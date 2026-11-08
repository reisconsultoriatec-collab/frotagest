'use strict';
/* FrotaGest — Controle: comunicações dos aparelhos, auditoria e sistema (status, portas/protocolos, pendentes, configurações, log ao vivo). Reis Tecnologia */

const NOMES_EVENTO = {
  conectou: 'Conectou', desconectou: 'Desconectou', registro: 'Registro', autenticou: 'Autenticou',
  autenticacao_recusada: 'Autenticação recusada', recusado: 'Conexão recusada',
};
const NOMES_ACAO = {
  acesso: 'Entrou no painel', saida: 'Saiu', criar: 'Cadastrou', editar: 'Alterou', desativar: 'Desativou', reativar: 'Reativou',
  excluir: 'Excluiu', convite: 'Enviou convite', tratar_alerta: 'Tratou alerta', ver_gravacao: 'Assistiu gravação',
  baixar_gravacao: 'Baixou gravação', salvar_gravacao: 'Salvou gravação', limpeza: 'Limpeza do histórico',
};
const NOMES_ENTIDADE = {
  empresa: 'Empresa', usuario: 'Usuário', grupo: 'Grupo', veiculo: 'Veículo', aparelho: 'Aparelho', aparelho_pendente: 'Aparelho pendente',
  perfil_protocolo: 'Perfil de protocolo', configuracoes: 'Configurações', alerta: 'Alerta', download: 'Download',
};

/* ---------------- comunicações ---------------- */

PAGINAS.comunicacoes = (() => {
  let dados = [];
  const f = { veiculo: '', tipo: '', de: '', ate: '' };

  function render(c) {
    if (!f.de) { f.de = `${textoServidor().slice(0, 10)} 00:00:00`; f.ate = `${textoServidor().slice(0, 10)} 23:59:59`; }
    c.innerHTML = `
      <div class="page"><section class="card">
        <div class="toolbar">
          <label class="field">Veículo / aparelho<select id="co-veic"></select></label>
          <label class="field">Tipo<select id="co-tipo"><option value="">Conexões e comandos</option><option value="conexoes">Só conexões</option><option value="comandos">Só comandos</option></select></label>
          <label class="field">De<input type="datetime-local" id="co-de"></label>
          <label class="field">Até<input type="datetime-local" id="co-ate"></label>
          <div class="grow"></div>
          <button class="btn btn-primary" type="button" id="co-buscar">${ico('search', 'i-sm')} Buscar</button>
          <button class="btn" type="button" id="co-csv">${ico('download', 'i-sm')} CSV</button>
        </div>
        <p class="hint" id="co-st">Conexões, desconexões e comandos enviados aos DVRs (vídeo, gravações, consultas), com a resposta de cada um.</p>
        <div class="table-wrap tall flat" id="co-tabela"></div>
      </section></div>`;
    $('#co-veic').innerHTML = opcoesVeiculos(f.veiculo, { vazio: 'Todos' });
    $('#co-tipo').value = f.tipo;
    $('#co-de').value = paraInput(f.de);
    $('#co-ate').value = paraInput(f.ate);
    $('#co-buscar').addEventListener('click', buscar);
    $('#co-csv').addEventListener('click', () => {
      const l = [['Quando', 'Veículo', 'Aparelho', 'Tipo', 'Evento', 'Detalhe', 'Resultado', 'Tempo (ms)', 'Usuário', 'IP']];
      for (const i of dados) l.push([i.quando, i.placa, i.identificador, i.origem, i.origem === 'conexao' ? NOMES_EVENTO[i.nome] || i.nome : i.nome, i.detalhe, i.resultado, i.tempo_ms, i.usuario, i.ip]);
      baixarCsv(`comunicacoes-${f.de.slice(0, 10)}.csv`, l);
    });
    buscar();
  }

  let seq = 0;
  async function buscar() {
    const minha = ++seq;
    f.veiculo = $('#co-veic').value;
    f.tipo = $('#co-tipo').value;
    f.de = deInput($('#co-de').value);
    f.ate = deInput($('#co-ate').value, true);
    const it = S.itens.get(f.veiculo);
    try {
      const r = await api(`/api/comunicacoes?${qs({ aparelho: it ? it.aparelhoId : '', tipo: f.tipo, de: f.de, ate: f.ate, empresa: it ? '' : S.empresa })}`);
      if (minha !== seq) return;
      dados = r.itens;
      $('#co-st').textContent = `${dados.length} registro(s)${dados.length >= 500 ? ' (os 500 mais recentes; diminua o período para ver o resto)' : ''}.`;
    } catch (e) {
      dados = [];
      $('#co-st').textContent = e.message;
    }
    const master = S.eu.perfil === 'master';
    $('#co-tabela').innerHTML = tabela([
      { t: 'Quando', cls: 'nw', v: (i) => H(fmtDataHora(i.quando)) },
      { t: 'Veículo', v: (i) => `${H(i.placa || '—')}<span class="sub mono">${H(i.identificador)}</span>` },
      { t: 'Tipo', v: (i) => (i.origem === 'conexao' ? '<span class="tag off">conexão</span>' : '<span class="tag novo">comando</span>') },
      { t: 'Evento', v: (i) => `<b>${H(i.origem === 'conexao' ? NOMES_EVENTO[i.nome] || i.nome : i.nome)}</b>${i.detalhe ? `<span class="sub">${H(i.detalhe)}</span>` : ''}` },
      { t: 'Resposta', v: (i) => (i.origem === 'comando' ? (i.resultado ? `${H(i.resultado)}${i.tempo_ms !== null ? `<span class="sub">${fmtNum(i.tempo_ms)} ms</span>` : ''}` : '<span class="muted">sem resposta</span>') : '') },
      { t: 'Quem', v: (i) => H(i.origem === 'comando' ? i.usuario || 'automático' : '') },
      ...(master ? [{ t: 'IP', cls: 'mono', v: (i) => H(i.ip ? `${i.ip}${i.porta ? `:${i.porta}` : ''}` : '') }] : []),
    ], dados, { vazio: 'Nada registrado nesse período.' });
  }

  return { id: 'comunicacoes', titulo: 'Comunicações', sub: 'Conexões dos aparelhos e comandos enviados', render };
})();

