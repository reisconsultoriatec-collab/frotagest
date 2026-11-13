'use strict';
const fs = require('fs');
/**
 * FrotaGest — API de ocorrências: lista, abrir (do alerta, do veículo ou do zero), andamento, provas
 * (baixar as câmeras do momento, anexar download/foto, enviar arquivo) e o dossiê em PDF.
 * Reis Tecnologia
 */
const { HttpErro, agora, formatar, paraMs, validar: V } = require('../util/comum');
const { permite } = require('../auth/acesso');
const { normalizeId } = require('../protocolo/jt808');
const { TIPOS, SITUACOES } = require('../servicos/ocorrencias');
const { gerarDossie, orientacaoJpeg } = require('../relatorios/dossie');
const { medidasJpeg } = require('../servicos/logotipos');
const geo = require('../servicos/geo');
const permissoes = require('../auth/permissoes');

const MAX_ARQUIVO = 20 * 1024 * 1024;
const MAX_PONTOS = 3000;
const GRAVIDADES = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
// o que pode ser enviado (extensão → tipo)
const TIPOS_ARQUIVO = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg',
  txt: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip',
};
const NOMES_ANEXO = { gravacao: 'Gravação', foto: 'Foto', arquivo: 'Arquivo' };

const br = (dt) => (dt ? `${dt.slice(8, 10)}/${dt.slice(5, 7)}/${dt.slice(0, 4)} ${dt.slice(11, 16)}` : '');
const brSeg = (dt) => (dt ? `${dt.slice(8, 10)}/${dt.slice(5, 7)}/${dt.slice(0, 4)} ${dt.slice(11, 19)}` : '');
const tamanho = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const numeroTexto = (o) => `${o.ano}/${String(o.numero).padStart(4, '0')}`;
/** Data e hora do formulário ("AAAA-MM-DDThh:mm" ou com espaço, com ou sem segundos) → "AAAA-MM-DD hh:mm:ss". */
function dh(v, nome) {
  let s = String(v || '').trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
  return formatar(paraMs(V.dataHora(s, nome)));
}

