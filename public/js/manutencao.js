'use strict';
/* FrotaGest — Manutenção e documentos: planos de manutenção por km e/ou tempo, manutenções feitas e
 * documentos com vencimento (do veículo e do motorista; a CNH vem do cadastro do motorista).
 * Tudo opcional: sem nada cadastrado, nada aparece nem é cobrado. Reis Tecnologia */

const ESTADOS_MANUT = { vencido: ['err', 'Vencido'], perto: ['wait', 'Vence em breve'], ok: ['ok', 'Em dia'] };
const TIPOS_ITEM_MANUT = { manutencao: ['tool', 'Manutenção'], documento: ['file-certificate', 'Documento'], cnh: ['id-badge-2', 'CNH'] };
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const reais = (v) => (v === null || v === undefined ? '' : `R$ ${fmtNum(v, 2)}`);

/** "faltam 12 dias (23/11/2026)", "venceu há 3 dias", "vence hoje". */
function textoPrazo(faltaDias, data) {
  if (faltaDias === null || faltaDias === undefined) return '';
  const d = data ? ` (${dataBr(data)})` : '';
  if (faltaDias < 0) return `venceu há ${-faltaDias} dia${faltaDias === -1 ? '' : 's'}${d}`;
  if (faltaDias === 0) return `vence hoje${d}`;
  return `vence em ${faltaDias} dia${faltaDias === 1 ? '' : 's'}${d}`;
}

/** Linha de detalhe de um item da situação. */
function detalheItemManut(x) {
  if (x.tipo !== 'manutencao') return textoPrazo(x.faltaDias, x.vencimento);
  const p = [];
  if (x.intervaloKm) {
    p.push(x.faltaKm < 0 ? `rodou ${fmtNum(x.kmDesde)} km (passou ${fmtNum(-x.faltaKm)} km do limite)`
      : x.faltaKm === 0 ? `rodou ${fmtNum(x.kmDesde)} km (chegou ao limite)` : `rodou ${fmtNum(x.kmDesde)} de ${fmtNum(x.intervaloKm)} km (faltam ${fmtNum(x.faltaKm)})`);
  }
  if (x.proximaData) p.push(textoPrazo(x.faltaDias, x.proximaData));
  return p.join(' · ');
}

function baseItemManut(x) {
  if (x.tipo !== 'manutencao') return x.numero ? `nº ${x.numero}` : '';
  const b = x.base.origem === 'feita' ? `última em ${dataBr(x.base.data)}${x.base.hodometro !== null ? ` com ${fmtNum(x.base.hodometro)} km` : ''}` : `contando desde ${dataBr(x.base.data)} (nenhuma registrada)`;
  return `${b}${x.hodometroEstimado !== null ? ` · hodômetro estimado ${fmtNum(x.hodometroEstimado)} km` : ''}`;
}

