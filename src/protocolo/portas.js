'use strict';
/**
 * FrotaGest — abre e fecha portas TCP conforme a lista desejada (perfis de protocolo).
 * Reis Tecnologia
 */
const net = require('net');

/**
 * alvo.servidores: Map(porta → net.Server). Portas fora da lista são fechadas (e as conexões
 * delas encerradas por aoFechar); portas novas são abertas. Uma porta que falha não derruba as outras.
 */
async function sincronizarPortas(alvo, portas, host, aoConectar, aoFechar) {
  const desejadas = new Set(portas.filter((p) => Number.isInteger(p) && p > 0 && p < 65536));
  const resultado = [];
  for (const [porta, srv] of alvo.servidores) {
    if (desejadas.has(porta)) continue;
    alvo.servidores.delete(porta);
    srv.close();
    if (aoFechar) aoFechar(porta);
    resultado.push({ porta, ok: true, fechada: true });
  }
  for (const porta of desejadas) {
    if (alvo.servidores.has(porta)) { resultado.push({ porta, ok: true }); continue; }
    const srv = net.createServer(aoConectar);
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(porta, host, () => { srv.removeListener('error', reject); resolve(); });
      });
      srv.on('error', () => {});
      alvo.servidores.set(porta, srv);
      resultado.push({ porta, ok: true, aberta: true });
    } catch (e) {
      resultado.push({ porta, ok: false, erro: e.code === 'EADDRINUSE' ? 'porta já usada por outro programa' : e.code === 'EACCES' ? 'sem permissão para usar a porta' : e.message });
    }
  }
  return resultado;
}

module.exports = { sincronizarPortas };
