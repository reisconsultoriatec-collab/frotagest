'use strict';
/* FrotaGest — Histórico: trajeto de um veículo num período, com resumo e exportação. Reis Tecnologia */

PAGINAS.historico = (() => {
  let mapa = null;
  let camada = null;
  let dados = null;
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
          <section class="card hist-map"><div id="hmap"></div></section>
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
    $('#hi-tabela').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr || !mapa || !dados) return;
      const p = dados.posicoes[Number(tr.dataset.i)];
      if (p && p.gps_valido) {
        mapa.setView([p.latitude, p.longitude], Math.max(mapa.getZoom(), 16));
        L.popup().setLatLng([p.latitude, p.longitude]).setContent(`<b>${H(fmtDataHora(p.data_hora))}</b><br>${fmtNum(p.velocidade)} km/h · ignição ${p.ignicao ? 'ligada' : 'desligada'}`).openOn(mapa);
      }
    });
    mapa = criarMapa($('#hmap'));
    if (f.veiculo) buscar();
  }

  function sair() {
    if (mapa) mapa.remove();
    mapa = null;
    camada = null;
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
    camada = L.featureGroup().addTo(mapa);
    const pts = dados.posicoes.filter((p) => p.gps_valido).map((p) => [p.latitude, p.longitude]);
    if (!pts.length) return;
    L.polyline(pts, { color: '#F59E0B', weight: 4, opacity: 0.9 }).addTo(camada);
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
