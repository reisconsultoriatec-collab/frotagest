'use strict';
/* FrotaGest — enfeites da tela de entrada: frase trazida por um ônibus que estaciona no fim, prévia do
 * painel, cidade com a estrada ao fundo, saudação e "Lembrar meu e-mail". Tudo aqui é decoração:
 * nada lê dados do servidor, e se alguma animação falhar o login continua funcionando.
 * No padrão do OdontoWorld e do CondoGest. Reis Tecnologia */

const reduzirMovimento = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const gateNaTela = () => { const g = document.getElementById('gate'); return !!(g && !g.hidden); };

/* ---------- frase trazida pelo ônibus ---------- */
// Um ônibus entra pela esquerda e percorre cada linha da frase; as letras vão aparecendo atrás dele
// (como se ele viesse trazendo o texto) e ele deixa o sublinhado âmbar em "em tempo real". Na última
// linha ele estaciona no fim da frase, acende os faróis e o sinal do 4G. A frase fica parada para
// leitura, o ônibus sai pela direita levando o texto e o ciclo recomeça. Só roda com o painel
// visível; no celular e com "reduzir movimento" tudo aparece pronto e parado.
const ENTRADA_FRASE = 'Sua frota monitorada em tempo real e sem complicações';
const ENTRADA_DESTAQUE = 'em tempo real';
const ENTRADA_TEMPO = { inicio: 500, velocidade: 0.6, parada: 9000, partida: 1000, apaga: 450, onda: 7, respiro: 700 };

