'use strict';
/**
 * FrotaGest — API de cadastros: empresas, usuários, grupos, veículos, aparelhos, perfis de protocolo,
 * aparelhos pendentes e configurações. Toda alteração fica na auditoria.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, gerarCodigo } = require('../util/comum');
const { empresaAlvo } = require('../auth/acesso');

const PERFIS_USUARIO = ['master', 'admin', 'operador', 'visualizador'];
const TIPOS_VEICULO = ['onibus', 'micro-onibus', 'van', 'caminhao', 'carro', 'moto', 'maquina', 'outro'];
const PROTOCOLOS = [{ id: 'jt808', nome: 'JT/T 808 (2013/2019, detectado sozinho)' }];
const PROTOCOLOS_VIDEO = [{ id: 'jt1078', nome: 'JT/T 1078 (RTP sobre TCP)' }];
const PORTAS_RESERVADAS = new Set([22, 80, 443, 3306, 8080]);

function registrar(srv) {
  const { banco, frota, auditoria, acesso, firebase, config, gateway } = srv;
  const r = (m, c, h, o) => srv.rota(m, c, h, o);

  /** Depois de mexer em cadastro de frota: recarrega a memória, derruba quem perdeu o acesso e avisa as telas. */
  async function frotaMudou() {
    await frota.carregar();
    gateway.reavaliar();
    srv.recarregarFrota();
  }

  function empresaDe(u, pedida, obrigatoria = true) {
    const id = u.perfil === 'master' ? V.id(pedida, 'a empresa', obrigatoria) : u.empresaId;
    if (id && !frota.empresas.has(id)) throw new HttpErro(400, 'Empresa não encontrada.');
    return id;
  }

  function podeMexer(u, empresaId) {
    if (u.perfil !== 'master' && empresaId !== u.empresaId) throw new HttpErro(404, 'Registro não encontrado.');
  }

  /* ---------------- empresas (master) ---------------- */

  function dadosEmpresa(b) {
    return {
      nome: V.texto(b.nome, 'o nome da empresa', { max: 120, obrigatorio: true, min: 2 }),
      documento: V.documento(b.documento),
      contato: V.texto(b.contato, 'o contato', { max: 120 }),
      telefone: V.texto(b.telefone, 'o telefone', { max: 30 }),
      email: V.email(b.email, 'o e-mail da empresa', false),
      cidade: V.texto(b.cidade, 'a cidade', { max: 80 }),
      uf: b.uf ? V.texto(b.uf, 'a UF', { max: 2, min: 2 }).toUpperCase() : null,
      observacao: V.texto(b.observacao, 'a observação', { max: 500 }),
    };
  }

  r('GET', '/api/empresas', async ({ u }) => {
    if (u.perfil !== 'master') {
      const e = await banco.um('SELECT id, nome, documento, contato, telefone, email, cidade, uf, ativo, codigo_convite FROM empresas WHERE id = ?', [u.empresaId]);
      return { empresas: e ? [e] : [] };
    }
    const empresas = await banco.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM veiculos v WHERE v.empresa_id = e.id AND v.ativo = 1) AS veiculos,
        (SELECT COUNT(*) FROM aparelhos a WHERE a.empresa_id = e.id AND a.ativo = 1) AS aparelhos,
        (SELECT COUNT(*) FROM usuarios s WHERE s.empresa_id = e.id AND s.ativo = 1) AS usuarios
      FROM empresas e ORDER BY e.nome`);
    return { empresas };
  });

  r('POST', '/api/empresas', async ({ u, body, ip }) => {
    if (u.perfil !== 'master') throw new HttpErro(403, 'Só o master cadastra empresas.');
    const d = dadosEmpresa(body);
    let x;
    for (let t = 0; ; t++) {
      try {
        x = await banco.query('INSERT INTO empresas (nome, documento, contato, telefone, email, cidade, uf, observacao, codigo_convite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [d.nome, d.documento, d.contato, d.telefone, d.email, d.cidade, d.uf, d.observacao, gerarCodigo()]);
        break;
      } catch (e) {
        if (t < 4 && e.code === 'ER_DUP_ENTRY' && /codigo/.test(e.message)) continue;
        throw e;
      }
    }
    await frotaMudou();
    await auditoria.registrar(u, 'criar', { entidade: 'empresa', entidadeId: x.insertId, descricao: d.nome, ip, empresaId: x.insertId });
    return { id: x.insertId };
  }, { pode: 'sistema' });

  r('PUT', '/api/empresas/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM empresas WHERE id = ?', [id]);
    if (!atual) throw new HttpErro(404, 'Empresa não encontrada.');
    const d = dadosEmpresa({ ...atual, ...body });
    const ativo = V.booleano(body.ativo, !!atual.ativo);
    await banco.query('UPDATE empresas SET nome = ?, documento = ?, contato = ?, telefone = ?, email = ?, cidade = ?, uf = ?, observacao = ?, ativo = ? WHERE id = ?',
      [d.nome, d.documento, d.contato, d.telefone, d.email, d.cidade, d.uf, d.observacao, ativo ? 1 : 0, id]);
    await frotaMudou();
    acesso.invalidar();
    const acao = !!atual.ativo !== ativo ? (ativo ? 'reativar' : 'desativar') : 'editar';
    await auditoria.registrar(u, acao, { entidade: 'empresa', entidadeId: id, descricao: d.nome, ip, empresaId: id });
    return { ok: true };
  }, { pode: 'sistema' });

  /** Gera um código novo para a empresa (o antigo para de valer). Master: qualquer empresa; admin: a própria. */
  r('POST', '/api/empresas/:id/codigo', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    podeMexer(u, id);
    if (!frota.empresas.has(id)) throw new HttpErro(404, 'Empresa não encontrada.');
    let codigo;
    for (let t = 0; t < 5; t++) {
      codigo = gerarCodigo();
      try { await banco.query('UPDATE empresas SET codigo_convite = ? WHERE id = ?', [codigo, id]); break; } catch (e) { if (e.code !== 'ER_DUP_ENTRY' || t === 4) throw e; }
    }
    await auditoria.registrar(u, 'novo_codigo', { entidade: 'empresa', entidadeId: id, descricao: 'gerou um código novo para cadastro da equipe', ip, empresaId: id });
    return { codigo };
  }, { pode: 'cadastros' });

  /* ---------------- grupos ---------------- */

  r('GET', '/api/grupos', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const grupos = [...frota.grupos.values()]
      .filter((g) => (emp ? g.empresa_id === emp : true))
      .filter((g) => u.todosGrupos || u.grupos.has(g.id))
      .map((g) => ({
        id: g.id, empresaId: g.empresa_id, paiId: g.pai_id, nome: g.nome, caminho: frota.caminhoGrupo(g.id),
        veiculos: [...frota.veiculos.values()].filter((v) => v.ativo && v.grupo_id === g.id).length,
      }))
      .sort((a, b) => a.caminho.localeCompare(b.caminho, 'pt-BR'));
    return { grupos };
  });

  function validarPai(empresaId, paiId, proprioId = null) {
    if (!paiId) return null;
    const pai = frota.grupos.get(paiId);
    if (!pai || pai.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo pai inválido.');
    if (proprioId && frota.descendentes(proprioId).has(paiId)) throw new HttpErro(400, 'Um grupo não pode ficar dentro dele mesmo.');
    return paiId;
  }

  r('POST', '/api/grupos', async ({ u, body, ip }) => {
    const empresaId = empresaDe(u, body.empresaId ?? body.empresa_id);
    const nome = V.texto(body.nome, 'o nome do grupo', { max: 80, obrigatorio: true });
    const paiId = validarPai(empresaId, V.id(body.paiId, 'o grupo pai', false));
    const x = await banco.query('INSERT INTO grupos (empresa_id, pai_id, nome) VALUES (?, ?, ?)', [empresaId, paiId, nome]);
    await frotaMudou();
    await auditoria.registrar(u, 'criar', { entidade: 'grupo', entidadeId: x.insertId, descricao: nome, ip, empresaId });
    return { id: x.insertId };
  }, { pode: 'cadastros' });

  r('PUT', '/api/grupos/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const g = frota.grupos.get(id);
    if (!g) throw new HttpErro(404, 'Grupo não encontrado.');
    podeMexer(u, g.empresa_id);
    const nome = V.texto(body.nome ?? g.nome, 'o nome do grupo', { max: 80, obrigatorio: true });
    const paiId = validarPai(g.empresa_id, V.id(body.paiId, 'o grupo pai', false), id);
    await banco.query('UPDATE grupos SET nome = ?, pai_id = ? WHERE id = ?', [nome, paiId, id]);
    await frotaMudou();
    await auditoria.registrar(u, 'editar', { entidade: 'grupo', entidadeId: id, descricao: nome, ip, empresaId: g.empresa_id });
    return { ok: true };
  }, { pode: 'cadastros' });

  r('DELETE', '/api/grupos/:id', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const g = frota.grupos.get(id);
    if (!g) throw new HttpErro(404, 'Grupo não encontrado.');
    podeMexer(u, g.empresa_id);
    if ((frota.filhos.get(id) || []).length) throw new HttpErro(409, 'Este grupo tem subgrupos. Mova ou exclua os subgrupos antes.');
    const n = await banco.um('SELECT COUNT(*) AS n FROM veiculos WHERE grupo_id = ?', [id]);
    if (n.n > 0) throw new HttpErro(409, `Este grupo tem ${n.n} veículo(s). Mude os veículos de grupo antes de excluir.`);
    await banco.query('DELETE FROM grupos WHERE id = ?', [id]);
    await frotaMudou();
    acesso.invalidar();
    await auditoria.registrar(u, 'excluir', { entidade: 'grupo', entidadeId: id, descricao: g.nome, ip, empresaId: g.empresa_id });
    return { ok: true };
  }, { pode: 'cadastros' });

  /* ---------------- usuários ---------------- */

  r('GET', '/api/usuarios', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const where = emp ? 'WHERE s.empresa_id = ?' : (u.perfil === 'master' ? '' : 'WHERE 1 = 0');
    const usuarios = await banco.query(`
      SELECT s.id, s.empresa_id, e.nome AS empresa, s.email, s.nome, s.perfil, s.todos_grupos, s.ativo, s.pendente, s.ultimo_acesso, s.criado_em,
             (s.firebase_uid IS NOT NULL) AS conta_ligada
        FROM usuarios s LEFT JOIN empresas e ON e.id = s.empresa_id ${where}
       ORDER BY s.ativo DESC, s.nome`, emp ? [emp] : []);
    const ids = usuarios.map((x) => x.id);
    const vinc = ids.length ? await banco.query('SELECT usuario_id, grupo_id FROM usuario_grupos WHERE usuario_id IN (?)', [ids]) : [];
    for (const x of usuarios) x.grupos = vinc.filter((g) => g.usuario_id === x.id).map((g) => g.grupo_id);
    return { usuarios };
  }, { pode: 'cadastros' });

  r('GET', '/api/usuarios/pendentes', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const x = await banco.um(`SELECT COUNT(*) AS n FROM usuarios WHERE pendente = 1${emp ? ' AND empresa_id = ?' : ''}`, emp ? [emp] : []);
    return { total: Number(x.n) || 0 };
  }, { pode: 'cadastros' });

  r('POST', '/api/usuarios/:id/aprovar', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await usuarioEditavel(u, id);
    if (!atual.pendente) throw new HttpErro(409, 'Este cadastro já foi analisado.');
    const perfil = V.opcao(body.perfil, ['admin', 'operador', 'visualizador'], 'o perfil');
    const d = dadosUsuario(u, { ...body, perfil }, { ...atual, grupos: [] });
    await banco.query('UPDATE usuarios SET perfil = ?, todos_grupos = ?, pendente = 0, ativo = 1 WHERE id = ?', [d.perfil, d.todosGrupos ? 1 : 0, id]);
    await gravarGrupos(id, d.grupos);
    acesso.invalidar();
    await auditoria.registrar(u, 'aprovar', { entidade: 'usuario', entidadeId: id, descricao: `${atual.nome} <${atual.email}> (${d.perfil})`, ip, empresaId: atual.empresa_id });
    srv.avisarPendentes(atual.empresa_id);
    return { ok: true };
  }, { pode: 'cadastros' });

  /** Recusar apaga o cadastro pendente: a pessoa pode tentar de novo com o código certo. */
  r('POST', '/api/usuarios/:id/recusar', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const atual = await usuarioEditavel(u, id);
    if (!atual.pendente) throw new HttpErro(409, 'Este cadastro já foi analisado.');
    await banco.query('DELETE FROM usuarios WHERE id = ? AND pendente = 1', [id]);
    acesso.invalidar();
    await auditoria.registrar(u, 'recusar', { entidade: 'usuario', entidadeId: id, descricao: `${atual.nome} <${atual.email}>`, ip, empresaId: atual.empresa_id });
    srv.avisarPendentes(atual.empresa_id);
    return { ok: true };
  }, { pode: 'cadastros' });

  function dadosUsuario(u, b, atual = null) {
    const perfil = V.opcao(b.perfil ?? (atual && atual.perfil), PERFIS_USUARIO, 'o perfil');
    if (perfil === 'master' && u.perfil !== 'master') throw new HttpErro(403, 'Só o master cria outro master.');
    let empresaId = null;
    if (perfil !== 'master') empresaId = atual ? atual.empresa_id : empresaDe(u, b.empresaId ?? b.empresa_id);
    const todosGrupos = perfil === 'operador' || perfil === 'visualizador' ? V.booleano(b.todosGrupos, atual ? !!atual.todos_grupos : true) : true;
    let grupos = [];
    if (!todosGrupos) {
      // alteração parcial (ex.: só desativar) mantém os grupos que o usuário já tinha
      const pedidos = b.grupos !== undefined ? b.grupos : (atual && atual.grupos);
      if (!Array.isArray(pedidos) || !pedidos.length) throw new HttpErro(400, 'Escolha pelo menos um grupo, ou marque "todos os grupos".');
      grupos = [...new Set(pedidos.map((g) => V.id(g, 'o grupo')))];
      for (const g of grupos) {
        const gr = frota.grupos.get(g);
        if (!gr || gr.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo inválido para esta empresa.');
      }
    }
    return {
      nome: V.texto(b.nome ?? (atual && atual.nome), 'o nome', { max: 120, obrigatorio: true, min: 2 }),
      perfil, empresaId, todosGrupos, grupos,
    };
  }

  async function gravarGrupos(usuarioId, grupos) {
    await banco.query('DELETE FROM usuario_grupos WHERE usuario_id = ?', [usuarioId]);
    if (grupos.length) await banco.query('INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES ?', [grupos.map((g) => [usuarioId, g])]);
  }

  r('POST', '/api/usuarios', async ({ u, body, ip }) => {
    const email = V.email(body.email);
    const d = dadosUsuario(u, body);
    const x = await banco.query('INSERT INTO usuarios (empresa_id, email, nome, perfil, todos_grupos, ativo) VALUES (?, ?, ?, ?, ?, 1)',
      [d.empresaId, email, d.nome, d.perfil, d.todosGrupos ? 1 : 0]);
    await gravarGrupos(x.insertId, d.grupos);
    await auditoria.registrar(u, 'criar', { entidade: 'usuario', entidadeId: x.insertId, descricao: `${d.nome} <${email}> (${d.perfil})`, ip, empresaId: d.empresaId });
    // convite: conta no Firebase + e-mail para a pessoa criar a senha
    let convite;
    try {
      const c = await firebase.convidar(email);
      if (c.uid) await banco.query('UPDATE usuarios SET firebase_uid = ? WHERE id = ? AND firebase_uid IS NULL', [c.uid, x.insertId]);
      convite = { enviado: true, contaExistente: c.existente };
    } catch (e) {
      convite = { enviado: false, erro: e.message };
    }
    return { id: x.insertId, convite };
  }, { pode: 'cadastros' });

  async function usuarioEditavel(u, id) {
    const atual = await banco.um('SELECT * FROM usuarios WHERE id = ?', [id]);
    if (!atual) throw new HttpErro(404, 'Usuário não encontrado.');
    if (u.perfil !== 'master' && (atual.perfil === 'master' || atual.empresa_id !== u.empresaId)) throw new HttpErro(404, 'Usuário não encontrado.');
    atual.grupos = (await banco.query('SELECT grupo_id FROM usuario_grupos WHERE usuario_id = ?', [id])).map((g) => g.grupo_id);
    return atual;
  }

  r('PUT', '/api/usuarios/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await usuarioEditavel(u, id);
    if (atual.pendente) throw new HttpErro(409, 'Este cadastro aguarda aprovação: use Aprovar ou Recusar.');
    if (body.email !== undefined && String(body.email).trim().toLowerCase() !== atual.email) {
      throw new HttpErro(400, 'O e-mail não pode ser trocado. Desative este usuário e cadastre outro com o e-mail novo.');
    }
    const d = dadosUsuario(u, body, atual);
    if ((atual.perfil === 'master') !== (d.perfil === 'master')) throw new HttpErro(400, 'Não é possível transformar master em usuário de empresa (ou o contrário). Cadastre outro usuário.');
    const ativo = V.booleano(body.ativo, !!atual.ativo);
    if (id === u.id && (!ativo || d.perfil !== atual.perfil)) throw new HttpErro(400, 'Você não pode desativar nem mudar o perfil do seu próprio usuário.');
    await banco.query('UPDATE usuarios SET nome = ?, perfil = ?, todos_grupos = ?, ativo = ? WHERE id = ?', [d.nome, d.perfil, d.todosGrupos ? 1 : 0, ativo ? 1 : 0, id]);
    await gravarGrupos(id, d.grupos);
    acesso.invalidar();
    const acao = !!atual.ativo !== ativo ? (ativo ? 'reativar' : 'desativar') : 'editar';
    await auditoria.registrar(u, acao, { entidade: 'usuario', entidadeId: id, descricao: `${d.nome} <${atual.email}> (${d.perfil})`, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { pode: 'cadastros' });

  r('POST', '/api/usuarios/:id/convite', async ({ u, params, ip }) => {
    const id = V.id(params.id);
    const atual = await usuarioEditavel(u, id);
    if (!atual.ativo) throw new HttpErro(400, 'Reative o usuário antes de reenviar o convite.');
    const c = await firebase.convidar(atual.email);
    if (c.uid) await banco.query('UPDATE usuarios SET firebase_uid = ? WHERE id = ?', [c.uid, id]);
    else if (c.existente && !atual.firebase_uid) { /* liga no primeiro acesso, com e-mail confirmado */ }
    acesso.invalidar();
    await auditoria.registrar(u, 'convite', { entidade: 'usuario', entidadeId: id, descricao: atual.email, ip, empresaId: atual.empresa_id });
    return { ok: true, contaExistente: c.existente };
  }, { pode: 'cadastros' });

  /* ---------------- perfis de protocolo (master) ---------------- */

  function dadosPerfil(b, atual = {}) {
    const m = { ...atual, ...b };
    const portaS = V.inteiro(m.porta_sinalizacao, 'a porta de sinalização', { min: 1024, max: 65535, obrigatorio: true });
    const portaV = V.inteiro(m.porta_video, 'a porta de vídeo', { min: 1024, max: 65535, obrigatorio: true });
    if (PORTAS_RESERVADAS.has(portaS) || PORTAS_RESERVADAS.has(portaV)) throw new HttpErro(400, 'Porta reservada para outro serviço do servidor.');
    if (portaS === portaV) throw new HttpErro(400, 'A porta de sinalização e a de vídeo precisam ser diferentes.');
    const end = V.texto(m.endereco_video, 'o endereço de vídeo', { max: 120 });
    if (end && !/^[\w.-]+$/.test(end)) throw new HttpErro(400, 'Endereço de vídeo inválido (use IP ou nome, sem http://).');
    return {
      nome: V.texto(m.nome, 'o nome do perfil', { max: 80, obrigatorio: true }),
      protocolo: V.opcao(m.protocolo, PROTOCOLOS.map((p) => p.id), 'o protocolo', 'jt808'),
      protocolo_video: V.opcao(m.protocolo_video, PROTOCOLOS_VIDEO.map((p) => p.id), 'o protocolo de vídeo', 'jt1078'),
      porta_sinalizacao: portaS,
      porta_video: portaV,
      endereco_video: end,
      fuso_minutos: V.inteiro(m.fuso_minutos, 'o fuso do aparelho', { min: -720, max: 840 }) ?? -180,
      observacao: V.texto(m.observacao, 'a observação', { max: 255 }),
      ativo: V.booleano(m.ativo, true),
      padrao: V.booleano(m.padrao, false),
    };
  }

  async function aplicarPortas() {
    const { sinalizacao, video } = frota.portas();
    const a = await gateway.sincronizarPortas(sinalizacao);
    const b = await srv.media.sincronizarPortas(video);
    return { sinalizacao: a, video: b };
  }

  r('GET', '/api/perfis', async () => {
    const perfis = await banco.query(`SELECT p.*, (SELECT COUNT(*) FROM aparelhos a WHERE a.perfil_id = p.id) AS aparelhos FROM perfis_protocolo p ORDER BY p.padrao DESC, p.id`);
    return {
      perfis, protocolos: PROTOCOLOS, protocolosVideo: PROTOCOLOS_VIDEO,
      abertas: { sinalizacao: gateway.portas(), video: srv.media.portas() },
    };
  }, { pode: 'cadastros' });

  r('POST', '/api/perfis', async ({ u, body, ip }) => {
    const d = dadosPerfil(body);
    const x = await banco.query(`INSERT INTO perfis_protocolo (nome, protocolo, protocolo_video, porta_sinalizacao, porta_video, endereco_video, fuso_minutos, observacao, ativo, padrao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [d.nome, d.protocolo, d.protocolo_video, d.porta_sinalizacao, d.porta_video, d.endereco_video, d.fuso_minutos, d.observacao, d.ativo ? 1 : 0]);
    if (d.padrao) await tornarPadrao(x.insertId);
    await frota.carregar();
    const portas = await aplicarPortas();
    await auditoria.registrar(u, 'criar', { entidade: 'perfil_protocolo', entidadeId: x.insertId, descricao: `${d.nome} (${d.porta_sinalizacao}/${d.porta_video})`, ip, empresaId: null });
    return { id: x.insertId, portas };
  }, { pode: 'sistema' });

  async function tornarPadrao(id) {
    await banco.query('UPDATE perfis_protocolo SET padrao = (id = ?)', [id]);
  }

  r('PUT', '/api/perfis/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM perfis_protocolo WHERE id = ?', [id]);
    if (!atual) throw new HttpErro(404, 'Perfil não encontrado.');
    const d = dadosPerfil(body, { ...atual, ativo: !!atual.ativo, padrao: !!atual.padrao });
    if (atual.padrao && !d.ativo) throw new HttpErro(400, 'O perfil padrão não pode ser desativado. Escolha outro como padrão antes.');
    if (d.padrao && !d.ativo) throw new HttpErro(400, 'Um perfil desativado não pode ser o padrão.');
    await banco.query(`UPDATE perfis_protocolo SET nome = ?, protocolo = ?, protocolo_video = ?, porta_sinalizacao = ?, porta_video = ?, endereco_video = ?,
      fuso_minutos = ?, observacao = ?, ativo = ? WHERE id = ?`,
    [d.nome, d.protocolo, d.protocolo_video, d.porta_sinalizacao, d.porta_video, d.endereco_video, d.fuso_minutos, d.observacao, d.ativo ? 1 : 0, id]);
    if (d.padrao && !atual.padrao) await tornarPadrao(id);
    await frota.carregar();
    const portas = await aplicarPortas();
    await auditoria.registrar(u, 'editar', { entidade: 'perfil_protocolo', entidadeId: id, descricao: `${d.nome} (${d.porta_sinalizacao}/${d.porta_video})`, ip, empresaId: null });
    return { ok: true, portas };
  }, { pode: 'sistema' });

  /* ---------------- aparelhos ---------------- */

  r('GET', '/api/aparelhos', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const aparelhos = await banco.query(`
      SELECT a.*, e.nome AS empresa, p.nome AS perfil, v.id AS veiculo_id, v.placa, v.prefixo,
             s.online, s.ultimo_contato
        FROM aparelhos a
        JOIN empresas e ON e.id = a.empresa_id
        JOIN perfis_protocolo p ON p.id = a.perfil_id
        LEFT JOIN veiculos v ON v.aparelho_id = a.id
        LEFT JOIN aparelhos_estado s ON s.aparelho_id = a.id
       ${emp ? 'WHERE a.empresa_id = ?' : ''}
       ORDER BY a.ativo DESC, e.nome, a.identificador`, emp ? [emp] : []);
    for (const a of aparelhos) {
      const dev = gateway.devices.get(a.identificador);
      a.online = Boolean(dev && dev.online);
      a.nomes_canais = Array.isArray(a.nomes_canais) ? a.nomes_canais : (frota.aparelhos.get(a.id) || {}).nomes_canais || [];
    }
    return { aparelhos };
  }, { pode: 'cadastros' });

  /** Aceita empresaId ou empresa_id vindo da tela. */
  function comEmpresa(body) {
    const b = { ...body };
    if (b.empresa_id === undefined && b.empresaId !== undefined) b.empresa_id = b.empresaId;
    delete b.empresaId;
    return b;
  }

  function dadosAparelho(u, b, atual = {}) {
    const m = { ...atual, ...b };
    const canais = V.inteiro(m.canais, 'o número de canais', { min: 1, max: 16 }) ?? 4;
    let nomes = [];
    if (Array.isArray(m.nomes_canais)) nomes = m.nomes_canais.slice(0, canais).map((n, i) => V.texto(n, `o nome do canal ${i + 1}`, { max: 30 }) || '');
    const perfilId = V.id(m.perfil_id, 'o perfil de protocolo', false) || (frota.perfilPadrao() || {}).id;
    if (!frota.perfis.has(perfilId)) throw new HttpErro(400, 'Perfil de protocolo inválido.');
    return {
      empresa_id: empresaDe(u, m.empresa_id),
      perfil_id: perfilId,
      identificador: V.identificador(m.identificador),
      fabricante: V.texto(m.fabricante, 'o fabricante', { max: 60 }),
      modelo: V.texto(m.modelo, 'o modelo', { max: 60 }),
      numero_serie: V.texto(m.numero_serie, 'o número de série', { max: 60 }),
      canais,
      nomes_canais: JSON.stringify(nomes),
      chip_numero: V.texto(m.chip_numero, 'o número do chip', { max: 20 }),
      chip_operadora: V.texto(m.chip_operadora, 'a operadora', { max: 30 }),
      observacao: V.texto(m.observacao, 'a observação', { max: 500 }),
      ativo: V.booleano(m.ativo, true),
    };
  }

  r('POST', '/api/aparelhos', async ({ u, body, ip }) => {
    const d = dadosAparelho(u, comEmpresa(body));
    const x = await banco.query(`INSERT INTO aparelhos (empresa_id, perfil_id, identificador, fabricante, modelo, numero_serie, canais, nomes_canais, chip_numero, chip_operadora, observacao, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.empresa_id, d.perfil_id, d.identificador, d.fabricante, d.modelo, d.numero_serie, d.canais, d.nomes_canais, d.chip_numero, d.chip_operadora, d.observacao, d.ativo ? 1 : 0]);
    await banco.query('DELETE FROM aparelhos_pendentes WHERE identificador = ?', [d.identificador]);
    await frotaMudou();
    await auditoria.registrar(u, 'criar', { entidade: 'aparelho', entidadeId: x.insertId, descricao: d.identificador, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { pode: 'sistema' });

  r('PUT', '/api/aparelhos/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM aparelhos WHERE id = ?', [id]);
    if (!atual) throw new HttpErro(404, 'Aparelho não encontrado.');
    const d = dadosAparelho(u, comEmpresa(body), { ...atual, nomes_canais: (frota.aparelhos.get(id) || {}).nomes_canais || [] });
    const veic = await banco.um('SELECT id, empresa_id, placa FROM veiculos WHERE aparelho_id = ?', [id]);
    if (veic && veic.empresa_id !== d.empresa_id) throw new HttpErro(409, `Este aparelho está no veículo ${veic.placa}. Retire-o do veículo antes de mudar a empresa.`);
    await banco.query(`UPDATE aparelhos SET empresa_id = ?, perfil_id = ?, identificador = ?, fabricante = ?, modelo = ?, numero_serie = ?, canais = ?, nomes_canais = ?,
      chip_numero = ?, chip_operadora = ?, observacao = ?, ativo = ? WHERE id = ?`,
    [d.empresa_id, d.perfil_id, d.identificador, d.fabricante, d.modelo, d.numero_serie, d.canais, d.nomes_canais, d.chip_numero, d.chip_operadora, d.observacao, d.ativo ? 1 : 0, id]);
    await frotaMudou();
    const acao = !!atual.ativo !== d.ativo ? (d.ativo ? 'reativar' : 'desativar') : 'editar';
    await auditoria.registrar(u, acao, { entidade: 'aparelho', entidadeId: id, descricao: d.identificador, ip, empresaId: d.empresa_id });
    return { ok: true };
  }, { pode: 'sistema' });

  r('GET', '/api/aparelhos-pendentes', async () => {
    const pendentes = await banco.query('SELECT * FROM aparelhos_pendentes ORDER BY ultimo_contato DESC LIMIT 500');
    for (const p of pendentes) {
      const dev = gateway.devices.get(p.identificador);
      p.online = Boolean(dev && dev.online);
    }
    return { pendentes };
  }, { pode: 'sistema' });

  r('DELETE', '/api/aparelhos-pendentes/:ident', async ({ u, params, ip }) => {
    const ident = V.identificador(params.ident);
    await banco.query('DELETE FROM aparelhos_pendentes WHERE identificador = ?', [ident]);
    await auditoria.registrar(u, 'excluir', { entidade: 'aparelho_pendente', entidadeId: ident, ip, empresaId: null });
    return { ok: true };
  }, { pode: 'sistema' });

  /* ---------------- veículos ---------------- */

  r('GET', '/api/veiculos', async ({ u, query }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const veiculos = await banco.query(`
      SELECT v.*, e.nome AS empresa, a.identificador, s.online, s.ultimo_contato
        FROM veiculos v
        JOIN empresas e ON e.id = v.empresa_id
        LEFT JOIN aparelhos a ON a.id = v.aparelho_id
        LEFT JOIN aparelhos_estado s ON s.aparelho_id = v.aparelho_id
       ${emp ? 'WHERE v.empresa_id = ?' : ''}
       ORDER BY v.ativo DESC, e.nome, v.prefixo, v.placa`, emp ? [emp] : []);
    for (const v of veiculos) {
      v.grupo = v.grupo_id ? frota.caminhoGrupo(v.grupo_id) : null;
      const dev = v.identificador ? gateway.devices.get(v.identificador) : null;
      v.online = Boolean(dev && dev.online);
    }
    return { veiculos: veiculos.filter((v) => acesso.veVeiculo(u, v)), tipos: TIPOS_VEICULO };
  }, { pode: 'cadastros' });

  function dadosVeiculo(u, b, atual = {}) {
    const m = { ...atual, ...b };
    const empresaId = atual.empresa_id || empresaDe(u, m.empresa_id ?? m.empresaId);
    const grupoId = V.id(m.grupo_id, 'o grupo', false);
    if (grupoId) {
      const g = frota.grupos.get(grupoId);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo inválido para esta empresa.');
    }
    const aparelhoId = V.id(m.aparelho_id, 'o aparelho', false);
    if (aparelhoId) {
      const ap = frota.aparelhos.get(aparelhoId);
      if (!ap || ap.empresa_id !== empresaId) throw new HttpErro(400, 'Aparelho inválido para esta empresa.');
    }
    const ano = V.inteiro(m.ano, 'o ano', { min: 1950, max: 2100 });
    return {
      empresa_id: empresaId, grupo_id: grupoId, aparelho_id: aparelhoId,
      placa: V.placa(m.placa),
      prefixo: V.texto(m.prefixo, 'o prefixo', { max: 20 }),
      descricao: V.texto(m.descricao, 'a descrição', { max: 120 }),
      tipo: m.tipo ? V.opcao(m.tipo, TIPOS_VEICULO, 'o tipo') : null,
      ano,
      cor: V.texto(m.cor, 'a cor', { max: 30 }),
      chassi: V.texto(m.chassi, 'o chassi', { max: 30 }),
      observacao: V.texto(m.observacao, 'a observação', { max: 500 }),
      ativo: V.booleano(m.ativo, true),
    };
  }

  r('POST', '/api/veiculos', async ({ u, body, ip }) => {
    const d = dadosVeiculo(u, body);
    const x = await banco.query(`INSERT INTO veiculos (empresa_id, grupo_id, aparelho_id, placa, prefixo, descricao, tipo, ano, cor, chassi, observacao, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.empresa_id, d.grupo_id, d.aparelho_id, d.placa, d.prefixo, d.descricao, d.tipo, d.ano, d.cor, d.chassi, d.observacao, d.ativo ? 1 : 0]);
    await frotaMudou();
    await auditoria.registrar(u, 'criar', { entidade: 'veiculo', entidadeId: x.insertId, descricao: d.placa, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { pode: 'cadastros' });

  r('PUT', '/api/veiculos/:id', async ({ u, params, body, ip }) => {
    const id = V.id(params.id);
    const atual = await banco.um('SELECT * FROM veiculos WHERE id = ?', [id]);
    if (!atual) throw new HttpErro(404, 'Veículo não encontrado.');
    podeMexer(u, atual.empresa_id);
    if (!acesso.veVeiculo(u, atual)) throw new HttpErro(404, 'Veículo não encontrado.');
    const d = dadosVeiculo(u, body, { ...atual, ativo: !!atual.ativo });
    await banco.query(`UPDATE veiculos SET grupo_id = ?, aparelho_id = ?, placa = ?, prefixo = ?, descricao = ?, tipo = ?, ano = ?, cor = ?, chassi = ?, observacao = ?, ativo = ?
      WHERE id = ?`, [d.grupo_id, d.aparelho_id, d.placa, d.prefixo, d.descricao, d.tipo, d.ano, d.cor, d.chassi, d.observacao, d.ativo ? 1 : 0, id]);
    await frotaMudou();
    const acao = !!atual.ativo !== d.ativo ? (d.ativo ? 'reativar' : 'desativar') : 'editar';
    await auditoria.registrar(u, acao, { entidade: 'veiculo', entidadeId: id, descricao: d.placa, ip, empresaId: d.empresa_id });
    return { ok: true };
  }, { pode: 'cadastros' });

  /* ---------------- configurações (master) ---------------- */

  r('GET', '/api/configuracoes', async () => ({ configuracoes: config.lista() }), { pode: 'sistema' });

  r('PUT', '/api/configuracoes', async ({ u, body, ip }) => {
    const mudou = await config.salvar(body, u.id);
    if (mudou.includes('aparelhos_nao_cadastrados')) gateway.reavaliar();
    await auditoria.registrar(u, 'editar', { entidade: 'configuracoes', descricao: mudou.map((k) => `${k}=${config.get(k)}`).join(', '), ip, empresaId: null });
    return { ok: true, configuracoes: config.lista() };
  }, { pode: 'sistema' });
}

module.exports = { registrar, TIPOS_VEICULO };
