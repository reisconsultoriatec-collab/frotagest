'use strict';
/**
 * FrotaGest — gravação do histórico no MySQL: posições (em lotes), último estado de cada aparelho,
 * alertas (abertura e encerramento pelos bits de alarme), comunicações e comandos.
 * Nada de vídeo passa por aqui.
 * Reis Tecnologia
 */
const { EventEmitter } = require('events');
const J = require('../protocolo/jt808');
const { formatar, agora, horaDoAparelho } = require('../util/comum');

const LOTE = 1000; // linhas por INSERT
const MAX_FILA = 100000; // se o banco ficar fora do ar, guarda até isto em memória
const REABRIR_MS = 120000; // alarme que volta em até 2 min reabre o mesmo alerta (evita alertas repetidos)
const ESTADO_MS = 10000; // último estado gravado a cada 10 s
const RECUSA_MS = 10 * 60000; // recusas do mesmo aparelho: no máximo uma linha a cada 10 min

// Gravidade de cada bit de alarme do JT/T 808 (a = alarme geral, v = alarme de vídeo)
const ALTA = new Set(['a0', 'a8', 'a26', 'a27', 'a28', 'a29', 'a30', 'a31']);
const BAIXA = new Set(['a4', 'a5', 'a6', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14']);

function gravidade(codigo) {
  if (ALTA.has(codigo)) return 'alta';
  if (BAIXA.has(codigo)) return 'baixa';
  return 'media';
}

function nomeAlarme(codigo) {
  const bit = Number(codigo.slice(1));
  if (codigo[0] === 'v') return J.VIDEO_ALARM_BITS[bit] || `Alarme de vídeo (bit ${bit})`;
  return J.ALARM_BITS[bit] || `Alarme (bit ${bit})`;
}

const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
/** Alerta que não vem dos bits de alarme do DVR (cercas: c12e, c12s, c12p). */
const externo = (codigo) => /^c\d/.test(String(codigo));
const limita = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));

