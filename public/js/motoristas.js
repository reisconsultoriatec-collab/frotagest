'use strict';
/* FrotaGest — Motoristas: cadastro, quem está em cada veículo agora, histórico de cada um e os cartões
 * lidos pelo DVR que ainda não estão no cadastro. Trocar o motorista do veículo: no painel do veículo
 * (Monitoramento) ou aqui. Reis Tecnologia */

const ORIGEM_VINCULO = { manual: 'escolhido no painel', cartao: 'pelo cartão no DVR' };

/** Linha "Motorista" do painel do veículo (quem vê o veículo vê quem dirige; trocar pede a tela Motoristas). */
function htmlMotoristaVeiculo(i) {
  if (!i.veiculoId || (!i.motorista && !podeTela('motoristas', 'alterar'))) return '';
  const m = i.motorista;
  const trocar = podeTela('motoristas', 'alterar') ? `<button class="link" type="button" data-trocar-mot>${m ? 'Trocar' : 'Escolher'}</button>` : '';
  return `<div class="det-mot">${ico('id-badge-2', 'i-sm')}<div><span class="muted small">Motorista</span>
    <b>${m ? H(m.nome) : '<span class="muted" style="font-weight:500">não informado</span>'}</b>
    ${m ? `<small class="muted">desde ${H(fmtCurto(m.desde))} · ${H(ORIGEM_VINCULO[m.origem] || m.origem)}</small>` : ''}</div>${trocar}</div>`;
}

/** Escolher o motorista do veículo (ou deixar sem). */
async function trocarMotorista(i) {
  let lista;
  try {
    lista = (await api(`/api/motoristas?${qs({ empresa: i.empresaId })}`)).motoristas.filter((m) => m.ativo && m.empresa_id === i.empresaId);
  } catch (e) { toast(e.message, 'err'); return; }
  if (!lista.length) {
    toast(podeTela('motoristas', 'incluir') ? 'Nenhum motorista cadastrado: cadastre em Cadastros › Motoristas.' : 'Nenhum motorista cadastrado nesta empresa.');
    return;
  }
  const opc = lista.map((m) => ({ v: m.id, t: `${m.nome}${m.matricula ? ` (${m.matricula})` : ''}${m.veiculoAtual && m.veiculoAtual.id !== i.veiculoId ? ` · está no ${m.veiculoAtual.rotulo}` : ''}` }));
  formulario({
    titulo: `Motorista · ${rotulo(i)}`, icone: 'id-badge-2', tamanho: 'sm',
    aviso: 'Vale a partir de agora, até alguém trocar (ou o motorista passar o cartão no DVR). Se ele estiver em outro veículo, sai de lá.',
    campos: [{ nome: 'motorista', rotulo: 'Quem está dirigindo', tipo: 'select', cheio: true, opcoes: [{ v: '', t: '— Sem motorista' }, ...opc] }],
    valores: { motorista: i.motorista ? i.motorista.id : '' },
    textoSalvar: 'Confirmar',
    salvar: async (d) => {
      await api(`/api/veiculos/${i.veiculoId}/motorista`, { corpo: { motorista: d.motorista || null } });
      toast(d.motorista ? 'Motorista do veículo trocado.' : 'Veículo sem motorista.', 'ok');
    },
  });
}

