'use strict';
/* FrotaGest — comandos para o veículo, pelo painel do veículo no Monitoramento: foto na hora das
 * câmeras, mensagem ao motorista (tela e voz do DVR), reiniciar o aparelho e os parâmetros
 * (intervalos de posição, limite de velocidade; APN e servidor só o master). Reis Tecnologia */

const ABAS_CMD = [['foto', 'Foto agora', 'camera'], ['mensagem', 'Mensagem', 'message-dots'], ['aparelho', 'Aparelho', 'settings-2'], ['historico', 'Histórico', 'history']];
const FRASES_MOTORISTA = ['Entre em contato com a central', 'Retorne à garagem', 'Reduza a velocidade', 'Pare em local seguro', 'Confirme o recebimento'];

/** Confirmação forte (APN/servidor): a pessoa digita ALTERAR. null = desistiu. */
function digitarConfirmacao() {
  return new Promise((resolve) => {
    let r = null;
    formulario({
      titulo: 'Mudar o APN ou o servidor', icone: 'alert-triangle', tamanho: 'sm', textoSalvar: 'Gravar no aparelho',
      aviso: 'Um valor errado tira o aparelho do ar, e aí só indo ao veículo. Confira e digite <b>ALTERAR</b> para confirmar.',
      campos: [{ nome: 'txt', rotulo: 'Confirmação', cheio: true, placeholder: 'ALTERAR', maxlength: 10 }],
      salvar: async (d) => {
        if (d.txt.trim().toUpperCase() !== 'ALTERAR') throw new Error('Digite ALTERAR para confirmar.');
        r = 'ALTERAR';
      },
      aoFechar: () => resolve(r),
    });
  });
}

/** Fotos vêm com o login: baixa e guarda o endereço local (blob) de cada uma. */
const urlsFoto = new Map();
async function urlFoto(id) {
  if (urlsFoto.has(id)) return urlsFoto.get(id);
  const pedir = async (forcar) => fetch(`/api/fotos/${id}`, { headers: { Authorization: `Bearer ${await token(forcar)}` } });
  let r = await pedir(false);
  if (r.status === 401) r = await pedir(true);
  if (!r.ok) throw new Error('foto indisponível');
  const url = URL.createObjectURL(await r.blob());
  urlsFoto.set(id, url);
  if (urlsFoto.size > 200) { const [k, v] = urlsFoto.entries().next().value; URL.revokeObjectURL(v); urlsFoto.delete(k); }
  return url;
}

function verFoto(f, titulo) {
  const j = janela({
    titulo, icone: 'photo', tamanho: 'lg',
    corpo: `<div class="cmd-foto-grande"><img alt="Foto da câmera ${f.canal}"></div>
      <p class="small muted" style="margin:10px 0 0">${H(fmtDataHora(f.dataHora))} · câmera ${f.canal}${f.velocidade !== null && f.velocidade !== undefined ? ` · ${fmtNum(Math.round(f.velocidade))} km/h` : ''}${f.pedidaPor ? ` · pedida por ${H(f.pedidaPor)}` : ''}</p>`,
    rodape: `<button class="btn" type="button" data-baixar>${ico('download', 'i-sm')} Baixar</button><button class="btn btn-primary" type="button" data-fechar>Fechar</button>`,
  });
  urlFoto(f.id).then((u) => { j.el.querySelector('img').src = u; }).catch(() => { j.el.querySelector('.cmd-foto-grande').textContent = 'O arquivo desta foto não existe mais.'; });
  j.el.querySelector('[data-baixar]').addEventListener('click', () => baixarArquivo(`/api/fotos/${f.id}`, `foto-${f.id}.jpg`).catch((e) => toast(e.message, 'err')));
}

