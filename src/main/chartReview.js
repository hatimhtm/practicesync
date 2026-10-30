'use strict';

/**
 * CHART REVIEW — the practice's "Client Chart Review Guide", run on every client
 * scheduled this week and next week. READ ONLY: it opens each chart in Practice
 * Fusion, reads the pages a reviewer reads (Summary, Timeline → Intake forms and
 * Encounters, Documents, Profile, the Pinned note) and lists what needs fixing.
 * It never edits a chart.
 *
 * Pages are read by their VISIBLE TEXT and labels ("Diagnoses", "Care team",
 * "MD Referral Expires:") rather than hidden page structure, so the checks below
 * are plain functions over text — tested on the text of the practice's own
 * walkthrough of the test patient.
 */

const { normalizeName, isNonPatient, matchProvider, mainCodeFor } = require('./model');

/* --------------------------------- dates --------------------------------- */

/** "9/19/26", "11/27/2026", "Signed 4/24" → { date, complete }. 4/24 = month/year only. */
function parseLooseDate(s, today = new Date()) {
  const t = String(s || '');
  let m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = new Date(y, +m[1] - 1, +m[2]);
    return isNaN(d) ? null : { date: d, complete: true, text: m[0] };
  }
  // "10/15", "Signed 4/24": month/day with no year — the closest such date to
  // today (so "10/15" written this fall is Oct 15 of this year, not Oct 2015).
  m = /\b(\d{1,2})\/(\d{1,2})\b(?![/.-]\d)/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
    const y0 = today.getFullYear();
    const best = [y0 - 1, y0, y0 + 1].map((y) => new Date(y, +m[1] - 1, +m[2])).sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0];
    return { date: best, complete: false, text: m[0] };
  }
  return null;
}
/** Calendar-day arithmetic — safe across daylight-saving changes (adding 24 h
 *  to Nov 1 00:00 lands on Nov 1 23:00, which is how "week of 11/1" happened). */
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const DAY = 86400000;
const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysFrom = (today, d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY);

/* ------------------------------- disciplines ------------------------------ */

