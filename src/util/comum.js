'use strict';
/**
 * FrotaGest — utilitários: horário de Brasília, erros HTTP e validação do que chega das telas.
 * Reis Tecnologia
 */

/* ---------- horário ---------- */

let FUSO_MIN = -180; // minutos em relação ao UTC (Brasília = -180)

function definirFuso(min) {
  if (Number.isInteger(min) && min >= -720 && min <= 840) FUSO_MIN = min;
}

const p2 = (n) => String(n).padStart(2, '0');

/** ms → 'AAAA-MM-DD hh:mm:ss' no fuso do sistema. */
function formatar(ms = Date.now()) {
  const d = new Date(ms + FUSO_MIN * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

const agora = () => formatar(Date.now());

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** 'AAAA-MM-DD hh:mm:ss' num fuso qualquer (minutos) → ms. */
function paraMs(texto, fusoMin = FUSO_MIN) {
  const m = RE_DATA.exec(String(texto || ''));
  if (!m) return NaN;
  const [, a, me, d, h, mi, s] = m.map(Number);
  if (me < 1 || me > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  return Date.UTC(a, me - 1, d, h, mi, s) - fusoMin * 60000;
}

/**
 * Hora informada pelo aparelho (no fuso configurado no perfil) → hora do sistema.
 * Hora ausente, inválida, anterior a 2020 ou mais de 1 dia no futuro: usa a hora de chegada.
 */
function horaDoAparelho(texto, fusoAparelhoMin, recebidoMs = Date.now()) {
  const ms = paraMs(texto, Number.isInteger(fusoAparelhoMin) ? fusoAparelhoMin : FUSO_MIN);
  if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1) || ms > recebidoMs + 86400000) return { texto: formatar(recebidoMs), ajustada: true };
  return { texto: formatar(ms), ajustada: false };
}

/* ---------- erros ---------- */

class HttpErro extends Error {
  /** extra: dados a mais para a tela (ex.: { empresa } no cadastro pendente) */
  constructor(status, mensagem, codigo, extra) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo || null;
    this.extra = extra || null;
  }
}

/** Código de acesso da empresa: 8 letras/números sem os que se confundem (0/O, 1/I/L). */
function gerarCodigo(tamanho = 8) {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const crypto = require('crypto');
  let s = '';
  for (let i = 0; i < tamanho; i++) s += alfabeto[crypto.randomInt(alfabeto.length)];
  return s;
}

/* ---------- validação ---------- */

function vazio(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function texto(v, nome, { max = 255, obrigatorio = false, min = 0 } = {}) {
  if (vazio(v)) {
    if (obrigatorio) throw new HttpErro(400, `Preencha ${nome}.`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpErro(400, `${cap(nome)} inválido.`);
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpErro(400, `${cap(nome)} pode ter no máximo ${max} caracteres.`);
  if (s.length < min) throw new HttpErro(400, `${cap(nome)} precisa ter pelo menos ${min} caracteres.`);
  return s;
}

function email(v, nome = 'o e-mail', obrigatorio = true) {
  const s = texto(v, nome, { max: 160, obrigatorio });
  if (s === null) return null;
  const e = s.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpErro(400, `${cap(nome)} não é válido.`);
  return e;
}

function inteiro(v, nome, { min = -2147483648, max = 2147483647, obrigatorio = false } = {}) {
  if (vazio(v)) {
    if (obrigatorio) throw new HttpErro(400, `Informe ${nome}.`);
    return null;
  }
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpErro(400, `${cap(nome)} inválido.`);
  return n;
}

function id(v, nome = 'o registro', obrigatorio = true) {
  return inteiro(v, nome, { min: 1, max: 4294967295, obrigatorio });
}

function booleano(v, padrao = false) {
  if (v === undefined || v === null || v === '') return padrao;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true' || v === 'sim') return true;
  if (v === 0 || v === '0' || v === 'false' || v === 'nao' || v === 'não') return false;
  throw new HttpErro(400, 'Valor sim/não inválido.');
}

function opcao(v, lista, nome, padrao = undefined) {
  if (vazio(v) && padrao !== undefined) return padrao;
  if (typeof v !== 'string' || !lista.includes(v)) throw new HttpErro(400, `${cap(nome)} inválido.`);
  return v;
}

/** Placa antiga (ABC1234) ou Mercosul (ABC1D23); guarda sem hífen, em maiúsculas. */
function placa(v) {
  const s = texto(v, 'a placa', { max: 10, obrigatorio: true }).toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(s)) throw new HttpErro(400, 'Placa inválida (use o formato ABC1234 ou ABC1D23).');
  return s;
}

/** Número do aparelho (terminal) como o DVR informa: só dígitos, sem zeros à esquerda. */
function identificador(v) {
  const s = texto(v, 'o número do aparelho', { max: 20, obrigatorio: true }).replace(/\s/g, '');
  if (!/^\d{1,20}$/.test(s)) throw new HttpErro(400, 'O número do aparelho deve ter só dígitos (até 20).');
  return s.replace(/^0+/, '') || '0';
}

function dataHora(v, nome) {
  const s = texto(v, nome, { max: 19, obrigatorio: true });
  if (!Number.isFinite(paraMs(s))) throw new HttpErro(400, `${cap(nome)} inválida (use AAAA-MM-DD hh:mm:ss).`);
  return s;
}

function documento(v) {
  const s = texto(v, 'o CNPJ/CPF', { max: 20 });
  if (s === null) return null;
  const d = s.replace(/\D/g, '');
  if (d.length !== 11 && d.length !== 14) throw new HttpErro(400, 'CNPJ/CPF deve ter 11 ou 14 dígitos.');
  return d;
}

function cap(s) {
  const t = String(s).replace(/^(o|a|os|as) /, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

module.exports = {
  definirFuso, formatar, agora, paraMs, horaDoAparelho,
  HttpErro,
  gerarCodigo,
  validar: { vazio, texto, email, inteiro, id, booleano, opcao, placa, identificador, dataHora, documento },
};
