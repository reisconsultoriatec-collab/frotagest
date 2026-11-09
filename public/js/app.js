'use strict';
/* FrotaGest — início do painel: entrar / criar conta (Firebase), cabeçalho e navegação. Reis Tecnologia */

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
  'auth/email-already-in-use': 'Este e-mail já tem login. Use a aba "Entrar" (ou "Esqueci minha senha").',
  'auth/weak-password': 'Senha fraca: use pelo menos 8 caracteres, com uma letra maiúscula e um número.',
  'auth/operation-not-allowed': 'O login por e-mail e senha está desativado no Firebase.',
  'auth/admin-restricted-operation': 'A criação de contas está desligada no Firebase (Authentication › Configurações › Ações do usuário).',
};
const ERROS_SENHA = ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found'];

let primeiroAcesso = true;
let cadastrando = false; // durante o "Criar conta" o painel não reage à troca de login

function validarSenha(s) {
  if (!s || s.length < 8 || !/[A-Z]/.test(s) || !/\d/.test(s)) {
    throw new Error('A senha precisa ter pelo menos 8 caracteres, com uma letra maiúscula e um número.');
  }
}

const campoSenha = (id, auto, placeholder) => `<span class="pw"><input type="password" id="${id}" autocomplete="${auto}" placeholder="${placeholder}" required><button type="button" data-ver="${id}" aria-label="Mostrar senha" title="Mostrar senha">${ico('eye', 'i-sm')}</button></span>
  <div class="caps-lock" id="caps-${id}" hidden>${ico('alert-triangle')} Caps Lock ligado</div>`;

const MARCA_CARTAO = `<div class="auth-card-nome"><span class="auth-marca">${ico('bus')}</span><span>FrotaGest</span></div>`;

