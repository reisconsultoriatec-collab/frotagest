'use strict';
/* FrotaGest — núcleo do painel: sessão (Firebase), API, tempo real, navegação e componentes. Reis Tecnologia */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const H = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (n, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
/* Ícones usados por nome calculado (para o gerador do sprite): ico('lock') ico('info-circle') ico('user') ico('steering-wheel')
   ico('clock') ico('gauge') ico('route') ico('map-pin') ico('wifi') ico('bus') ico('plug-connected-x') ico('alert-triangle')
   ico('user-plus') ico('user-check') ico('clock-pause') ico('mail') ico('refresh') ico('key') ico('copy')
   ico('volume-off') ico('volume') ico('sun') ico('moon') ico('antenna-bars-2') ico('camera-off') ico('device-sd-card') ico('gps') ico('plug-x') ico('wifi-off') ico('cpu') ico('wifi') ico('video') ico('check') ico('download') ico('alert-triangle') ico('bell-ringing')
   ico('building-warehouse') ico('map-pin') ico('shape') ico('ban') ico('device-mobile') ico('device-desktop') ico('device-tv') ico('arrows-minimize')
   ico('shield-lock') ico('shield-check') ico('lifebuoy') ico('device-mobile') ico('file-download') ico('copy') ico('login-2') */

/** Estado do painel. */
const S = {
  config: null,
  eu: null,
  itens: new Map(), // chave → item da frota (veículo/aparelho)
  grupos: [],
  empresas: [],
  empresa: '', // filtro do master ('' = todas)
  streams: new Map(),
  downloads: new Map(),
  alertas: { pendentes: 0, novos: 0, altas: 0 },
  pendentes: 0, // cadastros aguardando aprovação (administrador e master)
  conectado: false,
  paginaAtual: null,
};
const PAGINAS = {};
const bus = new EventTarget();
const emit = (tipo, detalhe) => bus.dispatchEvent(new CustomEvent(tipo, { detail: detalhe }));
const on = (tipo, fn) => { const h = (e) => fn(e.detail); bus.addEventListener(tipo, h); return () => bus.removeEventListener(tipo, h); };

/* ---------- preferências do navegador ---------- */

function pref(nome, padrao) {
  try { const v = localStorage.getItem(`fg:${nome}`); return v === null ? padrao : JSON.parse(v); } catch { return padrao; }
}
function salvarPref(nome, valor) {
  try { localStorage.setItem(`fg:${nome}`, JSON.stringify(valor)); } catch { /* navegador sem armazenamento */ }
}

/* ---------- datas (o servidor fala sempre no horário de Brasília) ---------- */

const p2 = (n) => String(n).padStart(2, '0');
/** 'AAAA-MM-DD hh:mm:ss' (Brasília) → ms */
function msDe(t) {
  if (!t) return NaN;
  return Date.parse(`${String(t).replace(' ', 'T')}-03:00`);
}
/** ms → 'AAAA-MM-DD hh:mm:ss' no horário de Brasília */
function textoServidor(ms = Date.now()) {
  const d = new Date(ms - 3 * 3600000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
function fmtDataHora(t) {
  if (!t) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(:\d{2})?/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}${m[6] || ''}` : t;
}
function fmtCurto(t) {
  if (!t) return '—';
  const hoje = textoServidor().slice(0, 10);
  return t.slice(0, 10) === hoje ? t.slice(11, 19) : fmtDataHora(t).slice(0, 16);
}
function atras(t) {
  const ms = msDe(t);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h${m % 60 && h < 10 ? ` ${m % 60} min` : ''}`;
  return `há ${Math.floor(h / 24)} dias`;
}
function fmtDur(seg) {
  seg = Math.max(0, Math.round(seg));
  if (seg < 60) return `${seg}s`;
  const m = Math.floor(seg / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${p2(m % 60)} min`;
}
function fmtNum(n, casas = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
function fmtTamanho(b) {
  if (!b) return '0 KB';
  if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;
}
/** valor de <input type=datetime-local> ↔ texto do servidor */
/** fim = true: o minuto escolhido entra inteiro (até :59) */
const deInput = (v, fim = false) => (v ? `${v.replace('T', ' ')}${v.length === 16 ? (fim ? ':59' : ':00') : ''}` : '');
const paraInput = (t) => (t ? t.slice(0, 16).replace(' ', 'T') : '');

/* ---------- avisos ---------- */

function toast(texto, tipo = '') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = texto;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), tipo === 'err' ? 7000 : 4500);
}

/* ---------- API ---------- */

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

async function token(forcar = false) {
  const u = window.firebase && firebase.auth().currentUser;
  if (!u) throw Object.assign(new Error('Sessão encerrada. Entre novamente.'), { status: 401 });
  return u.getIdToken(forcar);
}

async function api(caminho, { metodo, corpo, headers } = {}) {
  const enviar = async (forcar) => fetch(caminho, {
    method: metodo || (corpo ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${await token(forcar)}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let r = await enviar(false);
  if (r.status === 401) r = await enviar(true); // token venceu entre uma chamada e outra
  let j = {};
  try { j = await r.json(); } catch { /* sem corpo */ }
  if (r.status === 401 && j.codigo === 'sessao_encerrada') sessaoEncerradaPorAdmin();
  // o master passou a exigir a verificação em duas etapas (ou zerou o cadastro) com o painel aberto
  if (r.status === 403 && (j.codigo === 'dois_fatores' || j.codigo === 'dois_fatores_cadastro')) pedirSegundaEtapa(j);
  if (!r.ok) throw Object.assign(new Error(j.erro || `Erro ${r.status}`), { status: r.status, codigo: j.codigo, dados: j });
  return j;
}

async function wsUrl(caminho, params = {}) {
  const r = await api('/api/ws-ticket', { corpo: {} });
  return `${WS_PROTO}://${location.host}${caminho}?${qs({ ...params, k: r.ticket })}`;
}

/* ---------- frota e tempo real ---------- */

async function carregarFrota() {
  const r = await api('/api/frota');
  S.itens = new Map(r.itens.map((i) => [i.chave, i]));
  S.grupos = r.grupos;
  S.empresas = r.empresas;
  atualizarStatusFrota();
  emit('frota');
}

function itensVisiveis() {
  const lista = [...S.itens.values()];
  if (!S.empresa) return lista;
  return lista.filter((i) => String(i.empresaId) === String(S.empresa));
}

function rotulo(i) {
  if (!i) return '';
  if (i.pendente) return `Aparelho ${i.ident}`;
  if (i.placa) return i.prefixo ? `${i.prefixo} · ${i.placa}` : i.placa;
  return `Aparelho ${i.ident}`;
}

function atualizarStatusFrota() {
  const l = itensVisiveis().filter((i) => !i.pendente && !i.semAparelho);
  const on = l.filter((i) => i.online).length;
  $('#st-frota').className = `dot ${on ? 'on' : l.length ? 'off' : 'wait'}`;
  $('#st-frota-txt').textContent = `${on} de ${l.length}`;
}

let resumoTimer = null;
function atualizarResumoAlertas() {
  clearTimeout(resumoTimer);
  resumoTimer = setTimeout(async () => {
    try {
      S.alertas = await api('/api/alertas/resumo');
      const n = S.alertas.pendentes;
      const b = $('#tb-alertas-n');
      b.hidden = !n;
      b.textContent = n > 99 ? '99+' : String(n);
      const nb = $('#nav-alertas');
      if (nb) { nb.hidden = !n; nb.textContent = n > 99 ? '99+' : String(n); }
      atualizarSelosGrupos();
      tituloDaAba(S.tituloBase || 'FrotaGest');
      emit('resumo-alertas');
    } catch { /* tenta de novo no próximo evento */ }
  }, 400);
}

/** Cadastros novos aguardando aprovação: selo no menu Usuários e aviso no Início. */
let pendentesTimer = null;
function atualizarPendentes() {
  if (!S.eu || !S.eu.pode.cadastros) return;
  clearTimeout(pendentesTimer);
  pendentesTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/usuarios/pendentes${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      S.pendentes = r.total;
      const nb = $('#nav-pendentes');
      if (nb) { nb.hidden = !r.total; nb.textContent = String(r.total); }
      atualizarSelosGrupos();
      emit('pendentes');
    } catch { /* tenta de novo no próximo aviso */ }
  }, 300);
}

let eventosWs = null;
let espera = 1000;
let seqConexao = 0;
async function conectarEventos() {
  const seq = ++seqConexao;
  if (eventosWs) { eventosWs.onclose = null; eventosWs.close(); eventosWs = null; }
  let url;
  try {
    url = await wsUrl('/ws/eventos');
  } catch (e) {
    if (seq !== seqConexao || !S.eu) return;
    setTimeout(conectarEventos, Math.min(espera *= 2, 30000));
    return;
  }
  if (seq !== seqConexao || !S.eu) return;
  const w = new WebSocket(url);
  eventosWs = w;
  w.onopen = () => {
    espera = 1000;
    S.conectado = true;
    $('#st-tempo-real').className = 'dot on';
    $('#st-tempo-real-txt').textContent = 'conectado';
  };
  w.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    tratarEvento(m);
  };
  w.onclose = () => {
    if (eventosWs !== w) return;
    S.conectado = false;
    $('#st-tempo-real').className = 'dot off';
    $('#st-tempo-real-txt').textContent = 'reconectando';
    if (S.eu) setTimeout(conectarEventos, Math.min(espera *= 2, 30000));
  };
}

