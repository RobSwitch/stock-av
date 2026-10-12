'use strict';
// Lecture du « BEO Book » (PDF Amadeus/Delphi) : un BEO par événement, plusieurs pages chacun.
// Pour chaque BEO on récupère : compte, nom d'événement, date, statut, tableau des salles (heures)
// et la section « Mise en place salles de réunions & AV » (matériel demandé par salle).
const { extractPages, toLines, cells } = require('./pdftext.js');

const MONTHS = { janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12 };
const TIME_RANGE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/;
const BLOCK_HDR = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\|\s*(.*?)\s*\|\s*(.+)$/;
const pad = (t) => (t.length === 4 ? '0' + t : t);
const frDate = (s) => {
  const m = /(\d{1,2})\s+([A-Za-zéèûôîçà]+)\s+(\d{4})/.exec(s || '');
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
const shortDate = (s) => { const m = /(\d{2})\.(\d{2})\.(\d{2})$/.exec(s || ''); return m ? `20${m[3]}-${m[2]}-${m[1]}` : null; };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const HEADER_Y = 92, FOOTER_Y = 795; // zone utile d'une page (en-tête et pied de page répétés)
const RIGHT_X = 295;                 // colonne de droite (agenda / AV)
const ROOM_X = [190, 258];           // colonne « Salle » du tableau

function pageModel(page) {
  const lines = toLines(page).map((l) => ({ y: l.y, cells: cells(l, 3) }));
  const text = lines.map((l) => l.cells.map((c) => c.text).join(' ')).join('\n');
  return { lines, beo: (/BEO #:\s*(\d+)/.exec(text) || [])[1] || null };
}

function parseHeader(pm) {
  const L = pm.lines;
  const yC = L.find((l) => l.cells.some((c) => /^Nom du Compte/.test(c.text)));
  const yS = L.find((l) => l.cells.some((c) => /^Statut/.test(c.text)));
  if (!yC || !yS) return null;
  const between = L.filter((l) => l.y >= yC.y - 2 && l.y < yS.y - 2);
  const valLines = between.map((l) => ({ y: l.y, t: clean(l.cells.filter((c) => c.x >= 100 && c.x < 295).map((c) => c.text).join(' ')) })).filter((v) => v.t);
  const account = valLines.find((v) => Math.abs(v.y - yC.y) < 3)?.t || '';
  const eventName = clean(valLines.filter((v) => Math.abs(v.y - yC.y) >= 3).map((v) => v.t).join(' '));
  let date = null;
  for (const l of between) for (const c of l.cells) if (c.x >= 370 && !date) date = frDate(c.text);
  const status = clean(yS.cells.filter((c) => c.x >= 95 && c.x < 295).map((c) => c.text).join(' '));
  return { account, eventName, date, status };
}

// Colonnes du tableau (position x du début du texte) : Heure | Arrivée | Salle | Nom de l'évènement | Signalétique | Mise en place | Actuel | Location
const COLS = { name: [258, 340], sign: [340, 404], setup: [404, 458], pax: [458, 498] };
const inCol = (c, [a, b]) => c.x >= a && c.x < b;
const colText = (l, col) => clean(l.cells.filter((c) => inCol(c, col)).map((c) => c.text).join(' '));

// Lignes du tableau des salles d'une page : { start, end, date, room, name, sign, setup, pax }
function parseTable(pm) {
  const rows = [];
  let last = null;
  for (const l of pm.lines) {
    if (l.y < HEADER_Y || l.y > FOOTER_Y) continue;
    const t = l.cells.find((c) => c.x < 125 && TIME_RANGE.test(c.text));
    const d = l.cells.find((c) => c.x >= 115 && c.x < 190 && /\d{2}\.\d{2}\.\d{2}$/.test(c.text));
    const room = clean(l.cells.filter((c) => c.x >= ROOM_X[0] && c.x < ROOM_X[1]).map((c) => c.text).join(' '));
    if (t && d) {
      const m = TIME_RANGE.exec(t.text);
      last = { y: l.y, start: pad(m[1]), end: pad(m[2]), date: shortDate(d.text), room };
      for (const k of Object.keys(COLS)) last[k] = colText(l, COLS[k]);
      rows.push(last);
    } else if (last && l.y - last.y < 40 && !l.cells.some((c) => c.x < ROOM_X[0] - 5 || /^\*Ctr/.test(c.text))) {
      // ligne de suite (texte qui passe à la ligne dans une colonne)
      if (room) last.room = clean(last.room + ' ' + room);
      for (const k of Object.keys(COLS)) { const x = colText(l, COLS[k]); if (x) last[k] = clean(last[k] + ' ' + x); }
      last.y = l.y;
    } else if (l.cells.some((c) => /^\*Ctr/.test(c.text))) last = null;
  }
  return rows;
}

// Blocs AV d'une page, en continuité avec l'état précédent (la section peut courir sur plusieurs pages)
function parseAv(pm, st) {
  for (const l of pm.lines) {
    for (const c of l.cells) {
      if (c.x < RIGHT_X || l.y < HEADER_Y || l.y > FOOTER_Y) continue;
      if (c.size >= 11 && c.bold) { st.inAV = /Mise en place salles de r/i.test(c.text); st.cur = null; continue; }
      if (!st.inAV) continue;
      const m = BLOCK_HDR.exec(c.text);
      if (m && c.bold) { st.cur = { start: pad(m[1]), end: pad(m[2]), phase: m[3], room: clean(m[4]), av: [], other: [], mode: null }; st.blocks.push(st.cur); continue; }
      if (!st.cur) continue;
      if (c.x < 310) { st.cur.mode = /\bAV$/i.test(c.text) ? 'av' : 'other'; if (st.cur.mode === 'other') st.cur.other.push(c.text); }
      else if (st.cur.mode === 'av') st.cur.av.push(c.text);
      else st.cur.other.push(c.text);
    }
  }
}

// LCD + PROJECTOR / ECRAN → « LCD » ; micros demandés en plus → « HFS » ; autres éléments conservés tels quels
function describeAv(items) {
  const parts = [];
  const rest = [];
  let lcd = false, hfs = false;
  const layout = /flipchart|sous-?com|pl[ée]ni[èe]re|\btables?\b|chaises?|nappe|set ?up|classroom|u-shape|th[ée][aâ]tre|\beaux?\b|verres|salle\b/i; // mise en place de la salle, pas du matériel AV
  for (const raw of items) {
    const t = clean(raw);
    if (!t || layout.test(t)) continue;
    if (/\b(lcd|projector|projecteur|beamer|ecran|écran)\b/i.test(t)) lcd = true;
    else if (/micro|\bhf\b/i.test(t)) hfs = true;
    else if (!rest.some((r) => r.toLowerCase() === t.toLowerCase())) rest.push(t);
  }
  if (lcd) parts.push('LCD');
  if (hfs) parts.push('HFS');
  return [...parts, ...rest].join(' + ');
}

function parseBeoBook(buf, match) {
  const pages = extractPages(buf).map(pageModel);
  const warnings = [];
  const beos = [];
  let cur = null;
  for (const pm of pages) {
    if (!pm.beo) continue;
    if (!cur || cur.number !== pm.beo) {
      cur = { number: pm.beo, header: null, rows: [], av: { inAV: false, cur: null, blocks: [] } };
      beos.push(cur);
    }
    if (!cur.header) cur.header = parseHeader(pm);
    cur.rows.push(...parseTable(pm));
    parseAv(pm, cur.av);
  }
  if (!beos.length) throw new Error("Aucun BEO reconnu dans ce PDF (ce n'est pas un BEO Book ?)");

  const unmatched = new Map();
  const events = [];
  for (const b of beos) {
    const h = b.header;
    if (!h) { warnings.push(`BEO ${b.number} : en-tête illisible, ignoré`); continue; }
    const names = [h.account, h.eventName].filter(Boolean);
    const client = names.sort((a, c) => a.length - c.length)[0] || `BEO ${b.number}`;
    const color = /prospect/i.test(h.status) ? 'yellow' : 'red';
    // regroupe les lignes du tableau par (date, salle de l'application)
    const groups = new Map();
    const noteRoom = (name, n = 1) => {
      const ids = match(name);
      if (!ids.length) unmatched.set(name, (unmatched.get(name) || 0) + n);
      return ids;
    };
    for (const r of b.rows) {
      const ids = noteRoom(r.room);
      const date = r.date || h.date;
      if (h.date && r.date && r.date !== h.date) warnings.push(`BEO ${b.number} : ligne du ${r.date} différente de la date de l'événement (${h.date}) — date de la ligne utilisée`);
      for (const id of ids) {
        const key = `${date}|${id}`;
        const g = groups.get(key) || { date, id, start: r.start, end: r.end, rows: 0, info: [] };
        if (r.start < g.start) g.start = r.start;
        if (r.end > g.end) g.end = r.end;
        g.rows++; groups.set(key, g);
        const line = { start: r.start, end: r.end, name: r.name, sign: r.sign, setup: r.setup, pax: r.pax };
        if (!g.info.some((x) => JSON.stringify(x) === JSON.stringify(line))) g.info.push(line);
      }
    }
    // matériel AV par salle
    const avByRoom = new Map();
    for (const blk of b.av.blocks) {
      for (const id of noteRoom(blk.room, 0)) {
        const a = avByRoom.get(id) || { av: [], other: [], block: true };
        a.av.push(...blk.av); a.other.push(...blk.other);
        avByRoom.set(id, a);
        const g = [...groups.values()].find((x) => x.id === id);
        if (!g) { // salle présente dans l'agenda mais pas dans le tableau
          const key = `${h.date}|${id}`;
          groups.set(key, { date: h.date, id, start: blk.start, end: blk.end, rows: 0, info: [] });
        }
      }
    }
    for (const g of groups.values()) {
      const a = avByRoom.get(g.id);
      const items = a ? [...new Set(a.av.map(clean))] : [];
      const microInOther = a ? a.other.some((t) => /\bmicros?\b/i.test(t) && /pr[ée]voir|mettre|besoin|ajout/i.test(t)) : false;
      let detail = describeAv(items);
      if (microInOther && !/HFS/.test(detail)) detail = detail ? detail.replace(/^LCD/, 'LCD + HFS') : 'HFS';
      events.push({
        beo: b.number, date: g.date, room_id: g.id, start: g.start, end: g.end,
        client, account: h.account, event_name: h.eventName, status: h.status, color,
        detail, av: items, hasAv: !!a, rows: g.rows,
        info: { beo: b.number, account: h.account, event: h.eventName, rows: g.info }, // n° de BEO : retrouve l'événement dans une version mise à jour
      });
    }
  }
  events.sort((a, c) => a.date.localeCompare(c.date) || a.room_id - c.room_id || a.start.localeCompare(c.start));
  // liste des BEO du PDF (un BEO Book complet en contient beaucoup, un envoi isolé un seul ou quelques-uns)
  const beoList = beos.filter((b) => b.header).map((b) => ({ number: b.number, date: b.header.date, client: [b.header.account, b.header.eventName].filter(Boolean).sort((a, c) => a.length - c.length)[0] || '' }));
  return { beoCount: beos.length, beoList, events, unmatched: [...unmatched].map(([name, count]) => ({ name, count })).sort((a, c) => c.count - a.count), warnings };
}

// ---- Correspondance « nom de salle du PDF » → salle(s) de l'application
const nz = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+]/g, '');
const PDF_ALIAS = { // nom normalisé du PDF → noms normalisés (sans espaces) des salles de l'application
  boisdentelle: ['bdt'], flamboyant: ['flamby'], auditoriumcanopee: ['canopee'],
  arganforeti: ['arganforet1'], arganforetii: ['arganforet2'], arganforet1: ['arganforet1'], arganforet2: ['arganforet2'],
};
function editDist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// locs : [{id, name}] ; saved : { 'nom normalisé du PDF': [ids] } (choix mémorisés par l'utilisateur)
function makeMatcher(locs, saved = {}) {
  const named = locs.map((l) => ({ id: l.id, n: nz(l.name).replace(/\+/g, '') }));
  const one = (raw) => {
    const k = nz(raw).replace(/\+/g, '');
    if (!k) return [];
    if (saved[k]) return saved[k].filter((id) => named.some((x) => x.id === id));
    if (PDF_ALIAS[k]) return named.filter((x) => PDF_ALIAS[k].includes(x.n)).map((x) => x.id);
    let hit = named.filter((x) => x.n === k);
    if (hit.length === 1) return [hit[0].id];
    const [, letters, digits] = /^(.*?)(\d*)$/.exec(k);
    hit = named.filter((x) => {
      const [, l2, d2] = /^(.*?)(\d*)$/.exec(x.n);
      return l2.length >= 3 && letters.length >= 3 && d2 === digits && (letters.startsWith(l2) || l2.startsWith(letters));
    });
    if (hit.length === 1) return [hit[0].id];
    // nom de la grande salle sans numéro (« Cocobolo », « Cherry », « Redwood ») → toutes les parties réunies (Coco 1 + 2 + 3…)
    if (!digits) {
      hit = named.filter((x) => { const [, l2, d2] = /^(.*?)(\d+)$/.exec(x.n) || []; return d2 && l2.length >= 3 && (k.startsWith(l2) || l2.startsWith(k)); });
      if (hit.length >= 2 && new Set(hit.map((x) => /^(.*?)\d+$/.exec(x.n)[1])).size === 1) return hit.map((x) => x.id);
    }
    if (k.length >= 7) { hit = named.filter((x) => editDist(k, x.n) <= 1); if (hit.length === 1) return [hit[0].id]; }
    return [];
  };
  return (raw) => {
    const s = String(raw || '').trim();
    const rom = /^(.*?)\s+I\s*&\s*II$/.exec(s); // « Argan Fôret I & II »
    if (rom) return [...new Set([...one(`${rom[1]} I`), ...one(`${rom[1]} II`)])];
    // « Cherry 1+2 », « Cherry 1+2+3 » → plusieurs salles
    const m = /^(.*?)(\d(?:\s*\+\s*\d)+)$/.exec(s);
    if (m) return [...new Set(m[2].split('+').map((d) => d.trim()).flatMap((d) => one(`${m[1]}${d}`)))];
    return one(s);
  };
}

module.exports = { parseBeoBook, describeAv, makeMatcher, nz };
