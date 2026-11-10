'use strict';
/**
 * FrotaGest — cercas virtuais ao vivo: a cada posição, vê se o veículo entrou ou saiu de alguma cerca
 * da empresa dele e, conforme a cerca, abre o alerta (área proibida, saída da garagem fora do horário...).
 * Também diz quem está dentro de cada cerca agora (mapa, lista das cercas e modo TV).
 * Os relatórios de garagem e de cercas refazem o cálculo pelas posições guardadas (ver relatorios.js).
 * Reis Tecnologia
 */
const { EventEmitter } = require('events');
const { caixa, Rastreio, dentroDoHorario, centro } = require('./geo');
const { paraMs, formatar } = require('../util/comum');

const FINALIDADES = {
  garagem: { nome: 'Garagem', cor: '#2563EB' },
  ponto: { nome: 'Ponto ou terminal', cor: '#0D9488' },
  area: { nome: 'Área de interesse', cor: '#7C3AED' },
  proibida: { nome: 'Área proibida', cor: '#DC2626' },
};

const VELHA_MS = 6 * 3600000; // posição com mais de 6 h (chegou atrasada): atualiza onde está, mas não avisa

/** Linha do banco → cerca em memória. */
function daLinha(r) {
  let pontos = null;
  if (r.forma === 'poligono') {
    try { pontos = JSON.parse(r.pontos || '[]').map((p) => [Number(p[0]), Number(p[1])]); } catch { pontos = []; }
  }
  const c = {
    id: r.id, empresaId: r.empresa_id, grupoId: r.grupo_id, nome: r.nome, finalidade: r.finalidade, forma: r.forma,
    lat: r.latitude === null ? null : Number(r.latitude), lng: r.longitude === null ? null : Number(r.longitude),
    raio: r.raio_m === null ? null : Number(r.raio_m), pontos,
    alertaEntrada: Boolean(r.alerta_entrada), alertaSaida: Boolean(r.alerta_saida),
    horarioInicio: r.horario_inicio || null, horarioFim: r.horario_fim || null, observacao: r.observacao || null, ativo: Boolean(r.ativo),
  };
  const valida = c.forma === 'circulo' ? Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.raio > 0 : (c.pontos || []).length >= 3;
  if (!valida) return null;
  c.caixa = caixa(c);
  c.centro = centro(c);
  return c;
}

