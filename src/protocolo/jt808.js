'use strict';
/**
 * FrotaGest — codificação e decodificação do protocolo JT/T 808 (2013 e 2019).
 * Reis Tecnologia
 */

const MSG = {
  TERM_GENERAL_RESP: 0x0001,
  HEARTBEAT: 0x0002,
  LOGOUT: 0x0003,
  REGISTER: 0x0100,
  AUTH: 0x0102,
  PARAMS_RESP: 0x0104,
  ATTRIBUTES_RESP: 0x0107,
  LOCATION: 0x0200,
  BATCH_LOCATION: 0x0704,
  AV_ATTRIBUTES_RESP: 0x1003,
  PLAT_GENERAL_RESP: 0x8001,
  REGISTER_RESP: 0x8100,
  QUERY_ATTRIBUTES: 0x8107,
  QUERY_AV_ATTRIBUTES: 0x9003,
  VIDEO_REQUEST: 0x9101,
  VIDEO_CONTROL: 0x9102,
  RESOURCE_LIST: 0x1205,
  PLAYBACK_REQUEST: 0x9201,
  PLAYBACK_CONTROL: 0x9202,
  QUERY_RESOURCES: 0x9205,
  MEDIA_EVENT: 0x0800,
  MEDIA_UPLOAD: 0x0801,
  CAMERA_RESP: 0x0805,
  SET_PARAMS: 0x8103,
  QUERY_PARAMS: 0x8104,
  TERMINAL_CONTROL: 0x8105,
  TEXT_MESSAGE: 0x8300,
  MEDIA_UPLOAD_RESP: 0x8800,
  CAMERA_SHOT: 0x8801,
};

const MSG_NAMES = {
  0x0001: 'Resposta geral do aparelho',
  0x0002: 'Sinal de vida (heartbeat)',
  0x0003: 'Desconexão do aparelho',
  0x0100: 'Registro do aparelho',
  0x0102: 'Autenticação do aparelho',
  0x0104: 'Resposta de parâmetros',
  0x0107: 'Atributos do aparelho',
  0x0200: 'Posição',
  0x0704: 'Posições em lote',
  0x0800: 'Evento de mídia',
  0x0801: 'Envio de mídia',
  0x0805: 'Resposta da foto',
  0x0900: 'Dados transparentes',
  0x1003: 'Atributos de áudio e vídeo',
  0x1005: 'Contagem de passageiros',
  0x1205: 'Lista de gravações',
  0x1206: 'Resultado de envio de arquivo',
  0x8001: 'Resposta geral da plataforma',
  0x8100: 'Resposta de registro',
  0x8103: 'Alteração de parâmetros',
  0x8104: 'Consulta de parâmetros',
  0x8105: 'Controle do aparelho',
  0x8300: 'Mensagem ao motorista',
  0x8800: 'Resposta de envio de mídia',
  0x8801: 'Pedido de foto',
  0x8107: 'Consulta de atributos',
  0x9003: 'Consulta de atributos de áudio e vídeo',
  0x9101: 'Pedido de vídeo ao vivo',
  0x9102: 'Controle de vídeo ao vivo',
  0x9201: 'Pedido de reprodução de gravação',
  0x9202: 'Controle de reprodução',
  0x9205: 'Consulta de gravações',
};

const RESULT_NAMES = ['sucesso', 'falha', 'mensagem com erro', 'não suportado', 'alarme confirmado'];

const ALARM_BITS = [
  'Botão de emergência', 'Excesso de velocidade', 'Fadiga ao dirigir', 'Alerta de perigo',
  'Falha no módulo GNSS', 'Antena GNSS desconectada', 'Antena GNSS em curto', 'Tensão baixa na alimentação',
  'Alimentação principal cortada', 'Falha no display', 'Falha no módulo de voz (TTS)', 'Falha de câmera',
  'Falha no leitor de cartão do motorista', 'Pré-alerta de velocidade', 'Pré-alerta de fadiga', null,
  null, null, 'Tempo de direção acumulado excedido', 'Parada prolongada',
  'Entrada/saída de área', 'Entrada/saída de rota', 'Tempo de trecho fora do previsto', 'Desvio de rota',
  'Falha no sensor de velocidade (VSS)', 'Combustível anormal', 'Furto do veículo', 'Ignição não autorizada',
  'Deslocamento não autorizado', 'Pré-alerta de colisão', 'Pré-alerta de capotamento', 'Abertura de porta não autorizada',
];

