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

function nameTokens(value) {
  return String(value || '').trim().toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 2);
}

// A client record may be split by DISCIPLINE ("Jennifer OT Burgand", "Jennifer PT
// Burgand", "Jennifer SLP Burgand"). The right one for an appointment is the one
// whose tag matches the main doctor's unit: GP→PT, GO→OT, GN→SLP.
const DISC_FOR_CODE = { GP: 'pt', GO: 'ot', GN: 'slp' };
const DISC_TAG_RE = /\b(pt|ot|slp)\b/;
const SELF_PAY_RE = /\bself[\s-]?pay\b/;

// PURE decision (text only, unit-tested): given the option TEXTS, which index to
// click for `value`? Returns >=0 to click, -1 for none, -2 for "wait" (the right
// discipline variant may still be loading — don't grab the wrong one).
//   1. If a discipline is given and the patient has discipline-tagged records, pick
//      the one for THIS appointment's discipline (PT/OT/SLP).
//   2. Else prefer an UNtagged exact match, then any exact (all name tokens).
//   3. Else, if allowFirst, take the option whose LAST NAME matches (name variants
//      like Ronald→Ron) — never a name with no overlap at all. A dropdown result
//      that shares nothing with the searched name is a DIFFERENT patient, not a
//      variant, so it's rejected here and the caller reports "not found" instead
//      of silently booking whoever happened to be first in the list.
// Word-order independent ("Lochlann McNulty" ↔ "McNulty, Lochlann"), ignores a DOB.
function chooseOptionIndex(texts, value, { discipline = '', selfPay = false, allowFirst = false } = {}) {
  const tokens = nameTokens(value);
  const disc = String(discipline || '').toLowerCase(); // 'pt' | 'ot' | 'slp'
  const items = texts.map((t) => String(t || '').trim().toLowerCase());
  const hasAll = (t) => t && tokens.length && tokens.every((tok) => t.includes(tok));
  const nameIdx = items.map((t, i) => ({ t, i })).filter((x) => hasAll(x.t));
  if (selfPay) {
    // Private pay → the "… Self Pay …" record (not the OT/PT/SLP insurance ones).
    const sp = nameIdx.find((x) => SELF_PAY_RE.test(x.t));
    if (sp) return sp.i;
    if (!allowFirst && nameIdx.some((x) => DISC_TAG_RE.test(x.t) || SELF_PAY_RE.test(x.t))) return -2; // wait for the self-pay record
  } else if (disc) {
    const dm = nameIdx.find((x) => new RegExp(`\\b${disc}\\b`).test(x.t));
    if (dm) return dm.i;
    if (!allowFirst && nameIdx.some((x) => DISC_TAG_RE.test(x.t))) return -2; // wait for the right variant
  }
  const untagged = nameIdx.find((x) => !DISC_TAG_RE.test(x.t) && !SELF_PAY_RE.test(x.t));
  if (untagged) return untagged.i;
  if (nameIdx.length) return nameIdx[0].i;
  if (allowFirst) {
    // Require at least the LAST NAME to appear — that's the bar for "still the
    // same person, just a nickname/typo on the first name". No last-name overlap
    // at all means -1 (reject), never a blind guess at the first dropdown result.
    const last = tokens[tokens.length - 1];
    return last ? items.findIndex((t) => t.includes(last)) : -1;
  }
  return -1;
}

/* ------------------------------ clinician ------------------------------ */
// The clinician is the BILLING PROVIDER — a wrong one bills the visit under the
// wrong person (Dani's OT visit under Caryn). So it is matched on the whole name,
// looked for only inside the clinician box, and checked afterwards.

/** Tokens of a person's name for comparison: lowercase, hyphens and punctuation as
 *  spaces, "(You)" and credentials dropped. "Heather Vines-Dubose" = "heather vines dubose". */
