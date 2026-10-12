'use strict';
// Lecture d'un classeur Excel (.xlsx) SANS dépendance + extraction du planning BEO.
// Un .xlsx est une archive ZIP de fichiers XML : on la lit avec le module zlib intégré à Node.
const zlib = require('node:zlib');

// ---------------------------------------------------------------- ZIP
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx) valide");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    files[buf.toString('utf8', p + 46, p + 46 + nameLen)] = { method, csize, lho };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    get(name) {
      const f = files[name];
      if (!f) return null;
      const start = f.lho + 30 + buf.readUInt16LE(f.lho + 26) + buf.readUInt16LE(f.lho + 28);
      const data = buf.subarray(start, start + f.csize);
      return f.method === 0 ? data : zlib.inflateRawSync(data);
    },
  };
}

// ---------------------------------------------------------------- XML (regex, suffisant pour du SpreadsheetML)
const unesc = (s) =>
  String(s)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => (h.toUpperCase() === '000D' ? '' : String.fromCharCode(parseInt(h, 16))));

const attr = (s, name) => {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s || '');
  return m ? unesc(m[1]) : null;
};

function parseShared(xml) {
  const out = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let t = '';
    const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let x;
    while ((x = tr.exec(body))) t += unesc(x[1]);
    out.push(t);
  }
  return out;
}

function parseStyles(xml) {
  const block = (tag) => new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml)?.[1] || '';
  const fills = [];
  for (const m of block('fills').matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)) {
    const pt = /<patternFill\b([^>]*)/.exec(m[1]);
    const fg = /<fgColor\b([^>]*)\/?>/.exec(m[1]);
    fills.push({ solid: !!pt && attr(pt[1], 'patternType') === 'solid', rgb: fg ? attr(fg[1], 'rgb') : null });
  }
  const fonts = [];
  for (const m of block('fonts').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)) {
    const c = /<color\b([^>]*)\/?>/.exec(m[1]);
    fonts.push({ bold: /<b\b(?![a-z])/.test(m[1]) && !/<b\s+val="(0|false)"/.test(m[1]), rgb: c ? attr(c[1], 'rgb') : null });
  }
  const xfs = [];
  for (const m of block('cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const fill = fills[Number(attr(m[1], 'fillId') || 0)];
    const font = fonts[Number(attr(m[1], 'fontId') || 0)];
    xfs.push({ fill: fill && fill.solid ? fill.rgb : null, bold: !!font?.bold, fontRgb: font?.rgb || null });
  }
  return { xfs };
}

const colToNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const splitRef = (ref) => {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  return m ? [parseInt(m[2], 10), colToNum(m[1])] : null; // [ligne, colonne]
};

function parseSheet(xml, shared) {
  const cells = new Map(); // "ligne,colonne" -> { v, f, s }
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const rc = splitRef(attr(m[1], 'r') || '');
    if (!rc) continue;
    const t = attr(m[1], 't');
    const s = attr(m[1], 's');
    const body = m[2] || '';
    const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
    const fm = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
    let v = null;
    if (t === 's') v = vm ? shared[Number(vm[1])] ?? null : null;
    else if (t === 'inlineStr') {
      v = '';
      for (const x of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) v += unesc(x[1]);
    } else if (t === 'str') v = vm ? unesc(vm[1]) : null;
    else if (t === 'b') v = vm ? vm[1] === '1' : null;
    else if (t === 'e') v = null;
    else if (vm && vm[1] !== '') v = Number(vm[1]); // <v></v> vide (formule sans valeur en cache) = pas de valeur
    cells.set(rc[0] + ',' + rc[1], { v, f: fm ? unesc(fm[1] || '') : null, s: s == null ? null : Number(s) });
  }
  const merges = [];
  for (const x of xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)) {
    const [a, b] = x[1].split(':');
    const A = splitRef(a), B = splitRef(b || a);
    if (A && B) merges.push({ r1: A[0], c1: A[1], r2: B[0], c2: B[1] });
  }
  return { cells, merges };
}

