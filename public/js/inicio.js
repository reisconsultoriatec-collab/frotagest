'use strict';
/* FrotaGest — Início: resumo da frota, alertas pendentes e veículos sem comunicação. Reis Tecnologia */

PAGINAS.inicio = (() => {
  let offs = [];
  let timer = null;
  let alertas = [];

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <div class="kpis k5" id="ini-kpis"></div>
        <div class="grid-2">
          <section class="card">
            <div class="card-head"><h2>${ico('bell-ringing')} Alertas pendentes</h2><button class="link" type="button" data-ir="alertas">Ver todos ${ico('chevron-right', 'i-sm')}</button></div>
            <div class="list" id="ini-alertas"><div class="list-empty">Carregando…</div></div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('plug-connected-x')} Sem comunicação há mais tempo</h2><button class="link" type="button" data-ir="mapa">Abrir mapa ${ico('chevron-right', 'i-sm')}</button></div>
            <div class="list" id="ini-offline"></div>
          </section>
        </div>
        ${S.eu.perfil === 'master' ? '<section class="card" id="ini-pend" hidden></section>' : ''}
      </div>`;
    c.querySelector('.page').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ir]');
      if (b) navegar(b.dataset.ir, b.dataset.q || '');
      const v = e.target.closest('[data-veiculo]');
      if (v) navegar('mapa', qs({ v: v.dataset.veiculo }));
    });
    desenhar();
    carregarAlertas();
    offs.push(on('frota', desenhar));
    offs.push(on('item', () => { clearTimeout(timer); timer = setTimeout(desenhar, 1000); }));
    offs.push(on('alerta', () => { clearTimeout(timer); timer = setTimeout(() => { desenhar(); carregarAlertas(); }, 800); }));
    offs.push(on('resumo-alertas', desenharKpis));
  }

  function sair() {
    offs.forEach((f) => f());
    offs = [];
    clearTimeout(timer);
  }

  async function carregarAlertas() {
    try {
      const r = await api(`/api/alertas?${qs({ situacao: 'pendentes', limite: 8, empresa: S.empresa })}`);
      alertas = r.alertas;
    } catch (e) {
      alertas = null;
    }
    desenharAlertas();
  }

  function kpi(id, cls, icone, rotuloTxt, valor, sub, ir) {
    return `<div class="kpi ${cls}${ir ? ' clic' : ''}" ${ir ? `data-ir="${ir[0]}" data-q="${ir[1] || ''}"` : ''} id="${id}">
      <div class="kpi-ico">${ico(icone)}</div>
      <div class="kpi-body"><div class="kpi-label">${H(rotuloTxt)}</div><div class="kpi-value">${valor}</div><div class="kpi-sub">${H(sub)}</div></div></div>`;
  }

  function desenharKpis() {
    const box = $('#ini-kpis');
    if (!box) return;
    const l = itensVisiveis().filter((i) => !i.pendente);
    const comAp = l.filter((i) => !i.semAparelho);
    const on = comAp.filter((i) => i.online);
    const mov = on.filter((i) => i.posicao && i.posicao.vel > 3);
    const off = comAp.length - on.length;
    const comAlerta = l.filter((i) => i.alertas.length).length;
    box.innerHTML = [
      kpi('k-total', 'neutral', 'bus', 'Veículos', fmtNum(l.length), `${comAp.length} com aparelho instalado`, ['mapa']),
      kpi('k-on', 'ok', 'wifi', 'Online agora', fmtNum(on.length), comAp.length ? `${Math.round((on.length / comAp.length) * 100)}% da frota` : 'nenhum aparelho', ['mapa']),
      kpi('k-mov', 'ok', 'steering-wheel', 'Em movimento', fmtNum(mov.length), `${on.length - mov.length} parados com aparelho online`, ['mapa']),
      kpi('k-off', off ? 'err' : 'neutral', 'plug-connected-x', 'Offline', fmtNum(off), 'sem conexão com o servidor', ['mapa']),
      kpi('k-alertas', S.alertas.pendentes ? 'warn' : 'neutral', 'alert-triangle', 'Alertas pendentes', fmtNum(S.alertas.pendentes), `${comAlerta} veículo(s) com alarme ativo`, ['alertas']),
    ].join('');
  }

  function desenharAlertas() {
    const box = $('#ini-alertas');
    if (!box) return;
    if (alertas === null) { box.innerHTML = '<div class="list-empty">Não foi possível carregar os alertas.</div>'; return; }
    if (!alertas.length) { box.innerHTML = '<div class="list-empty">Nenhum alerta pendente. Tudo certo por aqui.</div>'; return; }
    box.innerHTML = alertas.map((a) => {
      const it = [...S.itens.values()].find((i) => i.aparelhoId === a.aparelho_id);
      return `<div class="list-item"><div class="list-ico">${ico('alert-triangle')}</div>
        <div class="list-main"><div class="list-title">${H(a.nome)} <span class="tag ${a.gravidade}">${H(NOMES_GRAVIDADE[a.gravidade])}</span></div>
          <div class="list-sub">${H(a.placa ? `${a.prefixo ? `${a.prefixo} · ` : ''}${a.placa}` : `Aparelho ${a.identificador}`)} · ${H(fmtDataHora(a.inicio))}${a.fim ? '' : ' · <b>ativo</b>'}</div></div>
        ${it ? `<button class="link" type="button" data-veiculo="${H(it.chave)}">Ver ${ico('chevron-right', 'i-sm')}</button>` : ''}</div>`;
    }).join('');
  }

  function desenharOffline() {
    const box = $('#ini-offline');
    if (!box) return;
    const off = itensVisiveis().filter((i) => !i.pendente && !i.semAparelho && !i.online)
      .sort((a, b) => (msDe(a.ultimoContato) || 0) - (msDe(b.ultimoContato) || 0)).slice(0, 8);
    if (!off.length) { box.innerHTML = '<div class="list-empty">Todos os aparelhos estão online.</div>'; return; }
    box.innerHTML = off.map((i) => `<div class="list-item"><div class="list-ico" style="background:#EEF1F6;color:var(--ink-2)">${ico('plug-connected-x')}</div>
      <div class="list-main"><div class="list-title">${H(rotulo(i))}</div>
        <div class="list-sub">${i.ultimoContato ? `Último contato ${H(atras(i.ultimoContato))} (${H(fmtDataHora(i.ultimoContato))})` : 'Nunca conectou'}</div></div>
      <button class="link" type="button" data-veiculo="${H(i.chave)}">Ver ${ico('chevron-right', 'i-sm')}</button></div>`).join('');
  }

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

  function desenhar() {
    desenharKpis();
    desenharOffline();
    desenharPendentes();
  }

  return { id: 'inicio', titulo: 'Início', sub: () => (S.eu.empresaNome ? S.eu.empresaNome : 'Visão geral de todas as empresas'), render, sair };
})();