function personTokens(s) {
  return String(s || '').toLowerCase().replace(/\(you\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t.length >= 2 && !/^(otr|ot|pt|dpt|slp|ccc|cota|ms|ma|ed|l|r)$/.test(t));
}

/** Does this text name the doctor (first name + last name both present)? */
function namesPerson(text, doctor) {
  const want = personTokens(doctor);
  const have = personTokens(text);
  if (!want.length || !have.length) return false;
  return have.includes(want[0]) && have.includes(want[want.length - 1]);
}

/**
 * PURE: which option is this doctor? Every name token present wins; failing that,
 * first + last name. Two candidates (two Heathers with no surname) → -1, never a guess.
 */
function pickClinicianIndex(texts, doctor) {
  const want = personTokens(doctor);
  if (!want.length) return -1;
  const items = texts.map(personTokens);
  const full = items.map((t, i) => (want.every((w) => t.includes(w)) ? i : -1)).filter((i) => i >= 0);
  if (full.length === 1) return full[0];
  if (full.length > 1) {
    const exact = full.filter((i) => items[i].length === want.length);
    return exact.length === 1 ? exact[0] : -1;
  }
  const loose = texts.map((t, i) => (namesPerson(t, doctor) ? i : -1)).filter((i) => i >= 0);
  return loose.length === 1 ? loose[0] : -1;
}

/** The name SimplePractice shows as this appointment's clinician right now ('' if unreadable). */
async function shownClinician(page, S) {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return '';
    const label = box.querySelector('.typeahead-label, .select-box__selected-option, .non-editable-dropdown');
    return ((label || box).textContent || '').replace(/\bClinician\b/i, '').replace(/\s+/g, ' ').trim();
  }, S.clinician).catch(() => '');
}

/**
 * Set the clinician to the billing provider and prove it took.
 * → { status: 'ok' | 'locked' | 'failed', shown }
 *   ok      the box now shows this doctor
 *   locked  the box never opened a list (a single, fixed clinician) — booked, but flagged
 *   failed  a list opened, yet the box still shows someone else — never saved
 */
async function selectClinician(page, S, doctor, onStep) {
  const before = await shownClinician(page, S);
  if (namesPerson(before, doctor)) { say(onStep, `Clinician: ${doctor} ✓`); return { status: 'ok', shown: before }; }
  const triggers = [S.clinicianOpen, `${S.clinician} .typeahead-trigger`, `${S.clinician} [role="combobox"]`, `${S.clinician} .non-editable-dropdown`, S.clinician].filter(Boolean);
  let sawList = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let opened = false;
    for (const t of triggers) {
      const el = await page.$(t).catch(() => null);
      if (!el) continue;
      await liveEngine.stage(page, 'moveTo', t).catch(() => {});
      await el.click({ timeout: 3000 }).catch(async () => { try { await el.evaluate((e) => e.click()); } catch {} });
      opened = true;
      break;
    }
    if (!opened) break;
    // A search box inside the clinician list narrows it; type the name if there is one.
    const search = await page.$(`${S.clinician} .select-box__input, .flyout-clinician-dropdown .select-box__input`).catch(() => null);
    if (search && await search.isVisible().catch(() => false)) { await search.fill('').catch(() => {}); await search.type(doctor.split(' ')[0], { delay: 15 }).catch(() => {}); }
    // Wait for the options — only VISIBLE ones, and never the client's or the
    // location's leftover lists (the old code read those and found no doctor).
    const deadline = Date.now() + 5000;
    let clicked = false;
    while (Date.now() < deadline && !clicked) {
      const handles = [];
      for (const os of OPTION_SELECTORS) {
        for (const h of await page.$$(os).catch(() => [])) {
          const ok = await h.evaluate((el) => !el.closest('[data-validation-path="client"], [data-validation-path="officeId"]') && !el.classList.contains('no-results')
            && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).catch(() => false);
          if (ok && !handles.includes(h)) handles.push(h);
        }
        if (handles.length) break;
      }
      if (handles.length) {
        const texts = [];
        for (const h of handles) texts.push(((await h.textContent().catch(() => '')) || '').trim());
        const idx = pickClinicianIndex(texts, doctor);
        // It's the clinician list only if it holds the doctor we want or the one
        // shown now — a stray visible list (a time picker) never counts.
        if (idx >= 0 || (before && texts.some((t) => namesPerson(t, before)))) sawList = true;
        if (idx >= 0) {
          await handles[idx].click({ timeout: 2000 }).catch(async () => { try { await handles[idx].evaluate((el) => el.click()); } catch {} });
          clicked = true;
          break;
        }
      }
      await sleep(200);
    }
    await sleep(350);
    const now = await shownClinician(page, S);
    if (namesPerson(now, doctor)) { say(onStep, `Clinician: ${doctor} ✓`); return { status: 'ok', shown: now }; }
  }
  const shown = await shownClinician(page, S);
  if (!sawList) {
    say(onStep, `⚠︎ Clinician: the box didn't open a list — it shows "${shown || 'nothing'}", wanted ${doctor}`);
    return { status: 'locked', shown };
  }
  say(onStep, `⚠︎ Clinician: could not set ${doctor} (SimplePractice shows "${shown || 'nothing'}")`);
  return { status: 'failed', shown };
}

