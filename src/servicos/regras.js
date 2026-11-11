'use strict';
/**
 * FrotaGest — regras de alerta da empresa, conferidas no servidor a cada posição (e a cada 20 s para
 * o que depende só do tempo passar: parada longa, motor ligado parado, aparelho que caiu).
 *
 *  velocidade    acima do limite por mais de N segundos (opcional: só dentro de uma cerca)
 *  fora_horario  veículo em uso (ignição ligada ou andando) fora dos dias/horário permitidos
 *  parada        parado há mais de N minutos fora das garagens (e, se marcado, dos pontos/terminais)
 *  ociosidade    motor ligado com o veículo parado há mais de N minutos
 *  sem_comunicacao  o aparelho parou de falar há mais de N minutos (por padrão, só se estava ligado)
 *
 * Vale a regra mais específica para cada veículo: a do veículo, senão a do grupo mais próximo, senão
 * a da empresa toda. Dentro de uma cerca com limite próprio, vale o limite da cerca.
 * O alerta fica aberto enquanto a situação durar (código "r<id da regra>") e fecha sozinho depois.
 * Reis Tecnologia
 */
const { distM, dentroDoHorario } = require('./geo');
const { formatar, paraMs } = require('../util/comum');

const TIPOS = {
  velocidade: { nome: 'Excesso de velocidade', gravidade: 'media', tempoSeg: 20 },
  fora_horario: { nome: 'Uso fora do horário', gravidade: 'alta', tempoSeg: 60 },
  parada: { nome: 'Parada longa fora da garagem', gravidade: 'media', tempoSeg: 1800 },
  ociosidade: { nome: 'Motor ligado parado', gravidade: 'baixa', tempoSeg: 600 },
  sem_comunicacao: { nome: 'Sem comunicação', gravidade: 'alta', tempoSeg: 600 },
};

const PARADO_KMH = 3; // igual aos relatórios
const ANDANDO_KMH = 10; // acima disto o veículo saiu do lugar (entre 3 e 10 é ruído do GPS parado)
const RAIO_PARADA_M = 150;
const VELHA_MS = 10 * 60000; // posição que chegou atrasada (lote de área sem sinal): atualiza, mas não abre alerta
const SEM_POSICAO_MS = 5 * 60000; // sem posição há 5 min: excesso de velocidade não continua aberto
const PARADA_SEM_CONTATO_MS = 24 * 3600000; // aparelho sem contato há mais de 1 dia: não abre parada nova
const TICK_MS = 20000;
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const RE_CODIGO = /^r(\d+)$/;

