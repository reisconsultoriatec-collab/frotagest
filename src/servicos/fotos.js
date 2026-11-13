'use strict';
/**
 * FrotaGest — fotos tiradas pelas câmeras do DVR (pedido "Foto agora" no painel, ou o próprio aparelho
 * mandando por um alarme). O arquivo JPEG fica em disco (pasta data/fotos, por mês); no banco só o
 * registro (veículo, canal, hora, posição, quem pediu). Apagadas depois de N dias (Sistema › Configurações).
 * Reis Tecnologia
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { formatar, horaDoAparelho, agora } = require('../util/comum');

const MAX_BYTES = 8 * 1024 * 1024;
const PEDIDO_MS = 3 * 60000; // foto que chega até 3 min depois do pedido é "de quem pediu"

class Fotos extends EventEmitter {
  constructor({ banco, frota, config, dados, log = () => {} }) {
    super();
    this.banco = banco;
    this.frota = frota;
    this.config = config;
    this.pasta = path.join(dados, 'fotos');
    this.log = log;
    this.pedidos = new Map(); // `${ident}:${canal}` → { usuarioId, em }
    fs.mkdirSync(this.pasta, { recursive: true });
  }

  iniciar() {
    const limpar = () => this.limpar().catch((e) => this.log('erro', `Fotos: limpeza falhou (${e.message})`));
    setTimeout(limpar, 60000).unref?.();
    this.timer = setInterval(limpar, 6 * 3600000);
    this.timer.unref?.();
  }

  /** O painel pediu foto deste canal: a próxima que chegar é de quem pediu. */
  pedido(ident, canal, usuarioId) {
    this.pedidos.set(`${ident}:${canal}`, { usuarioId, em: Date.now() });
    if (this.pedidos.size > 2000) this.pedidos.delete(this.pedidos.keys().next().value);
  }

  /** Mídia que chegou do aparelho (evento 'midia' do gateway). Só fotos JPEG de aparelho cadastrado. */
  async salvar(md) {
    if (md.type !== 0) return null;
    const dados = md.data;
    if (!dados || dados.length < 100 || dados.length > MAX_BYTES || dados[0] !== 0xff || dados[1] !== 0xd8) {
      this.log('aviso', `Foto do aparelho ${md.id} descartada (não é um JPEG válido)`);
      return null;
    }
    const ap = this.frota.porIdent.get(md.id);
    if (!ap || !ap.ativo) return null;
    const info = this.frota.info(md.id);
    const veiculo = this.frota.veiculoDoAparelho.get(ap.id) || null;
    const p = md.position;
    const hora = p ? horaDoAparelho(p.time, info && info.perfil ? info.perfil.fuso_minutos : undefined, md.recebidoEm).texto : formatar(md.recebidoEm);
    const gps = p && p.flags && p.flags.gpsFixado && (Math.abs(p.lat) > 0.0001 || Math.abs(p.lon) > 0.0001);
    const chave = `${md.id}:${md.channel}`;
    const ped = this.pedidos.get(chave);
    const usuarioId = ped && Date.now() - ped.em < PEDIDO_MS ? ped.usuarioId : null;
    if (usuarioId) this.pedidos.delete(chave);
    const mes = hora.slice(0, 7);
    const nome = `${ap.id}-${hora.replace(/[-: ]/g, '')}-c${md.channel}-${md.mediaId}.jpg`;
    const rel = path.join(mes, nome);
    await fs.promises.mkdir(path.join(this.pasta, mes), { recursive: true });
    await fs.promises.writeFile(path.join(this.pasta, rel), dados, { mode: 0o640 });
    const r = await this.banco.query(
      `INSERT INTO fotos (empresa_id, aparelho_id, veiculo_id, canal, midia_id, evento, data_hora, latitude, longitude, velocidade, arquivo, bytes, usuario_id, criado_em)
       VALUES (?)`,
      [[ap.empresa_id, ap.id, veiculo ? veiculo.id : null, md.channel, md.mediaId >>> 0, md.event, hora,
        gps ? Math.round(p.lat * 1e6) / 1e6 : null, gps ? Math.round(p.lon * 1e6) / 1e6 : null, p ? Math.min(9999.9, p.speed) : null,
        rel, dados.length, usuarioId, agora()]],
    );
    const foto = {
      id: r.insertId, ident: md.id, empresaId: ap.empresa_id, aparelhoId: ap.id, veiculoId: veiculo ? veiculo.id : null, canal: md.channel,
      dataHora: hora, latitude: gps ? p.lat : null, longitude: gps ? p.lon : null, velocidade: p ? p.speed : null, bytes: dados.length,
      pedida: Boolean(usuarioId), usuarioId,
    };
    this.emit('foto', foto);
    return foto;
  }

  async arquivo(foto) {
    return fs.promises.readFile(await this.caminho(foto));
  }

  /** Caminho do JPEG no disco (para anexar numa ocorrência). */
  async caminho(foto) {
    const alvo = path.resolve(this.pasta, foto.arquivo);
    if (!alvo.startsWith(path.resolve(this.pasta) + path.sep)) throw new Error('caminho inválido');
    await fs.promises.access(alvo);
    return alvo;
  }

  async limpar() {
    const dias = this.config.numero('retencao_fotos_dias');
    const limite = formatar(Date.now() - dias * 86400000);
    let total = 0;
    for (;;) {
      const rows = await this.banco.query('SELECT id, arquivo FROM fotos WHERE data_hora < ? ORDER BY id LIMIT 500', [limite]);
      if (!rows.length) break;
      for (const f of rows) await fs.promises.rm(path.join(this.pasta, f.arquivo), { force: true }).catch(() => {});
      await this.banco.query('DELETE FROM fotos WHERE id IN (?)', [rows.map((x) => x.id)]);
      total += rows.length;
      if (rows.length < 500) break;
    }
    // pastas de meses que ficaram vazias
    for (const d of await fs.promises.readdir(this.pasta).catch(() => [])) {
      const cheia = path.join(this.pasta, d);
      if ((await fs.promises.readdir(cheia).catch(() => ['x'])).length === 0) await fs.promises.rmdir(cheia).catch(() => {});
    }
    if (total) this.log('info', `Fotos: ${total} foto(s) com mais de ${dias} dias apagada(s)`);
    return total;
  }
}

module.exports = { Fotos };