function pararEventos() {
  seqConexao++;
  if (eventosWs) { eventosWs.onclose = null; eventosWs.close(); eventosWs = null; }
}

/** Manda um aviso pelo tempo real (tela atual, uso), se a conexão estiver aberta. */
function enviarWs(obj) {
  if (eventosWs && eventosWs.readyState === 1) { try { eventosWs.send(JSON.stringify(obj)); } catch { /* reconecta sozinho */ } }
}

/** Em que tela esta aba está (aparece para o administrador em "Usuários online"). */
function avisarTela() {
  if (S.paginaAtual) enviarWs({ type: 'tela', tela: S.paginaAtual.id });
}

/** Um administrador encerrou esta sessão: sai e explica na tela de entrada. */
let encerradaPorAdmin = false;
async function sessaoEncerradaPorAdmin() {
  if (encerradaPorAdmin || !S.eu) return;
  encerradaPorAdmin = true;
  avisoLogin = { texto: 'Sua sessão foi encerrada por um administrador do sistema. Entre novamente para continuar.', tipo: 'info' };
  try { await sair('encerrada'); } finally { encerradaPorAdmin = false; }
}

function tratarEvento(m) {
  switch (m.type) {
    case 'ola':
      verificarVersao(m.versao);
      S.conexao = m.conexao || null;
      avisarTela();
      S.streams = new Map((m.streams || []).map((s) => [s.key, s]));
      S.downloads = new Map((m.downloads || []).map((d) => [d.id, d]));
      // reconectou: traz a frota de novo (pode ter mudado enquanto estava fora)
      carregarFrota().catch(() => {});
      emit('downloads');
      break;
    case 'item':
      S.itens.set(m.item.chave, m.item);
      atualizarStatusFrota();
      emit('item', m.item);
      break;
    case 'alerta':
      atualizarResumoAlertas();
      if (m.acao === 'novo') avisarAlertaNovo(m.alerta);
      emit('alerta', m);
      break;
    case 'stream':
      S.streams.set(m.stream.key, m.stream);
      emit('stream', m.stream);
      break;
    case 'download':
      if (m.download.removed) S.downloads.delete(m.download.id); else S.downloads.set(m.download.id, m.download);
      emit('downloads');
      break;
    case 'recarregar':
      carregarFrota().catch(() => {});
      break;
    case 'pendentes':
      atualizarPendentes();
      break;
    case 'cerca': // veículo entrou ou saiu de uma cerca
      atualizarOcupacao(m.evento);
      emit('cerca', m.evento);
      break;
    case 'cercas': // alguém mudou o cadastro das cercas
      S.cercas = null;
      emit('cercas');
      break;
    case 'sessao_encerrada':
      sessaoEncerradaPorAdmin();
      break;
    default:
  }
}

