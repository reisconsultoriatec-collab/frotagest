'use strict';
/**
 * FrotaGest — download de gravações: o servidor grava a reprodução vinda do DVR
 * e converte para MP4 com o ffmpeg (sem recodificar).
 * Reis Tecnologia
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const NO_FRAMES_MS = 90000; // aparelho não começou a enviar
const IDLE_MS = 20000; // parou de enviar no meio
const MAX_RANGE_MS = 60 * 60 * 1000; // até 1 hora por download

function parseTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

class Recorder extends EventEmitter {
  constructor(cfg, dataDir, gateway, media, mediaCfg) {
    super();
    this.cfg = cfg;
    this.gateway = gateway;
    this.media = media;
    // endereço/porta de vídeo de cada aparelho (depende do perfil de protocolo dele)
    this.mediaCfgFor = typeof mediaCfg === 'function' ? mediaCfg : () => mediaCfg;
    this.dir = path.join(dataDir, 'gravacoes');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    this.jobs = new Map();
    this.ffmpeg = cfg.ffmpeg || 'ffmpeg';
    this.hasFfmpeg = spawnSync(this.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
    this.load();
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600 * 1000);
    // Resposta do DVR ao pedido de reprodução: recusa encerra na hora, com o motivo
    gateway.on('command', (c) => {
      if (c.msgId !== 0x9201) return;
      for (const job of this.jobs.values()) {
        if (job.status !== 'aguardando' || job.deviceId !== c.id || job.serial !== c.replySerial) continue;
        if (c.result !== 0) {
          const live = this.media.streams.get(`${job.deviceId}:${job.channel}`);
          const hint = live && live.live ? '. O vídeo ao vivo desse canal está aberto: feche-o e tente de novo' : '';
          this.fail(job, `o DVR recusou o pedido de reprodução (${c.resultName})${hint}`);
        } else {
          job.diag.reply = c.items === undefined ? 'aceito' : c.items ? `aceito, ${c.items} trecho(s)` : 'aceito sem trechos';
          job.note = c.items === 0 ? 'o DVR aceitou, mas não listou gravação nesse período; aguardando o vídeo' : 'o DVR aceitou; aguardando o vídeo';
          this.changed(job);
        }
      }
    });
    // Conexões de vídeo que chegam do aparelho enquanto o download espera
    media.on('mapped', (m) => {
      for (const job of this.jobs.values()) {
        if (job.status !== 'aguardando' || job.deviceId !== m.id) continue;
        if (m.key === job.key) {
          job.diag.connected = true;
          job.note = 'conexão de vídeo aberta; aguardando o primeiro quadro I';
          this.changed(job);
        } else if (m.channel === job.channel) job.diag.others.push(m.channel);
      }
    });
    media.on('closed', (s) => {
      for (const job of this.jobs.values()) {
        if (job.key !== s.key) continue;
        if (job.status === 'gravando') this.finish(job, 'fim da reprodução');
        else if (job.status === 'aguardando') this.fail(job, 'o aparelho encerrou a conexão sem enviar a gravação');
      }
    });
  }

  /* ---------- persistência ---------- */

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const j of list) {
        if (j.status !== 'pronto') continue; // trabalhos interrompidos por reinício não voltam
        if (!fs.existsSync(path.join(this.dir, j.file))) continue;
        this.jobs.set(j.id, j);
      }
    } catch { /* primeiro uso */ }
  }

  save() {
    const list = [...this.jobs.values()].map((j) => this.publicJob(j));
    try { fs.writeFileSync(this.indexFile, JSON.stringify(list, null, 2)); } catch { /* sem disco: segue em memória */ }
  }

  usedBytes() {
    let total = 0;
    for (const f of fs.readdirSync(this.dir)) {
      try { total += fs.statSync(path.join(this.dir, f)).size; } catch { /* arquivo sumiu */ }
    }
    return total;
  }

  cleanup() {
    const limit = Date.now() - this.cfg.retencaoDias * 86400000;
    for (const j of [...this.jobs.values()]) {
      if (j.status === 'pronto' && j.finishedAt < limit) this.remove(j.id);
    }
  }

  /* ---------- trabalhos ---------- */

  publicJob(j) {
    const { writer, viewer, timers, durations, serial, ...rest } = j;
    return rest;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.publicJob(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.jobs.get(id);
  }

  filePath(job) {
    return path.join(this.dir, job.file);
  }

  /** meta: { empresaId, usuarioId, rotulo } — dono do download e nome usado no arquivo (placa). */
  start(deviceId, { channel, start, end }, meta = {}) {
    const t0 = parseTime(start);
    const t1 = parseTime(end);
    if (t0 === null || t1 === null || t1 <= t0) throw new Error('período inválido');
    if (t1 - t0 > MAX_RANGE_MS) throw new Error('baixe no máximo 1 hora por vez');
    if (this.usedBytes() > this.cfg.maxGB * 1024 ** 3) throw new Error(`o espaço reservado para gravações (${this.cfg.maxGB} GB) está cheio; exclua downloads antigos`);
    const busy = [...this.jobs.values()].find((j) => j.deviceId === deviceId && j.channel === channel && ['aguardando', 'gravando', 'convertendo'].includes(j.status));
    if (busy) throw new Error(`já existe um download em andamento no canal ${channel}`);

    const id = crypto.randomBytes(6).toString('hex');
    const stamp = `${start.replace(/\D/g, '').slice(0, 8)}-${start.replace(/\D/g, '').slice(8)}_${end.replace(/\D/g, '').slice(8)}`;
    const rotulo = String(meta.rotulo || deviceId).replace(/[^\w-]/g, '');
    const base = `FrotaGest_${rotulo || deviceId}_CH${channel}_${stamp}`;
    const stream = this.media.expect(deviceId, channel, 'playback', { purpose: 'download', start, end, job: id });
    const job = {
      id, deviceId, channel, start, end, key: stream.key, totalMs: t1 - t0,
      empresaId: meta.empresaId || null, usuarioId: meta.usuarioId || null, rotulo: meta.rotulo || null,
      status: 'aguardando', note: 'pedindo a gravação ao aparelho', codec: null,
      frames: 0, bytes: 0, durationMs: 0, durations: [], createdAt: Date.now(), startedAt: null, finishedAt: null,
      raw: `${base}_${id}.h264`, file: `${base}.mp4`, name: `${base}.mp4`, size: 0,
      writer: null, viewer: null, timers: {}, serial: null, diag: { reply: null, connected: false, others: [] },
    };
    this.jobs.set(id, job);

    job.viewer = {
      internal: true,
      onInfo: (info) => { job.codec = info.codec; },
      onFrame: (f, s) => this.onFrame(job, f, s),
    };
    this.media.subscribeKey(job.key, job.viewer);
    try {
      job.serial = this.gateway.comoUsuario(meta.usuarioId, () => this.gateway.startPlayback(deviceId, { channel, start, end }, this.mediaCfgFor(deviceId)));
    } catch (e) {
      this.fail(job, e.message);
      throw e;
    }
    const wait = Math.max(10, Number(this.cfg.esperaVideoSeg) || NO_FRAMES_MS / 1000) * 1000;
    job.timers.noFrames = setTimeout(() => { if (!job.frames) this.fail(job, this.timeoutReason(job, wait / 1000)); }, wait);
    this.changed(job);
    return this.publicJob(job);
  }

  onFrame(job, f, s) {
    if (job.status !== 'aguardando' && job.status !== 'gravando') return;
    if (!job.frames && !f.isKey) return; // o arquivo começa num quadro I
    if (!job.writer) {
      job.codec = s.codec;
      job.writer = fs.createWriteStream(path.join(this.dir, job.raw));
      job.status = 'gravando';
      job.note = '';
      job.startedAt = Date.now();
      clearTimeout(job.timers.noFrames);
    }
    job.writer.write(f.data);
    job.frames++;
    job.bytes += f.data.length;
    job.durationMs += f.duration;
    if (job.durations.length < 500) job.durations.push(f.duration);
    clearTimeout(job.timers.idle);
    job.timers.idle = setTimeout(() => this.finish(job, 'o aparelho parou de enviar'), IDLE_MS);
    if (job.durationMs >= job.totalMs) this.finish(job, 'período completo');
    else if (job.frames % 25 === 0) this.changed(job);
  }

  /** Explica em que ponto o pedido parou quando nada chegou em 90s. */
  timeoutReason(job, sec) {
    const d = job.diag;
    const port = this.mediaCfgFor(job.deviceId).port;
    if (d.connected) return `o DVR abriu a conexão de vídeo, mas não enviou quadros em ${sec}s`;
    if (d.others.length) return `o DVR abriu uma conexão de vídeo do canal ${job.channel}, mas ela não pôde ser separada do vídeo ao vivo; feche o ao vivo desse canal e tente de novo`;
    if (!d.reply) return `o DVR não respondeu ao pedido de reprodução em ${sec}s (pode não aceitar reprodução remota, ou a conexão 4G caiu)`;
    if (d.reply === 'aceito sem trechos') return `o DVR aceitou o pedido, mas não há gravação do canal ${job.channel} nesse período (confira com "Buscar no DVR")`;
    return `o DVR aceitou o pedido, mas não abriu a conexão de vídeo na porta ${port} em ${sec}s`;
  }

  stopDevice(job) {
    try { this.gateway.controlPlayback(job.deviceId, { channel: job.channel, control: 2 }); } catch { /* aparelho offline */ }
  }

  detach(job) {
    Object.values(job.timers).forEach(clearTimeout);
    if (job.viewer) this.media.unsubscribeKey(job.key, job.viewer);
    job.viewer = null;
    this.media.release(job.key);
  }

  finish(job, reason) {
    if (job.status !== 'gravando') return;
    job.status = 'convertendo';
    job.note = reason;
    job.endReason = reason;
    this.detach(job);
    this.stopDevice(job);
    this.changed(job);
    const done = () => this.convert(job);
    if (job.writer) job.writer.end(done); else this.fail(job, 'nenhum quadro recebido');
  }

  fail(job, reason) {
    if (['pronto', 'erro', 'cancelado'].includes(job.status)) return;
    job.status = 'erro';
    job.note = reason;
    job.finishedAt = Date.now();
    this.detach(job);
    this.stopDevice(job);
    if (job.writer) job.writer.end(() => fs.rm(path.join(this.dir, job.raw), { force: true }, () => {}));
    this.changed(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('download não encontrado');
    if (!['aguardando', 'gravando'].includes(job.status)) throw new Error('este download não está em andamento');
    job.status = 'cancelado';
    job.note = 'cancelado pelo usuário';
    job.finishedAt = Date.now();
    this.detach(job);
    this.stopDevice(job);
    if (job.writer) job.writer.end(() => fs.rm(path.join(this.dir, job.raw), { force: true }, () => {}));
    this.changed(job);
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('download não encontrado');
    if (['aguardando', 'gravando', 'convertendo'].includes(job.status)) throw new Error('cancele o download antes de excluir');
    fs.rm(path.join(this.dir, job.file), { force: true }, () => {});
    fs.rm(path.join(this.dir, job.raw), { force: true }, () => {});
    this.jobs.delete(id);
    this.save();
    this.emit('job', { id, removed: true });
  }

  fps(job) {
    const d = [...job.durations].sort((a, b) => a - b);
    const median = d.length ? d[Math.floor(d.length / 2)] : 40;
    return Math.min(60, Math.max(1, Math.round(1000 / median)));
  }

  convert(job) {
    const raw = path.join(this.dir, job.raw);
    if (!this.hasFfmpeg) {
      job.file = job.raw;
      job.name = job.raw;
      this.ready(job, 'ffmpeg não instalado: arquivo entregue em H.264 bruto');
      return;
    }
    const out = path.join(this.dir, job.file);
    const args = ['-y', '-loglevel', 'error', '-fflags', '+genpts', '-r', String(this.fps(job)),
      '-f', job.codec === 'H265' ? 'hevc' : 'h264', '-i', raw, '-c', 'copy', ...(job.codec === 'H265' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', out];
    execFile(this.ffmpeg, args, { timeout: 180000 }, (err, _stdout, stderr) => {
      if (err) {
        job.file = job.raw;
        job.name = job.raw;
        this.ready(job, `conversão para MP4 falhou (${String(stderr || err.message).trim().slice(0, 160)}); arquivo entregue em H.264 bruto`);
        return;
      }
      fs.rm(raw, { force: true }, () => {});
      this.ready(job, this.completeness(job));
    });
  }

  /** Avisa quando o DVR entregou só parte do período (4G caiu, ou o período tem partes sem gravação). */
  completeness(job) {
    if (!job.totalMs || job.durationMs >= job.totalMs * 0.9) return '';
    const fmt = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
    const why = job.endReason === 'fim da reprodução' ? 'o DVR encerrou antes; o período pode ter partes sem gravação' : job.endReason;
    return `incompleto: chegaram ${fmt(job.durationMs)} de ${fmt(job.totalMs)} (${why})`;
  }

  ready(job, note) {
    job.status = 'pronto';
    job.note = note;
    job.finishedAt = Date.now();
    try { job.size = fs.statSync(path.join(this.dir, job.file)).size; } catch { job.size = 0; }
    job.writer = null;
    this.changed(job);
  }

  changed(job) {
    this.save();
    this.emit('job', this.publicJob(job));
  }
}

module.exports = { Recorder, parseTime };
