'use strict';
/**
 * FrotaGest — Procedimentos Auxiliares › Importação da Escala Globus.
 *
 *  POST   /api/escala-globus/previa               confere o arquivo sem gravar (o que bateu e o que não bateu)
 *  POST   /api/escala-globus/importar             grava a escala (o mesmo dia de novo pede substituir)
 *  GET    /api/escala-globus?data=&empresa=       a escala do dia, com o veículo e o motorista achados agora
 *  POST   /api/escala-globus/servicos/:id/vincular  coloca o motorista da escala no veículo (um a um)
 *  DELETE /api/escala-globus?data=&empresa=       exclui a escala importada daquele dia
 *
 * O veículo é achado pelo prefixo sem os zeros da frente e o motorista pela chapa (= matrícula); quem for
 * cadastrado depois da importação já aparece. O vínculo feito aqui termina sozinho no fim do serviço.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, agora, paraMs, formatar: formatarMs } = require('../util/comum');
const { limitado, permite } = require('../auth/acesso');
const { lerEscala, normEscala } = require('../servicos/escala-globus');

const ANTECEDENCIA_MIN = 60; // dá para vincular até 1 hora antes do início do serviço
const CORPO_MAX = 4 * 1024 * 1024;
const COLS = ['empresa_id', 'importacao_id', 'data', 'linha_arquivo', 'tipo_dia', 'prefixo', 'linha_codigo', 'linha_numero', 'linha_nome',
  'turno', 'turno_descricao', 'chapa', 'motorista_nome', 'servico_inicio', 'servico_fim', 'motorista_inicio', 'intervalo_inicio',
  'intervalo_fim', 'motorista_fim', 'local_pegada', 'vinculo_id', 'vinculado_em', 'vinculado_por'];
const hm = (s) => (s ? String(s).slice(11, 16) : '');
const fmtDia = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function registrar(srv) {
  const { banco, frota, auditoria, motoristas, acesso } = srv;

  const empresaDe = (u, q) => {
    if (u.perfil !== 'master') return u.empresaId;
    if (V.vazio(q.empresa)) throw new HttpErro(400, 'Escolha a empresa no topo da tela.', 'escolha_empresa');
    const id = V.id(q.empresa, 'a empresa');
    if (!frota.empresas.get(id)) throw new HttpErro(404, 'Empresa não encontrada.');
    return id;
  };
  const rotuloVeiculo = (v) => (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa);

  /** Veículos (pelo prefixo sem zeros) e motoristas (pela chapa = matrícula) ativos da empresa. */
  function mapas(emp) {
    const veiculos = new Map();
    const vRepetidos = new Set();
    for (const v of frota.veiculos.values()) {
      if (v.empresa_id !== emp || !v.ativo || V.vazio(v.prefixo)) continue;
      const k = normEscala(v.prefixo);
      if (veiculos.has(k)) vRepetidos.add(k); else veiculos.set(k, v);
    }
    const pessoas = new Map();
    const mRepetidos = new Set();
    for (const m of motoristas.lista.values()) {
      if (m.empresa_id !== emp || !m.ativo || V.vazio(m.matricula)) continue;
      const k = normEscala(m.matricula);
      if (pessoas.has(k)) mRepetidos.add(k); else pessoas.set(k, m);
    }
    const veiculo = (prefixo) => { const k = normEscala(prefixo); return prefixo && !vRepetidos.has(k) ? veiculos.get(k) || null : null; };
    const motorista = (chapa) => { const k = normEscala(chapa); return chapa && !mRepetidos.has(k) ? pessoas.get(k) || null : null; };
    return { veiculo, motorista, vRepetidos, mRepetidos };
  }

  /** O que bateu e o que não bateu, para a prévia e para o topo da escala do dia. */
  function pendencias(lista, mp) {
    const semCadastro = new Map();
    const naoAchados = new Map();
    let semVeiculo = 0;
    let semMotorista = 0;
    for (const s of lista) {
      if (!s.prefixo) semVeiculo++;
      else if (!mp.veiculo(s.prefixo)) {
        const k = normEscala(s.prefixo);
        const x = naoAchados.get(k) || { prefixo: s.prefixo, servicos: 0, repetido: mp.vRepetidos.has(k) };
        x.servicos++; naoAchados.set(k, x);
      }
      if (!s.chapa) semMotorista++;
      else if (!mp.motorista(s.chapa)) {
        const k = normEscala(s.chapa);
        const x = semCadastro.get(k) || { chapa: s.chapa, nome: s.motorista || '', servicos: 0, repetido: mp.mRepetidos.has(k) };
        x.servicos++; semCadastro.set(k, x);
      }
    }
    const porNome = (a, b) => String(a.nome || a.prefixo).localeCompare(String(b.nome || b.prefixo), 'pt-BR', { numeric: true });
    return {
      semVeiculo, semMotorista,
      veiculosNaoEncontrados: [...naoAchados.values()].sort(porNome),
      motoristasSemCadastro: [...semCadastro.values()].sort(porNome),
    };
  }

  /** O texto vem decodificado pelo navegador (UTF-8 ou Windows-1252, como o Globus gravou). */
  function lerCorpo(body) {
    const texto = typeof body.texto === 'string' ? body.texto : '';
    if (!texto.trim()) throw new HttpErro(400, 'Escolha o arquivo da escala gerado pelo Globus.');
    const arquivo = V.texto(body.arquivo, 'o nome do arquivo', { max: 160 });
    const r = lerEscala(texto);
    if (!r.servicos.length) {
      const e = r.erros[0];
      throw new HttpErro(400, e ? `Nenhum serviço válido no arquivo. Linha ${e.linha}: ${e.motivo}.` : 'Nenhum serviço no arquivo.');
    }
    return { ...r, arquivo };
  }

  async function existentes(emp, datas) {
    if (!datas.length) return new Map();
    const rows = await banco.query(
      `SELECT i.id, i.data, i.arquivo, i.servicos, i.criado_em, us.nome AS usuario FROM escala_importacoes i
        LEFT JOIN usuarios us ON us.id = i.usuario_id WHERE i.empresa_id = ? AND i.data IN (?) ORDER BY i.id`, [emp, datas]);
    return new Map(rows.map((x) => [String(x.data).slice(0, 10), x]));
  }

  /* ---------- prévia ---------- */

  srv.rota('POST', '/api/escala-globus/previa', async ({ u, body }) => {
    const emp = empresaDe(u, body);
    const r = lerCorpo(body);
    const mp = mapas(emp);
    const datas = [...new Set(r.servicos.map((s) => s.data))].sort();
    const ja = await existentes(emp, datas);
    return {
      empresa: (frota.empresas.get(emp) || {}).nome || '',
      arquivo: r.arquivo,
      servicos: r.servicos.length,
      datas: datas.map((d) => {
        const e = ja.get(d);
        return { data: d, servicos: r.servicos.filter((s) => s.data === d).length, existente: e ? { servicos: e.servicos, arquivo: e.arquivo, em: e.criado_em, por: e.usuario } : null };
      }),
      veiculos: new Set(r.servicos.filter((s) => s.prefixo).map((s) => normEscala(s.prefixo))).size,
      motoristas: new Set(r.servicos.filter((s) => s.chapa).map((s) => normEscala(s.chapa))).size,
      linhas: new Set(r.servicos.filter((s) => s.linhaCodigo).map((s) => s.linhaCodigo)).size,
      passamMeiaNoite: r.servicos.filter((s) => s.passaMeiaNoite).length,
      veiculosAchados: new Set(r.servicos.filter((s) => s.prefixo && mp.veiculo(s.prefixo)).map((s) => normEscala(s.prefixo))).size,
      motoristasAchados: new Set(r.servicos.filter((s) => s.chapa && mp.motorista(s.chapa)).map((s) => normEscala(s.chapa))).size,
      ...pendencias(r.servicos, mp),
      erros: r.erros.slice(0, 100),
      totalErros: r.erros.length,
    };
  }, { acesso: 'escala.incluir', corpoMax: CORPO_MAX, limite: { chave: 'escala', max: 60, minutos: 10 } });

  /* ---------- importar ---------- */

  srv.rota('POST', '/api/escala-globus/importar', async ({ u, body, ip }) => {
    const emp = empresaDe(u, body);
    const r = lerCorpo(body);
    const datas = [...new Set(r.servicos.map((s) => s.data))].sort();
    const ja = await existentes(emp, datas);
    if (ja.size && !V.booleano(body.substituir)) {
      throw new HttpErro(409, `Já existe escala importada para ${[...ja.keys()].map(fmtDia).join(', ')}. Confirme para substituir.`, 'ja_importada');
    }
    const quando = agora();
    await banco.transacao(async (c) => {
      for (const d of datas) {
        // o que já foi vinculado continua valendo: passa para a escala nova (mesmo veículo, motorista e início)
        const antigos = await c.query('SELECT prefixo, chapa, servico_inicio, vinculo_id, vinculado_em, vinculado_por FROM escala_servicos WHERE empresa_id = ? AND data = ? AND vinculo_id IS NOT NULL', [emp, d]);
        const chave = (p, ch, ini) => `${normEscala(p)}|${normEscala(ch)}|${String(ini).slice(0, 16)}`;
        const vinc = new Map(antigos.map((x) => [chave(x.prefixo, x.chapa, x.servico_inicio), x]));
        await c.query('DELETE FROM escala_servicos WHERE empresa_id = ? AND data = ?', [emp, d]);
        await c.query('DELETE FROM escala_importacoes WHERE empresa_id = ? AND data = ?', [emp, d]);
        const doDia = r.servicos.filter((s) => s.data === d);
        const imp = await c.query('INSERT INTO escala_importacoes (empresa_id, data, arquivo, servicos, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)',
          [emp, d, r.arquivo, doDia.length, u.id, quando]);
        const linhas = doDia.map((s) => {
          const v = vinc.get(chave(s.prefixo, s.chapa, s.servicoInicio));
          return [emp, imp.insertId, d, s.linha, s.tipoDia, s.prefixo, s.linhaCodigo, s.linhaNumero, s.linhaNome, s.turno, s.turnoDescricao,
            s.chapa, s.motorista, s.servicoInicio, s.servicoFim, s.motoristaInicio, s.intervaloInicio, s.intervaloFim, s.motoristaFim, s.local,
            v ? v.vinculo_id : null, v ? v.vinculado_em : null, v ? v.vinculado_por : null];
        });
        for (let i = 0; i < linhas.length; i += 500) await c.query(`INSERT INTO escala_servicos (${COLS.join(', ')}) VALUES ?`, [linhas.slice(i, i + 500)]);
      }
    });
    const subst = [...ja.keys()];
    await auditoria.registrar(u, 'importar_escala', {
      entidade: 'escala', descricao: `${r.arquivo || 'arquivo'}: ${r.servicos.length} serviço(s) de ${datas.map(fmtDia).join(', ')}${subst.length ? ' (substituiu a anterior)' : ''}${r.erros.length ? ` · ${r.erros.length} linha(s) com erro ficaram de fora` : ''}`,
      ip, empresaId: emp,
    });
    return { ok: true, datas, servicos: r.servicos.length, erros: r.erros.length, substituidas: subst };
  }, { acesso: 'escala.incluir', corpoMax: CORPO_MAX, limite: { chave: 'escala', max: 60, minutos: 10 } });

  /* ---------- a escala do dia ---------- */

  async function doDia(u, emp, data) {
    const rows = await banco.query('SELECT * FROM escala_servicos WHERE empresa_id = ? AND data = ? ORDER BY servico_inicio, linha_codigo, id', [emp, data]);
    const mp = mapas(emp);
    const ids = rows.filter((x) => x.vinculo_id).map((x) => x.vinculo_id);
    const vincs = ids.length ? await banco.query('SELECT id, inicio, fim, fim_previsto, origem FROM motorista_vinculos WHERE id IN (?)', [ids]) : [];
    const porId = new Map(vincs.map((x) => [x.id, x]));
    const quem = new Map();
    const usuarios = [...new Set(rows.map((x) => x.vinculado_por).filter(Boolean))];
    if (usuarios.length) for (const x of await banco.query('SELECT id, nome FROM usuarios WHERE id IN (?)', [usuarios])) quem.set(x.id, x.nome);
    const agoraTxt = agora();
    const agoraMs = paraMs(agoraTxt);
    const podeVincular = permite(u, 'escala', 'alterar');
    const lista = [];
    for (const s of rows) {
      const v = mp.veiculo(s.prefixo);
      if (limitado(u) && (!v || !acesso.veVeiculo(u, v))) continue; // quem vê só alguns grupos: só os veículos dele
      const m = mp.motorista(s.chapa);
      const ini = String(s.servico_inicio);
      const fim = String(s.servico_fim);
      const situacao = agoraTxt < ini ? 'aguardando' : agoraTxt < fim ? 'em_servico' : 'encerrado';
      const vin = s.vinculo_id ? porId.get(s.vinculo_id) : null;
      const noVeiculo = v ? motoristas.atual(v.id) : null;
      // por que não dá para vincular agora (o código vira um texto curto na tabela)
      let motivo = '';
      let codigo = '';
      const desde = hm(formatarMs(paraMs(ini) - ANTECEDENCIA_MIN * 60000));
      if (!s.prefixo) [codigo, motivo] = ['sem_veiculo', 'Serviço sem veículo na escala.'];
      else if (!v) [codigo, motivo] = ['veiculo_nao_encontrado', `Prefixo ${s.prefixo} não encontrado no FrotaGest.`];
      else if (!s.chapa) [codigo, motivo] = ['sem_motorista', 'Serviço sem motorista na escala.'];
      else if (!m) [codigo, motivo] = ['sem_cadastro', `Chapa ${s.chapa} sem cadastro: cadastre o motorista com essa matrícula.`];
      else if (situacao === 'encerrado') [codigo, motivo] = ['encerrado', `O serviço terminou às ${hm(fim)}.`];
      else if (agoraMs < paraMs(ini) - ANTECEDENCIA_MIN * 60000) [codigo, motivo] = ['cedo', `Dá para vincular a partir das ${desde} (1 hora antes do início, ${hm(ini)}).`];
      else if (noVeiculo && noVeiculo.id === m.id) [codigo, motivo] = ['ja_no_veiculo', 'Este motorista já está no veículo.'];
      else if (!acesso.veVeiculo(u, v)) [codigo, motivo] = ['fora_dos_grupos', 'Veículo fora dos seus grupos.'];
      else if (!podeVincular) [codigo, motivo] = ['sem_permissao', 'Você não tem permissão para vincular.'];
      lista.push({
        id: s.id, linhaArquivo: s.linha_arquivo, tipoDia: s.tipo_dia,
        linha: { codigo: s.linha_codigo, numero: s.linha_numero, nome: s.linha_nome },
        turno: s.turno, turnoDescricao: s.turno_descricao,
        prefixo: s.prefixo, veiculo: v ? { id: v.id, rotulo: rotuloVeiculo(v) } : null,
        chapa: s.chapa, motoristaNome: s.motorista_nome, motorista: m ? { id: m.id, nome: m.nome } : null,
        servicoInicio: ini, servicoFim: fim,
        motoristaInicio: s.motorista_inicio, intervaloInicio: s.intervalo_inicio, intervaloFim: s.intervalo_fim, motoristaFim: s.motorista_fim,
        local: s.local_pegada, situacao,
        vinculo: vin ? { em: s.vinculado_em, por: quem.get(s.vinculado_por) || null, aberto: !vin.fim, fim: vin.fim, fimPrevisto: vin.fim_previsto } : null,
        noVeiculo: noVeiculo ? { nome: noVeiculo.nome, origem: noVeiculo.origem, desde: noVeiculo.desde, mesmo: Boolean(m && noVeiculo.id === m.id) } : null,
        podeVincular: !motivo, motivo, codigo, vincularDesde: desde,
      });
    }
    return { lista, mp };
  }

  srv.rota('GET', '/api/escala-globus', async ({ u, query }) => {
    const emp = empresaDe(u, query);
    const data = V.dia(query.data, 'o dia') || agora().slice(0, 10);
    const { lista, mp } = await doDia(u, emp, data);
    const imp = (await existentes(emp, [data])).get(data) || null;
    const recentes = await banco.query('SELECT data, servicos FROM escala_importacoes WHERE empresa_id = ? ORDER BY data DESC LIMIT 31', [emp]);
    const raw = lista.map((s) => ({ prefixo: s.prefixo, chapa: s.chapa, motorista: s.motoristaNome }));
    return {
      empresa: (frota.empresas.get(emp) || {}).nome || '', empresaId: emp, data,
      importacao: imp ? { arquivo: imp.arquivo, servicos: imp.servicos, em: imp.criado_em, por: imp.usuario } : null,
      recentes: recentes.map((x) => ({ data: String(x.data).slice(0, 10), servicos: x.servicos })),
      servicos: lista,
      resumo: {
        servicos: lista.length,
        veiculos: new Set(lista.filter((s) => s.prefixo).map((s) => normEscala(s.prefixo))).size,
        motoristas: new Set(lista.filter((s) => s.chapa).map((s) => normEscala(s.chapa))).size,
        linhas: new Set(lista.filter((s) => s.linha.codigo).map((s) => s.linha.codigo)).size,
        emServico: lista.filter((s) => s.situacao === 'em_servico').length,
        vinculados: lista.filter((s) => s.vinculo).length,
      },
      ...pendencias(raw, mp),
    };
  }, { acesso: 'escala.ver' });

  /* ---------- vincular um a um ---------- */

  srv.rota('POST', '/api/escala-globus/servicos/:id/vincular', async ({ u, params, ip }) => {
    const s = await banco.um('SELECT * FROM escala_servicos WHERE id = ?', [V.id(params.id, 'o serviço')]);
    if (!s || (u.perfil !== 'master' && s.empresa_id !== u.empresaId)) throw new HttpErro(404, 'Serviço da escala não encontrado.');
    const { lista } = await doDia(u, s.empresa_id, String(s.data).slice(0, 10));
    const item = lista.find((x) => x.id === s.id);
    if (!item) throw new HttpErro(404, 'Serviço da escala não encontrado.');
    if (!item.podeVincular) throw new HttpErro(400, item.motivo);
    const v = frota.veiculos.get(item.veiculo.id);
    const m = motoristas.lista.get(item.motorista.id);
    const antes = motoristas.atual(v.id);
    const outro = motoristas.veiculoDe(m.id);
    await motoristas.vincular({ veiculoId: v.id, motoristaId: m.id, quando: agora(), origem: 'escala', usuarioId: u.id });
    const a = motoristas.abertos.get(v.id);
    if (!a || a.motoristaId !== m.id) throw new HttpErro(409, 'O motorista do veículo acabou de ser trocado por outra pessoa. Atualize a tela.');
    await banco.query('UPDATE motorista_vinculos SET fim_previsto = ? WHERE id = ?', [item.servicoFim, a.id]);
    await banco.query('UPDATE escala_servicos SET vinculo_id = ?, vinculado_em = ?, vinculado_por = ? WHERE id = ?', [a.id, agora(), u.id, s.id]);
    const desc = `${rotuloVeiculo(v)}: ${m.nome} (chapa ${s.chapa}) pela escala do Globus · ${s.linha_codigo || ''} ${hm(item.servicoInicio)}–${hm(item.servicoFim)}`
      + `${antes ? ` (antes: ${antes.nome})` : ''}${outro && outro !== v.id ? ` · saiu do ${rotuloVeiculo(frota.veiculos.get(outro))}` : ''}`;
    await auditoria.registrar(u, 'vincular_escala', { entidade: 'veiculo', entidadeId: v.id, descricao: desc, ip, empresaId: v.empresa_id });
    const depois = (await doDia(u, s.empresa_id, String(s.data).slice(0, 10))).lista.find((x) => x.id === s.id);
    return { ok: true, servico: depois };
  }, { acesso: 'escala.alterar', limite: { chave: 'escala-vincular', max: 600, minutos: 10 } });

  /* ---------- excluir a escala de um dia ---------- */

  srv.rota('DELETE', '/api/escala-globus', async ({ u, query, ip }) => {
    const emp = empresaDe(u, query);
    const data = V.dia(query.data, 'o dia', { obrigatorio: true });
    const imp = (await existentes(emp, [data])).get(data);
    if (!imp) throw new HttpErro(404, 'Não há escala importada neste dia.');
    await banco.transacao(async (c) => {
      await c.query('DELETE FROM escala_servicos WHERE empresa_id = ? AND data = ?', [emp, data]);
      await c.query('DELETE FROM escala_importacoes WHERE empresa_id = ? AND data = ?', [emp, data]);
    });
    await auditoria.registrar(u, 'excluir_escala', { entidade: 'escala', descricao: `escala de ${fmtDia(data)} (${imp.servicos} serviços${imp.arquivo ? `, ${imp.arquivo}` : ''}) · os vínculos já feitos continuam`, ip, empresaId: emp });
    return { ok: true };
  }, { acesso: 'escala.excluir' });
}

module.exports = { registrar };
