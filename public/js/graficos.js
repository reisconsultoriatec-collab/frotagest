'use strict';
/* FrotaGest — gráficos do dashboard em SVG, sem biblioteca: colunas (simples ou empilhadas, com linha
 * de comparação), barra segmentada, lista com barras e minigráfico dos cartões. Todos com dica ao passar
 * o mouse ou ao navegar pelo teclado (setas). Textos sempre por textContent. Reis Tecnologia */

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, pai = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
  if (pai) pai.append(e);
  return e;
}

/** Escala com números redondos (0, 50, 100, 150…) e no máximo "partes" divisões. */
function escalaBonita(max, partes = 4) {
  if (!(max > 0)) return { max: 1, passo: 1 };
  const bruto = max / partes;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto) || 10 * pot;
  return { max: Math.ceil(max / passo) * passo, passo };
}

/** 1.284 / 12,9 mil / 1,2 mi */
function fmtCompacto(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `${fmtNum(v / 1e6, v >= 1e7 ? 0 : 1)} mi`;
  if (Math.abs(v) >= 1e4) return `${fmtNum(v / 1e3, v >= 1e5 ? 0 : 1)} mil`;
  return fmtNum(Math.round(v));
}

/* ---------- dica (uma só, para a página toda) ---------- */

const Dica = {
  el: null,
  mostrar(titulo, linhas, alvo) {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'gr-dica';
      this.el.setAttribute('role', 'status');
      document.body.append(this.el);
    }
    const d = this.el;
    d.replaceChildren();
    const t = document.createElement('div');
    t.className = 'gr-dica-tit';
    t.textContent = titulo;
    d.append(t);
    for (const l of linhas) {
      const row = document.createElement('div');
      row.className = 'gr-dica-l';
      const k = document.createElement('i');
      k.className = `gr-chave ${l.tipo === 'linha' ? 'linha' : ''}`;
      if (l.cor) k.style.background = l.cor; else k.style.visibility = 'hidden';
      const v = document.createElement('b');
      v.textContent = l.valor;
      const n = document.createElement('span');
      n.textContent = l.nome || '';
      row.append(k, v, n);
      d.append(row);
    }
    d.hidden = false;
    // perto do alvo (retângulo da barra ou ponto do mouse), sem sair da tela
    const r = alvo;
    const w = d.offsetWidth;
    const h = d.offsetHeight;
    let x = r.x + (r.w || 0) / 2 - w / 2;
    let y = r.y - h - 10;
    if (y < 8) y = r.y + (r.h || 0) + 10;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    d.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  },
  esconder() { if (this.el) this.el.hidden = true; },
};
window.addEventListener('scroll', () => Dica.esconder(), { passive: true });

/** Redesenha quando a largura do quadro muda (girar o celular, abrir o menu…). */
function aoRedimensionar(box, fn) {
  if (box._gr) box._gr.disconnect();
  let larg = box.clientWidth;
  let t = null;
  const ro = new ResizeObserver(() => {
    if (Math.abs(box.clientWidth - larg) < 4) return;
    larg = box.clientWidth;
    clearTimeout(t);
    t = setTimeout(fn, 80);
  });
  ro.observe(box);
  box._gr = ro;
}

/** Caminho de uma coluna com o topo arredondado (4px) e a base reta. */
function colunaPath(x, yTopo, w, yBase, raio = 4) {
  const h = yBase - yTopo;
  if (h <= 0) return '';
  const r = Math.min(raio, w / 2, h);
  return `M${x},${yBase}V${yTopo + r}Q${x},${yTopo} ${x + r},${yTopo}H${x + w - r}Q${x + w},${yTopo} ${x + w},${yTopo + r}V${yBase}Z`;
}

/**
 * Colunas. o = {
 *   rotulos: ['00h', …], rotulosLongos?: [...], series: [{ nome, cor, valores }] (2+ = empilhadas),
 *   comparacao?: { nome, cor, valores } (linha, mesma unidade), destaque?: índice, corDestaque?,
 *   formato?: v => texto, formatoEixo?, altura?, compacto? (sem eixos), rotularDestaque?,
 *   extra?: i => [{ nome, valor }], aoClicar?: i => {}, titulo: texto para leitor de tela
 * }
 */
