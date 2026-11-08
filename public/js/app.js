'use strict';
/* FrotaGest — início do painel: login (Firebase), cabeçalho e navegação. Reis Tecnologia */

const ERROS_LOGIN = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/invalid-login-credentials': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/user-disabled': 'Este login está desativado.',
  'auth/too-many-requests': 'Muitas tentativas seguidas. Aguarde alguns minutos ou use "Esqueci minha senha".',
  'auth/network-request-failed': 'Sem conexão com o serviço de login. Verifique a internet.',
  'auth/missing-password': 'Digite a senha.',
};

let primeiroAcesso = true;

function mostrarGate(estado, texto = '') {
  $('#carregando').hidden = true;
  $('#shell').hidden = true;
  $('#gate').hidden = false;
  const box = $('#gate-box');
  const topo = `<div class="gate-ico">${ico(estado === 'login' ? 'lock' : 'info-circle')}</div>`;
  if (estado === 'login') {
    box.innerHTML = `${topo}<h2>Entrar no FrotaGest</h2><p>Use o e-mail e a senha cadastrados pela sua empresa.</p>
      <form class="login-form" id="login-form" novalidate>
        <label class="fld">E-mail<input type="email" id="login-email" autocomplete="username" required></label>
        <label class="fld">Senha<span class="pw"><input type="password" id="login-senha" autocomplete="current-password" required><button type="button" id="login-ver" aria-label="Mostrar senha">${ico('eye', 'i-sm')}</button></span></label>
        <p class="gate-msg err" id="login-msg" hidden></p>
        <button class="btn btn-primary" type="submit" id="login-ok">Entrar</button>
        <div class="gate-links"><button class="link" type="button" id="login-esqueci">Esqueci minha senha</button></div>
      </form>
      <div class="gate-foot">Reis Tecnologia · FrotaGest ${H(S.config ? S.config.versao : '')}</div>`;
    const msg = $('#login-msg');
    const mostrar = (t, tipo = 'err') => { msg.textContent = t; msg.className = `gate-msg ${tipo}`; msg.hidden = !t; };
    if (texto) mostrar(texto);
    $('#login-email').value = pref('ultimoEmail', '');
    setTimeout(() => ($('#login-email').value ? $('#login-senha') : $('#login-email')).focus(), 50);
    $('#login-ver').addEventListener('click', () => {
      const s = $('#login-senha');
      s.type = s.type === 'password' ? 'text' : 'password';
    });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#login-email').value.trim();
      const senha = $('#login-senha').value;
      if (!email || !senha) { mostrar('Preencha o e-mail e a senha.'); return; }
      const b = $('#login-ok');
      b.disabled = true;
      b.textContent = 'Entrando…';
      mostrar('');
      try {
        salvarPref('ultimoEmail', email);
        await firebase.auth().signInWithEmailAndPassword(email, senha);
      } catch (err) {
        mostrar(ERROS_LOGIN[err.code] || `Não foi possível entrar (${err.code || err.message}).`);
        b.disabled = false;
        b.textContent = 'Entrar';
      }
    });
    $('#login-esqueci').addEventListener('click', async () => {
      const email = $('#login-email').value.trim();
      if (!email) { mostrar('Digite seu e-mail acima e clique de novo em "Esqueci minha senha".', 'info'); return; }
      try {
        await firebase.auth().sendPasswordResetEmail(email, { url: `${location.origin}/` }).catch((err) => {
          if (/continue|domain|unauthorized/i.test(err.code || '')) return firebase.auth().sendPasswordResetEmail(email);
          throw err;
        });
        mostrar(`Se ${email} tiver acesso, chegará um e-mail com o link para criar uma nova senha. Veja também a caixa de spam.`, 'ok');
      } catch (err) {
        mostrar(ERROS_LOGIN[err.code] || `Não foi possível enviar (${err.code || err.message}).`);
      }
    });
    return;
  }
  if (estado === 'verificar') {
    box.innerHTML = `${topo}<h2>Confirme o seu e-mail</h2><p>${H(texto || 'Para o primeiro acesso, confirme o seu e-mail pelo link que enviamos.')}</p>
      <p class="gate-msg info" id="gv-msg" hidden></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-primary" type="button" id="gv-ja">Já confirmei</button>
        <button class="btn" type="button" id="gv-enviar">Enviar o link de novo</button>
        <button class="btn btn-ghost" type="button" id="gv-sair">Sair</button>
      </div>`;
    const msg = $('#gv-msg');
    $('#gv-enviar').addEventListener('click', async () => {
      try {
        await firebase.auth().currentUser.sendEmailVerification();
        msg.textContent = `Link enviado para ${firebase.auth().currentUser.email}. Veja também a caixa de spam.`;
      } catch (err) { msg.textContent = ERROS_LOGIN[err.code] || err.message; }
      msg.hidden = false;
    });
    $('#gv-ja').addEventListener('click', async () => {
      await firebase.auth().currentUser.reload();
      await firebase.auth().currentUser.getIdToken(true);
      entrar(firebase.auth().currentUser);
    });
    $('#gv-sair').addEventListener('click', sair);
    return;
  }
  const titulos = {
    bloqueado: 'Acesso não liberado',
    config: 'Login ainda não configurado',
    sdk: 'Não foi possível carregar o login',
    erro: 'Não foi possível abrir o FrotaGest',
  };
  box.innerHTML = `${topo}<h2>${H(titulos[estado] || 'Aviso')}</h2><p>${H(texto)}</p>
    <div style="display:flex;gap:8px;margin-top:8px">${estado === 'bloqueado' || estado === 'erro' ? '<button class="btn btn-primary" type="button" id="gb-sair">Entrar com outro login</button>' : '<button class="btn btn-primary" type="button" id="gb-recarregar">Tentar de novo</button>'}</div>`;
  const s = $('#gb-sair');
  if (s) s.addEventListener('click', sair);
  const r = $('#gb-recarregar');
  if (r) r.addEventListener('click', () => location.reload());
}

