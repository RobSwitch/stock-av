// Suivi de stock audiovisuel - V1
// Zéro dépendance : Node 22+ (http + node:sqlite intégrés)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const beopdf = require('./beopdf.js');
const offrepdf = require('./offrepdf.js');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
// Dossier des données (base + PDF des offres) : à côté de server.js par défaut,
// ou choisi dans l'application installée (variable STOCKAV_DATA)
const DATA_DIR = process.env.STOCKAV_DATA || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'stock.db'));

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('stock','salle'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Autre',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (item_id, location_id)
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  item_id INTEGER NOT NULL,
  from_location_id INTEGER,
  to_location_id INTEGER,
  qty INTEGER NOT NULL,
  note TEXT DEFAULT ''
);
-- Trace du matériel retiré du stock. "status" prépare les futurs états
-- ('reparation', 'hors_service'…) ; pour l'instant : 'retire'.
CREATE TABLE IF NOT EXISTS retired (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  item_id INTEGER NOT NULL REFERENCES items(id),
  from_location_id INTEGER,
  qty INTEGER NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL DEFAULT 'retire',
  note TEXT DEFAULT ''
);
`);

// Migration : colonne "étage" (NULL = pas d'étage : couloir, restaurant, bar…)
if (!db.prepare('PRAGMA table_info(locations)').all().some((c) => c.name === 'floor')) {
  db.exec('ALTER TABLE locations ADD COLUMN floor INTEGER');
}
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
// Équipement fixe d'une salle (matériel « Included » des fiches techniques, ou saisi à la main) : [{ qty, name }]
// equipment_src : 'auto' (appris des fiches, complété à chaque nouvelle fiche) ou 'manuel' (jamais écrasé)
if (!db.prepare('PRAGMA table_info(locations)').all().some((c) => c.name === 'equipment')) {
  db.exec('ALTER TABLE locations ADD COLUMN equipment TEXT');
  db.exec('ALTER TABLE locations ADD COLUMN equipment_src TEXT');
}
// Migration : identifiant de "déplacement" pour regrouper les lignes d'un même déplacement dans l'historique
if (!db.prepare('PRAGMA table_info(movements)').all().some((c) => c.name === 'batch')) {
  db.exec('ALTER TABLE movements ADD COLUMN batch TEXT');
}

// Stocks de départ (à renommer dans l'interface)
if (db.prepare('SELECT COUNT(*) c FROM locations').get().c === 0) {
  const ins = db.prepare('INSERT INTO locations (name, kind) VALUES (?, ?)');
  ['Stock principal', 'Stock 2', 'Stock 3'].forEach((n) => ins.run(n, 'stock'));
}

// Import unique de la liste réelle des salles de l'hôtel
const ROOMS = {
  '-1': ['Acerola', 'Carambola', 'Fig', 'Guava', 'Kumquat', 'Kiwano', 'Litchi', 'Mango', 'Pomegr.', 'Pitaya', 'Rambout.', 'Tamarillo'],
  '0': ['Amarente', 'Bdt', 'Coco 3', 'Coco 2', 'Coco 1', 'Delfino', 'Ebene', 'Flamby', 'Ginko', 'Cherry 3', 'Cherry 2', 'Cherry 1'],
  '1': ['Imbuia', 'Jatoba', 'Kawi', 'Mahog.', 'Mang. 1', 'Mang. 2', 'Mang. 3', 'Mang. 4', 'Palissandre', 'Rosewood', 'Snakewood', 'Teck'],
  none: ['Baobab', 'Canopée', 'Redwood 3', 'Redwood 2', 'Redwood 1', 'e-Coffee', 'Argan Forêt 1', 'Argan Forêt 2', 'Oak Bar', 'Esplanade', 'Bureau Redwood', 'Réception'],
};
if (!db.prepare("SELECT 1 FROM meta WHERE key='rooms_v1'").get()) {
  db.exec('BEGIN');
  // supprime les anciennes salles d'exemple si elles sont vides
  db.prepare("DELETE FROM locations WHERE kind='salle' AND name IN ('Salle A','Salle B','Salle C') AND id NOT IN (SELECT location_id FROM stock)").run();
  const ins = db.prepare("INSERT OR IGNORE INTO locations (name, kind, floor) VALUES (?, 'salle', ?)");
  for (const [f, names] of Object.entries(ROOMS)) names.forEach((n) => ins.run(n, f === 'none' ? null : Number(f)));
  db.prepare("INSERT INTO meta (key, value) VALUES ('rooms_v1','1')").run();
  db.exec('COMMIT');
}

const getLocationQty = db.prepare('SELECT qty FROM stock WHERE item_id=? AND location_id=?');
const setQty = db.prepare(`INSERT INTO stock (item_id, location_id, qty) VALUES (?,?,?)
  ON CONFLICT(item_id, location_id) DO UPDATE SET qty = excluded.qty`);
const delQty = db.prepare('DELETE FROM stock WHERE item_id=? AND location_id=?');

function adjust(itemId, locId, delta) {
  const cur = getLocationQty.get(itemId, locId)?.qty || 0;
  const next = cur + delta;
  if (next < 0) throw new Error('Quantité insuffisante à cet emplacement');
  if (next === 0) delQty.run(itemId, locId);
  else setQty.run(itemId, locId, next);
}

// from = null → entrée de matériel (achat, retour externe)
// to   = null → sortie définitive (HS, rendu, perdu)
// Note automatique quand l'utilisateur n'en écrit pas : « Montage Salle X » / « Démontage Salle X »
function autoNote(from, to) {
  const get = (id) => (id ? db.prepare('SELECT name, kind FROM locations WHERE id=?').get(id) : null);
  const f = get(from), t = get(to);
  if (f?.kind === 'stock' && t?.kind === 'salle') return `Montage ${t.name}`;
  if (f?.kind === 'salle' && t?.kind === 'stock') return `Démontage ${f.name}`;
  return '';
}

function moveOne({ item_id, from, to, qty, note, batch }) {
  note = String(note || '').trim() || autoNote(from, to);
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantité invalide');
  if (!from && !to) throw new Error('Choisir au moins un emplacement');
  if (from && to && from === to) throw new Error('Source et destination identiques');
  if (from) {
    const dispo = getLocationQty.get(item_id, from)?.qty || 0;
    if (dispo < qty) {
      const name = db.prepare('SELECT name FROM items WHERE id=?').get(item_id)?.name || 'matériel';
      throw new Error(`Quantité insuffisante pour « ${name} » (${dispo} disponible${dispo > 1 ? 's' : ''}, ${qty} demandé${qty > 1 ? 's' : ''})`);
    }
    adjust(item_id, from, -qty);
  }
  if (to) adjust(item_id, to, qty);
  db.prepare('INSERT INTO movements (item_id, from_location_id, to_location_id, qty, note, batch) VALUES (?,?,?,?,?,?)')
    .run(item_id, from || null, to || null, qty, note || '', batch || crypto.randomUUID());
}

// Tout ou rien : si une ligne échoue, rien n'est enregistré
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function move(m) {
  inTransaction(() => moveOne(m));
}

function moveBatch({ from, to, note, lines }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('La liste est vide');
  const batch = crypto.randomUUID(); // toutes les lignes partagent le même déplacement
  inTransaction(() => lines.forEach((l) => moveOne({ item_id: l.item_id, from, to, qty: l.qty, note, batch })));
}


// ---------------------------------------------------------------- Planning BEO
db.exec(`
CREATE TABLE IF NOT EXISTS planning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT NOT NULL,
  rooms TEXT NOT NULL, client TEXT, detail TEXT, start TEXT, end TEXT,
  tags TEXT, color TEXT, urgent INTEGER DEFAULT 0, raw TEXT, sheet TEXT, cell TEXT
);
`);
if (!db.prepare('PRAGMA table_info(planning_events)').all().some((c) => c.name === 'room_ids')) {
  db.exec('ALTER TABLE planning_events ADD COLUMN room_ids TEXT');
}
if (!db.prepare('PRAGMA table_info(planning_events)').all().some((c) => c.name === 'info')) {
  db.exec('ALTER TABLE planning_events ADD COLUMN info TEXT'); // détails venant du BEO (PDF) : lignes du tableau
}
if (!db.prepare('PRAGMA table_info(planning_events)').all().some((c) => c.name === 'done')) {
  db.exec('ALTER TABLE planning_events ADD COLUMN done TEXT'); // phases validées (« Prêt ») : ["Montage"], ["Montage","Démontage"]
}
db.exec(`UPDATE planning_events SET tags = REPLACE(tags, '"Setup"', '"Montage"') WHERE tags LIKE '%"Setup"%'`);
const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? '';
const metaSet = (k, v) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

const bumpPlanning = () => metaSet('beo_version', Number(metaGet('beo_version') || 0) + 1);
const metaJson = (k) => { try { return JSON.parse(metaGet(k) || '{}'); } catch { return {}; } };

// Matériel déplacé lors de la validation « Prêt » d'un montage / démontage d'offre (pour proposer le retour au démontage)
db.exec(`
CREATE TABLE IF NOT EXISTS offer_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  offer_id INTEGER, room_name TEXT, event_id INTEGER, phase TEXT NOT NULL,
  lines TEXT NOT NULL   -- [{ item_id, qty, from, to, offer_name }]
);
`);
// external : matériel d'une société externe (CAS…) installé / désinstallé, pas déplacé : [{ qty, name, supplier, offer_id, room_name, room_ids }]
if (!db.prepare('PRAGMA table_info(offer_moves)').all().some((c) => c.name === 'external')) db.exec('ALTER TABLE offer_moves ADD COLUMN external TEXT');
function offerMovesList() {
  return db.prepare('SELECT * FROM offer_moves ORDER BY id').all().map((m) => ({ ...m, lines: JSON.parse(m.lines), external: JSON.parse(m.external || '[]') }));
}

// version : change à chaque modification du planning (les autres postes se mettent à jour)
function beoStatus() {
  return { version: Number(metaGet('beo_version') || 0) };
}

// Rattache un nom de salle abrégé (« Caramb. », « Redw. 3 », « Canopé »… des anciens imports) aux salles de l'application
const nz = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ROOM_ALIAS = { argforet: ['arganforet2'], brasserie135: ['arganforet1'], summergarden: ['esplanade'] };
function editDist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}
function matchRoom(raw, locs) {
  const k = nz(raw);
  const named = locs.map((l) => ({ id: l.id, n: nz(l.name) }));
  if (ROOM_ALIAS[k]) return named.filter((x) => ROOM_ALIAS[k].includes(x.n)).map((x) => x.id);
  let hit = named.filter((x) => x.n === k);
  if (hit.length === 1) return [hit[0].id];
  const [, letters, digits] = /^(.*?)(\d*)$/.exec(k);
  hit = named.filter((x) => letters && x.n.startsWith(letters) && (!digits || x.n.endsWith(digits)) && (digits || !/\d$/.test(x.n)));
  if (hit.length === 1) return [hit[0].id];
  if (k.length >= 7) {
    hit = named.filter((x) => editDist(k, x.n) <= 1);
    if (hit.length === 1) return [hit[0].id];
  }
  return [];
}

function planningData() {
  const locs = db.prepare('SELECT id, name FROM locations').all();
  const known = new Set(locs.map((l) => l.id));
  const cache = {};
  const events = db.prepare('SELECT * FROM planning_events ORDER BY date, id').all().map((r) => {
    const rooms = JSON.parse(r.rooms || '[]');
    let ids = r.room_ids ? JSON.parse(r.room_ids) : [...new Set(rooms.flatMap((n) => (cache[n] ??= matchRoom(n, locs))))];
    return {
      id: r.id, date: r.date, end_date: r.end_date, rooms,
      room_ids: ids.filter((i) => known.has(i)),
      client: r.client, detail: r.detail, start: r.start, end: r.end,
      tags: JSON.parse(r.tags || '[]'), color: r.color, urgent: !!r.urgent, raw: r.raw,
      info: r.info ? JSON.parse(r.info) : null, done: JSON.parse(r.done || '[]'),
    };
  });
  return { events, offers: offersList(), offerMoves: offerMovesList(), itemMap: metaJson('offer_item_map'), status: beoStatus() };
}

const PL_TAGS = ['Montage', 'Répétition', 'Show', 'Démontage', 'Récup', 'Travaux'];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
const isTime = (t) => !t || /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
function upsertPlanningEvent(b) {
  const client = String(b.client || '').trim();
  if (!client) throw new Error('Indique le nom de la société / du client');
  if (!isDate(b.date)) throw new Error('Date invalide');
  const end_date = b.end_date || b.date;
  if (!isDate(end_date) || end_date < b.date) throw new Error('La date de fin doit être le même jour ou après la date de début');
  if (!isTime(b.start) || !isTime(b.end)) throw new Error('Horaire invalide (format HH:MM)');
  if (b.start && b.end && b.end <= b.start) throw new Error("L'heure de fin doit être après l'heure de début");
  const color = ['red', 'green', 'yellow'].includes(b.color) ? b.color : null;
  const ids = [...new Set((b.room_ids || []).map(Number))];
  if (!ids.length) throw new Error('Choisis au moins une salle');
  const rooms = ids.map((id) => db.prepare("SELECT name FROM locations WHERE id=? AND kind='salle'").get(id)?.name);
  if (rooms.some((r) => !r)) throw new Error('Salle inconnue');
  const tags = (b.tags || []).filter((t) => PL_TAGS.includes(t));
  const vals = [end_date, JSON.stringify(rooms), JSON.stringify(ids), client, String(b.detail || '').trim(), b.start || '', b.end || '',
    JSON.stringify(tags), color, b.urgent ? 1 : 0];
  if (b.id) {
    const r = db.prepare(`UPDATE planning_events SET date=?, end_date=?, rooms=?, room_ids=?, client=?, detail=?, start=?, end=?, tags=?, color=?, urgent=?, raw='', info=COALESCE(?, info) WHERE id=?`)
      .run(b.date, ...vals, b.info ? JSON.stringify(b.info) : null, b.id);
    if (!r.changes) throw new Error('Événement introuvable (déjà supprimé ?)');
  } else {
    db.prepare(`INSERT INTO planning_events (area, date, end_date, rooms, room_ids, client, detail, start, end, tags, color, urgent, raw, info)
      VALUES ('', ?,?,?,?,?,?,?,?,?,?,?, '', ?)`).run(b.date, ...vals, b.info ? JSON.stringify(b.info) : null);
  }
  return b.id || db.prepare('SELECT last_insert_rowid() id').get().id;
}
function savePlanningEvent(b) {
  upsertPlanningEvent(b);
  bumpPlanning();
  return planningData();
}

// ---- Import du BEO Book (PDF)
const pdfMapGet = () => { try { return JSON.parse(metaGet('pdf_room_map') || '{}'); } catch { return {}; } };
function previewBeoPdf(buf, filename) {
  const locs = db.prepare("SELECT id, name FROM locations WHERE kind='salle'").all();
  const saved = pdfMapGet();
  const r = beopdf.parseBeoBook(buf, beopdf.makeMatcher(locs, saved));
  const nameOf = new Map(locs.map((l) => [l.id, l.name]));
  const existing = planningData().events;
  const events = r.events.map((e, i) => {
    const same = existing.filter((x) => x.date <= e.date && e.date <= x.end_date && x.room_ids.includes(e.room_id));
    const twin = same.find((x) => beopdf.nz(x.client) === beopdf.nz(e.client));
    let state = 'new', existing_id = null;
    if (twin) {
      existing_id = twin.id;
      state = (twin.start || '') === e.start && (twin.end || '') === e.end && (twin.detail || '') === e.detail && (twin.color || '') === e.color ? (twin.info ? 'same' : 'info') : 'differs'; // 'info' : identique, mais les détails du BEO manquent
    }
    return {
      i, ...e, room_name: nameOf.get(e.room_id), state, existing_id,
      clash: !twin && same.length ? same.map((x) => x.client) : [],
      selected: (state === 'new' && e.hasAv) || state === 'info',
    };
  });
  const dates = events.map((e) => e.date).sort();
  return {
    filename, beoCount: r.beoCount, events, warnings: r.warnings,
    from: dates[0] || null, to: dates[dates.length - 1] || null,
    unmatched: r.unmatched.map((u) => ({ ...u, key: beopdf.nz(u.name).replace(/\+/g, ''), saved: saved[beopdf.nz(u.name).replace(/\+/g, '')] || [] })),
  };
}

// ---- Fiches techniques (« Offres ») : le PDF est conservé et affiché dans le planning au jour du montage
db.exec(`
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  filename TEXT, client TEXT NOT NULL, version TEXT, title TEXT, dated TEXT,
  rooms TEXT NOT NULL,   -- [{ name, room_ids, page, setup, show_from, show_to, show_raw, items:[{qty,name,section,kind,supplier}] }]
  services TEXT          -- techniciens, transport… (pas liés à une salle)
);
`);
// links : ce que l'offre a ajouté au planning [{ id: événement, tag, created }] → retiré si l'offre est supprimée ou remplacée
if (!db.prepare('PRAGMA table_info(offers)').all().some((c) => c.name === 'links')) db.exec('ALTER TABLE offers ADD COLUMN links TEXT');
const OFFER_DIR = path.join(DATA_DIR, 'fichiers', 'offres');
fs.mkdirSync(OFFER_DIR, { recursive: true });
const offerFile = (id) => path.join(OFFER_DIR, `${Number(id)}.pdf`);
const tmpFile = (token) => {
  if (!/^[0-9a-f-]{36}$/.test(token || '')) throw new Error('Envoi expiré : choisis à nouveau le fichier');
  return path.join(OFFER_DIR, `tmp-${token}.pdf`);
};

function offersList() {
  const known = new Set(db.prepare("SELECT id FROM locations WHERE kind='salle'").all().map((l) => l.id));
  return db.prepare('SELECT * FROM offers ORDER BY id').all().map((o) => ({
    id: o.id, ts: o.ts, filename: o.filename, client: o.client, version: o.version, title: o.title, dated: o.dated,
    rooms: JSON.parse(o.rooms).map((r) => ({ ...r, room_ids: (r.room_ids || []).filter((i) => known.has(i)) })),
    services: JSON.parse(o.services || '[]'),
  }));
}

// Lecture d'une fiche envoyée : on garde le PDF en attente (tmp-…) jusqu'à la validation
function previewOffer(buf, filename) {
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error("Ce fichier n'est pas un PDF");
  for (const f of fs.readdirSync(OFFER_DIR)) { // ménage : envois abandonnés depuis plus d'un jour
    const p = path.join(OFFER_DIR, f);
    if (f.startsWith('tmp-') && Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { force: true });
  }
  const token = crypto.randomUUID();
  fs.writeFileSync(tmpFile(token), buf);
  let parsed;
  try { parsed = offrepdf.parseOffer(buf); } catch (e) {
    return { token, filename, manual: true, reason: e.message, client: path.basename(filename || '', path.extname(filename || '')) };
  }
  const match = beopdf.makeMatcher(db.prepare("SELECT id, name FROM locations WHERE kind='salle'").all(), pdfMapGet());
  // la fiche ne donne pas de date de démontage : par défaut le dernier jour de show (modifiable dans l'aperçu)
  const rooms = parsed.rooms.map((r) => ({ ...r, demontage: r.show_to || r.show_from, room_ids: match(r.name), key: beopdf.nz(r.name).replace(/\+/g, '') }));
  // même client et même salle/jour de show qu'une offre déjà enregistrée → c'est probablement une nouvelle version
  const k = (n, d) => `${beopdf.nz(n)}|${d}`;
  const mine = new Set(rooms.map((r) => k(r.name, r.show_from)));
  const replaces = offersList().filter((o) => beopdf.nz(o.client) === beopdf.nz(parsed.client) && o.rooms.some((r) => mine.has(k(r.name, r.show_from))))
    .map((o) => ({ id: o.id, version: o.version, ts: o.ts, filename: o.filename }));
  return { token, filename, manual: false, ...parsed, rooms, replaces };
}

// ---- Étiquettes Montage / Show / Démontage ajoutées au planning par une offre
// Même société ? « EU Aluminium » ≈ « (CVENT) European Aluminium » : un mot significatif en commun suffit
const CLIENT_STOP = new Set(['the', 'and', 'des', 'les', 'group', 'groupe', 'meeting', 'meetings', 'event', 'events', 'international', 'europe', 'european', 'belgium', 'belgique', 'company', 'sprl', 'srl', 'asbl']);
const clientWords = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !CLIENT_STOP.has(w));
function sameClient(a, b) {
  if (beopdf.nz(a) && beopdf.nz(a) === beopdf.nz(b)) return true;
  const wb = new Set(clientWords(b));
  return clientWords(a).some((w) => wb.has(w));
}
// jours de chaque phase d'une salle de l'offre : { 'AAAA-MM-JJ': ['Montage', 'Show'…] }
function offerPhases(r) {
  const out = {};
  const add = (d, t) => { if (isDate(d)) (out[d] ||= []).includes(t) || out[d].push(t); };
  add(r.setup, 'Montage');
  if (isDate(r.show_from)) for (let d = r.show_from; d <= (r.show_to || r.show_from); d = nextDay(d)) add(d, 'Show');
  add(r.demontage, 'Démontage');
  return out;
}
const nextDay = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

// Ajoute l'étiquette à l'événement de la même société dans la salle ce jour-là, sinon crée l'événement. Renvoie les liens.
function applyOffer(client, rooms) {
  const links = [];
  const names = new Map(db.prepare("SELECT id, name FROM locations WHERE kind='salle'").all().map((l) => [l.id, l.name]));
  for (const r of rooms) {
    if (r.skip || !r.room_ids.length) continue;
    for (const [day, tags] of Object.entries(offerPhases(r))) {
      const evs = planningData().events.filter((e) => e.date <= day && day <= e.end_date && sameClient(e.client, client) && e.room_ids.some((id) => r.room_ids.includes(id)));
      for (const e of evs) for (const t of tags) if (!e.tags.includes(t)) {
        e.tags.push(t);
        db.prepare('UPDATE planning_events SET tags=? WHERE id=?').run(JSON.stringify(e.tags), e.id);
        links.push({ id: e.id, tag: t, created: false });
      }
      const rest = r.room_ids.filter((id) => !evs.some((e) => e.room_ids.includes(id)));
      if (rest.length) {
        const id = Number(db.prepare(`INSERT INTO planning_events (area, date, end_date, rooms, room_ids, client, detail, start, end, tags, color, urgent, raw)
          VALUES ('', ?, ?, ?, ?, ?, '', ?, '', ?, 'red', 0, '')`).run(day, day, JSON.stringify(rest.map((i) => names.get(i))), JSON.stringify(rest), client,
            tags.includes('Show') ? '' : freeFrom(day, rest), JSON.stringify(tags)).lastInsertRowid);
        for (const t of tags) links.push({ id, tag: t, created: true });
      }
    }
  }
  return links;
}
// Un montage (ou démontage) créé par une offre commence quand la salle se libère : fin du dernier événement
// d'une autre société dans ces salles ce jour-là (ex. Nagelmackers jusqu'à 17:00 → montage à 17:00)
function freeFrom(day, roomIds, exceptId) {
  return planningData().events
    .filter((e) => e.id !== exceptId && e.date <= day && day <= e.end_date && e.end && e.room_ids.some((id) => roomIds.includes(id)))
    .reduce((m, e) => (e.end > m ? e.end : m), '');
}
// Retire ce qu'une offre avait ajouté (un événement créé par l'offre est supprimé quand il n'a plus d'étiquette)
function undoOffer(offerId) {
  const o = db.prepare('SELECT links FROM offers WHERE id=?').get(offerId);
  for (const l of JSON.parse(o?.links || '[]')) {
    const e = db.prepare('SELECT tags FROM planning_events WHERE id=?').get(l.id);
    if (!e) continue;
    const tags = JSON.parse(e.tags || '[]').filter((t) => t !== l.tag);
    if (l.created && !tags.length) db.prepare('DELETE FROM planning_events WHERE id=?').run(l.id);
    else db.prepare('UPDATE planning_events SET tags=? WHERE id=?').run(JSON.stringify(tags), l.id);
  }
}

function saveOffer(b) {
  const src = tmpFile(b.token);
  if (!fs.existsSync(src)) throw new Error('Envoi expiré : choisis à nouveau le fichier');
  const client = String(b.client || '').trim();
  if (!client) throw new Error('Indique le nom de la société / du client');
  const rooms = (b.rooms || []).map((r) => ({
    name: String(r.name || '').trim(), page: Number(r.page) || 1, setup: r.setup || null,
    show_from: r.show_from || null, show_to: r.show_to || r.show_from || null, show_raw: r.show_raw || '',
    demontage: r.demontage || null,
    room_ids: [...new Set((r.room_ids || []).map(Number))].filter((id) => db.prepare("SELECT 1 FROM locations WHERE id=? AND kind='salle'").get(id)),
    items: Array.isArray(r.items) ? r.items : [], skip: !!r.skip, // skip : salle hors application (ex. « Networking area »), pas affichée dans la grille
  }));
  if (!rooms.length) throw new Error('Aucune salle dans cette offre');
  for (const r of rooms) {
    const where = r.name ? ` pour « ${r.name} »` : '';
    if (!isDate(r.setup)) throw new Error(`Date de montage manquante ou invalide${where}`);
    if (r.show_from && (!isDate(r.show_from) || !isDate(r.show_to) || r.show_to < r.show_from)) throw new Error(`Dates de show invalides${where}`);
    if (r.demontage && !isDate(r.demontage)) throw new Error(`Date de démontage invalide${where}`);
    if (r.show_from && r.setup > r.show_from) throw new Error(`Le montage doit être avant le show${where}`);
    if (r.demontage && r.demontage < (r.show_to || r.setup)) throw new Error(`Le démontage doit être après le show${where}`);
    if (!r.room_ids.length && !r.skip) throw new Error(`Choisis la salle de l'application pour « ${r.name || 'cette offre'} »`);
  }
  let id;
  inTransaction(() => {
    for (const old of (b.replace_ids || []).map(Number)) { undoOffer(old); db.prepare('DELETE FROM offers WHERE id=?').run(old); }
    const links = applyOffer(client, rooms);
    learnEquipment(rooms);
    id = Number(db.prepare('INSERT INTO offers (filename, client, version, title, dated, rooms, services, links) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.filename || '', client, b.version || '', b.title || '', b.dated || '', JSON.stringify(rooms), JSON.stringify(b.services || []), JSON.stringify(links)).lastInsertRowid);
    bumpPlanning();
  });
  fs.renameSync(src, offerFile(id));
  for (const old of (b.replace_ids || []).map(Number)) fs.rmSync(offerFile(old), { force: true });
  return id;
}

// Équipement inclus des salles appris des fiches : on garde pour chaque élément la plus grande quantité vue.
// Salle réunie (Cocobolo = Coco 1+2+3) : la quantité est répartie si elle se divise (3 projecteurs → 1 par partie).
const equipName = (s) => String(s || '').replace(/\(([^)]{18,})\)/g, '').replace(/^dlp\s+/i, '').replace(/\s+/g, ' ').trim();
function learnEquipment(rooms) {
  for (const r of rooms) {
    const ids = (r.room_ids || []).filter((id) => !r.skip);
    const items = (r.items || []).filter((i) => i.kind === 'inclus');
    if (!ids.length || !items.length) continue;
    for (const id of ids) {
      const loc = db.prepare("SELECT equipment, equipment_src FROM locations WHERE id=? AND kind='salle'").get(id);
      if (!loc || loc.equipment_src === 'manuel') continue;
      const eq = JSON.parse(loc.equipment || '[]');
      for (const it of items) {
        if (it.qty % ids.length) continue; // ne se répartit pas entre les parties : on ne devine pas
        const qty = it.qty / ids.length, name = equipName(it.name);
        const cur = eq.find((x) => beopdf.nz(x.name) === beopdf.nz(name));
        if (cur) cur.qty = Math.max(cur.qty, qty); else eq.push({ qty, name });
      }
      db.prepare("UPDATE locations SET equipment=?, equipment_src='auto' WHERE id=?").run(JSON.stringify(eq), id);
    }
  }
}
// « 2 × Projecteur », « 2x Projecteur », « Projecteur » (une ligne par élément)
const parseEquipment = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
  const m = /^(\d+)\s*[x×*]?\s+(.+)$/i.exec(l);
  return m ? { qty: Number(m[1]), name: m[2].trim() } : { qty: 1, name: l };
});