PAGINAS.motoristas = (() => {
  let cartoes = [];
  let off = null;
  const pagina = paginaLista({
    id: 'motoristas',
    titulo: 'Motoristas',
    sub: 'Quem dirige a frota, quem está em cada veículo agora e os cartões lidos pelo DVR',
    novoTexto: 'Novo motorista',
    podeCriar: () => podeTela('motoristas', 'incluir'),
    podeEditar: (m) => m.editavel && (podeTela('motoristas', 'alterar') || podeTela('motoristas', 'excluir')),
    vazio: 'Nenhum motorista cadastrado ainda. Cadastre para saber quem está em cada veículo, nos alertas e nos relatórios de jornada.',
    carregar: async () => {
      const r = await api(`/api/motoristas${qEmpresa()}`);
      cartoes = r.cartoes || [];
      return r.motoristas;
    },
    busca: (m) => [m.nome, m.matricula, m.cartao, m.cnh_numero, m.grupo, m.veiculoAtual && m.veiculoAtual.rotulo].join(' '),
    ativo: (m) => !!m.ativo,
    colunas: [
      { t: 'Motorista', v: (m) => `<b>${H(m.nome)}</b><span class="sub">${H([m.matricula ? `matrícula ${m.matricula}` : '', m.telefone].filter(Boolean).join(' · '))}</span>` },
      { t: 'Agora', cls: 'nw', v: (m) => (m.veiculoAtual ? `${ico('bus', 'i-xs')} ${H(m.veiculoAtual.rotulo)}<span class="sub">desde ${H(fmtCurto(m.veiculoAtual.desde))}${m.veiculoAtual.origem === 'cartao' ? ' · cartão' : ''}</span>` : '<span class="muted">—</span>') },
      { t: 'CNH', cls: 'nw', v: (m) => (m.cnh_numero || m.cnh_validade ? `${H(m.cnh_categoria || '')}${m.cnh_categoria && m.cnh_validade ? ' · ' : ''}${m.cnh_validade ? vencimentoCnh(m.cnh_validade) : ''}` : '<span class="muted">—</span>') },
      { t: 'Cartão', v: (m) => (m.cartao ? `<span class="mono">${H(m.cartao)}</span>` : '<span class="muted">—</span>') },
      { t: 'Grupo', v: (m) => H(m.grupo || '—') },
      { t: 'Situação', v: (m) => sim(m.ativo) },
    ],
    topo: async (box, atualizar) => {
      const c = cartoes;
      if (!c.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<section class="card mot-cartoes">
        <div class="card-head"><h2>${ico('id', 'i-sm')} Cartões lidos pelo DVR sem cadastro</h2><span class="count">${c.length}</span></div>
        <div class="card-body"><p class="small muted" style="margin:0 0 6px">Alguém passou estes cartões nos veículos. Cadastre o motorista com um clique (o código do cartão já vai preenchido).</p>
        <div class="mot-cartoes-lista">${c.map((x, k) => `<div class="mot-cartao">
          <div><b>${H(x.nome || 'Sem nome no cartão')}</b><span class="sub"><span class="mono">${H(x.cartao)}</span> · ${H(x.veiculo || 'veículo')} · ${H(fmtCurto(x.lidoEm))}${x.vezes > 1 ? ` · ${x.vezes} vezes` : ''}</span></div>
          <div class="mot-cartao-acoes"><button class="btn btn-sm btn-primary" type="button" data-cad-cartao="${k}">${ico('plus', 'i-sm')} Cadastrar</button>
          <button class="btn btn-sm btn-ghost" type="button" data-ign-cartao="${k}" title="Esquecer este cartão" aria-label="Esquecer este cartão">${ico('x', 'i-sm')}</button></div></div>`).join('')}</div></div></section>`;
      box.querySelectorAll('[data-cad-cartao]').forEach((b) => b.addEventListener('click', () => {
        const x = c[Number(b.dataset.cadCartao)];
        editarMotorista(null, atualizar, { nome: x.nome || '', cartao: x.cartao, empresa_id: x.empresaId });
      }));
      box.querySelectorAll('[data-ign-cartao]').forEach((b) => b.addEventListener('click', async () => {
        const x = c[Number(b.dataset.ignCartao)];
        try { await api(`/api/motoristas-cartoes/${encodeURIComponent(x.cartao)}?${qs({ empresa: x.empresaId })}`, { metodo: 'DELETE' }); atualizar(); } catch (e) { toast(e.message, 'err'); }
      }));
    },
    editar: (m, atualizar) => editarMotorista(m, atualizar),
  });
  return {
    ...pagina,
    render(c, params) {
      pagina.render(c, params);
      // cartão passado no DVR, troca feita em outro painel: a lista se atualiza sozinha
      off = on('motoristas', pagina.atualizar);
    },
    sair() {
      if (off) off();
      off = null;
      pagina.sair();
    },
  };
})();

/** "vence em 12/03/2027" com cor quando vencida ou perto de vencer. */
function vencimentoCnh(data) {
  const hoje = textoServidor().slice(0, 10);
  const dias = Math.round((Date.parse(`${data}T00:00:00Z`) - Date.parse(`${hoje}T00:00:00Z`)) / 86400000);
  const txt = `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}`;
  if (dias < 0) return `<span class="tag err">vencida em ${txt}</span>`;
  if (dias <= 30) return `<span class="tag wait">vence ${txt}</span>`;
  return `vence ${txt}`;
}

async function editarMotorista(m, aposSalvar, preenchido = null) {
  if (m && !podeTela('motoristas', 'alterar')) { excluirMotorista(m, aposSalvar); return; }
  const empresaId = m ? m.empresa_id : (preenchido && preenchido.empresa_id) || await escolherEmpresa();
  if (!empresaId) return;
  const r = await api(`/api/grupos?${qs({ empresa: empresaId })}`);
  const limitadoAqui = S.eu.perfil !== 'master' && !S.eu.todosGrupos;
  const cats = ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];
  const j = formulario({
    titulo: m ? m.nome : 'Novo motorista',
    icone: 'id-badge-2',
    aviso: S.eu.perfil === 'master' ? `Empresa: <b>${H(m ? m.empresa : nomeEmpresa(empresaId))}</b>` : '',
    campos: [
      { tipo: 'separador', rotulo: 'Motorista' },
      { nome: 'nome', rotulo: 'Nome', obrigatorio: true, cheio: true, maxlength: 120 },
      { nome: 'matricula', rotulo: 'Matrícula', maxlength: 30 },
      { nome: 'telefone', rotulo: 'Telefone', maxlength: 20, placeholder: '(11) 99999-0000' },
      { nome: 'grupo_id', rotulo: 'Grupo', tipo: 'select', opcoes: [...(limitadoAqui ? [] : [{ v: '', t: 'Sem grupo' }]), ...r.grupos.map((x) => ({ v: x.id, t: x.caminho }))], ajuda: 'Opcional: garagem ou setor do motorista.' },
      { tipo: 'separador', rotulo: 'CNH (opcional)' },
      { nome: 'cnh_numero', rotulo: 'Número da CNH', maxlength: 20 },
      { nome: 'cnh_categoria', rotulo: 'Categoria', tipo: 'select', opcoes: [{ v: '', t: '—' }, ...cats.map((x) => ({ v: x, t: x }))] },
      { nome: 'cnh_validade', rotulo: 'Validade', tipo: 'dia', ajuda: 'Com a validade, o sistema avisa antes de vencer.' },
      { tipo: 'separador', rotulo: 'Cartão no DVR (opcional)' },
      { nome: 'cartao', rotulo: 'Código do cartão', maxlength: 40, cheio: true, ajuda: 'Se o DVR tiver leitor de cartão, o motorista passa o cartão e o sistema sabe na hora quem está dirigindo. O código aparece em "Cartões lidos" quando ele passar o cartão a primeira vez.' },
      { nome: 'observacao', rotulo: 'Observação', tipo: 'textarea' },
      ...(m ? [{ nome: 'ativo', rotulo: 'Motorista ativo', tipo: 'check' }] : []),
    ],
    valores: m ? { ...m, ativo: !!m.ativo, cnh_validade: m.cnh_validade || '' } : (preenchido || {}),
    extras: m ? `<p style="margin:14px 0 0;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" type="button" data-hist-mot>${ico('history', 'i-sm')} Veículos que dirigiu</button>
      ${podeTela('motoristas', 'excluir') ? `<button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir</button>` : ''}</p>` : '',
    salvar: async (d) => {
      const corpo = { ...d, empresa: empresaId };
      if (m) await api(`/api/motoristas/${m.id}`, { metodo: 'PUT', corpo });
      else await api('/api/motoristas', { corpo });
      toast(m ? 'Motorista atualizado.' : 'Motorista cadastrado.', 'ok');
      aposSalvar && aposSalvar();
    },
  });
  const h = j.el.querySelector('[data-hist-mot]');
  if (h) h.addEventListener('click', () => historicoMotorista(m));
  const ex = j.el.querySelector('[data-excluir]');
  if (ex) ex.addEventListener('click', async () => { if (await excluirMotorista(m, aposSalvar)) j.fechar(); });
}

async function excluirMotorista(m, aposSalvar) {
  if (!podeTela('motoristas', 'excluir')) return false;
  if (!(await confirmar(`Excluir o motorista ${m.nome}? Só dá para excluir quem nunca dirigiu; os outros, desative.`, { titulo: 'Excluir motorista', ok: 'Excluir', perigo: true }))) return false;
  try {
    await api(`/api/motoristas/${m.id}`, { metodo: 'DELETE' });
    toast('Motorista excluído.', 'ok');
    aposSalvar && aposSalvar();
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

async function historicoMotorista(m) {
  let h;
  try { h = (await api(`/api/motoristas/${m.id}/historico`)).historico; } catch (e) { toast(e.message, 'err'); return; }
  janela({
    titulo: `${m.nome} · veículos que dirigiu`, icone: 'history',
    corpo: h.length ? `<div class="cmd-hist">${h.map((x) => `<div class="cmd-hist-item"><div><b>${H(x.veiculo)}</b><span class="sub">${H(ORIGEM_VINCULO[x.origem] || x.origem)}${x.usuario ? ` · ${H(x.usuario)}` : ''}</span></div>
      <div class="cmd-hist-lado"><span>${H(fmtCurto(x.inicio))} → ${x.fim ? H(fmtCurto(x.fim)) : '<span class="tag ok">agora</span>'}</span></div></div>`).join('')}</div>`
      : '<p class="small muted" style="margin:0">Ainda não dirigiu nenhum veículo.</p>',
    rodape: '<button class="btn" type="button" data-fechar>Fechar</button>',
  });
}
