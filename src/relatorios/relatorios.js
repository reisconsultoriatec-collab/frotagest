'use strict';
/**
 * FrotaGest — relatórios da frota: resumo por veículo, excessos de velocidade, paradas e alertas.
 * Calculados a partir das posições e dos alertas guardados no banco, sempre respeitando o que
 * cada usuário pode ver (empresa e grupos). Saem na tela, em Excel e em PDF.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, paraMs, formatar } = require('../util/comum');
const { empresaAlvo, limitado, permite } = require('../auth/acesso');
const { Rastreio, distM, FOLGA_M } = require('../servicos/geo');

const PARADO_KMH = 3; // até 3 km/h conta como parado (o GPS oscila com o veículo parado)
const LACUNA_SEG = 600; // mais de 10 min sem posição: o intervalo não entra nos tempos
const RAIO_PARADA_KM = 0.15; // posições a menos de 150 m contam como o mesmo lugar
const JUNTAR_EXCESSO_SEG = 60; // dois excessos separados por até 1 min viram um só
const ORCAMENTO = 400; // veículos × dias por relatório de posições (ex.: 363 veículos por 1 dia)
const MAX_DIAS = 31;
const MAX_DIAS_ALERTAS = 92;
const MAX_LINHAS = 20000;
const CACHE_MS = 10 * 60000;

const TIPOS = {
  resumo: { titulo: 'Resumo por veículo', arquivo: 'resumo-por-veiculo' },
  velocidade: { titulo: 'Excessos de velocidade', arquivo: 'excessos-de-velocidade' },
  paradas: { titulo: 'Paradas', arquivo: 'paradas' },
  alertas: { titulo: 'Alertas no período', arquivo: 'alertas' },
  garagem: { titulo: 'Saídas e chegadas na garagem', arquivo: 'saidas-e-chegadas-na-garagem' },
  cercas: { titulo: 'Entradas e saídas das cercas', arquivo: 'entradas-e-saidas-das-cercas' },
  jornada: { titulo: 'Jornada dos motoristas', arquivo: 'jornada-dos-motoristas' },
  motoristas: { titulo: 'Resumo por motorista', arquivo: 'resumo-por-motorista' },
  viagens: { titulo: 'Cumprimento das viagens', arquivo: 'cumprimento-das-viagens' },
};
const NOVA_JORNADA_SEG = 8 * 3600; // sem dirigir por 8 h ou mais: começa outra jornada (Lei do Motorista: 8 h seguidas do descanso de 11 h)
const DESCANSO_DIARIO_SEG = 11 * 3600;
const NOMES_FINALIDADE = { garagem: 'Garagem', ponto: 'Ponto ou terminal', area: 'Área de interesse', proibida: 'Área proibida' };

/* ---------- formatação (PDF e textos) ---------- */