function mostrarGate(estado, extra = {}) {
  if (typeof extra === 'string') extra = { texto: extra };
  $('#carregando').hidden = true;
  $('#shell').hidden = true;
  $('#gate').hidden = false;
  if (typeof iniciarTelaEntrada === 'function') iniciarTelaEntrada();
  const box = $('#gate-box');
  const versao = H(S.config ? S.config.versao : '');
  const termos = `<p class="login-termos">Ao entrar, você concorda com os <a href="/termos" target="_blank" rel="noopener">Termos de uso</a> e a <a href="/privacidade" target="_blank" rel="noopener">Política de privacidade</a>.</p>`;
  const rodape = `<div class="login-seguro">${ico('lock')} Conexão segura · acessos registrados</div>${termos}<p class="login-versao">FrotaGest ${versao} · Reis Tecnologia</p>`;
  const icone = (n, cls = '') => `<div class="gate-ico ${cls}">${ico(n)}</div>`;
  const cabecalho = (sub) => `<div class="auth-card-marca">${MARCA_CARTAO}<p id="gate-saudacao">${sub}</p></div>`;

  if (estado === 'login' || estado === 'cadastro') {
    const abas = `<div class="login-tabs gate-abas" role="tablist">
      <button class="login-tab${estado === 'login' ? ' active' : ''}" type="button" role="tab" aria-selected="${estado === 'login'}" data-aba="login">Entrar</button>
      <button class="login-tab${estado === 'cadastro' ? ' active' : ''}" type="button" role="tab" aria-selected="${estado === 'cadastro'}" data-aba="cadastro">Criar conta</button></div>`;
    if (estado === 'login') {
      box.innerHTML = `${cabecalho(typeof saudacao === 'function' ? saudacao() : 'Monitoramento de frota')}${abas}
        <form class="login-form gate-conteudo" id="login-form" novalidate>
          <div class="input-group"><label for="login-email">E-mail</label><input type="email" id="login-email" autocomplete="username" placeholder="seu@email.com" required></div>
          <div class="input-group"><label for="login-senha">Senha</label>${campoSenha('login-senha', 'current-password', 'Digite sua senha')}</div>
          <label class="login-lembrar" title="Guarda só o e-mail neste aparelho, nunca a senha. Não marque em computador compartilhado."><input type="checkbox" id="login-lembrar"> Lembrar meu e-mail</label>
          <p class="gate-msg err" id="gate-msg" role="alert" hidden></p>
          <button class="btn-entrar" type="submit" id="gate-ok">${ico('login-2')} Entrar</button>
          <button class="login-esqueci" type="button" id="login-esqueci">${ico('key')} Esqueci minha senha</button>
        </form>${rodape}`;
    } else {
      box.innerHTML = `${cabecalho('Crie o seu login com o código da sua empresa.')}${abas}
        <form class="login-form gate-conteudo" id="cad-form" novalidate>
          <div class="input-group"><label for="cad-nome">Seu nome completo</label><input id="cad-nome" maxlength="120" autocomplete="name" placeholder="Nome e sobrenome" required></div>
          <div class="input-group"><label for="cad-email">E-mail</label><input type="email" id="cad-email" maxlength="160" autocomplete="username" placeholder="seu@email.com" required></div>
          <div class="input-group"><label for="cad-senha">Senha</label>${campoSenha('cad-senha', 'new-password', 'Crie uma senha')}<small>Mínimo de 8 caracteres, com uma letra maiúscula e um número.</small></div>
          <div class="input-group"><label for="cad-codigo">Código da empresa</label><input id="cad-codigo" maxlength="12" autocomplete="off" class="codigo-input" placeholder="Ex.: K7M2Q9XA">
            <small>Peça ao administrador da sua empresa. O proprietário do sistema deixa em branco.</small></div>
          <p class="gate-msg err" id="gate-msg" role="alert" hidden></p>
          <button class="btn-entrar" type="submit" id="gate-ok">${ico('user-plus')} Criar conta</button>
        </form>${rodape}`;
    }
  } else if (estado === 'completar') {
    const u = firebase.auth().currentUser;
    box.innerHTML = `<div class="gate-conteudo">${icone('user-check')}<h2>Concluir cadastro</h2>
      <p class="gate-texto">O login <b>${H(u ? u.email : '')}</b> existe, mas falta concluir o cadastro no FrotaGest.</p>
      <form class="login-form" id="comp-form" novalidate>
        <div class="input-group"><label for="cad-nome">Seu nome completo</label><input id="cad-nome" maxlength="120" autocomplete="name" required></div>
        <div class="input-group"><label for="cad-codigo">Código da empresa</label><input id="cad-codigo" maxlength="12" autocomplete="off" class="codigo-input" placeholder="Ex.: K7M2Q9XA">
          <small>Peça ao administrador da sua empresa. O proprietário do sistema deixa em branco.</small></div>
        <p class="gate-msg err" id="gate-msg" role="alert" hidden></p>
        <button class="btn-entrar" type="submit" id="gate-ok">Concluir cadastro</button>
        <button class="link" type="button" data-sair>Sair e usar outro login</button>
      </form></div>${rodape}`;
    $('#cad-nome').value = extra.nome || (u && u.displayName) || '';
    $('#cad-codigo').value = extra.codigo || '';
  } else if (estado === 'pendente') {
    box.innerHTML = `<div class="gate-conteudo">${icone('clock-pause', 'aviso')}<h2>Aguardando aprovação</h2>
      <p class="gate-texto">Seu cadastro${extra.empresa ? ` em <b>${H(extra.empresa)}</b>` : ''} foi recebido. O administrador da empresa precisa aprovar o seu acesso e escolher o que você pode ver.</p>
      <p class="gate-msg info" id="gate-msg" hidden></p>
      <div class="gate-acoes"><button class="btn btn-primary" type="button" data-verificar>${ico('refresh', 'i-sm')} Verificar novamente</button>
        <button class="btn" type="button" data-sair>Sair</button></div></div>${rodape}`;
  } else if (estado === 'verificar') {
    box.innerHTML = `<div class="gate-conteudo">${icone('mail')}<h2>Confirme o seu e-mail</h2>
      <p class="gate-texto">${H(extra.texto || 'Enviamos um link de confirmação para o seu e-mail.')} Abra o e-mail (veja também o spam), clique no link e depois em "Já confirmei".</p>
      <p class="gate-msg info" id="gate-msg" hidden></p>
      <div class="gate-acoes"><button class="btn btn-primary" type="button" data-ja>Já confirmei</button>
        <button class="btn" type="button" data-reenviar>Enviar o link de novo</button>
        <button class="btn btn-ghost" type="button" data-sair>Sair</button></div></div>${rodape}`;
  } else {
    const titulos = { bloqueado: 'Acesso não liberado', config: 'Login ainda não configurado', sdk: 'Não foi possível carregar o login', erro: 'Não foi possível abrir o FrotaGest', inativo: 'Sessão encerrada' };
    box.innerHTML = `<div class="gate-conteudo">${icone('info-circle')}<h2>${H(titulos[estado] || 'Aviso')}</h2><p class="gate-texto">${H(extra.texto || '')}</p>
      <div class="gate-acoes">${estado === 'bloqueado' || estado === 'erro' ? '<button class="btn btn-primary" type="button" data-sair>Entrar com outro login</button>' : '<button class="btn btn-primary" type="button" data-recarregar>Tentar de novo</button>'}</div></div>${rodape}`;
  }

  const msg = $('#gate-msg');
  const mostrar = (t, tipo = 'err') => { if (!msg) return; msg.textContent = t; msg.className = `gate-msg ${tipo}`; msg.hidden = !t; };
  if (extra.erro) mostrar(extra.erro);
  else if (extra.texto && (estado === 'login' || estado === 'cadastro')) mostrar(extra.texto, extra.tipo || 'err');

  // eventos
  box.querySelectorAll('[data-aba]').forEach((b) => b.addEventListener('click', () => mostrarGate(b.dataset.aba)));
  box.querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', () => {
    const s = $(`#${b.dataset.ver}`);
    s.type = s.type === 'password' ? 'text' : 'password';
  }));
  box.querySelectorAll('[data-sair]').forEach((b) => b.addEventListener('click', () => sair()));
  const rec = box.querySelector('[data-recarregar]');
  if (rec) rec.addEventListener('click', () => location.reload());
  const verif = box.querySelector('[data-verificar]');
  if (verif) verif.addEventListener('click', async () => { verif.disabled = true; await entrar(); });
  const ja = box.querySelector('[data-ja]');
  if (ja) {
    ja.addEventListener('click', async () => {
      ja.disabled = true;
      const u = firebase.auth().currentUser;
      try { await u.reload(); await u.getIdToken(true); } catch { /* segue */ }
      if (!firebase.auth().currentUser.emailVerified) {
        mostrar('O e-mail ainda não aparece como confirmado. Abra o link do e-mail e tente de novo.', 'info');
        ja.disabled = false;
        return;
      }
      // proprietário: depois de confirmar, o cadastro de master é concluído no primeiro acesso
      await entrar();
    });
  }
  const reenv = box.querySelector('[data-reenviar]');
  if (reenv) {
    reenv.addEventListener('click', async () => {
      try {
        await firebase.auth().currentUser.sendEmailVerification();
        mostrar(`Link enviado para ${firebase.auth().currentUser.email}. Veja também a caixa de spam.`, 'info');
      } catch (err) { mostrar(ERROS_LOGIN[err.code] || err.message); }
    });
  }

  box.querySelectorAll('.pw input').forEach((c) => avisarCapsLock(c, $(`#caps-${c.id}`)));

  if (estado === 'login') {
    const lembrado = emailLembrado();
    $('#login-email').value = lembrado;
    $('#login-lembrar').checked = !!lembrado;
    $('#login-lembrar').addEventListener('change', (e) => { if (!e.target.checked) lembrarEmail('', false); });
    // no computador o cursor já vai para o campo certo (no celular não abre o teclado sozinho)
    try { if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => ($('#login-email').value ? $('#login-senha') : $('#login-email')).focus({ preventScroll: true }), 60); } catch { /* segue */ }
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#login-email').value.trim();
      const senha = $('#login-senha').value;
      if (!email || !senha) { mostrar('Preencha o e-mail e a senha.'); return; }
      const b = $('#gate-ok');
      b.disabled = true;
      b.textContent = 'Entrando…';
      mostrar('');
      try {
        const lembrar = $('#login-lembrar').checked;
        await firebase.auth().signInWithEmailAndPassword(email, senha);
        lembrarEmail(email, lembrar);
        marcarUso(); // a contagem de inatividade começa agora
      } catch (err) {
        if (ERROS_SENHA.includes(err.code)) {
          fetch('/api/conta/falha-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).catch(() => {});
        }
        mostrar(ERROS_LOGIN[err.code] || `Não foi possível entrar (${err.code || err.message}).`);
        b.disabled = false;
        b.innerHTML = `${ico('login-2')} Entrar`;
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
      } catch { /* mesma resposta para não revelar quais e-mails têm login */ }
      mostrar(`Se ${email} tiver login, chegará um e-mail com o link para criar uma nova senha. Veja também a caixa de spam.`, 'ok');
    });
  }

  if (estado === 'cadastro') {
    setTimeout(() => $('#cad-nome').focus(), 50);
    $('#cad-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = { nome: $('#cad-nome').value.trim(), email: $('#cad-email').value.trim(), senha: $('#cad-senha').value, codigo: $('#cad-codigo').value.trim().toUpperCase() };
      try {
        if (d.nome.length < 3) throw new Error('Informe o seu nome completo.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) throw new Error('Informe um e-mail válido.');
        validarSenha(d.senha);
      } catch (err) { mostrar(err.message); return; }
      const b = $('#gate-ok');
      b.disabled = true;
      b.textContent = 'Criando conta…';
      mostrar('');
      cadastrando = true;
      try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(d.email, d.senha);
        marcarUso();
        cred.user.updateProfile({ displayName: d.nome }).catch(() => {});
        cred.user.sendEmailVerification().catch(() => {});
        await concluirCadastro(d.nome, d.codigo);
      } catch (err) {
        if (firebase.auth().currentUser) {
          // o login foi criado, mas o código não foi aceito: corrige sem criar outra conta
          mostrarGate('completar', { erro: err.message, nome: d.nome, codigo: d.codigo });
        } else {
          mostrar(ERROS_LOGIN[err.code] || err.message);
          b.disabled = false;
          b.innerHTML = `${ico('user-plus')} Criar conta`;
        }
      } finally {
        cadastrando = false;
      }
    });
  }

  if (estado === 'completar') {
    $('#comp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nome = $('#cad-nome').value.trim();
      const codigo = $('#cad-codigo').value.trim().toUpperCase();
      if (nome.length < 3) { mostrar('Informe o seu nome completo.'); return; }
      const b = $('#gate-ok');
      b.disabled = true;
      try {
        await concluirCadastro(nome, codigo);
      } catch (err) {
        mostrar(err.message);
        b.disabled = false;
      }
    });
  }
}

