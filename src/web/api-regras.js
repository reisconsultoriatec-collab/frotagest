'use strict';
/**
 * FrotaGest — API das regras de alerta: excesso de velocidade, uso fora do horário, parada longa fora
 * da garagem e motor ligado parado. Cada regra vale para a empresa toda, um grupo ou um veículo.
 * Reis Tecnologia
 */
const { HttpErro, formatar, validar: V } = require('../util/comum');
const { empresaAlvo } = require('../auth/acesso');
const { TIPOS } = require('../servicos/regras');

const MAX_POR_EMPRESA = 200;
const COLUNAS = ['empresa_id', 'tipo', 'grupo_id', 'veiculo_id', 'cerca_id', 'limite_kmh', 'tempo_seg', 'dias', 'horario_inicio', 'horario_fim',
  'ignorar_garagem', 'ignorar_ponto', 'gravidade', 'ativo'];

function hora(v, nome) {
  const s = V.texto(v, `o ${nome}`, { max: 5, obrigatorio: true });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpErro(400, `${nome.charAt(0).toUpperCase()}${nome.slice(1)} inválido (use hh:mm).`);
  return s;
}

/** Número inteiro dentro da faixa, com a mensagem dizendo a faixa. */
function faixa(v, nome, min, max, unidade, padrao = null) {
  if (V.vazio(v)) {
    if (padrao === null) throw new HttpErro(400, `Informe ${nome}.`);
    return padrao;
  }
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpErro(400, `${nome.charAt(0).toUpperCase()}${nome.slice(1)} deve ficar entre ${min} e ${max} ${unidade}.`);
  return n;
}