// Ônibus de lado, virado para a direita (viewBox 96 x 60, rodas no chão em y = 54).
// "sufixo" separa os ids quando há mais de um ônibus na página.
function onibusSvg(sufixo = '', classe = '') {
  const id = (n) => `on-${n}${sufixo}`;
  const janelas = [13, 23, 33, 43, 53].map((x, i) => `<rect class="on-janela${i === 3 ? '' : ' acende'}" style="--j:${[2, 0, 3, 0, 1][i]}" x="${x}" y="16" width="8" height="12" rx="1"/>`).join('');
  const roda = (cx) => `<g class="on-roda"><circle cx="${cx}" cy="48" r="6" fill="#091330" stroke="rgba(125,211,252,.85)" stroke-width="1.2"/>`
    + `<g class="on-raios"><path d="M${cx - 3.6} 48H${cx + 3.6}M${cx - 1.8} 44.9L${cx + 1.8} 51.1M${cx + 1.8} 44.9L${cx - 1.8} 51.1" stroke="#94A3B8" stroke-width=".9" stroke-linecap="round"/></g>`
    + `<circle cx="${cx}" cy="48" r="1.6" fill="#E2E8F0"/></g>`;
  const corpo = 'M9 48V16.5Q9 11 14.5 11H73Q80.5 11 83.5 17.5L87.5 29V48Z';
  return `<svg class="onibus ${classe}" viewBox="0 0 96 60" aria-hidden="true"><defs>`
    + `<clipPath id="${id('recorte')}"><path d="${corpo}"/></clipPath>`
    + `<linearGradient id="${id('corpo')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D5AA0"/><stop offset="1" stop-color="#173461"/></linearGradient>`
    + `<linearGradient id="${id('feixe')}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FEF9C3" stop-opacity=".85"/><stop offset="1" stop-color="#FEF9C3" stop-opacity="0"/></linearGradient>`
    + `<linearGradient id="${id('luz')}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + '</defs>'
    + '<path class="on-estrada" d="M2 57.5H94"/>'
    + `<path class="on-feixe" d="M88 41.6L120 33V50.5Z" fill="url(#${id('feixe')})"/>`
    + '<g class="on-carro">'
    +   `<path class="on-corpo" d="${corpo}" fill="url(#${id('corpo')})"/>`
    +   '<rect class="on-faixa" x="9" y="33.5" width="78.5" height="3" fill="#F59E0B"/>'
    +   janelas
    +   '<rect class="on-vidro" x="63" y="16" width="8" height="25" rx="1"/><path d="M67 16V41" stroke="#0B1D42" stroke-width=".8"/>'
    +   '<path class="on-vidro" d="M74 16H80.2Q81.8 16 82.6 18L86 28.5H74Z"/>'
    +   '<rect class="on-farol" x="84.8" y="40" width="2.8" height="3.2" rx=".8" fill="#FEF9C3"/>'
    +   '<rect class="on-lanterna" x="8.4" y="39" width="2.2" height="4.6" rx=".6" fill="#F87171"/>'
    +   '<g class="on-antena"><path d="M40 11V5.4"/><circle cx="40" cy="4.6" r="1.1" fill="#7DD3FC"/></g>'
    +   '<path class="on-onda o1" d="M36.6 2.4Q40 -.6 43.4 2.4"/><path class="on-onda o2" d="M34.2 .2Q40 -4.8 45.8 .2"/><path class="on-onda o3" d="M31.8 -2Q40 -9 48.2 -2"/>'
    +   `<path class="on-contorno" d="${corpo}"/>`
    +   `<g clip-path="url(#${id('recorte')})"><g class="on-brilho-mov"><rect x="0" y="-10" width="14" height="80" fill="url(#${id('luz')})" transform="skewX(-22)"/></g></g>`
    + '</g>'
    + roda(22) + roda(74)
    + '<g transform="translate(93 16)"><path class="faisca f1" d="M0-6C.6-1.2 1.2-.6 6 0 1.2.6.6 1.2 0 6-.6 1.2-1.2.6-6 0-1.2-.6-.6-1.2 0-6z"/></g>'
    + '<g transform="translate(3 24)"><path class="faisca f2" d="M0-4C.4-.8.8-.4 4 0 .8.4.4.8 0 4-.4.8-.8.4-4 0-.8-.4-.4-.8 0-4z"/></g>'
    + '</svg>';
}

const _escrita = { quadro: 0, espera: 0, ativa: false, volta: 0 };

function montarFrase() {
  const h1 = document.querySelector('#gate .auth-titulo');
  if (!h1 || h1.getAttribute('data-montada')) return;
  const palavras = ENTRADA_FRASE.split(' ');
  const html = palavras.map((p, k) => {
    const letras = [...p].map((c) => `<span class="esc-l">${H(c)}</span>`).join('');
    if (p === ENTRADA_DESTAQUE) {
      return `<span class="esc-p esc-destaque">${letras}<svg class="esc-risco" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 9C45 5 90 4 130 6S185 9 197 5" pathLength="1"/></svg></span>`;
    }
    return `<span class="esc-p">${letras}${k === palavras.length - 1 ? onibusSvg('', 'parado') : ''}</span>`;
  }).join(' ');
  h1.innerHTML = `<span class="so-leitor">${H(ENTRADA_FRASE)}</span><span class="esc" aria-hidden="true">${html}</span>`;
  h1.setAttribute('data-montada', '1');
  h1.classList.add('escrito'); // até o ônibus começar, a frase fica pronta e legível
  const mov = document.querySelector('#gate .veiculo-mov');
  if (mov) mov.innerHTML = onibusSvg('-m', 'andando');
}

