'use strict';
/* FrotaGest — sessão e barra do topo: encerramento por falta de uso (com aviso antes), tempo conectado,
 * aviso de versão nova, e o aviso de alertas novos com som e notificação na área de trabalho.
 * Reis Tecnologia */

/* ---------- tema claro ou escuro ---------- */
// A escolha fica no navegador; sem escolha, segue o tema do sistema operacional.
// A tela de entrada é sempre escura (padrão dos outros sistemas da Reis Tecnologia).

function temaAtual() { return document.documentElement.dataset.tema === 'escuro' ? 'escuro' : 'claro'; }

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  if (typeof emit === 'function') emit('tema', tema); // gráficos pegam as cores do tema novo
  const b = document.getElementById('tb-tema');
  if (!b) return;
  b.innerHTML = ico(tema === 'escuro' ? 'sun' : 'moon');
  b.title = tema === 'escuro' ? 'Tema claro' : 'Tema escuro';
  b.setAttribute('aria-pressed', String(tema === 'escuro'));
}

function trocarTema() {
  const novo = temaAtual() === 'escuro' ? 'claro' : 'escuro';
  document.body.classList.add('trocando-tema');
  aplicarTema(novo);
  salvarPref('tema', novo);
  setTimeout(() => document.body.classList.remove('trocando-tema'), 400);
}

(function iniciarTema() {
  let t = pref('tema', null);
  if (t !== 'claro' && t !== 'escuro') {
    try { t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro'; } catch { t = 'claro'; }
  }
  aplicarTema(t);
}());

/* ---------- armazenamento simples (o navegador pode bloquear) ---------- */

function lerNumero(chave) { try { return Number(localStorage.getItem(chave)) || 0; } catch { return 0; } }
function gravarValor(chave, v) { try { localStorage.setItem(chave, String(v)); } catch { /* sem armazenamento */ } }
function apagarValor(chave) { try { localStorage.removeItem(chave); } catch { /* sem armazenamento */ } }

/* ---------- uso e inatividade ---------- */
// A hora do último uso fica no navegador (vale para todas as abas e sobrevive à janela fechada):
// passou do limite sem uso, a sessão é encerrada, mesmo que a pessoa tenha só fechado a janela.

const SESSAO = { local: Date.now(), gravado: 0, timer: 0, janela: null, encerrando: false };
let avisoLogin = null; // mensagem para a tela de entrada depois de encerrar a sessão

function marcarUso(forcar = false) {
  const t = Date.now();
  SESSAO.local = t;
  if (forcar || t - SESSAO.gravado > 15000) { SESSAO.gravado = t; gravarValor('fg:ultimoUso', t); }
  // "Usuários online" mostra há quanto tempo cada um não mexe no painel (aviso no máximo 1 vez por minuto)
  if (t - (SESSAO.avisadoWs || 0) > 60000 && typeof enviarWs === 'function') { SESSAO.avisadoWs = t; enviarWs({ type: 'uso' }); }
}

const ultimoUso = () => Math.max(SESSAO.local, lerNumero('fg:ultimoUso'));

/** Ficou fechado/parado mais que o limite? (0 = nunca encerra) */
function sessaoVencida(min) {
  if (!min) return false;
  const u = lerNumero('fg:ultimoUso');
  return u > 0 && Date.now() - u > min * 60000;
}

for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll']) {
  window.addEventListener(ev, () => { if (S.eu) marcarUso(); }, { passive: true, capture: true });
}

function iniciarSessao() {
  if (!lerNumero('fg:inicioSessao')) gravarValor('fg:inicioSessao', Date.now());
  gravarValor('fg:sessaoMin', S.eu.sessaoMin || 0);
  marcarUso(true);
  clearInterval(SESSAO.timer);
  SESSAO.timer = setInterval(tickSessao, 1000);
  tickSessao();
}

function pararSessao() {
  clearInterval(SESSAO.timer);
  SESSAO.timer = 0;
  fecharAvisoSessao();
}

/** Ao sair: o tempo conectado recomeça no próximo login. */
function limparSessaoLocal() {
  apagarValor('fg:inicioSessao');
  apagarValor('fg:ultimoUso');
}

