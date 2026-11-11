'use strict';
/**
 * FrotaGest — API da operação: sessão, frota ao vivo, alertas, histórico, comunicações, auditoria,
 * sistema, comandos ao DVR (vídeo, gravações) e downloads.
 * Reis Tecnologia
 */
const os = require('os');
const { HttpErro, validar: V, formatar, paraMs, agora } = require('../util/comum');
const { empresaAlvo, permite } = require('../auth/acesso');
const { normalizeId } = require('../protocolo/jt808');

const MAX_PONTOS = 20000;
const MAX_DIAS_HISTORICO = 7;

function registrar(srv) {
  const { banco, frota, auditoria, acesso, firebase, gateway, media, recorder, monitor, historico, config, retencao } = srv;
  const r = (m, c, h, o) => srv.rota(m, c, h, o);

  /* ---------------- público ---------------- */

  r('GET', '/api/publica/config', async () => ({
    nome: 'FrotaGest', versao: srv.versao, firebase: firebase.configPublica(),
  }), { publica: true });

  r('GET', '/api/saude', async ({ ip }) => {
    let bancoOk = false;
    try { await banco.query('SELECT 1'); bancoOk = true; } catch { /* fora */ }
    const r0 = { status: bancoOk ? 'ok' : 'degradado', versao: srv.versao, banco: bancoOk };
    // detalhes só para quem está no próprio servidor (scripts de instalação/atualização)
    if (ip === '127.0.0.1' || ip === '::1') r0.aparelhosOnline = [...gateway.devices.values()].filter((d) => d.online).length;
    return r0;
  }, { publica: true });

  /* ---------------- sessão ---------------- */

  r('GET', '/api/eu', async ({ u, ip, req }) => {
    await acesso.marcarAcesso(u);
    // o painel avisa quando acabou de abrir (login ou nova aba): fica na auditoria
    if (req.headers['x-novo-acesso'] === '1') await auditoria.registrar(u, 'acesso', { descricao: 'entrou no painel', ip });
    return {
      id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, perfilNome: u.perfilNome,
      empresaId: u.empresaId, empresaNome: u.empresaNome, todosGrupos: u.todosGrupos, pode: u.pode,
      acessos: u.acessos, acessoPersonalizado: Boolean(u.acessoPersonalizado),
      sessaoMin: config.numeroOuZero('sessao_inatividade_min'),
      doisFatores: { ativo: u.doisFatoresAtivo, exigido: srv.doisFatores ? srv.doisFatores.exige(u) : false },
    };
  });

  r('POST', '/api/ws-ticket', async ({ u, claims, ip, req }) => ({
    ticket: srv.newWsTicket(u, { uid: claims.uid, authTime: claims.authTime, ip, ua: req.headers['user-agent'] }), validoSeg: 60,
  }));

  r('POST', '/api/sair', async ({ u, ip, body }) => {
    if (body.motivo === 'inatividade') await auditoria.registrar(u, 'sessao_expirada', { descricao: 'sessão encerrada por falta de uso', ip });
    else await auditoria.registrar(u, 'saida', { descricao: 'saiu do painel', ip });
    return { ok: true };
  }, { livre2fa: true });

  /* ---------------- frota ao vivo ---------------- */

  r('GET', '/api/frota', async ({ u }) => {
    const itens = monitor.lista(u, acesso);
    const grupos = [...frota.grupos.values()]
      .filter((g) => (u.perfil === 'master' || g.empresa_id === u.empresaId) && (u.todosGrupos || u.grupos.has(g.id)))
      .map((g) => ({ id: g.id, empresaId: g.empresa_id, paiId: g.pai_id, nome: g.nome, caminho: frota.caminhoGrupo(g.id) }))
      .sort((a, b) => a.caminho.localeCompare(b.caminho, 'pt-BR'));
    const empresas = u.perfil === 'master'
      ? [...frota.empresas.values()].filter((e) => e.ativo).map((e) => ({ id: e.id, nome: e.nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      : [];
    return { itens, grupos, empresas, agora: agora() };
  });

  /** Veículos visíveis (ids) quando o usuário tem restrição de grupos; null = sem restrição além da empresa. */
  function veiculosPermitidos(u) {
    if (u.todosGrupos) return null;
    return [...frota.veiculos.values()].filter((v) => acesso.veVeiculo(u, v)).map((v) => v.id);
  }

  function periodo(query, maxDias) {
    const de = V.dataHora(query.de, 'a data inicial');
    const ate = V.dataHora(query.ate, 'a data final');
    if (ate <= de) throw new HttpErro(400, 'A data final precisa ser depois da inicial.');
    if (maxDias && paraMs(ate) - paraMs(de) > maxDias * 86400000) throw new HttpErro(400, `Escolha um período de até ${maxDias} dias.`);
    return { de, ate };
  }

  /** Aparelho pelo veículo ou pelo próprio id, conferindo se o usuário pode ver. */
  function alvoHistorico(u, query) {
    if (query.veiculo) {
      const v = frota.veiculos.get(V.id(query.veiculo, 'o veículo'));
      if (!v || !acesso.veVeiculo(u, v)) throw new HttpErro(404, 'Veículo não encontrado.');
      return { coluna: 'veiculo_id', id: v.id, veiculo: v, aparelho: v.aparelho_id ? frota.aparelhos.get(v.aparelho_id) : null };
    }
    const ap = frota.aparelhos.get(V.id(query.aparelho, 'o aparelho'));
    if (!ap || !acesso.veAparelho(u, ap)) throw new HttpErro(404, 'Aparelho não encontrado.');
    return { coluna: 'aparelho_id', id: ap.id, veiculo: frota.veiculoDoAparelho.get(ap.id) || null, aparelho: ap };
  }

  /* ---------------- histórico de posições ---------------- */

  r('GET', '/api/historico/posicoes', async ({ u, query }) => {
    const alvo = alvoHistorico(u, query);
    const { de, ate } = periodo(query, MAX_DIAS_HISTORICO);
    const rows = await banco.query(
      `SELECT data_hora, latitude, longitude, velocidade, direcao, ignicao, gps_valido, satelites, sinal, odometro, alarmes, alarmes_video
         FROM posicoes WHERE ${alvo.coluna} = ? AND data_hora BETWEEN ? AND ? ORDER BY data_hora, id LIMIT ?`,
      [alvo.id, de, ate, MAX_PONTOS + 1],
    );
    const cortado = rows.length > MAX_PONTOS;
    if (cortado) rows.length = MAX_PONTOS;
    // resumo do trajeto (só pontos com GPS válido)
    let km = 0;
    let velMax = 0;
    let movimentoSeg = 0;
    let ant = null;
    for (const p of rows) {
      p.latitude = Number(p.latitude);
      p.longitude = Number(p.longitude);
      p.velocidade = Number(p.velocidade);
      if (p.velocidade > velMax) velMax = p.velocidade;
      if (!p.gps_valido) continue;
      if (ant) {
        const d = distanciaKm(ant.latitude, ant.longitude, p.latitude, p.longitude);
        const dt = (paraMs(p.data_hora) - paraMs(ant.data_hora)) / 1000;
        if (d < 5 || (dt > 0 && d / (dt / 3600) < 250)) km += d; // ignora saltos impossíveis de GPS
        if (ant.velocidade > 3 && dt > 0 && dt < 600) movimentoSeg += dt;
      }
      ant = p;
    }
    return {
      veiculo: alvo.veiculo ? { id: alvo.veiculo.id, placa: alvo.veiculo.placa, prefixo: alvo.veiculo.prefixo } : null,
      aparelho: alvo.aparelho ? { id: alvo.aparelho.id, ident: alvo.aparelho.identificador } : null,
      de, ate, cortado, maxPontos: MAX_PONTOS,
      resumo: { pontos: rows.length, km: Math.round(km * 10) / 10, velocidadeMax: velMax, movimentoMin: Math.round(movimentoSeg / 60) },
      posicoes: rows,
    };
  }, { acesso: ['historico.ver', 'mapa.ver'] });

  /* ---------------- alertas ---------------- */

  r('GET', '/api/alertas', async ({ u, query }) => {
    const onde = [];
    const args = [];
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    if (emp) { onde.push('a.empresa_id = ?'); args.push(emp); }
    const perm = veiculosPermitidos(u);
    if (perm) {
      if (!perm.length) return { alertas: [], total: 0 };
      onde.push('a.veiculo_id IN (?)');
      args.push(perm);
    }
    if (query.situacao) {
      const s = V.opcao(query.situacao, ['novo', 'em_tratamento', 'tratado', 'pendentes'], 'a situação');
      if (s === 'pendentes') onde.push("a.situacao <> 'tratado'");
      else { onde.push('a.situacao = ?'); args.push(s); }
    }
    if (query.gravidade) { onde.push('a.gravidade = ?'); args.push(V.opcao(query.gravidade, ['alta', 'media', 'baixa'], 'a gravidade')); }
    if (query.ativos === '1') onde.push('a.fim IS NULL');
    if (query.veiculo) { onde.push('a.veiculo_id = ?'); args.push(V.id(query.veiculo, 'o veículo')); }
    if (query.de || query.ate) {
      const { de, ate } = periodo(query, 400);
      onde.push('a.inicio BETWEEN ? AND ?');
      args.push(de, ate);
    }
    const limite = Math.min(500, V.inteiro(query.limite, 'o limite', { min: 1, max: 500 }) || 200);
    const where = onde.length ? `WHERE ${onde.join(' AND ')}` : '';
    const alertas = await banco.query(`
      SELECT a.*, v.placa, v.prefixo, ap.identificador, e.nome AS empresa, us.nome AS tratado_por_nome, mo.nome AS motorista
        FROM alertas a
        LEFT JOIN motoristas mo ON mo.id = a.motorista_id
        LEFT JOIN veiculos v ON v.id = a.veiculo_id
        LEFT JOIN aparelhos ap ON ap.id = a.aparelho_id
        LEFT JOIN empresas e ON e.id = a.empresa_id
        LEFT JOIN usuarios us ON us.id = a.tratado_por
        ${where} ORDER BY a.inicio DESC, a.id DESC LIMIT ?`, [...args, limite]);
    const cont = await banco.um(`SELECT COUNT(*) AS n, SUM(a.situacao = 'novo') AS novos FROM alertas a ${where}`, args);
    return { alertas, total: Number(cont.n) || 0, novos: Number(cont.novos) || 0 };
  }, { acesso: 'alertas.ver' });

  r('GET', '/api/alertas/resumo', async ({ u }) => {
    const onde = ["a.situacao <> 'tratado'"];
    const args = [];
    if (u.perfil !== 'master') { onde.push('a.empresa_id = ?'); args.push(u.empresaId); }
    const perm = veiculosPermitidos(u);
    if (perm) {
      if (!perm.length) return { pendentes: 0, novos: 0, altas: 0 };
      onde.push('a.veiculo_id IN (?)');
      args.push(perm);
    }
    const x = await banco.um(`SELECT COUNT(*) AS pendentes, SUM(a.situacao = 'novo') AS novos, SUM(a.gravidade = 'alta' AND a.situacao = 'novo') AS altas
      FROM alertas a WHERE ${onde.join(' AND ')}`, args);
    return { pendentes: Number(x.pendentes) || 0, novos: Number(x.novos) || 0, altas: Number(x.altas) || 0 };
  }, { acesso: 'alertas.ver' });

  r('POST', '/api/alertas/:id/tratar', async ({ u, params, body, ip }) => {
    const id = V.id(params.id, 'o alerta');
    const a = await banco.um('SELECT * FROM alertas WHERE id = ?', [id]);
    if (!a) throw new HttpErro(404, 'Alerta não encontrado.');
    const visivel = u.perfil === 'master' || (a.empresa_id === u.empresaId && (a.veiculo_id ? acesso.veVeiculo(u, frota.veiculos.get(a.veiculo_id)) : u.perfil === 'admin'));
    if (!visivel) throw new HttpErro(404, 'Alerta não encontrado.');
    const situacao = V.opcao(body.situacao, ['em_tratamento', 'tratado'], 'a situação');
    const tratativa = V.texto(body.tratativa, 'a descrição do tratamento', { max: 500, obrigatorio: situacao === 'tratado' });
    await banco.query('UPDATE alertas SET situacao = ?, tratado_por = ?, tratado_em = ?, tratativa = COALESCE(?, tratativa) WHERE id = ?',
      [situacao, u.id, agora(), tratativa, id]);
    await auditoria.registrar(u, 'tratar_alerta', { entidade: 'alerta', entidadeId: id, descricao: `${a.nome}: ${situacao}${tratativa ? ` — ${tratativa}` : ''}`, ip, empresaId: a.empresa_id });
    srv.enviarAlerta({ acao: 'tratado', alerta: { id, empresaId: a.empresa_id, veiculoId: a.veiculo_id, aparelhoId: a.aparelho_id, situacao, tratadoPor: u.nome } });
    return { ok: true };
  }, { acesso: 'alertas.alterar' });

  /* ---------------- comunicações (conexões e comandos) ---------------- */

  r('GET', '/api/comunicacoes', async ({ u, query }) => {
    const { de, ate } = periodo(query, 31);
    const onde = [];
    const args = [];
    let alvo = null;
    if (query.veiculo || query.aparelho) {
      alvo = alvoHistorico(u, query);
      if (!alvo.aparelho) return { itens: [] };
      onde.push('x.aparelho_id = ?');
      args.push(alvo.aparelho.id);
    } else {
      const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
      if (emp) { onde.push('x.empresa_id = ?'); args.push(emp); }
    }
    const tipo = query.tipo ? V.opcao(query.tipo, ['conexoes', 'comandos'], 'o tipo') : null;
    const filtro = onde.length ? `AND ${onde.join(' AND ')}` : '';
    const partes = [];
    if (tipo !== 'comandos') {
      partes.push(banco.query(`
        SELECT 'conexao' AS origem, x.id, x.data_hora AS quando, x.identificador, x.aparelho_id, x.empresa_id, x.tipo AS nome, x.detalhe,
               x.ip, x.porta, NULL AS resultado, NULL AS tempo_ms, NULL AS usuario
          FROM eventos_aparelho x WHERE x.data_hora BETWEEN ? AND ? ${filtro} ORDER BY x.data_hora DESC LIMIT 500`, [de, ate, ...args]));
    }
    if (tipo !== 'conexoes') {
      partes.push(banco.query(`
        SELECT 'comando' AS origem, x.id, x.enviado_em AS quando, ap.identificador, x.aparelho_id, x.empresa_id, x.nome, x.detalhe,
               NULL AS ip, NULL AS porta, x.resultado, x.tempo_ms, us.nome AS usuario
          FROM comandos x JOIN aparelhos ap ON ap.id = x.aparelho_id LEFT JOIN usuarios us ON us.id = x.usuario_id
         WHERE x.enviado_em BETWEEN ? AND ? ${filtro} ORDER BY x.enviado_em DESC LIMIT 500`, [de, ate, ...args]));
    }
    const itens = (await Promise.all(partes)).flat()
      .filter((i) => u.perfil === 'master' || (i.aparelho_id && acesso.veAparelho(u, frota.aparelhos.get(i.aparelho_id))))
      .sort((a, b) => (a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : 0))
      .slice(0, 500);
    for (const i of itens) {
      const v = i.aparelho_id ? frota.veiculoDoAparelho.get(i.aparelho_id) : null;
      i.placa = v ? v.placa : null;
      if (u.perfil !== 'master') { i.ip = null; i.porta = null; }
    }
    return { itens };
  }, { acesso: 'comunicacoes.ver' });

  /* ---------------- auditoria ---------------- */

  r('GET', '/api/auditoria', async ({ u, query }) => {
    const { de, ate } = periodo(query, 400);
    const onde = ['x.data_hora BETWEEN ? AND ?'];
    const args = [de, ate];
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    if (emp) { onde.push('x.empresa_id = ?'); args.push(emp); }
    if (query.usuario) { onde.push('x.usuario_id = ?'); args.push(V.id(query.usuario, 'o usuário')); }
    if (query.acao) { onde.push('x.acao = ?'); args.push(V.texto(query.acao, 'a ação', { max: 40 })); }
    const itens = await banco.query(`
      SELECT x.*, us.nome AS usuario, us.email, e.nome AS empresa
        FROM auditoria x LEFT JOIN usuarios us ON us.id = x.usuario_id LEFT JOIN empresas e ON e.id = x.empresa_id
       WHERE ${onde.join(' AND ')} ORDER BY x.data_hora DESC, x.id DESC LIMIT 1000`, args);
    return { itens };
  }, { acesso: 'auditoria.ver' });

  /* ---------------- sistema (master) ---------------- */

  r('GET', '/api/sistema', async () => {
    const devs = [...gateway.devices.values()];
    const online = devs.filter((d) => d.online);
    const cont = await banco.um(`SELECT
        (SELECT COUNT(*) FROM empresas WHERE ativo = 1) AS empresas,
        (SELECT COUNT(*) FROM veiculos WHERE ativo = 1) AS veiculos,
        (SELECT COUNT(*) FROM aparelhos WHERE ativo = 1) AS aparelhos,
        (SELECT COUNT(*) FROM usuarios WHERE ativo = 1) AS usuarios,
        (SELECT COUNT(*) FROM aparelhos_pendentes) AS pendentes`).catch(() => null);
    const tamanho = await banco.query(`SELECT table_name AS tabela, table_rows AS linhas, ROUND((data_length + index_length) / 1048576, 1) AS mb
        FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (data_length + index_length) DESC`).catch(() => []);
    const mem = process.memoryUsage();
    return {
      versao: srv.versao,
      node: process.version,
      iniciadoEm: formatar(srv.iniciadoEm),
      agora: agora(),
      memoriaMb: Math.round(mem.rss / 1048576),
      carga: os.loadavg().map((x) => Math.round(x * 100) / 100),
      cpus: os.cpus().length,
      memoriaLivreMb: Math.round(os.freemem() / 1048576),
      memoriaTotalMb: Math.round(os.totalmem() / 1048576),
      portas: { sinalizacao: gateway.portas(), video: media.portas(), web: srv.cfg.port },
      conexoes: { aparelhos: gateway.conns.size, video: media.conns.size, painel: srv.eventos.size },
      aparelhosOnline: online.length,
      pendentesOnline: online.filter((d) => !frota.porIdent.has(d.id)).length,
      streams: media.snapshot(),
      conversao: srv.transcoders ? { ativa: srv.transcoders.enabled, motivo: srv.transcoders.reason, ...(srv.transcoders.info ? srv.transcoders.info() : {}) } : null,
      gravacoes: { ffmpeg: recorder.hasFfmpeg, usadoMb: Math.round(recorder.usedBytes() / 1048576), limiteGb: recorder.cfg.maxGB, retencaoDias: recorder.cfg.retencaoDias },
      banco: { ok: banco.ok, ultimoErro: banco.ultimoErro, ...historico.resumo(), cadastros: cont, tabelas: tamanho },
      limpeza: retencao.ultima,
      publicUrl: srv.publicUrl(),
      enderecoVideo: srv.mediaCfg.publicHost || null,
    };
  }, { pode: 'sistema' });

  r('POST', '/api/sistema/limpeza', async ({ u, ip }) => {
    const resumo = await retencao.rodar();
    if (resumo && srv.fotos) {
      const n = await srv.fotos.limpar().catch(() => 0);
      if (n) resumo.fotos = n;
    }
    await auditoria.registrar(u, 'limpeza', { descricao: JSON.stringify(resumo || {}), ip, empresaId: null });
    return { resumo };
  }, { pode: 'sistema' });

  r('GET', '/api/sistema/log', async ({ query }) => {
    const id = query.id ? normalizeId(V.identificador(query.id)) : null;
    return { entradas: srv.mensagens.filter((e) => !id || e.id === id).slice(-500) };
  }, { pode: 'sistema' });

  /* ---------------- comandos ao DVR ---------------- */

  /** capacidade: 'sistema' (master) ou 'tela.acao' do controle de acesso. */
  function dvr(u, ident, capacidade) {
    const id = normalizeId(V.identificador(ident));
    if (capacidade === 'sistema' ? !u.pode.sistema : capacidade && !permite(u, ...capacidade.split('.'))) {
      throw new HttpErro(403, 'Você não tem acesso a esta função. Fale com o administrador do sistema.', 'sem_acesso');
    }
    if (!acesso.aparelhoVisivel(u, id)) throw new HttpErro(404, 'Aparelho não encontrado.');
    return id;
  }

  const canal = (v, zero = false) => V.inteiro(v, 'o canal', { min: zero ? 0 : 1, max: 32, obrigatorio: true });
  const periodoDvr = (b) => {
    const start = V.dataHora(b.inicio, 'o início');
    const end = V.dataHora(b.fim, 'o fim');
    if (end <= start) throw new HttpErro(400, 'Período inválido.');
    return { start, end };
  };
  const midia = (id) => frota.midiaPara(id, (gateway.devices.get(id) || {}).port || null);

  // câmera ao vivo fica na auditoria (uma linha por pessoa, aparelho e canal a cada 10 min)
  const vistos = new Map();
  r('POST', '/api/dvr/:ident/video/iniciar', async ({ u, params, body, ip }) => {
    const id = dvr(u, params.ident, 'cameras.ver');
    const ch = canal(body.canal);
    media.expect(id, ch, 'live');
    const serial = gateway.comoUsuario(u.id, () => gateway.startVideo(id, { channel: ch, stream: Number(body.fluxo) === 0 ? 0 : 1 }, midia(id)));
    const chave = `${u.id}:${id}:${ch}`;
    const t = Date.now();
    if (!vistos.has(chave) || t - vistos.get(chave) > 600000) {
      vistos.set(chave, t);
      if (vistos.size > 5000) for (const [k, v] of vistos) if (t - v > 600000) vistos.delete(k);
      const ap = frota.porIdent.get(id);
      const v = ap ? frota.veiculoDoAparelho.get(ap.id) : null;
      await auditoria.registrar(u, 'ver_ao_vivo', { entidade: 'aparelho', entidadeId: ap ? ap.id : id, descricao: `${v ? `${v.prefixo ? `${v.prefixo} · ` : ''}${v.placa}, ` : ''}canal ${ch}`, ip, empresaId: ap ? ap.empresa_id : null });
    }
    return { ok: true, serial };
  });

  r('POST', '/api/dvr/:ident/video/parar', async ({ u, params, body }) => {
    const id = dvr(u, params.ident, 'cameras.ver');
    const ch = canal(body.canal);
    return { ok: true, serial: gateway.comoUsuario(u.id, () => gateway.stopVideo(id, ch)) };
  });

  r('POST', '/api/dvr/:ident/gravacoes/buscar', async ({ u, params, body }) => {
    const id = dvr(u, params.ident, 'gravacoes.ver');
    const ch = canal(body.canal, true);
    const { start, end } = periodoDvr(body);
    const list = await gateway.comoUsuario(u.id, () => gateway.queryResources(id, { channel: ch, start, end }));
    return { total: list.total, itens: list.items };
  });

  r('POST', '/api/dvr/:ident/reproducao/iniciar', async ({ u, params, body, ip }) => {
    const id = dvr(u, params.ident, 'gravacoes.ver');
    const ch = canal(body.canal);
    const { start, end } = periodoDvr(body);
    const s = media.expect(id, ch, 'playback', { purpose: 'ver', start, end });
    try {
      const serial = gateway.comoUsuario(u.id, () => gateway.startPlayback(id, { channel: ch, start, end }, midia(id)));
      srv.playbackSerials.set(`${id}:${serial}`, s.key);
      if (srv.playbackSerials.size > 100) srv.playbackSerials.delete(srv.playbackSerials.keys().next().value);
    } catch (e) {
      media.release(s.key);
      throw e;
    }
    await auditoria.registrar(u, 'ver_gravacao', { entidade: 'aparelho', entidadeId: id, descricao: `canal ${ch}, ${start} a ${end}`, ip });
    return { ok: true, key: s.key };
  });

  r('POST', '/api/dvr/:ident/reproducao/controle', async ({ u, params, body }) => {
    const id = dvr(u, params.ident, 'gravacoes.ver');
    const ch = canal(body.canal);
    const actions = { continuar: 0, pausar: 1, encerrar: 2, acelerar: 3 };
    if (!Object.prototype.hasOwnProperty.call(actions, body.acao)) throw new HttpErro(400, 'Ação inválida.');
    const speed = { 1: 1, 2: 2, 4: 3, 8: 4 }[Number(body.velocidade)] || 0;
    const control = body.acao === 'acelerar' && speed === 1 ? 0 : actions[body.acao];
    return { ok: true, serial: gateway.comoUsuario(u.id, () => gateway.controlPlayback(id, { channel: ch, control, speed: control === 3 ? speed : 0 })) };
  });

  r('POST', '/api/dvr/:ident/downloads', async ({ u, params, body, ip }) => {
    const id = dvr(u, params.ident, 'gravacoes.incluir');
    const ch = canal(body.canal);
    const { start, end } = periodoDvr(body);
    const ap = frota.porIdent.get(id);
    const v = ap ? frota.veiculoDoAparelho.get(ap.id) : null;
    const job = recorder.start(id, { channel: ch, start, end }, { empresaId: ap ? ap.empresa_id : null, usuarioId: u.id, rotulo: v ? v.placa : id });
    await auditoria.registrar(u, 'baixar_gravacao', { entidade: 'aparelho', entidadeId: id, descricao: `canal ${ch}, ${start} a ${end}`, ip, empresaId: ap ? ap.empresa_id : null });
    return { ok: true, download: job };
  });

  r('POST', '/api/dvr/:ident/atributos', async ({ u, params }) => {
    const id = dvr(u, params.ident, 'sistema');
    return { ok: true, serial: gateway.comoUsuario(u.id, () => gateway.queryAttributes(id)) };
  });

  r('POST', '/api/dvr/:ident/audio-video', async ({ u, params }) => {
    const id = dvr(u, params.ident, 'sistema');
    return { ok: true, serial: gateway.comoUsuario(u.id, () => gateway.queryAv(id)) };
  });

  r('GET', '/api/dvr/:ident', async ({ u, params }) => {
    const id = dvr(u, params.ident, null);
    const dev = gateway.devices.get(id);
    if (!dev) return { online: false };
    const s = gateway.summary(dev);
    if (u.perfil !== 'master') { delete s.remote; delete s.port; }
    return s;
  });

  /* ---------------- downloads ---------------- */

  r('GET', '/api/downloads', async ({ u }) => ({ downloads: srv.downloadsVisiveis(u), ffmpeg: recorder.hasFfmpeg }), { acesso: 'gravacoes.ver' });

  r('POST', '/api/downloads/:id/:acao', async ({ u, params, ip }) => {
    if (!/^[0-9a-f]{12}$/.test(params.id)) throw new HttpErro(404, 'Download não encontrado.');
    const job = recorder.get(params.id);
    if (!job || !srv.downloadVisivel(u, job)) throw new HttpErro(404, 'Download não encontrado.');
    if (params.acao === 'link') {
      if (job.status !== 'pronto') throw new HttpErro(409, 'O arquivo ainda não está pronto.');
      await auditoria.registrar(u, 'salvar_gravacao', { entidade: 'download', entidadeId: job.id, descricao: job.name, ip, empresaId: job.empresaId });
      return srv.novoLinkDownload(job, u);
    }
    if (params.acao === 'cancelar') { recorder.cancel(job.id); return { ok: true }; }
    if (params.acao === 'excluir') { recorder.remove(job.id); return { ok: true }; }
    throw new HttpErro(404, 'Ação inválida.');
  }, { acesso: 'gravacoes.incluir' });
}

function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

module.exports = { registrar };
