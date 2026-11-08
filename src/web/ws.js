'use strict';
/**
 * FrotaGest — servidor WebSocket mínimo (RFC 6455), sem dependências externas.
 * Reis Tecnologia
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_INCOMING = 64 * 1024; // o painel só envia mensagens pequenas

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${digest}`,
    '', '',
  ].join('\r\n'));
  return new WsConnection(socket);
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.fragments = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    this.pingTimer = setInterval(() => this.frame(0x9, Buffer.alloc(0)), 25000);
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.emit('close');
  }

  frame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  send(data) {
    if (typeof data === 'string') this.frame(0x1, Buffer.from(data, 'utf8'));
    else this.frame(0x2, data);
  }

  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this.frame(0x8, b);
    this.socket.end();
    this.finish();
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = Boolean(b[0] & 0x80);
      const opcode = b[0] & 0x0f;
      const masked = Boolean(b[1] & 0x80);
      let len = b[1] & 0x7f;
      let o = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        o = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_INCOMING)) return this.close(1009);
        len = Number(big);
        o = 10;
      }
      if (!masked) return this.close(1002); // o navegador sempre mascara
      if (len > MAX_INCOMING) return this.close(1009);
      if (b.length < o + 4 + len) return;
      const mask = b.subarray(o, o + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = b[o + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(o + 4 + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        if (!this.fragments) return this.close(1002);
        this.fragments.parts.push(payload);
        this.fragments.size += len;
        if (this.fragments.size > MAX_INCOMING) return this.close(1009);
        if (fin) {
          const full = Buffer.concat(this.fragments.parts);
          const op = this.fragments.opcode;
          this.fragments = null;
          this.deliver(op, full);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) { this.fragments = { opcode, parts: [payload], size: len }; continue; }
        this.deliver(opcode, payload);
        continue;
      }
      return this.close(1002);
    }
  }

  deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }
}

module.exports = { accept, reject };
