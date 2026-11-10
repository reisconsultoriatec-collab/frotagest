'use strict';
/* FrotaGest — Monitoramento: lista da frota, mapa ao vivo, detalhes do veículo e câmeras. Reis Tecnologia */

const CAMADAS = {
  osm: {
    nome: 'Ruas · OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, className: 'camada-ruas', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
  },
  esri: {
    nome: 'Ruas · Esri',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, className: 'camada-ruas', attribution: 'Mapa &copy; Esri' },
  },
  satelite: {
    nome: 'Satélite · Esri',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics' },
  },
};

/** Mapa Leaflet com troca de camada (lembrada) e troca automática se o OpenStreetMap não responder. */
function criarMapa(el) {
  if (!window.L) {
    el.innerHTML = '<div class="map-fallback">Mapa indisponível: a biblioteca não carregou (rode "npm install" no servidor).</div>';
    return null;
  }
  const mapa = L.map(el, { zoomControl: true, attributionControl: true }).setView([-15.8, -47.9], 4);
  const camadas = {};
  const porNome = {};
  for (const [id, d] of Object.entries(CAMADAS)) {
    camadas[id] = L.tileLayer(d.url, d.opts);
    porNome[d.nome] = camadas[id];
  }
  let atual = CAMADAS[pref('camada', 'osm')] ? pref('camada', 'osm') : 'osm';
  camadas[atual].addTo(mapa);
  L.control.layers(porNome, null, { position: 'topleft' }).addTo(mapa);
  mapa.on('baselayerchange', (e) => {
    atual = Object.keys(camadas).find((id) => camadas[id] === e.layer) || atual;
    salvarPref('camada', atual);
  });
  let falhas = 0;
  camadas.osm.on('tileerror', () => {
    falhas++;
    if (falhas !== 6 || atual !== 'osm') return;
    mapa.removeLayer(camadas.osm);
    camadas.esri.addTo(mapa);
    toast('O OpenStreetMap não respondeu; o mapa passou para a Esri.');
  });
  return mapa;
}

const temPosicao = (i) => i && i.posicao && Number.isFinite(i.posicao.lat) && (Math.abs(i.posicao.lat) > 0.0001 || Math.abs(i.posicao.lng) > 0.0001);
const rotuloCurto = (i) => (i.pendente ? i.ident : i.prefixo || i.placa || i.ident);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function descendentesGrupo(id) {
  const out = new Set([Number(id)]);
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const g of S.grupos) if (g.paiId && out.has(g.paiId) && !out.has(g.id)) { out.add(g.id); mudou = true; }
  }
  return out;
}

