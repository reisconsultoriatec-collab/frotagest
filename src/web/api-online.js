'use strict';
/**
 * FrotaGest — usuários online: quem está com o painel aberto agora, desde quando, em qual tela e de
 * qual aparelho; o master (e o administrador, na própria empresa) pode encerrar uma sessão.
 * Encerrar vale só para aquele login (aparelho/navegador): as outras sessões da pessoa continuam.
 * Reis Tecnologia
 */
const { HttpErro, validar: V, formatar } = require('../util/comum');
const { empresaAlvo } = require('../auth/acesso');

const TELAS = {
  inicio: 'Início', mapa: 'Monitoramento', alertas: 'Alertas', historico: 'Histórico', relatorios: 'Relatórios', gravacoes: 'Gravações',
  empresas: 'Empresas', aparelhos: 'Aparelhos', grupos: 'Grupos', veiculos: 'Veículos', cercas: 'Cercas', usuarios: 'Usuários',
  saude: 'Saúde dos aparelhos', comunicacoes: 'Comunicações', auditoria: 'Auditoria', sistema: 'Sistema', online: 'Usuários online', tv: 'Modo TV',
};

/** "Chrome · Windows", "Safari · iPhone"... */
function navegador(ua) {
  const s = String(ua || '');
  let nav = 'Navegador';
  if (/Edg\//.test(s)) nav = 'Edge';
  else if (/OPR\/|Opera/.test(s)) nav = 'Opera';
  else if (/SamsungBrowser/.test(s)) nav = 'Samsung Internet';
  else if (/Firefox\//.test(s)) nav = 'Firefox';
  else if (/Chrome\/|CriOS/.test(s)) nav = 'Chrome';
  else if (/Safari\//.test(s)) nav = 'Safari';
  let so = '';
  if (/iPhone/.test(s)) so = 'iPhone';
  else if (/iPad/.test(s)) so = 'iPad';
  else if (/Android/.test(s)) so = 'Android';
  else if (/Windows/.test(s)) so = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) so = 'Mac';
  else if (/CrOS/.test(s)) so = 'Chromebook';
  else if (/Linux/.test(s)) so = 'Linux';
  return { texto: so ? `${nav} · ${so}` : nav, celular: /Mobile|iPhone|Android/.test(s) };
}

function registrar(srv) {
  const { acesso, auditoria, frota } = srv;

  /** Conexões que o usuário pode ver: master todas (ou da empresa escolhida); admin as da própria empresa. */
  function visiveis(u, empresa) {
    const out = [];
    for (const c of srv.eventos) {
      if (!c.sessao || !c.u) continue;
      if (u.perfil !== 'master') {
        if (c.u.perfil === 'master' || c.u.empresaId !== u.empresaId) continue;
      } else if (empresa && c.u.empresaId !== empresa) continue;
      out.push(c);
    }
    return out;
  }

  srv.rota('GET', '/api/online', async ({ u, query, claims }) => {
    const emp = empresaAlvo(u, query.empresa ? V.id(query.empresa, 'a empresa') : null);
    const agora = Date.now();
    // um login (aparelho/navegador) pode ter várias abas abertas: aparecem juntas
    const porLogin = new Map();
    for (const c of visiveis(u, emp)) {
      const s = c.sessao;
      const k = `${s.uid}:${s.authTime}`;
      let x = porLogin.get(k);
      if (!x) {
        const nav = navegador(s.ua);
        const e = c.u.empresaId ? frota.empresas.get(c.u.empresaId) : null;
        x = {
          conexao: s.id, usuarioId: c.u.id, nome: c.u.nome, email: c.u.email, perfil: c.u.perfil, perfilNome: c.u.perfilNome,
          empresa: e ? e.nome : (c.u.perfil === 'master' ? 'Reis Tecnologia' : ''), empresaId: c.u.empresaId,
          entrouEm: s.authTime ? formatar(s.authTime * 1000) : null, conectadoDesde: s.desde, ativoEm: s.ativoEm,
          ip: s.ip, navegador: nav.texto, celular: nav.celular, abas: [], tv: false,
          voce: Boolean(claims && s.uid === claims.uid && s.authTime === claims.authTime),
        };
        porLogin.set(k, x);
      }
      x.conectadoDesde = Math.min(x.conectadoDesde, s.desde);
      x.ativoEm = Math.max(x.ativoEm, s.ativoEm);
      x.tv = x.tv || s.tv;
      x.abas.push(TELAS[s.tela] || (s.tela ? s.tela : 'Abrindo…'));
    }
    const sessoes = [...porLogin.values()].map((x) => ({
      ...x,
      conectadoDesde: formatar(x.conectadoDesde),
      ultimoUso: formatar(x.ativoEm),
      ociosoSeg: Math.max(0, Math.round((agora - x.ativoEm) / 1000)),
    }));
    sessoes.sort((a, b) => (b.voce - a.voce) || a.nome.localeCompare(b.nome, 'pt-BR'));
    return {
      sessoes,
      resumo: {
        usuarios: new Set(sessoes.map((s) => s.usuarioId)).size,
        sessoes: sessoes.length,
        tv: sessoes.filter((s) => s.tv).length,
        ativos: sessoes.filter((s) => s.ociosoSeg < 600).length,
      },
    };
  }, { pode: 'cadastros' });

  srv.rota('POST', '/api/online/encerrar', async ({ u, body, claims, ip }) => {
    const id = typeof body.conexao === 'string' ? body.conexao : '';
    const c = [...srv.eventos].find((x) => x.sessao && x.sessao.id === id);
    if (!c) throw new HttpErro(404, 'Essa sessão já não está mais conectada.');
    if (!visiveis(u, null).includes(c)) throw new HttpErro(404, 'Essa sessão já não está mais conectada.');
    const s = c.sessao;
    if (s.uid === claims.uid && s.authTime === claims.authTime) throw new HttpErro(400, 'Esta é a sua própria sessão: para sair, use o botão Sair.');
    if (!s.authTime) throw new HttpErro(409, 'Não foi possível identificar o login dessa sessão.');
    await acesso.encerrarSessao(s.uid, s.authTime, c.u.id, u.id);
    acesso.invalidar();
    const n = srv.derrubarSessao(s.uid, s.authTime);
    const nav = navegador(s.ua);
    await auditoria.registrar(u, 'encerrar_sessao', {
      entidade: 'usuario', entidadeId: c.u.id, ip, empresaId: c.u.empresaId,
      descricao: `Encerrou a sessão de ${c.u.nome} <${c.u.email}> (${nav.texto}, IP ${s.ip}${n > 1 ? `, ${n} abas` : ''})`,
    });
    return { ok: true, abas: n };
  }, { pode: 'cadastros', limite: { chave: 'encerrar', max: 30, minutos: 10 } });
}

module.exports = { registrar, navegador };