function escreverFrase() {
  const esc = _escrita;
  const T = ENTRADA_TEMPO;
  cancelAnimationFrame(esc.quadro); clearTimeout(esc.espera);
  const t = document.getElementById('gate');
  const h1 = t && t.querySelector('.auth-titulo');
  const caixa = t && t.querySelector('.auth-lado-texto');
  const veiculo = t && t.querySelector('.veiculo');
  if (!h1 || !caixa || !veiculo) return;
  const letras = [...h1.querySelectorAll('.esc-l')];
  const risco = h1.querySelector('.esc-risco');
  const traco = risco && risco.querySelector('path');
  const parado = h1.querySelector('.onibus.parado');
  const primeiroDestaque = risco ? letras.indexOf(risco.parentElement.querySelector('.esc-l')) : -1;
  const naTela = () => h1.isConnected && gateNaTela() && !!caixa.offsetParent;
  const limparLetras = () => letras.forEach((l) => { l.classList.remove('vis'); l.style.transitionDelay = ''; });
  const pronto = () => {
    cancelAnimationFrame(esc.quadro); clearTimeout(esc.espera); esc.ativa = false;
    limparLetras();
    if (traco) { traco.style.strokeDashoffset = ''; traco.style.transition = ''; }
    if (risco) risco.classList.remove('riscando');
    if (parado) parado.classList.remove('chegou');
    h1.classList.remove('apagando', 'trazendo'); h1.classList.add('escrito');
    veiculo.classList.remove('visivel');
  };
  if (reduzirMovimento() || !caixa.offsetParent || !letras.length || !parado) { pronto(); return; }
  esc.ativa = true;
  const volta = ++esc.volta;
  limparLetras();
  if (traco) { traco.style.transition = ''; traco.style.strokeDashoffset = ''; }
  if (risco) risco.classList.remove('riscando');
  parado.classList.remove('chegou');
  veiculo.classList.remove('visivel');

  // roteiro (refeito a cada volta, com a fonte carregada e a largura atual): as linhas da frase,
  // onde o ônibus anda em cada uma e onde ele estaciona
  let linhas = [];
  let vaga = null;
  let caixaRisco = null;
  const roteiro = () => {
    const b = caixa.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height });
    const rs = letras.map((l) => rel(l.getBoundingClientRect()));
    linhas = [];
    rs.forEach((r, i) => {
      const atual = linhas[linhas.length - 1];
      if (!atual || Math.abs(r.y - atual.topo) > 4) linhas.push({ topo: r.y, esq: r.x, dir: r.x + r.w, letras: [i] });
      else { atual.dir = Math.max(atual.dir, r.x + r.w); atual.letras.push(i); }
    });
    vaga = rel(parado.getBoundingClientRect());
    veiculo.style.width = `${vaga.w.toFixed(1)}px`;
    veiculo.style.height = `${vaga.h.toFixed(1)}px`;
    const alturaOnibus = vaga.y - linhas[linhas.length - 1].topo; // a mesma altura em todas as linhas
    linhas.forEach((ln, k) => {
      ln.y = ln.topo + alturaOnibus;
      ln.de = ln.esq - vaga.w - 28;
      ln.ate = k === linhas.length - 1 ? vaga.x : ln.dir + 18;
      ln.ms = Math.max(500, (ln.ate - ln.de) / T.velocidade);
      ln.revela = ln.letras.map((i) => ({ i, x: rs[i].x + rs[i].w * 0.35 }));
      ln.temRisco = ln.letras.includes(primeiroDestaque);
    });
    caixaRisco = risco ? rel(risco.getBoundingClientRect()) : null;
  };
  // arranque e freada suaves: acelera no começo da primeira linha e freia ao estacionar
  const A = 0.22;
  const arranca = (f) => (f < A ? (f * f) / (2 * A * (1 - A / 2)) : (f - A / 2) / (1 - A / 2));
  const freia = (f) => 1 - arranca(1 - f);
  const suave = (f) => (f < 0.5 ? 2 * f * f : 1 - ((-2 * f + 2) ** 2) / 2);
  const por = (x, y, opacidade) => {
    veiculo.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    veiculo.style.opacity = String(opacidade);
  };
  let k = 0;
  let tempo = 0;
  let ultimo = null;

  function quadro(agora) {
    if (!naTela()) { pronto(); return; }
    tempo += ultimo === null ? 0 : Math.min(agora - ultimo, 50); // aba escondida: continua de onde parou
    ultimo = agora;
    for (;;) {
      const ln = linhas[k];
      const ultimaLinha = k === linhas.length - 1;
      const f = Math.min(1, tempo / ln.ms);
      const e = k === 0 && ultimaLinha ? suave(f) : k === 0 ? arranca(f) : ultimaLinha ? freia(f) : f;
      const x = ln.de + (ln.ate - ln.de) * e;
      // entra e sai de cena nas trocas de linha (na última, chega inteiro na vaga)
      const op = Math.min(1, f / 0.12, ultimaLinha ? 1 : (1 - f) / 0.12);
      por(x, ln.y, Math.max(0, op));
      for (const r of ln.revela) if (x >= r.x && !letras[r.i].classList.contains('vis')) letras[r.i].classList.add('vis');
      if (ln.temRisco && caixaRisco && x > caixaRisco.x) {
        const g = Math.max(0, Math.min(1, (x - caixaRisco.x) / caixaRisco.w));
        risco.classList.add('riscando');
        traco.style.strokeDashoffset = String(1 - g);
      }
      if (f < 1) break;
      tempo -= ln.ms;
      k += 1;
      if (k >= linhas.length) { estacionar(); return; }
    }
    esc.quadro = requestAnimationFrame(quadro);
  }

  function estacionar() {
    letras.forEach((l) => l.classList.add('vis'));
    if (traco) traco.style.strokeDashoffset = '0';
    parado.classList.add('chegou');
    veiculo.classList.remove('visivel');
    esc.espera = setTimeout(partir, T.parada);
  }

  // o ônibus sai pela direita e o texto vai embora com ele
  function partir() {
    if (!naTela()) { pronto(); return; }
    parado.classList.remove('chegou');
    veiculo.classList.add('visivel');
    letras.forEach((l, n) => { l.style.transitionDelay = `${n * T.onda}ms`; });
    h1.classList.add('apagando');
    if (traco) { traco.style.transition = 'stroke-dashoffset .6s ease'; traco.style.strokeDashoffset = '1'; }
    const x0 = vaga.x;
    let inicio = null;
    const sair = (agora) => {
      if (!naTela()) { pronto(); return; }
      if (inicio === null) inicio = agora;
      const f = Math.min(1, (agora - inicio) / T.partida);
      por(x0 + 220 * f * f, vaga.y, f < 0.55 ? 1 : Math.max(0, (1 - f) / 0.45));
      if (f < 1) { esc.quadro = requestAnimationFrame(sair); return; }
      veiculo.classList.remove('visivel');
      esc.espera = setTimeout(() => {
        limparLetras();
        h1.classList.remove('apagando');
        if (traco) traco.style.transition = '';
        if (risco) risco.classList.remove('riscando');
        esc.espera = setTimeout(trazer, T.respiro);
      }, Math.max(0, T.apaga + letras.length * T.onda - T.partida));
    };
    esc.quadro = requestAnimationFrame(sair);
  }

  function trazer() {
    if (!naTela()) { pronto(); return; }
    roteiro();
    k = 0; tempo = 0; ultimo = null;
    por(linhas[0].de, linhas[0].y, 0);
    veiculo.classList.add('visivel');
    esc.quadro = requestAnimationFrame(quadro);
  }

  h1.classList.remove('escrito', 'apagando');
  h1.classList.add('trazendo');
  const fontes = document.fonts && document.fonts.ready
    ? Promise.race([document.fonts.ready, new Promise((ok) => setTimeout(ok, 1500))]) : Promise.resolve();
  const comeco = Date.now();
  fontes.then(() => {
    if (!esc.ativa || volta !== esc.volta) return;
    esc.espera = setTimeout(trazer, Math.max(0, T.inicio - (Date.now() - comeco)));
  });
}