const VIDEO_ALARM_BITS = [
  'Perda de sinal de vídeo', 'Câmera obstruída', 'Falha no armazenamento', 'Falha em outro equipamento de vídeo',
  'Excesso de passageiros', 'Direção anormal', 'Gravação de alarme atingiu o limite de armazenamento',
];

const MAX_FRAME = 64 * 1024; // nenhuma mensagem 808 legítima chega perto disso

/* ---------- utilitários ---------- */

function bcdToString(buf) {
  let s = '';
  for (const b of buf) s += (b >> 4).toString(16) + (b & 0x0f).toString(16);
  return s;
}

function stringToBcd(str, len) {
  const digits = String(str).replace(/\D/g, '').padStart(len * 2, '0').slice(-len * 2);
  return Buffer.from(digits, 'hex');
}

/** Identificador canônico do aparelho: número do terminal sem zeros à esquerda. */
function normalizeId(id) {
  const s = String(id).replace(/\D/g, '').replace(/^0+/, '');
  return s || '0';
}

function cleanString(buf) {
  return buf.toString('latin1').replace(/\0/g, '').trim();
}

function hex(buf, max = 512) {
  const h = buf.subarray(0, max).toString('hex').replace(/(..)/g, '$1 ').trim();
  return buf.length > max ? `${h} … (+${buf.length - max} bytes)` : h;
}

function bcdTime(buf) {
  const s = bcdToString(buf);
  if (!/^\d{12}$/.test(s)) return null;
  return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)} ${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

/* ---------- enquadramento (0x7e … 0x7e) ---------- */

class FrameSplitter {
  constructor(max = MAX_FRAME) {
    this.buf = Buffer.alloc(0);
    this.max = max;
    this.overflows = 0;
  }

  /** Recebe bytes do socket e devolve os quadros completos (ainda com escape, sem os delimitadores). */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    let last = this.buf.indexOf(0x7e);
    if (last < 0) {
      if (this.buf.length > this.max) { this.buf = Buffer.alloc(0); this.overflows++; }
      return frames;
    }
    let i;
    while ((i = this.buf.indexOf(0x7e, last + 1)) >= 0) {
      if (i > last + 1) frames.push(Buffer.from(this.buf.subarray(last + 1, i)));
      last = i;
    }
    this.buf = this.buf.subarray(last);
    if (this.buf.length > this.max) { this.buf = Buffer.alloc(0); this.overflows++; }
    return frames;
  }
}

function unescape(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      const n = buf[i + 1];
      if (n === 0x02) { out[j++] = 0x7e; i++; continue; }
      if (n === 0x01) { out[j++] = 0x7d; i++; continue; }
    }
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

function escape(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x7e) out.push(0x7d, 0x02);
    else if (b === 0x7d) out.push(0x7d, 0x01);
    else out.push(b);
  }
  return Buffer.from(out);
}

function xor(buf) {
  let x = 0;
  for (const b of buf) x ^= b;
  return x;
}

/* ---------- mensagem ---------- */

