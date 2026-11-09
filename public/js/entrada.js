'use strict';
/* FrotaGest — enfeites da tela de entrada: frase escrita pela caneta com o ônibus no fim, prévia do
 * painel, cidade com a estrada ao fundo, saudação e "Lembrar meu e-mail". Tudo aqui é decoração:
 * nada lê dados do servidor, e se alguma animação falhar o login continua funcionando.
 * No padrão do OdontoWorld e do CondoGest. Reis Tecnologia */

const reduzirMovimento = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const gateNaTela = () => { const g = document.getElementById('gate'); return !!(g && !g.hidden); };

/* ---------- frase escrita pela caneta ---------- */
// A caneta escreve a frase (cada letra: contorno azul-céu que se preenche de branco), sublinha
// "em tempo real" e desenha o contorno de um ônibus no fim da frase. Quando a caneta sai, o ônibus
// ganha cor, rodas, janelas acesas, faróis e o sinal do 4G, e fica "rodando" na estrada.
// A frase fica parada para leitura, se apaga e o ciclo recomeça. Só roda com o painel visível.
const ENTRADA_FRASE = 'Sua frota monitorada em tempo real e sem complicações';
const ENTRADA_DESTAQUE = 'em tempo real';
const ENTRADA_TEMPO = { inicio: 650, chega: 380, risca: 520, ida: 620, desenho: 1500, sai: 480, parada: 9000, apaga: 450, onda: 7, respiro: 600 };

// Ônibus (viewBox 96 x 60). A caneta traça da esquerda para a direita: chão, traseira, teto, frente e chão.
const ONIBUS_CONTORNO = 'M2 54H9V16.5Q9 11 14.5 11H73Q80.5 11 83.5 17.5L87.5 29V54H94';
function onibusSvg() {
  const janelas = [13, 23, 33, 43, 53].map((x, i) => `<rect class="on-janela${i === 3 ? '' : ' acende'}" style="--j:${[2, 0, 3, 0, 1][i]}" x="${x}" y="16" width="8" height="12" rx="1"/>`).join('');
  const roda = (cx, r) => `<g class="on-roda" style="--r:${r}"><circle cx="${cx}" cy="48" r="6" fill="#091330" stroke="rgba(125,211,252,.85)" stroke-width="1.2"/>`
    + `<g class="on-raios"><path d="M${cx - 3.6} 48H${cx + 3.6}M${cx - 1.8} ${(48 - 3.1).toFixed(1)}L${cx + 1.8} ${(48 + 3.1).toFixed(1)}M${cx + 1.8} ${(48 - 3.1).toFixed(1)}L${cx - 1.8} ${(48 + 3.1).toFixed(1)}" stroke="#94A3B8" stroke-width=".9" stroke-linecap="round"/></g>`
    + `<circle cx="${cx}" cy="48" r="1.6" fill="#E2E8F0"/></g>`;
  return '<svg class="onibus" viewBox="0 0 96 60" aria-hidden="true"><defs>'
    + '<clipPath id="on-recorte"><path d="M9 48V16.5Q9 11 14.5 11H73Q80.5 11 83.5 17.5L87.5 29V48Z"/></clipPath>'
    + '<linearGradient id="on-corpo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D5AA0"/><stop offset="1" stop-color="#173461"/></linearGradient>'
    + '<linearGradient id="on-feixe" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FEF9C3" stop-opacity=".85"/><stop offset="1" stop-color="#FEF9C3" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="on-luz" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
    + '</defs>'
    + '<path class="on-estrada" d="M2 57.5H94"/>'
    + '<path class="on-feixe" d="M88 41.6L120 33V50.5Z" fill="url(#on-feixe)"/>'
    + '<g class="on-carro">'
    +   '<path class="on-corpo" d="M9 48V16.5Q9 11 14.5 11H73Q80.5 11 83.5 17.5L87.5 29V48Z" fill="url(#on-corpo)"/>'
    +   '<rect class="on-faixa" x="9" y="33.5" width="78.5" height="3" fill="#F59E0B"/>'
    +   janelas
    +   '<rect class="on-vidro" x="63" y="16" width="8" height="25" rx="1"/><path d="M67 16V41" stroke="#0B1D42" stroke-width=".8"/>'
    +   '<path class="on-vidro" d="M74 16H80.2Q81.8 16 82.6 18L86 28.5H74Z"/>'
    +   '<rect class="on-farol" x="84.8" y="40" width="2.8" height="3.2" rx=".8" fill="#FEF9C3"/>'
    +   '<rect class="on-lanterna" x="8.4" y="39" width="2.2" height="4.6" rx=".6" fill="#F87171"/>'
    +   '<g class="on-antena"><path d="M40 11V5.4"/><circle cx="40" cy="4.6" r="1.1" fill="#7DD3FC"/></g>'
    +   '<path class="on-onda o1" d="M36.6 2.4Q40 -.6 43.4 2.4"/><path class="on-onda o2" d="M34.2 .2Q40 -4.8 45.8 .2"/><path class="on-onda o3" d="M31.8 -2Q40 -9 48.2 -2"/>'
    +   '<g clip-path="url(#on-recorte)"><g class="on-brilho-mov"><rect x="0" y="-10" width="14" height="80" fill="url(#on-luz)" transform="skewX(-22)"/></g></g>'
    + '</g>'
    + roda(22, 0) + roda(74, 1)
    + `<path class="on-contorno" d="${ONIBUS_CONTORNO}"/>`
    + '<g transform="translate(93 16)"><path class="faisca f1" d="M0-6C.6-1.2 1.2-.6 6 0 1.2.6.6 1.2 0 6-.6 1.2-1.2.6-6 0-1.2-.6-.6-1.2 0-6z"/></g>'
    + '<g transform="translate(3 24)"><path class="faisca f2" d="M0-4C.4-.8.8-.4 4 0 .8.4.4.8 0 4-.4.8-.8.4-4 0-.8-.4-.4-.8 0-4z"/></g>'
    + '</svg>';
}

