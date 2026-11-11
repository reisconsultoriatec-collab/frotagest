'use strict';
/**
 * FrotaGest — servidor web: painel, API (rotas em api-*.js) e WebSockets (eventos, vídeo e log).
 * Login pelo Firebase; cada usuário só recebe o que pode ver (empresa e grupos).
 * Reis Tecnologia
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ws = require('./ws');
const { normalizeId } = require('../protocolo/jt808');
const { HttpErro } = require('../util/comum');
const { permite, exigirAcesso } = require('../auth/acesso');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
const TICKET_MS = 5 * 60 * 1000; // link de download: vale 5 minutos
const WS_TICKET_MS = 60 * 1000; // bilhete para abrir conexão em tempo real: uso único, 1 minuto
const FAIL_MAX = 30; // logins/tokens inválidos permitidos por IP...
const FAIL_WINDOW_MS = 10 * 60 * 1000; // ...nesta janela
const BLOCK_MS = 15 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp',
};

/** Só os arquivos listados aqui são servidos — nenhum caminho vindo da URL chega ao disco. */
function montarEstaticos() {
  const m = {
    '/': path.join(PUBLIC, 'index.html'),
    '/termos': path.join(PUBLIC, 'termos.html'),
    '/privacidade': path.join(PUBLIC, 'privacidade.html'),
    // aplicativo instalável (celular e computador): manifesto e service worker na raiz (escopo do site todo)
    '/manifest.webmanifest': path.join(PUBLIC, 'manifest.webmanifest'),
    '/sw.js': path.join(PUBLIC, 'sw.js'),
    '/favicon.ico': path.join(PUBLIC, 'img', 'icone-32.png'),
    '/vendor/leaflet.js': path.join(MODULES, 'leaflet', 'dist', 'leaflet.js'),
    '/vendor/leaflet.css': path.join(MODULES, 'leaflet', 'dist', 'leaflet.css'),
    '/vendor/jmuxer.min.js': path.join(MODULES, 'jmuxer', 'dist', 'jmuxer.min.js'),
  };
  for (const img of ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
    m[`/vendor/images/${img}`] = path.join(MODULES, 'leaflet', 'dist', 'images', img);
  }
  for (const [pasta, re] of [['css', /^[\w-]+\.css$/], ['js', /^[\w-]+\.js$/], ['fonts', /^[\w-]+\.woff2?$/], ['img', /^[\w-]+\.(png|svg|ico|webp)$/]]) {
    let arquivos = [];
    try { arquivos = fs.readdirSync(path.join(PUBLIC, pasta)); } catch { /* pasta opcional */ }
    for (const f of arquivos) if (re.test(f)) m[`/${pasta}/${f}`] = path.join(PUBLIC, pasta, f);
  }
  return m;
}

class Servidor {
  constructor(ctx) {
    Object.assign(this, ctx); // cfg, versao, gateway, media, recorder, transcoders, frota, historico, monitor, acesso, firebase, banco, config, auditoria, retencao, logs, mensagens
    this.estaticos = montarEstaticos();
    this.eventos = new Set(); // conexões /ws/eventos (cada uma com conn.u)
    this.logConns = new Set(); // conexões /ws/log (master)
    this.stopTimers = new Map();
    this.tickets = new Map(); // link de download → { jobId, until, usuarioId }
    this.wsTickets = new Map(); // bilhete → { u, until }
    this.playbackSerials = new Map();
    this.fails = new Map();
    this.rotas = [];
    this.onLog = null;
    const publicos = (this.cfg.allowedHosts || []).map((h) => String(h).toLowerCase());
    this.publicHosts = publicos;
    this.allowedHosts = new Set([`127.0.0.1:${this.cfg.port}`, `localhost:${this.cfg.port}`, `[::1]:${this.cfg.port}`, ...publicos]);
    this.csp = this.montarCsp();
    this.gateway.on('command', (c) => {
      if (c.msgId !== 0x9201) return;
      const key = this.playbackSerials.get(`${c.id}:${c.replySerial}`);
      if (!key) return;
      this.playbackSerials.delete(`${c.id}:${c.replySerial}`);
      if (c.result !== 0) this.media.notify(key, `O DVR recusou a reprodução (${c.resultName})`);
      else if (c.items === 0) this.media.notify(key, 'O DVR aceitou, mas não listou gravação nesse período');
    });
  }

