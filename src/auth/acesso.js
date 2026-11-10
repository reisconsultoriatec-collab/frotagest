'use strict';
/**
 * FrotaGest — quem é o usuário e o que ele pode ver/fazer.
 *
 * Perfis:
 *  - master       (Reis Tecnologia) vê todas as empresas; cadastra empresas, aparelhos e portas/protocolos.
 *  - admin        administra a própria empresa: usuários, grupos e veículos; vê toda a frota dela.
 *  - operador     mapa, vídeo ao vivo, gravações do DVR e tratamento de alertas (nos grupos liberados).
 *  - visualizador mapa, vídeo ao vivo, histórico e alertas, sem gravações nem tratamento.
 * O perfil decide a empresa e os grupos que a pessoa enxerga; os menus e as ações (ver, incluir,
 * alterar, excluir) partem do padrão do perfil e podem ser personalizados por usuário no
 * Controle de acesso (permissoes.js).
 * Reis Tecnologia
 */
const { HttpErro, agora } = require('../util/comum');
const permissoes = require('./permissoes');

/* O que cada perfil faz por padrão está em permissoes.js (PADRAO); o master pode personalizar
 * por usuário no menu Controle de acesso. Aqui ficam só os nomes. */
const PERFIS = {
  master: { nome: 'Master (Reis Tecnologia)' },
  admin: { nome: 'Administrador da empresa' },
  operador: { nome: 'Operador' },
  visualizador: { nome: 'Visualizador' },
};

const CACHE_MS = 30000;

