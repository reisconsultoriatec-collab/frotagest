'use strict';
/**
 * FrotaGest — dados do dashboard do Início: km, tempos e alertas de hoje por veículo e os últimos dias.
 * Só os veículos que a pessoa enxerga (empresa e grupos); os alertas só para quem tem o menu Alertas.
 * Reis Tecnologia
 */
const { validar: V } = require('../util/comum');
const { empresaAlvo, permite } = require('../auth/acesso');

function registrar(srv) {
  const { frota, acesso, painel } = srv;

  srv.rota('GET', '/api/painel', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const veiculos = [...frota.veiculos.values()].filter((v) => v.ativo && (!emp || v.empresa_id === emp) && acesso.veVeiculo(u, v));
    return painel.resumo(veiculos, { alertas: permite(u, 'alertas') });
  }, { limite: { chave: 'painel', max: 1500, minutos: 10 } }); // uma central com várias telas sai pelo mesmo IP
}

module.exports = { registrar };
