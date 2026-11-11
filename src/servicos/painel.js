'use strict';
/**
 * FrotaGest — números do dashboard do Início.
 *
 *  - Hoje: km, motor ligado, em movimento, velocidade máxima, excessos e km por hora de cada
 *    veículo, calculados ao vivo das posições com a mesma conta dos relatórios (relatorios.analisar).
 *    A primeira leitura do dia percorre as posições de hoje; depois só as novas (pelo id).
 *  - Dias anteriores: tabela painel_dias, fechada uma vez por dia (e completada ao iniciar, para os
 *    últimos DIAS_HISTORICO dias que faltarem).
 * Nada aqui é pesado para o banco: as leituras são por veículo (índice) ou pelo id das posições.
 * Reis Tecnologia
 */
const { formatar, paraMs } = require('../util/comum');
const { analisar, distanciaKm } = require('../relatorios/relatorios');

const DIAS_HISTORICO = 14;
const PARADO_KMH = 3; // iguais aos dos relatórios
const LACUNA_SEG = 600;
const JUNTAR_EXCESSO_SEG = 60;
const LIMITE_KMH = 80; // excesso de velocidade quando o veículo não tem regra de velocidade (o relatório deixa escolher)
const ATUALIZAR_MS = 15000; // no máximo uma leitura de posições novas a cada 15 s
const LOTE = 20000;

const hojeTexto = () => formatar(Date.now()).slice(0, 10);
const diaMais = (dia, n) => formatar(paraMs(`${dia} 12:00:00`) + n * 86400000).slice(0, 10);

/** Acumulador de um veículo no dia (mesmas regras do relatorios.analisar, posição a posição). */
class Acumulador {
  constructor(limite = LIMITE_KMH) {
    this.limite = limite;
    this.km = 0;
    this.ligado = 0;
    this.movimento = 0;
    this.velMax = 0;
    this.excessos = 0;
    this.kmHora = new Array(24).fill(0);
    this.ant = null;
    this.antGps = null;
    this.ultimoAcima = null;
    this.ultima = null;
  }

  passo(p) {
    const t = paraMs(p.data_hora);
    if (this.ant && t < this.ant.t) return; // posição atrasada (o aparelho mandou depois): o relatório pega
    const vel = Number(p.velocidade) || 0;
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    const gps = !!p.gps_valido && Math.abs(lat) > 0.0001;
    const ign = !!p.ignicao;
    this.ultima = p.data_hora;
    if (gps && vel > this.velMax) this.velMax = vel;
    if (this.ant) {
      const dt = (t - this.ant.t) / 1000;
      if (dt > 0 && dt <= LACUNA_SEG) {
        if (this.ant.ign) this.ligado += dt;
        if (this.ant.vel > PARADO_KMH) this.movimento += dt;
      }
    }
    this.ant = { t, vel, ign };
    if (!gps) return;
    if (this.antGps) {
      const d = distanciaKm(this.antGps.lat, this.antGps.lon, lat, lon);
      const dt = (t - this.antGps.t) / 1000;
      if (d < 5 || (dt > 0 && d / (dt / 3600) < 250)) {
        this.km += d;
        this.kmHora[Number(p.data_hora.slice(11, 13))] += d;
      }
    }
    this.antGps = { t, lat, lon };
    if (vel > this.limite) {
      if (!this.ultimoAcima || (t - this.ultimoAcima) / 1000 > JUNTAR_EXCESSO_SEG) this.excessos++;
      this.ultimoAcima = t;
    }
  }

  publico(id) {
    const r1 = (n) => Math.round(n * 10) / 10;
    return {
      id, km: r1(this.km), ligado: Math.round(this.ligado), movimento: Math.round(this.movimento), velMax: Math.round(this.velMax),
      excessos: this.excessos, kmHora: this.kmHora.map(r1), ultima: this.ultima,
    };
  }
}

class Painel {
  constructor({ banco, frota, regras = null, log }) {
    this.banco = banco;
    this.frota = frota;
    this.regras = regras;
    this.log = typeof log === 'function' ? log : () => {}; // log(nível, texto)
    this.dia = null;
    this.acc = new Map(); // veiculoId → Acumulador (hoje)
    this.ultimoId = 0;
    this.atualizadoEm = 0;
    this.carregando = null; // promessa da leitura em andamento (uma por vez)
    this.fechando = null;
  }

  /** Começa: completa os dias que faltam e confere a virada do dia a cada minuto. */
  iniciar() {
    const fechar = () => this.fecharDiasPendentes().catch((e) => this.log('warn', `Dashboard: não fechou os dias anteriores (${e.message})`));
    setTimeout(fechar, 20000).unref?.();
    this.timer = setInterval(() => { if (this.dia && this.dia !== hojeTexto()) fechar(); }, 60000);
    this.timer.unref?.();
  }

