'use strict';
/**
 * FrotaGest — Guia do FrotaGest (manual das telas e tour guiado).
 *
 *  GET /api/eu/ajuda            o que a pessoa já leu, os tours que fez e se já viu as boas-vindas
 *  PUT /api/eu/ajuda            { chave, feito } marca ou desmarca (artigo:<id>, tour:<id>, pref:<id>, boas-vindas)
 *  GET /api/guia/implantacao    administrador e master: o que já foi configurado na empresa (só contagens)
 *
 * As marcas ficam no servidor para valerem em qualquer aparelho da pessoa. Não entram na auditoria
 * (são só o progresso de leitura). Reis Tecnologia
 */
const { HttpErro, validar: V, agora } = require('../util/comum');
const { empresaAlvo } = require('../auth/acesso');

const CHAVE = /^(?:(?:artigo|tour|pref):[a-z0-9-]{1,60}|boas-vindas)$/;
const MAX_MARCAS = 600; // bem acima do número de artigos e tours: só para ninguém encher a tabela

/** O que a implantação confere, na ordem em que a empresa é montada. */
const CONFERIR = {
  aparelhos: 'SELECT COUNT(*) AS n FROM aparelhos WHERE empresa_id = ? AND ativo = 1',
  comunicando: `SELECT COUNT(*) AS n FROM aparelhos a JOIN aparelhos_estado e ON e.aparelho_id = a.id
                 WHERE a.empresa_id = ? AND a.ativo = 1 AND e.ultimo_contato IS NOT NULL`,
  grupos: 'SELECT COUNT(*) AS n FROM grupos WHERE empresa_id = ?',
  veiculos: 'SELECT COUNT(*) AS n FROM veiculos WHERE empresa_id = ? AND ativo = 1 AND aparelho_id IS NOT NULL',
  garagem: "SELECT COUNT(*) AS n FROM cercas WHERE empresa_id = ? AND ativo = 1 AND finalidade = 'garagem'",
  regras: 'SELECT COUNT(*) AS n FROM regras_alerta WHERE empresa_id = ? AND ativo = 1',
  equipe: "SELECT COUNT(*) AS n FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND pendente = 0 AND perfil IN ('operador', 'visualizador')",
  motoristas: 'SELECT COUNT(*) AS n FROM motoristas WHERE empresa_id = ? AND ativo = 1',
  avisos: `SELECT COUNT(*) AS n FROM push_inscricoes p JOIN usuarios us ON us.id = p.usuario_id
            WHERE us.empresa_id = ? AND us.ativo = 1`,
  logotipo: 'SELECT COUNT(*) AS n FROM empresas_logo WHERE empresa_id = ?',
};

function registrar(srv) {
  const { banco, frota } = srv;

  srv.rota('GET', '/api/eu/ajuda', async ({ u }) => {
    const rows = await banco.query('SELECT chave, feito_em FROM usuario_ajuda WHERE usuario_id = ?', [u.id]);
    return { marcados: Object.fromEntries(rows.map((x) => [x.chave, x.feito_em])) };
  });

  srv.rota('PUT', '/api/eu/ajuda', async ({ u, body }) => {
    const chave = V.texto(body.chave, 'a marca', { max: 80, obrigatorio: true });
    if (!CHAVE.test(chave)) throw new HttpErro(400, 'Marca inválida.');
    if (body.feito === false) {
      await banco.query('DELETE FROM usuario_ajuda WHERE usuario_id = ? AND chave = ?', [u.id, chave]);
      return { ok: true };
    }
    const n = await banco.um('SELECT COUNT(*) AS n FROM usuario_ajuda WHERE usuario_id = ?', [u.id]);
    if (Number(n.n) >= MAX_MARCAS) throw new HttpErro(400, 'Limite de marcas do guia atingido.');
    await banco.query('INSERT IGNORE INTO usuario_ajuda (usuario_id, chave, feito_em) VALUES (?, ?, ?)', [u.id, chave, agora()]);
    return { ok: true };
  }, { limite: { chave: 'guia', max: 240, minutos: 10 } });

  srv.rota('GET', '/api/guia/implantacao', async ({ u, query }) => {
    if (u.perfil !== 'master' && u.perfil !== 'admin') throw new HttpErro(403, 'A lista de implantação é do administrador da empresa.');
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    if (!emp) throw new HttpErro(400, 'Escolha a empresa no topo da tela para ver a implantação dela.', 'escolha_empresa');
    const contagens = {};
    for (const [id, sql] of Object.entries(CONFERIR)) contagens[id] = Number((await banco.um(sql, [emp])).n) || 0;
    const itens = Object.fromEntries(Object.entries(contagens).map(([id, n]) => [id, n > 0]));
    const feitos = Object.values(itens).filter(Boolean).length;
    const e = frota.empresas.get(emp);
    return { empresa: { id: emp, nome: e ? e.nome : '' }, itens, contagens, feitos, total: Object.keys(itens).length };
  });
}

module.exports = { registrar, CONFERIR };
