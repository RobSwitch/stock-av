'use strict';
// Lecture de texte dans un PDF, sans aucune dépendance (zlib de Node uniquement).
// Gère : xref classique ou flux de références (objets lus par balayage), FlateDecode,
// polices TrueType/Type1 (WinAnsi) et Type0 Identity-H avec ToUnicode, positions du texte.
// Résultat : pages -> runs { x, y (depuis le haut de la page), size, bold, text }.
const zlib = require('node:zlib');

// ------------------------------------------------------------ objets
function tokenize(s, i = 0) {
  // mini analyseur d'objets PDF : renvoie [valeur, indexSuivant]
  const ws = /[\s\x00]/;
  const skip = () => { for (;;) { while (i < s.length && ws.test(s[i])) i++; if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; } else break; } };
  function parse() {
    skip();
    if (i >= s.length) return undefined;
    const c = s[i];
    if (c === '<' && s[i + 1] === '<') {
      i += 2; const d = {};
      for (;;) {
        skip();
        if (s[i] === '>' && s[i + 1] === '>') { i += 2; return d; }
        if (i >= s.length) return d;
        const k = parse();
        if (k === undefined) return d;
        d[k.name] = parse();
      }
    }
    if (c === '[') {
      i++; const a = [];
      for (;;) { skip(); if (s[i] === ']') { i++; return a; } if (i >= s.length) return a; a.push(parse()); }
    }
    if (c === '/') {
      let j = i + 1; while (j < s.length && !/[\s\x00/\[\]<>()%]/.test(s[j])) j++;
      const name = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      i = j; return { name };
    }
    if (c === '(') {
      let depth = 1, j = i + 1, out = '';
      while (j < s.length && depth) {
        const ch = s[j];
        if (ch === '\\') { out += s[j] + s[j + 1]; j += 2; continue; }
        if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) break; }
        out += ch; j++;
      }
      i = j + 1; return { str: out };
    }
    if (c === '<') { const j = s.indexOf('>', i); const hex = s.slice(i + 1, j).replace(/\s/g, ''); i = j + 1; return { hex }; }
    const m = /^(\d+)\s+(\d+)\s+R(?![A-Za-z])/.exec(s.slice(i, i + 40));
    if (m) { i += m[0].length; return { ref: Number(m[1]) }; }
    let j = i; while (j < s.length && !/[\s\x00/\[\]<>()%]/.test(s[j])) j++;
    const w = s.slice(i, j); if (j === i) i++; else i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return Number(w);
    if (w === 'true') return true; if (w === 'false') return false; if (w === 'null') return null;
    return { op: w };
  }
  return parse;
}

function loadObjects(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    let end = s.indexOf('endobj', start);
    if (end < 0) end = s.length;
    let body = s.slice(start, end);
    let stream = null;
    const sm = /stream\r?\n/.exec(body);
    if (sm) {
      const dictPart = body.slice(0, sm.index);
      const sStart = start + sm.index + sm[0].length;
      const sEnd = s.indexOf('endstream', sStart);
      let e = sEnd < 0 ? end : sEnd;
      if (s[e - 1] === '\n') e--; if (s[e - 1] === '\r') e--;
      stream = buf.subarray(sStart, e);
      body = dictPart;
      re.lastIndex = (sEnd < 0 ? end : sEnd);
    } else re.lastIndex = end;
    let val;
    try { val = tokenize(body)(); } catch { val = null; }
    objs.set(num, { val, stream });
  }
  unpackObjectStreams(objs);
  return objs;
}

// PDF ré-enregistrés (Acrobat, « PDF optimisé ») : beaucoup d'objets sont rangés dans des flux /ObjStm
// (n° et position en tête du flux décompressé, puis les objets à la suite). Les objets déjà lus directement priment.
function unpackObjectStreams(objs) {
  for (const [, o] of [...objs]) {
    const d = o.val;
    if (!o.stream || !d || d.Type?.name !== 'ObjStm') continue;
    const f = d.Filter;
    const filters = Array.isArray(f) ? f.map((x) => x?.name) : f ? [f.name] : [];
    if (filters.some((x) => x !== 'FlateDecode' && x !== 'Fl')) continue;
    let data = o.stream;
    try { if (filters.length) data = zlib.inflateSync(data); } catch { try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { continue; } }
    const s = data.toString('latin1');
    const n = Number(d.N), first = Number(d.First);
    if (!(n > 0) || !(first >= 0)) continue;
    const head = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = head[2 * k], off = head[2 * k + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off) || objs.has(num)) continue;
      const end = k + 1 < n ? first + head[2 * k + 3] : s.length;
      let val;
      try { val = tokenize(s.slice(first + off, end))(); } catch { val = null; }
      objs.set(num, { val, stream: null });
    }
  }
}