/* ---------- navegação ---------- */

const NAV = [
  // Cadastros primeiro: é por onde a empresa começa (quem não cadastra não vê este grupo)
  {
    grupo: 'Cadastros',
    pode: 'cadastros',
    itens: [
      // na ordem em que se monta uma empresa: empresa → DVRs → grupos → veículos → pessoas
      { id: 'empresas', nome: 'Empresas', ico: 'building', master: true },
      { id: 'aparelhos', nome: 'Aparelhos (DVR)', ico: 'device-cctv' },
      { id: 'grupos', nome: 'Grupos', ico: 'folders' },
      { id: 'veiculos', nome: 'Veículos', ico: 'bus' },
      { id: 'cercas', nome: 'Cercas', ico: 'fence' },
      { id: 'usuarios', nome: 'Usuários', ico: 'users', badge: 'nav-pendentes', badgeCls: 'warn' },
    ],
  },
  {
    grupo: 'Operação',
    itens: [
      { id: 'inicio', nome: 'Início', ico: 'layout-dashboard' },
      { id: 'mapa', nome: 'Monitoramento', ico: 'map-2' },
      { id: 'alertas', nome: 'Alertas', ico: 'bell-ringing', badge: 'nav-alertas' },
      { id: 'historico', nome: 'Histórico', ico: 'route' },
      { id: 'relatorios', nome: 'Relatórios', ico: 'file-analytics' },
      { id: 'gravacoes', nome: 'Gravações', ico: 'video', pode: 'gravacoes' },
      { id: 'tv', nome: 'Modo TV', ico: 'device-tv' },
    ],
  },
  {
    grupo: 'Controle',
    itens: [
      { id: 'saude', nome: 'Saúde dos aparelhos', ico: 'heartbeat', pode: 'cadastros', badge: 'nav-saude', badgeCls: 'err' },
      { id: 'comunicacoes', nome: 'Comunicações', ico: 'antenna', pode: 'cadastros' },
      { id: 'online', nome: 'Usuários online', ico: 'users-group', pode: 'cadastros' },
      { id: 'auditoria', nome: 'Auditoria', ico: 'shield-check', pode: 'auditoria' },
      { id: 'sistema', nome: 'Sistema', ico: 'server', pode: 'sistema' },
    ],
  },
];

