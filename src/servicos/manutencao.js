'use strict';
/**
 * FrotaGest — manutenção e documentos: o que está vencido ou perto de vencer.
 *
 *  - Plano de manutenção por km e/ou por tempo ("troca de óleo a cada 10.000 km ou 6 meses"). Para cada
 *    veículo, conta a partir da última feita (ou do dia em que o plano foi cadastrado). Km pelo GPS:
 *    os totais de cada dia do Dashboard (painel_dias) mais o dia de hoje ao vivo.
 *  - Documentos do veículo e do motorista com vencimento; a CNH vem do cadastro do motorista.
 *  - Resumo diário no celular (7h) para quem tem a tela e os avisos ligados.
 *
 * Tudo opcional: sem plano nem documento cadastrado, nada aparece e nada é cobrado de ninguém.
 * Reis Tecnologia
 */
const EventEmitter = require('events');
const { formatar } = require('../util/comum');
const { permite, limitado } = require('../auth/acesso');

const TIPOS_DOC = {
  licenciamento: { nome: 'Licenciamento (CRLV)', de: 'veiculo' },
  ipva: { nome: 'IPVA', de: 'veiculo' },
  seguro: { nome: 'Seguro', de: 'veiculo' },
  tacografo: { nome: 'Aferição do tacógrafo', de: 'veiculo' },
  vistoria: { nome: 'Vistoria / inspeção', de: 'veiculo' },
  autorizacao: { nome: 'Autorização de transporte', de: 'veiculo' },
  extintor: { nome: 'Extintor', de: 'veiculo' },
  toxicologico: { nome: 'Exame toxicológico', de: 'motorista' },
  curso: { nome: 'Curso obrigatório', de: 'motorista' },
  aso: { nome: 'Exame médico (ASO)', de: 'motorista' },
  outro: { nome: 'Outro documento', de: 'ambos' },
};
const AVISO_DIAS_PADRAO = 15; // plano por tempo: avisa 15 dias antes (ou 1/4 do intervalo, se for curto)
const AVISO_KM_FRACAO = 0.1; // plano por km: avisa faltando 10% do intervalo
const AVISO_CNH_DIAS = 30;
const HORA_RESUMO = 7; // resumo diário no celular
const CACHE_MS = 60000;
const DIA_MS = 86400000;

const msDia = (d) => Date.parse(`${d}T00:00:00Z`);
const diasEntre = (de, ate) => Math.round((msDia(ate) - msDia(de)) / DIA_MS);
const somarDias = (d, n) => new Date(msDia(d) + n * DIA_MS).toISOString().slice(0, 10);
/** Mesmo dia N meses depois (31/01 + 1 mês = 28 ou 29/02). */
function somarMeses(d, n) {
  const [a, m, dd] = d.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dd, ultimo));
  return alvo.toISOString().slice(0, 10);
}
/** Tem prazo por tempo? (em dias ou em meses) */
const temTempo = (p) => Boolean(p.intervalo_dias || p.intervalo_meses);
/** Dias do intervalo de tempo (meses contam 30 dias, só para a antecedência padrão). */
const diasDoIntervalo = (p) => (p.intervalo_meses ? p.intervalo_meses * 30 : p.intervalo_dias || 0);
const hoje = () => formatar().slice(0, 10);
const ORDEM_ESTADO = { vencido: 0, perto: 1, ok: 2 };

/** Antecedência do aviso de um plano (o que a pessoa escolheu, ou o padrão). */
function antecedencia(p) {
  return {
    km: p.intervalo_km ? (p.avisar_km !== null && p.avisar_km !== undefined ? Number(p.avisar_km) : Math.round(p.intervalo_km * AVISO_KM_FRACAO)) : null,
    dias: temTempo(p) ? (p.avisar_dias !== null && p.avisar_dias !== undefined ? Number(p.avisar_dias) : Math.min(AVISO_DIAS_PADRAO, Math.ceil(diasDoIntervalo(p) / 4))) : null,
  };
}