const DISC_WORDS = { pt: 'PT', ot: 'OT', slp: 'SLP', st: 'SLP', speech: 'SLP', physical: 'PT', occupational: 'OT' };
/** "PT, OT" / "PT/OT/SLP" / "PT & ST" → ['PT','OT',…] (deduped, in order). */
function parseDisciplines(s) {
  const out = [];
  for (const w of String(s || '').toLowerCase().split(/[^a-z]+/)) {
    const d = DISC_WORDS[w];
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/* ------------------------------- page parsers ----------------------------- */

const lines = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The text of one page section: from its heading to the next of `nextHeadings`. */
function section(text, heading, nextHeadings = [], maxLen = 4000) {
  const t = String(text || '');
  // The heading's own line ("Email", not "Email reminders and messaging").
  const whole = new RegExp(`(^|\\n)[ \\t]*${heading}[ \\t]*(Edit[^\\n]*)?(?=\\n|$)`, 'gi');
  const re = whole.test(t) ? (whole.lastIndex = 0, whole) : new RegExp(`(^|\\n)\\s*${heading}\\b`, 'gi');
  let best = '';
  let m;
  // Every occurrence, longest wins: the "Go to…" dropdown lists the same names
  // ("Care team", "Address", "Diagnoses") with nothing under them.
  while ((m = re.exec(t))) {
    const start = m.index + m[0].length;
    let end = Math.min(t.length, start + maxLen);
    for (const h of nextHeadings) {
      const n = new RegExp(`\\n\\s*${h}\\b`, 'i').exec(t.slice(start));
      if (n && start + n.index < end) end = start + n.index;
    }
    const sec = t.slice(start, end);
    if (sec.trim().length > best.trim().length) best = sec;
  }
  return best;
}

/** Summary → diagnoses ("(R53.1) Weakness"). */
function parseDiagnoses(summaryText) {
  const sec = section(summaryText, 'Diagnoses', ['Patient risk score', 'Social history', 'Allergies', 'Medications', 'Health concerns', 'Goals', 'Encounters', 'Implantable devices', 'Screenings']);
  const out = [];
  const re = /\(([A-TV-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)\)\s*([^\n(]*)/g;
  let m;
  while ((m = re.exec(sec))) out.push({ code: m[1], name: m[2].trim() });
  return out;
}

/** The pinned note's fields. */
function parsePinnedNote(text) {
  const t = String(text || '');
  const L = lines(t);
  const field = (re) => { const m = re.exec(t); return m ? m[1].trim() : null; };
  const services = field(/Services?\s*:\s*([^\n]*)/i);
  const note = {
    found: /Services?\s*:/i.test(t) || /referral/i.test(t) || /\bPOC\b/i.test(t),
    servicesText: services,
    services: parseDisciplines(services),
    referralExpires: null,
    documentationType: field(/Documentation\s*Type\s*:?\s*([^\n]*)/i) || field(/\bDoc(?:umentation)?\.?\s*type\s*:?\s*([^\n]*)/i),
    weeklySchedule: field(/Weekly\s*Schedule\s*:?\s*([^\n]*)/i),
    poc: {},
    reassessment: {},
    days: [],
    frequency: {},
  };
  const valueOf = (line) => { const i = line.indexOf(':'); return (i >= 0 ? line.slice(i + 1) : line.replace(/^.*?(?=\d|signed|sent|pending|n\/a)/i, '')).trim(); };
  for (const line of L) {
    // "MD Referral Expires: 9/19/26", "Referral exp: 11/27/26", "MD Rx expires 1/2/27"
    if (note.referralExpires == null && /referral|\bRx\b/i.test(line) && /exp|valid|thru|through|until|:/i.test(line) && !/authoriz/i.test(line)) note.referralExpires = valueOf(line);
    // "MD Signed POC for PT: Signed 4/24", "PT POC: signed 5/1", "Plan of Care (OT): sent 10/20"
    if (/\bPOC\b|plan of care/i.test(line)) {
      const label = line.split(':')[0];
      const ds = parseDisciplines(label.replace(/\bMD\b/gi, ''));
      for (const d of (ds.length ? ds : note.services)) if (note.poc[d] == null) note.poc[d] = valueOf(line);
    }
    // "PT Reassessment due: 10/17/26", "OT re-eval due 1/3/27", "Reassess (SLP): 12/1/26"
    if (/re-?\s?assess|re-?\s?eval|\bRE\s+due/i.test(line)) {
      const label = line.split(':')[0];
      const ds = parseDisciplines(label);
      for (const d of (ds.length ? ds : note.services)) if (note.reassessment[d] == null) note.reassessment[d] = valueOf(line);
    }
  }
  let m;
  const day = /^\s*(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]*\.?\s*[-–:]\s*(.+)$/gim;
  while ((m = day.exec(t))) note.days.push({ day: m[1], who: m[2].trim() });
  const freq = /(\d+)\s*x\s*\/?\s*w(?:ee)?k\s*(PT|OT|SLP|ST|Speech)?/gi;
  while ((m = freq.exec(note.weeklySchedule || ''))) {
    const d = parseDisciplines(m[2] || '')[0] || (note.services.length === 1 ? note.services[0] : '');
    if (d) note.frequency[d] = +m[1];
  }
  return note;
}

/** Find a toggle's state in page text: "ON\nEmail reminders…" or "Email reminders… ON". */
function toggleState(text, label) {
  const t = String(text || '');
  const before = new RegExp(`\\b(ON|OFF)\\s*\\n?\\s*${label}`, 'i').exec(t);
  if (before) return before[1].toUpperCase() === 'ON' ? 'on' : 'off';
  const after = new RegExp(`${label}[^\\n]*\\n?\\s*(ON|OFF)\\b`, 'i').exec(t);
  if (after) return after[1].toUpperCase() === 'ON' ? 'on' : 'off';
  return 'unknown';
}

/** Profile → patient basics, contact, reminders, care team. `toggles` (optional)
 *  are states read straight from the switches on the page, when available. */
function parseProfile(text, toggles = {}) {
  const t = String(text || '');
  const val = (label) => {
    const m = new RegExp(`(^|\\n)\\s*${label}\\s*\\n\\s*([^\\n]+)`, 'i').exec(t);
    const v = m ? m[2].trim() : '';
    return v && v !== '--' && !/^edit$/i.test(v) ? v : '';
  };
  const contact = section(t, 'Contact', ['Address', 'Insurance', 'Demographics', 'Care team']);
  const phoneSec = section(contact, 'Phone', ['Email', 'Appointment reminders', 'Preferred method']);
  const emailSec = section(contact, 'Email', ['Preferred method', 'Appointment reminders', 'Address']);
  const addressSec = section(t, 'Address', ['Insurance', 'Demographics', 'Care team', 'Payer'], 600);
  const reminders = section(t, 'Appointment reminders and messaging', ['Address', 'Practice documented', 'Turn on all reminders', 'Insurance'], 800);
  const care = section(t, 'Care team', ['Next of kin', "Patient's mother", 'Insurance', 'Emergency contact'], 4000);
  const pick = (label) => {
    const inSec = toggleState(reminders, label);
    return inSec !== 'unknown' ? inSec : toggleState(t, label);
  };
  const email = toggles.email || pick('Email reminders');
  const sms = toggles.sms || pick('Text\\s*/\\s*SMS reminders');
  return {
    name: val('NAME'), sex: val('SEX'), dob: val('DATE OF BIRTH'),
    phone: /\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(phoneSec || contact) ,
    email: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(emailSec || contact),
    address: (/\b\d{5}(-\d{4})?\b/.test(addressSec) || /^\s*\d+\s+[A-Za-z]/m.test(addressSec)) && !/No current address/i.test(addressSec),
    noConsent: /consent/i.test(t) && !/Practice documented/i.test(t),
    reminders: { email, sms, override: toggles.override != null ? !!toggles.override : /\boverride\b/i.test(reminders) },
    careTeamText: care,
    preferredCount: (care.match(/Preferred provider in practice/gi) || []).length,
    hasReferring: /referring provider/i.test(care),
  };
}

/** Timeline → Encounters: [{ date, chunk }] — each row's text, ending at its date. */
function parseEncounters(text) {
  const out = [];
  let last = 0;
  const re = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g;
  const t = String(text || '');
  let m;
  while ((m = re.exec(t))) {
    const chunk = t.slice(last, m.index);
    last = re.lastIndex;
    // Dates inside the CC text ("Appt time: 4/17/2025 …") are not row ends.
    if (/appt time:\s*$|arrival time:\s*$/i.test(chunk.slice(-20))) continue;
    const d = parseLooseDate(m[1]);
    if (d) out.push({ date: d.date, chunk });
  }
  return out;
}

/** Which roster therapists appear in a piece of text ("Caryn McAllister PT, DPT"). */
function therapistsIn(text, providers) {
  const norm = ` ${normalizeName(text)} `;
  return (providers || []).filter((p) => {
    const toks = normalizeName(p.name).split(' ').filter((x) => x.length > 1 && !/^\(|\)$/.test(x));
    if (toks.length < 2) return false;
    return norm.includes(` ${toks[0]} `) && norm.includes(` ${toks[toks.length - 1]} `);
  });
}

/* --------------------------------- checks --------------------------------- */

const ITEMS = [
  ['diagnosis', 'Diagnosis'],
  ['careTeam', 'Care Team'],
  ['pinnedNote', 'Pinned Note'],
  ['planOfCare', 'Plan of Care'],
  ['reassessments', 'Reassessments'],
  ['referral', 'Referral'],
  ['intake', 'Intake Forms'],
  ['contact', 'Contact Details'],
  ['schedule', 'Schedule'],
];

/**
 * Review one chart. `pages` holds the text read from each page; `visits` are this
 * client's Practice Fusion visits this week + next week ({ date: Date, discipline }).
 * Returns the 9 checklist items, each { key, label, status, notes[] } where status
 * is 'ok' | 'problem' (must be fixed) | 'check' (a person should look).
 */
function reviewChart(pages, { today = new Date(), providers = [], visits = [], weekStarts = [], weeks = null } = {}) {
  today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const items = Object.fromEntries(ITEMS.map(([key, label]) => [key, { key, label, status: 'ok', notes: [] }]));
  const flag = (key, status, note) => {
    const it = items[key];
    if (status === 'problem' || (status === 'check' && it.status === 'ok')) it.status = status;
    if (status === 'unknown' && it.status === 'ok') it.status = 'check';
    it.notes.push(note);
  };
  const unread = (key, what) => flag(key, 'unknown', `Couldn't read ${what} — check it by hand.`);

  // 1) Diagnosis
  if (pages.summary == null) unread('diagnosis', 'the Summary page');
  else if (!parseDiagnoses(pages.summary).length) flag('diagnosis', 'problem', 'No diagnosis on the chart (Summary → Diagnoses).');

  // 3) Pinned note
  const note = parsePinnedNote(pages.pinnedNote || '');
  const services = note.services;
  if (!pages.pinnedNote || !note.found) flag('pinnedNote', 'problem', 'No pinned note found (or it has no "Services:" line).');
  else {
    if (!services.length) flag('pinnedNote', 'problem', 'Pinned note doesn\'t list the services (Services: PT / OT / SLP).');
    if (!note.referralExpires) flag('pinnedNote', 'problem', 'Pinned note has no MD referral expiration date.');
    if (!note.documentationType) flag('pinnedNote', 'problem', 'Pinned note has no "Documentation Type" (basic note or insurance note).');
    else if (!/basic|insurance/i.test(note.documentationType)) flag('pinnedNote', 'check', `Documentation Type is "${note.documentationType}" — expected basic note or insurance note.`);
    if (!note.weeklySchedule && !note.days.length) flag('pinnedNote', pages.pinnedPartial ? 'check' : 'problem', pages.pinnedPartial ? 'Couldn\'t open the whole pinned note — check its weekly schedule.' : 'Pinned note has no weekly schedule (the Mo–Su mini calendar).');
    else if (note.days.length && note.days.length < 7) flag('pinnedNote', 'check', `Weekly schedule lists ${note.days.length} of 7 days.`);
  }

  // 4) Plan of care — one MD-signed POC per service, dated, and on file.
  for (const d of services) {
    const v = note.poc[d];
    if (v == null) flag('planOfCare', 'problem', `Pinned note has no MD-signed plan of care line for ${d}.`);
    else if (/\b(sent|pending|waiting|awaiting|faxed|requested)\b/i.test(v) && !/\bsigned\b/i.test(v)) flag('planOfCare', 'problem', `${d} plan of care isn't signed yet ("${v}") — follow up with the MD.`);
    else if (!parseLooseDate(v, today) && !/\bsigned\b/i.test(v)) flag('planOfCare', 'problem', `${d} plan of care has no signed date ("${v || 'blank'}").`);
  }
  const docs = pages.documents == null ? null : lines(pages.documents);
  // If only "Pending" could be listed, a signed document may just be out of sight.
  const docSeverity = pages.documentsComplete === false ? 'check' : 'problem';
  const docNote = (n) => (pages.documentsComplete === false ? `${n} (Only "Pending" documents could be listed — check Signed.)` : n);
  if (docs == null) unread('planOfCare', 'the Documents page');
  else if (!docs.some((l) => /plan of care|\bPOC\b/i.test(l))) flag('planOfCare', docSeverity, docNote('No signed Plan of Care in Documents.'));

  // 5) Reassessments — one per service, not overdue.
  for (const d of services) {
    const v = note.reassessment[d];
    const pd = parseLooseDate(v, today);
    if (v == null) flag('reassessments', 'problem', `Pinned note has no ${d} reassessment due date.`);
    else if (!pd) flag('reassessments', 'problem', `"${d} Reassessment due" has no date ("${v || 'blank'}").`);
    else {
      const n = daysFrom(today, pd.date);
      if (n < 0) flag('reassessments', 'problem', `${d} reassessment was due ${pd.text} (${-n} days ago) — contact the ${d} therapist.`);
      else if (n <= 14) flag('reassessments', 'check', `${d} reassessment is due ${pd.text} (in ${n} days) — remind the ${d} therapist.`);
    }
  }

  // Referral — on file, not expired, and the pinned note matches the document.
  const ref = parseLooseDate(note.referralExpires, today);
  if (note.referralExpires && !ref) flag('referral', 'problem', `"MD Referral Expires: ${note.referralExpires}" isn't a date.`);
  if (ref) {
    const n = daysFrom(today, ref.date);
    if (n < 0) flag('referral', 'problem', `MD referral expired ${ref.text} — start the updated-referral process.`);
    else if (n <= 30) flag('referral', 'check', `MD referral expires ${ref.text} (in ${n} days) — start the updated-referral process.`);
  }
  if (docs == null) unread('referral', 'the Documents page');
  else {
    const refDocs = docs.filter((l) => /referral/i.test(l));
    if (!refDocs.length) flag('referral', docSeverity, docNote('No referral on file in Documents.'));
    const docDates = refDocs.map((l) => parseLooseDate((/exp\w*\.?\s*:?\s*([\d/.-]+)/i.exec(l) || [])[1], today)).filter(Boolean);
    if (ref && docDates.length && !docDates.some((d) => sameDay(d.date, ref.date))) {
      const latest = docDates.sort((a, b) => b.date - a.date)[0];
      flag('referral', docSeverity, docNote(`Pinned note says the referral expires ${ref.text}, but the referral in Documents says ${fmt(latest.date)} — update the pinned note.`));
    }
    if (!note.referralExpires && docDates.length) flag('referral', 'problem', `Referral in Documents expires ${fmt(docDates[0].date)} — add it to the pinned note.`);
  }

  // 6) Intake forms — Timeline → Intake forms, else Documents.
  const intakeRows = pages.intakes == null ? null : lines(pages.intakes).filter((l) => /intake form/i.test(l) && !/^intake forms?$/i.test(l));
  const intakeDocs = (docs || []).filter((l) => /intake/i.test(l));
  if (intakeRows == null && docs == null) unread('intake', 'Intake forms or Documents');
  else if (!(intakeRows || []).length && !intakeDocs.length) flag('intake', 'problem', 'No intake forms — not in Timeline → Intake forms or Documents. Check with Abin whether they are in the billing system.');

  // 7) Contact details + reminders.
  if (pages.profile == null) { unread('contact', 'the Profile page'); unread('careTeam', 'the Profile page'); }
  else {
    const p = parseProfile(pages.profile, pages.toggles || {});
    if (!p.name || !p.sex || !p.dob) flag('contact', 'problem', `Missing ${[!p.name && 'name', !p.sex && 'sex', !p.dob && 'date of birth'].filter(Boolean).join(', ')}.`);
    if (!p.phone) flag('contact', 'problem', 'No phone number.');
    if (!p.email) flag('contact', 'problem', 'No email address.');
    if (!p.address) flag('contact', 'problem', 'No current home address.');
    if (p.reminders.override) {
      flag('contact', 'ok', 'Reminders are locked by the patient (Override) — leave them as they are.');
    } else {
      for (const [k, label] of [['email', 'Email'], ['sms', 'Text/SMS']]) {
        if (p.reminders[k] === 'off') flag('contact', 'problem', `${label} reminders are OFF — turn them on.`);
        else if (p.reminders[k] === 'unknown') flag('contact', 'check', p.noConsent ? `${label} reminders aren't on — no voice and text consent is documented.` : `Couldn't tell whether ${label} reminders are on.`);
      }
    }

    // 2) Care team — one preferred provider, a referring provider, and every
    // therapist who saw the client in the last ~4 months.
    if (!p.careTeamText) flag('careTeam', 'problem', 'No care team on the chart.');
    else {
      if (p.preferredCount === 0) flag('careTeam', 'problem', 'No "Preferred provider in practice" on the care team.');
      if (p.preferredCount > 1) flag('careTeam', 'problem', `${p.preferredCount} preferred providers — only one can be preferred; the others should be backup providers.`);
      if (!p.hasReferring) flag('careTeam', 'problem', 'No referring provider on the care team.');
      if (pages.encounters != null) {
        const since = addDays(today, -120);
        const seen = new Map();
        for (const e of parseEncounters(pages.encounters)) {
          if (e.date < since) continue;
          for (const t of therapistsIn(e.chunk, providers)) seen.set(t.name, t);
        }
        const onTeam = new Set(therapistsIn(p.careTeamText, providers).map((t) => t.name));
        const missing = [...seen.keys()].filter((n) => !onTeam.has(n));
        if (missing.length) flag('careTeam', 'problem', `Saw the client in the last 4 months but not on the care team: ${missing.join(', ')}.`);
      } else unread('careTeam', 'Timeline → Encounters');
    }
  }

  // 8) Schedule — each week of the range, every active service, at its frequency.
  // A week only partly inside the range is checked for "any visit" (if it has 3+
  // weekdays in range), and for the full frequency only when all 5 weekdays are in.
  const wks = weeks || weekStarts.map((ws, wi) => ({ start: ws, end: addDays(ws, 7), weekdays: 5, label: wi === 0 ? 'this week' : 'next week' }));
  if (wks.length) {
    const wanted = services.length ? services : [...new Set(visits.map((v) => v.discipline).filter(Boolean))];
    for (const w of wks) {
      if (w.weekdays < 3) continue;
      const inWeek = visits.filter((v) => v.date >= w.start && v.date < w.end);
      const label = w.label || `the week of ${fmt(w.start)}`;
      if (!inWeek.length) { flag('schedule', 'problem', `Not scheduled ${label}${w.label && /this|next/.test(w.label) ? ` (week of ${fmt(w.start)})` : ''}.`); continue; }
      const unknown = inWeek.filter((v) => !v.discipline).length;
      for (const d of wanted) {
        const n = inWeek.filter((v) => v.discipline === d).length;
        const f = note.frequency[d];
        if (!n && unknown) flag('schedule', 'check', `Couldn't tell whether ${label}'s ${unknown === 1 ? 'visit is' : `${unknown} visits are`} ${d} — the therapist isn't on Doctors & Codes.`);
        else if (!n) flag('schedule', 'problem', `No ${d} visit ${label}${f ? ` (pinned note says ${f}x/wk)` : ''}.`);
        else if (f && n < f && w.weekdays >= 5) flag('schedule', 'check', `${n} of ${f} ${d} visits scheduled ${label}.`);
      }
      const extra = [...new Set(inWeek.map((v) => v.discipline).filter((d) => d && services.length && !services.includes(d)))];
      if (extra.length) flag('schedule', 'check', `${extra.join(', ')} scheduled ${label} but not in the pinned note's services.`);
    }
  }

  return ITEMS.map(([key]) => items[key]);
}

/* ------------------------------ follow-ups ------------------------------- */

/** Merge a run's findings into the follow-up list: new notes are added, notes no
 *  longer found are marked resolved, ones a person closed stay closed. */
function mergeFollowUps(existing, results, at = new Date().toISOString()) {
  const list = (existing || []).map((f) => ({ ...f }));
  const byKey = new Map(list.map((f) => [f.key, f]));
  const reviewed = new Set(results.filter((r) => r.ok).map((r) => r.patientKey));
  const live = new Set();
  for (const r of results) {
    if (!r.ok) continue;
    for (const it of r.items) {
      if (it.status === 'ok') continue;
      for (const note of it.notes) {
        if (/^Reminders are locked|^Couldn't read/.test(note)) continue; // not something to fix in the chart
        const key = `${r.patientKey}|${it.key}|${note.replace(/\(\d+ days?( ago)?\)|\(in \d+ days?\)/g, '').trim()}`;
        live.add(key);
        const f = byKey.get(key);
        if (!f) {
          const nf = { key, id: 'fu_' + Math.random().toString(36).slice(2, 10), patientName: r.patientName, item: it.label, note, status: it.status, createdAt: at, resolvedAt: null, resolvedBy: '' };
          list.push(nf); byKey.set(key, nf);
        } else {
          f.note = note; f.status = it.status;
          if (f.resolvedBy === 'review') { f.resolvedAt = null; f.resolvedBy = ''; } // came back
        }
      }
    }
  }
  for (const f of list) {
    const patientKey = f.key.split('|')[0];
    if (!f.resolvedAt && reviewed.has(patientKey) && !live.has(f.key)) { f.resolvedAt = at; f.resolvedBy = 'review'; }
  }
  return list;
}

/* ------------------------------ the browser run --------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PF_BASE = 'https://static.practicefusion.com/apps/ehr/index.html#/PF/charts/patients/';
const PF_CHART_LIST = 'https://static.practicefusion.com/apps/ehr/index.html#/PF/charts/list/all/recent';
const CHART_ID_RE = /\/charts\/patients\/([0-9a-f-]{20,})/i;
const patientKey = (name) => normalizeName(name).split(' ').filter(Boolean).sort().join(' ');

/** Visible text of the page, minus the advertisement column. The ad column is
 *  the narrow box around the "Advertisement" label — measured, so the main page
 *  is never mistaken for it (1.8.0 hid the label's parent, which on the real
 *  Practice Fusion page was the whole page: every read came back empty). */
async function pageText(page) {
  return page.evaluate(() => {
    // Dropdowns out of the text: "Go to…" lists every section name on the page.
    const hide = document.createElement('style');
    hide.textContent = 'select{display:none!important}';
    document.head.appendChild(hide);
    const t = document.body ? document.body.innerText : '';
    hide.remove();
    const W = window.innerWidth || 1200;
    const drop = new Set();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 2 || !/^advertisement$/i.test((el.textContent || '').trim())) continue;
      // Climb while the box stays narrow (the ad column); the label's own
      // siblings in a wide parent are the ad content when there's no column box.
      let rail = el, up = el.parentElement;
      while (up && up !== document.body && up.getBoundingClientRect().width < W * 0.4) { rail = up; up = up.parentElement; }
      const boxes = rail === el && el.parentElement
        ? [el, ...[...el.parentElement.children].filter((c) => c !== el && c.getBoundingClientRect().width < W * 0.4 && c.getBoundingClientRect().left >= el.getBoundingClientRect().left - 2)]
        : [rail];
      for (const b of boxes) for (const line of (b.innerText || '').split('\n')) if (line.trim()) drop.add(line.trim());
    }
    if (!drop.size) return t;
    return t.split('\n').filter((line) => !drop.has(line.trim())).join('\n');
  }).catch(() => null);
}

/** Wait until a page's text contains one of `marks` and stops changing. */
async function settledText(page, marks, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let last = '', steady = 0;
  while (Date.now() < end) {
    await sleep(350);
    const t = await pageText(page);
    if (t == null) continue;
    const ready = marks.some((m) => (m instanceof RegExp ? m.test(t) : t.includes(m)));
    steady = t === last ? steady + 1 : 0;
    last = t;
    if (ready && steady >= 2) return t;
  }
  return last && marks.some((m) => (m instanceof RegExp ? m.test(last) : last.includes(m))) ? last : null;
}

/** The pinned note's full text: the popup (it auto-opens on many charts; otherwise
 *  the pin icon opens it, as in the guide). Read only — the note's Edit button is
 *  never pressed. Returns { text, partial } — partial = only the Profile panel's
 *  top lines could be seen. */
async function readPinnedNote(page) {
  const grab = () => page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('div, section, article, aside, form')) {
      const t = el.innerText || '';
      if (t.length > 6000 || !/Services?\s*:|MD Referral|\bPOC\b|Re-?assess/i.test(t) || !/\n/.test(t)) continue;
      if (/Appointment reminders|Care team/i.test(t)) continue; // a page column, not the note
      const score = (/Weekly\s*Schedule/i.test(t) ? 2 : 0) + (/Documentation\s*Type/i.test(t) ? 1 : 0);
      if (!best || score > best.score || (score === best.score && t.length < best.t.length)) best = { t, score };
    }
    return best ? best.t : '';
  }).catch(() => '');
  const whole = (t) => /Weekly\s*Schedule/i.test(t);
  let t = await grab();
  for (let i = 0; i < 4 && !whole(t); i++) { await sleep(400); const n = await grab(); if (n.length > t.length) t = n; } // auto-open
  if (!whole(t)) {
    // The pin icon: by its name if it has one, else its spot right of the history
    // icon, right after the "Patient ledger" tab in the chart header.
    const spot = await page.evaluate(() => {
      const named = [...document.querySelectorAll('[title], [aria-label], [data-element], [class*="pin" i]')].find((e) => {
        const a = `${e.getAttribute('title') || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('data-element') || ''} ${e.getAttribute('class') || ''}`;
        const r = e.getBoundingClientRect();
        return /\bpin(ned)?\b|pinned|thumb-?tack/i.test(a) && !/spin|ping|shipping/i.test(a) && r.width > 0 && r.width < 70 && r.top < 320;
      });
      if (named) { const r = named.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
      const tab = [...document.querySelectorAll('a, button, li, span, div')].find((e) => (e.textContent || '').trim() === 'Patient ledger' && e.getBoundingClientRect().width > 0);
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.right + 57, y: r.top + r.height / 2 };
    }).catch(() => null);
    if (spot) {
      await page.mouse.click(spot.x, spot.y).catch(() => {});
      for (let i = 0; i < 5 && !whole(t); i++) { await sleep(400); const n = await grab(); if (n.length > t.length) t = n; }
    }
  }
  return { text: t || '', partial: !whole(t) && !!t };
}

