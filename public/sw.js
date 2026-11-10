/* FrotaGest — service worker do aplicativo (instalável no celular e no computador).
 * Só guarda os arquivos do próprio painel (telas, estilos, ícones), para abrir mais rápido no 4G.
 * Nunca guarda dados: nada de /api, tempo real, vídeo ou downloads passa por aqui.
 * Sem internet, mostra um aviso em vez de uma tela quebrada. Reis Tecnologia */
'use strict';

const VERSAO = 'frotagest-__VERSAO__';
const ARQUIVOS = /^\/(css|js|fonts|img|vendor)\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

const SEM_INTERNET = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FrotaGest · sem conexão</title><meta name="theme-color" content="#1A2744"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0B1324;color:#E7ECF6;font:15px system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="width:64px;height:64px;margin:0 auto 18px;border-radius:16px;background:#F59E0B;display:grid;place-items:center">
<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1A2744" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M16 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 17h-2v-11a1 1 0 0 1 1 -1h14a5 7 0 0 1 5 7v5h-2m-4 0h-8"/><path d="M16 5l1.5 7l4.5 0"/><path d="M2 10l15 0"/><path d="M7 5l0 5"/><path d="M12 5l0 5"/></svg></div>
<h1 style="font-size:21px;margin:0 0 8px">Sem conexão com a internet</h1>
<p style="margin:0 0 20px;color:#A8B3C9;max-width:320px">O FrotaGest mostra a frota ao vivo e precisa de internet. Confira o Wi-Fi ou os dados móveis.</p>
<a href="/" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#F59E0B;color:#1A2744;font-weight:700;text-decoration:none">Tentar de novo</a></div></body></html>`;

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // login do Google e mapas: direto da internet

  // a tela principal: sempre a da internet (versão nova na hora); sem internet, o aviso
  if (req.mode === 'navigate') {
    ev.respondWith(fetch(req).catch(() => new Response(SEM_INTERNET, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }

  // arquivos do painel: os com ?v= nunca mudam (cada versão tem o seu); os outros, atualizados por trás
  if (!ARQUIVOS.test(url.pathname)) return;
  ev.respondWith((async () => {
    const cache = await caches.open(VERSAO);
    const guardado = await cache.match(req);
    const buscar = fetch(req).then((r) => {
      if (r.ok && r.type === 'basic') cache.put(req, r.clone());
      return r;
    });
    if (guardado) {
      if (!url.searchParams.has('v')) ev.waitUntil(buscar.catch(() => {}));
      return guardado;
    }
    return buscar;
  })());
});
