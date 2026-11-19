'use strict';
/* FrotaGest — Procedimentos Auxiliares › Importação da Escala Globus.
 * Importa o arquivo de texto da escala gerada no Globus (17 campos separados por ";"), mostra a escala do dia
 * com o veículo e o motorista achados no FrotaGest (prefixo sem os zeros da frente e chapa = matrícula),
 * lista quem não tem cadastro (com o botão Cadastrar) e, de forma opcional, vincula o motorista ao veículo,
 * um serviço por vez. Reis Tecnologia */

const SIT_ESCALA = { aguardando: ['Aguardando', 'off'], em_servico: ['Em serviço', 'ok'], encerrado: ['Encerrado', 'wait'] };
const LAYOUT_GLOBUS = ['Data', 'Tipo de dia', 'Prefixo do veículo', 'Código da linha', 'Número oficial da linha', 'Nome da linha', 'Código do turno',
  'Chapa do motorista', 'Nome do motorista', 'Hora inicial do serviço', 'Hora final do serviço', 'Hora inicial do motorista',
  'Hora inicial do intervalo', 'Hora final do intervalo', 'Hora final do motorista', 'Local de pegada do motorista', 'Descrição do turno'];
/** O modelo de exportação do Globus que gera o arquivo neste layout. */
const MODELO_GLOBUS = 'Exportação da Escala Diária - Modelo Personalizado';
/** As regras do arquivo (na janela de importação e em "Ver as regras"). */
function regrasGlobus({ layoutAberto = false } = {}) {
  return `<div class="gu-nota gu-n-dica es-modelo-nota">${ico('info-circle')}<div>
      <b>Modelo do Globus:</b> gere o arquivo em <b>${H(MODELO_GLOBUS)}</b>, com estas regras:
      <ul class="es-regras">
        <li>arquivo de texto (<b>.txt</b>), <b>um serviço por linha</b>; a primeira linha pode ser o cabeçalho com os nomes dos campos;</li>
        <li><b>${LAYOUT_GLOBUS.length} campos separados por ponto e vírgula (;)</b>, na ordem do layout abaixo;</li>
        <li>data em <b>dd/mm/aaaa</b> e horas em <b>HH:MM</b> (hora menor que o início do serviço é do dia seguinte);</li>
        <li><b>prefixo</b> igual ao do cadastro do veículo no FrotaGest; os zeros da frente são ignorados (0005755 = 5755);</li>
        <li><b>chapa</b> igual à <b>matrícula</b> do motorista no FrotaGest.</li>
      </ul></div></div>
    <details class="es-layout" ${layoutAberto ? 'open' : ''}><summary>Layout do arquivo: os ${LAYOUT_GLOBUS.length} campos, nesta ordem</summary><ol>${LAYOUT_GLOBUS.map((x) => `<li>${H(x)}</li>`).join('')}</ol></details>`;
}
const hmEscala = (s) => (s ? String(s).slice(11, 16) : '');
const diaBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

