'use strict';
/**
 * FrotaGest — cadastros em memória (empresas, grupos, perfis de protocolo, aparelhos e veículos).
 * São poucas centenas de linhas: carregamos tudo e recarregamos a cada alteração feita no painel.
 * Reis Tecnologia
 */
const { EventEmitter } = require('events');

class Frota extends EventEmitter {
  constructor(banco, config, opcoes = {}) {
    super();
    this.banco = banco;
    this.config = config;
    this.publicHostPadrao = opcoes.publicHost || '';
    this.empresas = new Map();
    this.grupos = new Map();
    this.filhos = new Map(); // grupo_id → [ids filhos]
    this.perfis = new Map();
    this.aparelhos = new Map(); // id → aparelho
    this.porIdent = new Map(); // identificador → aparelho
    this.veiculos = new Map(); // id → veículo
    this.veiculoDoAparelho = new Map(); // aparelho_id → veículo (ativo)
    this.carregadaEm = 0;
  }

  async carregar() {
    const [empresas, grupos, perfis, aparelhos, veiculos] = await Promise.all([
      this.banco.query('SELECT id, nome, ativo FROM empresas'),
      this.banco.query('SELECT id, empresa_id, pai_id, nome FROM grupos ORDER BY nome'),
      this.banco.query('SELECT * FROM perfis_protocolo ORDER BY padrao DESC, id'),
      this.banco.query(`SELECT id, empresa_id, perfil_id, identificador, fabricante, modelo, canais, nomes_canais, chip_numero, ativo
                          FROM aparelhos`),
      this.banco.query(`SELECT id, empresa_id, grupo_id, aparelho_id, placa, prefixo, descricao, tipo, ativo
                          FROM veiculos`),
    ]);
    this.empresas = new Map(empresas.map((e) => [e.id, { ...e, ativo: !!e.ativo }]));
    this.grupos = new Map(grupos.map((g) => [g.id, g]));
    this.filhos = new Map();
    for (const g of grupos) {
      if (!g.pai_id) continue;
      if (!this.filhos.has(g.pai_id)) this.filhos.set(g.pai_id, []);
      this.filhos.get(g.pai_id).push(g.id);
    }
    this.perfis = new Map(perfis.map((p) => [p.id, { ...p, ativo: !!p.ativo, padrao: !!p.padrao }]));
    this.aparelhos = new Map();
    this.porIdent = new Map();
    for (const a of aparelhos) {
      const ap = { ...a, ativo: !!a.ativo, nomes_canais: lerNomes(a.nomes_canais) };
      this.aparelhos.set(ap.id, ap);
      this.porIdent.set(ap.identificador, ap);
    }
    this.veiculos = new Map();
    this.veiculoDoAparelho = new Map();
    for (const v of veiculos) {
      const ve = { ...v, ativo: !!v.ativo };
      this.veiculos.set(ve.id, ve);
      if (ve.aparelho_id && ve.ativo) this.veiculoDoAparelho.set(ve.aparelho_id, ve);
    }
    this.carregadaEm = Date.now();
    this.emit('recarregada');
  }

  /** O aparelho pode ficar conectado? Desconhecido: fica na lista de pendentes (ou é recusado, conforme a configuração). */
  autorizar(ident) {
    const ap = this.porIdent.get(ident);
    if (!ap) {
      if (this.config.get('aparelhos_nao_cadastrados') === 'recusar') return { ok: false, motivo: 'aparelho não cadastrado' };
      return { ok: true, pendente: true };
    }
    if (!ap.ativo) return { ok: false, motivo: 'aparelho desativado no cadastro' };
    const emp = this.empresas.get(ap.empresa_id);
    if (!emp || !emp.ativo) return { ok: false, motivo: 'empresa desativada' };
    return { ok: true };
  }

  /** Cadastro completo de um aparelho conectado (ou null se não cadastrado/inativo). */
  info(ident) {
    const aparelho = this.porIdent.get(ident);
    if (!aparelho || !aparelho.ativo) return null;
    const empresa = this.empresas.get(aparelho.empresa_id) || null;
    if (!empresa || !empresa.ativo) return null;
    return {
      aparelho,
      empresa,
      veiculo: this.veiculoDoAparelho.get(aparelho.id) || null,
      perfil: this.perfis.get(aparelho.perfil_id) || this.perfilPadrao(),
    };
  }

  perfilPadrao() {
    for (const p of this.perfis.values()) if (p.padrao) return p;
    return this.perfis.values().next().value || null;
  }

  perfilDaPorta(porta) {
    for (const p of this.perfis.values()) if (p.ativo && p.porta_sinalizacao === porta) return p;
    return null;
  }

  /** Onde o aparelho deve entregar o vídeo: endereço e porta de vídeo do perfil dele. */
  midiaPara(ident, portaConectada = null) {
    const ap = this.porIdent.get(ident);
    let perfil = ap ? this.perfis.get(ap.perfil_id) : null;
    if (!perfil && portaConectada) perfil = this.perfilDaPorta(portaConectada);
    if (!perfil) perfil = this.perfilPadrao();
    return {
      publicHost: (perfil && perfil.endereco_video) || this.publicHostPadrao || '',
      port: perfil ? perfil.porta_video : 6602,
    };
  }

  /** Portas que precisam estar abertas, pelos perfis ativos. */
  portas() {
    const sinalizacao = new Set();
    const video = new Set();
    for (const p of this.perfis.values()) {
      if (!p.ativo) continue;
      sinalizacao.add(p.porta_sinalizacao);
      video.add(p.porta_video);
    }
    return { sinalizacao: [...sinalizacao], video: [...video] };
  }

  /** O grupo e todos os subgrupos dele. */
  descendentes(grupoId, out = new Set()) {
    if (out.has(grupoId)) return out;
    out.add(grupoId);
    for (const f of this.filhos.get(grupoId) || []) this.descendentes(f, out);
    return out;
  }

  /** Caminho do grupo ("Matriz › Linha 10"). */
  caminhoGrupo(grupoId) {
    const nomes = [];
    let g = this.grupos.get(grupoId);
    const vistos = new Set();
    while (g && !vistos.has(g.id)) {
      vistos.add(g.id);
      nomes.unshift(g.nome);
      g = g.pai_id ? this.grupos.get(g.pai_id) : null;
    }
    return nomes.join(' › ');
  }
}

function lerNomes(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x || ''));
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map((x) => String(x || '')) : [];
  } catch {
    return [];
  }
}

module.exports = { Frota };