function registrar(srv) {
  const { banco, frota, auditoria, regras, acesso, cercas } = srv;

  /** Quem enxerga só alguns grupos vê as regras gerais e as dos seus grupos/veículos. */
  function ve(u, r) {
    if (u.perfil === 'master') return true;
    if (r.empresa_id !== u.empresaId) return false;
    if (u.todosGrupos || (!r.grupo_id && !r.veiculo_id)) return true;
    if (r.grupo_id) return u.grupos.has(r.grupo_id);
    return acesso.veVeiculo(u, frota.veiculos.get(r.veiculo_id));
  }

  /** ...e só mexe nas dos seus grupos e veículos (as gerais valem para a empresa toda). */
  function podeMexer(u, r) {
    if (u.perfil === 'master') return true;
    if (r.empresa_id !== u.empresaId) return false;
    if (u.todosGrupos) return true;
    if (r.grupo_id) return u.grupos.has(r.grupo_id);
    if (r.veiculo_id) return acesso.veVeiculo(u, frota.veiculos.get(r.veiculo_id));
    return false;
  }
  const SO_SEUS = 'Você só cria regras para os grupos e veículos que você enxerga: escolha um deles em "Vale para".';

  function dados(u, b, atual = null) {
    const empresaId = atual ? atual.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(empresaId)) throw new HttpErro(400, 'Empresa não encontrada.');
    const tipo = atual ? atual.tipo : V.opcao(b.tipo, Object.keys(TIPOS), 'o tipo de regra');
    const alcance = V.opcao(b.alcance, ['empresa', 'grupo', 'veiculo'], 'a quem a regra vale', 'empresa');
    const d = {
      empresa_id: empresaId, tipo, grupo_id: null, veiculo_id: null, cerca_id: null, limite_kmh: null, tempo_seg: 0,
      dias: null, horario_inicio: null, horario_fim: null, ignorar_garagem: 1, ignorar_ponto: 0,
      gravidade: V.opcao(b.gravidade, ['alta', 'media', 'baixa'], 'a gravidade', TIPOS[tipo].gravidade),
      ativo: V.booleano(b.ativo, true) ? 1 : 0,
    };
    if (alcance === 'grupo') {
      d.grupo_id = V.id(b.grupo, 'o grupo');
      const g = frota.grupos.get(d.grupo_id);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo não encontrado nesta empresa.');
    } else if (alcance === 'veiculo') {
      d.veiculo_id = V.id(b.veiculo, 'o veículo');
      const v = frota.veiculos.get(d.veiculo_id);
      if (!v || v.empresa_id !== empresaId) throw new HttpErro(400, 'Veículo não encontrado nesta empresa.');
    }
    if (tipo === 'velocidade') {
      d.limite_kmh = faixa(b.limite, 'o limite de velocidade', 5, 200, 'km/h');
      d.tempo_seg = faixa(b.tolerancia, 'a tolerância', 0, 600, 'segundos', TIPOS.velocidade.tempoSeg);
      if (!V.vazio(b.cerca)) {
        d.cerca_id = V.id(b.cerca, 'a cerca');
        const c = cercas.lista.get(d.cerca_id);
        if (!c || c.empresaId !== empresaId) throw new HttpErro(400, 'Cerca não encontrada (ou desativada) nesta empresa.');
      }
    } else if (tipo === 'fora_horario') {
      const dias = Array.isArray(b.dias) ? [...new Set(b.dias.map(String))].filter((x) => /^[0-6]$/.test(x)).sort() : [];
      if (!dias.length) throw new HttpErro(400, 'Marque pelo menos um dia em que o uso é permitido.');
      d.dias = dias.join(',');
      d.horario_inicio = hora(b.inicio, 'horário inicial');
      d.horario_fim = hora(b.fim, 'horário final');
      if (d.horario_inicio === d.horario_fim) throw new HttpErro(400, 'O horário inicial e o final não podem ser iguais.');
      d.tempo_seg = faixa(b.minutos, 'a tolerância', 0, 60, 'minutos', 1) * 60;
    } else {
      const [min, max, padrao] = tipo === 'parada' ? [5, 1440, 30] : [2, 240, 10];
      d.tempo_seg = faixa(b.minutos, 'o tempo', min, max, 'minutos', padrao) * 60;
      d.ignorar_garagem = V.booleano(b.ignorarGaragem, tipo === 'parada') ? 1 : 0;
      d.ignorar_ponto = V.booleano(b.ignorarPonto, false) ? 1 : 0;
    }
    return d;
  }

  /** Uma regra igual (mesmo tipo, mesmo alcance e mesma cerca) deixaria em dúvida qual vale. */
  async function repetida(d, id = null) {
    const r = await banco.um(
      `SELECT id FROM regras_alerta WHERE empresa_id = ? AND tipo = ? AND grupo_id <=> ? AND veiculo_id <=> ? AND cerca_id <=> ?${id ? ' AND id <> ?' : ''} LIMIT 1`,
      [d.empresa_id, d.tipo, d.grupo_id, d.veiculo_id, d.cerca_id, ...(id ? [id] : [])]);
    if (r) throw new HttpErro(400, `Já existe uma regra de ${TIPOS[d.tipo].nome.toLowerCase()} para ${d.veiculo_id ? 'este veículo' : d.grupo_id ? 'este grupo' : 'a empresa toda'}${d.cerca_id ? ' nesta cerca' : ''}. Abra e altere a que já existe.`);
  }

  function alvoTexto(r) {
    if (r.veiculo_id) {
      const v = frota.veiculos.get(r.veiculo_id);
      return v ? `veículo ${v.prefixo ? `${v.prefixo} · ` : ''}${v.placa}` : 'veículo';
    }
    if (r.grupo_id) return `grupo ${frota.caminhoGrupo(r.grupo_id)}`;
    return 'empresa toda';
  }

  function saida(r, contagem) {
    const v = r.veiculo_id ? frota.veiculos.get(r.veiculo_id) : null;
    const c = r.cerca_id ? cercas.lista.get(r.cerca_id) : null;
    const e = frota.empresas.get(r.empresa_id);
    return {
      id: r.id, empresaId: r.empresa_id, empresa: e ? e.nome : '', tipo: r.tipo,
      alcance: r.veiculo_id ? 'veiculo' : r.grupo_id ? 'grupo' : 'empresa',
      grupoId: r.grupo_id, grupo: r.grupo_id ? frota.caminhoGrupo(r.grupo_id) : null,
      veiculoId: r.veiculo_id, veiculo: v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : null,
      cercaId: r.cerca_id, cerca: c ? c.nome : null, cercaSumiu: Boolean(r.cerca_id && !c),
      limite: r.limite_kmh, tempoSeg: r.tempo_seg, dias: r.dias ? r.dias.split(',').map(Number) : [],
      inicio: r.horario_inicio, fim: r.horario_fim, ignorarGaragem: Boolean(r.ignorar_garagem), ignorarPonto: Boolean(r.ignorar_ponto),
      gravidade: r.gravidade, ativo: Boolean(r.ativo), alertas7d: contagem.get(`r${r.id}`) || 0, atualizadoEm: r.atualizado_em,
    };
  }

  async function recarregar() {
    await regras.carregar();
    srv.painel.dia = null; // o dashboard refaz os excessos de hoje com o limite novo na próxima leitura
    srv.paraTodos({ type: 'regras' });
  }

  srv.rota('GET', '/api/regras', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const rows = (await banco.query(`SELECT * FROM regras_alerta${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY id`, emp ? [emp] : [])).filter((r) => ve(u, r));
    const contagem = new Map();
    if (rows.length) {
      const empresas = [...new Set(rows.map((r) => r.empresa_id))];
      const dt = formatar(Date.now() - 7 * 86400000);
      for (const x of await banco.query(
        `SELECT codigo, COUNT(*) AS n FROM alertas WHERE empresa_id IN (?) AND inicio >= ? AND codigo LIKE 'r%' GROUP BY codigo`, [empresas, dt])) {
        contagem.set(x.codigo, Number(x.n));
      }
    }
    return {
      regras: rows.map((r) => saida(r, contagem)),
      tipos: Object.entries(TIPOS).map(([id, t]) => ({ id, nome: t.nome, gravidade: t.gravidade, tempoSeg: t.tempoSeg })),
    };
  }, { acesso: 'regras.ver' });

  srv.rota('POST', '/api/regras', async ({ u, body, ip }) => {
    const d = dados(u, body);
    if (!podeMexer(u, d)) throw new HttpErro(400, SO_SEUS);
    const n = await banco.um('SELECT COUNT(*) AS n FROM regras_alerta WHERE empresa_id = ?', [d.empresa_id]);
    if (n.n >= MAX_POR_EMPRESA) throw new HttpErro(400, `Limite de ${MAX_POR_EMPRESA} regras por empresa.`);
    await repetida(d);
    const x = await banco.query(`INSERT INTO regras_alerta (${COLUNAS.join(', ')}) VALUES (?)`, [COLUNAS.map((k) => d[k])]);
    await recarregar();
    await auditoria.registrar(u, 'criar', { entidade: 'regra_alerta', entidadeId: x.insertId, descricao: `${TIPOS[d.tipo].nome} (${alvoTexto(d)})`, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'regras.incluir' });

  srv.rota('PUT', '/api/regras/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM regras_alerta WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Regra não encontrada.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Esta regra vale para a empresa toda: só quem enxerga todos os grupos pode mexer nela.');
    // só ligar/desligar (o botão da lista)
    let d;
    if (Object.keys(body || {}).length === 1 && Object.prototype.hasOwnProperty.call(body, 'ativo')) {
      d = { ...atual, ativo: V.booleano(body.ativo) ? 1 : 0 };
    } else {
      d = dados(u, body, atual);
      if (!podeMexer(u, d)) throw new HttpErro(400, SO_SEUS);
      await repetida(d, id);
    }
    const campos = COLUNAS.filter((k) => k !== 'empresa_id' && k !== 'tipo');
    await banco.query(`UPDATE regras_alerta SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...campos.map((k) => d[k]), id]);
    await recarregar();
    const mudou = atual.ativo && !d.ativo ? ' (desligada)' : !atual.ativo && d.ativo ? ' (ligada)' : '';
    await auditoria.registrar(u, 'editar', { entidade: 'regra_alerta', entidadeId: id, descricao: `${TIPOS[atual.tipo].nome} (${alvoTexto(d)})${mudou}`, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'regras.alterar' });

  srv.rota('DELETE', '/api/regras/:id', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM regras_alerta WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Regra não encontrada.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Esta regra vale para a empresa toda: só quem enxerga todos os grupos pode excluir.');
    await banco.query('DELETE FROM regras_alerta WHERE id = ?', [id]);
    await recarregar();
    await auditoria.registrar(u, 'excluir', { entidade: 'regra_alerta', entidadeId: id, descricao: `${TIPOS[atual.tipo].nome} (${alvoTexto(atual)})`, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'regras.excluir' });
}

module.exports = { registrar };