/* ---------- prévia do painel ---------- */
// Três cartões que imitam o FrotaGest: frota online com o mini mapa, avisos que se revezam e os km
// rodados no dia. Só decoração: todos os valores são fictícios e fixos aqui no código.
const VITRINE = {
  online: 347, total: 363, km: 18426, troca: 4200,
  avisos: [
    { ic: 'bell-ringing', cor: 'ambar', tit: 'Excesso de velocidade', sub: 'Carro 1042 · 86 km/h · limite 80' },
    { ic: 'wifi', cor: 'verde', tit: 'Veículo online', sub: 'Carro 2318 · saiu da garagem', online: 1 },
    { ic: 'video', cor: 'azul', tit: 'Câmera ao vivo', sub: 'Carro 2207 · CH1 e CH2' },
    { ic: 'check', cor: 'verde', tit: 'Alerta tratado', sub: 'Carro 1042 · motorista orientado' },
    { ic: 'download', cor: 'azul', tit: 'Gravação pronta', sub: 'Carro 1188 · 10 min em MP4' },
    { ic: 'alert-triangle', cor: 'vermelho', tit: 'Botão de emergência', sub: 'Carro 3051 · central acionada' },
    { ic: 'wifi', cor: 'verde', tit: 'Veículo online', sub: 'Carro 1730 · início de viagem', online: 1 },
  ],
};
const _vitrine = { timer: 0, espera: 0, contas: {}, online: 0, km: 0, i: 0, rodando: false };
const fmtInt = (n) => Math.round(n).toLocaleString('pt-BR');