function podeVer(item) {
  if (!S.eu) return false;
  if (item.master && S.eu.perfil !== 'master') return false;
  if (item.pode && !S.eu.pode[item.pode]) return false;
  return true;
}

/* Menu recolhível (mesmo padrão do EduGest): cada grupo abre com um clique no
 * nome, um por vez, e o grupo da página atual abre sozinho. Com o grupo
 * fechado, os selos dos itens (alertas, cadastros pendentes) somam no título
 * para o aviso não sumir. */
function montarNav() {
  let html = '';
  NAV.forEach((g, n) => {
    if (g.pode && !S.eu.pode[g.pode]) return;
    const itens = g.itens.filter(podeVer);
    if (!itens.length) return;
    const links = itens.map((it) => `<a class="sb-item" href="#/${it.id}" data-nav="${it.id}">${ico(it.ico)}<span>${H(it.nome)}</span>${it.badge ? `<span class="sb-badge ${it.badgeCls || 'err'}" id="${it.badge}" hidden></span>` : ''}</a>`).join('');
    html += `<div class="sb-grp" data-grupo="${n}">
      <button type="button" class="sb-grp-tit" aria-expanded="false" aria-controls="sb-grp-${n}">
        <span class="sb-grp-nome">${H(g.grupo)}</span><span class="sb-badge sb-grp-selo" hidden></span>${ico('chevron-right', 'sb-grp-seta')}
      </button>
      <div class="sb-grp-itens" id="sb-grp-${n}"><div>${links}</div></div>
    </div>`;
  });
  const nav = $('#nav');
  nav.innerHTML = html;
  if (!nav.dataset.ligado) {
    nav.dataset.ligado = '1';
    nav.addEventListener('click', (e) => {
      const tit = e.target.closest('.sb-grp-tit');
      if (tit) abrirGrupo(tit.closest('.sb-grp'), true);
    });
  }
  const atual = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'inicio';
  marcarGrupo(atual);
  atualizarSelosGrupos();
}

