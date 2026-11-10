'use strict';
/**
 * FrotaGest — QR Code (ISO/IEC 18004) gerado no próprio servidor, sem biblioteca externa: modo byte,
 * correção de erro nível M, versões 1 a 20. Usado para o celular ler a chave da verificação em duas
 * etapas. Sai como SVG (desenhado na tela, nada vai para fora).
 * Reis Tecnologia
 */

// nível M: [códigos de correção por bloco, [qtde de blocos, dados por bloco], [qtde, dados] (grupo 2)]
const BLOCOS_M = [null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]],
  [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]], [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]],
  [22, [8, 37], [1, 38]], [24, [4, 40], [5, 41]], [24, [5, 41], [5, 42]], [28, [7, 45], [3, 46]], [28, [10, 46], [1, 47]],
  [26, [9, 43], [4, 44]], [26, [3, 44], [11, 45]], [26, [3, 41], [13, 42]],
];
const ALINHAMENTO = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90]];

/* ---------- Reed-Solomon em GF(256), polinômio 0x11D ---------- */

function mult(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(grau) {
  const r = Array(grau - 1).fill(0).concat([1]);
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mult(r[j], raiz);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    raiz = mult(raiz, 2);
  }
  return r;
}

function resto(dados, div) {
  const r = div.map(() => 0);
  for (const b of dados) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= mult(c, f); });
  }
  return r;
}

/* ---------- montagem ---------- */

const capacidade = (v) => {
  const [, g1, g2] = BLOCOS_M[v];
  return g1[0] * g1[1] + (g2 ? g2[0] * g2[1] : 0);
};

/** Bits dos dados (modo byte) já com terminador e preenchimento. */
function codewords(bytes, v) {
  const bits = [];
  const por = (valor, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >>> i) & 1); };
  por(0b0100, 4);
  por(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) por(b, 8);
  const total = capacidade(v) * 8;
  por(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let p = 0xec; bits.length < total; p ^= 0xec ^ 0x11) por(p, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Divide em blocos, calcula a correção e intercala (como o leitor espera). */
function intercalar(dados, v) {
  const [ec, g1, g2] = BLOCOS_M[v];
  const blocos = [];
  let k = 0;
  for (const [qtde, tam] of [g1, g2].filter(Boolean)) {
    for (let i = 0; i < qtde; i++) { blocos.push(dados.slice(k, k + tam)); k += tam; }
  }
  const div = divisor(ec);
  const correcoes = blocos.map((b) => resto(b, div));
  const out = [];
  const maior = Math.max(...blocos.map((b) => b.length));
  for (let i = 0; i < maior; i++) for (const b of blocos) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const c of correcoes) out.push(c[i]);
  return out;
}

class Matriz {
  constructor(v) {
    this.v = v;
    this.n = v * 4 + 17;
    this.m = Array.from({ length: this.n }, () => Array(this.n).fill(false));
    this.funcao = Array.from({ length: this.n }, () => Array(this.n).fill(false));
  }

  set(x, y, escuro) { this.m[y][x] = escuro; this.funcao[y][x] = true; }

  padroes() {
    const n = this.n;
    for (let i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALINHAMENTO[this.v];
    const ult = pos.length - 1;
    for (let i = 0; i <= ult; i++) {
      for (let j = 0; j <= ult; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === ult) || (i === ult && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.formato(0); // reserva o lugar (o valor certo entra depois da máscara)
    if (this.v >= 7) {
      let r = this.v;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const bits = (this.v << 12) | r;
      for (let i = 0; i < 18; i++) {
        const b = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3);
        const c = Math.floor(i / 3);
        this.set(a, c, b);
        this.set(c, a, b);
      }
    }
  }

  /** Nível M (00) + máscara, com o BCH e o XOR do padrão. */
  formato(mascara) {
    const n = this.n;
    const dados = (0 << 3) | mascara;
    let r = dados;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const bits = ((dados << 10) | r) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // módulo sempre escuro
  }

  /** Coloca os dados em zigue-zague, de baixo para cima, duas colunas por vez. */
  dados(cw) {
    const n = this.n;
    let i = 0;
    for (let dir = n - 1; dir >= 1; dir -= 2) {
      if (dir === 6) dir = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = dir - j;
          const subindo = ((dir + 1) & 2) === 0;
          const y = subindo ? n - 1 - vert : vert;
          if (!this.funcao[y][x] && i < cw.length * 8) {
            this.m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  mascarar(k) {
    const f = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ][k];
    for (let y = 0; y < this.n; y++) for (let x = 0; x < this.n; x++) if (!this.funcao[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x];
  }

  /** Penalidade da norma (blocos e linhas iguais, padrões parecidos com o localizador, equilíbrio). */
  penalidade() {
    const n = this.n;
    const m = this.m;
    let p = 0;
    const linha = (get) => {
      for (let a = 0; a < n; a++) {
        let cor = get(a, 0);
        let run = 1;
        for (let b = 1; b < n; b++) {
          const c = get(a, b);
          if (c === cor) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { cor = c; run = 1; }
        }
        // padrão parecido com o localizador (1:1:3:1:1 com 4 claros de um lado), contando a margem branca
        const s = `0000${Array.from({ length: n }, (_, b) => (get(a, b) ? 1 : 0)).join('')}0000`;
        for (const pad of ['10111010000', '00001011101']) {
          for (let k = s.indexOf(pad); k >= 0; k = s.indexOf(pad, k + 1)) p += 40;
        }
      }
    };
    linha((a, b) => m[a][b]);
    linha((a, b) => m[b][a]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    const escuros = m.reduce((t, r) => t + r.filter(Boolean).length, 0);
    p += Math.floor(Math.abs(escuros * 20 - n * n * 10) / (n * n)) * 10;
    return p;
  }
}

/** Matriz de módulos (true = escuro) para o texto. */
function gerar(texto) {
  const bytes = [...Buffer.from(String(texto), 'utf8')];
  let v = 1;
  while (v <= 20 && 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 > capacidade(v) * 8) v++;
  if (v > 20) throw new Error('texto grande demais para o QR Code');
  const cw = intercalar(codewords(bytes, v), v);
  let melhor = null;
  for (let k = 0; k < 8; k++) {
    const q = new Matriz(v);
    q.padroes();
    q.dados(cw);
    q.mascarar(k);
    q.formato(k);
    const pen = q.penalidade();
    if (!melhor || pen < melhor.pen) melhor = { q, pen };
  }
  return melhor.q.m;
}

/** SVG do QR Code (com a margem branca de 4 módulos que os leitores precisam). */
function svg(texto, { cor = '#0F172A', fundo = '#FFFFFF' } = {}) {
  const m = gerar(texto);
  const n = m.length;
  const t = n + 8;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      let w = 1;
      while (x + w < n && m[y][x + w]) w++;
      d += `M${x + 4} ${y + 4}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${t}" height="${t}" fill="${fundo}"/><path d="${d}" fill="${cor}"/></svg>`;
}

module.exports = { gerar, svg };