PAGINAS.manutencao = (() => {
  const f = { aba: 'situacao', estado: 'atencao', busca: '' };
  let dados = null;
  let offs = [];
  let seq = 0;

  const ABAS = [['situacao', 'Situação', 'list-check'], ['planos', 'Planos de manutenção', 'tool'], ['documentos', 'Documentos', 'file-certificate'], ['feitas', 'Manutenções feitas', 'history']];

  function render(c, params) {
    if (params.aba && ABAS.some(([id]) => id === params.aba)) f.aba = params.aba;
    c.innerHTML = `
      <div class="page">
        <div class="kpis mn-kpis" id="mn-kpis" hidden></div>
        <section class="card">
          <div class="tabs" id="mn-abas">${ABAS.map(([id, t, i]) => `<button class="tab${id === f.aba ? ' active' : ''}" type="button" data-aba="${id}">${ico(i, 'i-sm')} ${H(t)}</button>`).join('')}</div>
          <div id="mn-corpo"><p class="hint">Carregando…</p></div>
        </section>
      </div>`;
    $('#mn-abas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aba]');
      if (!b) return;
      f.aba = b.dataset.aba;
      $$('#mn-abas .tab').forEach((x) => x.classList.toggle('active', x === b));
      desenhar();
    });
    $('#mn-kpis').addEventListener('click', (e) => {
      const k = e.target.closest('[data-estado]');
      if (!k) return;
      f.aba = 'situacao';
      f.estado = k.dataset.estado;
      $$('#mn-abas .tab').forEach((x) => x.classList.toggle('active', x.dataset.aba === 'situacao'));
      desenhar();
    });
    $('#mn-corpo').addEventListener('click', clique);
    carregar();
    offs.push(on('empresa', carregar));
    offs.push(on('manutencao', carregar));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    seq++;
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const r = await api(`/api/manutencao${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      if (meu !== seq || !$('#mn-corpo')) return;
      dados = r;
      desenharKpis();
      desenhar();
    } catch (e) {
      if (meu === seq && $('#mn-corpo')) $('#mn-corpo').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  function desenharKpis() {
    const r = dados.resumo;
    // nada cadastrado: sem números (a tela só explica para que serve)
    $('#mn-kpis').hidden = !dados.cadastrado;
    const tile = (estado, ico0, rotulo, valor, sub, cls) => `<div class="kpi ${estado ? 'clic ' : ''}${cls}" ${estado ? `data-estado="${estado}" role="button" tabindex="0"` : ''}><div class="kpi-ico">${ico(ico0)}</div><div class="kpi-body"><div class="kpi-label">${H(rotulo)}</div><div class="kpi-value">${valor}</div><div class="kpi-sub">${H(sub)}</div></div></div>`;
    $('#mn-kpis').innerHTML = tile('vencido', 'alert-triangle', 'Vencidos', fmtNum(r.vencidos), r.vencidos ? 'manutenção ou documento atrasado' : 'nada atrasado', r.vencidos ? 'err' : 'ok')
      + tile('perto', 'clock-exclamation', 'Vencem em breve', fmtNum(r.perto), r.perto ? 'dentro do prazo de aviso' : 'nada nos próximos dias', r.perto ? 'warn' : 'ok')
      + tile('ok', 'circle-check', 'Em dia', fmtNum(r.emDia), 'planos, documentos e CNHs', 'neutral')
      + tile('', 'receipt', 'Gasto no mês', r.custoMes ? `<small style="margin:0 3px 0 0">R$</small>${fmtNum(r.custoMes, 2)}` : '—', 'manutenções registradas com custo', 'neutral');
  }

  function desenhar() {
    const box = $('#mn-corpo');
    if (!box || !dados) return;
    if (f.aba === 'situacao') box.innerHTML = htmlSituacao();
    else if (f.aba === 'planos') box.innerHTML = htmlPlanos();
    else if (f.aba === 'documentos') box.innerHTML = htmlDocumentos();
    else box.innerHTML = htmlFeitas();
    const b = $('#mn-busca');
    if (b) {
      b.value = f.busca;
      b.addEventListener('input', () => { f.busca = b.value; const t = $('#mn-tabela'); if (t) t.innerHTML = tabelaAba(); });
    }
    const est = $('#mn-estado');
    if (est) est.addEventListener('click', (e) => { const x = e.target.closest('[data-e]'); if (!x) return; f.estado = x.dataset.e; desenhar(); });
  }

  const podeIncluir = () => podeTela('manutencao', 'incluir');
  const podeAlterar = () => podeTela('manutencao', 'alterar');
  const confere = (texto) => !f.busca || norm(texto).includes(norm(f.busca));

  /* ---------- situação ---------- */

  function htmlSituacao() {
    if (!dados.cadastrado) {
      return `<div class="mn-vazio">
        <div class="mn-vazio-ico">${ico('tool')}</div>
        <h3>Nada cadastrado — e está tudo bem assim</h3>
        <p>Esta tela é opcional. Cadastre só o que quiser acompanhar: <b>planos de manutenção</b> por km e/ou tempo (troca de óleo, revisão, pneus) e <b>documentos com vencimento</b> (licenciamento, seguro, tacógrafo, exame toxicológico). O sistema avisa antes de vencer, aqui, no Dashboard e no celular. A validade da CNH vem do cadastro do motorista.</p>
        ${podeIncluir() ? `<div class="mn-vazio-acoes"><button class="btn btn-primary" type="button" data-novo-plano>${ico('plus', 'i-sm')} Criar plano de manutenção</button>
          <button class="btn" type="button" data-novo-doc>${ico('plus', 'i-sm')} Cadastrar documento</button></div>` : ''}
      </div>`;
    }
    const n = (e) => dados.itens.filter((x) => (e === 'atencao' ? x.estado !== 'ok' : !e || x.estado === e)).length;
    const segs = [['atencao', 'Pedem atenção'], ['vencido', 'Vencidos'], ['perto', 'Vencem em breve'], ['ok', 'Em dia'], ['', 'Todos']];
    return `<div class="toolbar">
        <div class="seg" id="mn-estado">${segs.map(([e, t]) => `<button class="seg-btn${f.estado === e ? ' active' : ''}" type="button" data-e="${e}">${H(t)} <span class="muted">${n(e)}</span></button>`).join('')}</div>
        <label class="search">${ico('search', 'i-sm')}<input id="mn-busca" placeholder="Veículo, motorista ou item" autocomplete="off"></label>
        <div class="grow"></div>
        ${podeIncluir() ? `<button class="btn btn-primary" type="button" data-registrar>${ico('plus', 'i-sm')} Registrar manutenção</button>` : ''}
      </div>
      <div class="table-wrap tall flat" id="mn-tabela">${tabelaAba()}</div>
      <p class="hint">Km contados pelo GPS a partir do dia seguinte à última manutenção registrada (ou ao cadastro do plano). Avisa antes: no plano, faltando 10% do intervalo de km ou 15 dias (ajustável); nos documentos, nos dias escolhidos; na CNH, 30 dias antes.</p>`;
  }

  function linhasSituacao() {
    return dados.itens.filter((x) => (f.estado === 'atencao' ? x.estado !== 'ok' : !f.estado || x.estado === f.estado))
      .filter((x) => confere([x.nome, x.veiculo, x.motorista, x.numero, TIPOS_ITEM_MANUT[x.tipo][1]].join(' ')));
  }

  function tabelaAba() {
    if (f.aba === 'situacao') {
      return tabela([
        { t: 'Situação', cls: 'nw', v: (x) => `<span class="tag ${ESTADOS_MANUT[x.estado][0]}">${ESTADOS_MANUT[x.estado][1]}</span>` },
        { t: 'Item', v: (x) => `<span class="mn-item">${ico(TIPOS_ITEM_MANUT[x.tipo][0], 'i-sm')}<span><b>${H(x.nome)}</b><span class="sub">${H(TIPOS_ITEM_MANUT[x.tipo][1])}${x.detalhe ? ` · ${H(x.detalhe)}` : ''}</span></span></span>` },
        { t: 'Veículo / motorista', v: (x) => (x.veiculo ? `${ico('bus', 'i-xs')} ${H(x.veiculo)}` : `${ico('user', 'i-xs')} ${H(x.motorista || '')}`) },
        { t: 'Prazo', v: (x) => `${H(detalheItemManut(x))}<span class="sub">${H(baseItemManut(x))}</span>` },
        { t: '', cls: 'acts', v: (x) => acaoItem(x) },
      ], linhasSituacao(), { vazio: f.estado === 'atencao' ? 'Nada vencido nem perto de vencer. Tudo em dia.' : 'Nada encontrado.' });
    }
    if (f.aba === 'planos') return tabelaPlanos();
    if (f.aba === 'documentos') return tabelaDocumentos();
    return tabelaFeitas();
  }

  function acaoItem(x) {
    if (x.tipo === 'manutencao' && podeIncluir()) return `<button class="btn btn-sm" type="button" data-feita="${H(x.chave)}">${ico('check', 'i-sm')} Registrar feita</button>`;
    if (x.tipo === 'documento' && podeAlterar()) return `<button class="btn btn-sm" type="button" data-renovar="${x.id}">${ico('refresh', 'i-sm')} Renovar</button>`;
    if (x.tipo === 'cnh' && podeTela('motoristas')) return `<button class="btn btn-sm btn-ghost" type="button" data-ir-mot>${ico('id-badge-2', 'i-sm')} Motoristas</button>`;
    return '';
  }

  /* ---------- planos ---------- */

  const intervaloPlano = (p) => [p.intervalo_km ? `${fmtNum(p.intervalo_km)} km` : '', p.intervalo_meses ? `${p.intervalo_meses} ${p.intervalo_meses === 1 ? 'mês' : 'meses'}` : p.intervalo_dias ? `${p.intervalo_dias} dias` : ''].filter(Boolean).join(' ou ');
  const avisoPlano = (p) => {
    const km = p.intervalo_km ? (p.avisar_km !== null ? p.avisar_km : Math.round(p.intervalo_km * 0.1)) : null;
    const tempoDias = p.intervalo_meses ? p.intervalo_meses * 30 : p.intervalo_dias;
    const dias = tempoDias ? (p.avisar_dias !== null ? p.avisar_dias : Math.min(15, Math.ceil(tempoDias / 4))) : null;
    return ['faltando', [km !== null ? `${fmtNum(km)} km` : '', dias !== null ? `${dias} dias` : ''].filter(Boolean).join(' ou ')].join(' ');
  };

  function htmlPlanos() {
    return `<div class="toolbar">
        <label class="search">${ico('search', 'i-sm')}<input id="mn-busca" placeholder="Buscar plano" autocomplete="off"></label>
        <div class="grow"></div>
        ${podeIncluir() ? `<button class="btn btn-primary" type="button" data-novo-plano>${ico('plus', 'i-sm')} Novo plano</button>` : ''}
      </div>
      <div class="table-wrap tall flat" id="mn-tabela">${tabelaPlanos()}</div>
      <p class="hint">Cada plano vale para a empresa toda, um grupo (com os subgrupos) ou um veículo. Para cada veículo, a contagem começa na última manutenção registrada; sem registro, no dia em que o plano foi criado. Já fez há pouco ou está atrasado? Use "Registrar manutenção" com a data em que foi feita.</p>`;
  }

  function tabelaPlanos() {
    const abre = podeAlterar() || podeTela('manutencao', 'excluir');
    return tabela([
      { t: 'Plano', v: (p) => `<b>${H(p.nome)}</b>${p.observacao ? `<span class="sub">${H(p.observacao)}</span>` : ''}` },
      { t: 'Vale para', v: (p) => `${ico(p.alcance === 'veiculo' ? 'bus' : p.alcance === 'grupo' ? 'folders' : 'building', 'i-xs')} ${H(p.alvo)}` },
      { t: 'A cada', cls: 'nw', v: (p) => `<b>${H(intervaloPlano(p))}</b><span class="sub">avisa ${H(avisoPlano(p))}</span>` },
      { t: 'Veículos', cls: 'nw', v: (p) => `${fmtNum(p.veiculos)}${p.vencidos ? ` <span class="tag err">${p.vencidos} vencido${p.vencidos > 1 ? 's' : ''}</span>` : ''}${p.perto ? ` <span class="tag wait">${p.perto} em breve</span>` : ''}` },
      { t: 'Situação', v: (p) => (p.ativo ? '<span class="tag ok">ligado</span>' : '<span class="tag off">desligado</span>') },
    ], dados.planos.filter((p) => confere([p.nome, p.alvo, p.observacao].join(' '))), {
      vazio: dados.planos.length ? 'Nada encontrado.' : 'Nenhum plano. Ex.: troca de óleo a cada 10.000 km ou 6 meses; revisão a cada 20.000 km.',
      linhaCls: (p) => `${abre && p.editavel ? 'clic' : ''}${p.ativo ? '' : ' inativo'}`,
      atributos: (p) => `data-plano="${p.id}"`,
    });
  }

  /* ---------- documentos ---------- */

  function htmlDocumentos() {
    return `<div class="toolbar">
        <label class="search">${ico('search', 'i-sm')}<input id="mn-busca" placeholder="Veículo, motorista ou documento" autocomplete="off"></label>
        <div class="grow"></div>
        ${podeIncluir() ? `<button class="btn btn-primary" type="button" data-novo-doc>${ico('plus', 'i-sm')} Novo documento</button>` : ''}
      </div>
      <div class="table-wrap tall flat" id="mn-tabela">${tabelaDocumentos()}</div>
      <p class="hint">Para renovar, abra o documento e mude a data de vencimento (fica na auditoria). A CNH dos motoristas aparece na Situação pela validade do cadastro do motorista.</p>`;
  }

  function tabelaDocumentos() {
    const abre = podeAlterar() || podeTela('manutencao', 'excluir');
    return tabela([
      { t: 'Documento', v: (d) => `<b>${H(d.tipo === 'outro' ? d.descricao : d.nome)}</b><span class="sub">${H([d.tipo === 'outro' ? '' : d.descricao, d.numero ? `nº ${d.numero}` : ''].filter(Boolean).join(' · '))}</span>` },
      { t: 'De', v: (d) => `${ico(d.de === 'veiculo' ? 'bus' : 'user', 'i-xs')} ${H(d.alvo)}` },
      { t: 'Vencimento', cls: 'nw', v: (d) => `${H(dataBr(d.vencimento))}${d.estado && d.estado !== 'ok' ? ` <span class="tag ${ESTADOS_MANUT[d.estado][0]}">${H(textoPrazo(d.faltaDias))}</span>` : ''}` },
      { t: 'Avisa', cls: 'nw', v: (d) => `${d.avisar_dias} dias antes` },
    ], dados.documentos.filter((d) => confere([d.nome, d.descricao, d.numero, d.alvo].join(' '))), {
      vazio: dados.documentos.length ? 'Nada encontrado.' : 'Nenhum documento. Ex.: licenciamento, seguro, aferição do tacógrafo, exame toxicológico do motorista.',
      linhaCls: (d) => (abre && d.editavel ? 'clic' : ''),
      atributos: (d) => `data-doc="${d.id}"`,
    });
  }

  /* ---------- feitas ---------- */

  function htmlFeitas() {
    const l = linhasFeitas();
    const total = l.reduce((s, x) => s + (x.custo || 0), 0);
    return `<div class="toolbar">
        <label class="search">${ico('search', 'i-sm')}<input id="mn-busca" placeholder="Veículo, serviço ou oficina" autocomplete="off"></label>
        <div class="grow"></div>
        <span class="count">${fmtNum(l.length)} registro${l.length === 1 ? '' : 's'}${total ? ` · ${reais(total)}` : ''}</span>
        ${podeIncluir() ? `<button class="btn btn-primary" type="button" data-registrar>${ico('plus', 'i-sm')} Registrar manutenção</button>` : ''}
      </div>
      <div class="table-wrap tall flat" id="mn-tabela">${tabelaFeitas()}</div>`;
  }

  const linhasFeitas = () => dados.feitas.filter((x) => confere([x.veiculo, x.descricao, x.oficina, x.observacao].join(' ')));

  function tabelaFeitas() {
    const abre = podeAlterar() || podeTela('manutencao', 'excluir');
    return tabela([
      { t: 'Data', cls: 'nw', v: (x) => H(dataBr(x.data)) },
      { t: 'Veículo', cls: 'nw', v: (x) => H(x.veiculo) },
      { t: 'Serviço', v: (x) => `<b>${H(x.descricao)}</b>${x.plano_id ? '' : '<span class="sub">avulsa</span>'}${x.observacao ? `<span class="sub">${H(x.observacao)}</span>` : ''}` },
      { t: 'Hodômetro', cls: 'num', v: (x) => (x.hodometro !== null ? `${fmtNum(x.hodometro)} km` : '') },
      { t: 'Custo', cls: 'num', v: (x) => H(reais(x.custo)) },
      { t: 'Oficina', v: (x) => H(x.oficina || '') },
      { t: 'Registrado por', v: (x) => `${H(x.usuario || '')}` },
    ], linhasFeitas(), {
      vazio: dados.feitas.length ? 'Nada encontrado.' : 'Nenhuma manutenção registrada ainda.',
      linhaCls: () => (abre ? 'clic' : ''),
      atributos: (x) => `data-feita-id="${x.id}"`,
    });
  }

  /* ---------- ações ---------- */

  function clique(e) {
    const alvo = e.target.closest('[data-novo-plano],[data-novo-doc],[data-registrar],[data-feita],[data-renovar],[data-ir-mot],tr[data-plano],tr[data-doc],tr[data-feita-id]');
    if (!alvo) return;
    if (alvo.matches('[data-novo-plano]')) editarPlano(null);
    else if (alvo.matches('[data-novo-doc]')) editarDocumento(null);
    else if (alvo.matches('[data-registrar]')) registrarFeita(null, {});
    else if (alvo.matches('[data-feita]')) {
      const x = dados.itens.find((i) => i.chave === alvo.dataset.feita);
      if (x) registrarFeita(null, { veiculo: x.veiculoId, plano: x.planoId, empresa: x.empresaId });
    } else if (alvo.matches('[data-renovar]')) {
      const d = dados.documentos.find((i) => i.id === Number(alvo.dataset.renovar));
      if (d) editarDocumento(d, true);
    } else if (alvo.matches('[data-ir-mot]')) navegar('motoristas');
    else if (alvo.matches('tr[data-plano]') && alvo.classList.contains('clic')) editarPlano(dados.planos.find((p) => p.id === Number(alvo.dataset.plano)));
    else if (alvo.matches('tr[data-doc]') && alvo.classList.contains('clic')) editarDocumento(dados.documentos.find((d) => d.id === Number(alvo.dataset.doc)));
    else if (alvo.matches('tr[data-feita-id]') && alvo.classList.contains('clic')) registrarFeita(dados.feitas.find((x) => x.id === Number(alvo.dataset.feitaId)), {});
  }

  /** Veículos que a pessoa enxerga na empresa (os do Monitoramento: não pede a tela Veículos). */
  async function opcoesVeiculos(empresaId) {
    return [...S.itens.values()].filter((i) => i.veiculoId && String(i.empresaId) === String(empresaId))
      .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }))
      .map((i) => ({ v: i.veiculoId, t: `${rotulo(i)}${i.grupo ? ` (${i.grupo})` : ''}` }));
  }

  async function excluir(texto, caminho, ok) {
    if (!(await confirmar(texto, { titulo: 'Excluir', ok: 'Excluir', perigo: true }))) return false;
    try {
      await api(caminho, { metodo: 'DELETE' });
      toast(ok, 'ok');
      carregar();
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  async function editarPlano(p) {
    if (p && !podeAlterar()) { excluir(`Excluir o plano ${p.nome}? As manutenções já registradas continuam no histórico.`, `/api/manutencao/planos/${p.id}`, 'Plano excluído.'); return; }
    const empresaId = p ? p.empresa_id : await escolherEmpresa();
    if (!empresaId) return;
    const g = { grupos: S.grupos.filter((x) => String(x.empresaId) === String(empresaId)) };
    const veics = await opcoesVeiculos(empresaId);
    const alcance = [{ v: 'empresa', t: 'A empresa toda' }];
    if (g.grupos.length) alcance.push({ v: 'grupo', t: 'Um grupo (e os subgrupos)' });
    alcance.push({ v: 'veiculo', t: 'Um veículo' });
    if (S.eu.perfil !== 'master' && !S.eu.todosGrupos) alcance.shift();
    const j = formulario({
      titulo: p ? p.nome : 'Novo plano de manutenção', icone: 'tool',
      aviso: `Informe o intervalo em km, em tempo, ou os dois (vence no que chegar primeiro).${S.eu.perfil === 'master' ? `<br>Empresa: <b>${H(p ? p.empresa : nomeEmpresa(empresaId))}</b>` : ''}`,
      campos: [
        { nome: 'nome', rotulo: 'Serviço', obrigatorio: true, cheio: true, maxlength: 80, placeholder: 'Troca de óleo e filtros' },
        { tipo: 'separador', rotulo: 'Veículos' },
        { nome: 'alcance', rotulo: 'Vale para', tipo: 'select', opcoes: alcance },
        { nome: 'grupo', rotulo: 'Grupo', tipo: 'select', se: 'alcance=grupo', opcoes: g.grupos.map((x) => ({ v: x.id, t: x.caminho })) },
        { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', se: 'alcance=veiculo', opcoes: veics },
        { tipo: 'separador', rotulo: 'A cada' },
        { nome: 'km', rotulo: 'Km', tipo: 'numero', min: 100, max: 1000000, placeholder: '10000' },
        { nome: 'tempo', rotulo: 'Tempo', tipo: 'numero', min: 1, max: 3650, placeholder: '6' },
        { nome: 'unidade', rotulo: 'Em', tipo: 'select', opcoes: [{ v: 'meses', t: 'meses' }, { v: 'dias', t: 'dias' }] },
        { tipo: 'separador', rotulo: 'Avisar antes (opcional)' },
        { nome: 'avisarKm', rotulo: 'Faltando (km)', tipo: 'numero', min: 0, max: 100000, ajuda: 'Vazio: 10% do intervalo.' },
        { nome: 'avisarDias', rotulo: 'Faltando (dias)', tipo: 'numero', min: 0, max: 365, ajuda: 'Vazio: 15 dias.' },
        { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
        ...(p ? [{ nome: 'ativo', rotulo: 'Plano ligado', tipo: 'check' }] : []),
      ],
      valores: p ? {
        nome: p.nome, alcance: p.alcance, grupo: p.grupo_id, veiculo: p.veiculo_id, km: p.intervalo_km ?? '', tempo: p.intervalo_meses || p.intervalo_dias || '',
        unidade: p.intervalo_dias ? 'dias' : 'meses', avisarKm: p.avisar_km ?? '', avisarDias: p.avisar_dias ?? '', observacao: p.observacao, ativo: p.ativo,
      } : { alcance: alcance[0].v, unidade: 'meses' },
      extras: p && podeTela('manutencao', 'excluir') ? `<p style="margin:14px 0 0"><button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir plano</button></p>` : '',
      salvar: async (d) => {
        const corpo = { ...d, empresa: empresaId };
        if (p) await api(`/api/manutencao/planos/${p.id}`, { metodo: 'PUT', corpo });
        else await api('/api/manutencao/planos', { corpo });
        toast(p ? 'Plano atualizado.' : 'Plano criado: a contagem de cada veículo começa hoje.', 'ok');
        carregar();
      },
    });
    const ex = j.el.querySelector('[data-excluir]');
    if (ex) ex.addEventListener('click', async () => { if (await excluir(`Excluir o plano ${p.nome}? As manutenções já registradas continuam no histórico.`, `/api/manutencao/planos/${p.id}`, 'Plano excluído.')) j.fechar(); });
  }

  /** Registrar (ou editar) uma manutenção feita. pre: { veiculo, plano } vindos da situação. */
  async function registrarFeita(x, pre) {
    if (x && !podeAlterar()) { excluir(`Excluir o registro de ${x.descricao} do ${x.veiculo} em ${dataBr(x.data)}?`, `/api/manutencao/feitas/${x.id}`, 'Registro excluído.'); return; }
    const empresaId = x ? x.empresa_id : pre.empresa || await escolherEmpresa();
    if (!empresaId) return;
    const veics = await opcoesVeiculos(empresaId);
    const planosDo = (veiculoId) => dados.itens.filter((i) => i.tipo === 'manutencao' && String(i.veiculoId) === String(veiculoId))
      .map((i) => ({ v: i.planoId, t: `${i.nome}${i.estado !== 'ok' ? ` (${ESTADOS_MANUT[i.estado][1].toLowerCase()})` : ''}` }));
    const veic0 = x ? x.veiculo_id : pre.veiculo || (veics[0] && veics[0].v);
    const j = formulario({
      titulo: x ? `${x.descricao} · ${x.veiculo}` : 'Registrar manutenção feita', icone: 'tool',
      aviso: x ? '' : 'A próxima manutenção do plano passa a contar desta data (e do hodômetro, se informar).',
      campos: [
        { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', cheio: true, opcoes: veics, desativado: Boolean(x) },
        { nome: 'plano', rotulo: 'Serviço', tipo: 'select', cheio: true, opcoes: [...planosDo(veic0), { v: '', t: 'Outro serviço (avulso)' }] },
        { nome: 'descricao', rotulo: 'Qual serviço', cheio: true, maxlength: 120, se: 'plano=', placeholder: 'Troca de pastilhas de freio' },
        { nome: 'data', rotulo: 'Feita em', tipo: 'dia', obrigatorio: true },
        { nome: 'hodometro', rotulo: 'Hodômetro (km)', tipo: 'numero', min: 0, max: 9999999, ajuda: 'Opcional.' },
        { nome: 'custo', rotulo: 'Custo (R$)', placeholder: '350,00', ajuda: 'Opcional.' },
        { nome: 'oficina', rotulo: 'Oficina', maxlength: 80 },
        { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ],
      valores: x ? { ...x, veiculo: x.veiculo_id, plano: x.plano_id || '', custo: x.custo !== null ? fmtNum(x.custo, 2) : '', hodometro: x.hodometro ?? '' }
        : { veiculo: veic0, plano: pre.plano || (planosDo(veic0)[0] || { v: '' }).v, data: textoServidor().slice(0, 10) },
      extras: x && podeTela('manutencao', 'excluir') ? `<p style="margin:14px 0 0"><button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir registro</button></p>` : '',
      salvar: async (d) => {
        const corpo = { ...d, veiculo: x ? x.veiculo_id : d.veiculo };
        if (x) await api(`/api/manutencao/feitas/${x.id}`, { metodo: 'PUT', corpo });
        else await api('/api/manutencao/feitas', { corpo });
        toast(x ? 'Registro atualizado.' : 'Manutenção registrada.', 'ok');
        carregar();
      },
    });
    // trocou o veículo: os planos que valem para ele
    const sv = j.el.querySelector('select[name=veiculo]');
    const sp = j.el.querySelector('select[name=plano]');
    sv.addEventListener('change', () => {
      sp.innerHTML = [...planosDo(sv.value), { v: '', t: 'Outro serviço (avulso)' }].map((o) => `<option value="${H(o.v)}">${H(o.t)}</option>`).join('');
      sp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    j.el.querySelector('input[name=data]').max = textoServidor().slice(0, 10);
    const ex = j.el.querySelector('[data-excluir]');
    if (ex) ex.addEventListener('click', async () => { if (await excluir(`Excluir o registro de ${x.descricao} do ${x.veiculo} em ${dataBr(x.data)}?`, `/api/manutencao/feitas/${x.id}`, 'Registro excluído.')) j.fechar(); });
  }

  async function editarDocumento(d, renovar = false) {
    if (d && !podeAlterar()) { excluir(`Excluir o documento ${d.nome} de ${d.alvo}?`, `/api/manutencao/documentos/${d.id}`, 'Documento excluído.'); return; }
    const empresaId = d ? d.empresa_id : await escolherEmpresa();
    if (!empresaId) return;
    const [veics, mot] = await Promise.all([
      opcoesVeiculos(empresaId),
      podeTela('motoristas') ? api(`/api/motoristas?${qs({ empresa: empresaId })}`).catch(() => ({ motoristas: [] })) : Promise.resolve({ motoristas: [] }),
    ]);
    const mots = mot.motoristas.filter((m) => m.empresa_id === empresaId && (m.ativo || (d && d.motorista_id === m.id))).map((m) => ({ v: m.id, t: m.nome }));
    const tipos = dados.tipos;
    const j = formulario({
      titulo: d ? `${d.tipo === 'outro' ? d.descricao : d.nome} · ${d.alvo}` : 'Novo documento', icone: 'file-certificate',
      aviso: renovar ? 'Renovou? Coloque a nova data de vencimento.' : (S.eu.perfil === 'master' && !d ? `Empresa: <b>${H(nomeEmpresa(empresaId))}</b>` : ''),
      campos: [
        { nome: 'de', rotulo: 'Documento do', tipo: 'select', opcoes: [{ v: 'veiculo', t: 'Veículo' }, ...(mots.length || (d && d.motorista_id) ? [{ v: 'motorista', t: 'Motorista' }] : [])], desativado: Boolean(d) },
        { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', se: 'de=veiculo', opcoes: veics, desativado: Boolean(d) },
        { nome: 'motorista', rotulo: 'Motorista', tipo: 'select', se: 'de=motorista', opcoes: mots, desativado: Boolean(d) },
        { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', cheio: true, opcoes: tipos.map((t) => ({ v: t.id, t: t.nome })) },
        { nome: 'descricao', rotulo: 'Descrição', maxlength: 80, cheio: true, placeholder: 'Ex.: apólice da frota, curso de transporte escolar' },
        { nome: 'numero', rotulo: 'Número', maxlength: 40 },
        { nome: 'vencimento', rotulo: 'Vence em', tipo: 'dia', obrigatorio: true },
        { nome: 'avisarDias', rotulo: 'Avisar (dias antes)', tipo: 'numero', min: 0, max: 365 },
        { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ],
      valores: d ? { de: d.de, veiculo: d.veiculo_id, motorista: d.motorista_id, tipo: d.tipo, descricao: d.descricao, numero: d.numero, vencimento: d.vencimento, avisarDias: d.avisar_dias, observacao: d.observacao }
        : { de: 'veiculo', tipo: 'licenciamento', avisarDias: 30 },
      textoSalvar: renovar ? 'Renovar' : 'Salvar',
      extras: d && podeTela('manutencao', 'excluir') ? `<p style="margin:14px 0 0"><button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir documento</button></p>` : '',
      salvar: async (x) => {
        const corpo = { ...x, empresa: empresaId };
        if (d) await api(`/api/manutencao/documentos/${d.id}`, { metodo: 'PUT', corpo });
        else await api('/api/manutencao/documentos', { corpo });
        toast(d ? (x.vencimento !== d.vencimento ? 'Documento renovado.' : 'Documento atualizado.') : 'Documento cadastrado.', 'ok');
        carregar();
      },
    });
    // os tipos que fazem sentido para veículo ou para motorista
    const sDe = j.el.querySelector('select[name=de]');
    const sTipo = j.el.querySelector('select[name=tipo]');
    const filtrarTipos = () => {
      const atual = sTipo.value;
      const l = tipos.filter((t) => t.de === 'ambos' || t.de === sDe.value);
      sTipo.innerHTML = l.map((t) => `<option value="${t.id}">${H(t.nome)}</option>`).join('');
      sTipo.value = l.some((t) => t.id === atual) ? atual : l[0].id;
    };
    filtrarTipos();
    sDe.addEventListener('change', filtrarTipos);
    if (renovar) setTimeout(() => { const v = j.el.querySelector('input[name=vencimento]'); if (v) v.focus(); }, 60);
    const ex = j.el.querySelector('[data-excluir]');
    if (ex) ex.addEventListener('click', async () => { if (await excluir(`Excluir o documento ${d.nome} de ${d.alvo}?`, `/api/manutencao/documentos/${d.id}`, 'Documento excluído.')) j.fechar(); });
  }

  return { id: 'manutencao', titulo: 'Manutenção e documentos', sub: 'Planos por km e tempo, manutenções feitas e documentos com vencimento (opcional)', render, sair };
})();

/* ---------- selo no menu, aviso no Dashboard e no painel do veículo ---------- */
// O número vermelho em "Manutenção e documentos" conta o que está vencido. Só aparece
// para quem tem a tela e só quando há algo cadastrado e vencido.

let manutTimer = null;
async function atualizarManutencao() {
  clearTimeout(manutTimer);
  if (!S.eu || !podeTela('manutencao')) { S.manut = null; return; }
  try {
    const r = await api(`/api/manutencao/resumo${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
    S.manut = r;
    const nb = $('#nav-manut');
    if (nb) { nb.hidden = !r.vencidos; nb.textContent = String(r.vencidos); }
    atualizarSelosGrupos();
    emit('manut');
  } catch { /* tenta de novo depois */ }
  manutTimer = setTimeout(atualizarManutencao, 10 * 60000);
}

/** Linha no painel do veículo: o que está vencido ou perto de vencer nele. */
function htmlManutVeiculo(i) {
  if (!S.manut || !i.veiculoId || !podeTela('manutencao')) return '';
  const l = S.manut.itens.filter((x) => x.veiculoId === i.veiculoId);
  if (!l.length) return '';
  const venc = l.some((x) => x.estado === 'vencido');
  return `<button class="det-manut ${venc ? 'err' : 'warn'}" type="button" data-manut title="Abrir Manutenção e documentos">${ico('tool', 'i-sm')}
    <span>${l.slice(0, 2).map((x) => `${H(x.nome)} ${x.estado === 'vencido' ? 'vencido' : 'vence em breve'}`).join(' · ')}${l.length > 2 ? ` · +${l.length - 2}` : ''}</span></button>`;
}