/** Depois de criar o login no Firebase: grava o cadastro no FrotaGest (pendente ou master). */
async function concluirCadastro(nome, codigo) {
  let r;
  try {
    r = await api('/api/conta/registrar', { corpo: { nome, codigo } });
  } catch (e) {
    if (e.codigo === 'email_nao_verificado') { mostrarGate('verificar', 'Enviamos um link de confirmação para o seu e-mail: o acesso de proprietário só é liberado depois de confirmar.'); return; }
    if (e.codigo === 'ja_cadastrado') { await entrar(); return; }
    throw e;
  }
  if (r.status === 'pendente') { mostrarGate('pendente', { empresa: r.empresa }); return; }
  await entrar();
}

async function entrar() {
  // ficou sem uso além do limite (mesmo com a janela fechada): encerra antes de abrir o painel
  if (sessaoVencida(lerNumero('fg:sessaoMin'))) { await encerrarPorInatividade(lerNumero('fg:sessaoMin')); return; }
  try {
    S.eu = await api('/api/eu', { headers: primeiroAcesso ? { 'X-Novo-Acesso': '1' } : {} });
    primeiroAcesso = false;
  } catch (e) {
    S.eu = null;
    if (e.codigo === 'email_nao_verificado') { mostrarGate('verificar', e.message); return; }
    if (e.codigo === 'pendente') { mostrarGate('pendente', { empresa: e.dados && e.dados.empresa }); return; }
    if (e.codigo === 'sem_cadastro') { mostrarGate('completar'); return; }
    if (e.status === 403) { mostrarGate('bloqueado', e.message); return; }
    if (e.status === 401) { await firebase.auth().signOut(); mostrarGate('login', 'Sua sessão expirou. Entre novamente.'); return; }
    mostrarGate('erro', e.message);
    return;
  }
  if (sessaoVencida(S.eu.sessaoMin)) { await encerrarPorInatividade(S.eu.sessaoMin); return; }
  abrirApp();
}