// Offres enregistrées avant les étiquettes automatiques : on les ajoute une fois (démontage = dernier jour de show)
{
  const old = db.prepare('SELECT id, client, rooms FROM offers WHERE links IS NULL').all();
  if (old.length) inTransaction(() => {
    for (const o of old) {
      const rooms = JSON.parse(o.rooms).map((r) => ({ ...r, demontage: r.demontage || r.show_to || r.show_from || null }));
      db.prepare('UPDATE offers SET rooms=?, links=? WHERE id=?').run(JSON.stringify(rooms), JSON.stringify(applyOffer(o.client, rooms)), o.id);
    }
    bumpPlanning();
  });
  // montages créés avant la règle « après le dernier événement de la salle » : on leur donne l'heure de début
  let fixed = 0;
  for (const o of db.prepare('SELECT links FROM offers').all()) for (const l of JSON.parse(o.links || '[]')) {
    if (!l.created) continue;
    const e = db.prepare('SELECT date, room_ids, start, tags FROM planning_events WHERE id=?').get(l.id);
    if (!e || e.start || JSON.parse(e.tags || '[]').includes('Show')) continue;
    const t = freeFrom(e.date, JSON.parse(e.room_ids || '[]'), l.id);
    if (t) { db.prepare('UPDATE planning_events SET start=? WHERE id=?').run(t, l.id); fixed++; }
  }
  if (fixed) bumpPlanning();
  // équipement inclus appris des fiches déjà enregistrées (sans effet sur les salles saisies à la main)
  for (const o of db.prepare('SELECT rooms FROM offers').all()) learnEquipment(JSON.parse(o.rooms));
}

