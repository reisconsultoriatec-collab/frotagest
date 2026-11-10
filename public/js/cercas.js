'use strict';
/* FrotaGest — Cercas virtuais: desenhar no mapa (círculo ou área livre) a garagem, os pontos e as
 * áreas proibidas; ver quem está dentro de cada uma agora. Também desenha as cercas no
 * Monitoramento e no modo TV. Reis Tecnologia */

const FINALIDADES_CERCA = {
  garagem: { nome: 'Garagem', cor: '#2563EB', ico: 'building-warehouse' },
  ponto: { nome: 'Ponto ou terminal', cor: '#0D9488', ico: 'map-pin' },
  area: { nome: 'Área de interesse', cor: '#7C3AED', ico: 'shape' },
  proibida: { nome: 'Área proibida', cor: '#DC2626', ico: 'ban' },
};

/** Cercas da empresa escolhida (guardadas até alguém mudar o cadastro). */
async function carregarCercas(forcar = false) {
  if (S.cercas && !forcar && S.cercasEmpresa === S.empresa) return S.cercas;
  const r = await api(`/api/cercas${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
  S.cercas = r.cercas;
  S.cercasEmpresa = S.empresa;
  return S.cercas;
}

/** Entrou/saiu: mantém a lista "quem está dentro" sem buscar tudo de novo. */
function atualizarOcupacao(ev) {
  if (!S.cercas || !ev) return;
  const c = S.cercas.find((x) => x.id === ev.cercaId);
  if (!c) return;
  c.dentro = c.dentro.filter((k) => k !== ev.chave);
  if (ev.tipo === 'entrada') c.dentro.push(ev.chave);
}

/** Desenho de uma cerca no mapa (círculo ou polígono), na cor da finalidade. O nome fica na borda de
 * cima, para não cobrir os veículos parados dentro (garagem). */
function camadaCerca(c, { fraco = false, rotulo = true, interativo = false } = {}) {
  const f = FINALIDADES_CERCA[c.finalidade] || FINALIDADES_CERCA.area;
  const estilo = {
    color: f.cor, weight: fraco ? 1.5 : 2.5, opacity: c.ativo === false ? 0.45 : 0.9, fillColor: f.cor,
    fillOpacity: fraco ? 0.07 : 0.13, dashArray: c.ativo === false || c.finalidade === 'proibida' ? '6 5' : null, interactive: interativo,
  };
  const forma = c.forma === 'circulo' ? L.circle([c.lat, c.lng], { ...estilo, radius: c.raio }) : L.polygon(c.pontos, estilo);
  const g = L.featureGroup([forma]);
  if (rotulo) {
    let topo;
    if (c.forma === 'circulo') topo = [c.lat + c.raio / 111320, c.lng];
    else {
      const norte = Math.max(...c.pontos.map((p) => p[0]));
      const naBorda = c.pontos.filter((p) => p[0] >= norte - 1e-9);
      topo = [norte, naBorda.reduce((t, p) => t + p[1], 0) / naBorda.length];
    }
    g.addLayer(L.marker(topo, {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', html: `<span class="cerca-rot ${c.finalidade}" style="--c:${f.cor}">${H(c.nome)}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] }),
    }));
  }
  return g;
}

const fmtMetros = (m) => (m >= 1000 ? `${fmtNum(m / 1000, m >= 10000 ? 0 : 1)} km` : `${fmtNum(m)} m`);
const fmtArea = (m2) => (m2 >= 1e6 ? `${fmtNum(m2 / 1e6, 2)} km²` : m2 >= 10000 ? `${fmtNum(m2 / 10000, 1)} ha` : `${fmtNum(m2)} m²`);

/** "Avisa na saída fora de 04:00–23:00" */
function resumoAvisos(c) {
  if (c.finalidade === 'proibida') return 'Alerta enquanto um veículo estiver dentro';
  const qual = [c.alertaEntrada ? 'na entrada' : '', c.alertaSaida ? 'na saída' : ''].filter(Boolean).join(' e ');
  if (!qual) return 'Sem avisos (só relatório e ocupação)';
  return `Avisa ${qual}${c.horarioInicio ? ` fora de ${c.horarioInicio}–${c.horarioFim}` : ''}`;
}