const p2 = (n) => String(n).padStart(2, '0');
const fmtNum = (n, casas = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
function fmtDataHora(t, segundos = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}${segundos ? `:${m[6]}` : ''}` : String(t || '');
}
function fmtDuracao(seg) {
  if (seg === null || seg === undefined || !Number.isFinite(Number(seg))) return '';
  const s = Math.max(0, Math.round(seg));
  return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}
function fmtValor(v, tipo) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string' && tipo !== 'dataHora' && tipo !== 'texto') return v; // rótulos na linha de totais
  switch (tipo) {
    case 'inteiro': return fmtNum(v, 0);
    case 'decimal': return fmtNum(v, 1);
    case 'dataHora': return fmtDataHora(v);
    case 'duracao': return fmtDuracao(v);
    default: return String(v);
  }
}

/* ---------- cálculo ---------- */

function distanciaKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const coord = (la, lo) => (Number.isFinite(la) && Number.isFinite(lo) ? `${la.toFixed(5)}, ${lo.toFixed(5)}` : '');

/**
 * Passa as posições de um veículo pelas cercas (o mesmo cálculo dos avisos ao vivo) e chama
 * aoEvento({ cerca, tipo, dataHora, t, km, rastreio }) a cada entrada/saída. "anterior" é a última
 * posição antes do período: diz onde o veículo estava no começo, sem gerar evento.
 * Devolve o rastreio (com onde ficou no fim), os km rodados e se havia posição.
 */
function percorrerCercas(rows, cercas, anterior, aoEvento, aoComecar = null) {
  const r = new Rastreio();
  let km = 0;
  let ant = null;
  let comeco = null; // Map cercaId → dentro, logo na primeira posição
  const usar = (p, avisar) => {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!p.gps_valido || (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)) return;
    const t = paraMs(p.data_hora);
    const eventos = r.passo(cercas, lat, lng, t);
    if (r.rejeitou) return;
    if (ant && avisar) km += distM(ant.lat, ant.lng, lat, lng) / 1000;
    ant = { lat, lng };
    if (!comeco) { comeco = new Map(r.dentro); if (aoComecar) aoComecar(r); }
    if (avisar) for (const ev of eventos) aoEvento({ ...ev, dataHora: p.data_hora, t, km, rastreio: r });
  };
  if (anterior) usar(anterior, false);
  for (const p of rows) usar(p, true);
  return { rastreio: r, km, comeco: comeco || new Map(), posicoes: rows.length };
}

/** Percorre as posições de um veículo (em ordem) e devolve totais, excessos e paradas. */
function analisar(rows, { limite = 80, paradaMin = 5 } = {}) {
  const r = { km: 0, ligadoSeg: 0, movimentoSeg: 0, ociosoSeg: 0, velMax: 0, posicoes: rows.length, excessos: [], paradas: [], primeira: null, ultima: null };
  let ant = null; // posição anterior (qualquer)
  let antGps = null; // posição anterior com GPS válido
  let exc = null;
  let par = null;
  const fecharParada = (fimMs, fimTxt) => {
    if (!par) return;
    const dur = (fimMs - par.inicioMs) / 1000;
    if (dur >= paradaMin * 60) {
      const fr = dur > 0 ? par.ligadoSeg / dur : 0;
      r.paradas.push({ inicio: par.inicio, fim: fimTxt, duracao: dur, motor: fr >= 0.9 ? 'Ligado' : fr <= 0.1 ? 'Desligado' : 'Ligado parte do tempo', lat: par.lat, lon: par.lon });
    }
    par = null;
  };
  const fecharExcesso = () => {
    if (!exc) return;
    r.excessos.push({ inicio: exc.inicio, fim: exc.fimTxt, duracao: (exc.fimMs - exc.inicioMs) / 1000, max: exc.max, media: exc.soma / exc.n, lat: exc.lat, lon: exc.lon });
    exc = null;
  };
  for (const p of rows) {
    const t = paraMs(p.data_hora);
    const vel = Number(p.velocidade) || 0;
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    const gps = !!p.gps_valido && Math.abs(lat) > 0.0001;
    if (!r.primeira) r.primeira = p.data_hora;
    r.ultima = p.data_hora;
    if (vel > r.velMax && gps) r.velMax = vel;

    // tempos (pelo estado da posição anterior)
    if (ant) {
      const dt = (t - ant.t) / 1000;
      if (dt > 0 && dt <= LACUNA_SEG) {
        if (ant.ignicao) r.ligadoSeg += dt;
        if (ant.vel > PARADO_KMH) r.movimentoSeg += dt;
        else if (ant.ignicao) r.ociosoSeg += dt;
      }
    }

    if (gps) {
      // distância: ignora saltos impossíveis do GPS
      if (antGps) {
        const d = distanciaKm(antGps.lat, antGps.lon, lat, lon);
        const dt = (t - antGps.t) / 1000;
        if (d < 5 || (dt > 0 && d / (dt / 3600) < 250)) r.km += d;
      }
      // excesso de velocidade
      if (vel > limite) {
        if (exc && (t - exc.ultimoAcimaMs) / 1000 <= JUNTAR_EXCESSO_SEG) {
          exc.ultimoAcimaMs = t;
          exc.fimMs = t;
          exc.fimTxt = p.data_hora;
          exc.soma += vel;
          exc.n++;
          if (vel > exc.max) { exc.max = vel; exc.lat = lat; exc.lon = lon; }
        } else {
          fecharExcesso();
          exc = { inicio: p.data_hora, inicioMs: t, fimMs: t, fimTxt: p.data_hora, ultimoAcimaMs: t, max: vel, soma: vel, n: 1, lat, lon };
        }
      } else if (exc) {
        // voltou abaixo do limite: o excesso termina aqui (se for logo em seguida)
        if ((t - exc.ultimoAcimaMs) / 1000 <= JUNTAR_EXCESSO_SEG && exc.fimMs === exc.ultimoAcimaMs) { exc.fimMs = t; exc.fimTxt = p.data_hora; }
        if ((t - exc.ultimoAcimaMs) / 1000 > JUNTAR_EXCESSO_SEG) fecharExcesso();
      }
      // paradas: parado no mesmo lugar (mesmo com o aparelho desligado no meio)
      if (vel <= PARADO_KMH) {
        if (par && distanciaKm(par.lat, par.lon, lat, lon) > RAIO_PARADA_KM) fecharParada(t, p.data_hora);
        if (!par) par = { inicio: p.data_hora, inicioMs: t, lat, lon, ligadoSeg: 0 };
        else if (antGps && antGps.ignicao) {
          const dt = (t - antGps.t) / 1000;
          if (dt > 0 && dt <= LACUNA_SEG) par.ligadoSeg += dt;
        }
      } else if (par) {
        fecharParada(t, p.data_hora);
      }
      antGps = { t, lat, lon, ignicao: !!p.ignicao };
    }
    ant = { t, vel, ignicao: !!p.ignicao };
  }
  fecharExcesso();
  if (par && ant) fecharParada(ant.t, r.ultima);
  r.km = Math.round(r.km * 10) / 10;
  return r;
}

/**
 * Jornadas de um motorista a partir das posições dos veículos que ele dirigiu (em ordem, cada uma
 * com o veiculo_id). Dirigindo = em movimento; parado (ou sem posição) pelo descanso zera a direção
 * contínua; 8 h sem dirigir começa outra jornada.
 */
function jornadas(rows, { limiteSeg = 19800, descansoSeg = 1800 } = {}) {
  const lista = [];
  let j = null;
  let ant = null;
  let cont = 0;
  let acima = false;
  let ultimoMov = null;
  for (const p of rows) {
    const t = paraMs(p.data_hora);
    const vel = Number(p.velocidade) || 0;
    const lat = Number(p.latitude);
    const lon = Number(p.longitude);
    const gps = !!p.gps_valido && Math.abs(lat) > 0.0001;
    const mov = vel > PARADO_KMH;
    if (j && ant && ant.veic === p.veiculo_id) {
      const dt = (t - ant.t) / 1000;
      if (dt > 0 && dt <= LACUNA_SEG && ant.mov) {
        j.dirigindo += dt;
        cont += dt;
        if (cont > j.maiorContinua) j.maiorContinua = cont;
        if (cont >= limiteSeg && !acima) { j.vezesAcima++; acima = true; }
      }
      if (gps && ant.gps) {
        const d = distanciaKm(ant.lat, ant.lon, lat, lon);
        if (d < 5 || (dt > 0 && d / (dt / 3600) < 250)) j.km += d;
      }
    }
    if (mov) {
      const pausa = ultimoMov === null ? Infinity : (t - ultimoMov) / 1000;
      if (!j || pausa >= NOVA_JORNADA_SEG) {
        const anterior = j;
        j = { inicio: p.data_hora, inicioMs: t, fim: p.data_hora, fimMs: t, dirigindo: 0, maiorContinua: 0, pausas: 0, vezesAcima: 0, km: 0,
          veiculos: new Set(), descansoAntes: anterior ? (t - anterior.fimMs) / 1000 : null };
        lista.push(j);
        cont = 0;
        acima = false;
      } else if (pausa >= descansoSeg) {
        j.pausas++;
        cont = 0;
        acima = false;
      }
      j.fim = p.data_hora;
      j.fimMs = t;
      j.veiculos.add(p.veiculo_id);
      ultimoMov = t;
    }
    ant = { t, mov, gps, lat, lon, veic: p.veiculo_id };
  }
  for (const x of lista) x.km = Math.round(x.km * 10) / 10;
  // uma posição em movimento solta (o motorista assumiu e o trecho acabou ali) não é jornada
  return lista.filter((x) => x.dirigindo > 0);
}

/* ---------- relatórios ---------- */

class Relatorios {
  constructor({ banco, frota, acesso, cercas = null, motoristas = null }) {
    this.servMotoristas = motoristas;
    this.banco = banco;
    this.frota = frota;
    this.acesso = acesso;
    this.servCercas = cercas; // (o nome "cercas" é o do relatório)
    this.cache = new Map(); // usuário → { chave, em, resultado }
    this.rodando = new Set(); // usuários com relatório em andamento
  }

  /** Veículos do relatório conforme os filtros e o que o usuário pode ver. */
  veiculosAlvo(u, q) {
    const emp = empresaAlvo(u, q.empresa ? V.id(q.empresa, 'a empresa') : null);
    let lista = [...this.frota.veiculos.values()].filter((v) => v.ativo && this.acesso.veVeiculo(u, v) && (!emp || v.empresa_id === emp));
    let grupo = null;
    if (q.grupo) {
      grupo = this.frota.grupos.get(V.id(q.grupo, 'o grupo'));
      if (!grupo || (emp && grupo.empresa_id !== emp) || (u.perfil !== 'master' && grupo.empresa_id !== u.empresaId)) throw new HttpErro(404, 'Grupo não encontrado.');
      const ids = new Set();
      const juntar = (id) => { ids.add(id); for (const f of this.frota.filhos.get(id) || []) juntar(f); };
      juntar(grupo.id);
      lista = lista.filter((v) => ids.has(v.grupo_id));
    }
    let veiculo = null;
    if (q.veiculo) {
      const id = V.id(q.veiculo, 'o veículo');
      veiculo = lista.find((v) => v.id === id) || null;
      if (!veiculo) throw new HttpErro(404, 'Veículo não encontrado.');
      lista = [veiculo];
    }
    lista.sort((a, b) => (a.prefixo || a.placa).localeCompare(b.prefixo || b.placa, 'pt-BR', { numeric: true }));
    const empresas = new Set(lista.map((v) => v.empresa_id));
    return { lista, emp, grupo, veiculo, variasEmpresas: empresas.size > 1 };
  }

  nomeVeiculo(v) { return v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa; }
  nomeGrupo(v) { return v.grupo_id ? this.frota.caminhoGrupo(v.grupo_id) : ''; }
  nomeEmpresa(id) { const e = this.frota.empresas.get(id); return e ? e.nome : ''; }

  subtitulo(u, alvo, de, ate, extra = []) {
    const quem = alvo.veiculo ? `Veículo ${this.nomeVeiculo(alvo.veiculo)}`
      : alvo.grupo ? `Grupo ${this.frota.caminhoGrupo(alvo.grupo.id)}`
        : `${alvo.lista.length} veículo${alvo.lista.length === 1 ? '' : 's'}`;
    const emp = alvo.emp ? this.nomeEmpresa(alvo.emp) : (u.perfil === 'master' ? 'Todas as empresas' : u.empresaNome);
    return [`${emp} · ${quem}`, `Período: ${fmtDataHora(de, false)} a ${fmtDataHora(ate, false)}${extra.length ? ` · ${extra.join(' · ')}` : ''}`];
  }

  periodo(q, maxDias) {
    const de = V.dataHora(q.de, 'a data inicial');
    const ate = V.dataHora(q.ate, 'a data final');
    if (ate <= de) throw new HttpErro(400, 'A data final precisa ser depois da inicial.');
    const dias = (paraMs(ate) - paraMs(de)) / 86400000;
    if (dias > maxDias + 0.0001) throw new HttpErro(400, `Escolha um período de até ${maxDias} dias.`);
    return { de, ate, dias: Math.max(1, Math.ceil(dias - 0.0001)) };
  }

  async posicoesDe(v, de, ate) {
    return this.banco.query(
      `SELECT data_hora, latitude, longitude, velocidade, ignicao, gps_valido FROM posicoes
        WHERE veiculo_id = ? AND data_hora BETWEEN ? AND ? ORDER BY data_hora, id`, [v.id, de, ate]);
  }

  /** Gera (ou reaproveita, se for o mesmo pedido de há pouco) o relatório. */
  async gerar(u, tipo, q) {
    if (!TIPOS[tipo]) throw new HttpErro(404, 'Relatório não encontrado.');
    const chave = JSON.stringify([tipo, q.de, q.ate, q.empresa || '', q.grupo || '', q.veiculo || '', q.limite || '', q.minutos || '', q.gravidade || '', q.situacao || '', q.cerca || '', q.finalidade || '',
      q.motorista || '', q.continua || '', q.descanso || '', q.linha || '']);
    const c = this.cache.get(u.id);
    if (c && c.chave === chave && Date.now() - c.em < CACHE_MS) return c.resultado;
    if (this.rodando.has(u.id)) throw new HttpErro(429, 'Já há um relatório sendo gerado para você. Aguarde ele terminar.');
    if (this.rodando.size >= 3) throw new HttpErro(429, 'O servidor está gerando outros relatórios agora. Tente de novo em instantes.');
    this.rodando.add(u.id);
    try {
      const resultado = await this[tipo](u, q);
      resultado.tipo = tipo;
      resultado.arquivo = TIPOS[tipo].arquivo;
      resultado.geradoEm = formatar(Date.now());
      resultado.geradoPor = u.nome;
      this.cache.set(u.id, { chave, em: Date.now(), resultado });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      return resultado;
    } finally {
      this.rodando.delete(u.id);
    }
  }

  /** Última posição com GPS antes do período (até 7 dias antes): onde o veículo estava no começo. */
  async posicaoAntes(v, de) {
    return this.banco.um(
      `SELECT data_hora, latitude, longitude, velocidade, ignicao, gps_valido FROM posicoes
        WHERE veiculo_id = ? AND data_hora < ? AND data_hora >= ? AND gps_valido = 1 ORDER BY data_hora DESC, id DESC LIMIT 1`,
      [v.id, de, formatar(paraMs(de) - 7 * 86400000)]);
  }

  /** Cercas do relatório para um veículo (as que valem para ele, filtradas pela finalidade ou pela cerca escolhida). */
  cercasDoRelatorio(v, filtro) {
    if (!this.servCercas) return [];
    return this.servCercas.doVeiculo(v).filter(filtro);
  }

  filtroCerca(u, q, finalidade) {
    const id = q.cerca ? V.id(q.cerca, 'a cerca') : null;
    let escolhida = null;
    if (id) {
      escolhida = this.servCercas && this.servCercas.lista.get(id);
      if (!escolhida || (u.perfil !== 'master' && escolhida.empresaId !== u.empresaId)) throw new HttpErro(404, 'Cerca não encontrada (ou desativada).');
    }
    const fin = finalidade || (q.finalidade ? V.opcao(q.finalidade, Object.keys(NOMES_FINALIDADE), 'a finalidade') : null);
    return { escolhida, fin, filtro: (c) => (!escolhida || c.id === escolhida.id) && (!fin || c.finalidade === fin) };
  }

  checarOrcamento(alvo, dias) {
    if (!alvo.lista.length) throw new HttpErro(400, 'Nenhum veículo encontrado com esses filtros.');
    if (alvo.lista.length * dias > ORCAMENTO) {
      const maxDias = Math.max(1, Math.floor(ORCAMENTO / alvo.lista.length));
      throw new HttpErro(400, `Período longo demais para ${alvo.lista.length} veículos: escolha até ${maxDias} dia${maxDias === 1 ? '' : 's'} ou filtre por grupo ou veículo.`);
    }
  }

  colunasVeiculo(alvo) {
    const c = [];
    if (alvo.variasEmpresas) c.push({ titulo: 'Empresa', tipo: 'texto', largura: 22, peso: 1.6 });
    c.push({ titulo: 'Veículo', tipo: 'texto', largura: 20, peso: 1.5 }, { titulo: 'Grupo', tipo: 'texto', largura: 22, peso: 1.5 });
    return c;
  }

  celulasVeiculo(alvo, v) {
    const c = [];
    if (alvo.variasEmpresas) c.push(this.nomeEmpresa(v.empresa_id));
    c.push(this.nomeVeiculo(v), this.nomeGrupo(v));
    return c;
  }

  parametros(q) {
    const limite = q.limite ? V.inteiro(q.limite, 'o limite de velocidade', { min: 20, max: 200 }) : 80;
    const paradaMin = q.minutos ? V.inteiro(q.minutos, 'o tempo mínimo de parada', { min: 1, max: 720 }) : 5;
    return { limite, paradaMin };
  }

  async resumo(u, q) {
    const { de, ate, dias } = this.periodo(q, MAX_DIAS);
    const alvo = this.veiculosAlvo(u, q);
    this.checarOrcamento(alvo, dias);
    const par = this.parametros(q);
    const alertas = new Map((await this.banco.query(
      'SELECT veiculo_id, COUNT(*) AS n FROM alertas WHERE veiculo_id IN (?) AND inicio BETWEEN ? AND ? GROUP BY veiculo_id',
      [alvo.lista.map((v) => v.id), de, ate])).map((x) => [x.veiculo_id, Number(x.n)]));
    const linhas = [];
    const tot = { km: 0, ligado: 0, mov: 0, ocioso: 0, exc: 0, par: 0, al: 0, velMax: 0 };
    let semDados = 0;
    for (const v of alvo.lista) {
      const a = analisar(await this.posicoesDe(v, de, ate), par);
      if (!a.posicoes) semDados++;
      const nAl = alertas.get(v.id) || 0;
      const media = a.movimentoSeg > 60 ? a.km / (a.movimentoSeg / 3600) : null;
      linhas.push([...this.celulasVeiculo(alvo, v), a.km, a.ligadoSeg, a.movimentoSeg, a.ociosoSeg, a.velMax || null, media !== null ? Math.round(media * 10) / 10 : null,
        a.excessos.length, a.paradas.length, nAl, a.ultima]);
      tot.km += a.km; tot.ligado += a.ligadoSeg; tot.mov += a.movimentoSeg; tot.ocioso += a.ociosoSeg;
      tot.exc += a.excessos.length; tot.par += a.paradas.length; tot.al += nAl; tot.velMax = Math.max(tot.velMax, a.velMax);
    }
    const colunas = [...this.colunasVeiculo(alvo),
      { titulo: 'Km rodados', tipo: 'decimal', largura: 12, peso: 1, alinhar: 'd' },
      { titulo: 'Motor ligado', tipo: 'duracao', largura: 13, peso: 1.05, alinhar: 'd' },
      { titulo: 'Em movimento', tipo: 'duracao', largura: 13, peso: 1.05, alinhar: 'd' },
      { titulo: 'Parado ligado', tipo: 'duracao', largura: 13, peso: 1.05, alinhar: 'd' },
      { titulo: 'Vel. máx. (km/h)', tipo: 'inteiro', largura: 14, peso: 1, alinhar: 'd' },
      { titulo: 'Vel. média (km/h)', tipo: 'decimal', largura: 15, peso: 1.05, alinhar: 'd' },
      { titulo: `Excessos (> ${par.limite})`, tipo: 'inteiro', largura: 14, peso: 0.95, alinhar: 'd' },
      { titulo: `Paradas (≥ ${par.paradaMin} min)`, tipo: 'inteiro', largura: 15, peso: 1, alinhar: 'd' },
      { titulo: 'Alertas', tipo: 'inteiro', largura: 10, peso: 0.7, alinhar: 'd' },
      { titulo: 'Última posição', tipo: 'dataHora', largura: 19, peso: 1.35 }];
    const nVeic = colunas.length - 10;
    const totais = [...Array(nVeic).fill(null), tot.km, tot.ligado, tot.mov, tot.ocioso, tot.velMax || null, null, tot.exc, tot.par, tot.al, null];
    totais[0] = 'Total';
    return {
      titulo: TIPOS.resumo.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [`Limite ${par.limite} km/h`, `Paradas a partir de ${par.paradaMin} min`]),
      colunas, linhas, totais,
      resumo: [
        { rotulo: 'Veículos', valor: fmtNum(alvo.lista.length) },
        { rotulo: 'Km rodados', valor: `${fmtNum(tot.km, 1)} km` },
        { rotulo: 'Em movimento', valor: fmtDuracao(tot.mov) },
        { rotulo: 'Parado ligado', valor: fmtDuracao(tot.ocioso) },
        { rotulo: 'Excessos', valor: fmtNum(tot.exc) },
        { rotulo: 'Alertas', valor: fmtNum(tot.al) },
      ],
      observacao: `Km calculados pelo GPS. Tempos contam só intervalos de até ${LACUNA_SEG / 60} min entre posições.${semDados ? ` ${semDados} veículo(s) sem posição no período.` : ''}`,
    };
  }

  async velocidade(u, q) {
    const { de, ate, dias } = this.periodo(q, MAX_DIAS);
    const alvo = this.veiculosAlvo(u, q);
    this.checarOrcamento(alvo, dias);
    const par = this.parametros(q);
    const linhas = [];
    const veiculosCom = new Set();
    let maior = 0;
    for (const v of alvo.lista) {
      const a = analisar(await this.posicoesDe(v, de, ate), par);
      for (const e of a.excessos) {
        veiculosCom.add(v.id);
        maior = Math.max(maior, e.max);
        linhas.push([...this.celulasVeiculo(alvo, v), e.inicio, e.fim, e.duracao, e.max, Math.round(e.media * 10) / 10, coord(e.lat, e.lon)]);
      }
      if (linhas.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor ou um limite maior.');
    }
    const nVeic = this.colunasVeiculo(alvo).length;
    linhas.sort((a, b) => String(a[nVeic]).localeCompare(String(b[nVeic])));
    return {
      titulo: TIPOS.velocidade.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [`Acima de ${par.limite} km/h`]),
      colunas: [...this.colunasVeiculo(alvo),
        { titulo: 'Início', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Fim', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Duração', tipo: 'duracao', largura: 11, peso: 0.8, alinhar: 'd' },
        { titulo: 'Vel. máxima (km/h)', tipo: 'inteiro', largura: 16, peso: 1.05, alinhar: 'd' },
        { titulo: 'Vel. média (km/h)', tipo: 'decimal', largura: 15, peso: 1.05, alinhar: 'd' },
        { titulo: 'Local (lat, lon)', tipo: 'texto', largura: 24, peso: 1.5 }],
      linhas, totais: null,
      resumo: [
        { rotulo: 'Excessos', valor: fmtNum(linhas.length) },
        { rotulo: 'Veículos com excesso', valor: `${fmtNum(veiculosCom.size)} de ${fmtNum(alvo.lista.length)}` },
        { rotulo: 'Maior velocidade', valor: maior ? `${fmtNum(maior)} km/h` : '—' },
        { rotulo: 'Limite usado', valor: `${par.limite} km/h` },
      ],
      vazio: `Nenhum excesso acima de ${par.limite} km/h no período.`,
      observacao: `Velocidade do GPS. Trechos acima do limite separados por até ${JUNTAR_EXCESSO_SEG} s contam como um só excesso.`,
    };
  }

  async paradas(u, q) {
    const { de, ate, dias } = this.periodo(q, MAX_DIAS);
    const alvo = this.veiculosAlvo(u, q);
    this.checarOrcamento(alvo, dias);
    const par = this.parametros(q);
    const linhas = [];
    let total = 0;
    let maior = 0;
    for (const v of alvo.lista) {
      const a = analisar(await this.posicoesDe(v, de, ate), par);
      for (const p of a.paradas) {
        total += p.duracao;
        maior = Math.max(maior, p.duracao);
        linhas.push([...this.celulasVeiculo(alvo, v), p.inicio, p.fim, p.duracao, p.motor, coord(p.lat, p.lon)]);
      }
      if (linhas.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor ou um tempo mínimo de parada maior.');
    }
    return {
      titulo: TIPOS.paradas.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [`A partir de ${par.paradaMin} min parado`]),
      colunas: [...this.colunasVeiculo(alvo),
        { titulo: 'Início', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Fim', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Duração', tipo: 'duracao', largura: 11, peso: 0.85, alinhar: 'd' },
        { titulo: 'Motor', tipo: 'texto', largura: 20, peso: 1.25 },
        { titulo: 'Local (lat, lon)', tipo: 'texto', largura: 24, peso: 1.5 }],
      linhas,
      totais: linhas.length ? (() => { const t = Array(this.colunasVeiculo(alvo).length + 5).fill(null); t[0] = 'Total'; t[t.length - 3] = total; return t; })() : null,
      resumo: [
        { rotulo: 'Paradas', valor: fmtNum(linhas.length) },
        { rotulo: 'Tempo parado', valor: fmtDuracao(total) },
        { rotulo: 'Parada mais longa', valor: maior ? fmtDuracao(maior) : '—' },
        { rotulo: 'Média por parada', valor: linhas.length ? fmtDuracao(total / linhas.length) : '—' },
      ],
      vazio: `Nenhuma parada de ${par.paradaMin} min ou mais no período.`,
      observacao: `Parado: até ${PARADO_KMH} km/h no mesmo lugar (raio de ${RAIO_PARADA_KM * 1000} m), mesmo que o aparelho tenha ficado sem enviar posição no meio.`,
    };
  }

  async alertas(u, q) {
    const { de, ate } = this.periodo(q, MAX_DIAS_ALERTAS);
    const alvo = this.veiculosAlvo(u, q);
    if (!alvo.lista.length) throw new HttpErro(400, 'Nenhum veículo encontrado com esses filtros.');
    const onde = ['a.veiculo_id IN (?)', 'a.inicio BETWEEN ? AND ?'];
    const args = [alvo.lista.map((v) => v.id), de, ate];
    if (q.gravidade) { onde.push('a.gravidade = ?'); args.push(V.opcao(q.gravidade, ['alta', 'media', 'baixa'], 'a gravidade')); }
    if (q.situacao) {
      const s = V.opcao(q.situacao, ['novo', 'em_tratamento', 'tratado', 'pendentes'], 'a situação');
      if (s === 'pendentes') onde.push("a.situacao <> 'tratado'");
      else { onde.push('a.situacao = ?'); args.push(s); }
    }
    const rows = await this.banco.query(`
      SELECT a.veiculo_id, a.inicio, a.fim, a.nome, a.gravidade, a.velocidade, a.situacao, a.tratado_em, a.tratativa, us.nome AS tratado_por_nome
        FROM alertas a LEFT JOIN usuarios us ON us.id = a.tratado_por
       WHERE ${onde.join(' AND ')} ORDER BY a.inicio, a.id LIMIT ?`, [...args, MAX_LINHAS + 1]);
    if (rows.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor ou filtre por gravidade.');
    const GRAV = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
    const SIT = { novo: 'Novo', em_tratamento: 'Em tratamento', tratado: 'Tratado' };
    const cont = { alta: 0, pend: 0, trat: 0 };
    const linhas = rows.map((a) => {
      const v = this.frota.veiculos.get(a.veiculo_id);
      if (a.gravidade === 'alta') cont.alta++;
      if (a.situacao === 'tratado') cont.trat++; else cont.pend++;
      const dur = a.fim ? (paraMs(a.fim) - paraMs(a.inicio)) / 1000 : null;
      return [...this.celulasVeiculo(alvo, v), a.inicio, a.fim, dur, a.nome, GRAV[a.gravidade] || a.gravidade,
        a.velocidade !== null ? Number(a.velocidade) : null, SIT[a.situacao] || a.situacao, a.tratado_por_nome || '', a.tratado_em, a.tratativa || ''];
    });
    return {
      titulo: TIPOS.alertas.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [q.gravidade ? `Gravidade ${GRAV[q.gravidade]}` : '', q.situacao ? `Situação: ${q.situacao === 'pendentes' ? 'pendentes' : SIT[q.situacao]}` : ''].filter(Boolean)),
      colunas: [...this.colunasVeiculo(alvo),
        { titulo: 'Início', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Fim', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Duração', tipo: 'duracao', largura: 10, peso: 0.75, alinhar: 'd' },
        { titulo: 'Alerta', tipo: 'texto', largura: 26, peso: 1.6 },
        { titulo: 'Gravidade', tipo: 'texto', largura: 10, peso: 0.7 },
        { titulo: 'Vel. (km/h)', tipo: 'inteiro', largura: 10, peso: 0.7, alinhar: 'd' },
        { titulo: 'Situação', tipo: 'texto', largura: 14, peso: 0.95 },
        { titulo: 'Tratado por', tipo: 'texto', largura: 18, peso: 1.1 },
        { titulo: 'Tratado em', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Tratativa', tipo: 'texto', largura: 40, peso: 2 }],
      linhas, totais: null,
      resumo: [
        { rotulo: 'Alertas', valor: fmtNum(linhas.length) },
        { rotulo: 'Gravidade alta', valor: fmtNum(cont.alta) },
        { rotulo: 'Pendentes', valor: fmtNum(cont.pend) },
        { rotulo: 'Tratados', valor: fmtNum(cont.trat) },
      ],
      vazio: 'Nenhum alerta no período.',
    };
  }

  /** Cada saída da garagem com a volta: quando saiu, quando chegou, quanto tempo e quantos km fora. */
  async garagem(u, q) {
    const { de, ate, dias } = this.periodo(q, MAX_DIAS);
    const alvo = this.veiculosAlvo(u, q);
    this.checarOrcamento(alvo, dias);
    const { escolhida, filtro } = this.filtroCerca(u, q, 'garagem');
    const temGaragem = [...((this.servCercas && this.servCercas.lista.values()) || [])].some((c) => c.finalidade === 'garagem' && (u.perfil === 'master' || c.empresaId === u.empresaId));
    if (!temGaragem) throw new HttpErro(400, 'Nenhuma garagem cadastrada. Desenhe a garagem em Cadastros › Cercas (finalidade "Garagem").');
    const linhas = [];
    const saiu = new Set();
    let semGaragem = 0;
    let semDados = 0;
    let comDados = 0;
    const tot = { fora: 0, km: 0, saidas: 0 };
    let primeira = null;
    let ultimaChegada = null;
    for (const v of alvo.lista) {
      const garagens = this.cercasDoRelatorio(v, filtro);
      if (!garagens.length) { semGaragem++; continue; }
      const ids = new Set(garagens.map((c) => c.id));
      const emAlguma = (r) => [...r.dentro].some(([id, d]) => d && ids.has(id));
      let viagem = null;
      const rows = await this.posicoesDe(v, de, ate);
      const anterior = await this.posicaoAntes(v, de);
      const fechar = (chegouEm, chegada, km, t) => {
        const tempo = viagem.t ? (t - viagem.t) / 1000 : null;
        linhas.push([...this.celulasVeiculo(alvo, v), viagem.cerca ? viagem.cerca.nome : '', viagem.saida, chegouEm ? chegouEm.nome : '', chegada,
          tempo, viagem.saida && chegada ? Math.round((km - viagem.km) * 10) / 10 : null]);
        if (tempo !== null) tot.fora += tempo;
        if (viagem.saida && chegada) tot.km += km - viagem.km;
        if (chegada && (!ultimaChegada || chegada > ultimaChegada)) ultimaChegada = chegada;
        viagem = null;
      };
      const res = percorrerCercas(rows, garagens, anterior, (ev) => {
        if (ev.tipo === 'saida' && !viagem && !emAlguma(ev.rastreio)) {
          viagem = { cerca: ev.cerca, saida: ev.dataHora, t: ev.t, km: ev.km };
          saiu.add(v.id);
          tot.saidas++;
          if (!primeira || ev.dataHora < primeira) primeira = ev.dataHora;
        } else if (ev.tipo === 'entrada' && viagem) {
          fechar(ev.cerca, ev.dataHora, ev.km, ev.t);
        }
      }, (r) => {
        // começou o período fora da garagem: a primeira chegada aparece sem a saída
        if (!emAlguma(r)) viagem = { cerca: null, saida: null, t: null, km: 0 };
      });
      if (res.posicoes) comDados++; else semDados++;
      if (viagem && viagem.saida) { // ainda fora no fim do período
        linhas.push([...this.celulasVeiculo(alvo, v), viagem.cerca ? viagem.cerca.nome : '', viagem.saida, '', null, null, Math.round((res.km - viagem.km) * 10) / 10]);
        tot.km += res.km - viagem.km;
      }
    }
    // em ordem de saída (as viagens sem saída conhecida vão pela chegada)
    const nV = this.colunasVeiculo(alvo).length;
    linhas.sort((a, b) => String(a[nV + 1] || a[nV + 3]).localeCompare(String(b[nV + 1] || b[nV + 3])));
    // tempo total só quando alguma viagem tem saída e chegada (as em aberto ficam em branco)
    const totais = linhas.length ? (() => { const t = Array(nV + 6).fill(null); t[0] = 'Total'; t[nV + 4] = linhas.some((l) => l[nV + 4] !== null) ? tot.fora : null; t[nV + 5] = Math.round(tot.km * 10) / 10; return t; })() : null;
    return {
      titulo: TIPOS.garagem.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [escolhida ? `Garagem ${escolhida.nome}` : 'Todas as garagens']),
      colunas: [...this.colunasVeiculo(alvo),
        { titulo: 'Saiu de', tipo: 'texto', largura: 20, peso: 1.2 },
        { titulo: 'Saída', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Chegou em', tipo: 'texto', largura: 20, peso: 1.2 },
        { titulo: 'Chegada', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Tempo fora', tipo: 'duracao', largura: 12, peso: 0.9, alinhar: 'd' },
        { titulo: 'Km fora', tipo: 'decimal', largura: 10, peso: 0.8, alinhar: 'd' }],
      linhas, totais,
      resumo: [
        { rotulo: 'Saídas', valor: fmtNum(tot.saidas) },
        { rotulo: 'Veículos que saíram', valor: `${fmtNum(saiu.size)} de ${fmtNum(comDados)}` },
        { rotulo: 'Sem saída', valor: fmtNum(Math.max(0, comDados - saiu.size)) },
        { rotulo: 'Primeira saída', valor: primeira ? fmtDataHora(primeira, false).slice(-5) : '—' },
        { rotulo: 'Última chegada', valor: ultimaChegada ? fmtDataHora(ultimaChegada, false).slice(-5) : '—' },
        { rotulo: 'Km fora', valor: `${fmtNum(tot.km, 1)} km` },
      ],
      vazio: 'Nenhuma saída da garagem no período.',
      observacao: `Calculado pelas posições do GPS: para sair o veículo precisa passar ${FOLGA_M} m da borda da garagem. Saída em branco: já estava fora no começo do período; chegada em branco: ainda estava fora no fim.${semDados ? ` ${semDados} veículo(s) sem posição no período.` : ''}${semGaragem ? ` ${semGaragem} veículo(s) sem garagem cadastrada para o grupo deles.` : ''}`,
    };
  }

  /** Cada passagem por uma cerca: quando entrou, quando saiu e quanto tempo ficou dentro. */
  async cercas(u, q) {
    const { de, ate, dias } = this.periodo(q, MAX_DIAS);
    const alvo = this.veiculosAlvo(u, q);
    this.checarOrcamento(alvo, dias);
    const { escolhida, fin, filtro } = this.filtroCerca(u, q, null);
    const linhas = [];
    const porCerca = new Map();
    const veics = new Set();
    let total = 0;
    let algumaCerca = false;
    for (const v of alvo.lista) {
      const lista = this.cercasDoRelatorio(v, filtro);
      if (!lista.length) continue;
      algumaCerca = true;
      const abertas = new Map(); // cercaId → { dataHora, t }
      const rows = await this.posicoesDe(v, de, ate);
      const anterior = await this.posicaoAntes(v, de);
      const linha = (c, entrada, saida, tempo) => {
        linhas.push([...this.celulasVeiculo(alvo, v), c.nome, NOMES_FINALIDADE[c.finalidade], entrada, saida, tempo]);
        porCerca.set(c.nome, (porCerca.get(c.nome) || 0) + 1);
        veics.add(v.id);
        if (tempo !== null) total += tempo;
      };
      percorrerCercas(rows, lista, anterior, (ev) => {
        if (ev.tipo === 'entrada') abertas.set(ev.cerca.id, { dataHora: ev.dataHora, t: ev.t });
        else {
          const a = abertas.get(ev.cerca.id);
          abertas.delete(ev.cerca.id);
          // saiu sem ter entrado no período: já estava dentro no começo
          linha(ev.cerca, a ? a.dataHora : null, ev.dataHora, a ? (ev.t - a.t) / 1000 : null);
        }
      });
      for (const [id, a] of abertas) linha(lista.find((c) => c.id === id), a.dataHora, null, null); // ainda dentro no fim
      if (linhas.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor ou uma cerca.');
    }
    if (!algumaCerca) throw new HttpErro(400, escolhida || fin ? 'Nenhuma cerca com esse filtro vale para estes veículos.' : 'Nenhuma cerca cadastrada para estes veículos. Desenhe em Cadastros › Cercas.');
    const nV = this.colunasVeiculo(alvo).length;
    linhas.sort((a, b) => String(a[nV + 2] || a[nV + 3]).localeCompare(String(b[nV + 2] || b[nV + 3])));
    const mais = [...porCerca].sort((a, b) => b[1] - a[1])[0];
    return {
      titulo: TIPOS.cercas.titulo,
      subtitulo: this.subtitulo(u, alvo, de, ate, [escolhida ? `Cerca ${escolhida.nome}` : fin ? NOMES_FINALIDADE[fin] : 'Todas as cercas']),
      colunas: [...this.colunasVeiculo(alvo),
        { titulo: 'Cerca', tipo: 'texto', largura: 24, peso: 1.5 },
        { titulo: 'Tipo', tipo: 'texto', largura: 18, peso: 1.1 },
        { titulo: 'Entrada', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Saída', tipo: 'dataHora', largura: 19, peso: 1.3 },
        { titulo: 'Tempo dentro', tipo: 'duracao', largura: 13, peso: 0.9, alinhar: 'd' }],
      linhas,
      totais: linhas.length ? (() => { const t = Array(nV + 5).fill(null); t[0] = 'Total'; t[nV + 4] = total; return t; })() : null,
      resumo: [
        { rotulo: 'Passagens', valor: fmtNum(linhas.length) },
        { rotulo: 'Veículos', valor: fmtNum(veics.size) },
        { rotulo: 'Tempo dentro', valor: fmtDuracao(total) },
        { rotulo: 'Mais visitada', valor: mais ? `${mais[0]} (${fmtNum(mais[1])})` : '—' },
      ],
      vazio: 'Nenhuma entrada ou saída de cerca no período.',
      observacao: 'Calculado pelas posições do GPS. Entrada em branco: o veículo já estava dentro no começo do período; saída em branco: ainda estava dentro no fim.',
    };
  }

  /* ---------- motoristas ---------- */

  parametrosJornada(q) {
    const continua = q.continua ? V.inteiro(q.continua, 'a direção contínua', { min: 30, max: 720 }) : 330;
    const descanso = q.descanso ? V.inteiro(q.descanso, 'o descanso', { min: 5, max: 180 }) : 30;
    return { limiteSeg: continua * 60, descansoSeg: descanso * 60, continua, descanso };
  }

  /**
   * Por motorista: os trechos em que dirigiu cada veículo (dentro do período e do que o usuário vê),
   * com as posições de cada trecho. Devolve { alvo, porMotorista: Map(id → { m, trechos }) }.
   */
  async trechosDosMotoristas(u, q, de, ate) {
    if (!this.servMotoristas) throw new HttpErro(400, 'Motoristas indisponíveis.');
    const alvo = this.veiculosAlvo(u, q);
    if (!alvo.lista.length) throw new HttpErro(400, 'Nenhum veículo encontrado com esses filtros.');
    const motId = q.motorista ? V.id(q.motorista, 'o motorista') : null;
    const vinc = await this.servMotoristas.doPeriodo({ de, ate, veiculoIds: alvo.lista.map((v) => v.id), motoristaIds: motId ? [motId] : null });
    // orçamento: veículos × dias de posição lidos
    const seg = vinc.reduce((s, x) => s + (paraMs(x.fim && x.fim < ate ? x.fim : ate) - paraMs(x.inicio > de ? x.inicio : de)) / 1000, 0);
    if (seg / 86400 > ORCAMENTO) throw new HttpErro(400, 'Período longo demais para tantos motoristas: escolha menos dias, um grupo ou um motorista.');
    const porMotorista = new Map();
    for (const x of vinc) {
      const m = this.servMotoristas.lista.get(x.motorista_id);
      const v = this.frota.veiculos.get(x.veiculo_id);
      if (!m || !v) continue;
      const ini = x.inicio > de ? x.inicio : de;
      const fim = x.fim && x.fim < ate ? x.fim : ate;
      const rows = (await this.posicoesDe(v, ini, fim)).map((p) => ({ ...p, veiculo_id: v.id }));
      let e = porMotorista.get(m.id);
      if (!e) { e = { m, trechos: [] }; porMotorista.set(m.id, e); }
      e.trechos.push({ v, ini, fim, rows });
    }
    return { alvo, porMotorista };
  }

  async alertasDosMotoristas(ids, de, ate) {
    if (!ids.length) return [];
    return this.banco.query('SELECT motorista_id, inicio FROM alertas WHERE motorista_id IN (?) AND inicio BETWEEN ? AND ?', [ids, de, ate]);
  }

  subtituloMotoristas(u, alvo, de, ate, q, extra) {
    const m = q.motorista && this.servMotoristas ? this.servMotoristas.lista.get(Number(q.motorista)) : null;
    const [a, b] = this.subtitulo(u, alvo, de, ate, extra);
    return [m ? `${a} · Motorista ${m.nome}` : a, b];
  }

  async jornada(u, q) {
    const { de, ate } = this.periodo(q, MAX_DIAS);
    const par = this.parametrosJornada(q);
    const { alvo, porMotorista } = await this.trechosDosMotoristas(u, q, de, ate);
    const alertas = await this.alertasDosMotoristas([...porMotorista.keys()], de, ate);
    const linhas = [];
    const cont = { jornadas: 0, dirigindo: 0, acima: 0, descansoCurto: 0 };
    const lista = [...porMotorista.values()].sort((a, b) => a.m.nome.localeCompare(b.m.nome, 'pt-BR'));
    for (const { m, trechos } of lista) {
      const rows = trechos.flatMap((t) => t.rows);
      for (const j of jornadas(rows, par)) {
        const nAl = alertas.filter((a) => a.motorista_id === m.id && a.inicio >= j.inicio && a.inicio <= j.fim).length;
        const obs = [];
        if (j.maiorContinua >= par.limiteSeg) obs.push(`dirigiu ${fmtDuracao(j.maiorContinua).slice(0, -3)} sem descanso de ${par.descanso} min`);
        if (j.descansoAntes !== null && j.descansoAntes < DESCANSO_DIARIO_SEG) obs.push('descanso antes da jornada menor que 11 h');
        cont.jornadas++;
        cont.dirigindo += j.dirigindo;
        if (j.maiorContinua >= par.limiteSeg) cont.acima++;
        if (j.descansoAntes !== null && j.descansoAntes < DESCANSO_DIARIO_SEG) cont.descansoCurto++;
        linhas.push([m.nome, m.matricula || '', j.inicio, j.fim, (j.fimMs - j.inicioMs) / 1000, j.dirigindo, j.maiorContinua, j.pausas, j.km,
          [...j.veiculos].map((id) => this.nomeVeiculo(this.frota.veiculos.get(id))).join(', '), nAl, j.descansoAntes, obs.join('; ')]);
      }
      if (linhas.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor.');
    }
    return {
      titulo: TIPOS.jornada.titulo,
      subtitulo: this.subtituloMotoristas(u, alvo, de, ate, q, [`Direção contínua até ${fmtDuracao(par.limiteSeg).slice(0, -3)}`, `descanso de ${par.descanso} min`]),
      colunas: [
        { titulo: 'Motorista', tipo: 'texto', largura: 24, peso: 1.6 },
        { titulo: 'Matrícula', tipo: 'texto', largura: 11, peso: 0.8 },
        { titulo: 'Início', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Fim', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Jornada', tipo: 'duracao', largura: 10, peso: 0.8, alinhar: 'd' },
        { titulo: 'Dirigindo', tipo: 'duracao', largura: 10, peso: 0.8, alinhar: 'd' },
        { titulo: 'Maior direção contínua', tipo: 'duracao', largura: 14, peso: 1, alinhar: 'd' },
        { titulo: `Descansos (≥ ${par.descanso} min)`, tipo: 'inteiro', largura: 12, peso: 0.9, alinhar: 'd' },
        { titulo: 'Km', tipo: 'decimal', largura: 9, peso: 0.7, alinhar: 'd' },
        { titulo: 'Veículos', tipo: 'texto', largura: 22, peso: 1.3 },
        { titulo: 'Alertas', tipo: 'inteiro', largura: 8, peso: 0.6, alinhar: 'd' },
        { titulo: 'Descanso antes', tipo: 'duracao', largura: 12, peso: 0.9, alinhar: 'd' },
        { titulo: 'Atenção', tipo: 'texto', largura: 36, peso: 1.8 }],
      linhas, totais: null,
      resumo: [
        { rotulo: 'Motoristas', valor: fmtNum(porMotorista.size) },
        { rotulo: 'Jornadas', valor: fmtNum(cont.jornadas) },
        { rotulo: 'Horas dirigindo', valor: fmtDuracao(cont.dirigindo).slice(0, -3) },
        { rotulo: 'Acima da direção contínua', valor: fmtNum(cont.acima) },
        { rotulo: 'Descanso menor que 11 h', valor: fmtNum(cont.descansoCurto) },
      ],
      vazio: 'Nenhum motorista dirigiu os veículos escolhidos no período (o motorista é escolhido no painel do veículo, no Monitoramento, ou pelo cartão no DVR).',
      observacao: `Dirigindo = em movimento (acima de ${PARADO_KMH} km/h), pelos trechos em que o motorista estava no veículo. Parado ${par.descanso} min ou mais conta como descanso e zera a direção contínua; 8 h sem dirigir começa outra jornada. Referência: Lei 13.103/2015 (CTB art. 67-C).`,
    };
  }

  async motoristas(u, q) {
    const { de, ate } = this.periodo(q, MAX_DIAS);
    const par = this.parametrosJornada(q);
    const lim = this.parametros(q);
    const { alvo, porMotorista } = await this.trechosDosMotoristas(u, q, de, ate);
    const alertas = await this.alertasDosMotoristas([...porMotorista.keys()], de, ate);
    const linhas = [];
    const tot = { km: 0, dirigindo: 0, exc: 0, al: 0, jornadas: 0 };
    const lista = [...porMotorista.values()].sort((a, b) => a.m.nome.localeCompare(b.m.nome, 'pt-BR'));
    for (const { m, trechos } of lista) {
      const js = jornadas(trechos.flatMap((t) => t.rows), par);
      let excessos = 0;
      let velMax = 0;
      for (const t of trechos) {
        const a = analisar(t.rows, lim);
        excessos += a.excessos.length;
        velMax = Math.max(velMax, a.velMax);
      }
      const km = Math.round(js.reduce((s, j) => s + j.km, 0) * 10) / 10;
      const dirigindo = js.reduce((s, j) => s + j.dirigindo, 0);
      const maior = js.reduce((s, j) => Math.max(s, j.maiorContinua), 0);
      const acima = js.filter((j) => j.maiorContinua >= par.limiteSeg).length;
      const curtos = js.filter((j) => j.descansoAntes !== null && j.descansoAntes < DESCANSO_DIARIO_SEG).length;
      const nAl = alertas.filter((a) => a.motorista_id === m.id).length;
      const veics = new Set(trechos.map((t) => t.v.id));
      linhas.push([m.nome, m.matricula || '', js.length, km, dirigindo, maior, acima, curtos, excessos, velMax || null, nAl, veics.size]);
      tot.km += km; tot.dirigindo += dirigindo; tot.exc += excessos; tot.al += nAl; tot.jornadas += js.length;
    }
    return {
      titulo: TIPOS.motoristas.titulo,
      subtitulo: this.subtituloMotoristas(u, alvo, de, ate, q, [`Limite ${lim.limite} km/h`, `Direção contínua até ${fmtDuracao(par.limiteSeg).slice(0, -3)}`]),
      colunas: [
        { titulo: 'Motorista', tipo: 'texto', largura: 24, peso: 1.6 },
        { titulo: 'Matrícula', tipo: 'texto', largura: 11, peso: 0.8 },
        { titulo: 'Jornadas', tipo: 'inteiro', largura: 9, peso: 0.7, alinhar: 'd' },
        { titulo: 'Km', tipo: 'decimal', largura: 10, peso: 0.75, alinhar: 'd' },
        { titulo: 'Dirigindo', tipo: 'duracao', largura: 11, peso: 0.85, alinhar: 'd' },
        { titulo: 'Maior direção contínua', tipo: 'duracao', largura: 14, peso: 1, alinhar: 'd' },
        { titulo: 'Jornadas acima do limite', tipo: 'inteiro', largura: 12, peso: 0.9, alinhar: 'd' },
        { titulo: 'Descanso < 11 h', tipo: 'inteiro', largura: 11, peso: 0.85, alinhar: 'd' },
        { titulo: `Excessos (> ${lim.limite})`, tipo: 'inteiro', largura: 11, peso: 0.85, alinhar: 'd' },
        { titulo: 'Vel. máx. (km/h)', tipo: 'inteiro', largura: 12, peso: 0.85, alinhar: 'd' },
        { titulo: 'Alertas', tipo: 'inteiro', largura: 8, peso: 0.6, alinhar: 'd' },
        { titulo: 'Veículos', tipo: 'inteiro', largura: 8, peso: 0.6, alinhar: 'd' }],
      linhas,
      totais: linhas.length ? ['Total', null, tot.jornadas, Math.round(tot.km * 10) / 10, tot.dirigindo, null, null, null, tot.exc, null, tot.al, null] : null,
      resumo: [
        { rotulo: 'Motoristas', valor: fmtNum(linhas.length) },
        { rotulo: 'Km rodados', valor: `${fmtNum(tot.km, 1)} km` },
        { rotulo: 'Horas dirigindo', valor: fmtDuracao(tot.dirigindo).slice(0, -3) },
        { rotulo: 'Excessos de velocidade', valor: fmtNum(tot.exc) },
        { rotulo: 'Alertas', valor: fmtNum(tot.al) },
      ],
      vazio: 'Nenhum motorista dirigiu os veículos escolhidos no período (o motorista é escolhido no painel do veículo, no Monitoramento, ou pelo cartão no DVR).',
      observacao: `Contado só nos trechos em que cada motorista estava no veículo. Km e tempos pelo GPS; jornadas como no relatório de jornada (descanso de ${par.descanso} min, 8 h sem dirigir começa outra).`,
    };
  }

  /** Viagens das linhas no período: saída e chegada comparadas com o horário, pontos passados e pulados, fora da rota. */
  async viagens(u, q) {
    if (!permite(u, 'linhas')) throw new HttpErro(403, 'Sem acesso a Linhas e horários.');
    const { de, ate } = this.periodo(q, MAX_DIAS_ALERTAS);
    const emp = empresaAlvo(u, q.empresa ? V.id(q.empresa, 'a empresa') : null);
    const onde = ['v.previsto_inicio BETWEEN ? AND ?'];
    const args = [de, ate];
    if (emp) { onde.push('v.empresa_id = ?'); args.push(emp); }
    let linha = null;
    if (q.linha) {
      linha = await this.banco.um('SELECT id, empresa_id, grupo_id, codigo, nome FROM linhas WHERE id = ?', [V.id(q.linha, 'a linha')]);
      if (!linha || (u.perfil !== 'master' && linha.empresa_id !== u.empresaId) || (limitado(u) && linha.grupo_id && !u.grupos.has(linha.grupo_id))) throw new HttpErro(404, 'Linha não encontrada.');
      onde.push('v.linha_id = ?'); args.push(linha.id);
    }
    let veiculo = null;
    if (q.veiculo) {
      veiculo = this.frota.veiculos.get(V.id(q.veiculo, 'o veículo'));
      if (!veiculo || !this.acesso.veVeiculo(u, veiculo)) throw new HttpErro(404, 'Veículo não encontrado.');
      onde.push('v.veiculo_id = ?'); args.push(veiculo.id);
    }
    if (q.situacao) {
      const sit = V.opcao(q.situacao, ['concluida', 'incompleta', 'nao_realizada', 'cancelada', 'atrasadas'], 'a situação');
      if (sit === 'atrasadas') onde.push('v.atraso_max_seg > l.tolerancia_atraso_min * 60');
      else { onde.push('v.situacao = ?'); args.push(sit); }
    }
    const rows = await this.banco.query(`
      SELECT v.*, l.codigo, l.nome AS linha_nome, l.grupo_id, l.tolerancia_adiantado_min AS tol_ad, l.tolerancia_atraso_min AS tol_at,
             (SELECT p.diferenca_seg FROM viagem_pontos p WHERE p.viagem_id = v.id AND p.ordem = 1 AND p.situacao <> 'pulado') AS dif_saida,
             (SELECT p.diferenca_seg FROM viagem_pontos p WHERE p.viagem_id = v.id AND p.ordem = v.pontos_total AND p.situacao <> 'pulado') AS dif_chegada
        FROM viagens v JOIN linhas l ON l.id = v.linha_id
       WHERE ${onde.join(' AND ')} ORDER BY v.previsto_inicio, l.codigo, l.nome, v.id LIMIT ?`, [...args, MAX_LINHAS + 1]);
    if (rows.length > MAX_LINHAS) throw new HttpErro(400, 'Resultado grande demais: escolha um período menor ou uma linha.');
    const lista = rows.filter((r) => !limitado(u) || !r.grupo_id || u.grupos.has(r.grupo_id));
    const SIT = { prevista: 'Prevista', em_andamento: 'Em andamento', concluida: 'Concluída', incompleta: 'Incompleta', nao_realizada: 'Não realizada', cancelada: 'Cancelada' };
    const min = (seg) => {
      if (seg === null || seg === undefined) return '';
      const m = Math.round(Number(seg) / 60);
      return `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.abs(m)} min`;
    };
    const cont = { total: 0, feitas: 0, concl: 0, inc: 0, nao: 0, canc: 0, saidas: 0, saidaOk: 0, chegadas: 0, somaCheg: 0 };
    const linhas = lista.map((r) => {
      const ve = r.veiculo_id ? this.frota.veiculos.get(r.veiculo_id) : null;
      if (r.situacao === 'cancelada') cont.canc++; else cont.total++;
      if (r.situacao === 'concluida') cont.concl++;
      if (r.situacao === 'incompleta') cont.inc++;
      if (r.situacao === 'nao_realizada') cont.nao++;
      if (['concluida', 'incompleta', 'em_andamento'].includes(r.situacao)) cont.feitas++;
      if (r.dif_saida !== null && r.dif_saida !== undefined) {
        cont.saidas++;
        if (r.dif_saida >= -r.tol_ad * 60 && r.dif_saida <= r.tol_at * 60) cont.saidaOk++;
      }
      if (r.dif_chegada !== null && r.dif_chegada !== undefined) { cont.chegadas++; cont.somaCheg += Number(r.dif_chegada); }
      return [r.previsto_inicio, `${r.codigo ? `${r.codigo} · ` : ''}${r.linha_nome}`, ve ? this.nomeVeiculo(ve) : '', SIT[r.situacao] || r.situacao,
        r.inicio_real, min(r.dif_saida), r.fim_real, min(r.dif_chegada), `${r.pontos_passados}/${r.pontos_total}`, r.pontos_pulados,
        r.atraso_max_seg !== null && r.atraso_max_seg > 0 ? min(r.atraso_max_seg) : '', r.fora_rota_seg || null, r.observacao || ''];
    });
    const nomeEmp = emp ? this.nomeEmpresa(emp) : (u.perfil === 'master' ? 'Todas as empresas' : u.empresaNome);
    const quem = linha ? `Linha ${linha.codigo ? `${linha.codigo} · ` : ''}${linha.nome}` : 'Todas as linhas';
    const pct = (a, b) => (b ? `${fmtNum((a / b) * 100, 0)}%` : '—');
    return {
      titulo: TIPOS.viagens.titulo,
      subtitulo: [`${nomeEmp} · ${quem}${veiculo ? ` · Veículo ${this.nomeVeiculo(veiculo)}` : ''}`, `Período: ${fmtDataHora(de, false)} a ${fmtDataHora(ate, false)}`],
      colunas: [
        { titulo: 'Partida prevista', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Linha', tipo: 'texto', largura: 26, peso: 1.6 },
        { titulo: 'Veículo', tipo: 'texto', largura: 18, peso: 1.2 },
        { titulo: 'Situação', tipo: 'texto', largura: 14, peso: 0.95 },
        { titulo: 'Saída', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Dif. saída', tipo: 'texto', largura: 10, peso: 0.7, alinhar: 'd' },
        { titulo: 'Chegada', tipo: 'dataHora', largura: 19, peso: 1.25 },
        { titulo: 'Dif. chegada', tipo: 'texto', largura: 11, peso: 0.75, alinhar: 'd' },
        { titulo: 'Pontos', tipo: 'texto', largura: 8, peso: 0.6, alinhar: 'd' },
        { titulo: 'Pulados', tipo: 'inteiro', largura: 8, peso: 0.6, alinhar: 'd' },
        { titulo: 'Maior atraso', tipo: 'texto', largura: 11, peso: 0.75, alinhar: 'd' },
        { titulo: 'Fora da rota', tipo: 'duracao', largura: 11, peso: 0.75, alinhar: 'd' },
        { titulo: 'Observação', tipo: 'texto', largura: 30, peso: 1.4 }],
      linhas, totais: null,
      resumo: [
        { rotulo: 'Viagens previstas', valor: fmtNum(cont.total) },
        { rotulo: 'Concluídas', valor: fmtNum(cont.concl) },
        { rotulo: 'Incompletas', valor: fmtNum(cont.inc) },
        { rotulo: 'Não realizadas', valor: fmtNum(cont.nao) },
        { rotulo: 'Saída no horário', valor: pct(cont.saidaOk, cont.saidas) },
        { rotulo: 'Chegada (média)', valor: cont.chegadas ? min(Math.round(cont.somaCheg / cont.chegadas)) : '—' },
        ...(cont.canc ? [{ rotulo: 'Canceladas', valor: fmtNum(cont.canc) }] : []),
      ],
      vazio: 'Nenhuma viagem no período (as viagens saem das partidas cadastradas em Linhas e horários).',
      observacao: 'Diferença: + atrasado, − adiantado, comparado ao horário previsto (partida + minutos de cada ponto). No horário = dentro da tolerância da linha.',
    };
  }
}

/** Resultado → abas da planilha e dados do PDF */
function paraXlsx(r) {
  return [{
    nome: r.titulo, titulo: `${r.titulo} — FrotaGest`,
    subtitulo: [...r.subtitulo, `Gerado em ${fmtDataHora(r.geradoEm, false)} por ${r.geradoPor} · Reis Tecnologia`],
    colunas: r.colunas, linhas: r.linhas, totais: r.totais,
  }];
}

function paraPdf(r) {
  return {
    titulo: r.titulo,
    subtitulo: r.subtitulo,
    resumo: r.resumo,
    colunas: r.colunas.map((c) => ({ titulo: c.titulo, peso: c.peso, alinhar: c.alinhar })),
    linhas: r.linhas.map((l) => l.map((v, i) => fmtValor(v, r.colunas[i].tipo))),
    totais: r.totais ? r.totais.map((v, i) => fmtValor(v, r.colunas[i].tipo)) : null,
    vazio: r.vazio,
    observacao: r.observacao,
    rodape: `FrotaGest · Reis Tecnologia · Gerado em ${fmtDataHora(r.geradoEm, false)} por ${r.geradoPor}`,
  };
}

module.exports = { Relatorios, TIPOS, analisar, jornadas, percorrerCercas, paraXlsx, paraPdf, fmtValor, fmtDuracao, distanciaKm };
