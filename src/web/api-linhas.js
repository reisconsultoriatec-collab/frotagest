'use strict';
/**
 * FrotaGest — API de linhas e viagens: cadastro da linha (pontos na ordem com o tempo previsto, partidas,
 * percurso e tolerâncias), o percurso tirado de uma viagem gravada, o quadro das viagens do dia e a troca
 * do veículo / cancelamento de uma viagem.
 * Reis Tecnologia
 */
const { HttpErro, agora, formatar, paraMs, validar: V } = require('../util/comum');
const { limitado } = require('../auth/acesso');
const { simplificar } = require('../servicos/linhas');

const MAX_PONTOS = 120;
const MAX_PARTIDAS = 400;
const MAX_PERCURSO = 5000;
const NOMES_SIT = { prevista: 'Prevista', em_andamento: 'Em andamento', concluida: 'Concluída', incompleta: 'Incompleta', nao_realizada: 'Não realizada', cancelada: 'Cancelada' };

function registrar(srv) {
  const { banco, frota, auditoria, acesso, linhas } = srv;
  const rotuloVeiculo = (id) => { const v = frota.veiculos.get(id); return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : null; };
  const filtroEmpresa = (u, q) => (u.perfil === 'master' ? (q.empresa ? V.id(q.empresa, 'a empresa') : null) : u.empresaId);

  /** Linha que a pessoa vê: da empresa e, se ela só enxerga alguns grupos, sem grupo ou de um grupo dela. */
  function ve(u, l) {
    if (!l) return false;
    if (u.perfil === 'master') return true;
    if (l.empresa_id !== u.empresaId) return false;
    return !limitado(u) || !l.grupo_id || u.grupos.has(l.grupo_id);
  }
  const mexe = (u, l) => ve(u, l) && (!limitado(u) || Boolean(l.grupo_id));

  function linhaDe(u, id) {
    const l = linhas.linhas.get(V.id(id, 'a linha'));
    if (!ve(u, l)) throw new HttpErro(404, 'Linha não encontrada.');
    return l;
  }

  const publica = (l, u) => ({
    id: l.id, empresaId: l.empresa_id, empresa: (frota.empresas.get(l.empresa_id) || {}).nome || '', grupoId: l.grupo_id,
    grupo: l.grupo_id ? frota.caminhoGrupo(l.grupo_id) : null, codigo: l.codigo, nome: l.nome, cor: l.cor, ativo: l.ativo,
    corredor: l.corredor_m, toleranciaAdiantado: l.tolerancia_adiantado_min, toleranciaAtraso: l.tolerancia_atraso_min,
    alertaForaRota: Boolean(l.alerta_fora_rota), alertaAtraso: l.alerta_atraso_min, alertaPulado: Boolean(l.alerta_ponto_pulado),
    observacao: l.observacao, temPercurso: Boolean(l.percurso && l.percurso.length > 1), editavel: mexe(u, l),
    duracaoMin: l.pontos.length ? l.pontos[l.pontos.length - 1].minutos : 0,
  });

  /* ---------- linhas ---------- */

  srv.rota('GET', '/api/linhas', async ({ u, query }) => {
    const emp = filtroEmpresa(u, query);
    const hoje = agora().slice(0, 10);
    const cont = await banco.query('SELECT linha_id, COUNT(*) AS n FROM viagens WHERE data = ? AND situacao <> \'cancelada\' GROUP BY linha_id', [hoje]);
    const porLinha = new Map(cont.map((c) => [c.linha_id, Number(c.n)]));
    const lista = [...linhas.linhas.values()].filter((l) => (!emp || l.empresa_id === emp) && ve(u, l))
      .sort((a, b) => String(a.codigo || a.nome).localeCompare(String(b.codigo || b.nome), 'pt-BR', { numeric: true }))
      .map((l) => ({ ...publica(l, u), pontos: l.pontos.length, partidas: l.partidas.filter((p) => p.ativo).length, viagensHoje: porLinha.get(l.id) || 0 }));
    return { linhas: lista };
  }, { acesso: 'linhas.ver' });

  srv.rota('GET', '/api/linhas/:id', async ({ u, params }) => {
    const l = linhaDe(u, params.id);
    return {
      linha: {
        ...publica(l, u), percurso: l.percurso || [],
        pontos: l.pontos.map((p) => ({ id: p.id, nome: p.nome, latitude: p.latitude, longitude: p.longitude, raio: p.raio_m, minutos: p.minutos })),
        partidas: l.partidas.map((p) => ({ id: p.id, horario: p.horario.slice(0, 5), dias: p.dias, veiculo: p.veiculo_id, veiculoNome: rotuloVeiculo(p.veiculo_id), ativo: p.ativo })),
      },
    };
  }, { acesso: 'linhas.ver' });

  function dados(u, b, atual = null) {
    const empresaId = atual ? atual.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(empresaId)) throw new HttpErro(400, 'Empresa não encontrada.');
    const d = {
      empresa_id: empresaId,
      grupo_id: V.id(b.grupo, 'o grupo', false),
      codigo: V.texto(b.codigo, 'o código', { max: 20 }),
      nome: V.texto(b.nome, 'o nome da linha', { max: 100, min: 2, obrigatorio: true }),
      cor: b.cor ? String(b.cor) : null,
      corredor_m: V.inteiro(b.corredor, 'o corredor', { min: 50, max: 2000 }) ?? 200,
      tolerancia_adiantado_min: V.inteiro(b.toleranciaAdiantado, 'a tolerância de adiantado', { min: 0, max: 30 }) ?? 2,
      tolerancia_atraso_min: V.inteiro(b.toleranciaAtraso, 'a tolerância de atraso', { min: 0, max: 60 }) ?? 5,
      alerta_fora_rota: V.booleano(b.alertaForaRota, true) ? 1 : 0,
      alerta_atraso_min: V.inteiro(b.alertaAtraso, 'o aviso de atraso', { min: 1, max: 240 }),
      alerta_ponto_pulado: V.booleano(b.alertaPulado, false) ? 1 : 0,
      observacao: V.texto(b.observacao, 'a observação', { max: 500 }),
      ativo: V.booleano(b.ativo, true) ? 1 : 0,
    };
    if (d.cor && !/^#[0-9a-fA-F]{6}$/.test(d.cor)) throw new HttpErro(400, 'Cor inválida.');
    if (d.grupo_id) {
      const g = frota.grupos.get(d.grupo_id);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo não encontrado.');
    }
    if (!mexe(u, d)) throw new HttpErro(400, 'Escolha um dos seus grupos para a linha.');
    // pontos na ordem
    const pts = Array.isArray(b.pontos) ? b.pontos : [];
    if (pts.length < 2) throw new HttpErro(400, 'A linha precisa de pelo menos 2 pontos (de onde sai e aonde chega).');
    if (pts.length > MAX_PONTOS) throw new HttpErro(400, `No máximo ${MAX_PONTOS} pontos por linha.`);
    let antes = 0;
    d.pontos = pts.map((p, i) => {
      const lat = Number(p.latitude);
      const lon = Number(p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001)) {
        throw new HttpErro(400, `Ponto ${i + 1}: local inválido.`);
      }
      const min = i === 0 ? 0 : V.inteiro(p.minutos, `os minutos do ponto ${i + 1}`, { min: 0, max: 1440, obrigatorio: true });
      if (min < antes) throw new HttpErro(400, `Ponto ${i + 1}: o tempo previsto não pode ser menor que o do ponto anterior.`);
      antes = min;
      return {
        ordem: i + 1, nome: V.texto(p.nome, `o nome do ponto ${i + 1}`, { max: 80 }) || `Ponto ${i + 1}`,
        latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lon * 1e6) / 1e6,
        raio_m: V.inteiro(p.raio, `o raio do ponto ${i + 1}`, { min: 15, max: 1000 }) ?? 60, minutos: min,
      };
    });
    if (d.pontos[d.pontos.length - 1].minutos < 1) throw new HttpErro(400, 'Informe o tempo previsto até o último ponto (minutos depois da partida).');
    // partidas
    const pas = Array.isArray(b.partidas) ? b.partidas : [];
    if (pas.length > MAX_PARTIDAS) throw new HttpErro(400, `No máximo ${MAX_PARTIDAS} partidas por linha.`);
    const vistos = new Set();
    d.partidas = pas.map((p, i) => {
      const h = String(p.horario || '').trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) throw new HttpErro(400, `Partida ${i + 1}: horário inválido (use hh:mm).`);
      const dias = [...new Set(String(p.dias || '').replace(/[^1-7]/g, ''))].sort().join('');
      if (!dias) throw new HttpErro(400, `Partida das ${h}: escolha os dias da semana.`);
      const veiculoId = V.id(p.veiculo, 'o veículo', false);
      if (veiculoId) {
        const v = frota.veiculos.get(veiculoId);
        if (!v || v.empresa_id !== empresaId || !acesso.veVeiculo(u, v)) throw new HttpErro(400, `Partida das ${h}: veículo não encontrado.`);
      }
      const chave = `${h}|${dias}|${veiculoId || ''}`;
      if (vistos.has(chave)) throw new HttpErro(400, `Partida das ${h} repetida.`);
      vistos.add(chave);
      const id = V.id(p.id, 'a partida', false);
      if (id && (!atual || !atual.partidas.some((x) => x.id === id))) throw new HttpErro(400, 'Partida não encontrada.');
      return { id, horario: `${h}:00`, dias, veiculo_id: veiculoId, ativo: V.booleano(p.ativo, true) ? 1 : 0 };
    });
    // percurso (opcional): lista de [lat, lng]
    if (b.percurso === null || b.percurso === undefined || (Array.isArray(b.percurso) && !b.percurso.length)) d.percurso = null;
    else {
      if (!Array.isArray(b.percurso) || b.percurso.length > MAX_PERCURSO) throw new HttpErro(400, 'Percurso inválido.');
      const ps = b.percurso.map((x) => [Number(x[0]), Number(x[1])]);
      if (ps.some(([a, o]) => !Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 90 || Math.abs(o) > 180)) throw new HttpErro(400, 'Percurso inválido.');
      d.percurso = JSON.stringify(ps.map(([a, o]) => [Math.round(a * 1e6) / 1e6, Math.round(o * 1e6) / 1e6]));
    }
    return d;
  }

  const COLS = ['empresa_id', 'grupo_id', 'codigo', 'nome', 'cor', 'percurso', 'corredor_m', 'tolerancia_adiantado_min', 'tolerancia_atraso_min', 'alerta_fora_rota', 'alerta_atraso_min', 'alerta_ponto_pulado', 'observacao', 'ativo'];

  async function gravarFilhos(c, linhaId, d, atual) {
    await c.query('DELETE FROM linha_pontos WHERE linha_id = ?', [linhaId]);
    await c.query('INSERT INTO linha_pontos (linha_id, ordem, nome, latitude, longitude, raio_m, minutos) VALUES ?',
      [d.pontos.map((p) => [linhaId, p.ordem, p.nome, p.latitude, p.longitude, p.raio_m, p.minutos])]);
    const manter = new Set(d.partidas.filter((p) => p.id).map((p) => p.id));
    const sair = atual ? atual.partidas.filter((p) => !manter.has(p.id)).map((p) => p.id) : [];
    if (sair.length) await c.query('DELETE FROM linha_partidas WHERE id IN (?)', [sair]);
    for (const p of d.partidas) {
      if (p.id) await c.query('UPDATE linha_partidas SET horario = ?, dias = ?, veiculo_id = ?, ativo = ? WHERE id = ?', [p.horario, p.dias, p.veiculo_id, p.ativo, p.id]);
      else await c.query('INSERT INTO linha_partidas (linha_id, horario, dias, veiculo_id, ativo) VALUES (?, ?, ?, ?, ?)', [linhaId, p.horario, p.dias, p.veiculo_id, p.ativo]);
    }
  }

  const resumoTexto = (d) => `${d.codigo ? `${d.codigo} · ` : ''}${d.nome}: ${d.pontos.length} pontos, ${d.pontos[d.pontos.length - 1].minutos} min, ${d.partidas.length} partida(s)`;

  srv.rota('POST', '/api/linhas', async ({ u, body, ip }) => {
    const d = dados(u, body || {});
    const id = await banco.transacao(async (c) => {
      const r = await c.query(`INSERT INTO linhas (${COLS.join(', ')}, criado_em) VALUES (?)`, [[...COLS.map((k) => d[k]), agora()]]);
      await gravarFilhos(c, r.insertId, d, null);
      return r.insertId;
    });
    await linhas.linhaMudou(id);
    await auditoria.registrar(u, 'criar', { entidade: 'linha', entidadeId: id, descricao: resumoTexto(d), ip, empresaId: d.empresa_id });
    return { id };
  }, { acesso: 'linhas.incluir', corpoMax: 2 * 1024 * 1024 });

  srv.rota('PUT', '/api/linhas/:id', async ({ u, params, body, ip }) => {
    const atual = linhaDe(u, params.id);
    if (!mexe(u, atual)) throw new HttpErro(403, 'Esta linha vale para a empresa toda: só quem enxerga todos os grupos altera.');
    const d = dados(u, body || {}, atual);
    const cols = COLS.filter((k) => k !== 'empresa_id');
    await banco.transacao(async (c) => {
      await c.query(`UPDATE linhas SET ${cols.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`, [...cols.map((k) => d[k]), agora(), atual.id]);
      await gravarFilhos(c, atual.id, d, atual);
    });
    await linhas.linhaMudou(atual.id);
    await auditoria.registrar(u, 'editar', { entidade: 'linha', entidadeId: atual.id, descricao: resumoTexto(d), ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'linhas.alterar', corpoMax: 2 * 1024 * 1024 });

  srv.rota('DELETE', '/api/linhas/:id', async ({ u, params, ip }) => {
    const l = linhaDe(u, params.id);
    if (!mexe(u, l)) throw new HttpErro(403, 'Esta linha vale para a empresa toda: só quem enxerga todos os grupos exclui.');
    const feitas = await banco.um("SELECT COUNT(*) AS n FROM viagens WHERE linha_id = ? AND situacao NOT IN ('prevista','cancelada','nao_realizada')", [l.id]);
    if (feitas.n > 0) throw new HttpErro(409, 'Esta linha já tem viagens feitas (estão nos relatórios): desligue a linha em vez de excluir.');
    const vs = await banco.query('SELECT id FROM viagens WHERE linha_id = ?', [l.id]);
    await banco.transacao(async (c) => {
      if (vs.length) {
        await c.query('DELETE FROM viagem_pontos WHERE viagem_id IN (?)', [vs.map((x) => x.id)]);
        await c.query('DELETE FROM viagens WHERE linha_id = ?', [l.id]);
      }
      await c.query('DELETE FROM linha_pontos WHERE linha_id = ?', [l.id]);
      await c.query('DELETE FROM linha_partidas WHERE linha_id = ?', [l.id]);
      await c.query('DELETE FROM linhas WHERE id = ?', [l.id]);
    });
    await linhas.linhaMudou(l.id);
    await auditoria.registrar(u, 'excluir', { entidade: 'linha', entidadeId: l.id, descricao: `${l.codigo ? `${l.codigo} · ` : ''}${l.nome}`, ip, empresaId: l.empresa_id });
    return { ok: true };
  }, { acesso: 'linhas.excluir' });

  /** Percurso a partir de uma viagem feita: as posições do GPS do veículo no período, simplificadas. */
  srv.rota('GET', '/api/linhas-percurso', async ({ u, query }) => {
    const v = frota.veiculos.get(V.id(query.veiculo, 'o veículo'));
    if (!v || !acesso.veVeiculo(u, v)) throw new HttpErro(404, 'Veículo não encontrado.');
    const de = V.dataHora(String(query.de || '').replace('T', ' ').padEnd(19, ':00').slice(0, 19), 'o início');
    const ate = V.dataHora(String(query.ate || '').replace('T', ' ').padEnd(19, ':00').slice(0, 19), 'o fim');
    if (ate <= de) throw new HttpErro(400, 'O fim precisa ser depois do início.');
    if (paraMs(ate) - paraMs(de) > 12 * 3600000) throw new HttpErro(400, 'Escolha até 12 horas.');
    const rows = await banco.query('SELECT latitude, longitude FROM posicoes WHERE veiculo_id = ? AND gps_valido = 1 AND data_hora BETWEEN ? AND ? ORDER BY data_hora, id LIMIT 20000', [v.id, de, ate]);
    const pts = rows.map((r) => [Number(r.latitude), Number(r.longitude)]);
    if (pts.length < 2) throw new HttpErro(404, 'O veículo não tem posições do GPS nesse período.');
    let s = simplificar(pts, 12);
    if (s.length > MAX_PERCURSO) s = simplificar(pts, 40);
    return { percurso: s, posicoes: pts.length };
  }, { acesso: ['linhas.incluir', 'linhas.alterar'] });

  /* ---------- viagens ---------- */

  srv.rota('GET', '/api/viagens', async ({ u, query }) => {
    const data = query.data ? V.dia(query.data, 'a data') : agora().slice(0, 10);
    const emp = filtroEmpresa(u, query);
    const args = [data];
    let onde = 'v.data = ?';
    if (emp) { onde += ' AND v.empresa_id = ?'; args.push(emp); }
    if (query.linha) { onde += ' AND v.linha_id = ?'; args.push(V.id(query.linha, 'a linha')); }
    const vs = (await banco.query(`SELECT v.* FROM viagens v WHERE ${onde} ORDER BY v.previsto_inicio, v.id`, args))
      .filter((v) => ve(u, linhas.linhas.get(v.linha_id) || { empresa_id: v.empresa_id, grupo_id: null }));
    const ids = vs.map((v) => v.id);
    const pts = ids.length ? await banco.query('SELECT * FROM viagem_pontos WHERE viagem_id IN (?) ORDER BY viagem_id, ordem', [ids]) : [];
    const porViagem = new Map();
    for (const p of pts) { if (!porViagem.has(p.viagem_id)) porViagem.set(p.viagem_id, []); porViagem.get(p.viagem_id).push(p); }
    return { data, viagens: vs.map((v) => viagemPublica(v, porViagem.get(v.id) || [])) };
  }, { acesso: 'linhas.ver' });

  function viagemPublica(v, pontos) {
    const l = linhas.linhas.get(v.linha_id);
    const prox = pontos.find((p) => p.situacao === 'pendente');
    const atraso = v.atraso_atual_seg === null ? 0 : v.atraso_atual_seg;
    return {
      id: v.id, linhaId: v.linha_id, linha: l ? `${l.codigo ? `${l.codigo} · ` : ''}${l.nome}` : 'linha excluída', cor: l ? l.cor : null,
      empresaId: v.empresa_id, data: v.data, previstoInicio: v.previsto_inicio, previstoFim: v.previsto_fim,
      veiculoId: v.veiculo_id, veiculo: rotuloVeiculo(v.veiculo_id), veiculoOrigem: v.veiculo_origem,
      situacao: v.situacao, situacaoNome: NOMES_SIT[v.situacao], inicioReal: v.inicio_real, fimReal: v.fim_real,
      pontosTotal: v.pontos_total, pontosPassados: v.pontos_passados, pontosPulados: v.pontos_pulados,
      atrasoAtual: v.atraso_atual_seg, atrasoMax: v.atraso_max_seg, foraRotaSeg: v.fora_rota_seg, observacao: v.observacao,
      tolerancia: l ? { adiantado: l.tolerancia_adiantado_min, atraso: l.tolerancia_atraso_min } : { adiantado: 2, atraso: 5 },
      proximo: prox && ['prevista', 'em_andamento'].includes(v.situacao)
        ? { nome: prox.nome, previsto: prox.previsto, estimado: v.situacao === 'em_andamento' ? formatar(paraMs(prox.previsto) + atraso * 1000) : prox.previsto } : null,
      pontos: pontos.map((p) => ({ ordem: p.ordem, nome: p.nome, previsto: p.previsto, realizado: p.realizado, situacao: p.situacao, diferenca: p.diferenca_seg })),
    };
  }

  async function viagemDe(u, id) {
    const v = await banco.um('SELECT * FROM viagens WHERE id = ?', [V.id(id, 'a viagem')]);
    if (!v || !ve(u, linhas.linhas.get(v.linha_id) || { empresa_id: v.empresa_id, grupo_id: null })) throw new HttpErro(404, 'Viagem não encontrada.');
    return v;
  }

  srv.rota('GET', '/api/viagens/:id', async ({ u, params }) => {
    const v = await viagemDe(u, params.id);
    const pts = await banco.query('SELECT * FROM viagem_pontos WHERE viagem_id = ? ORDER BY ordem', [v.id]);
    return { viagem: viagemPublica(v, pts) };
  }, { acesso: 'linhas.ver' });

  srv.rota('POST', '/api/viagens/:id/veiculo', async ({ u, params, body, ip }) => {
    const v = await viagemDe(u, params.id);
    const veiculoId = V.id(body.veiculo, 'o veículo', false);
    if (veiculoId) {
      const ve2 = frota.veiculos.get(veiculoId);
      if (!ve2 || ve2.empresa_id !== v.empresa_id || !acesso.veVeiculo(u, ve2)) throw new HttpErro(400, 'Veículo não encontrado.');
    }
    try { await linhas.trocarVeiculo(v.id, veiculoId); } catch (e) { throw new HttpErro(409, e.message); }
    await auditoria.registrar(u, 'trocar_veiculo_viagem', { entidade: 'viagem', entidadeId: v.id, descricao: `${(linhas.linhas.get(v.linha_id) || {}).nome || 'linha'} ${v.previsto_inicio.slice(0, 16)}: ${rotuloVeiculo(veiculoId) || 'sem veículo'} (antes: ${rotuloVeiculo(v.veiculo_id) || 'sem veículo'})`, ip, empresaId: v.empresa_id });
    return { ok: true };
  }, { acesso: 'linhas.alterar' });

  srv.rota('POST', '/api/viagens/:id/cancelar', async ({ u, params, body, ip }) => {
    const v = await viagemDe(u, params.id);
    const motivo = V.texto(body.motivo, 'o motivo', { max: 300, obrigatorio: true });
    try { await linhas.cancelar(v.id, motivo); } catch (e) { throw new HttpErro(409, e.message); }
    await auditoria.registrar(u, 'cancelar_viagem', { entidade: 'viagem', entidadeId: v.id, descricao: `${(linhas.linhas.get(v.linha_id) || {}).nome || 'linha'} ${v.previsto_inicio.slice(0, 16)}: ${motivo}`, ip, empresaId: v.empresa_id });
    return { ok: true };
  }, { acesso: 'linhas.alterar' });
}

module.exports = { registrar };
