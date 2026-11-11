'use strict';
/**
 * FrotaGest — avisos no celular (e no computador) com o painel fechado, pelo Web Push do navegador.
 *
 *  - Cada pessoa ativa em cada aparelho dela (celular com o app instalado, computador) e escolhe
 *    o nível: só gravidade alta, alta e média, ou todos.
 *  - Recebe só o que veria no painel: precisa do menu Alertas e enxergar o veículo (empresa e grupos).
 *  - Vários alertas juntos (ex.: lote de uma área sem sinal) viram um aviso só, com o resumo.
 *  - Inscrição que o navegador cancelou (404/410) sai sozinha.
 * Reis Tecnologia
 */
const crypto = require('crypto');
const webpush = require('./webpush');
const { formatar, paraMs, agora, HttpErro } = require('../util/comum');
const { permite } = require('../auth/acesso');

const NIVEIS = { alta: ['alta'], media: ['alta', 'media'], todas: ['alta', 'media', 'baixa'] };
// serviços de push dos navegadores (o servidor só manda aviso para eles: nada de endereço qualquer)
const SERVICOS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const JUNTAR_MS = 4000; // alertas que chegam juntos viram um aviso só
const VELHO_MS = 10 * 60000; // alerta que chegou atrasado (posições de área sem sinal) não vira aviso
const MAX_FALHAS = 10;
const CACHE_USUARIO_MS = 60000;
const ORDEM = { alta: 0, media: 1, baixa: 2 };

const hashDe = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex');

class Avisos {
  constructor({ banco, frota, acesso, publicUrl = '', log = () => {}, hostsTeste = [], buscar = fetch }) {
    this.banco = banco;
    this.frota = frota;
    this.acesso = acesso;
    this.publicUrl = publicUrl;
    this.log = log;
    this.hostsTeste = hostsTeste; // só nos testes automatizados (serviço de push simulado em http)
    this.buscar = buscar;
    this.chaves = null;
    this.inscricoes = new Map(); // id → linha do banco
    this.jwts = new Map();
    this.filas = new Map(); // usuario_id → { alertas, timer }
    this.usuarios = new Map(); // usuario_id → { x, ate }
    this.enviados = 0;
    this.falhas = 0;
  }

  async iniciar() {
    let row = await this.banco.um("SELECT valor FROM configuracoes WHERE chave = 'push_vapid'");
    if (!row) {
      await this.banco.query("INSERT IGNORE INTO configuracoes (chave, valor) VALUES ('push_vapid', ?)", [JSON.stringify(webpush.gerarChaves())]);
      row = await this.banco.um("SELECT valor FROM configuracoes WHERE chave = 'push_vapid'");
    }
    this.chaves = JSON.parse(row.valor);
    await this.carregar();
  }

  async carregar() {
    const rows = await this.banco.query('SELECT * FROM push_inscricoes');
    this.inscricoes = new Map(rows.map((r) => [r.id, r]));
  }

  /** Quem manda o aviso (o serviço de push pede um contato: o endereço do painel). */
  get assunto() {
    return /^https:\/\//.test(this.publicUrl || '') ? this.publicUrl : 'mailto:avisos@frotagest.invalid';
  }

  chavePublica() {
    return this.chaves ? this.chaves.publica : null;
  }

  validar({ endpoint, keys }) {
    let url;
    try { url = new URL(String(endpoint || '')); } catch { throw new HttpErro(400, 'Inscrição de avisos inválida.'); }
    const teste = url.protocol === 'http:' && this.hostsTeste.includes(url.host);
    if (!teste && (url.protocol !== 'https:' || !SERVICOS.some((re) => re.test(url.hostname)))) {
      throw new HttpErro(400, 'Este navegador usa um serviço de avisos que o FrotaGest não reconhece.');
    }
    if (String(endpoint).length > 1000) throw new HttpErro(400, 'Inscrição de avisos inválida.');
    const p256dh = String((keys && keys.p256dh) || '');
    const auth = String((keys && keys.auth) || '');
    if (!/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) throw new HttpErro(400, 'Chaves da inscrição de avisos inválidas.');
    return { endpoint: String(endpoint), p256dh, auth };
  }

