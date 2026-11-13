'use strict';
/**
 * FrotaGest — dossiê da ocorrência em PDF (A4 em pé): dados do caso, descrição, trajeto desenhado,
 * alertas do período, fotos, lista das provas com o SHA-256 de cada arquivo (quem recebe confere que
 * nada foi alterado), andamento e conclusão. Usa o mesmo gerador sem biblioteca dos relatórios.
 * Reis Tecnologia
 */
const { montarPdf, Pagina, COR, winAnsi, largura, caber } = require('./pdf');

const W = 595; // A4 em pé, em pontos
const H = 842;
const M = 36;
const UTIL = W - 2 * M;
const LIMITE = M + 26; // acima do rodapé
const VERMELHO = [0xDC, 0x26, 0x26];
const VERDE = [0x16, 0xA3, 0x4A];
const n2 = (v) => (Math.round(v * 100) / 100).toString();

/** Quebra o texto em linhas que cabem na largura (respeita as quebras de linha do texto). */
function quebrar(texto, max, tam, negrito = false) {
  const out = [];
  for (const par of String(texto ?? '').replace(/\r/g, '').split('\n')) {
    const palavras = par.split(/\s+/).filter(Boolean);
    if (!palavras.length) { out.push(''); continue; }
    let linha = '';
    for (let p of palavras) {
      // palavra maior que a linha (link, código): corta em pedaços
      while (largura(winAnsi(p), tam, negrito) > max) {
        let n = p.length;
        while (n > 1 && largura(winAnsi(p.slice(0, n)), tam, negrito) > max) n--;
        if (linha) { out.push(linha); linha = ''; }
        out.push(p.slice(0, n));
        p = p.slice(n);
      }
      const t = linha ? `${linha} ${p}` : p;
      if (largura(winAnsi(t), tam, negrito) <= max) linha = t;
      else { out.push(linha); linha = p; }
    }
    out.push(linha);
  }
  return out;
}

/** Orientação da foto gravada pelo celular (EXIF): 1 normal, 3 de cabeça para baixo, 6 e 8 de lado. */
function orientacaoJpeg(b) {
  try {
    let i = 2;
    while (i + 4 < b.length && b[i] === 0xff) {
      const m = b[i + 1];
      const tam = b.readUInt16BE(i + 2);
      if (m === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10;
        const le = b.toString('latin1', t, t + 2) === 'II';
        const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
        const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
        return 1;
      }
      if (m === 0xda) break;
      i += 2 + tam;
    }
  } catch { /* EXIF estragado: como está */ }
  return 1;
}

class Dossie {
  constructor(d) {
    this.d = d;
    this.paginas = [];
    this.imagens = [];
    if (d.logo && d.logo.jpeg) {
      const esc = Math.min(30 / d.logo.altura, 120 / d.logo.largura);
      this.logo = { w: d.logo.largura * esc, h: d.logo.altura * esc };
      this.imagens.push({ nome: 'Im1', jpeg: d.logo.jpeg, largura: d.logo.largura, altura: d.logo.altura });
    }
    this.nova();
  }

  nova() {
    this.p = new Pagina();
    this.paginas.push(this.p);
    const p = this.p;
    p.marca(M, H - M - 28, 28);
    p.texto(M + 36, H - M - 12, 'FrotaGest', { tam: 14, negrito: true, c: COR.navy });
    p.texto(M + 36, H - M - 23, 'Reis Tecnologia', { tam: 7.5, c: COR.cinza });
    if (this.logo) {
      const x = M + 124;
      p.linha(x, H - M - 30, x, H - M + 1, COR.linha, 0.8);
      p.imagem(x + 10, H - M - 14 - this.logo.h / 2, this.logo.w, this.logo.h, 'Im1');
    }
    p.texto(W - M, H - M - 11, 'Dossiê da ocorrência', { tam: 13, negrito: true, c: COR.navy, alinhar: 'd' });
    p.texto(W - M, H - M - 23, `Nº ${this.d.numero} · ${this.d.situacao}`, { tam: 8.5, c: COR.cinza, alinhar: 'd' });
    p.linha(M, H - M - 36, W - M, H - M - 36, COR.amber, 1.2);
    this.y = H - M - 50;
  }

  precisa(h) { if (this.y - h < LIMITE) this.nova(); }

  secao(titulo) {
    this.precisa(40);
    this.y -= 6;
    this.p.texto(M, this.y - 10, titulo, { tam: 10.5, negrito: true, c: COR.navy });
    this.p.linha(M, this.y - 15, M + 26, this.y - 15, COR.amber, 1.6);
    this.y -= 24;
  }