/** Read the reminder switches from the page itself (states, and any Override lock). */
async function readToggles(page) {
  return page.evaluate(() => {
    const state = (label) => {
      const el = [...document.querySelectorAll('label, span, div, p, td')].find((e) => new RegExp(label, 'i').test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 60);
      if (!el) return null;
      let box = el;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        if ((box.textContent || '').length > 120) break; // left this switch's own row
        const sw = box.querySelector('input[type="checkbox"], [role="switch"], [aria-checked], [aria-pressed]');
        if (sw) {
          if (sw.matches('input')) return sw.checked ? 'on' : 'off';
          const v = sw.getAttribute('aria-checked') || sw.getAttribute('aria-pressed');
          if (v) return v === 'true' ? 'on' : 'off';
        }
        const own = (box.innerText || '').match(/\b(ON|OFF)\b/);
        if (own) return own[1] === 'ON' ? 'on' : 'off';
        const k = box.querySelector('[class*="toggle" i], [class*="switch" i]');
        if (k) {
          const c = k.getAttribute('class') || '';
          if (/\b(is-)?(on|checked|active|enabled)\b/i.test(c)) return 'on';
          if (/\b(is-)?(off|unchecked|inactive|disabled)\b/i.test(c)) return 'off';
          for (const part of [k, ...k.querySelectorAll('*')]) for (const ps of ['::before', '::after']) {
            const txt = getComputedStyle(part, ps).content || '';
            if (/\bON\b/.test(txt)) return 'on';
            if (/\bOFF\b/.test(txt)) return 'off';
          }
        }
      }
      return null;
    };
    const area = [...document.querySelectorAll('div, section')].find((e) => /^Appointment reminders and messaging/i.test((e.innerText || '').trim()) && (e.innerText || '').length < 1500);
    const override = !!(area && (/\boverride\b/i.test(area.innerText) || area.querySelector('[class*="lock" i], [data-icon*="lock" i], [title*="lock" i]')));
    return { email: state('^Email reminders'), sms: state('^Text\\s*/\\s*SMS reminders'), override };
  }).catch(() => ({}));
}