  /**
   * Liga os avisos neste aparelho para a pessoa. sincronizar: só atualiza se o aparelho já era dela
   * (ao abrir o painel), sem ligar nada que a pessoa não pediu.
   */
  async inscrever(u, corpo, aparelho) {
    const d = this.validar(corpo);
    const hash = hashDe(d.endpoint);
    const atual = await this.banco.um('SELECT id, usuario_id FROM push_inscricoes WHERE endpoint_hash = ?', [hash]);
    if (corpo.sincronizar) {
      if (!atual || atual.usuario_id !== u.id) return { ativo: false };
      await this.banco.query('UPDATE push_inscricoes SET p256dh = ?, auth = ?, aparelho = ? WHERE id = ?', [d.p256dh, d.auth, aparelho, atual.id]);
      await this.carregar();
      return { ativo: true, id: atual.id };
    }
    let id;
    if (atual) {
      // o mesmo navegador com outra pessoa: passa a ser de quem ativou agora
      await this.banco.query('UPDATE push_inscricoes SET usuario_id = ?, endpoint = ?, p256dh = ?, auth = ?, aparelho = ?, falhas = 0 WHERE id = ?',
        [u.id, d.endpoint, d.p256dh, d.auth, aparelho, atual.id]);
      id = atual.id;
    } else {
      const n = await this.banco.um('SELECT COUNT(*) AS n FROM push_inscricoes WHERE usuario_id = ?', [u.id]);
      if (n.n >= 10) throw new HttpErro(400, 'Você já tem 10 aparelhos recebendo avisos. Remova um da lista antes.');
      const r = await this.banco.query('INSERT INTO push_inscricoes (usuario_id, endpoint_hash, endpoint, p256dh, auth, aparelho, criado_em) VALUES (?)',
        [[u.id, hash, d.endpoint, d.p256dh, d.auth, aparelho, agora()]]);
      id = r.insertId;
    }
    await this.carregar();
    return { ativo: true, id };
  }

  /** Remove um aparelho da pessoa (pelo id da lista ou pelo endereço do próprio navegador). */
  async remover(u, { id = null, endpoint = null }) {
    const r = id
      ? await this.banco.query('DELETE FROM push_inscricoes WHERE id = ? AND usuario_id = ?', [id, u.id])
      : await this.banco.query('DELETE FROM push_inscricoes WHERE endpoint_hash = ? AND usuario_id = ?', [hashDe(endpoint), u.id]);
    await this.carregar();
    return r.affectedRows > 0;
  }