  parar() {
    clearInterval(this.timer);
  }

  /** Limite de velocidade do veículo: o da regra de velocidade dele (fora das cercas), senão 80 km/h. */
  limiteDe(veiculoId) {
    return (this.regras && this.regras.limiteDe(veiculoId)) || LIMITE_KMH;
  }

  /* ---------- hoje (ao vivo) ---------- */

  async atualizar(forcar = false) {
    if (this.carregando) return this.carregando;
    const hoje = hojeTexto();
    if (!forcar && this.dia === hoje && Date.now() - this.atualizadoEm < ATUALIZAR_MS) return null;
    this.carregando = (this.dia === hoje ? this.lerNovas() : this.lerHoje(hoje))
      .finally(() => { this.carregando = null; });
    return this.carregando;
  }

  /** Dia novo (ou servidor acabou de subir): percorre as posições de hoje veículo por veículo. */
  async lerHoje(hoje) {
    const max = await this.banco.um('SELECT COALESCE(MAX(id), 0) AS m FROM posicoes');
    const ate = Number(max.m);
    const acc = new Map();
    for (const v of this.frota.veiculos.values()) {
      const rows = await this.banco.query(
        `SELECT data_hora, latitude, longitude, velocidade, ignicao, gps_valido FROM posicoes
          WHERE veiculo_id = ? AND data_hora >= ? AND id <= ? ORDER BY data_hora, id`, [v.id, `${hoje} 00:00:00`, ate]);
      if (!rows.length) continue;
      const a = new Acumulador(this.limiteDe(v.id));
      for (const p of rows) a.passo(p);
      acc.set(v.id, a);
    }
    this.acc = acc;
    this.dia = hoje;
    this.ultimoId = ate;
    this.atualizadoEm = Date.now();
  }

  /** Só as posições que chegaram depois da última leitura. */
  async lerNovas() {
    const inicio = `${this.dia} 00:00:00`;
    for (;;) {
      const rows = await this.banco.query(
        `SELECT id, veiculo_id, data_hora, latitude, longitude, velocidade, ignicao, gps_valido FROM posicoes
          WHERE id > ? ORDER BY id LIMIT ${LOTE}`, [this.ultimoId]);
      for (const p of rows) {
        this.ultimoId = Number(p.id);
        if (!p.veiculo_id || p.data_hora < inicio) continue;
        let a = this.acc.get(p.veiculo_id);
        if (!a) { a = new Acumulador(); this.acc.set(p.veiculo_id, a); }
        a.limite = this.limiteDe(p.veiculo_id); // regra mudou no meio do dia: vale dali em diante
        a.passo(p);
      }
      if (rows.length < LOTE) break;
    }
    this.atualizadoEm = Date.now();
  }

  /* ---------- dias fechados ---------- */

  /** Fecha os dias que faltam (até DIAS_HISTORICO para trás), um por vez, sem pressa. */
  async fecharDiasPendentes() {
    if (this.fechando) return this.fechando;
    this.fechando = (async () => {
      const hoje = hojeTexto();
      const feitos = new Set((await this.banco.query(`SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS d FROM painel_dias_ok WHERE dia >= ?`,
        [diaMais(hoje, -DIAS_HISTORICO)])).map((x) => x.d));
      for (let n = DIAS_HISTORICO; n >= 1; n--) {
        const dia = diaMais(hoje, -n);
        if (!feitos.has(dia)) await this.fecharDia(dia);
      }
    })().finally(() => { this.fechando = null; });
    return this.fechando;
  }

