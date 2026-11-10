#!/usr/bin/env node
'use strict';
/**
 * FrotaGest — zera a verificação em duas etapas de um usuário pela linha de comando do servidor.
 * Para quando o próprio master perdeu o celular e os códigos de recuperação (ou o arquivo
 * data/chave-2fa.key foi perdido). No próximo acesso a pessoa cadastra o aplicativo de novo.
 *
 * Uso (na pasta do FrotaGest):  node tools/zerar-2fa.js email@exemplo.com
 * Reis Tecnologia
 */
const fs = require('fs');
const path = require('path');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Uso: node tools/zerar-2fa.js email@do.usuario');
  process.exit(1);
}

const arquivo = process.env.FROTAGEST_CONFIG || path.join(__dirname, '..', 'config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
} catch (e) {
  console.error(`Não consegui ler ${arquivo}: ${e.message}`);
  process.exit(1);
}
const b = { host: '127.0.0.1', porta: 3306, usuario: 'frotagest', senha: '', nome: 'frotagest', ...(cfg.banco || {}) };

(async () => {
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection({ host: b.host, port: b.porta, user: b.usuario, password: b.senha, database: b.nome });
  const [[u]] = await c.query('SELECT id, nome, totp_segredo FROM usuarios WHERE email = ?', [email]);
  if (!u) {
    console.error(`Nenhum usuário com o e-mail ${email}.`);
    process.exit(1);
  }
  await c.query('UPDATE usuarios SET totp_segredo = NULL, totp_pendente = NULL, totp_ativado_em = NULL, totp_ultimo_passo = NULL WHERE id = ?', [u.id]);
  await c.query('DELETE FROM codigos_recuperacao WHERE usuario_id = ?', [u.id]);
  await c.query('DELETE FROM sessoes_2fa WHERE usuario_id = ?', [u.id]);
  await c.query("INSERT INTO auditoria (data_hora, usuario_id, empresa_id, acao, entidade, entidade_id, descricao, ip) VALUES (NOW(), NULL, NULL, '2fa_zerada', 'usuario', ?, ?, 'servidor')",
    [String(u.id), `verificação em duas etapas de ${u.nome} <${email}> zerada pela linha de comando do servidor`]);
  await c.end();
  console.log(`Pronto: a verificação em duas etapas de ${u.nome} (${email}) foi zerada.`);
  console.log('Reinicie o FrotaGest (pm2 restart frotagest) e, no próximo acesso, a pessoa cadastra o aplicativo de novo.');
})().catch((e) => {
  console.error(`Falha: ${e.message}`);
  process.exit(1);
});