function _vitrineEl() {
  const v = document.querySelector('#gate .vitrine');
  return v ? { v, online: v.querySelector('#vt-online'), pct: v.querySelector('#vt-pct'), km: v.querySelector('#vt-km'), aviso: v.querySelector('#vt-aviso'),
    ic: v.querySelector('#vt-aviso-ic'), tit: v.querySelector('#vt-aviso-tit'), sub: v.querySelector('#vt-aviso-sub'), mapa: v.querySelector('.vt-mapa') } : null;
}
const _vitrineNaTela = (e) => !!(e && gateNaTela() && e.v.offsetParent);

function _contar(chave, el, de, ate, ms, formato, atraso = 0) {
  cancelAnimationFrame(_vitrine.contas[chave]);
  if (!el) return;
  const comeco = performance.now() + atraso;
  const passo = (agora) => {
    const f = Math.max(0, Math.min(1, (agora - comeco) / ms));
    el.textContent = formato(de + (ate - de) * (1 - (1 - f) ** 3));
    if (f < 1) _vitrine.contas[chave] = requestAnimationFrame(passo);
  };
  el.textContent = formato(de);
  _vitrine.contas[chave] = requestAnimationFrame(passo);
}

function _aviso(e, a, animar) {
  e.ic.className = `vt-ic ${a.cor}`;
  const use = e.ic.querySelector('use');
  if (use) use.setAttribute('href', `#i-${a.ic}`);
  e.tit.textContent = a.tit;
  e.sub.textContent = a.sub;
  e.aviso.classList.remove('troca');
  if (animar) { void e.aviso.offsetWidth; e.aviso.classList.add('troca'); }
}

function _pct(online) { return `${(online / VITRINE.total * 100).toFixed(1).replace('.', ',')}%`; }

function pararVitrine() {
  clearInterval(_vitrine.timer); clearTimeout(_vitrine.espera);
  Object.keys(_vitrine.contas).forEach((k) => cancelAnimationFrame(_vitrine.contas[k]));
  _vitrine.timer = 0; _vitrine.espera = 0; _vitrine.rodando = false;
}

function iniciarVitrine() {
  const e = _vitrineEl();
  if (!e) return;
  pararVitrine();
  const V = VITRINE;
  _vitrine.online = V.online; _vitrine.km = V.km; _vitrine.i = 0;
  e.aviso.style.setProperty('--vt-troca', `${V.troca}ms`);
  const parado = reduzirMovimento() || !_vitrineNaTela(e);
  try { if (e.mapa && e.mapa.pauseAnimations) { if (parado) e.mapa.pauseAnimations(); else e.mapa.unpauseAnimations(); } } catch { /* sem SMIL */ }
  if (parado) {
    e.v.classList.remove('vt-anima');
    e.online.textContent = fmtInt(V.online); e.pct.textContent = _pct(V.online); e.km.textContent = fmtInt(V.km);
    _aviso(e, V.avisos[0], false);
    return;
  }
  _vitrine.rodando = true;
  e.v.classList.remove('vt-anima'); void e.v.offsetWidth; e.v.classList.add('vt-anima');
  _contar('online', e.online, 0, V.online, 1500, fmtInt, 700);
  _contar('pct', e.pct, 0, V.online, 1500, _pct, 700);
  _contar('km', e.km, 0, V.km, 1700, fmtInt, 950);
  _aviso(e, V.avisos[0], false);
  _vitrine.espera = setTimeout(() => {
    if (!_vitrineNaTela(e)) { pararVitrine(); return; }
    _aviso(e, V.avisos[0], true);
    _vitrine.timer = setInterval(() => {
      if (!_vitrineNaTela(e)) { pararVitrine(); return; }
      _vitrine.i = (_vitrine.i + 1) % V.avisos.length;
      const a = V.avisos[_vitrine.i];
      _aviso(e, a, true);
      // a frota segue rodando: os km sobem sempre, e um veículo que entra conta como online
      const k0 = _vitrine.km;
      _vitrine.km += 9 + Math.round(Math.random() * 14);
      _contar('km', e.km, k0, _vitrine.km, 700, fmtInt, 200);
      if (a.online && _vitrine.online < V.total) {
        const o0 = _vitrine.online;
        _vitrine.online += a.online;
        _contar('online', e.online, o0, _vitrine.online, 600, fmtInt, 250);
        _contar('pct', e.pct, o0, _vitrine.online, 600, _pct, 250);
        e.online.parentElement.classList.add('sobe');
        setTimeout(() => e.online.parentElement.classList.remove('sobe'), 1300);
      }
    }, V.troca);
  }, 1100);
}

