'use strict';
/* FrotaGest — Guia do FrotaGest (mesmo modelo da Central de ajuda do EduGest).
 *  · Manual: para que serve cada menu e tela, passo a passo e perguntas frequentes, com busca,
 *    "Comece por aqui" do perfil e o que a pessoa já leu (fica no servidor: vale em qualquer aparelho).
 *  · Ajuda da tela atual (botão ? do topo) e "Mostrar na tela" (tour só daquela tela).
 *  · Tour guiado por todas as telas que a pessoa abre; boas-vindas no primeiro acesso.
 *  · Implantação da empresa (administrador e master): o que já foi configurado, também no Dashboard.
 *  · Manual em PDF pela impressão do navegador.
 * O conteúdo fica em guia-conteudo.js (GUIA). Reis Tecnologia */

const NOMES_PERFIL_GUIA = { master: 'Master', admin: 'Administrador', operador: 'Operador', visualizador: 'Visualizador' };
let marcasGuia = null; // { 'artigo:x': data, ... } da pessoa logada
let marcasGuiaDe = null;

const semAcentoGuia = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtGuia = (s) => H(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\{\{(.+?)\}\}/g, '<span class="gu-botao">$1</span>')
  .replace(/`(.+?)`/g, '<code>$1</code>');

async function carregarMarcasGuia() {
  if (marcasGuia && marcasGuiaDe === (S.eu && S.eu.id)) return marcasGuia;
  try { marcasGuia = (await api('/api/eu/ajuda')).marcados || {}; } catch { marcasGuia = marcasGuia || {}; }
  marcasGuiaDe = S.eu && S.eu.id;
  atualizarEntradaGuia();
  return marcasGuia;
}
function marcarGuia(chave, feito = true) {
  if (!marcasGuia) marcasGuia = {};
  if (feito) { if (marcasGuia[chave]) return; marcasGuia[chave] = textoServidor(); } else delete marcasGuia[chave];
  atualizarEntradaGuia();
  api('/api/eu/ajuda', { metodo: 'PUT', corpo: { chave, feito } }).catch(() => { /* é só o progresso: tenta de novo na próxima */ });
}
const lidoGuia = (id) => Boolean(marcasGuia && marcasGuia[`artigo:${id}`]);

/** Selo "Novo" na entrada do menu até a pessoa abrir o guia ou fazer o tour. */
function atualizarEntradaGuia() {
  const novo = $('#sb-guia-novo');
  if (!novo) return;
  novo.hidden = !marcasGuia || Boolean(marcasGuia['tour:geral'] || marcasGuia['pref:guia-visto']);
  const sub = $('#sb-guia-sub');
  if (sub && marcasGuia && S.eu) {
    const meus = GUIA.artigos.filter(artigoDoPerfil);
    const lidos = meus.filter((a) => lidoGuia(a.id)).length;
    sub.textContent = lidos ? `${lidos} de ${meus.length} artigos lidos` : 'Tour e manual das telas';
  }
}

/** O artigo é do perfil da pessoa e de uma tela que ela abre? */
function artigoDoPerfil(a) {
  if (!S.eu) return false;
  if (a.perfis && !a.perfis.includes(S.eu.perfil)) return false;
  if (a.tela && !paginaPermitida(a.tela)) return false;
  return true;
}

/* ---------------- tours ---------------- */

