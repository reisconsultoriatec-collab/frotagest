'use strict';
/* FrotaGest — Ocorrências: cada caso (acidente, assalto, avaria, reclamação...) com as provas
 * (gravações do DVR, fotos, arquivos), o trajeto, os alertas do período, o andamento e o dossiê em PDF.
 * Reis Tecnologia */

const SIT_OC = { aberta: ['wait', 'Aberta'], em_analise: ['novo', 'Em análise'], encerrada: ['ok', 'Encerrada'] };
const GRAV_OC = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
const ICO_ANEXO = { gravacao: 'video', foto: 'photo', arquivo: 'paperclip' };
const tamanhoArq = (b) => (b >= 1048576 ? `${fmtNum(b / 1048576, 1)} MB` : `${fmtNum(Math.max(1, Math.round(b / 1024)))} KB`);

/** Abre uma ocorrência: do alerta (pre.alerta), do veículo (pre.veiculoId) ou do zero. */
async function novaOcorrencia(pre = {}) {
  if (!podeTela('ocorrencias', 'incluir')) return;
  const a = pre.alerta || null;
  const itemV = pre.veiculoId ? [...S.itens.values()].find((i) => i.veiculoId === pre.veiculoId) : null;
  const empresaId = a ? a.empresa_id : itemV ? itemV.empresaId : pre.empresaId || await escolherEmpresa();
  if (!empresaId) return;
  let apoio;
  try { apoio = await api(`/api/ocorrencias/apoio?${qs({ empresa: empresaId })}`); } catch (e) { toast(e.message, 'err'); return; }
  const veics = [...S.itens.values()].filter((i) => i.veiculoId && String(i.empresaId) === String(empresaId))
    .sort((x, y) => rotulo(x).localeCompare(rotulo(y), 'pt-BR', { numeric: true }));
  const campos = [
    ...(a ? [] : [{ nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', cheio: true, opcoes: [{ v: '', t: '— Sem veículo (ocorrência geral)' }, ...veics.map((i) => ({ v: i.veiculoId, t: rotulo(i) }))] }]),
    { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', opcoes: apoio.tipos.map((t) => ({ v: t.id, t: t.nome })) },
    { nome: 'gravidade', rotulo: 'Gravidade', tipo: 'select', opcoes: [{ v: 'alta', t: 'Alta' }, { v: 'media', t: 'Média' }, { v: 'baixa', t: 'Baixa' }] },
    { nome: 'titulo', rotulo: 'Título', obrigatorio: true, cheio: true, maxlength: 120, placeholder: 'Colisão traseira no ponto da Av. Rui Barbosa' },
    ...(a ? [] : [{ nome: 'quando', rotulo: 'Data e hora do fato', tipo: 'data', obrigatorio: true }]),
    { nome: 'responsavel', rotulo: 'Responsável', tipo: 'select', opcoes: [{ v: '', t: '— Ninguém ainda' }, ...apoio.responsaveis.map((r) => ({ v: r.id, t: r.nome }))] },
    { nome: 'protocolo', rotulo: 'Protocolo externo', maxlength: 60, placeholder: 'Nº do BO, sinistro...' },
    { nome: 'local', rotulo: 'Local (endereço, referência)', cheio: true, maxlength: 200 },
    { nome: 'descricao', rotulo: 'O que aconteceu', tipo: 'textarea', max: 20000 },
  ];
  formulario({
    titulo: a ? `Ocorrência do alerta: ${a.nome}` : 'Nova ocorrência', icone: 'file-alert',
    aviso: a ? `${H(a.placa || `Aparelho ${a.identificador}`)} · ${H(fmtDataHora(a.inicio))}. O local, o motorista e o trajeto vêm do alerta e do GPS.`
      : 'Com o veículo, o local, o motorista e o trajeto saem do GPS na hora do fato. Depois, junte as provas: as câmeras do momento, fotos e arquivos.',
    campos,
    valores: {
      veiculo: pre.veiculoId || '', tipo: a ? (/colis|batida|impacto|capot/i.test(a.nome) ? 'acidente' : 'outro') : 'outro',
      gravidade: a ? a.gravidade : 'media', titulo: a ? a.nome : '', quando: paraInput(textoServidor()),
    },
    textoSalvar: 'Abrir ocorrência',
    salvar: async (d) => {
      const corpo = { ...d, empresa: empresaId, quando: d.quando ? deInput(d.quando) : undefined, ...(a ? { alerta: a.id } : {}) };
      const r = await api('/api/ocorrencias', { corpo });
      toast(r.existente ? `Este alerta já tem a ocorrência ${r.numero}.` : `Ocorrência ${r.numero} aberta.`, 'ok');
      navegar('ocorrencias', qs({ id: r.id }));
    },
  });
}

PAGINAS.ocorrencias = (() => {
  const f = { situacao: 'abertas', veiculo: '', busca: '' };
  let offs = [];
  let lista = [];
  let det = null; // detalhe aberto
  let idAberto = null;
  let mapa = null;
  let seq = 0;
  let timer = null;

  function render(c, params) {
    idAberto = params.id ? Number(params.id) : null;
    if (idAberto) renderDetalhe(c);
    else renderLista(c);
    offs.push(on('ocorrencias', (m) => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (idAberto) { if (!m || !m.id || m.id === idAberto) carregarDetalhe(); } else carregarLista(); }, 400);
    }));
    offs.push(on('downloads', () => { if (idAberto) desenharBaixando(); }));
    offs.push(on('empresa', () => { if (!idAberto) carregarLista(); }));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    clearTimeout(timer);
    removerMapa(mapa);
    mapa = null;
    det = null;
    seq++;
  }

  /* ---------- lista ---------- */

  function renderLista(c) {
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="toolbar">
            <label class="field">Situação<select id="oc-sit">
              <option value="abertas">Em aberto (abertas e em análise)</option><option value="aberta">Abertas</option>
              <option value="em_analise">Em análise</option><option value="encerrada">Encerradas</option><option value="">Todas</option></select></label>
            <label class="field">Veículo<select id="oc-veic"></select></label>
            <label class="search">${ico('search', 'i-sm')}<input id="oc-busca" placeholder="Nº, título, veículo, motorista, protocolo" autocomplete="off"></label>
            <div class="grow"></div>
            ${podeTela('ocorrencias', 'incluir') ? `<button class="btn btn-primary" type="button" id="oc-nova">${ico('plus', 'i-sm')} Nova ocorrência</button>` : ''}
          </div>
          <div class="card-head" style="border-bottom:0;padding-bottom:6px"><span class="count" id="oc-total"></span></div>
          <div class="table-wrap tall" id="oc-tabela"><p class="hint">Carregando…</p></div>
        </section>
      </div>`;
    $('#oc-sit').value = f.situacao;
    $('#oc-veic').innerHTML = opcoesVeiculos(f.veiculo, { soComAparelho: false, vazio: 'Todos' });
    $('#oc-busca').value = f.busca;
    $('#oc-sit').addEventListener('change', () => { f.situacao = $('#oc-sit').value; carregarLista(); });
    $('#oc-veic').addEventListener('change', () => { f.veiculo = $('#oc-veic').value; carregarLista(); });
    $('#oc-busca').addEventListener('input', () => { f.busca = $('#oc-busca').value; desenharLista(); });
    const nova = $('#oc-nova');
    if (nova) nova.addEventListener('click', () => novaOcorrencia({ empresaId: S.empresa ? Number(S.empresa) : null }));
    $('#oc-tabela').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-oc]');
      if (tr) navegar('ocorrencias', qs({ id: tr.dataset.oc }));
    });
    carregarLista();
  }

  async function carregarLista() {
    const meu = ++seq;
    const it = f.veiculo ? S.itens.get(f.veiculo) : null;
    try {
      const r = await api(`/api/ocorrencias?${qs({ situacao: f.situacao, veiculo: it ? it.veiculoId : '', empresa: S.empresa, limite: 500 })}`);
      if (meu !== seq || !$('#oc-tabela')) return;
      lista = r.ocorrencias;
      desenharLista();
    } catch (e) {
      if (meu === seq && $('#oc-total')) $('#oc-total').textContent = e.message;
    }
  }

  function desenharLista() {
    const box = $('#oc-tabela');
    if (!box) return;
    const b = norm(f.busca);
    const l = b ? lista.filter((o) => norm([o.numero, o.titulo, o.veiculo, o.motorista, o.protocolo, o.tipoNome, o.responsavel].join(' ')).includes(b)) : lista;
    $('#oc-total').textContent = `${fmtNum(l.length)} ocorrência(s)`;
    const master = S.eu.perfil === 'master';
    box.innerHTML = tabela([
      { t: 'Nº', cls: 'nw', v: (o) => `<b class="mono">${H(o.numero)}</b>` },
      { t: 'Data do fato', cls: 'nw', v: (o) => H(fmtDataHora(o.quando)) },
      { t: 'Ocorrência', v: (o) => `<b>${H(o.titulo)}</b><span class="sub">${H(o.tipoNome)}${o.protocolo ? ` · ${H(o.protocolo)}` : ''}</span>` },
      { t: 'Veículo', v: (o) => `${H(o.veiculo || '—')}${o.motorista ? `<span class="sub">${ico('id-badge-2', 'i-xs')} ${H(o.motorista)}</span>` : ''}${master ? `<span class="sub">${H(o.empresa)}</span>` : ''}` },
      { t: 'Gravidade', v: (o) => `<span class="tag ${o.gravidade}">${GRAV_OC[o.gravidade]}</span>` },
      { t: 'Situação', v: (o) => `<span class="tag ${SIT_OC[o.situacao][0]}">${SIT_OC[o.situacao][1]}</span>${o.responsavel ? `<span class="sub">${H(o.responsavel)}</span>` : ''}` },
      { t: 'Provas', cls: 'nw', v: (o) => (o.anexos ? `${ico('paperclip', 'i-xs')} ${fmtNum(o.anexos)}` : '<span class="muted">—</span>') },
    ], l, {
      vazio: f.situacao === 'abertas' ? 'Nenhuma ocorrência em aberto. Abra uma pelo botão acima, por um alerta (Alertas › Abrir ocorrência) ou pelo veículo no Monitoramento.' : 'Nenhuma ocorrência com esses filtros.',
      linhaCls: () => 'clic', atributos: (o) => `data-oc="${o.id}"`,
    });
  }

  /* ---------- detalhe ---------- */

  function renderDetalhe(c) {
    c.innerHTML = '<div class="page" id="oc-det"><p class="hint">Carregando…</p></div>';
    $('#oc-det').addEventListener('click', clique);
    carregarDetalhe();
  }

  async function carregarDetalhe() {
    const meu = ++seq;
    try {
      const r = await api(`/api/ocorrencias/${idAberto}`);
      if (meu !== seq || !$('#oc-det')) return;
      det = r;
      desenharDetalhe();
    } catch (e) {
      if (meu === seq && $('#oc-det')) $('#oc-det').innerHTML = `<section class="card"><p class="hint" style="color:var(--err)">${H(e.message)}</p><p><a class="link" href="#/ocorrencias">Voltar às ocorrências</a></p></section>`;
    }
  }

  const pode = (acao) => podeTela('ocorrencias', acao);

  function desenharDetalhe() {
    const o = det.ocorrencia;
    const fechada = o.situacao === 'encerrada';
    const rolagem = window.scrollY;
    const campos = [
      ['Veículo', o.veiculo || '—'],
      ['Motorista', o.motorista ? `${o.motorista.nome}${o.motorista.matricula ? ` (${o.motorista.matricula})` : ''}` : '—'],
      ['Data do fato', fmtDataHora(o.quando)],
      ['Local', [o.cerca ? `dentro de ${o.cerca}` : '', o.local_texto || ''].filter(Boolean).join(' · ') || (o.latitude !== null ? 'no mapa abaixo' : '—')],
      ['Responsável', o.responsavel ? o.responsavel.nome : '—'],
      ['Protocolo externo', o.protocolo || '—'],
      ['Aberta por', `${o.criadoPor || 'Sistema'} · ${fmtCurto(o.criado_em)}`],
      ['Alerta de origem', o.alerta ? `${o.alerta.nome} · ${fmtDataHora(o.alerta.inicio)}` : '—'],
      ...(S.eu.perfil === 'master' ? [['Empresa', o.empresa]] : []),
      ...(fechada ? [['Encerrada por', `${o.encerradoPor || '—'} · ${fmtCurto(o.encerrado_em)}`]] : []),
    ];
    $('#oc-det').innerHTML = `
      <section class="card oc-topo">
        <a class="link oc-voltar" href="#/ocorrencias">${ico('arrow-left', 'i-sm')} Ocorrências</a>
        <div class="oc-cab">
          <div class="oc-cab-txt">
            <div class="oc-num mono">Nº ${H(o.numero)}</div>
            <h2>${H(o.titulo)}</h2>
            <div class="oc-tags"><span class="tag ${SIT_OC[o.situacao][0]}">${SIT_OC[o.situacao][1]}</span><span class="tag ${o.gravidade}">${GRAV_OC[o.gravidade]}</span><span class="tag off">${H(o.tipoNome)}</span></div>
          </div>
          <div class="oc-acoes">
            ${pode('alterar') ? `<button class="btn" type="button" data-editar>${ico('pencil', 'i-sm')} Editar</button>` : ''}
            ${pode('alterar') && !fechada ? `<button class="btn" type="button" data-sit="${o.situacao === 'aberta' ? 'em_analise' : 'aberta'}">${ico('progress', 'i-sm')} ${o.situacao === 'aberta' ? 'Em análise' : 'Voltar para aberta'}</button>
              <button class="btn" type="button" data-sit="encerrada">${ico('circle-check', 'i-sm')} Encerrar</button>` : ''}
            ${pode('alterar') && fechada ? `<button class="btn" type="button" data-sit="aberta">${ico('refresh', 'i-sm')} Reabrir</button>` : ''}
            <button class="btn btn-primary" type="button" data-dossie>${ico('file-type-pdf', 'i-sm')} Dossiê em PDF</button>
            ${pode('excluir') ? `<button class="btn btn-ghost" type="button" data-excluir-oc title="Excluir ocorrência" aria-label="Excluir ocorrência">${ico('trash', 'i-sm')}</button>` : ''}
          </div>
        </div>
      </section>
      <div class="oc-grid">
        <div class="oc-col">
          <section class="card">
            <div class="card-head"><h2>${ico('list-details', 'i-sm')} Dados</h2></div>
            <div class="card-body">
            <dl class="oc-dados">${campos.map(([k, v]) => `<div><dt>${H(k)}</dt><dd>${H(v)}</dd></div>`).join('')}</dl>
            ${o.descricao ? `<div class="oc-texto">${H(o.descricao)}</div>` : ''}
            ${fechada && o.conclusao ? `<div class="oc-conclusao"><b>Conclusão</b>${H(o.conclusao)}</div>` : ''}
            </div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('route', 'i-sm')} Trajeto</h2><span class="count">${H(fmtCurto(det.periodo.de))} → ${H(fmtCurto(det.periodo.ate))}</span></div>
            <div class="card-body">${o.veiculo_id ? `<div class="oc-mapa" id="oc-mapa"></div><p class="hint" id="oc-traj-info"></p>` : '<p class="hint" style="margin:0">Ocorrência sem veículo: não há trajeto.</p>'}</div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('bell', 'i-sm')} Alertas do veículo no período</h2><span class="count">${det.alertas.length}</span></div>
            <div class="card-body">${det.alertas.length ? `<div class="oc-alertas">${det.alertas.map((a) => `<div class="oc-alerta"><span class="tag ${a.gravidade}">${GRAV_OC[a.gravidade]}</span><b>${H(a.nome)}</b><span class="muted">${H(fmtDataHora(a.inicio))}${a.velocidade !== null ? ` · ${fmtNum(Math.round(a.velocidade))} km/h` : ''}</span></div>`).join('')}</div>`
              : '<p class="hint" style="margin:0">Nenhum alerta do veículo no período do trajeto.</p>'}</div>
          </section>
        </div>
        <div class="oc-col">
          <section class="card">
            <div class="card-head"><h2>${ico('paperclip', 'i-sm')} Provas</h2><span class="count">${det.anexos.length}</span></div>
            <div class="card-body">
            ${!fechada && pode('incluir') ? `<div class="oc-prova-acoes">
              ${det.camera.podeBaixar ? `<button class="btn btn-primary btn-sm" type="button" data-baixar-cam>${ico('video', 'i-sm')} Baixar as câmeras do momento</button>` : ''}
              ${det.camera.downloads.length ? `<button class="btn btn-sm" type="button" data-anexar-dl>${ico('download', 'i-sm')} Anexar download (${det.camera.downloads.length})</button>` : ''}
              ${det.camera.fotos.length ? `<button class="btn btn-sm" type="button" data-anexar-foto>${ico('photo', 'i-sm')} Anexar foto (${det.camera.fotos.length})</button>` : ''}
              <button class="btn btn-sm" type="button" data-enviar>${ico('upload', 'i-sm')} Enviar arquivo</button>
              <input type="file" id="oc-arquivo" multiple hidden>
            </div>` : ''}
            <div id="oc-baixando"></div>
            <div class="oc-anexos">${det.anexos.length ? det.anexos.map(htmlAnexo).join('') : '<p class="hint" style="margin:0">Nenhuma prova ainda. Baixe as câmeras do momento (o DVR precisa estar online), anexe fotos ou envie arquivos (BO, fotos do celular, laudos).</p>'}</div>
            </div>
          </section>
          <section class="card">
            <div class="card-head"><h2>${ico('history', 'i-sm')} Andamento</h2></div>
            <div class="card-body">
            <ol class="oc-linha">${det.eventos.map((e) => `<li class="oc-ev ${H(e.tipo)}"><div class="oc-ev-cab"><b>${H(e.usuario || 'Sistema')}</b><span class="muted">${H(fmtCurto(e.quando))}</span></div><div>${H(e.texto)}</div></li>`).join('')}</ol>
            ${pode('incluir') ? `<div class="oc-nota"><textarea id="oc-nota" rows="2" maxlength="1000" placeholder="Anotar o que foi feito (ligação, retorno do seguro, conversa com o motorista...)"></textarea>
              <button class="btn btn-sm" type="button" data-anotar>${ico('message-plus', 'i-sm')} Anotar</button></div>` : ''}
            </div>
          </section>
        </div>
      </div>`;
    window.scrollTo(0, rolagem);
    desenharBaixando();
    desenharMapa();
    carregarMiniaturas();
    const arq = $('#oc-arquivo');
    if (arq) arq.addEventListener('change', () => { enviarArquivos([...arq.files]); arq.value = ''; });
  }

  function htmlAnexo(a) {
    const det1 = a.tipo === 'gravacao' ? `${a.descricao || `Câmera ${a.canal}`} · ${fmtDataHora(a.inicio)} a ${String(a.fim || '').slice(11, 19)}`
      : a.tipo === 'foto' ? `Câmera ${a.canal} · ${fmtDataHora(a.inicio)}` : (a.descricao || '');
    const ver = a.tipo === 'foto' || a.mime === 'image/jpeg' || a.mime === 'image/png' || a.mime === 'image/webp' || a.mime === 'application/pdf' || a.mime.startsWith('video/');
    return `<div class="oc-anexo" data-anexo="${a.id}">
      ${a.mime.startsWith('image/') && a.mime !== 'image/heic' ? `<button class="oc-mini" type="button" data-ver-anexo="${a.id}" aria-label="Ver ${H(a.nome)}"><img alt="" data-mini="${a.id}"></button>` : `<span class="oc-anexo-ico">${ico(ICO_ANEXO[a.tipo], 'i-sm')}</span>`}
      <div class="oc-anexo-txt"><b>${H(a.nome)}</b><span class="sub">${H([det1, tamanhoArq(a.bytes), `${a.usuario || 'Sistema'} · ${fmtCurto(a.criadoEm)}`].filter(Boolean).join(' · '))}</span>
        <span class="sub mono oc-sha" title="SHA-256: código para conferir que o arquivo não foi alterado">SHA-256 ${H(a.sha256.slice(0, 16))}…</span></div>
      <div class="oc-anexo-acoes">
        ${ver ? `<button class="btn btn-sm btn-ghost" type="button" data-ver-anexo="${a.id}" title="Ver">${ico('eye', 'i-sm')}</button>` : ''}
        <button class="btn btn-sm btn-ghost" type="button" data-baixar-anexo="${a.id}" title="Baixar">${ico('download', 'i-sm')}</button>
        ${pode('alterar') && det.ocorrencia.situacao !== 'encerrada' ? `<button class="btn btn-sm btn-ghost" type="button" data-tirar="${a.id}" title="Tirar da ocorrência">${ico('trash', 'i-sm')}</button>` : ''}
      </div></div>`;
  }

  /** Downloads pedidos pela ocorrência que ainda estão vindo do DVR. */
  function desenharBaixando() {
    const box = $('#oc-baixando');
    if (!box || !det) return;
    const l = [...S.downloads.values()].filter((d) => d.ocorrenciaId === idAberto && ['aguardando', 'gravando', 'convertendo'].includes(d.status));
    box.innerHTML = l.length ? `<div class="oc-baixando">${l.map((d) => {
      const pct = Math.min(100, Math.round((d.durationMs / d.totalMs) * 100) || 0);
      return `<div class="oc-bx"><span>${ico('loader-2', 'i-sm spin')} Câmera ${d.channel}${d.nomeCanal ? ` (${H(d.nomeCanal)})` : ''}</span><span class="muted">${d.status === 'aguardando' ? H(d.note || 'pedindo ao aparelho') : d.status === 'convertendo' ? 'convertendo' : `${pct}%`}</span><div class="oc-bx-barra"><i style="width:${d.status === 'aguardando' ? 3 : pct}%"></i></div></div>`;
    }).join('')}<p class="hint" style="margin:6px 0 0">As gravações entram aqui sozinhas quando ficarem prontas.</p></div>` : '';
  }

  function desenharMapa() {
    removerMapa(mapa);
    mapa = null;
    const el = $('#oc-mapa');
    if (!el) return;
    const o = det.ocorrencia;
    const pts = det.trajeto.map((p) => [p[0], p[1]]);
    const info = $('#oc-traj-info');
    if (!pts.length && o.latitude === null) {
      el.outerHTML = '<p class="hint">Sem posições do veículo no período (aparelho desligado ou sem sinal).</p>';
      if (info) info.remove();
      return;
    }
    mapa = criarMapa(el, { silencioso: true });
    if (!mapa) return;
    const camadas = [];
    if (pts.length > 1) camadas.push(L.polyline(pts, { color: '#1A2744', weight: 4, opacity: 0.85 }));
    if (pts.length) {
      camadas.push(L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#16A34A', fillOpacity: 1 }).bindTooltip(`Início · ${fmtCurto(det.trajeto[0][3])}`));
      camadas.push(L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#5B6478', fillOpacity: 1 }).bindTooltip(`Fim · ${fmtCurto(det.trajeto[det.trajeto.length - 1][3])}`));
    }
    for (const a of det.alertas) {
      if (a.latitude === null) continue;
      camadas.push(L.circleMarker([a.latitude, a.longitude], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#F59E0B', fillOpacity: 1 }).bindTooltip(`${a.nome} · ${fmtCurto(a.inicio)}`));
    }
    if (o.latitude !== null) camadas.push(L.circleMarker([o.latitude, o.longitude], { radius: 9, color: '#fff', weight: 3, fillColor: '#DC2626', fillOpacity: 1 }).bindTooltip('Local da ocorrência', { permanent: false }));
    const g = L.featureGroup(camadas).addTo(mapa);
    mapa.fitBounds(g.getBounds().pad(0.15), { maxZoom: 17 });
    if (info) {
      let km = 0;
      let vmax = 0;
      for (let i = 1; i < det.trajeto.length; i++) {
        const d = distKm(det.trajeto[i - 1][0], det.trajeto[i - 1][1], det.trajeto[i][0], det.trajeto[i][1]);
        if (d < 3) km += d;
      }
      for (const p of det.trajeto) vmax = Math.max(vmax, p[2]);
      info.innerHTML = `<span class="oc-leg"><i style="background:#DC2626"></i>local</span><span class="oc-leg"><i style="background:#16A34A"></i>início</span><span class="oc-leg"><i style="background:#5B6478"></i>fim</span>${det.alertas.length ? '<span class="oc-leg"><i style="background:#F59E0B"></i>alertas</span>' : ''} · ${fmtNum(km, 1)} km · máx. ${fmtNum(Math.round(vmax))} km/h`;
    }
  }

  function distKm(la1, lo1, la2, lo2) {
    const r = Math.PI / 180;
    const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Miniaturas das fotos (vêm com o login, em blob). */
  const urls = new Map();
  async function urlAnexo(id) {
    const k = `${idAberto}:${id}`;
    if (urls.has(k)) return urls.get(k);
    const pedir = async (forcar) => fetch(`/api/ocorrencias/${idAberto}/anexos/${id}`, { headers: { Authorization: `Bearer ${await token(forcar)}` } });
    let r = await pedir(false);
    if (r.status === 401) r = await pedir(true);
    if (!r.ok) throw new Error('arquivo indisponível');
    const u = URL.createObjectURL(await r.blob());
    urls.set(k, u);
    if (urls.size > 120) { const [k0, v0] = urls.entries().next().value; URL.revokeObjectURL(v0); urls.delete(k0); }
    return u;
  }

  function carregarMiniaturas() {
    $$('#oc-det img[data-mini]').forEach((img) => { urlAnexo(img.dataset.mini).then((u) => { img.src = u; }).catch(() => {}); });
  }

  async function linkAnexo(id) {
    const r = await api(`/api/ocorrencias/${idAberto}/anexos/${id}/link`, { corpo: {} });
    return r.url;
  }

  async function verAnexo(id) {
    const a = det.anexos.find((x) => x.id === id);
    if (!a) return;
    try {
      if (a.mime.startsWith('video/')) {
        const url = await linkAnexo(id);
        janela({ titulo: a.nome, icone: 'video', tamanho: 'lg', corpo: `<video class="oc-video" src="${H(url)}" controls autoplay playsinline></video>`, rodape: '<button class="btn" type="button" data-fechar>Fechar</button>' });
      } else if (a.mime === 'application/pdf') {
        window.open(URL.createObjectURL(await (await fetch(await urlAnexo(id))).blob()), '_blank', 'noopener');
      } else {
        const url = await urlAnexo(id);
        janela({ titulo: a.nome, icone: 'photo', tamanho: 'lg', corpo: `<div class="cmd-foto-grande"><img alt="${H(a.nome)}" src="${H(url)}"></div>`, rodape: '<button class="btn" type="button" data-fechar>Fechar</button>' });
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  async function baixarAnexo(id) {
    try {
      const url = await linkAnexo(id);
      const el = document.createElement('a');
      el.href = url;
      el.download = '';
      document.body.append(el);
      el.click();
      setTimeout(() => el.remove(), 1000);
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- ações ---------- */

  async function clique(e) {
    const b = e.target.closest('button[data-editar],button[data-sit],button[data-dossie],button[data-excluir-oc],button[data-baixar-cam],button[data-anexar-dl],button[data-anexar-foto],button[data-enviar],button[data-anotar],button[data-ver-anexo],button[data-baixar-anexo],button[data-tirar]');
    if (!b || !det) return;
    const o = det.ocorrencia;
    if (b.matches('[data-editar]')) editar();
    else if (b.matches('[data-sit]')) mudarSituacao(b.dataset.sit);
    else if (b.matches('[data-dossie]')) {
      b.disabled = true;
      try { await baixarArquivo(`/api/ocorrencias/${o.id}/dossie`, `ocorrencia-${o.numero.replace('/', '-')}.pdf`); toast('Dossiê gerado.', 'ok'); } catch (err) { toast(err.message, 'err'); }
      b.disabled = false;
    } else if (b.matches('[data-excluir-oc]')) {
      if (!(await confirmar(`Excluir a ocorrência ${o.numero} com todas as provas (${det.anexos.length} arquivo(s))? Não dá para desfazer.`, { titulo: 'Excluir ocorrência', ok: 'Excluir', perigo: true }))) return;
      try { await api(`/api/ocorrencias/${o.id}`, { metodo: 'DELETE' }); toast('Ocorrência excluída.', 'ok'); navegar('ocorrencias'); } catch (err) { toast(err.message, 'err'); }
    } else if (b.matches('[data-baixar-cam]')) baixarCameras();
    else if (b.matches('[data-anexar-dl]')) anexarDownload();
    else if (b.matches('[data-anexar-foto]')) anexarFoto();
    else if (b.matches('[data-enviar]')) $('#oc-arquivo').click();
    else if (b.matches('[data-anotar]')) {
      const t = $('#oc-nota').value.trim();
      if (!t) { $('#oc-nota').focus(); return; }
      b.disabled = true;
      try { await api(`/api/ocorrencias/${o.id}/notas`, { corpo: { texto: t } }); $('#oc-nota').value = ''; carregarDetalhe(); } catch (err) { toast(err.message, 'err'); }
      b.disabled = false;
    } else if (b.matches('[data-ver-anexo]')) verAnexo(Number(b.dataset.verAnexo));
    else if (b.matches('[data-baixar-anexo]')) baixarAnexo(Number(b.dataset.baixarAnexo));
    else if (b.matches('[data-tirar]')) {
      const a = det.anexos.find((x) => x.id === Number(b.dataset.tirar));
      if (!a || !(await confirmar(`Tirar ${a.nome} da ocorrência? O arquivo é apagado (o andamento guarda o registro).`, { titulo: 'Tirar prova', ok: 'Tirar', perigo: true }))) return;
      try { await api(`/api/ocorrencias/${o.id}/anexos/${a.id}`, { metodo: 'DELETE' }); carregarDetalhe(); } catch (err) { toast(err.message, 'err'); }
    }
  }

  async function editar() {
    const o = det.ocorrencia;
    let apoio;
    try { apoio = await api(`/api/ocorrencias/apoio?${qs({ empresa: o.empresa_id })}`); } catch (e) { toast(e.message, 'err'); return; }
    formulario({
      titulo: `Ocorrência ${o.numero}`, icone: 'pencil',
      campos: [
        { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', opcoes: apoio.tipos.map((t) => ({ v: t.id, t: t.nome })) },
        { nome: 'gravidade', rotulo: 'Gravidade', tipo: 'select', opcoes: [{ v: 'alta', t: 'Alta' }, { v: 'media', t: 'Média' }, { v: 'baixa', t: 'Baixa' }] },
        { nome: 'titulo', rotulo: 'Título', obrigatorio: true, cheio: true, maxlength: 120 },
        { nome: 'quando', rotulo: 'Data e hora do fato', tipo: 'data', obrigatorio: true },
        { nome: 'responsavel', rotulo: 'Responsável', tipo: 'select', opcoes: [{ v: '', t: '— Ninguém' }, ...apoio.responsaveis.map((r) => ({ v: r.id, t: r.nome }))] },
        { nome: 'protocolo', rotulo: 'Protocolo externo', maxlength: 60, placeholder: 'Nº do BO, sinistro...' },
        { nome: 'local', rotulo: 'Local (endereço, referência)', cheio: true, maxlength: 200 },
        { nome: 'descricao', rotulo: 'O que aconteceu', tipo: 'textarea', max: 20000 },
        { tipo: 'separador', rotulo: 'Trajeto mostrado' },
        { nome: 'antes', rotulo: 'Minutos antes do fato', tipo: 'numero', min: 0, max: 720 },
        { nome: 'depois', rotulo: 'Minutos depois', tipo: 'numero', min: 0, max: 720 },
      ],
      valores: {
        tipo: o.tipo, gravidade: o.gravidade, titulo: o.titulo, quando: paraInput(o.quando), responsavel: o.responsavel ? o.responsavel.id : '',
        protocolo: o.protocolo, local: o.local_texto, descricao: o.descricao, antes: o.trajeto_antes_min, depois: o.trajeto_depois_min,
      },
      salvar: async (d) => {
        await api(`/api/ocorrencias/${o.id}`, { metodo: 'PUT', corpo: { ...d, quando: deInput(d.quando), latitude: o.latitude, longitude: o.longitude } });
        toast('Ocorrência atualizada.', 'ok');
        carregarDetalhe();
      },
    });
  }

  function mudarSituacao(sit) {
    const o = det.ocorrencia;
    const encerrar = sit === 'encerrada';
    const reabrir = o.situacao === 'encerrada';
    formulario({
      titulo: encerrar ? `Encerrar a ocorrência ${o.numero}` : reabrir ? `Reabrir a ocorrência ${o.numero}` : `${o.numero}: ${SIT_OC[sit][1]}`,
      icone: encerrar ? 'circle-check' : 'progress', tamanho: 'sm',
      campos: [{ nome: 'texto', rotulo: encerrar ? 'Conclusão' : reabrir ? 'Por que reabrir' : 'Observação (opcional)', tipo: 'textarea', obrigatorio: encerrar || reabrir, max: 5000 }],
      aviso: encerrar ? 'A conclusão vai no dossiê. Depois de encerrada, para mexer nas provas é preciso reabrir.' : '',
      textoSalvar: encerrar ? 'Encerrar' : reabrir ? 'Reabrir' : 'Confirmar',
      salvar: async (d) => {
        await api(`/api/ocorrencias/${o.id}/situacao`, { corpo: { situacao: sit, texto: d.texto } });
        toast(encerrar ? 'Ocorrência encerrada.' : reabrir ? 'Ocorrência reaberta.' : 'Situação atualizada.', 'ok');
        carregarDetalhe();
      },
    });
  }

  function baixarCameras() {
    const o = det.ocorrencia;
    const c = det.camera;
    const ini = textoMs(paraMsTexto(o.quando) - 60000);
    const fim = textoMs(paraMsTexto(o.quando) + 60000);
    formulario({
      titulo: 'Baixar as câmeras do momento', icone: 'video',
      aviso: `${c.online ? '<b style="color:var(--ok)">Aparelho online.</b>' : '<b style="color:var(--err)">Aparelho offline agora</b>: o pedido só funciona com ele se comunicando.'} O DVR manda a gravação de cada câmera pela internet do chip; cada minuto de vídeo consome dados. Até 30 minutos por vez.`,
      campos: [
        { nome: 'canais', rotulo: 'Câmeras', tipo: 'multi', cheio: true, opcoes: c.canais.map((x) => ({ v: x.canal, t: `${x.canal}${x.nome ? ` · ${x.nome}` : ''}` })) },
        { nome: 'inicio', rotulo: 'De', tipo: 'data', obrigatorio: true },
        { nome: 'fim', rotulo: 'Até', tipo: 'data', obrigatorio: true },
      ],
      valores: { canais: c.canais.map((x) => x.canal), inicio: paraInput(ini), fim: paraInput(fim) },
      textoSalvar: 'Baixar',
      salvar: async (d) => {
        if (!d.canais.length) throw new Error('Escolha as câmeras.');
        const r = await api(`/api/ocorrencias/${o.id}/baixar`, { corpo: { canais: d.canais.map(Number), inicio: deInput(d.inicio), fim: deInput(d.fim, true) } });
        toast(`Pedido enviado ao DVR (${r.downloads.length} câmera${r.downloads.length > 1 ? 's' : ''}). As gravações entram aqui sozinhas quando ficarem prontas.${r.falhas.length ? ` Não começou: ${r.falhas.join('; ')}` : ''}`, r.falhas.length ? '' : 'ok');
        carregarDetalhe();
      },
    });
  }

  function anexarDownload() {
    const l = det.camera.downloads;
    formulario({
      titulo: 'Anexar download pronto', icone: 'download', tamanho: 'sm',
      aviso: 'Gravações deste veículo que já foram baixadas (em Gravações) e ainda não estão na ocorrência.',
      campos: [{ nome: 'download', rotulo: 'Gravação', tipo: 'select', cheio: true, opcoes: l.map((j) => ({ v: j.id, t: `Câmera ${j.channel} · ${fmtCurto(j.start)} a ${j.end.slice(11, 19)} · ${tamanhoArq(j.size || j.bytes || 0)}` })) }],
      textoSalvar: 'Anexar',
      salvar: async (d) => {
        await api(`/api/ocorrencias/${det.ocorrencia.id}/anexos/download`, { corpo: { download: d.download } });
        toast('Gravação anexada.', 'ok');
        carregarDetalhe();
      },
    });
  }

  function anexarFoto() {
    const l = det.camera.fotos;
    const escolhidas = new Set();
    const j = janela({
      titulo: 'Anexar fotos das câmeras', icone: 'photo', tamanho: 'lg',
      corpo: `<p class="hint" style="margin:0 0 10px">Fotos deste veículo até 6 horas antes e depois do fato. Clique para escolher.</p>
        <div class="oc-fotos">${l.map((f) => `<button class="oc-foto" type="button" data-f="${f.id}"><img alt="Câmera ${f.canal}" data-foto="${f.id}"><span>Câmera ${f.canal} · ${H(fmtCurto(f.data_hora))}</span></button>`).join('')}</div>`,
      rodape: '<button class="btn" type="button" data-fechar>Cancelar</button><button class="btn btn-primary" type="button" data-ok disabled>Anexar</button>',
    });
    j.el.querySelectorAll('img[data-foto]').forEach((img) => urlFoto(Number(img.dataset.foto)).then((u) => { img.src = u; }).catch(() => {}));
    const ok = j.el.querySelector('[data-ok]');
    j.el.querySelector('.oc-fotos').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      const id = Number(b.dataset.f);
      if (escolhidas.has(id)) escolhidas.delete(id); else escolhidas.add(id);
      b.classList.toggle('on', escolhidas.has(id));
      ok.disabled = !escolhidas.size;
      ok.textContent = escolhidas.size ? `Anexar ${escolhidas.size}` : 'Anexar';
    });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        for (const id of escolhidas) await api(`/api/ocorrencias/${det.ocorrencia.id}/anexos/foto`, { corpo: { foto: id } });
        toast(`${escolhidas.size} foto(s) anexada(s).`, 'ok');
        j.fechar();
        carregarDetalhe();
      } catch (err) { toast(err.message, 'err'); ok.disabled = false; }
    });
  }

  async function enviarArquivos(arqs) {
    if (!arqs.length) return;
    const grandes = arqs.filter((a) => a.size > 20 * 1048576);
    if (grandes.length) toast(`Até 20 MB por arquivo: ${grandes.map((a) => a.name).join(', ')} ficou de fora.`, 'err');
    let n = 0;
    for (const a of arqs.filter((x) => x.size <= 20 * 1048576)) {
      try {
        toast(`Enviando ${a.name}…`);
        const conteudo = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('não foi possível ler o arquivo'));
          r.readAsDataURL(a);
        });
        await api(`/api/ocorrencias/${det.ocorrencia.id}/anexos/arquivo`, { corpo: { nome: a.name, conteudo } });
        n++;
      } catch (err) { toast(`${a.name}: ${err.message}`, 'err'); }
    }
    if (n) { toast(`${n} arquivo(s) enviado(s).`, 'ok'); carregarDetalhe(); }
  }

  return { id: 'ocorrencias', titulo: 'Ocorrências', sub: 'Cada caso com as provas, o trajeto, o andamento e o dossiê em PDF', render, sair };
})();

/** "AAAA-MM-DD hh:mm:ss" (hora de Brasília) ↔ milissegundos. */
function paraMsTexto(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 3, +m[5], +(m[6] || 0)) : NaN;
}
function textoMs(ms) {
  const d = new Date(ms - 3 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
