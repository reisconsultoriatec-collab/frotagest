'use strict';
/* FrotaGest — Cadastros: veículos, grupos, usuários, aparelhos (DVR) e empresas. Reis Tecnologia */

/** Página de lista com busca, "mostrar inativos" e botão de novo. */
function paginaLista({ id, titulo, sub, novoTexto, podeCriar, carregar, colunas, busca, ativo, editar, vazio, dica }) {
  let linhas = [];
  let offs = [];
  const st = { q: '', inativos: false };

  async function atualizar() {
    const box = $(`#${id}-tabela`);
    if (!box) return;
    try {
      linhas = await carregar();
    } catch (e) {
      box.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
      return;
    }
    desenhar();
  }

  function desenhar() {
    const box = $(`#${id}-tabela`);
    if (!box) return;
    const q = norm(st.q);
    const lista = linhas.filter((l) => (st.inativos || !ativo || ativo(l)) && (!q || norm(busca(l)).includes(q)));
    const inativos = ativo ? linhas.filter((l) => !ativo(l)).length : 0;
    $(`#${id}-n`).textContent = `${lista.length} de ${linhas.length}${inativos ? ` · ${inativos} inativo(s)` : ''}`;
    box.innerHTML = tabela(colunas, lista, {
      vazio: linhas.length ? 'Nada encontrado com essa busca.' : vazio,
      linhaCls: (l) => `${editar ? 'clic' : ''}${ativo && !ativo(l) ? ' inativo' : ''}`,
      atributos: (l) => `data-i="${linhas.indexOf(l)}"`,
    });
  }

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="toolbar">
            <label class="search">${ico('search', 'i-sm')}<input id="${id}-q" placeholder="Buscar" autocomplete="off"></label>
            ${ativo ? `<label class="check"><input type="checkbox" id="${id}-inat"> Mostrar inativos</label>` : ''}
            <div class="grow"></div>
            <span class="count" id="${id}-n"></span>
            ${podeCriar() ? `<button class="btn btn-primary" type="button" id="${id}-novo">${ico('plus', 'i-sm')} ${H(novoTexto)}</button>` : ''}
          </div>
          ${dica ? `<p class="hint" style="padding-top:12px">${dica}</p>` : ''}
          <div class="table-wrap tall flat" id="${id}-tabela"><p class="hint">Carregando…</p></div>
        </section>
      </div>`;
    $(`#${id}-q`).addEventListener('input', (e) => { st.q = e.target.value; desenhar(); });
    const inat = $(`#${id}-inat`);
    if (inat) inat.addEventListener('change', (e) => { st.inativos = e.target.checked; desenhar(); });
    const novo = $(`#${id}-novo`);
    if (novo) novo.addEventListener('click', () => editar(null, atualizar));
    $(`#${id}-tabela`).addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const tr = e.target.closest('tr[data-i]');
      if (tr && editar) editar(linhas[Number(tr.dataset.i)], atualizar);
    });
    atualizar();
    offs.push(on('empresa', atualizar));
  }

  function sair() {
    offs.forEach((f) => f());
    offs = [];
  }

  return { id, titulo, sub, render, sair, atualizar };
}

const sim = (v) => (v ? '<span class="tag ok">ativo</span>' : '<span class="tag off">inativo</span>');
const qEmpresa = () => (S.empresa ? `?${qs({ empresa: S.empresa })}` : '');

/** Master: em qual empresa o cadastro novo vai entrar (usa o filtro do topo ou pergunta). */
async function escolherEmpresa({ comMaster = false } = {}) {
  if (S.eu.perfil !== 'master') return S.eu.empresaId;
  if (S.empresa && !comMaster) return Number(S.empresa);
  const r = await api('/api/empresas');
  const ativas = r.empresas.filter((e) => e.ativo);
  if (!ativas.length && !comMaster) { toast('Cadastre uma empresa primeiro (Cadastros › Empresas).', 'err'); return null; }
  if (ativas.length === 1 && !comMaster) return ativas[0].id;
  return new Promise((resolve) => {
    let escolha = null;
    const ops = [...(comMaster ? [{ v: 'master', t: 'Reis Tecnologia (usuário master)' }] : []), ...ativas.map((e) => ({ v: e.id, t: e.nome }))];
    formulario({
      titulo: 'Para qual empresa?', icone: 'building', tamanho: 'sm', textoSalvar: 'Continuar',
      campos: [{ nome: 'empresa', rotulo: 'Empresa', tipo: 'select', cheio: true, opcoes: ops }],
      valores: { empresa: S.empresa || (ops[0] && ops[0].v) },
      salvar: async (d) => { escolha = d.empresa === 'master' ? 'master' : Number(d.empresa); },
      aoFechar: () => resolve(escolha),
    });
  });
}