class Acesso {
  constructor({ banco, firebase, frota, proprietarios = [], log = () => {} }) {
    this.banco = banco;
    this.firebase = firebase;
    this.frota = frota;
    this.proprietarios = new Set(proprietarios.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
    this.log = log;
    this.cache = new Map(); // uid → { u, ate }
    this.acessos = new Map(); // usuario_id → última gravação de ultimo_acesso
    this.encerradas = new Set(); // `${uid}:${auth_time}` dos logins encerrados por um administrador
    frota.on('recarregada', () => this.invalidar());
  }

  /** Logins encerrados nos últimos 90 dias (os mais antigos o Firebase já não renova). */
  async carregarEncerradas() {
    try {
      await this.banco.query('DELETE FROM sessoes_encerradas WHERE encerrado_em < NOW() - INTERVAL 90 DAY');
      const rows = await this.banco.query('SELECT firebase_uid, auth_time FROM sessoes_encerradas');
      this.encerradas = new Set(rows.map((r) => `${r.firebase_uid}:${r.auth_time}`));
    } catch (e) {
      this.log('erro', `Falha ao ler as sessões encerradas: ${e.message}`);
    }
  }

  /** Encerra um login (só aquele aparelho/navegador): os próximos pedidos dele são recusados. */
  async encerrarSessao(uid, authTime, usuarioId, porId) {
    this.encerradas.add(`${uid}:${authTime}`);
    await this.banco.query(
      'INSERT IGNORE INTO sessoes_encerradas (firebase_uid, auth_time, usuario_id, encerrado_por) VALUES (?)',
      [[uid, authTime, usuarioId, porId]],
    );
  }

  sessaoEncerrada(claims) {
    return this.encerradas.has(`${claims.uid}:${claims.authTime}`);
  }

  invalidar() {
    this.cache.clear();
  }

  /** Token do Firebase → usuário do FrotaGest. Erros: 401 (token) ou 403 (sem cadastro/bloqueado). */
  /** Só confere o token (para o cadastro de quem ainda não tem usuário no FrotaGest). */
  async claims(token) {
    try {
      return await this.firebase.verificar(token);
    } catch (e) {
      throw new HttpErro(401, 'Sessão inválida ou expirada. Entre novamente.', 'token_invalido');
    }
  }

  ehProprietario(email) {
    return this.proprietarios.has(String(email || '').toLowerCase());
  }

  /** Cria o usuário master do proprietário do sistema (e-mail em "proprietarios", já confirmado). */
  async criarMaster(claims, nome) {
    const r = await this.banco.query(
      "INSERT INTO usuarios (email, nome, perfil, firebase_uid, todos_grupos, ativo) VALUES (?, ?, 'master', ?, 1, 1)",
      [claims.email, String(nome || claims.nome || claims.email.split('@')[0]).slice(0, 120), claims.uid],
    );
    this.log('ok', `Proprietário do sistema ${claims.email} entrou pela primeira vez (perfil master criado)`);
    return this.banco.um('SELECT * FROM usuarios WHERE id = ?', [r.insertId]);
  }

  async doToken(token) {
    return this.doClaims(await this.claims(token));
  }

  /** Login já conferido → usuário do FrotaGest (recusa o login que um administrador encerrou). */
  async doClaims(claims) {
    if (this.sessaoEncerrada(claims)) throw new HttpErro(401, 'Sua sessão foi encerrada por um administrador. Entre novamente.', 'sessao_encerrada');
    const c = this.cache.get(claims.uid);
    if (c && c.ate > Date.now()) return c.u;
    const u = await this.resolver(claims);
    this.cache.set(claims.uid, { u, ate: Date.now() + CACHE_MS });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    return u;
  }

  async resolver(claims) {
    let row = await this.banco.um('SELECT * FROM usuarios WHERE firebase_uid = ?', [claims.uid]);
    if (!row && claims.email) {
      const porEmail = await this.banco.um('SELECT * FROM usuarios WHERE email = ?', [claims.email]);
      if (porEmail) {
        if (porEmail.firebase_uid && porEmail.firebase_uid !== claims.uid) {
          throw new HttpErro(403, 'Este e-mail está ligado a outra conta de login. Peça ao administrador para reenviar o convite.', 'conta_divergente');
        }
        // primeiro acesso de quem foi convidado com e-mail que já tinha conta no Firebase: exige e-mail confirmado
        if (!claims.emailVerificado) throw new HttpErro(403, 'Confirme o seu e-mail para concluir o primeiro acesso.', 'email_nao_verificado');
        await this.banco.query('UPDATE usuarios SET firebase_uid = ? WHERE id = ? AND firebase_uid IS NULL', [claims.uid, porEmail.id]);
        row = { ...porEmail, firebase_uid: claims.uid };
      } else if (this.ehProprietario(claims.email)) {
        if (!claims.emailVerificado) throw new HttpErro(403, 'Confirme o seu e-mail para entrar como proprietário do sistema.', 'email_nao_verificado');
        row = await this.criarMaster(claims);
      }
    }
    if (!row) throw new HttpErro(403, 'Falta concluir o seu cadastro no FrotaGest: informe o código da sua empresa.', 'sem_cadastro');
    if (row.pendente) {
      const emp = this.frota.empresas.get(row.empresa_id);
      throw new HttpErro(403, 'Seu cadastro foi recebido e aguarda a aprovação do administrador da empresa.', 'pendente', { empresa: emp ? emp.nome : '' });
    }
    if (!row.ativo) throw new HttpErro(403, 'Seu acesso ao FrotaGest está desativado.', 'inativo');
    let empresaNome = null;
    if (row.perfil !== 'master') {
      const emp = this.frota.empresas.get(row.empresa_id);
      if (!emp || !emp.ativo) throw new HttpErro(403, 'O acesso da sua empresa ao FrotaGest está desativado.', 'empresa_inativa');
      empresaNome = emp.nome;
    }
    const todos = Boolean(row.todos_grupos) || row.perfil === 'master' || row.perfil === 'admin';
    const acessos = permissoes.efetivo(row.perfil, row.acessos);
    const grupos = new Set();
    if (!todos) {
      const gs = await this.banco.query('SELECT grupo_id FROM usuario_grupos WHERE usuario_id = ?', [row.id]);
      for (const g of gs) this.frota.descendentes(g.grupo_id, grupos);
    }
    return {
      id: row.id,
      uid: row.firebase_uid,
      nome: row.nome,
      email: row.email,
      perfil: row.perfil,
      perfilNome: PERFIS[row.perfil].nome,
      empresaId: row.perfil === 'master' ? null : row.empresa_id,
      empresaNome,
      todosGrupos: todos,
      grupos,
      acessos, // { tela: [ver, incluir, alterar, excluir] } — menus e ações liberados
      acessoPersonalizado: row.perfil !== 'master' && permissoes.ler(row.acessos) !== null,
      pode: permissoes.capacidades(row.perfil, acessos),
      doisFatoresAtivo: Boolean(row.totp_segredo), // aplicativo autenticador já cadastrado
      exigir2fa: Boolean(row.exigir_2fa), // o master exige deste usuário (além da regra por perfil)
    };
  }

  /** Grava o último acesso (no máximo uma vez a cada 5 minutos por usuário). */
  async marcarAcesso(u) {
    const ultimo = this.acessos.get(u.id) || 0;
    if (Date.now() - ultimo < 300000) return false;
    this.acessos.set(u.id, Date.now());
    await this.banco.query('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', [agora(), u.id]).catch(() => {});
    return true;
  }

  /* ---------- regras de visibilidade ---------- */

  veVeiculo(u, v) {
    if (!v) return false;
    if (u.perfil === 'master') return true;
    if (v.empresa_id !== u.empresaId) return false;
    if (u.todosGrupos) return true;
    return v.grupo_id !== null && v.grupo_id !== undefined && u.grupos.has(v.grupo_id);
  }

  veAparelho(u, ap) {
    if (!ap) return false;
    if (u.perfil === 'master') return true;
    if (ap.empresa_id !== u.empresaId) return false;
    const v = this.frota.veiculoDoAparelho.get(ap.id);
    if (v) return this.veVeiculo(u, v);
    return u.perfil === 'admin'; // aparelho ainda sem veículo: só o administrador vê
  }

  /** Aparelho conectado pelo número (identificador): existe e o usuário pode ver? */
  aparelhoVisivel(u, ident) {
    const ap = this.frota.porIdent.get(ident);
    if (!ap) return u.perfil === 'master'; // pendente de cadastro: só o master
    return this.veAparelho(u, ap);
  }

  veItem(u, item) {
    if (!item) return false;
    if (u.perfil === 'master') return true;
    if (item.pendente) return false;
    if (item.empresaId !== u.empresaId) return false;
    if (item.veiculoId) return this.veVeiculo(u, this.frota.veiculos.get(item.veiculoId));
    return u.perfil === 'admin';
  }
}

function exigir(u, capacidade) {
  if (!u || !u.pode[capacidade]) throw new HttpErro(403, 'Seu perfil não tem acesso a esta função.', 'perfil');
}

/** Pode entrar na tela (e fazer a ação)? O master pode tudo. */
function permite(u, tela, acao = 'ver') {
  if (!u) return false;
  if (u.perfil === 'master') return true;
  return permissoes.permite(u.acessos, tela, acao);
}

/** 'tela.acao' ou uma lista delas (basta uma). */
function permiteAlgum(u, regra) {
  const lista = Array.isArray(regra) ? regra : [regra];
  return lista.some((r) => { const [t, a] = String(r).split('.'); return permite(u, t, a || 'ver'); });
}

/** Só enxerga alguns grupos (não é master e não tem "todos os grupos")? */
const limitado = (u) => u.perfil !== 'master' && !u.todosGrupos;
/** Master e administrador da empresa: os únicos que mexem em administradores. */
const gerente = (u) => u.perfil === 'master' || u.perfil === 'admin';

/**
 * Quem edita (u) pode cuidar deste usuário (alvo: linha de usuarios + grupos[])?
 * Master: todos. Os demais: só da própria empresa (quem chama confere), nunca o master,
 * administrador só por administrador, e quem só enxerga alguns grupos só cuida de quem
 * está inteiramente dentro deles.
 */
function alcanca(u, alvo) {
  if (u.perfil === 'master') return true;
  if (alvo.perfil === 'master' || alvo.empresa_id !== u.empresaId) return false;
  if (alvo.pendente) return true;
  if (alvo.perfil === 'admin' && !gerente(u)) return false;
  if (!limitado(u)) return true;
  return !alvo.todos_grupos && alvo.perfil !== 'admin' && (alvo.grupos || []).length > 0 && alvo.grupos.every((g) => u.grupos.has(g));
}

function exigirAcesso(u, regra) {
  if (!permiteAlgum(u, regra)) throw new HttpErro(403, 'Você não tem acesso a esta função. Fale com o administrador do sistema.', 'sem_acesso');
}

/** Empresa em que a operação acontece: o master escolhe (ou todas = null); os demais, sempre a própria. */
function empresaAlvo(u, pedida) {
  if (u.perfil === 'master') return pedida || null;
  return u.empresaId;
}

module.exports = { Acesso, PERFIS, exigir, permite, permiteAlgum, exigirAcesso, empresaAlvo, limitado, gerente, alcanca };
