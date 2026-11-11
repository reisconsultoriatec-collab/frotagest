'use strict';
/**
 * FrotaGest — monitoramento de frota em tempo real para DVRs 4G (JT/T 808 + JT/T 1078).
 * Reis Tecnologia
 *
 * Uso: node server.js   (configuração em config.json — veja config.exemplo.json)
 *
 * Banco (MySQL): cadastros, posições, alertas, comunicações e auditoria. Nenhum vídeo vai para o banco:
 * o vídeo ao vivo passa direto do DVR para o navegador, e os downloads de gravação ficam em disco
 * por poucos dias (pasta data/gravacoes), com limite de espaço.
 */
const fs = require('fs');
const path = require('path');
const { Gateway808 } = require('./src/protocolo/gateway808');
const { Media1078 } = require('./src/protocolo/media1078');
const { Recorder } = require('./src/video/recorder');
const { TranscoderManager } = require('./src/video/transcoder');
const { Banco } = require('./src/banco/db');
const { Frota } = require('./src/servicos/frota');
const { Historico } = require('./src/servicos/historico');
const { Monitor } = require('./src/servicos/monitor');
const { Cercas } = require('./src/servicos/cercas');
const { Regras } = require('./src/servicos/regras');
const { Avisos } = require('./src/servicos/avisos');
const { Fotos } = require('./src/servicos/fotos');
const { Motoristas } = require('./src/servicos/motoristas');
const { Configuracoes } = require('./src/servicos/configuracoes');
const { Auditoria } = require('./src/servicos/auditoria');
const { Retencao } = require('./src/servicos/retencao');
const { Firebase } = require('./src/auth/firebase');
const { Acesso, permite } = require('./src/auth/acesso');
const { DoisFatores } = require('./src/auth/dois-fatores');
const { Servidor } = require('./src/web/servidor');
const apiCadastros = require('./src/web/api-cadastros');
const apiOperacao = require('./src/web/api-operacao');
const apiConta = require('./src/web/api-conta');
const apiRelatorios = require('./src/web/api-relatorios');
const apiSaude = require('./src/web/api-saude');
const apiCercas = require('./src/web/api-cercas');
const apiOnline = require('./src/web/api-online');
const apiAcessos = require('./src/web/api-acessos');
const apiDoisFatores = require('./src/web/api-2fa');
const { Relatorios } = require('./src/relatorios/relatorios');
const { Logotipos } = require('./src/servicos/logotipos');
const { Painel } = require('./src/servicos/painel');
const apiPainel = require('./src/web/api-painel');
const apiRegras = require('./src/web/api-regras');
const apiAvisos = require('./src/web/api-avisos');
const apiComandos = require('./src/web/api-comandos');
const apiMotoristas = require('./src/web/api-motoristas');
const { definirFuso, gerarCodigo } = require('./src/util/comum');
const { version } = require('./package.json');