function decode(rawEscaped) {
  const d = unescape(rawEscaped);
  if (d.length < 13) throw new Error(`mensagem curta demais (${d.length} bytes)`);
  const checksum = d[d.length - 1];
  const calc = xor(d.subarray(0, d.length - 1));
  if (checksum !== calc) throw new Error(`checksum inválido (recebido ${checksum.toString(16)}, calculado ${calc.toString(16)})`);

  const msgId = d.readUInt16BE(0);
  const props = d.readUInt16BE(2);
  const bodyLen = props & 0x03ff;
  const encrypt = (props >> 10) & 0x07;
  const sub = Boolean(props & 0x2000);
  const v2019 = Boolean(props & 0x4000);

  let o = 4;
  let protocolVersion = null;
  if (v2019) protocolVersion = d[o++];
  const phoneLen = v2019 ? 10 : 6;
  if (d.length < o + phoneLen + 3) throw new Error('cabeçalho incompleto');
  const phoneBcd = Buffer.from(d.subarray(o, o + phoneLen));
  o += phoneLen;
  const serial = d.readUInt16BE(o);
  o += 2;
  let total = 0;
  let index = 0;
  if (sub) {
    if (d.length < o + 5) throw new Error('cabeçalho de subpacote incompleto');
    total = d.readUInt16BE(o);
    index = d.readUInt16BE(o + 2);
    o += 4;
  }
  const body = Buffer.from(d.subarray(o, d.length - 1));
  return {
    msgId, v2019, protocolVersion, phoneBcd, phone: bcdToString(phoneBcd), serial,
    sub, total, index, encrypt, body, bodyLenDeclared: bodyLen, lenMismatch: body.length !== bodyLen, raw: d,
  };
}

function encode({ msgId, v2019, protocolVersion = 1, phoneBcd, serial, body = Buffer.alloc(0), pkg = null }) {
  if (body.length > 0x3ff) throw new Error('corpo maior que 1023 bytes exige subpacote');
  const head = [];
  const props = body.length | (v2019 ? 0x4000 : 0) | (pkg ? 0x2000 : 0);
  const h = Buffer.alloc(4);
  h.writeUInt16BE(msgId, 0);
  h.writeUInt16BE(props, 2);
  head.push(h);
  if (v2019) head.push(Buffer.from([protocolVersion & 0xff]));
  head.push(phoneBcd);
  const s = Buffer.alloc(2);
  s.writeUInt16BE(serial & 0xffff, 0);
  head.push(s);
  if (pkg) {
    const p = Buffer.alloc(4);
    p.writeUInt16BE(pkg.total, 0);
    p.writeUInt16BE(pkg.index, 2);
    head.push(p);
  }
  const content = Buffer.concat([...head, body]);
  const full = Buffer.concat([content, Buffer.from([xor(content)])]);
  return Buffer.concat([Buffer.from([0x7e]), escape(full), Buffer.from([0x7e])]);
}

/* ---------- corpos enviados pela plataforma ---------- */

function bodyGeneralResponse(replySerial, replyId, result = 0) {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(replySerial & 0xffff, 0);
  b.writeUInt16BE(replyId, 2);
  b[4] = result;
  return b;
}

function bodyRegisterResponse(replySerial, result, authCode) {
  const b = Buffer.alloc(3);
  b.writeUInt16BE(replySerial & 0xffff, 0);
  b[2] = result;
  return result === 0 ? Buffer.concat([b, Buffer.from(authCode, 'latin1')]) : b;
}

/**
 * 0x9101 — pede ao aparelho que envie vídeo ao vivo para ip:tcpPort.
 * dataType: 0 áudio+vídeo, 1 vídeo, 2 interfone, 3 escuta. streamType: 0 principal, 1 secundário.
 */
function bodyVideoRequest({ ip, tcpPort, udpPort = 0, channel, dataType = 1, streamType = 1 }) {
  const ipBuf = Buffer.from(String(ip), 'latin1');
  const b = Buffer.alloc(1 + ipBuf.length + 7);
  let o = 0;
  b[o++] = ipBuf.length;
  ipBuf.copy(b, o); o += ipBuf.length;
  b.writeUInt16BE(tcpPort, o); o += 2;
  b.writeUInt16BE(udpPort, o); o += 2;
  b[o++] = channel;
  b[o++] = dataType;
  b[o++] = streamType;
  return b;
}

/** 0x9102 — command: 0 encerrar, 1 trocar fluxo, 2 pausar, 3 retomar, 4 encerrar interfone. */
function bodyVideoControl({ channel, command = 0, closeType = 0, streamType = 0 }) {
  return Buffer.from([channel, command, closeType, streamType]);
}

