'use strict';
/**
 * FrotaGest — controle de acesso por usuário: em quais menus cada pessoa entra e, em cada um,
 * se pode incluir, alterar ou excluir (ou só ver).
 *
 *  - O perfil continua decidindo O QUE a pessoa enxerga (empresa e grupos).
 *  - Esta matriz decide ONDE ela entra e o que pode fazer lá.
 *  - Sem personalização vale o padrão do perfil (ninguém perdeu acesso com a mudança).
 *  - O master tem acesso total e é o único que libera o menu "Controle de acesso".
 *  - Empresas e Sistema continuam só do master (não entram na matriz).
 * Reis Tecnologia
 */

const ACOES = ['ver', 'incluir', 'alterar', 'excluir'];

/** Telas na ordem do menu. acoes: só as que existem naquela tela, com o que cada uma libera. */
const TELAS = [
  // o Dashboard fica à parte dos grupos: é a primeira tela de quem tem acesso a ele
  { id: 'dashboard', grupo: 'Dashboard', nome: 'Dashboard', acoes: { ver: 'Tela inicial com a frota ao vivo, km do dia, gráficos e alertas' } },
  { id: 'aparelhos', grupo: 'Cadastros', nome: 'Aparelhos (DVR)', acoes: {
    ver: 'Ver os aparelhos da empresa e a situação de cada um (o cadastro é feito pelo master)' } },
  { id: 'grupos', grupo: 'Cadastros', nome: 'Grupos', acoes: {
    ver: 'Ver os grupos da frota', incluir: 'Criar grupos e subgrupos', alterar: 'Renomear e mudar o grupo de lugar', excluir: 'Excluir grupos vazios' } },
  { id: 'veiculos', grupo: 'Cadastros', nome: 'Veículos', acoes: {
    ver: 'Ver a frota cadastrada', incluir: 'Cadastrar veículos', alterar: 'Editar, trocar grupo ou aparelho e desativar' } },
  { id: 'cercas', grupo: 'Cadastros', nome: 'Cercas', acoes: {
    ver: 'Ver as cercas cadastradas', incluir: 'Desenhar cercas novas', alterar: 'Editar e desativar cercas', excluir: 'Excluir cercas' } },
  { id: 'regras', grupo: 'Cadastros', nome: 'Regras de alerta', acoes: {
    ver: 'Ver as regras de alerta (velocidade, horário, parada, motor ligado)', incluir: 'Criar regras de alerta', alterar: 'Mudar, ligar e desligar regras', excluir: 'Excluir regras' } },
  { id: 'usuarios', grupo: 'Cadastros', nome: 'Usuários', acoes: {
    ver: 'Ver os usuários e os cadastros aguardando aprovação', incluir: 'Convidar por e-mail e aprovar cadastros', alterar: 'Editar perfil e grupos, desativar, reenviar convite e gerar código novo', excluir: 'Recusar cadastros' } },
  { id: 'mapa', grupo: 'Operação', nome: 'Monitoramento', acoes: { ver: 'Mapa com a frota ao vivo' } },
  { id: 'cameras', grupo: 'Operação', nome: 'Câmeras ao vivo', acoes: { ver: 'Abrir o vídeo ao vivo dos veículos' } },
  { id: 'comandos', grupo: 'Operação', nome: 'Comandos ao veículo', acoes: {
    ver: 'Ver as fotos tiradas e os comandos enviados (no veículo, pelo Monitoramento)', incluir: 'Mandar mensagem ao motorista e tirar foto na hora',
    alterar: 'Reiniciar o aparelho e mudar os intervalos de posição e o limite de velocidade do aparelho' } },
  { id: 'alertas', grupo: 'Operação', nome: 'Alertas', acoes: { ver: 'Ver os alertas e receber o aviso de alerta novo', alterar: 'Tratar alertas (em tratamento / tratado)' } },
  { id: 'historico', grupo: 'Operação', nome: 'Histórico', acoes: { ver: 'Ver o trajeto percorrido pelos veículos' } },
  { id: 'relatorios', grupo: 'Operação', nome: 'Relatórios', acoes: { ver: 'Gerar relatórios na tela, em Excel e em PDF' } },
  { id: 'gravacoes', grupo: 'Operação', nome: 'Gravações', acoes: { ver: 'Buscar e assistir as gravações do DVR', incluir: 'Baixar trechos das gravações (MP4)' } },
  { id: 'tv', grupo: 'Operação', nome: 'Modo TV', acoes: { ver: 'Tela cheia para a central de monitoramento' } },
  { id: 'saude', grupo: 'Controle', nome: 'Saúde dos aparelhos', acoes: { ver: 'Aparelhos com problema de câmera, cartão, GPS ou sinal' } },
  { id: 'comunicacoes', grupo: 'Controle', nome: 'Comunicações', acoes: { ver: 'Conexões dos aparelhos e comandos enviados' } },
  { id: 'online', grupo: 'Controle', nome: 'Usuários online', acoes: { ver: 'Quem está usando o painel agora', alterar: 'Encerrar a sessão de um usuário' } },
  { id: 'auditoria', grupo: 'Controle', nome: 'Auditoria', acoes: { ver: 'Histórico de tudo o que foi feito no painel' } },
  { id: 'acesso', grupo: 'Controle', nome: 'Controle de acesso', soMaster: true, acoes: {
    ver: 'Ver o que cada usuário pode fazer', alterar: 'Mudar o acesso dos usuários da empresa' } },
];

