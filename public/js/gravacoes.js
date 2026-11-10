'use strict';
/* FrotaGest — Gravações do cartão do DVR: buscar, assistir e baixar (o arquivo fica no servidor só por alguns dias, nunca no banco). Reis Tecnologia */

const DL_STATUS = {
  aguardando: ['wait', 'Aguardando o DVR'],
  gravando: ['wait', 'Recebendo'],
  convertendo: ['wait', 'Convertendo para MP4'],
  pronto: ['ok', 'Pronto'],
  erro: ['err', 'Falhou'],
  cancelado: ['off', 'Cancelado'],
};

PAGINAS.gravacoes = (() => {
  let offs = [];
  let itens = [];
  let mosaico = null;
  const f = { veiculo: '', canal: '0', data: '', inicio: '00:00', fim: '23:59', alarmes: false };

  const segEntre = (a, b) => Math.max(0, (msDe(b) - msDe(a)) / 1000);

  function render(c, params) {
    if (params.v) f.veiculo = params.v;
    if (!f.data) f.data = textoServidor().slice(0, 10);
    c.innerHTML = `
      <div class="page">
        <section class="card">
          <div class="card-head"><h2>${ico('device-sd-card')} Gravações no cartão do DVR</h2><span class="small muted">O DVR precisa estar online. Consultas e vídeos passam pelo 4G do veículo.</span></div>
          <form class="rec-form" id="gr-form">
            <label class="field">Veículo<select id="gr-veic"></select></label>
            <label class="field">Canal<select id="gr-canal"></select></label>
            <label class="field">Data<input type="date" id="gr-data"></label>
            <label class="field">De<input type="time" id="gr-ini" step="60"></label>
            <label class="field">Até<input type="time" id="gr-fim" step="60"></label>
            <label class="check"><input type="checkbox" id="gr-alarmes"> Só trechos com alarme</label>
            <div class="rec-actions">
              <button class="btn btn-primary" type="submit" id="gr-buscar">${ico('search', 'i-sm')} Buscar no DVR</button>
              ${podeTela('gravacoes', 'incluir') ? `<button class="btn" type="button" id="gr-periodo">${ico('download', 'i-sm')} Baixar período</button>` : ''}
            </div>
          </form>
          <div class="rec-status" id="gr-status"></div>
          <div class="table-wrap" id="gr-lista" hidden></div>
        </section>
        <section class="card" id="gr-play" hidden>
          <div class="card-head"><h2>${ico('player-play')} Reprodução</h2><button class="btn btn-sm" type="button" id="gr-play-fechar">${ico('x', 'i-sm')} Fechar</button></div>
          <div class="tiles" id="gr-tiles"></div>
        </section>
        <section class="card" ${podeTela('gravacoes', 'incluir') ? '' : 'hidden'}>
          <div class="card-head"><h2>${ico('download')} Downloads</h2><span class="small muted">Os arquivos ficam no servidor por poucos dias e depois são apagados sozinhos.</span></div>
          <p class="hint" id="gr-ffmpeg" hidden></p>
          <div class="table-wrap flat" id="gr-downloads"></div>
        </section>
      </div>`;
    $('#gr-veic').innerHTML = opcoesVeiculos(f.veiculo);
    $('#gr-data').value = f.data;
    $('#gr-ini').value = f.inicio;
    $('#gr-fim').value = f.fim;
    $('#gr-alarmes').checked = f.alarmes;
    canais();
    $('#gr-veic').addEventListener('change', () => { f.veiculo = $('#gr-veic').value; canais(); itens = []; desenharLista(); });
    $('#gr-alarmes').addEventListener('change', () => { f.alarmes = $('#gr-alarmes').checked; desenharLista(); });
    $('#gr-form').addEventListener('submit', buscar);
    if ($('#gr-periodo')) $('#gr-periodo').addEventListener('click', baixarPeriodo);
    $('#gr-lista').addEventListener('click', (e) => {
      const a = e.target.closest('[data-assistir]');
      const b = e.target.closest('[data-baixar]');
      if (a && itens[Number(a.dataset.assistir)]) assistir(itens[Number(a.dataset.assistir)]);
      else if (b && itens[Number(b.dataset.baixar)]) {
        const x = itens[Number(b.dataset.baixar)];
        baixar(x.channel, x.start, x.end);
      }
    });
    $('#gr-downloads').addEventListener('click', acaoDownload);
    mosaico = new Mosaico($('#gr-tiles'), () => { $('#gr-play').hidden = !mosaico.tamanho; });
    $('#gr-play-fechar').addEventListener('click', () => mosaico.fecharTodos());
    desenharDownloads();
    if (podeTela('gravacoes', 'incluir')) api('/api/downloads').then((r) => {
      S.downloads = new Map(r.downloads.map((d) => [d.id, d]));
      const n = $('#gr-ffmpeg');
      if (n && !r.ffmpeg) { n.hidden = false; n.textContent = 'O ffmpeg não está instalado no servidor: os downloads saem em H.264 bruto (abra com o VLC).'; }
      desenharDownloads();
    }).catch(() => {});
    offs.push(on('downloads', desenharDownloads));
  }

  function sair() {
    offs.forEach((x) => x());
    offs = [];
    if (mosaico) mosaico.fecharTodos();
  }

  function item() {
    return S.itens.get($('#gr-veic').value);
  }

  function canais() {
    const it = item();
    const n = it ? Math.max(1, it.canais || 4) : 4;
    const nomes = (it && it.nomesCanais) || [];
    const atual = f.canal;
    $('#gr-canal').innerHTML = `<option value="0">Todos (só para buscar)</option>${Array.from({ length: n }, (_, k) => `<option value="${k + 1}">${H(nomes[k] || `CH ${k + 1}`)}</option>`).join('')}`;
    $('#gr-canal').value = Number(atual) <= n ? atual : '0';
  }

  function periodo() {
    const d = $('#gr-data').value;
    const t = (v) => (v.length === 5 ? `${v}:00` : v);
    const inicio = `${d} ${t($('#gr-ini').value || '00:00')}`;
    const fim = `${d} ${t($('#gr-fim').value || '23:59')}`;
    if (!d || fim <= inicio) throw new Error('Confira a data e o horário: o fim precisa ser depois do início.');
    f.data = d;
    f.inicio = $('#gr-ini').value;
    f.fim = $('#gr-fim').value;
    f.canal = $('#gr-canal').value;
    return { inicio, fim };
  }

  function status(texto, erro = false) {
    const st = $('#gr-status');
    if (!st) return;
    st.textContent = texto;
    st.className = `rec-status${erro ? ' err' : ''}`;
  }

  async function buscar(e) {
    e.preventDefault();
    const it = item();
    if (!it) { status('Escolha o veículo.', true); return; }
    let p;
    try { p = periodo(); } catch (err) { status(err.message, true); return; }
    const btn = $('#gr-buscar');
    btn.disabled = true;
    status('Consultando o cartão do DVR… pode levar alguns segundos pelo 4G.');
    try {
      const r = await api(`/api/dvr/${it.ident}/gravacoes/buscar`, { corpo: { canal: Number(f.canal), ...p } });
      itens = r.itens || [];
      desenharLista();
    } catch (err) {
      status(`Não foi possível consultar: ${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  function desenharLista() {
    const box = $('#gr-lista');
    if (!box) return;
    const lista = itens.map((x, i) => ({ ...x, i })).filter((x) => !f.alarmes || x.alarms.length);
    const it = item();
    const nomes = (it && it.nomesCanais) || [];
    box.hidden = !lista.length;
    box.innerHTML = tabela([
      { t: 'Canal', cls: 'nw', v: (x) => H(nomes[x.channel - 1] || `CH ${x.channel}`) },
      { t: 'Início', cls: 'mono', v: (x) => H(x.start) },
      { t: 'Fim', cls: 'mono', v: (x) => H(x.end.slice(11)) },
      { t: 'Duração', v: (x) => H(fmtDur(segEntre(x.start, x.end))) },
      { t: 'Alarmes', v: (x) => (x.alarms.length ? x.alarms.map((a) => `<span class="tag alarm">${H(a)}</span>`).join(' ') : '—') },
      { t: 'Tamanho', cls: 'num', v: (x) => H(fmtTamanho(x.size)) },
      { t: '', cls: 'acts', v: (x) => `<button class="btn" type="button" data-assistir="${x.i}">${ico('player-play', 'i-sm')} Assistir</button>${podeTela('gravacoes', 'incluir') ? `<button class="btn" type="button" data-baixar="${x.i}">${ico('download', 'i-sm')} Baixar MP4</button>` : ''}` },
    ], lista);
    status(itens.length ? `${lista.length} de ${itens.length} trecho(s) encontrado(s).` : 'Nenhuma gravação encontrada nesse período.');
  }

  function assistir(x) {
    const it = item();
    if (!it) return;
    const nome = (it.nomesCanais && it.nomesCanais[x.channel - 1]) || `CH ${x.channel}`;
    mosaico.abrir({ ident: it.ident, canal: x.channel, titulo: `${it.prefixo || it.placa || it.ident} · ${nome}`, conv: pref('conv', '1'), reproducao: { inicio: x.start, fim: x.end } });
    $('#gr-play').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function baixar(canal, inicio, fim) {
    const it = item();
    if (!it) return;
    if (segEntre(inicio, fim) > 3600) { toast('Baixe no máximo 1 hora por vez: escolha um período menor.', 'err'); return; }
    try {
      await api(`/api/dvr/${it.ident}/downloads`, { corpo: { canal, inicio, fim } });
      toast(`Download iniciado: canal ${canal}, ${inicio.slice(11, 16)}–${fim.slice(11, 16)}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function baixarPeriodo() {
    let p;
    try { p = periodo(); } catch (err) { status(err.message, true); return; }
    if (!item()) { status('Escolha o veículo.', true); return; }
    if (!Number(f.canal)) { status('Escolha um canal específico para baixar o período.', true); return; }
    baixar(Number(f.canal), p.inicio, p.fim);
  }

  function desenharDownloads() {
    const box = $('#gr-downloads');
    if (!box) return;
    const lista = [...S.downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
    box.innerHTML = tabela([
      { t: 'Gravação', v: (d) => `<div class="mono">CH ${d.channel} · ${H(d.start)} → ${H(d.end.slice(11))}</div><div class="dl-sub">${H(d.rotulo || `Aparelho ${d.deviceId}`)}</div>` },
      { t: 'Situação', v: (d) => { const [cls, t] = DL_STATUS[d.status] || ['off', d.status]; return `<span class="tag ${cls}">${H(t)}</span>${d.note ? `<div class="dl-sub">${H(d.note)}</div>` : ''}`; } },
      {
        t: 'Progresso', v: (d) => {
          const pct = d.status === 'pronto' && !/^incompleto/.test(d.note || '') ? 100 : Math.min(100, Math.round((d.durationMs / d.totalMs) * 100) || 0);
          return `<div class="progress"><span style="width:${pct}%"></span></div><div class="dl-sub">${H(fmtDur(d.durationMs / 1000))} de ${H(fmtDur(d.totalMs / 1000))}</div>`;
        },
      },
      { t: 'Tamanho', cls: 'num', v: (d) => H(fmtTamanho(d.size)) },
      {
        t: '', cls: 'acts', v: (d) => [
          d.status === 'pronto' ? `<button class="btn btn-primary" type="button" data-dl="link" data-id="${d.id}">${ico('download', 'i-sm')} <span>Salvar</span></button>` : '',
          ['aguardando', 'gravando'].includes(d.status) ? `<button class="btn" type="button" data-dl="cancelar" data-id="${d.id}">Cancelar</button>` : '',
          ['pronto', 'erro', 'cancelado'].includes(d.status) ? `<button class="btn" type="button" data-dl="excluir" data-id="${d.id}">${ico('trash', 'i-sm')} Excluir</button>` : '',
        ].join(''),
      },
    ], lista, { vazio: 'Nenhum download ainda. Busque as gravações acima e clique em "Baixar MP4".' });
  }

  async function acaoDownload(e) {
    const b = e.target.closest('[data-dl]');
    if (!b) return;
    const d = S.downloads.get(b.dataset.id);
    if (!d) return;
    if (b.dataset.dl !== 'link') {
      try { await api(`/api/downloads/${d.id}/${b.dataset.dl}`, { corpo: {} }); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    // o servidor cria um link de uso curto e o próprio navegador baixa, com progresso na barra de downloads
    b.disabled = true;
    try {
      const r = await api(`/api/downloads/${d.id}/link`, { corpo: {} });
      const a = document.createElement('a');
      a.href = r.url;
      a.download = d.name;
      document.body.append(a);
      a.click();
      a.remove();
      toast(`Download iniciado (${fmtTamanho(d.size)}). Acompanhe na barra de downloads do navegador.`, 'ok');
    } catch (err) {
      toast(`Não foi possível salvar: ${err.message}`, 'err');
    } finally {
      setTimeout(() => { b.disabled = false; }, 3000);
    }
  }

  return { id: 'gravacoes', titulo: 'Gravações', sub: 'Vídeos guardados no cartão de memória do DVR', render, sair };
})();
