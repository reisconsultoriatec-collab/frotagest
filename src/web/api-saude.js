'use strict';
/**
 * FrotaGest — API da saúde dos aparelhos (na tela, em Excel e em PDF).
 * Reis Tecnologia
 */
const { HttpErro, validar: V, formatar } = require('../util/comum');
const { empresaAlvo } = require('../auth/acesso');
const { saudeDaFrota, TIPOS } = require('../servicos/saude');
const { gerarXlsx } = require('../relatorios/xlsx');
const { gerarPdf } = require('../relatorios/pdf');
const { fmtValor } = require('../relatorios/relatorios');

const GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
const sem = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** "Câmera: Perda de sinal de vídeo (canal 2)"; sem repetir quando o nome já diz o tipo ("Offline (há 3 dias)") */
const textoProblema = (p) => `${sem(p.nome).includes(sem(TIPOS[p.tipo]).split(' ')[0]) ? '' : `${TIPOS[p.tipo]}: `}${p.nome}${p.detalhe ? ` (${p.detalhe})` : ''}`;

function registrar(srv) {
  const { monitor, acesso, gateway, frota, auditoria } = srv;

  srv.rota('GET', '/api/saude-aparelhos', async ({ u, query, res, ip }) => {
    const formato = query.formato || 'json';
    if (!['json', 'xlsx', 'pdf'].includes(formato)) throw new HttpErro(400, 'Formato inválido.');
    let itens = monitor.lista(u, acesso).filter((i) => !i.pendente);
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    if (emp) itens = itens.filter((i) => i.empresaId === emp);
    if (query.grupo) {
      const g = frota.grupos.get(V.id(query.grupo, 'o grupo'));
      if (!g) throw new HttpErro(404, 'Grupo não encontrado.');
      const ids = new Set();
      const juntar = (id) => { ids.add(id); for (const f of frota.filhos.get(id) || []) juntar(f); };
      juntar(g.id);
      itens = itens.filter((i) => ids.has(i.grupoId));
    }
    const r = saudeDaFrota(itens, gateway);
    r.geradoEm = formatar(Date.now());
    if (formato === 'json') return r;

    // arquivo: por padrão só os aparelhos com problema (ou todos, com ?todos=1), e só um tipo se pedir
    let lista = query.todos === '1' ? r.aparelhos : r.aparelhos.filter((a) => a.problemas.length);
    if (query.tipo) {
      const tipos = String(query.tipo).split(',');
      lista = lista.filter((a) => a.problemas.some((p) => tipos.includes(p.tipo)));
    }
    const colunas = [
      { titulo: 'Veículo', tipo: 'texto', largura: 20, peso: 1.3 },
      { titulo: 'Aparelho', tipo: 'texto', largura: 22, peso: 1.25 },
      { titulo: 'Grupo', tipo: 'texto', largura: 20, peso: 1.2 },
      { titulo: 'Situação', tipo: 'texto', largura: 10, peso: 0.7 },
      { titulo: 'Última comunicação', tipo: 'dataHora', largura: 19, peso: 1.15 },
      { titulo: 'Sinal', tipo: 'inteiro', largura: 8, peso: 0.5, alinhar: 'd' },
      { titulo: 'Gravidade', tipo: 'texto', largura: 10, peso: 0.65 },
      { titulo: 'Problemas', tipo: 'texto', largura: 70, peso: 3.2 },
    ];
    const linhas = lista.map((a) => [
      a.veiculoId ? (a.prefixo ? `${a.prefixo} · ${a.placa}` : a.placa) : 'sem veículo',
      `${a.ident}${a.modelo ? ` (${a.modelo})` : ''}`,
      a.grupo || '',
      a.online ? 'Online' : 'Offline',
      a.ultimoContato,
      a.online ? a.sinal : null, // offline: o último sinal já não vale
      a.gravidade ? GRAV[a.gravidade] : 'OK',
      a.problemas.length ? a.problemas.map(textoProblema).join('; ') : 'Sem problemas',
    ]);
    const quem = emp ? (frota.empresas.get(emp) || {}).nome : (u.perfil === 'master' ? 'Todas as empresas' : u.empresaNome);
    const subtitulo = [`${quem} · ${lista.length} aparelho(s)${query.todos === '1' ? '' : ' com problema'}`, `Situação em ${fmtValor(r.geradoEm, 'dataHora')}`];
    const titulo = 'Saúde dos aparelhos';
    const rel = {
      titulo, subtitulo, colunas, linhas, totais: null, geradoEm: r.geradoEm, geradoPor: u.nome,
      resumo: [
        { rotulo: 'Aparelhos', valor: String(r.resumo.total) },
        { rotulo: 'Funcionando', valor: String(r.resumo.ok) },
        { rotulo: 'Offline', valor: String(r.resumo.offline) },
        { rotulo: 'Câmera ou vídeo', valor: String(r.resumo.camera) },
        { rotulo: 'Cartão ou HD', valor: String(r.resumo.armazenamento) },
        { rotulo: 'GPS', valor: String(r.resumo.gps) },
      ],
    };
    const nome = `frotagest-saude-dos-aparelhos-${r.geradoEm.slice(0, 10)}.${formato}`;
    const corpo = formato === 'xlsx'
      ? gerarXlsx([{ nome: titulo, titulo: `${titulo} — FrotaGest`, subtitulo: [...subtitulo, `Gerado em ${fmtValor(r.geradoEm, 'dataHora').slice(0, 16)} por ${u.nome} · Reis Tecnologia`], colunas, linhas, totais: null }], { titulo })
      : gerarPdf({
        titulo, subtitulo, resumo: rel.resumo, colunas: colunas.map((c) => ({ titulo: c.titulo, peso: c.peso, alinhar: c.alinhar })),
        linhas: linhas.map((l) => l.map((v, i) => fmtValor(v, colunas[i].tipo))), totais: null,
        vazio: 'Nenhum aparelho com problema agora.', rodape: `FrotaGest · Reis Tecnologia · Gerado em ${fmtValor(r.geradoEm, 'dataHora').slice(0, 16)} por ${u.nome}`,
        logo: await srv.logotipos.paraPdf(emp),
      });
    await auditoria.registrar(u, 'exportar_relatorio', { descricao: `${titulo} (${formato === 'xlsx' ? 'Excel' : 'PDF'}) · ${subtitulo[0]}`, ip });
    srv.send(res, 200, corpo, formato === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf', {
      'Content-Disposition': `attachment; filename="${nome}"`,
    });
    return undefined;
  }, { pode: 'cadastros' });
}

module.exports = { registrar };
