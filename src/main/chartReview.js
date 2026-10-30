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
function parseLooseDate(s) {
  const t = String(s || '');
  let m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = new Date(y, +m[1] - 1, +m[2]);
    return isNaN(d) ? null : { date: d, complete: true, text: m[0] };
  }
  m = /\b(\d{1,2})\/(\d{2,4})\b/.exec(t);
  if (m) {
    let y = +m[2]; if (y < 100) y += 2000;
    return { date: new Date(y, +m[1] - 1, 1), complete: false, text: m[0] };
  }
  return null;
}
const DAY = 86400000;
const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const daysFrom = (today, d) => Math.round((d - today) / DAY);

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
  const re = new RegExp(`(^|\\n)\\s*${heading}\\b`, 'i');
  const m = re.exec(t);
  if (!m) return '';
  const start = m.index + m[0].length;
  let end = Math.min(t.length, start + maxLen);
  for (const h of nextHeadings) {
    const n = new RegExp(`\\n\\s*${h}\\b`, 'i').exec(t.slice(start));
    if (n && start + n.index < end) end = start + n.index;
  }
  return t.slice(start, end);
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
  const field = (re) => { const m = re.exec(t); return m ? m[1].trim() : null; };
  const services = field(/Services\s*:\s*([^\n]*)/i);
  const note = {
    found: /Services\s*:/i.test(t) || /MD Referral/i.test(t),
    servicesText: services,
    services: parseDisciplines(services),
    referralExpires: field(/MD Referral Expires?\s*:\s*([^\n]*)/i),
    documentationType: field(/Documentation Type\s*:\s*([^\n]*)/i),
    weeklySchedule: field(/Weekly Schedule\s*:\s*([^\n]*)/i),
    poc: {},
    reassessment: {},
    days: [],
    frequency: {},
  };
  let m;
  const poc = /MD Signed POC(?: for)?\s+([A-Za-z/&, ]+?)\s*:\s*([^\n]*)/gi;
  while ((m = poc.exec(t))) for (const d of parseDisciplines(m[1])) note.poc[d] = m[2].trim();
  const re = /\b(PT|OT|SLP|ST|Speech)\s+Re-?assessment\s+due\s*:\s*([^\n]*)/gi;
  while ((m = re.exec(t))) for (const d of parseDisciplines(m[1])) note.reassessment[d] = m[2].trim();
  const day = /^\s*(Mo|Tu|We|Th|Fr|Sa|Su)[a-z]*\s*[-–:]\s*(.+)$/gim;
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
  const email = toggles.email || toggleState(reminders || t, 'Email reminders');
  const sms = toggles.sms || toggleState(reminders || t, 'Text\\s*/\\s*SMS reminders');
  return {
    name: val('NAME'), sex: val('SEX'), dob: val('DATE OF BIRTH'),
    phone: /\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(phoneSec || contact) ,
    email: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(emailSec || contact),
    address: /\d+\s+\S+.*\n?.*\b[A-Z]{2}\s+\d{5}/.test(addressSec) && !/No current address/i.test(addressSec),
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
function reviewChart(pages, { today = new Date(), providers = [], visits = [], weekStarts = [] } = {}) {
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
    if (!note.referralExpires) flag('pinnedNote', 'problem', 'Pinned note has no "MD Referral Expires" date.');
    if (!note.documentationType) flag('pinnedNote', 'problem', 'Pinned note has no "Documentation Type" (basic note or insurance note).');
    else if (!/basic|insurance/i.test(note.documentationType)) flag('pinnedNote', 'check', `Documentation Type is "${note.documentationType}" — expected basic note or insurance note.`);
    if (!note.weeklySchedule && !note.days.length) flag('pinnedNote', 'problem', 'Pinned note has no weekly schedule (the Mo–Su mini calendar).');
    else if (note.days.length && note.days.length < 7) flag('pinnedNote', 'check', `Weekly schedule lists ${note.days.length} of 7 days.`);
  }

  // 4) Plan of care — one MD-signed POC per service, dated, and on file.
  for (const d of services) {
    const v = note.poc[d];
    if (v == null) flag('planOfCare', 'problem', `Pinned note has no "MD Signed POC for ${d}".`);
    else if (!parseLooseDate(v)) flag('planOfCare', 'problem', `"MD Signed POC for ${d}" has no signed date ("${v || 'blank'}").`);
    else if (!parseLooseDate(v).complete) flag('planOfCare', 'check', `"MD Signed POC for ${d}: ${v}" — not a complete date (month/day/year).`);
  }
  const docs = pages.documents == null ? null : lines(pages.documents);
  if (docs == null) unread('planOfCare', 'the Documents page');
  else if (!docs.some((l) => /plan of care|\bPOC\b/i.test(l))) flag('planOfCare', 'problem', 'No signed Plan of Care in Documents.');

  // 5) Reassessments — one per service, not overdue.
  for (const d of services) {
    const v = note.reassessment[d];
    const pd = parseLooseDate(v);
    if (v == null) flag('reassessments', 'problem', `Pinned note has no "${d} Reassessment due" date.`);
    else if (!pd) flag('reassessments', 'problem', `"${d} Reassessment due" has no date ("${v || 'blank'}").`);
    else {
      const n = daysFrom(today, pd.date);
      if (n < 0) flag('reassessments', 'problem', `${d} reassessment was due ${pd.text} (${-n} days ago) — contact the ${d} therapist.`);
      else if (n <= 14) flag('reassessments', 'check', `${d} reassessment is due ${pd.text} (in ${n} days) — remind the ${d} therapist.`);
    }
  }

  // Referral — on file, not expired, and the pinned note matches the document.
  const ref = parseLooseDate(note.referralExpires);
  if (note.referralExpires && !ref) flag('referral', 'problem', `"MD Referral Expires: ${note.referralExpires}" isn't a date.`);
  if (ref) {
    const n = daysFrom(today, ref.date);
    if (n < 0) flag('referral', 'problem', `MD referral expired ${ref.text} — start the updated-referral process.`);
    else if (n <= 30) flag('referral', 'check', `MD referral expires ${ref.text} (in ${n} days) — start the updated-referral process.`);
  }
  if (docs == null) unread('referral', 'the Documents page');
  else {
    const refDocs = docs.filter((l) => /referral/i.test(l));
    if (!refDocs.length) flag('referral', 'problem', 'No referral on file in Documents.');
    const docDates = refDocs.map((l) => parseLooseDate((/expir\w*\s*:?\s*([\d/]+)/i.exec(l) || [])[1])).filter(Boolean);
    if (ref && docDates.length && !docDates.some((d) => sameDay(d.date, ref.date))) {
      const latest = docDates.sort((a, b) => b.date - a.date)[0];
      flag('referral', 'problem', `Pinned note says the referral expires ${ref.text}, but the referral in Documents says ${fmt(latest.date)} — update the pinned note.`);
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
        else if (p.reminders[k] === 'unknown') flag('contact', 'check', `Couldn't tell whether ${label} reminders are on.`);
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
        const since = new Date(today - 120 * DAY);
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

  // 8) Schedule — this week and next, every active service, at its frequency.
  if (weekStarts.length) {
    const wanted = services.length ? services : [...new Set(visits.map((v) => v.discipline).filter(Boolean))];
    weekStarts.forEach((ws, wi) => {
      const we = new Date(ws.getTime() + 7 * DAY);
      const inWeek = visits.filter((v) => v.date >= ws && v.date < we);
      const label = wi === 0 ? 'this week' : 'next week';
      if (!inWeek.length) { flag('schedule', 'problem', `Not scheduled ${label} (week of ${fmt(ws)}).`); return; }
      for (const d of wanted) {
        const n = inWeek.filter((v) => v.discipline === d).length;
        const f = note.frequency[d];
        if (!n) flag('schedule', 'problem', `No ${d} visit ${label}${f ? ` (pinned note says ${f}x/wk)` : ''}.`);
        else if (f && n < f) flag('schedule', 'check', `${n} of ${f} ${d} visits scheduled ${label}.`);
      }
      const extra = [...new Set(inWeek.map((v) => v.discipline).filter((d) => d && services.length && !services.includes(d)))];
      if (extra.length) flag('schedule', 'check', `${extra.join(', ')} scheduled ${label} but not in the pinned note's services.`);
    });
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
        if (/^Reminders are locked/.test(note)) continue;
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

/** Visible text of the main page, without the advertisement column. */
async function pageText(page) {
  return page.evaluate(() => {
    const ads = [...document.querySelectorAll('*')].filter((e) => /^advertisement$/i.test((e.textContent || '').trim()));
    const hide = ads.map((a) => a.parentElement).filter(Boolean);
    hide.forEach((h) => { h.dataset.__psHide = h.style.display; h.style.display = 'none'; });
    const t = document.body ? document.body.innerText : '';
    hide.forEach((h) => { h.style.display = h.dataset.__psHide || ''; });
    return t;
  }).catch(() => null);
}

/** Wait until a page's text contains one of `marks` and stops changing. */
async function settledText(page, marks, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = '', steady = 0;
  while (Date.now() < end) {
    await sleep(700);
    const t = await pageText(page);
    if (t == null) continue;
    const ready = marks.some((m) => (m instanceof RegExp ? m.test(t) : t.includes(m)));
    steady = t === last ? steady + 1 : 0;
    last = t;
    if (ready && steady >= 1) return t;
  }
  return last && marks.some((m) => (m instanceof RegExp ? m.test(last) : last.includes(m))) ? last : null;
}

/** The pinned note's full text: the popup that auto-opens, else the Profile panel
 *  (expanded with "View and edit all note text"). */
async function readPinnedNote(page) {
  const grab = () => page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('div, section, article, aside, form')) {
      const t = el.innerText || '';
      if (!/Services\s*:/i.test(t) || t.length > 6000) continue;
      const score = (/Weekly Schedule/i.test(t) ? 2 : 0) + (/Documentation Type/i.test(t) ? 1 : 0);
      if (!best || score > best.score || (score === best.score && t.length < best.t.length)) best = { t, score };
    }
    return best ? best.t : '';
  }).catch(() => '');
  let t = await grab();
  if (!/Weekly Schedule/i.test(t)) {
    const link = await page.$('text=/View and edit all note text/i').catch(() => null);
    if (link) { await link.click({ timeout: 3000 }).catch(() => {}); await sleep(1500); const t2 = await grab(); if (t2.length > t.length) t = t2; }
  }
  return t || '';
}

/** Read the reminder switches from the page itself (states, and any Override lock). */
async function readToggles(page) {
  return page.evaluate(() => {
    const state = (label) => {
      const el = [...document.querySelectorAll('label, span, div, p')].find((e) => new RegExp(label, 'i').test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 60);
      if (!el) return null;
      let box = el;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        const sw = box.querySelector('input[type="checkbox"], [role="switch"], [aria-checked]');
        if (sw) {
          const on = sw.matches('input') ? sw.checked : sw.getAttribute('aria-checked') === 'true';
          return on ? 'on' : 'off';
        }
      }
      return null;
    };
    const area = [...document.querySelectorAll('div, section')].find((e) => /^Appointment reminders and messaging/i.test((e.innerText || '').trim()) && (e.innerText || '').length < 1500);
    const override = !!(area && (/\boverride\b/i.test(area.innerText) || area.querySelector('[class*="lock" i], [data-icon*="lock" i], [title*="lock" i]')));
    return { email: state('^Email reminders'), sms: state('^Text\\s*/\\s*SMS reminders'), override };
  }).catch(() => ({}));
}

