'use strict';
/**
 * FrotaGest — conversão de H.265 para H.264 em tempo real, para o painel funcionar em qualquer navegador.
 * Um conversor por fluxo de vídeo, compartilhado por todos que estão assistindo.
 * Reis Tecnologia
 */
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const MAX_STDIN = 4 * 1024 * 1024; // conversor atrasado: descarta até o próximo quadro I
const MAX_GOP_BYTES = 4 * 1024 * 1024;
const AUD = Buffer.from([0, 0, 0, 1, 0x09]);

function probe(ffmpeg) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, reason: 'ffmpeg não encontrado' };
  if (!/libx264/.test(r.stdout)) return { ok: false, reason: 'o ffmpeg instalado não tem o codificador libx264' };
  const v = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  const major = Number((/ffmpeg version n?(\d+)/.exec(v.stdout || '') || [])[1] || 0);
  return { ok: true, fpsMode: major >= 5 };
}

class Transcoder extends EventEmitter {
  constructor(manager, source) {
    super();
    this.manager = manager;
    this.source = source;
    this.key = source.key;
    this.viewers = new Set();
    this.gop = [];
    this.gopBytes = 0;
    this.durations = [];
    this.buf = Buffer.alloc(0);
    this.waitingKey = true;
    this.ended = false;
    this.framesIn = 0;
    this.framesOut = 0;
    this.start();
  }

  info() {
    return { codec: 'H264', source: 'H265', key: this.key };
  }

  start() {
    const m = this.manager;
    const kbps = Math.min(8000, Math.max(200, Number(m.cfg.maxKbpsConversao) || 1000));
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // análise mínima da entrada (o primeiro quadro já sai); sem "nobuffer", que descartaria o quadro I inicial
      '-fflags', '+genpts', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0', '-threads', '1',
      '-f', 'hevc', '-i', 'pipe:0',
      '-an', ...(m.fpsMode ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough']),
      // 1 fatia por quadro: o player do navegador (jMuxer) corrompe quadros divididos em várias fatias
      '-c:v', 'libx264', '-threads', '1', '-x264-params', 'aud=1:repeat-headers=1:sliced-threads=0:slices=1', '-preset', m.cfg.presetConversao || 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0',
      // qualidade boa para monitoramento, com teto de banda por canal (padrão 1000 kbps)
      '-crf', '28', '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
      '-flush_packets', '1', '-f', 'h264', 'pipe:1',
    ];
    this.proc = spawn(m.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (d) => this.onOutput(d));
    let err = '';
    this.proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (!this.ended) {
        const text = `Conversão do canal ${this.source.channel} parou (${err.trim() || `código ${code}`})`;
        this.manager.emit('log', { level: 'erro', id: this.source.id, text });
        for (const v of this.viewers) if (v.onError) v.onError(text);
        this.end();
      }
    });
    this.sourceViewer = {
      internal: true,
      onInfo: () => {},
      onEnd: () => this.end(),
      onFrame: (f) => this.onInput(f),
    };
    this.manager.media.subscribeKey(this.key, this.sourceViewer);
  }

  onInput(f) {
    if (!this.proc) return;
    if (this.waitingKey) {
      if (!f.isKey) return;
      this.waitingKey = false;
    }
    if (this.proc.stdin.writableLength > MAX_STDIN) { this.waitingKey = true; return; }
    this.durations.push(f.duration);
    if (this.durations.length > 50) this.durations.shift();
    this.framesIn++;
    this.proc.stdin.write(f.data);
  }

  duration() {
    if (!this.durations.length) return 40;
    const d = [...this.durations].sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
  }

  /** Saída do ffmpeg: H.264 Annex B com AUD (tipo 9) no início de cada quadro. */
  onOutput(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = this.buf.indexOf(AUD);
    if (start < 0) {
      if (this.buf.length > MAX_GOP_BYTES) this.buf = Buffer.alloc(0);
      return;
    }
    let next;
    while ((next = this.buf.indexOf(AUD, start + AUD.length)) >= 0) {
      this.emitFrame(Buffer.from(this.buf.subarray(start, next)));
      start = next;
    }
    this.buf = this.buf.subarray(start);
  }

  emitFrame(data) {
    let isKey = false;
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 5) { isKey = true; break; }
    }
    const f = { data, isKey, duration: this.duration() };
    this.framesOut++;
    if (isKey) { this.gop = []; this.gopBytes = 0; }
    if (this.gop.length || isKey) {
      this.gop.push(f);
      this.gopBytes += data.length;
      if (this.gopBytes > MAX_GOP_BYTES) { this.gop = []; this.gopBytes = 0; }
    }
    const fake = { codec: 'H264' };
    for (const v of this.viewers) v.onFrame(f, fake);
  }

  add(viewer) {
    this.viewers.add(viewer);
    viewer.onInfo(this.info());
    const fake = { codec: 'H264' };
    for (const f of this.gop) viewer.onFrame(f, fake);
  }

  remove(viewer) {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.end();
  }

  /** Remove o espectador cujo onFrame é o mesmo do objeto informado. */
  removeViewerByBase(base) {
    for (const v of this.viewers) if (v.onFrame === base.onFrame) { this.remove(v); return; }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.manager.media.unsubscribeKey(this.key, this.sourceViewer);
    if (this.proc) {
      this.proc.stdin.end();
      const p = this.proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* já terminou */ } }, 1500);
    }
    this.manager.forget(this);
  }
}

class TranscoderManager extends EventEmitter {
  constructor(cfg, media, ffmpeg) {
    super();
    this.cfg = cfg;
    this.media = media;
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.active = new Map();
    const p = probe(this.ffmpeg);
    this.available = p.ok;
    this.reason = p.reason || '';
    this.fpsMode = p.fpsMode;
    this.enabled = cfg.converterH265 !== false && this.available;
  }

  /** Inscreve o espectador no conversor do fluxo (cria se ainda não existir). */
  attach(source, viewer) {
    let t = this.active.get(source.key);
    if (!t) {
      if (this.active.size >= (this.cfg.maxConversoes || 6)) throw new Error(`limite de ${this.cfg.maxConversoes || 6} conversões simultâneas atingido`);
      t = new Transcoder(this, source);
      this.active.set(source.key, t);
      this.emit('log', { level: 'info', id: source.id, text: `Canal ${source.channel}: convertendo H.265 para H.264 para o navegador` });
    }
    t.add(viewer);
    return t;
  }

  forget(t) {
    if (this.active.get(t.key) === t) this.active.delete(t.key);
  }
}

module.exports = { TranscoderManager };
