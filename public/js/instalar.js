'use strict';
/* FrotaGest — aplicativo instalável: registra o service worker e mostra o botão "Instalar" no topo
 * quando o navegador permite (Android, Chrome e Edge no computador). No iPhone e iPad explica o
 * caminho pelo Safari (Compartilhar › Adicionar à Tela de Início). Reis Tecnologia */

let pedidoInstalacao = null;

const instalado = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const ehIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function registrarAplicativo() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sem o service worker o painel funciona igual */ });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pedidoInstalacao = e;
    mostrarBotaoInstalar();
  });
  window.addEventListener('appinstalled', () => {
    pedidoInstalacao = null;
    mostrarBotaoInstalar();
    toast('FrotaGest instalado: abra pelo ícone na tela inicial.', 'ok');
  });
  document.documentElement.classList.toggle('app-instalado', instalado());
}

function mostrarBotaoInstalar() {
  const b = $('#tb-instalar');
  if (!b) return;
  b.hidden = instalado() || !(pedidoInstalacao || ehIOS());
}

async function instalarAplicativo() {
  if (pedidoInstalacao) {
    pedidoInstalacao.prompt();
    try { await pedidoInstalacao.userChoice; } catch { /* fechou */ }
    pedidoInstalacao = null;
    mostrarBotaoInstalar();
    return;
  }
  janela({
    titulo: 'Instalar no iPhone ou iPad', icone: 'device-mobile', tamanho: 'sm',
    corpo: `<ol class="instalar-ios">
      <li>Abra o FrotaGest no <b>Safari</b>.</li>
      <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima).</li>
      <li>Escolha <b>Adicionar à Tela de Início</b> e confirme em <b>Adicionar</b>.</li></ol>
      <p class="small muted" style="margin:10px 0 0">O ícone do FrotaGest aparece na tela inicial e abre em tela cheia, como um aplicativo.</p>`,
    rodape: '<button class="btn btn-primary" type="button" data-fechar>Entendi</button>',
  });
}
