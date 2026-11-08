'use strict';
/**
 * FrotaGest — limpeza do histórico antigo, conforme os prazos em Sistema › Configurações.
 * Apaga em blocos pequenos para não travar o banco; roda de madrugada (e uma vez ao iniciar).
 * Reis Tecnologia
 */
const { formatar } = require('../util/comum');

const BLOCO = 5000;
const TABELAS = [
  ['posicoes', 'data_hora', 'retencao_posicoes_dias'],
  ['eventos_aparelho', 'data_hora', 'retencao_eventos_dias'],
  ['comandos', 'enviado_em', 'retencao_eventos_dias'],
  ['alertas', 'inicio', 'retencao_alertas_dias'],
  ['auditoria', 'data_hora', 'retencao_auditoria_dias'],
];

class Retencao {
  constructor(banco, config, log = () => {}) {
    this.banco = banco;
    this.config = config;
    this.log = log;
    this.rodando = false;
    this.ultima = null;
  }

  iniciar() {
    setTimeout(() => this.rodar(), 60000).unref();
    // confere a cada hora; executa uma vez por dia, entre 3h e 4h
    this.timer = setInterval(() => {
      const hora = Number(formatar().slice(11, 13));
      const hoje = formatar().slice(0, 10);
      if (hora === 3 && this.diaFeito !== hoje) this.rodar();
    }, 3600000);
    this.timer.unref();
  }

  async rodar() {
    if (this.rodando) return null;
    this.rodando = true;
    const resumo = {};
    try {
      for (const [tabela, coluna, chave] of TABELAS) {
        const dias = this.config.numero(chave);
        const limite = formatar(Date.now() - dias * 86400000);
        let total = 0;
        for (;;) {
          const r = await this.banco.query(`DELETE FROM ${tabela} WHERE ${coluna} < ? LIMIT ${BLOCO}`, [limite]);
          total += r.affectedRows;
          if (r.affectedRows < BLOCO) break;
          await new Promise((ok) => setTimeout(ok, 200));
        }
        if (total) resumo[tabela] = total;
      }
      const pend = await this.banco.query('DELETE FROM aparelhos_pendentes WHERE ultimo_contato < ?', [formatar(Date.now() - 30 * 86400000)]);
      if (pend.affectedRows) resumo.aparelhos_pendentes = pend.affectedRows;
      this.diaFeito = formatar().slice(0, 10);
      this.ultima = { em: Date.now(), resumo };
      const partes = Object.entries(resumo).map(([t, n]) => `${t}: ${n}`);
      if (partes.length) this.log('info', `Limpeza do histórico antigo concluída (${partes.join(', ')})`);
      return resumo;
    } catch (e) {
      this.log('erro', `Limpeza do histórico falhou: ${e.message}`);
      return null;
    } finally {
      this.rodando = false;
    }
  }
}

module.exports = { Retencao };
