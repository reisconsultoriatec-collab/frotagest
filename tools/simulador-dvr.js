'use strict';
/**
 * FrotaGest — simulador de DVR (JT/T 808 + JT/T 1078) para testar o servidor sem o aparelho.
 * Reis Tecnologia
 *
 * Uso: node tools/simulador-dvr.js [--host 127.0.0.1] [--porta 6608] [--id 000020250711]
 *                                  [--v2013] [--sim10] [--video tools/amostra.h264] [--canais 4] [--h265]
 *                                  [--intervalo 5] (segundos entre posições)
 *
 * --h265  envia vídeo H.265 (como a maioria dos DVRs atuais), usando tools/amostra-h265.hevc
 * --reproducao normal|geral|recusar|mudo|vazio|ignorar|curta   como responder ao pedido de gravação (0x9201):
 *     normal = lista 0x1205 e envia; geral = resposta 0x0001 e envia; recusar = 0x0001 com falha;
 *     mudo = aceita e não envia; vazio = lista sem trechos e não envia; ignorar = não responde;
 *     curta = envia só a metade do período
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const J = require('../src/protocolo/jt808');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const HOST = opt('host', '127.0.0.1');
const PORT = Number(opt('porta', 6608));
const ID = opt('id', '000020250711');
const V2019 = !flag('v2013');
const SIM10 = flag('sim10');
const CHANNELS = Number(opt('canais', 4));
const H265 = flag('h265') || /\.(hevc|h265|265)$/i.test(opt('video', ''));
const VIDEO = path.resolve(opt('video', path.join(__dirname, H265 ? 'amostra-h265.hevc' : 'amostra.h264')));
const PT = H265 ? 99 : 98; // tipo de carga JT/T 1078: 98 = H.264, 99 = H.265
const PLAYBACK_MODE = opt('reproducao', 'normal');
const INTERVALO_MS = Math.max(1, Number(opt('intervalo', 5))) * 1000;

// foto de teste (pedido de foto 0x8801) e os parâmetros que a plataforma pode ler e mudar (0x8104/0x8103)
const FOTO = fs.readFileSync(path.join(__dirname, 'amostra-foto.jpg'));
const PARAMETROS = { 0x0001: 30, 0x0010: 'zap.vivo.com.br', 0x0011: 'vivo', 0x0012: 'vivo', 0x0013: V2019 ? `${HOST}:${PORT}` : HOST, 0x0018: PORT, 0x0027: 3600, 0x0029: 10, 0x0055: 90, 0x0056: 10, 0x0083: 'ABC1D23' };
if (!V2019) PARAMETROS[0x0018] = PORT;

const phoneBcd = J.stringToBcd(ID, V2019 ? 10 : 6);
const simBcd = J.stringToBcd(ID, SIM10 ? 10 : 6);
let serial = 0;
let authCode = null;
const streams = new Map();

// Trajeto de teste em Itapevi/SP
const ROUTE = [[-23.5489, -46.9342], [-23.5472, -46.9301], [-23.5445, -46.9277], [-23.5418, -46.9249], [-23.5401, -46.9208], [-23.5426, -46.9171], [-23.5463, -46.9196], [-23.5487, -46.9248]];
let step = 0;

function log(text) {
  console.log(`${new Date().toLocaleTimeString('pt-BR')} [simulador ${J.normalizeId(ID)}] ${text}`);
}

function send(sock, msgId, body) {
  serial = (serial + 1) & 0xffff;
  sock.write(J.encode({ msgId, v2019: V2019, protocolVersion: 1, phoneBcd, serial, body }));
  return serial;
}

/** Envia corpos grandes em subpacotes de até 1000 bytes, como o aparelho real faz. */
function sendLong(sock, msgId, body) {
  if (body.length <= 1000) return send(sock, msgId, body);
  const parts = [];
  for (let o = 0; o < body.length; o += 1000) parts.push(body.subarray(o, o + 1000));
  parts.forEach((part, i) => {
    serial = (serial + 1) & 0xffff;
    sock.write(J.encode({ msgId, v2019: V2019, protocolVersion: 1, phoneBcd, serial, body: part, pkg: { total: parts.length, index: i + 1 } }));
  });
  return serial;
}

