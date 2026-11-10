'use strict';
/**
 * FrotaGest — logotipo das empresas clientes: aparece no topo do painel, no modo TV e nos PDFs.
 * O navegador já manda a imagem reduzida em dois formatos: PNG (tela, com transparência) e JPEG
 * (PDF, fundo branco). Aqui só conferimos que são imagens de verdade e do tamanho certo.
 * Reis Tecnologia
 */
const { HttpErro } = require('../util/comum');

const MAX_LADO = 1200;
const MAX_BYTES = 600 * 1024;

/** Largura e altura de um PNG (cabeçalho IHDR). */
function medidasPng(b) {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 33 || !b.subarray(0, 8).equals(assinatura) || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { largura: b.readUInt32BE(16), altura: b.readUInt32BE(20) };
}

/** Largura, altura e componentes de cor de um JPEG (marcador SOF). */
function medidasJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const tam = b.readUInt16BE(i + 2);
    // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { altura: b.readUInt16BE(i + 5), largura: b.readUInt16BE(i + 7), componentes: b[i + 9], progressivo: m === 0xc2 };
    }
    i += 2 + tam;
  }
  return null;
}

function deBase64(texto, nome) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(texto || ''));
  if (!m) throw new HttpErro(400, `Imagem ${nome} inválida.`);
  const b = Buffer.from(m[2], 'base64');
  if (!b.length || b.length > MAX_BYTES) throw new HttpErro(400, 'Imagem grande demais: use um logotipo menor.');
  return b;
}

class Logotipos {
  constructor(banco) {
    this.banco = banco;
    this.cache = new Map(); // empresa_id → { png, jpg, largura, altura, em } | null
  }

  async de(empresaId) {
    if (!empresaId) return null;
    if (this.cache.has(empresaId)) return this.cache.get(empresaId);
    const r = await this.banco.um('SELECT png, jpg, largura, altura, atualizado_em FROM empresas_logo WHERE empresa_id = ?', [empresaId]);
    const v = r ? { png: r.png, jpg: r.jpg, largura: r.largura, altura: r.altura, em: r.atualizado_em } : null;
    this.cache.set(empresaId, v);
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  /** Para o PDF: { jpeg, largura, altura } (ou null). */
  async paraPdf(empresaId) {
    const l = await this.de(empresaId);
    return l ? { jpeg: l.jpg, largura: l.largura, altura: l.altura } : null;
  }

  async salvar(empresaId, { png, jpg }, usuarioId) {
    const bp = deBase64(png, 'PNG');
    const bj = deBase64(jpg, 'JPEG');
    const mp = medidasPng(bp);
    const mj = medidasJpeg(bj);
    if (!mp) throw new HttpErro(400, 'A imagem PNG do logotipo está corrompida.');
    if (!mj || mj.componentes !== 3) throw new HttpErro(400, 'A imagem JPEG do logotipo está corrompida.');
    if (mp.largura > MAX_LADO || mp.altura > MAX_LADO || mj.largura > MAX_LADO || mj.altura > MAX_LADO) throw new HttpErro(400, 'Logotipo grande demais (no máximo 1200 pixels de lado).');
    if (mj.largura < 16 || mj.altura < 8) throw new HttpErro(400, 'Logotipo pequeno demais.');
    await this.banco.query(
      `INSERT INTO empresas_logo (empresa_id, png, jpg, largura, altura, atualizado_por) VALUES (?) AS n
       ON DUPLICATE KEY UPDATE png = n.png, jpg = n.jpg, largura = n.largura, altura = n.altura, atualizado_por = n.atualizado_por`,
      [[empresaId, bp, bj, mj.largura, mj.altura, usuarioId]],
    );
    this.cache.delete(empresaId);
    return { largura: mj.largura, altura: mj.altura };
  }

  async remover(empresaId) {
    await this.banco.query('DELETE FROM empresas_logo WHERE empresa_id = ?', [empresaId]);
    this.cache.delete(empresaId);
  }
}

module.exports = { Logotipos, medidasPng, medidasJpeg };