function nomeEmpresa(id) {
  const e = S.empresas.find((x) => x.id === id);
  return e ? e.nome : '';
}

/* ---------------- veículos ---------------- */

PAGINAS.veiculos = paginaLista({
  id: 'veiculos',
  titulo: 'Veículos',
  sub: 'Frota cadastrada e o aparelho (DVR) instalado em cada veículo',
  novoTexto: 'Novo veículo',
  podeCriar: () => S.eu.pode.cadastros,
  vazio: 'Nenhum veículo cadastrado ainda.',
  carregar: async () => (await api(`/api/veiculos${qEmpresa()}`)).veiculos,
  busca: (v) => [v.placa, v.prefixo, v.descricao, v.grupo, v.identificador, v.empresa].join(' '),
  ativo: (v) => !!v.ativo,
  colunas: [
    { t: 'Veículo', v: (v) => `<b>${H(v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa)}</b><span class="sub">${H([NOMES_TIPO[v.tipo], v.descricao].filter(Boolean).join(' · '))}</span>` },
    { t: 'Grupo', v: (v) => H(v.grupo || '—') },
    { t: 'Aparelho', v: (v) => (v.identificador ? `<span class="mono">${H(v.identificador)}</span><span class="sub">${v.online ? '<span class="tag ok">online</span>' : v.ultimo_contato ? `último contato ${H(atras(v.ultimo_contato))}` : 'nunca conectou'}</span>` : '<span class="muted">sem aparelho</span>') },
    { t: 'Empresa', v: (v) => H(v.empresa) },
    { t: 'Situação', v: (v) => sim(v.ativo) },
  ],
  editar: editarVeiculo,
});