function fixed(str, len) {
  const b = Buffer.alloc(len);
  Buffer.from(str, 'latin1').copy(b, 0, 0, len);
  return b;
}

function registerBody() {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(35, 0);
  head.writeUInt16BE(3523, 2);
  return Buffer.concat([
    head,
    fixed('REIST', V2019 ? 11 : 5),
    fixed('SIMULADOR-MDVR', V2019 ? 30 : 20),
    fixed('SIM0001', V2019 ? 30 : 7),
    Buffer.from([9]),
    Buffer.from('ABC1D23', 'latin1'),
  ]);
}

function authBody() {
  const code = Buffer.from(authCode || 'SEMCODIGO', 'latin1');
  if (!V2019) return code;
  return Buffer.concat([Buffer.from([code.length]), code, fixed('861234567890123', 15), fixed('SIM-1.0.0', 20)]);
}

function bcdNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return Buffer.from(`${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`, 'hex');
}

function locationBody() {
  const [lat, lon] = ROUTE[step % ROUTE.length];
  step++;
  const b = Buffer.alloc(28);
  const alarm = step % 12 === 0 ? 1 << 1 : 0; // de vez em quando um excesso de velocidade
  const status = 1 | 2 | (1 << 2) | (1 << 3) | (1 << 22); // ignição, GPS, sul, oeste, em movimento
  b.writeUInt32BE(alarm, 0);
  b.writeUInt32BE(status >>> 0, 4);
  b.writeUInt32BE(Math.round(Math.abs(lat) * 1e6), 8);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 1e6), 12);
  b.writeUInt16BE(760, 16);
  b.writeUInt16BE(300 + (step % 5) * 40, 18);
  b.writeUInt16BE((step * 37) % 360, 20);
  bcdNow().copy(b, 22);
  // sinal da rede e satélites variam como num veículo em movimento
  const signal = Math.max(5, Math.min(31, Math.round(22 + 6 * Math.sin(step / 9) + ((step * 7) % 5) - 2)));
  const sats = 9 + ((step * 3) % 7);
  const extras = Buffer.from([0x01, 4, 0, 0, 0x30, 0x39, 0x30, 1, signal, 0x31, 1, sats]);
  return Buffer.concat([b, extras]);
}

function attributesBody() {
  const t = Buffer.alloc(2);
  t.writeUInt16BE(0x0001, 0);
  const hw = Buffer.from('HW-1.0', 'latin1');
  const fw = Buffer.from('SIM-FW-1.0.0', 'latin1');
  return Buffer.concat([
    t, fixed('REIST', 5), fixed('SIMULADOR-MDVR', V2019 ? 30 : 20), fixed('SIM0001', V2019 ? 30 : 7),
    Buffer.from('89550000000000000000', 'hex'),
    Buffer.from([hw.length]), hw, Buffer.from([fw.length]), fw, Buffer.from([0x03, 0x21]),
  ]);
}

/* ---------- gravações simuladas no "cartão" ---------- */

const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; };
const bcdToMs = (b) => { const t = J.bcdTime(b); return t ? Date.parse(`${t.replace(' ', 'T')}Z`) : null; };

/** Gera trechos de 10 minutos dentro do período pedido; alguns com alarme. */
function fakeRecordings(channel, startMs, endMs) {
  const items = [];
  const chans = channel === 0 ? [...Array(CHANNELS).keys()].map((c) => c + 1) : [channel];
  const STEP = 10 * 60 * 1000;
  let t = Math.ceil(startMs / STEP) * STEP;
  while (t + STEP <= endMs && items.length < 60) {
    for (const ch of chans) {
      if (items.length >= 60) break;
      const alarm = (t / STEP) % 7 === 3;
      items.push({ ch, start: t, end: t + STEP, alarm });
    }
    t += STEP;
  }
  return items;
}

