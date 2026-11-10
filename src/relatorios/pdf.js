'use strict';
/**
 * FrotaGest — gerador de PDF de relatórios em tabela, sem biblioteca externa.
 * A4 deitado, cabeçalho com a marca do FrotaGest em todas as páginas, quadros de resumo na
 * primeira, tabela com linhas zebradas (o cabeçalho da tabela se repete a cada página) e
 * rodapé com "Página X de Y". Usa as fontes padrão do PDF (Helvetica), que todo leitor tem.
 * Reis Tecnologia
 */
const zlib = require('zlib');
const { HELVETICA, HELVETICA_BOLD } = require('./metricas');

const L = 842; // A4 deitado, em pontos
const A = 595;
const M = 28;

const COR = {
  navy: [0x1A, 0x27, 0x44], amber: [0xF5, 0x9E, 0x0B], amberClaro: [0xFE, 0xF3, 0xC7], cinza: [0x5B, 0x64, 0x78],
  cinzaClaro: [0x8A, 0x93, 0xA6], linha: [0xE3, 0xE7, 0xEF], zebra: [0xF4, 0xF6, 0xFA], quadro: [0xF7, 0xF8, 0xFB], branco: [255, 255, 255], texto: [0x1F, 0x29, 0x37],
};

/* ---------- texto em WinAnsi (o que a Helvetica do PDF entende) ---------- */

const ESPECIAIS = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‹': 0x8B, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9B };
const TROCAS = { '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '\u2009': ' ', '\u202F': ' ' };

function winAnsi(s) {
  const out = [];
  for (const ch of String(s ?? '').replace(/[≥≤→←\u2009\u202F]/g, (c) => TROCAS[c])) {
    const c = ch.codePointAt(0);
    if (ESPECIAIS[ch]) out.push(ESPECIAIS[ch]);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (c === 9 || c === 10 || c === 13) out.push(32);
    else out.push(63); // ?
  }
  return out;
}

function largura(bytes, tam, negrito) {
  const t = negrito ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const b of bytes) w += b >= 32 ? t[b - 32] || 556 : 0;
  return (w * tam) / 1000;
}

/** Corta o texto com "…" para caber na largura. */
function caber(texto, max, tam, negrito) {
  let b = winAnsi(texto);
  if (largura(b, tam, negrito) <= max) return b;
  const reticencias = largura([0x85], tam, negrito);
  while (b.length && largura(b, tam, negrito) + reticencias > max) b = b.slice(0, -1);
  return [...b, 0x85];
}