// ---- Validation « Prêt » d'un montage / démontage d'offre : déplacement du matériel Dolce stock ⇄ salle
const PHASES = ['Montage', 'Démontage'];

// b = { event: {…comme /api/planning/event}, phase, offer_id, room_name, lines: [{ item_id | new_item:{name, category, stock_qty}, qty, from, to, offer_name }] }
function validatePhase(b) {
  const phase = b.phase;
  if (!PHASES.includes(phase)) throw new Error('Étape inconnue (montage ou démontage)');
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => Number(l.qty) > 0);
  const kind = (id) => db.prepare('SELECT kind FROM locations WHERE id=?').get(id)?.kind;
  let moved = 0;
  inTransaction(() => {
    const id = upsertPlanningEvent(b.event);
    const ev = db.prepare('SELECT client, tags, done, rooms FROM planning_events WHERE id=?').get(id);
    const itemMap = metaJson('offer_item_map');
    const done = [];
    for (const l of lines) {
      const from = Number(l.from), to = Number(l.to), qty = Number(l.qty);
      if (phase === 'Montage' && (kind(from) !== 'stock' || kind(to) !== 'salle')) throw new Error('Montage : le matériel part d\'un stock vers une salle');
      if (phase === 'Démontage' && (kind(from) !== 'salle' || kind(to) !== 'stock')) throw new Error('Démontage : le matériel revient d\'une salle vers un stock');
      let itemId = Number(l.item_id);
      if (l.new_item) { // matériel pas encore au catalogue : créé avec la quantité qu'on a en stock
        const name = String(l.new_item.name || '').trim();
        if (!name) throw new Error('Nom du nouveau matériel manquant');
        const existing = db.prepare('SELECT id FROM items WHERE lower(name)=lower(?)').get(name);
        itemId = existing ? existing.id : Number(db.prepare('INSERT INTO items (name, category, notes) VALUES (?,?,?)').run(name, resolveCategory(l.new_item.category), '').lastInsertRowid);
        const sq = Number(l.new_item.stock_qty);
        if (sq > 0) moveOne({ item_id: itemId, from: null, to: from, qty: sq, note: 'Ajout au catalogue (fiche technique)' });
      }
      if (!db.prepare('SELECT 1 FROM items WHERE id=?').get(itemId)) throw new Error('Matériel introuvable');
      if (l.offer_name) itemMap[beopdf.nz(l.offer_name).replace(/\+/g, '')] = itemId; // retenu pour les prochaines fiches
      done.push({ item_id: itemId, qty, from, to, offer_name: l.offer_name || '', offer_id: Number(l.offer_id) || null, room_name: l.room_name || '' });
    }
    // un déplacement par trajet (stock → salle) pour un historique lisible
    const rooms = JSON.parse(ev.rooms || '[]').join(', ');
    const groups = new Map();
    for (const l of done) { const k = `${l.from}>${l.to}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
    for (const g of groups.values()) {
      const batch = crypto.randomUUID();
      for (const l of g) { moveOne({ item_id: l.item_id, from: l.from, to: l.to, qty: l.qty, note: `${phase} ${rooms} — ${ev.client}`, batch }); moved += l.qty; }
    }
    metaSet('offer_item_map', JSON.stringify(itemMap));
    const external = (Array.isArray(b.external) ? b.external : []).filter((x) => Number(x.qty) > 0 && String(x.name || '').trim()).map((x) => ({
      qty: Number(x.qty), name: String(x.name).trim(), supplier: String(x.supplier || '').trim(), offer_id: Number(x.offer_id) || null,
      room_name: x.room_name || '', room_ids: (x.room_ids || []).map(Number),
    }));
    db.prepare('INSERT INTO offer_moves (offer_id, room_name, event_id, phase, lines, external) VALUES (?,?,?,?,?,?)')
      .run(Number(b.offer_id) || done[0]?.offer_id || external[0]?.offer_id || null, b.room_name || done[0]?.room_name || external[0]?.room_name || '', id, phase, JSON.stringify(done), JSON.stringify(external));
    // phases validées ; la case devient verte quand toutes ses phases (montage / démontage) sont faites
    const tags = JSON.parse(ev.tags || '[]');
    const doneP = [...new Set([...JSON.parse(ev.done || '[]'), phase])];
    const all = tags.filter((t) => PHASES.includes(t)).every((t) => doneP.includes(t));
    db.prepare('UPDATE planning_events SET done=?, color=? WHERE id=?').run(JSON.stringify(doneP), all ? 'green' : 'red', id);
    bumpPlanning();
  });
  return { moved, ...planningData() };
}

// Annuler la validation d'une phase (case validée par erreur) : remet le matériel à sa place et retire la phase
// b = { event, phase, lines: [{ item_id, qty, from, to }] } — lines = trajets inverses de ceux enregistrés
function undoPhase(b) {
  const phase = b.phase;
  if (!PHASES.includes(phase)) throw new Error('Étape inconnue (montage ou démontage)');
  let moved = 0;
  inTransaction(() => {
    const id = upsertPlanningEvent({ ...b.event, color: b.event.color === 'green' ? 'red' : b.event.color });
    const ev = db.prepare('SELECT client, done, rooms FROM planning_events WHERE id=?').get(id);
    if (!JSON.parse(ev.done || '[]').includes(phase)) throw new Error(`Le ${phase.toLowerCase()} n'est pas validé dans cette case`);
    const batch = crypto.randomUUID();
    for (const l of (b.lines || []).filter((x) => Number(x.qty) > 0)) {
      moveOne({ item_id: Number(l.item_id), from: Number(l.from), to: Number(l.to), qty: Number(l.qty), note: `Annulation ${phase.toLowerCase()} ${JSON.parse(ev.rooms || '[]').join(', ')} — ${ev.client}`, batch });
      moved += Number(l.qty);
    }
    db.prepare('DELETE FROM offer_moves WHERE event_id=? AND phase=?').run(id, phase);
    db.prepare('UPDATE planning_events SET done=? WHERE id=?').run(JSON.stringify(JSON.parse(ev.done || '[]').filter((p) => p !== phase)), id);
    bumpPlanning();
  });
  return { moved, ...planningData() };
}