async function abrirComandos(item) {
  const titulo = rotulo(item);
  const ident = item.ident;
  let d;
  try {
    d = await api(`/api/dvr/${encodeURIComponent(ident)}/comandos`);
  } catch (e) { toast(e.message, 'err'); return; }
  const abas = ABAS_CMD.filter(([id]) => id !== 'aparelho' || d.pode.alterar).filter(([id]) => id !== 'mensagem' || d.pode.incluir);
  const nomeCanal = (ch) => (d.nomesCanais && d.nomesCanais[ch - 1]) || `Câmera ${ch}`;
  const esperando = new Map(); // canal → timer (foto pedida que ainda não chegou)
  let aba = abas[0][0];
  let offs = [];

  const j = janela({
    titulo: `Comandos · ${titulo}`, icone: 'terminal-2', tamanho: 'lg',
    corpo: `<div class="cmd-status" id="cmd-status"></div>
      <div class="tabs" id="cmd-abas">${abas.map(([id, t, i]) => `<button class="tab${id === aba ? ' active' : ''}" type="button" data-aba="${id}">${ico(i, 'i-sm')} ${H(t)}</button>`).join('')}</div>
      <div id="cmd-corpo" class="cmd-corpo"></div>`,
    rodape: '<button class="btn" type="button" data-fechar>Fechar</button>',
    aoFechar: () => { offs.forEach((f) => f()); offs = []; esperando.forEach((t) => clearTimeout(t)); },
  });
  const corpo = j.el.querySelector('#cmd-corpo');

  function status() {
    const it = S.itens.get(item.chave) || item;
    d.online = Boolean(it.online);
    j.el.querySelector('#cmd-status').innerHTML = d.online
      ? `<span class="dot on"></span> Aparelho online${d.protocolo ? ` <span class="muted small">· JT/T 808-${d.protocolo}</span>` : ''}`
      : `<span class="dot off"></span> Aparelho offline <span class="muted small">· os comandos ficam disponíveis quando ele voltar (${it.ultimoContato ? `último contato ${H(atras(it.ultimoContato))}` : 'nunca conectou'})</span>`;
    $$('[data-precisa-online]', corpo).forEach((b) => { b.disabled = !d.online || b.dataset.ocupado === '1'; });
  }

  async function recarregar() {
    try { Object.assign(d, await api(`/api/dvr/${encodeURIComponent(ident)}/comandos`)); } catch { /* fica como estava */ }
    if (aba === 'foto') desenharFotos();
    if (aba === 'historico') desenharHistorico();
  }

  /* ---------- foto ---------- */
  function abaFoto() {
    const n = Math.max(1, d.canais || 4);
    corpo.innerHTML = d.pode.incluir ? `
      <div class="cmd-bloco">
        <div class="cmd-canais">${Array.from({ length: n }, (_, k) => `<label class="cmd-canal"><input type="checkbox" name="cmd-ch" value="${k + 1}" ${k === 0 ? 'checked' : ''}> ${H(nomeCanal(k + 1))}</label>`).join('')}</div>
        <div class="cmd-linha">
          <label class="field" style="margin:0">Qualidade<select id="cmd-qual"><option value="baixa">Baixa (mais rápida no 4G)</option><option value="media" selected>Média (640×480)</option><option value="alta">Alta (1024×768)</option></select></label>
          <button class="btn btn-primary" type="button" id="cmd-tirar" data-precisa-online>${ico('camera', 'i-sm')} Tirar foto</button>
        </div>
        <p class="small muted" style="margin:0">A foto chega em alguns segundos (depende do sinal do chip) e fica guardada aqui por um tempo.</p>
      </div>
      <div class="cmd-pendentes" id="cmd-pend"></div>` : '';
    corpo.insertAdjacentHTML('beforeend', '<div class="form-sep">Fotos recentes</div><div class="cmd-fotos" id="cmd-fotos"></div>');
    desenharFotos();
    const b = corpo.querySelector('#cmd-tirar');
    if (b) b.addEventListener('click', tirar);
  }

  function desenharPendentes() {
    const box = corpo.querySelector('#cmd-pend');
    if (!box) return;
    box.innerHTML = [...esperando.keys()].map((ch) => `<div class="cmd-pend">${ico('loader-2', 'i-sm gira')} Aguardando a foto de ${H(nomeCanal(ch))}…</div>`).join('');
  }

  function desenharFotos() {
    const box = corpo.querySelector('#cmd-fotos');
    if (!box) return;
    if (!d.fotos.length) { box.innerHTML = '<p class="small muted" style="margin:0">Nenhuma foto deste veículo ainda.</p>'; return; }
    box.innerHTML = d.fotos.map((f) => `<button class="cmd-foto" type="button" data-foto="${f.id}" title="Câmera ${f.canal} · ${H(fmtDataHora(f.dataHora))}">
        <span class="cmd-foto-img" data-img="${f.id}">${ico('photo')}</span>
        <span class="cmd-foto-txt"><b>${H(nomeCanal(f.canal))}</b><small>${H(fmtCurto(f.dataHora))}</small></span></button>`).join('');
    for (const f of d.fotos) {
      urlFoto(f.id).then((u) => { const s = box.querySelector(`[data-img="${f.id}"]`); if (s) s.innerHTML = `<img src="${u}" alt="">`; }).catch(() => {});
    }
    box.querySelectorAll('[data-foto]').forEach((x) => x.addEventListener('click', () => {
      const f = d.fotos.find((y) => y.id === Number(x.dataset.foto));
      if (f) verFoto(f, `${titulo} · ${nomeCanal(f.canal)}`);
    }));
  }

  async function tirar() {
    const canais = $$('[name=cmd-ch]:checked', corpo).map((x) => Number(x.value));
    if (!canais.length) { toast('Marque pelo menos uma câmera.'); return; }
    const b = corpo.querySelector('#cmd-tirar');
    b.dataset.ocupado = '1';
    b.disabled = true;
    try {
      const r = await api(`/api/dvr/${encodeURIComponent(ident)}/foto`, { corpo: { canais, qualidade: corpo.querySelector('#cmd-qual').value } });
      for (const x of r.resultados) {
        if (!x.ok) { toast(`${nomeCanal(x.canal)}: ${x.erro}`, 'err'); continue; }
        clearTimeout(esperando.get(x.canal));
        esperando.set(x.canal, setTimeout(() => {
          esperando.delete(x.canal);
          desenharPendentes();
          toast(`A foto de ${nomeCanal(x.canal)} não chegou. O aparelho pode estar sem sinal: tente de novo.`, 'err');
        }, 90000));
      }
      desenharPendentes();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      b.dataset.ocupado = '';
      status();
    }
  }

  offs.push(on('foto', (f) => {
    if (f.ident !== ident) return;
    if (esperando.has(f.canal)) { clearTimeout(esperando.get(f.canal)); esperando.delete(f.canal); desenharPendentes(); }
    recarregar();
  }));
  offs.push(on('item', (it) => { if (it && it.chave === item.chave) status(); }));

  /* ---------- mensagem ---------- */
  function abaMensagem() {
    corpo.innerHTML = `
      <div class="cmd-bloco">
        <div class="cmd-frases">${FRASES_MOTORISTA.map((f) => `<button class="chip" type="button" data-frase="${H(f)}">${H(f)}</button>`).join('')}</div>
        <label class="field full" style="margin:0"><span>Mensagem ao motorista</span><textarea id="cmd-texto" maxlength="200" rows="3" placeholder="Ex.: Entre em contato com a central"></textarea>
          <small><span id="cmd-n">0</span>/200 · vai sem acentos: os aparelhos não mostram acento</small></label>
        <div class="cmd-opcoes">
          <label class="check"><input type="checkbox" id="cmd-tela" checked> Mostrar na tela do aparelho</label>
          <label class="check"><input type="checkbox" id="cmd-voz" checked> Falar em voz alta (se o aparelho tiver alto-falante)</label>
          <label class="check"><input type="checkbox" id="cmd-urg"> Urgente</label>
        </div>
        <div class="cmd-linha"><span class="small muted" id="cmd-previa"></span><button class="btn btn-primary" type="button" id="cmd-enviar" data-precisa-online>${ico('send', 'i-sm')} Enviar</button></div>
      </div>`;
    const t = corpo.querySelector('#cmd-texto');
    const previa = () => {
      corpo.querySelector('#cmd-n').textContent = t.value.length;
      const s = t.value.normalize('NFD').replace(/[̀-ͯ]/g, '');
      corpo.querySelector('#cmd-previa').textContent = s !== t.value && s.trim() ? `Vai assim: "${s.trim()}"` : '';
    };
    t.addEventListener('input', previa);
    corpo.querySelectorAll('[data-frase]').forEach((x) => x.addEventListener('click', () => { t.value = x.dataset.frase; previa(); t.focus(); }));
    corpo.querySelector('#cmd-enviar').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (!t.value.trim()) { toast('Escreva a mensagem.'); return; }
      b.dataset.ocupado = '1';
      b.disabled = true;
      try {
        await api(`/api/dvr/${encodeURIComponent(ident)}/mensagem`, { corpo: { texto: t.value, tela: corpo.querySelector('#cmd-tela').checked, voz: corpo.querySelector('#cmd-voz').checked, urgente: corpo.querySelector('#cmd-urg').checked } });
        toast('Mensagem entregue ao aparelho.', 'ok');
        t.value = '';
        previa();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        b.dataset.ocupado = '';
        status();
      }
    });
  }

  /* ---------- aparelho: reiniciar e parâmetros ---------- */
  function abaAparelho() {
    const campo = (k, t, u, min, max, ajuda = '') => `<label class="field"><span>${H(t)} (${u})</span><input type="number" name="${k}" min="${min}" max="${max}">${ajuda ? `<small>${H(ajuda)}</small>` : ''}</label>`;
    corpo.innerHTML = `
      <div class="cmd-bloco">
        <div class="cmd-linha"><div><b>Reiniciar o aparelho</b><p class="small muted" style="margin:2px 0 0">Resolve travamentos de câmera ou de gravação. Ele some por 1 a 3 minutos e volta sozinho.</p></div>
          <button class="btn" type="button" id="cmd-reiniciar" data-precisa-online>${ico('power', 'i-sm')} Reiniciar</button></div>
      </div>
      <div class="form-sep">Parâmetros do aparelho</div>
      <div class="cmd-linha"><p class="small muted" style="margin:0" id="cmd-par-info">Leia do aparelho para ver os valores atuais.</p>
        <button class="btn btn-sm" type="button" id="cmd-ler" data-precisa-online>${ico('refresh', 'i-sm')} Ler do aparelho</button></div>
      <form class="form-grid" id="cmd-par" hidden>
        ${campo('intervaloPosicao', 'Posição com o veículo ligado', 's', 5, 3600, 'De quanto em quanto tempo manda a posição andando.')}
        ${campo('intervaloDormindo', 'Posição com o veículo desligado', 's', 30, 86400)}
        ${campo('batimento', 'Sinal de vida', 's', 10, 3600)}
        ${campo('velocidadeMax', 'Velocidade máxima no aparelho', 'km/h', 20, 250, 'O alarme de velocidade do próprio DVR (as regras de alerta do FrotaGest são à parte).')}
        ${campo('tempoExcesso', 'Tempo acima da velocidade', 's', 0, 600)}
        ${d.pode.master ? `
        <div class="form-sep">Só o master · cuidado: um valor errado tira o aparelho do ar</div>
        <label class="field"><span>APN do chip</span><input name="apn" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>Usuário do APN</span><input name="apnUsuario" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>Senha do APN</span><input name="apnSenha" maxlength="60" type="password" autocomplete="new-password" placeholder="(não muda se ficar em branco)"></label>
        <label class="field"><span>Servidor (endereço:porta)</span><input name="servidor" maxlength="90" autocomplete="off"></label>` : ''}
      </form>
      <p class="form-erro" id="cmd-par-erro" hidden></p>
      <div class="cmd-linha" id="cmd-par-acoes" hidden><span></span><button class="btn btn-primary" type="button" id="cmd-gravar" data-precisa-online>${ico('check', 'i-sm')} Gravar no aparelho</button></div>`;
    let lidos = {};
    const form = corpo.querySelector('#cmd-par');
    corpo.querySelector('#cmd-reiniciar').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (!(await confirmar(`Reiniciar o aparelho de ${titulo}? As câmeras e a posição param por 1 a 3 minutos.`, { titulo: 'Reiniciar aparelho', ok: 'Reiniciar', perigo: true }))) return;
      b.dataset.ocupado = '1';
      b.disabled = true;
      try {
        await api(`/api/dvr/${encodeURIComponent(ident)}/reiniciar`, { corpo: {} });
        toast('O aparelho aceitou: está reiniciando.', 'ok');
      } catch (err) { toast(err.message, 'err'); } finally { b.dataset.ocupado = ''; status(); }
    });
    corpo.querySelector('#cmd-ler').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.dataset.ocupado = '1';
      b.disabled = true;
      corpo.querySelector('#cmd-par-info').textContent = 'Lendo do aparelho…';
      try {
        const r = await api(`/api/dvr/${encodeURIComponent(ident)}/parametros/ler`, { corpo: {} });
        lidos = r.valores;
        for (const el of $$('input', form)) el.value = el.name === 'apnSenha' ? '' : (lidos[el.name] ?? '');
        form.hidden = false;
        corpo.querySelector('#cmd-par-acoes').hidden = false;
        corpo.querySelector('#cmd-par-info').textContent = `${r.itens.length} parâmetro(s) lidos agora. Mude só o que precisar.`;
      } catch (err) {
        corpo.querySelector('#cmd-par-info').textContent = err.message;
      } finally { b.dataset.ocupado = ''; status(); }
    });
    corpo.querySelector('#cmd-gravar').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      const erro = corpo.querySelector('#cmd-par-erro');
      erro.hidden = true;
      // só vai o que mudou
      const mudou = {};
      for (const el of $$('input', form)) {
        const v = el.value.trim();
        if (el.name === 'apnSenha' ? v : v !== '' && String(lidos[el.name] ?? '') !== v) mudou[el.name] = v;
      }
      if (!Object.keys(mudou).length) { toast('Nada mudou.'); return; }
      if (['apn', 'apnUsuario', 'apnSenha', 'servidor'].some((k) => k in mudou)) {
        const txt = await digitarConfirmacao();
        if (txt === null) return;
        mudou.confirmacao = txt;
      }
      b.dataset.ocupado = '1';
      b.disabled = true;
      try {
        const r = await api(`/api/dvr/${encodeURIComponent(ident)}/parametros`, { metodo: 'PUT', corpo: mudou });
        toast(`O aparelho aceitou ${r.alterados} mudança(s).`, 'ok');
        Object.assign(lidos, mudou);
      } catch (err) {
        erro.textContent = err.message;
        erro.hidden = false;
      } finally { b.dataset.ocupado = ''; status(); }
    });
  }

  /* ---------- histórico ---------- */
  function desenharHistorico() {
    if (aba !== 'historico') return;
    corpo.innerHTML = d.historico.length ? `<div class="cmd-hist">${d.historico.map((c) => `
      <div class="cmd-hist-item">
        <div><b>${H(c.nome)}</b>${c.detalhe ? `<span class="sub">${H(c.detalhe)}</span>` : ''}</div>
        <div class="cmd-hist-lado"><span class="tag ${!c.respondido_em ? 'off' : /sucesso|aceito|parâmetro/.test(c.resultado || '') ? 'ok' : 'err'}">${H(c.respondido_em ? c.resultado || 'respondido' : 'sem resposta')}</span>
          <small>${H(fmtCurto(c.enviado_em))}${c.usuario ? ` · ${H(c.usuario)}` : ''}</small></div>
      </div>`).join('')}</div>` : '<p class="small muted" style="margin:0">Nenhum comando enviado a este aparelho ainda.</p>';
  }

  function abrirAba(id) {
    aba = id;
    $$('#cmd-abas .tab', j.el).forEach((x) => x.classList.toggle('active', x.dataset.aba === id));
    if (id === 'foto') abaFoto();
    else if (id === 'mensagem') abaMensagem();
    else if (id === 'aparelho') abaAparelho();
    else { desenharHistorico(); recarregar(); }
    status();
  }
  j.el.querySelector('#cmd-abas').addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (b) abrirAba(b.dataset.aba); });
  abrirAba(aba);
}
