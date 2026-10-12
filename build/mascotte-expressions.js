'use strict';
// Mascotte Dolce AV : un même renard (casque audio rouge) avec plusieurs expressions.
// node build/mascotte-expressions.js  → écrit public/mascotte/<expression>.svg (sans fond)
// Les identifiants internes (dégradés) sont suffixés par expression : plusieurs renards peuvent cohabiter dans une page.
const fs = require('node:fs');
const path = require('node:path');

const INK = '#2a1608';

function fox(expr = 'normal') {
  const s = `-${expr}`; // suffixe des identifiants
  const defs = `<defs>
    <linearGradient id="fur${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa64d"/><stop offset="1" stop-color="#f0741c"/></linearGradient>
    <linearGradient id="ear${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a3c"/><stop offset="1" stop-color="#e8661a"/></linearGradient>
    <radialGradient id="iris${s}" cx="0.5" cy="0.7" r="0.6"><stop offset="0" stop-color="#b8661f"/><stop offset="0.55" stop-color="#5a2a10"/><stop offset="1" stop-color="#26150b"/></radialGradient>
    <linearGradient id="cup${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8384f"/><stop offset="1" stop-color="#a8132c"/></linearGradient>
  </defs>`;
  const ears = `
    <path d="M136 236 C 132 180 140 120 158 86 C 192 110 222 146 236 180 Z" fill="url(#ear${s})"/>
    <path d="M376 236 C 380 180 372 120 354 86 C 320 110 290 146 276 180 Z" fill="url(#ear${s})"/>
    <path d="M158 212 C 156 172 160 136 168 116 C 188 134 206 156 214 178 Z" fill="#ffd9b8"/>
    <path d="M354 212 C 356 172 352 136 344 116 C 324 134 306 156 298 178 Z" fill="#ffd9b8"/>`;
  const head = `
    <path d="M256 150 C 334 150 384 196 392 256 C 396 288 414 304 440 322 C 404 334 384 354 362 378 C 332 410 296 424 256 424 C 216 424 180 410 150 378 C 128 354 108 334 72 322 C 98 304 116 288 120 256 C 128 196 178 150 256 150 Z" fill="url(#fur${s})"/>
    <path d="M232 152 C 244 170 252 176 256 192 C 260 176 268 170 280 152 C 270 150 242 150 232 152 Z" fill="#ffb867" opacity="0.9"/>
    <path d="M78 322 C 118 324 148 304 176 304 C 206 304 232 322 256 334 C 280 322 306 304 336 304 C 364 304 394 324 434 322 C 402 336 382 356 362 378 C 332 410 296 424 256 424 C 216 424 180 410 150 378 C 130 356 110 336 78 322 Z" fill="#fff6ec"/>`;
  const blush = `<ellipse cx="160" cy="326" rx="20" ry="11" fill="#ff8a9a" opacity="0.55"/><ellipse cx="352" cy="326" rx="20" ry="11" fill="#ff8a9a" opacity="0.55"/>`;
  const nose = `<path d="M242 318 Q256 310 270 318 Q264 334 256 336 Q248 334 242 318 Z" fill="${INK}"/><ellipse cx="251" cy="317" rx="4" ry="2.5" fill="#fff" opacity="0.7"/>`;
  const phones = `
    <path d="M112 262 C 104 116 408 116 400 262" fill="none" stroke="#1b2442" stroke-width="30" stroke-linecap="round"/>
    <path d="M112 262 C 104 116 408 116 400 262" fill="none" stroke="#e9edf8" stroke-width="20" stroke-linecap="round"/>
    <path d="M127 206 Q 145 180 174 166" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity="0.9"/>
    <rect x="84" y="232" width="56" height="88" rx="24" fill="url(#cup${s})" stroke="#1b2442" stroke-width="5"/>
    <rect x="372" y="232" width="56" height="88" rx="24" fill="url(#cup${s})" stroke="#1b2442" stroke-width="5"/>
    <rect x="96" y="246" width="12" height="40" rx="6" fill="#fff" opacity="0.45"/>
    <rect x="384" y="246" width="12" height="40" rx="6" fill="#fff" opacity="0.45"/>`;

  // ---- parties qui changent selon l'expression
  const eyesNormal = `
    <ellipse cx="194" cy="266" rx="28" ry="34" fill="url(#iris${s})"/><ellipse cx="318" cy="266" rx="28" ry="34" fill="url(#iris${s})"/>
    <ellipse cx="194" cy="262" rx="14" ry="18" fill="#1a0e07" opacity="0.85"/><ellipse cx="318" cy="262" rx="14" ry="18" fill="#1a0e07" opacity="0.85"/>
    <circle cx="204" cy="252" r="11" fill="#fff"/><circle cx="328" cy="252" r="11" fill="#fff"/>
    <circle cx="185" cy="282" r="5" fill="#fff" opacity="0.9"/><circle cx="309" cy="282" r="5" fill="#fff" opacity="0.9"/>
    <path d="M164 246 C 170 228 190 222 210 226" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
    <path d="M348 246 C 342 228 322 222 302 226" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
  const mouthNormal = `<path d="M238 346 Q247 356 256 346 Q265 356 274 346" fill="none" stroke="${INK}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;

  let eyes = eyesNormal, mouth = mouthNormal, extra = '', cheeks = blush;
  if (expr === 'etonne') {
    // grands yeux ronds, petites pupilles, sourcils levés, bouche en « o », traits de surprise
    eyes = `
      <ellipse cx="194" cy="266" rx="30" ry="36" fill="#fff" stroke="${INK}" stroke-width="5"/><ellipse cx="318" cy="266" rx="30" ry="36" fill="#fff" stroke="${INK}" stroke-width="5"/>
      <circle cx="194" cy="270" r="13" fill="url(#iris${s})"/><circle cx="318" cy="270" r="13" fill="url(#iris${s})"/>
      <circle cx="194" cy="270" r="6" fill="#1a0e07"/><circle cx="318" cy="270" r="6" fill="#1a0e07"/>
      <circle cx="199" cy="264" r="3.5" fill="#fff"/><circle cx="323" cy="264" r="3.5" fill="#fff"/>
      <path d="M166 214 C 178 200 200 198 214 206" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <path d="M346 214 C 334 200 312 198 298 206" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
    mouth = `<ellipse cx="256" cy="356" rx="11" ry="14" fill="${INK}"/><ellipse cx="256" cy="362" rx="7" ry="6" fill="#ff7d8c"/>`;
    extra = `<g stroke="#ffd27a" stroke-width="7" stroke-linecap="round" class="fx-pop">
      <path d="M412 112 L 432 88"/><path d="M432 146 L 462 138"/><path d="M398 84 L 402 56"/>
      <path d="M100 112 L 80 88"/><path d="M80 146 L 50 138"/></g>`;
  } else if (expr === 'impatient') {
    // paupières mi-closes, regard sur le côté, sourcils froncés, moue, goutte de sueur, bulle « … »
    eyes = `
      <ellipse cx="200" cy="270" rx="26" ry="28" fill="url(#iris${s})"/><ellipse cx="324" cy="270" rx="26" ry="28" fill="url(#iris${s})"/>
      <circle cx="208" cy="274" r="11" fill="#1a0e07" opacity="0.85"/><circle cx="332" cy="274" r="11" fill="#1a0e07" opacity="0.85"/>
      <circle cx="214" cy="268" r="5" fill="#fff"/><circle cx="338" cy="268" r="5" fill="#fff"/>
      <path d="M168 238 H 232 V 266 H 168 Z" fill="#fa9a45"/><path d="M292 238 H 356 V 266 H 292 Z" fill="#fa9a45"/>
      <path d="M170 266 Q 200 262 230 266" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <path d="M294 266 Q 324 262 354 266" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <path d="M168 230 L 222 244" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <path d="M344 230 L 290 244" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
    mouth = `<path d="M240 354 Q 250 346 260 352 Q 268 356 274 350" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    cheeks = `<ellipse cx="160" cy="326" rx="18" ry="9" fill="#ff8a9a" opacity="0.35"/><ellipse cx="352" cy="326" rx="18" ry="9" fill="#ff8a9a" opacity="0.35"/>`;
    extra = `
      <path d="M372 182 C 372 182 356 204 356 214 C 356 224 364 230 372 230 C 380 230 388 224 388 214 C 388 204 372 182 372 182 Z" fill="#9fd4ff" stroke="#4a8fd1" stroke-width="3" class="fx-drop"/>
      <g class="fx-bubble"><ellipse cx="432" cy="86" rx="62" ry="40" fill="#fff" stroke="#1b2442" stroke-width="5"/>
        <circle cx="404" cy="86" r="8" fill="#1b2442" class="fx-d1"/><circle cx="432" cy="86" r="8" fill="#1b2442" class="fx-d2"/><circle cx="460" cy="86" r="8" fill="#1b2442" class="fx-d3"/>
        <circle cx="386" cy="134" r="10" fill="#fff" stroke="#1b2442" stroke-width="4"/></g>`;
  } else if (expr === 'content') {
    // yeux fermés en arc, grand sourire
    eyes = `
      <path d="M168 270 Q 194 240 220 270" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
      <path d="M292 270 Q 318 240 344 270" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>`;
    mouth = `<path d="M232 344 Q 256 382 280 344 Z" fill="${INK}"/><path d="M242 360 Q 256 376 270 360 Q 256 366 242 360 Z" fill="#ff7d8c"/>`;
    cheeks = `<ellipse cx="160" cy="320" rx="22" ry="12" fill="#ff8a9a" opacity="0.7"/><ellipse cx="352" cy="320" rx="22" ry="12" fill="#ff8a9a" opacity="0.7"/>`;
    extra = `<path d="M430 120 l6 16 16 6 -16 6 -6 16 -6 -16 -16 -6 16 -6z" fill="#ffd27a" class="fx-pop"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="fox fox-${expr}" role="img" aria-label="Mascotte Dolce AV">${defs}${ears}${head}${eyes}${cheeks}${nose}${mouth}${phones}${extra}</svg>`;
}

module.exports = { fox, EXPRESSIONS: ['normal', 'content', 'etonne', 'impatient'] };

if (require.main === module) {
  const out = path.join(__dirname, '..', 'public', 'mascotte');
  fs.mkdirSync(out, { recursive: true });
  for (const e of module.exports.EXPRESSIONS) fs.writeFileSync(path.join(out, `${e}.svg`), fox(e));
  console.log('mascottes écrites dans', out);
}
