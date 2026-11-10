'use strict';
/**
 * FrotaGest — API da verificação em duas etapas: cadastrar o aplicativo (QR Code), digitar o código
 * no login e, para o master, zerar a verificação de um usuário. Estas rotas funcionam antes da
 * segunda etapa (livre2fa); todas as outras ficam bloqueadas até o código ser confirmado.
 * Reis Tecnologia
 */
const { HttpErro, validar: V } = require('../util/comum');

function registrar(srv) {
  const { doisFatores, auditoria, acesso, banco } = srv;
  const r = (m, c, h, o = {}) => srv.rota(m, c, h, o);

  r('GET', '/api/2fa', async ({ u, claims }) => ({
    exigido: doisFatores.exige(u), ativo: u.doisFatoresAtivo, verificado: doisFatores.sessaoVerificada(claims),
    nome: u.nome, email: u.email,
  }), { livre2fa: true });

  r('POST', '/api/2fa/iniciar', async ({ u }) => {
    if (!doisFatores.exige(u)) throw new HttpErro(403, 'A verificação em duas etapas não foi ativada para o seu usuário.', 'nao_exigido');
    return doisFatores.iniciar(u);
  }, { livre2fa: true, limite: { chave: '2fa-iniciar', max: 60, minutos: 10 } });

  r('POST', '/api/2fa/confirmar', async ({ u, claims, body, ip }) => {
    if (!doisFatores.exige(u)) throw new HttpErro(403, 'A verificação em duas etapas não foi ativada para o seu usuário.', 'nao_exigido');
    let codigos;
    try {
      codigos = await doisFatores.confirmar(u, claims, body.codigo);
    } catch (e) {
      if (e.codigo === 'codigo_incorreto') await auditoria.registrar(u, '2fa_falha', { descricao: 'código errado ao ativar a verificação em duas etapas', ip });
      throw e;
    }
    acesso.invalidar();
    await auditoria.registrar(u, '2fa_ativada', { entidade: 'usuario', entidadeId: u.id, descricao: 'ativou a verificação em duas etapas (aplicativo autenticador)', ip });
    return { ok: true, codigos };
  }, { livre2fa: true, limite: { chave: '2fa-codigo', max: 150, minutos: 10 } });

  r('POST', '/api/2fa/verificar', async ({ u, claims, body, ip }) => {
    if (!doisFatores.exige(u) || !u.doisFatoresAtivo) return { ok: true, recuperacao: false };
    let r0;
    try {
      r0 = await doisFatores.verificar(u, claims, body.codigo);
    } catch (e) {
      if (e.codigo === 'codigo_incorreto') await auditoria.registrar(u, '2fa_falha', { descricao: 'código da verificação em duas etapas errado', ip });
      throw e;
    }
    if (r0.recuperacao) {
      await auditoria.registrar(u, '2fa_recuperacao', { descricao: `entrou com um código de recuperação (restam ${r0.restantes})`, ip });
    }
    return { ok: true, ...r0 };
  }, { livre2fa: true, limite: { chave: '2fa-codigo', max: 150, minutos: 10 } });

  /** Master: zera a verificação de alguém que perdeu o celular (cadastra de novo no próximo acesso). */
  r('POST', '/api/usuarios/:id/2fa/zerar', async ({ u, params, ip }) => {
    if (u.perfil !== 'master') throw new HttpErro(403, 'Só o master zera a verificação em duas etapas.', 'perfil');
    const id = V.id(params.id);
    const alvo = await banco.um('SELECT id, nome, email, empresa_id FROM usuarios WHERE id = ?', [id]);
    if (!alvo) throw new HttpErro(404, 'Usuário não encontrado.');
    await doisFatores.zerar(id);
    acesso.invalidar();
    srv.revalidarSegundaEtapa();
    await auditoria.registrar(u, '2fa_zerada', { entidade: 'usuario', entidadeId: id, descricao: `zerou a verificação em duas etapas de ${alvo.nome} <${alvo.email}>`, ip, empresaId: alvo.empresa_id });
    return { ok: true };
  });
}

module.exports = { registrar };
