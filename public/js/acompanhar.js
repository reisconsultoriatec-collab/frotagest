'use strict';
/* FrotaGest — página pública de acompanhamento (/a/<código>): a posição do veículo ou as viagens da linha,
 * a hora estimada no ponto de quem acompanha e o aviso "está chegando" no celular. Sem login.
 * Reis Tecnologia */
(() => {
  const token = location.pathname.split('/')[2] || '';
  const API = `/api/publico/a/${encodeURIComponent(token)}`;
  const $ = (s) => document.querySelector(s);
  const H = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const ONIBUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M16 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 17h-2v-11a1 1 0 0 1 1 -1h14a5 7 0 0 1 5 7v5h-2m-4 0h-8"/><path d="M16 5l1.5 7l4.5 0"/><path d="M2 10l15 0"/><path d="M7 5l0 5"/><path d="M12 5l0 5"/></svg>';
  const SINO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/></svg>';
  const TIPO = { van: 'Van', onibus: 'Ônibus', 'micro-onibus': 'Micro-ônibus', carro: 'Carro', caminhao: 'Caminhão' };
  const ehIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalado = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const podePush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const guardado = {
    ler(k) { try { return localStorage.getItem(`fg-a:${token}:${k}`); } catch { return null; } },
    gravar(k, v) { try { if (v === null) localStorage.removeItem(`fg-a:${token}:${k}`); else localStorage.setItem(`fg-a:${token}:${k}`, String(v)); } catch { /* sem armazenamento */ } },
  };

  let dados = null;
  let recebidoEm = 0;
  let primeira = true;
  let timer = null;
  let falhou = false;
  let mapa = null;
  let camadaLinha = null;
  let camadaVeic = null;
  let enquadrado = false;
  let seguir = true;
  let meuPonto = Number(guardado.ler('ponto')) || null;
  let minutosAviso = Number(guardado.ler('minutos')) || 5;
  let endpoint = null;
  let avisoMsg = null; // { tipo: 'ok' | 'erro', texto }
  let avisoOcupado = false;

  // o manifesto desta página (instalar no celular abre direto no link)
  const man = $('#ac-manifesto');
  if (man) man.href = `/a/${encodeURIComponent(token)}/manifest.webmanifest`;

  /* ---------- horários (sempre relativos ao relógio do servidor) ---------- */

  const RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
  function ms(t) {
    const m = RE.exec(String(t || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
  }
  const agoraServidor = () => ms(dados.agora) + (Date.now() - recebidoEm);
  const hhmm = (t) => String(t || '').slice(11, 16);
  const minutosAte = (t) => Math.round((ms(t) - agoraServidor()) / 60000);
  function quando(t) {
    const d = String(t || '').slice(0, 10);
    const hoje = new Date(agoraServidor()).toISOString().slice(0, 10);
    const amanha = new Date(agoraServidor() + 86400000).toISOString().slice(0, 10);
    const dia = d === hoje ? 'hoje' : d === amanha ? 'amanhã' : `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    return `${dia} às ${hhmm(t)}`;
  }
  function haQuanto(t) {
    const s = Math.max(0, Math.round((agoraServidor() - ms(t)) / 1000));
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    return `às ${hhmm(t)} de ${t.slice(8, 10)}/${t.slice(5, 7)}`;
  }

  /* ---------- buscar ---------- */

  async function carregar() {
    clearTimeout(timer);
    try {
      const q = new URLSearchParams();
      if (primeira) q.set('primeira', '1');
      if (endpoint) q.set('endpoint', endpoint);
      const r = await fetch(`${API}?${q}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) { invalido(j.erro); return; }
      if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
      primeira = false;
      falhou = false;
      dados = j;
      recebidoEm = Date.now();
      desenhar();
    } catch {
      falhou = true;
      if (dados) desenhar(); else $('#ac-corpo').innerHTML = '<p class="ac-erro">Sem conexão com o servidor. Tentando de novo…</p>';
    }
    timer = setTimeout(carregar, document.hidden ? 60000 : 10000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) carregar(); });

  function invalido(msg) {
    $('#ac-titulo').textContent = 'Link sem validade';
    $('#ac-corpo').innerHTML = `<div class="ac-invalido"><h2>Este link não vale mais</h2><p class="ac-dica">${H(msg || 'Ele venceu ou foi cancelado. Peça um novo a quem enviou.')}</p></div>`;
    if (camadaVeic) camadaVeic.clearLayers();
    $('#ac-centro').hidden = true;
  }

  /* ---------- desenhar ---------- */

  function desenhar() {
    const d = dados;
    document.title = `${d.titulo} · Acompanhamento`;
    $('#ac-emp').textContent = d.empresa;
    const logo = $('#ac-logo');
    if (d.logo && logo.hidden && !logo.dataset.pedido) {
      logo.dataset.pedido = '1';
      logo.onload = () => { logo.hidden = false; };
      logo.src = `${API}/logo`;
    }
    $('#ac-titulo').textContent = d.titulo;
    const html = d.tipo === 'veiculo' ? htmlVeiculo(d) : htmlLinha(d);
    const validade = d.validoAte ? `<p class="ac-dica">Link válido até ${H(quando(d.validoAte))}.</p>` : '';
    $('#ac-corpo').innerHTML = `${falhou ? '<p class="ac-erro">Sem conexão agora: mostrando a última informação recebida.</p>' : ''}${html}${validade}`;
    ligarControles();
    desenharMapa();
  }

  function chip(cls, texto) { return `<span class="ac-chip ${cls}"><i></i>${H(texto)}</span>`; }

  function htmlVeiculo(d) {
    if (d.estado === 'indisponivel') return `<div class="ac-estado">${chip('erro', 'Indisponível')}</div><p class="ac-dica">O veículo não está disponível para acompanhamento agora.</p>`;
    if (!d.posicao) return `<div class="ac-estado">${chip('espera', 'Sem posição')}</div><p class="ac-dica">O veículo ainda não mandou a posição do GPS.</p>`;
    const p = d.posicao;
    const vivo = p.online;
    return `<div class="ac-estado">${chip(vivo ? 'vivo' : 'espera', vivo ? 'Ao vivo' : 'Sem sinal agora')}
        <span class="ac-sub">${vivo ? (p.vel > 3 ? `${p.vel} km/h` : 'parado') : 'última posição'} · ${H(p.hora ? haQuanto(p.hora) : '')}</span></div>
      ${d.veiculo ? `<p class="ac-sub" style="margin:0">${H(TIPO[String(d.tipoVeiculo || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()] || 'Veículo')} ${H(d.veiculo)}</p>` : ''}`;
  }

  /** A viagem que interessa ao meu ponto: a primeira que ainda vai passar por ele; senão a que passou por último. */
  function viagemDoPonto(d, ordem) {
    let prox = null;
    let passou = null;
    for (const v of d.viagens) {
      const p = v.pontos.find((x) => x.ordem === ordem);
      if (!p) continue;
      if (p.estimado && (!prox || ms(p.estimado) < ms(prox.p.estimado))) prox = { v, p };
      if (p.passou && (!passou || ms(p.passou) > ms(passou.p.passou))) passou = { v, p };
    }
    return { prox, passou };
  }

  function htmlLinha(d) {
    if (d.estado === 'linha_desligada') return `<div class="ac-estado">${chip('erro', 'Sem viagens')}</div><p class="ac-dica">Esta linha não está rodando no momento.</p>`;
    const pontos = d.linha.pontos;
    if (meuPonto && !pontos.some((p) => p.ordem === meuPonto)) meuPonto = null;
    let estado = '';
    if (d.estado === 'ao_vivo') {
      const v = d.viagens[0];
      estado = `${chip('vivo', d.viagens.length > 1 ? `${d.viagens.length} viagens rodando` : 'Em viagem')}<span class="ac-sub">${v.inicioReal ? `saiu às ${H(hhmm(v.inicioReal))}` : ''}</span>`;
    } else if (d.estado === 'aguardando') {
      estado = `${chip('espera', d.proxima.atrasada ? 'Saída atrasada' : 'Aguardando a saída')}<span class="ac-sub">saída prevista ${H(quando(d.proxima.inicio))}</span>`;
    } else {
      estado = `${chip('', 'Nenhuma viagem agora')}<span class="ac-sub">${d.proxima ? `próxima ${H(quando(d.proxima.inicio))}` : 'sem horários nos próximos dias'}</span>`;
    }
    const opcoes = `<option value="">Escolha o seu ponto</option>${pontos.map((p) => `<option value="${p.ordem}"${p.ordem === meuPonto ? ' selected' : ''}>${H(p.nome)}</option>`).join('')}`;
    let eta = '<p class="ac-dica">Escolha o seu ponto para ver quando o veículo chega.</p>';
    if (meuPonto) {
      const { prox, passou } = viagemDoPonto(d, meuPonto);
      if (prox) {
        const m = minutosAte(prox.p.estimado);
        eta = `<div class="ac-eta"><b>${m <= 1 ? 'Chegando' : `~${m} min`}</b><span>previsão ${H(hhmm(prox.p.estimado))}${prox.v.veiculo ? ` · ${H(prox.v.veiculo)}` : ''}</span></div>`;
      } else if (passou) {
        eta = `<div class="ac-eta passou"><b>Já passou às ${H(hhmm(passou.p.passou))}</b></div>`;
      } else if (d.estado === 'aguardando' || d.proxima) {
        eta = `<p class="ac-dica">O veículo ainda não saiu. A hora no seu ponto aparece quando a viagem começar.</p>`;
      }
    }
    return `<div class="ac-estado">${estado}</div>
      <div class="ac-meu">
        <label>Meu ponto<select id="ac-ponto">${opcoes}</select></label>
        ${eta}
        ${meuPonto ? htmlAviso(d) : ''}
      </div>
      ${htmlPontos(d)}`;
  }

  function htmlAviso(d) {
    if (!d.avisos || !d.avisos.disponivel || !podePush) {
      return ehIPhone && !instalado && d.avisos && d.avisos.disponivel
        ? '<p class="ac-dica">Para receber o aviso no iPhone: toque em <b>Compartilhar</b> › <b>Adicionar à Tela de Início</b> e abra o acompanhamento por lá.</p>'
        : '';
    }
    if (ehIPhone && !instalado) return '<p class="ac-dica">Para receber o aviso no iPhone: toque em <b>Compartilhar</b> › <b>Adicionar à Tela de Início</b> e abra o acompanhamento por lá.</p>';
    const meu = d.meuAviso;
    const msg = avisoMsg ? `<div class="ac-${avisoMsg.tipo}">${H(avisoMsg.texto)}</div>` : '';
    if (meu) {
      const nome = (d.linha.pontos.find((p) => p.ordem === meu.ponto) || {}).nome || '';
      return `${msg || `<div class="ac-ok">Aviso ligado: quando faltar ~${meu.minutos} min para o ponto ${H(nome)}.</div>`}
        <div class="ac-aviso"><button class="ac-btn sec" type="button" id="ac-aviso-sair"${avisoOcupado ? ' disabled' : ''}>Desligar o aviso</button>
        ${meu.ponto !== meuPonto || meu.minutos !== minutosAviso ? `<button class="ac-btn" type="button" id="ac-aviso-ligar"${avisoOcupado ? ' disabled' : ''}>Mudar para este ponto</button>` : ''}</div>`;
    }
    return `${msg}<div class="ac-aviso">
        <button class="ac-btn" type="button" id="ac-aviso-ligar"${avisoOcupado ? ' disabled' : ''}>${SINO} Avisar quando estiver chegando</button>
        <select id="ac-minutos" aria-label="Com quantos minutos avisar">${[2, 5, 10, 15, 20, 30].map((m) => `<option value="${m}"${m === minutosAviso ? ' selected' : ''}>${m} min antes</option>`).join('')}</select>
      </div>`;
  }

  function htmlPontos(d) {
    const v = meuPonto ? (viagemDoPonto(d, meuPonto).prox || {}).v || d.viagens[0] : d.viagens[0];
    const cor = H(d.linha.cor);
    const linhas = d.linha.pontos.map((p) => {
      const x = v ? v.pontos.find((q) => q.ordem === p.ordem) : null;
      let hora = '';
      let cls = '';
      if (x && x.passou) { cls = 'passou'; hora = `${hhmm(x.passou)}<small>passou</small>`; } else if (x && x.pulado) { cls = 'pulado'; hora = '<small>não passou</small>'; } else if (x && x.estimado) hora = `${hhmm(x.estimado)}<small>previsão</small>`;
      return `<li class="${cls}${p.ordem === meuPonto ? ' meu' : ''}" style="--c:${cor}"><div class="ac-pt"><span class="ac-pt-nome">${H(p.nome)}</span><span class="ac-pt-hora">${hora}</span></div></li>`;
    }).join('');
    return `<div><p class="ac-sec-tit">${v ? `Viagem das ${H(hhmm(v.inicioPrevisto))}${v.veiculo ? ` · ${H(v.veiculo)}` : ''}` : 'Pontos da linha'}</p><ol class="ac-pts">${linhas}</ol></div>`;
  }

  function ligarControles() {
    const sel = $('#ac-ponto');
    if (sel) sel.addEventListener('change', () => { meuPonto = Number(sel.value) || null; guardado.gravar('ponto', meuPonto); avisoMsg = null; desenhar(); });
    const mins = $('#ac-minutos');
    if (mins) mins.addEventListener('change', () => { minutosAviso = Number(mins.value) || 5; guardado.gravar('minutos', minutosAviso); });
    const ligar = $('#ac-aviso-ligar');
    if (ligar) ligar.addEventListener('click', ligarAviso);
    const sair = $('#ac-aviso-sair');
    if (sair) sair.addEventListener('click', desligarAviso);
  }

  /* ---------- aviso "está chegando" (Web Push) ---------- */

  function chaveBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function inscricao() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(dados.avisos.chavePublica) });
    return sub;
  }

  async function ligarAviso() {
    if (!meuPonto) return;
    avisoOcupado = true;
    avisoMsg = null;
    desenhar();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('O navegador não deixou mostrar avisos. Libere as notificações deste site e tente de novo.');
      const sub = (await inscricao()).toJSON();
      const r = await fetch(`${API}/aviso`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, ponto: meuPonto, minutos: minutosAviso }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
      endpoint = sub.endpoint;
      dados.meuAviso = { ponto: j.ponto, minutos: j.minutos };
      const nome = (dados.linha.pontos.find((p) => p.ordem === j.ponto) || {}).nome || '';
      avisoMsg = { tipo: 'ok', texto: `Pronto: você recebe um aviso quando faltar ~${j.minutos} min para o ponto ${nome}.` };
    } catch (e) {
      avisoMsg = { tipo: 'erro', texto: e.message || 'Não foi possível ligar o aviso.' };
    } finally {
      avisoOcupado = false;
      desenhar();
    }
  }

  async function desligarAviso() {
    avisoOcupado = true;
    desenhar();
    try {
      await fetch(`${API}/aviso/sair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
      dados.meuAviso = null;
      avisoMsg = { tipo: 'ok', texto: 'Aviso desligado.' };
    } catch {
      avisoMsg = { tipo: 'erro', texto: 'Sem conexão: tente de novo.' };
    } finally {
      avisoOcupado = false;
      desenhar();
    }
  }

  /** Inscrição que este navegador já tem (para mostrar se o aviso está ligado). */
  async function verInscricao() {
    if (!podePush) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) endpoint = sub.endpoint;
    } catch { /* sem service worker */ }
  }

  /* ---------- mapa ---------- */

  function criarMapa() {
    if (!window.L) return;
    mapa = L.map('ac-mapa', { zoomControl: true, attributionControl: true }).setView([-15.8, -47.9], 4);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(mapa);
    let falhas = 0;
    osm.on('tileerror', () => {
      if (++falhas !== 6) return;
      mapa.removeLayer(osm);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Mapa &copy; Esri' }).addTo(mapa);
    });
    camadaLinha = L.layerGroup().addTo(mapa);
    camadaVeic = L.layerGroup().addTo(mapa);
    mapa.on('dragstart', () => { seguir = false; if (dados) $('#ac-centro').hidden = !posicoes().length; });
    $('#ac-centro').addEventListener('click', () => { seguir = true; centralizar(); $('#ac-centro').hidden = true; });
  }

  function posicoes() {
    if (!dados) return [];
    if (dados.tipo === 'veiculo') return dados.posicao ? [{ ...dados.posicao, veiculo: dados.veiculo, tipoVeiculo: dados.tipoVeiculo }] : [];
    return (dados.viagens || []).filter((v) => v.posicao).map((v) => ({ ...v.posicao, veiculo: v.veiculo, tipoVeiculo: v.tipoVeiculo }));
  }

  function centralizar() {
    const ps = posicoes();
    if (!mapa || !ps.length) return;
    if (ps.length === 1) mapa.setView([ps[0].lat, ps[0].lng], Math.max(mapa.getZoom(), 15), { animate: true });
    else mapa.fitBounds(ps.map((p) => [p.lat, p.lng]), { padding: [50, 50], maxZoom: 16 });
  }

  let linhaDesenhada = '';
  function desenharMapa() {
    if (!mapa) return;
    const d = dados;
    const cor = d.linha ? d.linha.cor : '#2563EB';
    // a linha (percurso e pontos) muda pouco: só redesenha quando o ponto escolhido muda
    const chave = d.linha ? `${meuPonto}|${d.linha.pontos.length}` : '';
    if (d.linha && chave !== linhaDesenhada) {
      linhaDesenhada = chave;
      camadaLinha.clearLayers();
      const pts = d.linha.pontos.map((p) => [p.lat, p.lng]);
      if (d.linha.percurso) L.polyline(d.linha.percurso, { color: cor, weight: 5, opacity: 0.7, interactive: false }).addTo(camadaLinha);
      else if (pts.length > 1) L.polyline(pts, { color: cor, weight: 3, opacity: 0.6, dashArray: '6 7', interactive: false }).addTo(camadaLinha);
      for (const p of d.linha.pontos) {
        const meu = p.ordem === meuPonto;
        L.marker([p.lat, p.lng], {
          keyboard: false, zIndexOffset: meu ? 500 : 0,
          icon: L.divIcon({ className: '', html: `<div class="ac-ponto${meu ? ' meu' : ''}" style="--c:${H(cor)}"></div>`, iconSize: meu ? [20, 20] : [12, 12], iconAnchor: meu ? [10, 10] : [6, 6] }),
        }).bindTooltip(H(p.nome), { direction: 'top', offset: [0, -8], permanent: meu }).addTo(camadaLinha);
      }
    }
    camadaVeic.clearLayers();
    const ps = posicoes();
    for (const p of ps) {
      const parado = !(p.vel > 3) || p.dir === null;
      L.marker([p.lat, p.lng], {
        keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({
          className: '', iconSize: [40, 40], iconAnchor: [20, 20],
          html: `<div class="ac-veic${parado ? ' parado' : ''}${p.online ? '' : ' sem-sinal'}" style="--c:${H(cor)}"><div class="ac-seta" style="transform:rotate(${Number(p.dir) || 0}deg)"></div><div class="ac-veic-c">${ONIBUS}</div></div>`,
        }),
      }).bindTooltip(H(p.veiculo || 'Veículo'), { direction: 'top', offset: [0, -18] }).addTo(camadaVeic);
    }
    if (!enquadrado) {
      const tudo = [...ps.map((p) => [p.lat, p.lng]), ...(d.linha ? d.linha.pontos.map((p) => [p.lat, p.lng]) : [])];
      if (tudo.length === 1) { mapa.setView(tudo[0], 15); enquadrado = true; } else if (tudo.length) { mapa.fitBounds(tudo, { padding: [36, 36], maxZoom: 16 }); enquadrado = true; }
    } else if (seguir && d.tipo === 'veiculo' && ps.length) {
      const c = mapa.getBounds().pad(-0.2);
      if (!c.contains([ps[0].lat, ps[0].lng])) mapa.panTo([ps[0].lat, ps[0].lng]);
    }
  }

  /* ---------- começar ---------- */

  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) { invalido(); return; }
  criarMapa();
  verInscricao().finally(carregar);
})();
