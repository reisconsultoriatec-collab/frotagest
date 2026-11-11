'use strict';
/**
 * FrotaGest — a frota "ao vivo": junta o cadastro (veículo, aparelho, grupo) com o estado de conexão,
 * a última posição e os alertas ativos. É o que o mapa e a lista de veículos mostram.
 * Reis Tecnologia
 */
const { formatar, horaDoAparelho } = require('../util/comum');

const num = (v) => (v === null || v === undefined ? null : Number(v));

class Monitor {
  constructor({ frota, gateway, historico, cercas = null, motoristas = null }) {
    this.motoristas = motoristas;
    this.frota = frota;
    this.gateway = gateway;
    this.historico = historico;
    this.cercas = cercas;
  }

  posicaoDoEstado(e) {
    if (!e || e.latitude === null || e.latitude === undefined) return null;
    return {
      lat: num(e.latitude), lng: num(e.longitude), vel: num(e.velocidade) || 0, dir: num(e.direcao) || 0,
      hora: e.ultima_posicao_em, ign: e.ignicao === null ? null : !!e.ignicao, gps: e.gps_valido === null ? null : !!e.gps_valido,
      sat: num(e.satelites), sinal: num(e.sinal), odometro: num(e.odometro),
    };
  }

  /** Item de um aparelho cadastrado (com ou sem veículo). */
  doAparelho(ap) {
    const v = this.frota.veiculoDoAparelho.get(ap.id) || null;
    const dev = this.gateway.devices.get(ap.identificador);
    const e = this.historico.estados.get(ap.id);
    const emp = this.frota.empresas.get(ap.empresa_id);
    const perfil = this.frota.perfis.get(ap.perfil_id);
    return {
      chave: `a${ap.id}`,
      aparelhoId: ap.id,
      ident: ap.identificador,
      empresaId: ap.empresa_id,
      empresa: emp ? emp.nome : '',
      veiculoId: v ? v.id : null,
      placa: v ? v.placa : null,
      prefixo: v ? v.prefixo : null,
      descricao: v ? v.descricao : null,
      tipo: v ? v.tipo : null,
      grupoId: v ? v.grupo_id : null,
      grupo: v && v.grupo_id ? this.frota.caminhoGrupo(v.grupo_id) : null,
      modelo: [ap.fabricante, ap.modelo].filter(Boolean).join(' ') || null,
      canais: ap.canais,
      nomesCanais: ap.nomes_canais,
      perfil: perfil ? perfil.nome : null,
      online: Boolean(dev && dev.online),
      ultimoContato: dev && dev.lastSeen ? formatar(dev.lastSeen) : (e ? e.ultimo_contato : null),
      posicao: this.posicaoDoEstado(e),
      alertas: this.historico.ativos(ap.id),
      cercas: this.cercas ? this.cercas.dentro(ap.id) : [],
      motorista: v && this.motoristas ? this.motoristas.atual(v.id) : null,
      protocolo: dev && dev.online ? (dev.v2019 ? 'JT/T 808-2019' : 'JT/T 808-2013') : (e ? e.protocolo : null),
    };
  }

  /** Veículo cadastrado sem aparelho (aparece na lista, sem posição). */
  doVeiculoSemAparelho(v) {
    const emp = this.frota.empresas.get(v.empresa_id);
    return {
      chave: `v${v.id}`, aparelhoId: null, ident: null, empresaId: v.empresa_id, empresa: emp ? emp.nome : '',
      veiculoId: v.id, placa: v.placa, prefixo: v.prefixo, descricao: v.descricao, tipo: v.tipo, grupoId: v.grupo_id,
      grupo: v.grupo_id ? this.frota.caminhoGrupo(v.grupo_id) : null, modelo: null, canais: 0, nomesCanais: [],
      online: false, ultimoContato: null, posicao: null, alertas: [], cercas: [], semAparelho: true,
      motorista: this.motoristas ? this.motoristas.atual(v.id) : null,
    };
  }

  /** Aparelho conectado sem cadastro (só o master vê, para cadastrar). */
  doPendente(dev) {
    const p = dev.position;
    let posicao = null;
    if (p && (Math.abs(p.lat) > 0.0001 || Math.abs(p.lon) > 0.0001)) {
      posicao = {
        lat: p.lat, lng: p.lon, vel: p.speed, dir: p.direction, hora: horaDoAparelho(p.time, undefined, p.receivedAt).texto,
        ign: !!(p.flags && p.flags.ignicao), gps: !!(p.flags && p.flags.gpsFixado), sat: p.extras ? p.extras.satelites ?? null : null,
        sinal: p.extras ? p.extras.sinalRede ?? null : null, odometro: p.extras ? p.extras.odometroKm ?? null : null,
      };
    }
    const reg = dev.register || {};
    return {
      chave: `p${dev.id}`, pendente: true, aparelhoId: null, ident: dev.id, empresaId: null, empresa: '', veiculoId: null,
      placa: null, prefixo: null, descricao: null, tipo: null, grupoId: null, grupo: null,
      modelo: [reg.manufacturer, reg.model].filter(Boolean).join(' ') || null, canais: 4, nomesCanais: [],
      online: dev.online, ultimoContato: dev.lastSeen ? formatar(dev.lastSeen) : null, posicao, alertas: [], cercas: [],
      protocolo: dev.v2019 ? 'JT/T 808-2019' : 'JT/T 808-2013',
    };
  }

  /** Item de um veículo (com ou sem aparelho). */
  porVeiculo(veiculoId) {
    const v = this.frota.veiculos.get(veiculoId);
    if (!v || !v.ativo) return null;
    const ap = v.aparelho_id ? this.frota.aparelhos.get(v.aparelho_id) : null;
    return ap && ap.ativo ? this.doAparelho(ap) : this.doVeiculoSemAparelho(v);
  }

  /** Item pelo número do aparelho (eventos ao vivo). */
  porIdent(ident) {
    const ap = this.frota.porIdent.get(ident);
    if (ap) return ap.ativo ? this.doAparelho(ap) : null;
    const dev = this.gateway.devices.get(ident);
    return dev ? this.doPendente(dev) : null;
  }

  /** Toda a frota que o usuário pode ver. */
  lista(u, acesso) {
    const out = [];
    for (const ap of this.frota.aparelhos.values()) {
      if (!ap.ativo || !acesso.veAparelho(u, ap)) continue;
      const emp = this.frota.empresas.get(ap.empresa_id);
      if (!emp || !emp.ativo) continue;
      out.push(this.doAparelho(ap));
    }
    for (const v of this.frota.veiculos.values()) {
      if (!v.ativo || v.aparelho_id) continue;
      if (!acesso.veVeiculo(u, v)) continue;
      out.push(this.doVeiculoSemAparelho(v));
    }
    // veículo ativo ligado a aparelho desativado: aparece como "sem aparelho"
    for (const v of this.frota.veiculos.values()) {
      if (!v.ativo || !v.aparelho_id) continue;
      const ap = this.frota.aparelhos.get(v.aparelho_id);
      if (ap && ap.ativo) continue;
      if (acesso.veVeiculo(u, v)) out.push(this.doVeiculoSemAparelho(v));
    }
    if (u.perfil === 'master') {
      for (const dev of this.gateway.devices.values()) {
        if (!this.frota.porIdent.has(dev.id) && dev.online) out.push(this.doPendente(dev));
      }
    }
    return out;
  }
}

module.exports = { Monitor };