function resourceListBody(replySerial, items) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(replySerial, 0);
  head.writeUInt32BE(items.length, 2);
  const rows = items.map((it) => {
    const r = Buffer.alloc(28);
    r[0] = it.ch;
    J.timeToBcd(fmt(it.start)).copy(r, 1);
    J.timeToBcd(fmt(it.end)).copy(r, 7);
    r.writeUInt32BE(0, 13); // alarmes de vídeo
    r.writeUInt32BE(it.alarm ? 1 : 0, 17); // botão de emergência
    r[21] = 0; // áudio e vídeo
    r[22] = 1; // fluxo principal
    r[23] = 1; // armazenamento principal
    r.writeUInt32BE(Math.round((it.end - it.start) / 1000) * 64 * 1024, 24);
    return r;
  });
  return Buffer.concat([head, ...rows]);
}

/* ---------- vídeo ---------- */

function splitAccessUnits(file) {
  const data = fs.readFileSync(file);
  const nals = [];
  let i = 0;
  let start = -1;
  while (i < data.length - 3) {
    const sc3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const sc4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) nals.push(data.subarray(start, i));
      start = i + (sc4 ? 4 : 3);
      i = start;
      continue;
    }
    i++;
  }
  if (start >= 0) nals.push(data.subarray(start));

  const units = [];
  let cur = [];
  let hasSlice = false;
  let isKey = false;
  const flush = () => {
    if (!cur.length) return;
    units.push({ data: Buffer.concat(cur.flatMap((n) => [Buffer.from([0, 0, 0, 1]), n])), isKey });
    cur = [];
    hasSlice = false;
    isKey = false;
  };
  for (const n of nals) {
    if (!n.length) continue;
    if (H265) {
      // H.265: tipo = bits 1..6 do 1º byte; VPS/SPS/PPS/AUD/SEI abrem um novo quadro; 16..21 = quadro I
      const type = (n[0] >> 1) & 0x3f;
      if (type >= 32 && type <= 40 && type !== 38) {
        if (hasSlice && type !== 40) flush();
        cur.push(n);
      } else if (type < 32) {
        const firstSlice = n.length > 2 && (n[2] & 0x80) !== 0;
        if (hasSlice && firstSlice) flush();
        cur.push(n);
        hasSlice = true;
        if (type >= 16 && type <= 21) isKey = true;
      } else {
        cur.push(n);
      }
      continue;
    }
    const type = n[0] & 0x1f;
    if (type === 9 || type === 7 || type === 8 || type === 6) {
      if (hasSlice) flush();
      cur.push(n);
    } else if (type === 1 || type === 5) {
      const firstMb = n.length > 1 && (n[1] & 0x80) !== 0;
      if (hasSlice && firstMb) flush();
      cur.push(n);
      hasSlice = true;
      if (type === 5) isKey = true;
    } else {
      cur.push(n);
    }
  }
  flush();
  return units;
}

let UNITS = null;

function rtpPackets(unit, channel, seqRef, ts) {
  const MAX = 950;
  const pieces = [];
  for (let o = 0; o < unit.data.length; o += MAX) pieces.push(unit.data.subarray(o, o + MAX));
  return pieces.map((body, idx) => {
    const sub = pieces.length === 1 ? 0 : idx === 0 ? 1 : idx === pieces.length - 1 ? 2 : 3;
    const dataType = unit.isKey ? 0 : 1;
    const last = sub === 0 || sub === 2;
    const head = Buffer.alloc(4 + 4 + simBcd.length + 2 + 8 + 4 + 2);
    let o = 0;
    head.writeUInt32BE(0x30316364, o); o += 4;
    head[o++] = 0x81;
    head[o++] = (last ? 0x80 : 0) | PT;
    head.writeUInt16BE(seqRef.n++ & 0xffff, o); o += 2;
    simBcd.copy(head, o); o += simBcd.length;
    head[o++] = channel;
    head[o++] = (dataType << 4) | sub;
    head.writeBigUInt64BE(BigInt(ts), o); o += 8;
    head.writeUInt16BE(0, o); o += 2;
    head.writeUInt16BE(40, o); o += 2;
    head.writeUInt16BE(body.length, o);
    return Buffer.concat([head, body]);
  });
}