function readWorkbook(buf) {
  const zip = readZip(buf);
  const text = (n) => zip.get(n)?.toString('utf8') ?? null;
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('Classeur Excel illisible (workbook.xml introuvable)');
  const relMap = {};
  for (const m of (text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) relMap[attr(m[1], 'Id')] = attr(m[1], 'Target');
  const shared = text('xl/sharedStrings.xml') ? parseShared(text('xl/sharedStrings.xml')) : [];
  const styles = parseStyles(text('xl/styles.xml') || '');
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const target = relMap[attr(m[1], 'r:id')];
    if (!target) continue;
    const xml = text(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    if (!xml) continue;
    sheets.push({ name: attr(m[1], 'name'), ...parseSheet(xml, shared) });
  }
  return { sheets, styles };
}

// ---------------------------------------------------------------- Extraction du planning BEO
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Onglets du fichier qui contiennent le planning (nom normalisé -> libellé affiché)
const AREAS = [
  { match: 'oasis', label: 'Oasis (étage -1)' },
  { match: 'rezdechaussee', label: 'Rez-de-chaussée' },
  { match: 'etage1', label: 'Étage +1' },
  { match: 'others', label: 'Autres espaces' },
];
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const serialToISO = (n) => new Date(Math.round((Math.floor(n) - 25569) * 86400000)).toISOString().slice(0, 10);

// Couleur de remplissage -> 'red' | 'green' | 'yellow' | null
function colorName(rgb) {
  if (!rgb || rgb.length < 6) return null;
  const hex = rgb.slice(-6);
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  if (r > 235 && g > 235 && b > 235) return null; // blanc
  if (r > g + 20 && r > b + 20 && g > 180 && b < 200 && r > 230 && g > 200) return 'yellow'; // jaune/orange clair (FFEB9C)
  if (r >= g + 25 && r >= b + 25) return 'red'; // rose/rouge (FFC7CE)
  if (g >= r + 15 && g >= b + 15) return 'green'; // vert (C6EFCE)
  return null;
}

// "CLIENT\n\nLCD + HFS\n\n0900_____1800" -> { client, detail, start, end, tags }
function parseEventText(raw) {
  const text = String(raw).replace(/\r/g, '');
  let start = null, end = null;
  let tm = /(\d{2})(\d{2})\s*_{2,}\s*(\d{2})(\d{2})/.exec(text);
  if (!tm) tm = /\b(\d{1,2})h(\d{2})?\s*[-–]\s*(\d{1,2})h(\d{2})?\b/i.exec(text);
  if (tm) {
    const p2 = (x) => String(x ?? '00').padStart(2, '0');
    start = p2(tm[1]) + ':' + p2(tm[2]);
    end = p2(tm[3]) + ':' + p2(tm[4]);
  }
  const lines = text
    .split('\n')
    .map((l) => clean(l.replace(/(\d{2})(\d{2})\s*_{2,}\s*(\d{2})(\d{2})/, '')))
    .filter(Boolean);
  const tags = [];
  if (/\bset-?up\b|instal/i.test(text)) tags.push('Montage');
  if (/\brepet/i.test(text)) tags.push('Répétition');
  if (/\bshow\b/i.test(text)) tags.push('Show');
  if (/d[ée]montage/i.test(text)) tags.push('Démontage');
  if (/\brecup/i.test(text)) tags.push('Récup');
  if (/travaux/i.test(text)) tags.push('Travaux');
  const phaseOnly = /^(set-?up|show|repet|d[ée]montage|travaux)(\s*\+\s*(set-?up|show|repet|d[ée]montage))*$/i;
  const client = lines[0] || '';
  const detail = lines.slice(1).filter((l) => !phaseOnly.test(l)).join(' · ');
  return { client, detail, start, end, tags };
}

function extractPlanning(wb) {
  const events = [];
  const areas = [];
  const warnings = [];
  const byName = Object.fromEntries(wb.sheets.map((s) => [norm(s.name), s]));
  const get = (sh, r, c) => sh.cells.get(r + ',' + c);

  // Résolution d'une date : valeur en cache, sinon formule du type =OASIS!C2
  const dateOf = (sh, r) => {
    const cell = get(sh, r, 3);
    if (!cell) return null;
    if (typeof cell.v === 'number' && cell.v > 1) return serialToISO(cell.v);
    const f = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/.exec((cell.f || '').replace(/^=/, ''));
    const src = f && byName[norm(f[1])];
    if (src && src !== sh) return dateOf(src, Number(f[3]));
    return null;
  };

  for (const area of AREAS) {
    const sh = byName[area.match];
    if (!sh) { warnings.push(`Onglet introuvable : ${area.label}`); continue; }

    // lignes des jours (colonne B) et ligne d'en-tête (juste au-dessus du premier jour)
    const dayRows = [];
    for (let r = 1; r <= 60; r++) {
      const v = get(sh, r, 2)?.v;
      if (typeof v === 'string' && DAYS.includes(norm(v))) dayRows.push(r);
    }
    if (!dayRows.length) { warnings.push(`Aucun jour trouvé dans « ${sh.name} »`); continue; }
    let headerRow = dayRows[0] - 1;
    const headerCount = (r) => [...sh.cells].filter(([k, c]) => k.startsWith(r + ',') && Number(k.split(',')[1]) >= 4 && typeof c.v === 'string' && c.v.trim()).length;
    while (headerRow > 1 && headerCount(headerRow) < 3) headerRow--;

    // salles = cellules texte de l'en-tête (colonnes D et suivantes), hors légende « = Prospect »
    const rooms = new Map(); // colonne -> nom
    for (const [k, c] of sh.cells) {
      const [r, col] = k.split(',').map(Number);
      if (r === headerRow && col >= 4 && typeof c.v === 'string' && clean(c.v) && !c.v.trim().startsWith('=')) rooms.set(col, clean(c.v));
    }
    areas.push({ label: area.label, sheet: sh.name, rooms: [...rooms.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]) });

    // cellules fusionnées : [haut-gauche] -> étendue ; autres cellules couvertes -> ignorées
    const span = new Map(), covered = new Set();
    for (const m of sh.merges) {
      span.set(m.r1 + ',' + m.c1, m);
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(r + ',' + c);
    }
    const rowDate = Object.fromEntries(dayRows.map((r) => [r, dateOf(sh, r)]));

    for (const r of dayRows) {
      if (!rowDate[r]) { warnings.push(`« ${sh.name} » ligne ${r} : date introuvable`); continue; }
      for (const [col] of rooms) {
        const key = r + ',' + col;
        const cell = sh.cells.get(key);
        if (!cell || covered.has(key)) continue;
        const raw = cell.v == null ? '' : String(cell.v);
        if (!raw.trim()) continue;
        const sp = span.get(key) || { r2: r, c2: col };
        const evRooms = [];
        for (let c = col; c <= sp.c2; c++) if (rooms.has(c)) evRooms.push(rooms.get(c));
        const lastRow = [...dayRows].reverse().find((x) => x <= sp.r2 && rowDate[x]) || r;
        const st = cell.s != null ? wb.styles.xfs[cell.s] : null;
        events.push({
          area: area.label,
          date: rowDate[r],
          end_date: rowDate[lastRow] || rowDate[r],
          rooms: evRooms,
          ...parseEventText(raw),
          raw: raw.trim(),
          color: colorName(st?.fill),
          urgent: !!(st?.bold && st.fontRgb && /^FF?FF0000$/i.test(st.fontRgb)),
          sheet: sh.name,
          cell: key,
        });
      }
    }
  }
  return { events, areas, warnings };
}

module.exports = { readWorkbook, extractPlanning, parseEventText, colorName };
