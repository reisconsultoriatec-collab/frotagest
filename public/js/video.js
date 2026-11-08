'use strict';
/* FrotaGest — quadro de vídeo (câmera ao vivo ou gravação do DVR), com jMuxer. Reis Tecnologia */

function h265Suportado() {
  if (!window.MediaSource) return false;
  return ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'].some((t) => MediaSource.isTypeSupported(t));
}

class Quadro {
  /**
   * opts: { ident, canal, titulo, fluxo (0 principal, 1 secundário), conv ('1' converte H.265 no servidor) }
   * gravação: opts.reproducao = { inicio, fim }
   */
  constructor(opts) {
    this.ident = opts.ident;
    this.canal = opts.canal;
    this.fluxo = opts.fluxo ?? 1;
    this.conv = opts.conv ?? '1';
    this.tituloBase = opts.titulo || `CH ${opts.canal}`;
    this.reproducao = opts.reproducao || null;
    this.aoFechar = opts.aoFechar || null;
    this.chave = this.reproducao ? `pb:${this.ident}:${this.canal}:${this.reproducao.inicio}` : `${this.ident}:${this.canal}`;
    this.frames = 0;
    this.bytes = 0;
    this.ultFrames = 0;
    this.ultBytes = 0;
    this.codec = null;
    this.convertido = false;
    this.jmuxer = null;

    this.root = document.createElement('div');
    this.root.className = `tile${this.reproducao ? ' playback' : ''}`;
    this.root.innerHTML = `<video muted autoplay playsinline></video>
      <div class="tile-bar"><div><span class="tile-title"></span> <span class="tile-stats"></span></div>
        <button class="tile-close" type="button" title="${this.reproducao ? 'Encerrar reprodução' : 'Fechar câmera'}" aria-label="Fechar">${ico('x')}</button></div>
      <div class="tile-msg">${this.reproducao ? 'Pedindo a gravação ao aparelho…' : 'Pedindo vídeo ao aparelho…'}</div>`;
    this.video = this.root.querySelector('video');
    this.titulo = this.root.querySelector('.tile-title');
    this.stats = this.root.querySelector('.tile-stats');
    this.msg = this.root.querySelector('.tile-msg');
    this.titulo.textContent = this.rotulo();
    this.stats.textContent = this.reproducao ? '' : (this.fluxo === 0 ? 'principal' : 'secundário');
    this.root.querySelector('.tile-close').addEventListener('click', () => this.fechar());
    if (this.reproducao) this.root.append(this.controles());
  }

  rotulo() {
    let codec = '';
    if (this.convertido) codec = ' · H.265 → H.264';
    else if (this.codec) codec = ` · ${this.codec === 'H265' ? 'H.265' : 'H.264'}`;
    if (!this.reproducao) return `${this.tituloBase}${codec}`;
    return `${this.tituloBase} · ${this.reproducao.inicio.slice(11, 16)}–${this.reproducao.fim.slice(11, 16)}${codec}`;
  }

  controles() {
    const box = document.createElement('div');
    box.className = 'tile-controls';
    box.innerHTML = `<button type="button" data-p>Pausar</button>
      <select aria-label="Velocidade"><option value="1">Velocidade 1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option></select>`;
    let pausado = false;
    const bp = box.querySelector('[data-p]');
    bp.addEventListener('click', async () => {
      pausado = !pausado;
      bp.textContent = pausado ? 'Continuar' : 'Pausar';
      await this.controle(pausado ? 'pausar' : 'continuar');
    });
    const sel = box.querySelector('select');
    sel.addEventListener('change', () => this.controle('acelerar', Number(sel.value)));
    return box;
  }