class Cercas extends EventEmitter {
  constructor({ banco, frota, historico, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.historico = historico;
    this.log = log;
    this.lista = new Map(); // id → cerca (só as ativas)
    this.rastreios = new Map(); // aparelho_id → Rastreio
    this.ultimaHora = new Map(); // aparelho_id → ms da última posição usada
  }

  async carregar() {
    const rows = await this.banco.query('SELECT * FROM cercas WHERE ativo = 1');
    const nova = new Map();
    for (const r of rows) {
      const c = daLinha(r);
      if (c) nova.set(c.id, c);
    }
    this.lista = nova;
    this.cache = new Map();
    this.recalcular();
  }

  /** Cercas que valem para um veículo (empresa dele; sem grupo = todas da empresa). */
  doVeiculo(v) {
    if (!v) return [];
    const k = `${v.id}:${v.empresa_id}:${v.grupo_id}`;
    let l = this.cache.get(k);
    if (l) return l;
    l = [];
    for (const c of this.lista.values()) {
      if (c.empresaId !== v.empresa_id) continue;
      if (c.grupoId) {
        const ids = new Set();
        this.frota.descendentes(c.grupoId, ids);
        if (!ids.has(v.grupo_id)) continue;
      }
      l.push(c);
    }
    this.cache.set(k, l);
    if (this.cache.size > 20000) this.cache.clear();
    return l;
  }

  /** Depois de carregar ou mudar cercas/frota: põe cada veículo onde ele está, sem gerar avisos. */
  recalcular() {
    this.cache = new Map();
    for (const ap of this.frota.aparelhos.values()) {
      const v = this.frota.veiculoDoAparelho.get(ap.id);
      const cercas = v && ap.ativo ? this.doVeiculo(v) : [];
      let r = this.rastreios.get(ap.id);
      if (!cercas.length) { if (r) r.limpar(new Set()); continue; }
      if (!r) { r = new Rastreio(); this.rastreios.set(ap.id, r); }
      r.limpar(new Set(cercas.map((c) => c.id)));
      const e = this.historico.estados.get(ap.id);
      if (!e || e.latitude === null || e.latitude === undefined) continue;
      // só as cercas novas para este veículo entram aqui (as outras continuam como estavam)
      const novas = cercas.filter((c) => !r.dentro.has(c.id));
      if (novas.length) {
        const ult = r.ultimo;
        r.ultimo = null; // sem filtro de salto nesta conferência
        r.passo(novas, Number(e.latitude), Number(e.longitude), Date.now());
        if (ult) r.ultimo = ult;
      }
    }
    this.fecharProibidasVazias();
  }

  /** Alerta de área proibida que ficou aberto (servidor reiniciou, cerca apagada) e o veículo não está mais lá. */
  fecharProibidasVazias() {
    for (const [apId, abertos] of this.historico.abertos) {
      for (const [codigo] of abertos) {
        const m = /^c(\d+)p$/.exec(codigo);
        if (!m) continue;
        const r = this.rastreios.get(apId);
        const id = Number(m[1]);
        if (this.lista.has(id) && this.lista.get(id).finalidade === 'proibida' && r && r.dentro.get(id) !== false) continue;
        const ap = this.frota.aparelhos.get(apId);
        const info = ap ? this.frota.info(ap.identificador) : null;
        if (info) this.historico.encerrarExterno(info, codigo, formatar(Date.now()));
      }
    }
  }

  /** Nova posição de um aparelho cadastrado (r = o que o histórico devolveu: hora e GPS). */
  posicao(ident, p, r) {
    if (!r || !r.gps || !this.lista.size) return;
    const info = this.frota.info(ident);
    if (!info || !info.veiculo) return;
    const cercas = this.doVeiculo(info.veiculo);
    if (!cercas.length) return;
    const t = paraMs(r.dataHora);
    const ap = info.aparelho.id;
    // posições atrasadas (lote de área sem sinal) não voltam o veículo no tempo
    if (t < (this.ultimaHora.get(ap) || 0)) return;
    this.ultimaHora.set(ap, t);
    let rast = this.rastreios.get(ap);
    if (!rast) { rast = new Rastreio(); this.rastreios.set(ap, rast); }
    const eventos = rast.passo(cercas, Number(p.lat), Number(p.lon), t);
    if (!eventos.length) return;
    const velha = Date.now() - t > VELHA_MS;
    for (const ev of eventos) {
      const dados = { dataHora: r.dataHora, lat: Number(p.lat), lng: Number(p.lon), vel: Number(p.speed) || 0 };
      this.emit('evento', { ...ev, info, ...dados });
      if (!velha) this.avisar(info, ev.cerca, ev.tipo, dados);
    }
  }

  /** Decide o alerta de cada entrada/saída conforme a cerca. */
  avisar(info, c, tipo, dados) {
    if (c.finalidade === 'proibida') {
      const codigo = `c${c.id}p`;
      if (tipo === 'entrada') this.historico.abrirExterno(info, codigo, { ...dados, nome: `Em área proibida: ${c.nome}`, gravidade: 'alta' });
      else this.historico.encerrarExterno(info, codigo, dados.dataHora);
      return;
    }
    const quer = tipo === 'entrada' ? c.alertaEntrada : c.alertaSaida;
    if (!quer) return;
    const hhmm = String(dados.dataHora).slice(11, 16);
    const temHorario = Boolean(c.horarioInicio && c.horarioFim);
    // com horário permitido, só avisa o que acontecer fora dele
    if (temHorario && dentroDoHorario(hhmm, c.horarioInicio, c.horarioFim)) return;
    const fora = temHorario ? ' fora do horário' : '';
    const nome = c.finalidade === 'garagem'
      ? (tipo === 'entrada' ? `Chegada na garagem${fora}: ${c.nome}` : `Saída da garagem${fora}: ${c.nome}`)
      : (tipo === 'entrada' ? `Entrada na cerca${fora}: ${c.nome}` : `Saída da cerca${fora}: ${c.nome}`);
    this.historico.alertaPontual(info, `c${c.id}${tipo === 'entrada' ? 'e' : 's'}`, { ...dados, nome, gravidade: temHorario ? 'media' : 'baixa' });
  }

  /** Cercas em que o aparelho está agora: [{ id, nome, finalidade }] */
  dentro(aparelhoId) {
    const r = this.rastreios.get(aparelhoId);
    if (!r) return [];
    const out = [];
    for (const [id, d] of r.dentro) {
      if (!d) continue;
      const c = this.lista.get(id);
      if (c) out.push({ id, nome: c.nome, finalidade: c.finalidade });
    }
    return out;
  }

  /** Quantos aparelhos estão dentro de cada cerca agora: Map cercaId → [aparelho_id] */
  ocupacao() {
    const m = new Map();
    for (const [ap, r] of this.rastreios) {
      for (const [id, d] of r.dentro) {
        if (!d || !this.lista.has(id)) continue;
        if (!m.has(id)) m.set(id, []);
        m.get(id).push(ap);
      }
    }
    return m;
  }

  /** Cerca para a tela (sem os campos internos). */
  publica(c) {
    return {
      id: c.id, empresaId: c.empresaId, grupoId: c.grupoId, nome: c.nome, finalidade: c.finalidade, forma: c.forma,
      lat: c.lat, lng: c.lng, raio: c.raio, pontos: c.pontos, alertaEntrada: c.alertaEntrada, alertaSaida: c.alertaSaida,
      horarioInicio: c.horarioInicio, horarioFim: c.horarioFim, cor: FINALIDADES[c.finalidade].cor,
    };
  }
}

module.exports = { Cercas, FINALIDADES, daLinha };
