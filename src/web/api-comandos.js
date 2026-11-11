'use strict';
/**
 * FrotaGest — comandos para o veículo (pelo painel do veículo no Monitoramento):
 *  - mensagem ao motorista (aparece na tela do DVR e/ou é falada no alto-falante)
 *  - foto na hora de uma ou mais câmeras (chega pelo aparelho em alguns segundos)
 *  - reiniciar o aparelho e ler/mudar os parâmetros (intervalos de posição, limite de velocidade;
 *    APN e servidor só o master, porque um valor errado tira o aparelho do ar)
 * Reis Tecnologia
 */
const J = require('../protocolo/jt808');
const { HttpErro, validar: V } = require('../util/comum');
const { permite } = require('../auth/acesso');

const RESOLUCOES = { baixa: 1, media: 2, alta: 4 };

function registrar(srv) {
  const { banco, frota, gateway, acesso, auditoria, fotos } = srv;

  /** Aparelho que o usuário enxerga e a ação que ele pode fazer ('comandos.incluir'...). */
  function alvo(u, ident, acao) {
    const id = J.normalizeId(V.identificador(ident));
    if (!permite(u, 'comandos', acao)) throw new HttpErro(403, 'Você não tem acesso a esta função. Fale com o administrador do sistema.', 'sem_acesso');
    if (!acesso.aparelhoVisivel(u, id)) throw new HttpErro(404, 'Aparelho não encontrado.');
    const ap = frota.porIdent.get(id);
    if (!ap) throw new HttpErro(404, 'Aparelho não cadastrado.');
    const v = frota.veiculoDoAparelho.get(ap.id) || null;
    return { id, ap, v, rotulo: v ? `${v.prefixo ? `${v.prefixo} · ` : ''}${v.placa}` : `aparelho ${id}` };
  }

  const online = (id) => {
    const d = gateway.devices.get(id);
    if (!d || !d.online) throw new HttpErro(409, 'O aparelho está offline: espere ele voltar a se conectar e tente de novo.', 'offline');
    return d;
  };

  /** Erro do aparelho (não respondeu, recusou) vira mensagem para a tela. */
  const doAparelho = (e) => {
    if (e instanceof HttpErro) return e;
    const m = String(e.message || e);
    if (/não respondeu/.test(m)) return new HttpErro(504, `O aparelho não respondeu (${m.replace(/^.*não respondeu /, '')}). Ele pode estar em área sem sinal.`);
    if (/não suportado/.test(m)) return new HttpErro(422, 'Este aparelho não aceita este comando.');
    return new HttpErro(502, `O aparelho recusou: ${m.replace(/^[^:]+: /, '')}.`);
  };

  const fotoPublica = (f, u) => ({
    id: f.id, canal: f.canal, dataHora: f.data_hora, latitude: f.latitude === null ? null : Number(f.latitude), longitude: f.longitude === null ? null : Number(f.longitude),
    velocidade: f.velocidade === null ? null : Number(f.velocidade), bytes: f.bytes, pedidaPor: f.usuario_nome || null, sua: f.usuario_id === u.id,
  });

  srv.rota('GET', '/api/dvr/:ident/comandos', async ({ u, params }) => {
    const { id, ap } = alvo(u, params.ident, 'ver');
    const dev = gateway.devices.get(id);
    const historico = await banco.query(
      `SELECT c.mensagem, c.nome, c.detalhe, c.enviado_em, c.respondido_em, c.resultado, us.nome AS usuario
         FROM comandos c LEFT JOIN usuarios us ON us.id = c.usuario_id
        WHERE c.aparelho_id = ? AND c.mensagem IN (?) ORDER BY c.enviado_em DESC, c.id DESC LIMIT 15`,
      [ap.id, [J.MSG.TEXT_MESSAGE, J.MSG.CAMERA_SHOT, J.MSG.TERMINAL_CONTROL, J.MSG.SET_PARAMS, J.MSG.QUERY_PARAMS]]);
    const lista = await banco.query(
      `SELECT f.*, us.nome AS usuario_nome FROM fotos f LEFT JOIN usuarios us ON us.id = f.usuario_id
        WHERE f.aparelho_id = ? ORDER BY f.data_hora DESC, f.id DESC LIMIT 12`, [ap.id]);
    return {
      online: Boolean(dev && dev.online), protocolo: dev ? (dev.v2019 ? '2019' : '2013') : null,
      canais: ap.canais || 4, nomesCanais: ap.nomes_canais || [],
      historico, fotos: lista.map((f) => fotoPublica(f, u)),
      pode: { incluir: permite(u, 'comandos', 'incluir'), alterar: permite(u, 'comandos', 'alterar'), master: u.perfil === 'master' },
    };
  }, { acesso: 'comandos.ver' });

  srv.rota('POST', '/api/dvr/:ident/mensagem', async ({ u, params, body, ip }) => {
    const a = alvo(u, params.ident, 'incluir');
    const texto = V.texto(body.texto, 'a mensagem', { max: 200, obrigatorio: true });
    if (!J.semAcentos(texto)) throw new HttpErro(400, 'Escreva a mensagem com letras e números.');
    const tela = V.booleano(body.tela, true);
    const voz = V.booleano(body.voz, true);
    if (!tela && !voz) throw new HttpErro(400, 'Escolha mostrar na tela, falar em voz alta, ou os dois.');
    online(a.id);
    try {
      await gateway.comoUsuario(u.id, () => gateway.mensagem(a.id, { texto, tela, voz, urgente: V.booleano(body.urgente, false) }));
    } catch (e) { throw doAparelho(e); }
    await auditoria.registrar(u, 'mensagem_motorista', { entidade: 'aparelho', entidadeId: a.ap.id, descricao: `${a.rotulo}: "${texto.slice(0, 120)}"`, ip, empresaId: a.ap.empresa_id });
    return { ok: true, enviado: J.semAcentos(texto) };
  }, { acesso: 'comandos.incluir', limite: { chave: 'cmd-msg', max: 60, minutos: 10 } });

  srv.rota('POST', '/api/dvr/:ident/foto', async ({ u, params, body, ip }) => {
    const a = alvo(u, params.ident, 'incluir');
    const lista = Array.isArray(body.canais) ? body.canais : [body.canal];
    const canais = [...new Set(lista.map((c) => V.inteiro(c, 'o canal', { min: 1, max: 32, obrigatorio: true })))];
    if (!canais.length || canais.length > 16) throw new HttpErro(400, 'Escolha as câmeras.');
    const resolution = RESOLUCOES[body.qualidade] || RESOLUCOES.media;
    online(a.id);
    const resultados = [];
    for (const ch of canais) {
      fotos.pedido(a.id, ch, u.id);
      try {
        const r = await gateway.comoUsuario(u.id, () => gateway.foto(a.id, { channel: ch, resolution }));
        resultados.push({ canal: ch, ok: true, ids: (r && r.ids) || [] });
      } catch (e) {
        resultados.push({ canal: ch, ok: false, erro: doAparelho(e).message });
      }
    }
    await auditoria.registrar(u, 'foto_agora', { entidade: 'aparelho', entidadeId: a.ap.id, descricao: `${a.rotulo}: câmera ${canais.join(', ')}`, ip, empresaId: a.ap.empresa_id });
    return { resultados };
  }, { acesso: 'comandos.incluir', limite: { chave: 'cmd-foto', max: 120, minutos: 10 } });

  srv.rota('POST', '/api/dvr/:ident/reiniciar', async ({ u, params, ip }) => {
    const a = alvo(u, params.ident, 'alterar');
    online(a.id);
    try {
      await gateway.comoUsuario(u.id, () => gateway.reiniciar(a.id));
    } catch (e) { throw doAparelho(e); }
    await auditoria.registrar(u, 'reiniciar_aparelho', { entidade: 'aparelho', entidadeId: a.ap.id, descricao: a.rotulo, ip, empresaId: a.ap.empresa_id });
    return { ok: true };
  }, { acesso: 'comandos.alterar', limite: { chave: 'cmd-reiniciar', max: 10, minutos: 10 } });

  /** Parâmetros lidos: os conhecidos com nome; a senha do APN nunca vai para a tela. */
  function parametrosPublicos(r, dev) {
    const itens = r.itens.map((x) => ({ ...x, valor: x.chave === 'apnSenha' ? (x.valor ? '••••••' : '') : x.valor }));
    const mapa = Object.fromEntries(itens.filter((x) => x.chave).map((x) => [x.chave, x.valor]));
    // 2013: servidor e porta separados; 2019: "servidor:porta" num campo só
    if (mapa.servidor && !/:\d+$/.test(String(mapa.servidor)) && mapa.porta) mapa.servidor = `${mapa.servidor}:${mapa.porta}`;
    return { valores: mapa, itens, total: r.total, v2019: Boolean(dev && dev.v2019) };
  }

  srv.rota('POST', '/api/dvr/:ident/parametros/ler', async ({ u, params }) => {
    const a = alvo(u, params.ident, 'alterar');
    const dev = online(a.id);
    try {
      return parametrosPublicos(await gateway.comoUsuario(u.id, () => gateway.lerParametros(a.id)), dev);
    } catch (e) { throw doAparelho(e); }
  }, { acesso: 'comandos.alterar', limite: { chave: 'cmd-param', max: 30, minutos: 10 } });

  srv.rota('PUT', '/api/dvr/:ident/parametros', async ({ u, params, body, ip }) => {
    const a = alvo(u, params.ident, 'alterar');
    const dev = online(a.id);
    const P = J.PARAM_POR_CHAVE;
    const lista = [];
    const num = (chave, nome, min, max, unidade) => {
      if (V.vazio(body[chave])) return;
      const n = Number(String(body[chave]).trim());
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpErro(400, `${nome} deve ficar entre ${min} e ${max} ${unidade}.`);
      lista.push({ id: P[chave], valor: n, texto: `${nome.toLowerCase()} = ${n} ${unidade}` });
    };
    num('intervaloPosicao', 'Posição com o veículo ligado', 5, 3600, 's');
    num('intervaloDormindo', 'Posição com o veículo desligado', 30, 86400, 's');
    num('batimento', 'Sinal de vida', 10, 3600, 's');
    num('velocidadeMax', 'Velocidade máxima no aparelho', 20, 250, 'km/h');
    num('tempoExcesso', 'Tempo acima da velocidade', 0, 600, 's');
    const sensiveis = ['apn', 'apnUsuario', 'apnSenha', 'servidor'].filter((k) => !V.vazio(body[k]));
    if (sensiveis.length) {
      if (u.perfil !== 'master') throw new HttpErro(403, 'Só o master muda o APN e o servidor do aparelho.');
      if (body.confirmacao !== 'ALTERAR') throw new HttpErro(400, 'Digite ALTERAR para confirmar a mudança do APN ou do servidor.');
      for (const k of ['apn', 'apnUsuario', 'apnSenha']) {
        if (V.vazio(body[k])) continue;
        const s = String(body[k]).trim();
        if (s.length > 60 || /[^\x20-\x7e]/.test(s)) throw new HttpErro(400, 'APN, usuário e senha: até 60 letras e números, sem acento.');
        lista.push({ id: P[k], valor: s, texto: k === 'apnSenha' ? 'senha do APN' : `${k === 'apn' ? 'APN' : 'usuário do APN'} = ${s}` });
      }
      if (!V.vazio(body.servidor)) {
        const m = /^([A-Za-z0-9.-]{3,80}):(\d{2,5})$/.exec(String(body.servidor).trim());
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new HttpErro(400, 'Servidor no formato endereço:porta (ex.: frotagest.exemplo.com.br:6608).');
        // 2019: "endereço:porta" no 0x0013; 2013: endereço no 0x0013 e a porta no 0x0018
        if (dev.v2019) lista.push({ id: P.servidor, valor: `${m[1]}:${m[2]}`, texto: `servidor = ${m[1]}:${m[2]}` });
        else lista.push({ id: P.servidor, valor: m[1], texto: `servidor = ${m[1]}` }, { id: P.porta, valor: Number(m[2]), texto: `porta = ${m[2]}` });
      }
    }
    if (!lista.length) throw new HttpErro(400, 'Nada para mudar.');
    try {
      await gateway.comoUsuario(u.id, () => gateway.gravarParametros(a.id, lista));
    } catch (e) { throw doAparelho(e); }
    await auditoria.registrar(u, 'parametros_aparelho', { entidade: 'aparelho', entidadeId: a.ap.id, descricao: `${a.rotulo}: ${lista.map((x) => x.texto).join('; ')}`.slice(0, 500), ip, empresaId: a.ap.empresa_id });
    return { ok: true, alterados: lista.length };
  }, { acesso: 'comandos.alterar', limite: { chave: 'cmd-param', max: 30, minutos: 10 } });

  srv.rota('GET', '/api/fotos/:id', async ({ u, params, res }) => {
    const f = await banco.um('SELECT * FROM fotos WHERE id = ?', [V.id(params.id, 'a foto')]);
    const ap = f ? frota.aparelhos.get(f.aparelho_id) : null;
    if (!f || !ap || !acesso.veAparelho(u, ap)) throw new HttpErro(404, 'Foto não encontrada.');
    let dados;
    try { dados = await fotos.arquivo(f); } catch { throw new HttpErro(404, 'O arquivo desta foto não existe mais.'); }
    res.writeHead(200, srv.cabecalhos({
      'Content-Type': 'image/jpeg', 'Content-Length': dados.length, 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `inline; filename="foto-${f.id}-canal-${f.canal}.jpg"`,
    }));
    res.end(dados);
  }, { acesso: 'comandos.ver' });
}

module.exports = { registrar };
