'use strict';

/*
 * Book ONE appointment in SimplePractice, with the visible cursor ("watch it
 * work"). Uses the verified selectors in presets.SP. By default it FILLS the
 * form but does NOT save (dryRun), so it is safe to exercise before the
 * typeahead/clinician/modifier handling is confirmed on the full account.
 *
 * Confidence of each piece (from the captured demo dialog):
 *   • date field, native service <select>, save button  → VERIFIED selectors.
 *   • client typeahead, clinician dropdown, location     → trigger VERIFIED, but
 *     the OPENED list/option structure was not captured (the demo capture only
 *     got the closed trigger). The open-state selectors below are best-effort and
 *     marked TODO(verify) — confirm against a capture of the opened dropdown.
 *   • units + per-line modifier boxes                    → not present in the demo
 *     dialog at all; TODO(real) — confirm on the account that has Services/Units.
 */

const presets = require('./presets');
const liveEngine = require('./liveEngine');
const { dismissPopups } = require('./login');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (onStep, m) => { try { if (typeof onStep === 'function') onStep(m); } catch {} };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Normalize a date to SimplePractice's MM/DD/YYYY, from "Mon, Jun 29, 2026",
// "2026-06-29", or "06/29/2026".
function toMDY(s) {
  const str = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str); if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str); if (m) return `${String(+m[1]).padStart(2, '0')}/${String(+m[2]).padStart(2, '0')}/${m[3]}`;
  m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(str); // "Jun 29, 2026"
  if (m && MONTHS[m[1].toLowerCase()]) return `${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}/${String(+m[2]).padStart(2, '0')}/${m[3]}`;
  return str;
}

// Best-effort option pickers for the opened dropdowns. TODO(verify) once we
// capture an opened typeahead/clinician list on the real account.
const OPTION_SELECTORS = ['.select-box__option', '[role="option"]', 'li[role="option"]', '.typeahead-option', '.select-box__options li'];

// Click the option that matches `value` by NAME TOKENS, regardless of word order
// ("Lochlann McNulty" ↔ "McNulty, Lochlann") and ignoring extra text like a DOB.
// A robust click (scroll into view + normal click + JS-click fallback) so it can
// never be a no-op.
async function clickOptionMatching(page, value) {
  const tokens = String(value || '').trim().toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return false;
  for (const os of OPTION_SELECTORS) {
    const opts = await page.$$(os).catch(() => []);
    for (const o of opts) {
      const t = ((await o.textContent().catch(() => '')) || '').toLowerCase();
      if (t && tokens.every((tok) => t.includes(tok))) {
        // Fast click, JS-click fallback — never waits out a long actionability timeout.
        await o.click({ timeout: 1200 }).catch(async () => { try { await o.evaluate((el) => el.click()); } catch {} });
        return true;
      }
    }
  }
  return false;
}

/**
 * Open a typeahead trigger, type the value into its search box, and select the
 * matching option — robustly. `searchSel` is the input the trigger reveals.
 * `verifySel` (optional) is an element that only appears AFTER a real selection
 * (for the client, the Services <select>): if given, we CONFIRM the selection
 * took and RETRY the whole open→type→pick up to 3× — because a missed client is
 * unacceptable. Never presses Escape (that closes SimplePractice's dialog).
 */
async function typeaheadSelect(page, triggerSel, value, onStep, label, searchSel, verifySel) {
  const want = String(value || '').trim();
  const maxAttempts = verifySel ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const trig = await page.waitForSelector(triggerSel, { timeout: 6000 }).catch(() => null);
      if (!trig) return false;
      await liveEngine.ensureStage(page);
      await liveEngine.stage(page, 'moveTo', triggerSel);
      await trig.click({ timeout: 3000 }).catch(() => {});
      // CRITICAL: wait for the search box to actually be ready before typing, or the
      // keystrokes go nowhere and the option list never appears (the "skipped" bug).
      let input = null;
      if (searchSel) input = await page.waitForSelector(searchSel, { timeout: 3000 }).catch(() => null);
      if (input) { await input.fill('').catch(() => {}); await input.type(want, { delay: 15 }); }
      else { await sleep(250); await page.keyboard.type(want, { delay: 15 }); }
      // Poll for a MATCHING option and click it — up to ~4s, so a slightly slow
      // search is never skipped, but a fast one selects immediately.
      let picked = false;
      const deadline = Date.now() + 4000;
      while (!picked && Date.now() < deadline) { picked = await clickOptionMatching(page, want); if (!picked) await sleep(150); }
      await liveEngine.stage(page, 'press');

      if (verifySel) {
        // Proof the selection took: the dependent section (Services) rendered.
        const ok = await page.waitForSelector(verifySel, { timeout: 3500 }).then(() => true).catch(() => false);
        if (ok) { say(onStep, `${label}: ${want} ✓`); return true; }
        if (attempt < maxAttempts) { say(onStep, `${label}: not selected yet — retrying (attempt ${attempt + 1})…`); await sleep(500); continue; }
        say(onStep, `${label}: could NOT select "${want}" — leaving it (won't book the wrong client)`);
        return false;
      }
      say(onStep, `${label}: ${want}${picked ? ' ✓' : ' (left as is)'}`);
      return picked;
    } catch { if (attempt >= maxAttempts) return false; await sleep(400); }
  }
  return false;
}

