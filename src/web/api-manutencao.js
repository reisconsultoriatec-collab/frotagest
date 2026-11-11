'use strict';
/**
 * FrotaGest — API de manutenção e documentos: situação (vencidos / perto / em dia), planos de
 * manutenção, manutenções feitas e documentos com vencimento. Tudo opcional.
 * Reis Tecnologia
 */
const { HttpErro, agora, validar: V } = require('../util/comum');
const { limitado } = require('../auth/acesso');
const { TIPOS_DOC } = require('../servicos/manutencao');

const MAX_PLANOS = 200;
const MAX_FEITAS_TELA = 500;

/** Valor em reais: "1.234,56", "1234,56" ou "1234.56". */
function dinheiro(v) {
  if (V.vazio(v)) return null;
  let s = String(v).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) throw new HttpErro(400, 'Custo inválido (ex.: 350,00).');
  return Number(s);
}

function registrar(srv) {
  const { banco, frota, auditoria, acesso, manutencao, motoristas } = srv;

  const rotuloVeiculo = (id) => {
    const v = frota.veiculos.get(id);
    return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : 'veículo';
  };
  const nomeMotorista = (id) => { const m = motoristas.lista.get(id); return m ? m.nome : 'motorista'; };
  const empresaDe = (u, b, atual) => {
    const id = atual ? atual.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(id)) throw new HttpErro(400, 'Empresa não encontrada.');
    return id;
  };
  const filtroEmpresa = (u, q) => (u.perfil === 'master' ? (q.empresa ? V.id(q.empresa, 'a empresa') : null) : u.empresaId);

  /* ---------- quem vê / mexe ---------- */

  /** Plano: quem só enxerga alguns grupos vê os gerais e os dos seus grupos/veículos... */
  function vePlano(u, p) {
    if (u.perfil === 'master') return true;
    if (p.empresa_id !== u.empresaId) return false;
    if (!limitado(u) || (!p.grupo_id && !p.veiculo_id)) return true;
    if (p.grupo_id) return u.grupos.has(p.grupo_id);
    return acesso.veVeiculo(u, frota.veiculos.get(p.veiculo_id));
  }
  /** ...e só mexe nos dos seus grupos e veículos. */
  function mexePlano(u, p) {
    if (!vePlano(u, p)) return false;
    if (!limitado(u)) return true;
    return Boolean(p.grupo_id || p.veiculo_id);
  }
  function veVeiculoId(u, id) { return acesso.veVeiculo(u, frota.veiculos.get(id)); }
  function veDoc(u, d) {
    if (u.perfil !== 'master' && d.empresa_id !== u.empresaId) return false;
    if (d.veiculo_id) return veVeiculoId(u, d.veiculo_id);
    if (d.motorista_id) return manutencao.veMotorista(u, motoristas.lista.get(d.motorista_id));
    return true;
  }
  function mexeMotorista(u, m) {
    if (!manutencao.veMotorista(u, m)) return false;
    return !limitado(u) || Boolean(m.grupo_id && u.grupos.has(m.grupo_id));
  }

  function alcanceTexto(p) {
    if (p.veiculo_id) return rotuloVeiculo(p.veiculo_id);
    if (p.grupo_id) return frota.caminhoGrupo(p.grupo_id);
    return 'Empresa toda';
  }

  /* ---------- situação ---------- */

  /** Item para a tela: com o veículo ou o motorista escrito. */
  const paraTela = (x) => ({ ...x, veiculo: x.veiculoId ? rotuloVeiculo(x.veiculoId) : null, motorista: x.motoristaId ? nomeMotorista(x.motoristaId) : null });

  srv.rota('GET', '/api/manutencao', async ({ u, query }) => {
    const emp = filtroEmpresa(u, query);
    const itens = (await manutencao.daPessoa(u, emp)).map(paraTela);
    const planos = (await banco.query(`SELECT * FROM manutencao_planos${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY nome, id`, emp ? [emp] : []))
      .filter((p) => vePlano(u, p))
      .map((p) => {
        const meus = itens.filter((x) => x.planoId === p.id);
        return {
          ...p, ativo: Boolean(p.ativo), alcance: p.veiculo_id ? 'veiculo' : p.grupo_id ? 'grupo' : 'empresa', alvo: alcanceTexto(p),
          empresa: (frota.empresas.get(p.empresa_id) || {}).nome || '', editavel: mexePlano(u, p),
          veiculos: meus.length, vencidos: meus.filter((x) => x.estado === 'vencido').length, perto: meus.filter((x) => x.estado === 'perto').length,
        };
      });
    const documentos = (await banco.query(`SELECT * FROM documentos${emp ? ' WHERE empresa_id = ?' : ''} ORDER BY vencimento, id`, emp ? [emp] : []))
      .filter((d) => veDoc(u, d))
      .map((d) => {
        const it = itens.find((x) => x.chave === `d${d.id}`);
        return {
          ...d, nome: (TIPOS_DOC[d.tipo] || TIPOS_DOC.outro).nome, de: d.veiculo_id ? 'veiculo' : 'motorista',
          alvo: d.veiculo_id ? rotuloVeiculo(d.veiculo_id) : nomeMotorista(d.motorista_id),
          estado: it ? it.estado : null, faltaDias: it ? it.faltaDias : null,
          editavel: d.veiculo_id ? true : mexeMotorista(u, motoristas.lista.get(d.motorista_id)),
        };
      });
    const feitas = (await banco.query(
      `SELECT m.*, DATE_FORMAT(m.data, '%Y-%m-%d') AS data, us.nome AS usuario FROM manutencoes m LEFT JOIN usuarios us ON us.id = m.usuario_id
        ${emp ? 'WHERE m.empresa_id = ?' : ''} ORDER BY m.data DESC, m.id DESC LIMIT ${MAX_FEITAS_TELA * 4}`, emp ? [emp] : []))
      .filter((f) => u.perfil === 'master' || (f.empresa_id === u.empresaId && veVeiculoId(u, f.veiculo_id)))
      .slice(0, MAX_FEITAS_TELA)
      .map((f) => ({ ...f, custo: f.custo === null ? null : Number(f.custo), veiculo: rotuloVeiculo(f.veiculo_id) }));
    const mes = agora().slice(0, 7);
    return {
      itens, planos, documentos, feitas,
      tipos: Object.entries(TIPOS_DOC).map(([id, t]) => ({ id, ...t })),
      resumo: {
        vencidos: itens.filter((x) => x.estado === 'vencido').length,
        perto: itens.filter((x) => x.estado === 'perto').length,
        emDia: itens.filter((x) => x.estado === 'ok').length,
        custoMes: Math.round(feitas.filter((f) => f.data.startsWith(mes)).reduce((s, f) => s + (f.custo || 0), 0) * 100) / 100,
      },
      cadastrado: planos.length > 0 || documentos.length > 0 || itens.some((x) => x.tipo === 'cnh'),
    };
  }, { acesso: 'manutencao.ver' });

  /** Só o que pede atenção: para o selo do menu, o Dashboard e o painel do veículo. */
  srv.rota('GET', '/api/manutencao/resumo', async ({ u, query }) => {
    const l = (await manutencao.daPessoa(u, filtroEmpresa(u, query))).filter((x) => x.estado !== 'ok');
    return {
      vencidos: l.filter((x) => x.estado === 'vencido').length,
      perto: l.filter((x) => x.estado === 'perto').length,
      itens: l.slice(0, 300).map((x) => ({
        chave: x.chave, tipo: x.tipo, nome: x.nome, estado: x.estado, veiculoId: x.veiculoId, motoristaId: x.motoristaId,
        faltaKm: x.faltaKm ?? null, faltaDias: x.faltaDias ?? null, vencimento: x.vencimento || x.proximaData || null,
        veiculo: x.veiculoId ? rotuloVeiculo(x.veiculoId) : null, motorista: x.motoristaId ? nomeMotorista(x.motoristaId) : null,
      })),
    };
  }, { acesso: 'manutencao.ver' });

  /* ---------- planos ---------- */

  function dadosPlano(u, b, atual = null) {
    const empresaId = empresaDe(u, b, atual);
    const alcance = V.opcao(b.alcance, ['empresa', 'grupo', 'veiculo'], 'a quem o plano vale', 'empresa');
    const d = {
      empresa_id: empresaId, grupo_id: null, veiculo_id: null,
      nome: V.texto(b.nome, 'o nome do plano (ex.: troca de óleo)', { max: 80, min: 2, obrigatorio: true }),
      intervalo_km: V.inteiro(b.km, 'o intervalo em km', { min: 100, max: 1000000 }),
      intervalo_dias: null, intervalo_meses: null,
      avisar_km: V.inteiro(b.avisarKm, 'o aviso em km', { min: 0, max: 100000 }),
      avisar_dias: V.inteiro(b.avisarDias, 'o aviso em dias', { min: 0, max: 365 }),
      observacao: V.texto(b.observacao, 'a observação', { max: 500 }),
      ativo: V.booleano(b.ativo, true) ? 1 : 0,
    };
    const tempo = V.inteiro(b.tempo, 'o intervalo de tempo', { min: 1, max: 3650 });
    if (tempo) {
      const un = V.opcao(b.unidade, ['meses', 'dias'], 'a unidade de tempo', 'meses');
      if (un === 'meses') { if (tempo > 120) throw new HttpErro(400, 'Intervalo de tempo: até 120 meses.'); d.intervalo_meses = tempo; } else d.intervalo_dias = tempo;
    }
    if (!d.intervalo_km && !tempo) throw new HttpErro(400, 'Informe a cada quantos km e/ou de quanto em quanto tempo.');
    if (d.avisar_km !== null && d.intervalo_km && d.avisar_km >= d.intervalo_km) throw new HttpErro(400, 'O aviso em km deve ser menor que o intervalo.');
    if (alcance === 'grupo') {
      d.grupo_id = V.id(b.grupo, 'o grupo');
      const g = frota.grupos.get(d.grupo_id);
      if (!g || g.empresa_id !== empresaId) throw new HttpErro(400, 'Grupo não encontrado.');
    } else if (alcance === 'veiculo') {
      d.veiculo_id = V.id(b.veiculo, 'o veículo');
      const v = frota.veiculos.get(d.veiculo_id);
      if (!v || v.empresa_id !== empresaId) throw new HttpErro(400, 'Veículo não encontrado.');
    }
    if (!mexePlano(u, d)) throw new HttpErro(400, 'Você só cria planos para os grupos e veículos que você enxerga: escolha um deles em "Vale para".');
    return d;
  }
  const COLS_PLANO = ['empresa_id', 'grupo_id', 'veiculo_id', 'nome', 'intervalo_km', 'intervalo_dias', 'intervalo_meses', 'avisar_km', 'avisar_dias', 'observacao', 'ativo'];
  const textoIntervalo = (d) => [d.intervalo_km ? `${d.intervalo_km} km` : '', d.intervalo_meses ? `${d.intervalo_meses} meses` : d.intervalo_dias ? `${d.intervalo_dias} dias` : ''].filter(Boolean).join(' ou ');

  srv.rota('POST', '/api/manutencao/planos', async ({ u, body, ip }) => {
    const d = dadosPlano(u, body || {});
    const n = await banco.um('SELECT COUNT(*) AS n FROM manutencao_planos WHERE empresa_id = ?', [d.empresa_id]);
    if (n.n >= MAX_PLANOS) throw new HttpErro(400, `Limite de ${MAX_PLANOS} planos por empresa.`);
    const x = await banco.query(`INSERT INTO manutencao_planos (${COLS_PLANO.join(', ')}, criado_em) VALUES (?)`, [[...COLS_PLANO.map((k) => d[k]), agora()]]);
    manutencao.mudou(d.empresa_id);
    await auditoria.registrar(u, 'criar', { entidade: 'plano_manutencao', entidadeId: x.insertId, descricao: `${d.nome}: a cada ${textoIntervalo(d)} (${alcanceTexto(d)})`, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'manutencao.incluir' });

  async function planoDe(u, id) {
    const p = await banco.um('SELECT * FROM manutencao_planos WHERE id = ?', [V.id(id)]);
    if (!p || !vePlano(u, p)) throw new HttpErro(404, 'Plano não encontrado.');
    if (!mexePlano(u, p)) throw new HttpErro(403, 'Este plano vale para a empresa toda: só quem enxerga todos os grupos altera.');
    return p;
  }

  srv.rota('PUT', '/api/manutencao/planos/:id', async ({ u, params, body, ip }) => {
    const atual = await planoDe(u, params.id);
    const d = dadosPlano(u, body || {}, atual);
    const cols = COLS_PLANO.filter((k) => k !== 'empresa_id');
    await banco.query(`UPDATE manutencao_planos SET ${cols.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`, [...cols.map((k) => d[k]), agora(), atual.id]);
    manutencao.mudou(atual.empresa_id);
    await auditoria.registrar(u, 'editar', { entidade: 'plano_manutencao', entidadeId: atual.id, descricao: `${d.nome}: a cada ${textoIntervalo(d)} (${alcanceTexto(d)})${d.ativo ? '' : ' · desligado'}`, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'manutencao.alterar' });

  srv.rota('DELETE', '/api/manutencao/planos/:id', async ({ u, params, ip }) => {
    const atual = await planoDe(u, params.id);
    // as manutenções feitas continuam no histórico (com o nome do serviço)
    await banco.query('UPDATE manutencoes SET plano_id = NULL WHERE plano_id = ?', [atual.id]);
    await banco.query('DELETE FROM manutencao_planos WHERE id = ?', [atual.id]);
    manutencao.mudou(atual.empresa_id);
    await auditoria.registrar(u, 'excluir', { entidade: 'plano_manutencao', entidadeId: atual.id, descricao: atual.nome, ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'manutencao.excluir' });

  /* ---------- manutenções feitas ---------- */

  async function dadosFeita(u, b, atual = null) {
    const veiculoId = atual ? atual.veiculo_id : V.id(b.veiculo, 'o veículo');
    const v = frota.veiculos.get(veiculoId);
    if (!v || !veVeiculoId(u, veiculoId)) throw new HttpErro(400, 'Veículo não encontrado.');
    const planoId = V.id(b.plano, 'o plano', false);
    let descricao = V.texto(b.descricao, 'o serviço feito', { max: 120 });
    if (planoId) {
      const p = await banco.um('SELECT * FROM manutencao_planos WHERE id = ?', [planoId]);
      if (!p || !manutencao.veiculosDoPlano(p).some((x) => x.id === veiculoId)) throw new HttpErro(400, 'Este plano não vale para este veículo.');
      descricao = p.nome;
    }
    if (!descricao) throw new HttpErro(400, 'Escolha o plano ou escreva o serviço feito.');
    const data = V.dia(b.data, 'a data', { obrigatorio: true });
    if (data > agora().slice(0, 10)) throw new HttpErro(400, 'A data não pode ser no futuro.');
    return {
      empresa_id: v.empresa_id, veiculo_id: veiculoId, plano_id: planoId, descricao, data,
      hodometro: V.inteiro(typeof b.hodometro === 'string' ? b.hodometro.replace(/\./g, '') : b.hodometro, 'o hodômetro', { min: 0, max: 9999999 }),
      custo: dinheiro(b.custo),
      oficina: V.texto(b.oficina, 'a oficina', { max: 80 }),
      observacao: V.texto(b.observacao, 'a observação', { max: 500 }),
    };
  }
  const COLS_FEITA = ['empresa_id', 'veiculo_id', 'plano_id', 'descricao', 'data', 'hodometro', 'custo', 'oficina', 'observacao'];
  const textoFeita = (d) => `${rotuloVeiculo(d.veiculo_id)}: ${d.descricao} em ${d.data.split('-').reverse().join('/')}${d.hodometro !== null ? ` · ${d.hodometro} km` : ''}${d.custo !== null ? ` · R$ ${d.custo.toFixed(2).replace('.', ',')}` : ''}`;

  srv.rota('POST', '/api/manutencao/feitas', async ({ u, body, ip }) => {
    const d = await dadosFeita(u, body || {});
    const x = await banco.query(`INSERT INTO manutencoes (${COLS_FEITA.join(', ')}, usuario_id, criado_em) VALUES (?)`, [[...COLS_FEITA.map((k) => d[k]), u.id || null, agora()]]);
    manutencao.mudou(d.empresa_id);
    await auditoria.registrar(u, 'registrar_manutencao', { entidade: 'manutencao', entidadeId: x.insertId, descricao: textoFeita(d), ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'manutencao.incluir' });

  async function feitaDe(u, id) {
    const f = await banco.um("SELECT *, DATE_FORMAT(data, '%Y-%m-%d') AS data FROM manutencoes WHERE id = ?", [V.id(id)]);
    if (!f || (u.perfil !== 'master' && f.empresa_id !== u.empresaId) || !veVeiculoId(u, f.veiculo_id)) throw new HttpErro(404, 'Registro não encontrado.');
    return f;
  }

  srv.rota('PUT', '/api/manutencao/feitas/:id', async ({ u, params, body, ip }) => {
    const atual = await feitaDe(u, params.id);
    const d = await dadosFeita(u, body || {}, atual);
    const cols = COLS_FEITA.filter((k) => k !== 'empresa_id' && k !== 'veiculo_id');
    await banco.query(`UPDATE manutencoes SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => d[k]), atual.id]);
    manutencao.mudou(atual.empresa_id);
    await auditoria.registrar(u, 'editar', { entidade: 'manutencao', entidadeId: atual.id, descricao: textoFeita(d), ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'manutencao.alterar' });

  srv.rota('DELETE', '/api/manutencao/feitas/:id', async ({ u, params, ip }) => {
    const atual = await feitaDe(u, params.id);
    await banco.query('DELETE FROM manutencoes WHERE id = ?', [atual.id]);
    manutencao.mudou(atual.empresa_id);
    await auditoria.registrar(u, 'excluir', { entidade: 'manutencao', entidadeId: atual.id, descricao: textoFeita({ ...atual, custo: atual.custo === null ? null : Number(atual.custo) }), ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'manutencao.excluir' });

  /* ---------- documentos ---------- */

  function dadosDoc(u, b, atual = null) {
    const de = atual ? (atual.veiculo_id ? 'veiculo' : 'motorista') : V.opcao(b.de, ['veiculo', 'motorista'], 'de quem é o documento', 'veiculo');
    const d = { empresa_id: null, veiculo_id: null, motorista_id: null };
    if (de === 'veiculo') {
      d.veiculo_id = atual ? atual.veiculo_id : V.id(b.veiculo, 'o veículo');
      const v = frota.veiculos.get(d.veiculo_id);
      if (!v || !veVeiculoId(u, d.veiculo_id)) throw new HttpErro(400, 'Veículo não encontrado.');
      d.empresa_id = v.empresa_id;
    } else {
      d.motorista_id = atual ? atual.motorista_id : V.id(b.motorista, 'o motorista');
      const m = motoristas.lista.get(d.motorista_id);
      if (!m || !manutencao.veMotorista(u, m)) throw new HttpErro(400, 'Motorista não encontrado.');
      if (!mexeMotorista(u, m)) throw new HttpErro(403, 'Este motorista não é de um grupo seu.');
      d.empresa_id = m.empresa_id;
    }
    d.tipo = V.opcao(b.tipo, Object.keys(TIPOS_DOC), 'o tipo de documento');
    const t = TIPOS_DOC[d.tipo];
    if (t.de !== 'ambos' && t.de !== de) throw new HttpErro(400, `${t.nome} é documento do ${t.de === 'veiculo' ? 'veículo' : 'motorista'}.`);
    d.descricao = V.texto(b.descricao, 'a descrição', { max: 80 });
    if (d.tipo === 'outro' && !d.descricao) throw new HttpErro(400, 'Escreva qual é o documento.');
    d.numero = V.texto(b.numero, 'o número', { max: 40 });
    d.vencimento = V.dia(b.vencimento, 'a data de vencimento', { obrigatorio: true });
    d.avisar_dias = V.inteiro(b.avisarDias, 'o aviso em dias', { min: 0, max: 365 }) ?? 30;
    d.observacao = V.texto(b.observacao, 'a observação', { max: 500 });
    return d;
  }
  const COLS_DOC = ['empresa_id', 'veiculo_id', 'motorista_id', 'tipo', 'descricao', 'numero', 'vencimento', 'avisar_dias', 'observacao'];
  const textoDoc = (d) => `${(TIPOS_DOC[d.tipo] || TIPOS_DOC.outro).nome}${d.descricao ? ` (${d.descricao})` : ''} · ${d.veiculo_id ? rotuloVeiculo(d.veiculo_id) : nomeMotorista(d.motorista_id)}`;
  const br = (dia) => String(dia).slice(0, 10).split('-').reverse().join('/');

  srv.rota('POST', '/api/manutencao/documentos', async ({ u, body, ip }) => {
    const d = dadosDoc(u, body || {});
    const x = await banco.query(`INSERT INTO documentos (${COLS_DOC.join(', ')}, usuario_id, criado_em) VALUES (?)`, [[...COLS_DOC.map((k) => d[k]), u.id || null, agora()]]);
    manutencao.mudou(d.empresa_id);
    await auditoria.registrar(u, 'criar', { entidade: 'documento', entidadeId: x.insertId, descricao: `${textoDoc(d)} · vence ${br(d.vencimento)}`, ip, empresaId: d.empresa_id });
    return { id: x.insertId };
  }, { acesso: 'manutencao.incluir' });

  async function docDe(u, id) {
    const d = await banco.um("SELECT *, DATE_FORMAT(vencimento, '%Y-%m-%d') AS vencimento FROM documentos WHERE id = ?", [V.id(id)]);
    if (!d || !veDoc(u, d)) throw new HttpErro(404, 'Documento não encontrado.');
    return d;
  }

  srv.rota('PUT', '/api/manutencao/documentos/:id', async ({ u, params, body, ip }) => {
    const atual = await docDe(u, params.id);
    const d = dadosDoc(u, body || {}, atual);
    const cols = COLS_DOC.filter((k) => !['empresa_id', 'veiculo_id', 'motorista_id'].includes(k));
    await banco.query(`UPDATE documentos SET ${cols.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`, [...cols.map((k) => d[k]), agora(), atual.id]);
    manutencao.mudou(atual.empresa_id);
    const renovou = d.vencimento !== atual.vencimento;
    await auditoria.registrar(u, renovou ? 'renovar_documento' : 'editar', {
      entidade: 'documento', entidadeId: atual.id, ip, empresaId: atual.empresa_id,
      descricao: `${textoDoc(d)}${renovou ? ` · vencimento ${br(atual.vencimento)} → ${br(d.vencimento)}` : ''}`,
    });
    return { ok: true };
  }, { acesso: 'manutencao.alterar' });

  srv.rota('DELETE', '/api/manutencao/documentos/:id', async ({ u, params, ip }) => {
    const atual = await docDe(u, params.id);
    if (atual.motorista_id && !mexeMotorista(u, motoristas.lista.get(atual.motorista_id))) throw new HttpErro(403, 'Este motorista não é de um grupo seu.');
    await banco.query('DELETE FROM documentos WHERE id = ?', [atual.id]);
    manutencao.mudou(atual.empresa_id);
    await auditoria.registrar(u, 'excluir', { entidade: 'documento', entidadeId: atual.id, descricao: textoDoc(atual), ip, empresaId: atual.empresa_id });
    return { ok: true };
  }, { acesso: 'manutencao.excluir' });
}

module.exports = { registrar, dinheiro };