  async controle(acao, velocidade = 1) {
    try {
      await api(`/api/dvr/${this.ident}/reproducao/controle`, { corpo: { canal: this.canal, acao, velocidade } });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async abrir() {
    if (!window.JMuxer) {
      this.mensagem('Player indisponível no servidor (rode "npm install").', true);
      return;
    }
    let url;
    try {
      if (this.reproducao) {
        const r = await api(`/api/dvr/${this.ident}/reproducao/iniciar`, { corpo: { canal: this.canal, inicio: this.reproducao.inicio, fim: this.reproducao.fim } });
        url = await wsUrl('/ws/video', { pb: r.key, conv: this.conv });
      } else {
        url = await wsUrl('/ws/video', { id: this.ident, canal: this.canal, conv: this.conv });
      }
    } catch (e) {
      this.mensagem(`Não foi possível abrir: ${e.message}`, true);
      return;
    }
    if (this.fechado) return;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = async () => {
      if (this.reproducao) return;
      try {
        await api(`/api/dvr/${this.ident}/video/iniciar`, { corpo: { canal: this.canal, fluxo: this.fluxo } });
      } catch (e) {
        this.mensagem(`Pedido não enviado: ${e.message}`, true);
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { this.quadro(ev.data); return; }
      const m = JSON.parse(ev.data);
      if (m.type === 'fim') {
        if (!this.semSuporte) this.mensagem(this.reproducao ? 'Fim da gravação' : 'O aparelho encerrou o vídeo', false);
      } else if (m.type === 'erro') {
        this.erroMostrado = true;
        this.mensagem(m.text, true);
      } else this.info(m);
    };
    ws.onclose = () => { if (!this.fechado && !this.terminou) this.mensagem('Conexão de vídeo encerrada', true); };
    this.timeout = setTimeout(() => {
      if (!this.frames && !this.erroMostrado) this.mensagem(`O aparelho não enviou ${this.reproducao ? 'a gravação' : 'vídeo'} em 15s. Verifique se ele está online e se a câmera deste canal está ligada.`, true);
    }, 15000);
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  info(m) {
    if (m.type !== 'info' || !m.codec) return;
    const conv = !!m.converted;
    if (this.codec === m.codec && this.convertido === conv && this.jmuxer) return;
    this.codec = m.codec;
    this.convertido = conv;
    this.titulo.textContent = this.rotulo();
    if (this.jmuxer) { try { this.jmuxer.destroy(); } catch { /* já destruído */ } this.jmuxer = null; }
    this.semSuporte = this.codec === 'H265' && !h265Suportado();
    if (this.semSuporte) {
      this.mensagem('O DVR envia H.265 e este navegador não exibe H.265 direto. Ligue "Converter H.265" acima das câmeras.', true);
      return;
    }
    this.jmuxer = new JMuxer({ node: this.video, mode: 'video', flushingTime: 0, fps: 25, debug: false, videoCodec: this.codec });
    this.limparAoQuadro = true;
  }

  quadro(buf) {
    if (!this.jmuxer) return;
    const view = new DataView(buf);
    if (view.getUint8(0) !== 1) return;
    const duracao = view.getUint32(2);
    const data = new Uint8Array(buf, 6);
    this.jmuxer.feed({ video: data, duration: duracao, isLastVideoFrameComplete: true });
    this.frames++;
    this.bytes += data.length;
    if (this.limparAoQuadro || this.terminou) { this.limparAoQuadro = false; this.terminou = false; this.mensagem(''); }
  }

  tick() {
    const fps = this.frames - this.ultFrames;
    const kbps = Math.round(((this.bytes - this.ultBytes) * 8) / 1000);
    this.ultFrames = this.frames;
    this.ultBytes = this.bytes;
    if (this.frames) this.stats.textContent = `${fps} fps · ${kbps} kbps`;
    const v = this.video;
    if (v.buffered.length) {
      const fim = v.buffered.end(v.buffered.length - 1);
      if (fim - v.currentTime > 1.5) v.currentTime = fim - 0.3;
      if (v.paused) v.play().catch(() => {});
    }
  }

  mensagem(texto, erro = false) {
    if (texto && !erro) this.terminou = true;
    this.msg.textContent = texto;
    this.msg.className = `tile-msg${erro ? ' err' : ''}`;
    this.msg.hidden = !texto;
  }

  fechar() {
    if (this.fechado) return;
    this.fechado = true;
    clearTimeout(this.timeout);
    clearInterval(this.ticker);
    if (this.ws) this.ws.close();
    if (this.jmuxer) { try { this.jmuxer.destroy(); } catch { /* já destruído */ } }
    this.root.remove();
    if (this.aoFechar) this.aoFechar(this);
  }
}

/** Conjunto de quadros de uma página (câmeras ao vivo do mapa, reproduções em Gravações). */
class Mosaico {
  constructor(area, aoMudar) {
    this.area = area;
    this.aoMudar = aoMudar || (() => {});
    this.quadros = new Map();
  }

  abrir(opts) {
    const q = new Quadro({ ...opts, aoFechar: (x) => { this.quadros.delete(x.chave); this.aoMudar(); } });
    const existente = this.quadros.get(q.chave);
    if (existente) existente.fechar();
    this.quadros.set(q.chave, q);
    this.area.append(q.root);
    this.aoMudar();
    q.abrir();
    return q;
  }

  alternar(opts) {
    const chave = `${opts.ident}:${opts.canal}`;
    const q = this.quadros.get(chave);
    if (q) { q.fechar(); return false; }
    this.abrir(opts);
    return true;
  }

  aberto(ident, canal) {
    return this.quadros.has(`${ident}:${canal}`);
  }

  reabrirTodos(mudanca) {
    const atuais = [...this.quadros.values()].filter((q) => !q.reproducao);
    for (const q of atuais) {
      const opts = { ident: q.ident, canal: q.canal, titulo: q.tituloBase, fluxo: q.fluxo, conv: q.conv, ...mudanca };
      q.fechar();
      this.abrir(opts);
    }
  }

  fecharTodos() {
    for (const q of [...this.quadros.values()]) q.fechar();
  }

  get tamanho() {
    return this.quadros.size;
  }
}