/** Situação de um plano num veículo (base = última feita, ou o cadastro do plano). */
function situacaoPlano(p, base, kmDesde, dia = hoje()) {
  const av = antecedencia(p);
  const diasDesde = Math.max(0, diasEntre(base.data, dia));
  const km = Math.round(kmDesde);
  const faltaKm = p.intervalo_km ? p.intervalo_km - km : null;
  const proximaData = p.intervalo_meses ? somarMeses(base.data, p.intervalo_meses) : p.intervalo_dias ? somarDias(base.data, p.intervalo_dias) : null;
  const faltaDias = proximaData ? diasEntre(dia, proximaData) : null;
  let estado = 'ok';
  if ((faltaKm !== null && faltaKm <= 0) || (faltaDias !== null && faltaDias < 0)) estado = 'vencido'; // a data do dia ainda vale (vence hoje)
  else if ((faltaKm !== null && faltaKm <= av.km) || (faltaDias !== null && faltaDias <= av.dias)) estado = 'perto';
  return {
    estado, kmDesde: km, diasDesde, faltaKm, faltaDias,
    proximaData,
    hodometroEstimado: base.hodometro !== null && base.hodometro !== undefined ? Number(base.hodometro) + km : null,
    proximoHodometro: base.hodometro !== null && base.hodometro !== undefined && p.intervalo_km ? Number(base.hodometro) + p.intervalo_km : null,
    avisarKm: av.km, avisarDias: av.dias,
  };
}

/** Situação de um vencimento (documento ou CNH). */
function situacaoVencimento(vencimento, avisarDias, dia = hoje()) {
  const faltaDias = diasEntre(dia, vencimento);
  return { faltaDias, estado: faltaDias < 0 ? 'vencido' : faltaDias <= avisarDias ? 'perto' : 'ok' };
}

class Manutencao extends EventEmitter {
  constructor({ banco, frota, painel = null, motoristas = null, acesso = null, avisos = null, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.painel = painel;
    this.motoristas = motoristas;
    this.acesso = acesso;
    this.avisos = avisos;
    this.log = log;
    this.cache = null; // { ate, itens }
    this.calculando = null;
  }

  iniciar() {
    this.timer = setInterval(() => this.resumoDiario().catch((e) => this.log('erro', `Manutenção: resumo diário (${e.message})`)), 60000);
    this.timer.unref?.();
  }

  parar() {
    clearInterval(this.timer);
  }

  /** Algo mudou (plano, manutenção feita, documento, CNH): recalcula e avisa as telas. */
  mudou(empresaId) {
    this.cache = null;
    this.emit('mudou', empresaId);
  }

  /** Veículos (ativos) a que o plano se aplica. */
  veiculosDoPlano(p) {
    const lista = [];
    const grupos = p.grupo_id ? this.frota.descendentes(p.grupo_id) : null;
    for (const v of this.frota.veiculos.values()) {
      if (!v.ativo || v.empresa_id !== p.empresa_id) continue;
      if (p.veiculo_id && v.id !== p.veiculo_id) continue;
      if (grupos && (!v.grupo_id || !grupos.has(v.grupo_id))) continue;
      lista.push(v);
    }
    return lista;
  }

  /** Km rodados (GPS) por veículo depois de cada data: dias fechados do Dashboard + hoje ao vivo. */
  async kmDepois(pares, dia) {
    const ids = [...new Set(pares.map((x) => x.veiculoId))];
    const res = new Map();
    if (!ids.length) return res;
    const desde = pares.reduce((m, x) => (x.data < m ? x.data : m), dia);
    const porVeiculo = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.banco.query(
        `SELECT veiculo_id, DATE_FORMAT(dia, '%Y-%m-%d') AS d, km FROM painel_dias WHERE dia > ? AND dia < ? AND veiculo_id IN (?)`,
        [desde, dia, ids.slice(i, i + 500)]);
      for (const r of rows) {
        let l = porVeiculo.get(r.veiculo_id);
        if (!l) { l = []; porVeiculo.set(r.veiculo_id, l); }
        l.push([r.d, Number(r.km) || 0]);
      }
    }
    let vivo = new Map();
    if (this.painel) {
      try {
        await this.painel.atualizar();
        if (this.painel.dia === dia) vivo = this.painel.acc;
      } catch { /* sem o dia de hoje: só os dias fechados */ }
    }
    for (const x of pares) {
      const l = porVeiculo.get(x.veiculoId) || [];
      let km = l.reduce((s, [d, k]) => (d > x.data ? s + k : s), 0);
      const a = x.data < dia ? vivo.get(x.veiculoId) : null;
      if (a) km += Number(a.km) || 0;
      res.set(`${x.veiculoId}:${x.data}`, km);
    }
    return res;
  }

