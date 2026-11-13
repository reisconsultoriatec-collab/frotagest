'use strict';
/**
 * FrotaGest — links de acompanhamento: uma página pública (sem login), com prazo, para quem está fora do
 * painel acompanhar:
 *  - link de VEÍCULO: só a posição do veículo, até o link vencer (cliente de fretamento, viagem avulsa);
 *  - link de LINHA: as viagens da linha enquanto estão rodando (fora delas, o veículo não aparece), com a
 *    hora estimada em cada ponto. Quem acompanha escolhe o seu ponto e liga o aviso "está chegando" no
 *    celular (Web Push, sem cadastro): o aviso sai quando a viagem estiver a X minutos do ponto.
 * A página nunca mostra motorista, alertas, câmeras nem outros veículos. Reis Tecnologia
 */
const crypto = require('crypto');
const { agora, formatar, paraMs, HttpErro } = require('../util/comum');

const TICK_MS = 15000;
const MAX_INSCRICOES_LINK = 500; // avisos por link (ex.: os pais de uma escola)
const DIAS_GUARDAR = 30; // link vencido ou cancelado sai da lista 30 dias depois
const ACESSO_GRAVAR_MS = 60000;
const NOMES_VEICULO = { van: ['A van', 'a van'], onibus: ['O ônibus', 'o ônibus'], 'micro-onibus': ['O micro-ônibus', 'o micro-ônibus'] };

const hhmm = (ms) => formatar(ms).slice(11, 16);
/** 'Ônibus' / 'onibus' / 'Micro-ônibus' → chave sem acento */
const tipoChave = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

class Acompanhamento {
  constructor({ banco, frota, monitor, linhas, avisos, log = () => {} }) {
    this.banco = banco;
    this.frota = frota;
    this.monitor = monitor;
    this.linhas = linhas;
    this.avisos = avisos;
    this.log = log;
    this.links = new Map(); // token → link válido
    this.porId = new Map(); // id → link válido
    this.inscricoes = new Map(); // link_id → Map(endpoint → inscrição)
    this.acessoGravado = new Map(); // link_id → ms
    this.limpezaDia = null;
    this.enviados = 0;
  }

