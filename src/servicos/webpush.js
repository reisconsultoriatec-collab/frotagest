'use strict';
/**
 * FrotaGest — envio de aviso pelo Web Push (o mesmo padrão dos navegadores: Chrome/Android, Safari/iPhone,
 * Edge, Firefox), sem biblioteca de fora:
 *  - RFC 8291 + RFC 8188: o aviso vai criptografado (aes128gcm) com as chaves do próprio aparelho;
 *    o serviço de push do Google/Apple/Mozilla/Microsoft só entrega, não lê.
 *  - RFC 8292 (VAPID): o servidor se identifica com um par de chaves P-256 (a pública vai para o navegador
 *    quando a pessoa ativa os avisos).
 * Reis Tecnologia
 */
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (chave, dados) => crypto.createHmac('sha256', chave).update(dados).digest();

/** Par de chaves VAPID novo: { publica (65 bytes, base64url), privada (32 bytes, base64url) } */
function gerarChaves() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publica: b64u(Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)])), privada: jwk.d };
}

function chavePrivada({ publica, privada }) {
  const pub = deB64u(publica);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('chave pública VAPID inválida');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privada, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
}

/** JWT do VAPID (ES256) para um serviço de push (aud = origem do endpoint). */
function jwtVapid(audiencia, assunto, chaves, validadeSeg = 12 * 3600) {
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const dados = b64u(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + validadeSeg, sub: assunto }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cab}.${dados}`), { key: chavePrivada(chaves), dsaEncoding: 'ieee-p1363' });
  return `${cab}.${dados}.${b64u(assinatura)}`;
}

/**
 * Criptografa o conteúdo para o aparelho (RFC 8291, um registro só).
 * p256dh e auth: as chaves que o navegador entregou na inscrição (base64url).
 */
function criptografar(conteudo, p256dh, auth, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPub = deB64u(p256dh);
  const segredoAuth = deB64u(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error('chave p256dh inválida');
  if (segredoAuth.length < 16) throw new Error('chave auth inválida');
  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPub = local.getPublicKey();
  const compartilhado = local.computeSecret(uaPub);
  // HKDF (RFC 5869) com SHA-256, como descrito na RFC 8291
  const prkChave = hmac(segredoAuth, compartilhado);
  const ikm = hmac(prkChave, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const texto = Buffer.concat([Buffer.from(conteudo), Buffer.from([2])]); // 0x02 = último registro
  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([cifra.update(texto), cifra.final(), cifra.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, cifrado]);
}

/**
 * Envia um aviso. inscricao: { endpoint, p256dh, auth }.
 * Retorna { status, texto }: 201 = entregue ao serviço de push; 404/410 = inscrição não existe mais.
 */
async function enviar(inscricao, conteudo, { chaves, assunto, ttl = 3600, urgencia = 'normal', topico = null, jwts = null, buscar = fetch } = {}) {
  const url = new URL(inscricao.endpoint);
  let jwt = jwts && jwts.get(url.origin);
  if (!jwt || jwt.ate < Date.now()) {
    jwt = { t: jwtVapid(url.origin, assunto, chaves), ate: Date.now() + 11 * 3600000 };
    if (jwts) jwts.set(url.origin, jwt);
  }
  const cabecalhos = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgencia,
    Authorization: `vapid t=${jwt.t}, k=${chaves.publica}`,
  };
  if (topico) cabecalhos.Topic = topico;
  const r = await buscar(inscricao.endpoint, {
    method: 'POST', headers: cabecalhos, body: criptografar(conteudo, inscricao.p256dh, inscricao.auth), signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, texto: r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200) };
}

module.exports = { gerarChaves, jwtVapid, criptografar, enviar, b64u, deB64u };