const POR_ID = new Map(TELAS.map((t) => [t.id, t]));

const tudo = (filtro = () => true) => Object.fromEntries(TELAS.filter(filtro).map((t) => [t.id, Object.keys(t.acoes)]));

/** Padrão de cada perfil = o que ele já tinha antes do controle de acesso. */
const PADRAO = {
  admin: tudo((t) => !t.soMaster),
  operador: { dashboard: ['ver'], mapa: ['ver'], cameras: ['ver'], comandos: ['ver', 'incluir'], alertas: ['ver', 'alterar'], historico: ['ver'], relatorios: ['ver'], gravacoes: ['ver', 'incluir'], tv: ['ver'] },
  visualizador: { dashboard: ['ver'], mapa: ['ver'], cameras: ['ver'], comandos: ['ver'], alertas: ['ver'], historico: ['ver'], relatorios: ['ver'], tv: ['ver'] },
};

/** Ações válidas de uma tela, na ordem, com "ver" sempre junto (sem ver não há como fazer o resto). */
function acoesValidas(telaId, lista) {
  const t = POR_ID.get(telaId);
  if (!t || !Array.isArray(lista)) return [];
  const pedidas = new Set(lista.map(String));
  const ok = Object.keys(t.acoes).filter((a) => pedidas.has(a));
  if (ok.length && !ok.includes('ver')) ok.unshift('ver');
  return ok;
}

/** Texto do banco (ou objeto) → { tela: [acoes] } só com as telas conhecidas. */
function ler(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  let o = valor;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = {};
  for (const t of TELAS) if (Object.prototype.hasOwnProperty.call(o, t.id)) r[t.id] = acoesValidas(t.id, o[t.id]);
  return r;
}

/** Matriz completa (todas as telas, vazias quando sem acesso): padrão do perfil + o que foi personalizado. */
function efetivo(perfil, armazenado) {
  if (perfil === 'master') return tudo();
  const base = PADRAO[perfil] || {};
  const pers = ler(armazenado) || {};
  const r = {};
  for (const t of TELAS) {
    const v = Object.prototype.hasOwnProperty.call(pers, t.id) ? pers[t.id] : (base[t.id] || []);
    r[t.id] = [...v];
  }
  return r;
}

function padraoCompleto(perfil) {
  return efetivo(perfil, null);
}

function permite(acessos, tela, acao = 'ver') {
  return Boolean(acessos && acessos[tela] && acessos[tela].includes(acao));
}

function iguais(a, b) {
  for (const t of TELAS) {
    const x = (a && a[t.id]) || [];
    const y = (b && b[t.id]) || [];
    if (x.length !== y.length || x.some((v) => !y.includes(v))) return false;
  }
  return true;
}

/** Só as telas diferentes do padrão do perfil (é o que vai para o banco); null = tudo no padrão. */
function diferencas(perfil, matriz) {
  const p = padraoCompleto(perfil);
  const r = {};
  for (const t of TELAS) {
    const x = matriz[t.id] || [];
    const y = p[t.id] || [];
    if (x.length !== y.length || x.some((v) => !y.includes(v))) r[t.id] = x;
  }
  return Object.keys(r).length ? r : null;
}

/** As capacidades antigas (usadas pelo vídeo, gravações e telas) saem da matriz. */
function capacidades(perfil, acessos) {
  return {
    video: permite(acessos, 'cameras'),
    gravacoes: permite(acessos, 'gravacoes'),
    baixarGravacoes: permite(acessos, 'gravacoes', 'incluir'),
    tratarAlertas: permite(acessos, 'alertas', 'alterar'),
    cadastros: ['aparelhos', 'grupos', 'veiculos', 'cercas', 'regras', 'usuarios'].some((t) => permite(acessos, t)),
    auditoria: permite(acessos, 'auditoria'),
    sistema: perfil === 'master',
  };
}

/** Catálogo para a tela de controle de acesso. */
function catalogo() {
  return TELAS.map((t) => ({ id: t.id, grupo: t.grupo, nome: t.nome, soMaster: Boolean(t.soMaster), acoes: t.acoes }));
}

module.exports = { ACOES, TELAS, PADRAO, ler, efetivo, padraoCompleto, permite, iguais, diferencas, capacidades, catalogo, acoesValidas };