  async situacao(u) {
    const row = await this.banco.um('SELECT push_nivel FROM usuarios WHERE id = ?', [u.id]);
    const aparelhos = [...this.inscricoes.values()].filter((i) => i.usuario_id === u.id)
      .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)))
      .map((i) => ({ id: i.id, nome: i.aparelho || 'Navegador', hash: i.endpoint_hash, criadoEm: i.criado_em, usadoEm: i.usado_em, falhas: i.falhas }));
    return { disponivel: Boolean(this.chaves), chavePublica: this.chavePublica(), nivel: NIVEIS[row && row.push_nivel] ? row.push_nivel : 'alta', aparelhos };
  }

  async definirNivel(u, nivel) {
    if (!NIVEIS[nivel]) throw new HttpErro(400, 'Nível de aviso inválido.');
    await this.banco.query('UPDATE usuarios SET push_nivel = ? WHERE id = ?', [nivel, u.id]);
    this.usuarios.delete(u.id);
  }

  /* ---------- alertas novos ---------- */

  /** Evento do histórico (alerta novo): decide quem recebe e junta numa fila curta por pessoa. */
  alerta(ev) {
    if (!ev || ev.acao !== 'novo' || !ev.alerta || !this.inscricoes.size) return;
    const a = ev.alerta;
    const t = paraMs(a.inicio);
    if (Number.isFinite(t) && Date.now() - t > VELHO_MS) return;
    const pessoas = new Set([...this.inscricoes.values()].map((i) => i.usuario_id));
    for (const id of pessoas) this.paraUsuario(id, a).catch((e) => this.log('erro', `Avisos no celular: ${e.message}`));
  }

  async paraUsuario(id, a) {
    const x = await this.usuario(id);
    if (!x) return;
    if (!permite(x.u, 'alertas')) return;
    if (!(NIVEIS[x.nivel] || NIVEIS.alta).includes(a.gravidade)) return;
    const ap = this.frota.aparelhos.get(a.aparelhoId);
    if (!ap || !this.acesso.veAparelho(x.u, ap)) return;
    let f = this.filas.get(id);
    if (!f) {
      f = { alertas: [], timer: setTimeout(() => this.despachar(id).catch((e) => this.log('erro', `Avisos no celular: ${e.message}`)), JUNTAR_MS) };
      f.timer.unref?.();
      this.filas.set(id, f);
    }
    f.alertas.push(a);
  }

  /** A pessoa como o painel a vê (perfil, grupos, acessos) e o nível escolhido; null = não recebe. */
  async usuario(id) {
    const c = this.usuarios.get(id);
    if (c && c.ate > Date.now()) return c.x;
    let x = null;
    const row = await this.banco.um('SELECT id, firebase_uid, email, ativo, pendente, push_nivel FROM usuarios WHERE id = ?', [id]);
    if (row && row.ativo && !row.pendente && row.firebase_uid) {
      try {
        x = { u: await this.acesso.resolver({ uid: row.firebase_uid, email: row.email }), nivel: row.push_nivel };
      } catch { x = null; } // desativado, empresa desativada...
    }
    this.usuarios.set(id, { x, ate: Date.now() + CACHE_USUARIO_MS });
    if (this.usuarios.size > 5000) this.usuarios.clear();
    return x;
  }

  /** Mudou o acesso de alguém: confere de novo no próximo alerta. */
  esquecer(id) {
    if (id) this.usuarios.delete(id); else this.usuarios.clear();
  }

  rotulo(a) {
    const v = a.veiculoId ? this.frota.veiculos.get(a.veiculoId) : null;
    if (v) return v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa;
    return a.ident ? `Aparelho ${a.ident}` : 'Veículo';
  }

  /** Texto do aviso: um alerta, ou o resumo de vários. */
  mensagem(alertas, comEmpresa) {
    const l = [...alertas].sort((x, y) => ORDEM[x.gravidade] - ORDEM[y.gravidade] || String(y.inicio).localeCompare(String(x.inicio)));
    const a = l[0];
    const emp = (x) => {
      if (!comEmpresa) return '';
      const e = this.frota.empresas.get(x.empresaId);
      return e ? `${e.nome} · ` : '';
    };
    if (l.length === 1) {
      const vel = Number(a.velocidade) > 0 ? ` · ${Math.round(Number(a.velocidade))} km/h` : '';
      return {
        t: a.nome, b: `${emp(a)}${this.rotulo(a)} · ${String(a.inicio || formatar()).slice(11, 16)}${vel}`,
        tag: `fg-a${a.id}`, g: a.gravidade, u: '/#/alertas', em: paraMs(a.inicio) || Date.now(),
      };
    }
    const altas = l.filter((x) => x.gravidade === 'alta').length;
    return {
      t: `${l.length} alertas novos`,
      b: `${altas ? `${altas} de gravidade alta · ` : ''}${a.nome} — ${emp(a)}${this.rotulo(a)}`,
      tag: 'fg-resumo', g: a.gravidade, u: '/#/alertas', em: Date.now(),
    };
  }

  async despachar(id) {
    const f = this.filas.get(id);
    this.filas.delete(id);
    if (!f || !f.alertas.length) return;
    const x = await this.usuario(id);
    if (!x) return;
    const msg = this.mensagem(f.alertas, x.u.perfil === 'master');
    const alta = msg.g === 'alta';
    const destinos = [...this.inscricoes.values()].filter((i) => i.usuario_id === id);
    await Promise.all(destinos.map((i) => this.enviarPara(i, msg, { ttl: alta ? 3600 : 1800, urgencia: alta ? 'high' : 'normal' })));
  }

  async enviarPara(insc, conteudo, { ttl = 1800, urgencia = 'normal' } = {}) {
    let status = 0;
    let texto = '';
    try {
      ({ status, texto } = await webpush.enviar(insc, JSON.stringify(conteudo), {
        chaves: this.chaves, assunto: this.assunto, ttl, urgencia, jwts: this.jwts, buscar: this.buscar,
      }));
    } catch (e) {
      texto = e.message;
    }
    if (status >= 200 && status < 300) {
      this.enviados++;
      insc.falhas = 0;
      await this.banco.query('UPDATE push_inscricoes SET usado_em = ?, falhas = 0 WHERE id = ?', [agora(), insc.id]).catch(() => {});
      return { ok: true, status };
    }
    this.falhas++;
    if (status === 404 || status === 410) {
      // o navegador cancelou a inscrição (desinstalou o app, limpou os dados, bloqueou os avisos)
      await this.banco.query('DELETE FROM push_inscricoes WHERE id = ?', [insc.id]).catch(() => {});
      this.inscricoes.delete(insc.id);
      this.log('info', `Avisos no celular: inscrição de ${insc.aparelho || 'um aparelho'} não existe mais (removida)`);
      return { ok: false, status, expirou: true };
    }
    insc.falhas = (insc.falhas || 0) + 1;
    if (insc.falhas >= MAX_FALHAS) {
      await this.banco.query('DELETE FROM push_inscricoes WHERE id = ?', [insc.id]).catch(() => {});
      this.inscricoes.delete(insc.id);
    } else {
      await this.banco.query('UPDATE push_inscricoes SET falhas = ? WHERE id = ?', [insc.falhas, insc.id]).catch(() => {});
    }
    this.log('aviso', `Avisos no celular: ${insc.aparelho || 'aparelho'} recusou (${status || 'sem resposta'}${texto ? `: ${texto}` : ''})`);
    return { ok: false, status, erro: texto };
  }

  /** Aviso de teste para os aparelhos da pessoa (ou um só). */
  async teste(u, id = null) {
    const destinos = [...this.inscricoes.values()].filter((i) => i.usuario_id === u.id && (!id || i.id === id));
    if (!destinos.length) throw new HttpErro(400, 'Nenhum aparelho seu recebe avisos ainda: ative neste aparelho primeiro.');
    const msg = { t: 'FrotaGest: aviso de teste', b: 'Pronto: os alertas vão chegar aqui mesmo com o painel fechado.', tag: 'fg-teste', g: 'media', u: '/#/alertas', em: Date.now() };
    const r = await Promise.all(destinos.map((i) => this.enviarPara(i, msg, { ttl: 600 }).then((x) => ({ id: i.id, nome: i.aparelho, ...x }))));
    return { enviados: r.filter((x) => x.ok).length, resultados: r };
  }

  resumo() {
    return { inscricoes: this.inscricoes.size, enviados: this.enviados, falhas: this.falhas };
  }
}

module.exports = { Avisos, NIVEIS, hashDe };
