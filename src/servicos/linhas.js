'use strict';
/**
 * FrotaGest — linhas e viagens: cada partida do dia vira uma viagem acompanhada pelo GPS do veículo.
 *
 *  - Começa quando o veículo sai do primeiro ponto (ou já chega ao segundo) perto do horário.
 *  - Em cada ponto: a hora real comparada com a prevista (partida + minutos do ponto) → no horário,
 *    adiantado ou atrasado, pela tolerância da linha. O trecho entre duas posições conta (quem passa
 *    rápido por um ponto, entre duas posições do GPS, não fica como "pulou").
 *  - Ponto que ficou para trás (o veículo chegou ao seguinte) = pulado.
 *  - Com o percurso gravado, sair do corredor (padrão 200 m) por 30 s abre o alerta "Fora da rota".
 *  - Não saiu até 60 min depois do horário = não realizada; não chegou ao fim = incompleta.
 * Reis Tecnologia
 */
const EventEmitter = require('events');
const { agora, formatar, paraMs } = require('../util/comum');
const { distM } = require('./geo');

const ANTES_MS = 30 * 60000; // a viagem pode começar até 30 min antes do horário...
const DEPOIS_MS = 60 * 60000; // ...e até 60 min depois; passou disso sem sair: não realizada
const FOLGA_SAIDA_M = 20; // para contar que saiu do ponto, passar 20 m do raio
const FORA_ROTA_MS = 30000;
const VELHA_MS = 10 * 60000; // posição que chega atrasada não mexe na viagem
const TICK_MS = 30000;
const SALTO_PONTOS = 2; // chegou até 2 pontos à frente: os do meio ficam como pulados