/** Documents opens on "Pending". Returns every other view of the list worth reading
 *  ("All", or "Signed"…), each as a function that switches to it. */
async function documentViews(page) {
  const sel = await page.evaluateHandle(() => [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /pending/i.test(o.text))) || null).catch(() => null);
  const el = sel && sel.asElement ? sel.asElement() : null;
  if (!el) return null;
  const opts = await el.evaluate((s) => [...s.options].map((o) => ({ value: o.value, text: o.text.trim() }))).catch(() => []);
  const all = opts.find((o) => /^all/i.test(o.text));
  const wanted = all ? [all] : opts.filter((o) => /signed|complete|reviewed/i.test(o.text));
  return wanted.map((o) => () => el.selectOption({ value: o.value }).catch(() => {}));
}

/** Chart id for a patient: from the schedule link, else the Charts search. */
async function findChartId(page, name, scheduleHref, onStep) {
  const fromHref = CHART_ID_RE.exec(scheduleHref || '');
  if (fromHref) return fromHref[1];
  await page.goto(PF_CHART_LIST, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settledText(page, [/recent patients|patient lists/i], 15000);
  const box = await page.evaluateHandle(() => {
    const ins = [...document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')].filter((i) => i.offsetParent && !/provider/i.test(i.placeholder || ''));
    return ins.find((i) => /search|name|patient/i.test(i.placeholder || i.getAttribute('aria-label') || '')) || ins[ins.length - 1] || null;
  }).catch(() => null);
  const el = box && box.asElement ? box.asElement() : null;
  if (!el) return '';
  await el.fill('').catch(() => {});
  await el.type(name, { delay: 20 }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(2500);
  const first = name.trim().split(/\s+/)[0].toLowerCase(), last = name.trim().split(/\s+/).pop().toLowerCase();
  const hrefs = await page.evaluate(({ first, last }) => {
    const out = [];
    for (const row of document.querySelectorAll('tr, [role="row"]')) {
      const t = (row.innerText || '').toLowerCase();
      if (!t.includes(first) || !t.includes(last)) continue;
      const a = row.querySelector('a[href*="/charts/patients/"]');
      if (a) out.push(a.getAttribute('href'));
      else out.push('click');
    }
    return out;
  }, { first, last }).catch(() => []);
  const ids = [...new Set(hrefs.map((h) => (CHART_ID_RE.exec(h || '') || [])[1]).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) { onStep(`  ${name}: ${ids.length} charts match this name — skipped (check by hand).`); return ''; }
  if (hrefs.length === 1) {
    // A result row without a plain link — open it and read the chart address.
    await page.evaluate(({ first, last }) => {
      for (const row of document.querySelectorAll('tr, [role="row"]')) {
        const t = (row.innerText || '').toLowerCase();
        if (t.includes(first) && t.includes(last)) { (row.querySelector('a') || row).click(); return; }
      }
    }, { first, last }).catch(() => {});
    await sleep(2500);
    return (CHART_ID_RE.exec(page.url()) || [])[1] || '';
  }
  return '';
}

const ALL = (...words) => new RegExp(words.map((w) => `(?=[\\s\\S]*${w})`).join(''), 'i');
/** Read every page of one chart. A page that doesn't load gets one reload; one that
 *  still doesn't stays null (reported as unread, and retried at the end of the run). */
async function readChart(page, id) {
  const go = async (sub, marks) => {
    await page.goto(PF_BASE + id + '/' + sub, { waitUntil: 'domcontentloaded' }).catch(() => {});
    let t = await settledText(page, marks);
    if (t == null) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      t = await settledText(page, marks, 20000);
    }
    return t;
  };
  const pages = {};
  // The header and dropdowns show first and the sections fill in after — wait for
  // the sections themselves.
  pages.summary = await go('summary', [ALL('Diagnoses', 'Encounters')]);
  let pinned = await readPinnedNote(page);
  pages.intakes = await go('timeline/intakes', ['TYPE/SOURCE', /no intake/i]);
  pages.encounters = await go('timeline/encounter', ['TYPE/SOURCE', /no encounters/i]);
  const docMarks = ['TITLE', /no documents/i];
  pages.documents = await go('documents', docMarks);
  if (pages.documents != null) {
    const views = await documentViews(page);
    pages.documentsComplete = !!(views && views.length);
    for (const show of views || []) {
      await show();
      await sleep(600);
      const more = await settledText(page, docMarks);
      if (more) pages.documents += `\n${more}`;
    }
  }
  pages.profile = await go('profile', [ALL('Appointment reminders', 'Care team')]);
  if (pages.profile) {
    pages.toggles = await readToggles(page);
    if (!/Weekly\s*Schedule/i.test(pinned.text)) {
      const again = await readPinnedNote(page);
      if (again.text.length > pinned.text.length) pinned = again;
    }
  }
  pages.pinnedNote = pinned.text;
  pages.pinnedPartial = pinned.partial;
  return pages;
}

/** Monday 00:00 of the week holding `d`. */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}

/** Local midnight Date from "MM/DD/YYYY" (or a Date). */
function toDay(x) {
  if (x instanceof Date) return new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(x || '').trim());
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(x || '').trim());
  return iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : null;
}
const mdyOf = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