/** 'AAAA-MM-DD hh:mm:ss' → BCD[6] (AAMMDDhhmmss), na hora do próprio aparelho. */
function timeToBcd(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) throw new Error(`data/hora inválida: ${text}`);
  return Buffer.from(`${m[1].slice(2)}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`, 'hex');
}

/**
 * 0x9205 — consulta as gravações guardadas no aparelho.
 * avType: 0 áudio+vídeo, 1 áudio, 2 vídeo, 3 vídeo ou áudio+vídeo. streamType: 0 todos, 1 principal, 2 secundário.
 * storage: 0 todos, 1 principal, 2 backup.
 */
function bodyQueryResources({ channel = 0, start, end, avType = 3, streamType = 0, storage = 0 }) {
  return Buffer.concat([
    Buffer.from([channel]), timeToBcd(start), timeToBcd(end),
    Buffer.alloc(8), // sem filtro de alarme: filtramos no painel
    Buffer.from([avType, streamType, storage]),
  ]);
}

/**
 * 0x9201 — pede que o aparelho reproduza uma gravação, entregando em ip:tcpPort.
 * mode: 0 normal, 1 avanço rápido, 2 retrocesso por quadro I, 3 só quadros I, 4 quadro único.
 * speed (para modos 1 e 2): 1 = 1x, 2 = 2x, 3 = 4x, 4 = 8x, 5 = 16x.
 */
function bodyPlaybackRequest({ ip, tcpPort, udpPort = 0, channel, avType, streamType, storage, mode = 0, speed = 0, start, end }) {
  // tipo de mídia 0 áudio e vídeo, 1 áudio, 2 vídeo, 3 vídeo ou áudio e vídeo; fluxo 0 qualquer, 1 principal, 2 secundário;
  // armazenamento 0 qualquer, 1 principal, 2 backup
  avType = Number.isInteger(avType) ? avType : 2;
  streamType = Number.isInteger(streamType) ? streamType : 0;
  storage = Number.isInteger(storage) ? storage : 0;
  const ipBuf = Buffer.from(String(ip), 'latin1');
  const ports = Buffer.alloc(4);
  ports.writeUInt16BE(tcpPort, 0);
  ports.writeUInt16BE(udpPort, 2);
  return Buffer.concat([
    Buffer.from([ipBuf.length]), ipBuf, ports,
    Buffer.from([channel, avType, streamType, storage, mode, speed]),
    timeToBcd(start), timeToBcd(end),
  ]);
}

/** 0x9202 — control: 0 iniciar/continuar, 1 pausar, 2 encerrar, 3 avanço rápido, 4 retrocesso, 5 ir para, 6 só quadros I. */
function bodyPlaybackControl({ channel, control, speed = 0, seek = null }) {
  return Buffer.concat([Buffer.from([channel, control, speed]), seek ? timeToBcd(seek) : Buffer.alloc(6)]);
}

/* ---------- corpos enviados pelo aparelho ---------- */

function parseTerminalResponse(body) {
  if (body.length < 5) return null;
  const result = body[4];
  return { replySerial: body.readUInt16BE(0), replyId: body.readUInt16BE(2), result, resultName: RESULT_NAMES[result] || `código ${result}` };
}

function parseRegister(body, v2019) {
  const L = v2019 ? { man: 11, model: 30, tid: 30 } : { man: 5, model: 20, tid: 7 };
  let o = 0;
  const r = {};
  try {
    r.province = body.readUInt16BE(o); o += 2;
    r.city = body.readUInt16BE(o); o += 2;
    r.manufacturer = cleanString(body.subarray(o, o + L.man)); o += L.man;
    r.model = cleanString(body.subarray(o, o + L.model)); o += L.model;
    r.terminalId = cleanString(body.subarray(o, o + L.tid)); o += L.tid;
    r.plateColor = body[o++];
    r.plate = cleanString(body.subarray(o));
  } catch (e) {
    r.parseError = 'registro com layout diferente do esperado';
  }
  return r;
}

