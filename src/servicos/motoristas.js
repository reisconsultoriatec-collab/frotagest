'use strict';
/**
 * FrotaGest — motoristas: quem está em cada veículo agora e quem dirigiu quando.
 *
 *  - O vínculo vem do painel (alguém escolhe o motorista do veículo) ou do cartão do motorista
 *    lido pelo DVR (0x0702: passou o cartão = começou; tirou = terminou).
 *  - Um veículo tem no máximo um motorista por vez, e um motorista está em um veículo por vez.
 *  - O vínculo escolhido no painel fica até alguém trocar; o do cartão termina quando o cartão sai.
 *  - Cartão que não está no cadastro fica guardado para cadastrar com um clique.
 * Reis Tecnologia
 */
const { EventEmitter } = require('events');
const { formatar, horaDoAparelho, agora } = require('../util/comum');

/** Código do cartão como comparamos: sem espaços e sem os zeros que o DVR completa. */
const normCartao = (c) => String(c || '').replace(/\s+/g, '').replace(/^0+/, '').toUpperCase().slice(0, 40);

class Motoristas extends EventEmitter {
  constructor({ banco, frota, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.log = log;
    this.lista = new Map(); // id → motorista
    this.porCartao = new Map(); // `${empresa}:${cartão}` → motorista (ativos)
    this.abertos = new Map(); // veiculo_id → { id, motoristaId, inicio, origem }
    this.fila = Promise.resolve(); // trocas em ordem (cartão e painel ao mesmo tempo)
  }

  async carregar() {
    const rows = await this.banco.query('SELECT * FROM motoristas');
    this.lista = new Map(rows.map((m) => [m.id, m]));
    this.porCartao = new Map();
    for (const m of rows) if (m.ativo && m.cartao) this.porCartao.set(`${m.empresa_id}:${normCartao(m.cartao)}`, m);
    const vinc = await this.banco.query('SELECT id, veiculo_id, motorista_id, inicio, origem FROM motorista_vinculos WHERE fim IS NULL ORDER BY inicio');
    this.abertos = new Map(vinc.map((x) => [x.veiculo_id, { id: x.id, motoristaId: x.motorista_id, inicio: x.inicio, origem: x.origem }]));
  }

  /** Motorista no veículo agora: { id, nome, desde, origem } ou null. */
  atual(veiculoId) {
    const a = veiculoId ? this.abertos.get(veiculoId) : null;
    if (!a) return null;
    const m = this.lista.get(a.motoristaId);
    return m ? { id: m.id, nome: m.nome, matricula: m.matricula || null, desde: a.inicio, origem: a.origem } : null;
  }

  /** Veículo em que o motorista está agora (ou null). */
  veiculoDe(motoristaId) {
    for (const [veiculoId, a] of this.abertos) if (a.motoristaId === motoristaId) return veiculoId;
    return null;
  }

  /**
   * Coloca o motorista no veículo (ou tira, com motoristaId null) a partir de "quando".
   * Fecha o vínculo anterior do veículo e o do motorista em outro veículo. Devolve os veículos que mudaram.
   */
  vincular({ veiculoId, motoristaId = null, quando = agora(), origem = 'manual', usuarioId = null }) {
    const p = this.fila.then(async () => {
      const v = this.frota.veiculos.get(veiculoId);
      if (!v) return [];
      const mudou = new Set();
      const atual = this.abertos.get(veiculoId);
      if (atual && atual.motoristaId === motoristaId) return []; // já é ele
      // hora que chegou atrasada (cartão passado com o DVR sem sinal): nunca antes do vínculo que está fechando
      let ini = String(quando);
      if (atual) {
        if (ini < String(atual.inicio)) ini = String(atual.inicio);
        const fim = ini;
        await this.banco.query('UPDATE motorista_vinculos SET fim = ? WHERE id = ?', [fim, atual.id]);
        this.abertos.delete(veiculoId);
        mudou.add(veiculoId);
      }
      if (motoristaId) {
        const outro = this.veiculoDe(motoristaId);
        if (outro) {
          const a = this.abertos.get(outro);
          if (ini < String(a.inicio)) ini = String(a.inicio);
          await this.banco.query('UPDATE motorista_vinculos SET fim = ? WHERE id = ?', [ini, a.id]);
          this.abertos.delete(outro);
          mudou.add(outro);
        }
        const r = await this.banco.query(
          'INSERT INTO motorista_vinculos (empresa_id, veiculo_id, motorista_id, inicio, origem, usuario_id) VALUES (?, ?, ?, ?, ?, ?)',
          [v.empresa_id, veiculoId, motoristaId, ini, origem, usuarioId]);
        this.abertos.set(veiculoId, { id: r.insertId, motoristaId, inicio: ini, origem });
        mudou.add(veiculoId);
      }
      if (mudou.size) this.emit('mudou', [...mudou]);
      return [...mudou];
    });
    this.fila = p.catch(() => {});
    return p;
  }

  /** Cartão do motorista lido pelo DVR (evento 'motorista' do gateway). */
  async cartao(info, d) {
    const v = info && info.veiculo;
    if (!v) return null;
    const quando = horaDoAparelho(d.time, info.perfil ? info.perfil.fuso_minutos : undefined, d.recebidoEm).texto;
    if (d.status === 2) {
      // tirou o cartão: termina só o vínculo que veio do cartão (o escolhido no painel continua)
      const a = this.abertos.get(v.id);
      if (a && a.origem === 'cartao') await this.vincular({ veiculoId: v.id, motoristaId: null, quando, origem: 'cartao' });
      return { acao: 'saiu' };
    }
    if (d.status !== 1 || !d.lido) return null;
    const codigos = [d.lido.certificado, d.lido.documento].map(normCartao).filter(Boolean);
    const m = codigos.map((c) => this.porCartao.get(`${v.empresa_id}:${c}`)).find(Boolean);
    if (m) {
      await this.vincular({ veiculoId: v.id, motoristaId: m.id, quando, origem: 'cartao' });
      return { acao: 'entrou', motorista: m };
    }
    // cartão fora do cadastro: outra pessoa está dirigindo; guarda o cartão para cadastrar
    const codigo = codigos[0];
    if (codigo) {
      await this.banco.query(
        `INSERT INTO motorista_cartoes_lidos (empresa_id, cartao, nome_lido, aparelho_id, lido_em) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE nome_lido = VALUES(nome_lido), aparelho_id = VALUES(aparelho_id), lido_em = VALUES(lido_em), vezes = vezes + 1`,
        [v.empresa_id, codigo, (d.lido.nome || '').slice(0, 120) || null, info.aparelho.id, quando]);
    }
    await this.vincular({ veiculoId: v.id, motoristaId: null, quando, origem: 'cartao' });
    this.emit('cartaoDesconhecido', { empresaId: v.empresa_id, cartao: codigo, nome: d.lido.nome, veiculoId: v.id });
    return { acao: 'desconhecido', cartao: codigo };
  }

  /** Vínculos que cruzam o período (para relatórios), em ordem. */
  async doPeriodo({ de, ate, veiculoIds = null, motoristaIds = null }) {
    const onde = ['inicio <= ?', '(fim IS NULL OR fim >= ?)'];
    const args = [ate, de];
    if (veiculoIds) { if (!veiculoIds.length) return []; onde.push('veiculo_id IN (?)'); args.push(veiculoIds); }
    if (motoristaIds) { if (!motoristaIds.length) return []; onde.push('motorista_id IN (?)'); args.push(motoristaIds); }
    return this.banco.query(`SELECT * FROM motorista_vinculos WHERE ${onde.join(' AND ')} ORDER BY inicio, id`, args);
  }

  resumo() {
    return { motoristas: this.lista.size, emVeiculos: this.abertos.size };
  }
}

module.exports = { Motoristas, normCartao, formatar };