/* ---------------- auditoria ---------------- */

PAGINAS.auditoria = (() => {
  let dados = [];
  const f = { acao: '', de: '', ate: '' };

  function render(c) {
    if (!f.de) { f.de = `${textoServidor(Date.now() - 6 * 86400000).slice(0, 10)} 00:00:00`; f.ate = `${textoServidor().slice(0, 10)} 23:59:59`; }
    c.innerHTML = `
      <div class="page"><section class="card">
        <div class="toolbar">
          <label class="field">Ação<select id="au-acao"><option value="">Todas</option>${Object.entries(NOMES_ACAO).map(([k, t]) => `<option value="${k}">${H(t)}</option>`).join('')}</select></label>
          <label class="field">De<input type="datetime-local" id="au-de"></label>
          <label class="field">Até<input type="datetime-local" id="au-ate"></label>
          <div class="grow"></div>
          <button class="btn btn-primary" type="button" id="au-buscar">${ico('search', 'i-sm')} Buscar</button>
          <button class="btn" type="button" id="au-csv">${ico('download', 'i-sm')} CSV</button>
        </div>
        <p class="hint" id="au-st"></p>
        <div class="table-wrap tall flat" id="au-tabela"></div>
      </section></div>`;
    $('#au-acao').value = f.acao;
    $('#au-de').value = paraInput(f.de);
    $('#au-ate').value = paraInput(f.ate);
    $('#au-buscar').addEventListener('click', buscar);
    $('#au-csv').addEventListener('click', () => {
      const l = [['Data/hora', 'Usuário', 'E-mail', 'Empresa', 'Ação', 'Item', 'Descrição', 'IP']];
      for (const i of dados) l.push([i.data_hora, i.usuario, i.email, i.empresa, NOMES_ACAO[i.acao] || i.acao, NOMES_ENTIDADE[i.entidade] || i.entidade, i.descricao, i.ip]);
      baixarCsv(`auditoria-${f.de.slice(0, 10)}.csv`, l);
    });
    buscar();
  }

  let seq = 0;
  async function buscar() {
    const minha = ++seq;
    f.acao = $('#au-acao').value;
    f.de = deInput($('#au-de').value);
    f.ate = deInput($('#au-ate').value, true);
    try {
      const r = await api(`/api/auditoria?${qs({ acao: f.acao, de: f.de, ate: f.ate, empresa: S.empresa })}`);
      if (minha !== seq) return;
      dados = r.itens;
      $('#au-st').textContent = `${dados.length} registro(s)${dados.length >= 1000 ? ' (os 1.000 mais recentes)' : ''}.`;
    } catch (e) {
      dados = [];
      $('#au-st').textContent = e.message;
    }
    $('#au-tabela').innerHTML = tabela([
      { t: 'Data/hora', cls: 'nw', v: (i) => H(fmtDataHora(i.data_hora)) },
      { t: 'Usuário', v: (i) => `${H(i.usuario || '—')}<span class="sub">${H(i.email || '')}</span>` },
      { t: 'Ação', v: (i) => `<b>${H(NOMES_ACAO[i.acao] || i.acao)}</b>${i.entidade ? `<span class="sub">${H(NOMES_ENTIDADE[i.entidade] || i.entidade)}${i.entidade_id ? ` #${H(i.entidade_id)}` : ''}</span>` : ''}` },
      { t: 'Descrição', v: (i) => H(i.descricao || '') },
      { t: 'Empresa', v: (i) => H(i.empresa || '—') },
      { t: 'IP', cls: 'mono', v: (i) => H(i.ip || '') },
    ], dados, { vazio: 'Nada registrado nesse período.' });
  }

  return { id: 'auditoria', titulo: 'Auditoria', sub: 'Quem fez o quê no FrotaGest', render };
})();