  async iniciar() {
    await this.carregar();
    this.timer = setInterval(() => this.tick().catch((e) => this.log('erro', `Acompanhamento: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  parar() { clearInterval(this.timer); }

  async carregar() {
    const ls = await this.banco.query('SELECT * FROM links_acompanhamento WHERE revogado_em IS NULL AND (expira_em IS NULL OR expira_em > ?)', [agora()]);
    this.links = new Map(ls.map((l) => [l.token, l]));
    this.porId = new Map(ls.map((l) => [l.id, l]));
    const ins = ls.length ? await this.banco.query('SELECT * FROM links_avisos WHERE link_id IN (?)', [ls.map((l) => l.id)]) : [];
    this.inscricoes = new Map();
    for (const i of ins) this.guardarInscricao(i);
  }

  guardarInscricao(i) {
    if (!this.inscricoes.has(i.link_id)) this.inscricoes.set(i.link_id, new Map());
    this.inscricoes.get(i.link_id).set(i.endpoint, i);
  }

  valido(l) {
    return Boolean(l) && !l.revogado_em && (!l.expira_em || paraMs(l.expira_em) > Date.now());
  }

  /** Link pelo endereço público (só se ainda vale). */
  doToken(token) {
    const l = this.links.get(String(token || ''));
    return this.valido(l) ? l : null;
  }

  async criar(u, d) {
    const token = crypto.randomBytes(18).toString('base64url');
    const r = await this.banco.query(`INSERT INTO links_acompanhamento (empresa_id, token, tipo, veiculo_id, linha_id, nome, mostrar_veiculo, criado_por, criado_em, expira_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [d.empresaId, token, d.tipo, d.veiculoId || null, d.linhaId || null, d.nome || null, d.mostrarVeiculo ? 1 : 0, u.id, agora(), d.expiraEm || null]);
    const l = await this.banco.um('SELECT * FROM links_acompanhamento WHERE id = ?', [r.insertId]);
    this.links.set(l.token, l);
    this.porId.set(l.id, l);
    return l;
  }

  async revogar(u, l) {
    await this.banco.query('UPDATE links_acompanhamento SET revogado_em = ?, revogado_por = ? WHERE id = ?', [agora(), u.id, l.id]);
    await this.banco.query('DELETE FROM links_avisos WHERE link_id = ?', [l.id]);
    this.links.delete(l.token);
    this.porId.delete(l.id);
    this.inscricoes.delete(l.id);
  }

  /** Conta quem abriu a página (a primeira carga) e guarda o último acesso (no máximo 1 vez por minuto). */
  async acesso(l, primeira) {
    const t = Date.now();
    if (!primeira && t - (this.acessoGravado.get(l.id) || 0) < ACESSO_GRAVAR_MS) return;
    this.acessoGravado.set(l.id, t);
    await this.banco.query(`UPDATE links_acompanhamento SET ${primeira ? 'acessos = acessos + 1, ' : ''}ultimo_acesso = ? WHERE id = ?`, [agora(), l.id]).catch(() => {});
  }

  /* ---------- a página pública ---------- */

  rotuloVeiculo(v) { return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : ''; }

  /** Posição para a página: só o necessário. */
  posicao(veiculoId) {
    const it = this.monitor.porVeiculo(veiculoId);
    if (!it || !it.posicao) return null;
    const p = it.posicao;
    return { lat: p.lat, lng: p.lng, vel: Math.round(Number(p.vel) || 0), dir: p.dir ?? null, hora: p.hora || null, online: Boolean(it.online) };
  }

  titulo(l) {
    if (l.tipo === 'veiculo') {
      const v = this.frota.veiculos.get(l.veiculo_id);
      return l.mostrar_veiculo && v ? `Veículo ${this.rotuloVeiculo(v)}` : 'Veículo';
    }
    const ln = this.linhas.linhas.get(l.linha_id);
    return ln ? `${ln.codigo ? `Linha ${ln.codigo} · ` : ''}${ln.nome}` : 'Linha';
  }

  publico(l) {
    const emp = this.frota.empresas.get(l.empresa_id);
    const base = {
      tipo: l.tipo, titulo: this.titulo(l), empresa: emp ? emp.nome : '', validoAte: l.expira_em, agora: agora(),
    };
    if (l.tipo === 'veiculo') {
      const v = this.frota.veiculos.get(l.veiculo_id);
      if (!v || !v.ativo) return { ...base, estado: 'indisponivel' };
      const pos = this.posicao(v.id);
      return { ...base, estado: pos ? 'ao_vivo' : 'sem_posicao', veiculo: l.mostrar_veiculo ? this.rotuloVeiculo(v) : null, tipoVeiculo: v.tipo, posicao: pos };
    }
    const ln = this.linhas.linhas.get(l.linha_id);
    if (!ln || !ln.ativo) return { ...base, estado: 'linha_desligada' };
    const linha = {
      cor: ln.cor || '#2563EB', percurso: ln.percurso && ln.percurso.length > 1 ? ln.percurso : null,
      pontos: ln.pontos.map((p) => ({ ordem: p.ordem, nome: p.nome, lat: p.latitude, lng: p.longitude })),
    };
    const agoraMs = Date.now();
    const vs = this.linhas.viagensDaLinha(ln.id);
    const rodando = vs.filter((v) => v.situacao === 'em_andamento').slice(0, 10);
    const prevista = vs.find((v) => v.situacao === 'prevista' && v.inicio + 60 * 60000 >= agoraMs) || null;
    const viagens = rodando.map((v) => {
      const ve = this.frota.veiculos.get(v.veiculo_id);
      return {
        id: v.id, inicioPrevisto: formatar(v.inicio), inicioReal: v.inicio_real || null,
        veiculo: l.mostrar_veiculo && ve ? this.rotuloVeiculo(ve) : null, tipoVeiculo: ve ? ve.tipo : null,
        posicao: v.veiculo_id ? this.posicao(v.veiculo_id) : null,
        pontos: v.pontos.map((p, k) => {
          const e = this.linhas.estimar(v, k, agoraMs) || {};
          return { ordem: p.ordem, previsto: formatar(p.previsto), passou: e.passou ? formatar(e.passou) : null, pulado: Boolean(e.pulado), estimado: e.estimado ? formatar(e.estimado) : null };
        }),
      };
    });
    return {
      ...base, estado: viagens.length ? 'ao_vivo' : prevista ? 'aguardando' : 'sem_viagem', linha, viagens,
      proxima: prevista ? { inicio: formatar(prevista.inicio), atrasada: agoraMs > prevista.inicio } : this.proximaPartida(ln, agoraMs),
      avisos: { disponivel: Boolean(this.avisos && this.avisos.chavePublica()), chavePublica: this.avisos ? this.avisos.chavePublica() : null },
    };
  }

  /** Próxima partida pelos horários (nos próximos 7 dias), para quando nenhuma viagem está prevista agora. */
  proximaPartida(ln, agoraMs) {
    const hoje = formatar(agoraMs).slice(0, 10);
    for (let d = 0; d < 8; d++) {
      const [a, m, dd] = hoje.split('-').map(Number);
      const data = new Date(Date.UTC(a, m - 1, dd + d)).toISOString().slice(0, 10);
      const wd = String(((new Date(Date.UTC(a, m - 1, dd + d)).getUTCDay() + 6) % 7) + 1);
      const hs = ln.partidas.filter((p) => p.ativo && p.dias.includes(wd)).map((p) => `${data} ${p.horario}`).filter((t) => paraMs(t) > agoraMs).sort();
      if (hs.length) return { inicio: hs[0], atrasada: false };
    }
    return null;
  }

  /* ---------- aviso "está chegando" ---------- */

  async inscrever(l, corpo) {
    if (l.tipo !== 'linha') throw new HttpErro(400, 'O aviso de chegada é só para os links de linha.');
    if (!this.avisos || !this.avisos.chavePublica()) throw new HttpErro(503, 'Os avisos no celular não estão disponíveis neste servidor.');
    const d = this.avisos.validar(corpo || {});
    const ln = this.linhas.linhas.get(l.linha_id);
    const ordem = Number(corpo.ponto);
    if (!ln || !ln.pontos.some((p) => p.ordem === ordem)) throw new HttpErro(400, 'Escolha o seu ponto.');
    const minutos = Number(corpo.minutos);
    if (![2, 5, 10, 15, 20, 30].includes(minutos)) throw new HttpErro(400, 'Escolha com quantos minutos avisar.');
    const atuais = this.inscricoes.get(l.id) || new Map();
    const ja = atuais.get(d.endpoint);
    if (!ja && atuais.size >= MAX_INSCRICOES_LINK) throw new HttpErro(409, 'Este link já tem avisos demais. Peça um link novo à empresa.');
    if (ja) {
      await this.banco.query('UPDATE links_avisos SET p256dh = ?, auth = ?, ponto_ordem = ?, minutos = ?, falhas = 0 WHERE id = ?', [d.p256dh, d.auth, ordem, minutos, ja.id]);
      Object.assign(ja, { p256dh: d.p256dh, auth: d.auth, ponto_ordem: ordem, minutos, falhas: 0 });
      return ja;
    }
    const r = await this.banco.query('INSERT INTO links_avisos (link_id, endpoint, p256dh, auth, ponto_ordem, minutos, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [l.id, d.endpoint, d.p256dh, d.auth, ordem, minutos, agora()]);
    const i = { id: r.insertId, link_id: l.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, ponto_ordem: ordem, minutos, ultimo_aviso_viagem: null, falhas: 0 };
    this.guardarInscricao(i);
    return i;
  }

  async desinscrever(l, endpoint) {
    const m = this.inscricoes.get(l.id);
    const i = m && m.get(String(endpoint || ''));
    if (!i) return false;
    m.delete(i.endpoint);
    await this.banco.query('DELETE FROM links_avisos WHERE id = ?', [i.id]);
    return true;
  }

  inscricaoDe(l, endpoint) {
    const m = this.inscricoes.get(l.id);
    const i = m && m.get(String(endpoint || ''));
    return i ? { ponto: i.ponto_ordem, minutos: i.minutos } : null;
  }

  async tick() {
    const hoje = agora().slice(0, 10);
    if (this.limpezaDia !== hoje) { this.limpezaDia = hoje; await this.limpar(); }
    // link que venceu: sai da memória junto com os avisos
    for (const l of [...this.porId.values()]) {
      if (this.valido(l)) continue;
      this.links.delete(l.token);
      this.porId.delete(l.id);
      if (this.inscricoes.has(l.id)) {
        this.inscricoes.delete(l.id);
        await this.banco.query('DELETE FROM links_avisos WHERE link_id = ?', [l.id]);
      }
    }
    const t = Date.now();
    for (const [linkId, m] of this.inscricoes) {
      if (!m.size) continue;
      const l = this.porId.get(linkId);
      const ln = l && this.linhas.linhas.get(l.linha_id);
      if (!ln) continue;
      const rodando = this.linhas.viagensDaLinha(ln.id).filter((v) => v.situacao === 'em_andamento');
      if (!rodando.length) continue;
      for (const i of [...m.values()]) {
        // a viagem que vai chegar primeiro ao ponto (e ainda não avisada para esta pessoa)
        let alvo = null;
        for (const v of rodando) {
          const k = v.pontos.findIndex((p) => p.ordem === i.ponto_ordem);
          const e = k >= 0 ? this.linhas.estimar(v, k, t) : null;
          if (!e || !e.estimado) continue;
          if (!alvo || e.estimado < alvo.quando) alvo = { v, k, quando: e.estimado };
        }
        if (!alvo || Number(i.ultimo_aviso_viagem) === alvo.v.id) continue;
        if (alvo.quando - t > i.minutos * 60000) continue;
        await this.avisar(l, ln, i, alvo, t);
      }
    }
  }

  async avisar(l, ln, i, alvo, t) {
    i.ultimo_aviso_viagem = alvo.v.id;
    await this.banco.query('UPDATE links_avisos SET ultimo_aviso_viagem = ?, ultimo_aviso_em = ? WHERE id = ?', [alvo.v.id, agora(), i.id]).catch(() => {});
    const ve = this.frota.veiculos.get(alvo.v.veiculo_id);
    const [Quem] = NOMES_VEICULO[tipoChave(ve && ve.tipo)] || ['O veículo'];
    const ponto = alvo.v.pontos[alvo.k];
    const min = Math.max(1, Math.round((alvo.quando - t) / 60000));
    const msg = {
      t: `${Quem} está chegando`,
      b: `${this.titulo(l)}: deve passar no ponto ${ponto.nome} em ~${min} min (${hhmm(alvo.quando)}).${l.mostrar_veiculo && ve ? ` Veículo ${this.rotuloVeiculo(ve)}.` : ''}`,
      tag: `fg-a${l.id}`, g: 'alta', u: `/a/${l.token}`, em: t,
    };
    const r = await this.avisos.enviarAvulso(i, msg, { ttl: Math.max(60, i.minutos * 60), urgencia: 'high' });
    if (r.ok) { this.enviados++; if (i.falhas) { i.falhas = 0; await this.banco.query('UPDATE links_avisos SET falhas = 0 WHERE id = ?', [i.id]).catch(() => {}); } return; }
    i.falhas = (i.falhas || 0) + 1;
    if (r.expirou || i.falhas >= 5) {
      const m = this.inscricoes.get(l.id);
      if (m) m.delete(i.endpoint);
      await this.banco.query('DELETE FROM links_avisos WHERE id = ?', [i.id]).catch(() => {});
    } else await this.banco.query('UPDATE links_avisos SET falhas = ? WHERE id = ?', [i.falhas, i.id]).catch(() => {});
  }

  /** Links vencidos ou cancelados há mais de 30 dias saem do banco (o histórico fica na auditoria). */
  async limpar() {
    const corte = formatar(Date.now() - DIAS_GUARDAR * 86400000);
    const velhos = await this.banco.query('SELECT id FROM links_acompanhamento WHERE (revogado_em IS NOT NULL AND revogado_em < ?) OR (expira_em IS NOT NULL AND expira_em < ?)', [corte, corte]);
    if (!velhos.length) return;
    const ids = velhos.map((x) => x.id);
    await this.banco.query('DELETE FROM links_avisos WHERE link_id IN (?)', [ids]);
    await this.banco.query('DELETE FROM links_acompanhamento WHERE id IN (?)', [ids]);
  }

  resumo() {
    let n = 0;
    for (const m of this.inscricoes.values()) n += m.size;
    return { links: this.links.size, avisos: n, enviados: this.enviados };
  }
}

module.exports = { Acompanhamento };
