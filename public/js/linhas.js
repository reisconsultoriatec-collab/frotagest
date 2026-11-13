'use strict';
/* FrotaGest — Linhas e horários: a linha (pontos na ordem, com o tempo previsto até cada um), os horários
 * de partida e as viagens do dia acompanhadas pelo GPS (no horário, adiantada, atrasada, ponto pulado,
 * fora da rota). Opcional: sem linha cadastrada, nada muda no resto do sistema. Reis Tecnologia */

const SIT_VG = {
  prevista: ['off', 'Prevista'], em_andamento: ['novo', 'Em andamento'], concluida: ['ok', 'Concluída'],
  incompleta: ['wait', 'Incompleta'], nao_realizada: ['err', 'Não realizada'], cancelada: ['off', 'Cancelada'],
};
const SIT_PT = { pendente: 'Pendente', no_horario: 'No horário', adiantado: 'Adiantado', atrasado: 'Atrasado', pulado: 'Não passou' };
const DIAS_SEM = [['1', 'Seg'], ['2', 'Ter'], ['3', 'Qua'], ['4', 'Qui'], ['5', 'Sex'], ['6', 'Sáb'], ['7', 'Dom']];
// cores das linhas (bem diferentes entre si, também para daltonismo, e legíveis com o número branco)
const CORES_LINHA = ['#2563EB', '#D97706', '#059669', '#9333EA', '#DC2626', '#0E7490', '#DB2777', '#475569'];
const hhmm = (t) => (t ? String(t).slice(11, 16) : '');
/** Diferença para o horário: "+4 min", "−2 min", "no horário". */
function difMin(seg) {
  if (seg === null || seg === undefined) return '';
  const m = Math.round(seg / 60);
  return m === 0 ? 'no horário' : `${m > 0 ? '+' : '−'}${Math.abs(m)} min`;
}
function textoDias(d) {
  const s = String(d || '');
  if (s === '1234567') return 'todos os dias';
  if (s === '12345') return 'seg a sex';
  if (s === '123456') return 'seg a sáb';
  if (s === '67') return 'sáb e dom';
  return s.split('').map((x) => (DIAS_SEM[Number(x) - 1] || ['', x])[1].toLowerCase()).join(', ');
}
/** Atraso agora comparado com a tolerância da linha. */
function estadoAtraso(seg, tol) {
  if (seg === null || seg === undefined) return '';
  if (seg > tol.atraso * 60) return 'atrasado';
  if (seg < -tol.adiantado * 60) return 'adiantado';
  return 'no_horario';
}
const CLS_ATRASO = { atrasado: 'wait', adiantado: 'novo', no_horario: 'ok' };