/* ---------------- sistema (master) ---------------- */

PAGINAS.sistema = (() => {
  let aba = 'status';
  let logWs = null;
  let logPausado = false;
  let logRotina = false;
  let timer = null;

  const ABAS = [
    ['status', 'Status', 'activity'],
    ['portas', 'Portas e protocolos', 'plug'],
    ['pendentes', 'Aparelhos pendentes', 'device-cctv'],
    ['config', 'Configurações', 'settings'],
    ['log', 'Log ao vivo', 'terminal-2'],
  ];

  function render(c, params) {
    if (params.aba && ABAS.some((a) => a[0] === params.aba)) aba = params.aba;
    c.innerHTML = `<div class="page"><section class="card">
      <div class="tabs" id="si-abas">${ABAS.map(([id, t, i]) => `<button class="tab${id === aba ? ' active' : ''}" type="button" data-aba="${id}">${ico(i, 'i-sm')} ${H(t)}</button>`).join('')}</div>
      <div id="si-corpo"></div></section></div>`;
    $('#si-abas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aba]');
      if (!b) return;
      aba = b.dataset.aba;
      $$('#si-abas .tab').forEach((x) => x.classList.toggle('active', x === b));
      abrirAba();
    });
    abrirAba();
  }

  function sair() {
    fecharLog();
    clearInterval(timer);
  }

  function abrirAba() {
    fecharLog();
    clearInterval(timer);
    const box = $('#si-corpo');
    box.innerHTML = '<p class="hint">Carregando…</p>';
    ({ status: abaStatus, portas: abaPortas, pendentes: abaPendentes, config: abaConfig, log: abaLog })[aba](box);
  }

  /* ---------- status ---------- */

  async function abaStatus(box) {
    const carregarStatus = async () => {
      let s;
      try { s = await api('/api/sistema'); } catch (e) { box.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`; return; }
      if (!$('#si-corpo') || aba !== 'status') return;
      const kv = (pares) => `<div class="kv">${pares.map(([k, v, cls]) => `<div class="k">${H(k)}</div><div class="v ${cls || ''}">${v}</div>`).join('')}</div>`;
      const b = s.banco;
      const ativos = s.streams.filter((x) => x.live);
      box.innerHTML = `
        <div class="card-body"><div class="kpis">
          <div class="kpi ${b.ok ? 'ok' : 'err'}"><div class="kpi-ico">${ico('database')}</div><div class="kpi-body"><div class="kpi-label">Banco de dados</div><div class="kpi-value">${b.ok ? 'OK' : 'Fora'}</div><div class="kpi-sub">${H(b.ok ? `${fmtNum(b.gravadas)} posições gravadas desde o início` : b.ultimoErro || '')}</div></div></div>
          <div class="kpi ok"><div class="kpi-ico">${ico('wifi')}</div><div class="kpi-body"><div class="kpi-label">Aparelhos online</div><div class="kpi-value">${fmtNum(s.aparelhosOnline)}</div><div class="kpi-sub">${s.pendentesOnline ? `${s.pendentesOnline} sem cadastro` : 'todos cadastrados'}</div></div></div>
          <div class="kpi neutral"><div class="kpi-ico">${ico('video')}</div><div class="kpi-body"><div class="kpi-label">Vídeos chegando</div><div class="kpi-value">${fmtNum(ativos.length)}</div><div class="kpi-sub">${s.conexoes.painel} painel(is) conectado(s)</div></div></div>
          <div class="kpi neutral"><div class="kpi-ico">${ico('cpu')}</div><div class="kpi-body"><div class="kpi-label">Servidor</div><div class="kpi-value">${fmtNum(s.memoriaMb)}<small>MB</small></div><div class="kpi-sub">carga ${s.carga.join(' / ')} · ${s.cpus} CPU · livre ${fmtNum(s.memoriaLivreMb)} de ${fmtNum(s.memoriaTotalMb)} MB</div></div></div>
        </div></div>
        <div class="grid-2" style="padding:0 18px 18px">
          <div class="card"><div class="card-head"><h2>${ico('server')} Servidor</h2></div><div class="card-body">${kv([
            ['Versão', `FrotaGest ${H(s.versao)} · Node ${H(s.node)}`],
            ['No ar desde', H(fmtDataHora(s.iniciadoEm))],
            ['Portas dos DVRs', `<span class="mono">${H(s.portas.sinalizacao.join(', ') || 'nenhuma')}</span>`, s.portas.sinalizacao.length ? '' : 'err'],
            ['Portas de vídeo', `<span class="mono">${H(s.portas.video.join(', ') || 'nenhuma')}</span>`, s.portas.video.length ? '' : 'err'],
            ['Endereço de vídeo', H(s.enderecoVideo || 'o mesmo IP em que o DVR se conectou')],
            ['Endereço do painel', H(s.publicUrl || `porta ${s.portas.web} (local)`)],
            ['Conexões', `${s.conexoes.aparelhos} de aparelhos · ${s.conexoes.video} de vídeo`],
            ['Conversão H.265', s.conversao && s.conversao.ativa ? 'ligada (ffmpeg)' : H(`desligada${s.conversao && s.conversao.motivo ? ` (${s.conversao.motivo})` : ''}`), s.conversao && s.conversao.ativa ? 'ok' : 'warn'],
            ['Downloads de gravação', `${fmtNum(s.gravacoes.usadoMb)} MB de ${s.gravacoes.limiteGb} GB · apagados após ${s.gravacoes.retencaoDias} dias${s.gravacoes.ffmpeg ? '' : ' · sem ffmpeg (sai H.264 bruto)'}`],
          ])}</div></div>
          <div class="card"><div class="card-head"><h2>${ico('database')} Banco de dados</h2><button class="btn btn-sm" type="button" id="si-limpar">${ico('trash', 'i-sm')} Limpar histórico antigo agora</button></div><div class="card-body">${kv([
            ['Situação', b.ok ? 'respondendo' : H(`fora do ar: ${b.ultimoErro || ''}`), b.ok ? 'ok' : 'err'],
            ['Fila para gravar', `${fmtNum(b.filaPosicoes)} posição(ões) · ${fmtNum(b.filaEventos)} evento(s)`, b.filaPosicoes > 5000 ? 'warn' : ''],
            ['Última gravação', b.ultimaGravacao ? H(atras(textoServidor(b.ultimaGravacao))) : '—'],
            ['Descartadas', b.descartadas ? `${fmtNum(b.descartadas)} (banco ficou fora por muito tempo)` : 'nenhuma', b.descartadas ? 'err' : ''],
            ['Cadastros', b.cadastros ? `${b.cadastros.empresas} empresa(s) · ${b.cadastros.veiculos} veículo(s) · ${b.cadastros.aparelhos} aparelho(s) · ${b.cadastros.usuarios} usuário(s)` : '—'],
            ['Última limpeza', s.limpeza ? H(`${atras(textoServidor(s.limpeza.em))} · ${Object.entries(s.limpeza.resumo || {}).map(([t, n]) => `${t}: ${n}`).join(', ') || 'nada a apagar'}`) : 'ainda não rodou'],
          ])}
          <div class="table-wrap flat" style="margin-top:14px;max-height:240px">${tabela([
            { t: 'Tabela', cls: 'mono', v: (t) => H(t.tabela) },
            { t: 'Linhas (aprox.)', cls: 'num', v: (t) => fmtNum(t.linhas) },
            { t: 'Tamanho', cls: 'num', v: (t) => `${fmtNum(t.mb, 1)} MB` },
          ], b.tabelas || [])}</div></div></div>
        </div>
        ${ativos.length ? `<div style="padding:0 18px 18px"><div class="card"><div class="card-head"><h2>${ico('video')} Vídeos chegando agora</h2></div><div class="table-wrap flat">${tabela([
          { t: 'Aparelho', cls: 'mono', v: (x) => H(x.id) },
          { t: 'Canal', v: (x) => `CH ${x.channel}` },
          { t: 'Tipo', v: (x) => (x.kind === 'playback' ? 'gravação' : 'ao vivo') },
          { t: 'Codificação', v: (x) => H(x.codec || '—') },
          { t: 'Assistindo', cls: 'num', v: (x) => String(x.viewers ?? 0) },
        ], ativos)}</div></div></div>` : ''}`;
      const limpar = $('#si-limpar');
      if (limpar) {
        limpar.addEventListener('click', async () => {
          if (!(await confirmar('Apagar agora o histórico mais antigo que os prazos de Configurações?', { ok: 'Limpar' }))) return;
          try {
            const r = await api('/api/sistema/limpeza', { corpo: {} });
            const n = Object.entries(r.resumo || {}).map(([t, x]) => `${t}: ${x}`).join(', ');
            toast(n ? `Limpeza feita (${n}).` : 'Nada antigo para apagar.', 'ok');
            carregarStatus();
          } catch (e) { toast(e.message, 'err'); }
        });
      }
    };
    await carregarStatus();
    timer = setInterval(carregarStatus, 10000);
  }

  /* ---------- portas e protocolos ---------- */

  async function abaPortas(box) {
    let r;
    try { r = await api('/api/perfis'); } catch (e) { box.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`; return; }
    const abertas = new Set([...r.abertas.sinalizacao, ...r.abertas.video]);
    box.innerHTML = `
      <div class="toolbar"><p class="small muted grow" style="margin:0">Cada perfil abre uma porta para os DVRs (sinalização) e uma de vídeo. O padrão é o JT/T 808 + JT/T 1078 nas portas 6608/6602.
        Ao criar ou mudar uma porta, libere-a também no firewall da Oracle (Lista de Segurança) e no servidor (iptables).</p>
        <button class="btn btn-primary" type="button" id="pf-novo">${ico('plus', 'i-sm')} Novo perfil</button></div>
      <div class="table-wrap flat">${tabela([
        { t: 'Perfil', v: (p) => `<b>${H(p.nome)}</b>${p.padrao ? ' <span class="tag ok">padrão</span>' : ''}<span class="sub">${H(p.observacao || '')}</span>` },
        { t: 'Protocolo', v: (p) => `${H((r.protocolos.find((x) => x.id === p.protocolo) || {}).nome || p.protocolo)}<span class="sub">vídeo ${H((r.protocolosVideo.find((x) => x.id === p.protocolo_video) || {}).nome || p.protocolo_video)}</span>` },
        { t: 'Porta DVR', cls: 'mono', v: (p) => `${p.porta_sinalizacao} ${p.ativo ? (abertas.has(p.porta_sinalizacao) ? '<span class="tag ok">aberta</span>' : '<span class="tag err">falhou</span>') : ''}` },
        { t: 'Porta vídeo', cls: 'mono', v: (p) => `${p.porta_video} ${p.ativo ? (abertas.has(p.porta_video) ? '<span class="tag ok">aberta</span>' : '<span class="tag err">falhou</span>') : ''}` },
        { t: 'Fuso do aparelho', v: (p) => H(fuso(p.fuso_minutos)) },
        { t: 'Aparelhos', cls: 'num', v: (p) => fmtNum(p.aparelhos) },
        { t: 'Situação', v: (p) => sim(p.ativo) },
      ], r.perfis, { linhaCls: () => 'clic', atributos: (p) => `data-pf="${p.id}"` })}</div>`;
    $('#pf-novo').addEventListener('click', () => editarPerfil(null, r));
    box.querySelector('.table-wrap').addEventListener('click', (e) => {
      const tr = e.target.closest('[data-pf]');
      if (tr) editarPerfil(r.perfis.find((p) => String(p.id) === tr.dataset.pf), r);
    });
  }

  function fuso(min) {
    const h = -Number(min) / 60;
    if (Number(min) === -180) return 'Brasília (UTC−3)';
    const s = Number(min) >= 0 ? '+' : '−';
    return `UTC${s}${Math.abs(Number(min) / 60)}${h === -8 ? ' (China)' : ''}`;
  }

  function editarPerfil(p, r) {
    const fusos = [-300, -240, -180, -120, 0, 480].map((m) => ({ v: m, t: fuso(m) }));
    formulario({
      titulo: p ? `Perfil: ${p.nome}` : 'Novo perfil de protocolo',
      icone: 'plug',
      aviso: 'Mudanças de porta valem na hora: os aparelhos conectados na porta antiga caem e precisam usar a nova.',
      campos: [
        { nome: 'nome', rotulo: 'Nome', obrigatorio: true, cheio: true, maxlength: 80 },
        { nome: 'protocolo', rotulo: 'Protocolo dos aparelhos', tipo: 'select', opcoes: r.protocolos.map((x) => ({ v: x.id, t: x.nome })) },
        { nome: 'protocolo_video', rotulo: 'Protocolo de vídeo', tipo: 'select', opcoes: r.protocolosVideo.map((x) => ({ v: x.id, t: x.nome })) },
        { nome: 'porta_sinalizacao', rotulo: 'Porta dos DVRs (sinalização)', tipo: 'numero', obrigatorio: true, min: 1024, max: 65535 },
        { nome: 'porta_video', rotulo: 'Porta de vídeo', tipo: 'numero', obrigatorio: true, min: 1024, max: 65535 },
        { nome: 'endereco_video', rotulo: 'Endereço de vídeo (opcional)', maxlength: 120, placeholder: 'Ex.: 144.22.152.40', ajuda: 'IP/nome que o DVR usa para mandar o vídeo. Vazio: o mesmo em que ele se conectou.' },
        { nome: 'fuso_minutos', rotulo: 'Horário configurado no aparelho', tipo: 'select', opcoes: fusos, ajuda: 'Pela norma o DVR usa o horário da China (UTC+8); a maioria é configurada no de Brasília.' },
        { nome: 'observacao', rotulo: 'Observação', cheio: true, maxlength: 255 },
        { nome: 'padrao', rotulo: 'Perfil padrão para aparelhos novos', tipo: 'check' },
        { nome: 'ativo', rotulo: 'Ativo (porta aberta)', tipo: 'check', desativado: p && p.padrao },
      ],
      valores: p ? { ...p, padrao: !!p.padrao, ativo: !!p.ativo } : { protocolo: 'jt808', protocolo_video: 'jt1078', fuso_minutos: -180, ativo: true },
      salvar: async (d) => {
        const corpo = { ...d, porta_sinalizacao: Number(d.porta_sinalizacao), porta_video: Number(d.porta_video), fuso_minutos: Number(d.fuso_minutos) };
        if (p && p.padrao) corpo.ativo = true;
        const res = p ? await api(`/api/perfis/${p.id}`, { metodo: 'PUT', corpo }) : await api('/api/perfis', { corpo });
        const falhas = [...res.portas.sinalizacao, ...res.portas.video].filter((x) => !x.ok);
        if (falhas.length) toast(`Salvo, mas a porta ${falhas.map((x) => `${x.porta} (${x.erro})`).join(', ')} não abriu.`, 'err');
        else toast('Perfil salvo e portas aplicadas.', 'ok');
        abrirAba();
      },
    });
  }

  /* ---------- aparelhos pendentes ---------- */

  async function abaPendentes(box) {
    let r;
    try { r = await api('/api/aparelhos-pendentes'); } catch (e) { box.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`; return; }
    box.innerHTML = `
      <p class="hint" style="padding-top:14px">DVRs que se conectaram ao servidor sem estar cadastrados. Nada deles é gravado no banco até o cadastro. A lista some sozinha após 30 dias sem contato.</p>
      <div class="table-wrap flat">${tabela([
        { t: 'Número', cls: 'mono', v: (p) => `<b>${H(p.identificador)}</b>` },
        { t: 'Conexão', v: (p) => (p.online ? '<span class="tag ok">online agora</span>' : `<span class="tag off">offline</span><span class="sub">${H(atras(p.ultimo_contato))}</span>`) },
        { t: 'Informado pelo DVR', v: (p) => H([p.fabricante, p.modelo, p.placa_informada && `placa ${p.placa_informada}`].filter(Boolean).join(' · ') || '—') },
        { t: 'Origem', cls: 'mono', v: (p) => H(`${p.ip || ''}${p.porta ? ` → ${p.porta}` : ''}`) },
        { t: 'Primeiro contato', cls: 'nw', v: (p) => H(fmtDataHora(p.primeiro_contato)) },
        { t: 'Conexões', cls: 'num', v: (p) => fmtNum(p.conexoes) },
        { t: '', cls: 'acts', v: (p) => `<button class="btn btn-primary" type="button" data-cad="${H(p.identificador)}">${ico('plus', 'i-sm')} Cadastrar</button><button class="btn" type="button" data-rem="${H(p.identificador)}">Remover</button>` },
      ], r.pendentes, { vazio: 'Nenhum aparelho pendente.' })}</div>`;
    box.querySelector('.table-wrap').addEventListener('click', async (e) => {
      const cad = e.target.closest('[data-cad]');
      const rem = e.target.closest('[data-rem]');
      if (cad) {
        const p = r.pendentes.find((x) => x.identificador === cad.dataset.cad);
        editarAparelho(null, () => { carregarFrota().catch(() => {}); abrirAba(); }, { identificador: p.identificador, fabricante: p.fabricante || '', modelo: p.modelo || '' });
      }
      if (rem) {
        try { await api(`/api/aparelhos-pendentes/${rem.dataset.rem}`, { metodo: 'DELETE' }); abrirAba(); } catch (err) { toast(err.message, 'err'); }
      }
    });
  }

  /* ---------- configurações ---------- */

  async function abaConfig(box) {
    let r;
    try { r = await api('/api/configuracoes'); } catch (e) { box.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`; return; }
    const c = Object.fromEntries(r.configuracoes.map((x) => [x.chave, x]));
    const num = (k) => `<label class="field">${H(c[k].titulo)}<input type="number" name="${k}" min="${c[k].min}" max="${c[k].max}" value="${H(c[k].valor)}"><small>de ${c[k].min} a ${c[k].max}</small></label>`;
    box.innerHTML = `<form class="card-body" id="cf-form" style="max-width:820px">
      <div class="form-grid">
        <div class="form-sep">Aparelhos</div>
        <label class="field full">${H(c.aparelhos_nao_cadastrados.titulo)}<select name="aparelhos_nao_cadastrados">
          <option value="listar">Aceitar a conexão e listar em "Aparelhos pendentes" (recomendado durante a implantação)</option>
          <option value="recusar">Recusar a conexão (mais seguro depois que toda a frota estiver cadastrada)</option></select></label>
        <div class="form-sep">Quanto tempo guardar o histórico</div>
        ${num('retencao_posicoes_dias')}${num('retencao_eventos_dias')}${num('retencao_alertas_dias')}${num('retencao_auditoria_dias')}
        <div class="field full"><small>Nenhum vídeo é guardado no banco. As posições são o que mais ocupa espaço: com 363 veículos, cada 30 dias somam alguns GB.</small></div>
      </div>
      <p class="form-erro" hidden></p>
      <div style="margin-top:16px"><button class="btn btn-primary" type="submit">${ico('check', 'i-sm')} Salvar configurações</button></div>
    </form>`;
    const form = $('#cf-form');
    form.aparelhos_nao_cadastrados.value = c.aparelhos_nao_cadastrados.valor;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const erro = form.querySelector('.form-erro');
      erro.hidden = true;
      const corpo = Object.fromEntries(r.configuracoes.map((x) => [x.chave, form[x.chave].value]));
      try {
        await api('/api/configuracoes', { metodo: 'PUT', corpo });
        toast('Configurações salvas.', 'ok');
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
      }
    });
  }

  /* ---------- log ao vivo ---------- */

  function abaLog(box) {
    box.innerHTML = `
      <div class="toolbar">
        <label class="field">Aparelho<input id="lg-id" placeholder="Todos" maxlength="20" style="width:160px"></label>
        <label class="check"><input type="checkbox" id="lg-rotina"> Mostrar sinais de vida e respostas de rotina</label>
        <div class="grow"></div>
        <button class="btn" type="button" id="lg-pausa">${ico('player-pause', 'i-sm')} Pausar</button>
        <button class="btn" type="button" id="lg-limpar">Limpar</button>
      </div>
      <div class="log-wrap"><table class="log"><thead><tr><th>Hora</th><th></th><th>Aparelho</th><th>Mensagem</th><th>Detalhe</th></tr></thead><tbody id="lg-corpo"></tbody></table></div>`;
    $('#lg-rotina').checked = logRotina;
    $('#lg-rotina').addEventListener('change', (e) => { logRotina = e.target.checked; });
    $('#lg-pausa').addEventListener('click', () => {
      logPausado = !logPausado;
      $('#lg-pausa').innerHTML = logPausado ? `${ico('player-play', 'i-sm')} Continuar` : `${ico('player-pause', 'i-sm')} Pausar`;
    });
    $('#lg-limpar').addEventListener('click', () => { $('#lg-corpo').innerHTML = ''; });
    let t = null;
    $('#lg-id').addEventListener('input', () => { clearTimeout(t); t = setTimeout(abrirLog, 600); });
    $('#lg-corpo').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.row');
      if (!tr || !tr.dataset.hex) return;
      const prox = tr.nextElementSibling;
      if (prox && prox.classList.contains('hexrow')) { prox.remove(); return; }
      const x = document.createElement('tr');
      x.className = 'hexrow';
      x.innerHTML = `<td colspan="5"><pre>${H(tr.dataset.hex)}</pre></td>`;
      tr.after(x);
    });
    abrirLog();
  }

  async function abrirLog() {
    fecharLog();
    const id = ($('#lg-id') && $('#lg-id').value.replace(/\D/g, '')) || '';
    try {
      const url = await wsUrl('/ws/log', id ? { id } : {});
      if (aba !== 'log') return;
      logWs = new WebSocket(url);
      logWs.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'recentes') { $('#lg-corpo').innerHTML = ''; m.entradas.forEach(linhaLog); }
        if (m.type === 'entrada' && !logPausado) linhaLog(m.entrada);
      };
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function fecharLog() {
    if (logWs) { logWs.onmessage = null; logWs.close(); logWs = null; }
  }

  function linhaLog(e) {
    const corpo = $('#lg-corpo');
    if (!corpo) return;
    if (e.kind === 'message' && e.quiet && !logRotina) return;
    const tr = document.createElement('tr');
    tr.className = 'row';
    const hora = new Date(e.at).toLocaleTimeString('pt-BR');
    if (e.kind === 'message') {
      tr.dataset.hex = e.hex || '';
      tr.innerHTML = `<td class="t">${H(hora)}</td><td class="dir ${e.dir === 'in' ? 'dir-in' : 'dir-out'}">${e.dir === 'in' ? '←' : '→'}</td><td class="id">${H(e.id)}</td><td class="name">${H(e.name)}</td><td class="text">${H(e.text || '')}</td>`;
    } else {
      tr.innerHTML = `<td class="t">${H(hora)}</td><td class="dir lvl-${H(e.level)}">●</td><td class="id">${H(e.id || '')}</td><td class="name lvl-${H(e.level)}">${H(e.source || '')}</td><td class="text">${H(e.text)}</td>`;
    }
    corpo.prepend(tr);
    while (corpo.children.length > 500) corpo.lastElementChild.remove();
  }

  return { id: 'sistema', titulo: 'Sistema', sub: 'Status do servidor, portas, aparelhos pendentes e configurações', render, sair };
})();