function fmtTempo(seg) {
  if (seg < 60) return `${seg} s`;
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "seg a sex" / "todos os dias" / "seg, qua, sex" */
function textoDias(dias) {
  const l = [...dias].sort((a, b) => a - b);
  if (l.length === 7) return 'todos os dias';
  const seq = l.length > 2 && l.every((d, i) => i === 0 || d === l[i - 1] + 1);
  if (seq) return `${DIAS[l[0]]} a ${DIAS[l[l.length - 1]]}`;
  return l.map((d) => DIAS[d]).join(', ');
}

function daLinha(r) {
  const dias = new Set(String(r.dias || '').split(',').filter((x) => /^[0-6]$/.test(x)).map(Number));
  return {
    id: r.id, empresaId: r.empresa_id, tipo: r.tipo, grupoId: r.grupo_id || null, veiculoId: r.veiculo_id || null, cercaId: r.cerca_id || null,
    limite: r.limite_kmh === null || r.limite_kmh === undefined ? null : Number(r.limite_kmh), tempoSeg: Number(r.tempo_seg) || 0,
    dias, inicio: r.horario_inicio || null, fim: r.horario_fim || null,
    ignorarGaragem: Boolean(r.ignorar_garagem), ignorarPonto: Boolean(r.ignorar_ponto),
    soLigado: r.so_ligado === undefined || r.so_ligado === null ? true : Boolean(r.so_ligado),
    gravidade: r.gravidade || TIPOS[r.tipo].gravidade, ativo: Boolean(r.ativo),
  };
}

/** Dia da semana (0 = domingo) de 'AAAA-MM-DD'. */
function diaDaSemana(data) {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

/** O horário/dia permite o uso? Janela que passa da meia-noite (22:00–06:00) conta no dia em que começou. */
function permitido(r, ms) {
  const t = formatar(ms);
  const hhmm = t.slice(11, 16);
  let dia = diaDaSemana(t.slice(0, 10));
  if (r.inicio > r.fim && hhmm <= r.fim) dia = (dia + 6) % 7;
  return r.dias.has(dia) && dentroDoHorario(hhmm, r.inicio, r.fim);
}

class Regras {
  constructor({ banco, frota, historico, cercas, gateway = null, log = () => {} }) {
    this.banco = banco;
    this.frota = frota;
    this.historico = historico;
    this.cercas = cercas;
    this.gateway = gateway;
    this.log = log;
    this.lista = new Map(); // id → regra ativa
    this.cache = new Map(); // veículo → regras que valem para ele, com a especificidade
    this.estados = new Map(); // aparelho_id → situação acompanhada
    this.timer = null;
  }

  async carregar() {
    const rows = await this.banco.query('SELECT * FROM regras_alerta WHERE ativo = 1');
    this.lista = new Map(rows.map((r) => [r.id, daLinha(r)]));
    this.cache = new Map();
    this.fecharOrfaos();
  }

  /** Começa a conferência periódica. As paradas já em andamento vêm do último estado gravado. */
  iniciar() {
    for (const [apId, e] of this.historico.estados) {
      if (e.latitude === null || e.latitude === undefined || !e.ultima_posicao_em) continue;
      const t = paraMs(e.ultima_posicao_em);
      if (!Number.isFinite(t) || Date.now() - t > PARADA_SEM_CONTATO_MS) continue;
      const st = this.estado(apId);
      st.t = t;
      st.lat = Number(e.latitude);
      st.lng = Number(e.longitude);
      st.vel = Number(e.velocidade) || 0;
      st.ign = Boolean(e.ignicao);
      st.contato = paraMs(e.ultimo_contato) || t;
      st.recebido = t;
      if (st.vel <= PARADO_KMH) st.parada = { desde: t, lat: st.lat, lng: st.lng };
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  parar() {
    clearInterval(this.timer);
  }

  frotaMudou() {
    this.cache = new Map();
  }

  estado(apId) {
    let st = this.estados.get(apId);
    if (!st) {
      st = { t: 0, contato: 0, recebido: 0, lat: null, lng: null, vel: 0, ign: false, gps: false, online: false, exc: null, foraDesde: null, parada: null, ociosoDesde: null };
      this.estados.set(apId, st);
    }
    return st;
  }

  /* ---------- quais regras valem para cada veículo ---------- */

  profundidade(grupoId) {
    let n = 0;
    let g = this.frota.grupos.get(grupoId);
    const vistos = new Set();
    while (g && g.pai_id && !vistos.has(g.id)) { vistos.add(g.id); n++; g = this.frota.grupos.get(g.pai_id); }
    return n;
  }

  /** -1 = não vale para o veículo; quanto maior, mais específica. */
  especificidade(r, v) {
    if (r.empresaId !== v.empresa_id) return -1;
    if (r.veiculoId) return r.veiculoId === v.id ? 1000 : -1;
    if (r.grupoId) {
      if (!v.grupo_id || !this.frota.descendentes(r.grupoId).has(v.grupo_id)) return -1;
      return 100 + this.profundidade(r.grupoId);
    }
    return 0;
  }

  doVeiculo(v) {
    const k = `${v.id}:${v.empresa_id}:${v.grupo_id}`;
    let l = this.cache.get(k);
    if (l) return l;
    l = [];
    for (const r of this.lista.values()) {
      const esp = this.especificidade(r, v);
      if (esp >= 0) l.push({ r, esp });
    }
    this.cache.set(k, l);
    if (this.cache.size > 20000) this.cache.clear();
    return l;
  }

  /** A regra que vale agora para o veículo, de um tipo (dentro = ids das cercas em que ele está). */
  efetiva(v, tipo, dentro = new Set()) {
    const melhor = (lista) => {
      let x = null;
      for (const c of lista) {
        if (!x || c.esp > x.esp || (c.esp === x.esp && (c.r.limite ?? 0) < (x.r.limite ?? 0)) || (c.esp === x.esp && c.r.limite === x.r.limite && c.r.id < x.r.id)) x = c;
      }
      return x ? x.r : null;
    };
    const doTipo = this.doVeiculo(v).filter((c) => c.r.tipo === tipo);
    if (tipo === 'velocidade') {
      const naCerca = doTipo.filter((c) => c.r.cercaId && dentro.has(c.r.cercaId) && this.cercas.lista.has(c.r.cercaId));
      if (naCerca.length) return melhor(naCerca);
    }
    return melhor(doTipo.filter((c) => !c.r.cercaId));
  }

  /** Limite de velocidade do veículo fora das cercas (dashboard); null = sem regra. */
  limiteDe(veiculoId) {
    const v = this.frota.veiculos.get(veiculoId);
    if (!v) return null;
    const r = this.efetiva(v, 'velocidade');
    return r ? r.limite : null;
  }

  /* ---------- posições e conexões ---------- */

  /** Nova posição de um aparelho (r = o que o histórico devolveu: hora e GPS). Chamar depois das cercas. */
  posicao(ident, p, r) {
    if (!r) return;
    const info = this.frota.info(ident);
    if (!info || !info.veiculo) return;
    const t = paraMs(r.dataHora);
    const st = this.estado(info.aparelho.id);
    st.contato = Date.now();
    st.recebido = Date.now();
    st.online = true;
    if (!Number.isFinite(t) || t < st.t) return; // posição atrasada não volta o veículo no tempo
    const vel = Math.max(0, Number(p.speed) || 0);
    const ign = Boolean(p.flags && p.flags.ignicao);
    st.t = t;
    st.vel = vel;
    st.ign = ign;
    st.gps = Boolean(r.gps);
    if (r.gps) {
      st.lat = Number(p.lat);
      st.lng = Number(p.lon);
      // parada: abaixo de 3 km/h no mesmo lugar; acima de 10 km/h ou a mais de 150 m, saiu
      if (vel <= PARADO_KMH) {
        if (!st.parada || distM(st.parada.lat, st.parada.lng, st.lat, st.lng) > RAIO_PARADA_M) st.parada = { desde: t, lat: st.lat, lng: st.lng };
      } else if (vel > ANDANDO_KMH || (st.parada && distM(st.parada.lat, st.parada.lng, st.lat, st.lng) > RAIO_PARADA_M)) {
        st.parada = null;
      }
    }
    st.ociosoDesde = ign && st.parada ? (st.ociosoDesde ?? t) : null;
    this.avaliar(info, st, t, Date.now() - t <= VELHA_MS, 'posicao');
  }

  /** O aparelho caiu ou voltou. */
  conexao(ident, online) {
    const info = this.frota.info(ident);
    if (!info || !info.veiculo) return;
    const st = this.estados.get(info.aparelho.id);
    if (!st) return;
    st.online = online;
    if (online) st.contato = Date.now();
    this.avaliar(info, st, Date.now(), true, 'conexao');
  }

  tick() {
    const agora = Date.now();
    for (const [apId, st] of this.estados) {
      const ap = this.frota.aparelhos.get(apId);
      const info = ap ? this.frota.info(ap.identificador) : null;
      if (!info || !info.veiculo) {
        this.fecharTodos(apId);
        continue;
      }
      const dev = this.gateway && this.gateway.devices.get(ap.identificador);
      st.online = Boolean(dev && dev.online);
      if (st.online && dev.lastSeen) st.contato = Math.max(st.contato, dev.lastSeen);
      try { this.avaliar(info, st, Math.max(agora, st.t), true, 'tick'); } catch (e) { this.log('erro', `Regras de alerta: ${e.message}`); }
    }
  }

  /* ---------- conferência ---------- */

  avaliar(info, st, agoraMs, podeAbrir, origem) {
    const apId = info.aparelho.id;
    const v = info.veiculo;
    const dentro = this.cercas.dentro(apId);
    const ids = new Set(dentro.map((c) => c.id));
    const fins = new Set(dentro.map((c) => c.finalidade));
    const abertos = this.historico.abertos.get(apId);
    const aberto = (codigo) => Boolean(abertos && abertos.has(codigo));
    const semPosicao = !st.online || Date.now() - st.recebido > SEM_POSICAO_MS;

    for (const tipo of Object.keys(TIPOS)) {
      const r = this.efetiva(v, tipo, ids);
      const codigo = r ? `r${r.id}` : null;
      let cond = false; // a situação está acontecendo agora?
      let quando = agoraMs; // hora do alerta (quando passou do tempo)
      let nome = '';

      if (tipo === 'velocidade') {
        if (!r) {
          st.exc = null;
        } else if (origem === 'posicao' && st.gps) {
          if (st.vel > r.limite) {
            if (!st.exc || st.exc.regra !== r.id) st.exc = { regra: r.id, desde: st.t, max: st.vel };
            st.exc.max = Math.max(st.exc.max, st.vel);
            cond = st.t - st.exc.desde >= r.tempoSeg * 1000;
            quando = st.t;
          } else {
            st.exc = null;
          }
        } else if (aberto(codigo) && !semPosicao) {
          cond = true; // posição sem GPS, ou entre uma posição e outra: continua como estava
        } else if (semPosicao) {
          st.exc = null;
        }
        if (r) {
          const c = r.cercaId ? this.cercas.lista.get(r.cercaId) : null;
          nome = `Excesso de velocidade${c ? ` em ${c.nome}` : ''} (limite ${r.limite} km/h)`;
        }
      } else if (tipo === 'fora_horario') {
        const emUso = st.online !== false && (st.ign || st.vel >= ANDANDO_KMH) && !(origem !== 'posicao' && semPosicao);
        if (r && emUso && !permitido(r, agoraMs)) {
          st.foraDesde = st.foraDesde ?? agoraMs;
          cond = agoraMs - st.foraDesde >= r.tempoSeg * 1000;
          quando = st.foraDesde + r.tempoSeg * 1000;
        } else {
          st.foraDesde = null;
        }
        if (r) nome = `Uso fora do horário (permitido ${textoDias(r.dias)}, ${r.inicio}–${r.fim})`;
      } else if (tipo === 'parada') {
        if (r && st.parada && !(r.ignorarGaragem && fins.has('garagem')) && !(r.ignorarPonto && fins.has('ponto'))) {
          const dur = agoraMs - st.parada.desde;
          cond = dur >= r.tempoSeg * 1000;
          quando = st.parada.desde + r.tempoSeg * 1000;
          // aparelho sem contato há muito tempo (retirado, quebrado): não abre parada nova
          if (cond && !aberto(codigo) && Date.now() - st.contato > PARADA_SEM_CONTATO_MS) cond = false;
        }
        if (r) {
          const onde = r.ignorarGaragem && r.ignorarPonto ? ' fora da garagem e dos pontos' : r.ignorarGaragem ? ' fora da garagem' : r.ignorarPonto ? ' fora dos pontos' : '';
          nome = `Parado${onde} há mais de ${fmtTempo(r.tempoSeg)}`;
        }
      } else if (tipo === 'ociosidade') {
        if (semPosicao && origem !== 'posicao') st.ociosoDesde = null;
        if (r && st.ociosoDesde !== null && !(r.ignorarGaragem && fins.has('garagem')) && !(r.ignorarPonto && fins.has('ponto'))) {
          cond = agoraMs - st.ociosoDesde >= r.tempoSeg * 1000;
          quando = st.ociosoDesde + r.tempoSeg * 1000;
        }
        if (r) nome = `Motor ligado parado há mais de ${fmtTempo(r.tempoSeg)}`;
      } else if (tipo === 'sem_comunicacao') {
        const silencio = Date.now() - st.contato;
        if (r && st.contato && (!r.soLigado || st.ign) && silencio >= r.tempoSeg * 1000) {
          cond = true;
          quando = st.contato + r.tempoSeg * 1000;
          // calado há mais de 1 dia (aparelho retirado, veículo parado na oficina): fica para a Saúde dos aparelhos
          if (!aberto(codigo) && silencio > PARADA_SEM_CONTATO_MS) cond = false;
        }
        if (r) nome = `Sem comunicação há mais de ${fmtTempo(r.tempoSeg)}${r.soLigado ? ' (estava ligado)' : ''}`;
      }

      // fecha os alertas deste tipo que não valem mais (situação acabou ou outra regra passou a valer)
      if (abertos) {
        for (const c of [...abertos.keys()]) {
          const m = RE_CODIGO.exec(c);
          if (!m) continue;
          const regra = this.lista.get(Number(m[1]));
          if (regra && regra.tipo !== tipo) continue;
          if (regra && c === codigo && cond) continue;
          this.fechar(info, c, regra, st);
        }
      }
      if (cond && podeAbrir && !aberto(codigo)) {
        this.historico.abrirExterno(info, codigo, {
          nome, gravidade: r.gravidade, dataHora: formatar(Math.min(quando, Date.now())),
          lat: st.lat, lng: st.lng, vel: tipo === 'velocidade' && st.exc ? st.exc.max : st.vel,
        });
      }
    }
  }

  fechar(info, codigo, regra, st) {
    const abertos = this.historico.abertos.get(info.aparelho.id);
    const entry = abertos && abertos.get(codigo);
    if (!entry) return;
    // excesso: guarda a maior velocidade do trecho no alerta
    if (regra && regra.tipo === 'velocidade' && st && st.exc && st.exc.regra === regra.id && entry.promessa) {
      const max = st.exc.max;
      entry.promessa.then((id) => this.banco.query('UPDATE alertas SET velocidade = GREATEST(COALESCE(velocidade, 0), ?) WHERE id = ?', [Math.min(9999.9, max), id])).catch(() => {});
    }
    // fim: a hora da última posição (o aparelho caiu, o veículo andou), nunca antes do início
    let fim = formatar(st && st.t ? Math.min(st.t, Date.now()) : Date.now());
    if (entry.inicio && fim < String(entry.inicio)) fim = String(entry.inicio);
    this.historico.encerrarExterno(info, codigo, fim);
  }

  /** Aparelho sem veículo (ou desativado): fecha o que estiver aberto pelas regras. */
  fecharTodos(apId) {
    const abertos = this.historico.abertos.get(apId);
    if (!abertos) return;
    const info = this.infoMinima(apId);
    if (!info) return;
    for (const c of [...abertos.keys()]) if (RE_CODIGO.test(c)) this.historico.encerrarExterno(info, c, formatar(Date.now()));
  }

  /** Regra apagada ou desativada: fecha os alertas dela que ficaram abertos. */
  fecharOrfaos() {
    for (const [apId, abertos] of this.historico.abertos) {
      const orfaos = [...abertos.keys()].filter((c) => { const m = RE_CODIGO.exec(c); return m && !this.lista.has(Number(m[1])); });
      if (!orfaos.length) continue;
      const info = this.infoMinima(apId);
      if (!info) continue;
      for (const c of orfaos) this.historico.encerrarExterno(info, c, formatar(Date.now()));
    }
  }

  infoMinima(apId) {
    const ap = this.frota.aparelhos.get(apId);
    if (!ap) return null;
    return { aparelho: ap, empresa: this.frota.empresas.get(ap.empresa_id) || { id: ap.empresa_id }, veiculo: this.frota.veiculoDoAparelho.get(apId) || null };
  }

  resumo() {
    return { regras: this.lista.size, acompanhados: this.estados.size };
  }
}

module.exports = { Regras, TIPOS, daLinha, permitido, textoDias, fmtTempo };