const ROOT = __dirname;
const DATA = process.env.FROTAGEST_DADOS || path.join(ROOT, 'data');
const LOGS = path.join(DATA, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const DEFAULTS = {
  banco: { host: '127.0.0.1', porta: 3306, usuario: 'frotagest', senha: '', nome: 'frotagest', conexoes: 10, fusoMinutos: -180 },
  firebase: { projectId: '', apiKey: '', authDomain: '' },
  gateway: { host: '0.0.0.0', idleTimeoutSec: 300, maxConnections: 1000, requireAuth: false, acceptUnknownAuthCode: true },
  media: { host: '0.0.0.0', publicHost: '', maxConnections: 300, autoStopSec: 20, converterH265: true, maxConversoes: 6, maxKbpsConversao: 1000 },
  web: { host: '127.0.0.1', port: 8080, allowedHosts: [], publicUrl: '' },
  gravacoes: { maxGB: 5, retencaoDias: 7, ffmpeg: 'ffmpeg', tipoMidia: 2, tipoFluxo: 0, armazenamento: 0, esperaVideoSeg: 90 },
  logs: { diasArquivo: 14 },
};

function loadConfig() {
  const file = process.env.FROTAGEST_CONFIG || path.join(ROOT, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      console.error(`config.json inválido: ${e.message}`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(file, `${JSON.stringify({ ...DEFAULTS, proprietarios: [] }, null, 2)}\n`, { mode: 0o600 });
    console.log(`Criei ${file} com os valores padrão. Preencha "banco" e "firebase" e rode de novo.`);
  }
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  cfg.proprietarios = Array.isArray(user.proprietarios) ? user.proprietarios : [];
  return cfg;
}

const cfg = loadConfig();
definirFuso(Number(cfg.banco.fusoMinutos ?? -180));

/* ---------- log do servidor ---------- */

const ring = []; // avisos do servidor (conexões, erros)
const mensagens = []; // mensagens do protocolo (para o log ao vivo do master)
let logFile = null;
let logDay = null;
let srv = null;

function writeFileLog(entry) {
  const day = new Date(entry.at).toISOString().slice(0, 10);
  if (day !== logDay) {
    logDay = day;
    if (logFile) logFile.end();
    logFile = fs.createWriteStream(path.join(LOGS, `frotagest-${day}.jsonl`), { flags: 'a' });
    limparLogs();
  }
  logFile.write(`${JSON.stringify(entry)}\n`);
}

function limparLogs() {
  const limite = Date.now() - (Number(cfg.logs.diasArquivo) || 14) * 86400000;
  for (const f of fs.readdirSync(LOGS)) {
    const m = /^frotagest-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(m[1]) < limite) fs.rm(path.join(LOGS, f), () => {});
  }
}

function log(level, text, extra = {}) {
  const e = { kind: 'log', at: Date.now(), source: 'servidor', level, text, ...extra };
  registrarLog(e);
}

function registrarLog(e) {
  ring.push(e);
  if (ring.length > 1000) ring.splice(0, ring.length - 1000);
  writeFileLog(e);
  const time = new Date(e.at).toLocaleTimeString('pt-BR');
  const tag = { ok: '✔', info: '·', aviso: '!', erro: '✖' }[e.level] || '·';
  console.log(`${time} ${tag} ${e.text}`);
  if (srv) srv.enviarLog(e);
}

function registrarMensagem(m) {
  const e = { kind: 'message', ...m };
  mensagens.push(e);
  if (mensagens.length > 2000) mensagens.splice(0, mensagens.length - 2000);
  if (srv) srv.enviarLog(e);
}

/* ---------- início ---------- */

async function conectarBanco(banco) {
  for (let i = 1; ; i++) {
    try {
      await banco.conectar();
      return;
    } catch (e) {
      if (i >= 30) {
        console.error(`\nNão foi possível conectar ao MySQL em ${cfg.banco.host}:${cfg.banco.porta}: ${e.message}`);
        console.error('Confira o contêiner do banco (sudo docker ps) e a seção "banco" do config.json.\n');
        process.exit(1);
      }
      if (i === 1) log('aviso', `Aguardando o MySQL (${e.code || e.message})...`);
      await banco.fechar();
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}

async function main() {
  const banco = new Banco(cfg.banco, (level, text) => log(level, text));
  await conectarBanco(banco);
  const aplicadas = await banco.migrar();
  if (aplicadas.length) log('ok', `Banco atualizado: ${aplicadas.join(', ')}`);

  // toda empresa precisa de um código para a equipe criar a conta
  for (const e of await banco.query('SELECT id FROM empresas WHERE codigo_convite IS NULL')) {
    for (let t = 0; t < 5; t++) {
      try { await banco.query('UPDATE empresas SET codigo_convite = ? WHERE id = ?', [gerarCodigo(), e.id]); break; } catch (err) { if (err.code !== 'ER_DUP_ENTRY') throw err; }
    }
  }

  const config = new Configuracoes(banco);
  await config.carregar();
  const frota = new Frota(banco, config, { publicHost: cfg.media.publicHost });
  await frota.carregar();
  const historico = new Historico(banco, frota, (level, text) => log(level, text));
  await historico.iniciar();
  const cercas = new Cercas({ banco, frota, historico, log: (level, text) => log(level, text) });
  await cercas.carregar();
  frota.on('recarregada', () => cercas.recalcular());
  const auditoria = new Auditoria(banco, (level, text) => log(level, text));
  const retencao = new Retencao(banco, config, (level, text) => log(level, text));

  const gateway = new Gateway808(cfg.gateway, DATA);
  gateway.playbackParams = { tipoMidia: cfg.gravacoes.tipoMidia, tipoFluxo: cfg.gravacoes.tipoFluxo, armazenamento: cfg.gravacoes.armazenamento };
  gateway.autorizar = (id) => frota.autorizar(id);
  const media = new Media1078(cfg.media);
  const midiaPara = (id) => frota.midiaPara(id, (gateway.devices.get(id) || {}).port || null);
  const recorder = new Recorder(cfg.gravacoes, DATA, gateway, media, midiaPara);
  const transcoders = new TranscoderManager(cfg.media, media, cfg.gravacoes.ffmpeg);
  const motoristas = new Motoristas({ banco, frota, log: (level, text) => log(level, text) });
  await motoristas.carregar();
  historico.motoristaDe = (veiculoId) => motoristas.atual(veiculoId);
  const monitor = new Monitor({ frota, gateway, historico, cercas, motoristas });
  const regras = new Regras({ banco, frota, historico, cercas, gateway, motoristas, log: (level, text) => log(level, text) });
  await regras.carregar();
  frota.on('recarregada', () => regras.frotaMudou());
  const fbOpcoes = { publicUrl: cfg.web.publicUrl };
  // só para testes automatizados (certificados e API de contas simulados)
  if (process.env.FROTAGEST_TESTE_CERTS) fbOpcoes.buscarCertificados = async () => ({ certs: JSON.parse(fs.readFileSync(process.env.FROTAGEST_TESTE_CERTS, 'utf8')), validadeSeg: 60 });
  if (process.env.FROTAGEST_TESTE_IDT) fbOpcoes.idtBase = process.env.FROTAGEST_TESTE_IDT;
  const firebase = new Firebase(cfg.firebase, fbOpcoes);
  const acesso = new Acesso({ banco, firebase, frota, proprietarios: cfg.proprietarios, log: (level, text) => log(level, text) });
  await acesso.carregarEncerradas();
  const avisos = new Avisos({
    banco, frota, acesso, publicUrl: cfg.web.publicUrl, log: (level, text) => log(level, text),
    hostsTeste: process.env.FROTAGEST_TESTE_PUSH ? String(process.env.FROTAGEST_TESTE_PUSH).split(',') : [],
  });
  await avisos.iniciar();
  const doisFatores = new DoisFatores({ banco, config, dados: DATA, log: (level, text) => log(level, text) });
  await doisFatores.carregar();

  srv = new Servidor({
    cfg: cfg.web, versao: version, gateway, media, mediaCfg: cfg.media, recorder, transcoders, frota, historico, monitor, acesso,
    firebase, banco, config, auditoria, retencao, logs: ring, mensagens, iniciadoEm: Date.now(), cercas, doisFatores, logotipos: new Logotipos(banco),
    relatorios: new Relatorios({ banco, frota, acesso, cercas, motoristas }),
    painel: new Painel({ banco, frota, regras, log: (level, text) => log(level, text) }),
    regras,
    avisos,
    fotos: new Fotos({ banco, frota, config, dados: DATA, log: (level, text) => log(level, text) }),
    motoristas,
  });
  apiOperacao.registrar(srv);
  apiConta.registrar(srv);
  apiCadastros.registrar(srv);
  apiRelatorios.registrar(srv);
  apiSaude.registrar(srv);
  apiCercas.registrar(srv);
  apiOnline.registrar(srv);
  apiAcessos.registrar(srv);
  apiPainel.registrar(srv);
  apiRegras.registrar(srv);
  apiAvisos.registrar(srv);
  apiComandos.registrar(srv);
  apiMotoristas.registrar(srv);
  apiDoisFatores.registrar(srv);
  srv.onLog = (e) => log(e.level, e.text, { source: 'painel' });

  // atualizações do mapa: junta várias posições do mesmo aparelho (ex.: lote de área sem sinal) num envio só
  const pendentesEnvio = new Map();
  const agendarItem = (id) => {
    if (pendentesEnvio.has(id)) return;
    pendentesEnvio.set(id, setTimeout(() => {
      pendentesEnvio.delete(id);
      srv.enviarItem(monitor.porIdent(id));
    }, 300));
  };

  gateway.on('log', (e) => registrarLog({ kind: 'log', ...e }));
  media.on('log', (e) => registrarLog({ kind: 'log', ...e }));
  transcoders.on('log', (e) => registrarLog({ kind: 'log', at: Date.now(), source: '1078', ...e }));
  gateway.on('message', (m) => {
    registrarMensagem(m);
    if (m.dir === 'in') historico.contato(m.id);
  });
  gateway.on('online', (d) => {
    historico.evento(d.id, 'conectou', { ip: d.ip, porta: d.port, detalhe: d.protocolo });
    historico.conexao(d.id, true, { ip: d.ip, protocolo: d.protocolo });
    regras.conexao(d.id, true);
    if (!frota.porIdent.has(d.id)) historico.pendente(d.id, { ip: d.ip, porta: d.port, protocolo: d.protocolo });
    agendarItem(d.id);
  });
  gateway.on('offline', (d) => {
    historico.evento(d.id, 'desconectou', { ip: d.ip, porta: d.port, detalhe: d.motivo });
    historico.conexao(d.id, false);
    regras.conexao(d.id, false);
    agendarItem(d.id);
  });
  gateway.on('recusado', (d) => {
    historico.evento(d.id, 'recusado', { ip: d.ip, porta: d.port, detalhe: d.motivo });
    if (!frota.porIdent.has(d.id)) historico.pendente(d.id, { ip: d.ip, porta: d.port });
  });
  gateway.on('registro', (d) => {
    const r = d.registro || {};
    historico.evento(d.id, 'registro', { ip: d.ip, porta: d.port, detalhe: [r.manufacturer, r.model, r.plate && `placa ${r.plate}`].filter(Boolean).join(' · ') });
    if (!frota.porIdent.has(d.id)) historico.pendente(d.id, { ip: d.ip, porta: d.port, registro: r });
  });
  gateway.on('autenticacao', (d) => {
    historico.evento(d.id, d.ok ? 'autenticou' : 'autenticacao_recusada', { detalhe: [d.nota, d.imei && `IMEI ${d.imei}`, d.firmware && `firmware ${d.firmware}`].filter(Boolean).join(' · ') });
  });
  gateway.on('position', ({ id, position }) => {
    const r = historico.posicao(id, position, position.receivedAt);
    try { cercas.posicao(id, position, r); } catch (e) { log('erro', `Cercas: ${e.message}`); }
    try { regras.posicao(id, position, r); } catch (e) { log('erro', `Regras de alerta: ${e.message}`); }
    agendarItem(id);
  });
  // entrou/saiu de cerca: as telas abertas na lista de cercas e no modo TV atualizam a ocupação
  cercas.on('evento', (ev) => srv.enviarCerca(ev));
  gateway.on('commandSent', (c) => historico.comando(c));
  // cartão do motorista passado no DVR: quem está dirigindo
  gateway.on('motorista', (d) => {
    motoristas.cartao(frota.info(d.id), d).catch((e) => log('erro', `Cartão do motorista (${d.id}): ${e.message}`));
  });
  // trocou o motorista de algum veículo: mapa e telas abertas
  motoristas.on('mudou', (ids) => {
    for (const id of ids) { const it = monitor.porVeiculo(id); if (it) srv.enviarItem(it); }
    srv.paraTodos({ type: 'motoristas' }, (u) => permite(u, 'motoristas') || permite(u, 'mapa'));
  });
  motoristas.on('cartaoDesconhecido', (c) => srv.paraTodos({ type: 'motoristas' }, (u) => permite(u, 'motoristas') && (u.perfil === 'master' || u.empresaId === c.empresaId)));
  // foto que chegou das câmeras (pedida no painel ou mandada pelo aparelho): disco + registro, e avisa as telas
  gateway.on('midia', (md) => {
    srv.fotos.salvar(md).then((f) => { if (f) srv.enviarFoto(f); }).catch((e) => log('erro', `Foto do aparelho ${md.id}: ${e.message}`));
  });
  gateway.on('command', (c) => historico.resposta(c));
  media.on('stream', (s) => srv.enviarStream(s));
  historico.on('alerta', (ev) => {
    srv.enviarAlerta(ev);
    avisos.alerta(ev);
    if (ev.alerta && ev.alerta.ident) agendarItem(ev.alerta.ident);
  });
  recorder.on('job', (j) => {
    srv.enviarDownload(j);
    if (j.status === 'pronto' || j.status === 'erro') log(j.status === 'pronto' ? 'ok' : 'erro', j.status === 'pronto' ? `Download pronto: ${j.name}${j.note ? ` (${j.note})` : ''}` : `Download falhou (${j.deviceId}): ${j.note}`);
  });

  const { sinalizacao, video } = frota.portas();
  const r1 = await gateway.sincronizarPortas(sinalizacao);
  const r2 = await media.sincronizarPortas(video);
  try {
    await srv.start();
  } catch (e) {
    console.error(`\nNão foi possível abrir o painel na porta ${cfg.web.port}: ${e.message}\n`);
    process.exit(1);
  }
  retencao.iniciar();
  srv.painel.iniciar();
  regras.iniciar();
  srv.fotos.iniciar();
  limparLogs();

  let saindo = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (saindo) return;
      saindo = true;
      log('info', 'Encerrando: gravando o que falta no banco...');
      await historico.parar().catch(() => {});
      await banco.fechar();
      process.exit(0);
    });
  }

  const fb = firebase.configurado ? `projeto ${cfg.firebase.projectId}` : 'NÃO CONFIGURADO (preencha "firebase" no config.json)';
  const portaTxt = (r) => r.map((x) => (x.ok ? `${x.porta}` : `${x.porta} (falhou: ${x.erro})`)).join(', ') || 'nenhuma';
  console.log('');
  console.log(`  FrotaGest ${version} · Reis Tecnologia`);
  console.log('  ───────────────────────────────────────────────');
  console.log(`  Banco:              MySQL ${cfg.banco.host}:${cfg.banco.porta}/${cfg.banco.nome}`);
  console.log(`  Login:              Firebase — ${fb}`);
  console.log(`  DVRs (sinalização): porta(s) ${portaTxt(r1)}`);
  console.log(`  Vídeo:              porta(s) ${portaTxt(r2)}`);
  console.log(`  Cadastros:          ${frota.empresas.size} empresa(s), ${frota.veiculos.size} veículo(s), ${frota.aparelhos.size} aparelho(s), ${cercas.lista.size} cerca(s), ${regras.lista.size} regra(s) de alerta`);
  console.log(`  Painel:             http://${cfg.web.host === '0.0.0.0' ? '127.0.0.1' : cfg.web.host}:${cfg.web.port}${cfg.web.publicUrl ? `  ·  ${cfg.web.publicUrl}` : ''}`);
  console.log(`  Vídeo H.265:        ${transcoders.enabled ? 'convertido para H.264 no servidor' : `enviado direto ao navegador (${transcoders.reason || 'conversão desligada'})`}`);
  if (!cfg.proprietarios.length) console.log('  Aviso: nenhum e-mail em "proprietarios" no config.json — ninguém entra como master.');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'leaflet'))) console.log('  Aviso: rode "npm install" para o mapa e o player funcionarem.');
  console.log('  ───────────────────────────────────────────────\n');
}

main().catch((e) => {
  console.error(`\nFalha ao iniciar o FrotaGest: ${e.message}\n`);
  process.exit(1);
});