// Click the chosen option. Robust click (normal + JS-click fallback) so it is never
// a silent no-op. Returns false when nothing should be clicked (none / keep waiting).
async function clickOptionMatching(page, value, opts = {}) {
  let els = [];
  for (const os of OPTION_SELECTORS) { els = await page.$$(os).catch(() => []); if (els.length) break; }
  if (!els.length) return false;
  const texts = [];
  for (const o of els) texts.push(((await o.textContent().catch(() => '')) || '').trim());
  const idx = chooseOptionIndex(texts, value, opts);
  if (idx < 0) return false;
  const o = els[idx];
  await o.click({ timeout: 1200 }).catch(async () => { try { await o.evaluate((el) => el.click()); } catch {} });
  return true;
}

// From several candidate selectors for a REPEATED per-line box, return the handles
// from whichever matches the MOST elements. A first-run capture can save a selector
// specific to ONE box (the one the user pointed at); the general built-in then
// matches every line so later service lines are not left unfilled.
async function collectAll(page, candidates) {
  let best = [];
  const seen = new Set();
  for (const sel of candidates) {
    if (!sel || seen.has(sel)) continue; seen.add(sel);
    const h = await page.$$(sel).catch(() => []);
    if (h.length > best.length) best = h;
  }
  return best;
}

// Fill a React-controlled box and CONFIRM the value stuck. SimplePractice inputs
// sometimes ignore a fast programmatic fill(), so if the value didn't register we
// re-enter it with real keystrokes. Prevents the "sometimes forgets the units or
// the letters" misses.
async function fillReliable(handle, value) {
  const want = String(value);
  try {
    await handle.fill(want, { timeout: 3000 }).catch(() => {});
    if ((await handle.inputValue().catch(() => '')) === want) return true;
    await handle.click({ timeout: 1500 }).catch(() => {});
    await handle.fill('', { timeout: 1500 }).catch(() => {});
    await handle.type(want, { delay: 20 }).catch(() => {});
    return (await handle.inputValue().catch(() => '')) === want;
  } catch { return false; }
}

/**
 * Open a typeahead trigger, type the value into its search box, and select the
 * matching option — robustly. `searchSel` is the input the trigger reveals.
 * `verifySel` (optional) is an element that only appears AFTER a real selection
 * (for the client, the Services <select>): if given, we CONFIRM the selection
 * took and RETRY the whole open→type→pick up to 3× — because a missed client is
 * unacceptable. Never presses Escape (that closes SimplePractice's dialog).
 */