  montarCsp() {
    const fb = this.firebase.configPublica();
    const wss = this.publicHosts.map((h) => `wss://${h}`).join(' ');
    return [
      "default-src 'self'",
      "script-src 'self' https://www.gstatic.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com https://*.basemaps.cartocdn.com",
      `connect-src 'self' ${wss} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com`.replace(/\s+/g, ' '),
      `frame-src ${fb ? `https://${fb.authDomain}` : "'none'"}`,
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ');
  }

  cabecalhos(extra = {}) {
    return {
      'Content-Security-Policy': this.csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store',
      ...extra,
    };
  }

  log(level, text) {
    if (this.onLog) this.onLog({ level, text });
  }

  start() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 30000;
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
  }

  /* ---------- rotas da API ---------- */

  /** caminho como '/api/empresas/:id'; opcoes: { publica, conta, pode: 'sistema', acesso: 'tela.acao' | [...], limite, livre2fa, corpoMax } */
  rota(metodo, caminho, handler, opcoes = {}) {
    const nomes = [];
    const re = new RegExp(`^${caminho.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; })}$`);
    this.rotas.push({ metodo, re, nomes, handler, ...opcoes });
  }

  /* ---------- segurança ---------- */

  clientIp(req) {
    const r = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (r === '127.0.0.1' || r === '::1') {
      const h = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
      if (h) return String(h).split(',')[0].trim().slice(0, 64);
    }
    return r;
  }

  blocked(ip) {
    const f = this.fails.get(ip);
    return Boolean(f && f.until > Date.now());
  }

  fail(ip) {
    const now = Date.now();
    let f = this.fails.get(ip);
    if (!f || (now - f.first > FAIL_WINDOW_MS && f.until < now)) f = { n: 0, first: now, until: 0 };
    f.n++;
    if (f.n >= FAIL_MAX && f.until < now) {
      f.until = now + BLOCK_MS;
      f.n = 0;
      f.first = now;
      this.log('aviso', `Muitas tentativas de acesso inválidas do IP ${ip}: bloqueado por 15 minutos`);
    }
    this.fails.set(ip, f);
    if (this.fails.size > 5000) for (const [k, v] of this.fails) if (v.until < now && now - v.first > FAIL_WINDOW_MS) this.fails.delete(k);
  }

  /** Limite simples por IP para rotas sensíveis: limite = { chave, max, minutos } */
  limitar(ip, { chave, max, minutos }) {
    if (!this.limites) this.limites = new Map();
    const k = `${chave}:${ip}`;
    const agora = Date.now();
    let l = this.limites.get(k);
    if (!l || agora - l.desde > minutos * 60000) l = { desde: agora, n: 0 };
    l.n++;
    this.limites.set(k, l);
    if (this.limites.size > 10000) for (const [x, v] of this.limites) if (agora - v.desde > 3600000) this.limites.delete(x);
    if (l.n > max) throw new HttpErro(429, `Muitas tentativas. Aguarde ${minutos} minutos.`, 'limite');
  }

  hostOk(req) {
    return this.allowedHosts.has(String(req.headers.host || '').toLowerCase());
  }

  originOk(req) {
    const origin = req.headers.origin;
    const host = String(req.headers.host || '').toLowerCase();
    if (origin === `http://${req.headers.host}`) return true;
    return this.publicHosts.includes(host) && origin === `https://${host}`;
  }

  /** sessao: { uid, authTime, ip, ua } do login que pediu o bilhete (para a lista de usuários online). */
  newWsTicket(u, sessao = null) {
    const now = Date.now();
    for (const [k, v] of this.wsTickets) if (v.until < now) this.wsTickets.delete(k);
    const t = crypto.randomBytes(18).toString('base64url');
    this.wsTickets.set(t, { u, sessao, until: now + WS_TICKET_MS });
    return t;
  }

  takeWsTicket(t) {
    if (typeof t !== 'string' || !this.wsTickets.has(t)) return null;
    const v = this.wsTickets.get(t);
    this.wsTickets.delete(t);
    return v.until >= Date.now() ? v : null;
  }

  publicUrl() {
    return String(this.cfg.publicUrl || '').replace(/\/+$/, '') || null;
  }

  /* ---------- HTTP ---------- */