let tickN = 0;
function tickSessao() {
  if (!S.eu) return;
  if (tickN++ % 15 === 0) atualizarTempoConectado();
  const min = S.eu.sessaoMin;
  if (!min) return;
  // no modo TV ninguém mexe no painel: a sessão não encerra por falta de uso
  if (S.paginaAtual && S.paginaAtual.id === 'tv') { marcarUso(); fecharAvisoSessao(); return; }
  const resta = ultimoUso() + min * 60000 - Date.now();
  if (resta <= 0) { encerrarPorInatividade(); return; }
  if (resta <= Math.min(60000, min * 30000)) mostrarAvisoSessao(resta); // avisa no último minuto (na metade, se o limite for 1 min)
  else fecharAvisoSessao();
}

function mostrarAvisoSessao(resta) {
  const seg = Math.max(0, Math.ceil(resta / 1000));
  const txt = `0:${String(seg).padStart(2, '0')}`;
  if (SESSAO.janela) { const c = SESSAO.janela.el.querySelector('[data-conta]'); if (c) c.textContent = txt; return; }
  SESSAO.janela = janela({
    titulo: 'Você ainda está aí?', icone: 'clock', tamanho: 'sm',
    corpo: `<p style="margin:0">Por segurança, a sessão será encerrada em <b data-conta>${txt}</b> por falta de uso.</p>`,
    rodape: '<button class="btn" type="button" data-sair-agora>Sair agora</button><button class="btn btn-primary" type="button" data-continuar>Continuar conectado</button>',
    aoFechar: () => { SESSAO.janela = null; marcarUso(true); },
  });
  SESSAO.janela.el.querySelector('[data-continuar]').addEventListener('click', () => SESSAO.janela && SESSAO.janela.fechar());
  SESSAO.janela.el.querySelector('[data-sair-agora]').addEventListener('click', () => { const j = SESSAO.janela; SESSAO.janela = null; if (j) j.el.remove(); sair(); });
}

function fecharAvisoSessao() {
  if (!SESSAO.janela) return;
  const j = SESSAO.janela;
  SESSAO.janela = null;
  j.el.remove();
}

async function encerrarPorInatividade(min = S.eu ? S.eu.sessaoMin : lerNumero('fg:sessaoMin')) {
  if (SESSAO.encerrando) return;
  SESSAO.encerrando = true;
  avisoLogin = { texto: `Sua sessão foi encerrada depois de ${min} min sem uso. Entre novamente.`, tipo: 'info' };
  try { await sair('inatividade'); } finally { SESSAO.encerrando = false; }
}

/* ---------- tempo conectado ---------- */