async function typeaheadSelect(page, triggerSel, value, onStep, label, searchSel, verifySel, disciplineTag, selfPay) {
  const want = String(value || '').trim();
  const disc = String(disciplineTag || '').toLowerCase(); // 'pt'|'ot'|'slp' — pick the right discipline variant
  // When verifying (the client), each retry searches a DIFFERENT way so a name that
  // isn't stored exactly still resolves: full name → last name → first name. On each
  // we prefer an exact match, then fall back to the first result that pops up.
  const parts = want.split(/\s+/).filter(Boolean);
  const searchTerms = verifySel
    ? [want, parts[parts.length - 1] || want, parts[0] || want]
    : [want];
  const maxAttempts = searchTerms.length;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const term = searchTerms[attempt - 1];
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
      if (input) { await input.fill('').catch(() => {}); await input.type(term, { delay: 15 }); }
      else { await sleep(250); await page.keyboard.type(term, { delay: 15 }); }
      // Poll: for the first ~2.2s prefer an EXACT (all-token) match; after that accept
      // a result that at least shares the LAST NAME (so a variant like Ronald→Ron
      // still books) — never an option with no name overlap at all, which is a
      // different patient, not a variant.
      let picked = false;
      const canFallback = !!verifySel; // last-name fallback only for the client
      const softDeadline = Date.now() + 2200;
      const hardDeadline = Date.now() + 4500;
      while (!picked && Date.now() < hardDeadline) {
        picked = await clickOptionMatching(page, want, { discipline: disc, selfPay: !!selfPay, allowFirst: canFallback && Date.now() > softDeadline });
        if (!picked) await sleep(150);
      }
      await liveEngine.stage(page, 'press');

      if (verifySel) {
        // Proof the selection took: the dependent section (Services) rendered.
        const ok = await page.waitForSelector(verifySel, { timeout: 3500 }).then(() => true).catch(() => false);
        const tag = selfPay ? ' [Self Pay]' : (disc ? ` [${disc.toUpperCase()}]` : '');
        if (ok) { say(onStep, `${label}: ${want}${tag}${term !== want ? ` (matched by "${term}")` : ''} ✓`); return true; }
        if (attempt < maxAttempts) { say(onStep, `${label}: "${want}" not found — retrying by "${searchTerms[attempt]}"…`); await sleep(400); continue; }
        say(onStep, `${label}: could NOT find "${want}" in SimplePractice — leaving it (won't book a wrong client)`);
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
  // The discipline (from the main doctor's GP/GO/GN) picks the right record when a
  // patient is split into OT/PT/SLP variants (e.g. "Jennifer PT Burgand").
  if (appointment.patientName) {
    // Self-pay → the "… Self Pay …" record; otherwise the discipline (GP/GO/GN → PT/OT/SLP) variant.
    const discTag = appointment.selfPay ? '' : (DISC_FOR_CODE[String(appointment.mainCode || '').toUpperCase()] || '');
    let gotClient = await typeaheadSelect(page, S.clientTrigger, appointment.patientName, onStep, 'Client', S.clientSearchInput, S.codeSelect, discTag, appointment.selfPay);
    if (!gotClient) {
      // One more go on a FRESH new-appointment form — a search that came back empty
      // once (slow results, a stuck dropdown) usually works the second time.
      say(onStep, `Client: trying "${appointment.patientName}" again on a fresh form…`);
      await page.goto(presets.SP.newApptUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await dismissPopups(page);
      await liveEngine.ensureStage(page);
      gotClient = await typeaheadSelect(page, S.clientTrigger, appointment.patientName, onStep, 'Client', S.clientSearchInput, S.codeSelect, discTag, appointment.selfPay);
    }
    if (!gotClient) return { ok: false, reason: 'client_not_found', error: `Could not select client "${appointment.patientName}" in SimplePractice (not found or didn't select).` };
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

  // 3) CLINICIAN = the billing provider (the therapist's main doctor). Set on the
  // whole name and CHECKED: if SimplePractice still shows someone else after a
  // list opened, the visit is NOT saved (a wrong clinician bills the wrong person).
  // A box that never opens a list (one fixed clinician, as on the demo) is booked
  // but flagged for a look.
  const warnings = [];
  if (appointment.mainDoctor && await page.$(S.clinician)) {
    const c = await selectClinician(page, S, appointment.mainDoctor, onStep);
    if (c.status === 'failed') {
      return { ok: false, reason: 'clinician', error: `Couldn't set the clinician to ${appointment.mainDoctor} (SimplePractice showed "${c.shown || 'nothing'}") — not saved, so it isn't billed under the wrong provider.` };
    }
    if (c.status === 'locked') warnings.push(`Clinician couldn't be changed — SimplePractice shows "${c.shown || 'nothing'}", should be ${appointment.mainDoctor}.`);
  }

  // PRIVATE OR INSURANCE — decided by the service SimplePractice pre-fills for
  // this client. A preset with NO code ("Home Visit", "Physical Therapy") means
  // private pay: its codes are already automated, so add none and just save. A
  // preset that starts with a code ("97112 Neuromuscular re-education") means
  // insurance. A client marked Private on the client list is never given codes.
  let selfPay = !!appointment.selfPay;
  let services = appointment.services || [];
  const preset = await readPresetService(page, S.codeSelect);
  if (preset.found && !preset.hasCode) {
    if (!selfPay) {
      say(onStep, `Preset service is "${preset.label}" (no code) — private pay, not adding codes.`);
      if (appointment.payer === 'insurance') warnings.push(`Client list says Insurance, but SimplePractice's preset service is "${preset.label}" (no code), so it was booked as private with no codes.`);
    }
    selfPay = true;
  } else if (preset.found && preset.hasCode && selfPay) {
    if (appointment.payer === 'private') {
      warnings.push(`Client list says Private, but SimplePractice's preset service is "${preset.label}". Booked as private (no codes added) — check which is right.`);
    } else if ((appointment.insuranceServices || []).length) {
      selfPay = false;
      services = appointment.insuranceServices;
      say(onStep, `Preset service is "${preset.label}" — insurance, adding the codes.`);
    }
  } else if (!preset.found) {
    say(onStep, `No preset service showed for ${appointment.patientName} — using the client list (${selfPay ? 'private' : 'insurance'}).`);
  }

  // 4) LOCATION — pick the practice's location. It exists on the account now, so
  // the typeahead matches and selects it (and there is NO Escape anywhere, so the
  // dialog stays open). If it ever doesn't match, typeaheadSelect just moves on.
  // Private-pay clients have their place of service preset, so it's left alone.
  if (!selfPay && presets.SP.defaultLocation && await page.$(S.locationTrigger)) {
    await typeaheadSelect(page, S.locationTrigger, presets.SP.defaultLocation, onStep, 'Location', S.locationSearchInput);
  }

  // SELF-PAY: the service ("Home Visit" etc.) and fee are PRESET on the client's
  // record in SimplePractice, so we add NO CPT codes — just save. Insurance
  // appointments fill the coded service lines below.
  if (selfPay) {
    say(onStep, 'Self-pay — service & fee are preset on this client; not adding codes.');
  } else {
  // SERVICES — one line per code (native <select>, verified). Add EVERY line and
  // select its code first, then fill units + modifiers scoped to each line's own
  // boxes. (Filling per-line inline mis-indexed the shared modifier inputs, so a
  // later line's modifiers overwrote the first line's boxes and the later line was
  // left blank — the "sometimes forgets / wrong box" bug.)
  for (let i = 0; i < services.length; i++) {
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
      await sel.selectOption({ value: services[i].code }, { timeout: 4000 }).catch(async () => { await sel.selectOption({ label: new RegExp('^' + services[i].code) }, { timeout: 4000 }).catch(() => {}); });
      say(onStep, `Service: ${services[i].code}`);
    }
  }
  // Units + modifiers, now that every line exists. The modifier boxes are shared
  // across lines (name^="modifier", four per line), so map each line to ITS OWN
  // block of boxes. Each value is written once and confirmed (fillReliable), so a
  // box is never skipped and a modifier is never duplicated into another line.
  const P = presets.SP.selectors;
  const allUnits = await collectAll(page, [S.unitsField, P.unitsField, 'input[name="numberOfUnits"]', 'input[aria-label="Number of Units"]']);
  const allMods = await collectAll(page, [S.modifierInputs, P.modifierInputs, 'input[placeholder="AA"]']);
  const perLine = services.length && allMods.length % services.length === 0 ? Math.max(1, allMods.length / services.length) : 4;
  say(onStep, `Service boxes: ${allUnits.length} units + ${allMods.length} modifier, for ${services.length} line${services.length === 1 ? '' : 's'}`);
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const u = String(svc.units || 1);
    if (allUnits[i]) { if (!(await fillReliable(allUnits[i], u))) say(onStep, `⚠︎ units for ${svc.code} may not have stuck`); }
    else if (u !== '1') say(onStep, `⚠︎ no units box found for line ${i + 1} (${svc.code} needs ${u}) — capture the Units box`);
    const mods = svc.modifiers || [];
    for (let mi = 0; mi < mods.length && mi < perLine; mi++) {
      const box = allMods[i * perLine + mi];
      if (box) await fillReliable(box, String(mods[mi]));
    }
    say(onStep, `Line ${i + 1}: ${svc.code} · units ${u}${mods.length ? ' · mods ' + mods.join(' ') : ''}`);
  }
  } // end insurance service lines

  if (dryRun) {
    const sv = await page.$(S.saveButton);
    const dis = sv ? await sv.isDisabled().catch(() => true) : null;
    say(onStep, `Filled (dry run — not saved). Save button: ${sv ? (dis ? 'found but disabled' : 'found + ENABLED ✓') : 'NOT FOUND'}`);
    return { ok: true, dryRun: true, warnings };
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
  // Wait for the outcome: the dialog CLOSES (saved ✓), OR a confirmation modal
  // appears ("Scheduling outside availability") — proceed anyway by clicking its
  // "Save appointment" button — OR it stays open (a field was rejected). Polling
  // (not a fixed sleep) so success returns fast and the modal is never missed.
  // SimplePractice can raise SEVERAL warnings in a row (outside availability, then
  // "client already has an appointment at this time" for a patient's 2nd session),
  // so each one is answered in turn — the earlier code answered only the first,
  // which left the second open and the visit unsaved.
  let deadline = Date.now() + 9000;
  let confirms = 0;
  let lastWarning = '';
  while (Date.now() < deadline) {
    if (!(await page.$(S.clientTrigger).catch(() => null))) { say(onStep, `Booked ${appointment.patientName} ✓`); return { ok: true, warnings }; }
    if (confirms < 4) {
      const w = await findProceedButton(page, S.confirmSave);
      if (w && w.text !== lastWarning) {
        confirms += 1;
        lastWarning = w.text;
        say(onStep, `Scheduling warning${w.text ? `: “${w.text}”` : ''} — clicking “${w.label}” to proceed…`);
        await liveEngine.stage(page, 'press');
        await w.handle.click({ timeout: 2500 }).catch(async () => { try { await w.handle.evaluate((el) => el.click()); } catch {} });
        deadline = Date.now() + 9000;
        await sleep(500);
        continue;
      } else if (w && confirms < 4) {
        // Same warning still showing — the click didn't land; try it once more.
        confirms += 1;
        await w.handle.evaluate((el) => el.click()).catch(() => {});
      }
    }
    await sleep(250);
  }
  const why = await visibleFormErrors(page);
  return { ok: false, error: `Clicked Save but SimplePractice didn't save it${why ? ` — it said: “${why}”` : lastWarning ? ` — last warning: “${lastWarning}”` : ' (no message shown)'}.` };
}

// The "proceed anyway" button on a SimplePractice confirmation modal. Matches by
// text, never a Cancel / Delete / Discard / Back button.
const PROCEED_RE = /^(save appointment|save anyway|schedule anyway|book anyway|continue|proceed|yes,? (save|schedule|continue))\b/i;
async function findProceedButton(page, confirmSel) {
  let handle = await page.$(confirmSel).catch(() => null);
  if (!handle) {
    for (const b of await page.$$('[role="dialog"] button, .modal button, .ember-modal-dialog button').catch(() => [])) {
      const t = ((await b.textContent().catch(() => '')) || '').trim();
      if (PROCEED_RE.test(t) && await b.isVisible().catch(() => false)) { handle = b; break; }
    }
  }
  if (!handle) return null;
  const label = ((await handle.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ') || 'Save appointment';
  const text = await handle.evaluate((el) => {
    const box = el.closest('[role="dialog"], .modal, .ember-modal-dialog, [class*="modal"]');
    const t = box ? (box.innerText || box.textContent || '') : '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 220);
  }).catch(() => '');
  return { handle, label, text: text.replace(label, '').replace(/\bCancel\b/g, '').trim() };
}

/** Error text SimplePractice shows on the form when it refuses to save. */
async function visibleFormErrors(page) {
  return page.evaluate(() => {
    const sel = '[role="alert"], .error, .errors, .field-error, .invalid-feedback, .form-error, .alert-danger, .flash-error, .validation-error, [class*="error-message"]';
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 200) seen.add(t);
    }
    return [...seen].slice(0, 3).join(' · ');
  }).catch(() => '');
}

// Parse the FullCalendar title ("Sat, Jun 27, 2026") to a day.
/** Local-midnight Date → "YYYY-MM-DD" (the form FullCalendar puts in data-date). */
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/**
 * The calendar toolbar title → the range of days it shows, { start, end }.
 * Handles "Sat, Jun 27, 2026", "Monday, October 26, 2026", "Oct 26" (no year →
 * the target's year), and week ranges "Oct 26 – Nov 1, 2026" / "Oct 26 – 31, 2026".
 */
function parseCalTitle(s, yearHint) {
  const t = String(s || '').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*/gi, '').replace(/\s+/g, ' ').trim();
  const part = /([a-z]{3,})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/gi;
  const hits = [];
  let m;
  while ((m = part.exec(t))) {
    const mi = (MONTHS[m[1].slice(0, 3).toLowerCase()] || 0) - 1;
    if (mi >= 0) hits.push({ mi, d: +m[2], y: m[3] ? +m[3] : null, end: part.lastIndex });
  }
  if (!hits.length) return null;
  const year = (hits.find((h) => h.y) || {}).y || yearHint || new Date().getFullYear();
  const first = hits[0];
  const start = new Date(first.y || year, first.mi, first.d);
  // "Oct 26 – 31, 2026": a bare day number after the dash shares the month.
  const tail = /[–—-]\s*(\d{1,2})(?:,?\s*(\d{4}))?\s*$/.exec(t.slice(first.end));
  let end = start;
  if (hits[1]) end = new Date(hits[1].y || year, hits[1].mi, hits[1].d);
  else if (tail) end = new Date(tail[2] ? +tail[2] : year, first.mi, +tail[1]);
  if (end < start) end = new Date(end.getFullYear() + 1, end.getMonth(), end.getDate()); // "Dec 28 – Jan 3"
  return { start, end };
}
function targetDay(s) {
  const mdy = toMDY(s); const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy);
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
}