function parseAuth(body, v2019) {
  if (!v2019) return { authCode: cleanString(body) };
  const len = body[0];
  if (len === undefined || len + 1 > body.length) return { authCode: cleanString(body) };
  const authCode = cleanString(body.subarray(1, 1 + len));
  const imei = cleanString(body.subarray(1 + len, 1 + len + 15));
  const software = cleanString(body.subarray(1 + len + 15, 1 + len + 35));
  return { authCode, imei, software };
}

function parseLocation(body) {
  if (body.length < 28) throw new Error('posição incompleta');
  const alarm = body.readUInt32BE(0);
  const status = body.readUInt32BE(4);
  const south = Boolean(status & (1 << 2));
  const west = Boolean(status & (1 << 3));
  const lat = body.readUInt32BE(8) / 1e6 * (south ? -1 : 1);
  const lon = body.readUInt32BE(12) / 1e6 * (west ? -1 : 1);
  const altitude = body.readUInt16BE(16);
  const speed = body.readUInt16BE(18) / 10;
  const direction = body.readUInt16BE(20);
  const time = bcdTime(body.subarray(22, 28));

  const alarms = [];
  for (let i = 0; i < 32; i++) if ((alarm >>> i) & 1) alarms.push(ALARM_BITS[i] || `Alarme bit ${i}`);

  const flags = {
    ignicao: Boolean(status & 1),
    gpsFixado: Boolean(status & 2),
    combustivelCortado: Boolean(status & (1 << 10)),
    circuitoCortado: Boolean(status & (1 << 11)),
    portasTravadas: Boolean(status & (1 << 12)),
    emMovimento: Boolean(status & (1 << 22)),
  };

  const extras = {};
  const raw = [];
  let o = 28;
  while (o + 2 <= body.length) {
    const id = body[o];
    const len = body[o + 1];
    const v = body.subarray(o + 2, o + 2 + len);
    o += 2 + len;
    if (v.length < len) break;
    switch (id) {
      case 0x01: if (len === 4) extras.odometroKm = v.readUInt32BE(0) / 10; break;
      case 0x02: if (len === 2) extras.combustivelL = v.readUInt16BE(0) / 10; break;
      case 0x03: if (len === 2) extras.velocidadeTacografoKmh = v.readUInt16BE(0) / 10; break;
      case 0x14: if (len === 4) extras.alarmeVideo = v.readUInt32BE(0); break;
      case 0x15: if (len === 4) extras.canaisSemSinal = channelsFromMask(v.readUInt32BE(0)); break;
      case 0x16: if (len === 4) extras.canaisObstruidos = channelsFromMask(v.readUInt32BE(0)); break;
      case 0x17: if (len === 2) extras.falhaArmazenamento = v.readUInt16BE(0); break;
      case 0x25: if (len === 4) extras.sinaisVeiculo = v.readUInt32BE(0); break;
      case 0x2a: if (len === 2) extras.entradasIO = v.readUInt16BE(0); break;
      case 0x30: if (len === 1) extras.sinalRede = v[0]; break;
      case 0x31: if (len === 1) extras.satelites = v[0]; break;
      default: raw.push({ id: `0x${id.toString(16).padStart(2, '0')}`, hex: hex(v, 64) });
    }
  }
  if (raw.length) extras.outros = raw;

  return { alarm, status, alarms, flags, lat, lon, altitude, speed, direction, time, extras };
}

function channelsFromMask(mask) {
  const out = [];
  for (let i = 0; i < 32; i++) if ((mask >>> i) & 1) out.push(i + 1);
  return out;
}

function parseBatchLocation(body) {
  const count = body.readUInt16BE(0);
  const type = body[2];
  const items = [];
  let o = 3;
  for (let i = 0; i < count && o + 2 <= body.length; i++) {
    const len = body.readUInt16BE(o);
    o += 2;
    try { items.push(parseLocation(body.subarray(o, o + len))); } catch (e) { /* item inválido */ }
    o += len;
  }
  return { count, type: type === 1 ? 'retransmissão' : 'normal', items };
}

