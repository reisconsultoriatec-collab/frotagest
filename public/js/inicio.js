'use strict';
/* FrotaGest — Início: dashboard da frota ao vivo. Situação agora (tempo real), km de hoje comparado com
 * ontem, últimos 14 dias, alertas do dia, garagens, ranking e quem está sem comunicação. Tudo filtrável
 * por grupo e com atalhos para as telas de cada assunto (respeitando o Controle de acesso). Reis Tecnologia */

PAGINAS.inicio = (() => {
  let offs = [];
  let timers = {};
  let dados = null; // /api/painel
  let alertas = []; // pendentes (lista)
  let mapa = null;
  let marcadores = new Map();
  let camadaGaragens = null;
  let enquadrou = false;
  let modoHora = 'km';
  let seq = 0;
  let agendado = null;

  const cor = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmtKm = (v) => `${fmtNum(v, v >= 100 || v === 0 ? 0 : 1)} km`;
  const hora = () => Number(textoServidor().slice(11, 13));

  /* ---------- filtro por grupo (inclui os subgrupos) ---------- */

  function grupoSel() {
    const g = pref('painelGrupo', '');
    return g && S.grupos.some((x) => String(x.id) === String(g)) ? String(g) : '';
  }
  function gruposDoFiltro() {
    const g = grupoSel();
    if (!g) return null;
    const out = new Set([Number(g)]);
    let mudou = true;
    while (mudou) {
      mudou = false;
      for (const x of S.grupos) if (x.paiId && out.has(x.paiId) && !out.has(x.id)) { out.add(x.id); mudou = true; }
    }
    return out;
  }
  function frota() {
    const gs = gruposDoFiltro();
    return itensVisiveis().filter((i) => !i.pendente && (!gs || gs.has(i.grupoId)));
  }
  function veiculosDoFiltro() {
    return new Set(frota().map((i) => i.veiculoId).filter(Boolean));
  }

  /* ---------- situação agora (do tempo real) ---------- */

  function situacao(l) {
    const comAp = l.filter((i) => !i.semAparelho);
    const on = comAp.filter((i) => i.online);
    const mov = on.filter((i) => i.posicao && i.posicao.vel > 3);
    const parados = on.length - mov.length;
    const paradosLigados = on.filter((i) => !(i.posicao && i.posicao.vel > 3) && i.posicao && i.posicao.ign).length;
    const garagens = (S.cercas || []).filter((c) => c.finalidade === 'garagem' && c.ativo !== false);
    const idsGar = new Set(garagens.map((c) => c.id));
    const naGaragem = comAp.filter((i) => (i.cercas || []).some((c) => idsGar.has(c.id))).length;
    return { total: l.length, comAp: comAp.length, on: on.length, mov: mov.length, parados, paradosLigados, off: comAp.length - on.length, semAp: l.length - comAp.length, garagens, naGaragem, comAlarme: l.filter((i) => i.alertas.length).length };
  }

  /* ---------- números de hoje (servidor) ---------- */

  function somarHoje(ids) {
    const r = { km: 0, kmHora: new Array(24).fill(0), rodando: new Array(24).fill(0), excessos: 0, veic: [] };
    if (!dados) return r;
    for (const v of dados.hoje) {
      if (!ids.has(v.id)) continue;
      r.km += v.km;
      r.excessos += v.excessos;
      v.kmHora.forEach((k, h) => { r.kmHora[h] += k; if (k >= 0.2) r.rodando[h]++; });
      r.veic.push(v);
    }
    return r;
  }
  function somarOntem(ids) {
    const kmHora = new Array(24).fill(0);
    const rodando = new Array(24).fill(0);
    let tem = false;
    if (dados) {
      for (const [id, h] of Object.entries(dados.historico)) {
        if (!ids.has(Number(id)) || !h.ontemHora) continue;
        tem = true;
        h.ontemHora.forEach((k, i) => { kmHora[i] += k; if (k >= 0.2) rodando[i]++; });
      }
    }
    return tem ? { kmHora, rodando } : null;
  }
  function alertasHoje(ids) {
    if (!dados || !dados.alertas) return [];
    return dados.alertas.itens.filter((a) => ids.has(a[0])).map((a) => ({ veiculo: a[0], minuto: a[1], gravidade: a[2], nome: dados.alertas.nomes[a[3]], situacao: a[4] }));
  }

  /* ---------- tela ---------- */

  function saudacao() {
    const h = hora();
    const nome = String(S.eu.nome || '').split(' ')[0];
    return `${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'}${nome ? `, ${nome}` : ''}`;
  }

  function render(c) {
    enquadrou = false;
    const dataLonga = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    const al = podeTela('alertas');
    const verMapa = podeTela('mapa');
    c.innerHTML = `
      <div class="page db">
        <div class="db-topo">
          <div class="db-ola"><h2>${H(saudacao())}</h2>
            <p>${H(dataLonga)} <span class="db-vivo" title="Atualiza sozinho"><i></i>ao vivo</span> <span class="muted" id="db-atual"></span></p></div>
          <div class="db-filtros">
            <label class="db-sel" title="Mostrar só um grupo">${ico('folders', 'i-sm')}<select id="db-grupo" aria-label="Grupo"></select></label>
          </div>
        </div>
        <div class="db-avisos">
          ${podeTela('usuarios') ? '<section class="card" id="ini-cad" hidden></section>' : ''}${podeTela('saude') ? '<section class="card" id="ini-saude" hidden></section>' : ''}
          ${S.eu.perfil === 'master' ? '<section class="card" id="ini-pend" hidden></section>' : ''}
        </div>

        <div class="db-kpis" id="db-kpis">
          <section class="card db-hero" id="k-km" ${podeTela('relatorios') ? 'data-ir="relatorios" data-q="tipo=resumo" tabindex="0" role="link"' : ''}>
            <div class="db-tile-top"><span class="db-rot">${ico('route', 'i-sm')} Km rodados hoje</span></div>
            <div class="db-hero-v"><span class="kpi-value" id="k-km-v">—</span><span class="db-delta" id="k-km-delta"></span></div>
            <div class="db-hero-sub" id="k-km-sub">Calculando…</div>
            <div class="db-spark" id="k-km-spark"></div>
          </section>
          ${tile('k-on', 'wifi', 'Online agora', verMapa ? 'online' : null)}
          ${tile('k-mov', 'steering-wheel', 'Em movimento', verMapa ? 'online' : null)}
          ${al ? tile('k-alertas', 'bell-ringing', 'Alertas hoje', 'alertas') : tile('k-alarme', 'alert-triangle', 'Com alarme agora', verMapa ? 'alerta' : null)}
          ${tile('k-gar', 'building-warehouse', 'Na garagem', podeTela('cercas') ? 'cercas' : null)}
        </div>

        <div class="db-linha ${verMapa ? 'db-l-mapa' : ''}">
          <section class="card db-card">
            <div class="card-head"><h2>${ico('bus')} Situação da frota agora</h2><span class="db-total"><b id="k-total">0</b> veículos</span></div>
            <div class="db-corpo" id="db-situacao"></div>
          </section>
          ${verMapa ? `<section class="card db-card db-mapa-card">
            <div class="card-head"><h2>${ico('map-2')} Frota no mapa</h2><button class="link" type="button" data-ir="mapa">Abrir o monitoramento ${ico('chevron-right', 'i-sm')}</button></div>
            <div class="db-mapa-area"><div id="db-mapa"></div></div>
          </section>` : ''}
        </div>

        <div class="db-linha">
          <section class="card db-card">
            <div class="card-head"><h2>${ico('clock-hour-4')} Hoje, hora a hora</h2>
              <div class="seg db-seg" id="db-modo"><button class="seg-btn" data-m="km" type="button">Km</button><button class="seg-btn" data-m="veic" type="button">Veículos rodando</button></div></div>
            <div class="db-corpo"><div class="db-leg" id="db-hora-leg"></div><div class="db-graf" id="db-hora"><div class="db-carregando">Carregando…</div></div>
              <button class="link db-tab-btn" type="button" data-tabela="db-hora">${ico('table', 'i-sm')} Ver como tabela</button><div class="db-tab" id="db-hora-tab" hidden></div></div>
          </section>
          <section class="card db-card">
            <div class="card-head"><h2>${ico('calendar-stats')} Km rodados · últimos 14 dias</h2><span class="muted small" id="db-dias-media"></span></div>
            <div class="db-corpo"><div class="db-graf" id="db-dias"><div class="db-carregando">Carregando…</div></div>
              <button class="link db-tab-btn" type="button" data-tabela="db-dias">${ico('table', 'i-sm')} Ver como tabela</button><div class="db-tab" id="db-dias-tab" hidden></div></div>
          </section>
        </div>

        ${al ? `<div class="db-linha db-l3">
          <section class="card db-card">
            <div class="card-head"><h2>${ico('alert-triangle')} Alertas de hoje por hora</h2><span class="muted small" id="db-al-total"></span></div>
            <div class="db-corpo"><div class="db-leg" id="db-al-leg"></div><div class="db-graf" id="db-al"><div class="db-carregando">Carregando…</div></div>
              <button class="link db-tab-btn" type="button" data-tabela="db-al">${ico('table', 'i-sm')} Ver como tabela</button><div class="db-tab" id="db-al-tab" hidden></div></div>
          </section>
          <section class="card db-card">
            <div class="card-head"><h2>${ico('list-details')} Tipos de alerta hoje</h2></div>
            <div class="db-corpo" id="db-tipos"><div class="db-carregando">Carregando…</div></div>
          </section>
          <section class="card db-card">
            <div class="card-head"><h2>${ico('bell-ringing')} Pendentes</h2><button class="link" type="button" data-ir="alertas">Ver todos ${ico('chevron-right', 'i-sm')}</button></div>
            <div class="list" id="ini-alertas"><div class="list-empty">Carregando…</div></div>
          </section>
        </div>` : ''}

        <div class="db-linha db-l3">
          <section class="card db-card" id="db-gar-card">
            <div class="card-head"><h2>${ico('building-warehouse')} Garagens agora</h2></div>
            <div class="db-corpo" id="db-gar"></div>
          </section>
          <section class="card db-card">
            <div class="card-head"><h2>${ico('trophy')} Quem mais rodou hoje</h2></div>
            <div class="db-corpo" id="db-rank"><div class="db-carregando">Carregando…</div></div>
          </section>
          <section class="card db-card">
            <div class="card-head"><h2>${ico('plug-connected-x')} Sem comunicação há mais tempo</h2></div>
            <div class="list" id="ini-offline"></div>
          </section>
        </div>

        <section class="card db-card" id="db-grupos-card" hidden>
          <div class="card-head"><h2>${ico('folders')} Por grupo</h2><span class="muted small">Clique num grupo para ver só ele</span></div>
          <div class="table-wrap" id="db-grupos"></div>
        </section>
      </div>`;

    const pg = c.querySelector('.page');
    pg.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-tabela]');
      if (tb) { const t = $(`#${tb.dataset.tabela}-tab`); t.hidden = !t.hidden; tb.innerHTML = `${ico('table', 'i-sm')} ${t.hidden ? 'Ver como tabela' : 'Esconder a tabela'}`; return; }
      const st = e.target.closest('[data-st]');
      if (st) { irMapa(st.dataset.st); return; }
      const b = e.target.closest('[data-ir]');
      if (b) { navegar(b.dataset.ir, b.dataset.q || ''); return; }
      const v = e.target.closest('[data-veiculo]');
      if (v && podeTela('mapa')) { navegar('mapa', qs({ v: v.dataset.veiculo })); return; }
      const g = e.target.closest('[data-grupo]');
      if (g) { salvarPref('painelGrupo', g.dataset.grupo); montarFiltro(); redesenharTudo(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
    pg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target.closest('[role=link][data-ir], [role=link][data-st]');
      if (t) { e.preventDefault(); t.click(); }
    });
    $('#db-grupo').addEventListener('change', (e) => { salvarPref('painelGrupo', e.target.value); redesenharTudo(); });
    $('#db-modo').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      modoHora = b.dataset.m;
      desenharHora();
    });

    montarFiltro();
    desenharAoVivo();
    if (verMapa) montarMapa();
    carregar();
    carregarAlertas();
    carregarCercas().then(() => { if (!$('#db-kpis')) return; desenharAoVivo(); desenharGaragensMapa(); }).catch(() => {});
    offs.push(on('frota', () => { montarFiltro(); agendar(); }));
    offs.push(on('item', agendar));
    offs.push(on('alerta', () => { agendar(); clearTimeout(timers.alerta); timers.alerta = setTimeout(() => { carregar(); carregarAlertas(); }, 2500); }));
    offs.push(on('resumo-alertas', desenharTiles));
    offs.push(on('pendentes', desenharCadastros));
    offs.push(on('saude', desenharSaude));
    offs.push(on('empresa', () => { dados = null; enquadrou = false; montarFiltro(); carregar(); carregarAlertas(); carregarCercas(true).then(() => { desenharAoVivo(); desenharGaragensMapa(); }).catch(() => {}); }));
    offs.push(on('tema', () => { desenharHora(); desenharDias(); desenharAlertasHora(); desenharTiposEgrupos(); desenharAoVivo(); }));
    timers.recarga = setInterval(() => { if (!document.hidden) carregar(); }, 60000);
    timers.relogio = setInterval(atualizarRelogio, 5000);
    desenharCadastros();
    desenharSaude();
  }

  function tile(id, icone, rot, ir) {
    const alvo = ir === 'alertas' || ir === 'cercas' ? `data-ir="${ir}" tabindex="0" role="link"` : ir ? `data-st="${ir}" tabindex="0" role="link"` : '';
    return `<section class="card db-tile${ir ? ' clic' : ''}" id="${id}" ${alvo}>
      <div class="db-tile-top"><span class="db-rot">${ico(icone, 'i-sm')} ${H(rot)}</span></div>
      <div class="kpi-value db-tile-v">—</div><div class="db-tile-sub"></div><div class="db-medidor" hidden><i></i></div></section>`;
  }

  function irMapa(st) {
    if (!podeTela('mapa')) return;
    salvarPref('filtroStatus', st);
    navegar('mapa', grupoSel() ? qs({ g: grupoSel() }) : '');
  }

  function sair() {
    offs.forEach((f) => f());
    offs = [];
    Object.values(timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
    timers = {};
    seq++;
    if (mapa) { mapa.remove(); mapa = null; }
    marcadores = new Map();
    Dica.esconder();
  }

  function agendar() {
    if (agendado) return;
    agendado = setTimeout(() => { agendado = null; if ($('#db-kpis')) desenharAoVivo(); }, 1200);
  }

  function montarFiltro() {
    const sel = $('#db-grupo');
    if (!sel) return;
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    sel.innerHTML = `<option value="">Todos os grupos</option>${grupos.map((g) => `<option value="${g.id}">${H(g.caminho)}</option>`).join('')}`;
    sel.value = grupoSel();
    sel.closest('.db-sel').hidden = grupos.length < 2 && !grupoSel();
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const r = await api(`/api/painel${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      if (meu !== seq || !$('#db-kpis')) return;
      dados = r;
      desenharDoServidor();
    } catch (e) {
      if (meu !== seq || !$('#db-kpis')) return;
      $$('.db-carregando').forEach((x) => { x.textContent = `Não foi possível carregar: ${e.message}`; });
    }
  }

  function redesenharTudo() {
    desenharAoVivo();
    desenharDoServidor();
    if (mapa) { enquadrou = false; atualizarMapa(); }
  }

  function desenharDoServidor() {
    if (!dados || !$('#db-kpis')) return;
    desenharHero();
    desenharTiles();
    desenharSituacao();
    desenharHora();
    desenharDias();
    desenharAlertasHora();
    desenharTiposEgrupos();
    desenharRanking();
    atualizarRelogio();
  }

  function desenharAoVivo() {
    if (!$('#db-kpis')) return;
    desenharTiles();
    desenharSituacao();
    desenharGaragens();
    desenharOffline();
    desenharPendentes();
    desenharTiposEgrupos();
    if (mapa) atualizarMapa();
  }

  function atualizarRelogio() {
    const el = $('#db-atual');
    if (!el || !dados) return;
    const s = Math.max(0, Math.round((Date.now() - msDe(dados.atualizadoEm)) / 1000));
    el.textContent = s < 15 ? '· atualizado agora' : `· atualizado há ${atras(dados.atualizadoEm).replace(/^há /, '')}`;
  }

  /* ---------- cartões ---------- */

  function setTile(id, valor, sub, { medidor = null, formato = fmtNum } = {}) {
    const t = $(`#${id}`);
    if (!t) return;
    contar(t.querySelector('.db-tile-v'), valor, formato);
    t.querySelector('.db-tile-sub').innerHTML = sub;
    const m = t.querySelector('.db-medidor');
    m.hidden = medidor === null;
    if (medidor !== null) { m.querySelector('i').style.width = `${Math.max(0, Math.min(100, medidor * 100))}%`; m.title = `${Math.round(medidor * 100)}%`; }
  }

  function desenharTiles() {
    const s = situacao(frota());
    setTile('k-on', s.on, s.comAp ? `de ${fmtNum(s.comAp)} com aparelho · <b>${Math.round((s.on / s.comAp) * 100)}%</b>` : 'nenhum aparelho', { medidor: s.comAp ? s.on / s.comAp : 0 });
    setTile('k-mov', s.mov, s.on ? `${fmtNum(s.parados)} parado${s.parados === 1 ? '' : 's'}${s.paradosLigados ? ` · ${fmtNum(s.paradosLigados)} com motor ligado` : ''}` : 'nenhum online agora');
    if ($('#k-alertas')) {
      const hoje = dados && dados.alertas ? alertasHoje(veiculosDoFiltro()) : null;
      const altas = hoje ? hoje.filter((a) => a.gravidade === 'alta').length : 0;
      const pend = S.alertas.pendentes || 0;
      setTile('k-alertas', hoje ? hoje.length : 0, `${fmtNum(pend)} pendente${pend === 1 ? '' : 's'} na empresa${altas ? ` · <b class="db-alta">${fmtNum(altas)} de gravidade alta</b>` : ''}`);
    }
    if ($('#k-alarme')) setTile('k-alarme', s.comAlarme, 'veículo(s) com alarme ativo');
    if (s.garagens.length) setTile('k-gar', s.naGaragem, `${fmtNum(s.comAp - s.naGaragem)} fora da garagem · ${s.garagens.length} garage${s.garagens.length === 1 ? 'm' : 'ns'}`, { medidor: s.comAp ? s.naGaragem / s.comAp : 0 });
    else setTile('k-gar', s.off, 'offline (cadastre as garagens em Cercas para ver quem está recolhido)');
    const kg = $('#k-gar .db-rot');
    if (kg) kg.innerHTML = s.garagens.length ? `${ico('building-warehouse', 'i-sm')} Na garagem` : `${ico('plug-connected-x', 'i-sm')} Offline`;
  }

  function desenharHero() {
    const ids = veiculosDoFiltro();
    const h = somarHoje(ids);
    const ontem = somarOntem(ids);
    contar($('#k-km-v'), h.km, fmtKm);
    const rodaram = h.veic.filter((v) => v.km >= 0.5).length;
    const mov = h.veic.reduce((t, v) => t + v.movimento, 0);
    $('#k-km-sub').innerHTML = `${fmtNum(rodaram)} veículo${rodaram === 1 ? '' : 's'} rodaram · ${fmtNum(Math.round(mov / 3600))} h em movimento${h.excessos ? ` · ${fmtNum(h.excessos)} excesso${h.excessos === 1 ? '' : 's'} acima de ${dados.limiteKmh} km/h` : ''}`;
    // comparação justa: ontem até esta mesma hora
    const d = $('#k-km-delta');
    d.textContent = '';
    d.className = 'db-delta';
    if (ontem) {
      const agoraH = hora();
      const min = Number(textoServidor().slice(14, 16));
      const ateAgora = ontem.kmHora.slice(0, agoraH).reduce((a, b) => a + b, 0) + ontem.kmHora[agoraH] * (min / 60);
      if (ateAgora > 1) {
        const p = Math.round(((h.km - ateAgora) / ateAgora) * 100);
        d.textContent = `${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}% em relação a ontem até esta hora`;
        d.title = `Ontem até ${String(agoraH).padStart(2, '0')}:${String(min).padStart(2, '0')}: ${fmtKm(ateAgora)}`;
      }
    }
    const atual = hora();
    colunas($('#k-km-spark'), {
      rotulos: h.kmHora.map((_, i) => `${String(i).padStart(2, '0')}h`), series: [{ nome: 'km', cor: cor('--g-suave'), valores: h.kmHora.map((v, i) => (i <= atual ? v : 0)) }],
      destaque: atual, corDestaque: cor('--g-destaque'), compacto: true, altura: 38, formato: fmtKm, titulo: 'Km por hora hoje',
    });
  }

  /* ---------- situação ---------- */

  function desenharSituacao() {
    const l = frota();
    const s = situacao(l);
    contar($('#k-total'), s.total);
    const box = $('#db-situacao');
    if (!box) return;
    const partes = [
      { nome: 'Em movimento', valor: s.mov, cor: cor('--st-mov'), ir: 'online' },
      { nome: 'Parados (online)', valor: s.parados, cor: cor('--st-parado'), ir: 'online' },
      { nome: 'Offline', valor: s.off, cor: cor('--st-off'), ir: 'offline' },
    ];
    segmentada(box, partes, { aoClicar: podeTela('mapa') ? (p) => irMapa(p.ir) : null });
    const notas = [];
    if (s.comAlarme) notas.push(`<button class="link" type="button" ${podeTela('mapa') ? 'data-st="alerta"' : 'disabled'}>${ico('alert-triangle', 'i-sm')} ${fmtNum(s.comAlarme)} com alarme ativo agora</button>`);
    if (s.semAp) notas.push(`<span>${ico('device-cctv', 'i-sm')} ${fmtNum(s.semAp)} sem aparelho instalado</span>`);
    if (notas.length) box.insertAdjacentHTML('beforeend', `<div class="db-notas">${notas.join('')}</div>`);
    box.insertAdjacentHTML('beforeend', '<div class="db-subtit">Hoje</div><div id="db-hoje-med"></div>');
    const dia = textoServidor().slice(0, 10);
    const comunicaram = l.filter((i) => !i.semAparelho && (i.online || String(i.ultimoContato || '').slice(0, 10) === dia)).length;
    const ids = new Set(l.map((i) => i.veiculoId).filter(Boolean));
    const rodaram = dados ? dados.hoje.filter((v) => ids.has(v.id) && v.km >= 0.5).length : null;
    const itens = [{ nome: 'Comunicaram hoje', sub: 'aparelho falou com o servidor hoje', valor: comunicaram, texto: `${fmtNum(comunicaram)} de ${fmtNum(s.comAp)}` }];
    if (rodaram !== null) itens.push({ nome: 'Rodaram hoje', sub: 'andaram pelo menos 500 m', valor: rodaram, texto: `${fmtNum(rodaram)} de ${fmtNum(s.comAp)}` });
    listaBarras($('#db-hoje-med'), itens, { cor: cor('--g-serie'), max: Math.max(1, s.comAp) });
  }

  /* ---------- hoje hora a hora ---------- */

  function desenharHora() {
    const box = $('#db-hora');
    if (!box || !dados) return;
    $$('#db-modo .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.m === modoHora));
    const ids = veiculosDoFiltro();
    const h = somarHoje(ids);
    const ontem = somarOntem(ids);
    const atual = hora();
    const km = modoHora === 'km';
    const valores = (km ? h.kmHora : h.rodando).map((v, i) => (i <= atual ? v : 0));
    const fmt = km ? fmtKm : (v) => `${fmtNum(v)} veículo${v === 1 ? '' : 's'}`;
    const o = {
      rotulos: valores.map((_, i) => `${String(i).padStart(2, '0')}h`),
      rotulosLongos: valores.map((_, i) => `${String(i).padStart(2, '0')}:00 às ${String(i).padStart(2, '0')}:59${i === atual ? ' (agora)' : ''}`),
      series: [{ nome: 'hoje', cor: cor('--g-serie'), valores }],
      comparacao: ontem ? { nome: 'ontem', cor: cor('--g-comp'), valores: km ? ontem.kmHora : ontem.rodando } : null,
      destaque: atual, corDestaque: cor('--g-destaque'), rotularDestaque: true, formato: fmt,
      formatoEixo: km ? fmtCompacto : (v) => fmtNum(v),
      extra: km ? (i) => [{ nome: 'veículos rodando', valor: fmtNum(h.rodando[i]) }] : (i) => [{ nome: 'rodados nessa hora', valor: fmtKm(h.kmHora[i]) }],
      titulo: km ? 'Km rodados por hora hoje, comparado com ontem' : 'Veículos rodando por hora hoje, comparado com ontem',
      rotuloEixoX: 'Hora', altura: 210,
    };
    $('#db-hora-leg').innerHTML = `<span><i class="sw" style="background:${o.series[0].cor}"></i>hoje</span><span><i class="sw" style="background:${o.corDestaque}"></i>hora atual</span>${o.comparacao ? `<span><i class="ln" style="background:${o.comparacao.cor}"></i>ontem</span>` : ''}`;
    colunas(box, o);
    $('#db-hora-tab').innerHTML = tabelaGrafico(o);
  }

  /* ---------- últimos 14 dias ---------- */

  function desenharDias() {
    const box = $('#db-dias');
    if (!box || !dados) return;
    const ids = veiculosDoFiltro();
    const hoje = somarHoje(ids);
    const dias = [...dados.dias, dados.dia];
    const km = dados.dias.map((_, i) => Object.entries(dados.historico).reduce((t, [id, h]) => t + (ids.has(Number(id)) ? h.km[i] : 0), 0));
    const rod = dados.dias.map((_, i) => Object.entries(dados.historico).filter(([id, h]) => ids.has(Number(id)) && h.km[i] >= 0.5).length);
    const al = dados.dias.map((_, i) => Object.entries(dados.historico).reduce((t, [id, h]) => t + (ids.has(Number(id)) ? h.alertas[i] : 0), 0));
    km.push(hoje.km);
    rod.push(hoje.veic.filter((v) => v.km >= 0.5).length);
    al.push(dados.alertas ? alertasHoje(ids).length : null);
    const semana = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
    const fechados = new Set(dados.diasFechados);
    const o = {
      rotulos: dias.map((d, i) => (i === dias.length - 1 ? 'hoje' : `${d.slice(8, 10)}/${d.slice(5, 7)}`)),
      rotulosLongos: dias.map((d, i) => `${semana(d)}, ${d.slice(8, 10)}/${d.slice(5, 7)}${i === dias.length - 1 ? ' (hoje, até agora)' : fechados.has(d) ? '' : ' (ainda calculando)'}`),
      series: [{ nome: 'km rodados', cor: cor('--g-serie'), valores: km }],
      destaque: dias.length - 1, corDestaque: cor('--g-destaque'), rotularDestaque: true, formato: fmtKm,
      extra: (i) => [{ nome: 'veículos rodaram', valor: fmtNum(rod[i]) }, ...(al[i] !== null && dados.alertas ? [{ nome: 'alertas', valor: fmtNum(al[i]) }] : [])],
      aoClicar: podeTela('relatorios') ? (i) => { const d = dias[i]; navegar('relatorios', qs({ tipo: 'resumo', de: `${d} 00:00:00`, ate: `${d} 23:59:59`, ...(grupoSel() ? { grupo: grupoSel() } : {}) })); } : null,
      titulo: 'Km rodados por dia nos últimos 14 dias', rotuloEixoX: 'Dia', altura: 210,
    };
    colunas(box, o);
    $('#db-dias-tab').innerHTML = tabelaGrafico(o);
    const completos = km.slice(0, -1).filter((v, i) => fechados.has(dias[i]) && v > 0);
    $('#db-dias-media').textContent = completos.length ? `média de ${fmtKm(completos.reduce((a, b) => a + b, 0) / completos.length)} por dia` : '';
  }

  /* ---------- alertas ---------- */

  function desenharAlertasHora() {
    const box = $('#db-al');
    if (!box || !dados || !dados.alertas) return;
    const lista = alertasHoje(veiculosDoFiltro());
    const atual = hora();
    const por = (g) => Array.from({ length: 24 }, (_, h) => lista.filter((a) => a.gravidade === g && Math.floor(a.minuto / 60) === h).length);
    const series = [
      { nome: 'alta', cor: cor('--gv-alta'), valores: por('alta') },
      { nome: 'média', cor: cor('--gv-media'), valores: por('media') },
      { nome: 'baixa', cor: cor('--gv-baixa'), valores: por('baixa') },
    ];
    const o = {
      rotulos: series[0].valores.map((_, i) => `${String(i).padStart(2, '0')}h`),
      rotulosLongos: series[0].valores.map((_, i) => `${String(i).padStart(2, '0')}:00 às ${String(i).padStart(2, '0')}:59${i === atual ? ' (agora)' : ''}`),
      series, destaque: atual, formato: (v) => fmtNum(v), formatoEixo: (v) => fmtNum(v),
      aoClicar: () => navegar('alertas'), titulo: 'Alertas de hoje por hora e gravidade', rotuloEixoX: 'Hora', altura: 230,
    };
    $('#db-al-leg').innerHTML = series.map((s) => `<span><i class="sw" style="background:${s.cor}"></i>${H(s.nome)}</span>`).join('');
    $('#db-al-total').textContent = `${fmtNum(lista.length)} alerta${lista.length === 1 ? '' : 's'} hoje`;
    if (!lista.length) box.innerHTML = '<div class="list-empty">Nenhum alerta hoje. Tudo certo por aqui.</div>';
    else colunas(box, o);
    $('#db-al-tab').innerHTML = tabelaGrafico(o);
  }

  function desenharTiposEgrupos() {
    const box = $('#db-tipos');
    if (box && dados && dados.alertas) {
      const cont = new Map();
      for (const a of alertasHoje(veiculosDoFiltro())) cont.set(a.nome, (cont.get(a.nome) || 0) + 1);
      const itens = [...cont.entries()].sort((a, b) => b[1] - a[1]);
      const top = itens.slice(0, 6).map(([nome, valor]) => ({ nome, valor }));
      const resto = itens.slice(6).reduce((t, x) => t + x[1], 0);
      if (resto) top.push({ nome: 'Outros', valor: resto });
      listaBarras(box, top, { cor: cor('--g-serie'), vazio: 'Nenhum alerta hoje.', aoClicar: () => navegar('alertas') });
    }
    desenharGrupos();
  }

  async function carregarAlertas() {
    if (!podeTela('alertas')) return;
    try {
      const r = await api(`/api/alertas?${qs({ situacao: 'pendentes', limite: 6, empresa: S.empresa })}`);
      alertas = r.alertas;
    } catch {
      alertas = null;
    }
    desenharAlertas();
  }

  function desenharAlertas() {
    const box = $('#ini-alertas');
    if (!box) return;
    if (alertas === null) { box.innerHTML = '<div class="list-empty">Não foi possível carregar os alertas.</div>'; return; }
    if (!alertas.length) { box.innerHTML = '<div class="list-empty">Nenhum alerta pendente. Tudo certo por aqui.</div>'; return; }
    box.innerHTML = alertas.map((a) => {
      const it = podeTela('mapa') && [...S.itens.values()].find((i) => i.aparelhoId === a.aparelho_id);
      return `<div class="list-item"><div class="list-ico gv-${a.gravidade}">${ico('alert-triangle')}</div>
        <div class="list-main"><div class="list-title">${H(a.nome)} <span class="tag ${a.gravidade}">${H(NOMES_GRAVIDADE[a.gravidade])}</span></div>
          <div class="list-sub">${H(a.placa ? `${a.prefixo ? `${a.prefixo} · ` : ''}${a.placa}` : `Aparelho ${a.identificador}`)} · ${H(atras(a.inicio))}${a.fim ? '' : ' · <b>ativo</b>'}</div></div>
        ${it ? `<button class="link" type="button" data-veiculo="${H(it.chave)}">Ver ${ico('chevron-right', 'i-sm')}</button>` : ''}</div>`;
    }).join('');
  }

  /* ---------- garagens, ranking, offline, grupos ---------- */

  function desenharGaragens() {
    const box = $('#db-gar');
    if (!box) return;
    const l = frota();
    const garagens = (S.cercas || []).filter((c) => c.finalidade === 'garagem' && c.ativo !== false);
    if (!garagens.length) {
      box.innerHTML = `<div class="list-empty">Nenhuma garagem cadastrada.${podeTela('cercas') && podeTela('cercas', 'incluir') ? ' <button class="link" type="button" data-ir="cercas">Desenhar a garagem em Cercas</button>' : ''}</div>`;
      return;
    }
    const comAp = l.filter((i) => !i.semAparelho).length;
    const itens = garagens.map((g) => {
      const dentro = l.filter((i) => (i.cercas || []).some((c) => c.id === g.id));
      const ligados = dentro.filter((i) => i.posicao && i.posicao.ign).length;
      return { nome: g.nome, valor: dentro.length, texto: `${fmtNum(dentro.length)}`, sub: dentro.length ? `${fmtNum(ligados)} com motor ligado` : 'vazia agora', cor: cor('--st-parado') };
    }).sort((a, b) => b.valor - a.valor);
    listaBarras(box, itens, { max: Math.max(comAp, 1), aoClicar: podeTela('cercas') ? () => navegar('cercas') : null });
  }

  function desenharRanking() {
    const box = $('#db-rank');
    if (!box || !dados) return;
    const h = somarHoje(veiculosDoFiltro());
    const porVeic = new Map([...S.itens.values()].filter((i) => i.veiculoId).map((i) => [i.veiculoId, i]));
    const top = h.veic.filter((v) => v.km >= 0.5).sort((a, b) => b.km - a.km).slice(0, 6).map((v) => {
      const it = porVeic.get(v.id);
      return { nome: it ? rotulo(it) : `Veículo ${v.id}`, sub: `${it && it.grupo ? `${it.grupo} · ` : ''}máx. ${fmtNum(v.velMax)} km/h${v.excessos ? ` · ${v.excessos} excesso${v.excessos === 1 ? '' : 's'}` : ''}`, valor: v.km, texto: fmtKm(v.km), chave: it && it.chave };
    });
    listaBarras(box, top, { cor: cor('--g-serie'), vazio: 'Nenhum veículo rodou hoje ainda.', aoClicar: podeTela('mapa') ? (x) => x.chave && navegar('mapa', qs({ v: x.chave })) : null });
  }

  function desenharOffline() {
    const box = $('#ini-offline');
    if (!box) return;
    const off = frota().filter((i) => !i.semAparelho && !i.online)
      .sort((a, b) => (msDe(a.ultimoContato) || 0) - (msDe(b.ultimoContato) || 0)).slice(0, 5);
    if (!off.length) { box.innerHTML = '<div class="list-empty">Todos os aparelhos estão online.</div>'; return; }
    box.innerHTML = off.map((i) => `<div class="list-item"><div class="list-ico" style="background:var(--fundo-suave);color:var(--ink-2)">${ico('plug-connected-x')}</div>
      <div class="list-main"><div class="list-title">${H(rotulo(i))}</div>
        <div class="list-sub">${i.ultimoContato ? `Último contato ${H(atras(i.ultimoContato))}` : 'Nunca conectou'}</div></div>
      ${podeTela('mapa') ? `<button class="link" type="button" data-veiculo="${H(i.chave)}">Ver ${ico('chevron-right', 'i-sm')}</button>` : ''}</div>`).join('');
  }

  function desenharGrupos() {
    const card = $('#db-grupos-card');
    if (!card) return;
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    const l = itensVisiveis().filter((i) => !i.pendente);
    card.hidden = grupos.length < 2 || Boolean(grupoSel());
    if (card.hidden) return;
    const hoje = dados ? new Map(dados.hoje.map((v) => [v.id, v])) : new Map();
    const al = dados && dados.alertas ? alertasHoje(new Set(l.map((i) => i.veiculoId).filter(Boolean))) : null;
    const linhas = grupos.map((g) => {
      const doGrupo = l.filter((i) => i.grupoId === g.id);
      const comAp = doGrupo.filter((i) => !i.semAparelho);
      const on = comAp.filter((i) => i.online).length;
      const mov = comAp.filter((i) => i.online && i.posicao && i.posicao.vel > 3).length;
      const ids = new Set(doGrupo.map((i) => i.veiculoId));
      const km = doGrupo.reduce((t, i) => t + ((hoje.get(i.veiculoId) || {}).km || 0), 0);
      const nAl = al ? al.filter((a) => ids.has(a.veiculo)).length : null;
      return { g, total: doGrupo.length, comAp: comAp.length, on, mov, km, nAl };
    }).filter((x) => x.total);
    $('#db-grupos').innerHTML = `<table class="tbl db-tbl-grupos"><thead><tr><th>Grupo</th><th class="num">Veículos</th><th>Online agora</th><th class="num">Em movimento</th><th class="num">Km hoje</th>${al ? '<th class="num">Alertas hoje</th>' : ''}</tr></thead>
      <tbody>${linhas.map((x) => `<tr class="clic" data-grupo="${x.g.id}" tabindex="0"><td><b>${H(x.g.caminho)}</b></td><td class="num">${fmtNum(x.total)}</td>
        <td><div class="db-mini-med"><span class="db-medidor"><i style="width:${x.comAp ? (x.on / x.comAp) * 100 : 0}%"></i></span><span class="num">${fmtNum(x.on)} de ${fmtNum(x.comAp)}</span></div></td>
        <td class="num">${fmtNum(x.mov)}</td><td class="num">${dados ? H(fmtKm(x.km)) : '—'}</td>${al ? `<td class="num">${fmtNum(x.nAl)}</td>` : ''}</tr>`).join('')}</tbody></table>`;
  }

  /* ---------- mini mapa ---------- */

  function montarMapa() {
    const el = $('#db-mapa');
    mapa = criarMapa(el, { silencioso: true }); // no dashboard a troca de mapa não precisa de aviso
    if (!mapa) return;
    mapa.setView([-23.55, -46.63], 10);
    marcadores = new Map();
    atualizarMapa();
    desenharGaragensMapa();
  }

  function corStatus(i) {
    if (!i.online) return cor('--st-off');
    if (i.alertas.length) return cor('--gv-alta');
    return i.posicao && i.posicao.vel > 3 ? cor('--st-mov') : cor('--st-parado');
  }

  function atualizarMapa() {
    if (!mapa) return;
    const l = frota().filter((i) => temPosicao(i));
    const vivos = new Set();
    for (const i of l) {
      vivos.add(i.chave);
      const ll = [i.posicao.lat, i.posicao.lng];
      let m = marcadores.get(i.chave);
      const estilo = { radius: i.online ? 7 : 5, color: cor('--card'), weight: 2, fillColor: corStatus(i), fillOpacity: 1 };
      if (!m) {
        m = L.circleMarker(ll, estilo).addTo(mapa);
        m.on('click', () => navegar('mapa', qs({ v: i.chave })));
        marcadores.set(i.chave, m);
      } else {
        m.setLatLng(ll);
        m.setStyle(estilo);
      }
      const dica = `${H(rotulo(i))}<br><span class="muted">${i.online ? (i.posicao.vel > 3 ? `${fmtNum(i.posicao.vel)} km/h` : 'parado') : `offline · ${H(atras(i.ultimoContato))}`}</span>`;
      if (m.getTooltip()) m.setTooltipContent(dica); else m.bindTooltip(dica, { direction: 'top', offset: [0, -6] });
      if (i.online) m.bringToFront();
    }
    for (const [k, m] of marcadores) if (!vivos.has(k)) { m.remove(); marcadores.delete(k); }
    if (!enquadrou && l.length) {
      enquadrou = true;
      const b = L.latLngBounds(l.map((i) => [i.posicao.lat, i.posicao.lng]));
      mapa.fitBounds(b.pad(0.15), { maxZoom: 14, animate: false });
    }
  }

  function desenharGaragensMapa() {
    if (!mapa || !S.cercas || typeof camadaCerca !== 'function') return;
    if (camadaGaragens) camadaGaragens.remove();
    camadaGaragens = L.layerGroup((S.cercas || []).filter((c) => c.finalidade === 'garagem' && c.ativo !== false).map((c) => camadaCerca(c, { fraco: true, rotulo: false }))).addTo(mapa);
    camadaGaragens.eachLayer((g) => g.bringToBack && g.bringToBack());
  }

  /* ---------- avisos (cadastros, saúde, aparelhos novos) ---------- */

  function desenharPendentes() {
    const box = $('#ini-pend');
    if (!box) return;
    const p = [...S.itens.values()].filter((i) => i.pendente);
    box.hidden = !p.length;
    if (!p.length) return;
    box.innerHTML = `<div class="card-head"><h2>${ico('device-cctv')} Aparelhos conectados sem cadastro <span class="pill">${p.length}</span></h2>
      <button class="link" type="button" data-ir="sistema" data-q="aba=pendentes">Ver lista ${ico('chevron-right', 'i-sm')}</button></div>
      <p class="hint">Estes DVRs já estão falando com o servidor. Cadastre cada um (Aparelhos › Novo) e ligue a um veículo para entrar no histórico.</p>
      <div class="list compact">${p.map((i) => `<div class="list-item"><div class="list-ico" style="background:var(--amber-100);color:var(--amber-700)">${ico('device-cctv')}</div>
        <div class="list-main"><div class="list-title mono">${H(i.ident)}</div><div class="list-sub">${H(i.modelo || 'modelo não informado')} · ${H(i.protocolo || '')}</div></div>
        <button class="btn btn-sm" type="button" data-cad="${H(i.ident)}">${ico('plus', 'i-sm')} Cadastrar</button></div>`).join('')}</div>`;
    box.querySelectorAll('[data-cad]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); const it = S.itens.get(`p${b.dataset.cad}`); abrirCadastroAparelho({ identificador: b.dataset.cad, modelo: it ? it.modelo : '' }); };
    });
  }

  function desenharSaude() {
    const box = $('#ini-saude');
    if (!box) return;
    const sd = S.saude;
    box.hidden = !sd || !sd.comProblema;
    if (box.hidden) return;
    const partes = [['offline', 'offline'], ['camera', 'com câmera ou vídeo'], ['armazenamento', 'com cartão ou HD'], ['gps', 'com GPS'], ['energiaSinal', 'com alimentação ou sinal']]
      .filter(([k]) => sd[k]).map(([k, t]) => `${sd[k]} ${t}`);
    box.innerHTML = `<div class="card-head"><h2>${ico('heartbeat')} ${sd.comProblema === 1 ? '1 aparelho precisa' : `${sd.comProblema} aparelhos precisam`} de atenção${sd.graves ? ` <span class="pill err">${sd.graves} grave${sd.graves > 1 ? 's' : ''}</span>` : ''}</h2>
      <button class="btn btn-sm" type="button" data-ir="saude">${ico('heartbeat', 'i-sm')} Ver a saúde dos aparelhos</button></div>
      <p class="hint">${H(partes.join(' · '))}. A lista pode ser baixada em PDF para a manutenção.</p>`;
  }

  function desenharCadastros() {
    const box = $('#ini-cad');
    if (!box) return;
    box.hidden = !S.pendentes;
    if (!S.pendentes) return;
    box.innerHTML = `<div class="card-head"><h2>${ico('clock-pause')} ${S.pendentes === 1 ? '1 cadastro aguardando' : `${S.pendentes} cadastros aguardando`} a sua aprovação</h2>
      <button class="btn btn-primary btn-sm" type="button" data-ir="usuarios">${ico('user-check', 'i-sm')} Ver e aprovar</button></div>
      <p class="hint">Pessoas que criaram a conta na tela de entrada com o código da empresa. Elas só entram depois da aprovação.</p>`;
  }

  const nomeEmpresa = () => {
    if (S.eu.empresaNome) return S.eu.empresaNome;
    const e = S.empresa && (S.empresas || []).find((x) => String(x.id) === String(S.empresa));
    return e ? e.nome : 'Visão geral de todas as empresas';
  };
  return { id: 'inicio', titulo: 'Início', sub: nomeEmpresa, render, sair };
})();
