'use strict';
/* FrotaGest — Alertas: lista com filtros e registro do tratamento. Reis Tecnologia */

const SITUACOES = { novo: 'Novo', em_tratamento: 'Em tratamento', tratado: 'Tratado' };

PAGINAS.alertas = (() => {
  let offs = [];
  let dados = [];
  let timer = null;
  const f = { situacao: 'pendentes', gravidade: '', veiculo: '', de: '', ate: '' };

  function render(c, params) {
    if (params.situacao) f.situacao = params.situacao;
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="toolbar">
            <label class="field">Situação<select id="al-sit">
              <option value="pendentes">Pendentes (novos e em tratamento)</option><option value="novo">Novos</option>
              <option value="em_tratamento">Em tratamento</option><option value="tratado">Tratados</option><option value="">Todos</option></select></label>
            <label class="field">Gravidade<select id="al-grav"><option value="">Todas</option><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></select></label>
            <label class="field">Veículo<select id="al-veic"></select></label>
            <label class="field">De<input type="datetime-local" id="al-de"></label>
            <label class="field">Até<input type="datetime-local" id="al-ate"></label>
            <div class="grow"></div>
            <button class="btn" type="button" id="al-som" title="Som e notificação quando chegar alerta novo">${ico('volume', 'i-sm')} Som e avisos</button>
            <button class="btn" type="button" id="al-csv">${ico('download', 'i-sm')} CSV</button>
          </div>
          <div class="card-head" style="border-bottom:0;padding-bottom:6px"><span class="count" id="al-total"></span></div>
          <div class="table-wrap tall" id="al-tabela"></div>
        </section>
      </div>`;
    $('#al-sit').value = f.situacao;
    $('#al-grav').value = f.gravidade;
    $('#al-veic').innerHTML = opcoesVeiculos(f.veiculo, { soComAparelho: false, vazio: 'Todos' });
    $('#al-de').value = paraInput(f.de);
    $('#al-ate').value = paraInput(f.ate);
    $('#al-som').addEventListener('click', (e) => { e.stopPropagation(); abrirMenuSom(); });
    const mudar = () => {
      f.situacao = $('#al-sit').value;
      f.gravidade = $('#al-grav').value;
      f.veiculo = $('#al-veic').value;
      f.de = deInput($('#al-de').value);
      f.ate = deInput($('#al-ate').value, true);
      carregar();
    };
    for (const id of ['#al-sit', '#al-grav', '#al-veic', '#al-de', '#al-ate']) $(id).addEventListener('change', mudar);
    $('#al-csv').addEventListener('click', exportar);
    $('#al-tabela').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tratar]');
      if (t) { tratar(dados.find((a) => String(a.id) === t.dataset.tratar)); return; }
      const v = e.target.closest('[data-ver]');
      if (v) navegar('mapa', qs({ v: v.dataset.ver }));
    });
    carregar();
    offs.push(on('alerta', () => { clearTimeout(timer); timer = setTimeout(carregar, 1000); }));
  }

  function sair() {
    offs.forEach((x) => x());
    offs = [];
    clearTimeout(timer);
  }

  let seq = 0;
  async function carregar() {
    const minha = ++seq; // filtro trocado no meio: só a última busca desenha a tabela
    const it = f.veiculo ? S.itens.get(f.veiculo) : null;
    const box = $('#al-tabela');
    try {
      if ((f.de && !f.ate) || (!f.de && f.ate)) { $('#al-total').textContent = 'Preencha as duas datas para filtrar por período.'; return; }
      const r = await api(`/api/alertas?${qs({ situacao: f.situacao, gravidade: f.gravidade, veiculo: it ? it.veiculoId : '', de: f.de, ate: f.ate, empresa: S.empresa, limite: 500 })}`);
      if (minha !== seq) return;
      dados = r.alertas;
      $('#al-total').textContent = `${fmtNum(r.total)} alerta(s)${r.total > dados.length ? ` · mostrando os ${dados.length} mais recentes` : ''}`;
    } catch (e) {
      if (minha !== seq) return;
      dados = [];
      $('#al-total').textContent = e.message;
    }
    if (!box) return;
    const master = S.eu.perfil === 'master';
    box.innerHTML = tabela([
      { t: 'Gravidade', v: (a) => `<span class="tag ${a.gravidade}">${H(NOMES_GRAVIDADE[a.gravidade])}</span>` },
      { t: 'Alerta', v: (a) => `<b>${H(a.nome)}</b>${a.velocidade !== null ? `<span class="sub">${fmtNum(a.velocidade)} km/h</span>` : ''}` },
      { t: 'Veículo', v: (a) => `${H(a.placa ? `${a.prefixo ? `${a.prefixo} · ` : ''}${a.placa}` : `Aparelho ${a.identificador}`)}${master ? `<span class="sub">${H(a.empresa || '')}</span>` : ''}` },
      { t: 'Início', cls: 'nw', v: (a) => H(fmtDataHora(a.inicio)) },
      { t: 'Fim', cls: 'nw', v: (a) => (a.fim ? H(fmtDataHora(a.fim)) : '<span class="tag err">ativo</span>') },
      { t: 'Situação', v: (a) => `<span class="tag ${a.situacao === 'tratado' ? 'ok' : a.situacao === 'novo' ? 'novo' : 'wait'}">${H(SITUACOES[a.situacao])}</span>${a.tratado_por_nome ? `<span class="sub">${H(a.tratado_por_nome)} · ${H(fmtCurto(a.tratado_em))}</span>` : ''}${a.tratativa ? `<span class="sub">${H(a.tratativa)}</span>` : ''}` },
      {
        t: '', cls: 'acts', v: (a) => {
          const item = [...S.itens.values()].find((i) => i.aparelhoId === a.aparelho_id);
          return `${item ? `<button class="btn" type="button" data-ver="${H(item.chave)}">${ico('map-pin', 'i-sm')} Mapa</button>` : ''}${S.eu.pode.tratarAlertas && a.situacao !== 'tratado' ? `<button class="btn btn-primary" type="button" data-tratar="${a.id}">Tratar</button>` : ''}`;
        },
      },
    ], dados, { vazio: f.situacao === 'pendentes' ? 'Nenhum alerta pendente.' : 'Nenhum alerta com esses filtros.' });
  }

  function tratar(a) {
    if (!a) return;
    formulario({
      titulo: `Tratar alerta: ${a.nome}`,
      icone: 'bell-ringing',
      tamanho: 'sm',
      aviso: `${H(a.placa || `Aparelho ${a.identificador}`)} · início ${H(fmtDataHora(a.inicio))}${a.fim ? ` · fim ${H(fmtDataHora(a.fim))}` : ' · ainda ativo'}`,
      campos: [
        { nome: 'situacao', rotulo: 'Situação', tipo: 'select', cheio: true, opcoes: [{ v: 'em_tratamento', t: 'Em tratamento' }, { v: 'tratado', t: 'Tratado (encerrar)' }] },
        { nome: 'tratativa', rotulo: 'O que foi feito', tipo: 'textarea', ajuda: 'Obrigatório para encerrar. Ex.: contato com o motorista, ocorrência registrada…' },
      ],
      valores: { situacao: a.situacao === 'em_tratamento' ? 'tratado' : 'em_tratamento', tratativa: a.tratativa || '' },
      salvar: async (d) => {
        await api(`/api/alertas/${a.id}/tratar`, { corpo: d });
        toast('Alerta atualizado.', 'ok');
        atualizarResumoAlertas();
        carregar();
      },
    });
  }

  function exportar() {
    const linhas = [['Gravidade', 'Alerta', 'Placa', 'Prefixo', 'Aparelho', 'Empresa', 'Início', 'Fim', 'Situação', 'Tratado por', 'Tratado em', 'Tratamento', 'Latitude', 'Longitude', 'Velocidade']];
    for (const a of dados) linhas.push([a.gravidade, a.nome, a.placa, a.prefixo, a.identificador, a.empresa, a.inicio, a.fim, SITUACOES[a.situacao], a.tratado_por_nome, a.tratado_em, a.tratativa, a.latitude, a.longitude, a.velocidade]);
    baixarCsv(`alertas-${textoServidor().slice(0, 10)}.csv`, linhas);
  }

  return { id: 'alertas', titulo: 'Alertas', sub: 'Alarmes enviados pelos aparelhos e o tratamento de cada um', render, sair };
})();