function parseAttributes(body, v2019) {
  const L = v2019 ? { man: 5, model: 30, tid: 30 } : { man: 5, model: 20, tid: 7 };
  const r = {};
  let o = 0;
  try {
    r.terminalType = body.readUInt16BE(o); o += 2;
    r.manufacturer = cleanString(body.subarray(o, o + L.man)); o += L.man;
    r.model = cleanString(body.subarray(o, o + L.model)); o += L.model;
    r.terminalId = cleanString(body.subarray(o, o + L.tid)); o += L.tid;
    r.iccid = bcdToString(body.subarray(o, o + 10)); o += 10;
    const hwLen = body[o++];
    r.hardware = cleanString(body.subarray(o, o + hwLen)); o += hwLen;
    const fwLen = body[o++];
    r.firmware = cleanString(body.subarray(o, o + fwLen)); o += fwLen;
    r.gnss = body[o++];
    r.comm = body[o++];
  } catch (e) {
    r.parseError = 'atributos com layout diferente do esperado';
  }
  return r;
}

const AV_CODECS = { 6: 'G.711A', 7: 'G.711U', 8: 'G.726', 19: 'AAC', 26: 'ADPCM', 98: 'H.264', 99: 'H.265', 100: 'AVS', 101: 'SVAC' };

function parseAvAttributes(body) {
  if (body.length < 10) return { parseError: 'atributos de áudio e vídeo incompletos' };
  return {
    audioCodec: AV_CODECS[body[0]] || `tipo ${body[0]}`,
    audioChannels: body[1],
    audioSampleRate: [8000, 22050, 44100, 48000][body[2]] || body[2],
    audioBits: [8, 16, 32][body[3]] || body[3],
    audioFrameLength: body.readUInt16BE(4),
    audioOutput: Boolean(body[6]),
    videoCodec: AV_CODECS[body[7]] || `tipo ${body[7]}`,
    maxAudioChannels: body[8],
    maxVideoChannels: body[9],
  };
}

const AV_TYPES = ['áudio e vídeo', 'áudio', 'vídeo', 'vídeo ou áudio e vídeo'];

/** 0x1205 — lista de gravações (resposta a 0x9205 e também a 0x9201). */
function parseResourceList(body) {
  const replySerial = body.readUInt16BE(0);
  const total = body.readUInt32BE(2);
  const items = [];
  let o = 6;
  while (o + 28 <= body.length) {
    const hi = body.readUInt32BE(o + 13);
    const lo = body.readUInt32BE(o + 17);
    const alarms = [];
    for (let i = 0; i < 32; i++) if ((lo >>> i) & 1) alarms.push(ALARM_BITS[i] || `Alarme bit ${i}`);
    for (let i = 0; i < 32; i++) if ((hi >>> i) & 1) alarms.push(VIDEO_ALARM_BITS[i] || `Alarme de vídeo bit ${i}`);
    items.push({
      channel: body[o],
      start: bcdTime(body.subarray(o + 1, o + 7)),
      end: bcdTime(body.subarray(o + 7, o + 13)),
      alarms,
      avType: AV_TYPES[body[o + 21]] || `tipo ${body[o + 21]}`,
      stream: body[o + 22] === 1 ? 'principal' : body[o + 22] === 2 ? 'secundário' : `tipo ${body[o + 22]}`,
      storage: body[o + 23] === 2 ? 'backup' : 'principal',
      size: body.readUInt32BE(o + 24),
    });
    o += 28;
  }
  return { replySerial, total, items };
}

/* ---------- comandos ao veículo (1.11) ---------- */

/**
 * 0x8300 — mensagem de texto ao motorista. flags: bit0 urgente, bit2 mostrar na tela, bit3 ler em voz alta (TTS).
 * O aparelho lê em GBK (chinês): o texto vai sem acentos (só ASCII, que é igual em GBK).
 * 2019: flags + tipo do texto (1 = aviso) + texto; 2013: flags + texto.
 */
function semAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ºª°]/g, (c) => ({ 'º': 'o', 'ª': 'a', '°': 'o' }[c]))
    .replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}

