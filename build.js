#!/usr/bin/env node
/**
 * build.js — génère dist/index.html + dist/feeds/*.ics à partir de data/planning.json
 * Usage : node build.js
 * Aucune dépendance externe.
 */
const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/planning.json'), 'utf8'));
const SITE = (process.env.SITE_URL || process.env.URL || DATA.site).replace(/\/$/, '');
const OUT = path.join(__dirname, 'dist');
const FEEDS = path.join(OUT, 'feeds');
fs.mkdirSync(FEEDS, { recursive: true });

// ---------------------------------------------------------------- utils
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hm = s => s.replace('h', '').padEnd(4, '0'); // "16h40" -> "1640", "14h20" -> "1420"
const frDate = d => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayFull = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { // RFC 5545 : lignes ≤ 75 octets
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur); return out.join('\r\n');
}

const vacOn = (date, child) => DATA.children[child].vacations.find(r => date >= parse(r.start) && date <= parse(r.end)) || null;
const absencesOn = date => DATA.absences.filter(a => date >= parse(a.start) && date <= parse(a.end));

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
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planning Andy & Ariel//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-CALDESC:${esc(desc)}`, 'X-WR-TIMEZONE:Europe/Paris', 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    VTIMEZONE, ...events.map(vevent), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- programme d'une journée (texte)
function dayProgram(date, whichChildren) {
  const dow = date.getDay();
  const head = [], items = [];
  for (const k of whichChildren) {
    const c = DATA.children[k];
    const vac = vacOn(date, k);
    if (vac && !vac.partial) { head.push(`${c.emoji} ${c.name} : en vacances (${vac.name}) — pas d'école, activités probablement suspendues`); continue; }
    if (vac && vac.partial) head.push(`${c.emoji} ${c.name} : ${vac.name}`);
    const end = c.schoolEnd[dow];
    if (end) items.push({ t: end, txt: `${c.emoji} ${end} · ${c.name} — sortie d'école (${c.school})` });
    else if (dow >= 1 && dow <= 5) head.push(`${c.emoji} ${c.name} : pas d'école ce jour`);
    for (const a of c.activities.filter(a => a.dow === dow))
      items.push({ t: a.start, txt: `${c.emoji} ${a.start}–${a.end} · ${c.name} — ${a.name}\n      📍 ${a.address}${a.contact ? '\n      📞 ' + a.contact : ''}` });
  }
  items.sort((a, b) => a.t.localeCompare(b.t));
  return [...head, ...(head.length && items.length ? [''] : []), ...items.map(i => i.txt)].join('\n');
}

// ---------------------------------------------------------------- génération des événements
const START = parse(DATA.schoolYear.start), END = parse(DATA.schoolYear.end);
const ev = { pickup: [], vac: { andy: [], ariel: [] }, act: { andy: [], ariel: [] }, care: {}, careTodo: [], absences: [] };
for (const k in DATA.caregivers) ev.care[k] = [];

// Vacances (jour entier)
for (const k of ['andy', 'ariel']) {
  const c = DATA.children[k];
  c.vacations.forEach((v, i) => ev.vac[k].push({
    uid: `vac-${k}-${v.start}`, allDay: true, start: parse(v.start), end: parse(v.end), transparent: true,
    summary: `${c.emoji} ${c.name} en vacances – ${v.name}`,
    description: `${c.name} (${c.school}) : ${v.name}\nDu ${frDate(parse(v.start))} au ${frDate(parse(v.end))} inclus.`
  }));
}

// Activités (une occurrence par semaine d'école, avec contexte de garde le mercredi)
for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) continue;
  for (const k of ['andy', 'ariel']) {
    const c = DATA.children[k];
    if (vacOn(d, k) && !vacOn(d, k).partial) continue;
    for (const a of c.activities.filter(a => a.dow === dow)) {
      const care = dow === 3 ? DATA.careSchedule[iso(d)] : null;
      const desc = [`${c.name} — ${a.name}`, a.contact ? `Contact : ${a.contact}` : null,
        care ? `Garde ce mercredi : ${DATA.caregivers[care].name}` : (dow === 3 ? '⚠️ Garde du mercredi à définir' : null)].filter(Boolean).join('\n');
      ev.act[k].push({ uid: `act-${k}-${iso(d)}-${hm(a.start)}`, start: d, startHM: hm(a.start), endHM: hm(a.end),
        summary: `${c.emoji} ${c.name} · ${a.name}`, description: desc, location: a.address, alarm: 30 });
    }
  }
}