/** O Globus pode gravar em UTF-8 ou em Windows-1252: tenta o primeiro e, se não for, lê como o segundo. */
async function lerTextoGlobus(arquivo) {
  const buf = await arquivo.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

PAGINAS.escala = (() => {
  const f = { dia: '', q: '', sit: '', linha: '' };
  let dados = null;
  let seq = 0;
  let offs = [];
  let timer = null;
  let espera = null;

  const hoje = () => textoServidor().slice(0, 10);

  function render(c) {
    if (!f.dia) f.dia = hoje();
    c.innerHTML = `<div class="page es">
      <section class="card es-topo">
        <div class="toolbar">
          <label class="field">Dia da escala<input type="date" id="es-dia" value="${H(f.dia)}"></label>
          <label class="field es-recentes-campo">Dias importados<select id="es-recentes"><option value="">—</option></select></label>
          <div class="es-acoes">
            ${podeTela('escala', 'incluir') ? `<button class="btn btn-primary" type="button" id="es-importar">${ico('file-import', 'i-sm')} Importar escala do Globus</button>` : ''}
            ${podeTela('escala', 'excluir') ? `<button class="btn btn-ghost" type="button" id="es-excluir" hidden>${ico('trash', 'i-sm')} Excluir a escala deste dia</button>` : ''}
          </div>
        </div>
        ${podeTela('escala', 'incluir') ? `<p class="es-modelo" id="es-modelo">${ico('info-circle', 'i-sm')}<span>Layout de importação: no Globus, use a <b>${H(MODELO_GLOBUS)}</b>.</span>
          <button class="btn btn-ghost btn-sm" type="button" id="es-regras">${ico('list-check', 'i-sm')} Ver as regras</button></p>` : ''}
        <p class="small muted es-info" id="es-info"></p>
      </section>
      <div class="kpis k6 es-kpis" id="es-kpis" hidden></div>
      <div id="es-pend"></div>
      <section class="card" id="es-lista-card" hidden>
        <div class="card-head"><h2>${ico('list-details', 'i-sm')} Serviços do dia</h2><span class="count" id="es-n"></span></div>
        <div class="card-body es-filtros">
          <label class="search">${ico('search', 'i-sm')}<input type="search" id="es-q" placeholder="Linha, prefixo, motorista ou chapa" value="${H(f.q)}" aria-label="Buscar na escala"></label>
          <select id="es-sit" aria-label="Situação">
            <option value="">Todas as situações</option><option value="aguardando">Aguardando</option><option value="em_servico">Em serviço agora</option>
            <option value="encerrado">Encerrados</option><option value="vincular">Podem ser vinculados agora</option><option value="pendencia">Com pendência de cadastro</option>
          </select>
          <select id="es-linha" aria-label="Linha"><option value="">Todas as linhas</option></select>
        </div>
        <div class="table-wrap flat" id="es-tabela"></div>
      </section>
      <div id="es-vazio"></div>
    </div>`;
    $('#es-sit').value = f.sit;
    c.onclick = clique;
    c.onchange = mudou;
    c.oninput = (ev) => {
      if (ev.target.id !== 'es-q') return;
      clearTimeout(espera);
      espera = setTimeout(() => { f.q = ev.target.value; desenharTabela(); }, 200);
    };
    offs.push(on('empresa', () => carregar()));
    offs.push(on('motoristas', () => { clearTimeout(timer); timer = setTimeout(carregar, 600); })); // trocaram o motorista em outro lugar
    carregar();
  }

  function mudou(ev) {
    const t = ev.target;
    if (t.id === 'es-dia' && t.value) { f.dia = t.value; f.linha = ''; carregar(); } else if (t.id === 'es-recentes' && t.value) { f.dia = t.value; $('#es-dia').value = f.dia; f.linha = ''; carregar(); } else if (t.id === 'es-sit') { f.sit = t.value; desenharTabela(); } else if (t.id === 'es-linha') { f.linha = t.value; desenharTabela(); }
  }

  async function carregar() {
    const meu = ++seq;
    clearTimeout(timer);
    if (S.eu.perfil === 'master' && !S.empresa) {
      dados = null;
      mostrarVazio(`${ico('building')} <b>Escolha a empresa no topo da tela</b><span>A escala do Globus é importada para uma empresa.</span>`);
      return;
    }
    try {
      const r = await api(`/api/escala-globus?${qs({ empresa: S.empresa || undefined, data: f.dia })}`);
      if (meu !== seq || !$('#es-kpis')) return;
      dados = r;
      desenhar();
    } catch (e) {
      if (meu === seq && $('#es-kpis')) mostrarVazio(`${ico('alert-triangle')} <b>${H(e.message)}</b>`);
    }
    // a situação (aguardando, em serviço, encerrado) muda com o relógio
    if (meu === seq && $('#es-kpis')) timer = setTimeout(carregar, 60 * 1000);
  }

  function mostrarVazio(html) {
    $('#es-kpis').hidden = true;
    $('#es-lista-card').hidden = true;
    $('#es-pend').innerHTML = '';
    $('#es-info').textContent = '';
    if ($('#es-excluir')) $('#es-excluir').hidden = true;
    $('#es-vazio').innerHTML = `<section class="card"><div class="card-body es-vazio">${html}</div></section>`;
  }

  function desenhar() {
    const r = dados;
    const sel = $('#es-recentes');
    sel.innerHTML = `<option value="">—</option>${r.recentes.map((x) => `<option value="${x.data}" ${x.data === r.data ? 'selected' : ''}>${diaBr(x.data)} · ${x.servicos} serviços</option>`).join('')}`;
    if ($('#es-excluir')) $('#es-excluir').hidden = !r.importacao;
    $('#es-info').innerHTML = r.importacao
      ? `${ico('file-text', 'i-xs')} ${H(r.importacao.arquivo || 'Arquivo')} · ${r.importacao.servicos} serviços · importada${r.importacao.por ? ` por ${H(r.importacao.por)}` : ''} em ${H(fmtCurto(r.importacao.em))}${S.eu.perfil === 'master' ? ` · ${H(r.empresa)}` : ''}`
      : '';
    if (!r.importacao) {
      mostrarVazio(`${ico('calendar-off')} <b>Nenhuma escala importada para ${diaBr(r.data)}</b>
        <span>${podeTela('escala', 'incluir') ? `Gere no Globus a <b>${H(MODELO_GLOBUS)}</b> e clique em <b>Importar escala do Globus</b>.` : 'Peça para quem importa a escala do Globus.'}${r.recentes.length ? ' Ou escolha um dos dias importados.' : ''}</span>`);
      return;
    }
    $('#es-vazio').innerHTML = '';
    const s = r.resumo;
    const tile = (i, rot, valor, sub, cls) => `<div class="kpi ${cls}"><div class="kpi-ico">${ico(i)}</div><div class="kpi-body"><div class="kpi-label">${H(rot)}</div><div class="kpi-value">${valor}</div><div class="kpi-sub">${sub}</div></div></div>`;
    const kp = $('#es-kpis');
    kp.hidden = false;
    const nv = r.veiculosNaoEncontrados.length;
    const nm = r.motoristasSemCadastro.length;
    kp.innerHTML = tile('list-details', 'Serviços', fmtNum(s.servicos), diaBr(r.data), 'neutral')
      + tile('bus', 'Veículos', fmtNum(s.veiculos), nv ? `${nv} não ${nv === 1 ? 'encontrado' : 'encontrados'}` : 'todos encontrados', nv ? 'warn' : 'ok')
      + tile('id-badge-2', 'Motoristas', fmtNum(s.motoristas), nm ? `${nm} sem cadastro` : 'todos cadastrados', nm ? 'warn' : 'ok')
      + tile('route-2', 'Linhas', fmtNum(s.linhas), 'na escala', 'neutral')
      + tile('steering-wheel', 'Em serviço', fmtNum(s.emServico), 'agora', s.emServico ? 'ok' : 'neutral')
      + tile('link', 'Vinculados', fmtNum(s.vinculados), 'pela escala', 'neutral');
    desenharPendencias();
    const linhas = [...new Map(r.servicos.filter((x) => x.linha.codigo).map((x) => [x.linha.codigo, x.linha.nome])).entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR', { numeric: true }));
    $('#es-linha').innerHTML = `<option value="">Todas as linhas</option>${linhas.map(([cod, nome]) => `<option value="${H(cod)}">${H(cod)}${nome ? ` · ${H(nome)}` : ''}</option>`).join('')}`;
    if (f.linha && !linhas.some(([cod]) => cod === f.linha)) f.linha = '';
    $('#es-linha').value = f.linha;
    $('#es-lista-card').hidden = false;
    desenharTabela();
  }

  function desenharPendencias() {
    const r = dados;
    const box = $('#es-pend');
    const ms = r.motoristasSemCadastro;
    const vs = r.veiculosNaoEncontrados;
    if (!ms.length && !vs.length && !r.semVeiculo && !r.semMotorista) { box.innerHTML = ''; return; }
    const cad = podeTela('motoristas', 'incluir');
    const notas = [r.semVeiculo ? `${r.semVeiculo} serviço(s) sem veículo na escala` : '', r.semMotorista ? `${r.semMotorista} serviço(s) sem motorista na escala` : ''].filter(Boolean);
    box.innerHTML = `<section class="card es-pendencias">
      <div class="card-head"><h2>${ico('alert-triangle', 'i-sm')} O que falta para vincular</h2>
        <span class="small muted">${notas.join(' · ')}</span></div>
      <div class="card-body es-pend-grade">
        ${ms.length ? `<details class="es-pend-bloco" ${ms.length <= 12 ? 'open' : ''}><summary><b>${ms.length} motorista(s) sem cadastro</b><span class="small muted">a chapa do Globus é a matrícula do motorista no FrotaGest</span></summary>
          <ul class="es-pend-lista">${ms.map((m) => `<li><span><b>${H(m.nome || 'Sem nome')}</b><small>chapa ${H(m.chapa)} · ${m.servicos} serviço(s)${m.repetido ? ' · matrícula repetida em dois cadastros' : ''}</small></span>
            ${cad && !m.repetido ? `<button class="btn btn-sm" type="button" data-cadastrar="${H(m.chapa)}" data-nome="${H(m.nome || '')}">${ico('user-plus', 'i-sm')} Cadastrar</button>` : ''}</li>`).join('')}</ul></details>` : ''}
        ${vs.length ? `<details class="es-pend-bloco" ${vs.length <= 12 ? 'open' : ''}><summary><b>${vs.length} veículo(s) não encontrado(s)</b><span class="small muted">o prefixo do Globus (sem os zeros da frente) precisa ser o mesmo do cadastro do veículo</span></summary>
          <ul class="es-pend-lista">${vs.map((v) => `<li><span><b class="mono">${H(v.prefixo)}</b><small>${v.servicos} serviço(s)${v.repetido ? ' · prefixo repetido em dois veículos' : ''}</small></span></li>`).join('')}</ul></details>` : ''}
      </div></section>`;
  }

  function filtrados() {
    const b = norm(f.q || '');
    return dados.servicos.filter((s) => {
      if (f.linha && s.linha.codigo !== f.linha) return false;
      if (f.sit === 'vincular' && !s.podeVincular) return false;
      if (f.sit === 'pendencia' && s.veiculo && s.motorista) return false;
      if (['aguardando', 'em_servico', 'encerrado'].includes(f.sit) && s.situacao !== f.sit) return false;
      if (b && !norm([s.linha.codigo, s.linha.nome, s.prefixo, s.veiculo && s.veiculo.rotulo, s.motoristaNome, s.chapa, s.local].join(' ')).includes(b)) return false;
      return true;
    });
  }

  function desenharTabela() {
    if (!dados || !$('#es-tabela')) return;
    const lista = filtrados();
    $('#es-n').textContent = lista.length === dados.servicos.length ? `${lista.length}` : `${lista.length} de ${dados.servicos.length}`;
    const cad = podeTela('motoristas', 'incluir');
    const diaSeg = (x, ref) => (x && ref && x.slice(0, 10) > ref.slice(0, 10) ? '<sup title="dia seguinte">+1</sup>' : '');
    $('#es-tabela').innerHTML = tabela([
      { t: 'Linha', v: (s) => `<b>${H(s.linha.codigo || '—')}</b><span class="sub">${H(s.linha.nome || '')}</span>` },
      { t: 'Turno', cls: 'nw', v: (s) => `${H(s.turno || '—')}<span class="sub">${H(s.turnoDescricao || '')}</span>` },
      { t: 'Veículo', cls: 'nw', v: (s) => (s.veiculo ? `<b>${H(s.prefixo)}</b><span class="sub">${H(s.veiculo.rotulo)}</span>`
        : s.prefixo ? `<span class="mono">${H(s.prefixo)}</span><span class="sub es-falta">não encontrado</span>` : '<span class="muted">sem veículo</span>') },
      { t: 'Motorista', v: (s) => {
        if (!s.chapa) return '<span class="muted">sem motorista</span>';
        const agora = s.noVeiculo && !s.noVeiculo.mesmo && s.situacao !== 'encerrado' ? `<span class="sub">no veículo agora: ${H(s.noVeiculo.nome)}</span>` : '';
        if (s.motorista) return `<b>${H(s.motorista.nome)}</b><span class="sub">chapa ${H(s.chapa)}</span>${agora}`;
        return `<div class="es-sem-cad"><span><b>${H(s.motoristaNome || 'Sem nome')}</b><span class="sub">chapa ${H(s.chapa)} · <span class="es-falta">sem cadastro</span></span></span>
          ${cad ? `<button class="btn btn-sm btn-ghost" type="button" data-cadastrar="${H(s.chapa)}" data-nome="${H(s.motoristaNome || '')}" title="Cadastrar o motorista com a chapa como matrícula">${ico('user-plus', 'i-sm')} Cadastrar</button>` : ''}</div>`;
      } },
      { t: 'Serviço', cls: 'nw', v: (s) => `<b>${hmEscala(s.servicoInicio)} – ${hmEscala(s.servicoFim)}${diaSeg(s.servicoFim, s.servicoInicio)}</b><span class="sub">pegada: ${H(s.local || '—')}</span>` },
      { t: 'Motorista (jornada)', cls: 'nw', v: (s) => `${hmEscala(s.motoristaInicio) || '—'} – ${hmEscala(s.motoristaFim) || '—'}${diaSeg(s.motoristaFim, s.servicoInicio)}<span class="sub">${s.intervaloInicio ? `intervalo ${hmEscala(s.intervaloInicio)}–${hmEscala(s.intervaloFim)}` : 'sem intervalo'}</span>` },
      { t: 'Situação', cls: 'nw', v: (s) => { const [t, cls] = SIT_ESCALA[s.situacao]; return `<span class="tag ${cls}">${t}</span>`; } },
      { t: 'Vínculo', cls: 'nw es-vinc', v: (s) => {
        if (s.vinculo) {
          const fim = s.vinculo.aberto ? `até ${hmEscala(s.vinculo.fimPrevisto || s.servicoFim)}` : `saiu às ${hmEscala(s.vinculo.fim)}`;
          return `<span class="tag ${s.vinculo.aberto ? 'ok' : 'off'}">${ico('link', 'i-xs')} Vinculado às ${hmEscala(s.vinculo.em)}</span><span class="sub">${H(s.vinculo.por || '')}${s.vinculo.por ? ' · ' : ''}${fim}</span>`;
        }
        if (s.podeVincular) return `<button class="btn btn-sm btn-primary" type="button" data-vincular="${s.id}" title="Colocar ${H(s.motorista.nome)} no ${H(s.veiculo.rotulo)} a partir de agora, até o fim do serviço">${ico('link', 'i-sm')} Vincular</button>`;
        if (s.noVeiculo && s.noVeiculo.mesmo) return `<span class="tag ok">${ico('check', 'i-xs')} Já está no veículo</span>`;
        return `<span class="muted small es-motivo" title="${H(s.motivo)}">${H(motivoCurto(s))}</span>`;
      } },
    ], lista, {
      vazio: dados.servicos.length ? 'Nenhum serviço com esses filtros.' : 'Nenhum serviço nesta escala.',
      linhaCls: (s) => `es-${s.situacao}${s.podeVincular ? ' es-pode' : ''}`,
      atributos: (s) => `data-servico="${s.id}"`,
    });
    // no celular cada serviço vira um cartão: cada campo leva o nome da coluna
    const cab = [...document.querySelectorAll('#es-tabela thead th')].map((th) => th.textContent);
    document.querySelectorAll('#es-tabela tbody tr[data-servico]').forEach((tr) => [...tr.children].forEach((td, i) => { td.dataset.r = cab[i] || ''; }));
  }

  /** O motivo em poucas palavras (o texto completo fica no balão do mouse). */
  function motivoCurto(s) {
    const t = {
      sem_veiculo: 'Sem veículo na escala', veiculo_nao_encontrado: 'Veículo não encontrado', sem_motorista: 'Sem motorista na escala',
      sem_cadastro: 'Motorista sem cadastro', encerrado: 'Serviço encerrado', cedo: `Vincular a partir das ${s.vincularDesde}`,
      fora_dos_grupos: 'Fora dos seus grupos', sem_permissao: 'Sem permissão para vincular',
    }[s.codigo];
    return t || s.motivo;
  }

  async function clique(ev) {
    const t = ev.target;
    if (t.closest('#es-importar')) { importar(); return; }
    if (t.closest('#es-regras')) {
      janela({ titulo: 'Layout de importação da escala', tamanho: 'lg', corpo: `<div class="es-imp">${regrasGlobus({ layoutAberto: true })}</div>`,
        rodape: '<button class="btn btn-primary" type="button" data-fechar>Entendi</button>' });
      return;
    }
    if (t.closest('#es-excluir')) { excluir(); return; }
    const cad = t.closest('[data-cadastrar]');
    if (cad) {
      if (typeof editarMotorista !== 'function') return;
      editarMotorista(null, () => { toast('Motorista cadastrado: o serviço dele já pode ser vinculado.', 'ok'); carregar(); },
        { nome: cad.dataset.nome, matricula: cad.dataset.cadastrar, empresa_id: dados.empresaId });
      return;
    }
    const vin = t.closest('[data-vincular]');
    if (vin) {
      vin.disabled = true;
      try {
        const r = await api(`/api/escala-globus/servicos/${vin.dataset.vincular}/vincular`, { corpo: {} });
        const s = r.servico;
        toast(`${s.motorista.nome} vinculado ao ${s.veiculo.rotulo} até ${hmEscala(s.servicoFim)} (fim do serviço).`, 'ok');
        carregar();
      } catch (e) { vin.disabled = false; toast(e.message, 'err'); }
    }
  }

  async function excluir() {
    if (!dados || !dados.importacao) return;
    const ok = await confirmar(`Excluir a escala de ${diaBr(dados.data)} (${dados.importacao.servicos} serviços)? Os motoristas já vinculados continuam nos veículos.`, { titulo: 'Excluir a escala do dia', ok: 'Excluir', perigo: true });
    if (!ok) return;
    try {
      await api(`/api/escala-globus?${qs({ empresa: S.empresa || undefined, data: dados.data })}`, { metodo: 'DELETE' });
      toast('Escala excluída.', 'ok');
      carregar();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- importar o arquivo ---------- */

  function importar() {
    if (S.eu.perfil === 'master' && !S.empresa) { toast('Escolha a empresa no topo da tela antes de importar.', 'err'); return; }
    let texto = null;
    let nome = '';
    let previa = null;
    const j = janela({
      titulo: 'Importar escala do Globus',
      tamanho: 'lg',
      corpo: `<div class="es-imp">
        ${regrasGlobus()}
        <label class="es-drop" id="es-drop">${ico('file-upload')}<span><b>Escolha o arquivo da escala</b><small>ou arraste para cá (.txt)</small></span>
          <input type="file" id="es-arquivo" accept=".txt,.csv,text/plain"></label>
        <div id="es-previa"></div>
      </div>`,
      rodape: `<button class="btn" type="button" data-fechar>Cancelar</button><button class="btn btn-primary" type="button" id="es-confirmar" disabled>${ico('file-import', 'i-sm')} Importar</button>`,
    });
    const el = j.el;
    const drop = $('#es-drop', el);
    const entrada = $('#es-arquivo', el);
    const usar = async (arq) => {
      if (!arq) return;
      if (arq.size > 4 * 1024 * 1024) { toast('Arquivo grande demais (até 4 MB).', 'err'); return; }
      nome = arq.name;
      $('#es-previa', el).innerHTML = '<p class="hint">Conferindo o arquivo…</p>';
      $('#es-confirmar', el).disabled = true;
      try {
        texto = await lerTextoGlobus(arq);
        previa = await api('/api/escala-globus/previa', { corpo: { texto, arquivo: nome, empresa: S.empresa || undefined } });
        desenharPrevia(previa);
        $('#es-confirmar', el).disabled = false;
        drop.classList.add('ok');
        $('b', drop).textContent = nome;
        $('small', drop).textContent = 'clique para escolher outro arquivo';
      } catch (e) {
        previa = null;
        $('#es-previa', el).innerHTML = `<div class="gu-nota gu-n-atencao">${ico('alert-triangle')}<div>${H(e.message)}</div></div>`;
      }
    };
    entrada.addEventListener('change', () => usar(entrada.files[0]));
    drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('sobre'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('sobre'));
    drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('sobre'); usar(ev.dataTransfer.files[0]); });

    function desenharPrevia(p) {
      const ja = p.datas.filter((d) => d.existente);
      const lista = (itens, fn, max = 40) => `${itens.slice(0, max).map(fn).join('')}${itens.length > max ? `<li class="muted">e mais ${itens.length - max}</li>` : ''}`;
      $('#es-previa', el).innerHTML = `
        <div class="es-prev-resumo">
          <div><span>Serviços</span><b>${fmtNum(p.servicos)}</b><small>${p.datas.map((d) => diaBr(d.data)).join(', ')}</small></div>
          <div><span>Veículos</span><b>${fmtNum(p.veiculos)}</b><small>${p.veiculosAchados} encontrado(s) no FrotaGest</small></div>
          <div><span>Motoristas</span><b>${fmtNum(p.motoristas)}</b><small>${p.motoristasAchados} com cadastro</small></div>
          <div><span>Linhas</span><b>${fmtNum(p.linhas)}</b><small>${p.passamMeiaNoite} serviço(s) passam da meia-noite</small></div>
        </div>
        ${ja.length ? `<div class="gu-nota gu-n-atencao">${ico('alert-triangle')}<div>Já existe escala importada para ${ja.map((d) => `<b>${diaBr(d.data)}</b> (${d.existente.servicos} serviços${d.existente.por ? `, por ${H(d.existente.por)}` : ''} em ${H(fmtCurto(d.existente.em))})`).join(', ')}.
          Importar <b>substitui</b> a escala desse dia; os motoristas já vinculados continuam nos veículos.</div></div>` : ''}
        ${p.semVeiculo || p.semMotorista ? `<p class="small muted">${[p.semVeiculo ? `${p.semVeiculo} serviço(s) sem veículo` : '', p.semMotorista ? `${p.semMotorista} serviço(s) sem motorista` : ''].filter(Boolean).join(' · ')} na escala: entram, mas não dá para vincular.</p>` : ''}
        ${p.motoristasSemCadastro.length || p.veiculosNaoEncontrados.length ? `<div class="es-prev-pend">
          ${p.motoristasSemCadastro.length ? `<details><summary>${p.motoristasSemCadastro.length} motorista(s) sem cadastro <span class="small muted">(cadastre depois, na tela, com um clique)</span></summary><ul>${lista(p.motoristasSemCadastro, (m) => `<li>${H(m.nome || 'Sem nome')} <span class="muted">· chapa ${H(m.chapa)}</span></li>`)}</ul></details>` : ''}
          ${p.veiculosNaoEncontrados.length ? `<details><summary>${p.veiculosNaoEncontrados.length} veículo(s) não encontrado(s) <span class="small muted">(prefixo diferente do cadastro)</span></summary><ul class="es-prev-cols">${lista(p.veiculosNaoEncontrados, (v) => `<li class="mono">${H(v.prefixo)}</li>`, 200)}</ul></details>` : ''}
        </div>` : '<p class="small" style="color:var(--ok)">Todos os veículos e motoristas foram encontrados.</p>'}
        ${p.totalErros ? `<details class="es-prev-erros" open><summary>${p.totalErros} linha(s) com erro ficam de fora</summary><ul>${p.erros.map((e) => `<li>Linha ${e.linha}: ${H(e.motivo)}</li>`).join('')}</ul></details>` : ''}`;
      $('#es-confirmar', el).innerHTML = `${ico('file-import', 'i-sm')} ${ja.length ? 'Substituir e importar' : 'Importar'} ${fmtNum(p.servicos)} serviço(s)`;
    }

    $('#es-confirmar', el).addEventListener('click', async () => {
      if (!texto || !previa) return;
      const b = $('#es-confirmar', el);
      b.disabled = true;
      try {
        const r = await api('/api/escala-globus/importar', { corpo: { texto, arquivo: nome, empresa: S.empresa || undefined, substituir: previa.datas.some((d) => d.existente) } });
        j.fechar();
        toast(`Escala importada: ${fmtNum(r.servicos)} serviço(s)${r.erros ? ` (${r.erros} linha(s) com erro ficaram de fora)` : ''}.`, 'ok');
        f.dia = r.datas[0];
        if ($('#es-dia')) $('#es-dia').value = f.dia;
        f.linha = '';
        carregar();
      } catch (e) { b.disabled = false; toast(e.message, 'err'); }
    });
  }

  function sair() {
    clearTimeout(timer);
    clearTimeout(espera);
    seq++;
    offs.forEach((o) => o());
    offs = [];
    const c = $('#conteudo');
    if (c) { c.onclick = null; c.onchange = null; c.oninput = null; }
  }

  return { id: 'escala', titulo: 'Importação da Escala Globus', sub: 'Escala de trabalho do Globus: veículo, linha, motorista e horários, com o vínculo do motorista ao veículo', tela: 'escala', render, sair };
})();
