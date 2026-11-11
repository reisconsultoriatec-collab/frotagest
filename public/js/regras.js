'use strict';
/* FrotaGest — Regras de alerta: limite de velocidade (por empresa, grupo, veículo ou dentro de uma cerca),
 * uso fora do horário, parada longa fora da garagem e motor ligado parado. O servidor confere as
 * regras ao vivo e abre o alerta; aqui a empresa decide o que quer acompanhar. Reis Tecnologia */

const TIPOS_REGRA = {
  velocidade: {
    nome: 'Excesso de velocidade', ico: 'gauge',
    desc: 'Avisa quando o veículo passa do limite por mais tempo que a tolerância. Dentro de uma cerca (garagem, pátio, escola) pode valer um limite menor.',
  },
  fora_horario: {
    nome: 'Uso fora do horário', ico: 'clock-exclamation',
    desc: 'Avisa quando o veículo é ligado ou anda fora dos dias e do horário permitidos.',
  },
  parada: {
    nome: 'Parada longa', ico: 'parking',
    desc: 'Avisa quando o veículo fica parado muito tempo fora da garagem, ligado ou desligado (ex.: dormiu na rua).',
  },
  ociosidade: {
    nome: 'Motor ligado parado', ico: 'engine',
    desc: 'Avisa quando o motor fica ligado com o veículo parado: gasto de combustível e desgaste.',
  },
  sem_comunicacao: {
    nome: 'Sem comunicação', ico: 'antenna-bars-off',
    desc: 'Avisa quando o aparelho para de se comunicar com o veículo ligado: antena ou cabo cortado, DVR desligado, falta de energia ou área sem sinal.',
  },
};
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function fmtTempoRegra(seg) {
  if (seg < 60) return `${seg} s`;
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

function textoDiasRegra(dias) {
  const l = [...dias].sort((a, b) => a - b);
  if (l.length === 7) return 'todos os dias';
  if (l.length === 5 && l.join() === '1,2,3,4,5') return 'seg a sex';
  if (l.length > 2 && l.every((d, i) => i === 0 || d === l[i - 1] + 1)) return `${DIAS_SEMANA[l[0]].toLowerCase()} a ${DIAS_SEMANA[l[l.length - 1]].toLowerCase()}`;
  return l.map((d) => DIAS_SEMANA[d].toLowerCase()).join(', ');
}

/** "80 km/h · tolerância 20 s · só em Garagem Barueri" */
function resumoRegra(r) {
  if (r.tipo === 'velocidade') {
    return [`<b>${fmtNum(r.limite)} km/h</b>`, r.tempoSeg ? `tolerância ${fmtTempoRegra(r.tempoSeg)}` : 'sem tolerância',
      r.cercaId ? (r.cercaSumiu ? '<span style="color:var(--err)">cerca excluída ou desativada: a regra está parada</span>' : `só dentro de ${H(r.cerca)}`) : ''].filter(Boolean).join(' · ');
  }
  if (r.tipo === 'fora_horario') {
    return [`permitido <b>${H(textoDiasRegra(r.dias))}, ${H(r.inicio)}–${H(r.fim)}</b>`, r.tempoSeg ? `tolerância ${fmtTempoRegra(r.tempoSeg)}` : ''].filter(Boolean).join(' · ');
  }
  if (r.tipo === 'sem_comunicacao') return `mais de <b>${fmtTempoRegra(r.tempoSeg)}</b> · ${r.soLigado ? 'só se estava ligado' : 'mesmo com o veículo desligado'}`;
  const fora = [r.ignorarGaragem ? 'garagens' : '', r.ignorarPonto ? 'pontos' : ''].filter(Boolean).join(' e ');
  return [`mais de <b>${fmtTempoRegra(r.tempoSeg)}</b>`, fora ? `não avisa em ${fora}` : 'avisa em qualquer lugar'].join(' · ');
}

function alvoRegra(r) {
  if (r.alcance === 'veiculo') return `${ico('bus', 'i-sm')} ${H(r.veiculo || 'veículo')}`;
  if (r.alcance === 'grupo') return `${ico('folders', 'i-sm')} ${H(r.grupo || 'grupo')}`;
  return `${ico('building', 'i-sm')} Empresa toda`;
}

PAGINAS.regras = (() => {
  let regras = [];
  let offs = [];

  function render(c) {
    c.innerHTML = `
      <div class="page">
        <section class="card rg-intro">
          <div class="rg-intro-ico">${ico('bell-cog')}</div>
          <div>
            <b>O servidor confere as regras o tempo todo</b>, mesmo com o painel fechado, e abre o alerta na hora.
            <span class="sub">Vale a regra mais específica: a do veículo, senão a do grupo, senão a da empresa toda. O alerta fica aberto enquanto a situação durar e fecha sozinho.</span>
          </div>
        </section>
        <div class="rg-grade" id="rg-grade"><p class="hint">Carregando…</p></div>
      </div>`;
    $('#rg-grade').addEventListener('click', clique);
    $('#rg-grade').addEventListener('change', ligarDesligar);
    carregar();
    offs.push(on('empresa', carregar));
    offs.push(on('regras', carregar));
  }

  function sair() {
    offs.forEach((f) => f());
    offs = [];
  }

  async function carregar() {
    try {
      regras = (await api(`/api/regras${S.empresa ? `?${qs({ empresa: S.empresa })}` : ''}`)).regras;
      desenhar();
    } catch (e) {
      const g = $('#rg-grade');
      if (g) g.innerHTML = `<p class="hint" style="color:var(--err)">${H(e.message)}</p>`;
    }
  }

  function desenhar() {
    const g = $('#rg-grade');
    if (!g) return;
    const podeCriar = podeTela('regras', 'incluir');
    const podeAlt = podeTela('regras', 'alterar');
    const abre = podeAlt || podeTela('regras', 'excluir');
    const variasEmpresas = S.eu.perfil === 'master' && !S.empresa && new Set(regras.map((r) => r.empresaId)).size > 1;
    const ordem = { empresa: 0, grupo: 1, veiculo: 2 };
    g.innerHTML = Object.entries(TIPOS_REGRA).map(([tipo, t]) => {
      const doTipo = regras.filter((r) => r.tipo === tipo)
        .sort((a, b) => (a.empresa || '').localeCompare(b.empresa || '') || ordem[a.alcance] - ordem[b.alcance] || (a.grupo || a.veiculo || '').localeCompare(b.grupo || b.veiculo || '') || a.id - b.id);
      const itens = doTipo.map((r) => `
        <div class="rg-item${r.ativo ? '' : ' off'}${abre ? ' clic' : ''}" data-id="${r.id}">
          <div class="rg-item-txt">
            <span class="rg-alvo">${alvoRegra(r)}${variasEmpresas ? `<small>${H(r.empresa)}</small>` : ''}</span>
            <span class="rg-par">${resumoRegra(r)}</span>
          </div>
          <div class="rg-item-lado">
            <span class="tag ${r.gravidade}" title="Gravidade do alerta">${H(NOMES_GRAVIDADE[r.gravidade])}</span>
            <span class="rg-n" title="Alertas desta regra nos últimos 7 dias">${r.alertas7d ? `${fmtNum(r.alertas7d)} alerta${r.alertas7d === 1 ? '' : 's'} em 7 dias` : 'nenhum alerta em 7 dias'}</span>
            ${podeAlt ? `<label class="switch" title="${r.ativo ? 'Ligada' : 'Desligada'}"><input type="checkbox" data-ativo ${r.ativo ? 'checked' : ''} aria-label="Regra ligada"><span></span></label>` : `<span class="tag ${r.ativo ? 'ok' : 'off'}">${r.ativo ? 'ligada' : 'desligada'}</span>`}
          </div>
        </div>`).join('');
      return `
        <section class="card rg-tipo" data-tipo="${tipo}">
          <header class="rg-head">
            <div class="rg-ico">${ico(t.ico)}</div>
            <div class="rg-head-txt"><h3>${H(t.nome)}</h3><p>${H(t.desc)}</p></div>
            ${podeCriar ? `<button class="btn btn-sm" type="button" data-nova="${tipo}">${ico('plus', 'i-sm')} Nova</button>` : ''}
          </header>
          <div class="rg-lista">${itens || `<p class="rg-vazio">Nenhuma regra. ${podeCriar ? 'Crie uma para começar a receber este alerta.' : 'Este alerta não está sendo gerado.'}</p>`}</div>
        </section>`;
    }).join('');
  }

  function clique(e) {
    if (e.target.closest('.switch')) return;
    const nova = e.target.closest('[data-nova]');
    if (nova) { editar(null, nova.dataset.nova); return; }
    const it = e.target.closest('.rg-item.clic');
    if (it) {
      const r = regras.find((x) => x.id === Number(it.dataset.id));
      if (r) editar(r, r.tipo);
    }
  }

  async function ligarDesligar(e) {
    const x = e.target.closest('[data-ativo]');
    if (!x) return;
    const id = Number(x.closest('.rg-item').dataset.id);
    x.disabled = true;
    try {
      await api(`/api/regras/${id}`, { metodo: 'PUT', corpo: { ativo: x.checked } });
      toast(x.checked ? 'Regra ligada.' : 'Regra desligada: os alertas dela que estavam abertos foram encerrados.', 'ok');
    } catch (err) {
      x.checked = !x.checked;
      toast(err.message, 'err');
    } finally {
      x.disabled = false;
    }
  }

  async function editar(r, tipo) {
    if (r && !podeTela('regras', 'alterar')) { excluir(r); return; }
    const empresaId = r ? r.empresaId : await escolherEmpresa();
    if (!empresaId) return;
    const q = qs({ empresa: empresaId });
    const [g, v, ce] = await Promise.all([
      api(`/api/grupos?${q}`), api(`/api/veiculos?${q}`),
      ['velocidade', 'parada', 'ociosidade'].includes(tipo) ? api(`/api/cercas?${q}`) : Promise.resolve({ cercas: [] }),
    ]);
    const t = TIPOS_REGRA[tipo];
    const veiculos = v.veiculos.filter((x) => x.ativo || (r && r.veiculoId === x.id))
      .sort((a, b) => (a.prefixo || a.placa).localeCompare(b.prefixo || b.placa, 'pt-BR', { numeric: true }));
    const alcance = [{ v: 'empresa', t: 'A empresa toda' }];
    if (g.grupos.length) alcance.push({ v: 'grupo', t: 'Um grupo (e os subgrupos)' });
    alcance.push({ v: 'veiculo', t: 'Um veículo' });
    // quem enxerga só alguns grupos não cria regra para a empresa toda
    if (S.eu.perfil !== 'master' && !S.eu.todosGrupos) alcance.shift();
    const campos = [
      { tipo: 'separador', rotulo: 'Veículos' },
      { nome: 'alcance', rotulo: 'Vale para', tipo: 'select', opcoes: alcance },
      { nome: 'grupo', rotulo: 'Grupo', tipo: 'select', se: 'alcance=grupo', opcoes: g.grupos.map((x) => ({ v: x.id, t: x.caminho })) },
      { nome: 'veiculo', rotulo: 'Veículo', tipo: 'select', se: 'alcance=veiculo', opcoes: veiculos.map((x) => ({ v: x.id, t: `${x.prefixo ? `${x.prefixo} · ` : ''}${x.placa}${x.grupo ? ` (${x.grupo})` : ''}` })) },
      { tipo: 'separador', rotulo: 'Quando avisar' },
    ];
    const valores = {
      alcance: r ? r.alcance : alcance[0].v, grupo: r && r.grupoId, veiculo: r && r.veiculoId, gravidade: r ? r.gravidade : null, ativo: r ? r.ativo : true,
    };
    if (tipo === 'velocidade') {
      const cercas = ce.cercas.filter((x) => x.ativo || (r && r.cercaId === x.id));
      campos.push(
        { nome: 'limite', rotulo: 'Limite (km/h)', tipo: 'numero', min: 5, max: 200, obrigatorio: true, placeholder: '80' },
        { nome: 'tolerancia', rotulo: 'Tolerância (segundos)', tipo: 'numero', min: 0, max: 600, ajuda: 'Só avisa se ficar acima do limite por mais que isto (evita aviso por uma ultrapassagem).' },
        { nome: 'cerca', rotulo: 'Onde vale', tipo: 'select', cheio: true, opcoes: [{ v: '', t: 'Em qualquer lugar' }, ...cercas.map((x) => ({ v: x.id, t: `Só dentro da cerca ${x.nome}` }))], ajuda: cercas.length ? 'Dentro da cerca, este limite substitui o geral (ex.: 20 km/h no pátio da garagem).' : 'Para um limite só num lugar (pátio, escola), desenhe antes a cerca em Cadastros › Cercas.' },
      );
      Object.assign(valores, { limite: r ? r.limite : 80, tolerancia: r ? r.tempoSeg : 20, cerca: r ? (r.cercaId || '') : '' });
    } else if (tipo === 'fora_horario') {
      campos.push(
        { nome: 'dias', rotulo: 'Dias em que o uso é permitido', tipo: 'multi', opcoes: DIAS_SEMANA.map((d, i) => ({ v: i, t: d })) },
        { nome: 'inicio', rotulo: 'Permitido das', tipo: 'hora', obrigatorio: true },
        { nome: 'fim', rotulo: 'Até as', tipo: 'hora', obrigatorio: true, ajuda: 'Pode passar da meia-noite (ex.: 22:00 até 06:00).' },
        { nome: 'minutos', rotulo: 'Tolerância (minutos)', tipo: 'numero', min: 0, max: 60, ajuda: 'Avisa depois deste tempo em uso fora do horário.' },
      );
      Object.assign(valores, { dias: r ? r.dias : [1, 2, 3, 4, 5, 6], inicio: r ? r.inicio : '05:00', fim: r ? r.fim : '23:00', minutos: r ? Math.round(r.tempoSeg / 60) : 1 });
    } else if (tipo === 'sem_comunicacao') {
      campos.push(
        { nome: 'minutos', rotulo: 'Sem comunicação há mais de (minutos)', tipo: 'numero', min: 5, max: 1440, obrigatorio: true },
        { nome: 'soLigado', rotulo: 'Só se o veículo estava ligado (recomendado)', tipo: 'check', cheio: true, ajuda: '' },
        { tipo: 'info', html: 'Desmarcado, avisa também os veículos desligados: o DVR que desliga junto com a chave gera um alerta toda noite.', se: 'soLigado=false' },
      );
      Object.assign(valores, { minutos: r ? Math.round(r.tempoSeg / 60) : 10, soLigado: r ? r.soLigado : true });
    } else {
      const parada = tipo === 'parada';
      campos.push(
        { nome: 'minutos', rotulo: parada ? 'Parado há mais de (minutos)' : 'Ligado e parado há mais de (minutos)', tipo: 'numero', min: parada ? 5 : 2, max: parada ? 1440 : 240, obrigatorio: true },
        { nome: 'ignorarGaragem', rotulo: 'Não avisar dentro das garagens', tipo: 'check', cheio: true },
        { nome: 'ignorarPonto', rotulo: 'Não avisar nos pontos e terminais', tipo: 'check', cheio: true },
      );
      Object.assign(valores, {
        minutos: r ? Math.round(r.tempoSeg / 60) : (parada ? 30 : 10),
        ignorarGaragem: r ? r.ignorarGaragem : parada, ignorarPonto: r ? r.ignorarPonto : false,
      });
    }
    campos.push(
      { nome: 'gravidade', rotulo: 'Gravidade do alerta', tipo: 'select', opcoes: [{ v: 'alta', t: 'Alta' }, { v: 'media', t: 'Média' }, { v: 'baixa', t: 'Baixa' }] },
      { nome: 'ativo', rotulo: 'Regra ligada', tipo: 'check' },
    );
    if (!valores.gravidade) valores.gravidade = { velocidade: 'media', fora_horario: 'alta', parada: 'media', ociosidade: 'baixa', sem_comunicacao: 'alta' }[tipo];
    // parada longa sem nenhuma garagem desenhada: todo veículo parado contaria
    const semGaragem = tipo === 'parada' && !ce.cercas.some((x) => x.ativo && x.finalidade === 'garagem');
    const j = formulario({
      titulo: r ? t.nome : `Nova regra: ${t.nome.toLowerCase()}`,
      icone: t.ico,
      aviso: `${H(t.desc)}${S.eu.perfil === 'master' ? `<br>Empresa: <b>${H(r ? r.empresa : nomeEmpresa(empresaId))}</b>` : ''}${semGaragem ? `<br><span class="rg-sem-garagem">${ico('alert-triangle', 'i-sm')} Nenhuma garagem desenhada nesta empresa: sem ela, todo veículo parado por mais desse tempo gera alerta. Desenhe as garagens em Cadastros › Cercas.</span>` : ''}`,
      campos, valores,
      extras: r && podeTela('regras', 'excluir') ? `<p style="margin:14px 0 0"><button class="btn btn-danger btn-sm" type="button" data-excluir>${ico('trash', 'i-sm')} Excluir regra</button></p>` : '',
      salvar: async (d) => {
        const corpo = { ...d, tipo, empresa: empresaId };
        if (r) await api(`/api/regras/${r.id}`, { metodo: 'PUT', corpo });
        else await api('/api/regras', { corpo });
        toast(r ? 'Regra atualizada.' : 'Regra criada: o servidor já está conferindo.', 'ok');
        carregar();
      },
    });
    const ex = j.el.querySelector('[data-excluir]');
    if (ex) ex.addEventListener('click', async () => { if (await excluir(r)) j.fechar(); });
  }

  async function excluir(r) {
    if (!podeTela('regras', 'excluir')) return false;
    if (!(await confirmar(`Excluir esta regra de ${TIPOS_REGRA[r.tipo].nome.toLowerCase()}? Os alertas que ela já gerou continuam no histórico. Para só parar os avisos por um tempo, desligue a regra.`, { titulo: 'Excluir regra', ok: 'Excluir', perigo: true }))) return false;
    try {
      await api(`/api/regras/${r.id}`, { metodo: 'DELETE' });
      toast('Regra excluída.', 'ok');
      carregar();
      return true;
    } catch (e) {
      toast(e.message, 'err');
      return false;
    }
  }

  return { id: 'regras', titulo: 'Regras de alerta', sub: 'Velocidade, horário, parada longa, motor ligado parado e sem comunicação: o que a empresa quer acompanhar', render, sair };
})();