PAGINAS.linhas = (() => {
  const f = { aba: 'hoje', data: '', linha: '', sit: '', busca: '' };
  let offs = [];
  let seq = 0;
  let timer = null;
  let viagens = [];
  let dataViagens = '';
  let linhas = null; // lista resumida (abas e filtro)
  const abertas = new Set(); // viagens com os pontos à mostra
  // editor
  let ed = null;
  let mapa = null;
  let camada = null;

  const ABAS = [['hoje', 'Viagens do dia', 'calendar-time'], ['linhas', 'Linhas', 'route']];
  const pode = (acao) => podeTela('linhas', acao);
  const hoje = () => textoServidor().slice(0, 10);

  function render(c, params) {
    if (params.linha) { renderEditor(c, params.linha); return; }
    if (params.aba && ABAS.some(([id]) => id === params.aba)) f.aba = params.aba;
    if (params.data) f.data = params.data;
    if (!f.data) f.data = hoje();
    c.innerHTML = `
      <div class="page">
        <div class="kpis k5 ln-kpis" id="ln-kpis" hidden></div>
        <section class="card">
          <div class="tabs" id="ln-abas">${ABAS.map(([id, t, i]) => `<button class="tab${id === f.aba ? ' active' : ''}" type="button" data-aba="${id}">${ico(i, 'i-sm')} ${H(t)}</button>`).join('')}</div>
          <div id="ln-corpo"><p class="hint">Carregando…</p></div>
        </section>
      </div>`;
    $('#ln-abas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aba]');
      if (!b) return;
      f.aba = b.dataset.aba;
      $$('#ln-abas .tab').forEach((x) => x.classList.toggle('active', x === b));
      desenhar();
    });
    $('#ln-kpis').addEventListener('click', (e) => {
      const k = e.target.closest('[data-sit]');
      if (!k) return;
      f.sit = k.dataset.sit;
      if (f.aba !== 'hoje') { f.aba = 'hoje'; $$('#ln-abas .tab').forEach((x) => x.classList.toggle('active', x.dataset.aba === 'hoje')); }
      desenhar();
    });
    $('#ln-corpo').addEventListener('click', clique);
    carregar();
    offs.push(on('viagens', () => { clearTimeout(timer); timer = setTimeout(carregar, 500); }));
    offs.push(on('empresa', () => { f.linha = ''; carregar(); }));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    clearTimeout(timer);
    removerMapa(mapa);
    mapa = null;
    camada = null;
    ed = null;
    seq++;
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const emp = S.empresa ? { empresa: S.empresa } : {};
      const [rl, rv] = await Promise.all([api(`/api/linhas?${qs(emp)}`), api(`/api/viagens?${qs({ ...emp, data: f.data })}`)]);
      if (meu !== seq || !$('#ln-corpo')) return;
      linhas = rl.linhas;
      viagens = rv.viagens;
      dataViagens = rv.data;
      if (f.linha && !linhas.some((l) => String(l.id) === String(f.linha))) f.linha = '';
      desenharKpis();
      desenhar();
    } catch (e) {
      if (meu === seq && $('#ln-corpo')) $('#ln-corpo').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  /* ---------- números do dia ---------- */

  const atrasadaAgora = (v) => v.situacao === 'em_andamento' && estadoAtraso(v.atrasoAtual, v.tolerancia) === 'atrasado';

  function desenharKpis() {
    const box = $('#ln-kpis');
    if (!box) return;
    box.hidden = !linhas.length;
    if (!linhas.length) return;
    const vs = viagens.filter((v) => !f.linha || String(v.linhaId) === String(f.linha));
    const n = (s) => vs.filter((v) => v.situacao === s).length;
    const total = vs.filter((v) => v.situacao !== 'cancelada').length;
    const atras = vs.filter(atrasadaAgora).length;
    const saidas = vs.filter((v) => v.pontos.length && v.pontos[0].realizado);
    const saidaOk = saidas.filter((v) => v.pontos[0].situacao === 'no_horario').length;
    const fora = vs.filter((v) => v.foraRotaSeg > 0).length;
    const tile = (sit, i, rotulo, valor, sub, cls) => `<div class="kpi clic ${cls}" data-sit="${sit}" role="button" tabindex="0"><div class="kpi-ico">${ico(i)}</div><div class="kpi-body"><div class="kpi-label">${H(rotulo)}</div><div class="kpi-value">${valor}</div><div class="kpi-sub">${H(sub)}</div></div></div>`;
    const canc = n('cancelada');
    box.innerHTML = tile('', 'calendar-time', dataViagens === hoje() ? 'Viagens de hoje' : `Viagens de ${dataViagens.split('-').reverse().join('/')}`, fmtNum(total), canc ? `${canc} cancelada(s)` : 'pelos horários das linhas', 'neutral')
      + tile('em_andamento', 'bus', 'Em andamento', fmtNum(n('em_andamento')), atras ? `${atras} atrasada(s) agora` : 'nenhuma atrasada agora', atras ? 'warn' : 'ok')
      + tile('concluida', 'circle-check', 'Concluídas', fmtNum(n('concluida')), saidas.length ? `${Math.round((saidaOk / saidas.length) * 100)}% saíram no horário` : 'nenhuma saída ainda', 'ok')
      + tile('nao_realizada', 'ban', 'Não realizadas', fmtNum(n('nao_realizada')), `${n('incompleta')} incompleta(s)`, n('nao_realizada') || n('incompleta') ? 'err' : 'neutral')
      + tile('fora', 'route-2', 'Saíram da rota', fmtNum(fora), 'saíram do percurso gravado', fora ? 'warn' : 'neutral');
  }

  function desenhar() {
    const box = $('#ln-corpo');
    if (!box || !linhas) return;
    if (!linhas.length) { box.innerHTML = htmlVazio(); return; }
    box.innerHTML = f.aba === 'hoje' ? htmlHoje() : htmlLinhas();
    const b = $('#ln-busca');
    if (b) {
      b.value = f.busca;
      b.addEventListener('input', () => { f.busca = b.value; const t = $('#ln-tabela'); if (t) t.innerHTML = f.aba === 'hoje' ? tabelaViagens() : tabelaLinhas(); });
    }
    const d = $('#ln-data');
    if (d) d.addEventListener('change', () => { f.data = d.value || hoje(); abertas.clear(); carregar(); });
    const l = $('#ln-linha');
    if (l) l.addEventListener('change', () => { f.linha = l.value; desenharKpis(); $('#ln-tabela').innerHTML = tabelaViagens(); });
    const s = $('#ln-sit');
    if (s) s.addEventListener('change', () => { f.sit = s.value; $('#ln-tabela').innerHTML = tabelaViagens(); });
  }

  function htmlVazio() {
    return `<div class="mn-vazio">
      <div class="mn-vazio-ico">${ico('route')}</div>
      <h3>Nenhuma linha cadastrada — e está tudo bem assim</h3>
      <p>Esta tela é opcional. Cadastre uma <b>linha</b> com os pontos na ordem (garagem, pontos, escolas, terminal), o tempo previsto até cada um e os <b>horários de partida</b>. A cada dia o sistema acompanha cada viagem pelo GPS: se saiu no horário, se está atrasada ou adiantada, se pulou algum ponto e, com o percurso gravado, se saiu da rota.</p>
      ${pode('incluir') ? `<div class="mn-vazio-acoes"><button class="btn btn-primary" type="button" data-nova-linha>${ico('plus', 'i-sm')} Cadastrar linha</button></div>` : ''}
    </div>`;
  }

  /* ---------- viagens do dia ---------- */

  function htmlHoje() {
    const ops = [['', 'Todas'], ['em_andamento', 'Em andamento'], ['atrasadas', 'Atrasadas agora'], ['prevista', 'Previstas'], ['concluida', 'Concluídas'],
      ['incompleta', 'Incompletas'], ['nao_realizada', 'Não realizadas'], ['fora', 'Saíram da rota'], ['cancelada', 'Canceladas']];
    return `<div class="toolbar">
        <label class="field">Dia<input type="date" id="ln-data" value="${H(f.data)}" max="${hoje()}"></label>
        <label class="field">Linha<select id="ln-linha"><option value="">Todas as linhas</option>${linhas.map((l) => `<option value="${l.id}"${String(l.id) === String(f.linha) ? ' selected' : ''}>${H(nomeLinha(l))}</option>`).join('')}</select></label>
        <label class="field">Situação<select id="ln-sit">${ops.map(([v, t]) => `<option value="${v}"${v === f.sit ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="search">${ico('search', 'i-sm')}<input id="ln-busca" placeholder="Veículo ou linha" autocomplete="off"></label>
        <div class="grow"></div>
        ${podeTela('relatorios') ? `<a class="btn" href="#/relatorios?tipo=viagens">${ico('file-analytics', 'i-sm')} Relatório</a>` : ''}
      </div>
      <div class="table-wrap tall" id="ln-tabela">${tabelaViagens()}</div>
      <p class="hint">Cada viagem começa quando o veículo sai do primeiro ponto perto do horário (até 30 min antes). Não saiu até 1 h depois: não realizada. As viagens do dia são criadas à meia-noite e quando uma linha é salva.</p>`;
  }

  const nomeLinha = (l) => `${l.codigo ? `${l.codigo} · ` : ''}${l.nome}`;

  function filtradasViagens() {
    const b = norm(f.busca);
    return viagens.filter((v) => (!f.linha || String(v.linhaId) === String(f.linha))
      && (!f.sit || (f.sit === 'atrasadas' ? atrasadaAgora(v) : f.sit === 'fora' ? v.foraRotaSeg > 0 : v.situacao === f.sit))
      && (!b || norm([v.linha, v.veiculo].join(' ')).includes(b)));
  }

  function tabelaViagens() {
    const l = filtradasViagens();
    if (!l.length) {
      const vazio = !viagens.length
        ? (f.data === hoje() ? 'Nenhuma viagem hoje: confira os horários e os dias da semana das partidas.' : 'Nenhuma viagem neste dia.')
        : 'Nenhuma viagem com esses filtros.';
      return `<table class="tbl"><tbody><tr><td class="empty">${H(vazio)}</td></tr></tbody></table>`;
    }
    const alt = pode('alterar');
    const linhasHtml = l.map((v) => {
      const ativa = ['prevista', 'em_andamento'].includes(v.situacao);
      const est = v.situacao === 'em_andamento' ? estadoAtraso(v.atrasoAtual, v.tolerancia) : '';
      const pct = v.pontosTotal ? Math.round((v.pontosPassados / v.pontosTotal) * 100) : 0;
      let sitSub = '';
      if (v.situacao === 'em_andamento' || v.situacao === 'incompleta') sitSub = v.inicioReal ? `saiu ${hhmm(v.inicioReal)}` : '';
      else if (v.situacao === 'concluida') sitSub = `${v.inicioReal ? `saiu ${hhmm(v.inicioReal)} · ` : ''}chegou ${hhmm(v.fimReal)}`;
      else if (v.situacao === 'cancelada') sitSub = v.observacao || '';
      else if (v.situacao === 'prevista' && msDe(v.previstoInicio) < Date.now()) sitSub = 'aguardando a saída';
      const prox = v.proximo ? `<span class="sub">Próximo: ${H(v.proximo.nome)} · ${hhmm(v.proximo.previsto)}${v.proximo.estimado !== v.proximo.previsto ? ` (estimado ${hhmm(v.proximo.estimado)})` : ''}</span>` : '';
      let horario = '<span class="muted">—</span>';
      if (est) horario = `<span class="tag ${CLS_ATRASO[est]}">${H(difMin(v.atrasoAtual))}</span>`;
      else if (['concluida', 'incompleta'].includes(v.situacao) && v.atrasoMax !== null) {
        horario = v.atrasoMax > v.tolerancia.atraso * 60 ? `<span class="sub" style="margin:0">maior atraso ${H(difMin(v.atrasoMax))}</span>` : '<span class="sub" style="margin:0">dentro do horário</span>';
      }
      if (v.foraRotaSeg > 0) horario += `<span class="sub ln-fora">${ico('route-2', 'i-xs')} fora da rota ${H(fmtDur(v.foraRotaSeg))}</span>`;
      const aberto = abertas.has(v.id);
      const tr = `<tr class="clic${aberto ? ' aberta' : ''}" data-viagem="${v.id}">
        <td class="nw"><b class="mono">${H(hhmm(v.previstoInicio))}</b><span class="sub">até ${H(hhmm(v.previstoFim))}</span></td>
        <td><span class="ln-cor" style="--c:${H(v.cor || '#94A3B8')}"></span><b>${H(v.linha)}</b></td>
        <td>${v.veiculo ? H(v.veiculo) : '<span class="muted">sem veículo</span>'}${v.veiculoOrigem === 'troca' ? '<span class="sub">trocado no dia</span>' : ''}</td>
        <td><span class="tag ${SIT_VG[v.situacao][0]}">${SIT_VG[v.situacao][1]}</span>${sitSub ? `<span class="sub">${H(sitSub)}</span>` : ''}</td>
        <td><div class="ln-barra${est === 'atrasado' ? ' atrasado' : ''}"><i style="width:${pct}%"></i></div><span class="sub">${v.pontosPassados}/${v.pontosTotal} pontos${v.pontosPulados ? ` · ${v.pontosPulados} sem passar` : ''}</span>${prox}</td>
        <td>${horario}</td>
        <td class="nw"><div class="ln-acoes">
          ${alt && ativa ? `<button class="btn btn-sm btn-ghost" type="button" data-trocar="${v.id}" title="Trocar o veículo" aria-label="Trocar o veículo">${ico('arrows-exchange', 'i-sm')}</button>
            <button class="btn btn-sm btn-ghost" type="button" data-cancelar="${v.id}" title="Cancelar a viagem" aria-label="Cancelar a viagem">${ico('ban', 'i-sm')}</button>` : ''}
          <span class="ln-seta">${ico(aberto ? 'chevron-down' : 'chevron-right', 'i-sm')}</span></div></td>
      </tr>`;
      return aberto ? tr + htmlPontosViagem(v) : tr;
    }).join('');
    return `<table class="tbl ln-tab"><thead><tr><th>Partida</th><th>Linha</th><th>Veículo</th><th>Situação</th><th>Andamento</th><th>Horário</th><th></th></tr></thead><tbody>${linhasHtml}</tbody></table>`;
  }

  function htmlPontosViagem(v) {
    return `<tr class="ln-det"><td colspan="7"><ol class="ln-pts">${v.pontos.map((p) => `<li class="${p.situacao}">
      <b>${H(p.nome)}</b><span>previsto ${H(hhmm(p.previsto))}</span>
      <span>${p.realizado ? `passou ${H(hhmm(p.realizado))} · ${H(difMin(p.diferenca))}` : p.situacao === 'pulado' ? 'não passou' : '—'}</span></li>`).join('')}</ol></td></tr>`;
  }

  /* ---------- linhas ---------- */

  function htmlLinhas() {
    return `<div class="toolbar">
        <label class="search">${ico('search', 'i-sm')}<input id="ln-busca" placeholder="Código ou nome da linha" autocomplete="off"></label>
        <div class="grow"></div>
        ${pode('incluir') ? `<button class="btn btn-primary" type="button" data-nova-linha>${ico('plus', 'i-sm')} Nova linha</button>` : ''}
      </div>
      <div class="table-wrap tall" id="ln-tabela">${tabelaLinhas()}</div>`;
  }

  function tabelaLinhas() {
    const b = norm(f.busca);
    const l = linhas.filter((x) => !b || norm([x.codigo, x.nome, x.grupo, x.empresa].join(' ')).includes(b));
    const master = S.eu.perfil === 'master' && !S.empresa;
    return tabela([
      { t: 'Linha', v: (x) => `<span class="ln-cor" style="--c:${H(x.cor || '#94A3B8')}"></span><b>${H(nomeLinha(x))}</b><span class="sub">${H([x.grupo ? `grupo ${x.grupo}` : 'empresa toda', master ? x.empresa : ''].filter(Boolean).join(' · '))}</span>` },
      { t: 'Pontos', cls: 'nw', v: (x) => `${fmtNum(x.pontos)}<span class="sub">${fmtNum(x.duracaoMin)} min do início ao fim</span>` },
      { t: 'Partidas', cls: 'nw', v: (x) => fmtNum(x.partidas) },
      { t: 'Viagens hoje', cls: 'nw', v: (x) => fmtNum(x.viagensHoje) },
      { t: 'Percurso', cls: 'nw', v: (x) => (x.temPercurso ? `gravado<span class="sub">corredor de ${fmtNum(x.corredor)} m</span>` : '<span class="muted">só os pontos</span>') },
      { t: 'Situação', v: (x) => (x.ativo ? '<span class="tag ok">Ativa</span>' : '<span class="tag off">Desligada</span>') },
    ], l, { vazio: 'Nenhuma linha com essa busca.', linhaCls: (x) => `clic${x.ativo ? '' : ' inativo'}`, atributos: (x) => `data-linha="${x.id}"` });
  }

  /* ---------- cliques ---------- */

  async function clique(e) {
    const t = e.target;
    if (t.closest('[data-nova-linha]')) { navegar('linhas', qs({ linha: 'nova' })); return; }
    const tl = t.closest('[data-trocar]');
    if (tl) { trocarVeiculo(viagens.find((v) => v.id === Number(tl.dataset.trocar))); return; }
    const cn = t.closest('[data-cancelar]');
    if (cn) { cancelarViagem(viagens.find((v) => v.id === Number(cn.dataset.cancelar))); return; }
    const lv = t.closest('tr[data-viagem]');
    if (lv) {
      const id = Number(lv.dataset.viagem);
      if (abertas.has(id)) abertas.delete(id); else abertas.add(id);
      $('#ln-tabela').innerHTML = tabelaViagens();
      return;
    }
    const ll = t.closest('tr[data-linha]');
    if (ll) navegar('linhas', qs({ linha: ll.dataset.linha }));
  }

  function veiculosDaEmpresa(empresaId) {
    return [...S.itens.values()].filter((i) => i.veiculoId && String(i.empresaId) === String(empresaId))
      .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
  }

  function trocarVeiculo(v) {
    if (!v) return;
    const vs = veiculosDaEmpresa(v.empresaId);
    formulario({
      titulo: `Trocar o veículo: ${v.linha} · ${hhmm(v.previstoInicio)}`, icone: 'arrows-exchange', tamanho: 'sm', textoSalvar: 'Trocar',
      aviso: v.situacao === 'em_andamento' ? 'A viagem já começou: o acompanhamento segue com o veículo novo a partir de agora.' : 'Só esta viagem muda; a escala da partida (nos horários da linha) continua a mesma.',
      campos: [{ nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', cheio: true, opcoes: [{ v: '', t: '— Sem veículo' }, ...vs.map((i) => ({ v: i.veiculoId, t: `${rotulo(i)}${i.online ? ' — online' : ''}` }))] }],
      valores: { veiculo: v.veiculoId || '' },
      salvar: async (d) => {
        await api(`/api/viagens/${v.id}/veiculo`, { corpo: { veiculo: d.veiculo || null } });
        toast('Veículo trocado.', 'ok');
        carregar();
      },
    });
  }

  function cancelarViagem(v) {
    if (!v) return;
    formulario({
      titulo: `Cancelar a viagem: ${v.linha} · ${hhmm(v.previstoInicio)}`, icone: 'ban', tamanho: 'sm', textoSalvar: 'Cancelar a viagem',
      aviso: 'A viagem cancelada não conta como não realizada no relatório. O motivo fica registrado.',
      campos: [{ nome: 'motivo', rotulo: 'Motivo', tipo: 'textarea', obrigatorio: true, max: 300 }],
      salvar: async (d) => {
        await api(`/api/viagens/${v.id}/cancelar`, { corpo: { motivo: d.motivo } });
        toast('Viagem cancelada.', 'ok');
        carregar();
      },
    });
  }

  /* ---------- editor da linha ---------- */

  async function renderEditor(c, id) {
    c.innerHTML = '<div class="page" id="ln-ed"><p class="hint">Carregando…</p></div>';
    const meu = ++seq;
    let l = null;
    try {
      if (id !== 'nova') l = (await api(`/api/linhas/${Number(id)}`)).linha;
    } catch (e) {
      if (meu === seq && $('#ln-ed')) $('#ln-ed').innerHTML = `<section class="card"><p class="hint" style="color:var(--err)">${H(e.message)}</p><p class="hint"><a class="link" href="#/linhas?aba=linhas">Voltar às linhas</a></p></section>`;
      return;
    }
    if (meu !== seq || !$('#ln-ed')) return;
    if (!l && !pode('incluir')) { navegar('linhas'); return; }
    let empresaId = l ? l.empresaId : null;
    if (!l) {
      empresaId = await escolherEmpresa();
      if (!empresaId) { navegar('linhas', qs({ aba: 'linhas' })); return; }
      if (meu !== seq || !$('#ln-ed')) return;
    }
    const usadas = new Set((linhas || []).map((x) => x.cor));
    ed = {
      id: l ? l.id : null, empresaId, editavel: l ? l.editavel && pode('alterar') : true,
      cor: l ? l.cor || CORES_LINHA[0] : CORES_LINHA.find((x) => !usadas.has(x)) || CORES_LINHA[0],
      pontos: l ? l.pontos.map((p) => ({ nome: p.nome, latitude: p.latitude, longitude: p.longitude, raio: p.raio, minutos: p.minutos })) : [],
      partidas: l ? l.partidas.map((p) => ({ id: p.id, horario: p.horario, dias: p.dias, veiculo: p.veiculo || '', ativo: p.ativo })) : [],
      percurso: l && l.percurso && l.percurso.length > 1 ? l.percurso : null,
      original: l,
    };
    desenharEditor(l);
  }

  function desenharEditor(l) {
    const v = l || { codigo: '', nome: '', grupoId: null, corredor: 200, toleranciaAdiantado: 2, toleranciaAtraso: 5, alertaForaRota: true, alertaAtraso: null, alertaPulado: false, observacao: '', ativo: true };
    const grupos = S.grupos.filter((g) => String(g.empresaId) === String(ed.empresaId));
    const limitado = S.eu.perfil !== 'master' && !S.eu.todosGrupos;
    const dis = ed.editavel ? '' : ' disabled';
    $('#ln-ed').innerHTML = `
      <section class="card oc-topo">
        <a class="link oc-voltar" href="#/linhas?aba=linhas">${ico('arrow-left', 'i-sm')} Linhas</a>
        <div class="oc-cab">
          <div class="oc-cab-txt"><h2>${l ? H(nomeLinha(l)) : 'Nova linha'}</h2>
            <div class="muted" style="font-size:12.5px">${l ? (ed.editavel ? 'Mudanças nos pontos e horários valem para as viagens de hoje que ainda não começaram.' : 'Só para consulta.') : 'Marque os pontos no mapa, na ordem, e informe os horários de partida.'}</div></div>
          <div class="oc-acoes">
            ${l && pode('excluir') && l.editavel ? `<button class="btn btn-ghost" type="button" data-excluir-linha title="Excluir linha" aria-label="Excluir linha">${ico('trash', 'i-sm')}</button>` : ''}
            ${ed.editavel ? `<a class="btn" href="#/linhas?aba=linhas">Cancelar</a><button class="btn btn-primary" type="button" data-salvar-linha>${ico('check', 'i-sm')} Salvar linha</button>` : ''}
          </div>
        </div>
        <p class="form-erro" id="ln-erro" hidden></p>
      </section>
      <div class="ln-grid">
        <div class="oc-col">
          <section class="card">
            <div class="card-head"><h2>${ico('list-details', 'i-sm')} Dados da linha</h2></div>
            <div class="card-body"><div class="ln-dados">
              <label class="field"><span>Código</span><input id="ld-codigo" maxlength="20" placeholder="101" value="${H(v.codigo || '')}"${dis}></label>
              <label class="field"><span>Nome <span class="req">*</span></span><input id="ld-nome" maxlength="100" placeholder="Centro — Bairro Novo" value="${H(v.nome || '')}"${dis}></label>
              <div class="field">Cor<div class="ln-cores" id="ld-cores">${CORES_LINHA.map((c) => `<button type="button" data-cor="${c}" style="--c:${c}" class="${c === ed.cor ? 'on' : ''}" aria-label="Cor ${c}"${dis}></button>`).join('')}</div></div>
              <label class="field"><span>Grupo</span><select id="ld-grupo"${dis}>${limitado ? '' : '<option value="">Empresa toda</option>'}${grupos.map((g) => `<option value="${g.id}"${String(g.id) === String(v.grupoId) ? ' selected' : ''}>${H(g.caminho)}</option>`).join('')}</select>
                <small>Quem só enxerga alguns grupos vê as linhas da empresa toda e as dos seus grupos.</small></label>
              <div class="form-sep full">Acompanhamento</div>
              <label class="field"><span>Tolerância de adiantado (min)</span><input type="number" id="ld-tad" min="0" max="30" value="${v.toleranciaAdiantado}"${dis}></label>
              <label class="field"><span>Tolerância de atraso (min)</span><input type="number" id="ld-tat" min="0" max="60" value="${v.toleranciaAtraso}"${dis}></label>
              <label class="field"><span>Corredor do percurso (m)</span><input type="number" id="ld-corr" min="50" max="2000" step="10" value="${v.corredor}"${dis}>
                <small>Com o percurso gravado: passou disso por 30 s, está fora da rota.</small></label>
              <label class="field"><span>Avisar atraso acima de (min)</span><input type="number" id="ld-aat" min="1" max="240" placeholder="não avisar" value="${v.alertaAtraso ?? ''}"${dis}>
                <small>Um alerta por viagem, em Alertas e no celular.</small></label>
              <label class="field field-check"><input type="checkbox" id="ld-afr"${v.alertaForaRota ? ' checked' : ''}${dis}> Alerta quando sair da rota</label>
              <label class="field field-check"><input type="checkbox" id="ld-apu"${v.alertaPulado ? ' checked' : ''}${dis}> Alerta quando não passar num ponto</label>
              <label class="field full"><span>Observação</span><input id="ld-obs" maxlength="500" value="${H(v.observacao || '')}"${dis}></label>
              <label class="field field-check full" style="padding-top:0"><input type="checkbox" id="ld-ativo"${v.ativo ? ' checked' : ''}${dis}> Linha ativa (desligada, não gera viagens)</label>
            </div></div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('bus-stop', 'i-sm')} Pontos, na ordem</h2><span class="count" id="ln-npts"></span></div>
            <div class="card-body">
              ${ed.editavel ? `<p class="hint" style="padding:0 0 10px">${ico('map-pin-plus', 'i-xs')} Clique no mapa para pôr o próximo ponto; arraste para ajustar. O primeiro é de onde sai; o último, aonde chega. <b>Previsto</b> = minutos depois da partida.</p>` : ''}
              <div id="ln-pontos"></div>
            </div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('clock-play', 'i-sm')} Horários de partida</h2>
              ${ed.editavel ? `<div class="oc-acoes"><button class="btn btn-sm" type="button" data-add-partida>${ico('plus', 'i-sm')} Horário</button><button class="btn btn-sm" type="button" data-gerar-partidas>${ico('list-numbers', 'i-sm')} Vários de uma vez</button></div>` : ''}</div>
            <div class="card-body"><div id="ln-partidas"></div></div>
          </section>
        </div>
        <div class="oc-col ln-col-mapa">
          <section class="card">
            <div class="card-head"><h2>${ico('map-route', 'i-sm')} Mapa</h2>
              ${ed.editavel ? `<div class="oc-acoes"><button class="btn btn-sm" type="button" data-gravar-percurso>${ico('player-record', 'i-sm')} Percurso de uma viagem</button>
                <button class="btn btn-sm btn-ghost" type="button" data-tirar-percurso title="Tirar o percurso" aria-label="Tirar o percurso">${ico('trash', 'i-sm')}</button></div>` : ''}</div>
            <div class="card-body"><div class="ln-mapa" id="ln-mapa"></div><p class="hint" id="ln-map-info" style="padding:8px 0 0"></p></div>
          </section>
        </div>
      </div>`;
    const box = $('#ln-ed');
    box.addEventListener('click', cliqueEditor);
    box.addEventListener('input', entradaEditor);
    box.addEventListener('change', mudancaEditor);
    desenharPontos();
    desenharPartidas();
    criarMapaEditor();
  }

  function desenharPontos() {
    const box = $('#ln-pontos');
    if (!box) return;
    $('#ln-npts').textContent = ed.pontos.length ? `${ed.pontos.length} ponto(s) · ${ed.pontos[ed.pontos.length - 1].minutos} min` : '';
    if (!ed.pontos.length) { box.innerHTML = `<p class="hint" style="padding:0">Nenhum ponto ainda.${ed.editavel ? ' Clique no mapa onde a viagem começa.' : ''}</p>`; return; }
    const dis = ed.editavel ? '' : ' disabled';
    const n = ed.pontos.length;
    box.innerHTML = `<div class="ln-pt-cab"><span>#</span><span>Ponto</span><span>Previsto</span><span>Raio</span><span></span></div>${ed.pontos.map((p, i) => `
      <div class="ln-pt" data-i="${i}">
        <button class="ln-num${i === 0 || i === n - 1 ? ' ponta' : ''}" type="button" data-foco="${i}" style="--c:${ed.cor}" title="Mostrar no mapa">${i + 1}</button>
        <input data-campo="nome" maxlength="80" value="${H(p.nome)}" placeholder="Nome do ponto" aria-label="Nome do ponto ${i + 1}"${dis}>
        <label class="ln-un" title="Minutos depois da partida"><input type="number" data-campo="minutos" min="0" max="1440" value="${p.minutos}" aria-label="Minutos até o ponto ${i + 1}"${i === 0 ? ' disabled' : dis}><span>min</span></label>
        <label class="ln-un" title="Raio do ponto: chegou a essa distância, passou pelo ponto"><input type="number" data-campo="raio" min="15" max="1000" step="5" value="${p.raio}" aria-label="Raio do ponto ${i + 1}"${dis}><span>m</span></label>
        <div class="ln-pt-acoes">${ed.editavel ? `
          <button class="btn btn-sm btn-ghost" type="button" data-mover="-1" title="Subir" aria-label="Subir"${i === 0 ? ' disabled' : ''}>${ico('arrow-up', 'i-sm')}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-mover="1" title="Descer" aria-label="Descer"${i === n - 1 ? ' disabled' : ''}>${ico('arrow-down', 'i-sm')}</button>
          <button class="btn btn-sm btn-ghost" type="button" data-tirar-ponto title="Tirar o ponto" aria-label="Tirar o ponto">${ico('trash', 'i-sm')}</button>` : ''}</div>
      </div>`).join('')}`;
  }

  function opcoesVeic(sel) {
    const vs = veiculosDaEmpresa(ed.empresaId);
    return `<option value="">Sem veículo fixo</option>${vs.map((i) => `<option value="${i.veiculoId}"${String(i.veiculoId) === String(sel) ? ' selected' : ''}>${H(rotulo(i))}</option>`).join('')}`;
  }

  function desenharPartidas() {
    const box = $('#ln-partidas');
    if (!box) return;
    ed.partidas.sort((a, b) => String(a.horario).localeCompare(String(b.horario)));
    if (!ed.partidas.length) { box.innerHTML = `<p class="hint" style="padding:0">Nenhum horário ainda.${ed.editavel ? ' Use <b>Horário</b> ou <b>Vários de uma vez</b> (ex.: das 5h às 23h, a cada 20 min).' : ''}</p>`; return; }
    const dis = ed.editavel ? '' : ' disabled';
    box.innerHTML = `<div class="ln-pa-cab"><span>Partida</span><span>Dias</span><span>Veículo da escala</span><span>Ativa</span><span></span></div>${ed.partidas.map((p, j) => `
      <div class="ln-pa${p.ativo ? '' : ' off'}" data-j="${j}">
        <label class="ln-hora"><input type="time" data-campo="horario" value="${H(p.horario)}" aria-label="Horário de partida"${dis}><small>chega ${chegada(p.horario)}</small></label>
        <div class="ln-dias" role="group" aria-label="Dias da semana">${DIAS_SEM.map(([d, t]) => `<label class="${p.dias.includes(d) ? 'on' : ''}" title="${t}"><input type="checkbox" data-dia="${d}"${p.dias.includes(d) ? ' checked' : ''}${dis}>${t[0]}</label>`).join('')}</div>
        <select data-campo="veiculo" aria-label="Veículo da escala"${dis}>${opcoesVeic(p.veiculo)}</select>
        <label class="ln-ativo" title="Desligada, não gera viagem"><input type="checkbox" data-campo="ativo" aria-label="Partida ativa"${p.ativo ? ' checked' : ''}${dis}><span>ativa</span></label>
        ${ed.editavel ? `<button class="btn btn-sm btn-ghost" type="button" data-tirar-partida title="Tirar o horário" aria-label="Tirar o horário">${ico('trash', 'i-sm')}</button>` : '<span></span>'}
      </div>`).join('')}`;
  }

  /** Hora prevista de chegada ao último ponto. */
  function chegada(h) {
    const m = /^(\d{2}):(\d{2})$/.exec(h || '');
    if (!m || !ed.pontos.length) return '';
    const t = (Number(m[1]) * 60 + Number(m[2]) + ed.pontos[ed.pontos.length - 1].minutos) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  /* mapa do editor */

  function criarMapaEditor() {
    removerMapa(mapa);
    mapa = criarMapa($('#ln-mapa'), { silencioso: true });
    if (!mapa) return;
    camada = L.layerGroup().addTo(mapa);
    // veículos da empresa como referência (ajudam a achar a garagem)
    const ref = L.layerGroup().addTo(mapa);
    for (const i of veiculosDaEmpresa(ed.empresaId)) {
      if (!temPosicao(i)) continue;
      L.circleMarker([i.posicao.lat, i.posicao.lng], { radius: 4, weight: 1, color: '#fff', fillColor: '#64748B', fillOpacity: 0.9, interactive: true, bubblingMouseEvents: false })
        .bindTooltip(H(rotulo(i)), { direction: 'top', offset: [0, -3] }).addTo(ref);
    }
    if (ed.editavel) mapa.on('click', (e) => adicionarPonto(e.latlng));
    desenharMapaEditor();
    const pts = [...ed.pontos.map((p) => [p.latitude, p.longitude]), ...(ed.percurso || [])];
    if (pts.length) mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    else {
      const vs = veiculosDaEmpresa(ed.empresaId).filter(temPosicao).map((i) => [i.posicao.lat, i.posicao.lng]);
      if (vs.length) mapa.fitBounds(vs, { padding: [40, 40], maxZoom: 14 });
    }
  }

  function desenharMapaEditor() {
    if (!mapa || !camada) return;
    camada.clearLayers();
    const cor = ed.cor;
    if (ed.percurso) L.polyline(ed.percurso, { color: cor, weight: 5, opacity: 0.75 }).addTo(camada);
    else if (ed.pontos.length > 1) L.polyline(ed.pontos.map((p) => [p.latitude, p.longitude]), { color: '#64748B', weight: 2, opacity: 0.8, dashArray: '6 6', interactive: false }).addTo(camada);
    const n = ed.pontos.length;
    ed.pontos.forEach((p, i) => {
      L.circle([p.latitude, p.longitude], { radius: p.raio, color: cor, weight: 1, fillColor: cor, fillOpacity: 0.12, interactive: false }).addTo(camada);
      const m = L.marker([p.latitude, p.longitude], {
        draggable: ed.editavel, keyboard: false, zIndexOffset: 1000 - i,
        icon: L.divIcon({ className: '', html: `<span class="ln-mk${i === 0 || i === n - 1 ? ' ponta' : ''}" style="--c:${cor}">${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).bindTooltip(`${i + 1}. ${H(p.nome)} · ${p.minutos} min`, { direction: 'top', offset: [0, -12] }).addTo(camada);
      m.on('dragend', () => {
        const ll = m.getLatLng();
        p.latitude = Math.round(ll.lat * 1e6) / 1e6;
        p.longitude = Math.round(ll.lng * 1e6) / 1e6;
        desenharMapaEditor();
      });
    });
    const info = $('#ln-map-info');
    if (info) {
      info.textContent = ed.percurso
        ? `Percurso gravado (${fmtNum(ed.percurso.length)} pontos): sair do corredor dele conta como fora da rota.`
        : 'Sem percurso gravado: a linha tracejada só liga os pontos. Grave o percurso de uma viagem para acompanhar o "fora da rota".';
    }
  }

  function adicionarPonto(ll) {
    const lat = Math.round(ll.lat * 1e6) / 1e6;
    const lng = Math.round(ll.lng * 1e6) / 1e6;
    const ant = ed.pontos[ed.pontos.length - 1];
    let minutos = 0;
    if (ant) {
      // sugestão: a distância em linha reta a 20 km/h (o usuário ajusta)
      const km = L.latLng(ant.latitude, ant.longitude).distanceTo([lat, lng]) / 1000;
      minutos = ant.minutos + Math.max(1, Math.round((km / 20) * 60));
    }
    ed.pontos.push({ nome: ed.pontos.length ? `Ponto ${ed.pontos.length + 1}` : 'Saída', latitude: lat, longitude: lng, raio: 60, minutos });
    desenharPontos();
    desenharMapaEditor();
    desenharPartidas();
  }

  function cliqueEditor(e) {
    const t = e.target;
    const cor = t.closest('[data-cor]');
    if (cor && ed.editavel) {
      ed.cor = cor.dataset.cor;
      $$('#ld-cores button').forEach((b) => b.classList.toggle('on', b === cor));
      desenharPontos();
      desenharMapaEditor();
      return;
    }
    const foco = t.closest('[data-foco]');
    if (foco && mapa) { const p = ed.pontos[Number(foco.dataset.foco)]; if (p) mapa.setView([p.latitude, p.longitude], Math.max(mapa.getZoom(), 16)); return; }
    const mv = t.closest('[data-mover]');
    if (mv) {
      const i = Number(mv.closest('[data-i]').dataset.i);
      const j = i + Number(mv.dataset.mover);
      if (j < 0 || j >= ed.pontos.length) return;
      const a = ed.pontos[i];
      ed.pontos[i] = ed.pontos[j];
      ed.pontos[j] = a;
      // o tempo previsto fica com a posição na ordem (o primeiro é sempre 0)
      const mins = [ed.pontos[i].minutos, ed.pontos[j].minutos];
      ed.pontos[i].minutos = mins[1];
      ed.pontos[j].minutos = mins[0];
      ed.pontos[0].minutos = 0;
      desenharPontos();
      desenharMapaEditor();
      return;
    }
    const tp = t.closest('[data-tirar-ponto]');
    if (tp) {
      ed.pontos.splice(Number(tp.closest('[data-i]').dataset.i), 1);
      if (ed.pontos.length) ed.pontos[0].minutos = 0;
      desenharPontos();
      desenharMapaEditor();
      desenharPartidas();
      return;
    }
    if (t.closest('[data-add-partida]')) {
      const ult = ed.partidas[ed.partidas.length - 1];
      ed.partidas.push({ id: null, horario: ult ? somarHora(ult.horario, 60) : '07:00', dias: ult ? ult.dias : '12345', veiculo: ult ? ult.veiculo : '', ativo: true });
      desenharPartidas();
      return;
    }
    if (t.closest('[data-gerar-partidas]')) { gerarPartidas(); return; }
    const tpa = t.closest('[data-tirar-partida]');
    if (tpa) { ed.partidas.splice(Number(tpa.closest('[data-j]').dataset.j), 1); desenharPartidas(); return; }
    if (t.closest('[data-gravar-percurso]')) { gravarPercurso(); return; }
    if (t.closest('[data-tirar-percurso]')) {
      if (!ed.percurso) { toast('A linha não tem percurso gravado.'); return; }
      ed.percurso = null;
      desenharMapaEditor();
      toast('Percurso tirado. Salve a linha para valer.');
      return;
    }
    if (t.closest('[data-salvar-linha]')) { salvar(); return; }
    if (t.closest('[data-excluir-linha]')) excluir();
  }

  function entradaEditor(e) {
    const t = e.target;
    const pt = t.closest('[data-i]');
    if (pt && t.dataset.campo) {
      const p = ed.pontos[Number(pt.dataset.i)];
      if (t.dataset.campo === 'nome') p.nome = t.value;
      else if (t.value !== '') p[t.dataset.campo] = Number(t.value);
    }
  }

  function mudancaEditor(e) {
    const t = e.target;
    if (t.closest('[data-i]') && t.dataset.campo) {
      $('#ln-npts').textContent = `${ed.pontos.length} ponto(s) · ${ed.pontos[ed.pontos.length - 1].minutos} min`;
      desenharMapaEditor();
      if (t.dataset.campo === 'minutos') desenharPartidas();
      return;
    }
    const pa = t.closest('[data-j]');
    if (!pa) return;
    const p = ed.partidas[Number(pa.dataset.j)];
    if (t.dataset.dia) {
      const set = new Set(p.dias.split(''));
      if (t.checked) set.add(t.dataset.dia); else set.delete(t.dataset.dia);
      p.dias = [...set].sort().join('');
      t.closest('label').classList.toggle('on', t.checked);
    } else if (t.dataset.campo === 'horario') {
      p.horario = t.value;
      const sm = pa.querySelector('.ln-hora small');
      if (sm) sm.textContent = `chega ${chegada(p.horario)}`;
    } else if (t.dataset.campo === 'veiculo') p.veiculo = t.value;
    else if (t.dataset.campo === 'ativo') { p.ativo = t.checked; pa.classList.toggle('off', !t.checked); }
  }

  function somarHora(h, min) {
    const m = /^(\d{2}):(\d{2})$/.exec(h || '');
    if (!m) return '07:00';
    const t = Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + min);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  function gerarPartidas() {
    formulario({
      titulo: 'Vários horários de uma vez', icone: 'list-numbers', textoSalvar: 'Adicionar',
      aviso: 'Ex.: primeira às 05:00, última às 23:00, a cada 20 minutos. Os horários que já existem com os mesmos dias não se repetem.',
      campos: [
        { nome: 'primeira', rotulo: 'Primeira partida', tipo: 'hora', obrigatorio: true },
        { nome: 'ultima', rotulo: 'Última partida', tipo: 'hora', obrigatorio: true },
        { nome: 'intervalo', rotulo: 'A cada (minutos)', tipo: 'numero', min: 5, max: 720, obrigatorio: true },
        { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', opcoes: [{ v: '', t: 'Sem veículo fixo' }, ...veiculosDaEmpresa(ed.empresaId).map((i) => ({ v: i.veiculoId, t: rotulo(i) }))] },
        { nome: 'dias', rotulo: 'Dias da semana', tipo: 'multi', opcoes: DIAS_SEM.map(([v, t]) => ({ v, t })) },
      ],
      valores: { primeira: '05:00', ultima: '23:00', intervalo: 30, dias: ['1', '2', '3', '4', '5'] },
      salvar: async (d) => {
        const min = (h) => { const m = /^(\d{2}):(\d{2})$/.exec(h || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
        const a = min(d.primeira);
        const b = min(d.ultima);
        const passo = Number(d.intervalo);
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Informe a primeira e a última partida.');
        if (b < a) throw new Error('A última partida precisa ser depois da primeira.');
        if (!Number.isInteger(passo) || passo < 5) throw new Error('O intervalo precisa ser de pelo menos 5 minutos.');
        if (!d.dias.length) throw new Error('Escolha os dias da semana.');
        const dias = [...d.dias].sort().join('');
        const novos = [];
        for (let t = a; t <= b; t += passo) novos.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
        if (ed.partidas.length + novos.length > 400) throw new Error('No máximo 400 horários por linha.');
        let n = 0;
        for (const h of novos) {
          if (ed.partidas.some((p) => p.horario === h && p.dias === dias && String(p.veiculo || '') === String(d.veiculo || ''))) continue;
          ed.partidas.push({ id: null, horario: h, dias, veiculo: d.veiculo || '', ativo: true });
          n++;
        }
        desenharPartidas();
        toast(`${n} horário(s) adicionado(s). Salve a linha para valer.`, 'ok');
      },
    });
  }

  function gravarPercurso() {
    const vs = veiculosDaEmpresa(ed.empresaId);
    const agora = textoServidor();
    formulario({
      titulo: 'Percurso de uma viagem feita', icone: 'player-record', textoSalvar: 'Usar este percurso',
      aviso: 'Escolha um veículo e o período de uma viagem completa desta linha (do primeiro ao último ponto). O caminho do GPS vira o percurso da linha.',
      campos: [
        { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', cheio: true, opcoes: [{ v: '', t: 'Escolha o veículo' }, ...vs.map((i) => ({ v: i.veiculoId, t: rotulo(i) }))] },
        { nome: 'de', rotulo: 'Saiu em', tipo: 'data', obrigatorio: true },
        { nome: 'ate', rotulo: 'Chegou em', tipo: 'data', obrigatorio: true },
      ],
      valores: { de: paraInput(textoServidor(msDe(agora) - 2 * 3600000)), ate: paraInput(agora) },
      salvar: async (d) => {
        if (!d.veiculo) throw new Error('Escolha o veículo.');
        const r = await api(`/api/linhas-percurso?${qs({ veiculo: d.veiculo, de: deInput(d.de), ate: deInput(d.ate, true) })}`);
        ed.percurso = r.percurso;
        desenharMapaEditor();
        if (mapa) mapa.fitBounds(ed.percurso, { padding: [40, 40], maxZoom: 16 });
        toast(`Percurso com ${fmtNum(r.percurso.length)} pontos (de ${fmtNum(r.posicoes)} posições do GPS). Salve a linha para valer.`, 'ok');
      },
    });
  }

  function lerDados() {
    return {
      codigo: $('#ld-codigo').value.trim(), nome: $('#ld-nome').value.trim(), cor: ed.cor, grupo: $('#ld-grupo').value || null,
      toleranciaAdiantado: $('#ld-tad').value, toleranciaAtraso: $('#ld-tat').value, corredor: $('#ld-corr').value,
      alertaAtraso: $('#ld-aat').value || null, alertaForaRota: $('#ld-afr').checked, alertaPulado: $('#ld-apu').checked,
      observacao: $('#ld-obs').value.trim(), ativo: $('#ld-ativo').checked,
    };
  }

  async function salvar() {
    const erro = $('#ln-erro');
    erro.hidden = true;
    const corpo = {
      ...lerDados(), empresa: ed.empresaId,
      pontos: ed.pontos.map((p) => ({ nome: p.nome, latitude: p.latitude, longitude: p.longitude, raio: p.raio, minutos: p.minutos })),
      partidas: ed.partidas.map((p) => ({ id: p.id || null, horario: p.horario, dias: p.dias, veiculo: p.veiculo || null, ativo: p.ativo })),
      percurso: ed.percurso,
    };
    const b = $('[data-salvar-linha]');
    b.disabled = true;
    try {
      if (ed.id) await api(`/api/linhas/${ed.id}`, { metodo: 'PUT', corpo });
      else await api('/api/linhas', { corpo });
      toast('Linha salva.', 'ok');
      navegar('linhas', qs({ aba: 'linhas' }));
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      b.disabled = false;
    }
  }

  async function excluir() {
    const l = ed.original;
    if (!await confirmar(`Excluir a linha ${nomeLinha(l)}? Os pontos e horários saem junto. Linha que já rodou não pode ser excluída (desligue em vez disso).`, { titulo: 'Excluir linha', ok: 'Excluir', perigo: true })) return;
    try {
      await api(`/api/linhas/${l.id}`, { metodo: 'DELETE' });
      toast('Linha excluída.', 'ok');
      navegar('linhas', qs({ aba: 'linhas' }));
    } catch (e) { toast(e.message, 'err'); }
  }

  return { id: 'linhas', titulo: 'Linhas e horários', sub: 'Cada viagem do dia acompanhada pelo GPS: no horário, atrasada, ponto pulado e fora da rota', render, sair };
})();