/** Abre um grupo e fecha os outros; "alternar" fecha se ele já estiver aberto. */
function abrirGrupo(grupo, alternar) {
  const abrir = !(alternar && grupo && grupo.classList.contains('aberto'));
  $$('.sb-grp').forEach((g) => {
    const aberto = abrir && g === grupo;
    g.classList.toggle('aberto', aberto);
    g.querySelector('.sb-grp-tit').setAttribute('aria-expanded', String(aberto));
  });
}

/** Destaca o grupo da página atual e o abre. */
function marcarGrupo(id) {
  const item = $(`.sb-item[data-nav="${id}"]`);
  const grupo = item ? item.closest('.sb-grp') : null;
  $$('.sb-grp').forEach((g) => g.classList.toggle('tem-ativo', g === grupo));
  if (grupo) abrirGrupo(grupo, false);
}

/** Soma os selos visíveis de cada grupo e mostra no título (só aparece com o grupo fechado). */
function atualizarSelosGrupos() {
  $$('.sb-grp').forEach((g) => {
    const selos = [...g.querySelectorAll('.sb-item .sb-badge')].filter((b) => !b.hidden && b.textContent);
    const total = selos.reduce((t, b) => t + (parseInt(b.textContent, 10) || 0), 0);
    const mais = selos.some((b) => b.textContent.endsWith('+'));
    const selo = g.querySelector('.sb-grp-selo');
    selo.hidden = !total;
    selo.textContent = total ? (mais || total > 99 ? '99+' : String(total)) : '';
    selo.className = `sb-badge sb-grp-selo ${selos.some((b) => b.classList.contains('err')) ? 'err' : 'warn'}`;
    selo.title = selos.map((b) => {
      const nome = b.closest('.sb-item').querySelector('span').textContent;
      return `${nome}: ${b.textContent}`;
    }).join(' · ');
  });
}

function navegar(id, params = '') {
  location.hash = `#/${id}${params ? `?${params}` : ''}`;
}

function paramsDaRota() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q).entries());
}

function abrirRota() {
  if (!S.eu) return;
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'inicio';
  let pag = PAGINAS[id];
  const nav = NAV.flatMap((g) => g.itens.map((i) => ({ ...i, pode: i.pode || g.pode }))).find((i) => i.id === id);
  if (!pag || (nav && !podeVer(nav))) {
    pag = PAGINAS.inicio;
    if (id !== 'inicio') { history.replaceState(null, '', '#/inicio'); }
  }
  if (S.paginaAtual && S.paginaAtual.sair) {
    try { S.paginaAtual.sair(); } catch { /* página já desmontada */ }
  }
  S.paginaAtual = pag;
  $$('.sb-item').forEach((a) => a.classList.toggle('active', a.dataset.nav === (pag.id || id)));
  marcarGrupo(pag.id || id);
  document.body.classList.remove('sb-open');
  $('#tb-titulo').textContent = pag.titulo;
  $('#tb-sub').textContent = typeof pag.sub === 'function' ? pag.sub() : (pag.sub || '');
  S.tituloBase = pag.titulo;
  tituloDaAba(pag.titulo);
  const c = $('#conteudo');
  c.className = `content${pag.cheia ? ' full' : ''}`;
  c.innerHTML = '';
  window.scrollTo(0, 0);
  pag.render(c, paramsDaRota());
  avisarTela();
}

