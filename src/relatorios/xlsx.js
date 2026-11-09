'use strict';
/**
 * FrotaGest — gerador de planilha Excel (.xlsx) sem biblioteca externa.
 * Um .xlsx é um arquivo zip com alguns XML dentro; aqui montamos só o necessário:
 * uma ou mais abas, título, cabeçalho com filtro, painel congelado, tipos de célula
 * (texto, número, data/hora e duração) e uma linha de totais opcional.
 * Reis Tecnologia
 */
const zlib = require('zlib');

/* ---------------- zip ---------------- */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** arquivos: [{ nome, dados (Buffer|string) }] → Buffer do zip (deflate) */
function zip(arquivos) {
  const d = new Date();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const partes = [];
  const central = [];
  let pos = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const bruto = Buffer.isBuffer(a.dados) ? a.dados : Buffer.from(a.dados, 'utf8');
    const comp = zlib.deflateRawSync(bruto, { level: 6 });
    const crc = crc32(bruto);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    loc.writeUInt16LE(8, 8); // deflate
    loc.writeUInt16LE(hora, 10);
    loc.writeUInt16LE(data, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(bruto.length, 22);
    loc.writeUInt16LE(nome.length, 26);
    loc.writeUInt16LE(0, 28);
    partes.push(loc, nome, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(hora, 12);
    cen.writeUInt16LE(data, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(bruto.length, 24);
    cen.writeUInt16LE(nome.length, 28);
    cen.writeUInt32LE(pos, 42);
    central.push(cen, nome);
    pos += loc.length + nome.length + comp.length;
  }
  const tamCentral = central.reduce((t, b) => t + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12);
  fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, ...central, fim]);
}

/* ---------------- planilha ---------------- */

// eslint-disable-next-line no-control-regex
const xml = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 0 → A, 25 → Z, 26 → AA */
function coluna(n) {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 'AAAA-MM-DD hh:mm:ss' (horário de Brasília, como o banco guarda) → número de série do Excel */
function serialData(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(t || ''));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return (ms - Date.UTC(1899, 11, 30)) / 86400000;
}