async function editarVeiculo(v, aposSalvar) {
  const empresaId = v ? v.empresa_id : await escolherEmpresa();
  if (!empresaId) return;
  const [g, a] = await Promise.all([api(`/api/grupos?${qs({ empresa: empresaId })}`), api(`/api/aparelhos?${qs({ empresa: empresaId })}`)]);
  const aparelhos = a.aparelhos.filter((x) => x.ativo && (!x.veiculo_id || (v && x.veiculo_id === v.id)));
  const tipos = Object.entries(NOMES_TIPO).map(([k, t]) => ({ v: k, t }));
  formulario({
    titulo: v ? `Veículo ${v.placa}` : 'Novo veículo',
    icone: 'bus',
    aviso: S.eu.perfil === 'master' ? `Empresa: <b>${H(v ? v.empresa : nomeEmpresa(empresaId))}</b>` : '',
    campos: [
      { tipo: 'separador', rotulo: 'Identificação' },
      { nome: 'placa', rotulo: 'Placa', obrigatorio: true, placeholder: 'ABC1D23', maxlength: 8 },
      { nome: 'prefixo', rotulo: 'Prefixo / número', maxlength: 20, placeholder: 'Ex.: 1020' },
      { nome: 'descricao', rotulo: 'Marca e modelo', maxlength: 120, placeholder: 'Ex.: Mercedes-Benz OF-1721' },
      { nome: 'tipo', rotulo: 'Tipo', tipo: 'select', opcoes: [{ v: '', t: '—' }, ...tipos] },
      { nome: 'ano', rotulo: 'Ano', tipo: 'numero', min: 1950, max: 2100 },
      { nome: 'cor', rotulo: 'Cor', maxlength: 30 },
      { nome: 'chassi', rotulo: 'Chassi', maxlength: 30, cheio: true },
      { tipo: 'separador', rotulo: 'Organização e equipamento' },
      { nome: 'grupo_id', rotulo: 'Grupo', tipo: 'select', opcoes: [{ v: '', t: 'Sem grupo' }, ...g.grupos.map((x) => ({ v: x.id, t: x.caminho }))], ajuda: 'Usuários com acesso só a alguns grupos veem apenas os veículos deles.' },
      { nome: 'aparelho_id', rotulo: 'Aparelho (DVR) instalado', tipo: 'select', opcoes: [{ v: '', t: 'Nenhum' }, ...aparelhos.map((x) => ({ v: x.id, t: `${x.identificador}${x.modelo ? ` · ${x.modelo}` : ''}${x.online ? ' (online)' : ''}` }))], ajuda: aparelhos.length ? 'Só aparecem os aparelhos livres desta empresa.' : 'Nenhum aparelho livre: o master cadastra os aparelhos em Aparelhos (DVR).' },
      { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ...(v ? [{ nome: 'ativo', rotulo: 'Veículo ativo', tipo: 'check' }] : []),
    ],
    valores: v ? { ...v, ativo: !!v.ativo } : {},
    salvar: async (d) => {
      const corpo = { ...d, empresa_id: empresaId };
      if (v) await api(`/api/veiculos/${v.id}`, { metodo: 'PUT', corpo });
      else await api('/api/veiculos', { corpo });
      toast(v ? 'Veículo atualizado.' : 'Veículo cadastrado.', 'ok');
      aposSalvar && aposSalvar();
    },
  });
}

/* ---------------- grupos ---------------- */

PAGINAS.grupos = paginaLista({
  id: 'grupos',
  titulo: 'Grupos',
  sub: 'Organize a frota (garagens, linhas, setores) e limite o que cada usuário vê',
  novoTexto: 'Novo grupo',
  podeCriar: () => S.eu.pode.cadastros,
  vazio: 'Nenhum grupo cadastrado. Grupos são opcionais: use para separar garagens, linhas ou clientes.',
  carregar: async () => (await api(`/api/grupos${qEmpresa()}`)).grupos,
  busca: (g) => g.caminho,
  colunas: [
    { t: 'Grupo', v: (g) => `<b>${H(g.caminho)}</b>` },
    { t: 'Veículos', cls: 'num', v: (g) => fmtNum(g.veiculos) },
    { t: 'Empresa', v: (g) => H(nomeEmpresa(g.empresaId) || (S.eu.empresaNome || '')) },
  ],
  editar: editarGrupo,
});

async function editarGrupo(g, aposSalvar) {
  const empresaId = g ? g.empresaId : await escolherEmpresa();
  if (!empresaId) return;
  const todos = (await api(`/api/grupos?${qs({ empresa: empresaId })}`)).grupos;
  // um grupo não pode ficar dentro dele mesmo nem de um subgrupo dele
  const proibidos = new Set();
  if (g) {
    proibidos.add(g.id);
    let mudou = true;
    while (mudou) { mudou = false; for (const x of todos) if (x.paiId && proibidos.has(x.paiId) && !proibidos.has(x.id)) { proibidos.add(x.id); mudou = true; } }
  }
  const j = formulario({
    titulo: g ? `Grupo ${g.nome}` : 'Novo grupo',
    icone: 'folders',
    tamanho: 'sm',
    campos: [
      { nome: 'nome', rotulo: 'Nome do grupo', obrigatorio: true, cheio: true, maxlength: 80 },
      { nome: 'paiId', rotulo: 'Dentro de', tipo: 'select', cheio: true, opcoes: [{ v: '', t: '— (grupo principal)' }, ...todos.filter((x) => !proibidos.has(x.id)).map((x) => ({ v: x.id, t: x.caminho }))] },
    ],
    valores: g ? { nome: g.nome, paiId: g.paiId || '' } : {},
    extras: g ? `<p style="margin:14px 0 0"><button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir grupo</button></p>` : '',
    salvar: async (d) => {
      const corpo = { nome: d.nome, paiId: d.paiId || null, empresaId };
      if (g) await api(`/api/grupos/${g.id}`, { metodo: 'PUT', corpo });
      else await api('/api/grupos', { corpo });
      toast(g ? 'Grupo atualizado.' : 'Grupo criado.', 'ok');
      aposSalvar && aposSalvar();
    },
  });
  const ex = j.el.querySelector('[data-excluir]');
  if (ex) {
    ex.addEventListener('click', async () => {
      j.fechar();
      if (!(await confirmar(`Excluir o grupo "${g.nome}"?`, { ok: 'Excluir', perigo: true }))) return;
      try {
        await api(`/api/grupos/${g.id}`, { metodo: 'DELETE' });
        toast('Grupo excluído.', 'ok');
        aposSalvar && aposSalvar();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

/* ---------------- usuários ---------------- */

PAGINAS.usuarios = paginaLista({
  id: 'usuarios',
  titulo: 'Usuários',
  sub: 'Quem acessa o FrotaGest e o que cada um pode ver',
  novoTexto: 'Novo usuário',
  podeCriar: () => S.eu.pode.cadastros,
  vazio: 'Nenhum usuário cadastrado.',
  dica: 'Ao cadastrar, a pessoa recebe um e-mail para criar a própria senha. Perfis: <b>Administrador</b> (cadastros da empresa), <b>Operador</b> (mapa, câmeras, gravações e alertas) e <b>Visualizador</b> (mapa, câmeras ao vivo e histórico).',
  carregar: async () => (await api(`/api/usuarios${qEmpresa()}`)).usuarios,
  busca: (u) => [u.nome, u.email, u.empresa, NOMES_PERFIL[u.perfil]].join(' '),
  ativo: (u) => !!u.ativo,
  colunas: [
    { t: 'Nome', v: (u) => `<b>${H(u.nome)}</b><span class="sub">${H(u.email)}</span>` },
    { t: 'Perfil', v: (u) => `${H(NOMES_PERFIL[u.perfil])}${u.perfil === 'operador' || u.perfil === 'visualizador' ? `<span class="sub">${u.todos_grupos ? 'todos os grupos' : `${u.grupos.length} grupo(s)`}</span>` : ''}` },
    { t: 'Empresa', v: (u) => H(u.empresa || 'Reis Tecnologia') },
    { t: 'Último acesso', cls: 'nw', v: (u) => (u.ultimo_acesso ? H(fmtDataHora(u.ultimo_acesso).slice(0, 16)) : `<span class="muted">${u.conta_ligada ? 'nunca entrou' : 'convite pendente'}</span>`) },
    { t: 'Situação', v: (u) => sim(u.ativo) },
  ],
  editar: editarUsuario,
});

async function editarUsuario(u, aposSalvar) {
  let empresaId;
  let master = false;
  if (u) { empresaId = u.empresa_id; master = u.perfil === 'master'; } else {
    const e = await escolherEmpresa({ comMaster: S.eu.perfil === 'master' });
    if (!e) return;
    master = e === 'master';
    empresaId = master ? null : e;
  }
  const grupos = master ? [] : (await api(`/api/grupos?${qs({ empresa: empresaId })}`)).grupos;
  const perfis = master ? [{ v: 'master', t: 'Master (Reis Tecnologia)' }] : [
    { v: 'operador', t: 'Operador' }, { v: 'visualizador', t: 'Visualizador' }, { v: 'admin', t: 'Administrador da empresa' },
  ];
  const eu = u && u.id === S.eu.id;
  const j = formulario({
    titulo: u ? u.nome : 'Novo usuário',
    icone: 'user',
    aviso: master ? 'Usuário <b>master</b>: vê e administra todas as empresas.' : (S.eu.perfil === 'master' ? `Empresa: <b>${H(u ? u.empresa : nomeEmpresa(empresaId))}</b>` : ''),
    campos: [
      { nome: 'nome', rotulo: 'Nome', obrigatorio: true, maxlength: 120 },
      { nome: 'email', rotulo: 'E-mail de login', tipo: 'email', obrigatorio: true, desativado: !!u, ajuda: u ? 'O e-mail não muda. Para trocar, desative e cadastre outro.' : 'A pessoa recebe neste e-mail o link para criar a senha.' },
      { nome: 'perfil', rotulo: 'Perfil', tipo: 'select', opcoes: perfis, desativado: master || eu },
      { nome: 'todosGrupos', rotulo: 'Pode ver todos os grupos', tipo: 'check', se: 'perfil=operador|visualizador' },
      { nome: 'grupos', rotulo: 'Grupos liberados', tipo: 'multi', opcoes: grupos.map((x) => ({ v: x.id, t: x.caminho })), se: 'perfil=operador|visualizador&todosGrupos=false', ajuda: 'Inclui os subgrupos de cada grupo marcado.' },
      ...(u && !eu ? [{ nome: 'ativo', rotulo: 'Acesso ativo', tipo: 'check' }] : []),
    ],
    valores: u ? { ...u, todosGrupos: !!u.todos_grupos, ativo: !!u.ativo, grupos: u.grupos } : { perfil: master ? 'master' : 'operador', todosGrupos: true },
    extras: u && u.ativo ? `<p style="margin:14px 0 0" class="small muted">${u.conta_ligada ? 'Login já criado.' : 'A pessoa ainda não criou a senha.'} <button class="link" type="button" data-convite>${ico('mail', 'i-sm')} Reenviar e-mail para criar/redefinir a senha</button></p>` : '',
    salvar: async (d) => {
      const corpo = { nome: d.nome, perfil: master ? 'master' : d.perfil, todosGrupos: d.todosGrupos, grupos: d.grupos.map(Number), empresaId };
      if (!['operador', 'visualizador'].includes(corpo.perfil)) { corpo.todosGrupos = true; corpo.grupos = []; }
      if (u) {
        if (!eu) corpo.ativo = d.ativo;
        await api(`/api/usuarios/${u.id}`, { metodo: 'PUT', corpo });
        toast('Usuário atualizado.', 'ok');
      } else {
        corpo.email = d.email;
        const r = await api('/api/usuarios', { corpo });
        if (r.convite && r.convite.enviado) toast(`Usuário criado. Enviamos para ${d.email} o link para criar a senha.`, 'ok');
        else setTimeout(() => janela({ titulo: 'Usuário criado, mas o e-mail não foi enviado', tamanho: 'sm', corpo: `<p style="margin:0">${H((r.convite && r.convite.erro) || 'Falha ao falar com o Firebase.')}</p><p class="small muted">Depois de corrigir, abra o usuário e clique em "Reenviar e-mail".</p>`, rodape: '<button class="btn btn-primary" type="button" data-fechar>Entendi</button>' }), 50);
      }
      aposSalvar && aposSalvar();
    },
  });
  const conv = j.el.querySelector('[data-convite]');
  if (conv) {
    conv.addEventListener('click', async () => {
      conv.disabled = true;
      try {
        await api(`/api/usuarios/${u.id}/convite`, { corpo: {} });
        toast(`E-mail enviado para ${u.email}.`, 'ok');
      } catch (e) { toast(e.message, 'err'); } finally { conv.disabled = false; }
    });
  }
}

/* ---------------- aparelhos (DVR) ---------------- */

PAGINAS.aparelhos = paginaLista({
  id: 'aparelhos',
  titulo: 'Aparelhos (DVR)',
  sub: 'DVRs instalados, o protocolo de cada um e os nomes das câmeras',
  novoTexto: 'Novo aparelho',
  podeCriar: () => S.eu.perfil === 'master',
  vazio: 'Nenhum aparelho cadastrado. DVRs que já se conectaram aparecem em Sistema › Aparelhos pendentes.',
  carregar: async () => (await api(`/api/aparelhos${qEmpresa()}`)).aparelhos,
  busca: (a) => [a.identificador, a.modelo, a.fabricante, a.placa, a.prefixo, a.empresa, a.chip_numero].join(' '),
  ativo: (a) => !!a.ativo,
  colunas: [
    { t: 'Número', v: (a) => `<span class="mono"><b>${H(a.identificador)}</b></span><span class="sub">${H([a.fabricante, a.modelo].filter(Boolean).join(' ') || '—')}</span>` },
    { t: 'Veículo', v: (a) => (a.placa ? H(a.prefixo ? `${a.prefixo} · ${a.placa}` : a.placa) : '<span class="muted">não instalado</span>') },
    { t: 'Conexão', v: (a) => (a.online ? '<span class="tag ok">online</span>' : a.ultimo_contato ? `<span class="tag off">offline</span><span class="sub">${H(atras(a.ultimo_contato))}</span>` : '<span class="muted">nunca conectou</span>') },
    { t: 'Canais', cls: 'num', v: (a) => String(a.canais) },
    { t: 'Protocolo', v: (a) => H(a.perfil) },
    { t: 'Empresa', v: (a) => H(a.empresa) },
    { t: 'Situação', v: (a) => sim(a.ativo) },
  ],
  editar: (a, apos) => (S.eu.perfil === 'master' ? editarAparelho(a, apos) : null),
});

async function editarAparelho(a, aposSalvar, valoresIniciais = {}) {
  const [emp, perf] = await Promise.all([api('/api/empresas'), api('/api/perfis')]);
  const empresas = emp.empresas.filter((e) => e.ativo || (a && e.id === a.empresa_id));
  if (!empresas.length) { toast('Cadastre uma empresa primeiro (Cadastros › Empresas).', 'err'); return; }
  const perfis = perf.perfis.filter((p) => p.ativo || (a && p.id === a.perfil_id));
  const padrao = perfis.find((p) => p.padrao) || perfis[0];
  const valores = a
    ? { ...a, ativo: !!a.ativo }
    : { empresa_id: S.empresa || (empresas.length === 1 ? empresas[0].id : ''), perfil_id: padrao && padrao.id, canais: 4, nomes_canais: [], ...valoresIniciais };
  formulario({
    titulo: a ? `Aparelho ${a.identificador}` : 'Novo aparelho',
    icone: 'device-cctv',
    tamanho: 'lg',
    aviso: a && a.placa ? `Instalado no veículo <b>${H(a.placa)}</b>. Para trocar de veículo, edite o veículo.` : '',
    campos: [
      { tipo: 'separador', rotulo: 'Aparelho' },
      { nome: 'empresa_id', rotulo: 'Empresa', tipo: 'select', obrigatorio: true, opcoes: [{ v: '', t: 'Escolha…' }, ...empresas.map((e) => ({ v: e.id, t: e.nome }))] },
      { nome: 'identificador', rotulo: 'Número do aparelho (ID do terminal)', obrigatorio: true, maxlength: 20, placeholder: 'Ex.: 20250703', ajuda: 'O número que o DVR envia ao conectar (o mesmo configurado nele).' },
      { nome: 'fabricante', rotulo: 'Fabricante', maxlength: 60 },
      { nome: 'modelo', rotulo: 'Modelo', maxlength: 60 },
      { nome: 'numero_serie', rotulo: 'Número de série', maxlength: 60 },
      { nome: 'perfil_id', rotulo: 'Perfil de protocolo', tipo: 'select', opcoes: perfis.map((p) => ({ v: p.id, t: `${p.nome} (${p.porta_sinalizacao}/${p.porta_video})` })), ajuda: 'Define as portas e o protocolo. O padrão atende os DVRs JT/T 808 + 1078.' },
      { tipo: 'separador', rotulo: 'Câmeras' },
      { nome: 'canais', rotulo: 'Quantidade de canais', tipo: 'numero', min: 1, max: 16 },
      { nome: 'nomes_canais', rotulo: 'Nome de cada câmera (opcional)', tipo: 'canais', contador: 'canais', ajuda: 'Ex.: Frontal, Cabine, Porta, Traseira. Aparecem no mapa e nas gravações.' },
      { tipo: 'separador', rotulo: 'Chip 4G' },
      { nome: 'chip_numero', rotulo: 'Número do chip', maxlength: 20 },
      { nome: 'chip_operadora', rotulo: 'Operadora', maxlength: 30 },
      { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ...(a ? [{ nome: 'ativo', rotulo: 'Aparelho ativo (desativado: o servidor recusa a conexão)', tipo: 'check', cheio: true }] : []),
    ],
    valores,
    salvar: async (d) => {
      const corpo = { ...d, canais: Number(d.canais) || 4 };
      if (a) await api(`/api/aparelhos/${a.id}`, { metodo: 'PUT', corpo });
      else await api('/api/aparelhos', { corpo });
      toast(a ? 'Aparelho atualizado.' : 'Aparelho cadastrado. Agora instale-o num veículo (Cadastros › Veículos).', 'ok');
      aposSalvar && aposSalvar();
    },
  });
}

/** Cadastro rápido de um aparelho que já está conectado (mapa, início, pendentes). */
function abrirCadastroAparelho(valores) {
  editarAparelho(null, () => carregarFrota().catch(() => {}), valores).catch((e) => toast(e.message, 'err'));
}

/* ---------------- empresas (master) ---------------- */

PAGINAS.empresas = paginaLista({
  id: 'empresas',
  titulo: 'Empresas',
  sub: 'Clientes do FrotaGest (cada empresa vê só a própria frota)',
  novoTexto: 'Nova empresa',
  podeCriar: () => S.eu.perfil === 'master',
  vazio: 'Nenhuma empresa cadastrada.',
  carregar: async () => (await api('/api/empresas')).empresas,
  busca: (e) => [e.nome, e.documento, e.cidade, e.contato, e.email].join(' '),
  ativo: (e) => !!e.ativo,
  colunas: [
    { t: 'Empresa', v: (e) => `<b>${H(e.nome)}</b><span class="sub">${H(e.documento ? fmtDoc(e.documento) : '')}</span>` },
    { t: 'Cidade', v: (e) => H([e.cidade, e.uf].filter(Boolean).join(' / ') || '—') },
    { t: 'Contato', v: (e) => `${H(e.contato || '—')}<span class="sub">${H([e.telefone, e.email].filter(Boolean).join(' · '))}</span>` },
    { t: 'Veículos', cls: 'num', v: (e) => fmtNum(e.veiculos) },
    { t: 'Aparelhos', cls: 'num', v: (e) => fmtNum(e.aparelhos) },
    { t: 'Usuários', cls: 'num', v: (e) => fmtNum(e.usuarios) },
    { t: 'Situação', v: (e) => sim(e.ativo) },
  ],
  editar: editarEmpresa,
});

function fmtDoc(d) {
  const s = String(d || '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return s;
}

function editarEmpresa(e, aposSalvar) {
  formulario({
    titulo: e ? e.nome : 'Nova empresa',
    icone: 'building',
    campos: [
      { nome: 'nome', rotulo: 'Nome', obrigatorio: true, cheio: true, maxlength: 120 },
      { nome: 'documento', rotulo: 'CNPJ ou CPF', maxlength: 20 },
      { nome: 'contato', rotulo: 'Pessoa de contato', maxlength: 120 },
      { nome: 'telefone', rotulo: 'Telefone', maxlength: 30 },
      { nome: 'email', rotulo: 'E-mail', tipo: 'email' },
      { nome: 'cidade', rotulo: 'Cidade', maxlength: 80 },
      { nome: 'uf', rotulo: 'UF', maxlength: 2 },
      { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ...(e ? [{ nome: 'ativo', rotulo: 'Empresa ativa (desativada: ninguém dela entra e os aparelhos são recusados)', tipo: 'check', cheio: true }] : []),
    ],
    valores: e ? { ...e, documento: fmtDoc(e.documento), ativo: !!e.ativo } : {},
    salvar: async (d) => {
      if (e) await api(`/api/empresas/${e.id}`, { metodo: 'PUT', corpo: d });
      else await api('/api/empresas', { corpo: d });
      toast(e ? 'Empresa atualizada.' : 'Empresa cadastrada.', 'ok');
      await carregarFrota().catch(() => {});
      atualizarSeletorEmpresa();
      aposSalvar && aposSalvar();
    },
  });
}
