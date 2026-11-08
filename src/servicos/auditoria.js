'use strict';
/**
 * FrotaGest — auditoria: quem fez o quê no painel (acessos, cadastros, vídeo, downloads, alertas).
 * Reis Tecnologia
 */
const { agora } = require('../util/comum');

class Auditoria {
  constructor(banco, log = () => {}) {
    this.banco = banco;
    this.log = log;
  }

  /** Nunca derruba a operação principal: se o banco falhar, só registra no log do servidor. */
  async registrar(u, acao, { entidade = null, entidadeId = null, descricao = null, ip = null, empresaId } = {}) {
    try {
      await this.banco.query(
        'INSERT INTO auditoria (data_hora, usuario_id, empresa_id, acao, entidade, entidade_id, descricao, ip) VALUES (?)',
        [[agora(), u ? u.id : null, empresaId !== undefined ? empresaId : (u ? u.empresaId : null), acao, entidade,
          entidadeId === null ? null : String(entidadeId), descricao ? String(descricao).slice(0, 500) : null, ip]],
      );
    } catch (e) {
      this.log('erro', `Falha ao gravar auditoria (${acao}): ${e.message}`);
    }
  }
}

module.exports = { Auditoria };
