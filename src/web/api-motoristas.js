'use strict';
/**
 * FrotaGest — API dos motoristas: cadastro, quem está em cada veículo (trocar pelo painel),
 * histórico de cada motorista e os cartões lidos pelo DVR que ainda não estão no cadastro.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, agora } = require('../util/comum');
const { empresaAlvo, limitado } = require('../auth/acesso');
const { normCartao } = require('../servicos/motoristas');

const CATEGORIAS = ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];

function registrar(srv) {
  const { banco, frota, auditoria, motoristas, acesso } = srv;

  /** Quem enxerga só alguns grupos vê os motoristas sem grupo e os dos seus grupos. */
  function ve(u, m) {
    if (u.perfil === 'master') return true;
    if (m.empresa_id !== u.empresaId) return false;
    return !limitado(u) || !m.grupo_id || u.grupos.has(m.grupo_id);
  }
  function podeMexer(u, m) {
    if (!ve(u, m)) return false;
    return !limitado(u) || (m.grupo_id && u.grupos.has(m.grupo_id));
  }

  function rotuloVeiculo(id) {
    const v = frota.veiculos.get(id);
    return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : 'veículo';
  }

  function dados(u, b, atual = null) {
    const empresaId = atual ? atual.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(empresaId)) throw new HttpErro(400, 'Empresa não encontrada.');
    const grupoId = V.id(b.grupo_id, 'o grupo', false);
    if (grupoId) {
      const g = frota.grupos.get(grupoId);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo inválido para esta empresa.');
    }
    if (limitado(u) && (!grupoId || !u.grupos.has(grupoId))) throw new HttpErro(400, 'Escolha um dos grupos que você enxerga para o motorista.');
    const cat = V.vazio(b.cnh_categoria) ? null : String(b.cnh_categoria).trim().toUpperCase();
    if (cat && !CATEGORIAS.includes(cat)) throw new HttpErro(400, 'Categoria da CNH inválida.');
    const cartao = V.vazio(b.cartao) ? null : normCartao(b.cartao);
    return {
      empresa_id: empresaId, grupo_id: grupoId,
      nome: V.texto(b.nome, 'o nome do motorista', { max: 120, min: 2, obrigatorio: true }),
      matricula: V.texto(b.matricula, 'a matrícula', { max: 30 }),
      telefone: V.texto(b.telefone, 'o telefone', { max: 20 }),
      cnh_numero: V.vazio(b.cnh_numero) ? null : String(b.cnh_numero).replace(/\D/g, '').slice(0, 20) || null,
      cnh_categoria: cat,
      cnh_validade: V.dia(b.cnh_validade, 'a validade da CNH'),
      cartao: cartao || null,
      observacao: V.texto(b.observacao, 'a observação', { max: 500 }),
      ativo: V.booleano(b.ativo, true) ? 1 : 0,
    };
  }

  async function cartaoRepetido(d, id = null) {
    if (!d.cartao) return;
    const r = await banco.um(`SELECT nome FROM motoristas WHERE empresa_id = ? AND cartao = ?${id ? ' AND id <> ?' : ''} LIMIT 1`, [d.empresa_id, d.cartao, ...(id ? [id] : [])]);
    if (r) throw new HttpErro(400, `Este cartão já é do motorista ${r.nome}.`);
  }

  const COLS = ['empresa_id', 'grupo_id', 'nome', 'matricula', 'telefone', 'cnh_numero', 'cnh_categoria', 'cnh_validade', 'cartao', 'observacao', 'ativo'];

  srv.rota('GET', '/api/motoristas', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const rows = (await banco.query(`SELECT * FROM motoristas${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY ativo DESC, nome`, emp ? [emp] : [])).filter((m) => ve(u, m));
    const lista = rows.map((m) => {
      const vid = motoristas.veiculoDe(m.id);
      const a = vid ? motoristas.abertos.get(vid) : null;
      const e = frota.empresas.get(m.empresa_id);
      return {
        ...m, empresa: e ? e.nome : '', grupo: m.grupo_id ? frota.caminhoGrupo(m.grupo_id) : null, editavel: podeMexer(u, m),
        veiculoAtual: vid && acesso.veVeiculo(u, frota.veiculos.get(vid)) ? { id: vid, rotulo: rotuloVeiculo(vid), desde: a.inicio, origem: a.origem } : null,
      };
    });
    let cartoes = [];
    if (u.acessos && u.acessos.motoristas && u.acessos.motoristas.includes('incluir')) {
      cartoes = (await banco.query(`SELECT * FROM motorista_cartoes_lidos${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY lido_em DESC LIMIT 50`, emp ? [emp] : []))
        .filter((c) => u.perfil === 'master' || c.empresa_id === u.empresaId)
        .map((c) => {
          const ap = c.aparelho_id ? frota.aparelhos.get(c.aparelho_id) : null;
          const v = ap ? frota.veiculoDoAparelho.get(ap.id) : null;
          return { empresaId: c.empresa_id, cartao: c.cartao, nome: c.nome_lido, lidoEm: c.lido_em, vezes: c.vezes, veiculo: v ? rotuloVeiculo(v.id) : null };
        });
    }
    return { motoristas: lista, cartoes, categorias: CATEGORIAS };
  }, { acesso: 'motoristas.ver' });

  srv.rota('POST', '/api/motoristas', async ({ u, body, ip }) => {
    const d = dados(u, body);
    await cartaoRepetido(d);
    const x = await banco.query(`INSERT INTO motoristas (${COLS.join(', ')}) VALUES (?)`, [COLS.map((k) => d[k])]);
    if (d.cartao) await banco.query('DELETE FROM motorista_cartoes_lidos WHERE empresa_id = ? AND cartao = ?', [d.empresa_id, d.cartao]);
    await motoristas.carregar();
    srv.paraTodos({ type: 'motoristas' });
    if (srv.manutencao) srv.manutencao.mudou(); // a validade da CNH entra em Manutenção e documentos
    await auditoria.registrar(u, 'criar', { entidade: 'motorista', entidadeId: x.insertId, descricao: d.nome, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'motoristas.incluir' });

  srv.rota('PUT', '/api/motoristas/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM motoristas WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Motorista não encontrado.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Este motorista não é de um grupo seu.');
    const d = dados(u, body, atual);
    await cartaoRepetido(d, id);
    const cols = COLS.filter((k) => k !== 'empresa_id');
    await banco.query(`UPDATE motoristas SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => d[k]), id]);
    await motoristas.carregar();
    // desativado: sai do veículo em que estava
    if (atual.ativo && !d.ativo) {
      const vid = motoristas.veiculoDe(id);
      if (vid) await motoristas.vincular({ veiculoId: vid, motoristaId: null, usuarioId: u.id });
    }
    srv.paraTodos({ type: 'motoristas' });
    if (srv.manutencao) srv.manutencao.mudou(); // a validade da CNH entra em Manutenção e documentos
    const acao = !!atual.ativo !== !!d.ativo ? (d.ativo ? 'reativar' : 'desativar') : 'editar';
    await auditoria.registrar(u, acao, { entidade: 'motorista', entidadeId: id, descricao: d.nome, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'motoristas.alterar' });

  srv.rota('DELETE', '/api/motoristas/:id', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM motoristas WHERE id = ?', [id]);
    if (!atual || !ve(u, atual)) throw new HttpErro(404, 'Motorista não encontrado.');
    if (!podeMexer(u, atual)) throw new HttpErro(403, 'Este motorista não é de um grupo seu.');
    const usado = await banco.um('SELECT id FROM motorista_vinculos WHERE motorista_id = ? LIMIT 1', [id]);
    if (usado) throw new HttpErro(409, 'Este motorista já dirigiu veículos: o histórico dele fica nos relatórios. Desative em vez de excluir.');
    await banco.query('DELETE FROM motoristas WHERE id = ?', [id]);
    await motoristas.carregar();
    srv.paraTodos({ type: 'motoristas' });
    if (srv.manutencao) srv.manutencao.mudou(); // a validade da CNH entra em Manutenção e documentos
    await auditoria.registrar(u, 'excluir', { entidade: 'motorista', entidadeId: id, descricao: atual.nome, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'motoristas.excluir' });

  /** Histórico de um motorista: os últimos veículos e períodos. */
  srv.rota('GET', '/api/motoristas/:id/historico', async ({ u, params }) => {
    const id = V.id(params.id);
    const m = motoristas.lista.get(id);
    if (!m || !ve(u, m)) throw new HttpErro(404, 'Motorista não encontrado.');
    const rows = await banco.query(
      `SELECT x.*, us.nome AS usuario FROM motorista_vinculos x LEFT JOIN usuarios us ON us.id = x.usuario_id
        WHERE x.motorista_id = ? ORDER BY x.inicio DESC, x.id DESC LIMIT 30`, [id]);
    return {
      historico: rows.filter((x) => acesso.veVeiculo(u, frota.veiculos.get(x.veiculo_id)))
        .map((x) => ({ veiculo: rotuloVeiculo(x.veiculo_id), inicio: x.inicio, fim: x.fim, origem: x.origem, usuario: x.usuario })),
    };
  }, { acesso: 'motoristas.ver' });

  /** Trocar o motorista do veículo pelo painel (motorista: id, ou vazio para "sem motorista"). */
  srv.rota('POST', '/api/veiculos/:id/motorista', async ({ u, params, body, ip }) => {
    const v = frota.veiculos.get(V.id(params.id));
    if (!v || !v.ativo || !acesso.veVeiculo(u, v)) throw new HttpErro(404, 'Veículo não encontrado.');
    let m = null;
    if (!V.vazio(body.motorista)) {
      m = motoristas.lista.get(V.id(body.motorista, 'o motorista'));
      if (!m || !ve(u, m) || m.empresa_id !== v.empresa_id) throw new HttpErro(400, 'Motorista não encontrado nesta empresa.');
      if (!m.ativo) throw new HttpErro(400, 'Este motorista está desativado.');
    }
    const antes = motoristas.atual(v.id);
    const outro = m ? motoristas.veiculoDe(m.id) : null;
    await motoristas.vincular({ veiculoId: v.id, motoristaId: m ? m.id : null, quando: agora(), origem: 'manual', usuarioId: u.id });
    const desc = `${rotuloVeiculo(v.id)}: ${m ? m.nome : 'sem motorista'}${antes ? ` (antes: ${antes.nome})` : ''}${outro && outro !== v.id ? ` · saiu do ${rotuloVeiculo(outro)}` : ''}`;
    await auditoria.registrar(u, 'trocar_motorista', { entidade: 'veiculo', entidadeId: v.id, descricao: desc, ip, empresaId: v.empresa_id });
    return { ok: true, motorista: motoristas.atual(v.id) };
  }, { acesso: 'motoristas.alterar' });

  /** Cartão lido que não é de ninguém: esquecer. */
  srv.rota('DELETE', '/api/motoristas-cartoes/:cartao', async ({ u, params, query }) => {
    const emp = u.perfil === 'master' ? V.id(query.empresa, 'a empresa') : u.empresaId;
    await banco.query('DELETE FROM motorista_cartoes_lidos WHERE empresa_id = ? AND cartao = ?', [emp, normCartao(params.cartao)]);
    srv.paraTodos({ type: 'motoristas' });
    if (srv.manutencao) srv.manutencao.mudou(); // a validade da CNH entra em Manutenção e documentos
    return { ok: true };
  }, { acesso: 'motoristas.incluir' });
}

module.exports = { registrar };
