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

const PROBLEM = new Set(['unmatched', 'client_not_found', 'clinician', 'failed']);

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
function takeExistingFrom(pool, name, disc) {
  const want = String(disc || '').toLowerCase();
  const tagsOf = (n) => (String(n).match(/\b(pt|ot|slp)\b/gi) || []).map((t) => t.toLowerCase());
  const same = pool.map((n, i) => ({ n, i })).filter(({ n }) => sameName(plainTitle(n), name));
  const pick = same.find(({ n }) => want && tagsOf(n).includes(want))
    || same.find(({ n }) => !tagsOf(n).length)
    || (!want ? same[0] : null);
  if (!pick) return false;
  pool.splice(pick.i, 1);
  return true;
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
async function runFullSync({ secrets, dates, providers, mainDoctors, selfPayClients = [], clientPayers = [], save = false, onStep, onMissingPatient, overrides = null, context: existing } = {}) {
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
      const planned = planAppointments(visits, providers, mainDoctors, selfPayClients, clientPayers);
      const matched = planned.filter((p) => p.matched);
      result.unmatched += planned.length - matched.length;
      matched.forEach((p) => { p.date = date; all.push(p); });
      say(onStep, `  ${date}: ${planned.length} visit${planned.length === 1 ? '' : 's'} read, ${matched.length} matched to a therapist`);
      // Name every visit whose therapist isn't recognized — never just a count.
      for (const p of planned.filter((x) => !x.matched)) {
        p.date = date;
        const o = outcome(p, 'unmatched', unmatchedReason(p));
        result.outcomes.push(o);
        say(onStep, `Not booked: ${visitLabel(o)} on ${date} — ${o.reason}`);
      }
    }
    result.planned = all;
    if (!all.length) { say(onStep, 'No matched appointments to book.'); reportProblems(result, onStep); return result; }

    // 3) SimplePractice login.
    const sp = await login.loginSimplePractice(page, secrets.simplePractice, { onStep });
    if (!sp.ok) return { ok: false, error: sp.error };

    // 4) Book per date, skipping clients already on that day's calendar.
    const byDate = {};
    for (const p of all) (byDate[p.date] = byDate[p.date] || []).push(p);
    for (const date of Object.keys(byDate)) {
      await book.spNavigateToDate(page, date, onStep);
      const existingClients = await book.spClientsOnDate(page);
      // A mutable pool of the names already on today's calendar: each entry can
      // only account for ONE of this patient's visits, and is matched word-order/
      // format independent (sameName — "Doe, Jane" on the calendar still matches
      // a "Jane Doe" visit from Practice Fusion) so a formatting difference never
      // causes the same visit to be re-booked as a duplicate.
      // When the calendar title carries a discipline ("Jane OT Doe"), an OT entry
      // only accounts for the OT visit — never for the same patient's PT visit, or
      // the PT gets skipped as "already booked" while the OT is booked twice.
      const existingPool = existingClients.slice();
      const takeExisting = (name, disc) => takeExistingFrom(existingPool, name, disc);
      const group = byDate[date];
      // Give each of the day's appointments its own time across 9am–5pm, so they
      // don't all land on the same slot (the same-time stacking the user saw).
      group.forEach((appt, i) => { appt.time = staggeredTime(i, group.length); });

      for (const appt of group) {
        const disc = appt.selfPay ? '' : String(appt.discipline || '').toLowerCase();
        if (takeExisting(appt.patientName, disc === 'slp' || disc === 'ot' || disc === 'pt' ? disc : '')) {
          result.skipped += 1; result.outcomes.push(outcome(appt, 'already', 'already on the SimplePractice calendar'));
          say(onStep, `Skip ${appt.patientName} (${appt.therapist}) on ${date} — already booked`); continue;
        }
        let r;
        try { r = await book.bookAppointment(page, appt, { onStep, dryRun: !save, overrides }); }
        catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        const warnings = [...(appt.warnings || []), ...((r && r.warnings) || [])];
        if (r.ok) {
          result.booked += 1;
          result.outcomes.push(outcome(appt, save ? 'booked' : 'would-book', '', warnings));
          for (const w of warnings) say(onStep, `⚠︎ Check ${appt.patientName}: ${w}`);
        } else {
          result.failed += 1;
          const status = r.reason === 'client_not_found' ? 'client_not_found' : r.reason === 'clinician' ? 'clinician' : 'failed';
          const why = status === 'client_not_found' ? `“${appt.patientName}” wasn't found in SimplePractice's client search` : r.error;
          result.outcomes.push(outcome(appt, status, why, warnings));
          say(onStep, `Could not book ${appt.patientName} (${appt.therapist}): ${r.error}`);
          if (status === 'client_not_found') {
            result.missingPatients.push(appt.patientName);
            say(onStep, `Alert: patient "${appt.patientName}" not found in SimplePractice search.`);
            if (typeof onMissingPatient === 'function') { try { onMissingPatient(appt.patientName, appt.date); } catch {} }
          }
        }
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
  const problems = result.outcomes.filter((o) => PROBLEM.has(o.status));
  const checks = result.outcomes.filter((o) => (o.status === 'booked' || o.status === 'would-book') && o.warnings.length);
  if (problems.length) {
    say(onStep, `Not booked (${problems.length}) — these need a look:`);
    for (const o of problems) say(onStep, `• ${visitLabel(o)} on ${o.date} — ${o.reason}`);
  }
  if (checks.length) {
    say(onStep, `Booked, but check (${checks.length}):`);
    for (const o of checks) say(onStep, `• ${visitLabel(o)} on ${o.date} — ${o.warnings.join(' · ')}`);
  }
}

module.exports = { runFullSync, expandDates, pfNavigateToDate, PROBLEM, takeExistingFrom, unmatchedReason };