function atualizarTempoConectado() {
  const chip = $('#tb-tempo');
  if (!chip || !S.eu) return;
  const ini = lerNumero('fg:inicioSessao') || Date.now();
  const min = Math.floor((Date.now() - ini) / 60000);
  const txt = min < 1 ? 'agora' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${p2(min % 60)} min`;
  chip.querySelector('span').textContent = txt;
  chip.title = `Conectado desde ${fmtDataHora(textoServidor(ini)).slice(0, 16)}${S.eu.sessaoMin ? ` · a sessão encerra depois de ${S.eu.sessaoMin} min sem uso` : ''}`;
}

/* ---------- atualizar a tela ---------- */

async function atualizarTela() {
  const b = $('#tb-atualizar');
  b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  b.disabled = true;
  try {
    await carregarFrota();
    atualizarResumoAlertas();
    atualizarPendentes();
    abrirRota();
    toast('Dados da tela atualizados.', 'ok');
  } catch (e) {
    toast(`Não foi possível atualizar: ${e.message}`, 'err');
  } finally {
    setTimeout(() => { b.disabled = false; }, 600);
  }
}

/* ---------- versão nova ---------- */
// O servidor diz a versão ao conectar o tempo real (a atualização reinicia o servidor e a conexão volta
// com a versão nova) e, por garantia, a cada 10 minutos.

function verificarVersao(nova) {
  if (!nova || !S.config || nova === S.config.versao || !S.eu) return;
  const b = $('#nova-versao');
  $('#nv-versao').textContent = nova;
  b.hidden = false;
}

setInterval(async () => {
  if (document.hidden || !S.eu) return;
  try { verificarVersao((await fetch('/api/publica/config', { cache: 'no-store' }).then((r) => r.json())).versao); } catch { /* sem conexão */ }
}, 10 * 60000);

/* ---------- aviso de alertas novos: som e notificação ---------- */
// Níveis de som: 'alta' (só gravidade alta), 'media' (alta e média), 'todas' e 'nenhum'.

const NIVEIS_SOM = { alta: ['alta'], media: ['alta', 'media'], todas: ['alta', 'media', 'baixa'], nenhum: [] };
function nivelSom() {
  const n = pref('somNivel', null);
  if (n && NIVEIS_SOM[n]) return n;
  return pref('somAlertas', true) === false ? 'nenhum' : 'alta'; // preferência das versões antigas
}

let audioCtx = null;
function contextoAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
  return audioCtx;
}
// o navegador só libera o som depois de um clique ou tecla na página
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { const c = audioCtx; if (c && c.state === 'suspended') c.resume().catch(() => {}); }, { passive: true });
}

/** Bipes sem arquivo de áudio: alta = 3 agudos, média = 2, baixa = 1 mais grave. */
let ultimoSom = 0;
function tocarAlerta(gravidade = 'alta', forcar = false) {
  const agora = Date.now();
  if (!forcar && agora - ultimoSom < 3000) return; // vários de uma vez: um aviso só
  ultimoSom = agora;
  const c = contextoAudio();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const cfg = { alta: [3, 960, 0.18], media: [2, 760, 0.2], baixa: [1, 560, 0.24] }[gravidade] || [2, 760, 0.2];
  try {
    const t0 = c.currentTime + 0.02;
    for (let i = 0; i < cfg[0]; i++) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = cfg[1];
      const ini = t0 + i * (cfg[2] + 0.06);
      g.gain.setValueAtTime(0.0001, ini);
      g.gain.exponentialRampToValueAtTime(0.25, ini + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ini + cfg[2]);
      o.connect(g).connect(c.destination);
      o.start(ini);
      o.stop(ini + cfg[2] + 0.02);
    }
  } catch { /* sem áudio */ }
}

const notificacaoDisponivel = () => 'Notification' in window && window.isSecureContext;

function notificarAlerta(a, nome) {
  if (!pref('notifAlertas', false) || !notificacaoDisponivel() || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return; // com a tela à vista, o aviso da própria página basta
  if (S.pushAqui) return; // este navegador já recebe pelos avisos no celular (o service worker mostra)
  try {
    const n = new Notification(`FrotaGest · ${a.nome}`, {
      body: `${nome} · gravidade ${NOMES_GRAVIDADE[a.gravidade] || a.gravidade} · ${fmtCurto(a.inicio || textoServidor())}`,
      tag: `fg-alerta-${a.id}`, icon: '/img/favicon.svg', requireInteraction: a.gravidade === 'alta',
    });
    n.onclick = () => { window.focus(); navegar('alertas'); n.close(); };
  } catch { /* navegador sem suporte */ }
}

/** Chamado para cada alerta novo que chega pelo tempo real. */
function avisarAlertaNovo(a) {
  const it = [...S.itens.values()].find((i) => i.aparelhoId === a.aparelhoId);
  const nome = rotulo(it) || (a.ident ? `Aparelho ${a.ident}` : '');
  const tocar = NIVEIS_SOM[nivelSom()].includes(a.gravidade);
  if (tocar || a.gravidade === 'alta') toast(`Alerta: ${a.nome} — ${nome}`, a.gravidade === 'alta' ? 'err' : 'warn');
  if (tocar) tocarAlerta(a.gravidade);
  // notificação: o mesmo nível do som (sem som, só os de gravidade alta)
  const nivelNotif = nivelSom() === 'nenhum' ? 'alta' : nivelSom();
  if (NIVEIS_SOM[nivelNotif].includes(a.gravidade)) notificarAlerta(a, nome);
}

/* ---------- botão do som no topo ---------- */

function atualizarBotaoSom() {
  const b = $('#tb-som');
  if (!b) return;
  const n = nivelSom();
  b.innerHTML = ico(n === 'nenhum' ? 'volume-off' : 'volume');
  b.title = n === 'nenhum' ? 'Aviso de alertas: sem som' : `Aviso de alertas: som ${{ alta: 'para gravidade alta', media: 'para alta e média', todas: 'para todos' }[n]}`;
  b.classList.toggle('desligado', n === 'nenhum');
}

function abrirMenuSom() {
  const pop = $('#tb-som-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const n = nivelSom();
  const disp = notificacaoDisponivel();
  const perm = disp ? Notification.permission : 'indisponivel';
  pop.innerHTML = `<div class="tb-pop-tit">${ico('bell-ringing', 'i-sm')} Aviso de alertas novos</div>
    ${[['alta', 'Som só para gravidade alta'], ['media', 'Som para alta e média'], ['todas', 'Som para todos os alertas'], ['nenhum', 'Sem som']]
    .map(([v, t]) => `<label class="tb-pop-op"><input type="radio" name="som-nivel" value="${v}" ${v === n ? 'checked' : ''}> ${t}</label>`).join('')}
    <div class="tb-pop-sep"></div>
    <label class="tb-pop-op"><input type="checkbox" id="som-notif" ${pref('notifAlertas', false) && perm === 'granted' ? 'checked' : ''} ${disp ? '' : 'disabled'}> Notificação na área de trabalho</label>
    <small class="tb-pop-nota" id="som-notif-txt">${!disp ? 'Este navegador não permite notificações aqui (é preciso abrir pelo endereço com https).'
      : perm === 'denied' ? 'O navegador está bloqueando as notificações deste site. Libere no cadeado ao lado do endereço.'
        : 'Aparece mesmo com o FrotaGest minimizado ou em outra aba.'}</small>
    <div class="tb-pop-acoes"><button class="btn btn-sm" type="button" id="som-testar">${ico('volume', 'i-sm')} Testar som</button></div>
    ${podeTela('alertas') ? `<div class="tb-pop-sep"></div>
    <button class="tb-pop-link" type="button" id="som-celular">${ico('device-mobile-message', 'i-sm')}<span><b>Avisos no celular</b><small>Receba os alertas com o FrotaGest fechado</small></span>${ico('chevron-right', 'i-sm')}</button>` : ''}`;
  pop.hidden = false;
  pop.querySelectorAll('[name=som-nivel]').forEach((r) => r.addEventListener('change', () => { salvarPref('somNivel', r.value); atualizarBotaoSom(); }));
  $('#som-testar').addEventListener('click', () => tocarAlerta(nivelSom() === 'nenhum' ? 'media' : 'alta', true));
  const cel = $('#som-celular');
  if (cel) cel.addEventListener('click', () => { pop.hidden = true; abrirAvisosCelular(); });
  const cb = $('#som-notif');
  cb.addEventListener('change', async () => {
    if (!cb.checked) { salvarPref('notifAlertas', false); return; }
    let p = Notification.permission;
    if (p === 'default') { try { p = await Notification.requestPermission(); } catch { p = 'denied'; } }
    if (p !== 'granted') {
      cb.checked = false;
      salvarPref('notifAlertas', false);
      $('#som-notif-txt').textContent = 'O navegador não liberou as notificações. Libere no cadeado ao lado do endereço e tente de novo.';
      return;
    }
    salvarPref('notifAlertas', true);
    $('#som-notif-txt').textContent = 'Pronto: os alertas novos também aparecem na área de trabalho.';
  });
}

document.addEventListener('click', (e) => {
  const pop = $('#tb-som-pop');
  if (pop && !pop.hidden && !e.target.closest('#tb-som-pop') && !e.target.closest('#tb-som')) pop.hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const pop = $('#tb-som-pop'); if (pop) pop.hidden = true; } });

/* ---------- título da aba com os alertas novos ---------- */

function tituloDaAba(base) {
  const n = S.alertas ? S.alertas.novos : 0;
  document.title = `${n ? `(${n > 99 ? '99+' : n}) ` : ''}${base} · FrotaGest`;
}