PAGINAS.cercas = (() => {
  let mapa = null;
  let lista = [];
  let camadas = new Map(); // id → camada no mapa
  let camadaVeic = null;
  let sel = null;
  let ed = null; // desenho em andamento
  let offs = [];
  const f = { q: '', fin: '' };

  function render(c) {
    c.innerHTML = `
      <div class="mon cer">
        <section class="card fleet" id="ce-painel"></section>
        <section class="card map-card" id="ce-mapcard">
          <div id="ce-map"></div>
          <div class="ce-dica" id="ce-dica" hidden></div>
          <div class="legend-map">${Object.values(FINALIDADES_CERCA).map((x) => `<span><i style="background:${x.cor}"></i>${H(x.nome)}</span>`).join('')}</div>
          <div class="card map-detail" id="ce-det" hidden></div>
        </section>
      </div>`;
    mapa = criarMapa($('#ce-map'));
    if (mapa) {
      camadaVeic = L.layerGroup().addTo(mapa);
      mapa.on('zoomend', rotulos);
    }
    painelLista();
    carregar(true);
    offs.push(on('cerca', () => { if (!ed) { desenharLista(); if (sel) detalhe(); } }));
    offs.push(on('cercas', () => { if (!ed) carregar(false); }));
    offs.push(on('empresa', () => { S.cercas = null; }));
    offs.push(on('frota', desenharVeiculos));
    offs.push(on('item', agendarVeiculos));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    clearTimeout(veicTimer);
    if (mapa) mapa.remove();
    mapa = null;
    camadas = new Map();
    camadaVeic = null;
    sel = null;
    ed = null;
  }

  async function carregar(ajustar) {
    try {
      lista = await carregarCercas(true);
    } catch (e) {
      const l = $('#ce-lista');
      if (l) l.innerHTML = `<div class="fleet-empty" style="color:var(--err)">${H(e.message)}</div>`;
      return;
    }
    if (!mapa && !$('#ce-lista')) return;
    if (sel && !lista.some((x) => x.id === sel)) sel = null;
    desenharLista();
    desenharMapa(ajustar);
    desenharVeiculos();
    if (sel) detalhe();
  }

  /* ---------- lista ---------- */

  function painelLista() {
    $('#ce-painel').innerHTML = `
      <div class="fleet-head">
        <label class="search">${ico('search', 'i-sm')}<input id="ce-q" placeholder="Buscar cerca" autocomplete="off"></label>
        <select id="ce-fin" aria-label="Tipo de cerca"><option value="">Todos os tipos</option>${Object.entries(FINALIDADES_CERCA).map(([id, x]) => `<option value="${id}">${H(x.nome)}</option>`).join('')}</select>
        ${podeTela('cercas', 'incluir') ? `<button class="btn btn-primary" type="button" id="ce-nova">${ico('plus', 'i-sm')} Nova cerca</button>` : ''}
      </div>
      <div class="fleet-list" id="ce-lista"><div class="fleet-empty">Carregando…</div></div>`;
    $('#ce-q').value = f.q;
    $('#ce-fin').value = f.fin;
    $('#ce-q').addEventListener('input', (e) => { f.q = e.target.value; desenharLista(); });
    $('#ce-fin').addEventListener('change', (e) => { f.fin = e.target.value; desenharLista(); desenharMapa(false); });
    if ($('#ce-nova')) $('#ce-nova').addEventListener('click', () => editar(null));
    $('#ce-lista').addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b) selecionar(Number(b.dataset.id), true);
    });
  }

  function filtradas() {
    const q = norm(f.q);
    return lista.filter((c) => (!f.fin || c.finalidade === f.fin) && (!q || norm([c.nome, c.grupo, c.empresa, FINALIDADES_CERCA[c.finalidade].nome].join(' ')).includes(q)));
  }

  function desenharLista() {
    const box = $('#ce-lista');
    if (!box) return;
    const l = filtradas();
    if (!l.length) {
      box.innerHTML = `<div class="fleet-empty">${lista.length ? 'Nenhuma cerca com esse filtro.' : `Nenhuma cerca ainda.<br><br>Comece pela <b>garagem</b>: clique em <b>Nova cerca</b> e marque no mapa onde ela fica.`}</div>`;
      return;
    }
    box.innerHTML = l.map((c) => {
      const fin = FINALIDADES_CERCA[c.finalidade];
      const tam = c.forma === 'circulo' ? `raio ${fmtMetros(c.raio)}` : `área ${fmtArea(c.area || 0)}`;
      const sub = [fin.nome, c.grupo || (S.eu.perfil === 'master' && !S.empresa ? c.empresa : ''), tam].filter(Boolean).join(' · ');
      const avisa = c.finalidade === 'proibida' || c.alertaEntrada || c.alertaSaida;
      return `<button class="fi ce-item${c.id === sel ? ' sel' : ''}${c.ativo ? '' : ' inativo'}" type="button" data-id="${c.id}">
        <span class="ce-cor" style="--c:${fin.cor}">${ico(fin.ico, 'i-sm')}</span>
        <span class="fi-main"><b>${H(c.nome)}${c.ativo ? '' : ' <span class="tag">desativada</span>'}</b><small>${H(sub)}</small></span>
        <span class="fi-meta">${avisa ? `<span title="${H(resumoAvisos(c))}">${ico('bell', 'i-xs')}</span>` : ''}<span class="ce-n${c.dentro.length ? ' tem' : ''}" title="Veículos dentro agora">${ico('bus', 'i-xs')} ${c.dentro.length}</span></span>
      </button>`;
    }).join('');
  }

  /* ---------- mapa ---------- */

  function desenharMapa(ajustar) {
    if (!mapa) return;
    camadas.forEach((l) => l.remove());
    camadas = new Map();
    const vis = new Set(filtradas().map((c) => c.id));
    for (const c of lista) {
      if (ed && ed.id === c.id) continue; // a que está sendo editada aparece só no desenho
      if (!vis.has(c.id)) continue;
      const l = camadaCerca(c, { interativo: !ed, fraco: Boolean(ed) });
      if (!ed) l.on('click', () => selecionar(c.id, false));
      l.addTo(mapa);
      camadas.set(c.id, l);
    }
    destacar();
    if (ajustar) {
      const b = lista.length ? L.latLngBounds([].concat(...lista.map(limites))) : null;
      if (b && b.isValid()) mapa.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
      else {
        const pts = itensVisiveis().filter(temPosicao).map((i) => [i.posicao.lat, i.posicao.lng]);
        if (pts.length) mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      }
    }
    rotulos();
  }

  /** Cantos de uma cerca (para enquadrar no mapa). */
  function limites(c) {
    if (c.forma === 'poligono') return c.pontos;
    const dLat = c.raio / 111320;
    const dLng = c.raio / (111320 * Math.cos((c.lat * Math.PI) / 180));
    return [[c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]];
  }

  function rotulos() {
    const card = $('#ce-mapcard');
    if (card && mapa) card.classList.toggle('sem-rotulos', mapa.getZoom() < 13);
  }

  function destacar() {
    camadas.forEach((l, id) => {
      l.setStyle({ weight: id === sel ? 4 : 2.5, fillOpacity: id === sel ? 0.22 : 0.13 });
      if (id === sel) l.bringToFront();
    });
  }

  let veicTimer = null;
  function agendarVeiculos() {
    if (veicTimer) return;
    veicTimer = setTimeout(() => { veicTimer = null; desenharVeiculos(); }, 2000);
  }

  /** Veículos como pontinhos (ajudam a achar a garagem e a conferir quem está dentro). */
  function desenharVeiculos() {
    if (!mapa || !camadaVeic) return;
    camadaVeic.clearLayers();
    for (const i of itensVisiveis()) {
      if (!temPosicao(i) || i.pendente) continue;
      const cor = i.alertas.length ? 'var(--err)' : i.online ? (i.posicao.vel > 3 ? 'var(--ok)' : 'var(--info)') : '#64748B';
      L.circleMarker([i.posicao.lat, i.posicao.lng], { radius: 5, weight: 1.5, color: '#fff', fillColor: cor, fillOpacity: 1, className: 'ce-veic' })
        .bindTooltip(H(rotulo(i)), { direction: 'top', offset: [0, -4] })
        .addTo(camadaVeic);
    }
  }

  /* ---------- detalhe ---------- */

  function selecionar(id, centralizar) {
    if (ed) return;
    sel = id;
    $$('#ce-lista .ce-item').forEach((b) => b.classList.toggle('sel', Number(b.dataset.id) === id));
    destacar();
    detalhe();
    const c = lista.find((x) => x.id === id);
    if (centralizar && c && mapa) mapa.fitBounds(limites(c), { padding: [60, 60], maxZoom: 17 });
  }

  function detalhe() {
    const box = $('#ce-det');
    if (!box) return;
    const c = lista.find((x) => x.id === sel);
    if (!c) { box.hidden = true; return; }
    const fin = FINALIDADES_CERCA[c.finalidade];
    const dentro = c.dentro.map((k) => S.itens.get(k)).filter(Boolean).sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
    const dado = (t, v) => `<div><span>${H(t)}</span><strong>${v}</strong></div>`;
    // quem só enxerga alguns grupos não mexe nas cercas gerais (valem para a empresa toda)
    const doEscopo = S.eu.perfil === 'master' || S.eu.todosGrupos || Boolean(c.grupo);
    const podeAlt = doEscopo && podeTela('cercas', 'alterar');
    const podeExc = doEscopo && podeTela('cercas', 'excluir');
    const tipoRel = c.finalidade === 'garagem' ? 'garagem' : 'cercas';
    box.innerHTML = `
      <div class="det-head">
        <div class="info-ico" style="background:${fin.cor}1f;color:${fin.cor}">${ico(fin.ico)}</div>
        <div style="min-width:0"><div class="eyebrow">${H(fin.nome)}${c.ativo ? '' : ' · desativada'}</div>
          <div class="info-title">${H(c.nome)}</div>
          <div class="small muted">${H(c.grupo ? `Só o grupo ${c.grupo}` : 'Todos os veículos da empresa')}</div></div>
        <button class="det-close" type="button" data-fechar-det aria-label="Fechar">${ico('x', 'i-sm')}</button>
      </div>
      <div class="det-grid">
        ${dado('Formato', c.forma === 'circulo' ? `Círculo de ${fmtMetros(c.raio)}` : `Área de ${c.pontos.length} pontos`)}
        ${dado('Tamanho', fmtArea(c.area || 0))}
      </div>
      <div class="ce-avisos">${ico('bell', 'i-sm')} ${H(resumoAvisos(c))}</div>
      ${c.observacao ? `<p class="small muted" style="margin:0">${H(c.observacao)}</p>` : ''}
      <div class="info-block"><div class="block-title">Dentro agora (${dentro.length})</div>
        ${dentro.length ? `<div class="ce-dentro">${dentro.map((i) => `<button type="button" class="chip" data-v="${H(i.chave)}" ${podeTela('mapa') ? '' : 'disabled'}>${H(rotuloCurto(i))}</button>`).join('')}</div>` : '<p class="small muted" style="margin:0">Nenhum veículo dentro agora.</p>'}</div>
      <div class="det-actions">
        ${podeAlt ? `<button class="btn btn-sm" type="button" data-editar>${ico('pencil', 'i-sm')} Editar</button>` : ''}
        ${podeTela('relatorios') ? `<button class="btn btn-sm" type="button" data-rel>${ico('file-analytics', 'i-sm')} ${c.finalidade === 'garagem' ? 'Saídas e chegadas' : 'Passagens'}</button>` : ''}
        ${podeAlt ? `<button class="btn btn-sm btn-ghost" type="button" data-ativo>${c.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}${podeExc ? `<button class="btn btn-sm btn-ghost" type="button" data-excluir style="color:var(--err)">${ico('trash', 'i-sm')} Excluir</button>` : ''}
      </div>`;
    box.hidden = false;
    box.querySelector('[data-fechar-det]').onclick = () => { sel = null; box.hidden = true; destacar(); $$('#ce-lista .ce-item').forEach((b) => b.classList.remove('sel')); };
    box.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => navegar('mapa', qs({ v: b.dataset.v })); });
    const rel = box.querySelector('[data-rel]');
    if (rel) rel.onclick = () => navegar('relatorios', qs({ tipo: tipoRel, cerca: c.id }));
    const e = box.querySelector('[data-editar]');
    if (e) e.onclick = () => editar(c);
    const a = box.querySelector('[data-ativo]');
    if (a) a.onclick = () => salvar({ ...corpoDe(c), ativo: !c.ativo }, c.id).then(() => toast(c.ativo ? 'Cerca desativada: não gera mais avisos.' : 'Cerca reativada.', 'ok')).catch((err) => toast(err.message, 'err'));
    const x = box.querySelector('[data-excluir]');
    if (x) {
      x.onclick = async () => {
        if (!await confirmar(`Excluir a cerca "${c.nome}"? Os alertas que ela já gerou continuam no histórico. Se só quer parar os avisos, use Desativar.`, { titulo: 'Excluir cerca', ok: 'Excluir', perigo: true })) return;
        try {
          await api(`/api/cercas/${c.id}`, { metodo: 'DELETE' });
          sel = null;
          $('#ce-det').hidden = true;
          toast('Cerca excluída.', 'ok');
          await carregar(false);
        } catch (err) { toast(err.message, 'err'); }
      };
    }
  }

  /** Cerca → corpo do PUT (para ativar/desativar sem abrir o desenho). */
  function corpoDe(c) {
    return {
      nome: c.nome, finalidade: c.finalidade, forma: c.forma, lat: c.lat, lng: c.lng, raio: c.raio, pontos: c.pontos,
      grupo: c.grupoId || '', alertaEntrada: c.alertaEntrada, alertaSaida: c.alertaSaida,
      horarioInicio: c.horarioInicio || '', horarioFim: c.horarioFim || '', observacao: c.observacao || '', ativo: c.ativo,
    };
  }

  async function salvar(corpo, id) {
    if (id) await api(`/api/cercas/${id}`, { metodo: 'PUT', corpo });
    else {
      const r = await api('/api/cercas', { corpo });
      id = r.id;
    }
    await carregar(false);
    return id;
  }

  /* ---------- desenho ---------- */

  async function editar(c) {
    if (!mapa) return;
    let empresa = c ? c.empresaId : null;
    if (!c) {
      empresa = await escolherEmpresa();
      if (!empresa) return;
    }
    sel = null;
    $('#ce-det').hidden = true;
    ed = {
      id: c ? c.id : null, empresa, forma: c ? c.forma : 'circulo', raio: c && c.raio ? c.raio : 150,
      centro: c && c.forma === 'circulo' ? L.latLng(c.lat, c.lng) : null,
      pontos: c && c.forma === 'poligono' ? c.pontos.map((p) => L.latLng(p[0], p[1])) : [],
      camada: L.layerGroup().addTo(mapa),
    };
    const grupos = S.grupos.filter((g) => String(g.empresaId) === String(empresa));
    const v = c || { finalidade: 'garagem', alertaEntrada: false, alertaSaida: true, ativo: true };
    $('#ce-painel').innerHTML = `
      <div class="ce-ed">
        <div class="ce-ed-tit">${ico(c ? 'pencil' : 'fence')}<h3>${c ? 'Editar cerca' : 'Nova cerca'}</h3></div>
        <label class="field"><span>Nome <span class="req">*</span></span><input id="ed-nome" maxlength="80" placeholder="Ex.: Garagem Central" value="${H(v.nome || '')}"></label>
        <label class="field">Tipo<select id="ed-fin">${Object.entries(FINALIDADES_CERCA).map(([id, x]) => `<option value="${id}"${id === v.finalidade ? ' selected' : ''}>${H(x.nome)}</option>`).join('')}</select></label>
        <div class="field">Formato<div class="seg" id="ed-forma">
          <button class="seg-btn" type="button" data-f="circulo">${ico('circle', 'i-sm')} Círculo</button>
          <button class="seg-btn" type="button" data-f="poligono">${ico('polygon', 'i-sm')} Área livre</button></div></div>
        <label class="field" data-so="circulo">Raio (metros)<input type="number" id="ed-raio" min="20" max="50000" step="10" value="${ed.raio}"></label>
        <div class="ce-ed-pts" data-so="poligono"><span id="ed-npts"></span>
          <button class="btn btn-sm" type="button" id="ed-desfazer">${ico('arrow-back-up', 'i-sm')} Desfazer</button>
          <button class="btn btn-sm btn-ghost" type="button" id="ed-limpar">Limpar</button></div>
        <label class="field">Ir até um veículo no mapa<select id="ed-ir">${opcoesVeiculos('', { vazio: 'Escolha para centralizar o mapa' })}</select></label>
        <label class="field">Vale para<select id="ed-grupo"><option value="">Todos os veículos da empresa</option>${grupos.map((g) => `<option value="${g.id}"${String(g.id) === String(v.grupoId) ? ' selected' : ''}>Só o grupo ${H(g.caminho)}</option>`).join('')}</select></label>
        <div class="form-sep">Avisos</div>
        <div class="form-aviso" id="ed-proib" style="margin:0">A área proibida sempre avisa: abre um alerta de gravidade alta quando o veículo entra e fecha quando ele sai.</div>
        <div id="ed-avisos">
          <label class="field-check"><input type="checkbox" id="ed-ent"${v.alertaEntrada ? ' checked' : ''}> Avisar quando um veículo <b>entrar</b></label>
          <label class="field-check"><input type="checkbox" id="ed-sai"${v.alertaSaida ? ' checked' : ''}> Avisar quando um veículo <b>sair</b></label>
          <div class="ce-horario">
            <label class="field">Horário permitido: das<input type="time" id="ed-hi" value="${H(v.horarioInicio || '')}"></label>
            <label class="field">até<input type="time" id="ed-hf" value="${H(v.horarioFim || '')}"></label>
          </div>
          <small class="hint">Com horário, só avisa o que acontecer fora dele (ex.: ônibus saindo da garagem de madrugada). Sem horário, avisa sempre.</small>
        </div>
        <label class="field">Observação<input id="ed-obs" maxlength="255" value="${H(v.observacao || '')}"></label>
        ${c ? `<label class="field-check"><input type="checkbox" id="ed-ativo"${c.ativo ? ' checked' : ''}> Cerca ativa</label>` : ''}
        <p class="form-erro" id="ed-erro" hidden></p>
        <div class="ce-ed-rodape"><button class="btn" type="button" id="ed-cancelar">Cancelar</button><button class="btn btn-primary" type="button" id="ed-salvar">${ico('check', 'i-sm')} Salvar cerca</button></div>
      </div>`;
    const atualizarCampos = () => {
      $$('#ed-forma [data-f]').forEach((b) => b.classList.toggle('active', b.dataset.f === ed.forma));
      $$('#ce-painel [data-so]').forEach((el) => { el.hidden = el.dataset.so !== ed.forma; });
      const proib = $('#ed-fin').value === 'proibida';
      $('#ed-proib').hidden = !proib;
      $('#ed-avisos').hidden = proib;
      $('#ed-npts').textContent = `${ed.pontos.length} ponto${ed.pontos.length === 1 ? '' : 's'}`;
      $('#ed-desfazer').disabled = !ed.pontos.length;
      $('#ed-limpar').disabled = !ed.pontos.length;
    };
    ed.atualizarCampos = atualizarCampos;
    $('#ed-forma').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b || b.dataset.f === ed.forma) return;
      // troca o formato aproveitando o lugar já marcado
      if (b.dataset.f === 'poligono' && ed.centro && !ed.pontos.length) ed.pontos = quadrado(ed.centro, ed.raio);
      if (b.dataset.f === 'circulo' && !ed.centro && ed.pontos.length) ed.centro = L.latLngBounds(ed.pontos).getCenter();
      ed.forma = b.dataset.f;
      redesenhar();
    });
    $('#ed-fin').addEventListener('change', redesenhar);
    $('#ed-raio').addEventListener('input', () => {
      const r = Number($('#ed-raio').value);
      if (r >= 20 && r <= 50000) { ed.raio = r; redesenhar(); }
    });
    $('#ed-desfazer').addEventListener('click', () => { ed.pontos.pop(); redesenhar(); });
    $('#ed-limpar').addEventListener('click', () => { ed.pontos = []; redesenhar(); });
    $('#ed-ir').addEventListener('change', (e) => {
      const i = S.itens.get(e.target.value);
      if (i && temPosicao(i)) mapa.setView([i.posicao.lat, i.posicao.lng], 17);
      e.target.value = '';
    });
    $('#ed-cancelar').addEventListener('click', fecharEditor);
    $('#ed-salvar').addEventListener('click', confirmarEdicao);
    mapa.on('click', cliqueMapa);
    $('#ce-mapcard').classList.add('desenhando');
    desenharMapa(false);
    redesenhar();
    if (c) mapa.fitBounds(limites(c), { padding: [60, 60], maxZoom: 17 });
    setTimeout(() => { const n = $('#ed-nome'); if (n) n.focus(); }, 50);
  }

  function quadrado(centro, raio) {
    const dLat = raio / 111320;
    const dLng = raio / (111320 * Math.cos((centro.lat * Math.PI) / 180));
    return [[1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => L.latLng(centro.lat + a * dLat, centro.lng + b * dLng));
  }

  function cliqueMapa(e) {
    if (!ed) return;
    if (ed.forma === 'circulo') ed.centro = e.latlng;
    else ed.pontos.push(e.latlng);
    redesenhar();
  }

  const alca = (cls) => L.divIcon({ className: '', html: `<div class="ce-alca ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });

  function pontoBorda() {
    return L.latLng(ed.centro.lat, ed.centro.lng + ed.raio / (111320 * Math.cos((ed.centro.lat * Math.PI) / 180)));
  }

  function redesenhar() {
    if (!ed || !mapa) return;
    ed.camada.clearLayers();
    const cor = FINALIDADES_CERCA[$('#ed-fin').value].cor;
    const estilo = { color: cor, weight: 2.5, fillColor: cor, fillOpacity: 0.16, interactive: false };
    if (ed.forma === 'circulo' && ed.centro) {
      const circ = L.circle(ed.centro, { ...estilo, radius: ed.raio }).addTo(ed.camada);
      const borda = L.marker(pontoBorda(), { draggable: true, icon: alca('raio'), title: 'Arraste para mudar o tamanho', zIndexOffset: 900 }).addTo(ed.camada);
      const meio = L.marker(ed.centro, { draggable: true, icon: alca('centro'), title: 'Arraste para mover', zIndexOffset: 1000 }).addTo(ed.camada);
      meio.on('drag', (ev) => { ed.centro = ev.target.getLatLng(); circ.setLatLng(ed.centro); borda.setLatLng(pontoBorda()); });
      borda.on('drag', (ev) => {
        ed.raio = Math.min(50000, Math.max(20, Math.round(mapa.distance(ed.centro, ev.target.getLatLng()))));
        circ.setRadius(ed.raio);
        $('#ed-raio').value = ed.raio;
      });
      borda.on('dragend', () => borda.setLatLng(pontoBorda()));
    }
    if (ed.forma === 'poligono' && ed.pontos.length) {
      const forma = ed.pontos.length >= 3 ? L.polygon(ed.pontos, estilo) : L.polyline(ed.pontos, { ...estilo, dashArray: '6 6' });
      forma.addTo(ed.camada);
      // ponto no meio de cada lado: clicar cria um canto ali
      if (ed.pontos.length >= 2) {
        const n = ed.pontos.length;
        for (let i = 0; i < (n >= 3 ? n : n - 1); i++) {
          const a = ed.pontos[i];
          const b = ed.pontos[(i + 1) % n];
          const m = L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], { icon: alca('meio'), title: 'Clique para criar um canto aqui', zIndexOffset: 800 }).addTo(ed.camada);
          m.on('click', () => { ed.pontos.splice(i + 1, 0, m.getLatLng()); redesenhar(); });
        }
      }
      ed.pontos.forEach((p, i) => {
        const m = L.marker(p, { draggable: true, icon: alca(i === 0 ? 'vertice primeiro' : 'vertice'), title: 'Arraste para ajustar; clique para tirar', zIndexOffset: 1000 }).addTo(ed.camada);
        m.on('drag', (ev) => { ed.pontos[i] = ev.target.getLatLng(); forma.setLatLngs(ed.pontos); });
        m.on('dragend', redesenhar);
        m.on('click', () => { ed.pontos.splice(i, 1); redesenhar(); });
      });
    }
    ed.atualizarCampos();
    dica();
  }

  function dica() {
    const d = $('#ce-dica');
    if (!d) return;
    let t;
    if (ed.forma === 'circulo') t = ed.centro ? 'Arraste o ponto do meio para mover e a alça da borda para mudar o tamanho (ou digite o raio).' : 'Clique no mapa onde fica o centro da cerca.';
    else if (ed.pontos.length < 3) t = `Clique no mapa para marcar os cantos da área${ed.pontos.length ? ` (faltam ${3 - ed.pontos.length})` : ' (pelo menos 3)'}.`;
    else t = 'Arraste os cantos para ajustar. Clique num canto para tirar, ou no ponto do meio de um lado para criar outro canto.';
    d.innerHTML = `${ico('info-circle', 'i-sm')} ${H(t)}`;
    d.hidden = false;
  }

  function fecharEditor() {
    if (ed) { ed.camada.remove(); mapa.off('click', cliqueMapa); }
    ed = null;
    $('#ce-dica').hidden = true;
    $('#ce-mapcard').classList.remove('desenhando');
    painelLista();
    desenharLista();
    desenharMapa(false);
  }

  async function confirmarEdicao() {
    const erro = $('#ed-erro');
    const b = $('#ed-salvar');
    erro.hidden = true;
    const corpo = {
      empresa: ed.empresa, nome: $('#ed-nome').value.trim(), finalidade: $('#ed-fin').value, forma: ed.forma,
      grupo: $('#ed-grupo').value, alertaEntrada: $('#ed-ent').checked, alertaSaida: $('#ed-sai').checked,
      horarioInicio: $('#ed-hi').value, horarioFim: $('#ed-hf').value, observacao: $('#ed-obs').value.trim(),
      ativo: $('#ed-ativo') ? $('#ed-ativo').checked : true,
    };
    try {
      if (corpo.nome.length < 2) throw new Error('Dê um nome para a cerca (ex.: Garagem Central).');
      if (ed.forma === 'circulo') {
        if (!ed.centro) throw new Error('Clique no mapa para marcar o centro da cerca.');
        Object.assign(corpo, { lat: ed.centro.lat, lng: ed.centro.lng, raio: ed.raio });
      } else {
        if (ed.pontos.length < 3) throw new Error('Marque pelo menos 3 cantos no mapa para formar a área.');
        corpo.pontos = ed.pontos.map((p) => [p.lat, p.lng]);
      }
      b.disabled = true;
      const id = await salvar(corpo, ed.id);
      toast(ed.id ? 'Cerca atualizada.' : 'Cerca criada. Os avisos já valem a partir de agora.', 'ok');
      fecharEditor();
      selecionar(id, false);
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
      b.disabled = false;
    }
  }

  return { id: 'cercas', titulo: 'Cercas', sub: 'Garagens, pontos e áreas desenhados no mapa, com avisos de entrada e saída', cheia: true, render, sair };
})();