function registrar(srv) {
  const { banco, frota, auditoria, acesso, ocorrencias, recorder, gateway, motoristas } = srv;

  const rotuloVeiculo = (id) => { const v = frota.veiculos.get(id); return v ? (v.prefixo ? `${v.prefixo} · ${v.placa}` : v.placa) : null; };
  const filtroEmpresa = (u, q) => (u.perfil === 'master' ? (q.empresa ? V.id(q.empresa, 'a empresa') : null) : u.empresaId);

  /** Quem vê: a empresa e, se a pessoa só enxerga alguns grupos, os veículos dela (sem veículo: todos da empresa). */
  function ve(u, o) {
    if (!o) return false;
    if (u.perfil === 'master') return true;
    if (o.empresa_id !== u.empresaId) return false;
    return !o.veiculo_id || acesso.veVeiculo(u, frota.veiculos.get(o.veiculo_id));
  }

  async function carregar(u, id) {
    const o = await banco.um('SELECT * FROM ocorrencias WHERE id = ?', [V.id(id, 'a ocorrência')]);
    if (!ve(u, o)) throw new HttpErro(404, 'Ocorrência não encontrada.');
    return o;
  }

  const avisar = (o) => ocorrencias.emit('mudou', o.empresa_id, o.id);

  /** Motorista que estava no veículo na hora do fato. */
  async function motoristaNaHora(veiculoId, quando) {
    if (!veiculoId) return null;
    const r = await banco.um(
      'SELECT motorista_id FROM motorista_vinculos WHERE veiculo_id = ? AND inicio <= ? AND (fim IS NULL OR fim > ?) ORDER BY inicio DESC LIMIT 1',
      [veiculoId, quando, quando]);
    return r ? r.motorista_id : null;
  }

  /** Cerca (garagem, ponto, área) em que o local do fato fica. */
  function cercaDoLocal(empresaId, lat, lon) {
    if (lat === null || lon === null || !srv.cercas) return null;
    const lista = [...srv.cercas.lista.values()].filter((c) => c.empresaId === empresaId);
    const c = lista.find((x) => { try { return geo.dentroDaCerca(x, lat, lon); } catch { return false; } });
    return c ? c.nome : null;
  }

  /* ---------- apoio e lista ---------- */

  srv.rota('GET', '/api/ocorrencias/apoio', async ({ u, query }) => {
    const emp = u.perfil === 'master' ? V.id(query.empresa, 'a empresa', false) : u.empresaId;
    let responsaveis = [];
    if (emp) {
      const us = await banco.query("SELECT id, nome, perfil, acessos FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND pendente = 0 ORDER BY nome", [emp]);
      // quem pode cuidar da ocorrência (pode mudar a situação)
      responsaveis = us.filter((x) => permissoes.permite(permissoes.efetivo(x.perfil, x.acessos), 'ocorrencias', 'alterar'))
        .map((x) => ({ id: x.id, nome: x.nome }));
    }
    return { tipos: Object.entries(TIPOS).map(([id, nome]) => ({ id, nome })), situacoes: SITUACOES, responsaveis };
  }, { acesso: 'ocorrencias.ver' });

  srv.rota('GET', '/api/ocorrencias', async ({ u, query }) => {
    const onde = [];
    const args = [];
    const emp = filtroEmpresa(u, query);
    if (emp) { onde.push('o.empresa_id = ?'); args.push(emp); }
    const sit = String(query.situacao || 'abertas');
    if (sit === 'abertas') onde.push("o.situacao <> 'encerrada'");
    else if (SITUACOES[sit]) { onde.push('o.situacao = ?'); args.push(sit); }
    if (query.veiculo) { onde.push('o.veiculo_id = ?'); args.push(V.id(query.veiculo, 'o veículo')); }
    if (query.alerta) { onde.push('o.alerta_id = ?'); args.push(V.id(query.alerta, 'o alerta')); }
    if (query.de && query.ate) {
      onde.push('o.quando BETWEEN ? AND ?');
      args.push(dh(query.de, 'a data inicial'), dh(query.ate, 'a data final'));
    }
    const limite = Math.min(1000, V.inteiro(query.limite, 'o limite', { min: 1, max: 1000 }) || 300);
    const rows = await banco.query(
      `SELECT o.*, mo.nome AS motorista, ur.nome AS responsavel, uc.nome AS criado_por_nome,
              (SELECT COUNT(*) FROM ocorrencia_anexos x WHERE x.ocorrencia_id = o.id) AS anexos
         FROM ocorrencias o
         LEFT JOIN motoristas mo ON mo.id = o.motorista_id
         LEFT JOIN usuarios ur ON ur.id = o.responsavel_id
         LEFT JOIN usuarios uc ON uc.id = o.criado_por
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
        ORDER BY o.quando DESC, o.id DESC LIMIT ${limite * 3}`, args);
    let lista = rows.filter((o) => ve(u, o));
    if (query.busca) {
      const b = String(query.busca).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      lista = lista.filter((o) => [numeroTexto(o), o.titulo, o.descricao, o.protocolo, rotuloVeiculo(o.veiculo_id), o.motorista, o.local_texto]
        .join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(b));
    }
    return {
      ocorrencias: lista.slice(0, limite).map((o) => ({
        id: o.id, numero: numeroTexto(o), empresaId: o.empresa_id, empresa: (frota.empresas.get(o.empresa_id) || {}).nome || '',
        veiculoId: o.veiculo_id, veiculo: rotuloVeiculo(o.veiculo_id), motorista: o.motorista, alertaId: o.alerta_id,
        tipo: o.tipo, tipoNome: TIPOS[o.tipo] || o.tipo, titulo: o.titulo, quando: o.quando, gravidade: o.gravidade,
        situacao: o.situacao, responsavel: o.responsavel, anexos: Number(o.anexos), protocolo: o.protocolo, criadoPor: o.criado_por_nome,
      })),
      total: lista.length,
    };
  }, { acesso: 'ocorrencias.ver' });

  /* ---------- detalhe ---------- */

  async function detalhe(u, o) {
    const [eventos, anexos, mot, resp, criador, encerrador, alerta] = await Promise.all([
      banco.query('SELECT e.*, us.nome AS usuario FROM ocorrencia_eventos e LEFT JOIN usuarios us ON us.id = e.usuario_id WHERE e.ocorrencia_id = ? ORDER BY e.id', [o.id]),
      banco.query('SELECT a.*, us.nome AS usuario FROM ocorrencia_anexos a LEFT JOIN usuarios us ON us.id = a.usuario_id WHERE a.ocorrencia_id = ? ORDER BY a.tipo, a.inicio, a.id', [o.id]),
      o.motorista_id ? banco.um('SELECT id, nome, matricula FROM motoristas WHERE id = ?', [o.motorista_id]) : null,
      o.responsavel_id ? banco.um('SELECT id, nome FROM usuarios WHERE id = ?', [o.responsavel_id]) : null,
      o.criado_por ? banco.um('SELECT nome FROM usuarios WHERE id = ?', [o.criado_por]) : null,
      o.encerrado_por ? banco.um('SELECT nome FROM usuarios WHERE id = ?', [o.encerrado_por]) : null,
      o.alerta_id ? banco.um('SELECT id, nome, gravidade, inicio, fim, velocidade, situacao FROM alertas WHERE id = ?', [o.alerta_id]) : null,
    ]);
    // trajeto e alertas no período (antes e depois do fato)
    const de = formatar(paraMs(o.quando) - o.trajeto_antes_min * 60000);
    const ate = formatar(paraMs(o.quando) + o.trajeto_depois_min * 60000);
    let trajeto = [];
    let alertas = [];
    if (o.veiculo_id) {
      [trajeto, alertas] = await Promise.all([
        banco.query(`SELECT data_hora, latitude, longitude, velocidade, ignicao FROM posicoes WHERE veiculo_id = ? AND data_hora BETWEEN ? AND ? AND gps_valido = 1
          ORDER BY data_hora, id LIMIT ${MAX_PONTOS}`, [o.veiculo_id, de, ate]),
        banco.query(`SELECT id, nome, gravidade, inicio, fim, latitude, longitude, velocidade FROM alertas WHERE veiculo_id = ? AND inicio BETWEEN ? AND ?
          ORDER BY inicio LIMIT 200`, [o.veiculo_id, de, ate]),
      ]);
    }
    const v = o.veiculo_id ? frota.veiculos.get(o.veiculo_id) : null;
    const ap = v && v.aparelho_id ? frota.aparelhos.get(v.aparelho_id) : (o.aparelho_id ? frota.aparelhos.get(o.aparelho_id) : null);
    const ident = ap ? normalizeId(ap.identificador) : null;
    const dev = ident ? gateway.devices.get(ident) : null;
    const nomesCanais = ap ? (ap.nomes_canais || []) : [];
    const canais = ap ? Array.from({ length: ap.canais || 4 }, (_, i) => ({ canal: i + 1, nome: nomesCanais[i] || '' })) : [];
    // o que dá para anexar: downloads prontos desse aparelho e fotos perto da hora
    const anexados = new Set(anexos.filter((a) => a.origem).map((a) => `${a.tipo}:${a.origem}`));
    const downloads = ident && u.pode.gravacoes
      ? recorder.list().filter((j) => j.deviceId === ident && srv.downloadVisivel(u, j))
      : [];
    let fotos = [];
    if (ap && permite(u, 'comandos')) {
      fotos = await banco.query(`SELECT id, canal, data_hora, velocidade FROM fotos WHERE aparelho_id = ? AND data_hora BETWEEN ? AND ? ORDER BY data_hora DESC LIMIT 100`,
        [ap.id, formatar(paraMs(o.quando) - 6 * 3600000), formatar(paraMs(o.quando) + 6 * 3600000)]);
    }
    const lat = o.latitude === null ? null : Number(o.latitude);
    const lon = o.longitude === null ? null : Number(o.longitude);
    return {
      ocorrencia: {
        ...o, numero: numeroTexto(o), tipoNome: TIPOS[o.tipo] || o.tipo, latitude: lat, longitude: lon,
        veiculo: rotuloVeiculo(o.veiculo_id), empresa: (frota.empresas.get(o.empresa_id) || {}).nome || '',
        motorista: mot, responsavel: resp, criadoPor: criador ? criador.nome : null, encerradoPor: encerrador ? encerrador.nome : null,
        alerta, cerca: cercaDoLocal(o.empresa_id, lat, lon),
      },
      eventos: eventos.map((e) => ({ id: e.id, tipo: e.tipo, texto: e.texto, quando: e.criado_em, usuario: e.usuario || (e.usuario_id ? '' : 'Sistema') })),
      anexos: anexos.map((a) => ({
        id: a.id, tipo: a.tipo, nome: a.nome, descricao: a.descricao, mime: a.mime, bytes: Number(a.bytes), sha256: a.sha256,
        canal: a.canal, inicio: a.inicio, fim: a.fim, usuario: a.usuario || (a.usuario_id ? '' : 'Sistema'), criadoEm: a.criado_em,
      })),
      trajeto: trajeto.map((p) => [Number(p.latitude), Number(p.longitude), Number(p.velocidade), p.data_hora]),
      periodo: { de, ate },
      alertas: alertas.map((a) => ({ ...a, latitude: a.latitude === null ? null : Number(a.latitude), longitude: a.longitude === null ? null : Number(a.longitude), velocidade: a.velocidade === null ? null : Number(a.velocidade) })),
      camera: {
        ident, online: Boolean(dev && dev.online), canais,
        podeBaixar: Boolean(ident && permite(u, 'gravacoes', 'incluir') && permite(u, 'ocorrencias', 'incluir')),
        baixando: downloads.filter((j) => j.ocorrenciaId === o.id && ['aguardando', 'gravando', 'convertendo'].includes(j.status)),
        downloads: downloads.filter((j) => j.status === 'pronto' && !anexados.has(`gravacao:${j.id}`)),
        fotos: fotos.filter((f) => !anexados.has(`foto:${f.id}`)),
      },
    };
  }

  srv.rota('GET', '/api/ocorrencias/:id', async ({ u, params }) => detalhe(u, await carregar(u, params.id)), { acesso: 'ocorrencias.ver' });

  /* ---------- abrir e editar ---------- */

  function dados(u, b, atual = null) {
    const d = {
      tipo: V.opcao(b.tipo, Object.keys(TIPOS), 'o tipo', atual ? atual.tipo : 'outro'),
      titulo: V.texto(b.titulo, 'o título', { max: 120, min: 3, obrigatorio: true }),
      descricao: V.texto(b.descricao, 'a descrição', { max: 20000 }),
      quando: dh(b.quando, 'a data e hora do fato'),
      gravidade: V.opcao(b.gravidade, Object.keys(GRAVIDADES), 'a gravidade', 'media'),
      local_texto: V.texto(b.local, 'o local', { max: 200 }),
      protocolo: V.texto(b.protocolo, 'o protocolo', { max: 60 }),
      responsavel_id: V.id(b.responsavel, 'o responsável', false),
      trajeto_antes_min: V.inteiro(b.antes, 'os minutos antes', { min: 0, max: 720 }) ?? (atual ? atual.trajeto_antes_min : 30),
      trajeto_depois_min: V.inteiro(b.depois, 'os minutos depois', { min: 0, max: 720 }) ?? (atual ? atual.trajeto_depois_min : 15),
    };
    if (d.quando > formatar(Date.now() + 10 * 60000)) throw new HttpErro(400, 'A data do fato não pode ser no futuro.');
    const lat = b.latitude === '' || b.latitude === null || b.latitude === undefined ? null : Number(b.latitude);
    const lon = b.longitude === '' || b.longitude === null || b.longitude === undefined ? null : Number(b.longitude);
    if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180))) {
      throw new HttpErro(400, 'Local inválido: informe latitude e longitude.');
    }
    d.latitude = lat;
    d.longitude = lon;
    return d;
  }

  srv.rota('POST', '/api/ocorrencias', async ({ u, body, ip }) => {
    const b = body || {};
    let alerta = null;
    if (b.alerta) {
      alerta = await banco.um('SELECT * FROM alertas WHERE id = ?', [V.id(b.alerta, 'o alerta')]);
      const visivel = alerta && (u.perfil === 'master' || (alerta.empresa_id === u.empresaId && (!alerta.veiculo_id || acesso.veVeiculo(u, frota.veiculos.get(alerta.veiculo_id)))));
      if (!visivel) throw new HttpErro(404, 'Alerta não encontrado.');
      const ja = await banco.um('SELECT * FROM ocorrencias WHERE alerta_id = ? ORDER BY id LIMIT 1', [alerta.id]);
      if (ja) return { id: ja.id, numero: numeroTexto(ja), existente: true };
    }
    const veiculoId = alerta ? alerta.veiculo_id : V.id(b.veiculo, 'o veículo', false);
    const v = veiculoId ? frota.veiculos.get(veiculoId) : null;
    if (veiculoId && (!v || !acesso.veVeiculo(u, v))) throw new HttpErro(400, 'Veículo não encontrado.');
    const empresaId = alerta ? alerta.empresa_id : v ? v.empresa_id : (u.perfil === 'master' ? V.id(b.empresa, 'a empresa') : u.empresaId);
    if (!frota.empresas.has(empresaId)) throw new HttpErro(400, 'Empresa não encontrada.');
    const base = {
      titulo: b.titulo || (alerta ? alerta.nome : ''), quando: b.quando || (alerta ? alerta.inicio : agora()),
      gravidade: b.gravidade || (alerta ? alerta.gravidade : 'media'),
      latitude: b.latitude ?? (alerta ? alerta.latitude : null), longitude: b.longitude ?? (alerta ? alerta.longitude : null),
    };
    const d = dados(u, { ...b, ...base });
    if (d.responsavel_id) {
      const r = await banco.um('SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?', [d.responsavel_id, empresaId]);
      if (!r) throw new HttpErro(400, 'Responsável não encontrado.');
    }
    // sem local informado: a posição do veículo mais perto da hora do fato
    if (d.latitude === null && veiculoId) {
      const p = await banco.um(`SELECT latitude, longitude FROM posicoes WHERE veiculo_id = ? AND gps_valido = 1 AND data_hora BETWEEN ? AND ?
        ORDER BY ABS(TIMESTAMPDIFF(SECOND, data_hora, ?)) LIMIT 1`, [veiculoId, formatar(paraMs(d.quando) - 600000), formatar(paraMs(d.quando) + 600000), d.quando]);
      if (p) { d.latitude = Number(p.latitude); d.longitude = Number(p.longitude); }
    }
    const motoristaId = b.motorista ? V.id(b.motorista, 'o motorista') : (alerta && alerta.motorista_id) || await motoristaNaHora(veiculoId, d.quando);
    const n = await ocorrencias.criar({
      ...d, empresa_id: empresaId, veiculo_id: veiculoId || null, aparelho_id: alerta ? alerta.aparelho_id : (v ? v.aparelho_id : null),
      motorista_id: motoristaId || null, alerta_id: alerta ? alerta.id : null, criado_por: u.id || null,
    });
    const num = `${n.ano}/${String(n.numero).padStart(4, '0')}`;
    await ocorrencias.evento(n.id, u.id, 'criada', alerta ? `Ocorrência aberta a partir do alerta "${alerta.nome}" (${brSeg(alerta.inicio)})` : 'Ocorrência aberta');
    if (alerta && alerta.situacao === 'novo') {
      await banco.query("UPDATE alertas SET situacao = 'em_tratamento', tratado_por = ?, tratado_em = ?, tratativa = COALESCE(tratativa, ?) WHERE id = ?",
        [u.id || null, agora(), `Ocorrência ${num} aberta`, alerta.id]);
      srv.enviarAlerta({ acao: 'tratado', alerta: { id: alerta.id, empresaId: alerta.empresa_id, veiculoId: alerta.veiculo_id, aparelhoId: alerta.aparelho_id, situacao: 'em_tratamento', tratadoPor: u.nome } });
    }
    await auditoria.registrar(u, 'criar', { entidade: 'ocorrencia', entidadeId: n.id, descricao: `${num}: ${d.titulo}${v ? ` (${rotuloVeiculo(v.id)})` : ''}`, ip, empresaId });
    avisar({ id: n.id, empresa_id: empresaId });
    return { id: n.id, numero: num };
  }, { acesso: 'ocorrencias.incluir' });

  srv.rota('PUT', '/api/ocorrencias/:id', async ({ u, params, body, ip }) => {
    const o = await carregar(u, params.id);
    const d = dados(u, body || {}, o);
    if (d.responsavel_id) {
      const r = await banco.um('SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?', [d.responsavel_id, o.empresa_id]);
      if (!r) throw new HttpErro(400, 'Responsável não encontrado.');
    }
    if (body && body.motorista !== undefined) d.motorista_id = body.motorista ? V.id(body.motorista, 'o motorista') : null;
    const nomes = { tipo: 'tipo', titulo: 'título', descricao: 'descrição', quando: 'data do fato', gravidade: 'gravidade', local_texto: 'local', protocolo: 'protocolo', responsavel_id: 'responsável', latitude: 'local no mapa', motorista_id: 'motorista', trajeto_antes_min: 'período do trajeto', trajeto_depois_min: 'período do trajeto' };
    const mudou = [...new Set(Object.keys(d).filter((k) => nomes[k] && String(d[k] ?? '') !== String(k === 'latitude' || k === 'longitude' ? (o[k] === null ? '' : Number(o[k])) : (o[k] ?? ''))).map((k) => nomes[k]))];
    const cols = Object.keys(d);
    await banco.query(`UPDATE ocorrencias SET ${cols.map((k) => `${k} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`, [...cols.map((k) => d[k]), agora(), o.id]);
    if (mudou.length) await ocorrencias.evento(o.id, u.id, 'edicao', `Alterou: ${mudou.join(', ')}`);
    await auditoria.registrar(u, 'editar', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: ${mudou.join(', ') || 'sem mudanças'}`, ip, empresaId: o.empresa_id });
    avisar(o);
    return { ok: true };
  }, { acesso: 'ocorrencias.alterar' });

  srv.rota('POST', '/api/ocorrencias/:id/situacao', async ({ u, params, body, ip }) => {
    const o = await carregar(u, params.id);
    const situacao = V.opcao(body.situacao, Object.keys(SITUACOES), 'a situação');
    const texto = V.texto(body.texto, situacao === 'encerrada' ? 'a conclusão' : 'o motivo', { max: 5000, obrigatorio: situacao === 'encerrada' || o.situacao === 'encerrada' });
    if (situacao === o.situacao) throw new HttpErro(400, `A ocorrência já está ${SITUACOES[situacao].toLowerCase()}.`);
    if (situacao === 'encerrada') {
      await banco.query('UPDATE ocorrencias SET situacao = ?, conclusao = ?, encerrado_por = ?, encerrado_em = ?, atualizado_em = ? WHERE id = ?', [situacao, texto, u.id || null, agora(), agora(), o.id]);
      await ocorrencias.evento(o.id, u.id, 'situacao', `Encerrada: ${texto}`);
    } else {
      await banco.query('UPDATE ocorrencias SET situacao = ?, encerrado_por = NULL, encerrado_em = NULL, atualizado_em = ? WHERE id = ?', [situacao, agora(), o.id]);
      await ocorrencias.evento(o.id, u.id, 'situacao', `${o.situacao === 'encerrada' ? 'Reaberta' : 'Situação'}: ${SITUACOES[situacao]}${texto ? ` — ${texto}` : ''}`);
    }
    await auditoria.registrar(u, 'situacao_ocorrencia', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: ${SITUACOES[o.situacao]} → ${SITUACOES[situacao]}`, ip, empresaId: o.empresa_id });
    avisar(o);
    return { ok: true };
  }, { acesso: 'ocorrencias.alterar' });

  srv.rota('POST', '/api/ocorrencias/:id/notas', async ({ u, params, body }) => {
    const o = await carregar(u, params.id);
    const texto = V.texto(body.texto, 'a anotação', { max: 1000, obrigatorio: true });
    await ocorrencias.evento(o.id, u.id, 'nota', texto);
    await banco.query('UPDATE ocorrencias SET atualizado_em = ? WHERE id = ?', [agora(), o.id]);
    avisar(o);
    return { ok: true };
  }, { acesso: 'ocorrencias.incluir' });

  srv.rota('DELETE', '/api/ocorrencias/:id', async ({ u, params, ip }) => {
    const o = await carregar(u, params.id);
    await ocorrencias.excluir(o);
    await auditoria.registrar(u, 'excluir', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: ${o.titulo}`, ip, empresaId: o.empresa_id });
    avisar(o);
    return { ok: true };
  }, { acesso: 'ocorrencias.excluir' });

  /* ---------- provas ---------- */

  /** Baixa as câmeras do momento: um download por câmera, que entra na ocorrência quando fica pronto. */
  srv.rota('POST', '/api/ocorrencias/:id/baixar', async ({ u, params, body, ip }) => {
    const o = await carregar(u, params.id);
    if (o.situacao === 'encerrada') throw new HttpErro(409, 'A ocorrência está encerrada: reabra para baixar mais gravações.');
    if (!permite(u, 'gravacoes', 'incluir')) throw new HttpErro(403, 'Você não tem acesso a baixar gravações. Fale com o administrador do sistema.', 'sem_acesso');
    const v = o.veiculo_id ? frota.veiculos.get(o.veiculo_id) : null;
    const ap = v && v.aparelho_id ? frota.aparelhos.get(v.aparelho_id) : (o.aparelho_id ? frota.aparelhos.get(o.aparelho_id) : null);
    if (!ap) throw new HttpErro(400, 'Esta ocorrência não tem veículo com aparelho: não há câmeras para baixar.');
    const ident = normalizeId(ap.identificador);
    const dev = gateway.devices.get(ident);
    if (!dev || !dev.online) throw new HttpErro(409, 'O aparelho do veículo está offline: as gravações ficam no cartão do DVR; tente quando ele voltar a se comunicar.');
    const canais = [...new Set((Array.isArray(body.canais) ? body.canais : []).map((c) => V.inteiro(c, 'a câmera', { min: 1, max: 32, obrigatorio: true })))];
    if (!canais.length) throw new HttpErro(400, 'Escolha as câmeras.');
    if (canais.length > 16) throw new HttpErro(400, 'Escolha no máximo 16 câmeras.');
    const inicio = dh(body.inicio, 'o início');
    const fim = dh(body.fim, 'o fim');
    if (fim <= inicio) throw new HttpErro(400, 'O fim precisa ser depois do início.');
    if (paraMs(fim) - paraMs(inicio) > 30 * 60000) throw new HttpErro(400, 'Baixe no máximo 30 minutos por vez nas ocorrências.');
    const pedidos = [];
    const falhas = [];
    for (const ch of canais) {
      try {
        const job = recorder.start(ident, { channel: ch, start: inicio, end: fim }, {
          empresaId: ap.empresa_id, usuarioId: u.id, rotulo: v ? v.placa : ident, ocorrenciaId: o.id, nomeCanal: (ap.nomes_canais || [])[ch - 1] || null,
        });
        pedidos.push(job);
      } catch (e) { falhas.push(`câmera ${ch}: ${e.message}`); }
    }
    if (pedidos.length) {
      await ocorrencias.evento(o.id, u.id, 'download', `Pediu as gravações da${pedidos.length > 1 ? 's câmeras' : ' câmera'} ${pedidos.map((j) => j.channel).join(', ')} de ${brSeg(inicio)} a ${fim.slice(11, 19)}`);
      await auditoria.registrar(u, 'baixar_gravacao', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: câmeras ${pedidos.map((j) => j.channel).join(', ')}, ${inicio} a ${fim}`, ip, empresaId: o.empresa_id });
      avisar(o);
    }
    if (!pedidos.length) throw new HttpErro(409, `Nenhum download começou: ${falhas.join('; ')}`);
    return { ok: true, downloads: pedidos, falhas };
  }, { acesso: 'ocorrencias.incluir' });

  srv.rota('POST', '/api/ocorrencias/:id/anexos/download', async ({ u, params, body }) => {
    const o = await carregar(u, params.id);
    const job = recorder.get(String(body.download || ''));
    if (!job || !srv.downloadVisivel(u, job)) throw new HttpErro(404, 'Download não encontrado.');
    if (job.status !== 'pronto') throw new HttpErro(409, 'O download ainda não está pronto.');
    if (job.empresaId && job.empresaId !== o.empresa_id) throw new HttpErro(400, 'Este download é de outra empresa.');
    const a = await ocorrencias.anexarDownload(o.id, job, u.id, V.texto(body.descricao, 'a descrição', { max: 300 }));
    if (a.repetido) throw new HttpErro(409, 'Esta gravação já está na ocorrência.');
    await ocorrencias.evento(o.id, u.id, 'anexo', `Anexou a gravação da câmera ${job.channel}: ${job.start.slice(0, 16)} a ${job.end.slice(11, 19)} (${tamanho(a.bytes)})`);
    avisar(o);
    return { ok: true, id: a.id };
  }, { acesso: 'ocorrencias.incluir' });

  srv.rota('POST', '/api/ocorrencias/:id/anexos/foto', async ({ u, params, body }) => {
    const o = await carregar(u, params.id);
    if (!permite(u, 'comandos')) throw new HttpErro(403, 'Você não tem acesso às fotos das câmeras.', 'sem_acesso');
    const f = await banco.um('SELECT * FROM fotos WHERE id = ?', [V.id(body.foto, 'a foto')]);
    const apF = f ? frota.aparelhos.get(f.aparelho_id) : null;
    if (!f || !apF || (u.perfil !== 'master' && f.empresa_id !== u.empresaId) || !acesso.aparelhoVisivel(u, normalizeId(apF.identificador))) {
      throw new HttpErro(404, 'Foto não encontrada.');
    }
    let a;
    try { a = await ocorrencias.anexarFoto(o.id, f, u.id, V.texto(body.descricao, 'a descrição', { max: 300 })); } catch { throw new HttpErro(404, 'O arquivo desta foto não existe mais.'); }
    if (a.repetido) throw new HttpErro(409, 'Esta foto já está na ocorrência.');
    await ocorrencias.evento(o.id, u.id, 'anexo', `Anexou a foto da câmera ${f.canal} de ${brSeg(f.data_hora)}`);
    avisar(o);
    return { ok: true, id: a.id };
  }, { acesso: 'ocorrencias.incluir' });

  srv.rota('POST', '/api/ocorrencias/:id/anexos/arquivo', async ({ u, params, body }) => {
    const o = await carregar(u, params.id);
    const nome = V.texto(body.nome, 'o nome do arquivo', { max: 160, obrigatorio: true });
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(nome) || [])[1];
    const mime = ext && TIPOS_ARQUIVO[ext.toLowerCase()];
    if (!mime) throw new HttpErro(400, 'Tipo de arquivo não aceito. Envie PDF, foto (JPG, PNG), vídeo (MP4, MOV), áudio, documento do Word/Excel, texto ou ZIP.');
    const m = /^data:[^;,]*(;base64)?,([A-Za-z0-9+/=]*)$/.exec(String(body.conteudo || ''));
    if (!m || !m[1]) throw new HttpErro(400, 'Arquivo inválido.');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new HttpErro(400, 'O arquivo está vazio.');
    if (buf.length > MAX_ARQUIVO) throw new HttpErro(413, 'Arquivo grande demais: até 20 MB por arquivo.');
    const a = await ocorrencias.anexarBuffer(o.id, buf, { nome, mime, descricao: V.texto(body.descricao, 'a descrição', { max: 300 }) }, u.id);
    await ocorrencias.evento(o.id, u.id, 'anexo', `Enviou o arquivo ${nome} (${tamanho(a.bytes)})`);
    avisar(o);
    return { ok: true, id: a.id };
  }, { acesso: 'ocorrencias.incluir', corpoMax: Math.ceil(MAX_ARQUIVO * 1.4) + 4096 });

  async function anexoDe(u, params) {
    const o = await carregar(u, params.id);
    const a = await banco.um('SELECT * FROM ocorrencia_anexos WHERE id = ? AND ocorrencia_id = ?', [V.id(params.anexo, 'o anexo'), o.id]);
    if (!a) throw new HttpErro(404, 'Anexo não encontrado.');
    return { o, a };
  }

  /** Abre o arquivo (fotos e PDFs na tela). */
  srv.rota('GET', '/api/ocorrencias/:id/anexos/:anexo', async ({ u, params, req, res }) => {
    const { a } = await anexoDe(u, params);
    if (a.bytes > 25 * 1048576) throw new HttpErro(413, 'Arquivo grande: use o botão de baixar.');
    await srv.enviarArquivo(req, res, { caminho: ocorrencias.caminho(a), nome: a.nome, mime: a.mime, inline: true });
  }, { acesso: 'ocorrencias.ver' });

  /** Link curto para baixar (vídeos grandes não passam pela memória do navegador). */
  srv.rota('POST', '/api/ocorrencias/:id/anexos/:anexo/link', async ({ u, params, ip }) => {
    const { o, a } = await anexoDe(u, params);
    await auditoria.registrar(u, 'baixar_anexo', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: ${a.nome}`, ip, empresaId: o.empresa_id });
    return srv.novoLinkArquivo({ caminho: ocorrencias.caminho(a), nome: a.nome, mime: a.mime }, u);
  }, { acesso: 'ocorrencias.ver' });

  srv.rota('DELETE', '/api/ocorrencias/:id/anexos/:anexo', async ({ u, params, ip }) => {
    const { o, a } = await anexoDe(u, params);
    if (o.situacao === 'encerrada') throw new HttpErro(409, 'A ocorrência está encerrada: reabra para tirar provas.');
    await ocorrencias.removerAnexo(a);
    await ocorrencias.evento(o.id, u.id, 'anexo_removido', `Removeu ${NOMES_ANEXO[a.tipo].toLowerCase()} ${a.nome} (SHA-256 ${a.sha256})`);
    await auditoria.registrar(u, 'excluir', { entidade: 'ocorrencia', entidadeId: o.id, descricao: `${numeroTexto(o)}: anexo ${a.nome}`, ip, empresaId: o.empresa_id });
    avisar(o);
    return { ok: true };
  }, { acesso: 'ocorrencias.alterar' });

  /* ---------- dossiê em PDF ---------- */

  srv.rota('GET', '/api/ocorrencias/:id/dossie', async ({ u, params, res, ip }) => {
    const o = await carregar(u, params.id);
    const x = await detalhe(u, o);
    const oc = x.ocorrencia;
    const cor = { alta: [0xDC, 0x26, 0x26], media: [0xD9, 0x77, 0x06], baixa: [0x5B, 0x64, 0x78] };
    const local = [oc.latitude !== null ? `${oc.latitude.toFixed(6)}, ${oc.longitude.toFixed(6)}` : '', oc.cerca ? `dentro de ${oc.cerca}` : '', oc.local_texto || ''].filter(Boolean).join(' · ');
    // fotos (das câmeras e as enviadas em JPEG) entram no PDF; até 16 e 30 MB
    const fotosPdf = [];
    let soma = 0;
    const linhasAnexo = await banco.query("SELECT * FROM ocorrencia_anexos WHERE ocorrencia_id = ? AND mime = 'image/jpeg' ORDER BY tipo, inicio, id", [o.id]);
    for (const a of linhasAnexo) {
      if (fotosPdf.length >= 16) break;
      try {
        const buf = await fs.promises.readFile(ocorrencias.caminho(a));
        const m = medidasJpeg(buf);
        if (!m || (m.componentes !== 3 && m.componentes !== 1) || soma + buf.length > 30 * 1048576) continue;
        soma += buf.length;
        fotosPdf.push({
          jpeg: buf, largura: m.largura, altura: m.altura, componentes: m.componentes, orientacao: orientacaoJpeg(buf),
          legenda: a.tipo === 'foto' ? `Câmera ${a.canal} · ${brSeg(a.inicio)}` : `${a.nome}${a.descricao ? ` · ${a.descricao}` : ''}`,
        });
      } catch { /* arquivo sumiu: só na lista */ }
    }
    const vel = (() => {
      let melhor = null;
      for (const p of x.trajeto) if (!melhor || Math.abs(paraMs(p[3]) - paraMs(oc.quando)) < Math.abs(paraMs(melhor[3]) - paraMs(oc.quando))) melhor = p;
      return melhor && Math.abs(paraMs(melhor[3]) - paraMs(oc.quando)) <= 120000 ? melhor[2] : null;
    })();
    let km = 0;
    for (let i = 1; i < x.trajeto.length; i++) {
      const d = geo.distM(x.trajeto[i - 1][0], x.trajeto[i - 1][1], x.trajeto[i][0], x.trajeto[i][1]);
      if (d < 3000) km += d / 1000;
    }
    const velMax = x.trajeto.reduce((mx, p) => Math.max(mx, p[2]), 0);
    const pdf = gerarDossie({
      numero: oc.numero, titulo: oc.titulo, situacao: SITUACOES[oc.situacao],
      quadros: [['Tipo', oc.tipoNome], ['Gravidade', GRAVIDADES[oc.gravidade], cor[oc.gravidade]], ['Data do fato', br(oc.quando)], ['Provas', `${x.anexos.length} arquivo${x.anexos.length === 1 ? '' : 's'}`]],
      campos: [
        ['Veículo', oc.veiculo || 'não informado'], ['Motorista', oc.motorista ? `${oc.motorista.nome}${oc.motorista.matricula ? ` (${oc.motorista.matricula})` : ''}` : 'não informado'],
        ['Empresa', oc.empresa], ['Local', local || 'não informado'],
        ['Protocolo externo (BO, sinistro)', oc.protocolo || '—'], ['Responsável', oc.responsavel ? oc.responsavel.nome : '—'],
        ['Aberta por', `${oc.criadoPor || 'Sistema'} em ${br(oc.criado_em)}`], ['Alerta de origem', oc.alerta ? `${oc.alerta.nome} · ${brSeg(oc.alerta.inicio)}${oc.alerta.velocidade !== null ? ` · ${Math.round(oc.alerta.velocidade)} km/h` : ''}` : '—'],
        ...(oc.situacao === 'encerrada' ? [['Encerrada por', `${oc.encerradoPor || '—'} em ${br(oc.encerrado_em)}`]] : []),
      ],
      descricao: oc.descricao,
      trajeto: oc.veiculo_id ? {
        pontos: x.trajeto.map((p) => [p[0], p[1]]),
        alvo: oc.latitude !== null ? [oc.latitude, oc.longitude] : null,
        alertas: x.alertas.filter((a) => a.latitude !== null).map((a) => [a.latitude, a.longitude]),
        legenda: `De ${br(x.periodo.de)} a ${br(x.periodo.ate)} · ${km.toFixed(1).replace('.', ',')} km · velocidade máxima ${Math.round(velMax)} km/h${vel !== null ? ` · no momento do fato: ${Math.round(vel)} km/h` : ''} · posições do GPS do aparelho (sem mapa de fundo).`,
      } : null,
      alertas: x.alertas.map((a) => [brSeg(a.inicio), a.nome, GRAVIDADES[a.gravidade], a.velocidade !== null ? `${Math.round(a.velocidade)} km/h` : '', a.fim ? brSeg(a.fim) : 'ativo']),
      fotos: fotosPdf,
      anexos: x.anexos.map((a) => [NOMES_ANEXO[a.tipo], a.nome,
        a.tipo === 'gravacao' ? `${a.descricao || `Câmera ${a.canal}`} · ${brSeg(a.inicio)} a ${String(a.fim || '').slice(11, 19)}` : a.tipo === 'foto' ? `Câmera ${a.canal} · ${brSeg(a.inicio)}` : (a.descricao || ''),
        tamanho(a.bytes), `SHA-256 ${a.sha256}`]),
      eventos: x.eventos.map((e) => [br(e.quando), e.usuario || 'Sistema', e.texto]),
      conclusao: oc.situacao === 'encerrada' ? oc.conclusao : null,
      logo: await srv.logotipos.paraPdf(o.empresa_id),
      rodape: `Gerado em ${br(agora())} por ${u.nome || u.email} · FrotaGest · Reis Tecnologia`,
    });
    await ocorrencias.evento(o.id, u.id, 'dossie', 'Gerou o dossiê em PDF');
    await auditoria.registrar(u, 'gerar_dossie', { entidade: 'ocorrencia', entidadeId: o.id, descricao: numeroTexto(o), ip, empresaId: o.empresa_id });
    avisar(o);
    res.writeHead(200, srv.cabecalhos({
      'Content-Type': 'application/pdf', 'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="ocorrencia-${o.ano}-${String(o.numero).padStart(4, '0')}.pdf"`,
    }));
    res.end(pdf);
  }, { acesso: 'ocorrencias.ver' });
}

module.exports = { registrar, TIPOS_ARQUIVO };
