#!/usr/bin/env node
/**
 * update.js — modifie data/planning.json de façon sûre (validation + JSON propre).
 * C'est la "porte d'entrée" commune : Claude, une GitHub Action, un formulaire… tous passent par ici.
 *
 * Exemples :
 *   node update.js garde 2026-10-07 mamimo
 *   node update.js garde 2026-10-14 diane
 *   node update.js garde-supprimer 2026-10-14
 *   node update.js absence younette 2026-12-20 2026-12-27 "Younette à Marrakech"
 *   node update.js absence-supprimer younette 2026-12-20
 *   node update.js vacances andy 2027-03-24 2027-03-24 "Sortie scolaire annulée"
 *   node update.js activite-horaire andy 3 "Graphologie" 14h30 15h10
 *   node update.js liste                      # affiche les mercredis à définir
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data/planning.json');
const D = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const [cmd, ...a] = process.argv.slice(2);

const fail = m => { console.error('✖ ' + m); process.exit(1); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));
const dow = s => new Date(s + 'T00:00:00').getDay();
const who = k => { if (!D.caregivers[k]) fail(`personne inconnue "${k}" (attendu : ${Object.keys(D.caregivers).join(', ')})`); return k; };
const child = k => { if (!D.children[k]) fail(`enfant inconnu "${k}" (attendu : ${Object.keys(D.children).join(', ')})`); return k; };
const save = msg => { fs.writeFileSync(FILE, JSON.stringify(D, null, 2) + '\n'); console.log('✔ ' + msg); };

switch (cmd) {
  case 'garde': {
    const [date, k] = a;
    if (!isDate(date)) fail('date attendue AAAA-MM-JJ');
    if (dow(date) !== 3) fail(`${date} n'est pas un mercredi`);
    who(k);
    D.careSchedule[date] = k;
    D.careSchedule = Object.fromEntries(Object.entries(D.careSchedule).sort());
    save(`mercredi ${date} → ${D.caregivers[k].name}`); break;
  }
  case 'garde-supprimer': {
    const [date] = a;
    if (!D.careSchedule[date]) fail(`aucune garde le ${date}`);
    delete D.careSchedule[date]; save(`garde du ${date} supprimée`); break;
  }
  case 'absence': {
    const [k, start, end, ...name] = a;
    who(k); if (!isDate(start) || !isDate(end) || end < start) fail('dates attendues AAAA-MM-JJ (début ≤ fin)');
    D.absences.push({ who: k, start, end, name: name.join(' ') || `Absence de ${D.caregivers[k].name}` });
    D.absences.sort((x, y) => x.start.localeCompare(y.start));
    save(`absence ${D.caregivers[k].name} du ${start} au ${end}`); break;
  }
  case 'absence-supprimer': {
    const [k, start] = a;
    const n = D.absences.length; D.absences = D.absences.filter(x => !(x.who === k && x.start === start));
    if (n === D.absences.length) fail('absence introuvable'); save('absence supprimée'); break;
  }
  case 'vacances': {
    const [k, start, end, ...name] = a;
    child(k); if (!isDate(start) || !isDate(end) || end < start) fail('dates attendues AAAA-MM-JJ');
    D.children[k].vacations.push({ start, end, name: name.join(' ') || 'Fermeture' });
    D.children[k].vacations.sort((x, y) => x.start.localeCompare(y.start));
    save(`${D.children[k].name} : pas d'école du ${start} au ${end}`); break;
  }
  case 'activite-horaire': {
    const [k, d, label, start, end] = a;
    child(k);
    const act = D.children[k].activities.find(x => x.dow === +d && x.name.toLowerCase().includes(label.toLowerCase()));
    if (!act) fail(`activité "${label}" introuvable le jour ${d} pour ${k}`);
    act.start = start; act.end = end; save(`${act.name} → ${start}-${end}`); break;
  }
  case 'liste': {
    const inVac = (s, k) => D.children[k].vacations.some(v => s >= v.start && s <= v.end && !v.partial);
    let d = new Date(D.schoolYear.start + 'T00:00:00'), end = new Date(D.schoolYear.end + 'T00:00:00');
    console.log('Mercredis :');
    for (; d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 3) continue;
      const s = d.toISOString().slice(0, 10);
      if (inVac(s, 'andy') && inVac(s, 'ariel')) continue;
      const c = D.careSchedule[s];
      console.log(`  ${s}  ${c ? D.caregivers[c].name : '⚠️  À DÉFINIR'}${inVac(s, 'andy') ? '  (Andy en vacances)' : ''}${inVac(s, 'ariel') ? '  (Ariel en vacances)' : ''}`);
    }
    break;
  }
  default:
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(cmd ? 1 : 0);
}