class Historico extends EventEmitter {
  constructor(banco, frota, log = () => {}) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.log = log;
    this.fila = []; // posições aguardando o INSERT
    this.eventos = []; // comunicações aguardando o INSERT
    this.estados = new Map(); // aparelho_id → último estado
    this.sujos = new Set();
    this.abertos = new Map(); // aparelho_id → Map(codigo → { id, promessa, nome, inicio })
    this.recentes = new Map(); // `${aparelho}:${codigo}` → { id, em } (encerrados há pouco)
    this.pontuais = new Map(); // `${aparelho}:${codigo}` → quando (alertas de um momento só, das cercas)
    this.comandos = new Map(); // `${ident}:${serial}` → { promessa, em }
    this.recusas = new Map();
    this.descartadas = 0;
    this.gravadas = 0;
    this.gravando = false;
    this.ultimaGravacao = null;
    this.timers = [];
  }

  async iniciar() {
    await this.carregarAbertos();
    const est = await this.banco.query('SELECT * FROM aparelhos_estado');
    for (const e of est) this.estados.set(e.aparelho_id, { ...e, online: 0 });
    this.timers.push(setInterval(() => this.gravar(), 1000));
    this.timers.push(setInterval(() => this.gravarEstados(), ESTADO_MS));
    for (const t of this.timers) t.unref();
  }

  async parar() {
    for (const t of this.timers) clearInterval(t);
    for (const e of this.estados.values()) e.online = 0;
    for (const id of this.estados.keys()) this.sujos.add(id);
    await this.gravar(true).catch(() => {});
    await this.gravarEstados().catch(() => {});
  }

  async carregarAbertos() {
    const rows = await this.banco.query('SELECT id, aparelho_id, codigo, nome, gravidade, inicio FROM alertas WHERE fim IS NULL');
    for (const r of rows) {
      if (!this.abertos.has(r.aparelho_id)) this.abertos.set(r.aparelho_id, new Map());
      this.abertos.get(r.aparelho_id).set(r.codigo, {
        id: r.id, promessa: Promise.resolve(r.id), nome: r.nome, inicio: r.inicio, gravidade: r.gravidade, externo: externo(r.codigo),
      });
    }
  }

  /* ---------- posições ---------- */

  /** Registra uma posição de aparelho cadastrado. Retorna a hora usada (já no horário de Brasília). */
  posicao(ident, p, recebidoMs = Date.now()) {
    const info = this.frota.info(ident);
    if (!info) return null;
    const { aparelho, veiculo, perfil } = info;
    const h = horaDoAparelho(p.time, perfil ? perfil.fuso_minutos : undefined, recebidoMs);
    const gps = Boolean(p.flags && p.flags.gpsFixado) && (Math.abs(p.lat) > 0.0001 || Math.abs(p.lon) > 0.0001);
    const ex = p.extras || {};
    const vel = Math.min(9999.9, Math.max(0, Number(p.speed) || 0));
    this.fila.push([
      aparelho.id, veiculo ? veiculo.id : null, h.texto, formatar(recebidoMs),
      r6(p.lat), r6(p.lon), vel, limita(p.direction, 0, 65535), limita(p.altitude, -32768, 32767),
      p.alarm >>> 0, (ex.alarmeVideo || 0) >>> 0, p.status >>> 0, p.flags && p.flags.ignicao ? 1 : 0, gps ? 1 : 0,
      Number.isInteger(ex.satelites) ? limita(ex.satelites, 0, 255) : null,
      Number.isInteger(ex.sinalRede) ? limita(ex.sinalRede, 0, 255) : null,
      Number.isFinite(ex.odometroKm) ? ex.odometroKm : null,
    ]);
    if (this.fila.length > MAX_FILA) {
      const sobra = this.fila.length - MAX_FILA;
      this.fila.splice(0, sobra);
      this.descartadas += sobra;
    }
    // último estado (só avança: posições antigas de área sem sinal não voltam o mapa no tempo)
    const est = this.estado(aparelho.id);
    if (!est.ultima_posicao_em || h.texto >= est.ultima_posicao_em) {
      Object.assign(est, {
        ultima_posicao_em: h.texto, velocidade: vel, direcao: limita(p.direction, 0, 65535), ignicao: p.flags && p.flags.ignicao ? 1 : 0,
        gps_valido: gps ? 1 : 0,
        satelites: Number.isInteger(ex.satelites) ? ex.satelites : est.satelites,
        sinal: Number.isInteger(ex.sinalRede) ? ex.sinalRede : est.sinal,
        odometro: Number.isFinite(ex.odometroKm) ? ex.odometroKm : est.odometro,
      });
      if (gps) { est.latitude = r6(p.lat); est.longitude = r6(p.lon); }
    }
    est.ultimo_contato = formatar(recebidoMs);
    this.sujos.add(aparelho.id);
    this.alarmes(info, p, h.texto);
    return { dataHora: h.texto, horaAjustada: h.ajustada, gps };
  }

  estado(aparelhoId) {
    let e = this.estados.get(aparelhoId);
    if (!e) {
      e = { aparelho_id: aparelhoId, online: 0, ultimo_contato: null, ultima_posicao_em: null, latitude: null, longitude: null, velocidade: null, direcao: null, ignicao: null, gps_valido: null, satelites: null, sinal: null, odometro: null, ip: null, protocolo: null };
      this.estados.set(aparelhoId, e);
    }
    return e;
  }

  /** Online/offline de um aparelho cadastrado. */
  conexao(ident, online, { ip = null, protocolo = null } = {}) {
    const info = this.frota.info(ident);
    if (!info) return;
    const e = this.estado(info.aparelho.id);
    e.online = online ? 1 : 0;
    e.ultimo_contato = agora();
    if (ip) e.ip = ip;
    if (protocolo) e.protocolo = protocolo;
    this.sujos.add(info.aparelho.id);
  }

  /** Contato de qualquer mensagem (sinal de vida): só atualiza a hora em memória. */
  contato(ident) {
    const ap = this.frota.porIdent.get(ident);
    if (!ap) return;
    const e = this.estados.get(ap.id);
    if (e) e.ultimo_contato = agora();
  }

  /* ---------- alertas ---------- */

  alarmes(info, p, dataHora) {
    const { aparelho } = info;
    const atuais = new Set();
    const a = p.alarm >>> 0;
    for (let b = 0; b < 32; b++) if ((a >>> b) & 1) atuais.add(`a${b}`);
    const v = ((p.extras && p.extras.alarmeVideo) || 0) >>> 0;
    for (let b = 0; b < 32; b++) if ((v >>> b) & 1) atuais.add(`v${b}`);
    let abertos = this.abertos.get(aparelho.id);
    if (!abertos) {
      if (!atuais.size) return;
      abertos = new Map();
      this.abertos.set(aparelho.id, abertos);
    }
    for (const c of atuais) if (!abertos.has(c)) this.abrir(info, c, p, dataHora, abertos);
    // os alertas das cercas não vêm dos bits de alarme: quem abre e fecha é o serviço das cercas
    for (const [c, entry] of abertos) if (!atuais.has(c) && !entry.externo) this.encerrar(info, c, entry, dataHora, abertos);
  }

  /** def: { nome, gravidade } dos alertas que não são bits de alarme do DVR (cercas). */
  abrir(info, codigo, p, dataHora, abertos, def = null) {
    const { aparelho, veiculo, empresa } = info;
    const nome = def ? def.nome : nomeAlarme(codigo);
    const grav = def ? def.gravidade : gravidade(codigo);
    const entry = { id: null, nome, inicio: dataHora, promessa: null, gravidade: grav, externo: Boolean(def) };
    abertos.set(codigo, entry);
    const chave = `${aparelho.id}:${codigo}`;
    const rec = this.recentes.get(chave);
    const base = {
      empresaId: empresa.id, aparelhoId: aparelho.id, veiculoId: veiculo ? veiculo.id : null, ident: aparelho.identificador,
      codigo, nome, gravidade: grav,
    };
    if (rec && Date.now() - rec.em < REABRIR_MS) {
      this.recentes.delete(chave);
      entry.id = rec.id;
      entry.promessa = this.banco.query('UPDATE alertas SET fim = NULL WHERE id = ?', [rec.id]).then(() => {
        this.emit('alerta', { acao: 'reaberto', alerta: { ...base, id: rec.id, fim: null } });
        return rec.id;
      });
    } else {
      const gps = Math.abs(p.lat) > 0.0001 || Math.abs(p.lon) > 0.0001;
      const vel = Math.min(9999.9, Math.max(0, Number(p.speed) || 0));
      entry.promessa = this.banco.query(
        `INSERT INTO alertas (empresa_id, aparelho_id, veiculo_id, codigo, nome, gravidade, inicio, latitude, longitude, velocidade)
         VALUES (?)`,
        [[empresa.id, aparelho.id, veiculo ? veiculo.id : null, codigo, nome, base.gravidade, dataHora, gps ? r6(p.lat) : null, gps ? r6(p.lon) : null, vel]],
      ).then((r) => {
        entry.id = r.insertId;
        this.emit('alerta', {
          acao: 'novo',
          alerta: { ...base, id: r.insertId, inicio: dataHora, fim: null, latitude: gps ? r6(p.lat) : null, longitude: gps ? r6(p.lon) : null, velocidade: vel, situacao: 'novo' },
        });
        return r.insertId;
      });
    }
    // banco fora do ar: esquece a abertura para tentar de novo na próxima posição
    entry.promessa.catch(() => { if (abertos.get(codigo) === entry) abertos.delete(codigo); });
  }

  encerrar(info, codigo, entry, dataHora, abertos) {
    abertos.delete(codigo);
    const { aparelho, veiculo, empresa } = info;
    entry.promessa.then((id) => this.banco.query('UPDATE alertas SET fim = ? WHERE id = ? AND fim IS NULL', [dataHora, id]).then(() => {
      this.recentes.set(`${aparelho.id}:${codigo}`, { id, em: Date.now() });
      if (this.recentes.size > 5000) this.recentes.delete(this.recentes.keys().next().value);
      this.emit('alerta', {
        acao: 'encerrado',
        alerta: { id, empresaId: empresa.id, aparelhoId: aparelho.id, veiculoId: veiculo ? veiculo.id : null, ident: aparelho.identificador, codigo, nome: entry.nome, gravidade: entry.gravidade || gravidade(codigo), fim: dataHora },
      });
    })).catch((e) => this.log('erro', `Falha ao encerrar alerta: ${e.message}`));
  }

  /** Alertas ativos agora (para o mapa), por aparelho. */
  ativos(aparelhoId) {
    const m = this.abertos.get(aparelhoId);
    if (!m || !m.size) return [];
    return [...m.entries()].map(([codigo, e]) => ({ codigo, nome: e.nome, gravidade: e.gravidade || gravidade(codigo), inicio: e.inicio }));
  }

  /* ---------- alertas das cercas ---------- */

  /** Abre um alerta que fica aberto até alguém encerrar (ex.: veículo dentro de área proibida). */
  abrirExterno(info, codigo, { nome, gravidade: grav, dataHora, lat, lng, vel }) {
    let abertos = this.abertos.get(info.aparelho.id);
    if (!abertos) { abertos = new Map(); this.abertos.set(info.aparelho.id, abertos); }
    if (abertos.has(codigo)) return;
    this.abrir(info, codigo, { lat, lon: lng, speed: vel }, dataHora, abertos, { nome: String(nome).slice(0, 80), gravidade: grav });
  }

  encerrarExterno(info, codigo, dataHora) {
    const abertos = this.abertos.get(info.aparelho.id);
    const entry = abertos && abertos.get(codigo);
    if (entry) this.encerrar(info, codigo, entry, dataHora, abertos);
  }

  /** Alerta de um momento só (entrou/saiu da cerca): já nasce com o fim igual ao início. */
  alertaPontual(info, codigo, { nome, gravidade: grav, dataHora, lat, lng, vel }) {
    const { aparelho, veiculo, empresa } = info;
    const chave = `${aparelho.id}:${codigo}`;
    const rec = this.pontuais.get(chave);
    if (rec && Date.now() - rec < REABRIR_MS) return null; // o mesmo aviso repetido em seguida: ignora
    this.pontuais.set(chave, Date.now());
    if (this.pontuais.size > 5000) this.pontuais.delete(this.pontuais.keys().next().value);
    const gps = Number.isFinite(lat) && (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001);
    const v = Math.min(9999.9, Math.max(0, Number(vel) || 0));
    const n = String(nome).slice(0, 80);
    return this.banco.query(
      `INSERT INTO alertas (empresa_id, aparelho_id, veiculo_id, codigo, nome, gravidade, inicio, fim, latitude, longitude, velocidade)
       VALUES (?)`,
      [[empresa.id, aparelho.id, veiculo ? veiculo.id : null, codigo, n, grav, dataHora, dataHora, gps ? r6(lat) : null, gps ? r6(lng) : null, v]],
    ).then((r) => {
      this.emit('alerta', {
        acao: 'novo',
        alerta: {
          empresaId: empresa.id, aparelhoId: aparelho.id, veiculoId: veiculo ? veiculo.id : null, ident: aparelho.identificador,
          codigo, nome: n, gravidade: grav, id: r.insertId, inicio: dataHora, fim: dataHora,
          latitude: gps ? r6(lat) : null, longitude: gps ? r6(lng) : null, velocidade: v, situacao: 'novo',
        },
      });
      return r.insertId;
    }).catch((e) => this.log('erro', `Falha ao gravar alerta de cerca: ${e.message}`));
  }

  /* ---------- comunicações ---------- */

  evento(ident, tipo, { ip = null, porta = null, detalhe = null } = {}) {
    const ap = this.frota.porIdent.get(ident);
    if (tipo === 'recusado') {
      const ultimo = this.recusas.get(ident) || 0;
      if (Date.now() - ultimo < RECUSA_MS) return;
      this.recusas.set(ident, Date.now());
      if (this.recusas.size > 5000) this.recusas.clear();
    }
    this.eventos.push([ap ? ap.id : null, ap ? ap.empresa_id : null, String(ident).slice(0, 20), tipo, agora(), ip, porta, detalhe ? String(detalhe).slice(0, 500) : null]);
    if (this.eventos.length > MAX_FILA) this.eventos.splice(0, this.eventos.length - MAX_FILA);
  }

  /** Comando enviado a um aparelho cadastrado (grava na hora, para receber a resposta depois). */
  comando({ id: ident, msgId, serial, name, note, usuarioId }) {
    const ap = this.frota.porIdent.get(ident);
    if (!ap) return;
    const k = `${ident}:${serial}`;
    const promessa = this.banco.query(
      'INSERT INTO comandos (empresa_id, aparelho_id, usuario_id, mensagem, nome, detalhe, sequencia, enviado_em) VALUES (?)',
      [[ap.empresa_id, ap.id, usuarioId || null, msgId, String(name).slice(0, 80), note ? String(note).slice(0, 255) : null, serial, agora()]],
    ).then((r) => r.insertId);
    promessa.catch((e) => this.log('erro', `Falha ao gravar comando: ${e.message}`));
    this.comandos.set(k, { promessa, em: Date.now() });
    if (this.comandos.size > 500) {
      const limite = Date.now() - 5 * 60000;
      for (const [x, c] of this.comandos) if (c.em < limite) this.comandos.delete(x);
    }
  }

  /** Resposta do aparelho a um comando. */
  resposta({ id: ident, replySerial, resultName, elapsedMs }) {
    const k = `${ident}:${replySerial}`;
    const c = this.comandos.get(k);
    if (!c) return;
    this.comandos.delete(k);
    c.promessa.then((cid) => this.banco.query(
      'UPDATE comandos SET respondido_em = ?, resultado = ?, tempo_ms = ? WHERE id = ?',
      [agora(), String(resultName || '').slice(0, 120), Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null, cid],
    )).catch(() => {});
  }

  /* ---------- gravação em lote ---------- */

  async gravar(tudo = false) {
    if (this.gravando) return;
    this.gravando = true;
    try {
      do {
        if (this.fila.length) {
          const lote = this.fila.slice(0, LOTE);
          await this.banco.query(
            `INSERT INTO posicoes (aparelho_id, veiculo_id, data_hora, recebido_em, latitude, longitude, velocidade, direcao, altitude,
              alarmes, alarmes_video, estado, ignicao, gps_valido, satelites, sinal, odometro) VALUES ?`,
            [lote],
          );
          this.fila.splice(0, lote.length);
          this.gravadas += lote.length;
          this.ultimaGravacao = Date.now();
        }
        if (this.eventos.length) {
          const lote = this.eventos.slice(0, LOTE);
          await this.banco.query('INSERT INTO eventos_aparelho (aparelho_id, empresa_id, identificador, tipo, data_hora, ip, porta, detalhe) VALUES ?', [lote]);
          this.eventos.splice(0, lote.length);
        }
      } while (tudo && (this.fila.length || this.eventos.length));
    } catch {
      // banco fora do ar: as linhas continuam na fila e vão na próxima tentativa (o Banco já avisou no log)
    } finally {
      this.gravando = false;
    }
  }

  async gravarEstados() {
    if (!this.sujos.size) return;
    const ids = [...this.sujos];
    this.sujos.clear();
    const rows = ids.map((id) => this.estados.get(id)).filter(Boolean).map((e) => [
      e.aparelho_id, e.online ? 1 : 0, e.ultimo_contato, e.ultima_posicao_em, e.latitude, e.longitude, e.velocidade, e.direcao,
      e.ignicao, e.gps_valido, e.satelites, e.sinal, e.odometro, e.ip, e.protocolo,
    ]);
    if (!rows.length) return;
    try {
      await this.banco.query(
        `INSERT INTO aparelhos_estado (aparelho_id, online, ultimo_contato, ultima_posicao_em, latitude, longitude, velocidade, direcao,
           ignicao, gps_valido, satelites, sinal, odometro, ip, protocolo) VALUES ?
         AS n ON DUPLICATE KEY UPDATE online = n.online, ultimo_contato = n.ultimo_contato, ultima_posicao_em = n.ultima_posicao_em,
           latitude = n.latitude, longitude = n.longitude, velocidade = n.velocidade, direcao = n.direcao, ignicao = n.ignicao,
           gps_valido = n.gps_valido, satelites = n.satelites, sinal = n.sinal, odometro = n.odometro, ip = n.ip, protocolo = n.protocolo`,
        [rows],
      );
    } catch {
      for (const id of ids) this.sujos.add(id);
    }
  }

  /** Aparelho sem cadastro que se conectou: entra (ou é atualizado) na lista de pendentes. */
  pendente(ident, dados = {}) {
    // um de cada vez por aparelho (conexão e registro chegam quase juntos)
    if (!this.filaPendentes) this.filaPendentes = new Map();
    const anterior = this.filaPendentes.get(ident) || Promise.resolve();
    const atual = anterior.then(() => this.gravarPendente(ident, dados));
    this.filaPendentes.set(ident, atual);
    atual.finally(() => { if (this.filaPendentes.get(ident) === atual) this.filaPendentes.delete(ident); });
    return atual;
  }

  async gravarPendente(ident, { ip = null, porta = null, registro = null, protocolo = null } = {}) {
    const r = registro || {};
    try {
      await this.banco.query(
        `INSERT INTO aparelhos_pendentes (identificador, primeiro_contato, ultimo_contato, ip, porta, fabricante, modelo, placa_informada, protocolo)
         VALUES (?) AS n ON DUPLICATE KEY UPDATE ultimo_contato = n.ultimo_contato, ip = n.ip, porta = n.porta,
           fabricante = COALESCE(n.fabricante, aparelhos_pendentes.fabricante), modelo = COALESCE(n.modelo, aparelhos_pendentes.modelo),
           placa_informada = COALESCE(n.placa_informada, aparelhos_pendentes.placa_informada),
           protocolo = COALESCE(n.protocolo, aparelhos_pendentes.protocolo), conexoes = aparelhos_pendentes.conexoes + 1`,
        [[String(ident).slice(0, 20), agora(), agora(), ip, porta, cortar(r.manufacturer, 40), cortar(r.model, 40), cortar(r.plate, 20), protocolo]],
      );
    } catch (e) {
      this.log('erro', `Falha ao registrar aparelho pendente ${ident}: ${e.message}`);
    }
  }

  resumo() {
    return { filaPosicoes: this.fila.length, filaEventos: this.eventos.length, descartadas: this.descartadas, gravadas: this.gravadas, ultimaGravacao: this.ultimaGravacao };
  }
}

function cortar(v, n) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[^\x20-\x7e -ÿ]/g, '').trim();
  return s ? s.slice(0, n) : null;
}

module.exports = { Historico, gravidade, nomeAlarme };
