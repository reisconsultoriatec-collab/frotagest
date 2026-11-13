'use strict';
/* FrotaGest — Links de acompanhamento: página pública com prazo para um cliente ou passageiro acompanhar
 * a posição de um veículo ou as viagens de uma linha (com o aviso "está chegando" no celular). Aqui se
 * criam, enviam (copiar / WhatsApp) e cancelam os links. Reis Tecnologia */

const SIT_LINK = { ativo: ['ok', 'Ativo'], vencido: ['off', 'Vencido'], cancelado: ['off', 'Cancelado'] };
const fmtValidade = (h) => (h < 24 ? `${h} hora${h === 1 ? '' : 's'}` : `${h / 24} dia${h === 24 ? '' : 's'}`);
const urlLink = (caminho) => `${location.origin}${caminho}`;

/** Cria um link (do Monitoramento: pre.tipo = 'veiculo' e pre.veiculoId; das linhas: 'linha' e pre.linhaId). */
async function novoLinkAcompanhamento(pre = {}) {
  if (!podeTela('acompanhamento', 'incluir')) return;
  let apoio;
  try { apoio = await api(`/api/acompanhamento${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`); } catch (e) { toast(e.message, 'err'); return; }
  const veics = [...S.itens.values()].filter((i) => i.veiculoId && i.aparelhoId)
    .sort((a, b) => rotulo(a).localeCompare(rotulo(b), 'pt-BR', { numeric: true }));
  const tipos = [{ v: 'veiculo', t: 'Posição de um veículo' }, ...(apoio.linhas.length || pre.tipo === 'linha' ? [{ v: 'linha', t: 'Viagens de uma linha (passageiros)' }] : [])];
  formulario({
    titulo: 'Novo link de acompanhamento', icone: 'share', textoSalvar: 'Criar link',
    aviso: 'Quem recebe o link vê <b>só</b> o que está aqui: a posição do veículo (ou as viagens da linha enquanto rodam), sem login, até o link vencer ou ser cancelado. Nada de motorista, câmeras ou alertas.',
    campos: [
      { nome: 'tipo', rotulo: 'O que compartilhar', tipo: 'select', cheio: true, opcoes: tipos },
      { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', cheio: true, se: 'tipo=veiculo', opcoes: [{ v: '', t: 'Escolha o veículo' }, ...veics.map((i) => ({ v: i.veiculoId, t: rotulo(i) }))] },
      { nome: 'horas', rotulo: 'Vale por', tipo: 'select', se: 'tipo=veiculo', opcoes: apoio.validades.map((h) => ({ v: h, t: fmtValidade(h) })) },
      { nome: 'linha', rotulo: 'Linha', tipo: 'select', cheio: true, se: 'tipo=linha', opcoes: [{ v: '', t: 'Escolha a linha' }, ...apoio.linhas.map((l) => ({ v: l.id, t: l.nome }))] },
      { nome: 'ate', rotulo: 'Vale até (vazio = até cancelar)', tipo: 'dia', se: 'tipo=linha', ajuda: 'O veículo só aparece enquanto uma viagem da linha está rodando.' },
      { nome: 'nome', rotulo: 'Para quem (só para você saber)', maxlength: 80, cheio: true, placeholder: 'Ex.: Cliente Transportes Silva / Pais da Escola Municipal' },
      { nome: 'mostrarVeiculo', rotulo: 'Mostrar o prefixo e a placa do veículo', tipo: 'check', cheio: true },
    ],
    valores: { tipo: pre.tipo || 'veiculo', veiculo: pre.veiculoId || '', linha: pre.linhaId || '', horas: 4, mostrarVeiculo: true },
    salvar: async (d) => {
      const corpo = d.tipo === 'veiculo'
        ? { tipo: 'veiculo', veiculo: d.veiculo || null, horas: Number(d.horas), nome: d.nome, mostrarVeiculo: d.mostrarVeiculo }
        : { tipo: 'linha', linha: d.linha || null, ate: d.ate || null, nome: d.nome, mostrarVeiculo: d.mostrarVeiculo };
      if (d.tipo === 'veiculo' && !d.veiculo) throw new Error('Escolha o veículo.');
      if (d.tipo === 'linha' && !d.linha) throw new Error('Escolha a linha.');
      const r = await api('/api/acompanhamento', { corpo });
      emit('acompanhamento');
      setTimeout(() => mostrarLink(r.caminho, r.expiraEm, d.tipo), 50);
    },
  });
}

/** O link pronto: copiar ou mandar pelo WhatsApp. */
function mostrarLink(caminho, expiraEm, tipo) {
  const url = urlLink(caminho);
  const texto = tipo === 'linha'
    ? `Acompanhe a viagem pelo link (escolha o seu ponto e ligue o aviso de chegada): ${url}`
    : `Acompanhe a localização do veículo pelo link${expiraEm ? ` (vale até ${fmtDataHora(expiraEm).slice(0, 16)})` : ''}: ${url}`;
  const j = janela({
    titulo: 'Link pronto', icone: 'link', tamanho: 'sm',
    corpo: `<p style="margin:0 0 10px">${expiraEm ? `Vale até <b>${H(fmtDataHora(expiraEm).slice(0, 16))}</b>.` : 'Vale até você cancelar (em <b>Links de acompanhamento</b>).'}</p>
      <label class="field"><span>Endereço</span><input id="lk-url" readonly value="${H(url)}"></label>
      <div class="lk-acoes"><button class="btn btn-primary" type="button" data-copiar>${ico('copy', 'i-sm')} Copiar</button>
        <a class="btn" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener noreferrer">${ico('brand-whatsapp', 'i-sm')} WhatsApp</a>
        <a class="btn btn-ghost" href="${H(caminho)}" target="_blank" rel="noopener noreferrer">${ico('external-link', 'i-sm')} Abrir</a></div>`,
  });
  j.el.querySelector('#lk-url').addEventListener('focus', (e) => e.target.select());
  j.el.querySelector('[data-copiar]').addEventListener('click', () => copiarLink(url));
}

async function copiarLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copiado.', 'ok');
  } catch {
    const el = $('#lk-url');
    if (el) { el.focus(); el.select(); }
    toast('Selecione e copie o endereço (Ctrl+C).');
  }
}