function colunas(box, o) {
  const fmt = o.formato || ((v) => fmtNum(v));
  const desenhar = () => {
    box.replaceChildren();
    const W = Math.max(120, box.clientWidth);
    const H = o.altura || 200;
    const compacto = Boolean(o.compacto);
    const padL = compacto ? 0 : 40;
    const padR = compacto ? 0 : 6;
    const padT = compacto ? 2 : (o.rotularDestaque ? 20 : 10);
    const padB = compacto ? 0 : 24;
    const n = o.rotulos.length;
    const totais = o.rotulos.map((_, i) => o.series.reduce((s, se) => s + (Number(se.valores[i]) || 0), 0));
    const maxDados = Math.max(0, ...totais, ...(o.comparacao ? o.comparacao.valores.map((v) => Number(v) || 0) : [0]));
    const { max, passo } = escalaBonita(maxDados || 1, compacto ? 2 : 4);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const banda = plotW / n;
    const bw = Math.max(2, Math.min(compacto ? 10 : 24, banda * (compacto ? 0.7 : 0.62)));
    const yBase = padT + plotH;
    const y = (v) => yBase - (v / max) * plotH;
    const svg = svgEl('svg', { class: 'gr-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: '0', 'aria-label': o.titulo || '' });
    // grade e eixo
    if (!compacto) {
      for (let v = 0; v <= max + 1e-9; v += passo) {
        const yy = Math.round(y(v)) + 0.5;
        svgEl('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: v === 0 ? 'gr-base' : 'gr-grade' }, svg);
        const t = svgEl('text', { x: padL - 8, y: yy + 4, class: 'gr-eixo', 'text-anchor': 'end' }, svg);
        t.textContent = (o.formatoEixo || fmtCompacto)(v);
      }
      // rótulos espaçados para não encostar; o destacado (agora/hoje) sempre aparece e some o vizinho
      const cada = Math.max(1, Math.ceil(36 / banda));
      o.rotulos.forEach((r, i) => {
        const dest = i === o.destaque;
        if (!dest && (i % cada !== 0 || (o.destaque !== undefined && Math.abs(i - o.destaque) < cada))) return;
        const t = svgEl('text', { x: padL + banda * i + banda / 2, y: H - 6, class: `gr-eixo${i === o.destaque ? ' forte' : ''}`, 'text-anchor': 'middle' }, svg);
        t.textContent = r;
      });
    }
    // colunas
    const grupos = [];
    for (let i = 0; i < n; i++) {
      const g = svgEl('g', { class: 'gr-b' }, svg);
      const x = padL + banda * i + (banda - bw) / 2;
      let acum = 0;
      const vis = o.series.map((se, k) => ({ se, k, v: Number(se.valores[i]) || 0 })).filter((s) => s.v > 0);
      vis.forEach((s, idx) => {
        const topo = idx === vis.length - 1;
        const y0 = y(acum) - (idx > 0 ? 2 : 0); // 2px de folga entre as partes empilhadas
        acum += s.v;
        const y1 = Math.min(y(acum), y0 - 1);
        const cor = o.series.length === 1 && i === o.destaque && o.corDestaque ? o.corDestaque : s.se.cor;
        if (topo) svgEl('path', { d: colunaPath(x, y1, bw, y0), fill: cor }, g);
        else svgEl('rect', { x, y: y1, width: bw, height: Math.max(0, y0 - y1), fill: cor }, g);
      });
      // valor escrito só na coluna destacada e só se couber (senão fica na dica e na tabela)
      if (o.rotularDestaque && i === o.destaque && totais[i] > 0 && banda * 2.2 >= fmt(totais[i]).length * 6.5) {
        const t = svgEl('text', { x: x + bw / 2, y: y(totais[i]) - 6, class: 'gr-valor', 'text-anchor': 'middle' }, svg);
        t.textContent = fmt(totais[i]);
      }
      grupos.push(g);
    }
    // linha de comparação (ex.: ontem)
    if (o.comparacao) {
      const pts = o.comparacao.valores.map((v, i) => `${padL + banda * i + banda / 2},${y(Number(v) || 0)}`).join(' ');
      svgEl('polyline', { points: pts, class: 'gr-linha', stroke: o.comparacao.cor }, svg);
    }
    // áreas de toque (a coluna inteira, maior que a barra)
    const marca = svgEl('line', { class: 'gr-mira', y1: padT, y2: yBase, x1: 0, x2: 0, visibility: 'hidden' }, svg);
    let atual = -1;
    const mostrar = (i) => {
      if (i < 0 || i >= n) return;
      atual = i;
      svg.classList.add('com-foco');
      grupos.forEach((g, k) => g.classList.toggle('on', k === i));
      const cx = padL + banda * i + banda / 2;
      if (o.comparacao) { marca.setAttribute('x1', cx); marca.setAttribute('x2', cx); marca.setAttribute('visibility', 'visible'); }
      const r = svg.getBoundingClientRect();
      const topo = y(Math.max(totais[i], o.comparacao ? Number(o.comparacao.valores[i]) || 0 : 0));
      const linhas = o.series.map((se) => ({ nome: se.nome, valor: fmt(Number(se.valores[i]) || 0), cor: o.series.length === 1 && i === o.destaque && o.corDestaque ? o.corDestaque : se.cor }));
      if (o.series.length > 1) linhas.unshift({ nome: 'no total', valor: fmt(totais[i]) });
      if (o.comparacao) linhas.push({ nome: o.comparacao.nome, valor: fmt(Number(o.comparacao.valores[i]) || 0), cor: o.comparacao.cor, tipo: 'linha' });
      if (o.extra) linhas.push(...o.extra(i));
      Dica.mostrar((o.rotulosLongos || o.rotulos)[i], linhas, { x: r.left + cx - bw / 2, y: r.top + topo, w: bw, h: yBase - topo });
    };
    const limpar = () => { atual = -1; svg.classList.remove('com-foco'); grupos.forEach((g) => g.classList.remove('on')); marca.setAttribute('visibility', 'hidden'); Dica.esconder(); };
    for (let i = 0; i < n; i++) {
      const hit = svgEl('rect', { x: padL + banda * i, y: 0, width: banda, height: H, class: 'gr-hit' }, svg);
      hit.addEventListener('pointerenter', () => mostrar(i));
      hit.addEventListener('pointermove', () => { if (atual !== i) mostrar(i); });
      if (o.aoClicar) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => o.aoClicar(i)); }
    }
    svg.addEventListener('pointerleave', limpar);
    svg.addEventListener('blur', limpar);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        mostrar(atual < 0 ? (o.destaque ?? n - 1) : Math.max(0, Math.min(n - 1, atual + (e.key === 'ArrowRight' ? 1 : -1))));
      } else if (e.key === 'Enter' && o.aoClicar && atual >= 0) o.aoClicar(atual);
      else if (e.key === 'Escape') limpar();
    });
    box.append(svg);
  };
  desenhar();
  aoRedimensionar(box, desenhar);
}