// Caneta de corpo azul laqueado e partes de metal; a ponta fica na origem (0, 11)
const CANETA_SVG = '<svg viewBox="0 0 136 22" aria-hidden="true"><defs>'
  + '<linearGradient id="fg-caneta-corpo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7CB8FF"/><stop offset=".3" stop-color="#2F6FE0"/><stop offset=".7" stop-color="#173B8F"/><stop offset="1" stop-color="#0A1A45"/></linearGradient>'
  + '<linearGradient id="fg-caneta-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F8FAFC"/><stop offset=".45" stop-color="#CBD5E1"/><stop offset=".75" stop-color="#8A9BB4"/><stop offset="1" stop-color="#CBD5E1"/></linearGradient></defs>'
  + '<path d="M0 11 5.5 9.4v3.2z" fill="#0F172A"/><path d="M5 9.5 25 4.2v13.6L5 12.5z" fill="url(#fg-caneta-metal)"/>'
  + '<rect x="25" y="3.6" width="3" height="14.8" fill="#E2E8F0"/><rect x="28" y="3.4" width="88" height="15.2" fill="url(#fg-caneta-corpo)"/>'
  + '<rect x="28" y="5.2" width="88" height="1.3" fill="#fff" opacity=".35"/><rect x="70" y="3.4" width="4" height="15.2" fill="url(#fg-caneta-metal)"/>'
  + '<rect x="116" y="3.4" width="2.6" height="15.2" fill="url(#fg-caneta-metal)"/><path d="M118.6 3.4h8.6a7.6 7.6 0 0 1 0 15.2h-8.6z" fill="url(#fg-caneta-corpo)"/>'
  + '<rect x="86" y=".6" width="38" height="3.4" rx="1.7" fill="url(#fg-caneta-metal)"/><circle cx="87.6" cy="2.3" r="2.1" fill="#E2E8F0"/></svg>';

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
    return `<span class="esc-p">${letras}${k === palavras.length - 1 ? onibusSvg() : ''}</span>`;
  }).join(' ');
  h1.innerHTML = `<span class="so-leitor">${H(ENTRADA_FRASE)}</span><span class="esc" aria-hidden="true">${html}</span>`;
  h1.setAttribute('data-montada', '1');
  h1.classList.add('escrito'); // até a caneta começar, a frase fica pronta e legível
  const mov = document.querySelector('#gate .caneta-mov');
  if (mov) mov.innerHTML = CANETA_SVG;
}