PAGINAS.acompanhamento = (() => {
  const f = { sit: 'ativo', busca: '' };
  let lista = [];
  let offs = [];
  let seq = 0;

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="toolbar">
            <label class="field">Situação<select id="lk-sit"><option value="ativo">Ativos</option><option value="">Todos (inclusive vencidos e cancelados)</option></select></label>
            <label class="search">${ico('search', 'i-sm')}<input id="lk-busca" placeholder="Para quem, veículo ou linha" autocomplete="off"></label>
            <div class="grow"></div>
            ${podeTela('acompanhamento', 'incluir') ? `<button class="btn btn-primary" type="button" id="lk-novo">${ico('plus', 'i-sm')} Novo link</button>` : ''}
          </div>
          <div class="table-wrap tall" id="lk-tabela"><p class="hint">Carregando…</p></div>
          <p class="hint">O link abre uma página sem login com a posição do veículo (ou as viagens da linha enquanto rodam). Link de veículo vale por um prazo; link de linha vale até a data escolhida ou até cancelar. Vencidos e cancelados saem da lista depois de 30 dias.</p>
        </section>
      </div>`;
    $('#lk-sit').value = f.sit;
    $('#lk-busca').value = f.busca;
    $('#lk-sit').addEventListener('change', () => { f.sit = $('#lk-sit').value; desenhar(); });
    $('#lk-busca').addEventListener('input', () => { f.busca = $('#lk-busca').value; desenhar(); });
    const novo = $('#lk-novo');
    if (novo) novo.addEventListener('click', () => novoLinkAcompanhamento());
    $('#lk-tabela').addEventListener('click', clique);
    carregar();
    offs.push(on('acompanhamento', carregar));
    offs.push(on('empresa', carregar));
  }

  function sair() {
    offs.forEach((o) => o());
    offs = [];
    seq++;
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const r = await api(`/api/acompanhamento${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      if (meu !== seq || !$('#lk-tabela')) return;
      lista = r.links;
      desenhar();
    } catch (e) {
      if (meu === seq && $('#lk-tabela')) $('#lk-tabela').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  function desenhar() {
    const box = $('#lk-tabela');
    if (!box) return;
    const b = norm(f.busca);
    const l = lista.filter((x) => (!f.sit || x.situacao === f.sit) && (!b || norm([x.nome, x.alvo, x.criadoPor].join(' ')).includes(b)));
    const exc = podeTela('acompanhamento', 'excluir');
    const master = S.eu.perfil === 'master' && !S.empresa;
    box.innerHTML = tabela([
      { t: 'Link', v: (x) => `<span class="lk-alvo">${ico(x.tipo === 'veiculo' ? 'bus' : 'route-2', 'i-sm')}<span><b>${H(x.alvo)}</b><span class="sub">${H(x.nome || (x.tipo === 'veiculo' ? 'posição do veículo' : 'viagens da linha'))}${master ? ` · ${H(x.empresa)}` : ''}</span></span></span>` },
      { t: 'Vale até', cls: 'nw', v: (x) => (x.revogadoEm ? `<span class="muted">cancelado ${H(fmtCurto(x.revogadoEm))}</span>` : x.expiraEm ? H(fmtDataHora(x.expiraEm).slice(0, 16)) : 'até cancelar') },
      { t: 'Acessos', cls: 'nw', v: (x) => `${fmtNum(x.acessos)}${x.ultimoAcesso ? `<span class="sub">último ${H(fmtCurto(x.ultimoAcesso))}</span>` : ''}` },
      { t: 'Avisos de chegada', cls: 'nw', v: (x) => (x.tipo === 'linha' ? fmtNum(x.avisos) : '<span class="muted">—</span>') },
      { t: 'Criado', cls: 'nw', v: (x) => `${H(fmtCurto(x.criadoEm))}<span class="sub">${H(x.criadoPor)}</span>` },
      { t: 'Situação', v: (x) => `<span class="tag ${SIT_LINK[x.situacao][0]}">${SIT_LINK[x.situacao][1]}</span>` },
      { t: '', cls: 'nw', v: (x) => (x.situacao === 'ativo' ? `<div class="ln-acoes">
          <button class="btn btn-sm btn-ghost" type="button" data-ver-link="${x.id}" title="Copiar ou enviar" aria-label="Copiar ou enviar">${ico('share', 'i-sm')}</button>
          ${exc ? `<button class="btn btn-sm btn-ghost" type="button" data-cancelar-link="${x.id}" title="Cancelar o link" aria-label="Cancelar o link">${ico('link-off', 'i-sm')}</button>` : ''}</div>` : '') },
    ], l, {
      vazio: f.sit === 'ativo' ? 'Nenhum link ativo. Crie um em "Novo link", pelo veículo no Monitoramento (Compartilhar localização) ou pela linha.' : 'Nenhum link.',
      linhaCls: (x) => (x.situacao === 'ativo' ? '' : 'inativo'),
    });
  }

  async function clique(e) {
    const v = e.target.closest('[data-ver-link]');
    if (v) { const x = lista.find((y) => y.id === Number(v.dataset.verLink)); if (x) mostrarLink(x.caminho, x.expiraEm, x.tipo); return; }
    const c = e.target.closest('[data-cancelar-link]');
    if (!c) return;
    const x = lista.find((y) => y.id === Number(c.dataset.cancelarLink));
    if (!x || !await confirmar(`Cancelar o link de ${x.alvo}${x.nome ? ` (${x.nome})` : ''}? Quem tem o endereço deixa de ver na hora${x.avisos ? ` e os ${x.avisos} aviso(s) de chegada param` : ''}.`, { titulo: 'Cancelar link', ok: 'Cancelar o link', perigo: true })) return;
    try {
      await api(`/api/acompanhamento/${x.id}`, { metodo: 'DELETE' });
      toast('Link cancelado.', 'ok');
      carregar();
    } catch (err) { toast(err.message, 'err'); }
  }

  return { id: 'acompanhamento', titulo: 'Links de acompanhamento', sub: 'Página com a posição do veículo ou as viagens da linha para clientes e passageiros', render, sair };
})();
