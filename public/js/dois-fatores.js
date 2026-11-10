'use strict';
/* FrotaGest — verificação em duas etapas na tela de entrada: digitar o código do aplicativo, cadastrar
 * o aplicativo (QR Code) e guardar os códigos de recuperação. Tudo no FrotaGest (o Firebase continua
 * só com o e-mail e a senha). Quem exige é o master. Reis Tecnologia */

/** No meio do uso (o master ligou a regra agora, ou zerou o cadastro): volta para a tela da segunda etapa. */
function pedirSegundaEtapa(dados) {
  if (!S.eu) return; // durante a entrada quem trata é o entrar()
  S.eu = null;
  pararSessao();
  pararEventos();
  $$('.modal-back').forEach((m) => m.remove());
  if (S.paginaAtual && S.paginaAtual.sair) { try { S.paginaAtual.sair(); } catch { /* ok */ } }
  S.paginaAtual = null;
  $('#conteudo').innerHTML = '';
  document.body.classList.remove('modo-tv');
  mostrarGate(dados.codigo === 'dois_fatores' ? '2fa' : '2fa-cadastro', dados);
}

/** Campo do código: só números, com um espaço no meio (000 000) para ler melhor. */
function campoCodigo(input, aoCompletar) {
  input.addEventListener('input', () => {
    if (input.dataset.rec) {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9);
      return;
    }
    const d = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    if (d.length === 6 && aoCompletar) aoCompletar();
  });
}

