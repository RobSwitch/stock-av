'use strict';
// Lecture d'une fiche technique Dolce (« TECHNICAL SET » / « REGULAR SET », PDF généré depuis Excel).
// Page 1 : Client, Version, Dated. Ensuite, pour chaque salle : Room / Set up / Show time puis le matériel
// (QTY | Equipment | Coeff | … | fournisseur : Included, Dolce, CAS, Géné-Electra… ou un prix).
const { extractPages, toLines, cells } = require('./pdftext.js');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LABEL_X = 110; // les libellés (Client, Room, Set up…) sont dans la colonne de gauche
const NAME_X = [75, 300]; // colonne « Equipment »
const SUPPLIER_X = 430; // dernière colonne (Included / Dolce / CAS / prix)

// « 14/10/2026 », « 15-16/10/2026 », « 15&16/10/2026 », « 30/10/2026 - 02/11/2026 » → { from, to }
function parseDates(s) {
  const t = clean(s);
  const iso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const full = [...t.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (full.length >= 2) return { from: iso(full[0][1], full[0][2], full[0][3]), to: iso(full.at(-1)[1], full.at(-1)[2], full.at(-1)[3]) };
  const m = /(\d{1,2})(?:\s*[-&+,]\s*(?:\d{1,2}\s*[-&+,]\s*)*(\d{1,2}))?\/(\d{1,2})\/(\d{4})/.exec(t);
  if (!m) return { from: null, to: null };
  return { from: iso(m[1], m[3], m[4]), to: iso(m[2] || m[1], m[3], m[4]) };
}

// Included → inclus ; Dolce → dolce (notre matériel) ; un prix → payant ; sinon société externe (CAS…)
function supplierKind(s) {
  if (/^included$/i.test(s)) return { kind: 'inclus', supplier: 'Inclus' };
  if (/^dolce$/i.test(s)) return { kind: 'dolce', supplier: 'Dolce' };
  if (/^[\d\s.,€]+$/.test(s)) return { kind: 'prix', supplier: s.replace(/\s/g, '') };
  if (!s) return { kind: 'externe', supplier: '?' };
  return { kind: 'externe', supplier: s.length <= 4 ? s.toUpperCase() : s };
}

function parseOffer(buf) {
  const pages = extractPages(buf);
  const out = { client: '', version: '', title: '', dated: '', pageCount: pages.length, rooms: [], services: [] };
  let room = null, section = '', inServices = false, last = null;
  pages.forEach((page, pi) => {
    for (const line of toLines(page)) {
      const cs = cells(line, 3);
      if (!cs.length) continue;
      const lbl = cs[0].x < LABEL_X ? clean(cs[0].text) : '';
      const rest = clean(cs.slice(1).map((c) => c.text).join(' '));
      // en-tête de la page 1
      if (!out.client && lbl === 'Client' && rest) { out.client = rest; continue; }
      if (!out.version && lbl === 'Version' && rest) { out.version = rest; continue; }
      if (!out.dated && lbl === 'Dated' && rest) { out.dated = rest; continue; }
      if (!out.title && cs.length === 1 && cs[0].bold && cs[0].size >= 12 && /\bSET\b/.test(cs[0].text)) { out.title = clean(cs[0].text); continue; }
      // bloc salle
      if (lbl === 'Room' && rest) {
        room = { name: rest, page: pi + 1, setup: null, show_from: null, show_to: null, show_raw: '', items: [] };
        out.rooms.push(room); section = ''; inServices = false; last = null; continue;
      }
      if (room && lbl === 'Set up' && rest) { room.setup = parseDates(rest).from; continue; }
      if (room && lbl === 'Show time' && rest) { const d = parseDates(rest); room.show_from = d.from; room.show_to = d.to; room.show_raw = rest; continue; }
      // titre de section (PROJECTION & HARDWARE, SOUND, SERVICES - TRANSPORT…) : texte gras seul, en majuscules
      if (cs.length === 1 && cs[0].bold && cs[0].x > 150 && /[A-Z]/.test(cs[0].text) && cs[0].text === cs[0].text.toUpperCase() && !/\bSET\b/.test(cs[0].text)) {
        section = clean(cs[0].text);
        if (/^SERVICES/.test(section)) inServices = true;
        last = null; continue;
      }
      // ligne de matériel : quantité | désignation | coeff | … | fournisseur
      if (cs[0].x < NAME_X[0] && /^\d+$/.test(cs[0].text.trim())) {
        const name = clean(cs.filter((c) => c.x >= NAME_X[0] && c.x < NAME_X[1]).map((c) => c.text).join(' '));
        const sup = cs.filter((c) => c.x >= SUPPLIER_X);
        const item = { qty: Number(cs[0].text), name, section, ...supplierKind(clean(sup.length ? sup[sup.length - 1].text : '')) };
        if (inServices || !room) out.services.push(item); else room.items.push(item);
        last = { item, y: line.y }; continue;
      }
      // suite d'une désignation trop longue (passée à la ligne)
      if (last && line.y - last.y < 18 && cs.every((c) => !c.bold && c.x >= NAME_X[0] && c.x < NAME_X[1])) {
        last.item.name = clean(last.item.name + ' ' + cs.map((c) => c.text).join(' '));
        last.y = line.y; continue;
      }
      last = null;
    }
  });
  if (!out.rooms.length) throw new Error("Ce PDF n'a pas la forme d'une fiche technique Dolce (aucun bloc « Room / Set up / Show time » trouvé)");
  return out;
}

module.exports = { parseOffer, parseDates };
