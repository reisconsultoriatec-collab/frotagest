'use strict';
/**
 * FrotaGest — códigos de 6 dígitos que mudam a cada 30 segundos (TOTP, RFC 6238), os mesmos do
 * Google Authenticator, Microsoft Authenticator e Authy. Tudo calculado aqui no servidor: não usa
 * nenhum serviço externo nem o Firebase.
 * Reis Tecnologia
 */
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIODO = 30;
const DIGITOS = 6;
const JANELA = 1; // aceita o código anterior e o próximo (relógio do celular um pouco adiantado ou atrasado)

function base32(buf) {
  let bits = 0;
  let valor = 0;
  let out = '';
  for (const b of buf) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}

function deBase32(texto) {
  const s = String(texto).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const out = [];
  for (const ch of s) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error('chave inválida');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Chave nova de 160 bits (o tamanho recomendado pela RFC 4226). */
function novoSegredo() {
  return base32(crypto.randomBytes(20));
}

/** Código de um passo de 30 s (HOTP com o contador = passo). */
function codigoDoPasso(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(contador).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

const passoAtual = (ms = Date.now()) => Math.floor(ms / 1000 / PERIODO);

/**
 * Confere o código. Devolve o passo usado (para não aceitar o mesmo código duas vezes) ou null.
 * ultimoPasso: o último passo já aceito para este usuário.
 */
function conferir(segredo, codigo, ultimoPasso = null, agoraMs = Date.now()) {
  const c = String(codigo || '').replace(/\D/g, '');
  if (c.length !== DIGITOS) return null;
  const atual = passoAtual(agoraMs);
  for (let d = -JANELA; d <= JANELA; d++) {
    const p = atual + d;
    if (ultimoPasso !== null && ultimoPasso !== undefined && p <= Number(ultimoPasso)) continue;
    const esperado = codigoDoPasso(segredo, p);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(c))) return p;
  }
  return null;
}

/** Endereço que o aplicativo lê no QR Code. */
function uri({ segredo, conta, emissor = 'FrotaGest' }) {
  const rotulo = `${encodeURIComponent(emissor)}:${encodeURIComponent(conta)}`;
  return `otpauth://totp/${rotulo}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=${DIGITOS}&period=${PERIODO}`;
}

/** "ABCD EFGH ..." para digitar à mão quando a câmera não lê o QR Code. */
const chaveLegivel = (segredo) => segredo.replace(/(.{4})/g, '$1 ').trim();

module.exports = { novoSegredo, conferir, codigoDoPasso, passoAtual, uri, chaveLegivel, base32, deBase32 };
