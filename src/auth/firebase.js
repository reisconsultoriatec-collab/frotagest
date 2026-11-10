'use strict';
/**
 * FrotaGest — Firebase Authentication sem o firebase-admin:
 *  - confere o token de login (JWT RS256) com os certificados públicos do Google;
 *  - cria a conta de quem é convidado e envia o e-mail para a pessoa criar a senha (API REST, com a chave web).
 * Assim o servidor não precisa guardar chave de conta de serviço.
 * Reis Tecnologia
 */
const crypto = require('crypto');
const { HttpErro } = require('../util/comum');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const FOLGA_SEG = 300; // diferença de relógio tolerada

class Firebase {
  constructor(cfg = {}, opcoes = {}) {
    this.projectId = cfg.projectId || '';
    this.apiKey = cfg.apiKey || '';
    this.authDomain = cfg.authDomain || (this.projectId ? `${this.projectId}.firebaseapp.com` : '');
    this.publicUrl = opcoes.publicUrl || '';
    this.certs = null; // kid → KeyObject
    this.certsAte = 0;
    this.ultimaBusca = 0;
    // nos testes, os certificados vêm de outra fonte
    this.buscarCertificados = opcoes.buscarCertificados || buscarCertificadosGoogle;
    this.fetch = opcoes.fetch || ((...a) => fetch(...a));
    this.idtBase = opcoes.idtBase || IDT;
  }

  get configurado() {
    return Boolean(this.projectId && this.apiKey);
  }

  configPublica() {
    if (!this.configurado) return null;
    return { apiKey: this.apiKey, authDomain: this.authDomain, projectId: this.projectId };
  }

  async chave(kid) {
    const agora = Date.now();
    if (!this.certs || agora > this.certsAte || (!this.certs.has(kid) && agora - this.ultimaBusca > 60000)) {
      this.ultimaBusca = agora;
      const { certs, validadeSeg } = await this.buscarCertificados();
      this.certs = new Map(Object.entries(certs).map(([k, pem]) => [k, crypto.createPublicKey(pem)]));
      this.certsAte = agora + Math.max(60, Math.min(validadeSeg || 3600, 86400)) * 1000;
    }
    return this.certs.get(kid) || null;
  }

  /** Confere o token de login. Retorna { uid, email, emailVerificado, nome } ou lança erro. */
  async verificar(token) {
    if (!this.configurado) throw new Error('Firebase não configurado no servidor');
    if (typeof token !== 'string' || token.length > 4096) throw new Error('token inválido');
    const partes = token.split('.');
    if (partes.length !== 3) throw new Error('token malformado');
    let cab;
    let dados;
    try {
      cab = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
      dados = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    } catch {
      throw new Error('token malformado');
    }
    if (cab.alg !== 'RS256' || typeof cab.kid !== 'string') throw new Error('algoritmo do token não aceito');
    const chave = await this.chave(cab.kid);
    if (!chave) throw new Error('certificado do token desconhecido');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${partes[0]}.${partes[1]}`), chave, Buffer.from(partes[2], 'base64url'));
    if (!ok) throw new Error('assinatura do token inválida');
    const agora = Math.floor(Date.now() / 1000);
    if (dados.aud !== this.projectId) throw new Error('token de outro projeto');
    if (dados.iss !== `https://securetoken.google.com/${this.projectId}`) throw new Error('emissor do token inválido');
    if (typeof dados.sub !== 'string' || !dados.sub || dados.sub.length > 128) throw new Error('token sem usuário');
    if (!Number.isFinite(dados.exp) || dados.exp <= agora) throw new Error('token expirado');
    if (!Number.isFinite(dados.iat) || dados.iat > agora + FOLGA_SEG) throw new Error('token emitido no futuro');
    if (Number.isFinite(dados.auth_time) && dados.auth_time > agora + FOLGA_SEG) throw new Error('login no futuro');
    return {
      uid: dados.sub,
      email: String(dados.email || '').toLowerCase(),
      emailVerificado: dados.email_verified === true,
      nome: dados.name || '',
      // hora do login (fica igual quando o token é renovado): identifica a sessão deste aparelho
      authTime: Number.isFinite(dados.auth_time) ? dados.auth_time : dados.iat,
    };
  }

