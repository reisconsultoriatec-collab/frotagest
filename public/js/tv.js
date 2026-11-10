'use strict';
/* FrotaGest — Modo TV da central: tela cheia para o monitor da parede, com o mapa grande, a frota
 * agora, as garagens, os alertas pendentes em destaque e a troca automática entre os grupos.
 * A sessão não encerra por falta de uso e a tela não apaga (quando o navegador deixa). Reis Tecnologia */

PAGINAS.tv = (() => {
  let mapa = null;
  let marcadores = new Map();
  let camadaCercas = null;
  let offs = [];
  let timers = [];
  let visoes = [];
  let iVisao = 0;
  let proxTroca = 0;
  let travaTela = null;
  let redesenho = null;
  let alertasTimer = null;
  let piscaTimer = null;
  let ociosoTimer = null;
  const INTERVALOS = [{ v: 0, t: 'Não trocar' }, { v: 30, t: 'A cada 30 s' }, { v: 60, t: 'A cada 1 min' }, { v: 120, t: 'A cada 2 min' }, { v: 300, t: 'A cada 5 min' }];

  const intervalo = () => Number(pref('tvTroca', 60));
  const gruposEscolhidos = () => pref('tvGrupos', null); // null = os grupos principais

  function render(c) {
    document.body.classList.add('modo-tv');
    c.innerHTML = `
      <div class="tv" id="tv">
        <header class="tv-topo">
          <div class="tv-marca"><span class="tv-logo">${ico('bus')}</span><div><b>FrotaGest</b><small id="tv-empresa"></small></div><span class="tv-cliente" id="tv-cliente" hidden><img alt=""></span></div>
          <div class="tv-visao"><span class="tv-visao-nome" id="tv-visao"></span><span class="tv-pontos" id="tv-pontos"></span><span class="tv-barra"><i id="tv-barra"></i></span></div>
          <div class="tv-status"><span class="dot" id="tv-dot"></span><span id="tv-dot-txt"></span></div>
          <div class="tv-relogio"><b id="tv-hora"></b><small id="tv-data"></small></div>
          <div class="tv-ctrl">
            <button type="button" id="tv-cheia" title="Tela cheia (F)" aria-label="Tela cheia">${ico('arrows-maximize')}</button>
            <button type="button" id="tv-ajustes" title="Ajustes do modo TV" aria-label="Ajustes">${ico('settings')}</button>
            <button type="button" id="tv-sair" title="Sair do modo TV" aria-label="Sair do modo TV">${ico('x')}</button>
          </div>
          <div class="tv-pop" id="tv-pop" hidden></div>
        </header>
        <div class="tv-corpo">
          <section class="tv-mapa"><div id="tv-map"></div></section>
          <aside class="tv-lado">
            <div class="tv-bloco"><h3>Frota agora</h3><div class="tv-kpis" id="tv-kpis"></div></div>
            <div class="tv-bloco" id="tv-gar-bloco" hidden><h3>Garagens <small>veículos dentro</small></h3><div class="tv-gar" id="tv-gar"></div></div>
            <div class="tv-bloco tv-al-bloco" ${podeTela('alertas') ? '' : 'hidden'}><h3>Alertas pendentes <span class="tv-al-n" id="tv-al-n"></span></h3><div class="tv-al" id="tv-al"></div></div>
          </aside>
        </div>
      </div>`;

    mapa = criarMapa($('#tv-map'));
    if (mapa) {
      mapa.on('zoomend', rotulos);
      const at = mapa.attributionControl;
      if (at) at.setPrefix(false);
    }
    $('#tv-empresa').textContent = S.eu.empresaNome || (S.empresa ? (S.empresas.find((e) => String(e.id) === String(S.empresa)) || {}).nome : 'Todas as empresas') || '';
    // logotipo da empresa cliente ao lado da marca
    logoDaEmpresa(empresaDoLogo()).then((l) => {
      const box = $('#tv-cliente');
      if (!box || !l) return;
      box.querySelector('img').src = l.png;
      box.hidden = false;
    });
    $('#tv-sair').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); navegar('inicio'); });
    $('#tv-cheia').addEventListener('click', telaCheia);
    $('#tv-ajustes').addEventListener('click', ajustes);
    const teclas = (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === 'f' || e.key === 'F') telaCheia();
      if (e.key === 'ArrowRight') irPara(iVisao + 1);
      if (e.key === 'ArrowLeft') irPara(iVisao - 1);
    };
    document.addEventListener('keydown', teclas);
    offs.push(() => document.removeEventListener('keydown', teclas));
    const mexeu = () => {
      $('#tv').classList.remove('ocioso');
      clearTimeout(ociosoTimer);
      ociosoTimer = setTimeout(() => { const t = $('#tv'); if (t && $('#tv-pop').hidden) t.classList.add('ocioso'); }, 4000);
    };
    // mouse, toque ou tecla: os botões voltam a aparecer (somem de novo depois de 4 s parado)
    for (const ev of ['mousemove', 'pointerdown', 'keydown']) {
      document.addEventListener(ev, mexeu);
      offs.push(() => document.removeEventListener(ev, mexeu));
    }
    mexeu();
    const fs = () => { $('#tv-cheia').innerHTML = ico(document.fullscreenElement ? 'arrows-minimize' : 'arrows-maximize'); if (mapa) setTimeout(() => mapa.invalidateSize(), 200); };
    document.addEventListener('fullscreenchange', fs);
    offs.push(() => document.removeEventListener('fullscreenchange', fs));

    montarVisoes();
    irPara(0);
    relogio();
    timers.push(setInterval(relogio, 1000));
    carregarAlertas();
    timers.push(setInterval(carregarAlertas, 60000));
    carregarGaragens();
    manterTelaAcesa();
    offs.push(on('item', agendar));
    offs.push(on('frota', () => { montarVisoes(); desenhar(false); }));
    offs.push(on('alerta', (m) => {
      clearTimeout(alertasTimer);
      alertasTimer = setTimeout(carregarAlertas, 600);
      if (m.acao === 'novo') piscar(m.alerta);
    }));
    offs.push(on('cerca', () => desenharGaragens()));
    offs.push(on('cercas', carregarGaragens));
  }

  function sair() {
    document.body.classList.remove('modo-tv');
    offs.forEach((o) => o());
    offs = [];
    timers.forEach((t) => clearInterval(t));
    timers = [];
    [redesenho, alertasTimer, piscaTimer, ociosoTimer].forEach((t) => clearTimeout(t));
    redesenho = null;
    if (travaTela) { travaTela.release().catch(() => {}); travaTela = null; }
    if (mapa) mapa.remove();
    mapa = null;
    marcadores = new Map();
    camadaCercas = null;
  }

  /* ---------- tela cheia e tela acesa ---------- */

  function telaCheia() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('O navegador não deixou abrir em tela cheia. Use a tecla F11.'));
  }

  async function manterTelaAcesa() {
    if (!('wakeLock' in navigator)) return;
    try {
      travaTela = await navigator.wakeLock.request('screen');
      travaTela.addEventListener('release', () => { travaTela = null; });
    } catch { /* aba em segundo plano ou navegador sem permissão */ }
    // a trava cai quando a aba sai da frente: pede de novo quando volta
    if (!offs.some((o) => o.tela)) {
      const voltou = () => { if (document.visibilityState === 'visible' && !travaTela && mapa) manterTelaAcesa(); };
      document.addEventListener('visibilitychange', voltou);
      const off = () => document.removeEventListener('visibilitychange', voltou);
      off.tela = true;
      offs.push(off);
    }
  }

  /* ---------- visões (toda a frota e os grupos, em rodízio) ---------- */

  function montarVisoes() {
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    const escolhidos = gruposEscolhidos();
    const usados = escolhidos ? grupos.filter((g) => escolhidos.includes(g.id)) : grupos.filter((g) => !g.paiId);
    const atual = visoes[iVisao] ? visoes[iVisao].id : 'todos';
    visoes = [{ id: 'todos', nome: 'Toda a frota', grupos: null }];
    for (const g of usados) {
      const ids = descendentesGrupo(g.id);
      if (itensVisiveis().some((i) => ids.has(i.grupoId) && temPosicao(i))) visoes.push({ id: g.id, nome: g.caminho, grupos: ids });
    }
    iVisao = Math.max(0, visoes.findIndex((v) => v.id === atual));
  }

  function irPara(i) {
    if (!visoes.length) return;
    iVisao = ((i % visoes.length) + visoes.length) % visoes.length;
    proxTroca = Date.now() + intervalo() * 1000;
    const v = visoes[iVisao];
    $('#tv-visao').textContent = v.nome;
    $('#tv-pontos').innerHTML = visoes.length > 1 ? visoes.map((x, k) => `<i class="${k === iVisao ? 'on' : ''}"></i>`).join('') : '';
    desenhar(true);
  }

  const daVisao = (i) => {
    const v = visoes[iVisao];
    return !i.pendente && (!v || !v.grupos || v.grupos.has(i.grupoId));
  };

  /* ---------- mapa ---------- */

  function agendar() {
    if (redesenho) return;
    redesenho = setTimeout(() => { redesenho = null; desenhar(false); }, 1000);
  }

  function classe(i) {
    if (i.alertas.length) return 'alerta';
    if (!i.online) return '';
    return i.posicao && i.posicao.vel > 3 ? 'mov' : 'on';
  }

  function icone(i) {
    const dir = i.posicao ? Number(i.posicao.dir) || 0 : 0;
    return L.divIcon({
      className: '',
      html: `<div class="vpin ${classe(i)}"><div class="seta"><svg viewBox="0 0 24 24" style="transform:rotate(${dir}deg)"><path d="M12 2.5l6.5 17-6.5-3.6-6.5 3.6z" fill="currentColor"/></svg></div></div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  function desenhar(enquadrar) {
    const itens = itensVisiveis().filter(daVisao);
    kpis(itens);
    if (!mapa) return;
    const vis = new Set();
    const pts = [];
    for (const i of itens) {
      if (!temPosicao(i)) continue;
      vis.add(i.chave);
      const ll = [i.posicao.lat, i.posicao.lng];
      pts.push(ll);
      let m = marcadores.get(i.chave);
      const html = `${classe(i)}|${Math.round(Number(i.posicao.dir) || 0)}`;
      if (!m) {
        m = L.marker(ll, { icon: icone(i), keyboard: false, zIndexOffset: i.alertas.length ? 1000 : 0 }).addTo(mapa);
        m.bindTooltip(H(rotuloCurto(i)), { permanent: true, direction: 'bottom', offset: [0, 13], className: 'vlabel' });
        m._fg = html;
        marcadores.set(i.chave, m);
      } else {
        m.setLatLng(ll);
        if (m._fg !== html) { m.setIcon(icone(i)); m._fg = html; m.setZIndexOffset(i.alertas.length ? 1000 : 0); }
      }
    }
    for (const [k, m] of marcadores) if (!vis.has(k)) { m.remove(); marcadores.delete(k); }
    if (enquadrar) {
      if (pts.length === 1) mapa.setView(pts[0], 15);
      else if (pts.length) mapa.fitBounds(pts, { padding: [50, 50], maxZoom: 15 });
    }
    rotulos();
  }

  function rotulos() {
    const t = $('#tv');
    if (t && mapa) t.classList.toggle('sem-rotulos', mapa.getZoom() < 12 || (marcadores.size > 150 && mapa.getZoom() < 14));
  }

  function kpis(itens) {
    const l = itens.filter((i) => !i.semAparelho);
    const on = l.filter((i) => i.online);
    const mov = on.filter((i) => i.posicao && i.posicao.vel > 3).length;
    const al = l.filter((i) => i.alertas.length).length;
    const k = (cls, n, rot) => `<div class="tv-kpi ${cls}"><b>${fmtNum(n)}</b><span>${H(rot)}</span></div>`;
    $('#tv-kpis').innerHTML = [
      k('ok', mov, 'em movimento'),
      k('info', on.length - mov, 'parados'),
      k('', l.length - on.length, 'offline'),
      k(al ? 'err' : '', al, 'com alerta'),
    ].join('');
  }

  /* ---------- garagens ---------- */

  async function carregarGaragens() {
    try { await carregarCercas(true); } catch { return; }
    desenharGaragens();
    if (!mapa) return;
    if (camadaCercas) camadaCercas.remove();
    camadaCercas = L.layerGroup((S.cercas || []).filter((c) => c.ativo).map((c) => camadaCerca(c, { fraco: true }))).addTo(mapa);
  }

  function desenharGaragens() {
    const box = $('#tv-gar');
    if (!box) return;
    const gar = (S.cercas || []).filter((c) => c.ativo && c.finalidade === 'garagem');
    $('#tv-gar-bloco').hidden = !gar.length;
    box.innerHTML = gar.slice(0, 6).map((c) => `<div class="tv-gar-l"><span>${ico('building-warehouse', 'i-sm')} ${H(c.nome)}</span><b>${c.dentro.length}</b></div>`).join('');
  }

  /* ---------- alertas ---------- */

  async function carregarAlertas() {
    if (!podeTela('alertas')) return; // sem o menu Alertas no Controle de acesso, a TV mostra só a frota
    try {
      const r = await api(`/api/alertas?${qs({ situacao: 'pendentes', limite: 12, empresa: S.empresa })}`);
      const box = $('#tv-al');
      if (!box) return;
      $('#tv-al-n').textContent = r.total ? fmtNum(r.total) : '';
      $('#tv-al-n').className = `tv-al-n${r.alertas.some((a) => a.gravidade === 'alta') ? ' err' : ''}`;
      box.innerHTML = r.alertas.length ? r.alertas.map((a) => `
        <div class="tv-al-l ${a.gravidade}${a.situacao === 'novo' ? ' novo' : ''}" data-id="${a.id}">
          <span class="tv-al-h">${H(fmtCurto(a.inicio).slice(0, 5))}</span>
          <span class="tv-al-t"><b>${H(a.prefixo ? `${a.prefixo} · ${a.placa}` : a.placa || a.identificador)}</b><small>${H(a.nome)}</small></span>
          ${a.situacao === 'em_tratamento' ? '<span class="tv-al-s">em tratamento</span>' : ''}
        </div>`).join('') : `<div class="tv-vazio">${ico('check')} Nenhum alerta pendente</div>`;
    } catch { /* tenta de novo no próximo */ }
  }

  function piscar(alerta) {
    const t = $('#tv');
    if (!t) return;
    t.classList.remove('pisca', 'pisca-alta');
    void t.offsetWidth; // recomeça a animação
    t.classList.add(alerta && alerta.gravidade === 'alta' ? 'pisca-alta' : 'pisca');
    clearTimeout(piscaTimer);
    piscaTimer = setTimeout(() => t.classList.remove('pisca', 'pisca-alta'), 9000);
  }

  /* ---------- relógio, rodízio e conexão ---------- */

  function relogio() {
    const h = $('#tv-hora');
    if (!h) return;
    const agora = textoServidor();
    h.textContent = agora.slice(11, 19);
    const d = new Date(`${agora.slice(0, 10)}T12:00:00`);
    $('#tv-data').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    $('#tv-dot').className = `dot ${S.conectado ? 'on' : 'off'}`;
    $('#tv-dot-txt').textContent = S.conectado ? 'ao vivo' : 'reconectando';
    const seg = intervalo();
    const barra = $('#tv-barra');
    if (seg && visoes.length > 1) {
      const resta = Math.max(0, proxTroca - Date.now());
      barra.style.width = `${100 - (resta / (seg * 1000)) * 100}%`;
      barra.parentElement.hidden = false;
      if (resta <= 0) irPara(iVisao + 1);
    } else barra.parentElement.hidden = true;
  }

  function ajustes() {
    const pop = $('#tv-pop');
    if (!pop.hidden) { pop.hidden = true; return; }
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    const esc = gruposEscolhidos();
    const marcado = (g) => (esc ? esc.includes(g.id) : !g.paiId);
    pop.innerHTML = `
      <label class="field">Trocar de grupo<select id="tv-troca">${INTERVALOS.map((x) => `<option value="${x.v}"${x.v === intervalo() ? ' selected' : ''}>${x.t}</option>`).join('')}</select></label>
      ${grupos.length ? `<div class="field">Grupos no rodízio<div class="tv-pop-grupos">${grupos.map((g) => `<label><input type="checkbox" value="${g.id}"${marcado(g) ? ' checked' : ''}> ${H(g.caminho)}</label>`).join('')}</div></div>` : '<p class="hint" style="margin:0">Sem grupos cadastrados: o modo TV mostra toda a frota.</p>'}
      <p class="hint" style="margin:0">Teclas: F tela cheia · ← → troca o grupo.</p>`;
    pop.hidden = false;
    pop.querySelector('#tv-troca').addEventListener('change', (e) => { salvarPref('tvTroca', Number(e.target.value)); proxTroca = Date.now() + intervalo() * 1000; });
    pop.querySelectorAll('.tv-pop-grupos input').forEach((x) => x.addEventListener('change', () => {
      salvarPref('tvGrupos', $$('.tv-pop-grupos input:checked', pop).map((y) => Number(y.value)));
      montarVisoes();
      irPara(iVisao);
    }));
    const fora = (e) => {
      if (e.target.closest('#tv-pop, #tv-ajustes')) return;
      pop.hidden = true;
      document.removeEventListener('mousedown', fora);
    };
    setTimeout(() => document.addEventListener('mousedown', fora), 0);
  }

  return { id: 'tv', titulo: 'Modo TV', sub: 'Tela da central', cheia: true, render, sair };
})();