// Catégories : "micro", "Micro", "MICROS", " micros " → la catégorie existante la plus ancienne ("Micros")
const catKey = (s) => {
  let k = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (k.length > 3) k = k.replace(/[sx]$/, ''); // pluriel simple
  return k;
};
function resolveCategory(input) {
  const clean = String(input || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Autre';
  const key = catKey(clean);
  const existing = db.prepare('SELECT category FROM items ORDER BY id').all().find((r) => catKey(r.category) === key);
  if (existing) return existing.category;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const routes = {
  'GET /api/version': () => ({ build: BUILD }),
  'GET /api/data': () => ({
    locations: db.prepare('SELECT * FROM locations ORDER BY id').all(),
    items: db.prepare('SELECT * FROM items ORDER BY category, name').all(),
    stock: db.prepare('SELECT * FROM stock').all(),
  }),
  'GET /api/planning': () => planningData(),
  'GET /api/planning/status': () => beoStatus(),
  'POST /api/planning/event': (b) => savePlanningEvent(b),
  'POST /api/planning/pdf/mapping': (b) => {
    const k = beopdf.nz(b.name).replace(/\+/g, '');
    if (!k) throw new Error('Nom de salle vide');
    const map = pdfMapGet();
    const ids = [...new Set((b.room_ids || []).map(Number))].filter((id) => db.prepare("SELECT 1 FROM locations WHERE id=? AND kind='salle'").get(id));
    if (ids.length) map[k] = ids; else delete map[k];
    metaSet('pdf_room_map', JSON.stringify(map));
    return { ok: true };
  },
  'POST /api/planning/pdf/import': (b) => {
    const list = Array.isArray(b.events) ? b.events : [];
    if (!list.length) throw new Error('Aucun événement sélectionné');
    let added = 0, updated = 0; const skipped = [];
    inTransaction(() => {
      for (const e of list) {
        const old = e.replace_id ? db.prepare('SELECT * FROM planning_events WHERE id=?').get(e.replace_id) : null;
        if (old && e.info_only) { db.prepare('UPDATE planning_events SET info=? WHERE id=?').run(JSON.stringify(e.info), old.id); updated++; continue; }
        const ev = {
          id: old ? old.id : null, date: e.date, end_date: old ? old.end_date : e.date, room_ids: [e.room_id],
          client: e.client, detail: e.detail, start: e.start, end: e.end, color: e.color,
          tags: old ? JSON.parse(old.tags || '[]') : [], urgent: old ? !!old.urgent : false, info: e.info || null,
        };
        if (old) { ev.room_ids = JSON.parse(old.room_ids || '[]'); if (!ev.room_ids.includes(e.room_id)) ev.room_ids.push(e.room_id); ev.date = old.date; }
        try { upsertPlanningEvent(ev); if (old) updated++; else added++; }
        catch (err) { skipped.push(`${e.client} (${e.date}) : ${err.message}`); }
      }
      bumpPlanning();
    });
    return { added, updated, skipped, ...planningData() };
  },
  'POST /api/planning/phase': (b) => validatePhase(b),
  'POST /api/planning/phase/undo': (b) => undoPhase(b),
  'POST /api/offers/save': (b) => {
    saveOffer(b);
    return planningData();
  },
  'POST /api/offers/delete': (b) => {
    if (!db.prepare('SELECT 1 FROM offers WHERE id=?').get(b.id)) throw new Error('Offre introuvable (déjà supprimée ?)');
    inTransaction(() => { undoOffer(b.id); db.prepare('DELETE FROM offers WHERE id=?').run(b.id); });
    fs.rmSync(offerFile(b.id), { force: true });
    bumpPlanning();
    return planningData();
  },
  'POST /api/planning/event/delete': (b) => {
    db.prepare('DELETE FROM planning_events WHERE id=?').run(b.id);
    bumpPlanning();
    return planningData();
  },
  // Historique : un élément par déplacement (avec la liste du matériel déplacé)
  'GET /api/movements': () => {
    const rows = db.prepare(`SELECT m.id, m.ts, m.qty, m.note, m.batch, m.from_location_id, m.to_location_id,
        i.name item, i.category, lf.name from_name, lt.name to_name, lf.kind from_kind, lt.kind to_kind
      FROM movements m JOIN items i ON i.id=m.item_id
      LEFT JOIN locations lf ON lf.id=m.from_location_id
      LEFT JOIN locations lt ON lt.id=m.to_location_id
      ORDER BY m.id DESC LIMIT 3000`).all();
    const groups = new Map();
    for (const r of rows) {
      // anciennes lignes (sans identifiant) : même seconde, même source, même destination, même note
      const key = r.batch || `legacy|${r.ts}|${r.from_location_id}|${r.to_location_id}|${r.note}`;
      let g = groups.get(key);
      if (!g) {
        // un emplacement supprimé depuis (id présent mais plus de nom) ne doit pas passer pour « Extérieur »
        const gone = '(emplacement supprimé)';
        g = {
          id: key, ts: r.ts, note: r.note, lines: [], total_qty: 0,
          from_name: r.from_location_id && !r.from_name ? gone : r.from_name,
          to_name: r.to_location_id && !r.to_name ? gone : r.to_name,
          from_kind: r.from_kind, to_kind: r.to_kind,
        };
        groups.set(key, g);
      }
      g.lines.push({ item: r.item, category: r.category, qty: r.qty });
      g.total_qty += r.qty;
    }
    return [...groups.values()].slice(0, 100).map((g) => ({ ...g, lines: g.lines.reverse() }));
  },
  'POST /api/items': (b) => {
    if (!b.name?.trim()) throw new Error('Nom requis');
    const category = resolveCategory(b.category);
    const r = db.prepare('INSERT INTO items (name, category, notes) VALUES (?,?,?)')
      .run(b.name.trim(), category, b.notes || '');
    return { id: Number(r.lastInsertRowid), category };
  },
  // Modifier une fiche du catalogue (nom, catégorie) et, au passage, ajouter des pièces dans un stock
  'POST /api/items/update': (b) => {
    if (!b.name?.trim()) throw new Error('Nom requis');
    if (!db.prepare('SELECT 1 FROM items WHERE id=?').get(b.id)) throw new Error('Matériel introuvable');
    const category = resolveCategory(b.category);
    inTransaction(() => {
      db.prepare('UPDATE items SET name=?, category=? WHERE id=?').run(b.name.trim(), category, b.id);
      if (b.add && Number(b.add.qty) > 0) {
        const loc = db.prepare('SELECT kind FROM locations WHERE id=?').get(b.add.location_id);
        if (!loc || loc.kind !== 'stock') throw new Error('Les pièces ne peuvent être ajoutées que dans un stock');
        moveOne({ item_id: b.id, from: null, to: b.add.location_id, qty: b.add.qty, note: 'Ajout depuis le catalogue' });
      }
    });
    return { ok: true, category };
  },
  // Supprimer définitivement une fiche : seulement s'il ne reste aucune pièce et aucun retrait conservé
  'POST /api/items/delete': (b) => {
    if (!db.prepare('SELECT 1 FROM items WHERE id=?').get(b.id)) throw new Error('Matériel introuvable');
    const total = db.prepare('SELECT COALESCE(SUM(qty),0) t FROM stock WHERE item_id=?').get(b.id).t;
    if (total > 0) throw new Error(`Il reste ${total} pièce${total > 1 ? 's' : ''} (en stock ou en salle) : impossible de supprimer la fiche`);
    if (db.prepare('SELECT COUNT(*) c FROM retired WHERE item_id=?').get(b.id).c > 0)
      throw new Error('Ce matériel a un historique de retrait (« Matériel retiré ») : sa fiche est conservée');
    let removed = 0;
    inTransaction(() => {
      removed = Number(db.prepare('DELETE FROM movements WHERE item_id=?').run(b.id).changes);
      db.prepare('DELETE FROM items WHERE id=?').run(b.id);
    });
    return { ok: true, removed_movements: removed };
  },
  // Retrait d'une quantité de matériel, uniquement depuis un stock (jamais depuis une salle)
  'POST /api/retire': (b) => {
    const loc = db.prepare('SELECT kind FROM locations WHERE id=?').get(b.location_id);
    if (!loc) throw new Error('Emplacement introuvable');
    if (loc.kind !== 'stock') throw new Error('Le matériel ne peut être retiré que depuis un stock : ramène-le d\'abord en stock');
    const note = (b.note || '').trim();
    inTransaction(() => {
      moveOne({ item_id: b.item_id, from: b.location_id, to: null, qty: b.qty, note: 'Retiré' + (note ? ' : ' + note : '') });
      db.prepare('INSERT INTO retired (item_id, from_location_id, qty, status, note) VALUES (?,?,?,?,?)')
        .run(b.item_id, b.location_id, Number(b.qty), 'retire', note);
    });
    return { ok: true };
  },
  'GET /api/retired': () =>
    db.prepare(`SELECT r.*, i.name item, i.category, l.name from_name
      FROM retired r JOIN items i ON i.id=r.item_id
      LEFT JOIN locations l ON l.id=r.from_location_id
      ORDER BY r.id DESC LIMIT 200`).all(),
  'POST /api/locations': (b) => {
    if (!b.name?.trim()) throw new Error('Nom requis');
    const kind = b.kind === 'stock' ? 'stock' : 'salle';
    const floor = kind === 'salle' && b.floor !== '' && b.floor != null ? Number(b.floor) : null;
    db.prepare('INSERT INTO locations (name, kind, floor) VALUES (?,?,?)').run(b.name.trim(), kind, floor);
    return { ok: true };
  },
  'POST /api/locations/update': (b) => {
    if (!b.name?.trim()) throw new Error('Nom requis');
    const loc = db.prepare('SELECT kind FROM locations WHERE id=?').get(b.id);
    if (!loc) throw new Error('Emplacement introuvable');
    const floor = loc.kind === 'salle' && b.floor !== '' && b.floor != null ? Number(b.floor) : null;
    db.prepare('UPDATE locations SET name=?, floor=? WHERE id=?').run(b.name.trim(), floor, b.id);
    // équipement modifié à la main : il ne sera plus complété automatiquement par les fiches
    if (loc.kind === 'salle' && typeof b.equipment === 'string') {
      const eq = parseEquipment(b.equipment);
      const before = db.prepare('SELECT equipment FROM locations WHERE id=?').get(b.id).equipment || '[]';
      if (JSON.stringify(eq) !== JSON.stringify(JSON.parse(before))) db.prepare("UPDATE locations SET equipment=?, equipment_src='manuel' WHERE id=?").run(JSON.stringify(eq), b.id);
    }
    return { ok: true };
  },
  'POST /api/locations/floor': (b) => {
    const floor = b.floor === '' || b.floor == null ? null : Number(b.floor);
    db.prepare("UPDATE locations SET floor=? WHERE id=? AND kind='salle'").run(floor, b.id);
    return { ok: true };
  },
  'POST /api/locations/rename': (b) => {
    if (!b.name?.trim()) throw new Error('Nom requis');
    db.prepare('UPDATE locations SET name=? WHERE id=?').run(b.name.trim(), b.id);
    return { ok: true };
  },
  'POST /api/locations/delete': (b) => {
    const used = db.prepare('SELECT COUNT(*) c FROM stock WHERE location_id=?').get(b.id).c;
    if (used > 0) throw new Error('Cet emplacement contient encore du matériel : déplace-le d\'abord');
    db.prepare('DELETE FROM locations WHERE id=?').run(b.id);
    return { ok: true };
  },
  'POST /api/move-batch': (b) => {
    moveBatch(b);
    return { ok: true };
  },
  'POST /api/move': (b) => {
    move(b);
    return { ok: true };
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// Version = celle de package.json (les pages ouvertes se rechargent toutes seules quand elle change)
const BUILD = 'v' + require('./package.json').version;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Envois de fichiers PDF depuis le navigateur : corps binaire + en-tête X-Filename
  const binary = {
    '/api/planning/pdf/preview': (buf, filename) => previewBeoPdf(buf, filename),
    '/api/offers/preview': (buf, filename) => previewOffer(buf, filename),
  };
  // Affichage du PDF d'une offre dans le navigateur
  const op = /^\/api\/offers\/(\d+)\/pdf$/.exec(url.pathname);
  if (req.method === 'GET' && op) {
    const o = db.prepare('SELECT filename FROM offers WHERE id=?').get(op[1]);
    if (!o || !fs.existsSync(offerFile(op[1]))) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Offre introuvable (supprimée ?)'); }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(o.filename || `offre-${op[1]}.pdf`)}` });
    return fs.createReadStream(offerFile(op[1])).pipe(res);
  }
  if (req.method === 'POST' && binary[url.pathname]) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 40e6) chunks.push(c); });
    req.on('end', () => {
      try {
        if (size > 40e6) throw new Error('Fichier trop volumineux');
        const filename = decodeURIComponent(req.headers['x-filename'] || '');
        const out = binary[url.pathname](Buffer.concat(chunks), filename);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        console.log(`[ERREUR] ${url.pathname} -> ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const out = handler(body ? JSON.parse(body) : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        const msg = /UNIQUE/.test(e.message) ? 'Ce nom existe déjà' : e.message;
        console.log(`[ERREUR] ${req.method} ${url.pathname} -> ${e.message}\n         données reçues : ${body.slice(0, 300)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (url.pathname.startsWith('/api/')) console.log(`[404] ${req.method} ${url.pathname} : action inconnue de ce serveur`);
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// Lancé directement (node server.js) : démarre tout de suite.
// Chargé par l'application installée (electron/main.js) : c'est elle qui appelle start().
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.off('error', reject); resolve({ port, build: BUILD, dataDir: DATA_DIR }); });
  });
}
module.exports = { start, BUILD, DATA_DIR };

if (require.main === module) {
  start().then(() => {
    console.log(`Dolce AV (${BUILD}) sur http://localhost:${PORT}`);
    console.log(`Données : ${DATA_DIR}`);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\nERREUR : le port ${PORT} est déjà utilisé.`);
      console.log('Une ancienne fenêtre du serveur (ou l\'application Dolce AV en mode serveur) tourne encore.');
      console.log('Ferme-la, ou termine « Node.js JavaScript Runtime » dans le Gestionnaire des tâches, puis relance : node server.js\n');
      process.exit(1);
    }
    throw e;
  });
}
