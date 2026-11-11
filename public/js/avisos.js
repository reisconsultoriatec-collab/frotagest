'use strict';
/* FrotaGest — avisos no celular (e no computador) com o painel fechado, pelo Web Push do navegador.
 * A pessoa ativa em cada aparelho dela, escolhe o nível (só alta, alta e média, todos) e pode mandar
 * um aviso de teste. No iPhone os avisos funcionam pelo app instalado (iOS 16.4 ou mais novo).
 * Reis Tecnologia */

const pushSuportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

function deB64u(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const paraB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hashTexto(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** O service worker pronto (com limite de espera: sem ele não há aviso). */
async function swPronto() {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((ok) => setTimeout(() => ok(null), 8000))]);
}

async function inscricaoAtual() {
  if (!pushSuportado()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

async function ativarAvisosAqui(chave) {
  let p = Notification.permission;
  if (p === 'default') { try { p = await Notification.requestPermission(); } catch { p = 'denied'; } }
  if (p !== 'granted') throw Object.assign(new Error('O navegador não liberou as notificações.'), { bloqueado: p === 'denied' });
  const reg = await swPronto();
  if (!reg) throw new Error('O aplicativo ainda está carregando. Feche esta janela e tente de novo em alguns segundos.');
  let sub = await reg.pushManager.getSubscription();
  // inscrição feita com outra chave do servidor (servidor reinstalado): refaz
  if (sub && sub.options && sub.options.applicationServerKey && paraB64u(sub.options.applicationServerKey) !== chave) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64u(chave) });
  const j = sub.toJSON();
  const r = await api('/api/push/inscricao', { corpo: { endpoint: j.endpoint, keys: j.keys, instalado: instalado() } });
  S.pushAqui = true;
  return r;
}

async function desativarAvisosAqui() {
  S.pushAqui = false;
  const sub = await inscricaoAtual();
  if (!sub) return;
  try { await api('/api/push/remover', { corpo: { endpoint: sub.endpoint } }); } catch { /* sem sessão: o servidor descobre sozinho no próximo aviso */ }
  try { await sub.unsubscribe(); } catch { /* já cancelada */ }
}

/** Ao entrar: se este navegador já recebe os avisos desta pessoa, mantém as chaves em dia (não liga nada novo). */
async function sincronizarAvisos() {
  try {
    if (!podeTela('alertas') || !pushSuportado() || Notification.permission !== 'granted') return;
    const sub = await inscricaoAtual();
    if (!sub) return;
    const j = sub.toJSON();
    const r = await api('/api/push/inscricao', { corpo: { endpoint: j.endpoint, keys: j.keys, sincronizar: true, instalado: instalado() } });
    S.pushAqui = Boolean(r && r.ativo);
  } catch { /* sem avisos: o painel funciona igual */ }
}

/** Clique num aviso com o painel aberto: o service worker pede para abrir a tela do alerta. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.tipo === 'abrir' && typeof d.url === 'string') {
      const h = new URL(d.url, location.origin).hash;
      if (h && S.eu) location.hash = h;
    }
  });
}

/** Situação deste aparelho: [classe, título, texto]. */
function estadoAvisosAqui(ativo) {
  if (!pushSuportado()) {
    if (ehIOS() && !instalado()) {
      return ['ios', 'No iPhone, os avisos chegam pelo app instalado',
        'No Safari, toque em Compartilhar › Adicionar à Tela de Início, abra o FrotaGest pelo ícone e ative aqui (iOS 16.4 ou mais novo).'];
    }
    return ['sem', 'Este navegador não recebe avisos', 'Use o Chrome, o Edge, o Firefox ou o Safari atualizados, pelo endereço com https.'];
  }
  if (Notification.permission === 'denied') {
    return ['bloqueado', 'As notificações estão bloqueadas neste navegador',
      'Libere nas configurações do site (cadeado ao lado do endereço) ou do celular (Configurações › Notificações) e abra esta janela de novo.'];
  }
  if (ativo) return ['ativo', 'Este aparelho recebe os avisos', 'Mesmo com o FrotaGest fechado: os alertas aparecem como notificação, com o som e a vibração do aparelho.'];
  const dica = /Android/.test(navigator.userAgent) && !instalado() ? ' Dica: instale o app (botão Instalar no topo) para o aviso abrir direto nele.' : '';
  return ['inativo', 'Este aparelho ainda não recebe avisos', 'Ative para receber os alertas mesmo com o painel fechado.' + dica];
}