function startStream(ip, port, channel) {
  stopStream(channel);
  if (!UNITS) {
    if (!fs.existsSync(VIDEO)) { log(`arquivo de vídeo não encontrado: ${VIDEO}`); return; }
    UNITS = splitAccessUnits(VIDEO);
    log(`vídeo de teste carregado: ${UNITS.length} quadros ${H265 ? 'H.265' : 'H.264'}`);
  }
  const sock = net.connect(port, ip);
  const st = { sock, timer: null, i: 0, seq: { n: 0 }, ts: Date.now(), dest: `${ip}:${port}` };
  streams.set(channel, st);
  sock.on('connect', () => {
    log(`canal ${channel}: enviando vídeo para ${ip}:${port}`);
    st.timer = setInterval(() => {
      const unit = UNITS[st.i % UNITS.length];
      st.i++;
      st.ts += 40;
      for (const p of rtpPackets(unit, channel, st.seq, st.ts)) sock.write(p);
    }, 40);
  });
  sock.on('error', (e) => log(`canal ${channel}: erro no vídeo (${e.message})`));
  sock.on('close', () => { clearInterval(st.timer); if (streams.get(channel) === st) streams.delete(channel); });
}

const playbacks = new Map();

function startPlayback(ip, port, channel, startMs, endMs) {
  stopPlayback(channel);
  if (PLAYBACK_MODE === 'curta') endMs = startMs + Math.round((endMs - startMs) / 2); // DVR que entrega só metade
  if (!UNITS) UNITS = splitAccessUnits(VIDEO);
  const sock = net.connect(port, ip);
  const st = { sock, timer: null, i: 0, seq: { n: 0 }, ts: startMs, endMs, interval: 40, paused: false };
  playbacks.set(channel, st);
  const tick = () => {
    if (st.paused) return;
    const unit = UNITS[st.i % UNITS.length];
    st.i++;
    st.ts += 40;
    for (const p of rtpPackets(unit, channel, st.seq, st.ts)) sock.write(p);
    if (st.ts >= st.endMs) {
      log(`canal ${channel}: fim da gravação reproduzida`);
      stopPlayback(channel, true);
    }
  };
  st.restart = () => { clearInterval(st.timer); st.timer = setInterval(tick, st.interval); };
  sock.on('connect', () => {
    log(`canal ${channel}: reproduzindo gravação ${fmt(startMs)} → ${fmt(endMs)} para ${ip}:${port}`);
    st.restart();
  });
  sock.on('error', (e) => log(`canal ${channel}: erro na reprodução (${e.message})`));
  sock.on('close', () => { clearInterval(st.timer); if (playbacks.get(channel) === st) playbacks.delete(channel); });
}

function stopPlayback(channel, graceful = false) {
  const st = playbacks.get(channel);
  if (!st) return;
  clearInterval(st.timer);
  if (graceful) st.sock.end(); else st.sock.destroy();
  playbacks.delete(channel);
}

function stopStream(channel) {
  const st = streams.get(channel);
  if (!st) return;
  clearInterval(st.timer);
  st.sock.destroy();
  streams.delete(channel);
  log(`canal ${channel}: vídeo encerrado`);
}

/* ---------- conexão 808 ---------- */