/** Tabela com os mesmos números do gráfico (para ler sem passar o mouse, e para leitor de tela). */
function tabelaGrafico(o) {
  const fmt = o.formato || ((v) => fmtNum(v));
  const cols = [...o.series.map((s) => s.nome), ...(o.comparacao ? [o.comparacao.nome] : [])];
  const linhas = o.rotulos.map((r, i) => `<tr><th scope="row">${H((o.rotulosLongos || o.rotulos)[i])}</th>${o.series.map((s) => `<td>${H(fmt(Number(s.valores[i]) || 0))}</td>`).join('')}${o.comparacao ? `<td>${H(fmt(Number(o.comparacao.valores[i]) || 0))}</td>` : ''}</tr>`).join('');
  return `<div class="gr-tabela"><table class="tbl"><thead><tr><th>${H(o.rotuloEixoX || '')}</th>${cols.map((c) => `<th>${H(c)}</th>`).join('')}</tr></thead><tbody>${linhas}</tbody></table></div>`;
}

/**
 * Barra segmentada (um todo em partes, até 6). partes: [{ nome, valor, cor, tinta? ('#fff' | '#0b0b0b'), ir? }]
 * Desenha a barra e a legenda (nome, quantidade e %), clicável quando a parte tem "ir".
 */
function segmentada(box, partes, { aoClicar } = {}) {
  const total = partes.reduce((s, p) => s + p.valor, 0);
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  box.innerHTML = `<div class="gr-seg" role="img" aria-label="${H(partes.map((p) => `${p.nome}: ${p.valor}`).join(', '))}">
      ${partes.filter((p) => p.valor > 0).map((p) => `<div class="gr-seg-p" data-p="${H(p.nome)}" style="flex:${p.valor};background:${p.cor};color:${p.tinta || '#fff'}"><span>${pct(p.valor)}%</span></div>`).join('') || '<div class="gr-seg-vazio"></div>'}
    </div>
    <div class="gr-seg-leg">${partes.map((p, i) => `<button type="button" class="gr-seg-item" data-i="${i}" ${aoClicar && p.ir ? '' : 'disabled'}>
      <i style="background:${p.cor}"></i><span class="gr-seg-nome">${H(p.nome)}</span><b>${fmtNum(p.valor)}</b><small>${pct(p.valor)}%</small></button>`).join('')}</div>`;
  // rótulo dentro do bloco só quando cabe
  box.querySelectorAll('.gr-seg-p').forEach((b) => {
    const s = b.querySelector('span');
    if (s.offsetWidth + 14 > b.offsetWidth) s.hidden = true;
    b.addEventListener('pointerenter', () => {
      const p = partes.find((x) => x.nome === b.dataset.p);
      const r = b.getBoundingClientRect();
      Dica.mostrar(p.nome, [{ valor: fmtNum(p.valor), nome: `veículo${p.valor === 1 ? '' : 's'} · ${pct(p.valor)}%`, cor: p.cor }], { x: r.left, y: r.top, w: r.width, h: r.height });
    });
    b.addEventListener('pointerleave', () => Dica.esconder());
  });
  if (aoClicar) box.querySelectorAll('.gr-seg-item:not([disabled])').forEach((b) => b.addEventListener('click', () => aoClicar(partes[Number(b.dataset.i)])));
}