function makeDoc(buf) {
  const objs = loadObjects(buf);
  const get = (v) => { let n = 0; while (v && typeof v === 'object' && v.ref !== undefined && n++ < 20) v = objs.get(v.ref)?.val; return v; };
  const streamOf = (v) => {
    const o = v && v.ref !== undefined ? objs.get(v.ref) : null;
    if (!o || !o.stream) return null;
    const d = get(o.val) || {};
    const f = get(d.Filter);
    const filters = Array.isArray(f) ? f.map((x) => get(x)?.name) : f ? [f.name] : [];
    let data = o.stream;
    for (const fl of filters) {
      if (fl === 'FlateDecode' || fl === 'Fl') {
        try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; } }
      } else throw new Error(`Filtre PDF non géré : ${fl}`);
    }
    return data;
  };
  return { objs, get, streamOf };
}

// ------------------------------------------------------------ polices
function parseToUnicode(text) {
  const map = new Map();
  const u16 = (hex) => { let o = ''; for (let i = 0; i < hex.length; i += 4) o += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return o; };
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), u16(m[2]));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
      if (m[3][0] === '<') {
        const base = m[3].slice(1, -1);
        for (let c = a; c <= b; c++) {
          const chars = u16(base); const last = chars.charCodeAt(chars.length - 1) + (c - a);
          map.set(c, chars.slice(0, -1) + String.fromCharCode(last));
        }
      } else {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => u16(x[1]));
        for (let c = a; c <= b && c - a < list.length; c++) map.set(c, list[c - a]);
      }
    }
  }
  return map;
}

const WIN1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };

function loadFont(doc, ref) {
  const f = doc.get(ref) || {};
  const sub = doc.get(f.Subtype)?.name;
  const base = doc.get(f.BaseFont)?.name || '';
  const font = { bold: /bold|black|heavy/i.test(base), cid: sub === 'Type0', map: null, widths: null, dw: 1000, first: 0, wmap: null };
  const tu = f.ToUnicode ? doc.streamOf(f.ToUnicode) : null;
  if (tu) font.map = parseToUnicode(tu.toString('latin1'));
  if (font.cid) {
    const desc = doc.get((doc.get(f.DescendantFonts) || [])[0]) || {};
    font.dw = Number(doc.get(desc.DW) ?? 1000);
    font.wmap = new Map();
    const W = doc.get(desc.W) || [];
    for (let i = 0; i < W.length;) {
      const a = doc.get(W[i]);
      const b = doc.get(W[i + 1]);
      if (Array.isArray(b)) { b.forEach((w, k) => font.wmap.set(a + k, Number(doc.get(w)))); i += 2; }
      else { const w = Number(doc.get(W[i + 2])); for (let c = a; c <= b && c - a < 70000; c++) font.wmap.set(c, w); i += 3; }
    }
  } else {
    font.first = Number(doc.get(f.FirstChar) ?? 0);
    font.widths = (doc.get(f.Widths) || []).map((w) => Number(doc.get(w)));
    font.dw = Number(doc.get(doc.get(f.FontDescriptor)?.MissingWidth) ?? 500);
  }
  return font;
}

// ------------------------------------------------------------ contenu
function unescapePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n'; else if (n === 'r') out += '\r'; else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b'; else if (n === 'f') out += '\f';
    else if (n === '\n') { /* continuation */ } else if (n === '\r') { if (s[i + 1] === '\n') i++; }
    else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i]; out += String.fromCharCode(parseInt(o, 8) & 255); }
    else out += n;
  }
  return out;
}
const hexBytes = (h) => { if (h.length % 2) h += '0'; let o = ''; for (let i = 0; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return o; };

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

function runContent(doc, content, fonts, pageH) {
  const runs = [];
  const parse = tokenize(content);
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
  let font = null, fsize = 0, tc = 0, tw = 0, tz = 1, tl = 0, rise = 0;
  const args = [];
  const showString = (raw) => {
    if (!font) return;
    let text = '', adv = 0;
    if (font.cid) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
        text += font.map?.get(code) ?? '';
        adv += (font.wmap.get(code) ?? font.dw) / 1000 * fsize + tc;
      }
    } else {
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const ch = font.map?.get(code) ?? WIN1252[code] ?? String.fromCharCode(code);
        text += ch;
        const w = font.widths[code - font.first] ?? font.dw;
        adv += w / 1000 * fsize + tc + (code === 32 ? tw : 0);
      }
    }
    const t = mul(tm, ctm);
    const sizeEff = Math.abs(fsize * Math.hypot(t[2], t[3]));
    if (text) runs.push({ x: t[4], x2: t[4] + adv * tz * Math.hypot(t[0], t[1]), y: pageH - t[5], size: sizeEff, bold: font.bold, text });
    tm = mul([1, 0, 0, 1, adv * tz, 0], tm);
  };
  for (;;) {
    let tok;
    try { tok = parse(); } catch { break; }
    if (tok === undefined) break;
    if (!(tok && typeof tok === 'object' && tok.op !== undefined)) { args.push(tok); if (args.length > 200) args.shift(); continue; }
    const op = tok.op;
    const n = (i) => Number(args[i]);
    switch (op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.pop() || ctm; break;
      case 'cm': ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': font = fonts[args[0]?.name] || null; fsize = n(1); break;
      case 'Tc': tc = n(0); break;
      case 'Tw': tw = n(0); break;
      case 'Tz': tz = n(0) / 100; break;
      case 'TL': tl = n(0); break;
      case 'Ts': rise = n(0); void rise; break;
      case 'Td': tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'TD': tl = -n(1); tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'Tm': tm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tlm = tm; break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
      case 'Tj': { const a = args[0]; if (a?.str !== undefined) showString(unescapePdfString(a.str)); else if (a?.hex !== undefined) showString(hexBytes(a.hex)); break; }
      case "'": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; { const a = args[0]; if (a?.str !== undefined) showString(unescapePdfString(a.str)); else if (a?.hex !== undefined) showString(hexBytes(a.hex)); } break;
      case '"': tw = n(0); tc = n(1); tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; { const a = args[2]; if (a?.str !== undefined) showString(unescapePdfString(a.str)); else if (a?.hex !== undefined) showString(hexBytes(a.hex)); } break;
      case 'TJ': {
        for (const a of args[0] || []) {
          if (typeof a === 'number') tm = mul([1, 0, 0, 1, -a / 1000 * fsize * tz, 0], tm);
          else if (a?.str !== undefined) showString(unescapePdfString(a.str));
          else if (a?.hex !== undefined) showString(hexBytes(a.hex));
        }
        break;
      }
      default: break;
    }
    args.length = 0;
  }
  return runs;
}