/* ---------- componentes ---------- */

/** Janela sobre a tela. Retorna { el, fechar }. */
function janela({ titulo, icone = null, corpo = '', rodape = '', tamanho = '', aoFechar = null }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${tamanho}" role="dialog" aria-modal="true" aria-label="${H(titulo)}">
    <div class="modal-head">${icone ? `<div class="kpi-ico" style="width:36px;height:36px">${ico(icone)}</div>` : ''}<h2>${H(titulo)}</h2>
      <button class="det-close" type="button" data-fechar aria-label="Fechar">${ico('x', 'i-sm')}</button></div>
    <div class="modal-body">${corpo}</div>
    ${rodape ? `<div class="modal-foot">${rodape}</div>` : ''}
  </div>`;
  const fechar = () => {
    back.remove();
    document.removeEventListener('keydown', esc);
    if (aoFechar) aoFechar();
  };
  const esc = (e) => { if (e.key === 'Escape') fechar(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.dataset.fora = '1'; else delete back.dataset.fora; });
  back.addEventListener('click', (e) => {
    if (e.target.closest('[data-fechar]') || (e.target === back && back.dataset.fora)) fechar();
  });
  document.addEventListener('keydown', esc);
  $('#modais').append(back);
  const primeiro = back.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
  if (primeiro) setTimeout(() => primeiro.focus(), 30);
  return { el: back, fechar };
}

function confirmar(texto, { titulo = 'Confirmar', ok = 'Confirmar', perigo = false } = {}) {
  return new Promise((resolve) => {
    let resp = false;
    const j = janela({
      titulo, tamanho: 'sm', corpo: `<p style="margin:0">${H(texto)}</p>`,
      rodape: `<button class="btn" type="button" data-fechar>Cancelar</button><button class="btn ${perigo ? 'btn-danger' : 'btn-primary'}" type="button" data-ok>${H(ok)}</button>`,
      aoFechar: () => resolve(resp),
    });
    j.el.querySelector('[data-ok]').addEventListener('click', () => { resp = true; j.fechar(); });
  });
}

/**
 * Formulário em janela. campos: [{ nome, rotulo, tipo, opcoes, obrigatorio, ajuda, cheio, min, max, placeholder, se }]
 * tipos: texto, email, numero, select, check, textarea, multi, canais, separador, info.
 * salvar(dados) → Promise; se lançar erro, a mensagem aparece no formulário.
 */
function formulario({ titulo, icone, campos, valores = {}, salvar, textoSalvar = 'Salvar', aviso = '', tamanho = '', extras = '', aoFechar = null }) {
  const v = (n) => (valores[n] === null || valores[n] === undefined ? '' : valores[n]);
  const html = campos.map((c) => {
    const id = `f-${c.nome || Math.random().toString(36).slice(2)}`;
    const cls = `field${c.cheio || ['textarea', 'multi', 'canais', 'info'].includes(c.tipo) ? ' full' : ''}`;
    const req = c.obrigatorio ? ' <span class="req">*</span>' : '';
    const ajuda = c.ajuda ? `<small>${H(c.ajuda)}</small>` : '';
    const dis = c.desativado ? ' disabled' : '';
    const se = c.se ? ` data-se="${H(c.se)}"` : '';
    switch (c.tipo) {
      case 'separador': return `<div class="form-sep"${se}>${H(c.rotulo)}</div>`;
      case 'info': return `<div class="${cls}"${se}><div class="form-aviso" style="margin:0">${c.html || H(c.rotulo)}</div></div>`;
      case 'check': return `<label class="field field-check${c.cheio ? ' full' : ''}"${se}><input type="checkbox" name="${c.nome}" ${v(c.nome) === true || v(c.nome) === 1 ? 'checked' : ''}${dis}> ${H(c.rotulo)}</label>`;
      case 'select': {
        const ops = (c.opcoes || []).map((o) => `<option value="${H(o.v)}" ${String(o.v) === String(v(c.nome)) ? 'selected' : ''}>${H(o.t)}</option>`).join('');
        return `<label class="${cls}"${se}><span>${H(c.rotulo)}${req}</span><select name="${c.nome}" id="${id}"${dis}>${ops}</select>${ajuda}</label>`;
      }
      case 'textarea': return `<label class="${cls}"${se}><span>${H(c.rotulo)}${req}</span><textarea name="${c.nome}" id="${id}" maxlength="${c.max || 500}"${dis}>${H(v(c.nome))}</textarea>${ajuda}</label>`;
      case 'multi': {
        const sel = new Set((valores[c.nome] || []).map(String));
        const ops = (c.opcoes || []).map((o) => `<label><input type="checkbox" name="${c.nome}" value="${H(o.v)}" ${sel.has(String(o.v)) ? 'checked' : ''}> ${H(o.t)}</label>`).join('') || '<span class="none">Nenhuma opção cadastrada.</span>';
        return `<div class="${cls}"${se}>${H(c.rotulo)}${req}<div class="multi">${ops}</div>${ajuda}</div>`;
      }
      case 'canais': {
        const nomes = valores[c.nome] || [];
        const n = Number(v(c.contador)) || 4;
        const ins = Array.from({ length: n }, (_, i) => `<input name="${c.nome}" data-i="${i}" maxlength="30" placeholder="CH ${i + 1}" value="${H(nomes[i] || '')}">`).join('');
        return `<div class="${cls}"${se}>${H(c.rotulo)}<div class="canais-grid" data-canais="${c.nome}">${ins}</div>${ajuda}</div>`;
      }
      default: {
        const tipo = { email: 'email', numero: 'number', senha: 'password', data: 'datetime-local' }[c.tipo] || 'text';
        const extra = [c.min !== undefined ? `min="${c.min}"` : '', c.max !== undefined && c.tipo === 'numero' ? `max="${c.max}"` : '', c.maxlength ? `maxlength="${c.maxlength}"` : '', c.placeholder ? `placeholder="${H(c.placeholder)}"` : ''].join(' ');
        return `<label class="${cls}"${se}><span>${H(c.rotulo)}${req}</span><input type="${tipo}" name="${c.nome}" id="${id}" value="${H(v(c.nome))}" ${extra}${dis}${c.tipo === 'email' ? ' autocomplete="off"' : ''}>${ajuda}</label>`;
      }
    }
  }).join('');
  const j = janela({
    titulo, icone, tamanho, aoFechar,
    corpo: `${aviso ? `<div class="form-aviso">${aviso}</div>` : ''}<form class="form-grid" novalidate>${html}</form>${extras}<p class="form-erro" hidden></p>`,
    rodape: `<button class="btn" type="button" data-fechar>Cancelar</button><button class="btn btn-primary" type="button" data-salvar>${ico('check', 'i-sm')} ${H(textoSalvar)}</button>`,
  });
  const form = j.el.querySelector('form');
  const erro = j.el.querySelector('.form-erro');
  const ler = () => {
    const d = {};
    for (const c of campos) {
      if (!c.nome || c.tipo === 'separador' || c.tipo === 'info') continue;
      if (c.tipo === 'check') d[c.nome] = form.querySelector(`[name="${c.nome}"]`).checked;
      else if (c.tipo === 'multi') d[c.nome] = $$(`[name="${c.nome}"]:checked`, form).map((x) => x.value);
      else if (c.tipo === 'canais') d[c.nome] = $$(`[name="${c.nome}"]`, form).map((x) => x.value.trim());
      else {
        const el = form.querySelector(`[name="${c.nome}"]`);
        d[c.nome] = el ? el.value.trim() : '';
      }
    }
    return d;
  };
  // campos que só aparecem em certas condições: data-se="campo=valor" ou "campo" (check marcado)
  const condicoes = () => {
    const d = ler();
    $$('[data-se]', form).forEach((el) => {
      // "perfil=operador|visualizador&todosGrupos=false": todas as condições precisam valer
      el.hidden = !el.dataset.se.split('&').every((cond) => {
        const [campo, valor] = cond.split('=');
        const atual = d[campo];
        return valor === undefined ? atual === true : valor.split('|').includes(String(atual));
      });
    });
  };
  form.addEventListener('change', condicoes);
  condicoes();
  // número de canais muda a quantidade de nomes
  const contador = campos.find((c) => c.tipo === 'canais');
  if (contador) {
    const n = form.querySelector(`[name="${contador.contador}"]`);
    n.addEventListener('input', () => {
      const q = Math.max(1, Math.min(16, Number(n.value) || 1));
      const grid = form.querySelector(`[data-canais="${contador.nome}"]`);
      const atuais = $$('input', grid).map((x) => x.value);
      grid.innerHTML = Array.from({ length: q }, (_, i) => `<input name="${contador.nome}" data-i="${i}" maxlength="30" placeholder="CH ${i + 1}" value="${H(atuais[i] || '')}">`).join('');
    });
  }
  const botao = j.el.querySelector('[data-salvar]');
  const enviar = async () => {
    erro.hidden = true;
    botao.disabled = true;
    try {
      await salvar(ler(), j);
      j.fechar();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      botao.disabled = false;
    }
  };
  botao.addEventListener('click', enviar);
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); enviar(); } });
  return j;
}

/** Tabela HTML. colunas: [{ t, v: (linha) => html, cls }] */
function tabela(colunas, linhas, { vazio = 'Nada para mostrar.', linhaCls = null, atributos = null } = {}) {
  const head = colunas.map((c) => `<th class="${c.cls || ''}">${H(c.t)}</th>`).join('');
  const body = linhas.length
    ? linhas.map((l) => `<tr class="${linhaCls ? linhaCls(l) : ''}" ${atributos ? atributos(l) : ''}>${colunas.map((c) => `<td class="${c.cls || ''}">${c.v(l)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="empty" colspan="${colunas.length}">${H(vazio)}</td></tr>`;
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Baixa um arquivo da API (com o login) e salva com o nome que o servidor mandar. */
async function baixarArquivo(caminho, nomePadrao = 'arquivo') {
  const pedir = async (forcar) => fetch(caminho, { headers: { Authorization: `Bearer ${await token(forcar)}` } });
  let r = await pedir(false);
  if (r.status === 401) r = await pedir(true);
  if (!r.ok) {
    let j = {};
    try { j = await r.json(); } catch { /* sem corpo */ }
    throw Object.assign(new Error(j.erro || `Erro ${r.status}`), { status: r.status });
  }
  const m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = m ? m[1] : nomePadrao;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return a.download;
}

function baixarCsv(nome, linhas) {
  const esc = (x) => {
    const s = String(x ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = `﻿${linhas.map((l) => l.map(esc).join(';')).join('\r\n')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nome;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** <select> de veículos/aparelhos visíveis (para histórico, gravações e filtros). */
function opcoesVeiculos(selecionado = '', { soComAparelho = true, vazio = 'Escolha o veículo' } = {}) {
  const lista = itensVisiveis()
    .filter((i) => !i.pendente && (!soComAparelho || i.aparelhoId))
    .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
  return `<option value="">${H(vazio)}</option>${lista.map((i) => `<option value="${H(i.chave)}" ${i.chave === selecionado ? 'selected' : ''}>${H(rotulo(i))}${i.online ? ' — online' : ''}</option>`).join('')}`;
}

function iniciais(nome) {
  const p = String(nome || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

const NOMES_GRAVIDADE = { alta: 'alta', media: 'média', baixa: 'baixa' };
const NOMES_PERFIL = { master: 'Master', admin: 'Administrador', operador: 'Operador', visualizador: 'Visualizador' };
const NOMES_TIPO = { onibus: 'Ônibus', 'micro-onibus': 'Micro-ônibus', van: 'Van', caminhao: 'Caminhão', carro: 'Carro', moto: 'Moto', maquina: 'Máquina', outro: 'Outro' };