function escreverFrase() {
  const esc = _escrita;
  const T = ENTRADA_TEMPO;
  cancelAnimationFrame(esc.quadro); clearTimeout(esc.espera);
  const t = document.getElementById('gate');
  const h1 = t && t.querySelector('.auth-titulo');
  const caixa = t && t.querySelector('.auth-lado-texto');
  const caneta = t && t.querySelector('.caneta');
  if (!h1 || !caixa || !caneta) return;
  const letras = [...h1.querySelectorAll('.esc-l')];
  const risco = h1.querySelector('.esc-risco');
  const traco = risco && risco.querySelector('path');
  const desenho = h1.querySelector('.onibus');
  const contorno = desenho && desenho.querySelector('.on-contorno');
  const mov = caneta.firstElementChild;
  let tamDesenho = 0;
  const naTela = () => h1.isConnected && gateNaTela() && !!caixa.offsetParent;
  const pronto = () => {
    cancelAnimationFrame(esc.quadro); clearTimeout(esc.espera); esc.ativa = false;
    letras.forEach((l) => { l.style.clipPath = ''; l.style.transitionDelay = ''; });
    if (traco) { traco.style.strokeDashoffset = ''; traco.style.transition = ''; }
    if (contorno) { contorno.style.strokeDasharray = ''; contorno.style.strokeDashoffset = ''; contorno.style.transition = ''; }
    if (desenho) desenho.classList.remove('construindo', 'demolindo', 'tracando');
    if (risco) risco.classList.remove('riscando');
    h1.classList.remove('apagando'); h1.classList.add('escrito');
    caneta.classList.remove('visivel', 'saindo');
  };
  if (reduzirMovimento() || !caixa.offsetParent || !letras.length) { pronto(); return; }
  esc.ativa = true;
  const volta = ++esc.volta;
  letras.forEach((l) => { l.classList.remove('traco', 'feito'); l.style.clipPath = ''; l.style.transitionDelay = ''; });
  if (traco) { traco.style.transition = ''; traco.style.strokeDashoffset = ''; }
  if (desenho) desenho.classList.remove('construindo', 'demolindo', 'tracando');
  if (risco) risco.classList.remove('riscando');
  if (contorno) { contorno.style.transition = ''; contorno.style.strokeDasharray = ''; contorno.style.strokeDashoffset = ''; }
  caneta.classList.remove('visivel', 'saindo');

  // roteiro (refeito a cada volta, com a fonte carregada e a largura atual)
  let passos = [];
  const roteiro = () => {
    const r0 = letras.map((l) => l.getBoundingClientRect());
    passos = letras.map((l, i) => {
      const anterior = i ? letras[i - 1].textContent : '';
      const novaLinha = i > 0 && r0[i].top - r0[i - 1].top > 4;
      const novaPalavra = i > 0 && !l.previousElementSibling;
      let desloca = i === 0 || novaLinha ? 420 : novaPalavra ? 70 : 0;
      if (novaPalavra && anterior === ',') desloca += 200;
      return { desloca, escreve: 12 + r0[i].width * 0.95 + Math.random() * 10, novaLinha, novaPalavra };
    });
    if (contorno) {
      tamDesenho = contorno.getTotalLength();
      contorno.style.transition = '';
      contorno.style.strokeDasharray = String(tamDesenho);
      contorno.style.strokeDashoffset = String(tamDesenho);
    }
  };
  const suave = (f) => (f < 0.5 ? 2 * f * f : 1 - ((-2 * f + 2) ** 2) / 2);
  const ponta = (r, b, direita) => ({ x: (direita ? r.right : r.left) - b.left, y: r.top + r.height * 0.8 - b.top });
  const por = (p, sobe = 0, gira = 0) => {
    caneta.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    mov.style.transform = `translateY(${(-sobe).toFixed(1)}px) rotate(${gira.toFixed(2)}deg)`;
  };
  const entre = (a, c, f) => ({ x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f });
  const noRisco = (b, f) => {
    const rr = risco.getBoundingClientRect();
    const pt = traco.getPointAtLength(f * traco.getTotalLength());
    return { x: rr.left + (pt.x / 200) * rr.width - b.left, y: rr.top + (pt.y / 14) * rr.height - b.top };
  };
  const noDesenho = (b, f) => {
    const m = contorno.getScreenCTM();
    const pt = contorno.getPointAtLength(f * tamDesenho);
    return { x: m.a * pt.x + m.c * pt.y + m.e - b.left, y: m.b * pt.x + m.d * pt.y + m.f - b.top };
  };
  let i = 0;
  let tempo = 0;
  let fase = 'letras';
  let ultimo = null;
  let deOnde = null;

  function quadro(agora) {
    if (!naTela()) { pronto(); return; }
    tempo += ultimo === null ? 0 : Math.min(agora - ultimo, 50);
    ultimo = agora;
    const b = caixa.getBoundingClientRect();
    let f;
    let g;
    if (fase === 'letras') {
      for (;;) {
        const p = passos[i];
        const r = letras[i].getBoundingClientRect();
        const ini = ponta(r, b, false);
        const fim = ponta(r, b, true);
        if (tempo < p.desloca) {
          f = tempo / p.desloca;
          const de = i ? ponta(letras[i - 1].getBoundingClientRect(), b, true) : { x: ini.x + 34, y: ini.y - 40 };
          por(entre(de, ini, i === 0 || p.novaLinha ? suave(f) : f), (p.novaLinha ? 12 : p.novaPalavra ? 4 : 0) * Math.sin(f * Math.PI));
          break;
        }
        g = (tempo - p.desloca) / p.escreve;
        if (g < 1) {
          letras[i].classList.add('traco');
          letras[i].style.clipPath = `inset(-35% ${((1 - g) * 100).toFixed(1)}% -35% -12%)`;
          por(entre(ini, fim, g), 2.5 * Math.sin(g * Math.PI), -2 * Math.sin(g * Math.PI));
          break;
        }
        letras[i].style.clipPath = 'inset(-35% -12% -35% -12%)';
        letras[i].classList.add('traco', 'feito');
        tempo -= p.desloca + p.escreve;
        i += 1;
        if (i >= letras.length) { fase = risco ? 'chega' : contorno ? 'ida' : 'sai'; deOnde = fim; break; }
      }
    }
    if (fase === 'chega') {
      f = Math.min(1, tempo / T.chega);
      por(entre(deOnde, noRisco(b, 0), suave(f)), 10 * Math.sin(f * Math.PI));
      if (f >= 1) { tempo -= T.chega; fase = 'risca'; risco.classList.add('riscando'); }
    }
    if (fase === 'risca') {
      f = Math.min(1, tempo / T.risca);
      traco.style.strokeDashoffset = String(1 - f);
      por(noRisco(b, f), 0, -1.5 * Math.sin(f * Math.PI));
      if (f >= 1) { tempo -= T.risca; deOnde = noRisco(b, 1); fase = contorno ? 'ida' : 'sai'; }
    }
    if (fase === 'ida') {
      f = Math.min(1, tempo / T.ida);
      por(entre(deOnde, noDesenho(b, 0), suave(f)), 18 * Math.sin(f * Math.PI));
      if (f >= 1) { tempo -= T.ida; fase = 'desenho'; desenho.classList.add('tracando'); }
    }
    if (fase === 'desenho') {
      f = Math.min(1, tempo / T.desenho);
      g = f * 0.85 + suave(f) * 0.15;
      contorno.style.strokeDashoffset = String(tamDesenho * (1 - g));
      por(noDesenho(b, g), 0, -1.2 * Math.sin(g * Math.PI * 2));
      if (f >= 1) { tempo -= T.desenho; fase = 'sai'; deOnde = noDesenho(b, 1); desenho.classList.add('construindo'); }
    }
    if (fase === 'sai') {
      f = Math.min(1, tempo / T.sai);
      if (!caneta.classList.contains('saindo')) { caneta.classList.add('saindo'); caneta.classList.remove('visivel'); }
      por(entre(deOnde, { x: deOnde.x + 30, y: deOnde.y - 38 }, suave(f)));
      if (f >= 1) { esc.espera = setTimeout(apagar, T.parada); return; }
    }
    esc.quadro = requestAnimationFrame(quadro);
  }

  function apagar() {
    if (!naTela()) { pronto(); return; }
    letras.forEach((l, k) => { l.style.transitionDelay = `${k * T.onda}ms`; });
    h1.classList.add('apagando');
    if (traco) { traco.style.transition = 'stroke-dashoffset .6s ease'; traco.style.strokeDashoffset = '1'; }
    if (desenho) {
      desenho.classList.remove('construindo'); desenho.classList.add('demolindo');
      contorno.style.strokeDashoffset = String(tamDesenho);
    }
    esc.espera = setTimeout(() => {
      letras.forEach((l) => { l.classList.remove('traco', 'feito'); l.style.transitionDelay = ''; l.style.clipPath = ''; });
      h1.classList.remove('apagando');
      if (traco) traco.style.transition = '';
      if (risco) risco.classList.remove('riscando');
      if (desenho) desenho.classList.remove('demolindo', 'tracando');
      esc.espera = setTimeout(escrever, T.respiro);
    }, T.apaga + letras.length * T.onda);
  }

  function escrever() {
    if (!naTela()) { pronto(); return; }
    roteiro();
    i = 0; tempo = 0; fase = 'letras'; ultimo = null; deOnde = null;
    caneta.classList.remove('saindo'); caneta.classList.add('visivel');
    esc.quadro = requestAnimationFrame(quadro);
  }

  h1.classList.remove('escrito', 'apagando');
  const fontes = document.fonts && document.fonts.ready
    ? Promise.race([document.fonts.ready, new Promise((ok) => setTimeout(ok, 1500))]) : Promise.resolve();
  const comeco = Date.now();
  fontes.then(() => {
    if (!esc.ativa || volta !== esc.volta) return;
    esc.espera = setTimeout(escrever, Math.max(0, T.inicio - (Date.now() - comeco)));
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
  for (let x = -20; x < L + 20;) {
    const w = 50 + r() * 80;
    const alt = 110 + r() * 125;
    fundo += `<rect x="${n(x)}" y="${n(A - alt)}" width="${n(w)}" height="${n(alt)}"/>`;
    if (r() < 0.3) fundo += `<rect x="${n(x + w * 0.22)}" y="${n(A - alt - 12 - r() * 16)}" width="${n(w * 0.56)}" height="30"/>`;
    x += w + 2 + r() * 12;
  }
  for (let x = -8; x < L + 8;) {
    const w = 45 + Math.floor(r() * 8) * 9;
    const alt = 46 + r() * 118;
    const y = A - alt;
    frente += `<rect x="${n(x)}" y="${n(y)}" width="${w}" height="${n(alt + 1)}"/>`;
    if (r() < 0.25) frente += `<rect x="${n(x + 9)}" y="${n(y - 10)}" width="${w - 18}" height="12"/>`;
    if (alt > 128 && r() < 0.55) {
      const ax = n(x + w * (0.3 + r() * 0.4));
      const ah = 16 + r() * 16;
      frente += `<rect x="${ax}" y="${n(y - ah)}" width="2" height="${n(ah + 1)}"/>`;
      luz += `<circle class="hz-luz" cx="${n(ax + 1)}" cy="${n(y - ah)}" r="2.4"/>`;
    }
    if (r() > 0.14) {
      for (let jy = y + 9; jy < A - 10; jy += 12) {
        if (r() < 0.12) continue;
        for (let jx = x + 7; jx < x + w - 9; jx += 9) {
          if (r() < 0.8) jan += `<rect x="${n(jx)}" y="${n(jy)}" width="4" height="5"${r() < 0.24 ? ' class="acesa"' : ''}/>`;
        }
      }
    }
    x += w + 4 + r() * 9;
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
    const caneta = document.querySelector('#gate .caneta');
    if (caneta) caneta.classList.remove('visivel', 'saindo');
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