async function entrar(user) {
  try {
    S.eu = await api('/api/eu', { headers: primeiroAcesso ? { 'X-Novo-Acesso': '1' } : {} });
    primeiroAcesso = false;
  } catch (e) {
    S.eu = null;
    if (e.codigo === 'email_nao_verificado') { mostrarGate('verificar', e.message); return; }
    if (e.status === 403) { mostrarGate('bloqueado', e.message); return; }
    if (e.status === 401) { await firebase.auth().signOut(); mostrarGate('login', 'Sua sessão expirou. Entre novamente.'); return; }
    mostrarGate('erro', e.message);
    return;
  }
  abrirApp(user);
}

async function abrirApp() {
  $('#gate').hidden = true;
  $('#carregando').hidden = true;
  $('#shell').hidden = false;
  $('#tb-nome').textContent = S.eu.nome;
  $('#tb-perfil').textContent = S.eu.empresaNome ? `${NOMES_PERFIL[S.eu.perfil]} · ${S.eu.empresaNome}` : S.eu.perfilNome;
  $('#tb-avatar').textContent = iniciais(S.eu.nome);
  montarNav();
  S.empresa = S.eu.perfil === 'master' ? pref('empresa', '') : '';
  try {
    await carregarFrota();
  } catch (e) {
    toast(`Não foi possível carregar a frota: ${e.message}`, 'err');
  }
  atualizarSeletorEmpresa();
  atualizarResumoAlertas();
  conectarEventos();
  abrirRota();
}

function atualizarSeletorEmpresa() {
  const sel = $('#tb-empresa');
  if (S.eu.perfil !== 'master') { sel.hidden = true; return; }
  if (S.empresa && !S.empresas.some((e) => String(e.id) === String(S.empresa))) S.empresa = '';
  sel.innerHTML = `<option value="">Todas as empresas</option>${S.empresas.map((e) => `<option value="${e.id}">${H(e.nome)}</option>`).join('')}`;
  sel.value = S.empresa;
  sel.hidden = !S.empresas.length;
}

async function sair() {
  try { if (S.eu) await api('/api/sair', { corpo: {} }); } catch { /* sessão já encerrada */ }
  S.eu = null;
  pararEventos();
  if (S.paginaAtual && S.paginaAtual.sair) { try { S.paginaAtual.sair(); } catch { /* ok */ } }
  S.paginaAtual = null;
  $('#conteudo').innerHTML = '';
  await firebase.auth().signOut();
}

async function iniciar() {
  $$('.versao').forEach((x) => { x.textContent = ''; });
  try {
    S.config = await fetch('/api/publica/config').then((r) => r.json());
  } catch {
    mostrarGate('erro', 'O servidor não respondeu. Verifique a conexão e tente de novo.');
    return;
  }
  $$('.versao').forEach((x) => { x.textContent = S.config.versao; });
  if (!S.config.firebase) { mostrarGate('config', 'O administrador do sistema ainda precisa preencher a configuração do Firebase no servidor.'); return; }
  if (!window.firebase || !firebase.initializeApp) { mostrarGate('sdk', 'A biblioteca de login (Google Firebase) não carregou. Verifique a internet ou se algum bloqueador está impedindo www.gstatic.com.'); return; }
  firebase.initializeApp(S.config.firebase);
  firebase.auth().languageCode = 'pt-BR';
  firebase.auth().onAuthStateChanged((user) => {
    if (!user) {
      S.eu = null;
      pararEventos();
      mostrarGate('login');
      return;
    }
    entrar(user);
  });

  // cabeçalho
  $('#tb-sair').addEventListener('click', sair);
  $('#tb-alertas').addEventListener('click', () => navegar('alertas'));
  $('#tb-menu').addEventListener('click', () => document.body.classList.toggle('sb-open'));
  $('#sb-backdrop').addEventListener('click', () => document.body.classList.remove('sb-open'));
  $('#tb-empresa').addEventListener('change', (e) => {
    S.empresa = e.target.value;
    salvarPref('empresa', S.empresa);
    atualizarStatusFrota();
    emit('empresa');
    abrirRota();
  });
  window.addEventListener('hashchange', abrirRota);
}

iniciar();
