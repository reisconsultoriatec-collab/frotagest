'use strict';
/**
 * FrotaGest — acesso ao MySQL (mysql2) e aplicação automática das migrações.
 * Reis Tecnologia
 *
 * Todas as datas trafegam como texto 'AAAA-MM-DD hh:mm:ss' no horário de Brasília:
 * a sessão do MySQL usa o mesmo fuso e o driver não converte nada (dateStrings).
 */
const fs = require('fs');
const path = require('path');

const MIGRACOES = path.join(__dirname, 'migracoes');

class Banco {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.pool = null;
    this.ok = false;
    this.ultimoErro = null;
  }

  get fusoSql() {
    const m = Number(this.cfg.fusoMinutos ?? -180);
    const s = m < 0 ? '-' : '+';
    const a = Math.abs(m);
    return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }

  async conectar() {
    const mysql = require('mysql2/promise');
    const fuso = this.fusoSql;
    this.pool = mysql.createPool({
      host: this.cfg.host,
      port: this.cfg.porta,
      user: this.cfg.usuario,
      password: this.cfg.senha,
      database: this.cfg.nome,
      connectionLimit: this.cfg.conexoes || 10,
      waitForConnections: true,
      queueLimit: 0,
      dateStrings: true,
      timezone: fuso,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      decimalNumbers: true,
      // objeto vindo da tela nunca vira trecho de SQL ("campo = valor")
      stringifyObjects: true,
      enableKeepAlive: true,
      connectTimeout: 10000,
    });
    // cada conexão nova do pool trabalha no horário de Brasília (NOW(), CURRENT_TIMESTAMP)
    this.pool.pool.on('connection', (c) => c.query(`SET time_zone = '${fuso}'`, () => {}));
    await this.pool.query('SELECT 1');
    this.ok = true;
  }

  marcar(e) {
    const fora = /ECONNREFUSED|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|ECONNRESET|ER_ACCESS_DENIED|ENOTFOUND|POOL_CLOSED/.test(`${e.code} ${e.message}`);
    if (fora) {
      if (this.ok) this.log('erro', `Banco de dados indisponível: ${e.message}`);
      this.ok = false;
      this.ultimoErro = e.message;
    }
    return e;
  }

  async query(sql, params) {
    try {
      const [rows] = await this.pool.query(sql, params);
      if (!this.ok) { this.ok = true; this.log('ok', 'Banco de dados voltou a responder'); }
      return rows;
    } catch (e) {
      throw this.marcar(e);
    }
  }

  async um(sql, params) {
    const r = await this.query(sql, params);
    return r[0] || null;
  }

  async transacao(fn) {
    const c = await this.pool.getConnection().catch((e) => { throw this.marcar(e); });
    const q = {
      query: async (sql, params) => (await c.query(sql, params))[0],
      um: async (sql, params) => (await c.query(sql, params))[0][0] || null,
    };
    try {
      await c.beginTransaction();
      const r = await fn(q);
      await c.commit();
      return r;
    } catch (e) {
      await c.rollback().catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** Aplica as migrações novas (pasta migracoes/, em ordem). Cada uma é escrita para poder rodar de novo. */
  async migrar() {
    await this.query(`CREATE TABLE IF NOT EXISTS migracoes (
      nome VARCHAR(100) NOT NULL PRIMARY KEY,
      aplicada_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const feitas = new Set((await this.query('SELECT nome FROM migracoes')).map((r) => r.nome));
    const arquivos = fs.readdirSync(MIGRACOES).filter((f) => /^\d{3}-[\w-]+\.sql$/.test(f)).sort();
    const aplicadas = [];
    for (const f of arquivos) {
      if (feitas.has(f)) continue;
      const comandos = dividirSql(fs.readFileSync(path.join(MIGRACOES, f), 'utf8'));
      for (const sql of comandos) {
        try {
          await this.query(sql);
        } catch (e) {
          throw new Error(`migração ${f} falhou: ${e.message}\n${sql.slice(0, 300)}`);
        }
      }
      await this.query('INSERT INTO migracoes (nome) VALUES (?)', [f]);
      aplicadas.push(f);
    }
    return aplicadas;
  }

  async fechar() {
    if (this.pool) await this.pool.end().catch(() => {});
  }
}

/** Separa um arquivo .sql em comandos, respeitando textos entre aspas e comentários. */
function dividirSql(texto) {
  const out = [];
  let atual = '';
  let i = 0;
  const n = texto.length;
  while (i < n) {
    const c = texto[i];
    const d = texto[i + 1];
    if (c === '-' && d === '-' && (i + 2 >= n || /\s/.test(texto[i + 2]))) {
      while (i < n && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < n && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const fim = texto.indexOf('*/', i + 2);
      i = fim < 0 ? n : fim + 2;
      atual += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (texto[j] === '\\' && c !== '`') { j += 2; continue; }
        if (texto[j] === c) {
          if (texto[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      atual += texto.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ';') {
      if (atual.trim()) out.push(atual.trim());
      atual = '';
      i++;
      continue;
    }
    atual += c;
    i++;
  }
  if (atual.trim()) out.push(atual.trim());
  return out;
}

module.exports = { Banco, dividirSql };
