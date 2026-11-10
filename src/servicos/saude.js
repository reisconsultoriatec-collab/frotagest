'use strict';
/**
 * FrotaGest — saúde dos aparelhos: o que precisa de manutenção na frota. Junta a conexão, a última
 * posição e os alarmes ativos de cada DVR e aponta os problemas: offline, nunca conectou, câmera,
 * cartão de memória/HD, GPS, alimentação e sinal do chip.
 * Reis Tecnologia
 */
const { paraMs } = require('../util/comum');

// a frota dorme na garagem com o DVR desligado: só conta como problema depois de 1 dia sem comunicar
const OFFLINE_MEDIA_H = 24; // sem comunicar há mais de 1 dia: atenção
const OFFLINE_ALTA_H = 72; // há mais de 3 dias: problema sério
const SEM_POSICAO_MIN = 30; // online, mas sem mandar posição há mais de 30 min
const SINAL_FRACO = 10; // CSQ do chip (0 a 31): abaixo de 10 é fraco

// alarmes do DVR que indicam defeito de equipamento (a = alarme geral, v = alarme de vídeo)
const ALARMES = {
  v0: { tipo: 'camera', gravidade: 'media' }, // perda de sinal de vídeo
  v1: { tipo: 'camera', gravidade: 'baixa' }, // câmera obstruída
  a11: { tipo: 'camera', gravidade: 'media' }, // falha de câmera
  v2: { tipo: 'armazenamento', gravidade: 'alta' }, // falha no armazenamento (cartão/HD)
  v6: { tipo: 'armazenamento', gravidade: 'media' }, // gravação de alarme no limite do armazenamento
  v3: { tipo: 'video', gravidade: 'media' }, // outro equipamento de vídeo
  a4: { tipo: 'gps', gravidade: 'media' }, // falha no módulo GNSS
  a5: { tipo: 'gps', gravidade: 'media' }, // antena GNSS desconectada
  a6: { tipo: 'gps', gravidade: 'media' }, // antena GNSS em curto
  a7: { tipo: 'energia', gravidade: 'media' }, // tensão baixa
  a8: { tipo: 'energia', gravidade: 'alta' }, // alimentação cortada
  a9: { tipo: 'equipamento', gravidade: 'baixa' }, // display
  a10: { tipo: 'equipamento', gravidade: 'baixa' }, // voz
  a12: { tipo: 'equipamento', gravidade: 'baixa' }, // leitor de cartão do motorista
  a24: { tipo: 'equipamento', gravidade: 'baixa' }, // sensor de velocidade
};

const TIPOS = {
  offline: 'Offline', nunca: 'Nunca conectou', camera: 'Câmera', armazenamento: 'Cartão ou HD', video: 'Vídeo',
  gps: 'GPS', energia: 'Alimentação', sinal: 'Sinal do chip', posicao: 'Sem posição', equipamento: 'Equipamento',
};
const PESO = { alta: 3, media: 2, baixa: 1 };

function horasDesde(texto, agoraMs) {
  const ms = paraMs(texto);
  return Number.isFinite(ms) ? (agoraMs - ms) / 3600000 : null;
}

