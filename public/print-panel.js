// Réglages d'impression partagés : aperçu des PDF (apercu.html) et fiche du jour (fiche.html).
// Dans l'application installée : choix de l'imprimante, copies, pages, couleur, recto-verso → impression directe.
// Dans un navigateur : la fenêtre d'impression du navigateur prend le relais.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const app = () => !!(window.dolceav && window.dolceav.print);

  // « 1-3, 5 » → [1, 2, 3, 5] (pages existantes uniquement)
  function parsePages(str, n) {
    const out = new Set();
    for (const part of String(str || '').split(/[,;]+/)) {
      const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) out.add(i);
    }
    return [...out].sort((x, y) => x - y);
  }

  async function mount(el, opt) {
    const n = opt.pageCount || 1;
    el.innerHTML = `
      <div class="pp-title">Imprimer</div>
      <label class="pp-f">Imprimante<select id="ppPrinter" ${app() ? '' : 'disabled'}><option>${app() ? 'Recherche des imprimantes…' : 'Choisie à l\'étape suivante'}</option></select></label>
      <label class="pp-f">Copies<input type="number" id="ppCopies" min="1" max="99" value="1"></label>
      ${n > 1 ? `<div class="pp-f"><span>Pages</span>
        <label class="pp-r"><input type="radio" name="ppPages" value="all" checked> Toutes (${n})</label>
        <label class="pp-r"><input type="radio" name="ppPages" value="some"> Pages <input id="ppRange" placeholder="ex. 1-3, 5" style="width:9em"></label></div>` : ''}
      <div class="pp-f"><span>Couleur</span><div class="pp-seg" id="ppColor"><button type="button" data-v="1" class="on">Couleur</button><button type="button" data-v="0">Noir et blanc</button></div></div>
      ${app() ? '<label class="pp-r"><input type="checkbox" id="ppDuplex"> Recto-verso</label>' : ''}
      <button type="button" class="pp-btn main" id="ppGo">🖨 Imprimer</button>
      ${opt.downloadUrl ? `<a class="pp-btn" id="ppDl" href="${esc(opt.downloadUrl)}" download="${esc(opt.downloadName || 'document.pdf')}">${esc(opt.downloadLabel || '⬇ Télécharger le PDF')}</a>` : ''}
      ${opt.extraButtons || ''}
      <button type="button" class="pp-btn ghost" id="ppClose">Fermer</button>
      <p class="pp-msg" id="ppMsg"></p>`;
    const $ = (s) => el.querySelector(s);
    if (app()) {
      try {
        const list = await window.dolceav.printers();
        // imprimante proposée : la dernière utilisée, sinon celle par défaut, sinon une vraie imprimante (pas OneNote / PDF / XPS / Fax)
        let last = ''; try { last = localStorage.getItem('printer') || ''; } catch {}
        const virtual = /onenote|pdf|xps|fax|send to/i;
        const pick = list.find((p) => p.name === last) || list.find((p) => p.isDefault) || list.find((p) => !virtual.test(p.name + ' ' + p.displayName)) || list[0];
        $('#ppPrinter').innerHTML = list.length
          ? list.map((p) => `<option value="${esc(p.name)}" ${p === pick ? 'selected' : ''}>${esc(p.displayName || p.name)}${p.isDefault ? ' (par défaut)' : ''}</option>`).join('')
          : '<option value="">Aucune imprimante trouvée</option>';
      } catch { $('#ppPrinter').innerHTML = '<option value="">Imprimantes indisponibles</option>'; }
    }
    const read = () => {
      const some = el.querySelector('input[name=ppPages][value=some]')?.checked;
      const pages = some ? parsePages($('#ppRange').value, n) : Array.from({ length: n }, (_, i) => i + 1);
      return { deviceName: app() ? $('#ppPrinter').value : '', copies: Math.max(1, Math.min(99, Number($('#ppCopies').value) || 1)), pages,
        color: $('#ppColor .on').dataset.v === '1', duplex: !!$('#ppDuplex')?.checked };
    };
    const changed = () => opt.onChange && opt.onChange(read());
    el.addEventListener('input', changed);
    el.addEventListener('change', changed);
    $('#ppColor').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      $('#ppColor').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); changed();
    });
    $('#ppRange')?.addEventListener('focus', () => { el.querySelector('input[name=ppPages][value=some]').checked = true; changed(); });
    $('#ppClose').onclick = () => (opt.onClose ? opt.onClose() : window.close());
    $('#ppGo').onclick = async () => {
      const o = read();
      if (!o.pages.length) { $('#ppMsg').textContent = 'Indique les pages à imprimer (ex. 1-3, 5).'; return; }
      if (app() && !o.deviceName) { $('#ppMsg').textContent = 'Aucune imprimante sélectionnée.'; return; }
      $('#ppGo').disabled = true; $('#ppMsg').textContent = 'Impression en cours…';
      try { if (o.deviceName) localStorage.setItem('printer', o.deviceName); } catch {}
      try { await opt.onPrint(o); $('#ppMsg').textContent = app() ? `✔ Envoyé à l'imprimante (${o.copies} copie${o.copies > 1 ? 's' : ''})` : ''; }
      catch (err) { $('#ppMsg').textContent = 'Impression impossible : ' + (err?.message || err); }
      finally { $('#ppGo').disabled = false; }
    };
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); $('#ppGo').click(); } });
    changed();
    return { read };
  }

  // impression via l'application installée (imprimante choisie, sans passer par la boîte de Windows)
  const printApp = (o, extra = {}) => window.dolceav.print({ deviceName: o.deviceName, copies: o.copies, color: o.color, duplex: o.duplex, ...extra });

  window.PrintPanel = { mount, parsePages, printApp, isApp: app };
})();