const hojeTexto = () => agora().slice(0, 10);
/** 1 = segunda ... 7 = domingo */
function diaSemana(data) {
  const [a, m, d] = data.split('-').map(Number);
  return ((new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}
const somarDia = (data, n) => { const [a, m, d] = data.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };

/** Projeção local (metros) para medir distância de ponto a segmento. */
function proj(lat0) {
  const k = Math.cos((lat0 * Math.PI) / 180) * 111320;
  return (la, lo) => [lo * k, la * 110540];
}

/** Distância (m) do ponto P ao segmento AB e a fração do caminho de A até o ponto mais perto. */
function distSegmento(p, a, b) {
  const pr = proj(p[0]);
  const [px, py] = pr(p[0], p[1]);
  const [ax, ay] = pr(a[0], a[1]);
  const [bx, by] = pr(b[0], b[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let f = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  f = Math.max(0, Math.min(1, f));
  return { d: Math.hypot(px - (ax + f * dx), py - (ay + f * dy)), f };
}

/** Menor distância (m) do ponto ao percurso (lista de [lat, lng]). */
function distPercurso(p, pts) {
  let min = Infinity;
  for (let i = 1; i < pts.length; i++) min = Math.min(min, distSegmento(p, pts[i - 1], pts[i]).d);
  if (pts.length === 1) min = distM(p[0], p[1], pts[0][0], pts[0][1]);
  return min;
}

/** Simplifica o trajeto (Douglas-Peucker) para guardar como percurso. */
function simplificar(pts, tolM = 15) {
  if (pts.length < 3) return pts.slice();
  const manter = new Uint8Array(pts.length);
  manter[0] = 1;
  manter[pts.length - 1] = 1;
  const pilha = [[0, pts.length - 1]];
  while (pilha.length) {
    const [i, j] = pilha.pop();
    let max = 0;
    let k = -1;
    for (let x = i + 1; x < j; x++) {
      const d = distSegmento(pts[x], pts[i], pts[j]).d;
      if (d > max) { max = d; k = x; }
    }
    if (max > tolM && k > 0) { manter[k] = 1; pilha.push([i, k], [k, j]); }
  }
  return pts.filter((_, i) => manter[i]);
}

class Linhas extends EventEmitter {
  constructor({ banco, frota, historico, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.historico = historico;
    this.log = log;
    this.linhas = new Map(); // id → linha { ..., pontos, partidas, percurso }
    this.viagens = new Map(); // id → viagem ativa (prevista / em andamento)
    this.porVeiculo = new Map(); // veiculo_id → Set(id)
    this.filas = new Map(); // viagem → promessa (gravações em ordem)
    this.diaGerado = null;
  }

  async iniciar() {
    await this.carregar();
    await this.gerarDia(hojeTexto());
    await this.carregarAtivas();
    this.timer = setInterval(() => this.tick().catch((e) => this.log('erro', `Linhas: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  parar() { clearInterval(this.timer); }

  async carregar() {
    const [ls, ps, pa] = await Promise.all([
      this.banco.query('SELECT * FROM linhas'),
      this.banco.query('SELECT * FROM linha_pontos ORDER BY linha_id, ordem'),
      this.banco.query('SELECT id, linha_id, horario, dias, veiculo_id, ativo FROM linha_partidas ORDER BY linha_id, horario'),
    ]);
    const nova = new Map();
    for (const l of ls) {
      let percurso = null;
      try { percurso = l.percurso ? JSON.parse(l.percurso) : null; } catch { percurso = null; }
      nova.set(l.id, { ...l, ativo: Boolean(l.ativo), percurso, pontos: [], partidas: [] });
    }
    for (const p of ps) { const l = nova.get(p.linha_id); if (l) l.pontos.push({ ...p, latitude: Number(p.latitude), longitude: Number(p.longitude) }); }
    for (const p of pa) {
      const l = nova.get(p.linha_id);
      const h = String(p.horario || '00:00:00');
      if (l) l.partidas.push({ ...p, horario: (h.length === 5 ? `${h}:00` : h).slice(0, 8), ativo: Boolean(p.ativo) });
    }
    this.linhas = nova;
  }

  rotuloLinha(l) { return l ? `${l.codigo ? `${l.codigo} · ` : ''}${l.nome}` : 'linha'; }

  /** Cria as viagens do dia (uma por partida que vale naquele dia da semana). */
  async gerarDia(data, linhaId = null) {
    const wd = String(diaSemana(data));
    const agoraMs = Date.now();
    let n = 0;
    for (const l of this.linhas.values()) {
      if (linhaId && l.id !== linhaId) continue;
      if (!l.ativo || l.pontos.length < 2) continue;
      for (const pa of l.partidas) {
        if (!pa.ativo || !pa.dias.includes(wd)) continue;
        const inicio = `${data} ${pa.horario}`;
        const ini = paraMs(inicio);
        if (ini + DEPOIS_MS < agoraMs) continue; // já passou da janela (linha criada no meio do dia, servidor parado)
        const pontos = l.pontos.map((p) => ({ ordem: p.ordem, nome: p.nome, previsto: formatar(ini + p.minutos * 60000) }));
        const fim = pontos[pontos.length - 1].previsto;
        const r = await this.banco.query(
          `INSERT IGNORE INTO viagens (empresa_id, linha_id, partida_id, data, previsto_inicio, previsto_fim, veiculo_id, veiculo_origem, situacao, pontos_total, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prevista', ?, ?)`,
          [l.empresa_id, l.id, pa.id, data, inicio, fim, pa.veiculo_id || null, pa.veiculo_id ? 'escala' : null, pontos.length, agora()]);
        if (!r.affectedRows) continue;
        await this.banco.query('INSERT INTO viagem_pontos (viagem_id, ordem, nome, previsto) VALUES ?', [pontos.map((p) => [r.insertId, p.ordem, p.nome, p.previsto])]);
        n++;
      }
    }
    if (!linhaId) this.diaGerado = data;
    return n;
  }

  /** Viagens de hoje e de ontem (as que passam da meia-noite) que ainda podem acontecer. */
  async carregarAtivas() {
    await Promise.all([...this.filas.values()]); // gravações na fila primeiro (viagem que acabou de terminar não volta)
    const ontem = somarDia(hojeTexto(), -1);
    const vs = await this.banco.query("SELECT * FROM viagens WHERE data >= ? AND situacao IN ('prevista','em_andamento')", [ontem]);
    const ids = vs.map((v) => v.id);
    const pts = ids.length ? await this.banco.query('SELECT * FROM viagem_pontos WHERE viagem_id IN (?) ORDER BY viagem_id, ordem', [ids]) : [];
    const porViagem = new Map();
    for (const p of pts) { if (!porViagem.has(p.viagem_id)) porViagem.set(p.viagem_id, []); porViagem.get(p.viagem_id).push(p); }
    const antigos = this.viagens;
    this.viagens = new Map();
    this.porVeiculo = new Map();
    for (const v of vs) {
      const velho = antigos.get(v.id);
      if (velho && ['prevista', 'em_andamento'].includes(velho.situacao)) {
        // já acompanhada: a memória está à frente do banco (gravação em fila); só o veículo pode ter mudado
        velho.veiculo_id = v.veiculo_id;
        velho.veiculo_origem = v.veiculo_origem;
        this.viagens.set(v.id, velho);
        if (v.veiculo_id) this.indexar(v.id, v.veiculo_id);
        continue;
      }
      const pontos = (porViagem.get(v.id) || []).map((p) => ({
        ordem: p.ordem, nome: p.nome, previsto: paraMs(p.previsto), realizado: p.realizado ? paraMs(p.realizado) : null, situacao: p.situacao, diferenca: p.diferenca_seg,
      }));
      const idx = pontos.findIndex((p) => p.situacao === 'pendente');
      const l = this.linhas.get(v.linha_id);
      this.viagens.set(v.id, {
        ...v, pontos, idx: idx < 0 ? pontos.length : idx, inicio: paraMs(v.previsto_inicio), fim: paraMs(v.previsto_fim),
        // os pontos da linha como estavam quando a viagem foi criada (a linha pode mudar no meio da viagem)
        def: l ? l.pontos.map((p) => ({ latitude: p.latitude, longitude: p.longitude, raio_m: p.raio_m })) : [],
        noInicio: false, ult: null, ultT: 0, foraDesde: null, foraAberto: false, avisouAtraso: false,
      });
      if (v.veiculo_id) this.indexar(v.id, v.veiculo_id);
    }
  }

  indexar(id, veiculoId) {
    if (!this.porVeiculo.has(veiculoId)) this.porVeiculo.set(veiculoId, new Set());
    this.porVeiculo.get(veiculoId).add(id);
  }

  desindexar(id, veiculoId) {
    const s = veiculoId && this.porVeiculo.get(veiculoId);
    if (s) s.delete(id);
  }

  /** A viagem que o veículo está fazendo (ou vai começar) agora. */
  viagemDe(veiculoId, t) {
    const ids = this.porVeiculo.get(veiculoId);
    if (!ids || !ids.size) return null;
    let andamento = null;
    let melhor = null;
    for (const id of ids) {
      const v = this.viagens.get(id);
      if (!v) continue;
      if (v.situacao === 'em_andamento') { andamento = v; continue; }
      if (v.situacao !== 'prevista' || t < v.inicio - ANTES_MS || t > v.inicio + DEPOIS_MS) continue;
      if (!melhor || Math.abs(t - v.inicio) < Math.abs(t - melhor.inicio)) melhor = v;
    }
    // a viagem anterior não chegou ao fim (pulou o último ponto) e já está na hora da próxima: fecha como incompleta
    if (andamento && melhor && melhor !== andamento && t > andamento.fim && t >= melhor.inicio - 10 * 60000) {
      this.fecharIncompleta(andamento);
      return melhor;
    }
    return andamento || melhor;
  }

  fecharIncompleta(v) {
    v.situacao = 'incompleta';
    v.fim_real = v.ult ? formatar(v.ultT) : null;
    this.encerrarFora(v);
    return this.gravar(v);
  }

  /** Fecha o alerta "fora da rota" que ficou aberto (viagem terminou, foi cancelada ou mudou de veículo). */
  encerrarFora(v) {
    if (!v.foraAberto) return;
    v.foraAberto = false;
    v.foraDesde = null;
    const ve = this.frota.veiculos.get(v.veiculo_id);
    const ap = ve && ve.aparelho_id ? this.frota.aparelhos.get(ve.aparelho_id) : null;
    const info = ap ? this.frota.info(ap.identificador) : null;
    if (info) this.historico.encerrarExterno(info, `l${v.linha_id}r`, agora());
  }

  /* ---------- posição do GPS ---------- */

  posicao(ident, p, r) {
    if (!r || !r.gps) return;
    const info = this.frota.info(ident);
    if (!info || !info.veiculo) return;
    const t = paraMs(r.dataHora);
    if (!Number.isFinite(t) || Date.now() - t > VELHA_MS) return;
    const v = this.viagemDe(info.veiculo.id, t);
    if (!v || t < v.ultT) return;
    const l = this.linhas.get(v.linha_id);
    if (!l || v.def.length !== v.pontos.length || v.def.length < 2) return;
    const pos = [Number(p.lat), Number(p.lon)];
    const ant = v.ult && t - v.ultT < 5 * 60000 ? v.ult : null; // posição anterior (trecho entre as duas)
    const mudou = v.situacao === 'prevista' ? this.antesDeSair(v, l, pos, ant, t) : this.emAndamento(v, l, pos, ant, t, info, p);
    v.ult = pos;
    v.ultT = t;
    if (mudou) this.gravar(v, info);
  }

  /** Passou pelo ponto entre a posição anterior e esta? Devolve a hora (interpolada) ou null. */
  passou(pt, pos, ant, t, antT) {
    const alvo = [pt.latitude, pt.longitude];
    if (distM(pos[0], pos[1], alvo[0], alvo[1]) <= pt.raio_m) return t;
    if (!ant) return null;
    const s = distSegmento(alvo, ant, pos);
    return s.d <= pt.raio_m ? Math.round(antT + (t - antT) * s.f) : null;
  }

  antesDeSair(v, l, pos, ant, t) {
    const p0 = v.def[0];
    const d0 = distM(pos[0], pos[1], p0.latitude, p0.longitude);
    if (d0 <= p0.raio_m) { v.noInicio = true; return false; }
    if (v.noInicio && d0 > p0.raio_m + FOLGA_SAIDA_M && t >= v.inicio - ANTES_MS) {
      // saiu do primeiro ponto: partiu
      this.iniciar_(v, t);
      this.marcar(v, l, 0, t);
      v.idx = 1;
      this.avancar(v, l, pos, ant, t); // já passou pelo ponto seguinte no mesmo trecho
      return true;
    }
    // não vimos a saída (GPS ligou depois): começou se já está no ponto seguinte
    if (v.def.length > 2) {
      const tp = this.passou(v.def[1], pos, ant, t, v.ultT);
      if (tp !== null) {
        this.iniciar_(v, tp);
        v.pontos[0].situacao = 'pulado';
        v.idx = 1;
        this.marcar(v, l, 1, tp);
        v.idx = 2;
        return true;
      }
    }
    return false;
  }

  iniciar_(v, t) {
    v.situacao = 'em_andamento';
    v.inicio_real = formatar(t);
  }

  /** Hora real no ponto i: compara com a prevista e marca a situação. */
  marcar(v, l, i, t) {
    const p = v.pontos[i];
    p.realizado = t;
    p.diferenca = Math.round((t - p.previsto) / 1000);
    p.situacao = p.diferenca < -l.tolerancia_adiantado_min * 60 ? 'adiantado' : p.diferenca > l.tolerancia_atraso_min * 60 ? 'atrasado' : 'no_horario';
    v.atraso_atual_seg = p.diferenca;
    v.atraso_max_seg = Math.max(v.atraso_max_seg ?? -Infinity, p.diferenca);
    p.mudou = true;
  }

  /** Procura o próximo ponto (ou até 2 adiante) no trecho; devolve se avançou. */
  avancar(v, l, pos, ant, t) {
    let avancou = false;
    const pts = v.def;
    for (let volta = 0; volta < pts.length && v.idx < pts.length; volta++) {
      let achou = -1;
      let tp = null;
      const ultimo = pts.length - 1;
      for (let j = v.idx; j <= Math.min(v.idx + SALTO_PONTOS, ultimo); j++) {
        // o fim da linha só por salto quando já passou metade do tempo previsto (linha que volta ao terminal)
        if (j === ultimo && j > v.idx && t < v.inicio + (v.fim - v.inicio) / 2) continue;
        tp = this.passou(pts[j], pos, ant, t, v.ultT || t);
        if (tp !== null) { achou = j; break; }
      }
      if (achou < 0) break;
      for (let k = v.idx; k < achou; k++) { v.pontos[k].situacao = 'pulado'; v.pontos[k].mudou = true; v.pulouAgora = (v.pulouAgora || []).concat(k); }
      this.marcar(v, l, achou, tp);
      v.idx = achou + 1;
      avancou = true;
      if (v.idx >= pts.length) { v.situacao = 'concluida'; v.fim_real = formatar(tp); break; }
    }
    return avancou;
  }

  emAndamento(v, l, pos, ant, t, info, p) {
    let mudou = this.avancar(v, l, pos, ant, t);
    // fora da rota (só com o percurso gravado)
    if (l.percurso && l.percurso.length > 1 && v.situacao === 'em_andamento') {
      const d = distPercurso(pos, l.percurso);
      if (d > l.corredor_m) {
        if (v.ultT && v.foraDesde !== null) { v.fora_rota_seg = (v.fora_rota_seg || 0) + Math.round((t - v.ultT) / 1000); mudou = true; }
        if (v.foraDesde === null) v.foraDesde = t;
        if (!v.foraAberto && t - v.foraDesde >= FORA_ROTA_MS) {
          v.foraAberto = true;
          if (l.alerta_fora_rota) {
            this.historico.abrirExterno(info, `l${l.id}r`, { nome: `Fora da rota: ${this.rotuloLinha(l)}`, gravidade: 'media', dataHora: formatar(t), lat: pos[0], lng: pos[1], vel: p.speed });
          }
          mudou = true;
        }
      } else if (d <= l.corredor_m * 0.8) {
        v.foraDesde = null;
        if (v.foraAberto) { v.foraAberto = false; this.historico.encerrarExterno(info, `l${l.id}r`, formatar(t)); mudou = true; }
      }
    }
    if (v.situacao === 'concluida' && v.foraAberto) { v.foraAberto = false; this.historico.encerrarExterno(info, `l${l.id}r`, formatar(t)); }
    // avisos pontuais: atraso acima do limite da linha (uma vez por viagem) e ponto pulado
    if (mudou && l.alerta_atraso_min && !v.avisouAtraso && v.atraso_atual_seg !== null && v.atraso_atual_seg > l.alerta_atraso_min * 60) {
      v.avisouAtraso = true;
      const pt = v.pontos[v.idx - 1];
      this.historico.alertaPontual(info, `l${l.id}a`, {
        nome: `Atraso de ${Math.round(v.atraso_atual_seg / 60)} min: ${this.rotuloLinha(l)} (${pt ? pt.nome : ''})`, gravidade: 'baixa', dataHora: formatar(t), lat: pos[0], lng: pos[1], vel: p.speed,
      });
    }
    if (v.pulouAgora && v.pulouAgora.length) {
      if (l.alerta_ponto_pulado) {
        this.historico.alertaPontual(info, `l${l.id}p`, {
          nome: `Não passou no ponto ${v.pulouAgora.map((k) => v.pontos[k].nome).join(', ')}: ${this.rotuloLinha(l)}`.slice(0, 80), gravidade: 'baixa', dataHora: formatar(t), lat: pos[0], lng: pos[1], vel: p.speed,
        });
      }
      v.pulouAgora = null;
    }
    return mudou;
  }

  /* ---------- gravar e relógio ---------- */

  resumo(v) {
    v.pontos_passados = v.pontos.filter((p) => p.realizado !== null).length;
    v.pontos_pulados = v.pontos.filter((p) => p.situacao === 'pulado').length;
  }

  gravar(v, info = null) {
    this.resumo(v);
    const pontos = v.pontos.filter((p) => p.mudou);
    for (const p of pontos) p.mudou = false;
    const linha = [v.situacao, v.inicio_real || null, v.fim_real || null, v.pontos_passados, v.pontos_pulados, v.atraso_atual_seg ?? null,
      Number.isFinite(v.atraso_max_seg) ? v.atraso_max_seg : null, v.fora_rota_seg || 0, agora(), v.id];
    const anterior = this.filas.get(v.id) || Promise.resolve();
    const prox = anterior.then(async () => {
      await this.banco.query(`UPDATE viagens SET situacao = ?, inicio_real = ?, fim_real = ?, pontos_passados = ?, pontos_pulados = ?, atraso_atual_seg = ?,
        atraso_max_seg = ?, fora_rota_seg = ?, atualizado_em = ? WHERE id = ?`, linha);
      for (const p of pontos) {
        await this.banco.query('UPDATE viagem_pontos SET realizado = ?, situacao = ?, diferenca_seg = ? WHERE viagem_id = ? AND ordem = ?',
          [p.realizado !== null ? formatar(p.realizado) : null, p.situacao, p.diferenca ?? null, v.id, p.ordem]);
      }
    }).catch((e) => this.log('erro', `Linhas: não gravou a viagem ${v.id} (${e.message})`));
    this.filas.set(v.id, prox);
    prox.then(() => { if (this.filas.get(v.id) === prox) this.filas.delete(v.id); });
    if (!['prevista', 'em_andamento'].includes(v.situacao)) {
      this.viagens.delete(v.id);
      this.desindexar(v.id, v.veiculo_id);
    }
    this.emit('mudou', v.empresa_id, v.id);
    return prox;
  }

  async tick() {
    const hoje = hojeTexto();
    if (this.diaGerado !== hoje) {
      await this.gerarDia(hoje);
      await this.carregarAtivas();
    }
    const t = Date.now();
    for (const v of [...this.viagens.values()]) {
      if (v.situacao === 'prevista' && t > v.inicio + DEPOIS_MS) {
        v.situacao = 'nao_realizada';
        this.gravar(v);
      } else if (v.situacao === 'em_andamento' && t > v.fim + Math.max(30 * 60000, (v.fim - v.inicio) / 2)) {
        this.fecharIncompleta(v);
      }
    }
  }

  /** A linha mudou: as viagens previstas de hoje (ainda não começadas) são refeitas com os pontos e horários novos. */
  async linhaMudou(linhaId) {
    await this.carregar();
    const hoje = hojeTexto();
    const velhas = await this.banco.query("SELECT id, partida_id, veiculo_id, veiculo_origem FROM viagens WHERE linha_id = ? AND data = ? AND situacao = 'prevista'", [linhaId, hoje]);
    // o veículo trocado à mão hoje continua na viagem refeita
    const trocas = velhas.filter((x) => x.veiculo_origem === 'troca' && x.partida_id);
    if (velhas.length) {
      const ids = velhas.map((x) => x.id);
      await this.banco.query('DELETE FROM viagem_pontos WHERE viagem_id IN (?)', [ids]);
      await this.banco.query('DELETE FROM viagens WHERE id IN (?)', [ids]);
    }
    await this.gerarDia(hoje, linhaId);
    for (const x of trocas) {
      await this.banco.query("UPDATE viagens SET veiculo_id = ?, veiculo_origem = 'troca' WHERE partida_id = ? AND data = ? AND situacao = 'prevista'", [x.veiculo_id, x.partida_id, hoje]);
    }
    await this.carregarAtivas();
    this.emit('mudou', (this.linhas.get(linhaId) || {}).empresa_id || null, null);
  }

  async trocarVeiculo(viagemId, veiculoId) {
    const v = this.viagens.get(viagemId);
    if (!v) throw new Error('Esta viagem já terminou: não dá para trocar o veículo.');
    this.encerrarFora(v);
    this.desindexar(v.id, v.veiculo_id);
    v.veiculo_id = veiculoId || null;
    v.veiculo_origem = veiculoId ? 'troca' : null;
    v.noInicio = false;
    v.ult = null;
    v.ultT = 0;
    if (veiculoId) this.indexar(v.id, veiculoId);
    await this.banco.query('UPDATE viagens SET veiculo_id = ?, veiculo_origem = ?, atualizado_em = ? WHERE id = ?', [v.veiculo_id, v.veiculo_origem, agora(), v.id]);
    this.emit('mudou', v.empresa_id, v.id);
  }

  async cancelar(viagemId, motivo) {
    const v = this.viagens.get(viagemId);
    if (!v) throw new Error('Esta viagem já terminou.');
    this.encerrarFora(v);
    v.situacao = 'cancelada';
    await this.banco.query('UPDATE viagens SET observacao = ? WHERE id = ?', [motivo, v.id]);
    await this.gravar(v);
  }
}

module.exports = { Linhas, simplificar, distPercurso, distSegmento, diaSemana };
