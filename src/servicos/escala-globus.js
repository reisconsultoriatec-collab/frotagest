'use strict';
/**
 * FrotaGest — escala de trabalho gerada no Globus (Procedimentos Auxiliares › Importação da Escala Globus).
 *
 * Layout do arquivo (texto, um serviço por linha, 17 campos separados por ";"):
 *   1 data · 2 tipo de dia · 3 prefixo do veículo · 4 código da linha · 5 número oficial da linha · 6 nome da linha
 *   7 código do turno · 8 chapa do motorista · 9 nome do motorista · 10 hora inicial do serviço · 11 hora final do serviço
 *   12 hora inicial do motorista · 13 hora inicial do intervalo · 14 hora final do intervalo · 15 hora final do motorista
 *   16 local de pegada do motorista · 17 descrição do turno
 *
 *  - O veículo é achado pelo prefixo sem os zeros da frente (0005755 = 5755) e o motorista pela chapa (= matrícula).
 *  - O vínculo com o veículo usa a hora do SERVIÇO (é quando o veículo troca de mãos); a hora do motorista
 *    (que pode terminar depois, voltando à garagem) e o intervalo ficam para conferir a jornada.
 *  - Horário menor que o início do serviço é do dia seguinte (serviço que passa da meia-noite); 25:10 também vale.
 *  - O vínculo é opcional e feito um a um pelo painel; o feito pela escala termina sozinho no fim do serviço,
 *    a não ser que alguém troque antes (o cartão no DVR e a troca pelo painel sempre valem mais).
 * Reis Tecnologia
 */
const { agora } = require('../util/comum');

const CAMPOS = 17;
const MAX_LINHAS = 6000;

/** Prefixo e chapa como comparamos: sem espaços, em maiúsculas e sem os zeros da frente. */
const normEscala = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase().replace(/^0+(?=.)/, '').slice(0, 30);

const corta = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : null;
};
const p2 = (n) => String(n).padStart(2, '0');

/** 'AAAA-MM-DD' + dias. */
function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
/** "05:10" → minutos (aceita 24:00 a 47:59 para o dia seguinte) ou null; NaN se inválido. */
function minutos(h) {
  const s = String(h || '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[1]) > 47) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
function dataHora(data, min) {
  const dia = somarDias(data, Math.floor(min / 1440));
  const r = min % 1440;
  return `${dia} ${p2(Math.floor(r / 60))}:${p2(r % 60)}:00`;
}

/**
 * Lê o texto do arquivo. Devolve { servicos, erros, ignoradas }.
 * erros: [{ linha, motivo }] — a linha não entra; ignoradas: cabeçalho e linhas em branco.
 */
function lerEscala(texto) {
  const linhas = String(texto || '').replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const servicos = [];
  const erros = [];
  let ignoradas = 0;
  if (linhas.length > MAX_LINHAS + 1) {
    erros.push({ linha: 0, motivo: `Arquivo grande demais: até ${MAX_LINHAS} linhas por vez.` });
    return { servicos, erros, ignoradas };
  }
  linhas.forEach((bruta, i) => {
    const n = i + 1;
    if (!bruta.trim()) { ignoradas++; return; }
    const c = bruta.split(';').map((x) => x.trim());
    if (n === 1 && /^data\b/i.test(c[0])) { ignoradas++; return; } // cabeçalho com os nomes dos campos
    if (c.length < CAMPOS) { erros.push({ linha: n, motivo: `tem ${c.length} campos (o layout do Globus tem ${CAMPOS}, separados por ";")` }); return; }
    const md = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0]);
    if (!md) {
      erros.push({ linha: n, motivo: `data "${c[0].slice(0, 12)}" inválida (use dd/mm/aaaa)` });
      return;
    }
    const data = `${md[3]}-${md[2]}-${md[1]}`;
    const dt = new Date(`${data}T12:00:00Z`);
    if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== data) { erros.push({ linha: n, motivo: `data ${c[0]} não existe` }); return; }
    const h = [9, 10, 11, 12, 13, 14].map((k) => minutos(c[k]));
    const nomes = ['hora inicial do serviço', 'hora final do serviço', 'hora inicial do motorista', 'hora inicial do intervalo', 'hora final do intervalo', 'hora final do motorista'];
    const ruim = h.findIndex((x) => Number.isNaN(x));
    if (ruim >= 0) { erros.push({ linha: n, motivo: `${nomes[ruim]} "${c[9 + ruim]}" inválida (use HH:MM)` }); return; }
    const [ini, fimS, iniM, intI, intF, fimM] = h;
    if (ini == null || fimS == null) { erros.push({ linha: n, motivo: 'sem a hora inicial ou final do serviço' }); return; }
    let fim = fimS;
    if (fim <= ini) fim += 1440; // passa da meia-noite
    if (fim - ini > 24 * 60) { erros.push({ linha: n, motivo: 'serviço com mais de 24 horas' }); return; }
    // horas do motorista e do intervalo: antes do início do serviço (com folga de 2 h) = dia seguinte
    const rel = (m) => (m == null ? null : dataHora(data, m < ini - 120 && m < 1440 ? m + 1440 : m));
    servicos.push({
      linha: n,
      data,
      tipoDia: corta(c[1], 5),
      prefixo: corta(c[2], 20),
      linhaCodigo: corta(c[3], 20),
      linhaNumero: corta(c[4], 20),
      linhaNome: corta(c[5], 120),
      turno: corta(c[6], 10),
      chapa: corta(c[7], 30),
      motorista: corta(c[8], 120),
      servicoInicio: dataHora(data, ini),
      servicoFim: dataHora(data, fim),
      motoristaInicio: rel(iniM),
      intervaloInicio: rel(intI),
      intervaloFim: rel(intF),
      motoristaFim: rel(fimM),
      local: corta(c[15], 80),
      turnoDescricao: corta(c[16], 40),
      passaMeiaNoite: fim >= 1440,
    });
  });
  return { servicos, erros, ignoradas };
}

/** Encerra, no fim do serviço, os vínculos feitos pela escala que ninguém trocou antes. */
class EscalaGlobus {
  constructor({ banco, motoristas, log = () => {} }) {
    this.banco = banco;
    this.motoristas = motoristas;
    this.log = log;
    this.timer = null;
  }

  iniciar() {
    this.encerrarPrevistos().catch(() => {});
    this.timer = setInterval(() => this.encerrarPrevistos().catch((e) => this.log(`escala: ${e.message}`)), 60 * 1000);
    this.timer.unref();
  }

  parar() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async encerrarPrevistos() {
    const vencidos = await this.banco.query(
      "SELECT id, veiculo_id, fim_previsto FROM motorista_vinculos WHERE fim IS NULL AND origem = 'escala' AND fim_previsto IS NOT NULL AND fim_previsto <= ?",
      [agora()]);
    for (const x of vencidos) {
      const a = this.motoristas.abertos.get(x.veiculo_id);
      if (a && a.id === x.id) await this.motoristas.vincular({ veiculoId: x.veiculo_id, motoristaId: null, quando: String(x.fim_previsto), origem: 'escala' });
    }
    return vencidos.length;
  }
}

module.exports = { lerEscala, normEscala, EscalaGlobus, CAMPOS, MAX_LINHAS };