function connect() {
  const sock = net.connect(PORT, HOST);
  const splitter = new J.FrameSplitter();
  let timers = [];

  sock.on('connect', () => {
    log(`conectado em ${HOST}:${PORT} (${V2019 ? 'JT/T 808-2019' : 'JT/T 808-2013'}, SIM 1078 de ${SIM10 ? 10 : 6} bytes)`);
    send(sock, J.MSG.REGISTER, registerBody());
  });

  sock.on('data', (chunk) => {
    for (const raw of splitter.push(chunk)) {
      let m;
      try { m = J.decode(raw); } catch (e) { log(`mensagem inválida da plataforma: ${e.message}`); continue; }
      const reply = (result = 0) => send(sock, J.MSG.TERM_GENERAL_RESP, J.bodyGeneralResponse(m.serial, m.msgId, result));
      switch (m.msgId) {
        case J.MSG.REGISTER_RESP:
          authCode = m.body.subarray(3).toString('latin1');
          log(`registro aceito, código ${authCode}`);
          send(sock, J.MSG.AUTH, authBody());
          break;
        case J.MSG.PLAT_GENERAL_RESP: {
          const replyId = m.body.readUInt16BE(2);
          if (replyId === J.MSG.AUTH) {
            log(m.body[4] === 0 ? 'autenticado' : 'autenticação recusada');
            if (m.body[4] === 0 && !timers.length) {
              send(sock, J.MSG.LOCATION, locationBody());
              timers.push(setInterval(() => send(sock, J.MSG.LOCATION, locationBody()), INTERVALO_MS));
              timers.push(setInterval(() => send(sock, J.MSG.HEARTBEAT, Buffer.alloc(0)), 30000));
            }
          }
          break;
        }
        case J.MSG.VIDEO_REQUEST: {
          const len = m.body[0];
          const ip = m.body.subarray(1, 1 + len).toString('latin1');
          const port = m.body.readUInt16BE(1 + len);
          const channel = m.body[5 + len];
          reply(channel >= 1 && channel <= CHANNELS ? 0 : 1);
          if (channel >= 1 && channel <= CHANNELS) {
            // como os DVRs reais: pedido repetido para o mesmo destino mantém a conexão que já transmite
            const cur = streams.get(channel);
            if (cur && cur.dest === `${ip}:${port}` && !cur.sock.destroyed) log(`canal ${channel}: já transmitindo; mantém a conexão`);
            else startStream(ip, port, channel);
          }
          break;
        }
        case J.MSG.VIDEO_CONTROL:
          reply(0);
          if (m.body[1] === 0) stopStream(m.body[0]);
          break;
        case J.MSG.QUERY_RESOURCES: {
          const channel = m.body[0];
          const t0 = bcdToMs(m.body.subarray(1, 7));
          const t1 = bcdToMs(m.body.subarray(7, 13));
          const items = fakeRecordings(channel, t0, t1);
          log(`consulta de gravações: ${items.length} trecho(s)`);
          sendLong(sock, J.MSG.RESOURCE_LIST, resourceListBody(m.serial, items));
          break;
        }
        case J.MSG.PLAYBACK_REQUEST: {
          const len = m.body[0];
          const ip = m.body.subarray(1, 1 + len).toString('latin1');
          const port = m.body.readUInt16BE(1 + len);
          let o = 5 + len;
          const channel = m.body[o];
          o += 6; // canal, tipo, fluxo, armazenamento, modo, velocidade
          const t0 = bcdToMs(m.body.subarray(o, o + 6));
          const t1 = bcdToMs(m.body.subarray(o + 6, o + 12));
          if (PLAYBACK_MODE === 'ignorar') { log(`canal ${channel}: pedido de gravação ignorado (modo de teste)`); break; }
          if (!(channel >= 1 && channel <= CHANNELS) || !t0 || !t1 || PLAYBACK_MODE === 'recusar') { reply(1); break; }
          if (PLAYBACK_MODE === 'vazio') { send(sock, J.MSG.RESOURCE_LIST, resourceListBody(m.serial, [])); break; }
          if (PLAYBACK_MODE === 'geral' || PLAYBACK_MODE === 'mudo') reply(0);
          else send(sock, J.MSG.RESOURCE_LIST, resourceListBody(m.serial, [{ ch: channel, start: t0, end: t1, alarm: false }]));
          if (PLAYBACK_MODE !== 'mudo') startPlayback(ip, port, channel, t0, t1);
          break;
        }
        case J.MSG.PLAYBACK_CONTROL: {
          const [channel, control, speed] = m.body;
          reply(0);
          const st = playbacks.get(channel);
          if (!st) break;
          if (control === 0) { st.paused = false; st.interval = 40; st.restart(); log(`canal ${channel}: reprodução continuando`); }
          if (control === 1) { st.paused = true; log(`canal ${channel}: reprodução pausada`); }
          if (control === 2) { log(`canal ${channel}: reprodução encerrada pela plataforma`); stopPlayback(channel); }
          if (control === 3) { st.paused = false; st.interval = Math.max(5, 40 / [1, 1, 2, 4, 8, 16][speed || 1]); st.restart(); log(`canal ${channel}: avanço rápido`); }
          break;
        }
        case J.MSG.QUERY_ATTRIBUTES:
          send(sock, J.MSG.ATTRIBUTES_RESP, attributesBody());
          break;
        case J.MSG.QUERY_AV_ATTRIBUTES:
          send(sock, J.MSG.AV_ATTRIBUTES_RESP, Buffer.from([6, 1, 0, 1, 0x01, 0x40, 0, PT, 1, CHANNELS]));
          break;
        /* ---------- comandos ao veículo (1.11) ---------- */
        case J.MSG.TEXT_MESSAGE: {
          const flags = m.body[0];
          const texto = m.body.subarray(V2019 ? 2 : 1).toString('latin1');
          log(`mensagem ao motorista${flags & 8 ? ' (voz)' : ''}${flags & 4 ? ' (tela)' : ''}${flags & 1 ? ' URGENTE' : ''}: "${texto}"`);
          reply(0);
          break;
        }
        case J.MSG.CAMERA_SHOT: {
          const channel = m.body[0];
          if (!(channel >= 1 && channel <= CHANNELS)) {
            const r = Buffer.alloc(3); r.writeUInt16BE(m.serial, 0); r[2] = 2;
            send(sock, J.MSG.CAMERA_RESP, r);
            break;
          }
          const mediaId = (Date.now() / 1000 >>> 0) + channel;
          const r = Buffer.alloc(9); r.writeUInt16BE(m.serial, 0); r[2] = 0; r.writeUInt16BE(1, 3); r.writeUInt32BE(mediaId >>> 0, 5);
          send(sock, J.MSG.CAMERA_RESP, r);
          log(`foto pedida do canal ${channel}: enviando em 1 s`);
          setTimeout(() => {
            const cab = Buffer.from([0, 0, 0, 0, 0, 0, 0, channel]);
            cab.writeUInt32BE(mediaId >>> 0, 0);
            send(sock, J.MSG.MEDIA_EVENT, cab);
            const corpo = Buffer.concat([cab, locationBody().subarray(0, 28), FOTO]);
            sendLong(sock, J.MSG.MEDIA_UPLOAD, corpo);
          }, 1000);
          break;
        }
        case J.MSG.MEDIA_UPLOAD_RESP:
          log(`plataforma confirmou a mídia nº ${m.body.readUInt32BE(0)} (${m.body[4] ? `faltam ${m.body[4]} pacote(s)` : 'inteira'})`);
          break;
        case J.MSG.TERMINAL_CONTROL:
          reply(0);
          if (m.body[0] === 4) { log('reiniciar pedido pela plataforma: desconectando por 3 s'); setTimeout(() => sock.destroy(), 300); }
          break;
        case J.MSG.QUERY_PARAMS: {
          const itens = Object.entries(PARAMETROS).map(([id, v]) => {
            const cab = Buffer.alloc(5); cab.writeUInt32BE(Number(id), 0);
            let val; if (typeof v === 'number') { val = Buffer.alloc(4); val.writeUInt32BE(v, 0); } else val = Buffer.from(v, 'latin1');
            cab[4] = val.length;
            return Buffer.concat([cab, val]);
          });
          const head = Buffer.alloc(3); head.writeUInt16BE(m.serial, 0); head[2] = itens.length;
          send(sock, J.MSG.PARAMS_RESP, Buffer.concat([head, ...itens]));
          break;
        }
        case J.MSG.SET_PARAMS: {
          let o = 1;
          for (let k = 0; k < m.body[0] && o + 5 <= m.body.length; k++) {
            const id = m.body.readUInt32BE(o); const len = m.body[o + 4]; const v = m.body.subarray(o + 5, o + 5 + len); o += 5 + len;
            PARAMETROS[id] = typeof PARAMETROS[id] === 'string' || len !== 4 ? v.toString('latin1') : v.readUInt32BE(0);
            log(`parâmetro 0x${id.toString(16).padStart(4, '0')} = ${PARAMETROS[id]}`);
          }
          reply(0);
          break;
        }
        default:
          reply(3);
      }
    }
  });

  sock.on('error', (e) => log(`erro de conexão: ${e.message}`));
  sock.on('close', () => {
    timers.forEach(clearInterval);
    timers = [];
    for (const ch of [...streams.keys()]) stopStream(ch);
    for (const ch of [...playbacks.keys()]) stopPlayback(ch);
    log('desconectado; nova tentativa em 5s');
    setTimeout(connect, 5000);
  });
}

connect();
