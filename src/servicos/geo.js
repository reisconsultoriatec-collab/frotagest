'use strict';
/**
 * FrotaGest — geometria das cercas virtuais: dentro/fora de círculo e polígono, com folga na borda
 * (o GPS oscila uns metros com o veículo parado perto do limite) e descarte de saltos impossíveis.
 * O mesmo cálculo serve para os avisos ao vivo e para os relatórios (que refazem tudo pelas posições).
 * Reis Tecnologia
 */

const RAIO_TERRA = 6371000;
const FOLGA_M = 25; // para sair é preciso passar 25 m da borda (evita entra-e-sai de quem está parado no limite)
const SALTO_KMH = 200; // posição que exigiria mais que isso desde a anterior é erro de GPS
const SALTO_MIN_M = 300; // ...desde que a distância seja grande (saltos curtos não atrapalham)

const rad = (g) => (g * Math.PI) / 180;

/** Distância em metros entre dois pontos. */
function distM(la1, lo1, la2, lo2) {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 2 * RAIO_TERRA * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ponto dentro do polígono (raio cruzando as arestas; serve para áreas do tamanho de uma cidade). */
function dentroPoligono(lat, lng, pts) {
  let dentro = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ai, oi] = pts[i];
    const [aj, oj] = pts[j];
    if ((ai > lat) !== (aj > lat) && lng < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) dentro = !dentro;
  }
  return dentro;
}

/** Menor distância (m) do ponto até a borda do polígono, numa projeção plana em volta do ponto. */
function distBordaM(lat, lng, pts) {
  const kx = RAIO_TERRA * Math.cos(rad(lat)) * (Math.PI / 180);
  const ky = RAIO_TERRA * (Math.PI / 180);
  const xy = pts.map(([a, o]) => [(o - lng) * kx, (a - lat) * ky]);
  let min = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [x1, y1] = xy[j];
    const [x2, y2] = xy[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? -(x1 * dx + y1 * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    min = Math.min(min, Math.hypot(px, py));
  }
  return min;
}

/** Retângulo que contém a cerca (com a folga), para descartar rápido quem está longe. */
function caixa(c) {
  const folgaLat = (FOLGA_M + 10) / 111320;
  if (c.forma === 'circulo') {
    const dLat = c.raio / 111320 + folgaLat;
    const dLng = c.raio / (111320 * Math.max(0.05, Math.cos(rad(c.lat)))) + folgaLat * 2;
    return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLng: c.lng - dLng, maxLng: c.lng + dLng };
  }
  const lats = c.pontos.map((p) => p[0]);
  const lngs = c.pontos.map((p) => p[1]);
  return { minLat: Math.min(...lats) - folgaLat, maxLat: Math.max(...lats) + folgaLat, minLng: Math.min(...lngs) - folgaLat * 2, maxLng: Math.max(...lngs) + folgaLat * 2 };
}

/**
 * O ponto está dentro da cerca? Quem já estava dentro só sai depois de passar a folga da borda.
 * cerca: { forma, lat, lng, raio, pontos, caixa }
 */
function dentroDaCerca(c, lat, lng, estavaDentro = false) {
  const b = c.caixa || caixa(c);
  if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return false;
  const folga = estavaDentro ? FOLGA_M : 0;
  if (c.forma === 'circulo') return distM(c.lat, c.lng, lat, lng) <= c.raio + folga;
  if (dentroPoligono(lat, lng, c.pontos)) return true;
  return folga > 0 && distBordaM(lat, lng, c.pontos) <= folga;
}

/** Centro aproximado (para centralizar o mapa e calcular distâncias). */
function centro(c) {
  if (c.forma === 'circulo') return [c.lat, c.lng];
  const n = c.pontos.length;
  return [c.pontos.reduce((t, p) => t + p[0], 0) / n, c.pontos.reduce((t, p) => t + p[1], 0) / n];
}

/** Área aproximada em m² (para mostrar no cadastro). */
function areaM2(c) {
  if (c.forma === 'circulo') return Math.PI * c.raio * c.raio;
  const [la0, lo0] = centro(c);
  const kx = RAIO_TERRA * Math.cos(rad(la0)) * (Math.PI / 180);
  const ky = RAIO_TERRA * (Math.PI / 180);
  const xy = c.pontos.map(([a, o]) => [(o - lo0) * kx, (a - la0) * ky]);
  let s = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
  return Math.abs(s) / 2;
}

/**
 * Acompanha um veículo pelas cercas, posição a posição (em ordem de horário).
 * A primeira posição só diz onde ele está (sem evento); depois, cada troca vira 'entrada' ou 'saida'.
 */
class Rastreio {
  constructor() {
    this.dentro = new Map(); // cercaId → true/false
    this.ultimo = null; // { lat, lng, t }
    this.rejeitou = false; // a última posição foi descartada como salto do GPS
    this.saltos = 0; // descartes seguidos
  }

  /** cercas: lista das que valem para o veículo. Retorna [{ cerca, tipo }] e ignora saltos impossíveis. */
  passo(cercas, lat, lng, tMs) {
    this.rejeitou = true;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)) return [];
    if (this.ultimo) {
      const d = distM(this.ultimo.lat, this.ultimo.lng, lat, lng);
      const h = (tMs - this.ultimo.t) / 3600000;
      // um ponto fora da curva é descartado; vários seguidos querem dizer que o errado era o anterior
      if (d > SALTO_MIN_M && (h <= 0 || d / 1000 / h > SALTO_KMH) && this.saltos < 2) {
        this.saltos++;
        return [];
      }
    }
    this.saltos = 0;
    this.rejeitou = false;
    this.ultimo = { lat, lng, t: tMs };
    const eventos = [];
    for (const c of cercas) {
      const antes = this.dentro.get(c.id);
      const agora = dentroDaCerca(c, lat, lng, antes === true);
      this.dentro.set(c.id, agora);
      if (antes === undefined || antes === agora) continue;
      eventos.push({ cerca: c, tipo: agora ? 'entrada' : 'saida' });
    }
    return eventos;
  }

  /** Esquece cercas que não valem mais para o veículo (apagadas ou trocadas de grupo). */
  limpar(idsValidos) {
    for (const id of this.dentro.keys()) if (!idsValidos.has(id)) this.dentro.delete(id);
  }
}

/** "HH:MM" dentro da janela [inicio, fim] (que pode virar a meia-noite, ex.: 22:00 a 05:00)? */
function dentroDoHorario(hhmm, inicio, fim) {
  if (!inicio || !fim) return true;
  if (inicio <= fim) return hhmm >= inicio && hhmm <= fim;
  return hhmm >= inicio || hhmm <= fim;
}

module.exports = { distM, dentroPoligono, distBordaM, dentroDaCerca, caixa, centro, areaM2, Rastreio, dentroDoHorario, FOLGA_M };