/* ---------- cidade e estrada ao fundo ---------- */
// Silhueta de uma cidade à noite com janelas que acendem e apagam aos poucos e uma estrada com
// faróis passando. Desenho gerado aqui com números (sem nenhum dado); para quando o login sai da tela.
const _horizonte = { timer: 0, janelas: null };

function montarHorizonte() {
  const h = document.querySelector('#gate .horizonte');
  if (!h) return null;
  if (_horizonte.janelas) return h;
  let s = 20261109; // sorteio fixo: a cidade é sempre a mesma
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const n = (v) => Math.round(v * 10) / 10;
  const L = 1600;
  const A = 240;
  let fundo = '';
  let frente = '';
  let jan = '';
  let luz = '';
  // poucos prédios, mais baixos e espaçados: a tela fica mais limpa
  for (let x = -20 + r() * 60; x < L + 20;) {
    const w = 70 + r() * 70;
    const alt = 70 + r() * 80;
    fundo += `<rect x="${n(x)}" y="${n(A - alt)}" width="${n(w)}" height="${n(alt)}"/>`;
    x += w + 70 + r() * 170;
  }
  for (let x = 10 + r() * 80; x < L + 8;) {
    const w = 42 + Math.floor(r() * 5) * 9;
    const alt = 36 + r() * 82;
    const y = A - alt;
    frente += `<rect x="${n(x)}" y="${n(y)}" width="${w}" height="${n(alt + 1)}"/>`;
    if (alt > 96 && r() < 0.45) {
      const ax = n(x + w * (0.3 + r() * 0.4));
      const ah = 14 + r() * 12;
      frente += `<rect x="${ax}" y="${n(y - ah)}" width="2" height="${n(ah + 1)}"/>`;
      luz += `<circle class="hz-luz" cx="${n(ax + 1)}" cy="${n(y - ah)}" r="2.4"/>`;
    }
    if (r() > 0.2) {
      for (let jy = y + 9; jy < A - 10; jy += 12) {
        if (r() < 0.25) continue;
        for (let jx = x + 7; jx < x + w - 9; jx += 9) {
          if (r() < 0.6) jan += `<rect x="${n(jx)}" y="${n(jy)}" width="4" height="5"${r() < 0.2 ? ' class="acesa"' : ''}/>`;
        }
      }
    }
    x += w + 60 + r() * 190;
  }
  // faróis na estrada: tempos e atrasos diferentes para não andarem juntos
  let carros = '';
  for (let k = 0; k < 6; k++) carros += `<span class="carro ida" style="--d:${n(9 + r() * 7)}s;--a:-${n(r() * 14)}s"></span>`;
  for (let k = 0; k < 5; k++) carros += `<span class="carro volta" style="--d:${n(11 + r() * 8)}s;--a:-${n(r() * 16)}s"></span>`;
  h.innerHTML = `<svg viewBox="0 0 ${L} ${A}" preserveAspectRatio="xMidYMax slice" focusable="false">`
    + `<g class="hz-fundo">${fundo}</g><g class="hz-frente">${frente}</g>`
    + `<g class="hz-jan" shape-rendering="crispEdges">${jan}</g><g>${luz}</g></svg><div class="estrada">${carros}</div>`;
  _horizonte.janelas = h.querySelectorAll('.hz-jan rect');
  return h;
}

