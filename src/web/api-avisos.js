'use strict';
/**
 * FrotaGest — API dos avisos no celular (Web Push): ativar/desativar em cada aparelho, nível dos avisos
 * e aviso de teste. Cada pessoa mexe só nos aparelhos dela.
 * Reis Tecnologia
 */
const { HttpErro, validar: V } = require('../util/comum');
const { navegador } = require('./api-online');

function registrar(srv) {
  const { avisos, auditoria } = srv;

  srv.rota('GET', '/api/push', async ({ u }) => avisos.situacao(u), { acesso: 'alertas.ver' });

  srv.rota('POST', '/api/push/inscricao', async ({ u, body, req, ip }) => {
    const nav = navegador(req.headers['user-agent']);
    const aparelho = `${nav.texto}${body && body.instalado ? ' (app)' : ''}`.slice(0, 80);
    const r = await avisos.inscrever(u, body || {}, aparelho);
    if (r.ativo && !(body && body.sincronizar)) {
      await auditoria.registrar(u, 'ativar_avisos', { entidade: 'usuario', entidadeId: u.id, descricao: `Avisos no celular ativados em ${aparelho}`, ip, empresaId: u.empresaId });
    }
    return r;
  }, { acesso: 'alertas.ver', limite: { chave: 'push', max: 60, minutos: 10 } });

  // remover vale sempre (até para quem perdeu o menu Alertas): é o "parar de receber"
  srv.rota('POST', '/api/push/remover', async ({ u, body }) => {
    const id = body && body.id ? V.id(body.id, 'o aparelho') : null;
    const endpoint = body && body.endpoint ? String(body.endpoint).slice(0, 1000) : null;
    if (!id && !endpoint) throw new HttpErro(400, 'Informe o aparelho.');
    return { removido: await avisos.remover(u, { id, endpoint }) };
  });

  srv.rota('PUT', '/api/push/nivel', async ({ u, body }) => {
    await avisos.definirNivel(u, String((body && body.nivel) || ''));
    return { ok: true };
  }, { acesso: 'alertas.ver' });

  srv.rota('PUT', '/api/push/manutencao', async ({ u, body }) => {
    await avisos.definirManutencao(u, V.booleano(body && body.ligado, true));
    return { ok: true };
  }, { acesso: 'manutencao.ver' });

  srv.rota('POST', '/api/push/teste', async ({ u, body }) => avisos.teste(u, body && body.id ? V.id(body.id, 'o aparelho') : null),
    { acesso: 'alertas.ver', limite: { chave: 'push-teste', max: 10, minutos: 10 } });
}

module.exports = { registrar };
