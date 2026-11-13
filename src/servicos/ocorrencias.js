'use strict';
/**
 * FrotaGest — ocorrências: número por empresa e ano, andamento e provas. Os arquivos ficam em
 * data/ocorrencias/<id>/ — gravação baixada e foto entram por link físico (mesmo arquivo no disco, sem
 * ocupar o dobro; continua lá mesmo quando o download ou a foto original vencem) ou por cópia.
 * Gravação pedida pela ocorrência ("baixar as câmeras do momento") entra sozinha quando fica pronta.
 * Reis Tecnologia
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { agora } = require('../util/comum');

const TIPOS = {
  acidente: 'Acidente / colisão',
  roubo: 'Roubo / assalto',
  avaria: 'Avaria / pane',
  conduta: 'Conduta do motorista',
  passageiro: 'Passageiro / reclamação',
  transito: 'Infração de trânsito',
  vandalismo: 'Vandalismo',
  outro: 'Outro',
};
const SITUACOES = { aberta: 'Aberta', em_analise: 'Em análise', encerrada: 'Encerrada' };

const sha256Arquivo = (arq) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(arq).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** Nome seguro para o disco (sem caminho, sem caracteres estranhos). */
function nomeSeguro(nome) {
  const base = path.basename(String(nome || 'arquivo')).normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'arquivo';
}

class Ocorrencias extends EventEmitter {
  constructor({ banco, frota, recorder, fotos, dataDir, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.recorder = recorder;
    this.fotos = fotos;
    this.log = log;
    this.pasta = path.join(dataDir, 'ocorrencias');
    fs.mkdirSync(this.pasta, { recursive: true });
  }

  pastaDe(ocId) { return path.join(this.pasta, String(Number(ocId))); }

  caminho(anexo) {
    const alvo = path.resolve(this.pastaDe(anexo.ocorrencia_id), anexo.arquivo);
    if (!alvo.startsWith(path.resolve(this.pasta) + path.sep)) throw new Error('caminho inválido');
    return alvo;
  }

  /** Cria com o próximo número do ano (o índice único garante que dois ao mesmo tempo não repetem). */
  async criar(d) {
    const ano = Number(agora().slice(0, 4));
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const r = await this.banco.um('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ocorrencias WHERE empresa_id = ? AND ano = ?', [d.empresa_id, ano]);
      const linha = { ...d, ano, numero: Number(r.n), criado_em: agora() };
      const cols = Object.keys(linha);
      try {
        const x = await this.banco.query(`INSERT INTO ocorrencias (${cols.join(', ')}) VALUES (?)`, [cols.map((k) => linha[k])]);
        return { id: x.insertId, ano, numero: r.n };
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY' && !/duplicate/i.test(e.message)) throw e;
      }
    }
    throw new Error('não foi possível numerar a ocorrência; tente de novo');
  }

  async evento(ocId, usuarioId, tipo, texto) {
    await this.banco.query('INSERT INTO ocorrencia_eventos (ocorrencia_id, usuario_id, tipo, texto, criado_em) VALUES (?, ?, ?, ?, ?)',
      [ocId, usuarioId || null, tipo, String(texto).slice(0, 1000), agora()]);
  }

