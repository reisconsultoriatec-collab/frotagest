'use strict';
/**
 * FrotaGest — configurações do sistema guardadas no banco (editadas pelo master).
 * Reis Tecnologia
 */
const { HttpErro } = require('../util/comum');

const CHAVES = {
  aparelhos_nao_cadastrados: { padrao: 'listar', opcoes: ['listar', 'recusar'], titulo: 'Aparelhos sem cadastro' },
  retencao_posicoes_dias: { padrao: '90', min: 7, max: 1825, titulo: 'Guardar posições por (dias)' },
  retencao_eventos_dias: { padrao: '180', min: 7, max: 1825, titulo: 'Guardar comunicações por (dias)' },
  retencao_alertas_dias: { padrao: '365', min: 30, max: 3650, titulo: 'Guardar alertas por (dias)' },
  retencao_auditoria_dias: { padrao: '730', min: 180, max: 3650, titulo: 'Guardar auditoria por (dias)' },
  sessao_inatividade_min: { padrao: '60', min: 0, max: 1440, titulo: 'Encerrar a sessão sem uso após (minutos)' },
};

class Configuracoes {
  constructor(banco) {
    this.banco = banco;
    this.valores = new Map(Object.entries(CHAVES).map(([k, d]) => [k, d.padrao]));
  }

  async carregar() {
    const rows = await this.banco.query('SELECT chave, valor FROM configuracoes');
    for (const r of rows) if (CHAVES[r.chave]) this.valores.set(r.chave, r.valor);
  }

  get(chave) {
    return this.valores.get(chave);
  }

  numero(chave) {
    return Number(this.valores.get(chave)) || Number(CHAVES[chave].padrao);
  }

  /** Como numero(), mas aceitando 0 (ex.: 0 = nunca encerrar a sessão). */
  numeroOuZero(chave) {
    const n = Number(this.valores.get(chave));
    return Number.isFinite(n) ? n : Number(CHAVES[chave].padrao);
  }

  lista() {
    return Object.entries(CHAVES).map(([chave, d]) => ({ chave, valor: this.valores.get(chave), ...d }));
  }

  validar(chave, valor) {
    const d = CHAVES[chave];
    if (!d) throw new HttpErro(400, `Configuração desconhecida: ${chave}`);
    const v = String(valor ?? '').trim();
    if (d.opcoes) {
      if (!d.opcoes.includes(v)) throw new HttpErro(400, `${d.titulo}: valor inválido.`);
      return v;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < d.min || n > d.max) throw new HttpErro(400, `${d.titulo}: use um número entre ${d.min} e ${d.max}.`);
    return String(n);
  }

  async salvar(alteracoes, usuarioId) {
    const validas = Object.entries(alteracoes || {}).map(([k, v]) => [k, this.validar(k, v)]);
    for (const [k, v] of validas) {
      await this.banco.query(
        'INSERT INTO configuracoes (chave, valor, atualizado_por) VALUES (?, ?, ?) AS n ON DUPLICATE KEY UPDATE valor = n.valor, atualizado_por = n.atualizado_por',
        [k, v, usuarioId || null],
      );
      this.valores.set(k, v);
    }
    return validas.map(([k]) => k);
  }
}

module.exports = { Configuracoes, CHAVES };