function montarSegundaEtapa(box, estado, extra, rodape) {
  const u = window.firebase && firebase.auth().currentUser;
  const email = extra.email || (u && u.email) || '';
  const msg = (t, tipo = 'err') => { const m = $('#gate-msg'); if (!m) return; m.textContent = t; m.className = `gate-msg ${tipo}`; m.hidden = !t; };
  const ligarSair = () => box.querySelectorAll('[data-sair]').forEach((b) => b.addEventListener('click', () => sair()));

  if (estado === '2fa') {
    box.innerHTML = `<div class="gate-conteudo">
      <div class="gate-ico">${ico('shield-lock')}</div>
      <h2>Verificação em duas etapas</h2>
      <p class="gate-texto" id="tf-texto">Abra o <b>Google Authenticator</b> (ou o aplicativo que você usou) e digite o código de 6 dígitos do <b>FrotaGest</b>.</p>
      <form class="login-form" id="tf-form" novalidate>
        <div class="input-group"><label for="tf-codigo" id="tf-rotulo">Código do aplicativo</label>
          <input id="tf-codigo" class="tf-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="000 000" required></div>
        <p class="gate-msg err" id="gate-msg" role="alert" hidden></p>
        <button class="btn-entrar" type="submit" id="gate-ok">${ico('shield-check')} Confirmar</button>
        <button class="link" type="button" id="tf-rec">${ico('lifebuoy', 'i-sm')} Perdeu o celular? Use um código de recuperação</button>
        <button class="link" type="button" data-sair>Sair e entrar com outro login</button>
      </form>
      <p class="tf-conta">${ico('user', 'i-sm')} ${H(email)}</p></div>${rodape}`;
    const campo = $('#tf-codigo');
    const form = $('#tf-form');
    const enviar = async () => {
      const codigo = campo.value.trim();
      if (!codigo) { msg('Digite o código.'); return; }
      const b = $('#gate-ok');
      if (b.disabled) return;
      b.disabled = true;
      msg('');
      try {
        const r = await api('/api/2fa/verificar', { corpo: { codigo } });
        b.innerHTML = `${ico('check')} Liberado`;
        marcarUso(true);
        await entrar();
        if (r.recuperacao) {
          setTimeout(() => toast(r.restantes > 2
            ? `Você entrou com um código de recuperação (restam ${r.restantes}).`
            : `Você entrou com um código de recuperação e restam só ${r.restantes}. Peça ao master para zerar a verificação e cadastre o aplicativo de novo.`, r.restantes > 2 ? '' : 'err'), 800);
        }
      } catch (e) {
        msg(e.message);
        campo.value = '';
        campo.focus();
        b.disabled = false;
      }
    };
    campoCodigo(campo, enviar);
    form.addEventListener('submit', (e) => { e.preventDefault(); enviar(); });
    $('#tf-rec').addEventListener('click', () => {
      const rec = !campo.dataset.rec;
      if (rec) campo.dataset.rec = '1'; else delete campo.dataset.rec;
      campo.value = '';
      campo.inputMode = rec ? 'text' : 'numeric';
      campo.placeholder = rec ? 'XXXX-XXXX' : '000 000';
      campo.autocomplete = rec ? 'off' : 'one-time-code';
      $('#tf-rotulo').textContent = rec ? 'Código de recuperação' : 'Código do aplicativo';
      $('#tf-texto').innerHTML = rec
        ? 'Digite um dos <b>códigos de recuperação</b> que você guardou ao ativar a verificação. Cada um vale uma vez só.'
        : 'Abra o <b>Google Authenticator</b> (ou o aplicativo que você usou) e digite o código de 6 dígitos do <b>FrotaGest</b>.';
      $('#tf-rec').innerHTML = rec ? `${ico('device-mobile', 'i-sm')} Voltar para o código do aplicativo` : `${ico('lifebuoy', 'i-sm')} Perdeu o celular? Use um código de recuperação`;
      msg('');
      campo.focus();
    });
    ligarSair();
    setTimeout(() => campo.focus({ preventScroll: true }), 60);
    return;
  }

  if (estado === '2fa-cadastro') {
    box.innerHTML = `<div class="gate-conteudo tf-cad">
      <div class="gate-ico">${ico('shield-lock')}</div>
      <h2>Proteja o seu acesso</h2>
      <p class="gate-texto">Além da senha, o FrotaGest vai pedir um código do seu celular ao entrar. Leva um minuto:</p>
      <ol class="tf-passos">
        <li><span>1</span><div><b>Instale</b> o Google Authenticator (ou o Microsoft Authenticator) no celular, pela loja de aplicativos.</div></li>
        <li><span>2</span><div>No aplicativo, toque em <b>+</b> e escolha <b>ler QR Code</b>:
          <div class="tf-qr" id="tf-qr"><span class="spinner"></span></div>
          <details class="tf-chave"><summary>Não consegue ler? Digite a chave</summary>
            <div class="tf-chave-linha"><code id="tf-chave">…</code><button class="btn tf-copiar" type="button" id="tf-copiar" title="Copiar a chave">${ico('copy', 'i-sm')}</button></div>
            <small>Conta: ${H(email)} · tipo: baseado em horário</small></details></div></li>
        <li><span>3</span><div>Digite o <b>código de 6 dígitos</b> que apareceu no aplicativo:</div></li>
      </ol>
      <form class="login-form" id="tf-form" novalidate>
        <div class="input-group"><input id="tf-codigo" class="tf-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000" aria-label="Código de 6 dígitos" required></div>
        <p class="gate-msg err" id="gate-msg" role="alert" hidden></p>
        <button class="btn-entrar" type="submit" id="gate-ok" disabled>${ico('shield-check')} Ativar e entrar</button>
        <button class="link" type="button" data-sair>Sair</button>
      </form></div>${rodape}`;
    ligarSair();
    let chave = '';
    api('/api/2fa/iniciar', { corpo: {} }).then((r) => {
      $('#tf-qr').innerHTML = r.qr;
      // a chave em duas linhas de 4 grupos (nunca quebra um grupo no meio)
      const grupos = r.chave.split(' ');
      $('#tf-chave').innerHTML = `${H(grupos.slice(0, 4).join(' '))}<br>${H(grupos.slice(4).join(' '))}`;
      chave = r.chave.replace(/\s/g, '');
      $('#gate-ok').disabled = false;
    }).catch((e) => {
      if (e.codigo === 'ja_ativa') { mostrarGate('2fa', extra); return; }
      $('#tf-qr').innerHTML = `<p class="tf-qr-erro">${H(e.message)}</p>`;
    });
    $('#tf-copiar').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(chave); msg('Chave copiada.', 'ok'); } catch { msg('Não foi possível copiar: digite a chave no aplicativo.', 'info'); }
    });
    const campo = $('#tf-codigo');
    const enviar = async () => {
      const b = $('#gate-ok');
      if (b.disabled) return;
      const codigo = campo.value.replace(/\D/g, '');
      if (codigo.length !== 6) { msg('Digite os 6 números que aparecem no aplicativo.'); return; }
      b.disabled = true;
      msg('');
      try {
        const r = await api('/api/2fa/confirmar', { corpo: { codigo } });
        mostrarGate('2fa-codigos', { codigos: r.codigos, email });
      } catch (e) {
        msg(e.message);
        campo.value = '';
        campo.focus();
        b.disabled = false;
      }
    };
    campoCodigo(campo, enviar);
    $('#tf-form').addEventListener('submit', (e) => { e.preventDefault(); enviar(); });
    return;
  }

  if (estado === '2fa-codigos') {
    const codigos = extra.codigos || [];
    box.innerHTML = `<div class="gate-conteudo">
      <div class="gate-ico ok">${ico('shield-check')}</div>
      <h2>Ativado! Guarde estes códigos</h2>
      <p class="gate-texto">Se perder o celular, cada código abaixo entra <b>uma vez</b> no lugar do código do aplicativo. Guarde fora do celular: no papel ou num gerenciador de senhas.</p>
      <div class="tf-codigos" id="tf-codigos">${codigos.map((c) => `<code>${H(c)}</code>`).join('')}</div>
      <div class="tf-acoes">
        <button class="btn" type="button" id="tf-copiar-tudo">${ico('copy', 'i-sm')} Copiar</button>
        <button class="btn" type="button" id="tf-baixar">${ico('file-download', 'i-sm')} Baixar (.txt)</button>
      </div>
      <p class="gate-msg ok" id="gate-msg" hidden></p>
      <label class="login-lembrar tf-guardei"><input type="checkbox" id="tf-guardei"> Guardei os códigos em um lugar seguro</label>
      <button class="btn-entrar" type="button" id="tf-continuar" disabled>${ico('login-2')} Continuar</button>
      <p class="tf-aviso">Estes códigos não aparecem de novo.</p></div>${rodape}`;
    const texto = `FrotaGest · Reis Tecnologia\nCódigos de recuperação da verificação em duas etapas\nConta: ${email}\nGerados em: ${fmtDataHora(textoServidor()).slice(0, 16)}\n\nCada código vale uma vez só.\n\n${codigos.join('\n')}\n`;
    $('#tf-copiar-tudo').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(texto); msg('Códigos copiados.', 'ok'); } catch { msg('Não foi possível copiar: use "Baixar".', 'info'); }
    });
    $('#tf-baixar').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([texto.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
      a.download = 'frotagest-codigos-de-recuperacao.txt';
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      msg('Arquivo baixado.', 'ok');
    });
    $('#tf-guardei').addEventListener('change', (e) => { $('#tf-continuar').disabled = !e.target.checked; });
    $('#tf-continuar').addEventListener('click', async () => {
      $('#tf-continuar').disabled = true;
      marcarUso(true);
      await entrar();
    });
  }
}
