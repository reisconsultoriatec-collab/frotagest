'use strict';
/**
 * FrotaGest — API dos links de acompanhamento: criar (veículo ou linha), listar e cancelar, no painel;
 * e a parte pública (sem login) que a página /a/<código> consulta: posição, viagens da linha, logotipo
 * e o aviso "está chegando".
 * Reis Tecnologia
 */
const { HttpErro, agora, formatar, paraMs, validar: V } = require('../util/comum');
const { limitado } = require('../auth/acesso');

const VALIDADES_HORAS = [1, 2, 4, 8, 12, 24, 48, 72, 168];
const LIMITE_PUBLICO = { chave: 'acompanhar', max: 1500, minutos: 10 }; // várias pessoas atrás do mesmo IP (4G)

function registrar(srv) {
  const { banco, frota, auditoria, acesso, linhas, acompanhamento: ac } = srv;
  const rotuloVeiculo = (v) => (v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : '');
  const nomeLinha = (l) => (l ? `${l.codigo ? `${l.codigo} · ` : ''}${l.nome}` : 'linha excluída');

  /** A pessoa enxerga o link: o veículo (link de veículo) ou a linha (link de linha). */
  function ve(u, l) {
    if (u.perfil !== 'master' && l.empresa_id !== u.empresaId) return false;
    if (l.tipo === 'veiculo') {
      const v = frota.veiculos.get(l.veiculo_id);
      return v ? acesso.veVeiculo(u, v) : u.perfil === 'master' || !limitado(u);
    }
    const ln = linhas.linhas.get(l.linha_id);
    if (!ln) return u.perfil === 'master' || !limitado(u);
    return !limitado(u) || !ln.grupo_id || u.grupos.has(ln.grupo_id);
  }

  function situacao(l) {
    if (l.revogado_em) return 'cancelado';
    if (l.expira_em && paraMs(l.expira_em) <= Date.now()) return 'vencido';
    return 'ativo';
  }

  /* ---------- painel ---------- */

  srv.rota('GET', '/api/acompanhamento', async ({ u, query }) => {
    const emp = u.perfil === 'master' ? (query.empresa ? V.id(query.empresa, 'a empresa') : null) : u.empresaId;
    const rows = await banco.query(`SELECT l.*, us.nome AS criado_por_nome FROM links_acompanhamento l LEFT JOIN usuarios us ON us.id = l.criado_por
      ${emp ? 'WHERE l.empresa_id = ?' : ''} ORDER BY l.revogado_em IS NOT NULL, l.criado_em DESC LIMIT 1000`, emp ? [emp] : []);
    const lista = rows.filter((l) => ve(u, l)).map((l) => {
      const ins = ac.inscricoes.get(l.id);
      return {
        id: l.id, tipo: l.tipo, empresaId: l.empresa_id, empresa: (frota.empresas.get(l.empresa_id) || {}).nome || '',
        alvo: l.tipo === 'veiculo' ? rotuloVeiculo(frota.veiculos.get(l.veiculo_id)) || 'veículo excluído' : nomeLinha(linhas.linhas.get(l.linha_id)),
        veiculoId: l.veiculo_id, linhaId: l.linha_id, nome: l.nome, mostrarVeiculo: Boolean(l.mostrar_veiculo),
        caminho: `/a/${l.token}`, criadoEm: l.criado_em, criadoPor: l.criado_por_nome || '', expiraEm: l.expira_em, revogadoEm: l.revogado_em,
        situacao: situacao(l), acessos: l.acessos, ultimoAcesso: l.ultimo_acesso, avisos: ins ? ins.size : 0,
      };
    });
    // linhas que a pessoa pode compartilhar (o formulário do link não depende da tela de linhas)
    const opcoesLinhas = [...linhas.linhas.values()]
      .filter((ln) => ln.ativo && (!emp || ln.empresa_id === emp) && (u.perfil === 'master' || ln.empresa_id === u.empresaId) && (!limitado(u) || !ln.grupo_id || u.grupos.has(ln.grupo_id)))
      .sort((a, b) => nomeLinha(a).localeCompare(nomeLinha(b), 'pt-BR', { numeric: true }))
      .map((ln) => ({ id: ln.id, nome: nomeLinha(ln), empresaId: ln.empresa_id }));
    return { links: lista, validades: VALIDADES_HORAS, linhas: opcoesLinhas };
  }, { acesso: 'acompanhamento.ver' });

  srv.rota('POST', '/api/acompanhamento', async ({ u, body, ip }) => {
    const tipo = V.opcao(body.tipo, ['veiculo', 'linha'], 'o tipo de link');
    const d = { tipo, nome: V.texto(body.nome, 'para quem é o link', { max: 80 }), mostrarVeiculo: V.booleano(body.mostrarVeiculo, true) };
    let alvo = '';
    if (tipo === 'veiculo') {
      const v = frota.veiculos.get(V.id(body.veiculo, 'o veículo'));
      if (!v || !v.ativo || !acesso.veVeiculo(u, v)) throw new HttpErro(404, 'Veículo não encontrado.');
      d.veiculoId = v.id;
      d.empresaId = v.empresa_id;
      alvo = `veículo ${rotuloVeiculo(v)}`;
      // posição de um veículo: sempre com prazo
      const horas = V.inteiro(body.horas, 'a validade', { obrigatorio: true });
      if (!VALIDADES_HORAS.includes(horas)) throw new HttpErro(400, 'Escolha a validade do link (de 1 hora a 7 dias).');
      d.expiraEm = formatar(Date.now() + horas * 3600000);
    } else {
      const ln = linhas.linhas.get(V.id(body.linha, 'a linha'));
      if (!ln || (u.perfil !== 'master' && ln.empresa_id !== u.empresaId) || (limitado(u) && ln.grupo_id && !u.grupos.has(ln.grupo_id))) throw new HttpErro(404, 'Linha não encontrada.');
      d.linhaId = ln.id;
      d.empresaId = ln.empresa_id;
      alvo = `linha ${nomeLinha(ln)}`;
      // linha: sem prazo (até cancelar) ou até o fim de um dia escolhido (ex.: fim do semestre)
      const ate = V.dia(body.ate, 'a data final');
      if (ate) {
        if (ate < agora().slice(0, 10)) throw new HttpErro(400, 'A data final já passou.');
        d.expiraEm = `${ate} 23:59:59`;
      }
    }
    const l = await ac.criar(u, d);
    await auditoria.registrar(u, 'criar_link', {
      entidade: 'link_acompanhamento', entidadeId: l.id, ip, empresaId: l.empresa_id,
      descricao: `Link de acompanhamento do ${alvo}${d.nome ? ` para ${d.nome}` : ''}${d.expiraEm ? `, até ${d.expiraEm.slice(0, 16)}` : ', sem prazo'}`,
    });
    return { id: l.id, caminho: `/a/${l.token}`, expiraEm: l.expira_em };
  }, { acesso: 'acompanhamento.incluir' });

  srv.rota('DELETE', '/api/acompanhamento/:id', async ({ u, params, ip }) => {
    const l = await banco.um('SELECT * FROM links_acompanhamento WHERE id = ?', [V.id(params.id, 'o link')]);
    if (!l || !ve(u, l)) throw new HttpErro(404, 'Link não encontrado.');
    if (l.revogado_em) throw new HttpErro(409, 'Este link já foi cancelado.');
    await ac.revogar(u, l);
    await auditoria.registrar(u, 'cancelar_link', {
      entidade: 'link_acompanhamento', entidadeId: l.id, ip, empresaId: l.empresa_id,
      descricao: `Link de acompanhamento ${l.tipo === 'veiculo' ? `do veículo ${rotuloVeiculo(frota.veiculos.get(l.veiculo_id))}` : `da linha ${nomeLinha(linhas.linhas.get(l.linha_id))}`}${l.nome ? ` (${l.nome})` : ''} cancelado`,
    });
    return { ok: true };
  }, { acesso: 'acompanhamento.excluir' });

  /* ---------- público (a página /a/<código>) ---------- */

  const doToken = (token) => {
    const l = ac.doToken(token);
    if (!l) throw new HttpErro(404, 'Este link de acompanhamento não vale mais: venceu ou foi cancelado. Peça um novo a quem enviou.', 'link_invalido');
    return l;
  };

  srv.rota('GET', '/api/publico/a/:token', async ({ params, query }) => {
    const l = doToken(params.token);
    const gravando = ac.acesso(l, query.primeira === '1');
    if (query.primeira === '1') await gravando; // a primeira abertura conta na lista na hora
    const r = ac.publico(l);
    r.logo = Boolean(await srv.logotipos.de(l.empresa_id)); // (fica em cache no serviço de logotipos)
    if (query.endpoint) r.meuAviso = ac.inscricaoDe(l, query.endpoint);
    return r;
  }, { publica: true, limite: LIMITE_PUBLICO });

  srv.rota('GET', '/api/publico/a/:token/logo', async ({ params, res }) => {
    const l = doToken(params.token);
    const logo = await srv.logotipos.de(l.empresa_id);
    if (!logo) throw new HttpErro(404, 'Sem logotipo.');
    res.writeHead(200, srv.cabecalhos({ 'Content-Type': 'image/png', 'Content-Length': logo.png.length, 'Cache-Control': 'public, max-age=3600' }));
    res.end(logo.png);
  }, { publica: true, limite: LIMITE_PUBLICO });

  srv.rota('POST', '/api/publico/a/:token/aviso', async ({ params, body }) => {
    const l = doToken(params.token);
    const i = await ac.inscrever(l, body || {});
    return { ok: true, ponto: i.ponto_ordem, minutos: i.minutos };
  }, { publica: true, limite: { chave: 'acompanhar-aviso', max: 60, minutos: 10 } });

  srv.rota('POST', '/api/publico/a/:token/aviso/sair', async ({ params, body }) => {
    const l = doToken(params.token);
    return { ok: await ac.desinscrever(l, (body || {}).endpoint) };
  }, { publica: true, limite: { chave: 'acompanhar-aviso', max: 60, minutos: 10 } });
}

module.exports = { registrar };