async function abrirAvisosCelular() {
  const j = janela({
    titulo: 'Avisos no celular', icone: 'device-mobile-message',
    corpo: '<div id="av-corpo"><p class="hint">Carregando…</p></div>',
    rodape: '<button class="btn" type="button" data-fechar>Fechar</button>',
  });
  const corpo = j.el.querySelector('#av-corpo');
  let ocupado = false;

  async function desenhar() {
    let s;
    try {
      s = await api('/api/push');
    } catch (e) {
      corpo.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
      return;
    }
    const sub = await inscricaoAtual().catch(() => null);
    const meu = sub ? await hashTexto(sub.endpoint) : null;
    const aqui = meu ? s.aparelhos.find((a) => a.hash === meu) : null;
    S.pushAqui = Boolean(aqui);
    const [cls, tit, txt] = estadoAvisosAqui(Boolean(aqui));
    const botoes = cls === 'ativo'
      ? `<button class="btn btn-sm" type="button" data-teste>${ico('send', 'i-sm')} Enviar teste</button><button class="btn btn-sm btn-ghost" type="button" data-desativar>Desativar aqui</button>`
      : cls === 'inativo' ? `<button class="btn btn-primary" type="button" data-ativar>${ico('bell-ringing', 'i-sm')} Ativar neste aparelho</button>` : '';
    const niveis = [['alta', 'Só gravidade alta', 'pânico, área proibida, uso fora do horário, sem comunicação…'], ['media', 'Alta e média', 'inclui excesso de velocidade e parada longa'], ['todas', 'Todos os alertas', '']];
    corpo.innerHTML = `
      <div class="av-aqui ${cls}">
        <div class="av-aqui-ico">${ico(cls === 'ativo' ? 'bell-ringing' : 'bell-off')}</div>
        <div class="av-aqui-txt"><b>${H(tit)}</b><span>${H(txt)}</span>${botoes ? `<div class="av-botoes">${botoes}</div>` : ''}</div>
      </div>
      <p class="form-erro" id="av-erro" hidden></p>
      <div class="form-sep">Quais alertas</div>
      <div class="av-niveis">${niveis.map(([v, t, d]) => `<label class="av-nivel"><input type="radio" name="av-nivel" value="${v}" ${s.nivel === v ? 'checked' : ''}><span><b>${t}</b>${d ? `<small>${d}</small>` : ''}</span></label>`).join('')}</div>
      <p class="small muted" style="margin:8px 0 0">Vale para todos os seus aparelhos. Chegam só os alertas dos veículos que você vê no painel; vários de uma vez viram um aviso só. Clicar em <b>Sair</b> desliga os avisos daquele aparelho.</p>
      <div class="form-sep">Seus aparelhos que recebem</div>
      ${s.aparelhos.length ? `<div class="av-lista">${s.aparelhos.map((a) => `
        <div class="av-item">
          ${ico(/iPhone|Android|iPad/.test(a.nome) ? 'device-mobile' : 'device-desktop', 'i-sm')}
          <div class="av-item-txt"><b>${H(a.nome)}${a.hash === meu ? ' <span class="tag ok">este aparelho</span>' : ''}</b>
            <small>ativado ${H(String(a.criadoEm).slice(0, 10) === textoServidor().slice(0, 10) ? `hoje às ${String(a.criadoEm).slice(11, 16)}` : fmtDataHora(a.criadoEm).slice(0, 10))}${a.usadoEm ? ` · último aviso ${H(atras(a.usadoEm))}` : ''}${a.falhas ? ` · ${a.falhas} falha(s) de entrega` : ''}</small></div>
          <button class="det-close" type="button" data-remover="${a.id}" title="Parar de enviar para este aparelho" aria-label="Remover">${ico('trash', 'i-sm')}</button>
        </div>`).join('')}</div>` : '<p class="small muted" style="margin:0">Nenhum aparelho ainda.</p>'}`;
  }

  const erro = (m) => { const e = corpo.querySelector('#av-erro'); if (e) { e.textContent = m; e.hidden = !m; } };

  corpo.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ativar], [data-desativar], [data-teste], [data-remover]');
    if (!b || ocupado) return;
    ocupado = true;
    b.disabled = true;
    erro('');
    try {
      if (b.matches('[data-ativar]')) {
        const s = await api('/api/push');
        const r = await ativarAvisosAqui(s.chavePublica);
        toast('Avisos ativados neste aparelho: mandamos um aviso de teste.', 'ok');
        try { await api('/api/push/teste', { corpo: { id: r.id } }); } catch { /* o teste é só um extra */ }
      } else if (b.matches('[data-desativar]')) {
        await desativarAvisosAqui();
        toast('Este aparelho não recebe mais os avisos.', 'ok');
      } else if (b.matches('[data-teste]')) {
        const sub = await inscricaoAtual();
        const s = await api('/api/push');
        const meu = sub ? await hashTexto(sub.endpoint) : null;
        const a = s.aparelhos.find((x) => x.hash === meu);
        const r = await api('/api/push/teste', { corpo: a ? { id: a.id } : {} });
        toast(r.enviados ? 'Aviso de teste enviado: deve chegar em alguns segundos.' : 'O serviço de avisos do navegador recusou o teste.', r.enviados ? 'ok' : 'err');
      } else {
        await api('/api/push/remover', { corpo: { id: Number(b.dataset.remover) } });
        toast('Aparelho removido dos avisos.', 'ok');
      }
      await desenhar();
    } catch (err) {
      erro(err.bloqueado ? 'O navegador bloqueou as notificações. Libere nas configurações do site e tente de novo.' : err.message);
      b.disabled = false;
    } finally {
      ocupado = false;
    }
  });

  corpo.addEventListener('change', async (e) => {
    const r = e.target.closest('[name=av-nivel]');
    if (!r) return;
    try {
      await api('/api/push/nivel', { metodo: 'PUT', corpo: { nivel: r.value } });
      toast('Pronto: vale para todos os seus aparelhos.', 'ok');
    } catch (err) { erro(err.message); }
  });

  await desenhar();
}