async function abrirApp() {
  if (typeof pararTelaEntrada === 'function') pararTelaEntrada();
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
  atualizarPendentes();
  conectarEventos();
  iniciarSessao();
  atualizarBotaoSom();
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

async function sair(motivo) {
  try { if (S.eu || motivo) await api('/api/sair', { corpo: motivo ? { motivo } : {} }); } catch { /* sessão já encerrada */ }
  S.eu = null;
  pararSessao();
  limparSessaoLocal();
  $('#nova-versao').hidden = true;
  $('#tb-som-pop').hidden = true;
  $$('.modal-back').forEach((m) => m.remove());
  pararEventos();
  if (S.paginaAtual && S.paginaAtual.sair) { try { S.paginaAtual.sair(); } catch { /* ok */ } }
  S.paginaAtual = null;
  $('#conteudo').innerHTML = '';
  await firebase.auth().signOut();
}

async function iniciar() {
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
    if (cadastrando) return;
    if (!user) {
      S.eu = null;
      pararEventos();
      pararSessao();
      mostrarGate('login', avisoLogin || {});
      avisoLogin = null;
      return;
    }
    entrar();
  });

  // cabeçalho
  $('#tb-sair').addEventListener('click', () => sair());
  $('#tb-atualizar').addEventListener('click', atualizarTela);
  $('#tb-tema').addEventListener('click', trocarTema);
  $('#tb-som').addEventListener('click', abrirMenuSom);
  $('#nv-atualizar').addEventListener('click', () => location.reload());
  $('#nv-fechar').addEventListener('click', () => { $('#nova-versao').hidden = true; });
  $('#tb-alertas').addEventListener('click', () => navegar('alertas'));
  $('#tb-menu').addEventListener('click', () => document.body.classList.toggle('sb-open'));
  $('#sb-backdrop').addEventListener('click', () => document.body.classList.remove('sb-open'));
  $('#tb-empresa').addEventListener('change', (e) => {
    S.empresa = e.target.value;
    salvarPref('empresa', S.empresa);
    atualizarStatusFrota();
    atualizarPendentes();
    emit('empresa');
    abrirRota();
  });
  window.addEventListener('hashchange', abrirRota);
}

iniciar();
