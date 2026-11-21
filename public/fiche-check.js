// « À vérifier avant la fiche du jour » : ce qui aurait dû être fait hier (ou les jours d'avant, 7 jours au plus) ou être prêt
// pour aujourd'hui, et qui n'est pas validé dans l'application. Même règle pour le planning (fenêtre ouverte par le bouton
// « Fiche du jour ») et pour la fiche elle-même (avant d'imprimer : on prévient s'il reste des lignes sans réponse).
//  - étape passée pas validée : montage (premier jour de la case) ou démontage (dernier jour) avant aujourd'hui ;
//  - case d'aujourd'hui encore « À préparer » : elle aurait dû être prête (préparée hier). Sauf nos propres montages /
//    démontages du jour (créés par une fiche technique, sans heure de fin) : c'est le travail d'aujourd'hui ; et sauf une case
//    dont il ne reste que le démontage (aujourd'hui ou plus tard). La valider = son montage s'il en a un, sinon « Prêt » ;
//  - action à faire dans une salle, prévue un jour passé et pas cochée « fait ».
// Une réponse « pas fait » est gardée par le serveur pour la journée (planningData().ficheCheck[jour].skipped) :
// la ligne reste à faire et apparaît sur la fiche, la fenêtre ne la redemande pas.
(function () {
  const PHASES = ['Montage', 'Démontage'];
  const BACK = 7; // jours en arrière
  const pad2 = (n) => String(n).padStart(2, '0');
  const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; };
  const isOurJob = (e) => !e.end && e.tags.length > 0 && e.tags.every((t) => PHASES.includes(t));

  // data = { events, actions } (réponse de /api/planning) → [{ id, kind: 'phase' | 'ready' | 'action', when: 'before' | 'today', date, ev?, phases?, action? }]
  function items(data, today) {
    const from = addDays(today, -BACK);
    const out = [];
    for (const e of data.events || []) {
      // « Prêt » : tout est fait ; « Prospect » : pas confirmé
      if (!e.room_ids.length || e.color === 'green' || e.color === 'yellow') continue;
      const done = e.done || [];
      const left = e.tags.filter((t) => PHASES.includes(t) && !done.includes(t));
      const late = left.filter((t) => (t === 'Montage' ? e.date : e.end_date) < today && (t === 'Montage' ? e.date : e.end_date) >= from);
      if (late.length) {
        out.push({ id: `ev:${e.id}`, kind: 'phase', when: 'before', date: late.includes('Démontage') ? e.end_date : e.date, ev: e, phases: late });
      } else if (e.color === 'red' && !done.length && !isOurJob(e) && e.date <= today && today <= e.end_date && (!left.length || left.includes('Montage'))) {
        // (case dont il ne reste que le démontage, aujourd'hui ou plus tard : rien à préparer, le démontage est sur la fiche)
        out.push({ id: `ev:${e.id}`, kind: 'ready', when: 'today', date: today, ev: e });
      }
    }
    for (const a of data.actions || []) {
      if (!a.done_ts && a.date < today && a.date >= from) out.push({ id: `act:${a.id}`, kind: 'action', when: 'before', date: a.date, action: a });
    }
    const room = (x) => (x.ev ? x.ev.room_ids[0] : x.action.room_ids[0]) || 0;
    const time = (x) => (x.ev ? x.ev.start : x.action.time) || '99';
    out.sort((a, b) => (a.when === b.when ? 0 : a.when === 'before' ? -1 : 1) || a.date.localeCompare(b.date) || room(a) - room(b) || time(a).localeCompare(time(b)));
    return out;
  }
  // réponses « pas fait » enregistrées pour ce jour
  const skipped = (data, day) => new Set((data.ficheCheck?.[day]?.skipped) || []);
  // lignes encore sans réponse : ni validées dans l'application, ni marquées « pas fait »
  const open = (data, day) => { const s = skipped(data, day); return items(data, day).filter((x) => !s.has(x.id)); };
  // « Démontage pas validé », « Montage et démontage pas validés », « Pas encore « Prêt » », « Action pas faite »
  function title(x) {
    if (x.kind === 'action') return 'Action pas faite';
    if (x.kind === 'ready') return 'Pas encore « Prêt »';
    return x.phases.length > 1 ? 'Montage et démontage pas validés' : `${x.phases[0]} pas validé`;
  }
  function actionText(a) {
    return a.kind === 'autre' ? a.name : `${a.kind === 'ajouter' ? 'Ajouter' : 'Enlever'} ${a.qty} × ${a.name}`;
  }
  window.FicheCheck = { items, open, skipped, title, actionText, isOurJob, BACK };
})();
