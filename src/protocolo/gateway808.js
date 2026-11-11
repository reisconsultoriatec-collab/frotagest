'use strict';
/**
 * FrotaGest — gateway JT/T 808: recebe os DVRs, responde, guarda o estado e envia comandos.
 * Escuta em várias portas ao mesmo tempo (uma por perfil de protocolo).
 * Reis Tecnologia
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const J = require('./jt808');
const { sincronizarPortas } = require('./portas');

const HISTORY = 120; // posições guardadas em memória por aparelho para desenhar o rastro no mapa

class Gateway808 extends EventEmitter {
  constructor(cfg, dataDir) {
    super();
    this.cfg = cfg;
    this.devices = new Map();
    this.conns = new Set();
    this.storeFile = path.join(dataDir, 'codigos-autenticacao.json');
    this.store = this.loadStore();
    this.waiters = new Map(); // `${id}:${serial}` → { resolve, reject, timer }
    this.servidores = new Map(); // porta → net.Server
    // Decide se um aparelho pode ficar conectado: (id, ctx) → { ok: true } ou { ok: false, motivo }
    this.autorizar = null;
    // Quem pediu o comando que está sendo enviado agora (vai junto no evento commandSent)
    this.comandoUsuario = null;
  }

  /* ---------- persistência dos códigos de autenticação ---------- */

  loadStore() {
    try { return JSON.parse(fs.readFileSync(this.storeFile, 'utf8')); } catch { return {}; }
  }

  saveStore() {
    try { fs.writeFileSync(this.storeFile, JSON.stringify(this.store, null, 2)); } catch (e) { this.log('erro', null, `Falha ao gravar ${this.storeFile}: ${e.message}`); }
  }

  /* ---------- servidor ---------- */

  /** Abre/fecha as portas de sinalização conforme os perfis ativos. Retorna [{ porta, ok, erro }]. */
  async sincronizarPortas(portas) {
    const r = await sincronizarPortas(this, portas, this.cfg.host, (sock) => this.onConnection(sock), (porta) => {
      for (const ctx of this.conns) if (ctx.port === porta) ctx.sock.destroy();
    });
    for (const x of r) {
      if (x.aberta) this.log('ok', null, `Recebendo aparelhos na porta ${x.porta}`);
      if (x.fechada) this.log('aviso', null, `Porta ${x.porta} fechada (perfil desativado ou alterado)`);
      if (!x.ok) this.log('erro', null, `Não foi possível abrir a porta ${x.porta}: ${x.erro}`);
    }
    return r;
  }

  portas() {
    return [...this.servidores.keys()].sort((a, b) => a - b);
  }

  /** Desconecta quem não pode mais ficar (cadastro desativado, aparelho recusado). */
  reavaliar() {
    if (!this.autorizar) return;
    for (const dev of this.devices.values()) {
      if (!dev.ctx) continue;
      const r = this.autorizar(dev.id, dev.ctx);
      if (!r.ok) {
        this.log('aviso', dev.id, `Aparelho ${dev.id} desconectado: ${r.motivo}`);
        dev.ctx.sock.destroy();
      }
    }
  }

  log(level, id, text, extra = {}) {
    this.emit('log', { at: Date.now(), source: '808', level, id, text, ...extra });
  }

  onConnection(sock) {
    const remote = `${(sock.remoteAddress || '').replace(/^::ffff:/, '')}:${sock.remotePort}`;
    if (this.conns.size >= this.cfg.maxConnections) {
      this.log('aviso', null, `Conexão recusada de ${remote}: limite de ${this.cfg.maxConnections} conexões`);
      sock.destroy();
      return;
    }
    const ctx = { sock, remote, ip: remote.replace(/:\d+$/, ''), port: sock.localPort, splitter: new J.FrameSplitter(), device: null, parts: new Map(), badFrames: 0 };
    this.conns.add(ctx);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 60000);
    sock.setTimeout(this.cfg.idleTimeoutSec * 1000);
    this.log('info', null, `Nova conexão na porta ${ctx.port} vinda de ${remote}`);

    sock.on('data', (chunk) => {
      ctx.rx = (ctx.rx || 0) + chunk.length;
      for (const f of ctx.splitter.push(chunk)) this.onFrame(ctx, f);
      if (ctx.device && ctx.device.ctx === ctx) { ctx.device.rxBytes += ctx.rx - (ctx.counted || 0); ctx.counted = ctx.rx; }
      if (ctx.splitter.overflows > 3) {
        this.log('aviso', ctx.device && ctx.device.id, `Dados sem formato JT/T 808 vindos de ${remote}; conexão encerrada`);
        sock.destroy();
      }
    });
    sock.on('timeout', () => {
      this.log('aviso', ctx.device && ctx.device.id, `Sem dados há ${this.cfg.idleTimeoutSec}s; conexão de ${remote} encerrada`);
      sock.destroy();
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.conns.delete(ctx);
      const dev = ctx.device;
      if (dev && dev.ctx === ctx) {
        dev.ctx = null;
        dev.online = false;
        dev.authenticated = false;
        this.log('aviso', dev.id, `Aparelho ${dev.id} desconectou (${remote})`);
        this.emit('offline', { id: dev.id, ip: ctx.ip, port: ctx.port, motivo: ctx.motivo || null });
        this.emit('device', this.summary(dev));
      } else {
        this.log('info', null, `Conexão ${remote} encerrada`);
      }
    });
  }

  onFrame(ctx, raw) {
    let m;
    try {
      m = J.decode(raw);
    } catch (e) {
      ctx.badFrames++;
      this.log('erro', ctx.device && ctx.device.id, `Mensagem inválida de ${ctx.remote}: ${e.message}`, { hex: J.hex(raw, 128) });
      if (ctx.badFrames > 20) ctx.sock.destroy();
      return;
    }

    const id = J.normalizeId(m.phone);
    if (ctx.idChecked !== id && this.autorizar) {
      const r = this.autorizar(id, ctx, m);
      if (!r.ok) {
        if (!ctx.recusado) this.log('aviso', id, `Aparelho ${id} recusado (${r.motivo}); conexão de ${ctx.remote} encerrada`);
        ctx.recusado = true;
        this.emit('recusado', { id, ip: ctx.ip, port: ctx.port, motivo: r.motivo });
        ctx.sock.destroy();
        return;
      }
      ctx.idChecked = id;
    }

    let dev = this.devices.get(id);
    if (!dev) {
      dev = this.newDevice(id);
      this.devices.set(id, dev);
    }
    if (dev.ctx && dev.ctx !== ctx) {
      this.log('aviso', id, `Aparelho ${id} abriu nova conexão; a anterior (${dev.ctx.remote}) foi encerrada`);
      const old = dev.ctx;
      dev.ctx = null;
      old.sock.destroy();
    }
    const wasOnline = dev.online;
    dev.ctx = ctx;
    ctx.device = dev;
    dev.online = true;
    dev.remote = ctx.remote;
    dev.port = ctx.port;
    dev.v2019 = m.v2019;
    dev.protocolVersion = m.protocolVersion;
    dev.phoneBcd = m.phoneBcd;
    dev.phone = m.phone;
    dev.lastSeen = Date.now();
    dev.messages++;

    // Subpacotes: junta as partes antes de interpretar
    if (m.sub) {
      this.reply(dev, m, 0);
      const key = `${m.msgId}`;
      let p = ctx.parts.get(key);
      // partes de um envio que parou no meio (mais de 2 min sem chegar nada) não se misturam com o próximo
      if (!p || p.total !== m.total || Date.now() - p.at > 120000) { p = { total: m.total, items: new Map(), at: Date.now() }; ctx.parts.set(key, p); }
      p.at = Date.now();
      p.items.set(m.index, m.body);
      this.logMsg('in', dev, m, `parte ${m.index} de ${m.total}`);
      if (p.items.size < p.total) return;
      ctx.parts.delete(key);
      const ordered = [];
      for (let i = 1; i <= p.total; i++) ordered.push(p.items.get(i) || Buffer.alloc(0));
      m.body = Buffer.concat(ordered);
    }

    try {
      this.handle(dev, m);
    } catch (e) {
      this.log('erro', id, `Falha ao interpretar ${J.MSG_NAMES[m.msgId] || hexId(m.msgId)}: ${e.message}`, { hex: J.hex(m.raw, 256) });
      this.reply(dev, m, 2);
    }
    if (!wasOnline) {
      this.log('ok', id, `Aparelho ${id} online (${dev.v2019 ? 'JT/T 808-2019' : 'JT/T 808-2013'}, ${ctx.remote})`);
      this.emit('online', { id, ip: ctx.ip, port: ctx.port, protocolo: dev.v2019 ? 'JT/T 808-2019' : 'JT/T 808-2013' });
    }
    this.emit('device', this.summary(dev));
  }

  newDevice(id) {
    return {
      id, online: false, authenticated: false, ctx: null, remote: null, v2019: false, protocolVersion: null,
      phoneBcd: null, phone: null, serial: 0, messages: 0, firstSeen: Date.now(), lastSeen: null, rxBytes: 0, txBytes: 0, port: null,
      register: null, auth: null, attributes: null, av: null, position: null, track: [], pending: new Map(),
    };
  }

  handle(dev, m) {
    const id = dev.id;
    switch (m.msgId) {
      case J.MSG.REGISTER: {
        const reg = J.parseRegister(m.body, m.v2019);
        dev.register = reg;
        const code = this.issueAuthCode(id);
        this.logMsg('in', dev, m, `fabricante ${reg.manufacturer || '?'}, modelo ${reg.model || '?'}, placa ${reg.plate || '?'}`, reg);
        this.send(dev, J.MSG.REGISTER_RESP, J.bodyRegisterResponse(m.serial, 0, code), `código de autenticação emitido`);
        this.emit('registro', { id, ip: dev.ctx && dev.ctx.ip, port: dev.port, registro: reg });
        return;
      }
      case J.MSG.AUTH: {
        const a = J.parseAuth(m.body, m.v2019);
        dev.auth = { imei: a.imei, software: a.software };
        const known = this.store[id] && this.store[id].authCode;
        let ok = true;
        let note;
        if (known && known === a.authCode) note = 'código confere';
        else if (this.cfg.acceptUnknownAuthCode) note = known ? 'código diferente do emitido — aceito' : 'código emitido por outra plataforma — aceito';
        else { ok = false; note = 'código não reconhecido — recusado'; }
        this.logMsg('in', dev, m, `${note}${a.imei ? `, IMEI ${a.imei}` : ''}${a.software ? `, firmware ${a.software}` : ''}`, a);
        dev.authenticated = ok;
        this.reply(dev, m, ok ? 0 : 1);
        if (ok) this.log('ok', id, `Aparelho ${id} autenticado`);
        this.emit('autenticacao', { id, ok, nota: note, imei: a.imei || null, firmware: a.software || null });
        return;
      }
      case J.MSG.HEARTBEAT:
        this.logMsg('in', dev, m, '', null, true);
        this.reply(dev, m, 0, true);
        return;
      case J.MSG.LOGOUT:
        this.logMsg('in', dev, m, '');
        this.reply(dev, m, 0);
        return;
      case J.MSG.LOCATION: {
        if (!this.checkAuth(dev, m)) return;
        const p = J.parseLocation(m.body);
        this.addPosition(dev, p);
        this.logMsg('in', dev, m, positionText(p), p);
        this.reply(dev, m, 0);
        return;
      }
      case J.MSG.BATCH_LOCATION: {
        if (!this.checkAuth(dev, m)) return;
        const b = J.parseBatchLocation(m.body);
        b.items.forEach((p) => this.addPosition(dev, p));
        this.logMsg('in', dev, m, `${b.items.length} posições (${b.type})`, b);
        this.reply(dev, m, 0);
        return;
      }
      case J.MSG.TERM_GENERAL_RESP: {
        const r = J.parseTerminalResponse(m.body);
        const cmd = r && dev.pending.get(r.replySerial);
        if (cmd) dev.pending.delete(r.replySerial);
        const name = r ? (J.MSG_NAMES[r.replyId] || hexId(r.replyId)) : '?';
        this.logMsg('in', dev, m, r ? `para "${name}": ${r.resultName}` : 'resposta incompleta', r);
        if (r) this.emit('command', { id, msgId: r.replyId, replySerial: r.replySerial, name, result: r.result, resultName: r.resultName, at: Date.now(), elapsedMs: cmd ? Date.now() - cmd.at : null });
        if (r && r.result !== 0) this.settle(id, r.replySerial, new Error(`${name}: ${r.resultName}`));
        else if (r) this.settle(id, r.replySerial, null, r, ['geral', 'foto']); // só quem espera a resposta geral
        return;
      }
      case J.MSG.PARAMS_RESP: {
        const r = J.parseParamsResponse(m.body);
        this.logMsg('in', dev, m, `${r.itens.length} parâmetro(s)`, { total: r.total, itens: r.itens.filter((x) => x.chave !== 'apnSenha') });
        this.reply(dev, m, 0);
        const cmd = dev.pending.get(r.replySerial);
        if (cmd) {
          dev.pending.delete(r.replySerial);
          this.emit('command', { id, msgId: cmd.msgId, replySerial: r.replySerial, name: J.MSG_NAMES[cmd.msgId], result: 0, resultName: `${r.itens.length} parâmetro(s)`, at: Date.now(), elapsedMs: Date.now() - cmd.at });
        }
        this.settle(id, r.replySerial, null, r);
        return;
      }
      case J.MSG.CAMERA_RESP: {
        const r = J.parseCameraResponse(m.body);
        this.logMsg('in', dev, m, r ? `foto: ${r.resultName}${r.ids.length ? ` (nº ${r.ids.join(', ')})` : ''}` : 'resposta incompleta', r);
        this.reply(dev, m, 0);
        if (!r) return;
        const cmd = dev.pending.get(r.replySerial);
        if (cmd) {
          dev.pending.delete(r.replySerial);
          this.emit('command', { id, msgId: J.MSG.CAMERA_SHOT, replySerial: r.replySerial, name: J.MSG_NAMES[J.MSG.CAMERA_SHOT], result: r.result, resultName: r.resultName, at: Date.now(), elapsedMs: Date.now() - cmd.at });
        }
        if (r.result !== 0) this.settle(id, r.replySerial, new Error(`Foto: ${r.resultName}`));
        else this.settle(id, r.replySerial, null, r);
        return;
      }
      case J.MSG.MEDIA_EVENT: {
        const e = J.parseMediaEvent(m.body);
        this.logMsg('in', dev, m, e ? `mídia nº ${e.mediaId} (${['foto', 'áudio', 'vídeo'][e.type] || e.type}, canal ${e.channel})` : 'incompleto', e);
        this.reply(dev, m, 0);
        return;
      }
      case J.MSG.MEDIA_UPLOAD: {
        const md = J.parseMediaUpload(m.body);
        this.logMsg('in', dev, m, `mídia nº ${md.mediaId}: ${['foto', 'áudio', 'vídeo'][md.type] || md.type} do canal ${md.channel}, ${Math.round(md.data.length / 1024)} KB`,
          { mediaId: md.mediaId, type: md.type, format: md.format, event: md.event, channel: md.channel, bytes: md.data.length });
        this.send(dev, J.MSG.MEDIA_UPLOAD_RESP, J.bodyMediaUploadResponse(md.mediaId), `mídia nº ${md.mediaId} recebida inteira`, true);
        this.emit('midia', { id, ...md, recebidoEm: Date.now() });
        return;
      }
      case J.MSG.RESOURCE_LIST: {
        const list = J.parseResourceList(m.body);
        const alarmed = list.items.filter((i) => i.alarms.length).length;
        this.logMsg('in', dev, m, `${list.items.length} trecho(s) gravado(s)${alarmed ? `, ${alarmed} com alarme` : ''}`, { total: list.total, primeiros: list.items.slice(0, 5) });
        this.reply(dev, m, 0);
        this.settle(id, list.replySerial, null, list);
        const consulta = dev.pending.get(list.replySerial);
        if (consulta && consulta.msgId === J.MSG.QUERY_RESOURCES) {
          dev.pending.delete(list.replySerial);
          this.emit('command', {
            id, msgId: J.MSG.QUERY_RESOURCES, replySerial: list.replySerial, name: J.MSG_NAMES[J.MSG.QUERY_RESOURCES],
            result: 0, resultName: `${list.items.length} trecho(s) gravado(s)`, items: list.items.length, at: Date.now(), elapsedMs: Date.now() - consulta.at,
          });
        }
        // Pela norma, o DVR também responde ao pedido de reprodução (0x9201) com a lista do que vai enviar
        const asked = dev.pending.get(list.replySerial);
        if (asked && asked.msgId === J.MSG.PLAYBACK_REQUEST) {
          dev.pending.delete(list.replySerial);
          this.emit('command', {
            id, msgId: J.MSG.PLAYBACK_REQUEST, replySerial: list.replySerial, name: J.MSG_NAMES[J.MSG.PLAYBACK_REQUEST],
            result: 0, resultName: list.items.length ? `aceito (${list.items.length} trecho(s))` : 'aceito, mas o DVR não listou gravação nesse período',
            items: list.items.length, at: Date.now(), elapsedMs: Date.now() - asked.at,
          });
        }
        return;
      }
      case J.MSG.ATTRIBUTES_RESP: {
        dev.attributes = J.parseAttributes(m.body, m.v2019);
        const a = dev.attributes;
        this.logMsg('in', dev, m, `${a.manufacturer || ''} ${a.model || ''}, firmware ${a.firmware || '?'}, ICCID ${a.iccid || '?'}`.trim(), a);
        return;
      }
      case J.MSG.AV_ATTRIBUTES_RESP: {
        dev.av = J.parseAvAttributes(m.body);
        const a = dev.av;
        this.logMsg('in', dev, m, `vídeo ${a.videoCodec}, até ${a.maxVideoChannels} canais de vídeo, áudio ${a.audioCodec}`, a);
        return;
      }
      default:
        this.logMsg('in', dev, m, 'mensagem registrada, ainda sem interpretação no FrotaGest');
        this.reply(dev, m, 0);
    }
  }

  checkAuth(dev, m) {
    if (dev.authenticated || !this.cfg.requireAuth) return true;
    this.logMsg('in', dev, m, 'recebida antes da autenticação — recusada');
    this.reply(dev, m, 1);
    return false;
  }

  issueAuthCode(id) {
    const code = `FG${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    this.store[id] = { ...(this.store[id] || {}), authCode: code, registeredAt: new Date().toISOString() };
    this.saveStore();
    return code;
  }

  addPosition(dev, p) {
    dev.position = { ...p, receivedAt: Date.now() };
    if (Math.abs(p.lat) > 0.0001 || Math.abs(p.lon) > 0.0001) {
      dev.track.push([p.lat, p.lon]);
      if (dev.track.length > HISTORY) dev.track.shift();
    }
    this.emit('position', { id: dev.id, position: dev.position });
  }

  /* ---------- envio ---------- */

  nextSerial(dev) {
    dev.serial = (dev.serial + 1) & 0xffff;
    return dev.serial;
  }

  send(dev, msgId, body, note = '', quiet = false) {
    if (!dev.ctx) throw new Error(`aparelho ${dev.id} está offline`);
    const serial = this.nextSerial(dev);
    const frame = J.encode({ msgId, v2019: dev.v2019, protocolVersion: dev.protocolVersion || 1, phoneBcd: dev.phoneBcd, serial, body });
    dev.ctx.sock.write(frame);
    dev.txBytes += frame.length;
    this.emit('message', {
      at: Date.now(), dir: 'out', id: dev.id, msgId, name: J.MSG_NAMES[msgId] || hexId(msgId), serial, text: note, hex: J.hex(frame, 256), quiet,
    });
    return serial;
  }

  reply(dev, m, result, quiet = result === 0) {
    // respostas de sucesso são rotina: ficam ocultas no painel até marcar "Sinais de vida e respostas"
    this.send(dev, J.MSG.PLAT_GENERAL_RESP, J.bodyGeneralResponse(m.serial, m.msgId, result), `para "${J.MSG_NAMES[m.msgId] || hexId(m.msgId)}": ${J.RESULT_NAMES[result]}`, quiet);
  }

  logMsg(dir, dev, m, text, data = null, quiet = false) {
    this.emit('message', {
      at: Date.now(), dir, id: dev.id, msgId: m.msgId, name: J.MSG_NAMES[m.msgId] || hexId(m.msgId), serial: m.serial,
      text: m.lenMismatch ? `${text} (tamanho declarado ${m.bodyLenDeclared}, recebido ${m.body.length})` : text,
      hex: J.hex(m.raw, 256), data, quiet,
    });
  }

  command(id, msgId, body, note) {
    const dev = this.devices.get(J.normalizeId(id));
    if (!dev || !dev.online) throw new Error('aparelho offline ou desconhecido');
    const serial = this.send(dev, msgId, body, note);
    dev.pending.set(serial, { msgId, at: Date.now() });
    this.emit('commandSent', { id: dev.id, msgId, serial, name: J.MSG_NAMES[msgId] || hexId(msgId), note, usuarioId: this.comandoUsuario, at: Date.now() });
    if (dev.pending.size > 50) dev.pending.delete(dev.pending.keys().next().value);
    return serial;
  }

  /** Executa um envio de comando registrando quem pediu (painel). */
  comoUsuario(usuarioId, fn) {
    this.comandoUsuario = usuarioId || null;
    try { return fn(); } finally { this.comandoUsuario = null; }
  }

  /** Endereço que o DVR deve usar para entregar o vídeo. */
  mediaHost(dev, mediaCfg) {
    if (mediaCfg.publicHost) return mediaCfg.publicHost;
    return (dev.ctx.sock.localAddress || '').replace(/^::ffff:/, '');
  }

  startVideo(id, { channel, stream }, mediaCfg) {
    const dev = this.devices.get(J.normalizeId(id));
    if (!dev || !dev.online) throw new Error('aparelho offline ou desconhecido');
    const ip = this.mediaHost(dev, mediaCfg);
    const body = J.bodyVideoRequest({ ip, tcpPort: mediaCfg.port, udpPort: 0, channel, dataType: 1, streamType: stream });
    return this.command(id, J.MSG.VIDEO_REQUEST, body, `canal ${channel}, fluxo ${stream === 0 ? 'principal' : 'secundário'}, entregar em ${ip}:${mediaCfg.port}`);
  }

  stopVideo(id, channel) {
    return this.command(id, J.MSG.VIDEO_CONTROL, J.bodyVideoControl({ channel, command: 0, closeType: 0 }), `encerrar canal ${channel}`);
  }

  queryAttributes(id) {
    return this.command(id, J.MSG.QUERY_ATTRIBUTES, Buffer.alloc(0), '');
  }

  queryAv(id) {
    return this.command(id, J.MSG.QUERY_AV_ATTRIBUTES, Buffer.alloc(0), '');
  }

  /* ---------- gravações no cartão do aparelho ---------- */

  /** tipo: o que resolve a espera ('geral' = resposta geral 0x0001, 'foto' = 0x0805 ou 0x0001; sem tipo = resposta própria). */
  wait(id, serial, ms, tipo = null) {
    const key = `${J.normalizeId(id)}:${serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`o aparelho não respondeu em ${Math.round(ms / 1000)}s`));
      }, ms);
      this.waiters.set(key, { resolve, reject, timer, tipo });
    });
  }

  settle(id, serial, err, value, soTipos = null) {
    const key = `${id}:${serial}`;
    const w = this.waiters.get(key);
    if (!w) return;
    if (soTipos && !soTipos.includes(w.tipo)) return;
    this.waiters.delete(key);
    clearTimeout(w.timer);
    if (err) w.reject(err); else w.resolve(value);
  }

  /** 0x9205 → espera a lista 0x1205 do aparelho. */
  queryResources(id, { channel, start, end }) {
    const body = J.bodyQueryResources({ channel, start, end });
    const serial = this.command(id, J.MSG.QUERY_RESOURCES, body, `${channel ? `canal ${channel}` : 'todos os canais'}, de ${start} a ${end}`);
    return this.wait(id, serial, 45000);
  }

  /** 0x9201 — o aparelho reproduz a gravação e entrega no endereço de vídeo. */
  startPlayback(id, { channel, start, end, mode = 0, speed = 0 }, mediaCfg) {
    const dev = this.devices.get(J.normalizeId(id));
    if (!dev || !dev.online) throw new Error('aparelho offline ou desconhecido');
    const ip = this.mediaHost(dev, mediaCfg);
    const p = this.playbackParams || {};
    const body = J.bodyPlaybackRequest({ ip, tcpPort: mediaCfg.port, channel, start, end, mode, speed, avType: p.tipoMidia, streamType: p.tipoFluxo, storage: p.armazenamento });
    const media = ['áudio e vídeo', 'áudio', 'vídeo', 'vídeo ou áudio e vídeo'][Number.isInteger(p.tipoMidia) ? p.tipoMidia : 2] || p.tipoMidia;
    return this.command(id, J.MSG.PLAYBACK_REQUEST, body, `canal ${channel}, de ${start} a ${end}, ${media}, entregar em ${ip}:${mediaCfg.port}`);
  }

  /** 0x9202 — control: 0 continuar, 1 pausar, 2 encerrar, 3 avanço rápido. */
  controlPlayback(id, { channel, control, speed = 0 }) {
    const names = ['continuar', 'pausar', 'encerrar', 'avanço rápido', 'retroceder', 'ir para', 'só quadros I'];
    return this.command(id, J.MSG.PLAYBACK_CONTROL, J.bodyPlaybackControl({ channel, control, speed }), `canal ${channel}: ${names[control] || control}${speed ? ` (${[0, 1, 2, 4, 8, 16][speed]}x)` : ''}`);
  }

  /* ---------- comandos ao veículo ---------- */

  dispositivo(id) {
    const dev = this.devices.get(J.normalizeId(id));
    if (!dev || !dev.online) throw new Error('aparelho offline ou desconhecido');
    return dev;
  }

  /** 0x8300 → espera a resposta geral. */
  mensagem(id, { texto, tela = true, voz = true, urgente = false }) {
    const dev = this.dispositivo(id);
    const body = J.bodyTextMessage({ texto, tela, voz, urgente, v2019: dev.v2019 });
    const serial = this.command(id, J.MSG.TEXT_MESSAGE, body, `"${J.semAcentos(texto).slice(0, 60)}"${[tela && 'tela', voz && 'voz', urgente && 'urgente'].filter(Boolean).map((x) => ` · ${x}`).join('')}`);
    return this.wait(id, serial, 20000, 'geral');
  }

  /** 0x8801 → espera 0x0805 (ou a resposta geral); a foto chega depois pelo 0x0801 (evento 'midia'). */
  foto(id, { channel, resolution = 2, quality = 3 }) {
    this.dispositivo(id);
    const serial = this.command(id, J.MSG.CAMERA_SHOT, J.bodyCameraShot({ channel, resolution, quality }), `canal ${channel}, enviar agora`);
    return this.wait(id, serial, 20000, 'foto');
  }

  /** 0x8105 comando 4 → reiniciar. */
  reiniciar(id) {
    this.dispositivo(id);
    const serial = this.command(id, J.MSG.TERMINAL_CONTROL, J.bodyTerminalControl(4), 'reiniciar o aparelho');
    return this.wait(id, serial, 20000, 'geral');
  }

  /** 0x8104 → espera 0x0104 com todos os parâmetros. */
  lerParametros(id) {
    this.dispositivo(id);
    const serial = this.command(id, J.MSG.QUERY_PARAMS, Buffer.alloc(0), 'todos os parâmetros');
    return this.wait(id, serial, 30000);
  }

  /** 0x8103 → espera a resposta geral. lista: [{ id, valor, texto }] */
  gravarParametros(id, lista) {
    this.dispositivo(id);
    const serial = this.command(id, J.MSG.SET_PARAMS, J.bodySetParams(lista), lista.map((x) => x.texto || `0x${x.id.toString(16)}`).join(', '));
    return this.wait(id, serial, 20000, 'geral');
  }

  /* ---------- estado para o painel ---------- */

  summary(dev) {
    return {
      id: dev.id, online: dev.online, authenticated: dev.authenticated, remote: dev.remote, port: dev.port,
      protocol: dev.v2019 ? `JT/T 808-2019 (v${dev.protocolVersion})` : 'JT/T 808-2013',
      messages: dev.messages, firstSeen: dev.firstSeen, lastSeen: dev.lastSeen,
      register: dev.register, auth: dev.auth, attributes: dev.attributes, av: dev.av, position: dev.position,
    };
  }

  snapshot() {
    return [...this.devices.values()].map((d) => ({ ...this.summary(d), track: d.track }));
  }
}

function hexId(n) {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

function positionText(p) {
  const parts = [`${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`, `${p.speed.toFixed(1)} km/h`, p.flags.gpsFixado ? 'GPS fixado' : 'sem GPS', p.flags.ignicao ? 'ignição ligada' : 'ignição desligada'];
  if (p.time) parts.push(`hora do aparelho ${p.time}`);
  if (p.alarms.length) parts.push(`ALARMES: ${p.alarms.join(', ')}`);
  return parts.join(' · ');
}

module.exports = { Gateway808 };
