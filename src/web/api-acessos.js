'use strict';
/**
 * FrotaGest — Controle de acesso: o que cada usuário pode ver e fazer em cada menu.
 *
 * Regras:
 *  - O master tem acesso total, vê todas as empresas e é o único que libera o menu
 *    "Controle de acesso" para alguém.
 *  - Quem recebeu o menu cuida só dos usuários da própria empresa; não mexe no próprio acesso,
 *    no master nem em quem também cuida do controle de acesso; e não libera o que ele mesmo não tem
 *    (essas caixas ficam travadas e o servidor mantém como estavam).
 *  - Mudou o perfil do usuário: o acesso volta ao padrão do novo perfil.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, agora } = require('../util/comum');
const { empresaAlvo, permite, alcanca } = require('../auth/acesso');
const P = require('../auth/permissoes');

function registrar(srv) {
  const { banco, auditoria, acesso } = srv;

  /** Caixas (tela.acao) que quem edita não pode mudar. */
  function travadas(u) {
    const r = new Set();
    if (u.perfil === 'master') return r;
    for (const t of P.TELAS) {
      for (const a of Object.keys(t.acoes)) {
        if (t.soMaster || !permite(u, t.id, a)) r.add(`${t.id}.${a}`);
      }
    }
    return r;
  }

  /** Por que este usuário não pode ser alterado por quem está editando (null = pode). */
  function motivo(u, alvo) {
    if (alvo.perfil === 'master') return 'Master: acesso total a tudo, sempre.';
    if (alvo.id === u.id) return 'É você: o seu acesso é definido por quem administra o sistema.';
    if (!permite(u, 'acesso', 'alterar')) return 'Você pode só consultar o controle de acesso.';
    if (u.perfil === 'master') return null;
    if (!alcanca(u, alvo)) {
      return alvo.perfil === 'admin' ? 'Administrador: só outro administrador (ou o master) altera.' : 'Tem acesso a grupos que você não enxerga.';
    }
    if (P.permite(P.efetivo(alvo.perfil, alvo.acessos), 'acesso')) return 'Também cuida do controle de acesso: só o master altera.';
    return null;
  }

  async function carregarUsuarios(where, args) {
    const rows = await banco.query(`
      SELECT s.id, s.empresa_id, e.nome AS empresa, s.email, s.nome, s.perfil, s.todos_grupos, s.ativo, s.pendente,
             s.acessos, s.acessos_em, q.nome AS acessos_por, s.ultimo_acesso
        FROM usuarios s
        LEFT JOIN empresas e ON e.id = s.empresa_id
        LEFT JOIN usuarios q ON q.id = s.acessos_por
       WHERE s.pendente = 0 ${where}
       ORDER BY s.perfil = 'master' DESC, s.ativo DESC, s.nome`, args);
    const ids = rows.map((x) => x.id);
    const vinc = ids.length ? await banco.query('SELECT usuario_id, grupo_id FROM usuario_grupos WHERE usuario_id IN (?)', [ids]) : [];
    for (const x of rows) x.grupos = vinc.filter((g) => g.usuario_id === x.id).map((g) => g.grupo_id);
    return rows;
  }

  function saida(u, x) {
    const m = motivo(u, x);
    return {
      id: x.id, nome: x.nome, email: x.email, perfil: x.perfil, empresaId: x.empresa_id, empresa: x.empresa,
      ativo: Boolean(x.ativo), todosGrupos: Boolean(x.todos_grupos) || x.perfil === 'admin' || x.perfil === 'master', grupos: x.grupos.length,
      acessos: P.efetivo(x.perfil, x.acessos),
      personalizado: x.perfil !== 'master' && P.ler(x.acessos) !== null,
      alteradoEm: x.acessos_em, alteradoPor: x.acessos_por,
      ultimoAcesso: x.ultimo_acesso,
      editavel: !m, motivo: m,
    };
  }

  srv.rota('GET', '/api/acessos', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const where = [];
    const args = [];
    if (emp) { where.push('AND s.empresa_id = ?'); args.push(emp); }
    if (u.perfil !== 'master') where.push("AND s.perfil <> 'master'");
    let rows = await carregarUsuarios(where.join(' '), args);
    // quem só enxerga alguns grupos não vê quem está fora deles
    if (u.perfil !== 'master' && !u.todosGrupos) rows = rows.filter((x) => x.id === u.id || alcanca(u, x));
    return {
      telas: P.catalogo(),
      acoes: P.ACOES,
      padroes: { admin: P.padraoCompleto('admin'), operador: P.padraoCompleto('operador'), visualizador: P.padraoCompleto('visualizador') },
      travadas: [...travadas(u)],
      podeAlterar: permite(u, 'acesso', 'alterar'),
      usuarios: rows.map((x) => saida(u, x)),
    };
  }, { acesso: 'acesso.ver' });

  srv.rota('PUT', '/api/acessos/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id, 'o usuário');
    const [alvo] = await carregarUsuarios('AND s.id = ?', [id]);
    if (!alvo || (u.perfil !== 'master' && (alvo.perfil === 'master' || alvo.empresa_id !== u.empresaId))) throw new HttpErro(404, 'Usuário não encontrado.');
    const m = motivo(u, alvo);
    if (m) throw new HttpErro(403, m, 'sem_acesso');

    const antes = P.efetivo(alvo.perfil, alvo.acessos);
    const voltarAoPadrao = body.acessos === null || body.padrao === true;
    let pedido;
    if (voltarAoPadrao) {
      pedido = P.padraoCompleto(alvo.perfil);
    } else {
      const lido = P.ler(body.acessos);
      if (!lido) throw new HttpErro(400, 'Envie a lista de acessos (ou "voltar ao padrão do perfil").');
      pedido = {};
      for (const t of P.TELAS) pedido[t.id] = lido[t.id] || [];
    }
    // o que quem edita não tem (e o Controle de acesso, se não for o master) fica como estava
    const trava = travadas(u);
    const nova = {};
    for (const t of P.TELAS) {
      const acoes = Object.keys(t.acoes).filter((a) => (trava.has(`${t.id}.${a}`) ? antes[t.id].includes(a) : pedido[t.id].includes(a)));
      nova[t.id] = P.acoesValidas(t.id, acoes);
    }
    if (P.iguais(antes, nova) && (!voltarAoPadrao || P.ler(alvo.acessos) === null)) {
      return { ok: true, mudou: false, acessos: antes, personalizado: P.ler(alvo.acessos) !== null };
    }
    const guardar = P.diferencas(alvo.perfil, nova);
    await banco.query('UPDATE usuarios SET acessos = ?, acessos_em = ?, acessos_por = ? WHERE id = ?',
      [guardar ? JSON.stringify(guardar) : null, agora(), u.id, id]);
    acesso.invalidar();

    // auditoria: o que entrou e o que saiu, em palavras
    const mudancas = [];
    for (const t of P.TELAS) {
      const mais = nova[t.id].filter((a) => !antes[t.id].includes(a));
      const menos = antes[t.id].filter((a) => !nova[t.id].includes(a));
      if (mais.length) mudancas.push(`+ ${t.nome} (${mais.join(', ')})`);
      if (menos.length) mudancas.push(`− ${t.nome} (${menos.join(', ')})`);
    }
    await auditoria.registrar(u, 'alterar_acesso', {
      entidade: 'usuario', entidadeId: id, ip, empresaId: alvo.empresa_id,
      descricao: `${alvo.nome} <${alvo.email}>: ${guardar ? (mudancas.join('; ') || 'personalizado') : `voltou ao padrão do perfil${mudancas.length ? ` (${mudancas.join('; ')})` : ''}`}`,
    });
    srv.atualizarUsuario(id).catch(() => {});
    return { ok: true, mudou: true, acessos: nova, personalizado: Boolean(guardar) };
  }, { acesso: 'acesso.alterar', limite: { chave: 'acessos', max: 300, minutos: 10 } });
}

module.exports = { registrar };