  /** Todos os itens (de todas as empresas), com a situação de cada um. Guardado por 1 min. */
  async itens() {
    if (this.cache && this.cache.ate > Date.now()) return this.cache.itens;
    if (!this.calculando) {
      this.calculando = this.calcular()
        .then((itens) => { this.cache = { ate: Date.now() + CACHE_MS, itens }; return itens; })
        .finally(() => { this.calculando = null; });
    }
    return this.calculando;
  }

  async calcular() {
    const dia = hoje();
    const [planos, feitas, docs] = await Promise.all([
      this.banco.query('SELECT * FROM manutencao_planos WHERE ativo = 1'),
      this.banco.query(`SELECT id, veiculo_id, plano_id, DATE_FORMAT(data, '%Y-%m-%d') AS data, hodometro FROM manutencoes
        WHERE plano_id IS NOT NULL ORDER BY data, id`),
      this.banco.query(`SELECT id, empresa_id, veiculo_id, motorista_id, tipo, descricao, numero,
        DATE_FORMAT(vencimento, '%Y-%m-%d') AS vencimento, avisar_dias FROM documentos`),
    ]);
    const ultima = new Map(); // `${plano}:${veículo}` → última feita
    for (const f of feitas) ultima.set(`${f.plano_id}:${f.veiculo_id}`, f);
    const itens = [];
    const pendentes = [];
    for (const p of planos) {
      const base0 = String(p.criado_em).slice(0, 10);
      for (const v of this.veiculosDoPlano(p)) {
        const f = ultima.get(`${p.id}:${v.id}`);
        const base = f ? { data: f.data, hodometro: f.hodometro, origem: 'feita', feitaId: f.id } : { data: base0, hodometro: null, origem: 'plano' };
        pendentes.push({ p, v, base, veiculoId: v.id, data: base.data });
      }
    }
    const kms = await this.kmDepois(pendentes, dia);
    for (const x of pendentes) {
      const s = situacaoPlano(x.p, x.base, kms.get(`${x.v.id}:${x.base.data}`) || 0, dia);
      itens.push({
        chave: `p${x.p.id}-v${x.v.id}`, tipo: 'manutencao', empresaId: x.p.empresa_id, veiculoId: x.v.id, motoristaId: null,
        planoId: x.p.id, nome: x.p.nome, intervaloKm: x.p.intervalo_km, intervaloDias: x.p.intervalo_dias, intervaloMeses: x.p.intervalo_meses, base: x.base, ...s,
      });
    }
    for (const d of docs) {
      const t = TIPOS_DOC[d.tipo] || TIPOS_DOC.outro;
      if (d.veiculo_id) { const v = this.frota.veiculos.get(d.veiculo_id); if (!v || !v.ativo) continue; }
      if (d.motorista_id) { const m = this.motoristas && this.motoristas.lista.get(d.motorista_id); if (!m || !m.ativo) continue; }
      itens.push({
        chave: `d${d.id}`, tipo: 'documento', id: d.id, empresaId: d.empresa_id, veiculoId: d.veiculo_id, motoristaId: d.motorista_id,
        docTipo: d.tipo, nome: d.tipo === 'outro' && d.descricao ? d.descricao : t.nome, detalhe: d.tipo === 'outro' ? null : d.descricao,
        numero: d.numero, vencimento: d.vencimento, avisarDias: d.avisar_dias, ...situacaoVencimento(d.vencimento, d.avisar_dias, dia),
      });
    }
    if (this.motoristas) {
      for (const m of this.motoristas.lista.values()) {
        if (!m.ativo || !m.cnh_validade) continue;
        const venc = String(m.cnh_validade).slice(0, 10);
        itens.push({
          chave: `c${m.id}`, tipo: 'cnh', empresaId: m.empresa_id, veiculoId: null, motoristaId: m.id, nome: `CNH${m.cnh_categoria ? ` ${m.cnh_categoria}` : ''}`,
          numero: m.cnh_numero || null, vencimento: venc, avisarDias: AVISO_CNH_DIAS, ...situacaoVencimento(venc, AVISO_CNH_DIAS, dia),
        });
      }
    }
    itens.sort((a, b) => ORDEM_ESTADO[a.estado] - ORDEM_ESTADO[b.estado] || (a.faltaDias ?? 99999) - (b.faltaDias ?? 99999));
    return itens;
  }

