'use strict';
/* FrotaGest — Relatórios: resumo por veículo, excessos de velocidade, paradas e alertas, na tela,
 * em Excel e em PDF (os arquivos são gerados pelo servidor). Reis Tecnologia */

PAGINAS.relatorios = (() => {
  const TIPOS = [
    { id: 'resumo', nome: 'Resumo por veículo', ico: 'list-details', desc: 'Km rodados, tempo ligado, em movimento e parado, velocidades, excessos, paradas e alertas.' },
    { id: 'velocidade', nome: 'Excessos de velocidade', ico: 'gauge', desc: 'Cada trecho acima do limite: início, fim, duração, velocidade máxima e local.' },
    { id: 'paradas', nome: 'Paradas', ico: 'clock-pause', desc: 'Onde e por quanto tempo cada veículo ficou parado, com o motor ligado ou desligado.' },
    { id: 'alertas', nome: 'Alertas', ico: 'bell-ringing', desc: 'Alertas do período com a gravidade, a situação e o tratamento registrado.' },
  ];
  const f = { tipo: 'resumo', de: '', ate: '', grupo: '', veiculo: '', limite: '80', minutos: '5', gravidade: '', situacao: '' };
  let seq = 0;
  let offs = [];

  const fmtHms = (s) => {
    if (s === null || s === undefined || s === '') return '';
    const t = Math.max(0, Math.round(Number(s)));
    return `${Math.floor(t / 3600)}:${p2(Math.floor((t % 3600) / 60))}:${p2(t % 60)}`;
  };
  function celula(v, tipo) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string' && tipo !== 'texto' && tipo !== 'dataHora') return H(v);
    switch (tipo) {
      case 'inteiro': return fmtNum(v);
      case 'decimal': return fmtNum(v, 1);
      case 'dataHora': return H(fmtDataHora(v));
      case 'duracao': return fmtHms(v);
      default: return H(v);
    }
  }

  function opcoesGrupo() {
    const lista = S.grupos.filter((g) => !S.empresa || String(g.empresaId) === String(S.empresa));
    return `<option value="">Todos os grupos</option>${lista.map((g) => `<option value="${g.id}">${H(g.caminho)}</option>`).join('')}`;
  }

  function opcoesVeic() {
    const grupos = new Set();
    if (f.grupo) {
      const juntar = (id) => { grupos.add(String(id)); S.grupos.filter((g) => String(g.paiId) === String(id)).forEach((g) => juntar(g.id)); };
      juntar(f.grupo);
    }
    const lista = itensVisiveis().filter((i) => i.veiculoId && (!f.grupo || grupos.has(String(i.grupoId))))
      .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
    return `<option value="">Todos os veículos${lista.length ? ` (${lista.length})` : ''}</option>${lista.map((i) => `<option value="${i.veiculoId}">${H(rotulo(i))}</option>`).join('')}`;
  }

  function render(c, params) {
    if (params.tipo && TIPOS.some((t) => t.id === params.tipo)) f.tipo = params.tipo;
    if (!f.de) {
      f.de = `${textoServidor().slice(0, 10)} 00:00:00`;
      f.ate = `${textoServidor().slice(0, 10)} 23:59:59`;
    }
    c.innerHTML = `
      <div class="page">
        <div class="rel-tipos" id="rl-tipos" role="tablist">${TIPOS.map((t) => `
          <button class="rel-tipo${t.id === f.tipo ? ' active' : ''}" type="button" role="tab" aria-selected="${t.id === f.tipo}" data-tipo="${t.id}">
            <span class="rel-tipo-ico">${ico(t.ico)}</span><span><b>${H(t.nome)}</b><small>${H(t.desc)}</small></span></button>`).join('')}</div>
        <section class="card">
          <div class="toolbar rel-filtros">
            <label class="field">De<input type="datetime-local" id="rl-de"></label>
            <label class="field">Até<input type="datetime-local" id="rl-ate"></label>
            <div class="seg" id="rl-rapido"><button class="seg-btn" type="button" data-p="hoje">Hoje</button><button class="seg-btn" type="button" data-p="ontem">Ontem</button><button class="seg-btn" type="button" data-p="7">7 dias</button><button class="seg-btn" type="button" data-p="mes">Este mês</button></div>
            <label class="field">Grupo<select id="rl-grupo"></select></label>
            <label class="field">Veículo<select id="rl-veic"></select></label>
            <label class="field" data-so="resumo velocidade">Limite (km/h)<input type="number" id="rl-limite" min="20" max="200" step="5" style="width:110px"></label>
            <label class="field" data-so="resumo paradas">Parada mínima (min)<input type="number" id="rl-min" min="1" max="720" style="width:130px"></label>
            <label class="field" data-so="alertas">Gravidade<select id="rl-grav"><option value="">Todas</option><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></select></label>
            <label class="field" data-so="alertas">Situação<select id="rl-sit"><option value="">Todas</option><option value="pendentes">Pendentes</option><option value="tratado">Tratados</option></select></label>
          </div>
          <div class="rel-acoes">
            <p class="hint" id="rl-status">Escolha o período e clique em Gerar. Posições: até 31 dias (com muitos veículos, menos dias). Alertas: até 92 dias.</p>
            <div class="grow"></div>
            <button class="btn btn-primary" type="button" id="rl-gerar">${ico('player-play', 'i-sm')} Gerar relatório</button>
            <button class="btn" type="button" id="rl-xlsx" title="Baixar em Excel (.xlsx)">${ico('file-spreadsheet', 'i-sm')} Excel</button>
            <button class="btn" type="button" id="rl-pdf" title="Baixar em PDF">${ico('file-type-pdf', 'i-sm')} PDF</button>
          </div>
        </section>
        <div class="kpis" id="rl-kpis" hidden></div>
        <section class="card" id="rl-res" hidden>
          <div class="card-head"><h2 id="rl-titulo"></h2><span class="count" id="rl-n"></span></div>
          <p class="hint rel-sub" id="rl-sub"></p>
          <div class="table-wrap tall" id="rl-tabela"></div>
          <p class="hint rel-obs" id="rl-obs"></p>
        </section>
      </div>`;
    $('#rl-de').value = paraInput(f.de);
    $('#rl-ate').value = paraInput(f.ate);
    $('#rl-grupo').innerHTML = opcoesGrupo();
    $('#rl-grupo').value = f.grupo;
    $('#rl-veic').innerHTML = opcoesVeic();
    $('#rl-veic').value = f.veiculo;
    $('#rl-limite').value = f.limite;
    $('#rl-min').value = f.minutos;
    $('#rl-grav').value = f.gravidade;
    $('#rl-sit').value = f.situacao;
    mostrarCampos();

    $('#rl-tipos').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tipo]');
      if (!b || b.dataset.tipo === f.tipo) return;
      f.tipo = b.dataset.tipo;
      $$('#rl-tipos .rel-tipo').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
      mostrarCampos();
      limpar();
    });
    $('#rl-rapido').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      const hoje = textoServidor().slice(0, 10);
      const dia = (ms) => textoServidor(ms).slice(0, 10);
      if (b.dataset.p === 'hoje') { f.de = `${hoje} 00:00:00`; f.ate = `${hoje} 23:59:59`; }
      if (b.dataset.p === 'ontem') { const d = dia(Date.now() - 86400000); f.de = `${d} 00:00:00`; f.ate = `${d} 23:59:59`; }
      if (b.dataset.p === '7') { f.de = `${dia(Date.now() - 6 * 86400000)} 00:00:00`; f.ate = `${hoje} 23:59:59`; }
      if (b.dataset.p === 'mes') { f.de = `${hoje.slice(0, 8)}01 00:00:00`; f.ate = `${hoje} 23:59:59`; }
      $('#rl-de').value = paraInput(f.de);
      $('#rl-ate').value = paraInput(f.ate);
    });
    $('#rl-grupo').addEventListener('change', () => {
      f.grupo = $('#rl-grupo').value;
      f.veiculo = '';
      $('#rl-veic').innerHTML = opcoesVeic();
    });
    $('#rl-gerar').addEventListener('click', gerar);
    $('#rl-xlsx').addEventListener('click', () => baixar('xlsx'));
    $('#rl-pdf').addEventListener('click', () => baixar('pdf'));
    // a empresa escolhida no topo mudou: grupos e veículos mudam junto
    offs.push(on('empresa', () => { f.grupo = ''; f.veiculo = ''; }));
    offs.push(on('frota', () => {
      if (!$('#rl-veic')) return;
      const v = $('#rl-veic').value;
      $('#rl-veic').innerHTML = opcoesVeic();
      $('#rl-veic').value = v;
    }));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    seq++;
  }

  function mostrarCampos() {
    $$('[data-so]').forEach((el) => { el.hidden = !el.dataset.so.split(' ').includes(f.tipo); });
  }

  function limpar() {
    $('#rl-kpis').hidden = true;
    $('#rl-res').hidden = true;
    $('#rl-status').textContent = 'Escolha o período e clique em Gerar.';
  }

  function lerFiltros() {
    f.de = deInput($('#rl-de').value);
    f.ate = deInput($('#rl-ate').value, true);
    f.grupo = $('#rl-grupo').value;
    f.veiculo = $('#rl-veic').value;
    f.limite = $('#rl-limite').value;
    f.minutos = $('#rl-min').value;
    f.gravidade = $('#rl-grav').value;
    f.situacao = $('#rl-sit').value;
    if (!f.de || !f.ate) throw new Error('Preencha o período.');
    const q = { de: f.de, ate: f.ate, empresa: S.empresa, grupo: f.grupo, veiculo: f.veiculo };
    if (f.tipo === 'resumo' || f.tipo === 'velocidade') q.limite = f.limite;
    if (f.tipo === 'resumo' || f.tipo === 'paradas') q.minutos = f.minutos;
    if (f.tipo === 'alertas') { q.gravidade = f.gravidade; q.situacao = f.situacao; }
    return `/api/relatorios/${f.tipo}?${qs(q)}`;
  }

  function ocupado(sim, texto) {
    for (const id of ['#rl-gerar', '#rl-xlsx', '#rl-pdf']) $(id).disabled = sim;
    if (texto !== undefined) $('#rl-status').innerHTML = texto;
  }

  async function gerar() {
    let url;
    try { url = lerFiltros(); } catch (e) { $('#rl-status').textContent = e.message; return; }
    const meu = ++seq;
    ocupado(true, '<span class="spinner spinner-sm"></span> Gerando o relatório… com muitos veículos pode levar alguns segundos.');
    try {
      const r = await api(url);
      if (meu !== seq) return;
      mostrar(r);
      ocupado(false, `Gerado em ${H(fmtDataHora(r.geradoEm).slice(0, 16))}. Para guardar ou enviar, baixe em Excel ou PDF.`);
    } catch (e) {
      if (meu !== seq) return;
      ocupado(false, `<span style="color:var(--err)">${H(e.message)}</span>`);
    }
  }

  async function baixar(formato) {
    let url;
    try { url = lerFiltros(); } catch (e) { $('#rl-status').textContent = e.message; return; }
    ocupado(true, `<span class="spinner spinner-sm"></span> Preparando o ${formato === 'pdf' ? 'PDF' : 'Excel'}…`);
    try {
      const nome = await baixarArquivo(`${url}&formato=${formato}`, `frotagest-relatorio.${formato}`);
      ocupado(false, `Arquivo <b>${H(nome)}</b> baixado.`);
    } catch (e) {
      ocupado(false, `<span style="color:var(--err)">${H(e.message)}</span>`);
    }
  }

  function mostrar(r) {
    const k = $('#rl-kpis');
    k.innerHTML = r.resumo.map((q, i) => `<div class="kpi ${['', 'ok', 'neutral', 'warn', 'err', 'neutral'][i] || ''}"><div class="kpi-body"><div class="kpi-label">${H(q.rotulo)}</div><div class="kpi-value rel-kpi">${H(q.valor)}</div></div></div>`).join('');
    k.style.gridTemplateColumns = `repeat(${Math.min(r.resumo.length, 6)}, minmax(0, 1fr))`;
    k.hidden = false;
    $('#rl-titulo').innerHTML = `${ico(TIPOS.find((t) => t.id === r.tipo).ico)} ${H(r.titulo)}`;
    $('#rl-sub').textContent = r.subtitulo.join(' · ');
    $('#rl-n').textContent = r.totalLinhas > r.linhas.length
      ? `mostrando ${fmtNum(r.linhas.length)} de ${fmtNum(r.totalLinhas)} linhas · o arquivo traz todas`
      : `${fmtNum(r.totalLinhas)} linha${r.totalLinhas === 1 ? '' : 's'}`;
    const cls = (c) => (c.alinhar === 'd' ? 'num' : '');
    const corpo = r.linhas.length
      ? r.linhas.map((l) => `<tr>${r.colunas.map((c, i) => `<td class="${cls(c)}">${celula(l[i], c.tipo)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${r.colunas.length}">${H(r.vazio || 'Nenhum registro no período.')}</td></tr>`;
    const totais = r.totais && r.linhas.length ? `<tfoot><tr>${r.colunas.map((c, i) => `<td class="${cls(c)}">${celula(r.totais[i], c.tipo)}</td>`).join('')}</tr></tfoot>` : '';
    $('#rl-tabela').innerHTML = `<table class="tbl rel-tbl"><thead><tr>${r.colunas.map((c) => `<th class="${cls(c)}">${H(c.titulo)}</th>`).join('')}</tr></thead><tbody>${corpo}</tbody>${totais}</table>`;
    $('#rl-obs').textContent = r.observacao || '';
    $('#rl-obs').hidden = !r.observacao;
    $('#rl-res').hidden = false;
  }

  return { id: 'relatorios', titulo: 'Relatórios', sub: 'Resumo da frota, velocidade, paradas e alertas em Excel e PDF', render, sair };
})();