function iniciarHorizonte() {
  const h = montarHorizonte();
  if (!h) return;
  clearInterval(_horizonte.timer); _horizonte.timer = 0;
  requestAnimationFrame(() => h.classList.add('pronto'));
  const jan = _horizonte.janelas;
  if (reduzirMovimento() || !jan || !jan.length) return;
  _horizonte.timer = setInterval(() => {
    if (!gateNaTela()) { clearInterval(_horizonte.timer); _horizonte.timer = 0; return; }
    if (document.hidden) return;
    for (let k = 0; k < 3; k++) {
      const j = jan[Math.floor(Math.random() * jan.length)];
      if (j.classList.contains('acesa')) j.classList.remove('acesa');
      else if (Math.random() < 0.34) j.classList.add('acesa');
    }
  }, 650);
}

/* ---------- saudação e "Lembrar meu e-mail" ---------- */
// Guarda SÓ o e-mail (nunca a senha), e só quando a pessoa marca a opção e entra com sucesso.
// Desmarcar apaga na hora.
const CHAVE_EMAIL_LEMBRADO = 'fg:emailLembrado';

function emailLembrado() {
  let v = '';
  try { v = (localStorage.getItem(CHAVE_EMAIL_LEMBRADO) || '').trim(); } catch { /* sem armazenamento */ }
  return v.length <= 254 && /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/.test(v) ? v : '';
}

function lembrarEmail(email, lembrar) {
  try {
    if (lembrar && email) localStorage.setItem(CHAVE_EMAIL_LEMBRADO, email);
    else localStorage.removeItem(CHAVE_EMAIL_LEMBRADO);
    localStorage.removeItem('fg:ultimoEmail'); // versões antigas guardavam sem perguntar
  } catch { /* sem armazenamento */ }
}

function saudacao() {
  const h = new Date().getHours();
  const oi = h >= 5 && h < 12 ? 'Bom dia!' : h >= 12 && h < 18 ? 'Boa tarde!' : 'Boa noite!';
  return `<strong>${oi}</strong> ${emailLembrado() ? 'Que bom ter você de volta.' : 'Acesse o monitoramento da sua frota.'}`;
}

/** Aviso de Caps Lock ligado num campo de senha. */
function avisarCapsLock(campo, aviso) {
  if (!campo || !aviso) return;
  const ver = (e) => { try { aviso.hidden = !e.getModifierState('CapsLock'); } catch { /* navegador antigo */ } };
  campo.addEventListener('keydown', ver);
  campo.addEventListener('keyup', ver);
  campo.addEventListener('blur', () => { aviso.hidden = true; });
}

/* ---------- liga e desliga ---------- */

function iniciarTelaEntrada() {
  try {
    const g = document.getElementById('gate');
    if (!g) return;
    montarFrase();
    if (!g.dataset.entrou) {
      g.dataset.entrou = '1';
      g.classList.remove('entrando'); void g.offsetWidth; g.classList.add('entrando');
      setTimeout(() => g.classList.remove('entrando'), 1400);
    }
    if (!_escrita.ativa) escreverFrase();
    if (!_vitrine.rodando) iniciarVitrine();
    if (!_horizonte.timer) iniciarHorizonte();
  } catch (e) {
    console.warn('Tela de entrada:', e); // a animação nunca pode impedir o login
  }
}

function pararTelaEntrada() {
  try {
    cancelAnimationFrame(_escrita.quadro); clearTimeout(_escrita.espera); _escrita.ativa = false; _escrita.volta++;
    const veiculo = document.querySelector('#gate .veiculo');
    if (veiculo) veiculo.classList.remove('visivel');
    pararVitrine();
    clearInterval(_horizonte.timer); _horizonte.timer = 0;
    const g = document.getElementById('gate');
    if (g) delete g.dataset.entrou;
  } catch { /* nada a parar */ }
}

// a janela mudou de tamanho no meio da escrita: recomeça com as posições novas
let _redimensiona = 0;
window.addEventListener('resize', () => {
  clearTimeout(_redimensiona);
  _redimensiona = setTimeout(() => { if (gateNaTela() && _escrita.ativa) escreverFrase(); else if (gateNaTela()) iniciarTelaEntrada(); }, 400);
});