function bodyTextMessage({ texto, tela = true, voz = true, urgente = false, v2019 = true }) {
  const flags = (urgente ? 1 : 0) | (tela ? 1 << 2 : 0) | (voz ? 1 << 3 : 0);
  const t = Buffer.from(semAcentos(texto), 'latin1');
  return Buffer.concat([Buffer.from(v2019 ? [flags, 1] : [flags]), t]);
}

/**
 * 0x8801 — foto na hora. count: quantas fotos (1); save 0 = enviar já (0x0801), 1 = só guardar no aparelho.
 * resolution: 1 = 320x240, 2 = 640x480, 3 = 800x600, 4 = 1024x768, 8 = 704x576. quality 1 (melhor) a 10.
 */
function bodyCameraShot({ channel, count = 1, interval = 0, save = 0, resolution = 2, quality = 3 }) {
  const b = Buffer.alloc(12);
  b[0] = channel;
  b.writeUInt16BE(count, 1);
  b.writeUInt16BE(interval, 3);
  b[5] = save;
  b[6] = resolution;
  b[7] = quality;
  b[8] = 128; // brilho
  b[9] = 64; // contraste
  b[10] = 64; // saturação
  b[11] = 128; // cor
  return b;
}

/** 0x0805 — resposta ao pedido de foto: resultado (0 ok, 1 falhou, 2 canal não existe) e os números das fotos. */
function parseCameraResponse(body) {
  if (body.length < 3) return null;
  const result = body[2];
  const ids = [];
  if (body.length >= 5) {
    const n = body.readUInt16BE(3);
    for (let i = 0; i < n && 5 + i * 4 + 4 <= body.length; i++) ids.push(body.readUInt32BE(5 + i * 4));
  }
  return { replySerial: body.readUInt16BE(0), result, resultName: ['sucesso', 'falhou', 'canal não existe'][result] || `código ${result}`, ids };
}

/** 0x0800 — evento de mídia (antes do envio): número, tipo (0 foto, 1 áudio, 2 vídeo), formato (0 JPEG), evento, canal. */
function parseMediaEvent(body) {
  if (body.length < 8) return null;
  return { mediaId: body.readUInt32BE(0), type: body[4], format: body[5], event: body[6], channel: body[7] };
}

/** 0x0801 — envio de mídia (já com os subpacotes juntos): cabeçalho, posição na hora e o arquivo (JPEG). */
function parseMediaUpload(body) {
  if (body.length < 8 + 28) throw new Error('envio de mídia incompleto');
  const r = { mediaId: body.readUInt32BE(0), type: body[4], format: body[5], event: body[6], channel: body[7] };
  try { r.position = parseLocation(body.subarray(8, 36)); } catch { r.position = null; }
  r.data = body.subarray(36);
  return r;
}

/** 0x8800 — resposta ao envio de mídia: recebido inteiro (sem pacotes para reenviar). */
function bodyMediaUploadResponse(mediaId, retransmitir = []) {
  const b = Buffer.alloc(5 + retransmitir.length * 2);
  b.writeUInt32BE(mediaId >>> 0, 0);
  b[4] = retransmitir.length;
  retransmitir.forEach((x, i) => b.writeUInt16BE(x, 5 + i * 2));
  return b;
}

/** 0x8105 — controle do aparelho. 4 = reiniciar. */
function bodyTerminalControl(command, params = '') {
  return Buffer.concat([Buffer.from([command]), Buffer.from(String(params), 'latin1')]);
}