/** Documents: switch the list from "Pending" to all documents when the filter allows. */
async function showAllDocuments(page) {
  return page.evaluate(() => {
    for (const s of document.querySelectorAll('select')) {
      const opts = [...s.options];
      if (!opts.some((o) => /pending/i.test(o.text))) continue;
      const all = opts.find((o) => /^all/i.test(o.text.trim()));
      if (all && s.value !== all.value) { s.value = all.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'all'; }
      return all ? 'all' : 'pending-only';
    }
    return 'no-filter';
  }).catch(() => 'no-filter');
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

/** Read every page of one chart. Missing pages stay null (reported as unread). */
async function readChart(page, id) {
  const go = async (sub, marks) => {
    await page.goto(PF_BASE + id + '/' + sub, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return settledText(page, marks);
  };
  const pages = {};
  pages.summary = await go('summary', ['Diagnoses']);
  pages.pinnedNote = await readPinnedNote(page);
  pages.intakes = await go('timeline/intakes', [/intake form/i, /no intake/i, 'TYPE/SOURCE']);
  pages.encounters = await go('timeline/encounter', ['TYPE/SOURCE', /no encounters/i]);
  await page.goto(PF_BASE + id + '/documents', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settledText(page, ['TITLE', /no documents/i]);
  const filter = await showAllDocuments(page);
  pages.documents = await settledText(page, ['TITLE', /no documents/i]);
  pages.documentsFilter = filter;
  pages.profile = await go('profile', ['Contact', 'Care team']);
  if (pages.profile) {
    pages.toggles = await readToggles(page);
    const fuller = await readPinnedNote(page);
    if (fuller.length > (pages.pinnedNote || '').length) pages.pinnedNote = fuller;
  }
  return pages;
}

/** Monday 00:00 of the week holding `d`. */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7;
  return new Date(x.getTime() - dow * DAY);
}

/**
 * The whole review. `readSchedule(dates)` returns Practice Fusion visits for those
 * days ([{ patientName, doctorName, date: 'MM/DD/YYYY', href }]) — supplied by the
 * caller so the schedule reading stays in one place.
 */
async function runChartReview({ page, readSchedule, providers = [], mainDoctors = [], onStep = () => {}, onResult = () => {}, today = new Date(), only = null }) {
  const say = (m) => { try { onStep(m); } catch {} };
  const ws0 = mondayOf(today), ws1 = new Date(ws0.getTime() + 7 * DAY);
  const dates = [];
  for (let i = 0; i < 14; i++) { const d = new Date(ws0.getTime() + i * DAY); dates.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`); }
  say(`Reading the Practice Fusion schedule for this week and next (${dates[0]} → ${dates[13]})…`);
  const visits = await readSchedule(dates);
  const DISC = { GP: 'PT', GO: 'OT', GN: 'SLP' };
  const clients = new Map();
  for (const v of visits) {
    if (!v.patientName || isNonPatient(v.patientName)) continue;
    const k = patientKey(v.patientName);
    if (only && !only.includes(k)) continue;
    const { provider } = matchProvider(v.doctorName, providers);
    const discipline = provider ? (DISC[mainCodeFor(provider.mainDoctor, mainDoctors)] || parseDisciplines(provider.discipline)[0] || '') : '';
    const [mm, dd, yy] = String(v.date).split('/').map(Number);
    const c = clients.get(k) || { patientKey: k, patientName: v.patientName, href: '', visits: [] };
    c.visits.push({ date: new Date(yy, mm - 1, dd), discipline });
    if (!c.href && v.href) c.href = v.href;
    clients.set(k, c);
  }
  say(`${clients.size} client${clients.size === 1 ? '' : 's'} scheduled — reviewing each chart.`);
  const results = [];
  let i = 0;
  for (const c of clients.values()) {
    i += 1;
    say(`(${i}/${clients.size}) ${c.patientName}…`);
    let r;
    try {
      const id = await findChartId(page, c.patientName, c.href, say);
      if (!id) r = { ok: false, patientKey: c.patientKey, patientName: c.patientName, error: 'Couldn\'t find this chart in Practice Fusion.' };
      else {
        const pages = await readChart(page, id);
        const items = reviewChart(pages, { today, providers, visits: c.visits, weekStarts: [ws0, ws1] });
        if (pages.documentsFilter === 'pending-only') items.find((x) => x.key === 'referral').notes.push('Only "Pending" documents could be listed — signed ones weren\'t checked.');
        r = { ok: true, patientKey: c.patientKey, patientName: c.patientName, chartId: id, items };
        const bad = items.filter((x) => x.status !== 'ok').length;
        say(`  ${bad ? `${bad} item${bad === 1 ? '' : 's'} to fix` : 'all 9 items OK ✓'}`);
      }
    } catch (e) {
      r = { ok: false, patientKey: c.patientKey, patientName: c.patientName, error: (e && e.message) || String(e) };
    }
    r.reviewedAt = new Date().toISOString();
    results.push(r);
    try { onResult(r); } catch {}
  }
  return results;
}

module.exports = {
  ITEMS, parseLooseDate, parseDisciplines, parseDiagnoses, parsePinnedNote, parseProfile,
  parseEncounters, therapistsIn, toggleState, reviewChart, mergeFollowUps, runChartReview, mondayOf, patientKey,
};