PAGINAS.mapa = (() => {
  let mapa = null;
  let marcadores = new Map();
  let selecionado = null;
  let rastro = null;
  let mosaico = null;
  let offs = [];
  let relogio = null;
  let ajustou = false;
  let redesenho = null;
  let camadaGrupos = null; // bolinhas com o número de veículos próximos
  let gruposAtuais = new Map(); // membros → marcador da bolinha (reaproveitado entre atualizações)
  let agrupaTimer = null;
  let camadaCercas = null; // garagens, pontos e áreas (botão "Cercas")
  const filtros = { busca: '', status: 'todos', grupo: '' };
  const ZOOM_PERTO = 17; // daqui para dentro só junta quem está praticamente no mesmo lugar

  function filtrados() {
    const q = norm(filtros.busca);
    const grupos = filtros.grupo ? descendentesGrupo(filtros.grupo) : null;
    return itensVisiveis().filter((i) => {
      if (filtros.status === 'online' && !i.online) return false;
      if (filtros.status === 'offline' && (i.online || i.pendente)) return false;
      if (filtros.status === 'alerta' && !i.alertas.length) return false;
      if (grupos && !grupos.has(i.grupoId)) return false;
      if (q && !norm([i.placa, i.prefixo, i.ident, i.descricao, i.grupo, i.empresa].join(' ')).includes(q)) return false;
      return true;
    }).sort((a, b) => (b.pendente - a.pendente) || rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
  }

  function render(c, params) {
    filtros.status = pref('filtroStatus', 'todos');
    c.innerHTML = `
      <div class="mon">
        <section class="card fleet">
          <div class="fleet-head">
            <label class="search">${ico('search', 'i-sm')}<input id="f-busca" placeholder="Placa, prefixo ou nº do aparelho" autocomplete="off"></label>
            <div class="seg" id="f-status">
              <button class="seg-btn" data-st="todos" type="button">Todos <span></span></button>
              <button class="seg-btn" data-st="online" type="button">Online <span></span></button>
              <button class="seg-btn" data-st="offline" type="button">Offline <span></span></button>
              <button class="seg-btn" data-st="alerta" type="button">Alerta <span></span></button>
            </div>
            <select id="f-grupo" aria-label="Grupo"></select>
          </div>
          <div class="fleet-list" id="f-lista"></div>
        </section>
        <section class="card map-card" id="map-card">
          <div id="map"></div>
          <div class="legend-map"><span><i style="background:var(--ok)"></i>Em movimento</span><span><i style="background:var(--info)"></i>Parado</span><span><i style="background:#64748B"></i>Offline</span><span><i style="background:var(--err)"></i>Alerta</span></div>
          <div class="card map-detail" id="detalhe" hidden></div>
        </section>
      </div>
      <section class="card cams" id="cams" hidden>
        <div class="card-head">
          <h2>${ico('video')} Câmeras ao vivo <span class="pill" id="cams-n">0</span></h2>
          <div class="card-actions">
            <div class="seg" title="Qualidade pedida ao DVR"><button class="seg-btn" data-fluxo="1" type="button">Secundário (leve)</button><button class="seg-btn" data-fluxo="0" type="button">Principal (HD)</button></div>
            <div class="seg" title="Vídeo H.265"><button class="seg-btn" data-conv="1" type="button">Converter H.265</button><button class="seg-btn" data-conv="0" type="button">Direto</button></div>
            <button class="btn btn-sm" id="cams-fechar" type="button">${ico('x', 'i-sm')} Fechar todas</button>
          </div>
        </div>
        <div class="tiles" id="cams-tiles"></div>
      </section>`;

    const busca = $('#f-busca');
    busca.value = filtros.busca;
    busca.addEventListener('input', () => { filtros.busca = busca.value; desenharTudo(); });
    $('#f-status').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]');
      if (!b) return;
      filtros.status = b.dataset.st;
      salvarPref('filtroStatus', filtros.status);
      desenharTudo();
    });
    $('#f-grupo').addEventListener('change', (e) => { filtros.grupo = e.target.value; desenharTudo(); });
    $('#f-lista').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) selecionar(b.dataset.k, true);
    });

    mosaico = new Mosaico($('#cams-tiles'), atualizarCams);
    $('#cams').addEventListener('click', (e) => {
      const f = e.target.closest('[data-fluxo]');
      const v = e.target.closest('[data-conv]');
      if (f) { salvarPref('fluxo', Number(f.dataset.fluxo)); mosaico.reabrirTodos({ fluxo: Number(f.dataset.fluxo) }); atualizarCams(); }
      if (v) { salvarPref('conv', v.dataset.conv); mosaico.reabrirTodos({ conv: v.dataset.conv }); atualizarCams(); }
    });
    $('#cams-fechar').addEventListener('click', () => mosaico.fecharTodos());

    mapa = criarMapa($('#map'));
    if (mapa) {
      camadaGrupos = L.layerGroup().addTo(mapa);
      gruposAtuais = new Map();
      mapa.on('zoomend', () => agrupar());
      botaoAgrupar();
      botaoCercas();
      rotulos();
      desenharCercas();
    }
    ajustou = false;
    desenharTudo();
    offs.push(on('frota', () => { desenharTudo(); if (selecionado) desenharDetalhe(); }));
    offs.push(on('item', (it) => {
      atualizarMarcador(it);
      if (it.chave === selecionado) { desenharDetalhe(); estenderRastro(it); }
      agendarLista();
    }));
    offs.push(on('cercas', desenharCercas));
    offs.push(on('empresa', () => { S.cercas = null; }));
    relogio = setInterval(() => { agendarLista(); if (selecionado) desenharDetalhe(); }, 15000);
    if (params.v) selecionar(params.v, true);
  }

  function sair() {
    offs.forEach((f) => f());
    offs = [];
    clearInterval(relogio);
    clearTimeout(redesenho);
    if (mosaico) mosaico.fecharTodos();
    clearTimeout(agrupaTimer);
    agrupaTimer = null;
    if (mapa) mapa.remove();
    mapa = null;
    camadaGrupos = null;
    camadaCercas = null;
    gruposAtuais = new Map();
    marcadores = new Map();
    rastro = null;
    selecionado = null;
  }

  function agendarLista() {
    if (redesenho) return;
    redesenho = setTimeout(() => { redesenho = null; desenharLista(); }, 800);
  }

  function desenharTudo() {
    desenharGrupos();
    desenharLista();
    desenharMarcadores();
  }

  function desenharGrupos() {
    const sel = $('#f-grupo');
    if (!sel) return;
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    sel.innerHTML = `<option value="">Todos os grupos</option>${grupos.map((g) => `<option value="${g.id}" ${String(g.id) === filtros.grupo ? 'selected' : ''}>${H(g.caminho)}</option>`).join('')}`;
    sel.hidden = !grupos.length;
  }

  function desenharLista() {
    const lista = $('#f-lista');
    if (!lista) return;
    const todos = itensVisiveis();
    const cont = { todos: todos.length, online: todos.filter((i) => i.online).length, offline: todos.filter((i) => !i.online && !i.pendente).length, alerta: todos.filter((i) => i.alertas.length).length };
    $$('#f-status [data-st]').forEach((b) => {
      b.classList.toggle('active', b.dataset.st === filtros.status);
      b.querySelector('span').textContent = cont[b.dataset.st];
    });
    const itens = filtrados();
    if (!itens.length) {
      lista.innerHTML = `<div class="fleet-empty">${todos.length ? 'Nenhum veículo com esse filtro.' : 'Nenhum veículo cadastrado ainda.'}</div>`;
      return;
    }
    lista.innerHTML = itens.map(htmlItem).join('');
  }

  function htmlItem(i) {
    const dot = i.pendente ? 'wait' : i.online ? 'on' : i.semAparelho ? '' : 'off';
    let sub;
    if (i.pendente) sub = 'Sem cadastro — clique para cadastrar';
    else if (i.semAparelho) sub = 'Sem aparelho instalado';
    else if (!i.veiculoId) sub = 'Aparelho ainda sem veículo';
    else sub = [i.grupo, i.descricao].filter(Boolean).join(' · ') || `Aparelho ${i.ident}`;
    if (S.eu.perfil === 'master' && !S.empresa && i.empresa) sub = `${i.empresa} · ${sub}`;
    const meta = i.online ? (i.posicao ? `${Math.round(i.posicao.vel)} km/h` : 'online') : i.ultimoContato ? atras(i.ultimoContato) : (i.semAparelho ? '' : 'nunca conectou');
    return `<button class="fi${i.chave === selecionado ? ' sel' : ''}" data-k="${H(i.chave)}" type="button">
      <span class="dot ${dot}"></span>
      <span class="fi-main"><b>${H(rotulo(i))}</b><small>${H(sub)}</small></span>
      <span class="fi-meta">${i.alertas.length ? ico('alert-triangle') : ''}<span class="fi-vel">${H(meta)}</span></span>
    </button>`;
  }

  /* ---------- mapa ---------- */

  function classeDe(i) {
    if (i.pendente) return 'pend';
    if (i.alertas.length) return 'alerta';
    if (!i.online) return '';
    return i.posicao && i.posicao.vel > 3 ? 'mov' : 'on';
  }

  function iconeDe(i) {
    const dir = i.posicao ? Number(i.posicao.dir) || 0 : 0;
    return L.divIcon({
      className: '',
      html: `<div class="vpin ${classeDe(i)}${i.chave === selecionado ? ' sel' : ''}"><div class="seta"><svg viewBox="0 0 24 24" style="transform:rotate(${dir}deg)"><path d="M12 2.5l6.5 17-6.5-3.6-6.5 3.6z" fill="currentColor"/></svg></div></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  function desenharMarcadores() {
    if (!mapa) return;
    const visiveis = new Set();
    const pontos = [];
    for (const i of filtrados()) {
      if (!temPosicao(i)) continue;
      visiveis.add(i.chave);
      pontos.push([i.posicao.lat, i.posicao.lng]);
      atualizarMarcador(i, true);
    }
    for (const [k, m] of marcadores) if (!visiveis.has(k)) { m.remove(); marcadores.delete(k); }
    agrupar();
    if (!ajustou && pontos.length) {
      ajustou = true;
      if (pontos.length === 1) mapa.setView(pontos[0], 15);
      else mapa.fitBounds(pontos, { padding: [40, 40], maxZoom: 15 });
    }
  }

  function atualizarMarcador(i, jaFiltrado = false) {
    if (!mapa) return;
    let m = marcadores.get(i.chave);
    const mostra = temPosicao(i) && (jaFiltrado || filtrados().some((x) => x.chave === i.chave));
    if (!mostra) {
      if (m) { m.remove(); marcadores.delete(i.chave); agendarAgrupar(); }
      return;
    }
    const ll = [i.posicao.lat, i.posicao.lng];
    if (!m) {
      // o marcador só entra no mapa pelo agrupar() (pode ficar dentro de uma bolinha)
      m = L.marker(ll, { icon: iconeDe(i), title: rotulo(i), zIndexOffset: i.alertas.length ? 1000 : 0 });
      m.bindTooltip(H(rotuloCurto(i)), { permanent: true, direction: 'bottom', offset: [0, 13], className: 'vlabel' });
      m.on('click', () => selecionar(i.chave, false));
      marcadores.set(i.chave, m);
      if (!jaFiltrado) agrupar();
    } else {
      m.setLatLng(ll);
      m.setIcon(iconeDe(i));
      m.setZIndexOffset(i.alertas.length ? 1000 : 0);
      if (!jaFiltrado) agendarAgrupar();
    }
  }

  function rotulos() {
    const card = $('#map-card');
    if (!card || !mapa) return;
    let naTela = 0;
    marcadores.forEach((m) => { if (mapa.hasLayer(m)) naTela++; });
    card.classList.toggle('sem-rotulos', mapa.getZoom() < 11 || (naTela > 150 && mapa.getZoom() < 13));
  }

  /* ---------- veículos próximos agrupados ---------- */
  // Com centenas de veículos, os que estão perto uns dos outros na tela viram uma bolinha com o
  // número (cor pela situação: alerta, em movimento, parado, offline). Clicar aproxima; se estão
  // todos no mesmo lugar (garagem), abre a lista para escolher. O veículo selecionado nunca entra.

  const agrupando = () => pref('agruparMapa', true);

  function agendarAgrupar() {
    if (agrupaTimer) return;
    agrupaTimer = setTimeout(() => { agrupaTimer = null; agrupar(); }, 1500);
  }

  function agrupar() {
    clearTimeout(agrupaTimer);
    agrupaTimer = null;
    if (!mapa || !camadaGrupos) return;
    const z = mapa.getZoom();
    const raio = z >= ZOOM_PERTO ? 14 : 56;
    const lista = [];
    for (const [k, m] of marcadores) lista.push({ k, m, i: S.itens.get(k), p: mapa.project(m.getLatLng(), z) });
    // alertas primeiro: a bolinha nasce em cima de quem precisa de atenção
    lista.sort((a, b) => ((b.i && b.i.alertas.length) ? 1 : 0) - ((a.i && a.i.alertas.length) ? 1 : 0));
    const usados = new Set();
    const grupos = [];
    if (agrupando()) {
      for (const a of lista) {
        if (usados.has(a.k) || a.k === selecionado) continue;
        const membros = [a];
        for (const b of lista) {
          if (b === a || usados.has(b.k) || b.k === selecionado) continue;
          if (Math.abs(b.p.x - a.p.x) <= raio && Math.abs(b.p.y - a.p.y) <= raio) membros.push(b);
        }
        if (membros.length < 2) continue;
        membros.forEach((x) => usados.add(x.k));
        grupos.push(membros);
      }
    }
    for (const a of lista) {
      const dentro = usados.has(a.k);
      if (dentro && mapa.hasLayer(a.m)) a.m.remove();
      if (!dentro && !mapa.hasLayer(a.m)) a.m.addTo(mapa);
    }
    const novos = new Map();
    for (const g of grupos) {
      const chave = g.map((x) => x.k).sort().join(',');
      const lat = g.reduce((t, x) => t + x.m.getLatLng().lat, 0) / g.length;
      const lng = g.reduce((t, x) => t + x.m.getLatLng().lng, 0) / g.length;
      const html = htmlGrupo(g);
      let mk = gruposAtuais.get(chave);
      if (mk) {
        gruposAtuais.delete(chave);
        mk.setLatLng([lat, lng]);
        if (mk._fgHtml !== html.html) { mk.setIcon(html.icone); mk._fgHtml = html.html; mk.setTooltipContent(html.dica); }
      } else {
        mk = L.marker([lat, lng], { icon: html.icone, zIndexOffset: html.alerta ? 900 : 500, keyboard: true, title: html.dica });
        mk._fgHtml = html.html;
        mk.bindTooltip(html.dica, { direction: 'top', offset: [0, -html.tam / 2] });
        mk.on('click', () => abrirGrupo(chave, mk));
        camadaGrupos.addLayer(mk);
      }
      mk._fgMembros = g.map((x) => x.k);
      novos.set(chave, mk);
    }
    for (const mk of gruposAtuais.values()) camadaGrupos.removeLayer(mk);
    gruposAtuais = novos;
    rotulos();
  }

  function htmlGrupo(g) {
    const itens = g.map((x) => x.i).filter(Boolean);
    const al = itens.filter((i) => i.alertas.length).length;
    const on = itens.filter((i) => i.online).length;
    const mov = itens.filter((i) => i.online && i.posicao && i.posicao.vel > 3).length;
    const cls = al ? 'alerta' : mov ? 'mov' : on ? 'on' : 'off';
    const n = g.length;
    const tam = n < 10 ? 36 : n < 50 ? 42 : n < 200 ? 50 : 58;
    const html = `<div class="vclu ${cls}" style="--t:${tam}px"><b>${n}</b>${al ? `<i>${al}</i>` : ''}</div>`;
    const dica = `${n} veículos · ${on} online · ${mov} em movimento${al ? ` · ${al} com alerta` : ''}`;
    return { html, dica, tam, alerta: al, icone: L.divIcon({ className: '', html, iconSize: [tam, tam], iconAnchor: [tam / 2, tam / 2] }) };
  }

  function abrirGrupo(chave, mk) {
    const membros = (mk._fgMembros || []).map((k) => marcadores.get(k)).filter(Boolean);
    if (!membros.length) return;
    const b = L.latLngBounds(membros.map((m) => m.getLatLng()));
    if (mapa.getZoom() < ZOOM_PERTO) {
      mapa.fitBounds(b, { padding: [70, 70], maxZoom: 18 });
      return;
    }
    // praticamente no mesmo lugar: lista para escolher
    const box = document.createElement('div');
    box.className = 'vclu-lista';
    const itens = (mk._fgMembros || []).map((k) => S.itens.get(k)).filter(Boolean)
      .sort((x, y) => rotulo(x).localeCompare(rotulo(y), 'pt-BR', { numeric: true }));
    box.innerHTML = `<div class="vclu-tit">${itens.length} veículos neste ponto</div>${itens.map((i) => `<button type="button" data-k="${H(i.chave)}"><span class="dot ${i.alertas.length ? 'off' : i.online ? 'on' : ''}"></span>${H(rotulo(i))}<small>${H(i.online ? (i.posicao ? `${Math.round(i.posicao.vel)} km/h` : 'online') : 'offline')}</small></button>`).join('')}`;
    box.addEventListener('click', (e) => {
      const bt = e.target.closest('[data-k]');
      if (!bt) return;
      mapa.closePopup();
      selecionar(bt.dataset.k, true);
    });
    L.popup({ maxWidth: 280, className: 'vclu-pop' }).setLatLng(mk.getLatLng()).setContent(box).openOn(mapa);
  }

  function botaoAgrupar() {
    const Botao = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const b = L.DomUtil.create('button', 'map-tool');
        b.type = 'button';
        const pintar = () => {
          b.classList.toggle('ativo', agrupando());
          b.title = agrupando() ? 'Veículos próximos agrupados (clique para mostrar todos separados)' : 'Mostrando todos os veículos (clique para agrupar os próximos)';
          b.innerHTML = `${ico('chart-bubble', 'i-sm')}<span>${agrupando() ? 'Agrupado' : 'Agrupar'}</span>`;
        };
        pintar();
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => { salvarPref('agruparMapa', !agrupando()); pintar(); agrupar(); });
        return b;
      },
    });
    new Botao().addTo(mapa);
  }

  /* ---------- cercas no mapa ---------- */

  const mostrandoCercas = () => pref('cercasMapa', true);

  async function desenharCercas() {
    if (!mapa) return;
    if (camadaCercas) { camadaCercas.remove(); camadaCercas = null; }
    if (!mostrandoCercas()) return;
    let lista = [];
    try { lista = await carregarCercas(); } catch { return; }
    if (!mapa || !mostrandoCercas()) return;
    if (camadaCercas) camadaCercas.remove();
    camadaCercas = L.layerGroup(lista.filter((c) => c.ativo).map((c) => camadaCerca(c, { fraco: true }))).addTo(mapa);
  }

  function botaoCercas() {
    const Botao = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const b = L.DomUtil.create('button', 'map-tool');
        b.type = 'button';
        const pintar = () => {
          b.classList.toggle('ativo', mostrandoCercas());
          b.title = mostrandoCercas() ? 'Mostrando garagens, pontos e áreas (clique para esconder)' : 'Mostrar as cercas (garagens, pontos e áreas)';
          b.innerHTML = `${ico('fence', 'i-sm')}<span>Cercas</span>`;
        };
        pintar();
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => { salvarPref('cercasMapa', !mostrandoCercas()); pintar(); desenharCercas(); });
        return b;
      },
    });
    new Botao().addTo(mapa);
  }

  /* ---------- seleção e detalhes ---------- */

  async function selecionar(chave, centralizar) {
    const ant = selecionado;
    selecionado = chave;
    const i = S.itens.get(chave);
    if (ant && marcadores.get(ant)) atualizarMarcador(S.itens.get(ant) || { chave: ant });
    if (i) atualizarMarcador(i);
    agrupar();
    $$('#f-lista .fi').forEach((b) => b.classList.toggle('sel', b.dataset.k === chave));
    desenharDetalhe();
    if (centralizar && mapa && temPosicao(i)) mapa.setView([i.posicao.lat, i.posicao.lng], Math.max(mapa.getZoom(), 15));
    if (rastro) { rastro.remove(); rastro = null; }
    if (i && i.aparelhoId && mapa) {
      try {
        const r = await api(`/api/historico/posicoes?${qs({ aparelho: i.aparelhoId, de: textoServidor(Date.now() - 2 * 3600000), ate: textoServidor(Date.now() + 60000) })}`);
        if (selecionado !== chave || !mapa) return;
        const pts = r.posicoes.filter((p) => p.gps_valido).map((p) => [p.latitude, p.longitude]);
        if (pts.length > 1) rastro = L.polyline(pts, { color: '#F59E0B', weight: 4, opacity: 0.85 }).addTo(mapa);
      } catch { /* sem rastro */ }
    }
  }

  function estenderRastro(i) {
    if (!rastro || !temPosicao(i) || !i.posicao.gps) return;
    const pts = rastro.getLatLngs();
    const ult = pts[pts.length - 1];
    if (!ult || ult.lat !== i.posicao.lat || ult.lng !== i.posicao.lng) rastro.addLatLng([i.posicao.lat, i.posicao.lng]);
  }

  function fecharDetalhe() {
    const ant = selecionado;
    selecionado = null;
    $('#detalhe').hidden = true;
    if (rastro) { rastro.remove(); rastro = null; }
    if (ant && S.itens.get(ant)) atualizarMarcador(S.itens.get(ant));
    agrupar();
    $$('#f-lista .fi').forEach((b) => b.classList.remove('sel'));
  }

  function desenharDetalhe() {
    const box = $('#detalhe');
    if (!box) return;
    const i = S.itens.get(selecionado);
    if (!i) { fecharDetalhe(); return; }
    const p = i.posicao;
    const status = i.pendente
      ? `<span class="dot wait"></span> Aparelho sem cadastro${i.online ? ' · online' : ''}`
      : i.semAparelho ? '<span class="dot"></span> Sem aparelho instalado'
        : i.online ? `<span class="dot on"></span> Online <span class="muted small" style="font-weight:500">· ${H(i.protocolo || '')}</span>`
          : `<span class="dot off"></span> Offline <span class="muted small" style="font-weight:500">· ${i.ultimoContato ? `último contato ${atras(i.ultimoContato)}` : 'nunca conectou'}</span>`;
    const dado = (t, v) => `<div><span>${H(t)}</span><strong>${v}</strong></div>`;
    const grid = p ? [
      dado('Velocidade', `${fmtNum(p.vel)} km/h`),
      dado('Ignição', p.ign === null ? '—' : p.ign ? 'Ligada' : 'Desligada'),
      dado('GPS', p.gps === false ? 'Sem sinal' : `${p.sat ?? '—'} satélites`),
      dado('Sinal 4G', p.sinal === null || p.sinal === undefined ? '—' : `${p.sinal}/31`),
      dado('Odômetro', p.odometro === null || p.odometro === undefined ? '—' : `${fmtNum(p.odometro, 1)} km`),
      dado('Posição de', H(fmtCurto(p.hora))),
    ].join('') : '';
    const naCerca = (i.cercas || []).length
      ? `<div class="ce-chips">${i.cercas.map((c) => `<span class="ce-chip ${c.finalidade}">${ico((FINALIDADES_CERCA[c.finalidade] || FINALIDADES_CERCA.area).ico, 'i-xs')} ${H(c.finalidade === 'garagem' && !/^garagem/i.test(c.nome) ? `Na garagem ${c.nome}` : c.finalidade === 'proibida' ? `Em área proibida: ${c.nome}` : c.nome)}</span>`).join('')}</div>`
      : '';
    const alertas = i.alertas.length
      ? `<div class="alarms">${i.alertas.map((a) => `<div class="alarm">${ico('alert-triangle')} ${H(a.nome)} <span class="muted small" style="margin-left:auto">${H(fmtCurto(a.inicio))}</span></div>`).join('')}</div>`
      : '';
    let cams = '';
    if (S.eu.pode.video && i.ident && !i.semAparelho) {
      const n = Math.max(1, i.canais || 4);
      const botoes = Array.from({ length: n }, (_, k) => {
        const ch = k + 1;
        const nome = (i.nomesCanais && i.nomesCanais[k]) || `CH ${ch}`;
        return `<button class="ch-btn${mosaico.aberto(i.ident, ch) ? ' on' : ''}" type="button" data-ch="${ch}" ${i.online ? '' : 'disabled'} title="${H(nome)}">${H(nome)}</button>`;
      }).join('');
      cams = `<div class="info-block"><div class="block-title">Câmeras</div><div class="channels">${botoes}</div>
        ${i.online ? `<div class="video-controls"><button class="link" type="button" data-todas>${ico('player-play', 'i-sm')} Abrir todas</button></div>` : '<p class="small muted" style="margin:0">As câmeras abrem quando o aparelho estiver online.</p>'}</div>`;
    }
    const acoes = [];
    if (i.pendente && S.eu.perfil === 'master') acoes.push(`<button class="btn btn-primary btn-sm" type="button" data-cadastrar>${ico('plus', 'i-sm')} Cadastrar aparelho</button>`);
    if (i.aparelhoId) acoes.push(`<button class="btn btn-sm" type="button" data-hist>${ico('route', 'i-sm')} Histórico</button>`);
    if (i.aparelhoId && S.eu.pode.gravacoes) acoes.push(`<button class="btn btn-sm" type="button" data-grav>${ico('video', 'i-sm')} Gravações</button>`);
    box.innerHTML = `
      <div class="det-head">
        <div class="info-ico">${ico(i.pendente ? 'device-cctv' : 'bus')}</div>
        <div style="min-width:0"><div class="eyebrow">${H(i.pendente ? 'Aparelho pendente' : i.empresa || 'Veículo')}</div>
          <div class="info-title">${H(rotulo(i))}</div>
          <div class="small muted">${H([i.descricao, i.grupo].filter(Boolean).join(' · ') || (i.modelo ? `DVR ${i.modelo}` : ''))}</div></div>
        <button class="det-close" type="button" data-fechar-det aria-label="Fechar">${ico('x', 'i-sm')}</button>
      </div>
      <div class="det-status">${status}</div>
      ${naCerca}
      ${p ? `<div class="det-grid">${grid}</div>` : '<p class="small muted" style="margin:0">Sem posição registrada ainda.</p>'}
      ${alertas}
      ${cams}
      ${acoes.length ? `<div class="det-actions">${acoes.join('')}</div>` : ''}
      ${i.ident ? `<div class="small muted">Aparelho <span class="mono">${H(i.ident)}</span>${i.modelo ? ` · ${H(i.modelo)}` : ''}</div>` : ''}`;
    box.hidden = false;
    box.querySelector('[data-fechar-det]').onclick = fecharDetalhe;
    box.querySelectorAll('[data-ch]').forEach((b) => { b.onclick = () => abrirCanal(i, Number(b.dataset.ch)); });
    const todas = box.querySelector('[data-todas]');
    if (todas) todas.onclick = () => { for (let ch = 1; ch <= Math.max(1, i.canais || 4); ch++) if (!mosaico.aberto(i.ident, ch)) abrirCanal(i, ch); };
    const cad = box.querySelector('[data-cadastrar]');
    if (cad) cad.onclick = () => abrirCadastroAparelho({ identificador: i.ident, modelo: i.modelo || '' });
    const hist = box.querySelector('[data-hist]');
    if (hist) hist.onclick = () => navegar('historico', qs({ v: i.chave }));
    const grav = box.querySelector('[data-grav]');
    if (grav) grav.onclick = () => navegar('gravacoes', qs({ v: i.chave }));
  }

  function abrirCanal(i, ch) {
    const nome = (i.nomesCanais && i.nomesCanais[ch - 1]) || `CH ${ch}`;
    if (!mosaico.aberto(i.ident, ch) && mosaico.tamanho >= 9) { toast('Feche alguma câmera antes de abrir outra (máximo de 9 ao mesmo tempo).'); return; }
    mosaico.alternar({ ident: i.ident, canal: ch, titulo: `${rotuloCurto(i)} · ${nome}`, fluxo: pref('fluxo', 1), conv: pref('conv', '1') });
    desenharDetalhe();
  }

  function atualizarCams() {
    const cams = $('#cams');
    if (!cams) return;
    const antes = !cams.hidden;
    cams.hidden = !mosaico.tamanho;
    // com câmeras abertas o mapa encolhe para as duas coisas caberem na tela
    const mon = $('.mon');
    if (mon && mon.classList.contains('com-cams') !== !!mosaico.tamanho) {
      mon.classList.toggle('com-cams', !!mosaico.tamanho);
      setTimeout(() => { if (mapa) mapa.invalidateSize(); }, 60);
    }
    if (!antes && mosaico.tamanho) setTimeout(() => cams.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    $('#cams-n').textContent = mosaico.tamanho;
    $$('#cams [data-fluxo]').forEach((b) => b.classList.toggle('active', Number(b.dataset.fluxo) === pref('fluxo', 1)));
    $$('#cams [data-conv]').forEach((b) => b.classList.toggle('active', b.dataset.conv === pref('conv', '1')));
    if (selecionado) desenharDetalhe();
  }

  return { id: 'mapa', titulo: 'Monitoramento', sub: 'Frota ao vivo no mapa', cheia: true, render, sair };
})();