  send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, this.cabecalhos({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload), ...extra }));
    res.end(payload);
  }

  onRequest(req, res) {
    if (!this.hostOk(req)) return this.send(res, 421, { erro: 'Host não permitido' });
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return this.send(res, 400, { erro: 'endereço inválido' }); }

    if ((req.method === 'GET' || req.method === 'HEAD') && this.estaticos[url.pathname]) return this.estatico(req, res, this.estaticos[url.pathname]);
    if (req.method === 'GET' && url.pathname.startsWith('/baixar/')) return this.onTicket(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      this.onApi(req, res, url).catch((e) => {
        this.log('erro', `Falha inesperada em ${req.method} ${url.pathname}: ${e.message}`);
        if (!res.headersSent) this.send(res, 500, { erro: 'Erro interno no servidor' });
      });
      return;
    }
    this.send(res, 404, { erro: 'não encontrado' });
  }

  /** Arquivos do painel com ETag (o navegador revalida e só baixa de novo o que mudou). */
  estatico(req, res, arquivo) {
    fs.stat(arquivo, (err, st) => {
      if (err) {
        const vendor = arquivo.startsWith(MODULES);
        return this.send(res, 404, { erro: 'arquivo não encontrado', dica: vendor ? 'rode "npm install" na pasta do FrotaGest' : undefined });
      }
      // a página e o service worker levam a versão dentro: ela entra na etiqueta (atualizar troca a etiqueta)
      const comVersao = arquivo.endsWith('index.html') || arquivo.endsWith(`${path.sep}sw.js`);
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${comVersao ? `-${this.versao}` : ''}"`;
      const tipo = TIPOS[path.extname(arquivo)] || 'application/octet-stream';
      const cache = { 'Cache-Control': 'no-cache', ETag: etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, this.cabecalhos(cache));
        res.end();
        return;
      }
      fs.readFile(arquivo, (e2, data) => {
        if (e2) return this.send(res, 404, { erro: 'arquivo não encontrado' });
        let corpo = data;
        // a versão entra no HTML (arquivos com ?v=) e no service worker (cada versão limpa o que guardou antes)
        if (comVersao) corpo = data.toString('utf8').replace(/__VERSAO__/g, this.versao);
        if (req.method === 'HEAD') {
          res.writeHead(200, this.cabecalhos({ 'Content-Type': tipo, 'Content-Length': Buffer.byteLength(corpo), ...cache }));
          res.end();
          return;
        }
        this.send(res, 200, corpo, tipo, cache);
      });
    });
  }

  readJson(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'HEAD') { resolve({}); return; }
      const ct = String(req.headers['content-type'] || '');
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { reject(new HttpErro(413, 'Dados grandes demais')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) { resolve({}); return; }
        if (!ct.startsWith('application/json')) { reject(new HttpErro(415, 'use application/json')); return; }
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error();
          resolve(j);
        } catch { reject(new HttpErro(400, 'JSON inválido')); }
      });
      req.on('error', reject);
    });
  }

  async onApi(req, res, url) {
    const ip = this.clientIp(req);
    const p = url.pathname;
    let rota = null;
    let params = {};
    for (const r of this.rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      rota = r;
      params = Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      break;
    }
    if (!rota) return this.send(res, 404, { erro: 'rota não encontrada' });

    let u = null;
    let claims = null;
    try {
      if (rota.limite) this.limitar(ip, rota.limite);
      if (rota.conta) {
        // cadastro: basta o login do Firebase (o usuário ainda não existe no FrotaGest)
        if (this.blocked(ip)) throw new HttpErro(429, 'Muitas tentativas inválidas; aguarde 15 minutos.');
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
        if (!m) throw new HttpErro(401, 'Entre com seu login para continuar.', 'sem_token');
        try {
          claims = await this.acesso.claims(m[1].trim());
        } catch (e) {
          this.fail(ip);
          throw e;
        }
      } else if (!rota.publica) {
        if (this.blocked(ip)) throw new HttpErro(429, 'Muitas tentativas inválidas; aguarde 15 minutos.');
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
        if (!m) throw new HttpErro(401, 'Entre com seu login para continuar.', 'sem_token');
        try {
          claims = await this.acesso.claims(m[1].trim());
          u = await this.acesso.doClaims(claims);
        } catch (e) {
          // sessão encerrada pelo administrador não conta como tentativa inválida (o painel sai sozinho)
          if (e.status === 401 && e.codigo !== 'sessao_encerrada') this.fail(ip);
          throw e;
        }
        // verificação em duas etapas: até digitar o código do aplicativo, só as rotas da própria verificação
        if (!rota.livre2fa && this.doisFatores) {
          const b = this.doisFatores.bloqueio(u, claims);
          if (b) throw new HttpErro(403, b.mensagem, b.codigo, { nome: u.nome, email: u.email });
        }
        if (rota.pode && !u.pode[rota.pode]) throw new HttpErro(403, 'Seu perfil não tem acesso a esta função.', 'perfil');
        // controle de acesso: menu e ação liberados para este usuário (basta uma das regras da lista)
        if (rota.acesso) exigirAcesso(u, rota.acesso);
      }
      const body = await this.readJson(req, rota.corpoMax || MAX_BODY);
      const query = Object.fromEntries(url.searchParams.entries());
      const r = await rota.handler({ req, res, u, claims, params, body, query, ip });
      if (!res.headersSent) this.send(res, 200, r === undefined ? { ok: true } : r);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpErro) return this.send(res, e.status, { erro: e.message, codigo: e.codigo || undefined, ...(e.extra || {}) });
      if (e.code === 'ER_DUP_ENTRY') return this.send(res, 409, { erro: duplicado(e.message) });
      if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_ROW_IS_REFERENCED') return this.send(res, 409, { erro: 'Não é possível excluir: há registros ligados a este. Desative em vez de excluir.' });
      if (!this.banco.ok) return this.send(res, 503, { erro: 'Banco de dados indisponível no momento. Tente de novo em instantes.' });
      // erro de operação no aparelho (offline, comando recusado): mensagem própria
      if (e.constructor === Error && !e.code && !e.sql) return this.send(res, 409, { erro: e.message });
      this.log('erro', `Erro em ${req.method} ${p}: ${e.message}`);
      return this.send(res, 500, { erro: 'Erro interno no servidor' });
    }
  }

  /* ---------- downloads (links de uso curto) ---------- */

  novoLinkDownload(job, u) {
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.until < now) this.tickets.delete(t);
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(ticket, { jobId: job.id, until: now + TICKET_MS, usuarioId: u.id });
    return { url: `/baixar/${ticket}`, validoSeg: TICKET_MS / 1000 };
  }

  onTicket(req, res, url) {
    const ip = this.clientIp(req);
    if (this.blocked(ip)) return this.send(res, 429, { erro: 'muitas tentativas; aguarde 15 minutos' });
    const m = /^\/baixar\/([A-Za-z0-9_-]{24})$/.exec(url.pathname);
    const t = m && this.tickets.get(m[1]);
    if (!t || t.until < Date.now()) {
      if (t) this.tickets.delete(m[1]);
      else this.fail(ip);
      return this.send(res, 404, { erro: 'link de download expirado; clique em Salvar de novo no painel' });
    }
    const job = this.recorder.get(t.jobId);
    if (!job) return this.send(res, 404, { erro: 'download não encontrado' });
    return this.sendFile(req, res, job);
  }

  sendFile(req, res, job) {
    if (job.status !== 'pronto') return this.send(res, 409, { erro: 'o arquivo ainda não está pronto' });
    const file = this.recorder.filePath(job);
    fs.stat(file, (err, st) => {
      if (err) return this.send(res, 404, { erro: 'arquivo não encontrado no servidor' });
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(Number(range[2]), end);
        } else start = Math.max(0, st.size - Number(range[2]));
        if (start > end || start >= st.size) {
          res.writeHead(416, this.cabecalhos({ 'Content-Range': `bytes */${st.size}` }));
          res.end();
          return;
        }
        status = 206;
      }
      res.writeHead(status, this.cabecalhos({
        'Content-Type': job.file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${job.name.replace(/[^\w.-]/g, '_')}"`,
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
      }));
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
    });
  }

  /* ---------- WebSockets ---------- */

  onUpgrade(req, socket) {
    socket.on('error', () => {});
    if (!this.hostOk(req) || !this.originOk(req)) return ws.reject(socket, 403, 'Forbidden');
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return ws.reject(socket, 400, 'Bad Request'); }
    const ip = this.clientIp(req);
    if (this.blocked(ip)) return ws.reject(socket, 429, 'Too Many Requests');
    const bilhete = this.takeWsTicket(url.searchParams.get('k'));
    const u = bilhete ? bilhete.u : null;
    if (!u) {
      this.fail(ip);
      return ws.reject(socket, 401, 'Unauthorized');
    }

    if (url.pathname === '/ws/eventos') {
      const conn = ws.accept(req, socket);
      if (!conn) return;
      conn.u = u;
      const s = bilhete.sessao || {};
      conn.sessao = {
        id: crypto.randomBytes(9).toString('base64url'), uid: s.uid || u.uid, authTime: s.authTime || 0, ip: s.ip || ip,
        ua: String(s.ua || req.headers['user-agent'] || '').slice(0, 300), desde: Date.now(), ativoEm: Date.now(), tela: null, tv: false,
      };
      this.eventos.add(conn);
      conn.on('close', () => this.eventos.delete(conn));
      conn.on('message', (txt) => this.mensagemDoPainel(conn, txt));
      conn.sendJson({ type: 'ola', versao: this.versao, streams: this.streamsVisiveis(u), downloads: this.downloadsVisiveis(u), conexao: conn.sessao.id });
      return;
    }

    if (url.pathname === '/ws/log') {
      if (u.perfil !== 'master') return ws.reject(socket, 403, 'Forbidden');
      const conn = ws.accept(req, socket);
      if (!conn) return;
      conn.u = u;
      conn.filtro = url.searchParams.get('id') ? normalizeId(url.searchParams.get('id')) : null;
      this.logConns.add(conn);
      conn.on('close', () => this.logConns.delete(conn));
      const recentes = this.mensagens.filter((e) => !conn.filtro || e.id === conn.filtro).slice(-300);
      conn.sendJson({ type: 'recentes', entradas: recentes });
      return;
    }

    if (url.pathname === '/ws/video' && url.searchParams.has('pb')) {
      const key = url.searchParams.get('pb');
      const st = /^pb\d{1,9}$/.test(key || '') && this.media.streams.get(key);
      if (!st || st.kind !== 'playback') return ws.reject(socket, 404, 'Not Found');
      if (!u.pode.gravacoes || !this.acesso.aparelhoVisivel(u, st.id)) return ws.reject(socket, 403, 'Forbidden');
      const conn = ws.accept(req, socket);
      if (!conn) return;
      this.watchPlayback(conn, st, url.searchParams.get('conv') !== '0');
      return;
    }

    if (url.pathname === '/ws/video') {
      const id = url.searchParams.get('id');
      const channel = Number(url.searchParams.get('canal'));
      if (!/^\d{1,20}$/.test(id || '') || !Number.isInteger(channel) || channel < 1 || channel > 32) return ws.reject(socket, 400, 'Bad Request');
      const nid = normalizeId(id);
      if (!u.pode.video || !this.acesso.aparelhoVisivel(u, nid)) return ws.reject(socket, 403, 'Forbidden');
      const conn = ws.accept(req, socket);
      if (!conn) return;
      this.watch(conn, nid, channel, url.searchParams.get('conv') !== '0');
      return;
    }
    ws.reject(socket, 404, 'Not Found');
  }

  viewerFor(conn, id, channel) {
    let waitingKey = true;
    return {
      onEnd: () => conn.sendJson({ type: 'fim' }),
      onError: (text) => conn.sendJson({ type: 'erro', text }),
      onInfo: (info) => {
        waitingKey = true;
        conn.sendJson({ type: 'info', codec: info.codec, pt: info.pt, converted: info.source === 'H265', id, channel });
      },
      onFrame: (f, s) => {
        if (!s.codec) return;
        if (waitingKey) {
          if (!f.isKey) return;
          waitingKey = false;
        }
        if (conn.bufferedAmount > 4 * 1024 * 1024) { waitingKey = true; return; }
        const head = Buffer.alloc(6);
        head[0] = 1;
        head[1] = s.codec === 'H265' ? 2 : 1;
        head.writeUInt32BE(f.duration, 2);
        conn.send(Buffer.concat([head, f.data]));
      },
    };
  }

  /** Liga o navegador a um fluxo; H.265 é convertido para H.264 no servidor quando possível. */
  attachViewer(conn, source, wantConvert) {
    const out = this.viewerFor(conn, source.id, source.channel);
    let tc = null;
    let failed = false;
    let needInfo = false;
    const convert = (codec) => codec === 'H265' && wantConvert && this.transcoders && this.transcoders.enabled && !failed;
    const fallback = (text) => {
      failed = true;
      tc = null;
      needInfo = true;
      out.onError(`${text}. Tentando exibir o H.265 direto no navegador.`);
    };
    const ensure = () => {
      if (failed || (tc && !tc.ended)) return;
      try {
        tc = this.transcoders.attach(source, { ...out, onError: fallback });
      } catch (e) {
        fallback(e.message);
      }
    };
    const bridge = {
      onEnd: (st) => out.onEnd(st),
      onError: (text) => out.onError(text),
      onInfo: (info) => { if (convert(info.codec)) ensure(); else out.onInfo(info); },
      onFrame: (f, st) => {
        if (convert(st.codec)) { ensure(); return; }
        if (needInfo) { needInfo = false; out.onInfo(st.info()); }
        out.onFrame(f, st);
      },
    };
    this.media.subscribeKey(source.key, bridge);
    if (source.error) out.onError(source.error);
    return () => {
      this.media.unsubscribeKey(source.key, bridge);
      if (tc && !tc.ended) tc.removeViewerByBase(out);
      const st = this.media.streams.get(source.key);
      return st ? st.subs.size : 0;
    };
  }

  watchPlayback(conn, st, wantConvert) {
    const detach = this.attachViewer(conn, st, wantConvert);
    conn.on('close', () => {
      const left = detach();
      if (left > 0) return;
      setTimeout(() => {
        if (st.subs.size > 0) return;
        if (st.live) { try { this.gateway.controlPlayback(st.id, { channel: st.channel, control: 2 }); } catch { /* offline */ } }
        this.media.release(st.key);
      }, 5000);
    });
  }

  watch(conn, id, channel, wantConvert) {
    const key = `${id}:${channel}`;
    clearTimeout(this.stopTimers.get(key));
    this.stopTimers.delete(key);
    const source = this.media.getStream(id, channel);
    const detach = this.attachViewer(conn, source, wantConvert);
    conn.on('close', () => {
      const left = detach();
      if (left > 0 || !this.mediaCfg.autoStopSec) return;
      // ninguém mais assistindo: encerra a transmissão no aparelho para economizar o chip 4G
      const t = setTimeout(() => {
        this.stopTimers.delete(key);
        const s = this.media.streams.get(key);
        if (s && s.subs.size === 0) {
          try { this.gateway.stopVideo(id, channel); } catch { /* aparelho já offline */ }
        }
      }, this.mediaCfg.autoStopSec * 1000);
      this.stopTimers.set(key, t);
    });
  }

  /** O painel avisa em que tela está e quando houve uso (para a lista de usuários online). */
  mensagemDoPainel(conn, txt) {
    if (typeof txt !== 'string' || txt.length > 500) return;
    let m;
    try { m = JSON.parse(txt); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const s = conn.sessao;
    if (m.type === 'tela') {
      if (typeof m.tela === 'string' && /^[a-z]{1,30}$/.test(m.tela)) s.tela = m.tela;
      s.tv = m.tela === 'tv';
      s.ativoEm = Date.now();
    } else if (m.type === 'uso') {
      s.ativoEm = Date.now();
    }
  }

  /** Fecha as conexões em tempo real de um login (depois de encerrado por um administrador). */
  derrubarSessao(uid, authTime) {
    let n = 0;
    for (const c of this.eventos) {
      if (!c.sessao || c.sessao.uid !== uid || c.sessao.authTime !== authTime) continue;
      n++;
      c.sendJson({ type: 'sessao_encerrada' });
      setTimeout(() => { try { c.close(); } catch { /* já fechou */ } }, 300);
    }
    return n;
  }

  /** A regra das duas etapas mudou: quem ainda não passou pela segunda etapa perde o tempo real na hora
   * (o painel reconecta e, se precisar, pede o código; quem não precisa nem percebe). */
  revalidarSegundaEtapa() {
    if (!this.doisFatores) return;
    for (const c of this.eventos) {
      if (!c.sessao || this.doisFatores.sessaoVerificada({ uid: c.sessao.uid, authTime: c.sessao.authTime })) continue;
      try { c.close(); } catch { /* já fechou */ }
    }
  }

  /* ---------- envio de eventos (cada usuário só recebe o que pode ver) ---------- */

  paraTodos(obj, filtro) {
    if (!this.eventos.size) return;
    const text = JSON.stringify(obj);
    for (const c of this.eventos) {
      if (filtro && !filtro(c.u)) continue;
      if (c.bufferedAmount < 2 * 1024 * 1024) c.send(text);
    }
  }

  enviarItem(item) {
    if (!item) return;
    this.paraTodos({ type: 'item', item }, (u) => this.acesso.veItem(u, item));
  }

  enviarAlerta(ev) {
    const a = ev.alerta;
    this.paraTodos({ type: 'alerta', acao: ev.acao, alerta: a }, (u) => {
      if (u.perfil === 'master') return true;
      if (!permite(u, 'alertas')) return false;
      if (a.empresaId !== u.empresaId) return false;
      if (a.veiculoId) return this.acesso.veVeiculo(u, this.frota.veiculos.get(a.veiculoId));
      return u.perfil === 'admin';
    });
  }

  /** Veículo entrou ou saiu de uma cerca (a ocupação das telas abertas acompanha). */
  enviarCerca(ev) {
    const v = ev.info.veiculo;
    this.paraTodos({
      type: 'cerca',
      evento: { cercaId: ev.cerca.id, tipo: ev.tipo, chave: `a${ev.info.aparelho.id}`, veiculoId: v ? v.id : null, dataHora: ev.dataHora },
    }, (u) => v && this.acesso.veVeiculo(u, v));
  }

  enviarStream(info) {
    this.paraTodos({ type: 'stream', stream: info }, (u) => this.acesso.aparelhoVisivel(u, info.id));
  }

  enviarDownload(job) {
    this.paraTodos({ type: 'download', download: job }, (u) => this.downloadVisivel(u, job));
  }

  /** Avisa quem cuida dos usuários da empresa (e o master) que chegou cadastro para aprovar. */
  avisarPendentes(empresaId) {
    this.paraTodos({ type: 'pendentes' }, (u) => u.perfil === 'master' || (u.empresaId === empresaId && permite(u, 'usuarios')));
  }

  /** O cadastro ou o acesso de um usuário mudou: as conexões abertas dele passam a filtrar pelo que vale
   * agora, e o painel dele recarrega o menu (sai da tela que perdeu). */
  async atualizarUsuario(usuarioId, avisar = true) {
    this.acesso.invalidar();
    if (this.avisos) this.avisos.esquecer(usuarioId);
    for (const c of this.eventos) {
      if (!c.u || c.u.id !== usuarioId || !c.sessao) continue;
      try {
        c.u = await this.acesso.doClaims({ uid: c.sessao.uid, authTime: c.sessao.authTime });
        if (avisar) c.sendJson({ type: 'acessos' });
      } catch {
        // desativado, empresa desativada etc.: o painel tenta reconectar, recebe a recusa e mostra o aviso
        try { c.close(); } catch { /* já fechou */ }
      }
    }
  }

  recarregarFrota() {
    this.paraTodos({ type: 'recarregar' });
  }

  enviarLog(entry) {
    if (!this.logConns.size) return;
    const text = JSON.stringify({ type: 'entrada', entrada: entry });
    for (const c of this.logConns) {
      if (c.filtro && entry.id !== c.filtro) continue;
      if (c.bufferedAmount < 2 * 1024 * 1024) c.send(text);
    }
  }

  streamsVisiveis(u) {
    return this.media.snapshot().filter((s) => this.acesso.aparelhoVisivel(u, s.id));
  }

  downloadVisivel(u, job) {
    if (!job) return false;
    if (u.perfil === 'master') return true;
    if (!u.pode.gravacoes) return false;
    if (job.empresaId !== u.empresaId) return false;
    return this.acesso.aparelhoVisivel(u, job.deviceId);
  }

  downloadsVisiveis(u) {
    if (!u.pode.gravacoes) return [];
    return this.recorder.list().filter((j) => this.downloadVisivel(u, j));
  }
}

function duplicado(msg) {
  if (/uq_aparelhos_identificador/.test(msg)) return 'Já existe um aparelho com esse número.';
  if (/uq_veiculos_placa/.test(msg)) return 'Já existe um veículo com essa placa nesta empresa.';
  if (/uq_veiculos_aparelho/.test(msg)) return 'Esse aparelho já está instalado em outro veículo.';
  if (/uq_usuarios_email/.test(msg)) return 'Já existe um usuário com esse e-mail.';
  if (/uq_empresas_documento/.test(msg)) return 'Já existe uma empresa com esse CNPJ/CPF.';
  if (/uq_perfis_porta/.test(msg)) return 'Já existe um perfil usando essa porta de sinalização.';
  return 'Registro duplicado.';
}

module.exports = { Servidor };
