#!/usr/bin/env node
/**
 * build.js — génère dist/index.html + dist/feeds/*.ics à partir de data/planning.json
 * Usage : node build.js
 * Aucune dépendance externe.
 * Variables d'environnement :
 *   SITE_URL    — URL publique du site (sinon DATA.site)
 *   FEED_SECRET — secret servant à rendre les noms de flux .ics non devinables (stable d'un build à l'autre)
 *
 * Modèle de données (data/planning.json) :
 *   children       — { id: { name, school, emoji, color, bg, schoolEnd{dow:"16h30"|null}, activities[], vacations[] | "autreEnfant" } }
 *   families       — [ { id, name, children[] } ]  → un flux par famille
 *   caregivers     — { id: { name, short, emoji, color, bg } } → un flux par gardien
 *   wednesday      — { needsCare[]: enfants pour qui un mercredi non attribué = "À définir",
 *                      defaults{ gardien: enfants[] }: garde par défaut le mercredi, sauf attribution explicite }
 *   careSchedule   — { "YYYY-MM-DD": { gardien: enfants[] } }  gardes journée (mercredi ou jour sans école)
 *   pickups        — { "YYYY-MM-DD": { gardien: enfants[] | { kids: enfants[], at: "16h00" } } }
 *                    sorties d'école ponctuelles ; "at" = heure de sortie anticipée (sinon l'heure habituelle de chaque enfant)
 *                    les clés commençant par "_" sont ignorées (exemples / commentaires)
 *   recurringCare  — [ { who, days[], kids?[], label, endHM } ] sorties d'école récurrentes
 *   absences       — [ { who, start, end, name } ]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/planning.json'), 'utf8'));
const rawSite = (process.env.SITE_URL || process.env.URL || DATA.site).trim().replace(/\/$/, '');
const SITE = /^https?:\/\//.test(rawSite) ? rawSite : `https://${rawSite}`;
const OUT = path.join(__dirname, 'dist');
const FEEDS = path.join(OUT, 'feeds');
fs.mkdirSync(FEEDS, { recursive: true });

const FEED_SECRET = (process.env.FEED_SECRET || '').trim();
if (!FEED_SECRET) console.warn('⚠️  FEED_SECRET non défini : les noms de flux .ics seront devinables');
const feedFile = id => FEED_SECRET
  ? `${id}-${crypto.createHash('sha256').update(FEED_SECRET + id).digest('hex').slice(0, 12)}.ics`
  : `${id}.ics`;
console.log(`Site : ${SITE} · flux ${FEED_SECRET ? 'avec' : 'SANS'} suffixe secret`);

// ---------------------------------------------------------------- normalisation des données
const CH = DATA.children, CG = DATA.caregivers;
const CHILD_IDS = Object.keys(CH);
for (const id of CHILD_IDS) {                       // "vacations": "ariel" → copie des dates d'Ariel
  if (typeof CH[id].vacations === 'string') CH[id].vacations = CH[CH[id].vacations].vacations;
  CH[id].activities = CH[id].activities || [];
}
DATA.wednesday = DATA.wednesday || { needsCare: CHILD_IDS, defaults: {} };
const WED = DATA.wednesday;
// "mamimo" → { mamimo: [needsCare] } ; { who: ["a"] } et { who: { kids: ["a"], at: "16h00" } } acceptés
const normAssign = v => { if (typeof v === 'string') return { [v]: WED.needsCare }; const r = {}; for (const who in (v || {})) r[who] = Array.isArray(v[who]) ? { kids: v[who] } : v[who]; return r; };
const dropMeta = o => { for (const k in o) if (k.startsWith('_')) delete o[k]; return o; };
DATA.careSchedule = dropMeta(DATA.careSchedule || {});
for (const key in DATA.careSchedule) DATA.careSchedule[key] = normAssign(DATA.careSchedule[key]);
DATA.pickups = dropMeta(DATA.pickups || {});
for (const key in DATA.pickups) DATA.pickups[key] = normAssign(DATA.pickups[key]);
DATA.families = DATA.families || [{ id: 'parents', name: 'Parents', children: CHILD_IDS }];
DATA.recurringCare = DATA.recurringCare || [];
DATA.absences = DATA.absences || [];
for (const key in { ...DATA.careSchedule, ...DATA.pickups })
  for (const who in { ...DATA.careSchedule[key], ...DATA.pickups[key] })
    if (!CG[who]) console.warn(`⚠️  ${key} : gardien inconnu "${who}"`);

// ---------------------------------------------------------------- utils
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hm = s => s.replace('h', '').padEnd(4, '0'); // "16h40" -> "1640"
const frDate = d => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const names = kids => kids.map(k => CH[k].name).join(' & ');
const emojis = kids => kids.map(k => CH[k].emoji).join('');

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { // RFC 5545 : lignes ≤ 75 octets
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur); return out.join('\r\n');
}

const vacOn = (date, child) => CH[child].vacations.find(r => date >= parse(r.start) && date <= parse(r.end)) || null;
const offFull = (date, child) => { const v = vacOn(date, child); return !!(v && !v.partial); };
const hasSchool = (date, child) => !offFull(date, child) && !!CH[child].schoolEnd[date.getDay()];
const absencesOn = date => DATA.absences.filter(a => date >= parse(a.start) && date <= parse(a.end));
const absent = (date, who) => absencesOn(date).some(a => a.who === who);

// Gardes journée effectives pour une date : { gardien: enfants[] }
// - attribution explicite (careSchedule) : toujours appliquée
// - sinon, le mercredi : gardes par défaut, hors enfants en vacances et hors absence du gardien
function careOn(date) {
  const explicit = DATA.careSchedule[iso(date)] || {};
  const res = {};
  for (const who in CG) {
    let kids = explicit[who] && explicit[who].kids;
    if (!kids && date.getDay() === 3 && !absent(date, who)) kids = (WED.defaults[who] || []).filter(k => !offFull(date, k));
    if (kids && kids.length) res[who] = kids;
  }
  return res;
}
// Sorties d'école effectives pour une date : { gardien: enfants[] }
function pickupsOn(date) {
  const dow = date.getDay(), res = {};
  const add = (who, kids) => { const ok = kids.filter(k => hasSchool(date, k)); if (ok.length) res[who] = [...new Set([...(res[who] || []), ...ok])]; };
  for (const r of DATA.recurringCare) if (r.days.includes(dow)) add(r.who, r.kids || CHILD_IDS);
  const p = DATA.pickups[iso(date)] || {};
  for (const who in p) add(who, p[who].kids);
  return res;
}
// Heure de sortie d'un enfant pour un gardien ce jour-là ("at" ponctuel, sinon horaire habituel)
const pickupTime = (date, who, k) => { const p = (DATA.pickups[iso(date)] || {})[who]; return (p && p.at) || CH[k].schoolEnd[date.getDay()]; };

// ---------------------------------------------------------------- ICS builders
const DTSTAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const VTIMEZONE = `BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`.replace(/\n/g, '\r\n');

function vevent(e) {
  const L = ['BEGIN:VEVENT', `UID:${e.uid}@planning-andy-ariel`, `DTSTAMP:${DTSTAMP}`];
  if (e.allDay) {
    L.push(`DTSTART;VALUE=DATE:${ymd(e.start)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.end, 1))}`);
  } else {
    L.push(`DTSTART;TZID=Europe/Paris:${ymd(e.start)}T${e.startHM}00`, `DTEND;TZID=Europe/Paris:${ymd(e.start)}T${e.endHM}00`);
  }
  L.push(`SUMMARY:${esc(e.summary)}`);
  if (e.description) L.push(`DESCRIPTION:${esc(e.description)}`);
  if (e.location) L.push(`LOCATION:${esc(e.location)}`);
  if (e.transparent) L.push('TRANSP:TRANSPARENT');
  if (e.alarm) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.summary)}`, `TRIGGER:-PT${e.alarm}M`, 'END:VALARM');
  L.push('END:VEVENT');
  return L.map(fold).join('\r\n');
}

function calendar(name, desc, events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planning famille//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-CALDESC:${esc(desc)}`, 'X-WR-TIMEZONE:Europe/Paris', 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    VTIMEZONE, ...events.map(vevent), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- programme d'une journée (texte)
function dayProgram(date, kids) {
  const dow = date.getDay();
  const head = [], items = [];
  for (const k of kids) {
    const c = CH[k];
    const vac = vacOn(date, k);
    if (vac && !vac.partial) { head.push(`${c.emoji} ${c.name} : en vacances (${vac.name}) — pas d'école, activités probablement suspendues`); continue; }
    if (vac && vac.partial) head.push(`${c.emoji} ${c.name} : ${vac.name}`);
    const end = c.schoolEnd[dow];
    if (end) items.push({ t: end, txt: `${c.emoji} ${end} · ${c.name} — sortie (${c.school})` });
    else if (dow >= 1 && dow <= 5) head.push(`${c.emoji} ${c.name} : pas d'école ce jour`);
    for (const a of c.activities.filter(a => a.dow === dow))
      items.push({ t: a.start, txt: `${c.emoji} ${a.start}–${a.end} · ${c.name} — ${a.name}\n      📍 ${a.address}${a.contact ? '\n      📞 ' + a.contact : ''}` });
  }
  items.sort((a, b) => a.t.localeCompare(b.t));
  return [...head, ...(head.length && items.length ? [''] : []), ...items.map(i => i.txt)].join('\n');
}

// ---------------------------------------------------------------- génération des événements
const START = parse(DATA.schoolYear.start), END = parse(DATA.schoolYear.end);
const ev = { act: {}, care: {}, pickup: {}, careTodo: [], absences: [] };
for (const k of CHILD_IDS) ev.act[k] = [];
for (const k in CG) { ev.care[k] = []; ev.pickup[k] = []; }

// Vacances : une série d'événements pour un groupe d'enfants, fusionnés quand les dates/noms coïncident
function vacEvents(kids) {
  const groups = {};
  for (const k of kids) for (const v of CH[k].vacations) {
    const key = `${v.start}|${v.end}|${v.name}`;
    (groups[key] = groups[key] || { v, kids: [] }).kids.push(k);
  }
  return Object.values(groups).map(({ v, kids }) => ({
    uid: `vac-${kids.join('-')}-${v.start}`, allDay: true, start: parse(v.start), end: parse(v.end), transparent: true,
    summary: `${emojis(kids)} ${names(kids)} en vacances – ${v.name}`,
    description: `${kids.map(k => `${CH[k].name} (${CH[k].school})`).join(', ')} : ${v.name}\nDu ${frDate(parse(v.start))} au ${frDate(parse(v.end))} inclus.`
  }));
}

// Activités (une occurrence par semaine d'école, avec contexte de garde le mercredi)
for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) continue;
  const care = careOn(d);
  for (const k of CHILD_IDS) {
    const c = CH[k];
    if (offFull(d, k)) continue;
    for (const a of c.activities.filter(a => a.dow === dow)) {
      const who = Object.keys(care).find(w => care[w].includes(k));
      const desc = [`${c.name} — ${a.name}`, a.contact ? `Contact : ${a.contact}` : null,
        who ? `Garde ce jour : ${CG[who].name}` : (dow === 3 && WED.needsCare.includes(k) ? '⚠️ Garde du mercredi à définir' : null)].filter(Boolean).join('\n');
      ev.act[k].push({ uid: `act-${k}-${iso(d)}-${hm(a.start)}`, start: d, startHM: hm(a.start), endHM: hm(a.end), kids: [k],
        summary: `${c.emoji} ${c.name} · ${a.name}`, description: desc, location: a.address, alarm: 30 });
    }
  }
}

// Sorties d'école (récurrentes + ponctuelles)
for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
  const key = iso(d), dow = d.getDay();
  const pk = pickupsOn(d);
  for (const who in pk) {
    if (!CG[who]) continue;
    const kids = pk[who];
    const rule = DATA.recurringCare.find(r => r.who === who && r.days.includes(dow));
    const times = kids.map(k => pickupTime(d, who, k)).sort();
    const early = kids.filter(k => pickupTime(d, who, k) !== CH[k].schoolEnd[dow]);
    const desc = [
      ...kids.map(k => `${CH[k].emoji} ${pickupTime(d, who, k)} · ${CH[k].name} — sortie${early.includes(k) ? ' anticipée' : ''} (${CH[k].school})`),
      '', 'Activités après l\'école :',
      dayProgram(d, kids).split('\n').filter(l => l.includes('–')).join('\n') || 'aucune',
      '', `Mis à jour depuis ${SITE}`].join('\n');
    ev.pickup[who].push({ uid: `pickup-${who}-${key}`, start: d, startHM: hm(times[0]), endHM: (rule && rule.endHM) || '1830', alarm: 60, who, kids,
      summary: `${CG[who].emoji} ${CG[who].name.split(' ')[0]} récupère ${names(kids)}${early.length ? ` à ${times[0]}` : ''}`, description: desc });
  }
}

// Gardes journée (mercredis + attributions explicites) et mercredis "à définir"
const careDates = new Set(Object.keys(DATA.careSchedule));
for (let d = new Date(START); d <= END; d = addDays(d, 1)) if (d.getDay() === 3) careDates.add(iso(d));
for (const key of [...careDates].sort()) {
  const d = parse(key), dow = d.getDay();
  const care = careOn(d);
  const abs = absencesOn(d).map(a => `✈️ ${a.name}`).join('\n');
  for (const who in care) {
    if (!CG[who]) continue;
    const kids = care[who];
    // début = première sortie d'école ou première activité des enfants gardés ; sinon 9h
    const starts = kids.flatMap(k => [CH[k].schoolEnd[dow], ...CH[k].activities.filter(a => a.dow === dow).map(a => a.start)]).filter(Boolean).map(hm).sort();
    ev.care[who].push({ uid: `care-${who}-${key}`, start: d, startHM: starts[0] || '0900', endHM: '1800', alarm: 12 * 60, who, kids,
      summary: `${CG[who].emoji} Garde ${names(kids)} – ${CG[who].name}${dow !== 3 ? ' (journée sans école)' : ''}`,
      description: `Programme du ${frDate(d)} :\n\n${dayProgram(d, kids)}${abs ? '\n\n' + abs : ''}\n\nMis à jour depuis ${SITE}` });
  }
  if (dow === 3) {
    const assigned = new Set(Object.values(care).flat());
    const todo = WED.needsCare.filter(k => !assigned.has(k) && !offFull(d, k));
    if (todo.length) ev.careTodo.push({ uid: `care-todo-${key}`, allDay: true, start: d, end: d, kids: todo,
      summary: `⚠️ Garde du mercredi à définir (${names(todo)})`,
      description: `Personne n'est encore prévu pour ${names(todo)} ce mercredi.\n\n${dayProgram(d, todo)}${abs ? '\n\n' + abs : ''}` });
  }
}

// Absences des adultes
DATA.absences.forEach(a => ev.absences.push({
  uid: `abs-${a.who}-${a.start}`, allDay: true, start: parse(a.start), end: parse(a.end), transparent: true, who: a.who,
  summary: `✈️ ${a.name}`, description: `${CG[a.who].name} indisponible du ${frDate(parse(a.start))} au ${frDate(parse(a.end))}.`
}));

// ---------------------------------------------------------------- flux
const allCare = Object.values(ev.care).flat(), allPickup = Object.values(ev.pickup).flat();
const involves = kids => e => e.kids.some(k => kids.includes(k));
const feeds = [];
for (const f of DATA.families) feeds.push({
  id: f.id, kind: 'family', name: f.name, color: CH[f.children[0]].color,
  desc: `Vacances, activités, gardes et sorties d'école — ${names(f.children)}`,
  events: [...vacEvents(f.children), ...f.children.flatMap(k => ev.act[k]), ...allCare.filter(involves(f.children)),
    ...allPickup.filter(involves(f.children)), ...ev.careTodo.filter(involves(f.children)), ...ev.absences]
});
for (const k in CG) {
  const mine = [...ev.care[k], ...ev.pickup[k]];
  const kidsCared = [...new Set([...(WED.defaults[k] || []), ...mine.flatMap(e => e.kids)])];
  feeds.push({
    id: k, kind: 'caregiver', name: `Garde – ${CG[k].name}`, color: CG[k].color,
    desc: `Vos jours de garde et sorties d'école avec le programme détaillé, et les vacances de ${names(kidsCared) || 'vos petits-enfants'}`,
    events: [...mine, ...vacEvents(kidsCared), ...ev.absences.filter(a => a.who === k)]
  });
}
for (const k of CHILD_IDS) feeds.push({
  id: k, kind: 'child', name: CH[k].name, color: CH[k].color,
  desc: `Vacances, activités et gardes de ${CH[k].name} uniquement`,
  events: [...vacEvents([k]), ...ev.act[k], ...allCare.filter(involves([k])), ...allPickup.filter(involves([k]))]
});

const feedList = [];
for (const f of feeds) {
  const file = feedFile(f.id);
  fs.writeFileSync(path.join(FEEDS, file), calendar(f.name, f.desc, f.events));
  feedList.push({ id: f.id, kind: f.kind, name: f.name, desc: f.desc, color: f.color, count: f.events.length,
    https: `${SITE}/feeds/${file}`, webcal: `${SITE.replace(/^https?:\/\//, 'webcal://')}/feeds/${file}` });
  console.log(`✓ feeds/${file}  (${f.events.length} événements)`);
}

// ---------------------------------------------------------------- HTML
let html = fs.readFileSync(path.join(__dirname, 'src/index.template.html'), 'utf8');
html = html.replace('/*__DATA__*/null', JSON.stringify(DATA)).replace('/*__FEEDS__*/null', JSON.stringify(feedList)).replace(/__SITE__/g, SITE);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'feeds/index.json'), JSON.stringify(feedList, null, 2));
console.log('✓ index.html');