/** The days the main calendar grid is showing, from FullCalendar's data-date tags. */
async function visibleCalendarDays(page) {
  return page.evaluate((grid) => {
    const root = document.querySelector(grid);
    if (!root) return [];
    const days = [...root.querySelectorAll('[data-date]')].map((e) => (e.getAttribute('data-date') || '').slice(0, 10));
    return [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  }, presets.SP.calendar.grid).catch(() => []);
}

/**
 * Move the SimplePractice calendar so it shows `date`. Works in Day, Week or
 * Month view: it reads the dates the grid itself shows (FullCalendar tags each
 * day with data-date), falling back to the toolbar title. Returns true only once
 * the day is on screen; if it can't get there, says what SimplePractice showed.
 */
async function spNavigateToDate(page, date, onStep) {
  const C = presets.SP.calendar;
  const want = targetDay(date);
  if (!want) return false;
  const wantIso = isoDay(want);
  await page.goto(presets.SP.calendarUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissPopups(page);
  await page.waitForSelector(C.title, { timeout: 8000 }).catch(() => {});
  await sleep(600);
  let lastTitle = '';
  let unreadable = 0;
  for (let i = 0; i < 120; i++) {
    const el = await page.$(C.title);
    lastTitle = el ? ((await el.textContent().catch(() => '')) || '').trim() : '';
    const days = await visibleCalendarDays(page);
    let dir = 0;
    if (days.length) {
      if (days.includes(wantIso)) { say(onStep, `SimplePractice calendar on ${toMDY(date)} ✓`); return true; }
      dir = wantIso < days[0] ? -1 : 1;
    } else {
      const r = parseCalTitle(lastTitle, want.getFullYear());
      if (!r) {
        if (++unreadable > 40) break; // ~15 s of a title we can't read
        await sleep(350); continue;
      }
      if (want >= r.start && want <= r.end) {
        if (+r.start === +r.end) { say(onStep, `SimplePractice calendar on ${toMDY(date)} ✓`); return true; }
        break; // a multi-day view with no day tags — can't isolate the day safely
      }
      dir = want < r.start ? -1 : 1;
    }
    const btn = dir > 0 ? C.nextDay : C.prevDay;
    await liveEngine.stage(page, 'moveTo', btn).catch(() => {});
    await page.click(btn, { timeout: 4000 }).catch(() => {});
    await sleep(450);
    await dismissPopups(page);
  }
  say(onStep, `⚠︎ Couldn't get the SimplePractice calendar to ${toMDY(date)} — it showed "${lastTitle || 'no date heading'}".`);
  return false;
}

/** A service label that starts with a billing code: "97112 …", "L3807 …". */
const SERVICE_CODE_RE = /^\s*(\d{5}|[A-Z]\d{4})\b/;
/**
 * The service SimplePractice pre-fills on the first line once a client is picked.
 * Waits briefly for it (it fills in after the client loads). { found, label, hasCode }.
 */
async function readPresetService(page, codeSelect) {
  for (let i = 0; i < 12; i++) {
    const label = await page.$eval(codeSelect, (el) => {
      const o = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return o && o.value ? (o.textContent || '').trim() : '';
    }).catch(() => '');
    if (label) return { found: true, label, hasCode: SERVICE_CODE_RE.test(label) };
    await sleep(400);
  }
  return { found: false, label: '', hasCode: false };
}

/**
 * Read the day's existing appointments RELIABLY, for the duplicate check. Waits
 * for the calendar grid, then re-reads until the appointment count holds steady
 * across three reads (appointments load in after the grid). Returns ok:false if
 * the grid never appears or the page can't be read, so the caller books nothing
 * rather than treating "couldn't read" as "the day is empty" (a double booking).
 */
/** In the page: the appointment titles on one day. Events inside a day column
 *  (data-date) count only for their own day; an event outside any column counts
 *  only when the grid shows that single day. null = can't attribute safely. */
function collectDayTitles({ grid, appt, iso }) {
  const root = document.querySelector(grid) || document;
  const days = new Set([...root.querySelectorAll('[data-date]')].map((e) => (e.getAttribute('data-date') || '').slice(0, 10)).filter(Boolean));
  const out = [];
  for (const e of document.querySelectorAll(appt)) {
    const title = (e.getAttribute('data-appt-title') || '').trim();
    if (!title) continue;
    const col = e.closest('[data-date]');
    if (col) { if ((col.getAttribute('data-date') || '').slice(0, 10) === iso) out.push(title); continue; }
    if (days.size > 1) return null;
    out.push(title);
  }
  return out;
}

async function spReadDay(page, date) {
  const C = presets.SP.calendar;
  const want = date ? targetDay(date) : null;
  const iso = want ? isoDay(want) : '';
  const grid = await page.waitForSelector(C.grid, { timeout: 15000 }).catch(() => null);
  if (!grid) return { ok: false, titles: [] };
  // With no day tags on the grid, only a heading that names exactly this one day
  // proves which day the appointments belong to.
  if (want && !(await visibleCalendarDays(page)).length) {
    const el = await page.$(C.title);
    const r = parseCalTitle(el ? await el.textContent().catch(() => '') : '', want.getFullYear());
    if (!r || +r.start !== +r.end || +r.start !== +want) return { ok: false, titles: [] };
  }
  let last = null, steady = 0;
  for (let i = 0; i < 24 && steady < 2; i++) {
    await sleep(600);
    let titles;
    try {
      titles = await page.evaluate(collectDayTitles, { grid: C.grid, appt: C.apptTitle, iso });
    } catch { return { ok: false, titles: [] }; }
    if (!titles) return { ok: false, titles: [] };
    const sig = titles.slice().sort().join('\n');
    steady = sig === last ? steady + 1 : 0;
    last = sig;
    if (steady >= 2) return { ok: true, titles };
  }
  return { ok: false, titles: [] };
}

/** Read the client names already booked on the currently-shown calendar day. */
async function spClientsOnDate(page) {
  try {
    return await page.evaluate((sel) => [...document.querySelectorAll(sel)]
      .map((e) => (e.getAttribute('data-appt-title') || '').trim()).filter(Boolean), presets.SP.calendar.apptTitle);
  } catch { return []; }
}

module.exports = { PROCEED_RE, bookAppointment, spNavigateToDate, spReadDay, readPresetService, SERVICE_CODE_RE, parseCalTitle, collectDayTitles, isoDay, spClientsOnDate, chooseOptionIndex, pickClinicianIndex, namesPerson, selectClinician };
