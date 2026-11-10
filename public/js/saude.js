'use strict';
/* FrotaGest — Saúde dos aparelhos: o que precisa de manutenção (offline, câmera, cartão/HD, GPS,
 * alimentação, sinal do chip), com exportação em Excel e PDF para a equipe técnica. Reis Tecnologia */

PAGINAS.saude = (() => {
  const GRUPOS = [
    { id: '', nome: 'Todos os problemas', tipos: null },
    { id: 'offline', nome: 'Offline ou nunca conectou', tipos: ['offline', 'nunca'], ico: 'wifi-off', kpi: 'offline' },
    { id: 'camera', nome: 'Câmera ou vídeo', tipos: ['camera', 'video'], ico: 'camera-off', kpi: 'camera' },
    { id: 'armazenamento', nome: 'Cartão de memória ou HD', tipos: ['armazenamento'], ico: 'device-sd-card', kpi: 'armazenamento' },
    { id: 'gps', nome: 'GPS ou sem posição', tipos: ['gps', 'posicao'], ico: 'gps', kpi: 'gps' },
    { id: 'energia', nome: 'Alimentação, sinal e outros', tipos: ['energia', 'sinal', 'equipamento'], ico: 'plug-x', kpi: 'energiaSinal' },
  ];
  const ICONE_TIPO = { offline: 'wifi-off', nunca: 'plug-connected-x', camera: 'camera-off', video: 'camera-off', armazenamento: 'device-sd-card', gps: 'gps', posicao: 'map-pin', energia: 'plug-x', sinal: 'antenna-bars-2', equipamento: 'cpu' };
  const f = { mostrar: 'problemas', grupo: '', area: '', busca: '' };
  let dados = null;
  let timer = null;
  let seq = 0;
  let offs = [];

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <div class="kpis saude-kpis" id="sa-kpis"></div>
        <section class="card">
          <div class="toolbar">
            <div class="seg" id="sa-mostrar"><button class="seg-btn" type="button" data-m="problemas">Com problema</button><button class="seg-btn" type="button" data-m="todos">Todos</button></div>
            <label class="field">Problema<select id="sa-grupo">${GRUPOS.map((g) => `<option value="${g.id}">${H(g.nome)}</option>`).join('')}</select></label>
            <label class="field">Grupo de veículos<select id="sa-area"></select></label>
            <label class="search">${ico('search', 'i-sm')}<input id="sa-busca" placeholder="Placa, prefixo ou nº do aparelho" autocomplete="off"></label>
            <div class="grow"></div>
            <button class="btn" type="button" id="sa-xlsx" title="Baixar em Excel (.xlsx)">${ico('file-spreadsheet', 'i-sm')} Excel</button>
            <button class="btn" type="button" id="sa-pdf" title="Baixar em PDF para a manutenção">${ico('file-type-pdf', 'i-sm')} PDF</button>
          </div>
          <div class="card-head" style="border-bottom:0;padding-bottom:6px"><span class="count" id="sa-n"></span><span class="hint" id="sa-hora" style="padding:0"></span></div>
          <div class="table-wrap tall" id="sa-tabela"><p class="hint">Carregando…</p></div>
          <p class="hint">Offline: sem comunicar há mais de 1 dia (grave depois de 3 dias), porque à noite a frota fica na garagem com o DVR desligado. Sem posição: conectado e com a ignição ligada, mas sem mandar posição há 30 min. GPS sem sinal: só conta com a ignição ligada. Sinal do chip fraco: abaixo de 10 numa escala de 0 a 31. Câmera, cartão, GPS e alimentação vêm dos alarmes que o próprio DVR envia.</p>
        </section>
      </div>`;
    const grupos = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    $('#sa-area').innerHTML = `<option value="">Todos</option>${grupos.map((g) => `<option value="${g.id}">${H(g.caminho)}</option>`).join('')}`;
    $('#sa-area').value = f.area;
    $('#sa-grupo').value = f.grupo;
    $('#sa-busca').value = f.busca;
    marcarMostrar();
    $('#sa-mostrar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      f.mostrar = b.dataset.m;
      marcarMostrar();
      desenhar();
    });
    $('#sa-grupo').addEventListener('change', () => { f.grupo = $('#sa-grupo').value; if (f.grupo) f.mostrar = 'problemas'; marcarMostrar(); desenhar(); });
    $('#sa-area').addEventListener('change', () => { f.area = $('#sa-area').value; carregar(); });
    $('#sa-busca').addEventListener('input', () => { f.busca = $('#sa-busca').value; desenhar(); });
    $('#sa-kpis').addEventListener('click', (e) => {
      const k = e.target.closest('[data-g]');
      if (!k) return;
      f.grupo = k.dataset.g === 'ok' ? '' : k.dataset.g;
      f.mostrar = k.dataset.g === 'ok' ? 'todos' : 'problemas';
      $('#sa-grupo').value = f.grupo;
      marcarMostrar();
      desenhar();
    });
    $('#sa-tabela').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ir]');
      if (!b) return;
      const [pagina, chave] = b.dataset.ir.split('|');
      if (pagina === 'mapa') navegar('mapa', qs({ v: chave }));
      if (pagina === 'historico') navegar('historico', qs({ v: chave }));
      if (pagina === 'comunicacoes') navegar('comunicacoes', qs({ v: chave }));
    });
    $('#sa-xlsx').addEventListener('click', () => baixar('xlsx'));
    $('#sa-pdf').addEventListener('click', () => baixar('pdf'));
    carregar();
    timer = setInterval(carregar, 30000);
    offs.push(on('frota', carregar));
  }

  function sair() {
    clearInterval(timer);
    offs.forEach((o) => o());
    offs = [];
    seq++;
  }

  function marcarMostrar() {
    $$('#sa-mostrar [data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === f.mostrar));
  }

  function parametros(extra = {}) {
    return qs({ empresa: S.empresa, grupo: f.area, ...extra });
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const r = await api(`/api/saude-aparelhos?${parametros()}`);
      if (meu !== seq || !$('#sa-tabela')) return;
      dados = r;
      if (!f.area) guardarResumoSaude(r.resumo, r.aparelhos);
      desenharKpis();
      desenhar();
      $('#sa-hora').textContent = `atualizado às ${r.geradoEm.slice(11, 16)} · atualiza sozinho a cada 30 s`;
    } catch (e) {
      if (meu === seq && $('#sa-tabela')) $('#sa-tabela').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  function desenharKpis() {
    const r = dados.resumo;
    const tile = (g, ico0, rotulo, valor, sub, cls) => `<div class="kpi clic ${cls}" data-g="${g}" role="button" tabindex="0"><div class="kpi-ico">${ico(ico0)}</div><div class="kpi-body"><div class="kpi-label">${H(rotulo)}</div><div class="kpi-value">${fmtNum(valor)}</div><div class="kpi-sub">${H(sub)}</div></div></div>`;
    $('#sa-kpis').innerHTML = tile('ok', 'heartbeat', 'Funcionando', r.ok, `de ${fmtNum(r.total)} aparelho(s)`, r.comProblema ? 'neutral' : 'ok')
      + GRUPOS.filter((g) => g.kpi).map((g) => tile(g.id, g.ico, g.nome, r[g.kpi], r[g.kpi] ? 'clique para ver' : 'nenhum', r[g.kpi] ? (g.id === 'offline' || g.id === 'armazenamento' ? 'err' : 'warn') : 'ok')).join('');
  }

  function filtrados() {
    const g = GRUPOS.find((x) => x.id === f.grupo);
    const q = norm(f.busca);
    return dados.aparelhos.filter((a) => {
      if (f.mostrar === 'problemas' && !a.problemas.length) return false;
      if (g && g.tipos && !a.problemas.some((p) => g.tipos.includes(p.tipo))) return false;
      if (q && !norm([a.placa, a.prefixo, a.ident, a.grupo, a.empresa, a.modelo].join(' ')).includes(q)) return false;
      return true;
    });
  }

  function situacao(a) {
    if (a.online) return '<span class="sa-sit"><span class="dot on"></span>Online</span>';
    if (!a.ultimoContato) return '<span class="sa-sit"><span class="dot"></span>Nunca conectou</span>';
    return `<span class="sa-sit" title="${H(fmtDataHora(a.ultimoContato))}"><span class="dot off"></span>Offline ${H(atras(a.ultimoContato))}</span>`;
  }

  function sinal(a) {
    if (a.sinal === null || a.sinal === undefined || !a.online) return '<span class="muted">—</span>';
    const n = a.sinal >= 20 ? 4 : a.sinal >= 15 ? 3 : a.sinal >= 10 ? 2 : a.sinal > 0 ? 1 : 0;
    return `<span class="sa-sinal n${n}" title="Sinal do chip: ${a.sinal} de 31"><i></i><i></i><i></i><i></i></span>`;
  }

  function desenhar() {
    if (!dados || !$('#sa-tabela')) return;
    const lista = filtrados();
    $('#sa-n').textContent = `${fmtNum(lista.length)} aparelho(s)${f.mostrar === 'problemas' ? ' com problema' : ''}`;
    if (!lista.length) {
      $('#sa-tabela').innerHTML = f.mostrar === 'problemas' && !f.grupo && !f.busca
        ? `<div class="empty-state"><div class="empty-icon" style="background:var(--ok-50);color:var(--ok)">${ico('heartbeat')}</div><h2>Tudo funcionando</h2><p class="muted">Nenhum aparelho com problema agora.</p></div>`
        : '<p class="hint">Nenhum aparelho com esse filtro.</p>';
      return;
    }
    $('#sa-tabela').innerHTML = tabela([
      { t: 'Veículo', v: (a) => `<b>${H(a.veiculoId ? (a.prefixo ? `${a.prefixo} · ${a.placa}` : a.placa) : 'Sem veículo')}</b><div class="small muted">${H([S.eu.perfil === 'master' && !S.empresa ? a.empresa : '', a.grupo].filter(Boolean).join(' · ') || '—')}</div>` },
      { t: 'Aparelho', v: (a) => `<code>${H(a.ident)}</code><div class="small muted">${H(a.modelo || '')}</div>` },
      { t: 'Situação', cls: 'nw', v: situacao },
      { t: 'Problemas', v: (a) => (a.problemas.length ? `<div class="sa-probs">${a.problemas.map((p) => `<span class="tag ${p.gravidade}" title="${H([p.nome, p.detalhe, p.desde ? `desde ${fmtDataHora(p.desde)}` : ''].filter(Boolean).join(' · '))}">${ico(ICONE_TIPO[p.tipo] || 'alert-triangle', 'i-xs')} ${H(p.nome)}${p.detalhe ? ` <small>${H(p.detalhe)}</small>` : ''}</span>`).join('')}</div>` : '<span class="tag ok">OK</span>') },
      { t: 'Última posição', cls: 'nw', v: (a) => (a.ultimaPosicao ? `${H(atras(a.ultimaPosicao))}<div class="small muted">${a.gps === false ? 'GPS sem sinal' : a.satelites !== null && a.satelites !== undefined ? `${a.satelites} satélite(s)` : ''}</div>` : '<span class="muted">—</span>') },
      { t: 'Sinal', v: sinal },
      { t: '', cls: 'nw', v: (a) => `<div class="sa-acoes"><button class="btn btn-sm" type="button" data-ir="mapa|${H(a.chave)}" title="Ver no mapa">${ico('map-2', 'i-sm')}</button><button class="btn btn-sm" type="button" data-ir="historico|${H(a.chave)}" title="Histórico">${ico('route', 'i-sm')}</button><button class="btn btn-sm" type="button" data-ir="comunicacoes|${H(a.chave)}" title="Comunicações do aparelho">${ico('antenna', 'i-sm')}</button></div>` },
    ], lista, { linhaCls: (a) => (a.gravidade === 'alta' ? 'sa-grave' : '') });
  }

  async function baixar(formato) {
    const b = $(`#sa-${formato}`);
    b.disabled = true;
    const g = GRUPOS.find((x) => x.id === f.grupo);
    try {
      const nome = await baixarArquivo(`/api/saude-aparelhos?${parametros({ formato, todos: f.mostrar === 'todos' ? '1' : '', tipo: g && g.tipos ? g.tipos.join(',') : '' })}`, `frotagest-saude.${formato}`);
      toast(`Arquivo ${nome} baixado.`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      b.disabled = false;
    }
  }

  return { id: 'saude', titulo: 'Saúde dos aparelhos', sub: 'DVRs que precisam de atenção: conexão, câmeras, cartão, GPS e alimentação', render, sair };
})();

/* ---------- selo no menu e aviso no Início ---------- */
// O número vermelho em "Saúde dos aparelhos" conta os aparelhos com problema grave
// (offline há mais de 3 dias, falha no cartão/HD, alimentação cortada).

function guardarResumoSaude(resumo, aparelhos) {
  S.saude = { ...resumo, graves: aparelhos.filter((a) => a.gravidade === 'alta').length };
  const nb = $('#nav-saude');
  if (nb) { nb.hidden = !S.saude.graves; nb.textContent = String(S.saude.graves); }
  atualizarSelosGrupos();
  emit('saude');
}

let saudeTimer = null;
async function atualizarSaude() {
  clearTimeout(saudeTimer);
  if (!S.eu || !S.eu.pode.cadastros) return;
  try {
    const r = await api(`/api/saude-aparelhos?${qs({ empresa: S.empresa })}`);
    guardarResumoSaude(r.resumo, r.aparelhos);
  } catch { /* tenta de novo depois */ }
  saudeTimer = setTimeout(atualizarSaude, 5 * 60000);
}