function literal(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

const n2 = (v) => (Math.round(v * 100) / 100).toString();
const cor = (c, fundo) => `${c.map((x) => n2(x / 255)).join(' ')} ${fundo ? 'rg' : 'RG'}`;

/* ---------- uma página ---------- */

class Pagina {
  constructor() { this.ops = []; }

  texto(x, y, txt, { tam = 8, negrito = false, c = COR.texto, alinhar = 'e', max = null } = {}) {
    const b = max ? caber(txt, max, tam, negrito) : winAnsi(txt);
    const w = largura(b, tam, negrito);
    const px = alinhar === 'd' ? x - w : alinhar === 'c' ? x - w / 2 : x;
    this.ops.push(`BT ${cor(c, true)} /${negrito ? 'F2' : 'F1'} ${n2(tam)} Tf ${n2(px)} ${n2(y)} Td ${literal(b)} Tj ET`);
  }

  retangulo(x, y, w, h, c) { this.ops.push(`${cor(c, true)} ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`); }

  linha(x1, y1, x2, y2, c, esp = 0.6) { this.ops.push(`${cor(c)} ${n2(esp)} w ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`); }

  arredondado(x, y, w, h, r, c, contorno = null) {
    const k = r * 0.5523;
    this.ops.push(`${cor(c, true)}${contorno ? ` ${cor(contorno)} 0.6 w` : ''} ${n2(x + r)} ${n2(y)} m ${n2(x + w - r)} ${n2(y)} l ${n2(x + w - r + k)} ${n2(y)} ${n2(x + w)} ${n2(y + r - k)} ${n2(x + w)} ${n2(y + r)} c `
      + `${n2(x + w)} ${n2(y + h - r)} l ${n2(x + w)} ${n2(y + h - r + k)} ${n2(x + w - r + k)} ${n2(y + h)} ${n2(x + w - r)} ${n2(y + h)} c `
      + `${n2(x + r)} ${n2(y + h)} l ${n2(x + r - k)} ${n2(y + h)} ${n2(x)} ${n2(y + h - r + k)} ${n2(x)} ${n2(y + h - r)} c `
      + `${n2(x)} ${n2(y + r)} l ${n2(x)} ${n2(y + r - k)} ${n2(x + r - k)} ${n2(y)} ${n2(x + r)} ${n2(y)} c ${contorno ? 'B' : 'f'}`);
  }

  /** Imagem (o logotipo da empresa cliente) já registrada como /Im1. */
  imagem(x, y, w, h) { this.ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(y)} cm /Im1 Do Q`); }

  circulo(cx, cy, r, c) {
    const k = r * 0.5523;
    this.ops.push(`${cor(c, true)} ${n2(cx + r)} ${n2(cy)} m ${n2(cx + r)} ${n2(cy + k)} ${n2(cx + k)} ${n2(cy + r)} ${n2(cx)} ${n2(cy + r)} c `
      + `${n2(cx - k)} ${n2(cy + r)} ${n2(cx - r)} ${n2(cy + k)} ${n2(cx - r)} ${n2(cy)} c ${n2(cx - r)} ${n2(cy - k)} ${n2(cx - k)} ${n2(cy - r)} ${n2(cx)} ${n2(cy - r)} c `
      + `${n2(cx + k)} ${n2(cy - r)} ${n2(cx + r)} ${n2(cy - k)} ${n2(cx + r)} ${n2(cy)} c f`);
  }

  /** Marca do FrotaGest: ônibus azul-marinho num quadrado âmbar. */
  marca(x, y, t) {
    this.arredondado(x, y, t, t, t * 0.26, COR.amber);
    const u = t / 30;
    this.arredondado(x + 5 * u, y + 9 * u, 20 * u, 13 * u, 2.4 * u, COR.navy);
    this.retangulo(x + 7.2 * u, y + 15.5 * u, 4.4 * u, 4.2 * u, COR.amber);
    this.retangulo(x + 12.8 * u, y + 15.5 * u, 4.4 * u, 4.2 * u, COR.amber);
    this.retangulo(x + 18.4 * u, y + 15.5 * u, 4.4 * u, 4.2 * u, COR.amber);
    this.circulo(x + 10 * u, y + 8.6 * u, 2.6 * u, COR.navy);
    this.circulo(x + 20 * u, y + 8.6 * u, 2.6 * u, COR.navy);
    this.circulo(x + 10 * u, y + 8.6 * u, 1.1 * u, COR.amber);
    this.circulo(x + 20 * u, y + 8.6 * u, 1.1 * u, COR.amber);
  }
}

/* ---------- documento ---------- */

/**
 * rel: { titulo, subtitulo: [linhas], resumo: [{ rotulo, valor }], colunas: [{ titulo, peso, alinhar: 'e'|'d'|'c' }],
 *        linhas: [[textos]], totais: [textos] | null, rodape: 'texto', vazio: 'texto',
 *        logo: { jpeg: Buffer, largura, altura } (logotipo da empresa cliente, opcional) }
 * Os valores já chegam formatados (texto).
 */
function gerarPdf(rel) {
  const paginas = [];
  const larguraUtil = L - 2 * M;
  const pesos = rel.colunas.map((c) => c.peso || 1);
  const soma = pesos.reduce((a, b) => a + b, 0);
  const larg = pesos.map((p) => (larguraUtil * p) / soma);
  const xs = larg.map((_, i) => M + larg.slice(0, i).reduce((a, b) => a + b, 0));
  const PAD = 4;
  const TAM = 7.4;
  const ALT_LINHA = 14;
  const ALT_CAB = 18;
  const LIMITE = M + 24; // acima do rodapé

  // logotipo da empresa cliente ao lado da marca do FrotaGest (até 34 pt de altura e 150 de largura)
  let logo = null;
  if (rel.logo && rel.logo.jpeg && rel.logo.largura && rel.logo.altura) {
    const esc = Math.min(34 / rel.logo.altura, 150 / rel.logo.largura);
    logo = { ...rel.logo, w: rel.logo.largura * esc, h: rel.logo.altura * esc };
  }
  const espacoMarca = 200 + (logo ? logo.w + 22 : 0);

  const cabecalho = (p) => {
    p.marca(M, A - M - 30, 30);
    p.texto(M + 38, A - M - 13, 'FrotaGest', { tam: 15, negrito: true, c: COR.navy });
    p.texto(M + 38, A - M - 25, 'Reis Tecnologia', { tam: 8, c: COR.cinza });
    if (logo) {
      const x = M + 142;
      p.linha(x, A - M - 32, x, A - M + 2, COR.linha, 0.8);
      p.imagem(x + 12, A - M - 15 - logo.h / 2, logo.w, logo.h);
    }
    p.texto(L - M, A - M - 12, rel.titulo, { tam: 13, negrito: true, c: COR.navy, alinhar: 'd', max: larguraUtil - espacoMarca });
    let y = A - M - 24;
    for (const s of (rel.subtitulo || []).slice(0, 3)) {
      p.texto(L - M, y, s, { tam: 8, c: COR.cinza, alinhar: 'd', max: larguraUtil - espacoMarca });
      y -= 10.5;
    }
    const base = Math.min(A - M - 40, y - 2);
    p.linha(M, base, L - M, base, COR.amber, 1.2);
    return base - 12;
  };

  const cabTabela = (p, y) => {
    p.retangulo(M, y - ALT_CAB, larguraUtil, ALT_CAB, COR.navy);
    rel.colunas.forEach((c, i) => {
      const al = c.alinhar || 'e';
      const x = al === 'd' ? xs[i] + larg[i] - PAD : al === 'c' ? xs[i] + larg[i] / 2 : xs[i] + PAD;
      p.texto(x, y - ALT_CAB + 6, c.titulo, { tam: TAM, negrito: true, c: COR.branco, alinhar: al, max: larg[i] - 2 * PAD });
    });
    return y - ALT_CAB;
  };

  const linhaTabela = (p, y, valores, { zebra = false, total = false } = {}) => {
    if (total) p.retangulo(M, y - ALT_LINHA, larguraUtil, ALT_LINHA, COR.amberClaro);
    else if (zebra) p.retangulo(M, y - ALT_LINHA, larguraUtil, ALT_LINHA, COR.zebra);
    rel.colunas.forEach((c, i) => {
      const v = valores[i];
      if (v === null || v === undefined || v === '') return;
      const al = c.alinhar || 'e';
      const x = al === 'd' ? xs[i] + larg[i] - PAD : al === 'c' ? xs[i] + larg[i] / 2 : xs[i] + PAD;
      p.texto(x, y - ALT_LINHA + 4.6, v, { tam: TAM, negrito: total, c: COR.texto, alinhar: al, max: larg[i] - 2 * PAD });
    });
    if (total) p.linha(M, y, L - M, y, COR.amber, 0.8);
    return y - ALT_LINHA;
  };

  let p = new Pagina();
  paginas.push(p);
  let y = cabecalho(p);

  // quadros de resumo (só na primeira página)
  const resumo = (rel.resumo || []).slice(0, 7);
  if (resumo.length) {
    const gap = 8;
    const w = (larguraUtil - gap * (resumo.length - 1)) / resumo.length;
    resumo.forEach((q, i) => {
      const x = M + i * (w + gap);
      p.arredondado(x, y - 38, w, 38, 6, COR.quadro, COR.linha);
      p.texto(x + 9, y - 13, String(q.rotulo).toUpperCase(), { tam: 6.6, negrito: true, c: COR.cinzaClaro, max: w - 18 });
      p.texto(x + 9, y - 29, q.valor, { tam: 12.5, negrito: true, c: COR.navy, max: w - 18 });
    });
    y -= 52;
  }

  if (!rel.linhas.length) {
    y = cabTabela(p, y);
    p.texto(L / 2, y - 26, rel.vazio || 'Nenhum registro no período escolhido.', { tam: 9, c: COR.cinza, alinhar: 'c' });
  } else {
    y = cabTabela(p, y);
    rel.linhas.forEach((lin, k) => {
      if (y - ALT_LINHA < LIMITE) {
        p = new Pagina();
        paginas.push(p);
        y = cabTabela(p, cabecalho(p));
      }
      y = linhaTabela(p, y, lin, { zebra: k % 2 === 1 });
    });
    if (rel.totais) {
      if (y - ALT_LINHA < LIMITE) {
        p = new Pagina();
        paginas.push(p);
        y = cabTabela(p, cabecalho(p));
      }
      y = linhaTabela(p, y, rel.totais, { total: true });
    }
  }
  if (rel.observacao && y - 20 > LIMITE) p.texto(M, y - 14, rel.observacao, { tam: 7, c: COR.cinza, max: larguraUtil });

  // rodapé com o total de páginas
  paginas.forEach((pg, i) => {
    pg.linha(M, M + 12, L - M, M + 12, COR.linha, 0.6);
    pg.texto(M, M + 2, rel.rodape || 'FrotaGest · Reis Tecnologia', { tam: 7, c: COR.cinzaClaro, max: larguraUtil - 90 });
    pg.texto(L - M, M + 2, `Página ${i + 1} de ${paginas.length}`, { tam: 7, c: COR.cinzaClaro, alinhar: 'd' });
  });

  // objetos do PDF
  const objs = [];
  const add = (corpo) => { objs.push(corpo); return objs.length; };
  const catalogo = add(null);
  const raiz = add(null);
  const f1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const f2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  // o JPEG entra como está (DCTDecode): uma vez só no arquivo, usado por todas as páginas
  const im = logo ? add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${logo.largura} /Height ${logo.altura} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.jpeg.length} >>\nstream\n`),
    logo.jpeg, Buffer.from('\nendstream')])) : null;
  const recursos = `/Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${im ? ` /XObject << /Im1 ${im} 0 R >>` : ''}`;
  const kids = [];
  for (const pg of paginas) {
    const dados = zlib.deflateSync(Buffer.from(pg.ops.join('\n'), 'latin1'));
    const conteudo = add(Buffer.concat([Buffer.from(`<< /Length ${dados.length} /Filter /FlateDecode >>\nstream\n`), dados, Buffer.from('\nendstream')]));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${raiz} 0 R /MediaBox [0 0 ${L} ${A}] /Resources << ${recursos} >> /Contents ${conteudo} 0 R >>`)));
  }
  objs[catalogo - 1] = Buffer.from(`<< /Type /Catalog /Pages ${raiz} 0 R >>`);
  objs[raiz - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const info = add(Buffer.from(`<< /Title ${literal(winAnsi(rel.titulo))} /Producer (FrotaGest - Reis Tecnologia) /Creator (FrotaGest) >>`));

  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = partes[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    partes.push(b);
    pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  partes.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(partes);
}

module.exports = { gerarPdf, winAnsi, largura };
