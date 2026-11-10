'use strict';
/* FrotaGest — Usuários online: quem está com o painel aberto agora, em qual tela, de qual aparelho,
 * e o botão para encerrar uma sessão (só aquele aparelho). Reis Tecnologia */

PAGINAS.online = (() => {
  let timer = null;
  let dados = null;
  let seq = 0;

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <div class="kpis" id="on-kpis">${[0, 1, 2, 3].map(() => '<div class="kpi"><div class="kpi-body"><div class="kpi-label">&nbsp;</div><div class="kpi-value">—</div></div></div>').join('')}</div>
        <section class="card">
          <div class="card-head"><h2>${ico('users-group')} Conectados agora</h2>
            <div class="card-actions"><span class="count" id="on-n"></span><button class="btn btn-sm" type="button" id="on-atualizar">${ico('refresh', 'i-sm')} Atualizar</button></div></div>
          <div class="table-wrap flat" id="on-tabela"><p class="hint">Carregando…</p></div>
          <p class="hint" style="padding:12px 18px 16px">Encerrar desconecta só aquele aparelho: a pessoa precisa entrar de novo com a senha. Para bloquear o acesso de vez, desative o usuário em Cadastros › Usuários. Atualiza sozinho a cada 15 segundos.</p>
        </section>
      </div>`;
    $('#on-atualizar').addEventListener('click', carregar);
    $('#on-tabela').addEventListener('click', (e) => {
      const b = e.target.closest('[data-encerrar]');
      if (b) encerrar(b.dataset.encerrar);
    });
    carregar();
    timer = setInterval(carregar, 15000);
  }

  function sair() {
    clearInterval(timer);
    timer = null;
    seq++;
  }

  async function carregar() {
    const meu = ++seq;
    try {
      const r = await api(`/api/online${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`);
      if (meu !== seq || !$('#on-tabela')) return;
      dados = r;
      desenhar();
    } catch (e) {
      if (meu === seq && $('#on-tabela')) $('#on-tabela').innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  function ocioso(seg) {
    if (seg < 90) return '<span class="tag ok">usando agora</span>';
    const m = Math.round(seg / 60);
    return `<span class="muted">parado há ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${p2(m % 60)} min`}</span>`;
  }

  function desenhar() {
    const { resumo, sessoes } = dados;
    const k = (cls, icone, rot, val, sub) => `<div class="kpi ${cls}"><div class="kpi-ico">${ico(icone)}</div><div class="kpi-body"><div class="kpi-label">${H(rot)}</div><div class="kpi-value">${fmtNum(val)}</div><div class="kpi-sub">${H(sub)}</div></div></div>`;
    $('#on-kpis').innerHTML = [
      k('ok', 'users-group', 'Usuários conectados', resumo.usuarios, 'pessoas com o painel aberto'),
      k('neutral', 'device-desktop', 'Sessões', resumo.sessoes, 'aparelhos ou navegadores'),
      k('', 'user-check', 'Usando agora', resumo.ativos, 'mexeram nos últimos 10 min'),
      k('neutral', 'device-tv', 'Modo TV', resumo.tv, 'telas da central'),
    ].join('');
    $('#on-n').textContent = `${sessoes.length} sess${sessoes.length === 1 ? 'ão' : 'ões'}`;
    const master = S.eu.perfil === 'master';
    $('#on-tabela').innerHTML = tabela([
      { t: 'Usuário', v: (s) => `<b>${H(s.nome)}</b>${s.voce ? ' <span class="tag ok">você</span>' : ''}<span class="sub">${H(s.email)}</span>` },
      { t: 'Perfil', v: (s) => `${H(NOMES_PERFIL[s.perfil] || s.perfilNome)}${master && s.empresa ? `<span class="sub">${H(s.empresa)}</span>` : ''}` },
      { t: 'Aparelho', v: (s) => `<span class="on-nav">${ico(s.tv ? 'device-tv' : s.celular ? 'device-mobile' : 'device-desktop', 'i-sm')} ${H(s.navegador)}</span><span class="sub mono">${H(s.ip)}</span>` },
      { t: 'Entrou', v: (s) => `${H(fmtCurto(s.entrouEm))}<span class="sub">conectado ${H(atras(s.conectadoDesde))}</span>` },
      { t: 'Tela', v: (s) => `<div class="chips">${s.abas.map((a) => `<span class="chip${a === 'Modo TV' ? ' warn' : ''}">${H(a)}</span>`).join('')}</div>${s.abas.length > 1 ? `<span class="sub">${s.abas.length} abas abertas</span>` : ''}` },
      { t: 'Atividade', v: (s) => ocioso(s.ociosoSeg) },
      { t: '', cls: 'num', v: (s) => (s.voce || !podeTela('online', 'alterar') ? '' : `<button class="btn btn-sm btn-ghost on-encerrar" type="button" data-encerrar="${H(s.conexao)}" title="Desconectar este aparelho">${ico('logout', 'i-sm')} Encerrar</button>`) },
    ], sessoes, { vazio: 'Ninguém conectado agora.' });
  }

  async function encerrar(conexao) {
    const s = dados && dados.sessoes.find((x) => x.conexao === conexao);
    if (!s) return;
    const ok = await confirmar(`Encerrar a sessão de ${s.nome} (${s.navegador})? O painel dele(a) fecha agora e será preciso entrar de novo com a senha.`, { titulo: 'Encerrar sessão', ok: 'Encerrar sessão', perigo: true });
    if (!ok) return;
    try {
      await api('/api/online/encerrar', { corpo: { conexao } });
      toast(`Sessão de ${s.nome} encerrada.`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
    setTimeout(carregar, 500);
  }

  return { id: 'online', titulo: 'Usuários online', sub: 'Quem está usando o FrotaGest agora, e onde', render, sair };
})();
