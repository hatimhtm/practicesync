'use strict';

/*
 * The full sync orchestrator: Practice Fusion (read) → SimplePractice (book).
 *
 *   1. Log in to Practice Fusion (pausing for the phone code if asked).
 *   2. For each date in the range, navigate the Schedule there and read every
 *      appointment, planning each against the roster (main doctor + codes).
 *   3. Log in to SimplePractice.
 *   4. For each date, read the clients already on that day's calendar (de-dup),
 *      then book only the MISSING ones — the number booked for a patient equals
 *      the number Practice Fusion shows for them that day (so two real visits
 *      both get booked, but a re-run never duplicates).
 *
 * `save:false` fills the form without saving (a safe dry run). Everything is
 * driven with the visible cursor + HUD.
 */

const { JSDOM } = require('jsdom');
const presets = require('./presets');
const liveEngine = require('./liveEngine');
const login = require('./login');
const book = require('./book');
const { extractVisits } = require('./extract');
const { planAppointments } = require('./automation');
const { isNonPatient, sameName, payerStatusFor, normalizeName } = require('./model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (onStep, m) => { try { if (typeof onStep === 'function') onStep(m); } catch {} };

function parseHeadingDay(s) { const d = new Date(String(s || '').replace(/^[A-Za-z]+,\s*/, '')); return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function parseTargetDay(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(s); return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
const fmtMDY = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

/** Expand a start (+optional end) into a list of MM/DD/YYYY day strings. */
function expandDates(start, end) {
  const s = parseTargetDay(start); if (!s) return [];
  const e = end ? parseTargetDay(end) : s;
  if (!e || e < s) return [fmtMDY(s)];
  const out = []; const d = new Date(s);
  while (d <= e && out.length < 60) { out.push(fmtMDY(new Date(d))); d.setDate(d.getDate() + 1); }
  return out;
}

/**
 * A staggered start time so a day's appointments don't all stack on the same slot.
 * Spread evenly across 9:00 AM–5:00 PM, ~1 hour apart, compressed if there are many.
 * Returns "9:00 AM", "10:00 AM", … (the format SimplePractice's time box accepts).
 */
function staggeredTime(index, total) {
  const startMin = 9 * 60;   // 9:00 AM
  const endMin = 17 * 60;    // 5:00 PM
  const step = total > 1 ? Math.min(60, Math.floor((endMin - startMin) / (total - 1))) : 0;
  const mins = Math.min(endMin, startMin + index * step);
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Order a day's visits: each patient's 1st session, then 2nd sessions, then 3rd. */
function spreadSessions(group) {
  const seen = {};
  const rounds = [];
  for (const appt of group) {
    const k = normalizeName(appt.patientName).split(' ').filter(Boolean).sort().join(' ');
    const n = seen[k] = (seen[k] || 0) + 1;
    (rounds[n - 1] = rounds[n - 1] || []).push(appt);
  }
  return rounds.flat();
}

/* --------------------------- outcomes per visit --------------------------- */
// Every Practice Fusion visit ends up with an outcome, so nothing can go missing
// silently: booked, already there, skipped by a rule, or NOT booked with the
// reason and the therapist (several therapists can see one patient on one day).

/** Why a therapist on Practice Fusion couldn't be matched, in the office's words. */
function unmatchedReason(appt) {
  const who = appt.doctorName ? `“${appt.doctorName}”` : 'the therapist';
  const r = String(appt.reason || '');
  if (/no doctor name/.test(r)) return 'Practice Fusion shows no therapist for this visit';
  if (/ambiguous/.test(r)) return `${who} could be more than one therapist on Doctors & Codes — give them their full name there`;
  if (/not found in Practice Fusion|no visits/.test(r)) return r;
  return `${who} isn't on Doctors & Codes — add them under their billing provider`;
}

/** A visit's outcome line: { date, patientName, therapist, discipline, status, reason, warnings } */
function outcome(appt, status, reason = '', warnings = []) {
  return {
    date: appt.date || '', patientName: appt.patientName || '', patientId: appt.patientId || '',
    therapist: appt.therapist || appt.doctorName || '', discipline: appt.discipline || '',
    billingProvider: appt.mainDoctor || '', status, reason, warnings: warnings.filter(Boolean),
  };
}

const PROBLEM = new Set(['unmatched', 'client_not_found', 'clinician', 'failed', 'unverified', 'possible_duplicate', 'cancel_unclear', 'cancelled_on_calendar', 'record', 'service', 'codes']);
/** Not a failure, but something for the office to do (a new client to add to the list). */
const REMINDER = new Set(['new_client']);
/** Booking results that are their own kind on the Alerts screen. */
const BOOK_REASONS = new Set(['client_not_found', 'clinician', 'record', 'service', 'codes']);

/**
 * Sort one day's planned visits by their Practice Fusion cancellation (see
 * model.cancellationOf), in the office's rule:
 *   CX>24 / Therapist CX → never added ('cancelled', kept to check the calendar)
 *   CX<24                → added like any visit, flagged as a late cancel
 *   cancelled / no-show with no term, or two terms → held for the office
 * → { keep: [...plans to book or report], cancelled: [...], outcomes: [...] }
 */
function sortCancellations(planned) {
  const keep = [], cancelled = [], outcomes = [];
  for (const p of planned) {
    const c = p.cancel || { kind: 'none' };
    if (c.kind === 'over24' || c.kind === 'therapist') {
      cancelled.push(p);
      outcomes.push(outcome(p, 'cancelled', `${c.term} in Practice Fusion — not added to SimplePractice`));
    } else if (c.kind === 'no_term' || c.kind === 'conflict') {
      outcomes.push(outcome(p, 'cancel_unclear', c.kind === 'conflict'
        ? `Practice Fusion has two cancellation terms on this visit (${c.term}), so it wasn't added. Leave just one (CX>24, CX<24 or Therapist CX) and sync again.`
        : `Practice Fusion shows "${c.status}" but none of CX>24, CX<24 or Therapist CX, so it wasn't added. Add the term to the visit in Practice Fusion; the next sync adds it if it's CX<24.`));
    } else {
      if (c.kind === 'under24') p.warnings = [...(p.warnings || []), 'Late cancel (CX<24) in Practice Fusion. Added to SimplePractice as the office asked; check it\'s billed as a late cancel.'];
      keep.push(p);
    }
  }
  return { keep, cancelled, outcomes };
}

/** One reminder per client who isn't on the Clients list yet (never for a visit that won't be added). */
function newClientReminders(plans, already = new Set()) {
  const out = [];
  for (const p of plans) {
    const k = normalizeName(p.patientName).split(' ').filter(Boolean).sort().join(' ');
    if (!p.newClient || !k || already.has(k)) continue;
    already.add(k);
    out.push(outcome({ ...p, therapist: '', discipline: '', mainDoctor: '' }, 'new_client', 'New client: not on the Clients list yet. Add them there with their payer type and their codes for each therapist, so their visits get the right codes.'));
  }
  return out;
}

/**
 * After a day is booked: a visit cancelled CX>24 / Therapist CX that is STILL on
 * the SimplePractice calendar (it was added before it was cancelled). Never
 * deleted by the app — the office removes it. `pool` holds the calendar entries
 * the day's real visits didn't account for.
 */
function cancelledStillBooked(pool, cancelled) {
  const out = [];
  for (const p of cancelled) {
    const disc = String(p.discipline || '').toLowerCase();
    if (takeExistingFrom(pool, p.patientName, /^(pt|ot|slp)$/.test(disc) ? disc : '', p.mainDoctor || '')) {
      out.push(outcome(p, 'cancelled_on_calendar', `${(p.cancel && p.cancel.term) || 'Cancelled'} in Practice Fusion, but it's on the SimplePractice calendar (it was added before it was cancelled). Delete it in SimplePractice so it isn't billed.`));
    }
  }
  return out;
}

/** "Toby Fakename — Nardeen Abdelsayed (PT)" */
function visitLabel(o) {
  const who = [o.therapist, o.discipline && `(${o.discipline})`].filter(Boolean).join(' ');
  return `${o.patientName}${who ? ` — ${who}` : ''}`;
}

// The calendar may show a client as "Jane OT Doe" or "Jane Self Pay Doe"; those
// words aren't part of the name Practice Fusion shows.
function plainTitle(t) { return String(t || '').replace(/\bself[\s-]?pay\b/ig, ' '); }

/**
 * Does the day's calendar already hold this visit? Takes (removes) the matching
 * entry from `pool` — each calendar entry accounts for ONE visit. Names match in
 * any order or format; a title's PT/OT/SLP tag must fit the visit's discipline
 * ("Toby PT/OT Fakename" is one record for both PT and OT); an untagged title
 * fits any visit, as before.
 */
function takeExistingFrom(pool, name, disc, billing = '') {
  const want = String(disc || '').toLowerCase();
  const tagsOf = (n) => (entryTitle(n).match(/\b(pt|ot|slp)\b/gi) || []).map((t) => t.toLowerCase());
  const same = pool.map((n, i) => ({ n, i }))
    .filter(({ n }) => sameClient(entryTitle(n), name) && !otherColumn(n, billing));
  // An entry in this visit's own billing provider's column is the surest match.
  const pick = same.find(({ n }) => billing && entryClinician(n))
    || same.find(({ n }) => want && tagsOf(n).includes(want))
    || same.find(({ n }) => !tagsOf(n).length)
    || (!want ? same[0] : null);
  if (!pick) return false;
  pool.splice(pick.i, 1);
  return true;
}

/** A calendar entry is a title string, or { title, clinician } when its column is
 *  known. The clinician is the billing provider, so an entry in ANOTHER provider's
 *  column is a different session (Jane's OT with Heather isn't her PT with Caryn). */
const entryTitle = (e) => (e && typeof e === 'object' ? e.title : String(e || ''));
const entryClinician = (e) => (e && typeof e === 'object' ? e.clinician || '' : '');
const otherColumn = (e, billing) => { const c = entryClinician(e); return !!(c && billing && !book.namesPerson(c, billing)); };

/** Same person: the exact name in any order, or the same first and last name with
 *  a middle name/initial on one side only ("Mary E Moran" = "Mary PT/OT/SLP Moran"). */
function sameClient(title, name) {
  if (sameName(plainTitle(title), name)) return true;
  const a = nameTokens(title), b = nameTokens(name);
  if (a.length < 2 || b.length < 2 || a.length === b.length) return false;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

/** An entry for this client in a column that no visit of theirs today bills under. */
function strayEntry(pool, name, group) {
  const billings = group.filter((a) => sameClient(a.patientName, name)).map((a) => a.mainDoctor).filter(Boolean);
  return pool.find((e) => {
    const c = entryClinician(e);
    return c && sameClient(entryTitle(e), name) && !billings.some((b) => book.namesPerson(c, b));
  }) || null;
}

/** Name tokens, lowercased, without discipline / self-pay tags. */
function nameTokens(n) {
  return normalizeName(plainTitle(n)).split(' ').filter((t) => t && !/^(pt|ot|slp)$/.test(t));
}
/**
 * A looser "same client?" for the duplicate check: same last name and first
 * names that agree on their first 3 letters or where one starts the other
 * ("Sam Placeholder" ~ "Samuel Placeholder", "Liz Testerly" is NOT "Elizabeth
 * Testerly" but "Eliza Testerly" is). Used only to HOLD a booking for review — never to book.
 */
function looseSameClient(title, name) {
  const a = nameTokens(title), b = nameTokens(name);
  if (a.length < 2 || b.length < 2) return false;
  const lastA = a[a.length - 1], lastB = b[b.length - 1];
  const surname = lastA === lastB || a.includes(lastB) || b.includes(lastA);
  if (!surname) return false;
  const fa = a[0] === lastB ? a[1] : a[0], fb = b[0] === lastA ? b[1] : b[0];
  if (!fa || !fb) return false;
  return fa.startsWith(fb) || fb.startsWith(fa) || (fa.length >= 3 && fb.length >= 3 && fa.slice(0, 3) === fb.slice(0, 3));
}
/**
 * A calendar entry that may be this visit under a different spelling. NOT one
 * that's the same exact name (that person's other session — the PT/OT/SLP check
 * already decided it isn't this visit), and NOT one tagged for another
 * discipline ("Jane PT Doe" is her PT session, not her OT one): a patient can
 * have several sessions a day, and every Practice Fusion visit is a real one.
 */
function findLooseExisting(pool, name, disc, billing = '') {
  const want = String(disc || '').toLowerCase();
  const tagsOf = (n) => (String(n).match(/\b(pt|ot|slp)\b/gi) || []).map((t) => t.toLowerCase());
  const hit = pool.find((e) => {
    const t = entryTitle(e);
    if (sameClient(t, name) || otherColumn(e, billing)) return false;
    const tags = tagsOf(t);
    if (tags.length && want && !tags.includes(want)) return false;
    return looseSameClient(t, name);
  });
  return hit ? entryTitle(hit) : '';
}

/**
 * The local booking record: every visit this Mac has saved in SimplePractice.
 * A visit already in it is never booked again, even if the calendar read misses
 * it. `n` numbers a patient's repeat visits with the same therapist on one day,
 * so a genuine second visit still gets its own entry.
 */
function ledgerKey(appt, n = 1) {
  const sortTokens = (x) => normalizeName(x).split(' ').filter(Boolean).sort().join(' ');
  return [appt.date || '', sortTokens(appt.patientName), String(appt.discipline || '').toLowerCase(), sortTokens(appt.therapist || appt.doctorName || ''), n].join('|');
}

/** Walk the Practice Fusion day arrows (visible cursor) until the heading matches. */
async function pfNavigateToDate(page, target, onStep) {
  const want = parseTargetDay(target); if (!want) return false;
  for (let i = 0; i < 200; i++) {
    const el = await page.$(presets.PF.nav.dateHeading);
    const cur = parseHeadingDay(el ? await el.textContent() : '');
    if (!cur) { await sleep(400); continue; }
    if (Math.round((want - cur) / 86400000) === 0) return true;
    const btn = want > cur ? presets.PF.nav.nextDay : presets.PF.nav.prevDay;
    await liveEngine.stage(page, 'moveTo', btn).catch(() => {});
    await page.click(btn, { timeout: 4000 }).catch(() => {});
    await sleep(550); await login.dismissPopups(page);
  }
  return false;
}

/** Wait for a day's appointment rows to load and stop changing (an empty day is fine). */
async function waitForDayRows(page) {
  let last = -1, steady = 0;
  for (let i = 0; i < 20 && steady < 2; i++) {
    await sleep(300);
    const n = await page.$$eval(presets.PF.selectors.rowSelector, (r) => r.length).catch(() => 0);
    steady = n === last ? steady + 1 : 0;
    last = n;
  }
}

/**
 * Read the Practice Fusion schedule for each day, for the chart review: every
 * visit with its patient, therapist and the patient's chart link (the name is a
 * link to the chart). A day whose heading can't be reached is skipped and said.
 */
async function readPfSchedule(page, dates, onStep) {
  const out = [];
  // Open the schedule ONCE and walk forward a day at a time (the dates are
  // consecutive) — reopening it from today for every day was the slow part.
  await page.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await login.dismissPopups(page);
  for (const date of dates) {
    if (!(await pfNavigateToDate(page, date, onStep))) {
      // Lost the schedule (a popup, a reload) — reopen it once and try again.
      await page.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await login.dismissPopups(page);
      if (!(await pfNavigateToDate(page, date, onStep))) { say(onStep, `  ⚠︎ Couldn't open the Practice Fusion schedule on ${date} — skipped.`); continue; }
    }
    await waitForDayRows(page);
    const html = await page.content();
    const doc = new JSDOM(html).window.document;
    const rows = extractVisits(doc, presets.PF.selectors, 400);
    const links = [...doc.querySelectorAll(presets.PF.selectors.rowSelector)].map((row) => {
      const a = row.querySelector(presets.PF.selectors.patientSelector);
      return (a && (a.getAttribute('href') || '')) || '';
    });
    rows.forEach((v, i) => out.push({ patientName: (v.patientName || '').trim(), doctorName: (v.doctorName || '').trim(), date, href: links[i] || '' }));
    say(onStep, `  ${date}: ${rows.length} visit${rows.length === 1 ? '' : 's'}`);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.secrets   { practiceFusion:{username,password}, simplePractice:{email,password} }
 * @param {string[]} opts.dates   MM/DD/YYYY days to sync (use expandDates for a range)
 * @param {Array}  opts.providers roster
 * @param {Array}  opts.mainDoctors
 * @param {boolean} opts.save     true = actually book; false = dry run (fill only)
 * @param {function} opts.onStep
 * @param {function} opts.onMissingPatient  called with a patient name the SimplePractice
 *   search couldn't find (never called for agency/org rows — those are dropped earlier)
 */
async function runFullSync({ secrets, dates, providers, mainDoctors, selfPayClients = [], clientPayers = [], bookedVisits = [], onBooked = null, save = false, onStep, onMissingPatient, overrides = null, context: existing } = {}) {
  const result = { ok: true, planned: [], booked: 0, skipped: 0, failed: 0, unmatched: 0, missingPatients: [], outcomes: [], dryRun: !save };
  const own = !existing;
  let context = existing;
  if (!context) {
    const r = await liveEngine.openAutomationContext({ headless: false });
    if (r.error) return { ok: false, error: r.error.error || r.error };
    context = r.context;
  }
  const page = context.pages()[0] || (await context.newPage());
  try {
    // 1) Practice Fusion login (may pause for 2FA).
    const pf = await login.loginPracticeFusion(page, secrets.practiceFusion, { onStep });
    if (!pf.ok) return { ok: false, error: pf.error };

    // 2) Read + plan each date.
    const all = [];
    const cancelledByDate = {};
    const remindedClients = new Set();
    for (const date of dates) {
      say(onStep, `Reading Practice Fusion for ${date}…`);
      await page.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await login.dismissPopups(page);
      await liveEngine.ensureStage(page).catch(() => {});
      await pfNavigateToDate(page, date, onStep);
      try { await page.waitForSelector(presets.PF.selectors.rowSelector, { timeout: 15000 }); } catch {}
      await sleep(1000); await login.dismissPopups(page);
      const doc = new JSDOM(await page.content()).window.document;
      const allRows = extractVisits(doc, presets.PF.selectors, 300)
        .map((v) => ({ ...v, patientName: (v.patientName || '').trim(), doctorName: (v.doctorName || '').trim(), date }));
      // Drop organization rows (e.g. "…Contract Agency") — they aren't patients and
      // have no SimplePractice client, so they must never be booked.
      const visits = allRows.filter((v) => {
        if (isNonPatient(v.patientName)) { result.skipped += 1; result.outcomes.push(outcome({ ...v, therapist: v.doctorName }, 'agency', 'not a patient (agency/contract entry)')); say(onStep, `Skip ${v.patientName} — not a patient (agency/contract entry)`); return false; }
        // Contracted clients are billed through their contract — never added to SimplePractice.
        if (payerStatusFor(v.patientName, clientPayers) === 'contracted') { result.skipped += 1; result.outcomes.push(outcome({ ...v, therapist: v.doctorName }, 'contracted', 'contracted — billed through the contract')); say(onStep, `Skip ${v.patientName} — contracted (not added to SimplePractice)`); return false; }
        return true;
      });
      const plannedAll = planAppointments(visits, providers, mainDoctors, selfPayClients, clientPayers);
      plannedAll.forEach((p) => { p.date = date; });
      // Cancellations first: CX>24 / Therapist CX are never added, a cancellation
      // with no term is held, CX<24 goes on like any visit.
      const sorted = sortCancellations(plannedAll);
      for (const o of sorted.outcomes) {
        result.outcomes.push(o);
        if (o.status === 'cancelled') { result.skipped += 1; say(onStep, `Skip ${o.patientName}${o.therapist ? ` (${o.therapist})` : ''} on ${date} — ${o.reason}`); }
        else { result.failed += 1; say(onStep, `Not booked: ${visitLabel(o)} on ${date} — ${o.reason}`); }
      }
      if (sorted.cancelled.length) cancelledByDate[date] = sorted.cancelled.filter((p) => p.matched);
      const planned = sorted.keep;
      result.outcomes.push(...newClientReminders(planned, remindedClients));
      const matched = planned.filter((p) => p.matched);
      result.unmatched += planned.length - matched.length;
      matched.forEach((p) => { all.push(p); });
      say(onStep, `  ${date}: ${plannedAll.length} visit${plannedAll.length === 1 ? '' : 's'} read${sorted.outcomes.length ? ` (${sorted.outcomes.length} cancelled)` : ''}, ${matched.length} matched to a therapist`);
      // Name every visit whose therapist isn't recognized — never just a count.
      for (const p of planned.filter((x) => !x.matched)) {
        p.date = date;
        const o = outcome(p, 'unmatched', unmatchedReason(p));
        result.outcomes.push(o);
        say(onStep, `Not booked: ${visitLabel(o)} on ${date} — ${o.reason}`);
      }
    }
    result.planned = all;
    const hasCancelled = Object.values(cancelledByDate).some((l) => l.length);
    if (!all.length && !hasCancelled) { say(onStep, 'No matched appointments to book.'); reportProblems(result, onStep); return result; }

    // 3) SimplePractice login.
    const sp = await login.loginSimplePractice(page, secrets.simplePractice, { onStep });
    if (!sp.ok) return { ok: false, error: sp.error };

    // 4) Book per date, skipping clients already on that day's calendar.
    const byDate = {};
    for (const p of all) (byDate[p.date] = byDate[p.date] || []).push(p);
    // Days with only cancelled visits are still opened, to catch one already on the calendar.
    for (const d of Object.keys(cancelledByDate)) if (cancelledByDate[d].length && !byDate[d]) byDate[d] = [];
    const ledger = new Set((bookedVisits || []).map((b) => (typeof b === 'string' ? b : b && b.key)).filter(Boolean));
    for (const date of dates.filter((d) => byDate[d])) {
      // Never book a day we couldn't check: if the calendar won't open on this
      // date, or its appointments can't be read, book NOTHING for the day — an
      // unread calendar looks empty, and that is how a visit gets billed twice.
      const onDay = await book.spNavigateToDate(page, date, onStep);
      const day = onDay ? await book.spReadDay(page, date) : { ok: false, titles: [] };
      if (!day.ok) {
        const why = onDay ? 'couldn\'t read the SimplePractice calendar for this day' : 'couldn\'t open the SimplePractice calendar on this day';
        say(onStep, `⚠︎ ${date}: ${why} — not booking this day, so nothing is booked twice.`);
        for (const appt of byDate[date]) {
          result.failed += 1;
          result.outcomes.push(outcome(appt, 'unverified', `${why}, so it wasn't booked (to avoid a double booking). Run the sync again, or check the calendar and book by hand.`));
        }
        continue;
      }
      // Only a column headed by one of the billing providers counts as "whose column"
      // (a Week view's columns are headed by dates, not people).
      const isBilling = (c) => (mainDoctors || []).some((m) => book.namesPerson(c, m.name || m));
      const existingClients = day.titles.map((t) => ({ title: t.title, clinician: isBilling(t.clinician) ? t.clinician : '' }));
      const ledgerToday = (key) => ledger.has(key) && !existingClients.length;
      say(onStep, `SimplePractice already has ${existingClients.length} appointment${existingClients.length === 1 ? '' : 's'} on ${date} — checking each visit against them.`);
      // A mutable pool of the names already on today's calendar: each entry can
      // only account for ONE of this patient's visits, and is matched word-order/
      // format independent (sameName — "Doe, Jane" on the calendar still matches
      // a "Jane Doe" visit from Practice Fusion) so a formatting difference never
      // causes the same visit to be re-booked as a duplicate.
      // When the calendar title carries a discipline ("Jane OT Doe"), an OT entry
      // only accounts for the OT visit — never for the same patient's PT visit, or
      // the PT gets skipped as "already booked" while the OT is booked twice.
      const existingPool = existingClients.slice();
      const takeExisting = (name, disc, billing) => takeExistingFrom(existingPool, name, disc, billing);
      const group = byDate[date];
      // Give each of the day's appointments its own time across 9am–5pm, so they
      // don't all land on the same slot (the same-time stacking the user saw).
      // A patient's 2nd/3rd session that day goes after everyone's 1st, so the same
      // patient's sessions are hours apart instead of back-to-back 10 minutes apart.
      group.splice(0, group.length, ...spreadSessions(group));
      group.forEach((appt, i) => { appt.time = staggeredTime(i, group.length); });

      const repeat = {};
      for (const appt of group) {
        const disc = appt.selfPay ? '' : String(appt.discipline || '').toLowerCase();
        const base = ledgerKey(appt, 0);
        repeat[base] = (repeat[base] || 0) + 1;
        const key = ledgerKey(appt, repeat[base]);
        const billing = appt.mainDoctor || '';
        if (takeExisting(appt.patientName, disc === 'slp' || disc === 'ot' || disc === 'pt' ? disc : '', billing)) {
          result.skipped += 1; result.outcomes.push(outcome(appt, 'already', 'already on the SimplePractice calendar'));
          say(onStep, `Skip ${appt.patientName} (${appt.therapist}) on ${date} — already booked`); continue;
        }
        // SimplePractice's calendar is the truth: if a visit isn't on it, it isn't
        // billed, so it's booked — even if this app booked it before (someone removed
        // it). The record only speaks up when the calendar shows NOTHING at all that
        // day though visits were booked: that looks like a calendar that didn't load.
        if (ledgerToday(key)) {
          result.failed += 1;
          result.outcomes.push(outcome(appt, 'unverified', 'SimplePractice shows no appointments this day, but this app booked this visit earlier, so it wasn\'t booked again. If they were deleted on purpose, use "Forget earlier bookings" on the Alerts screen and sync again.'));
          say(onStep, `⚠︎ Holding ${appt.patientName} (${appt.therapist}) on ${date} — booked earlier, but the calendar shows nothing this day.`); continue;
        }
        if (ledger.has(key)) say(onStep, `${appt.patientName} (${appt.therapist}) was booked earlier but is no longer on the calendar — booking it again.`);
        // Same client in a column none of their visits today bill under: it may be
        // THIS visit booked under another provider — hold it rather than risk a
        // second charge. (A column one of their visits bills under is that session.)
        const stray = strayEntry(existingPool, appt.patientName, group);
        if (stray) {
          result.failed += 1;
          result.outcomes.push(outcome(appt, 'possible_duplicate', `“${entryTitle(stray)}” is already on ${entryClinician(stray)}'s column that day, which isn't this visit's billing provider (${billing}). It may be this visit under the wrong provider, so it wasn't booked. Check the calendar: move or delete that entry, then sync again, or book it by hand.`));
          say(onStep, `⚠︎ Holding ${appt.patientName} (${appt.therapist}) on ${date} — “${entryTitle(stray)}” is on ${entryClinician(stray)}'s column.`); continue;
        }
        const similar = findLooseExisting(existingPool, appt.patientName, disc === 'slp' || disc === 'ot' || disc === 'pt' ? disc : '', billing);
        if (similar) {
          result.failed += 1;
          result.outcomes.push(outcome(appt, 'possible_duplicate', `“${similar}” is already on the calendar that day and looks like the same client, so it wasn't booked. If it's a different person, book it by hand.`));
          say(onStep, `⚠︎ Holding ${appt.patientName} (${appt.therapist}) on ${date} — “${similar}” is already on the calendar; looks like the same client.`); continue;
        }
        let r;
        try { r = await book.bookAppointment(page, appt, { onStep, dryRun: !save, overrides }); }
        catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        const warnings = [...(appt.warnings || []), ...((r && r.warnings) || [])];
        if (r.ok) {
          result.booked += 1;
          if (save) {
            ledger.add(key);
            if (typeof onBooked === 'function') { try { onBooked(key); } catch {} }
          }
          result.outcomes.push(outcome(appt, save ? 'booked' : 'would-book', '', warnings));
          for (const w of warnings) say(onStep, `⚠︎ Check ${appt.patientName}: ${w}`);
        } else {
          result.failed += 1;
          const status = BOOK_REASONS.has(r.reason) ? r.reason : 'failed';
          const why = status === 'client_not_found' ? `“${appt.patientName}” wasn't found in SimplePractice's client search.${/search showed/.test(r.error || '') ? ` ${String(r.error).replace(/^.*?(SimplePractice's search showed)/, '$1')}` : ''}` : r.error;
          result.outcomes.push(outcome(appt, status, why, warnings));
          say(onStep, `Could not book ${appt.patientName} (${appt.therapist}): ${r.error}`);
          if (status === 'client_not_found') {
            result.missingPatients.push(appt.patientName);
            say(onStep, `Alert: patient "${appt.patientName}" not found in SimplePractice search.`);
            if (typeof onMissingPatient === 'function') { try { onMissingPatient(appt.patientName, appt.date); } catch {} }
          }
        }
      }
      // A visit cancelled CX>24 / Therapist CX that's still on the calendar (it
      // was added before the cancellation): the office deletes it.
      for (const o of cancelledStillBooked(existingPool, cancelledByDate[date] || [])) {
        result.outcomes.push(o);
        say(onStep, `⚠︎ ${visitLabel(o)} on ${date} — ${o.reason}`);
      }
    }
    say(onStep, `Done — ${result.booked} booked, ${result.skipped} skipped (already there / not a patient), ${result.failed} failed, ${result.unmatched} unrecognized.`);
    reportProblems(result, onStep);
    return result;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), ...result };
  } finally {
    if (own) { try { await context.close(); } catch {} }
  }
}

/** End of a run: every visit that was NOT booked, and every booking to check, by name. */
function reportProblems(result, onStep) {
  const onCalendar = result.outcomes.filter((o) => o.status === 'cancelled_on_calendar');
  const problems = result.outcomes.filter((o) => PROBLEM.has(o.status) && o.status !== 'cancelled_on_calendar');
  const checks = result.outcomes.filter((o) => (o.status === 'booked' || o.status === 'would-book') && o.warnings.length);
  const newClients = result.outcomes.filter((o) => o.status === 'new_client');
  if (problems.length) {
    say(onStep, `Not booked (${problems.length}) — these need a look:`);
    for (const o of problems) say(onStep, `• ${visitLabel(o)} on ${o.date} — ${o.reason}`);
  }
  if (onCalendar.length) {
    say(onStep, `Cancelled, but on SimplePractice (${onCalendar.length}) — delete these there:`);
    for (const o of onCalendar) say(onStep, `• ${visitLabel(o)} on ${o.date} — ${o.reason}`);
  }
  if (checks.length) {
    say(onStep, `Booked, but check (${checks.length}):`);
    for (const o of checks) say(onStep, `• ${visitLabel(o)} on ${o.date} — ${o.warnings.join(' · ')}`);
  }
  if (newClients.length) {
    say(onStep, `New clients to add on the Clients screen (${newClients.length}):`);
    for (const o of newClients) say(onStep, `• ${o.patientName} (first seen ${o.date})`);
  }
}

module.exports = { runFullSync, readPfSchedule, expandDates, pfNavigateToDate, PROBLEM, REMINDER, takeExistingFrom, unmatchedReason, looseSameClient, ledgerKey, findLooseExisting, spreadSessions, strayEntry, sortCancellations, newClientReminders, cancelledStillBooked };