  paragrafo(texto, { tam = 9, c = COR.texto, negrito = false, recuo = 0 } = {}) {
    for (const l of quebrar(texto, UTIL - recuo, tam, negrito)) {
      this.precisa(tam + 4);
      if (l) this.p.texto(M + recuo, this.y - tam, l, { tam, c, negrito });
      this.y -= tam + 3.4;
    }
    this.y -= 3;
  }

  /** Pares rótulo/valor em colunas. */
  campos(lista, colunas = 2) {
    const gap = 16;
    const cw = (UTIL - gap * (colunas - 1)) / colunas;
    for (let i = 0; i < lista.length; i += colunas) {
      const linha = lista.slice(i, i + colunas).map(([r, v]) => [r, quebrar(v || '—', cw, 9)]);
      const alt = 12 + Math.max(...linha.map(([, ls]) => ls.length)) * 11.5 + 6;
      this.precisa(alt);
      linha.forEach(([r, ls], k) => {
        const x = M + k * (cw + gap);
        this.p.texto(x, this.y - 7, String(r).toUpperCase(), { tam: 6.4, negrito: true, c: COR.cinzaClaro, max: cw });
        ls.forEach((l, j) => this.p.texto(x, this.y - 18 - j * 11.5, l, { tam: 9, c: COR.texto }));
      });
      this.y -= alt;
    }
  }

  quadros(lista) {
    this.precisa(46);
    const gap = 8;
    const w = (UTIL - gap * (lista.length - 1)) / lista.length;
    lista.forEach(([r, v, destaque], i) => {
      const x = M + i * (w + gap);
      this.p.arredondado(x, this.y - 38, w, 38, 6, COR.quadro, COR.linha);
      this.p.texto(x + 9, this.y - 13, String(r).toUpperCase(), { tam: 6.4, negrito: true, c: COR.cinzaClaro, max: w - 18 });
      this.p.texto(x + 9, this.y - 29, v, { tam: 11, negrito: true, c: destaque || COR.navy, max: w - 18 });
    });
    this.y -= 50;
  }

  tabela(colunas, linhas, { tam = 7.6, vazio = 'Nenhum registro.' } = {}) {
    const soma = colunas.reduce((a, c) => a + (c.peso || 1), 0);
    const larg = colunas.map((c) => (UTIL * (c.peso || 1)) / soma);
    const xs = larg.map((_, i) => M + larg.slice(0, i).reduce((a, b) => a + b, 0));
    const cab = () => {
      this.p.retangulo(M, this.y - 16, UTIL, 16, COR.navy);
      colunas.forEach((c, i) => this.p.texto(xs[i] + 4, this.y - 11, c.titulo, { tam: 7, negrito: true, c: COR.branco, max: larg[i] - 8 }));
      this.y -= 16;
    };
    this.precisa(34);
    cab();
    if (!linhas.length) {
      this.p.texto(M + 4, this.y - 12, vazio, { tam: 8, c: COR.cinza });
      this.y -= 22;
      return;
    }
    linhas.forEach((lin, k) => {
      const alturas = lin.map((v, i) => (colunas[i].quebrar ? quebrar(v, larg[i] - 8, tam).length : 1));
      const alt = Math.max(...alturas) * (tam + 3.4) + 6;
      if (this.y - alt < LIMITE) { this.nova(); cab(); }
      if (k % 2) this.p.retangulo(M, this.y - alt, UTIL, alt, COR.zebra);
      lin.forEach((v, i) => {
        const c = colunas[i];
        if (v === null || v === undefined || v === '') return;
        if (c.quebrar) quebrar(v, larg[i] - 8, tam).forEach((l, j) => this.p.texto(xs[i] + 4, this.y - 3 - tam - j * (tam + 3.4), l, { tam, c: COR.texto }));
        else this.p.texto(xs[i] + 4, this.y - 3 - tam, v, { tam: c.tam || tam, c: COR.texto, max: larg[i] - 8, negrito: c.negrito });
      });
      this.y -= alt;
    });
    this.y -= 8;
  }

