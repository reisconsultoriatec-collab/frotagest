'use strict';
/* FrotaGest — Histórico: trajeto de um veículo num período, com resumo e exportação. Reis Tecnologia */

PAGINAS.historico = (() => {
  let mapa = null;
  let camada = null;
  let dados = null;
  let rota = null; // linha do trajeto inteiro
  // reprodução do trajeto
  const pl = { pts: [], t0: 0, t1: 0, t: 0, tocando: false, quadro: 0, ultimo: null, marcador: null, feito: null, rastro: [], ate: -1, desenhado: 0, arrastando: false };
  const VELOCIDADES = [1, 5, 10, 30, 60, 120, 300];
  const f = { veiculo: '', de: '', ate: '' };

  function render(c, params) {
    if (params.v) f.veiculo = params.v;
    if (!f.de) {
      f.de = `${textoServidor().slice(0, 10)} 00:00:00`;
      f.ate = `${textoServidor().slice(0, 10)} 23:59:59`;
    }
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="toolbar">
            <label class="field">Veículo<select id="hi-veic"></select></label>
            <label class="field">De<input type="datetime-local" id="hi-de"></label>
            <label class="field">Até<input type="datetime-local" id="hi-ate"></label>
            <div class="seg" id="hi-rapido"><button class="seg-btn" type="button" data-h="1">1 h</button><button class="seg-btn" type="button" data-h="6">6 h</button><button class="seg-btn" type="button" data-hoje="1">Hoje</button><button class="seg-btn" type="button" data-ontem="1">Ontem</button></div>
            <div class="grow"></div>
            <button class="btn btn-primary" type="button" id="hi-buscar">${ico('search', 'i-sm')} Buscar</button>
            <button class="btn" type="button" id="hi-csv" disabled>${ico('download', 'i-sm')} CSV</button>
          </div>
          <p class="hint" id="hi-status">Escolha o veículo e o período (até 7 dias).</p>
        </section>
        <div class="kpis" id="hi-kpis" hidden></div>
        <div class="hist-layout">
          <section class="card hist-map"><div id="hmap"></div>
            <div class="player" id="hi-player" hidden>
              <button class="btn btn-primary pl-play" type="button" id="pl-play" title="Reproduzir o trajeto (barra de espaço)" aria-label="Reproduzir">${ico('player-play', 'i-sm')}</button>
              <button class="btn pl-btn" type="button" id="pl-inicio" title="Voltar ao início" aria-label="Voltar ao início">${ico('player-skip-back', 'i-sm')}</button>
              <div class="pl-linha"><input type="range" id="pl-pos" min="0" max="1000" value="0" aria-label="Momento do trajeto"><div class="pl-marcas" id="pl-marcas"></div></div>
              <div class="pl-info"><b id="pl-hora">—</b><span id="pl-vel">—</span></div>
              <div class="pl-opcoes">
                <label class="pl-sel" title="Velocidade da reprodução (1× = tempo real)">${ico('gauge', 'i-sm')}<select id="pl-velocidade" aria-label="Velocidade da reprodução">${VELOCIDADES.map((v) => `<option value="${v}">${v}×</option>`).join('')}</select></label>
                <label class="check" title="O mapa acompanha o veículo"><input type="checkbox" id="pl-seguir" checked> Seguir o veículo</label>
                <label class="check" title="Passa direto pelos trechos em que ficou parado"><input type="checkbox" id="pl-pular" checked> Pular paradas</label>
              </div>
            </div>
          </section>
          <section class="card"><div class="card-head"><h2>${ico('list-details')} Posições</h2><span class="count" id="hi-n"></span></div>
            <div class="table-wrap" style="max-height:520px" id="hi-tabela"><p class="hint">Nenhuma busca feita.</p></div></section>
        </div>
      </div>`;
    $('#hi-veic').innerHTML = opcoesVeiculos(f.veiculo);
    $('#hi-de').value = paraInput(f.de);
    $('#hi-ate').value = paraInput(f.ate);
    $('#hi-buscar').addEventListener('click', buscar);
    $('#hi-csv').addEventListener('click', exportar);
    $('#hi-rapido').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const agora = Date.now();
      if (b.dataset.h) { f.de = textoServidor(agora - Number(b.dataset.h) * 3600000); f.ate = textoServidor(agora); }
      if (b.dataset.hoje) { f.de = `${textoServidor(agora).slice(0, 10)} 00:00:00`; f.ate = textoServidor(agora); }
      if (b.dataset.ontem) { const d = textoServidor(agora - 86400000).slice(0, 10); f.de = `${d} 00:00:00`; f.ate = `${d} 23:59:59`; }
      $('#hi-de').value = paraInput(f.de);
      $('#hi-ate').value = paraInput(f.ate);
      if ($('#hi-veic').value) buscar();
    });
    $('#pl-velocidade').value = String(pref('velReproducao', 30));
    $('#pl-velocidade').addEventListener('change', (e) => salvarPref('velReproducao', Number(e.target.value)));
    $('#pl-play').addEventListener('click', () => (pl.tocando ? pausar() : tocar()));
    $('#pl-inicio').addEventListener('click', () => { pausar(); irPara(pl.t0, true); });
    const faixa = $('#pl-pos');
    faixa.addEventListener('pointerdown', () => { pl.arrastando = true; });
    for (const ev of ['pointerup', 'pointercancel', 'change']) faixa.addEventListener(ev, () => { pl.arrastando = false; });
    faixa.addEventListener('input', () => irPara(pl.t0 + (pl.t1 - pl.t0) * (Number(faixa.value) / 1000), true));
    document.addEventListener('keydown', teclas);
    $('#hi-tabela').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr || !mapa || !dados) return;
      const p = dados.posicoes[Number(tr.dataset.i)];
      if (p && p.gps_valido && pl.pts.length > 1) { pausar(); irPara(msDe(p.data_hora), true); }
      if (p && p.gps_valido) {
        mapa.setView([p.latitude, p.longitude], Math.max(mapa.getZoom(), 16));
        L.popup().setLatLng([p.latitude, p.longitude]).setContent(`<b>${H(fmtDataHora(p.data_hora))}</b><br>${fmtNum(p.velocidade)} km/h · ignição ${p.ignicao ? 'ligada' : 'desligada'}`).openOn(mapa);
      }
    });
    mapa = criarMapa($('#hmap'));
    if (f.veiculo) buscar();
  }

  function sair() {
    pausar();
    document.removeEventListener('keydown', teclas);
    removerMapa(mapa);
    mapa = null;
    camada = null;
    rota = null;
    pl.pts = [];
    pl.marcador = null;
    pl.feito = null;
  }

  function teclas(e) {
    if (e.code !== 'Space' || !pl.pts.length || $('#hi-player').hidden) return;
    if (e.target.closest('input:not([type=range]), select, textarea, button')) return;
    e.preventDefault();
    if (pl.tocando) pausar(); else tocar();
  }

  async function buscar() {
    f.veiculo = $('#hi-veic').value;
    f.de = deInput($('#hi-de').value);
    f.ate = deInput($('#hi-ate').value, true);
    const it = S.itens.get(f.veiculo);
    const st = $('#hi-status');
    if (!it) { st.textContent = 'Escolha um veículo.'; return; }
    if (!f.de || !f.ate) { st.textContent = 'Preencha o período.'; return; }
    st.textContent = 'Buscando…';
    pausar();
    try {
      const alvo = it.veiculoId ? { veiculo: it.veiculoId } : { aparelho: it.aparelhoId };
      dados = await api(`/api/historico/posicoes?${qs({ ...alvo, de: f.de, ate: f.ate })}`);
    } catch (e) {
      st.textContent = e.message;
      return;
    }
    const n = dados.posicoes.length;
    st.textContent = n ? `${rotulo(it)} · ${fmtDataHora(dados.de)} a ${fmtDataHora(dados.ate)}${dados.cortado ? ` · período grande: mostrando as primeiras ${fmtNum(dados.maxPontos)} posições` : ''}` : 'Nenhuma posição nesse período.';
    $('#hi-csv').disabled = !n;
    desenharResumo();
    desenharMapa();
    desenharTabela();
  }

  function desenharResumo() {
    const r = dados.resumo;
    const box = $('#hi-kpis');
    box.hidden = !r.pontos;
    box.innerHTML = [
      ['route', 'Distância', `${fmtNum(r.km, 1)}<small>km</small>`, 'calculada pelo GPS'],
      ['gauge', 'Velocidade máxima', `${fmtNum(r.velocidadeMax)}<small>km/h</small>`, ''],
      ['clock', 'Em movimento', H(fmtDur(r.movimentoMin * 60)), 'acima de 3 km/h'],
      ['map-pin', 'Posições', fmtNum(r.pontos), dados.cortado ? 'limitado ao máximo' : 'no período'],
    ].map(([i, t, v, s]) => `<div class="kpi neutral"><div class="kpi-ico">${ico(i)}</div><div class="kpi-body"><div class="kpi-label">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${H(s)}</div></div></div>`).join('');
  }

  function desenharMapa() {
    if (!mapa) return;
    if (camada) camada.remove();
    $('#hi-player').hidden = true;
    pl.pts = [];
    pl.rastro = [];
    pl.ate = -1;
    camada = L.featureGroup().addTo(mapa);
    const pts = dados.posicoes.filter((p) => p.gps_valido).map((p) => [p.latitude, p.longitude]);
    if (!pts.length) return;
    rota = L.polyline(pts, { color: '#F59E0B', weight: 4, opacity: 0.9 }).addTo(camada);
    const ponto = (ll, cor, t) => L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: cor, fillOpacity: 1 }).bindTooltip(t).addTo(camada);
    ponto(pts[0], '#16A34A', 'Início');
    ponto(pts[pts.length - 1], '#DC2626', 'Fim');
    // paradas longas (ignição desligada) e alarmes
    for (const p of dados.posicoes) {
      if (p.gps_valido && (p.alarmes || p.alarmes_video)) {
        L.circleMarker([p.latitude, p.longitude], { radius: 5, color: '#DC2626', weight: 2, fillColor: '#FEE2E2', fillOpacity: 1 })
          .bindTooltip(`Alarme · ${H(fmtDataHora(p.data_hora))}`).addTo(camada);
      }
    }
    mapa.fitBounds(camada.getBounds(), { padding: [30, 30], maxZoom: 16 });
    prepararReproducao();
  }

  /* ---------- reprodução do trajeto ---------- */
  // Um veículo anda pelo trajeto na velocidade escolhida (1× = tempo real). O trecho já percorrido
  // fica forte e o resto fica claro; dá para arrastar a linha do tempo, pular as paradas e o mapa
  // acompanha o veículo. As marcas vermelhas na linha do tempo são os alarmes.

  const distKm = (a, b) => {
    const r = Math.PI / 180;
    const x = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  const rumo = (a, b) => {
    const r = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
    const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };

  function prepararReproducao() {
    pausar();
    const box = $('#hi-player');
    pl.pts = dados.posicoes.filter((p) => p.gps_valido).map((p) => ({
      t: msDe(p.data_hora), ll: [p.latitude, p.longitude], vel: Number(p.velocidade) || 0, ign: p.ignicao, dir: Number(p.direcao) || 0, alarme: !!(p.alarmes || p.alarmes_video),
    })).filter((p) => Number.isFinite(p.t));
    if (pl.pts.length < 2) { box.hidden = true; return; }
    pl.t0 = pl.pts[0].t;
    pl.t1 = pl.pts[pl.pts.length - 1].t;
    pl.marcador = L.marker(pl.pts[0].ll, {
      icon: L.divIcon({ className: '', html: '<div class="vpin mov sel pl-veiculo"><div class="seta"><svg viewBox="0 0 24 24"><path d="M12 2.5l6.5 17-6.5-3.6-6.5 3.6z" fill="currentColor"/></svg></div></div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
      zIndexOffset: 3000, keyboard: false,
    }).addTo(camada);
    pl.feito = L.polyline([], { color: '#D97706', weight: 5, opacity: 0.95 }).addTo(camada);
    // alarmes na linha do tempo
    const dur = pl.t1 - pl.t0 || 1;
    $('#pl-marcas').innerHTML = pl.pts.filter((p) => p.alarme).slice(0, 300).map((p) => `<i style="left:${(((p.t - pl.t0) / dur) * 100).toFixed(2)}%"></i>`).join('');
    box.hidden = false;
    setTimeout(() => { if (mapa) mapa.invalidateSize(); }, 30);
    irPara(pl.t0, false);
  }

  /** Índice da última posição com hora até t (busca binária). */
  function indice(t) {
    let lo = 0;
    let hi = pl.pts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (pl.pts[m].t <= t) lo = m; else hi = m - 1;
    }
    return lo;
  }

  function irPara(t, centralizar) {
    if (!pl.pts.length || !pl.marcador) return;
    pl.t = Math.max(pl.t0, Math.min(pl.t1, t));
    const i = indice(pl.t);
    const a = pl.pts[i];
    const b = pl.pts[Math.min(i + 1, pl.pts.length - 1)];
    const f = b.t > a.t ? Math.min(1, (pl.t - a.t) / (b.t - a.t)) : 0;
    const ll = [a.ll[0] + (b.ll[0] - a.ll[0]) * f, a.ll[1] + (b.ll[1] - a.ll[1]) * f];
    pl.marcador.setLatLng(ll);
    const el = pl.marcador.getElement();
    const direcao = distKm(a.ll, b.ll) > 0.003 ? rumo(a.ll, b.ll) : a.dir;
    if (el) {
      const svg = el.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${direcao}deg)`;
      el.querySelector('.vpin').className = `vpin sel pl-veiculo ${a.vel > 3 ? 'mov' : 'on'}`;
    }
    // trecho percorrido: refaz ao voltar; ao avançar, só acrescenta (e redesenha no máximo a cada 120 ms)
    if (i < pl.ate) { pl.rastro = pl.pts.slice(0, i + 1).map((p) => p.ll); pl.ate = i; }
    while (pl.ate < i) { pl.ate++; pl.rastro.push(pl.pts[pl.ate].ll); }
    const agora = performance.now();
    if (!pl.tocando || agora - pl.desenhado > 120 || centralizar) {
      pl.desenhado = agora;
      pl.feito.setLatLngs([...pl.rastro, ll]);
      if (rota) rota.setStyle({ opacity: pl.t > pl.t0 || pl.tocando ? 0.35 : 0.9 });
    }
    if (!pl.arrastando) $('#pl-pos').value = String(Math.round(((pl.t - pl.t0) / (pl.t1 - pl.t0 || 1)) * 1000));
    $('#pl-hora').textContent = fmtDataHora(textoServidor(pl.t));
    $('#pl-vel').textContent = `${fmtNum(a.vel)} km/h · ignição ${a.ign ? 'ligada' : 'desligada'}`;
    if (mapa && (centralizar || $('#pl-seguir').checked) && !mapa.getBounds().pad(-0.22).contains(ll)) mapa.panTo(ll, { animate: !centralizar, duration: 0.4 });
  }

  function tocar() {
    if (pl.pts.length < 2) return;
    if (pl.t >= pl.t1) irPara(pl.t0, true);
    pl.tocando = true;
    pl.arrastando = false;
    pl.ultimo = null;
    $('#pl-play').innerHTML = ico('player-pause', 'i-sm');
    $('#pl-play').setAttribute('aria-label', 'Pausar');
    pl.quadro = requestAnimationFrame(passo);
  }

  function pausar() {
    pl.tocando = false;
    cancelAnimationFrame(pl.quadro);
    const b = $('#pl-play');
    if (b) { b.innerHTML = ico('player-play', 'i-sm'); b.setAttribute('aria-label', 'Reproduzir'); }
  }

  function passo(agora) {
    if (!pl.tocando || !mapa) return;
    const dt = pl.ultimo === null ? 0 : Math.min(agora - pl.ultimo, 100);
    pl.ultimo = agora;
    let t = pl.t + dt * Number($('#pl-velocidade').value || 30);
    if ($('#pl-pular').checked) {
      // parado (ou sem posição por muito tempo no mesmo lugar): pula direto para quando voltar a andar
      for (let n = 0, i = indice(t); n < 5000 && i < pl.pts.length - 1; n++, i++) {
        const a = pl.pts[i];
        const b = pl.pts[i + 1];
        const parado = (a.vel <= 3 && b.vel <= 3 && distKm(a.ll, b.ll) < 0.05) || (b.t - a.t > 300000 && distKm(a.ll, b.ll) < 0.15);
        if (!parado) break;
        t = Math.max(t, b.t);
      }
    }
    if (t >= pl.t1) {
      irPara(pl.t1, false);
      pausar();
      return;
    }
    irPara(t, false);
    pl.quadro = requestAnimationFrame(passo);
  }

  function desenharTabela() {
    const lista = dados.posicoes;
    $('#hi-n').textContent = lista.length ? `${fmtNum(lista.length)} posições` : '';
    // a tabela mostra até 2.000 linhas (o CSV leva todas)
    const mostrar = lista.length > 2000 ? lista.filter((_, i) => i % Math.ceil(lista.length / 2000) === 0) : lista;
    const idx = new Map(lista.map((p, i) => [p, i]));
    $('#hi-tabela').innerHTML = tabela([
      { t: 'Data/hora', cls: 'nw', v: (p) => H(fmtDataHora(p.data_hora)) },
      { t: 'Velocidade', cls: 'num', v: (p) => `${fmtNum(p.velocidade)} km/h` },
      { t: 'Ignição', v: (p) => (p.ignicao ? 'Ligada' : 'Desligada') },
      { t: 'GPS', v: (p) => (p.gps_valido ? `${p.satelites ?? '—'} sat.` : '<span class="tag err">sem sinal</span>') },
      { t: 'Alarme', v: (p) => (p.alarmes || p.alarmes_video ? '<span class="tag alarm">sim</span>' : '') },
    ], mostrar, { vazio: 'Nenhuma posição nesse período.', linhaCls: () => 'clic', atributos: (p) => `data-i="${idx.get(p)}"` });
  }

  function exportar() {
    if (!dados) return;
    const it = S.itens.get(f.veiculo);
    const linhas = [['Data/hora', 'Latitude', 'Longitude', 'Velocidade (km/h)', 'Direção', 'Ignição', 'GPS válido', 'Satélites', 'Sinal 4G', 'Odômetro (km)', 'Alarmes']];
    for (const p of dados.posicoes) linhas.push([p.data_hora, p.latitude, p.longitude, p.velocidade, p.direcao, p.ignicao ? 'sim' : 'não', p.gps_valido ? 'sim' : 'não', p.satelites, p.sinal, p.odometro, p.alarmes || p.alarmes_video ? 'sim' : '']);
    baixarCsv(`historico-${(it && (it.placa || it.ident)) || 'veiculo'}-${f.de.slice(0, 10)}.csv`, linhas);
  }

  return { id: 'historico', titulo: 'Histórico', sub: 'Trajetos e posições gravados no banco', render, sair };
})();
