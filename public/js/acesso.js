'use strict';
/* FrotaGest — Controle de acesso: em quais menus cada usuário entra e, em cada um, se pode incluir,
 * alterar ou excluir (ou só ver). O perfil continua decidindo a empresa e os grupos que a pessoa enxerga.
 * O master tem acesso total e é o único que libera este menu para alguém. Reis Tecnologia */

const NOMES_ACAO_ACESSO = { ver: 'Ver', incluir: 'Incluir', alterar: 'Alterar', excluir: 'Excluir' };

PAGINAS.acesso = (() => {
  let dados = null; // resposta do /api/acessos
  let sel = null; // id do usuário escolhido
  let rascunho = null; // { tela: Set(acoes) } em edição
  let seq = 0;
  let offs = [];
  const f = { q: '', so: '' };

  function render(c, params) {
    if (params && params.u) sel = Number(params.u) || null;
    c.innerHTML = `
      <div class="page">
        <p class="ac-intro">${ico('info-circle', 'i-sm')}<span>O <b>perfil</b> define a empresa e os grupos que a pessoa enxerga. Aqui você escolhe <b>em quais menus ela entra</b> e, em cada um, se pode <b>incluir, alterar ou excluir</b> ou só ver. Sem personalizar, vale o padrão do perfil.</span></p>
        <div class="ac-grade">
          <section class="card ac-usuarios">
            <div class="card-head"><h2>${ico('users')} Usuários</h2><span class="count" id="ac-n"></span></div>
            <div class="ac-filtros">
              <label class="search">${ico('search', 'i-sm')}<input id="ac-q" placeholder="Buscar usuário" autocomplete="off"></label>
              <select id="ac-so" aria-label="Filtrar usuários">
                <option value="">Todos</option><option value="pers">Personalizados</option>
                <option value="admin">Administradores</option><option value="operador">Operadores</option><option value="visualizador">Visualizadores</option>
              </select>
            </div>
            <div class="ac-lista" id="ac-lista"><p class="hint">Carregando…</p></div>
          </section>
          <section class="card ac-matriz" id="ac-matriz"><div class="ac-vazio">${ico('lock-access')}<p>Escolha um usuário na lista para ver e ajustar o acesso dele.</p></div></section>
        </div>
      </div>`;
    $('#ac-q').addEventListener('input', (e) => { f.q = e.target.value; desenharLista(); });
    $('#ac-so').value = f.so;
    $('#ac-so').addEventListener('change', (e) => { f.so = e.target.value; desenharLista(); });
    $('#ac-lista').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-u]');
      if (!b) return;
      const id = Number(b.dataset.u);
      if (id === sel) return;
      if (alterado() && !(await confirmar('Há alterações não salvas no acesso deste usuário. Descartar?', { titulo: 'Descartar alterações', ok: 'Descartar', perigo: true }))) return;
      escolher(id);
      if (window.matchMedia('(max-width: 900px)').matches) $('#ac-matriz').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    carregar();
    offs.push(on('empresa', () => { sel = null; rascunho = null; carregar(); }));
  }

  function sair() {
    offs.forEach((x) => x());
    offs = [];
    seq++;
  }

  async function carregar(manterRascunho = false) {
    const meu = ++seq;
    try {
      const r = await api(`/api/acessos${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      if (meu !== seq || !$('#ac-lista')) return;
      dados = r;
      dados.trava = new Set(r.travadas);
      if (sel && !dados.usuarios.some((u) => u.id === sel)) sel = null;
      desenharLista();
      if (sel) escolher(sel, manterRascunho);
    } catch (e) {
      if (meu === seq && $('#ac-lista')) $('#ac-lista').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  const usuario = () => (dados ? dados.usuarios.find((u) => u.id === sel) : null);

  function situacao(u) {
    if (u.perfil === 'master') return '<span class="tag ok">acesso total</span>';
    if (u.personalizado) return '<span class="tag wait">personalizado</span>';
    return '<span class="tag off">padrão do perfil</span>';
  }

  function desenharLista() {
    const box = $('#ac-lista');
    if (!box || !dados) return;
    const q = norm(f.q);
    const lista = dados.usuarios.filter((u) => (!q || norm([u.nome, u.email, u.empresa].join(' ')).includes(q))
      && (!f.so || (f.so === 'pers' ? u.personalizado : u.perfil === f.so)));
    $('#ac-n').textContent = `${lista.length} de ${dados.usuarios.length}`;
    if (!lista.length) { box.innerHTML = `<p class="hint">${dados.usuarios.length ? 'Ninguém com esse filtro.' : 'Nenhum usuário.'}</p>`; return; }
    const todas = S.eu.perfil === 'master' && !S.empresa;
    box.innerHTML = lista.map((u) => `
      <button type="button" class="ac-item${u.id === sel ? ' sel' : ''}${u.ativo ? '' : ' inativo'}" data-u="${u.id}">
        <span class="avatar">${H(iniciais(u.nome))}</span>
        <span class="ac-item-txt"><b>${H(u.nome)}${u.id === S.eu.id ? ' <small>(você)</small>' : ''}</b>
          <small>${H(NOMES_PERFIL[u.perfil] || u.perfil)}${todas && u.empresa ? ` · ${H(u.empresa)}` : ''}${u.ativo ? '' : ' · inativo'}</small></span>
        <span class="ac-item-sit">${situacao(u)}${u.editavel ? '' : `<span class="ac-cad" title="${H(u.motivo || '')}">${ico('lock', 'i-xs')}</span>`}</span>
      </button>`).join('');
  }

  /** Matriz do usuário → rascunho editável (Sets). */
  function paraRascunho(acessos) {
    const r = {};
    for (const t of dados.telas) r[t.id] = new Set(acessos[t.id] || []);
    return r;
  }

  function alterado() {
    const u = usuario();
    if (!u || !rascunho) return false;
    return dados.telas.some((t) => {
      const a = new Set(u.acessos[t.id] || []);
      const b = rascunho[t.id];
      return a.size !== b.size || [...a].some((x) => !b.has(x));
    });
  }

  function escolher(id, manterRascunho = false) {
    sel = id;
    const u = usuario();
    if (!u) return;
    if (!manterRascunho || !rascunho) rascunho = paraRascunho(u.acessos);
    $$('#ac-lista .ac-item').forEach((b) => b.classList.toggle('sel', Number(b.dataset.u) === id));
    desenharMatriz();
  }

  /** Pode mexer nesta caixa? (usuário editável, ação existe na tela e não está travada para quem edita) */
  const editavel = (u, t, a) => u.editavel && Object.prototype.hasOwnProperty.call(t.acoes, a) && !dados.trava.has(`${t.id}.${a}`);

  function desenharMatriz() {
    const box = $('#ac-matriz');
    const u = usuario();
    if (!box || !u) return;
    const padrao = u.perfil === 'master' ? null : dados.padroes[u.perfil];
    const grupos = [...new Set(dados.telas.map((t) => t.grupo))];
    const cab = dados.acoes.map((a) => `<th class="ac-col"><button type="button" class="ac-col-btn" data-col="${a}" ${u.editavel ? '' : 'disabled'} title="${u.editavel ? `Marcar ou desmarcar ${NOMES_ACAO_ACESSO[a].toLowerCase()} em todos os menus` : ''}">${NOMES_ACAO_ACESSO[a]}</button></th>`).join('');
    const linhas = grupos.map((g) => {
      const telas = dados.telas.filter((t) => t.grupo === g);
      return `<tr class="ac-grupo"><td colspan="${dados.acoes.length + 1}">${H(g)}</td></tr>${telas.map((t) => {
        const celulas = dados.acoes.map((a) => {
          if (!Object.prototype.hasOwnProperty.call(t.acoes, a)) return '<td class="ac-cel na" aria-label="Não se aplica">—</td>';
          const marcado = rascunho[t.id].has(a);
          const pode = editavel(u, t, a);
          const dif = padrao && marcado !== (padrao[t.id] || []).includes(a);
          const motivoTrava = !pode && u.editavel ? (t.soMaster ? 'Só o master libera o Controle de acesso.' : 'Você não tem esta permissão, então não pode liberar nem tirar.') : '';
          return `<td class="ac-cel${dif ? ' dif' : ''}"><label class="ac-chk${pode ? '' : ' trava'}" title="${H(`${t.acoes[a]}${motivoTrava ? ` — ${motivoTrava}` : ''}${dif ? ' (diferente do padrão do perfil)' : ''}`)}">
            <input type="checkbox" data-t="${t.id}" data-a="${a}" ${marcado ? 'checked' : ''} ${pode ? '' : 'disabled'} aria-label="${H(`${t.nome}: ${NOMES_ACAO_ACESSO[a]}`)}"></label></td>`;
        }).join('');
        return `<tr class="${rascunho[t.id].size ? '' : 'sem'}"><th scope="row" class="ac-tela">
          <span class="ac-tela-nome">${H(t.nome)}${t.soMaster ? ` <span class="ac-so-master" title="Só o master libera este menu">${ico('lock', 'i-xs')} master</span>` : ''}</span>
          <small>${H(descricao(t))}</small></th>${celulas}</tr>`;
      }).join('')}`;
    }).join('');

    const aviso = !u.editavel
      ? `<div class="ac-aviso ${u.perfil === 'master' ? 'ok' : ''}">${ico(u.perfil === 'master' ? 'shield-check' : 'lock', 'i-sm')}<span>${H(u.motivo)}</span></div>` : '';
    const quando = u.alteradoEm ? `Última alteração em ${H(fmtDataHora(u.alteradoEm).slice(0, 16))}${u.alteradoPor ? ` por ${H(u.alteradoPor)}` : ''}.` : '';
    box.innerHTML = `
      <div class="ac-cab">
        <span class="avatar">${H(iniciais(u.nome))}</span>
        <div class="ac-cab-txt"><div class="eyebrow">${H(NOMES_PERFIL[u.perfil] || u.perfil)}${u.empresa ? ` · ${H(u.empresa)}` : ''}</div>
          <h2>${H(u.nome)}</h2><div class="small muted">${H(u.email)} · ${u.todosGrupos ? 'todos os grupos' : `${u.grupos} grupo(s)`}</div></div>
        <div class="ac-cab-sit" id="ac-sit">${situacao(u)}</div>
      </div>
      ${aviso}
      <div class="ac-tabela-box"><table class="tbl ac-tabela">
        <thead><tr><th class="ac-tela-h">Menu</th>${cab}</tr></thead>
        <tbody id="ac-corpo">${linhas}</tbody>
      </table></div>
      <div class="ac-rodape">
        <div class="ac-legenda small muted">
          <span><i class="ac-ponto"></i> diferente do padrão do perfil</span>
          <span>— não se aplica a este menu</span>
          ${quando ? `<span>${quando}</span>` : ''}
        </div>
        ${u.editavel ? `<div class="ac-botoes">
          <select id="ac-modelo" aria-label="Preencher com o padrão de um perfil"><option value="">Preencher com o padrão de…</option>
            <option value="admin">Administrador</option><option value="operador">Operador</option><option value="visualizador">Visualizador</option></select>
          <button class="btn" type="button" id="ac-padrao" ${u.personalizado ? '' : 'disabled'}>${ico('arrow-back-up', 'i-sm')} Voltar ao padrão do perfil</button>
          <button class="btn" type="button" id="ac-desfazer" disabled>Desfazer</button>
          <button class="btn btn-primary" type="button" id="ac-salvar" disabled>${ico('check', 'i-sm')} Salvar</button>
        </div>` : ''}
      </div>`;
    if (!u.editavel) return;
    $('#ac-corpo').addEventListener('change', (e) => {
      const i = e.target.closest('input[data-t]');
      if (!i) return;
      marcar(i.dataset.t, i.dataset.a, i.checked);
    });
    box.querySelectorAll('[data-col]').forEach((b) => b.addEventListener('click', () => coluna(b.dataset.col)));
    $('#ac-modelo').addEventListener('change', (e) => {
      const p = e.target.value;
      e.target.value = '';
      if (!p) return;
      for (const t of dados.telas) for (const a of Object.keys(t.acoes)) if (editavel(u, t, a)) {
        if ((dados.padroes[p][t.id] || []).includes(a)) rascunho[t.id].add(a); else rascunho[t.id].delete(a);
      }
      atualizarCaixas();
      toast(`Preenchido com o padrão de ${NOMES_PERFIL[p]}. Confira e salve.`);
    });
    $('#ac-padrao').addEventListener('click', voltarAoPadrao);
    $('#ac-desfazer').addEventListener('click', () => { rascunho = paraRascunho(u.acessos); atualizarCaixas(); });
    $('#ac-salvar').addEventListener('click', salvar);
    atualizarBotoes();
  }

  /** "Ver" vem junto com qualquer outra ação; tirar o "Ver" tira o menu inteiro. */
  function marcar(tela, acao, ligado) {
    const s = rascunho[tela];
    const u = usuario();
    const t = dados.telas.find((x) => x.id === tela);
    if (ligado) {
      s.add(acao);
      if (acao !== 'ver' && !s.has('ver')) s.add('ver');
    } else if (acao === 'ver') {
      for (const a of [...s]) if (editavel(u, t, a)) s.delete(a);
      s.delete('ver');
    } else {
      s.delete(acao);
    }
    atualizarCaixas();
  }

  function coluna(acao) {
    const u = usuario();
    const telas = dados.telas.filter((t) => editavel(u, t, acao));
    if (!telas.length) return;
    const ligar = telas.some((t) => !rascunho[t.id].has(acao));
    for (const t of telas) marcar(t.id, acao, ligar);
  }

  /** Redesenha só o estado das caixas (sem perder a rolagem). */
  function atualizarCaixas() {
    const u = usuario();
    const padrao = dados.padroes[u.perfil];
    $$('#ac-corpo input[data-t]').forEach((i) => {
      const marcado = rascunho[i.dataset.t].has(i.dataset.a);
      i.checked = marcado;
      const dif = padrao && marcado !== (padrao[i.dataset.t] || []).includes(i.dataset.a);
      i.closest('td').classList.toggle('dif', Boolean(dif));
      i.closest('tr').classList.toggle('sem', !rascunho[i.dataset.t].size);
    });
    atualizarBotoes();
  }

  function atualizarBotoes() {
    const mudou = alterado();
    const sit = $('#ac-sit');
    const u = usuario();
    if (sit && u) sit.innerHTML = mudou ? '<span class="tag novo">alterações não salvas</span>' : situacao(u);
    const s = $('#ac-salvar');
    if (s) s.disabled = !mudou;
    const d = $('#ac-desfazer');
    if (d) d.disabled = !mudou;
  }

  function resumoMudancas(u) {
    const mais = [];
    const menos = [];
    for (const t of dados.telas) {
      const antes = new Set(u.acessos[t.id] || []);
      const depois = rascunho[t.id];
      const m = dados.acoes.filter((a) => depois.has(a) && !antes.has(a)).map((a) => NOMES_ACAO_ACESSO[a].toLowerCase());
      const n = dados.acoes.filter((a) => antes.has(a) && !depois.has(a)).map((a) => NOMES_ACAO_ACESSO[a].toLowerCase());
      if (m.length) mais.push(`${t.nome} (${m.join(', ')})`);
      if (n.length) menos.push(`${t.nome} (${n.join(', ')})`);
    }
    return { mais, menos };
  }

  async function salvar() {
    const u = usuario();
    if (!u || !alterado()) return;
    const { mais, menos } = resumoMudancas(u);
    const lista = (t, l) => (l.length ? `<p style="margin:10px 0 0"><b>${t}</b></p><ul class="ac-ul">${l.map((x) => `<li>${H(x)}</li>`).join('')}</ul>` : '');
    const ok = await confirmar(`${lista('Libera', mais)}${lista('Tira', menos)}<p class="small muted" style="margin:12px 0 0">Se ${H(u.nome)} estiver com o painel aberto, o menu muda na hora.</p>`,
      { titulo: `Salvar o acesso de ${u.nome}?`, ok: 'Salvar', html: true });
    if (!ok) return;
    const corpo = {};
    for (const t of dados.telas) corpo[t.id] = [...rascunho[t.id]];
    await enviar(u, { acessos: corpo }, `Acesso de ${u.nome} salvo.`);
  }

  async function voltarAoPadrao() {
    const u = usuario();
    if (!u) return;
    const ok = await confirmar(`O acesso de ${u.nome} volta a ser o padrão do perfil ${NOMES_PERFIL[u.perfil]}. As personalizações são descartadas.`,
      { titulo: 'Voltar ao padrão do perfil', ok: 'Voltar ao padrão' });
    if (!ok) return;
    await enviar(u, { acessos: null }, `${u.nome} voltou ao padrão do perfil.`);
  }

  async function enviar(u, corpo, msg) {
    const b = $('#ac-salvar');
    if (b) b.disabled = true;
    try {
      await api(`/api/acessos/${u.id}`, { metodo: 'PUT', corpo });
      toast(msg, 'ok');
      rascunho = null;
      await carregar();
    } catch (e) {
      toast(e.message, 'err');
      atualizarBotoes();
    }
  }

  /** O que a pessoa pode fazer naquele menu, em uma linha (a descrição de cada ação aparece ao passar o mouse). */
  function descricao(t) {
    return t.acoes.ver;
  }

  return { id: 'acesso', titulo: 'Controle de acesso', sub: 'Menus e ações liberados para cada usuário', render, sair };
})();