  async rest(metodo, corpo) {
    const headers = { 'Content-Type': 'application/json' };
    // se a chave web tiver restrição por site, as chamadas do servidor se apresentam pelo domínio do painel
    if (this.publicUrl) headers.Referer = `${this.publicUrl.replace(/\/+$/, '')}/`;
    const r = await this.fetch(`${this.idtBase}/${metodo}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST', headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
      const e = new Error(msg);
      e.firebase = String(msg).split(' ')[0];
      throw e;
    }
    return j;
  }

  /**
   * Cria a conta no Firebase com senha aleatória (ninguém a conhece) e manda o e-mail para a pessoa criar a dela.
   * Se o e-mail já tiver conta no Firebase, só manda o e-mail (o vínculo é feito no primeiro acesso, com e-mail confirmado).
   */
  async convidar(email) {
    if (!this.configurado) throw new HttpErro(503, 'O Firebase ainda não foi configurado no servidor (config.json › firebase).');
    let uid = null;
    let existente = false;
    try {
      const r = await this.rest('accounts:signUp', { email, password: crypto.randomBytes(24).toString('base64url'), returnSecureToken: false });
      uid = r.localId || null;
    } catch (e) {
      if (e.firebase === 'EMAIL_EXISTS') existente = true;
      else throw new HttpErro(502, traduzir(e.firebase, e.message));
    }
    await this.enviarCriacaoSenha(email);
    return { uid, existente };
  }

  async enviarCriacaoSenha(email) {
    const corpo = { requestType: 'PASSWORD_RESET', email };
    if (this.publicUrl) corpo.continueUrl = `${this.publicUrl.replace(/\/+$/, '')}/`;
    try {
      await this.rest('accounts:sendOobCode', corpo);
    } catch (e) {
      // domínio do painel ainda não autorizado no Firebase: manda sem o link de volta
      if (corpo.continueUrl && /UNAUTHORIZED_DOMAIN|INVALID_CONTINUE_URI/.test(e.firebase || '')) {
        delete corpo.continueUrl;
        await this.rest('accounts:sendOobCode', corpo).catch((e2) => { throw new HttpErro(502, traduzir(e2.firebase, e2.message)); });
        return;
      }
      throw new HttpErro(502, traduzir(e.firebase, e.message));
    }
  }
}

function traduzir(codigo, original) {
  const m = {
    OPERATION_NOT_ALLOWED: 'O login por e-mail e senha está desativado no Firebase (Authentication › Sign-in method).',
    ADMIN_ONLY_OPERATION: 'O Firebase não permite criar contas por esta chave (Authentication › Settings › User actions).',
    INVALID_EMAIL: 'E-mail inválido para o Firebase.',
    EMAIL_NOT_FOUND: 'Esse e-mail não tem conta no Firebase.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'O Firebase bloqueou temporariamente por excesso de tentativas. Tente mais tarde.',
    API_KEY_INVALID: 'A chave web (apiKey) do Firebase no config.json está errada.',
    API_KEY_HTTP_REFERRER_BLOCKED: 'A chave web do Firebase tem restrição de site que bloqueia o servidor.',
  };
  return m[codigo] || `Firebase recusou: ${original}`;
}

/** Certificados públicos do Google para os tokens do Firebase, com a validade do cabeçalho Cache-Control. */
async function buscarCertificadosGoogle() {
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`certificados do Google indisponíveis (HTTP ${r.status})`);
  const certs = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  return { certs, validadeSeg: m ? Number(m[1]) : 3600 };
}

module.exports = { Firebase };