/** The Mon–Sun weeks a date range touches, each clipped to the range, with how
 *  many weekdays (Mon–Fri) of it are inside the range. */
function weeksInRange(start, end, today = new Date()) {
  const out = [];
  const thisMon = mondayOf(today);
  for (let mon = mondayOf(start); mon <= end; mon = addDays(mon, 7)) {
    const s = mon < start ? start : mon;
    const sun = addDays(mon, 7);
    const endNext = addDays(end, 1);
    const e = sun < endNext ? sun : endNext;
    let weekdays = 0;
    for (let d = new Date(s); d < e; d = addDays(d, 1)) if (d.getDay() >= 1 && d.getDay() <= 5) weekdays += 1;
    const wk = Math.round(daysFrom(thisMon, mon) / 7);
    out.push({ start: s, end: e, weekdays, label: wk === 0 ? 'this week' : wk === 1 ? 'next week' : '' });
  }
  return out;
}

/**
 * The whole review. `readSchedule(dates)` returns Practice Fusion visits for those
 * days ([{ patientName, doctorName, date: 'MM/DD/YYYY', href }]) — supplied by the
 * caller so the schedule reading stays in one place. `pages` are the browser tabs
 * to use; clients are reviewed on all of them at once (the first also reads the
 * schedule). Default range: this week and next.
 */
