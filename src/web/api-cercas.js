'use strict';
/**
 * FrotaGest — API das cercas virtuais: cadastro (círculo ou polígono desenhado no mapa), lista com
 * quem está dentro de cada uma agora, e a ocupação para o modo TV.
 * Reis Tecnologia
 */
const { HttpErro, validar: V } = require('../util/comum');
const { empresaAlvo, permite } = require('../auth/acesso');
const { FINALIDADES, daLinha } = require('../servicos/cercas');
const { areaM2 } = require('../servicos/geo');

const MAX_POR_EMPRESA = 500;
const MAX_PONTOS = 200;

function hora(v, nome) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpErro(400, `${nome} inválido (use hh:mm).`);
  return s;
}

function numero(v, erro, min, max) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max) throw new HttpErro(400, erro);
  return n;
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const COLUNAS = ['empresa_id', 'grupo_id', 'nome', 'finalidade', 'forma', 'latitude', 'longitude', 'raio_m', 'pontos',
  'alerta_entrada', 'alerta_saida', 'horario_inicio', 'horario_fim', 'observacao', 'ativo'];

function registrar(srv) {
  const { banco, frota, auditoria, cercas, acesso } = srv;

  /** O usuário vê a cerca? (empresa dele; operador com grupos limitados vê as gerais e as dos grupos dele) */
  function ve(u, c) {
    if (u.perfil === 'master') return true;
    if (c.empresa_id !== u.empresaId) return false;
    if (u.todosGrupos || !c.grupo_id) return true;
    return u.grupos.has(c.grupo_id);
  }

  /** Quem só enxerga alguns grupos só mexe nas cercas desses grupos (as gerais valem para a empresa toda). */
  function podeMexer(u, c) {
    if (u.perfil === 'master') return true;
    if (c.empresa_id !== u.empresaId) return false;
    return u.todosGrupos || Boolean(c.grupo_id && u.grupos.has(c.grupo_id));
  }
  const SO_SEUS_GRUPOS = 'Você só cadastra cercas dos grupos que você enxerga: escolha um deles no campo Grupo.';

  function dados(u, b, atual = null) {
    const empresaId = atual ? atual.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(empresaId)) throw new HttpErro(400, 'Empresa não encontrada.');
    const d = {
      empresa_id: empresaId,
      nome: V.texto(b.nome, 'o nome da cerca', { max: 80, min: 2, obrigatorio: true }),
      finalidade: V.opcao(b.finalidade, Object.keys(FINALIDADES), 'a finalidade', 'area'),
      forma: V.opcao(b.forma, ['circulo', 'poligono'], 'o formato'),
      grupo_id: b.grupo ? V.id(b.grupo, 'o grupo') : null,
      alerta_entrada: V.booleano(b.alertaEntrada) ? 1 : 0,
      alerta_saida: V.booleano(b.alertaSaida) ? 1 : 0,
      horario_inicio: hora(b.horarioInicio, 'O horário inicial'),
      horario_fim: hora(b.horarioFim, 'O horário final'),
      observacao: V.texto(b.observacao, 'a observação', { max: 255 }),
      ativo: V.booleano(b.ativo, true) ? 1 : 0,
      latitude: null, longitude: null, raio_m: null, pontos: null,
    };
    if (d.grupo_id) {
      const g = frota.grupos.get(d.grupo_id);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo não encontrado nesta empresa.');
    }
    if (Boolean(d.horario_inicio) !== Boolean(d.horario_fim)) throw new HttpErro(400, 'Preencha o horário permitido completo (início e fim) ou deixe os dois em branco.');
    if (d.horario_inicio && d.horario_inicio === d.horario_fim) throw new HttpErro(400, 'O horário inicial e o final não podem ser iguais.');
    if (d.forma === 'circulo') {
      d.latitude = r6(numero(b.lat, 'Marque o centro do círculo no mapa.', -90, 90));
      d.longitude = r6(numero(b.lng, 'Marque o centro do círculo no mapa.', -180, 180));
      d.raio_m = Math.round(numero(b.raio, 'O raio deve ficar entre 20 m e 50 km.', 20, 50000));
    } else {
      if (!Array.isArray(b.pontos) || b.pontos.length < 3) throw new HttpErro(400, 'Marque pelo menos 3 pontos no mapa para formar a área.');
      if (b.pontos.length > MAX_PONTOS) throw new HttpErro(400, `Use no máximo ${MAX_PONTOS} pontos.`);
      const pts = b.pontos.map((p) => {
        if (!Array.isArray(p) || p.length !== 2) throw new HttpErro(400, 'Ponto da área inválido.');
        return [r6(numero(p[0], 'Ponto da área inválido.', -90, 90)), r6(numero(p[1], 'Ponto da área inválido.', -180, 180))];
      });
      const area = areaM2({ forma: 'poligono', pontos: pts });
      if (area < 100) throw new HttpErro(400, 'A área desenhada é pequena demais. Marque os pontos mais afastados.');
      d.pontos = JSON.stringify(pts);
    }
    return d;
  }

  function saida(row, ocupacao, u) {
    const c = daLinha(row);
    const dentro = c ? (ocupacao.get(c.id) || []) : [];
    const veiculos = [];
    for (const apId of dentro) {
      const v = frota.veiculoDoAparelho.get(apId);
      if (v && acesso.veVeiculo(u, v)) veiculos.push(`a${apId}`);
    }
    let pontos = null;
    if (row.forma === 'poligono') { try { pontos = JSON.parse(row.pontos || '[]'); } catch { pontos = []; } }
    const e = frota.empresas.get(row.empresa_id);
    return {
      id: row.id, empresaId: row.empresa_id, empresa: e ? e.nome : '', grupoId: row.grupo_id,
      grupo: row.grupo_id ? frota.caminhoGrupo(row.grupo_id) : null,
      nome: row.nome, finalidade: row.finalidade, forma: row.forma,
      lat: row.latitude === null ? null : Number(row.latitude), lng: row.longitude === null ? null : Number(row.longitude),
      raio: row.raio_m, pontos, alertaEntrada: Boolean(row.alerta_entrada), alertaSaida: Boolean(row.alerta_saida),
      horarioInicio: row.horario_inicio, horarioFim: row.horario_fim, observacao: row.observacao, ativo: Boolean(row.ativo),
      cor: FINALIDADES[row.finalidade].cor, area: c ? Math.round(areaM2(c)) : null, dentro: veiculos, atualizadoEm: row.atualizado_em,
    };
  }

  srv.rota('GET', '/api/cercas', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const rows = await banco.query(`SELECT * FROM cercas${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY ativo DESC, nome`, emp ? [emp] : []);
    const oc = cercas.ocupacao();
    const lista = rows.filter((r) => ve(u, r) && (r.ativo || permite(u, 'cercas'))).map((r) => saida(r, oc, u));
    return { cercas: lista, finalidades: Object.entries(FINALIDADES).map(([id, f]) => ({ id, ...f })) };
  });

  srv.rota('POST', '/api/cercas', async ({ u, body, ip }) => {
    const d = dados(u, body);
    if (!podeMexer(u, d)) throw new HttpErro(400, SO_SEUS_GRUPOS);
    const n = await banco.um('SELECT COUNT(*) AS n FROM cercas WHERE empresa_id = ?', [d.empresa_id]);
    if (n.n >= MAX_POR_EMPRESA) throw new HttpErro(400, `Limite de ${MAX_POR_EMPRESA} cercas por empresa.`);
    const x = await banco.query(`INSERT INTO cercas (${COLUNAS.join(', ')}) VALUES (?)`, [COLUNAS.map((k) => d[k])]);
    await cercas.carregar();
    srv.paraTodos({ type: 'cercas' });
    await auditoria.registrar(u, 'criar', { entidade: 'cerca', entidadeId: x.insertId, descricao: `${d.nome} (${FINALIDADES[d.finalidade].nome})`, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'cercas.incluir' });

  srv.rota('PUT', '/api/cercas/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM cercas WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Cerca não encontrada.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Esta cerca vale para a empresa toda: só quem enxerga todos os grupos pode mexer nela.');
    const d = dados(u, body, atual);
    if (!podeMexer(u, d)) throw new HttpErro(400, SO_SEUS_GRUPOS);
    const campos = COLUNAS.filter((k) => k !== 'empresa_id');
    await banco.query(`UPDATE cercas SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...campos.map((k) => d[k]), id]);
    await cercas.carregar();
    srv.paraTodos({ type: 'cercas' });
    const mudou = [atual.ativo && !d.ativo ? 'desativada' : '', !atual.ativo && d.ativo ? 'reativada' : ''].filter(Boolean).join(' ');
    await auditoria.registrar(u, 'editar', { entidade: 'cerca', entidadeId: id, descricao: `${d.nome}${mudou ? ` (${mudou})` : ''}`, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'cercas.alterar' });

  srv.rota('DELETE', '/api/cercas/:id', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM cercas WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Cerca não encontrada.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Esta cerca vale para a empresa toda: só quem enxerga todos os grupos pode excluir.');
    await banco.query('DELETE FROM cercas WHERE id = ?', [id]);
    await cercas.carregar();
    srv.paraTodos({ type: 'cercas' });
    await auditoria.registrar(u, 'excluir', { entidade: 'cerca', entidadeId: id, descricao: atual.nome, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'cercas.excluir' });
}

module.exports = { registrar };