/** Problemas de um item da frota (o mesmo que o mapa usa) e do aparelho conectado no gateway. */
function avaliar(item, dev, agoraMs = Date.now()) {
  const problemas = [];
  const add = (tipo, gravidade, nome, detalhe = '', desde = null) => problemas.push({ tipo, gravidade, nome, detalhe, desde });
  if (!item.online) {
    if (!item.ultimoContato) add('nunca', 'media', 'Nunca conectou', 'Confira a configuração do servidor e o chip no DVR.');
    else {
      const h = horasDesde(item.ultimoContato, agoraMs);
      if (h !== null && h >= OFFLINE_MEDIA_H) {
        add('offline', h >= OFFLINE_ALTA_H ? 'alta' : 'media', 'Offline', h >= 48 ? `há ${Math.floor(h / 24)} dias` : `há ${Math.floor(h)} h`, item.ultimoContato);
      }
    }
  }
  for (const a of item.alertas || []) {
    const def = ALARMES[a.codigo];
    if (!def) continue;
    let detalhe = '';
    const ex = dev && dev.position && dev.position.extras;
    if (a.codigo === 'v0' && ex && Array.isArray(ex.canaisSemSinal) && ex.canaisSemSinal.length) detalhe = `canal ${ex.canaisSemSinal.join(', ')}`;
    if (a.codigo === 'v2' && ex && ex.falhaArmazenamento) detalhe = `código ${ex.falhaArmazenamento}`;
    add(def.tipo, def.gravidade, a.nome, detalhe, a.inicio);
  }
  if (item.online) {
    const p = item.posicao;
    if (!p) add('posicao', 'media', 'Sem posição', 'conectado, mas não mandou nenhuma posição');
    else {
      const min = (horasDesde(p.hora, agoraMs) || 0) * 60;
      // com a ignição desligada o DVR pode mandar posição bem de vez em quando: aí só depois de 6 h
      const ligado = p.ign !== false;
      if (min >= (ligado ? SEM_POSICAO_MIN : 360)) add('posicao', 'media', 'Sem posição recente', `última há ${min >= 120 ? `${Math.floor(min / 60)} h` : `${Math.floor(min)} min`}`, p.hora);
      // GPS sem sinal parado na garagem coberta é normal: só conta com a ignição ligada
      if (p.gps === false && ligado && !problemas.some((x) => x.tipo === 'gps')) add('gps', 'media', 'GPS sem sinal', p.sat !== null && p.sat !== undefined ? `${p.sat} satélite(s)` : '');
      if (p.sinal !== null && p.sinal !== undefined && p.sinal < SINAL_FRACO) add('sinal', 'baixa', 'Sinal do chip fraco', `nível ${p.sinal} de 31`);
    }
  }
  problemas.sort((x, y) => PESO[y.gravidade] - PESO[x.gravidade]);
  return problemas;
}

/** Lista da saúde de todos os aparelhos que o usuário pode ver. */
function saudeDaFrota(itens, gateway, agoraMs = Date.now()) {
  const aparelhos = itens.filter((i) => i.aparelhoId).map((i) => {
    const dev = gateway.devices.get(i.ident);
    const problemas = avaliar(i, dev, agoraMs);
    return {
      chave: i.chave, aparelhoId: i.aparelhoId, ident: i.ident, veiculoId: i.veiculoId, placa: i.placa, prefixo: i.prefixo,
      empresaId: i.empresaId, empresa: i.empresa, grupoId: i.grupoId, grupo: i.grupo, modelo: i.modelo, online: i.online,
      ultimoContato: i.ultimoContato, ultimaPosicao: i.posicao ? i.posicao.hora : null, gps: i.posicao ? i.posicao.gps : null,
      satelites: i.posicao ? i.posicao.sat : null, sinal: i.posicao ? i.posicao.sinal : null,
      problemas, gravidade: problemas.length ? problemas[0].gravidade : null,
    };
  });
  aparelhos.sort((a, b) => (PESO[b.gravidade] || 0) - (PESO[a.gravidade] || 0)
    || String(a.prefixo || a.placa || a.ident).localeCompare(String(b.prefixo || b.placa || b.ident), 'pt-BR', { numeric: true }));
  const tem = (a, tipos) => a.problemas.some((p) => tipos.includes(p.tipo));
  const resumo = {
    total: aparelhos.length,
    ok: aparelhos.filter((a) => !a.problemas.length).length,
    comProblema: aparelhos.filter((a) => a.problemas.length).length,
    offline: aparelhos.filter((a) => tem(a, ['offline', 'nunca'])).length,
    camera: aparelhos.filter((a) => tem(a, ['camera', 'video'])).length,
    armazenamento: aparelhos.filter((a) => tem(a, ['armazenamento'])).length,
    gps: aparelhos.filter((a) => tem(a, ['gps', 'posicao'])).length,
    energiaSinal: aparelhos.filter((a) => tem(a, ['energia', 'sinal', 'equipamento'])).length,
  };
  return { resumo, aparelhos, limites: { offlineMediaH: OFFLINE_MEDIA_H, offlineAltaH: OFFLINE_ALTA_H, semPosicaoMin: SEM_POSICAO_MIN, sinalFraco: SINAL_FRACO } };
}

module.exports = { avaliar, saudeDaFrota, TIPOS, ALARMES };
