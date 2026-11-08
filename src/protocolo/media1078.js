'use strict';
/**
 * FrotaGest — recepção de vídeo JT/T 1078 (RTP sobre TCP).
 * Remonta os quadros H.264/H.265 e os entrega para quem estiver assistindo.
 * Reis Tecnologia
 */
const net = require('net');
const { EventEmitter } = require('events');
const { bcdToString, normalizeId, hex } = require('./jt808');
const { sincronizarPortas } = require('./portas');

const HEADER = 0x30316364; // "01cd"
const MAX_BODY = 1200; // a norma limita a 950 bytes; damos folga para aparelhos fora do padrão
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_GOP_BYTES = 6 * 1024 * 1024;

const PT_CODEC = { 98: 'H264', 99: 'H265' };
const DATA_TYPES = ['quadro I', 'quadro P', 'quadro B', 'áudio', 'dados transparentes'];

/**
 * Tenta ler um pacote no início do buffer, supondo SIM de `simLen` bytes (6 na versão 2016, 10 em aparelhos 2019).
 * Retorna { need: true } se faltam bytes, { invalid: true } se o layout não bate, ou o pacote.
 */
function parseAt(buf, simLen) {
  let o = 8 + simLen;
  if (buf.length < o + 2) return { need: true };
  if ((buf[4] & 0xc0) !== 0x80) return { invalid: true }; // RTP versão 2
  const pt = buf[5] & 0x7f;
  const marker = buf[5] >> 7;
  const seq = buf.readUInt16BE(6);
  const sim = bcdToString(buf.subarray(8, 8 + simLen));
  if (!/^\d+$/.test(sim)) return { invalid: true };
  const channel = buf[o++];
  const label = buf[o++];
  const dataType = label >> 4;
  const sub = label & 0x0f;
  if (dataType > 4 || sub > 3) return { invalid: true };
  let ts = null;
  if (dataType !== 4) {
    if (buf.length < o + 8) return { need: true };
    ts = Number(buf.readBigUInt64BE(o));
    o += 8;
  }
  if (dataType <= 2) {
    if (buf.length < o + 4) return { need: true };
    o += 4; // intervalo desde o último quadro I e desde o último quadro
  }
  if (buf.length < o + 2) return { need: true };
  const len = buf.readUInt16BE(o);
  o += 2;
  if (len > MAX_BODY) return { invalid: true };
  if (buf.length < o + len) return { need: true };
  return { ok: true, size: o + len, sim, channel, dataType, sub, pt, seq, marker, ts, body: buf.subarray(o, o + len) };
}

class Stream {
  constructor(key, id, channel, kind = 'live', meta = {}) {
    this.key = key;
    this.id = id;
    this.channel = channel;
    this.kind = kind; // 'live' ou 'playback'
    this.meta = meta;
    this.codec = null;
    this.pt = null;
    this.subs = new Set();
    this.gop = [];
    this.gopBytes = 0;
    this.lastTs = null;
    this.frames = 0;
    this.bytes = 0;
    this.keyFrames = 0;
    this.live = false;
    this.startedAt = null;
    this.lastFrameAt = null;
    this.simLen = null;
  }

  info() {
    return {
      key: this.key, id: this.id, channel: this.channel, kind: this.kind, meta: this.meta, codec: this.codec, pt: this.pt, live: this.live,
      viewers: [...this.subs].filter((v) => !v.internal).length, frames: this.frames, keyFrames: this.keyFrames, bytes: this.bytes,
      startedAt: this.startedAt, lastFrameAt: this.lastFrameAt, simLen: this.simLen,
    };
  }
}