  /** Trajeto desenhado sobre um quadro (sem mapa de fundo), com escala e o ponto da ocorrência. */
  trajeto({ pontos, alvo, alertas = [], legenda }) {
    const alt = 250;
    this.precisa(alt + 30);
    const x0 = M;
    const y0 = this.y - alt;
    this.p.arredondado(x0, y0, UTIL, alt, 6, COR.quadro, COR.linha);
    const todos = [...pontos, ...(alvo ? [alvo] : []), ...alertas];
    if (!todos.length) {
      this.p.texto(W / 2, y0 + alt / 2, 'Sem posições do veículo no período.', { tam: 9, c: COR.cinza, alinhar: 'c' });
      this.y = y0 - 10;
      return;
    }
    const latM = todos.reduce((s, [la]) => s + la, 0) / todos.length;
    const kx = Math.cos((latM * Math.PI) / 180);
    const proj = ([la, lo]) => [lo * kx, la];
    const pr = todos.map(proj);
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of pr) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const minSpan = 0.0018; // ~200 m: um ponto só não vira um zoom infinito
    if (maxX - minX < minSpan) { const c = (maxX + minX) / 2; minX = c - minSpan / 2; maxX = c + minSpan / 2; }
    if (maxY - minY < minSpan) { const c = (maxY + minY) / 2; minY = c - minSpan / 2; maxY = c + minSpan / 2; }
    const pad = 18;
    const esc = Math.min((UTIL - 2 * pad) / (maxX - minX), (alt - 2 * pad) / (maxY - minY));
    const ox = x0 + (UTIL - (maxX - minX) * esc) / 2;
    const oy = y0 + (alt - (maxY - minY) * esc) / 2;
    const tela = (p) => { const [x, y] = proj(p); return [ox + (x - minX) * esc, oy + (y - minY) * esc]; };
    this.p.polilinha(pontos.map(tela), COR.navy, 1.6);
    if (pontos.length) {
      const [sx, sy] = tela(pontos[0]);
      this.p.circulo(sx, sy, 3.6, VERDE);
      const [ex, ey] = tela(pontos[pontos.length - 1]);
      this.p.circulo(ex, ey, 3.6, COR.cinza);
    }
    for (const a of alertas) { const [ax, ay] = tela(a); this.p.circulo(ax, ay, 3, COR.amber); }
    if (alvo) {
      const [tx, ty] = tela(alvo);
      this.p.circulo(tx, ty, 6.5, COR.branco);
      this.p.circulo(tx, ty, 5, VERMELHO);
    }
    // escala: 1 grau de latitude ≈ 111.320 m
    const mPorPt = 111320 / esc;
    const alvoPt = 90;
    const bruto = mPorPt * alvoPt;
    const passos = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    const m = passos.find((v) => v >= bruto * 0.6) || passos[passos.length - 1];
    const comp = m / mPorPt;
    const bx = x0 + UTIL - 14 - comp;
    this.p.linha(bx, y0 + 12, bx + comp, y0 + 12, COR.texto, 1.2);
    this.p.linha(bx, y0 + 9, bx, y0 + 15, COR.texto, 1.2);
    this.p.linha(bx + comp, y0 + 9, bx + comp, y0 + 15, COR.texto, 1.2);
    this.p.texto(bx + comp / 2, y0 + 18, m >= 1000 ? `${m / 1000} km` : `${m} m`, { tam: 7, c: COR.texto, alinhar: 'c' });
    // norte para cima
    this.p.linha(x0 + 16, y0 + alt - 30, x0 + 16, y0 + alt - 14, COR.cinza, 1);
    this.p.polilinha([[x0 + 12.5, y0 + alt - 18], [x0 + 16, y0 + alt - 13], [x0 + 19.5, y0 + alt - 18]], COR.cinza, 1);
    this.p.texto(x0 + 22, y0 + alt - 26, 'N', { tam: 8, negrito: true, c: COR.cinza });
    this.y = y0 - 6;
    // legenda
    let lx = M;
    const item = (c, t) => {
      this.p.circulo(lx + 4, this.y - 6, 3.4, c);
      this.p.texto(lx + 11, this.y - 8.5, t, { tam: 7.4, c: COR.cinza });
      lx += 18 + largura(winAnsi(t), 7.4);
    };
    item(VERMELHO, 'Local da ocorrência');
    item(VERDE, 'Início do trajeto');
    item(COR.cinza, 'Fim do trajeto');
    if (alertas.length) item(COR.amber, 'Alertas');
    this.y -= 16;
    if (legenda) this.paragrafo(legenda, { tam: 7.6, c: COR.cinza });
  }

  /** Fotos em grade (2 por linha), cada uma com a legenda. */
  fotos(lista) {
    const gap = 14;
    const cw = (UTIL - gap) / 2;
    const maxH = 175;
    for (let i = 0; i < lista.length; i += 2) {
      const par = lista.slice(i, i + 2).map((f) => {
        const lado = f.orientacao === 6 || f.orientacao === 8;
        const [iw, ih] = lado ? [f.altura, f.largura] : [f.largura, f.altura];
        const esc = Math.min(cw / iw, maxH / ih);
        return { ...f, w: iw * esc, h: ih * esc };
      });
      const alt = Math.max(...par.map((f) => f.h)) + 26;
      this.precisa(alt);
      par.forEach((f, k) => {
        const nome = `Im${this.imagens.length + 1}`;
        this.imagens.push({ nome, jpeg: f.jpeg, largura: f.largura, altura: f.altura, cinza: f.componentes === 1 });
        const cx = M + k * (cw + gap);
        const x = cx + (cw - f.w) / 2;
        const y = this.y - f.h;
        const o = f.orientacao;
        // celular de lado (EXIF): gira a imagem na hora de desenhar
        if (o === 6) this.p.ops.push(`q 0 ${n2(-f.h)} ${n2(f.w)} 0 ${n2(x)} ${n2(y + f.h)} cm /${nome} Do Q`);
        else if (o === 8) this.p.ops.push(`q 0 ${n2(f.h)} ${n2(-f.w)} 0 ${n2(x + f.w)} ${n2(y)} cm /${nome} Do Q`);
        else if (o === 3) this.p.ops.push(`q ${n2(-f.w)} 0 0 ${n2(-f.h)} ${n2(x + f.w)} ${n2(y + f.h)} cm /${nome} Do Q`);
        else this.p.imagem(x, y, f.w, f.h, nome);
        this.p.moldura(x, y, f.w, f.h, COR.linha, 0.5);
        this.p.texto(cx, this.y - f.h - 11, f.legenda, { tam: 7.4, c: COR.cinza, max: cw });
      });
      this.y -= alt;
    }
  }

  pdf(rodape) {
    this.paginas.forEach((pg, i) => {
      pg.linha(M, M + 12, W - M, M + 12, COR.linha, 0.6);
      pg.texto(M, M + 2, rodape, { tam: 6.8, c: COR.cinzaClaro, max: UTIL - 80 });
      pg.texto(W - M, M + 2, `Página ${i + 1} de ${this.paginas.length}`, { tam: 6.8, c: COR.cinzaClaro, alinhar: 'd' });
    });
    return montarPdf(this.paginas, { largura: W, altura: H, titulo: `Ocorrência ${this.d.numero}`, imagens: this.imagens });
  }
}