/**
 * Lista com barras (cada linha: nome, barra e número), ex.: tipos de alerta, ranking de km.
 * itens: [{ nome, sub?, valor, texto?, chave? }]; o: { cor, max?, aoClicar?, vazio }
 */
function listaBarras(box, itens, o = {}) {
  if (!itens.length) { box.innerHTML = `<div class="list-empty">${H(o.vazio || 'Nada por aqui.')}</div>`; return; }
  const max = o.max || Math.max(...itens.map((x) => x.valor), 1);
  box.innerHTML = `<div class="gr-lb">${itens.map((x, i) => `<${o.aoClicar ? 'button type="button"' : 'div'} class="gr-lb-l" data-i="${i}">
      <span class="gr-lb-nome"><b>${H(x.nome)}</b>${x.sub ? `<small>${H(x.sub)}</small>` : ''}</span>
      <span class="gr-lb-v">${H(x.texto ?? fmtNum(x.valor))}</span>
      <span class="gr-lb-trilho"><i style="width:${Math.max(x.valor > 0 ? 2 : 0, (x.valor / max) * 100)}%;background:${x.cor || o.cor}"></i></span>
    </${o.aoClicar ? 'button' : 'div'}>`).join('')}</div>`;
  if (o.aoClicar) box.querySelectorAll('.gr-lb-l').forEach((b) => b.addEventListener('click', () => o.aoClicar(itens[Number(b.dataset.i)])));
}

/** Número que "conta" até o valor na primeira vez (depois só troca). */
function contar(el, valor, formato = fmtNum) {
  if (!el) return;
  const alvo = Number(valor) || 0;
  const de = Number(el.dataset.v);
  el.dataset.v = alvo;
  // só anima números grandes, na primeira vez (contar de 0 a 3 não acrescenta nada)
  if (Number.isFinite(de) || window.matchMedia('(prefers-reduced-motion: reduce)').matches || alvo < 20) { el.textContent = formato(alvo); return; }
  const t0 = performance.now();
  const passo = (t) => {
    const k = Math.min(1, (t - t0) / 650);
    const e = 1 - (1 - k) ** 3;
    if (Number(el.dataset.v) !== alvo) return;
    el.textContent = formato(alvo * e);
    if (k < 1) requestAnimationFrame(passo); else el.textContent = formato(alvo);
  };
  requestAnimationFrame(passo);
}