class Media1078 extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.streams = new Map();
    this.devBytes = new Map();
    this.allowed = new Map();
    this.conns = new Set();
    this.expected = []; // pedidos (ao vivo ou reprodução) aguardando a conexão de vídeo do aparelho
    this.pbCounter = 0;
    this.servidores = new Map(); // porta → net.Server
  }

  /** Abre/fecha as portas de vídeo conforme os perfis ativos. Retorna [{ porta, ok, erro }]. */
  async sincronizarPortas(portas) {
    const r = await sincronizarPortas(this, portas, this.cfg.host, (sock) => this.onConnection(sock), (porta) => {
      for (const ctx of this.conns) if (ctx.port === porta) ctx.sock.destroy();
    });
    for (const x of r) {
      if (x.aberta) this.log('ok', null, `Recebendo vídeo na porta ${x.porta}`);
      if (x.fechada) this.log('aviso', null, `Porta de vídeo ${x.porta} fechada`);
      if (!x.ok) this.log('erro', null, `Não foi possível abrir a porta de vídeo ${x.porta}: ${x.erro}`);
    }
    return r;
  }

  portas() {
    return [...this.servidores.keys()].sort((a, b) => a - b);
  }

  log(level, id, text, extra = {}) {
    this.emit('log', { at: Date.now(), source: '1078', level, id, text, ...extra });
  }

  /** Só aceitamos vídeo de um aparelho para o qual acabamos de enviar o pedido 0x9101. */
  authorize(id, ms = 120000) {
    this.allowed.set(normalizeId(id), Date.now() + ms);
  }

  isAuthorized(id) {
    const until = this.allowed.get(id);
    return Boolean(until && until > Date.now());
  }

  getStream(id, channel) {
    return this.streamByKey(`${id}:${channel}`, id, channel);
  }

  streamByKey(key, id, channel, kind = 'live', meta = {}) {
    let s = this.streams.get(key);
    if (!s) {
      s = new Stream(key, id, channel, kind, meta);
      this.streams.set(key, s);
    }
    return s;
  }

  /** Registra que um pedido foi feito: a próxima conexão de vídeo desse aparelho e canal pertence a ele. */
  expect(id, channel, kind, meta = {}, ms = 120000) {
    const nid = normalizeId(id);
    this.authorize(nid, ms);
    const key = kind === 'playback' ? `pb${++this.pbCounter}` : `${nid}:${channel}`;
    const s = this.streamByKey(key, nid, channel, kind, meta);
    if (kind === 'live') {
      // ao vivo já chegando: o DVR continua na conexão atual e não abre outra
      if (s.live) return s;
      this.expected = this.expected.filter((e) => !(e.id === nid && e.channel === channel && e.kind === 'live'));
    }
    this.expected.push({ id: nid, channel, key, kind, until: Date.now() + ms });
    return s;
  }

  /** Decide a que pedido pertence uma conexão de vídeo nova, pelo aparelho e canal. */
  takeExpected(id, channel) {
    const now = Date.now();
    this.expected = this.expected.filter((e) => e.until > now);
    const liveKey = `${id}:${channel}`;
    const live = this.streams.get(liveKey);
    // Com o ao vivo do canal chegando por outra conexão, a conexão nova é a gravação pedida
    const liveActive = Boolean(live && live.live);
    const i = this.expected.findIndex((e) => e.id === id && e.channel === channel && !(liveActive && e.kind === 'live'));
    if (i < 0) return liveKey;
    const [e] = this.expected.splice(i, 1);
    if (e.kind === 'live') this.expected = this.expected.filter((x) => !(x.id === id && x.channel === channel && x.kind === 'live'));
    return e.key;
  }

  /** Avisa quem assiste um fluxo (ex.: o DVR recusou a reprodução). */
  notify(key, text) {
    const s = this.streams.get(key);
    if (!s) return;
    s.error = text; // quem conectar depois (o quadro abre logo após o pedido) também recebe
    for (const v of s.subs) if (v.onError) v.onError(text);
  }

  subscribe(id, channel, viewer) {
    return this.subscribeKey(`${normalizeId(id)}:${channel}`, viewer, normalizeId(id), channel);
  }

  subscribeKey(key, viewer, id = null, channel = null) {
    const s = this.streams.get(key) || this.streamByKey(key, id, channel);
    s.subs.add(viewer);
    if (s.codec) viewer.onInfo(s.info());
    for (const f of s.gop) viewer.onFrame(f, s);
    this.emit('stream', s.info());
    return s;
  }

  unsubscribe(id, channel, viewer) {
    return this.unsubscribeKey(`${normalizeId(id)}:${channel}`, viewer);
  }

  unsubscribeKey(key, viewer) {
    const s = this.streams.get(key);
    if (!s) return 0;
    s.subs.delete(viewer);
    this.emit('stream', s.info());
    return s.subs.size;
  }

  /** Remove um fluxo de reprodução que terminou e não tem mais ninguém assistindo. */
  release(key) {
    const s = this.streams.get(key);
    if (s && s.kind === 'playback' && s.subs.size === 0 && !s.live) this.streams.delete(key);
  }

  onConnection(sock) {
    const remote = `${(sock.remoteAddress || '').replace(/^::ffff:/, '')}:${sock.remotePort}`;
    if (this.conns.size >= this.cfg.maxConnections) {
      this.log('aviso', null, `Conexão de vídeo recusada de ${remote}: limite de ${this.cfg.maxConnections}`);
      sock.destroy();
      return;
    }
    const ctx = { sock, remote, port: sock.localPort, buf: Buffer.alloc(0), simLen: null, id: null, parts: new Map(), streams: new Set(), keys: new Map(), packets: 0, skipped: 0, rx: 0, counted: 0 };
    this.conns.add(ctx);
    sock.setNoDelay(true);
    sock.setTimeout(30000);
    this.log('info', null, `Nova conexão de vídeo na porta ${ctx.port} vinda de ${remote}`);

    sock.on('data', (chunk) => {
      ctx.buf = ctx.buf.length ? Buffer.concat([ctx.buf, chunk]) : chunk;
      if (ctx.buf.length > MAX_BUFFER) {
        this.log('erro', ctx.id, `Fluxo de vídeo de ${remote} sem pacotes reconhecíveis; conexão encerrada`, { hex: hex(ctx.buf, 96) });
        sock.destroy();
        return;
      }
      ctx.rx += chunk.length;
      this.drain(ctx);
      this.countBytes(ctx);
    });
    sock.on('timeout', () => {
      this.log('aviso', ctx.id, `Vídeo de ${remote} parou de chegar há 30s; conexão encerrada`);
      sock.destroy();
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.conns.delete(ctx);
      for (const s of ctx.streams) {
        s.live = false;
        this.emit('stream', s.info());
        this.emit('closed', s);
        for (const v of s.subs) if (v.onEnd) v.onEnd(s);
      }
      this.log('info', ctx.id, `Conexão de vídeo ${remote} encerrada (${ctx.packets} pacotes recebidos)`);
    });
  }

  /** Bytes recebidos de cada aparelho pela porta de vídeo (consumo do chip), separados em ao vivo e gravações. */
  countBytes(ctx) {
    const n = ctx.rx - ctx.counted;
    if (!ctx.id || n <= 0) return;
    ctx.counted = ctx.rx;
    const kind = [...ctx.keys.values()].some((k) => k.startsWith('pb')) ? 'playback' : 'live';
    const b = this.devBytes.get(ctx.id) || { live: 0, playback: 0 };
    b[kind] += n;
    this.devBytes.set(ctx.id, b);
  }

  drain(ctx) {
    for (;;) {
      const buf = ctx.buf;
      if (buf.length < 4) return;
      if (buf.readUInt32BE(0) !== HEADER) {
        const next = buf.indexOf(Buffer.from([0x30, 0x31, 0x63, 0x64]), 1);
        ctx.skipped += next < 0 ? buf.length - 3 : next;
        ctx.buf = next < 0 ? buf.subarray(buf.length - 3) : buf.subarray(next);
        continue;
      }
      let p;
      if (ctx.simLen) {
        p = parseAt(buf, ctx.simLen);
      } else {
        p = this.detect(ctx, buf);
        if (!p) return;
      }
      if (p.need) return;
      if (p.invalid) {
        ctx.buf = buf.subarray(1); // procura o próximo cabeçalho
        continue;
      }
      ctx.buf = buf.subarray(p.size);
      if (!this.onPacket(ctx, p)) return;
    }
  }

  /** Descobre se o aparelho usa SIM de 6 ou 10 bytes, confirmando pelo início do pacote seguinte. */
  detect(ctx, buf) {
    const results = [6, 10].map((n) => ({ n, p: parseAt(buf, n) }));
    const confirmed = results.find(({ p }) => p.ok && (buf.length === p.size || (buf.length >= p.size + 4 && buf.readUInt32BE(p.size) === HEADER)));
    if (confirmed && buf.length >= confirmed.p.size + 4) {
      ctx.simLen = confirmed.n;
      this.log('info', null, `Pacotes 1078 com SIM de ${confirmed.n} bytes (${ctx.remote})`);
      return confirmed.p;
    }
    if (results.every(({ p }) => p.invalid)) return { invalid: true };
    if (buf.length > 8192) {
      const any = results.find(({ p }) => p.ok);
      if (any) { ctx.simLen = any.n; return any.p; }
      return { invalid: true };
    }
    return { need: true };
  }

  onPacket(ctx, p) {
    ctx.packets++;
    const id = normalizeId(p.sim);
    if (!ctx.id) {
      if (!this.isAuthorized(id)) {
        this.log('aviso', id, `Vídeo do aparelho ${id} recusado: nenhum pedido de vídeo foi feito para ele (${ctx.remote})`);
        ctx.sock.destroy();
        return false;
      }
      ctx.id = id;
      this.log('ok', id, `Aparelho ${id} começou a enviar vídeo (${ctx.remote})`);
    } else if (id !== ctx.id) {
      return true; // pacote de outro SIM na mesma conexão: ignorado
    }

    if (p.dataType > 2) return true; // áudio e dados transparentes ficam para depois

    let key = ctx.keys.get(p.channel);
    if (!key) {
      key = this.takeExpected(id, p.channel);
      ctx.keys.set(p.channel, key);
      this.emit('mapped', { id, channel: p.channel, key, remote: ctx.remote });
    }
    const s = this.streams.get(key) || this.getStream(id, p.channel);
    if (!ctx.streams.has(s)) {
      ctx.streams.add(s);
      s.simLen = ctx.simLen;
      if (s.kind === 'playback') this.log('ok', id, `Canal ${p.channel}: reprodução de gravação começou a chegar`);
    }
    if (s.pt !== p.pt) {
      s.pt = p.pt;
      s.codec = PT_CODEC[p.pt] || null;
      if (!s.codec) this.log('aviso', id, `Canal ${p.channel}: codificação de vídeo tipo ${p.pt} não suportada pelo painel (esperado 98 = H.264 ou 99 = H.265)`);
      else this.log('ok', id, `Canal ${p.channel}: vídeo ${s.codec === 'H264' ? 'H.264' : 'H.265'}`);
      for (const v of s.subs) v.onInfo(s.info());
    }

    const pk = `${p.channel}`;
    let frame = null;
    switch (p.sub) {
      case 0: frame = Buffer.from(p.body); break;
      case 1: ctx.parts.set(pk, { list: [Buffer.from(p.body)], size: p.body.length, dataType: p.dataType }); break;
      case 3: case 2: {
        const part = ctx.parts.get(pk);
        if (!part) break; // perdemos o início do quadro
        part.list.push(Buffer.from(p.body));
        part.size += p.body.length;
        if (part.size > MAX_FRAME) { ctx.parts.delete(pk); break; }
        if (p.sub === 2) { frame = Buffer.concat(part.list); ctx.parts.delete(pk); }
        break;
      }
      default: break;
    }
    if (frame) this.onFrame(s, frame, p);
    return true;
  }

  onFrame(s, data, p) {
    const now = Date.now();
    let duration = 40;
    if (s.lastTs !== null && p.ts !== null) {
      const d = p.ts - s.lastTs;
      if (d >= 10 && d <= 500) duration = d;
    }
    if (p.ts !== null) s.lastTs = p.ts;
    const isKey = p.dataType === 0;
    const f = { data, duration, isKey, ts: p.ts };

    if (!s.live) {
      s.live = true;
      s.startedAt = now;
      this.emit('stream', s.info());
    }
    s.frames++;
    s.bytes += data.length;
    s.lastFrameAt = now;
    if (isKey) {
      s.keyFrames++;
      s.gop = [];
      s.gopBytes = 0;
    }
    if (s.gop.length || isKey) {
      s.gop.push(f);
      s.gopBytes += data.length;
      if (s.gopBytes > MAX_GOP_BYTES) { s.gop = []; s.gopBytes = 0; }
    }
    for (const v of s.subs) v.onFrame(f, s);
    if (s.frames % 50 === 0) this.emit('stream', s.info());
  }

  snapshot() {
    return [...this.streams.values()].map((s) => s.info());
  }
}

module.exports = { Media1078, parseAt, DATA_TYPES };