// Estilos (índices de cellXfs)
const E = { titulo: 1, subtitulo: 2, cabecalho: 3, texto: 4, inteiro: 5, decimal: 6, dataHora: 7, duracao: 8, totalTexto: 9, totalInteiro: 10, totalDecimal: 11, totalDuracao: 12, data: 13 };
const ESTILO_TIPO = { texto: E.texto, inteiro: E.inteiro, decimal: E.decimal, dataHora: E.dataHora, data: E.data, duracao: E.duracao };
const ESTILO_TOTAL = { inteiro: E.totalInteiro, decimal: E.totalDecimal, duracao: E.totalDuracao };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/><numFmt numFmtId="165" formatCode="#,##0.0"/><numFmt numFmtId="166" formatCode="[h]:mm:ss"/><numFmt numFmtId="167" formatCode="#,##0"/><numFmt numFmtId="168" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="14"/><color rgb="FF1A2744"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="9"/><color rgb="FF5B6478"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1A2744"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FFF59E0B"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="167" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function celula(ref, valor, tipo, estilo) {
  if (valor === null || valor === undefined || valor === '') return `<c r="${ref}" s="${estilo}"/>`;
  if (tipo === 'dataHora' || tipo === 'data') {
    const s = serialData(valor);
    if (s !== null) return `<c r="${ref}" s="${estilo}"><v>${s}</v></c>`;
    tipo = 'texto';
  }
  if (tipo === 'duracao') {
    const n = Number(valor);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${estilo}"><v>${n / 86400}</v></c>`;
  }
  if (tipo === 'inteiro' || tipo === 'decimal') {
    const n = Number(valor);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${estilo}"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
}

/**
 * aba: { nome, titulo, subtitulo: [linhas], colunas: [{ titulo, tipo, largura }], linhas: [[valores]], totais: [valores] | null }
 * Duração: em segundos. Data/hora: texto do banco ('AAAA-MM-DD hh:mm:ss').
 */
function folha(aba) {
  const cols = aba.colunas;
  const ultima = coluna(Math.max(0, cols.length - 1));
  const linhasXml = [];
  let r = 1;
  linhasXml.push(`<row r="${r}" ht="22" customHeight="1">${celula(`A${r}`, aba.titulo, 'texto', E.titulo)}</row>`);
  for (const s of aba.subtitulo || []) {
    r++;
    linhasXml.push(`<row r="${r}">${celula(`A${r}`, s, 'texto', E.subtitulo)}</row>`);
  }
  r += 2;
  const cab = r;
  linhasXml.push(`<row r="${r}" ht="20" customHeight="1">${cols.map((c, i) => celula(`${coluna(i)}${r}`, c.titulo, 'texto', E.cabecalho)).join('')}</row>`);
  for (const lin of aba.linhas) {
    r++;
    linhasXml.push(`<row r="${r}">${cols.map((c, i) => celula(`${coluna(i)}${r}`, lin[i], c.tipo || 'texto', ESTILO_TIPO[c.tipo] || E.texto)).join('')}</row>`);
  }
  if (aba.totais) {
    r++;
    linhasXml.push(`<row r="${r}">${cols.map((c, i) => celula(`${coluna(i)}${r}`, aba.totais[i], aba.totais[i] === undefined || typeof aba.totais[i] === 'string' ? 'texto' : c.tipo, typeof aba.totais[i] === 'string' || aba.totais[i] == null ? E.totalTexto : (ESTILO_TOTAL[c.tipo] || E.totalTexto))).join('')}</row>`);
  }
  const larguras = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura || 14}" customWidth="1"/>`).join('');
  const fimDados = cab + aba.linhas.length;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${ultima}${Math.max(r, cab)}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${cab}" topLeftCell="A${cab + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${larguras}</cols>
<sheetData>${linhasXml.join('')}</sheetData>
${aba.linhas.length ? `<autoFilter ref="A${cab}:${ultima}${fimDados}"/>` : ''}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L&amp;8FrotaGest · Reis Tecnologia&amp;R&amp;8Página &amp;P de &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

const nomeAba = (n, i) => (String(n || `Aba ${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Aba ${i + 1}`);

/** abas: lista de abas (ver folha). Devolve o Buffer do .xlsx. */
function gerarXlsx(abas, { titulo = 'Relatório', autor = 'FrotaGest' } = {}) {
  const nomes = [];
  for (const [i, a] of abas.entries()) {
    let n = nomeAba(a.nome, i);
    let k = 2;
    while (nomes.includes(n)) n = `${nomeAba(a.nome, i).slice(0, 27)} (${k++})`;
    nomes.push(n);
  }
  const agoraIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const arquivos = [
    { nome: '[Content_Types].xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>` },
    { nome: '_rels/.rels', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>` },
    { nome: 'docProps/core.xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(titulo)}</dc:title><dc:creator>${xml(autor)}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${agoraIso}</dcterms:created></cp:coreProperties>` },
    { nome: 'docProps/app.xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FrotaGest · Reis Tecnologia</Application></Properties>` },
    { nome: 'xl/workbook.xml', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${nomes.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${abas.map((a, i) => (a.linhas.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(nomes[i]).replace(/'/g, "''")}'!$A$${(a.subtitulo || []).length + 3}:$${coluna(a.colunas.length - 1)}$${(a.subtitulo || []).length + 3 + a.linhas.length}</definedName>` : '')).join('')}</definedNames>
</workbook>` },
    { nome: 'xl/_rels/workbook.xml.rels', dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { nome: 'xl/styles.xml', dados: STYLES },
    ...abas.map((a, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: folha(a) })),
  ];
  return zip(arquivos);
}

module.exports = { gerarXlsx, zip, crc32, serialData };