// ------------------------------------------------------------ API
function extractPages(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error("Ce fichier n'est pas un PDF");
  const doc = makeDoc(buf);
  let root = null;
  for (const [, o] of doc.objs) { const v = o.val; if (v && v.Type && doc.get(v.Type)?.name === 'Catalog') root = v; }
  // le trailer peut désigner un autre catalogue (mises à jour incrémentales) : on prend le dernier
  const tr = [...buf.toString('latin1').matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  if (tr) root = doc.objs.get(Number(tr[1]))?.val || root;
  if (!root) throw new Error('PDF illisible (catalogue introuvable). Est-il protégé par un mot de passe ?');
  if ([...doc.objs.values()].some((o) => o.val && doc.get(o.val.Type)?.name === 'Encrypt')) throw new Error('PDF protégé : non pris en charge');
  const pages = [];
  const fontCache = new Map();
  const walk = (node, inherited) => {
    const n = doc.get(node); if (!n) return;
    const res = n.Resources !== undefined ? n.Resources : inherited.Resources;
    const box = n.MediaBox !== undefined ? n.MediaBox : inherited.MediaBox;
    if (n.Kids) { for (const k of doc.get(n.Kids)) walk(k, { Resources: res, MediaBox: box }); return; }
    const mb = (doc.get(box) || [0, 0, 595, 842]).map((v) => Number(doc.get(v)));
    const pageH = mb[3] - mb[1];
    const fres = doc.get(doc.get(res)?.Font) || {};
    const fonts = {};
    for (const [name, ref] of Object.entries(fres)) {
      const key = ref && ref.ref !== undefined ? ref.ref : null;
      if (key !== null && fontCache.has(key)) fonts[name] = fontCache.get(key);
      else { const f = loadFont(doc, ref); fonts[name] = f; if (key !== null) fontCache.set(key, f); }
    }
    let contents = doc.get(n.Contents);
    const list = Array.isArray(contents) ? n.Contents : [n.Contents];
    const data = Buffer.concat(list.flatMap((c) => { const d = doc.streamOf(c); return d ? [d, Buffer.from('\n')] : []; }));
    pages.push({ width: mb[2] - mb[0], height: pageH, runs: runContent(doc, data.toString('latin1'), fonts, pageH) });
  };
  walk(root.Pages, {});
  return pages;
}

// Regroupe les runs d'une page en lignes (même y) triées de gauche à droite
function toLines(page, tol = 2.5) {
  const runs = page.runs.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of runs) {
    const l = lines.find((L) => Math.abs(L.y - r.y) <= tol);
    if (l) l.runs.push(r); else lines.push({ y: r.y, runs: [r] });
  }
  for (const l of lines) l.runs.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

// Découpe une ligne en « cellules » : les runs séparés par un grand espace horizontal (colonnes) sont séparés
function cells(line, gap = 9) {
  const out = [];
  for (const r of line.runs) {
    const last = out[out.length - 1];
    if (last && r.x - last.x2 <= gap) { last.text += r.text; last.x2 = Math.max(last.x2, r.x2); last.bold = last.bold && r.bold; }
    else out.push({ x: r.x, x2: r.x2, y: line.y, size: r.size, bold: r.bold, text: r.text });
  }
  for (const c of out) c.text = c.text.replace(/\s+/g, ' ').trim();
  return out.filter((c) => c.text);
}

module.exports = { extractPages, toLines, cells };
