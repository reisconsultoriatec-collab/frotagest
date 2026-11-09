'use strict';
/**
 * FrotaGest — API dos relatórios: na tela (JSON), em Excel (.xlsx) e em PDF.
 * Reis Tecnologia
 */
const { HttpErro } = require('../util/comum');
const { TIPOS, paraXlsx, paraPdf } = require('../relatorios/relatorios');
const { gerarXlsx } = require('../relatorios/xlsx');
const { gerarPdf } = require('../relatorios/pdf');

const NA_TELA = 2000; // linhas mostradas na tela; o arquivo leva todas

function registrar(srv) {
  const { relatorios, auditoria } = srv;

  srv.rota('GET', '/api/relatorios', async () => ({
    tipos: Object.entries(TIPOS).map(([id, t]) => ({ id, titulo: t.titulo })),
  }));

  srv.rota('GET', '/api/relatorios/:tipo', async ({ u, params, query, res, ip }) => {
    const formato = query.formato || 'json';
    if (!['json', 'xlsx', 'pdf'].includes(formato)) throw new HttpErro(400, 'Formato inválido.');
    const rel = await relatorios.gerar(u, params.tipo, query);
    if (formato === 'json') {
      return { ...rel, linhas: rel.linhas.slice(0, NA_TELA), totalLinhas: rel.linhas.length, naTela: NA_TELA };
    }
    const dia = String(query.de || '').slice(0, 10);
    const nome = `frotagest-${rel.arquivo}-${dia}.${formato}`;
    const corpo = formato === 'xlsx' ? gerarXlsx(paraXlsx(rel), { titulo: rel.titulo }) : gerarPdf(paraPdf(rel));
    await auditoria.registrar(u, 'exportar_relatorio', {
      descricao: `${rel.titulo} (${formato === 'xlsx' ? 'Excel' : 'PDF'}) · ${rel.subtitulo.join(' · ')} · ${rel.linhas.length} linha(s)`,
      ip, empresaId: query.empresa ? Number(query.empresa) || null : undefined,
    });
    srv.send(res, 200, corpo, formato === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf', {
      'Content-Disposition': `attachment; filename="${nome}"`,
    });
    return undefined;
  });
}

module.exports = { registrar };
