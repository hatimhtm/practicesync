'use strict';

/*
 * A small reader for Excel .xlsx files (the staff list upload) — no extra
 * library: an .xlsx is a zip of XML files, read with Node's own zlib. Returns
 * the first sheet as rows of cell text. Formulas give their saved value.
 */

const zlib = require('zlib');

/** The zip's files as { name: Buffer } (only the ones `want` accepts). */
function unzip(buf, want = () => true) {
  // The central directory lists every file; find its end record from the back.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
  }
  return out;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
const textOf = (xml) => unescape([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** The first sheet of an .xlsx file as an array of rows (arrays of strings). */
function readFirstSheet(buf) {
  const files = unzip(buf, (n) => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
  const shared = files['xl/sharedStrings.xml'] ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  // The first sheet in the workbook's order (not just whichever file is named sheet1).
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = files['xl/workbook.xml'] && files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'] && files['xl/_rels/workbook.xml.rels'].toString('utf8');
  const firstId = wb && (/<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || [])[1];
  if (firstId && rels) {
    const target = (new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)
      || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels) || [])[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = files[sheetPath] || Object.entries(files).find(([n]) => n.startsWith('xl/worksheets/'))?.[1];
  if (!sheet) throw new Error('This Excel file has no sheet.');
  const rows = [];
  for (const r of sheet.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const inner = c[2] || '';
      let v = '';
      if (type === 's') v = shared[Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1])] || '';
      else if (type === 'inlineStr') v = textOf(inner);
      else v = unescape((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
      row[ref ? colIndex(ref) : row.length] = v.trim();
    }
    rows.push(Array.from(row, (x) => x || ''));
  }
  return rows;
}

/** Staff from sheet rows: finds the email in each row, and the name from the
 *  "First Name" + "Last Name" columns (or a "Name" column, or the first text
 *  cell), and the role from a "Role"/"Title" column. Returns lines the staff
 *  importer reads: "Name\tRole\temail". */
function staffLinesFromRows(rows) {
  const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const head = (rows[0] || []).map((h) => String(h || '').toLowerCase());
  const hasHeader = head.some((h) => /name|email|role/.test(h)) && !head.some((h) => EMAIL.test(h));
  const col = (re) => head.findIndex((h) => re.test(h));
  const first = hasHeader ? col(/first/) : -1;
  const last = hasHeader ? col(/last|surname/) : -1;
  const full = hasHeader ? col(/^(full )?name$|staff/) : -1;
  const role = hasHeader ? col(/role|title|position|discipline/) : -1;
  const lines = [];
  for (const row of hasHeader ? rows.slice(1) : rows) {
    const cells = row.map((c) => String(c || '').trim());
    const email = (cells.find((c) => EMAIL.test(c)) || '').match(EMAIL);
    if (!email) continue;
    let name = first >= 0 || last >= 0 ? [cells[first], cells[last]].filter(Boolean).join(' ') : full >= 0 ? cells[full] : '';
    if (!name) name = cells.find((c, i) => c && !EMAIL.test(c) && i !== role) || '';
    if (!name) continue;
    // "Lee - Williams" → "Lee-Williams" (a spaced dash would read as a separator).
    lines.push(`${name.replace(/\s+[-–—]\s+/g, '-').replace(/\s+/g, ' ')}\t${role >= 0 ? cells[role] || '' : ''}\t${email[0]}`);
  }
  return lines.join('\n');
}

module.exports = { readFirstSheet, staffLinesFromRows, unzip };