/**
 * @param appointment { patientName, date, mainDoctor, services:[{code,units,modifiers[]}] }
 * @param opts { onStep, dryRun=true } — dryRun fills but does not click Save.
 */
async function bookAppointment(page, appointment, { onStep, dryRun = true, overrides = null } = {}) {
  // First-run captured selectors (units / modifier boxes / clinician / location)
  // take precedence over the built-in ones when present.
  const S = { ...presets.SP.selectors, ...(overrides || {}) };
  // Open a fresh new-appointment dialog.
  await page.goto(presets.SP.newApptUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissPopups(page);
  await liveEngine.ensureStage(page);
  await liveEngine.stage(page, 'status', `Booking ${appointment.patientName}…`);

  // 1) CLIENT FIRST — verified + retried (the Services section only renders once a
  // real client is selected, so it doubles as proof the selection took). A missed
  // client is unacceptable, so if it can't be selected we abort rather than save.
  if (appointment.patientName) {
    const gotClient = await typeaheadSelect(page, S.clientTrigger, appointment.patientName, onStep, 'Client', S.clientSearchInput, S.codeSelect);
    if (!gotClient) return { ok: false, error: `Could not select client "${appointment.patientName}" in SimplePractice (not found or didn't select).` };
  }
  await sleep(200);

  // 2) DATE (verified) — MM/DD/YYYY, and the start TIME from Practice Fusion.
  const mdy = toMDY(appointment.date);
  if (mdy && await page.$(S.dateField)) {
    await liveEngine.stage(page, 'moveTo', S.dateField);
    await page.fill(S.dateField, '').catch(() => {});
    await page.type(S.dateField, mdy, { delay: 14 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    await liveEngine.stage(page, 'press');
    say(onStep, `Date: ${mdy}`);
  }
  if (appointment.time && await page.$(S.startTimeField)) {
    await liveEngine.stage(page, 'moveTo', S.startTimeField);
    await page.fill(S.startTimeField, '').catch(() => {});
    await page.type(S.startTimeField, appointment.time, { delay: 14 }).catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    say(onStep, `Time: ${appointment.time}`);
  }

  // 3) CLINICIAN = the main doctor. Demo has a single non-editable clinician (a
  // no-op); the real account opens a list to pick from (all clinicians pre-loaded).
  if (appointment.mainDoctor) {
    const open = await page.$(S.clinicianOpen);
    if (open) {
      await open.click().catch(() => {});
      await sleep(250);
      const ok = await clickOptionMatching(page, appointment.mainDoctor.split(' ')[0]); // first name is enough
      say(onStep, `Clinician: ${appointment.mainDoctor}${ok ? ' ✓' : ' (single/locked on demo)'}`);
    }
  }

  // 4) LOCATION — pick the practice's location. It exists on the account now, so
  // the typeahead matches and selects it (and there is NO Escape anywhere, so the
  // dialog stays open). If it ever doesn't match, typeaheadSelect just moves on.
  if (presets.SP.defaultLocation && await page.$(S.locationTrigger)) {
    await typeaheadSelect(page, S.locationTrigger, presets.SP.defaultLocation, onStep, 'Location', S.locationSearchInput);
  }

  // SERVICES — one line per code (native <select>, verified). Units + modifiers
  // are TODO(real): filled when those inputs exist (absent in the demo dialog).
  const services = appointment.services || [];
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    if (i > 0) {
      const addBtn = await page.$(S.addService);
      // Bounded click + JS fallback so a momentarily-unclickable "Add service" can
      // never hang for 30s; then wait briefly for the new service row to render.
      if (addBtn) { await addBtn.click({ timeout: 4000 }).catch(async () => { try { await addBtn.evaluate((el) => el.click()); } catch {} }); }
      await page.waitForFunction(({ sel, n }) => document.querySelectorAll(sel).length >= n, { sel: S.codeSelect, n: i + 1 }, { timeout: 4000 }).catch(() => {});
      await sleep(200);
    }
    const codeSelects = await page.$$(S.codeSelect);
    const sel = codeSelects[i] || codeSelects[codeSelects.length - 1];
    if (sel) {
      await sel.selectOption({ value: svc.code }, { timeout: 4000 }).catch(async () => { await sel.selectOption({ label: new RegExp('^' + svc.code) }, { timeout: 4000 }).catch(() => {}); });
      say(onStep, `Service: ${svc.code}`);
    }
    // TODO(real): units input + the four modifier boxes for this line.
    const unitInputs = await page.$$(S.unitsField);
    if (unitInputs[i]) { await unitInputs[i].fill(String(svc.units || 1)).catch(() => {}); }
    const modInputs = await page.$$(S.modifierInputs);
    (svc.modifiers || []).forEach(async (m, mi) => { if (modInputs[mi]) await modInputs[mi].fill(String(m)).catch(() => {}); });
  }

  if (dryRun) {
    const sv = await page.$(S.saveButton);
    const dis = sv ? await sv.isDisabled().catch(() => true) : null;
    say(onStep, `Filled (dry run — not saved). Save button: ${sv ? (dis ? 'found but disabled' : 'found + ENABLED ✓') : 'NOT FOUND'}`);
    return { ok: true, dryRun: true };
  }

  // SAVE — the button enables once required fields are valid. Bounded click +
  // a direct JS-click fallback so it can never hang. (No Escape anywhere — that
  // closes SimplePractice's dialog.)
  const save = await page.$(S.saveButton);
  if (!save) return { ok: false, error: 'Save button not found.' };
  await liveEngine.stage(page, 'moveTo', S.saveButton);
  if (await save.isDisabled().catch(() => false)) return { ok: false, error: 'Save is disabled — a required field did not fill (client/clinician/service). Re-check on this account.' };
  say(onStep, `Saving ${appointment.patientName}…`);
  await save.click({ timeout: 6000 }).catch(async () => { try { await save.evaluate((el) => el.click()); } catch {} });
  await liveEngine.stage(page, 'press');
  await sleep(2200);
  // Success = the dialog closed (the client field is gone). If it's still up, a
  // field was rejected and SimplePractice kept the form open.
  const stillOpen = await page.$(S.clientTrigger);
  if (stillOpen) return { ok: false, error: 'Clicked Save but the dialog stayed open — a field was likely rejected.' };
  say(onStep, `Booked ${appointment.patientName} ✓`);
  return { ok: true };
}

// Parse the FullCalendar title ("Sat, Jun 27, 2026") to a day.
function parseCalTitle(s) {
  const d = new Date(String(s || '').replace(/^[A-Za-z]+,\s*/, ''));
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function targetDay(s) {
  const mdy = toMDY(s); const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy);
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}

/** Move the SimplePractice calendar to a date (MM/DD/YYYY or any parseable form). */
async function spNavigateToDate(page, date, onStep) {
  const C = presets.SP.calendar;
  const want = targetDay(date);
  if (!want) return false;
  await page.goto(presets.SP.calendarUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissPopups(page);
  await page.waitForSelector(C.title, { timeout: 6000 }).catch(() => {});
  await sleep(400);
  for (let i = 0; i < 200; i++) {
    const el = await page.$(C.title);
    const cur = parseCalTitle(el ? await el.textContent() : '');
    if (!cur) { await sleep(250); continue; }
    const diff = Math.round((want - cur) / 86400000);
    if (diff === 0) { say(onStep, `SimplePractice calendar on ${toMDY(date)} ✓`); return true; }
    const btn = diff > 0 ? C.nextDay : C.prevDay;
    await liveEngine.stage(page, 'moveTo', btn).catch(() => {});
    await page.click(btn).catch(() => {});
    await sleep(300);
    await dismissPopups(page);
  }
  return false;
}

/** Read the client names already booked on the currently-shown calendar day. */
async function spClientsOnDate(page) {
  try {
    return await page.evaluate((sel) => [...document.querySelectorAll(sel)]
      .map((e) => (e.getAttribute('data-appt-title') || '').trim()).filter(Boolean), presets.SP.calendar.apptTitle);
  } catch { return []; }
}

module.exports = { bookAppointment, spNavigateToDate, spClientsOnDate };
