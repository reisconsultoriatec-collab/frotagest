'use strict';
/**
 * FrotaGest — cadastro pela tela de entrada (mesmo modelo do EduGest).
 *
 *  POST /api/conta/registrar    quem acabou de criar o login no Firebase conclui o cadastro:
 *                               - com o código da empresa: fica pendente até o administrador aprovar;
 *                               - sem código: só o proprietário do sistema (vira master, com e-mail confirmado).
 *  POST /api/conta/falha-login  registra senha errada na auditoria (público, com limite por IP).
 *
 *  Fluxo no painel: createUserWithEmailAndPassword → POST /api/conta/registrar.
 *  Se o código estiver errado, nada é gravado e a pessoa pode tentar de novo com a mesma conta.
 * Reis Tecnologia
 */
const { HttpErro, validar: V } = require('../util/comum');

function registrar(srv) {
  const { banco, auditoria, acesso } = srv;
  const r = (m, c, h, o) => srv.rota(m, c, h, o);

  r('POST', '/api/conta/registrar', async ({ claims, body, ip }) => {
    if (!claims.email) throw new HttpErro(400, 'O login precisa ter e-mail.', 'sem_email');
    const ja = await banco.um('SELECT id, pendente FROM usuarios WHERE firebase_uid = ? OR email = ?', [claims.uid, claims.email]);
    if (ja) throw new HttpErro(409, ja.pendente ? 'Seu cadastro já foi recebido e aguarda aprovação.' : 'Você já tem cadastro no FrotaGest. Use "Entrar".', 'ja_cadastrado');

    const nome = V.texto(body.nome, 'o seu nome completo', { max: 120, min: 3, obrigatorio: true });
    const codigo = V.texto(body.codigo, 'o código da empresa', { max: 12 });

    // sem código: só o proprietário do sistema (Reis Tecnologia)
    if (!codigo) {
      if (!acesso.ehProprietario(claims.email)) {
        throw new HttpErro(400, 'Informe o código da empresa. Peça o código ao administrador da sua empresa.', 'sem_codigo');
      }
      if (!claims.emailVerificado) {
        throw new HttpErro(403, 'Confirme o seu e-mail pelo link que enviamos para concluir o acesso de proprietário.', 'email_nao_verificado');
      }
      const row = await acesso.criarMaster(claims, nome);
      acesso.invalidar();
      await auditoria.registrar({ id: row.id, empresaId: null }, 'cadastro', { entidade: 'usuario', entidadeId: row.id, descricao: `${nome} <${claims.email}> — proprietário do sistema (master)`, ip, empresaId: null });
      return { status: 'ativo', perfil: 'master' };
    }

    const emp = await banco.um('SELECT id, nome, ativo FROM empresas WHERE codigo_convite = ?', [codigo.toUpperCase().replace(/\s/g, '')]);
    if (!emp || !emp.ativo) {
      await auditoria.registrar(null, 'cadastro_recusado', { descricao: `Código de empresa inválido usado por ${claims.email}`, ip, empresaId: null });
      throw new HttpErro(404, 'Código da empresa não encontrado. Confira com o administrador da sua empresa.', 'codigo_invalido');
    }
    const x = await banco.query(
      "INSERT INTO usuarios (empresa_id, firebase_uid, email, nome, perfil, todos_grupos, ativo, pendente) VALUES (?, ?, ?, ?, 'visualizador', 1, 1, 1)",
      [emp.id, claims.uid, claims.email, nome],
    );
    await auditoria.registrar({ id: x.insertId, empresaId: emp.id }, 'cadastro', { entidade: 'usuario', entidadeId: x.insertId, descricao: `${nome} <${claims.email}> — pelo código da empresa, aguardando aprovação`, ip, empresaId: emp.id });
    srv.log('info', `Novo cadastro aguardando aprovação: ${claims.email} (${emp.nome})`);
    srv.avisarPendentes(emp.id);
    return { status: 'pendente', empresa: emp.nome };
  }, { conta: true, limite: { chave: 'cadastro', max: 10, minutos: 15 } });

  r('POST', '/api/conta/falha-login', async ({ body, ip }) => {
    let email;
    try { email = V.email(body.email); } catch { return { ok: true }; }
    const u = await banco.um('SELECT id, empresa_id FROM usuarios WHERE email = ?', [email]);
    await auditoria.registrar(u ? { id: u.id, empresaId: u.empresa_id } : null, 'falha_login', {
      descricao: `Senha errada para ${email}`, ip, empresaId: u ? u.empresa_id : null,
    });
    return { ok: true };
  }, { publica: true, limite: { chave: 'falha-login', max: 30, minutos: 15 } });

}

module.exports = { registrar };