/** Parâmetros conhecidos (JT/T 808): id → { nome, tipo }. */
const PARAMS = {
  0x0001: { chave: 'batimento', nome: 'Sinal de vida (heartbeat)', tipo: 'dword', unidade: 's' },
  0x0010: { chave: 'apn', nome: 'APN do chip', tipo: 'string' },
  0x0011: { chave: 'apnUsuario', nome: 'Usuário do APN', tipo: 'string' },
  0x0012: { chave: 'apnSenha', nome: 'Senha do APN', tipo: 'string', oculto: true },
  0x0013: { chave: 'servidor', nome: 'Servidor principal', tipo: 'string' },
  0x0018: { chave: 'porta', nome: 'Porta do servidor (TCP)', tipo: 'dword' },
  0x0020: { chave: 'estrategia', nome: 'Estratégia de envio de posição', tipo: 'dword' },
  0x0027: { chave: 'intervaloDormindo', nome: 'Posição com o veículo desligado (dormindo)', tipo: 'dword', unidade: 's' },
  0x0029: { chave: 'intervaloPosicao', nome: 'Posição com o veículo ligado', tipo: 'dword', unidade: 's' },
  0x0055: { chave: 'velocidadeMax', nome: 'Velocidade máxima no aparelho', tipo: 'dword', unidade: 'km/h' },
  0x0056: { chave: 'tempoExcesso', nome: 'Tempo acima da velocidade para o aparelho alarmar', tipo: 'dword', unidade: 's' },
  0x0080: { chave: 'odometro', nome: 'Odômetro do aparelho', tipo: 'dword', unidade: '0,1 km' },
  0x0083: { chave: 'placa', nome: 'Placa no aparelho', tipo: 'string' },
};
const PARAM_POR_CHAVE = Object.fromEntries(Object.entries(PARAMS).map(([id, p]) => [p.chave, Number(id)]));

/** 0x0104 — resposta à consulta de parâmetros. */
function parseParamsResponse(body) {
  if (body.length < 3) throw new Error('resposta de parâmetros incompleta');
  const replySerial = body.readUInt16BE(0);
  const total = body[2];
  const itens = [];
  let o = 3;
  while (o + 5 <= body.length) {
    const id = body.readUInt32BE(o);
    const len = body[o + 4];
    const v = body.subarray(o + 5, o + 5 + len);
    o += 5 + len;
    if (v.length < len) break;
    const def = PARAMS[id];
    let valor;
    if (len === 4 && (!def || def.tipo === 'dword')) valor = v.readUInt32BE(0);
    else if (len === 2 && (!def || def.tipo !== 'string')) valor = v.readUInt16BE(0);
    else if (len === 1 && (!def || def.tipo !== 'string')) valor = v[0];
    else valor = cleanString(v);
    itens.push({ id, hexId: `0x${id.toString(16).padStart(4, '0')}`, chave: def ? def.chave : null, nome: def ? def.nome : null, valor });
  }
  return { replySerial, total, itens };
}

/** 0x8103 — altera parâmetros: [{ id, valor }] (número = DWORD; texto = STRING). */
function bodySetParams(lista) {
  const partes = [Buffer.from([lista.length])];
  for (const { id, valor } of lista) {
    const cab = Buffer.alloc(5);
    cab.writeUInt32BE(id >>> 0, 0);
    let v;
    if (typeof valor === 'number') { v = Buffer.alloc(4); v.writeUInt32BE(valor >>> 0, 0); } else v = Buffer.from(String(valor), 'latin1');
    cab[4] = v.length;
    partes.push(cab, v);
  }
  return Buffer.concat(partes);
}

module.exports = {
  MSG, MSG_NAMES, RESULT_NAMES, AV_CODECS,
  FrameSplitter, decode, encode, unescape, escape, xor,
  bcdToString, stringToBcd, normalizeId, hex, bcdTime,
  bodyGeneralResponse, bodyRegisterResponse, bodyVideoRequest, bodyVideoControl,
  timeToBcd, bodyQueryResources, bodyPlaybackRequest, bodyPlaybackControl, parseResourceList, VIDEO_ALARM_BITS, ALARM_BITS,
  parseTerminalResponse, parseRegister, parseAuth, parseLocation, parseBatchLocation, parseAttributes, parseAvAttributes,
  semAcentos, bodyTextMessage, bodyCameraShot, parseCameraResponse, parseMediaEvent, parseMediaUpload, bodyMediaUploadResponse,
  bodyTerminalControl, PARAMS, PARAM_POR_CHAVE, parseParamsResponse, bodySetParams,
};