// Gardes récurrentes (ex. Diane lundi & jeudi : sortie d'école)
for (const rule of (DATA.recurringCare || [])) {
  const cg = DATA.caregivers[rule.who];
  for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
    if (!rule.days.includes(d.getDay())) continue;
    const dow = d.getDay();
    const atSchool = ['andy', 'ariel'].filter(k => !(vacOn(d, k) && !vacOn(d, k).partial) && DATA.children[k].schoolEnd[dow]);
    if (!atSchool.length) continue;
    const off = ['andy', 'ariel'].filter(k => !atSchool.includes(k));
    const names = atSchool.map(k => DATA.children[k].name).join(' & ');
    const times = atSchool.map(k => DATA.children[k].schoolEnd[dow]).sort();
    const desc = [
      ...atSchool.map(k => `${DATA.children[k].emoji} ${DATA.children[k].schoolEnd[dow]} · ${DATA.children[k].name} — sortie (${DATA.children[k].school})`),
      ...off.map(k => `${DATA.children[k].emoji} ${DATA.children[k].name} : en vacances (${vacOn(d, k).name}) — pas à récupérer`),
      '', 'Activités après l\'école :',
      dayProgram(d, atSchool).split('\n').filter(l => l.includes('–')).join('\n') || 'aucune',
      '', `Mis à jour depuis ${SITE}`].join('\n');
    ev.pickup.push({ uid: `pickup-${rule.who}-${iso(d)}`, start: d, startHM: hm(times[0]), endHM: rule.endHM, alarm: 60, who: rule.who, kids: atSchool,
      summary: `${cg.emoji} ${cg.name.split(' ')[0]} récupère ${names}${off.length ? ' (' + off.map(k => DATA.children[k].name).join(', ') + ' en vacances)' : ''}`,
      description: desc });
  }
}

// Mercredis de garde
for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
  if (d.getDay() !== 3) continue;
  const bothOff = vacOn(d, 'andy') && vacOn(d, 'ariel') && !vacOn(d, 'andy').partial;
  if (bothOff) continue;
  const care = DATA.careSchedule[iso(d)];
  const program = dayProgram(d, ['andy', 'ariel']);
  const abs = absencesOn(d).map(a => `✈️ ${a.name}`).join('\n');
  if (care) {
    const cg = DATA.caregivers[care];
    ev.care[care].push({ uid: `care-${iso(d)}`, start: d, startHM: '1100', endHM: '1700', alarm: 12 * 60,
      summary: `${cg.emoji} Garde Andy & Ariel – ${cg.name}`,
      description: `Programme du ${frDate(d)} :\n\n${program}${abs ? '\n\n' + abs : ''}\n\nMis à jour depuis ${SITE}` });
  } else {
    ev.careTodo.push({ uid: `care-todo-${iso(d)}`, allDay: true, start: d, end: d,
      summary: `⚠️ Garde du mercredi à définir`,
      description: `Personne n'est encore prévu pour ce mercredi.\n\n${program}${abs ? '\n\n' + abs : ''}` });
  }
}

// Absences des adultes
DATA.absences.forEach(a => ev.absences.push({
  uid: `abs-${a.who}-${a.start}`, allDay: true, start: parse(a.start), end: parse(a.end), transparent: true,
  summary: `✈️ ${a.name}`, description: `${DATA.caregivers[a.who].name} indisponible du ${frDate(parse(a.start))} au ${frDate(parse(a.end))}.`
}));

// ---------------------------------------------------------------- flux
const allCare = Object.values(ev.care).flat();
const feeds = {
  parents: { name: 'Andy & Ariel – Parents', desc: 'Vacances, activités, gardes du mercredi et absences',
    events: [...ev.vac.andy, ...ev.vac.ariel, ...ev.act.andy, ...ev.act.ariel, ...allCare, ...ev.pickup, ...ev.careTodo, ...ev.absences] },
  andy: { name: 'Andy', desc: 'Vacances et activités d\'Andy', events: [...ev.vac.andy, ...ev.act.andy, ...allCare, ...ev.pickup.filter(e => e.kids.includes('andy'))] },
  ariel: { name: 'Ariel', desc: 'Vacances et activités d\'Ariel', events: [...ev.vac.ariel, ...ev.act.ariel, ...allCare, ...ev.pickup.filter(e => e.kids.includes('ariel'))] }
};
for (const k in DATA.caregivers) {
  const cg = DATA.caregivers[k];
  feeds[k] = { name: `Garde Andy & Ariel – ${cg.name}`, desc: k === 'diane' ? 'Sorties d\'école du lundi et jeudi, mercredis de garde éventuels, vacances des enfants' : 'Vos mercredis de garde avec le programme détaillé, et les vacances des enfants',
    events: [...ev.care[k], ...ev.pickup.filter(e => e.who === k), ...ev.vac.andy, ...ev.vac.ariel, ...ev.absences.filter(a => a.uid.includes(k))] };
}

const feedList = [];
for (const id in feeds) {
  const f = feeds[id];
  fs.writeFileSync(path.join(FEEDS, `${id}.ics`), calendar(f.name, f.desc, f.events));
  feedList.push({ id, name: f.name, desc: f.desc, count: f.events.length,
    https: `${SITE}/feeds/${id}.ics`, webcal: `${SITE.replace(/^https?:\/\//, 'webcal://')}/feeds/${id}.ics` });
  console.log(`✓ feeds/${id}.ics  (${f.events.length} événements)`);
}

// ---------------------------------------------------------------- HTML
let html = fs.readFileSync(path.join(__dirname, 'src/index.template.html'), 'utf8');
html = html.replace('/*__DATA__*/null', JSON.stringify(DATA)).replace('/*__FEEDS__*/null', JSON.stringify(feedList)).replace(/__SITE__/g, SITE);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'feeds/index.json'), JSON.stringify(feedList, null, 2));
console.log('✓ index.html');