  /** Coloca um arquivo do disco na pasta da ocorrência (link físico; se não der, cópia). */
  async trazer(ocId, origem, nome) {
    await fs.promises.mkdir(this.pastaDe(ocId), { recursive: true });
    const arquivo = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${nomeSeguro(nome)}`;
    const dest = path.join(this.pastaDe(ocId), arquivo);
    try { await fs.promises.link(origem, dest); } catch { await fs.promises.copyFile(origem, dest); }
    return { arquivo, dest };
  }

  async registrarAnexo(ocId, { tipo, origem = null, arquivo, dest, nome, descricao = null, mime, canal = null, inicio = null, fim = null }, usuarioId) {
    const st = await fs.promises.stat(dest);
    const sha = await sha256Arquivo(dest);
    const x = await this.banco.query(
      `INSERT INTO ocorrencia_anexos (ocorrencia_id, tipo, origem, arquivo, nome, descricao, mime, bytes, sha256, canal, inicio, fim, usuario_id, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ocId, tipo, origem, arquivo, nome, descricao, mime, st.size, sha, canal, inicio, fim, usuarioId || null, agora()]);
    return { id: x.insertId, bytes: st.size, sha256: sha };
  }

  /** Gravação já baixada (pronta) entra na ocorrência. */
  async anexarDownload(ocId, job, usuarioId, descricao = null) {
    const ja = await this.banco.um("SELECT id FROM ocorrencia_anexos WHERE ocorrencia_id = ? AND tipo = 'gravacao' AND origem = ?", [ocId, job.id]);
    if (ja) return { id: ja.id, repetido: true };
    const { arquivo, dest } = await this.trazer(ocId, this.recorder.filePath(job), job.name);
    const a = await this.registrarAnexo(ocId, {
      tipo: 'gravacao', origem: job.id, arquivo, dest, nome: job.name, descricao, mime: 'video/mp4', canal: job.channel, inicio: job.start, fim: job.end,
    }, usuarioId);
    return a;
  }

  async anexarFoto(ocId, foto, usuarioId, descricao = null) {
    const ja = await this.banco.um("SELECT id FROM ocorrencia_anexos WHERE ocorrencia_id = ? AND tipo = 'foto' AND origem = ?", [ocId, String(foto.id)]);
    if (ja) return { id: ja.id, repetido: true };
    const origem = await this.fotos.caminho(foto);
    const nome = `foto_camera${foto.canal}_${String(foto.data_hora).replace(/\D/g, '').slice(0, 14)}.jpg`;
    const { arquivo, dest } = await this.trazer(ocId, origem, nome);
    return this.registrarAnexo(ocId, { tipo: 'foto', origem: String(foto.id), arquivo, dest, nome, descricao, mime: 'image/jpeg', canal: foto.canal, inicio: foto.data_hora }, usuarioId);
  }

  async anexarBuffer(ocId, buf, { nome, mime, descricao = null }, usuarioId) {
    await fs.promises.mkdir(this.pastaDe(ocId), { recursive: true });
    const arquivo = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${nomeSeguro(nome)}`;
    const dest = path.join(this.pastaDe(ocId), arquivo);
    await fs.promises.writeFile(dest, buf);
    return this.registrarAnexo(ocId, { tipo: 'arquivo', arquivo, dest, nome, descricao, mime }, usuarioId);
  }

  async removerAnexo(anexo) {
    await fs.promises.rm(this.caminho(anexo), { force: true });
    await this.banco.query('DELETE FROM ocorrencia_anexos WHERE id = ?', [anexo.id]);
  }

  async excluir(oc) {
    await fs.promises.rm(this.pastaDe(oc.id), { recursive: true, force: true });
    await this.banco.query('DELETE FROM ocorrencia_anexos WHERE ocorrencia_id = ?', [oc.id]);
    await this.banco.query('DELETE FROM ocorrencia_eventos WHERE ocorrencia_id = ?', [oc.id]);
    await this.banco.query('DELETE FROM ocorrencias WHERE id = ?', [oc.id]);
  }

  /** Download pedido pela ocorrência: entra sozinho quando fica pronto (ou registra a falha). */
  async aoDownload(job) {
    if (!job.ocorrenciaId || (job.status !== 'pronto' && job.status !== 'erro')) return;
    const marca = `${job.id}:${job.status}`;
    this.vistos = this.vistos || new Set();
    if (this.vistos.has(marca)) return;
    this.vistos.add(marca);
    if (this.vistos.size > 5000) this.vistos.clear();
    const oc = await this.banco.um('SELECT id, empresa_id FROM ocorrencias WHERE id = ?', [job.ocorrenciaId]);
    if (!oc) return;
    const cam = `câmera ${job.channel}${job.nomeCanal ? ` (${job.nomeCanal})` : ''}`;
    try {
      if (job.status === 'pronto') {
        const a = await this.anexarDownload(oc.id, job, null, job.nomeCanal ? `Câmera ${job.channel} (${job.nomeCanal})` : `Câmera ${job.channel}`);
        if (!a.repetido) await this.evento(oc.id, null, 'anexo', `Gravação da ${cam} anexada: ${job.start.slice(11)} a ${job.end.slice(11)}${job.note ? ` (${job.note})` : ''}`);
      } else {
        await this.evento(oc.id, null, 'falha', `Download da ${cam} não concluído: ${job.note || 'erro'}`);
      }
    } catch (e) {
      this.log('erro', `Ocorrência ${oc.id}: não anexou a gravação ${job.id} (${e.message})`);
      await this.evento(oc.id, null, 'falha', `Gravação da ${cam} não pôde ser anexada (${e.message})`).catch(() => {});
    }
    this.emit('mudou', oc.empresa_id, oc.id);
  }

  async espacoUsado() {
    let total = 0;
    const passar = async (d) => {
      for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const c = path.join(d, e.name);
        if (e.isDirectory()) await passar(c);
        else total += (await fs.promises.stat(c).catch(() => ({ size: 0 }))).size;
      }
    };
    await passar(this.pasta);
    return total;
  }
}

module.exports = { Ocorrencias, TIPOS, SITUACOES, nomeSeguro };
