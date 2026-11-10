'use strict';
/* FrotaGest — logotipo da empresa cliente: envio no cadastro da empresa (master), no topo do painel,
 * no modo TV e nos PDFs (o servidor coloca). Reis Tecnologia */

const LOGO_MAX_L = 600;
const LOGO_MAX_A = 240;
const logos = new Map(); // empresa_id → { png } | null

async function logoDaEmpresa(id, forcar = false) {
  if (!id) return null;
  if (!forcar && logos.has(id)) return logos.get(id);
  try {
    const r = await api(`/api/empresas/${id}/logo`);
    const v = r.png ? r : null;
    logos.set(id, v);
    return v;
  } catch { return null; }
}

/** Empresa cujo logotipo aparece: a do usuário; para o master, a escolhida no topo. */
const empresaDoLogo = () => (S.eu ? (S.eu.perfil === 'master' ? Number(S.empresa) || null : S.eu.empresaId) : null);

async function atualizarLogoTopo() {
  const el = $('#tb-logo');
  if (!el) return;
  const id = empresaDoLogo();
  const l = id ? await logoDaEmpresa(id) : null;
  if (id !== empresaDoLogo()) return; // trocou de empresa no meio
  el.hidden = !l;
  if (l) {
    el.querySelector('img').src = l.png;
    el.title = (S.empresas.find((e) => e.id === id) || {}).nome || S.eu.empresaNome || '';
  }
}

/** Arquivo escolhido → PNG (tela) e JPEG com fundo branco (PDF), reduzidos e sem bordas vazias. */
async function prepararLogo(arquivo) {
  if (!/^image\/(png|jpeg|webp)$/.test(arquivo.type)) throw new Error('Use uma imagem PNG, JPG ou WebP.');
  if (arquivo.size > 8 * 1024 * 1024) throw new Error('Imagem grande demais (até 8 MB).');
  const url = URL.createObjectURL(arquivo);
  try {
    const img = await new Promise((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => erro(new Error('Não foi possível abrir a imagem.'));
      i.src = url;
    });
    // corta as bordas totalmente transparentes (muito logotipo vem com sobra em volta)
    const c0 = document.createElement('canvas');
    c0.width = img.naturalWidth;
    c0.height = img.naturalHeight;
    const g0 = c0.getContext('2d');
    g0.drawImage(img, 0, 0);
    let x0 = 0; let y0 = 0; let x1 = c0.width - 1; let y1 = c0.height - 1;
    try {
      const d = g0.getImageData(0, 0, c0.width, c0.height).data;
      const opaco = (x, y) => d[(y * c0.width + x) * 4 + 3] > 8;
      const linhaVazia = (y) => { for (let x = 0; x < c0.width; x++) if (opaco(x, y)) return false; return true; };
      const colunaVazia = (x) => { for (let y = y0; y <= y1; y++) if (opaco(x, y)) return false; return true; };
      while (y0 < y1 && linhaVazia(y0)) y0++;
      while (y1 > y0 && linhaVazia(y1)) y1--;
      while (x0 < x1 && colunaVazia(x0)) x0++;
      while (x1 > x0 && colunaVazia(x1)) x1--;
    } catch { /* segue sem cortar */ }
    const w0 = x1 - x0 + 1;
    const h0 = y1 - y0 + 1;
    const esc = Math.min(1, LOGO_MAX_L / w0, LOGO_MAX_A / h0);
    const w = Math.max(1, Math.round(w0 * esc));
    const h = Math.max(1, Math.round(h0 * esc));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c0, x0, y0, w0, h0, 0, 0, w, h);
    const png = c.toDataURL('image/png');
    const cj = document.createElement('canvas');
    cj.width = w;
    cj.height = h;
    const gj = cj.getContext('2d');
    gj.fillStyle = '#fff';
    gj.fillRect(0, 0, w, h);
    gj.drawImage(c, 0, 0);
    const jpg = cj.toDataURL('image/jpeg', 0.92);
    if (w < 16 || h < 8) throw new Error('Imagem pequena demais para um logotipo.');
    return { png, jpg, largura: w, altura: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Bloco do logotipo no formulário da empresa (master). */
function blocoLogoEmpresa(e) {
  if (!e) return '<div class="logo-emp"><div class="logo-emp-txt"><b>Logotipo</b><small>Salve a empresa primeiro; depois abra de novo para enviar o logotipo.</small></div></div>';
  return `<div class="logo-emp" id="logo-emp">
    <div class="logo-emp-prev" id="logo-prev"><span class="muted small">Sem logotipo</span></div>
    <div class="logo-emp-txt"><b>Logotipo da empresa</b><small>Aparece no topo do painel de quem é desta empresa, no modo TV e nos PDFs. PNG com fundo transparente fica melhor.</small>
      <div class="logo-emp-acoes">
        <label class="btn btn-sm">${ico('upload', 'i-sm')} Escolher imagem<input type="file" id="logo-arq" accept="image/png,image/jpeg,image/webp" hidden></label>
        <button class="btn btn-sm btn-ghost" type="button" id="logo-tirar" hidden>${ico('trash', 'i-sm')} Remover</button>
      </div><p class="form-erro" id="logo-erro" hidden style="margin:8px 0 0"></p></div>
  </div>`;
}

/** aoMudar: atualiza a lista de empresas (coluna Logotipo) mesmo que o formulário seja fechado sem salvar. */
async function ligarLogoEmpresa(raiz, e, aoMudar = null) {
  if (!e) return;
  const prev = raiz.querySelector('#logo-prev');
  const tirar = raiz.querySelector('#logo-tirar');
  const erro = raiz.querySelector('#logo-erro');
  const mostrar = (png) => {
    prev.innerHTML = png ? `<img src="${png}" alt="Logotipo de ${H(e.nome)}">` : '<span class="muted small">Sem logotipo</span>';
    tirar.hidden = !png;
  };
  const atual = await logoDaEmpresa(e.id, true);
  mostrar(atual && atual.png);
  raiz.querySelector('#logo-arq').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    erro.hidden = true;
    try {
      const l = await prepararLogo(f);
      prev.innerHTML = '<span class="spinner spinner-sm"></span>';
      await api(`/api/empresas/${e.id}/logo`, { metodo: 'PUT', corpo: { png: l.png, jpg: l.jpg } });
      logos.set(e.id, { png: l.png });
      mostrar(l.png);
      toast('Logotipo salvo.', 'ok');
      atualizarLogoTopo();
      if (aoMudar) aoMudar();
    } catch (err) {
      mostrar((logos.get(e.id) || {}).png);
      erro.textContent = err.message;
      erro.hidden = false;
    }
  });
  tirar.addEventListener('click', async () => {
    if (!await confirmar(`Remover o logotipo de ${e.nome}?`, { titulo: 'Remover logotipo', ok: 'Remover', perigo: true })) return;
    try {
      await api(`/api/empresas/${e.id}/logo`, { metodo: 'DELETE' });
      logos.set(e.id, null);
      mostrar(null);
      atualizarLogoTopo();
      if (aoMudar) aoMudar();
    } catch (err) { toast(err.message, 'err'); }
  });
}
