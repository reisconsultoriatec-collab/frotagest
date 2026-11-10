'use strict';
/**
 * FrotaGest — verificação em duas etapas (Google Authenticator, Microsoft Authenticator, Authy).
 * Depois do e-mail e senha (Firebase), o FrotaGest pede o código de 6 dígitos do aplicativo. O master
 * decide quem precisa: por perfil (Sistema › Configurações) ou por usuário (Cadastros › Usuários).
 *
 * - A chave de cada pessoa fica cifrada no banco (AES-256-GCM); a chave da cifra fica em data/,
 *   fora do banco: um backup do banco sozinho não abre as chaves.
 * - Cada login (aparelho/navegador, pelo auth_time do Firebase) passa uma vez pela segunda etapa e
 *   não pede de novo até sair ou a sessão encerrar.
 * - 10 códigos de recuperação de uso único para quem perder o celular; o master pode zerar a
 *   verificação de alguém, e o dono do servidor pode zerar pela linha de comando (tools/zerar-2fa.js).
 * Reis Tecnologia
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpErro, agora } = require('../util/comum');
const totp = require('./totp');
const qr = require('./qr');

const PERFIS = ['master', 'admin', 'operador', 'visualizador'];
const ALFA_REC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I, que confundem
const N_CODIGOS = 10;
const MAX_ERROS = 6; // erros seguidos...
const JANELA_ERROS_MS = 10 * 60000; // ...em 10 min bloqueiam por 10 min
const GUARDAR_DIAS = 90;

function chaveDoArquivo(arquivo) {
  if (fs.existsSync(arquivo)) {
    const hex = fs.readFileSync(arquivo, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`arquivo de chave inválido: ${arquivo}`);
    return Buffer.from(hex, 'hex');
  }
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(arquivo, `${k.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  return k;
}

const resumo = (usuarioId, codigo) => crypto.createHash('sha256').update(`${usuarioId}:${codigo}`).digest('hex');
const normalizarRec = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class DoisFatores {
  constructor({ banco, config, dados, log = () => {} }) {
    this.banco = banco;
    this.config = config;
    this.arquivoChave = path.join(dados, 'chave-2fa.key');
    this.log = log;
    this.verificadas = new Map(); // `${uid}:${authTime}` → usuario_id
    this.erros = new Map(); // usuario_id → { n, desde, ate }
    this._chave = null;
  }

  async carregar() {
    try {
      await this.banco.query(`DELETE FROM sessoes_2fa WHERE verificado_em < NOW() - INTERVAL ${GUARDAR_DIAS} DAY`);
      const rows = await this.banco.query('SELECT firebase_uid, auth_time, usuario_id FROM sessoes_2fa');
      this.verificadas = new Map(rows.map((r) => [`${r.firebase_uid}:${r.auth_time}`, r.usuario_id]));
    } catch (e) {
      this.log('erro', `Falha ao ler as sessões verificadas em duas etapas: ${e.message}`);
    }
  }

  /* ---------- cifra das chaves ---------- */

  chave() {
    if (!this._chave) this._chave = chaveDoArquivo(this.arquivoChave);
    return this._chave;
  }

  cifrar(texto) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.chave(), iv);
    const corpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), corpo]).toString('base64')}`;
  }

  decifrar(guardado) {
    const m = /^v1:(.+)$/.exec(String(guardado || ''));
    if (!m) throw new Error('chave em formato desconhecido');
    const b = Buffer.from(m[1], 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.chave(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }

  /** A chave do usuário (null se não der para abrir: arquivo de chave trocado ou perdido). */
  segredoDe(guardado) {
    try {
      return this.decifrar(guardado);
    } catch (e) {
      this.log('erro', `Não foi possível abrir a chave de duas etapas (${e.message}). Confira ${this.arquivoChave} ou zere a verificação do usuário.`);
      return null;
    }
  }

  /* ---------- quem precisa ---------- */

  perfisExigidos() {
    return new Set(String(this.config.get('dois_fatores_perfis') || '').split(',').filter((p) => PERFIS.includes(p)));
  }

  exige(u) {
    return Boolean(u.exigir2fa) || this.perfisExigidos().has(u.perfil);
  }

  sessaoVerificada(claims) {
    return this.verificadas.has(`${claims.uid}:${claims.authTime}`);
  }

  /** Antes de liberar qualquer coisa: precisa cadastrar o aplicativo ou digitar o código? (null = liberado) */
  bloqueio(u, claims) {
    if (!this.exige(u) || this.sessaoVerificada(claims)) return null;
    return u.doisFatoresAtivo
      ? { codigo: 'dois_fatores', mensagem: 'Digite o código do aplicativo autenticador para continuar.' }
      : { codigo: 'dois_fatores_cadastro', mensagem: 'Ative a verificação em duas etapas para continuar.' };
  }

  async marcarSessao(claims, usuarioId) {
    const k = `${claims.uid}:${claims.authTime}`;
    this.verificadas.set(k, usuarioId);
    await this.banco.query('INSERT IGNORE INTO sessoes_2fa (firebase_uid, auth_time, usuario_id) VALUES (?)', [[claims.uid, claims.authTime, usuarioId]]);
  }

  /* ---------- tentativas erradas ---------- */

  conferirBloqueio(usuarioId) {
    const e = this.erros.get(usuarioId);
    if (e && e.ate > Date.now()) {
      const min = Math.ceil((e.ate - Date.now()) / 60000);
      throw new HttpErro(429, `Muitos códigos errados seguidos. Aguarde ${min} minuto${min === 1 ? '' : 's'} e tente de novo.`, 'bloqueado_2fa');
    }
  }

  errou(usuarioId) {
    const t = Date.now();
    let e = this.erros.get(usuarioId);
    if (!e || t - e.desde > JANELA_ERROS_MS) e = { n: 0, desde: t, ate: 0 };
    e.n++;
    if (e.n >= MAX_ERROS) { e.ate = t + JANELA_ERROS_MS; e.n = 0; e.desde = t; }
    this.erros.set(usuarioId, e);
    if (this.erros.size > 5000) this.erros.delete(this.erros.keys().next().value);
  }

  /* ---------- cadastro do aplicativo ---------- */

  /** Gera a chave nova (fica pendente até a pessoa confirmar com um código) e o QR Code. */
  async iniciar(u) {
    const row = await this.banco.um('SELECT totp_segredo FROM usuarios WHERE id = ?', [u.id]);
    if (row && row.totp_segredo) throw new HttpErro(409, 'A verificação em duas etapas já está ativa neste usuário.', 'ja_ativa');
    const segredo = totp.novoSegredo();
    await this.banco.query('UPDATE usuarios SET totp_pendente = ? WHERE id = ?', [this.cifrar(segredo), u.id]);
    const endereco = totp.uri({ segredo, conta: u.email });
    return { qr: qr.svg(endereco), chave: totp.chaveLegivel(segredo), conta: u.email, emissor: 'FrotaGest', endereco };
  }

  /** Confere o primeiro código e ativa. Devolve os códigos de recuperação (aparecem uma vez só). */
  async confirmar(u, claims, codigo) {
    this.conferirBloqueio(u.id);
    const row = await this.banco.um('SELECT totp_segredo, totp_pendente FROM usuarios WHERE id = ?', [u.id]);
    if (row && row.totp_segredo) throw new HttpErro(409, 'A verificação em duas etapas já está ativa neste usuário.', 'ja_ativa');
    const segredo = row && row.totp_pendente ? this.segredoDe(row.totp_pendente) : null;
    if (!segredo) throw new HttpErro(409, 'Gere o QR Code de novo e leia com o aplicativo.', 'sem_pendente');
    const passo = totp.conferir(segredo, codigo);
    if (passo === null) {
      this.errou(u.id);
      throw new HttpErro(400, 'Código incorreto. Digite o código que aparece agora no aplicativo (ele muda a cada 30 segundos) e confira se o horário do celular está automático.', 'codigo_incorreto');
    }
    await this.banco.query('UPDATE usuarios SET totp_segredo = totp_pendente, totp_pendente = NULL, totp_ativado_em = ?, totp_ultimo_passo = ? WHERE id = ?', [agora(), passo, u.id]);
    const codigos = await this.novosCodigos(u.id);
    await this.marcarSessao(claims, u.id);
    this.erros.delete(u.id);
    return codigos;
  }

  async novosCodigos(usuarioId) {
    const codigos = Array.from({ length: N_CODIGOS }, () => {
      const s = Array.from(crypto.randomBytes(8), (b) => ALFA_REC[b % ALFA_REC.length]).join('');
      return `${s.slice(0, 4)}-${s.slice(4)}`;
    });
    await this.banco.query('DELETE FROM codigos_recuperacao WHERE usuario_id = ?', [usuarioId]);
    await this.banco.query('INSERT INTO codigos_recuperacao (usuario_id, hash) VALUES ?', [codigos.map((c) => [usuarioId, resumo(usuarioId, normalizarRec(c))])]);
    return codigos;
  }

  /* ---------- no login ---------- */

  /** Código do aplicativo (6 dígitos) ou de recuperação (XXXX-XXXX). Devolve { recuperacao, restantes }. */
  async verificar(u, claims, codigo) {
    this.conferirBloqueio(u.id);
    const bruto = String(codigo || '').trim();
    const digitos = bruto.replace(/\s/g, '');
    if (/^\d{6}$/.test(digitos)) {
      const row = await this.banco.um('SELECT totp_segredo, totp_ultimo_passo FROM usuarios WHERE id = ?', [u.id]);
      const segredo = row && row.totp_segredo ? this.segredoDe(row.totp_segredo) : null;
      if (!segredo) throw new HttpErro(409, 'Não foi possível conferir o código: peça ao master para zerar a sua verificação em duas etapas.', 'sem_chave');
      const passo = totp.conferir(segredo, digitos, row.totp_ultimo_passo);
      if (passo === null) {
        this.errou(u.id);
        throw new HttpErro(400, 'Código incorreto ou já usado. Digite o código que aparece agora no aplicativo.', 'codigo_incorreto');
      }
      // só avança (o mesmo código não serve duas vezes)
      await this.banco.query('UPDATE usuarios SET totp_ultimo_passo = ? WHERE id = ? AND (totp_ultimo_passo IS NULL OR totp_ultimo_passo < ?)', [passo, u.id, passo]);
      await this.marcarSessao(claims, u.id);
      this.erros.delete(u.id);
      return { recuperacao: false };
    }
    const rec = normalizarRec(bruto);
    if (rec.length !== 8) {
      this.errou(u.id);
      throw new HttpErro(400, 'Digite os 6 números do aplicativo ou um código de recuperação (XXXX-XXXX).', 'codigo_incorreto');
    }
    const r = await this.banco.query('UPDATE codigos_recuperacao SET usado_em = ? WHERE usuario_id = ? AND hash = ? AND usado_em IS NULL', [agora(), u.id, resumo(u.id, rec)]);
    if (!r.affectedRows) {
      this.errou(u.id);
      throw new HttpErro(400, 'Código de recuperação incorreto ou já usado.', 'codigo_incorreto');
    }
    await this.marcarSessao(claims, u.id);
    this.erros.delete(u.id);
    const x = await this.banco.um('SELECT COUNT(*) AS n FROM codigos_recuperacao WHERE usuario_id = ? AND usado_em IS NULL', [u.id]);
    return { recuperacao: true, restantes: Number(x.n) || 0 };
  }

  /** Master: apaga o cadastro do aplicativo (a pessoa cadastra de novo no próximo acesso). */
  async zerar(usuarioId) {
    await this.banco.query('UPDATE usuarios SET totp_segredo = NULL, totp_pendente = NULL, totp_ativado_em = NULL, totp_ultimo_passo = NULL WHERE id = ?', [usuarioId]);
    await this.banco.query('DELETE FROM codigos_recuperacao WHERE usuario_id = ?', [usuarioId]);
    await this.banco.query('DELETE FROM sessoes_2fa WHERE usuario_id = ?', [usuarioId]);
    for (const [k, id] of this.verificadas) if (id === usuarioId) this.verificadas.delete(k);
    this.erros.delete(usuarioId);
  }

  async restantes(usuarioId) {
    const x = await this.banco.um('SELECT COUNT(*) AS n FROM codigos_recuperacao WHERE usuario_id = ? AND usado_em IS NULL', [usuarioId]);
    return Number(x.n) || 0;
  }
}

module.exports = { DoisFatores, PERFIS };