  async fecharDia(dia) {
    const de = `${dia} 00:00:00`;
    const ate = `${dia} 23:59:59`;
    const ids = (await this.banco.query(
      'SELECT DISTINCT veiculo_id FROM posicoes WHERE data_hora BETWEEN ? AND ? AND veiculo_id IS NOT NULL', [de, ate])).map((x) => Number(x.veiculo_id));
    const alertas = new Map((await this.banco.query(
      'SELECT veiculo_id, COUNT(*) AS n FROM alertas WHERE inicio BETWEEN ? AND ? AND veiculo_id IS NOT NULL GROUP BY veiculo_id', [de, ate]))
      .map((x) => [Number(x.veiculo_id), Number(x.n)]));
    const linhas = [];
    for (const id of new Set([...ids, ...alertas.keys()])) {
      const rows = ids.includes(id) ? await this.banco.query(
        `SELECT data_hora, latitude, longitude, velocidade, ignicao, gps_valido FROM posicoes
          WHERE veiculo_id = ? AND data_hora BETWEEN ? AND ? ORDER BY data_hora, id`, [id, de, ate]) : [];
      const a = analisar(rows, { limite: this.limiteDe(id) });
      const porHora = new Acumulador(); // mesma conta, guardando os km de cada hora (comparar "até esta hora")
      for (const p of rows) porHora.passo(p);
      linhas.push([dia, id, Math.round(a.km * 100) / 100, Math.round(a.ligadoSeg), Math.round(a.movimentoSeg), a.velMax || 0, a.excessos.length, alertas.get(id) || 0,
        porHora.kmHora.map((k) => Math.round(k * 10) / 10).join(',')]);
    }
    await this.banco.transacao(async (t) => {
      await t.query('DELETE FROM painel_dias WHERE dia = ?', [dia]);
      for (let i = 0; i < linhas.length; i += 500) {
        await t.query('INSERT INTO painel_dias (dia, veiculo_id, km, ligado_seg, movimento_seg, vel_max, excessos, alertas, km_horas) VALUES ?', [linhas.slice(i, i + 500)]);
      }
      await t.query('INSERT INTO painel_dias_ok (dia, fechado_em) VALUES (?, ?) ON DUPLICATE KEY UPDATE fechado_em = VALUES(fechado_em)', [dia, formatar()]);
    });
    if (linhas.length) this.log('info', `Dashboard: dia ${dia} fechado (${linhas.length} veículo(s))`);
  }

  /* ---------- resposta para a tela ---------- */

  /**
   * veiculos: os veículos que a pessoa enxerga. Devolve hoje por veículo e os últimos dias
   * (por veículo, para o filtro de grupo funcionar na tela sem pedir de novo).
   */
  async resumo(veiculos, { alertas = false } = {}) {
    await this.atualizar();
    const ids = veiculos.map((v) => v.id);
    const hoje = this.dia || hojeTexto();
    const r = {
      dia: hoje,
      atualizadoEm: formatar(this.atualizadoEm || Date.now()),
      limiteKmh: null, // o mesmo para todos os veículos? (cada um pode ter o seu pelas regras)
      hoje: ids.map((id) => this.acc.get(id)).map((a, k) => (a ? a.publico(ids[k]) : null)).filter(Boolean),
      dias: [],
      historico: {},
    };
    const limites = new Set(ids.map((id) => this.limiteDe(id)));
    r.limiteKmh = limites.size <= 1 ? (limites.values().next().value || LIMITE_KMH) : null;
    for (let n = DIAS_HISTORICO - 1; n >= 1; n--) r.dias.push(diaMais(hoje, -n));
    if (ids.length) {
      const rows = await this.banco.query(
        `SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS d, veiculo_id, km, movimento_seg, alertas, km_horas FROM painel_dias
          WHERE dia >= ? AND dia < ? AND veiculo_id IN (?)`, [r.dias[0], hoje, ids]);
      const ontem = r.dias[r.dias.length - 1];
      const pos = new Map(r.dias.map((d, i) => [d, i]));
      for (const x of rows) {
        const i = pos.get(x.d);
        if (i === undefined) continue;
        const h = r.historico[x.veiculo_id] || (r.historico[x.veiculo_id] = { km: new Array(r.dias.length).fill(0), mov: new Array(r.dias.length).fill(0), alertas: new Array(r.dias.length).fill(0) });
        h.km[i] = Number(x.km);
        h.mov[i] = Number(x.movimento_seg);
        h.alertas[i] = Number(x.alertas);
        if (x.d === ontem && x.km_horas) h.ontemHora = String(x.km_horas).split(',').map(Number);
      }
      const ok = await this.banco.query(`SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS d FROM painel_dias_ok WHERE dia >= ? AND dia < ?`, [r.dias[0], hoje]);
      r.diasFechados = ok.map((x) => x.d);
    } else {
      r.diasFechados = [];
    }
    if (alertas && ids.length) {
      // alertas de hoje, compactos: [veiculo, minuto do dia, gravidade, nome (índice), situação]
      const rows = await this.banco.query(
        `SELECT veiculo_id, inicio, gravidade, nome, situacao FROM alertas
          WHERE veiculo_id IN (?) AND inicio >= ? ORDER BY inicio LIMIT 5000`, [ids, `${hoje} 00:00:00`]);
      const nomes = [];
      const idx = new Map();
      r.alertas = {
        nomes,
        itens: rows.map((x) => {
          if (!idx.has(x.nome)) { idx.set(x.nome, nomes.length); nomes.push(x.nome); }
          const hm = String(x.inicio).slice(11, 16);
          return [Number(x.veiculo_id), Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)), x.gravidade, idx.get(x.nome), x.situacao];
        }),
      };
    }
    return r;
  }
}

module.exports = { Painel, Acumulador, LIMITE_KMH, DIAS_HISTORICO };
