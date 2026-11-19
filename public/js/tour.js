'use strict';
/* FrotaGest — tour guiado (mesmo modelo do EduGest).
 * Passa pelas telas destacando os elementos reais (o resto escurece) e explicando cada um num balão.
 * Só navega e mostra: não clica em nada nem grava dados. Esc sai; ← → (ou Enter) voltam e avançam.
 *
 *   TOUR.iniciar(passos, { id, aoTerminar(concluiu) })
 *   passo: { pagina?, alvo?: seletor | [seletores], celular?: seletor, titulo, texto }   (texto aceita **negrito**)
 *   Sem alvo (ou alvo que não está na tela): balão no centro. Tela que a pessoa não abre: o passo é pulado.
 * Reis Tecnologia */

const TOUR = (() => {
  let atual = null; // { passos, i, vez, opcoes, els, alvo }

  const fmt = (s) => H(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  const celular = () => window.innerWidth <= 900; // menu lateral recolhido
  const visivel = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  function achar(passo) {
    let lista = [].concat(passo.alvo || []);
    if (celular() && passo.celular) lista = [].concat(passo.celular, lista);
    for (const sel of lista) {
      const el = $$(sel).find((e) => visivel(e) && (!celular() || !e.closest('#sb') || document.body.classList.contains('sb-open')));
      if (el) return el;
    }
    return null;
  }
  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function aguardarAlvo(passo, ms) {
    const fim = Date.now() + ms;
    for (;;) {
      const el = achar(passo);
      if (el || Date.now() > fim) return el;
      await esperar(120);
    }
  }
  const paginaAtual = () => (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';

  function montar() {
    const bloqueio = document.createElement('div');
    bloqueio.className = 'tour-bloqueio';
    const foco = document.createElement('div');
    foco.className = 'tour-foco';
    const balao = document.createElement('div');
    balao.className = 'tour-balao';
    balao.setAttribute('role', 'dialog');
    balao.setAttribute('aria-live', 'polite');
    balao.innerHTML = `<div class="tour-cab"><span class="tour-progresso" data-tour-progresso></span>
        <button class="det-close" type="button" data-tour="sair" title="Sair do tour (Esc)" aria-label="Sair do tour">${ico('x', 'i-sm')}</button></div>
      <h3 data-tour-titulo></h3><div class="tour-texto" data-tour-texto></div>
      <div class="tour-barra"><span data-tour-barra></span></div>
      <div class="tour-rodape">
        <button class="btn btn-sm" type="button" data-tour="voltar">${ico('arrow-left', 'i-sm')} Voltar</button>
        <button class="btn btn-primary btn-sm" type="button" data-tour="proximo">Próximo ${ico('arrow-right', 'i-sm')}</button>
      </div>`;
    document.body.append(bloqueio, foco, balao);
    balao.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tour]');
      if (!b || b.disabled) return;
      if (b.dataset.tour === 'sair') terminar(false);
      else if (b.dataset.tour === 'voltar') mostrar(atual.i - 1, -1);
      else if (b.dataset.tour === 'proximo') {
        if (atual.i >= atual.passos.length - 1) terminar(true); else mostrar(atual.i + 1, 1);
      }
    });
    return { bloqueio, foco, balao };
  }

  function posicionar() {
    if (!atual) return;
    const { foco, balao, bloqueio } = atual.els;
    const el = atual.alvo;
    const W = window.innerWidth;
    const A = window.innerHeight;
    const M = 12;
    if (!el || !el.isConnected) {
      foco.classList.add('oculto');
      bloqueio.classList.add('escuro');
      balao.classList.add('centro');
      balao.classList.remove('rodape-celular');
      balao.style.left = '';
      balao.style.top = '';
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad) };
    box.width = Math.min(W - 8, r.right + pad) - box.left;
    box.height = Math.min(A - 8, r.bottom + pad) - box.top;
    Object.assign(foco.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    foco.classList.remove('oculto');
    bloqueio.classList.remove('escuro');
    balao.classList.remove('centro');
    if (W < 640) { balao.classList.add('rodape-celular'); balao.style.left = ''; balao.style.top = ''; return; }
    balao.classList.remove('rodape-celular');
    const bw = balao.offsetWidth;
    const bh = balao.offsetHeight;
    let left;
    let top;
    if (box.top + box.height + M + bh <= A - M) { top = box.top + box.height + M; left = box.left; } else if (box.top - M - bh >= M) { top = box.top - M - bh; left = box.left; } else if (box.left + box.width + M + bw <= W - M) { left = box.left + box.width + M; top = box.top; } else if (box.left - M - bw >= M) { left = box.left - M - bw; top = box.top; } else { left = (W - bw) / 2; top = A - bh - M; }
    left = Math.max(M, Math.min(left, W - bw - M));
    top = Math.max(M, Math.min(top, A - bh - M));
    balao.style.left = `${left}px`;
    balao.style.top = `${top}px`;
  }
  let raf = 0;
  const reposicionar = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(posicionar); };

  async function mostrar(i, direcao) {
    if (!atual) return;
    const { passos } = atual;
    if (i < 0) i = 0;
    if (i >= passos.length) { terminar(true); return; }
    const passo = passos[i];
    const minha = ++atual.vez;
    // tela que esta pessoa não abre: pula o passo
    if (passo.pagina && !paginaPermitida(passo.pagina)) {
      if (direcao < 0 && i === 0) { mostrar(1, 1); return; }
      mostrar(i + (direcao < 0 ? -1 : 1), direcao);
      return;
    }
    atual.i = i;
    const { balao } = atual.els;
    balao.classList.add('trocando');
    // passos do menu no celular: abre o menu lateral; fora deles, fecha
    if (celular()) document.body.classList.toggle('sb-open', Boolean(passo.menu));
    if (passo.pagina && paginaAtual() !== passo.pagina) {
      navegar(passo.pagina);
      await esperar(300);
      if (!atual || minha !== atual.vez) return;
      if (celular()) document.body.classList.toggle('sb-open', Boolean(passo.menu));
    }
    const el = passo.alvo ? await aguardarAlvo(passo, passo.pagina ? 3500 : 800) : null;
    if (!atual || minha !== atual.vez) return;
    // o elemento não está na tela desta pessoa (ex.: filtro de grupo com um grupo só): pula o passo
    if (passo.alvo && !el) {
      const outro = i + (direcao < 0 ? -1 : 1);
      if (outro < 0) mostrar(i + 1, 1);
      else if (outro >= passos.length) terminar(true);
      else mostrar(outro, direcao);
      return;
    }
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 20) {
        el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: 'smooth' });
        await esperar(380);
        if (!atual || minha !== atual.vez) return;
      }
    }
    atual.alvo = el;
    $('[data-tour-progresso]', balao).textContent = `${i + 1} de ${passos.length}`;
    $('[data-tour-titulo]', balao).textContent = passo.titulo || '';
    $('[data-tour-texto]', balao).innerHTML = (Array.isArray(passo.texto) ? passo.texto : [passo.texto || '']).map((t) => `<p>${fmt(t)}</p>`).join('');
    $('[data-tour-barra]', balao).style.width = `${Math.round(((i + 1) / passos.length) * 100)}%`;
    $('[data-tour="voltar"]', balao).disabled = i === 0;
    const prox = $('[data-tour="proximo"]', balao);
    prox.innerHTML = i === passos.length - 1 ? `${ico('check', 'i-sm')} Concluir` : `Próximo ${ico('arrow-right', 'i-sm')}`;
    balao.classList.remove('trocando');
    posicionar();
    prox.focus({ preventScroll: true });
    // a tela pode terminar de montar depois (listas que carregam, mapa): acompanha o elemento por mais um pouco
    [150, 400, 900, 1600].forEach((ms) => setTimeout(() => { if (atual && minha === atual.vez) posicionar(); }, ms));
  }

  function tecla(ev) {
    if (!atual) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); terminar(false); } else if (ev.key === 'ArrowRight' || (ev.key === 'Enter' && ev.target.closest('.tour-balao'))) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Enter' && ev.target.matches('[data-tour]') && ev.target.dataset.tour !== 'proximo') { ev.target.click(); return; }
      if (atual.i >= atual.passos.length - 1) terminar(true); else mostrar(atual.i + 1, 1);
    } else if (ev.key === 'ArrowLeft' && atual.i > 0) { ev.preventDefault(); ev.stopPropagation(); mostrar(atual.i - 1, -1); } else if (ev.key === ' ') ev.stopPropagation(); // a barra de espaço não reproduz o trajeto atrás do tour
  }

  function terminar(concluiu) {
    if (!atual) return;
    const { els, opcoes } = atual;
    atual = null;
    Object.values(els).forEach((e) => e.remove());
    document.removeEventListener('keydown', tecla, true);
    window.removeEventListener('resize', reposicionar);
    window.removeEventListener('scroll', reposicionar, true);
    document.body.classList.remove('em-tour');
    if (celular()) document.body.classList.remove('sb-open');
    if (opcoes.aoTerminar) opcoes.aoTerminar(concluiu);
  }

  return {
    get ativo() { return Boolean(atual); },
    iniciar(passos, opcoes) {
      if (atual) terminar(false);
      const lista = (passos || []).filter(Boolean);
      if (!lista.length) return;
      $$('.modal-back').forEach((m) => m.remove());
      atual = { passos: lista, i: 0, vez: 0, opcoes: opcoes || {}, els: montar(), alvo: null };
      document.body.classList.add('em-tour');
      document.addEventListener('keydown', tecla, true);
      window.addEventListener('resize', reposicionar);
      window.addEventListener('scroll', reposicionar, true);
      mostrar(0, 1);
    },
    sair() { terminar(false); },
  };
})();

/** A pessoa abre esta tela? (o tour pula as que não abre; o guia esconde os artigos delas) */
function paginaPermitida(id) {
  if (!PAGINAS[id]) return false;
  if (id === 'guia') return true;
  const nav = [NAV_TOPO, ...NAV.flatMap((g) => g.itens)].find((i) => i.id === id);
  if (nav) return podeVer(nav);
  return !PAGINAS[id].tela || podeTela(PAGINAS[id].tela);
}
/** Nome da tela como aparece no menu. */
function nomeDaTela(id) {
  const nav = [NAV_TOPO, ...NAV.flatMap((g) => g.itens)].find((i) => i.id === id);
  return nav ? nav.nome : (PAGINAS[id] ? PAGINAS[id].titulo : id);
}