async function runChartReview({ pages: tabs, page, readSchedule, providers = [], mainDoctors = [], onStep = () => {}, onResult = () => {}, today = new Date(), only = null, start = null, end = null }) {
  const say = (m) => { try { onStep(m); } catch {} };
  tabs = tabs && tabs.length ? tabs : [page];
  const t0 = toDay(today);
  const from = toDay(start) || mondayOf(t0);
  const to = toDay(end) || addDays(mondayOf(t0), 13);
  if (to < from) return [];
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(mdyOf(d));
  const weeks = weeksInRange(from, to, t0);
  say(`Reading the Practice Fusion schedule, ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} day${dates.length === 1 ? '' : 's'})…`);
  const visits = await readSchedule(dates);
  const DISC = { GP: 'PT', GO: 'OT', GN: 'SLP' };
  const clients = new Map();
  for (const v of visits) {
    if (!v.patientName || isNonPatient(v.patientName)) continue;
    const k = patientKey(v.patientName);
    if (only && !only.includes(k)) continue;
    const { provider } = matchProvider(v.doctorName, providers);
    const discipline = provider ? (DISC[mainCodeFor(provider.mainDoctor, mainDoctors)] || parseDisciplines(provider.discipline)[0] || '') : '';
    const c = clients.get(k) || { patientKey: k, patientName: v.patientName, href: '', visits: [] };
    c.visits.push({ date: toDay(v.date), discipline });
    if (!c.href && v.href) c.href = v.href;
    clients.set(k, c);
  }
  const queue = [...clients.values()];
  const total = queue.length;
  say(`${total} client${total === 1 ? '' : 's'} scheduled — reviewing ${Math.min(tabs.length, total) > 1 ? `${Math.min(tabs.length, total)} charts at a time` : 'each chart'}.`);
  const results = [];
  let done = 0;
  const reviewOne = async (tab, c) => {
    let r;
    try {
      const id = await findChartId(tab, c.patientName, c.href, say);
      if (!id) r = { ok: false, patientKey: c.patientKey, patientName: c.patientName, error: 'Couldn\'t find this chart in Practice Fusion.' };
      else {
        const pg = await readChart(tab, id);
        const items = reviewChart(pg, { today: t0, providers, visits: c.visits, weeks });
        r = { ok: true, patientKey: c.patientKey, patientName: c.patientName, chartId: id, items, pinnedNote: (pg.pinnedNote || '').slice(0, 3000) };
      }
    } catch (e) {
      r = { ok: false, patientKey: c.patientKey, patientName: c.patientName, error: (e && e.message) || String(e) };
    }
    r.reviewedAt = new Date().toISOString();
    done += 1;
    const bad = r.ok ? r.items.filter((x) => x.status !== 'ok').length : 0;
    say(`(${done}/${total}) ${c.patientName} — ${!r.ok ? `couldn't review: ${r.error}` : bad ? `${bad} item${bad === 1 ? '' : 's'} to fix` : 'all 9 items OK ✓'}`);
    results.push(r);
    try { onResult(r); } catch {}
  };
  await Promise.all(tabs.slice(0, Math.max(1, Math.min(tabs.length, total))).map(async (tab) => {
    for (let c = queue.shift(); c; c = queue.shift()) await reviewOne(tab, c);
  }));
  // Second pass, one at a time: any chart with a page that couldn't be read.
  const unread = (r) => !r.ok || r.items.some((i) => i.notes.some((n) => /^Couldn't read/.test(n)));
  const again = results.filter(unread).map((r) => clients.get(r.patientKey)).filter(Boolean);
  if (again.length) {
    say(`Trying ${again.length} chart${again.length === 1 ? '' : 's'} again, one at a time…`);
    for (const c of again) {
      const before = results.findIndex((r) => r.patientKey === c.patientKey);
      if (before >= 0) results.splice(before, 1);
      done -= 1;
      await reviewOne(tabs[0], c);
    }
  }
  return results;
}

module.exports = {
  ITEMS, parseLooseDate, parseDisciplines, parseDiagnoses, parsePinnedNote, parseProfile,
  pageText, readChart, parseEncounters, therapistsIn, toggleState, reviewChart, mergeFollowUps, runChartReview, mondayOf, patientKey, weeksInRange, toDay,
};