  /** Motorista que a pessoa enxerga (mesma regra da tela Motoristas). */
  veMotorista(u, m) {
    if (!m) return false;
    if (u.perfil === 'master') return true;
    if (m.empresa_id !== u.empresaId) return false;
    return !limitado(u) || !m.grupo_id || u.grupos.has(m.grupo_id);
  }

  /** Os itens que a pessoa vê (veículos e motoristas dela), de uma empresa ou de todas (master). */
  async daPessoa(u, empresaId = null) {
    const l = await this.itens();
    return l.filter((x) => {
      if (empresaId && x.empresaId !== empresaId) return false;
      if (u.perfil !== 'master' && x.empresaId !== u.empresaId) return false;
      if (x.veiculoId) return this.acesso.veVeiculo(u, this.frota.veiculos.get(x.veiculoId));
      if (x.motoristaId) return this.veMotorista(u, this.motoristas && this.motoristas.lista.get(x.motoristaId));
      return true;
    });
  }

  rotulo(x) {
    if (x.veiculoId) {
      const v = this.frota.veiculos.get(x.veiculoId);
      return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : 'veículo';
    }
    const m = x.motoristaId && this.motoristas ? this.motoristas.lista.get(x.motoristaId) : null;
    return m ? m.nome : 'motorista';
  }

  /** Texto curto do resumo: "2 vencidos: Troca de óleo (TST1001), CNH (João) · 3 vencem em breve". */
  textoResumo(lista) {
    const venc = lista.filter((x) => x.estado === 'vencido');
    const perto = lista.filter((x) => x.estado === 'perto');
    const nomes = (l) => l.slice(0, 3).map((x) => `${x.nome} (${this.rotulo(x)})`).join(', ') + (l.length > 3 ? '…' : '');
    const partes = [];
    if (venc.length) partes.push(`${venc.length} vencido${venc.length > 1 ? 's' : ''}: ${nomes(venc)}`);
    if (perto.length) partes.push(`${perto.length} vence${perto.length > 1 ? 'm' : ''} em breve${venc.length ? '' : `: ${nomes(perto)}`}`);
    return partes.join(' · ').slice(0, 240);
  }

  /** Uma vez por dia (7h): manda para o celular de quem tem a tela o que está vencido ou perto. */
  async resumoDiario(forcar = false) {
    if (!this.avisos || !this.avisos.inscricoes.size) return 0;
    const agora = formatar();
    const dia = agora.slice(0, 10);
    if (!forcar) {
      if (Number(agora.slice(11, 13)) < HORA_RESUMO || this.ultimoResumo === dia) return 0;
      const r = await this.banco.um("SELECT valor FROM configuracoes WHERE chave = 'manutencao_resumo_dia'");
      this.ultimoResumo = r ? r.valor : null;
      if (this.ultimoResumo === dia) return 0;
      await this.banco.query("INSERT INTO configuracoes (chave, valor) VALUES ('manutencao_resumo_dia', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [dia]);
      this.ultimoResumo = dia;
    }
    let enviados = 0;
    const pessoas = new Set([...this.avisos.inscricoes.values()].map((i) => i.usuario_id));
    for (const id of pessoas) {
      const x = await this.avisos.usuario(id);
      if (!x || !x.manutencao || !permite(x.u, 'manutencao')) continue;
      const l = (await this.daPessoa(x.u)).filter((i) => i.estado !== 'ok');
      if (!l.length) continue;
      const venc = l.filter((i) => i.estado === 'vencido').length;
      const msg = { t: 'Manutenção e documentos', b: this.textoResumo(l), tag: 'fg-manut', g: venc ? 'media' : 'baixa', u: '/#/manutencao', em: Date.now() };
      const destinos = [...this.avisos.inscricoes.values()].filter((i) => i.usuario_id === id);
      await Promise.all(destinos.map((i) => this.avisos.enviarPara(i, msg, { ttl: 6 * 3600, urgencia: 'normal' })));
      enviados++;
    }
    if (enviados) this.log('info', `Manutenção: resumo do dia enviado para ${enviados} pessoa(s)`);
    return enviados;
  }
}

module.exports = { Manutencao, TIPOS_DOC, situacaoPlano, situacaoVencimento, antecedencia, somarMeses };