function passosDaTela(id, soGeral) {
  const t = GUIA.tours[id];
  if (!t) return [];
  const serve = (p) => !p.perfis || p.perfis.includes(S.eu.perfil);
  return t.filter((p) => (!soGeral || p.g) && serve(p)).map((p) => ({ pagina: id, ...p }));
}
function tourGeral() {
  const serve = (p) => !p.perfis || p.perfis.includes(S.eu.perfil);
  const meio = GUIA.ordem.filter(paginaPermitida).flatMap((id) => passosDaTela(id, true));
  return [...GUIA.tourInicio.filter(serve), ...meio, ...GUIA.tourFim];
}
function iniciarTourGeral() {
  const volta = (location.hash.replace(/^#\/?/, '').split('?')[0]) || telaInicial();
  TOUR.iniciar(tourGeral(), {
    id: 'geral',
    aoTerminar(concluiu) {
      if (concluiu) {
        marcarGuia('tour:geral');
        toast('Tour concluído! O Guia do FrotaGest fica no menu e no botão ? do topo.', 'ok');
      } else toast('Você pode refazer o tour quando quiser pelo Guia do FrotaGest.', '');
      if (volta === 'guia') navegar('guia');
    },
  });
}
function tourDaTela(id) {
  const passos = passosDaTela(id, false);
  if (!passos.length) return;
  TOUR.iniciar(passos, { id, aoTerminar: (ok) => { if (ok) marcarGuia(`tour:${id}`); } });
}

/* ---------------- primeiro acesso ---------------- */

let boasVindasDe = null; // para quem a janela já abriu nesta página
/** Depois de entrar: convite para o tour, uma vez por pessoa (vale em qualquer aparelho). */
async function guiaBoasVindas() {
  // navegador controlado por automação (testes, robôs de monitoramento): sem janela de boas-vindas
  if (!S.eu || boasVindasDe === S.eu.id || navigator.webdriver) return;
  await carregarMarcasGuia();
  if (!S.eu || marcasGuia['boas-vindas'] || TOUR.ativo || $('#shell').hidden) return;
  if ($('.modal-back') || (S.paginaAtual && S.paginaAtual.id === 'tv')) return; // outra janela aberta ou Modo TV: fica para o próximo acesso
  boasVindasDe = S.eu.id;
  marcarGuia('boas-vindas');
  const nome = String(S.eu.nome || '').split(' ')[0];
  const passos = tourGeral().length;
  const adm = S.eu.perfil === 'admin' || S.eu.perfil === 'master';
  const j = janela({
    titulo: 'Boas-vindas',
    tamanho: 'sm',
    corpo: `<div class="gu-boas">
      <div class="gu-boas-marca">${ico('bus')}</div>
      <h3>Bem-vindo(a) ao FrotaGest${nome ? `, ${H(nome)}` : ''}!</h3>
      <p>Vamos mostrar onde fica cada coisa. São poucos minutos e você pode sair a qualquer momento.</p>
      <ul class="gu-boas-lista">
        <li>${ico('route')}<span><strong>Tour guiado</strong>: passa pelas telas que você usa e mostra os botões principais (${passos} passos).</span></li>
        <li>${ico('lifebuoy')}<span><strong>Guia do FrotaGest</strong>: o manual de cada menu e tela, com passo a passo e perguntas frequentes. Fica em destaque no menu e no botão <span class="gu-botao">?</span> do topo.</span></li>
        ${adm ? `<li>${ico('checklist')}<span><strong>Implantação</strong>: a lista do que cadastrar, na ordem certa, aparece no Dashboard até tudo ficar pronto.</span></li>` : ''}
      </ul></div>`,
    rodape: `<button class="btn" type="button" data-fechar>Agora não</button><button class="btn btn-primary" type="button" data-comecar>${ico('route', 'i-sm')} Começar o tour</button>`,
    aoFechar: () => { if (!TOUR.ativo) toast('O tour e o manual ficam no Guia do FrotaGest, no menu.', ''); },
  });
  j.el.querySelector('[data-comecar]').addEventListener('click', () => { j.fechar(); iniciarTourGeral(); });
}

/* ---------------- implantação da empresa ---------------- */

async function carregarImplantacao() {
  if (!S.eu || (S.eu.perfil !== 'admin' && S.eu.perfil !== 'master')) return null;
  if (S.eu.perfil === 'master' && !S.empresa) return { escolher: true };
  try { return await api(`/api/guia/implantacao?${qs({ empresa: S.empresa })}`); } catch { return null; }
}
function htmlImplantacao(r, completo) {
  if (!r) return '';
  if (r.escolher) return `<div class="card-head"><h2>${ico('checklist')} Implantação da empresa</h2></div><div class="card-body"><p class="hint" style="margin:0">Escolha a empresa no topo da tela para ver o que já foi configurado nela.</p></div>`;
  const itens = GUIA.implantacao.map((x) => ({ ...x, feito: Boolean(r.itens[x.id]), n: r.contagens[x.id] || 0 }));
  const pct = Math.round((r.feitos / r.total) * 100);
  const linha = (x) => `<li class="${x.feito ? 'feito' : ''}">
      ${ico(x.feito ? 'circle-check' : 'circle-dashed', 'gu-impl-ico')}
      <span><strong>${H(x.titulo)}</strong><small>${x.feito && x.conta ? `${fmtNum(x.n)} ${H(x.conta)}` : H(x.texto)}</small></span>
      <span class="gu-impl-acoes">
        ${x.artigo ? `<button class="link" type="button" data-gu-artigo="${x.artigo}">Como fazer</button>` : ''}
        ${!x.feito && x.pagina && paginaPermitida(x.pagina) ? `<button class="btn btn-sm" type="button" data-gu-ir="${x.pagina}">Abrir</button>` : ''}
      </span></li>`;
  const pend = itens.filter((x) => !x.feito);
  const fases = [...new Set(itens.map((x) => x.fase))];
  return `<div class="card-head"><h2>${ico('checklist')} Implantação ${r.empresa && r.empresa.nome ? `· ${H(r.empresa.nome)}` : 'da empresa'}</h2>
      <div class="card-head-dir">${completo ? '' : '<button class="link" type="button" data-gu-ocultar title="Esconder do Dashboard (continua no Guia do FrotaGest)">Ocultar</button>'}<span class="gu-impl-num">${r.feitos} de ${r.total}</span></div></div>
    <div class="card-body">
      <div class="gu-barra grande"><span style="width:${pct}%"></span></div>
      ${completo ? fases.map((f) => `<div class="gu-fase">${H(f)}</div><ul class="gu-impl">${itens.filter((x) => x.fase === f).map(linha).join('')}</ul>`).join('')
    : `<p class="small muted" style="margin:10px 0 4px">${pend.length ? 'Próximos passos para a empresa começar a usar o FrotaGest:' : 'Tudo configurado.'}</p>
        <ul class="gu-impl">${pend.slice(0, 4).map(linha).join('')}</ul>
        <button class="link" type="button" data-gu-cat="implantacao">Ver a lista completa e o passo a passo ${ico('chevron-right', 'i-sm')}</button>`}
    </div>`;
}
/** Cartão do Dashboard (administrador e master com a empresa escolhida): some quando tudo estiver feito ou se a pessoa ocultar. */
async function guiaCartaoImplantacao(box) {
  if (!box) return;
  await carregarMarcasGuia();
  if (marcasGuia['pref:implantacao-oculta']) { box.hidden = true; return; }
  const r = await carregarImplantacao();
  if (!box.isConnected) return;
  if (!r || r.escolher || r.feitos === r.total) { box.hidden = true; return; }
  box.innerHTML = htmlImplantacao(r, false);
  box.hidden = false;
}

/* ---------------- manual em PDF (impressão do navegador) ---------------- */

function imprimirManual(todos) {
  const lista = GUIA.artigos.filter((a) => todos || artigoDoPerfil(a));
  const cats = GUIA.categorias.map((c) => ({ c, itens: lista.filter((a) => a.cat === c.id) })).filter((x) => x.itens.length);
  const empresa = S.eu.empresaNome || '';
  const quem = todos ? 'todos os perfis' : `perfil ${(NOMES_PERFIL_GUIA[S.eu.perfil] || S.eu.perfil).toLowerCase()}`;
  let box = $('#manual-impressao');
  if (!box) { box = document.createElement('div'); box.id = 'manual-impressao'; document.body.appendChild(box); }
  box.innerHTML = `<div class="mi-capa">
      <div class="mi-marca"><span class="mi-logo">${ico('bus')}</span><strong>FrotaGest</strong></div>
      <h1>Manual do sistema</h1>
      <p>${H(empresa)}${empresa ? '<br>' : ''}${H(quem)} · versão ${H((S.config && S.config.versao) || '')} · ${H(fmtDataHora(textoServidor()).slice(0, 10))}</p>
      <div class="mi-indice"><h3>Conteúdo</h3><ol>${cats.map(({ c, itens }) => `<li><strong>${H(c.titulo)}</strong><ul>${itens.map((a) => `<li>${H(a.titulo)}</li>`).join('')}</ul></li>`).join('')}</ol></div>
      <p class="mi-rodape">Reis Tecnologia · frotagest.reisconsultoriatec.com</p>
    </div>
    ${cats.map(({ c, itens }) => `<section class="mi-cat"><h2>${H(c.titulo)}</h2><p class="mi-desc">${H(c.desc)}</p>
      ${itens.map((a) => `<div class="mi-artigo"><h3>${H(a.titulo)}</h3><p class="gu-resumo">${fmtGuia(a.resumo)}</p>${corpoArtigo(a)}</div>`).join('')}</section>`).join('')}`;
  document.body.classList.add('imprimindo-manual');
  const limpar = () => { document.body.classList.remove('imprimindo-manual'); box.innerHTML = ''; window.removeEventListener('afterprint', limpar); };
  window.addEventListener('afterprint', limpar);
  setTimeout(() => { window.print(); setTimeout(limpar, 1500); }, 60);
}

/* ---------------- desenho dos artigos ---------------- */

function blocoGuia([tipo, conteudo]) {
  if (tipo === 'p') return `<p>${fmtGuia(conteudo)}</p>`;
  if (tipo === 'h') return `<h4>${fmtGuia(conteudo)}</h4>`;
  if (tipo === 'passos') return `<ol class="gu-passos">${conteudo.map((x) => `<li>${fmtGuia(x)}</li>`).join('')}</ol>`;
  if (tipo === 'lista') return `<ul class="gu-lista">${conteudo.map((x) => `<li>${fmtGuia(x)}</li>`).join('')}</ul>`;
  if (tipo === 'dica') return `<div class="gu-nota gu-n-dica">${ico('bulb')}<div>${fmtGuia(conteudo)}</div></div>`;
  if (tipo === 'atencao') return `<div class="gu-nota gu-n-atencao">${ico('alert-triangle')}<div>${fmtGuia(conteudo)}</div></div>`;
  if (tipo === 'onde') return `<div class="gu-onde">${ico('map-pin', 'i-sm')} <span>Onde fica: <strong>${fmtGuia(conteudo)}</strong></span></div>`;
  if (tipo === 'tabela') {
    const [cab, ...linhas] = conteudo;
    return `<div class="gu-tabela-wrap"><table class="tbl gu-tabela"><thead><tr>${cab.map((c) => `<th>${fmtGuia(c)}</th>`).join('')}</tr></thead>
      <tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${fmtGuia(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  return '';
}
const corpoArtigo = (a) => a.corpo.map(blocoGuia).join('');

/* ---------------- a tela ---------------- */

PAGINAS.guia = (() => {
  const est = { busca: '', todos: false };
  let params = {};
  let raiz = null;
  let espera = null;

  const artigos = () => GUIA.artigos.filter((a) => est.todos || artigoDoPerfil(a));
  const artigo = (id) => GUIA.artigos.find((a) => a.id === id);
  const categoria = (id) => GUIA.categorias.find((c) => c.id === id);
  const ehAdm = () => S.eu && (S.eu.perfil === 'admin' || S.eu.perfil === 'master');
  const ir = (p) => navegar('guia', qs(p));

  function buscar(termo) {
    const palavras = semAcentoGuia(termo).split(/\s+/).filter((p) => p.length > 1);
    if (!palavras.length) return [];
    return artigos().map((a) => {
      const titulo = semAcentoGuia(a.titulo);
      const extra = semAcentoGuia(`${(a.palavras || []).join(' ')} ${a.resumo}`);
      const corpo = semAcentoGuia(JSON.stringify(a.corpo));
      let pontos = 0;
      for (const p of palavras) {
        const n = (titulo.includes(p) ? 6 : 0) + (extra.includes(p) ? 3 : 0) + (corpo.includes(p) ? 1 : 0);
        if (!n) return null; // todas as palavras precisam aparecer
        pontos += n;
      }
      return { a, pontos };
    }).filter(Boolean).sort((x, y) => y.pontos - x.pontos).map((x) => x.a);
  }

  function itemLista(a) {
    const c = categoria(a.cat);
    return `<button class="gu-item" type="button" data-gu-artigo="${a.id}">
      ${ico(lidoGuia(a.id) ? 'circle-check' : (c ? c.icone : 'file-text'), lidoGuia(a.id) ? 'gu-lido' : '')}
      <span><strong>${H(a.titulo)}</strong><small>${H(a.resumo)}</small></span>${ico('chevron-right', 'gu-seta')}</button>`;
  }

  function cabecalho() {
    const meus = GUIA.artigos.filter(artigoDoPerfil);
    const lidos = meus.filter((a) => lidoGuia(a.id)).length;
    const pct = meus.length ? Math.round((lidos / meus.length) * 100) : 0;
    return `<section class="card gu-cab">
      <div class="gu-cab-linha">
        <div class="gu-cab-ico">${ico('lifebuoy')}</div>
        <div class="gu-cab-txt"><h2>Guia do FrotaGest</h2>
          <p>O manual do sistema: para que serve cada menu e tela, passo a passo e as dúvidas mais comuns.</p></div>
        <div class="gu-cab-acoes">
          <button class="btn btn-primary" type="button" data-gu="tour">${ico('route', 'i-sm')} Fazer o tour guiado</button>
          <button class="btn" type="button" data-gu="manual">${ico('printer', 'i-sm')} Manual em PDF</button>
        </div>
      </div>
      <label class="search gu-busca">${ico('search', 'i-sm')}<input type="search" id="gu-busca" placeholder="O que você quer fazer? Ex.: tratar alerta, baixar vídeo, desenhar garagem" value="${H(est.busca)}" aria-label="Buscar no guia" autocomplete="off"></label>
      <div class="gu-progresso" id="gu-progresso">
        <div class="gu-barra"><span style="width:${pct}%"></span></div>
        <span>Você leu <strong>${lidos} de ${meus.length}</strong> artigos do seu perfil</span>
        <label class="check gu-todos"><input type="checkbox" id="gu-todos" ${est.todos ? 'checked' : ''}> Mostrar também os de outros perfis e telas</label>
      </div>
    </section>`;
  }

  /** Cada menu que a pessoa vê, com para que serve cada tela (o "mapa" do sistema). */
  function menusETelas() {
    const resumoDe = (id) => { const a = artigo(`tela-${id}`); return a ? a.resumo : (PAGINAS[id] && typeof PAGINAS[id].sub === 'string' ? PAGINAS[id].sub : ''); };
    const blocos = [{ grupo: 'Dashboard', ico: NAV_TOPO.ico, itens: [NAV_TOPO] }, ...NAV]
      .map((g) => ({ ...g, itens: g.itens.filter((it) => est.todos || podeVer(it)) }))
      .filter((g) => g.itens.length);
    return `<section class="card gu-telas">
      <div class="card-head"><h2>${ico('layout-list')} Menus e telas</h2><span class="small muted">Para que serve cada tela do seu menu. Clique para ler o artigo.</span></div>
      <div class="card-body gu-telas-grade">${blocos.map((g) => `<div class="gu-menu">
        <div class="gu-menu-tit">${ico(g.ico, 'i-sm')} ${H(g.grupo)}</div>
        ${g.itens.map((it) => `<button class="gu-tela" type="button" data-gu-artigo="tela-${it.id}" ${artigo(`tela-${it.id}`) ? '' : 'disabled'}>
          <span class="gu-tela-ico">${ico(it.ico, 'i-sm')}</span><span><b>${H(it.nome)}</b><small>${H(resumoDe(it.id))}</small></span>
          ${lidoGuia(`tela-${it.id}`) ? ico('circle-check', 'gu-lido') : ''}</button>`).join('')}
      </div>`).join('')}</div>
    </section>`;
  }

  function telaInicio() {
    const trilha = (GUIA.trilhas[S.eu.perfil] || []).map(artigo).filter((a) => a && (est.todos || artigoDoPerfil(a)));
    const tela = params.tela && params.tela !== 'guia' ? params.tela : '';
    const daTela = tela ? artigos().filter((a) => a.tela === tela) : [];
    const temTour = tela && GUIA.tours[tela] && paginaPermitida(tela);
    const cats = GUIA.categorias.map((c) => ({ c, lista: artigos().filter((a) => a.cat === c.id) })).filter((x) => x.lista.length);
    return `
      ${tela && (daTela.length || temTour) ? `<section class="card gu-contexto">
        <div class="card-head"><h2>${ico('help')} Ajuda desta tela: ${H(nomeDaTela(tela))}</h2>
          <div class="card-head-dir">${paginaPermitida(tela) ? `<button class="btn btn-sm" type="button" data-gu-ir="${tela}">${ico('external-link', 'i-sm')} Voltar para a tela</button>` : ''}
          ${temTour ? `<button class="btn btn-primary btn-sm" type="button" data-gu-tour-tela="${tela}">${ico('route', 'i-sm')} Mostrar na tela</button>` : ''}</div></div>
        <div class="card-body gu-itens">${daTela.map(itemLista).join('') || '<p class="hint" style="margin:0">Use "Mostrar na tela" para ver os elementos desta tela.</p>'}</div>
      </section>` : ''}
      ${ehAdm() ? '<section class="card gu-impl-card" id="gu-impl" hidden></section>' : ''}
      ${trilha.length ? `<section class="card">
        <div class="card-head"><h2>${ico('flag')} Comece por aqui</h2><span class="small muted">${trilha.filter((a) => lidoGuia(a.id)).length} de ${trilha.length} lidos</span></div>
        <div class="card-body"><p class="small muted" style="margin:0 0 10px">O essencial para o seu dia a dia, na ordem em que costuma ser usado. Ideal para quem está começando.</p>
        <div class="gu-itens">${trilha.map(itemLista).join('')}</div></div>
      </section>` : ''}
      ${menusETelas()}
      <div class="gu-cats">${cats.map(({ c, lista }) => {
        const l = lista.filter((a) => lidoGuia(a.id)).length;
        return `<button class="gu-cat" type="button" data-gu-cat="${c.id}">
          <span class="gu-cat-ico">${ico(c.icone)}</span>
          <strong>${H(c.titulo)}</strong><small>${H(c.desc)}</small>
          <span class="gu-cat-rodape">${lista.length} artigo${lista.length === 1 ? '' : 's'}${l ? ` · ${l} lido${l === 1 ? '' : 's'}` : ''}</span></button>`;
      }).join('')}</div>`;
  }

  function telaCategoria() {
    const c = categoria(params.cat);
    if (!c) return telaInicio();
    const lista = artigos().filter((a) => a.cat === c.id);
    return `<section class="card">
      <div class="card-body">
        <button class="link gu-voltar" type="button" data-gu-inicio>${ico('arrow-left', 'i-sm')} Guia do FrotaGest</button>
        <h2 class="gu-cat-tit">${ico(c.icone)} ${H(c.titulo)}</h2>
        <p class="small muted">${H(c.desc)}</p>
        ${c.id === 'implantacao' && ehAdm() ? '<div class="gu-impl-dentro" id="gu-impl" data-completo hidden></div>' : ''}
        <div class="gu-itens">${lista.map(itemLista).join('') || '<p class="hint">Nenhum artigo para o seu perfil neste assunto.</p>'}</div>
      </div></section>`;
  }

  function telaBusca() {
    const r = buscar(est.busca);
    return `<section class="card">
      <div class="card-head"><h2>${ico('search')} ${r.length} resultado${r.length === 1 ? '' : 's'} para "${H(est.busca)}"</h2>
        <button class="link" type="button" data-gu-limpar>Limpar a busca</button></div>
      <div class="card-body gu-itens">${r.map(itemLista).join('') || `<p class="hint" style="margin:0">Nada encontrado. Tente outras palavras${est.todos ? '' : ' ou marque "Mostrar também os de outros perfis e telas"'}.</p>`}</div>
    </section>`;
  }

  function telaArtigo() {
    const a = artigo(params.artigo);
    if (!a) return telaInicio();
    const c = categoria(a.cat);
    const podeIr = a.tela && paginaPermitida(a.tela) && a.tela !== 'guia';
    const temTour = podeIr && GUIA.tours[a.tela];
    const rel = (a.relacionados || []).map(artigo).filter((x) => x && (est.todos || artigoDoPerfil(x)));
    const mesmos = artigos().filter((x) => x.cat === a.cat);
    const pos = mesmos.indexOf(a);
    const prox = pos >= 0 ? mesmos[pos + 1] : null;
    return `<article class="card gu-artigo">
      <div class="card-body">
        <nav class="gu-trilha"><button class="link" type="button" data-gu-inicio>Guia do FrotaGest</button> ›
          <button class="link" type="button" data-gu-cat="${a.cat}">${H(c ? c.titulo : '')}</button></nav>
        <h2>${H(a.titulo)}</h2>
        <p class="gu-resumo">${fmtGuia(a.resumo)}</p>
        ${a.perfis ? `<div class="gu-perfis">Para: ${a.perfis.map((p) => `<span class="tag off">${H(NOMES_PERFIL_GUIA[p] || p)}</span>`).join(' ')}</div>` : ''}
        ${a.tela ? `<div class="gu-onde">${ico('map-pin', 'i-sm')} <span>Onde fica: <strong>${H(ondeFica(a.tela))}</strong></span></div>` : ''}
        ${podeIr || temTour ? `<div class="gu-acoes-artigo">
          ${podeIr ? `<button class="btn btn-sm" type="button" data-gu-ir="${a.tela}">${ico('external-link', 'i-sm')} Abrir ${H(nomeDaTela(a.tela))}</button>` : ''}
          ${temTour ? `<button class="btn btn-sm" type="button" data-gu-tour-tela="${a.tela}">${ico('route', 'i-sm')} Mostrar na tela</button>` : ''}
        </div>` : ''}
        <div class="gu-corpo">${corpoArtigo(a)}</div>
        ${rel.length ? `<div class="gu-rel"><div class="gu-fase">Veja também</div><div class="gu-itens">${rel.map(itemLista).join('')}</div></div>` : ''}
        <div class="gu-artigo-rodape">
          <span class="small muted">${ico('circle-check', 'i-sm gu-lido')} Marcado como lido</span>
          ${prox ? `<button class="btn btn-sm" type="button" data-gu-artigo="${prox.id}">Próximo: ${H(prox.titulo)} ${ico('arrow-right', 'i-sm')}</button>` : ''}
        </div>
      </div></article>`;
  }

  /** "Operação › Alertas": o caminho no menu. */
  function ondeFica(tela) {
    if (tela === NAV_TOPO.id) return 'Dashboard, no alto do menu';
    const g = NAV.find((x) => x.itens.some((i) => i.id === tela));
    const it = g ? g.itens.find((i) => i.id === tela) : null;
    return g ? `${g.grupo} › ${it.nome}` : nomeDaTela(tela);
  }

  function desenharCorpo() {
    if (!raiz || !raiz.isConnected) return;
    const corpo = est.busca.trim().length >= 2 ? telaBusca() : params.artigo ? telaArtigo() : params.cat ? telaCategoria() : telaInicio();
    $('#gu-corpo').innerHTML = corpo;
    const impl = $('#gu-impl');
    if (impl) {
      carregarImplantacao().then((r) => {
        if (!impl.isConnected || !r) return;
        if (r.escolher && !impl.hasAttribute('data-completo')) return; // master sem empresa escolhida: só na página da implantação
        impl.innerHTML = htmlImplantacao(r, impl.hasAttribute('data-completo'));
        impl.hidden = false;
      });
    }
  }

  function render(c, p) {
    params = p || {};
    raiz = c;
    est.busca = ''; // a busca é só desta visita à tela
    c.innerHTML = `<div class="page gu">${'<div id="gu-cab"></div>'}<div id="gu-corpo"><p class="hint">Carregando…</p></div></div>`;
    carregarMarcasGuia().then(() => {
      if (!raiz || !raiz.isConnected) return;
      marcarGuia('pref:guia-visto');
      if (params.artigo && artigo(params.artigo)) marcarGuia(`artigo:${params.artigo}`);
      $('#gu-cab').innerHTML = cabecalho();
      desenharCorpo();
    });
    c.onclick = clique;
    c.onchange = (ev) => {
      if (ev.target.id === 'gu-todos') { est.todos = ev.target.checked; $('#gu-cab').innerHTML = cabecalho(); desenharCorpo(); }
    };
    c.oninput = (ev) => {
      if (ev.target.id !== 'gu-busca') return;
      clearTimeout(espera);
      espera = setTimeout(() => { est.busca = ev.target.value; desenharCorpo(); }, 200);
    };
  }

  function clique(ev) {
    const t = ev.target;
    const art = t.closest('[data-gu-artigo]');
    if (art && !art.disabled) { ir({ artigo: art.dataset.guArtigo }); return; }
    const cat = t.closest('[data-gu-cat]');
    if (cat) { est.busca = ''; ir({ cat: cat.dataset.guCat }); return; }
    if (t.closest('[data-gu-inicio]')) { est.busca = ''; ir({}); return; }
    if (t.closest('[data-gu-limpar]')) { est.busca = ''; $('#gu-busca').value = ''; desenharCorpo(); return; }
    const vai = t.closest('[data-gu-ir]');
    if (vai) { navegar(vai.dataset.guIr); return; }
    const tt = t.closest('[data-gu-tour-tela]');
    if (tt) { tourDaTela(tt.dataset.guTourTela); return; }
    const b = t.closest('[data-gu]');
    if (!b) return;
    if (b.dataset.gu === 'tour') iniciarTourGeral();
    else if (b.dataset.gu === 'manual') imprimirManual(est.todos);
  }

  function sair() {
    clearTimeout(espera);
    if (raiz) { raiz.onclick = null; raiz.onchange = null; raiz.oninput = null; } // o #conteudo é o mesmo para todas as telas
    raiz = null;
  }

  return { id: 'guia', titulo: 'Guia do FrotaGest', sub: 'Tour guiado e o manual de cada menu e tela do sistema', render, sair };
})();

/* Botões fora da tela do guia: o ? do topo e o cartão de implantação do Dashboard */
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!t.closest || t.closest('.gu')) return; // dentro do guia, quem trata é a própria tela
  if (t.closest('#tb-ajuda')) {
    const tela = (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';
    navegar('guia', tela && tela !== 'guia' ? qs({ tela }) : '');
    return;
  }
  const impl = t.closest('#ini-impl');
  if (!impl) return;
  const art = t.closest('[data-gu-artigo]');
  if (art) { navegar('guia', qs({ artigo: art.dataset.guArtigo })); return; }
  const vai = t.closest('[data-gu-ir]');
  if (vai) { navegar(vai.dataset.guIr); return; }
  if (t.closest('[data-gu-cat]')) { navegar('guia', qs({ cat: 'implantacao' })); return; }
  if (t.closest('[data-gu-ocultar]')) {
    marcarGuia('pref:implantacao-oculta');
    impl.hidden = true;
    toast('Lista de implantação oculta. Ela continua no Guia do FrotaGest › Implantação da empresa.', '');
  }
});
