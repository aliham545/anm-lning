// Minimal .xlsx-skrivare utan externa beroenden. Bygger en riktig Excel-fil
// (OOXML i ett ZIP-paket) direkt i webbläsaren.
//
//   const bytes = await buildXlsx([
//     { name: "Deltagare",
//       columns: [{ header: "Namn", width: 28 }, { header: "Antal", width: 10, type: "number" }],
//       rows: [["Mila", 3], ["Nils", { v: "Ska hämtas", warn: true }]] }
//   ], { title: "Deltagare", creator: "Allaktivitetshuset" });
//
// Kolumn:  { header, width?, type?: "text"|"number"|"date", wrap?: boolean }
// Cell:    string | number | Date | null | { v, warn: true }   (warn = orange markering)

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const encoder = new TextEncoder();

// Stilar (index i cellXfs i styles.xml)
const S = { DEFAULT: 0, HEADER: 1, TEXT: 2, WRAP: 3, NUMBER: 4, DATE: 5, WARN: 6 };

/* ---------- Hjälpfunktioner ---------- */

function xmlEscape(value){
  return String(value)
    // tecken som inte är tillåtna i XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(index){
  let n = index + 1, s = "";
  while(n > 0){
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel-datum (antal dagar sedan 1899-12-30), baserat på lokal kalenderdag.
function dateSerial(d){
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 25569;
}

// Bladnamn: max 31 tecken, inga []:*?/\ , unika (oavsett versaler).
function uniqueSheetNames(sheets){
  const used = new Set();
  return sheets.map((sheet, i) => {
    let base = String(sheet.name || "Blad " + (i + 1))
      .replace(/[\[\]:*?\/\\]/g, " ")
      .replace(/^'+|'+$/g, "")
      .trim()
      .slice(0, 31) || "Blad " + (i + 1);
    let name = base, n = 2;
    while(used.has(name.toLowerCase())){
      const suffix = " (" + n++ + ")";
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/* ---------- Kalkylblad ---------- */

function cellXml(value, col, ref){
  const emptyStyle = col.type === "number" ? S.NUMBER : col.type === "date" ? S.DATE : (col.wrap ? S.WRAP : S.TEXT);
  let warn = false;
  if(value && typeof value === "object" && !(value instanceof Date)){
    warn = !!value.warn;
    value = value.v;
  }
  if(value === null || value === undefined || value === "") return `<c r="${ref}" s="${emptyStyle}"/>`;
  if(value instanceof Date){
    return isNaN(value.getTime())
      ? `<c r="${ref}" s="${S.DATE}"/>`
      : `<c r="${ref}" s="${S.DATE}"><v>${dateSerial(value)}</v></c>`;
  }
  if(typeof value === "number"){
    return isFinite(value) ? `<c r="${ref}" s="${S.NUMBER}"><v>${value}</v></c>` : `<c r="${ref}" s="${S.NUMBER}"/>`;
  }
  let text = typeof value === "boolean" ? (value ? "Ja" : "Nej") : String(value);
  if(text.length > 32767) text = text.slice(0, 32767); // Excels gräns per cell
  const style = warn ? S.WARN : (col.wrap ? S.WRAP : S.TEXT);
  // inlineStr => allt lagras som text, aldrig som formel (=, +, -, @ är ofarliga)
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet, selected){
  const cols = sheet.columns;
  const rows = sheet.rows || [];
  const lastCol = colName(cols.length - 1);
  const lastRow = rows.length + 1;

  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
  x += `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`;
  x += `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`;
  x += `<dimension ref="A1:${lastCol}${lastRow}"/>`;
  x += `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}>`
     + `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
     + `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`;
  x += `<sheetFormatPr defaultRowHeight="15"/>`;
  x += `<cols>` + cols.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(255, Math.max(4, c.width || 14))}" customWidth="1"/>`).join("") + `</cols>`;

  x += `<sheetData>`;
  x += `<row r="1" ht="28" customHeight="1">` + cols.map((c, i) =>
    `<c r="${colName(i)}1" s="${S.HEADER}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c.header)}</t></is></c>`).join("") + `</row>`;
  rows.forEach((row, ri) => {
    const r = ri + 2;
    x += `<row r="${r}">` + cols.map((c, ci) => cellXml(row[ci], c, colName(ci) + r)).join("") + `</row>`;
  });
  x += `</sheetData>`;
  x += `<autoFilter ref="A1:${lastCol}${lastRow}"/>`;
  x += `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`;
  x += `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`;
  x += `</worksheet>`;
  return x;
}

/* ---------- Övriga delar i paketet ---------- */

function stylesXml(){
  const border = `<border><left style="thin"><color rgb="FFD0DEF3"/></left><right style="thin"><color rgb="FFD0DEF3"/></right>`
               + `<top style="thin"><color rgb="FFD0DEF3"/></top><bottom style="thin"><color rgb="FFD0DEF3"/></bottom><diagonal/></border>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>`
    + `<fonts count="3">`
    +   `<font><sz val="10"/><color rgb="FF12283F"/><name val="Arial"/><family val="2"/></font>`
    +   `<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>`
    +   `<font><b/><sz val="10"/><color rgb="FF8A5A0B"/><name val="Arial"/><family val="2"/></font>`
    + `</fonts>`
    + `<fills count="4">`
    +   `<fill><patternFill patternType="none"/></fill>`
    +   `<fill><patternFill patternType="gray125"/></fill>`
    +   `<fill><patternFill patternType="solid"><fgColor rgb="FF2F63D9"/><bgColor indexed="64"/></patternFill></fill>`
    +   `<fill><patternFill patternType="solid"><fgColor rgb="FFFDECD2"/><bgColor indexed="64"/></patternFill></fill>`
    + `</fills>`
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="7">`
    +   `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    +   `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>`
    +   `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
    +   `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
    +   `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    +   `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    +   `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`
    + `</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;
}

function workbookXml(names){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<bookViews><workbookView activeTab="0"/></bookViews>`
    + `<sheets>` + names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets>`
    + `</workbook>`;
}

function workbookRelsXml(count){
  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  for(let i = 1; i <= count; i++){
    x += `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  x += `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return x + `</Relationships>`;
}

function contentTypesXml(count){
  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`;
  for(let i = 1; i <= count; i++){
    x += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  x += `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
     + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
     + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`;
  return x + `</Types>`;
}

function rootRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>`
    + `</Relationships>`;
}

function coreXml(title, creator){
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>${xmlEscape(creator)}</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + `</cp:coreProperties>`;
}

function appXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`;
}

/* ---------- ZIP ---------- */

let crcTable = null;
function crc32(bytes){
  if(!crcTable){
    crcTable = new Uint32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(bytes){
  if(typeof CompressionStream === "undefined") return null;
  try{
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(bytes).then(() => writer.close()).catch(() => {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }catch(e){
    return null;
  }
}

async function zip(files, compress){
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const central = [];
  let offset = 0;

  for(const file of files){
    const nameBytes = encoder.encode(file.name);
    const raw = file.data;
    const crc = crc32(raw);
    let data = raw, method = 0;
    if(compress){
      const packed = await deflateRaw(raw);
      if(packed && packed.length < raw.length){ data = packed; method = 8; }
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);      // UTF-8 filnamn
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, method, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for(const p of all){ out.set(p, pos); pos += p.length; }
  return out;
}

/* ---------- Publikt API ---------- */

export async function buildXlsx(sheets, options = {}){
  if(!Array.isArray(sheets) || !sheets.length) throw new Error("Minst ett blad krävs");
  const names = uniqueSheetNames(sheets);
  const title = options.title || "Export";
  const creator = options.creator || "Aktivitetsanmälan";

  const files = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml(sheets.length)) },
    { name: "_rels/.rels", data: encoder.encode(rootRelsXml()) },
    { name: "docProps/core.xml", data: encoder.encode(coreXml(title, creator)) },
    { name: "docProps/app.xml", data: encoder.encode(appXml()) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(names)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRelsXml(sheets.length)) },
    { name: "xl/styles.xml", data: encoder.encode(stylesXml()) },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(sheetXml(sheet, i === 0))
    }))
  ];
  return zip(files, options.compress !== false);
}