/**
 * d: { numero, titulo, situacao, quadros: [[rotulo, valor, cor?]], campos: [[rotulo, valor]], descricao,
 *      trajeto: { pontos, alvo, alertas, legenda } | null, alertas: [[...]], fotos: [{ jpeg, largura, altura,
 *      componentes, orientacao, legenda }], anexos: [[...]], eventos: [[...]], conclusao, logo, rodape }
 */
function gerarDossie(d) {
  const doc = new Dossie(d);
  doc.paragrafo(d.titulo, { tam: 14, negrito: true, c: COR.navy });
  doc.quadros(d.quadros);
  doc.secao('Dados da ocorrência');
  doc.campos(d.campos);
  if (d.descricao) {
    doc.secao('Descrição');
    doc.paragrafo(d.descricao);
  }
  if (d.trajeto) {
    doc.secao('Trajeto do veículo');
    doc.trajeto(d.trajeto);
  }
  doc.secao('Alertas do veículo no período');
  doc.tabela([{ titulo: 'Início', peso: 1.3 }, { titulo: 'Alerta', peso: 2.6 }, { titulo: 'Gravidade', peso: 0.9 }, { titulo: 'Velocidade', peso: 0.9 }, { titulo: 'Fim', peso: 1.3 }], d.alertas, { vazio: 'Nenhum alerta do veículo no período do trajeto.' });
  if (d.fotos.length) {
    doc.secao('Fotos');
    doc.fotos(d.fotos);
  }
  doc.secao('Provas anexadas');
  doc.tabela([
    { titulo: 'Tipo', peso: 0.8 }, { titulo: 'Arquivo', peso: 2.4, quebrar: true }, { titulo: 'Detalhe', peso: 1.9, quebrar: true }, { titulo: 'Tamanho', peso: 0.8 },
  ], d.anexos.map((a) => a.slice(0, 4)), { vazio: 'Nenhuma prova anexada.' });
  if (d.anexos.length) {
    doc.paragrafo('Conferência dos arquivos (SHA-256): calcule o SHA-256 do arquivo recebido e compare com o código abaixo. Se for igual, o arquivo é exatamente o que estava anexado à ocorrência.', { tam: 7.4, c: COR.cinza });
    for (const a of d.anexos) {
      doc.precisa(20);
      doc.p.texto(M, doc.y - 7.4, a[1], { tam: 7.4, negrito: true, c: COR.texto, max: UTIL });
      doc.p.texto(M, doc.y - 17, a[4], { tam: 7, c: COR.cinza, max: UTIL });
      doc.y -= 22;
    }
  }
  doc.secao('Andamento');
  doc.tabela([{ titulo: 'Quando', peso: 1.1 }, { titulo: 'Quem', peso: 1.2 }, { titulo: 'O que', peso: 4.2, quebrar: true }], d.eventos, { vazio: 'Sem andamento.' });
  if (d.conclusao) {
    doc.secao('Conclusão');
    doc.paragrafo(d.conclusao);
  }
  return doc.pdf(d.rodape);
}

module.exports = { gerarDossie, quebrar, orientacaoJpeg };
