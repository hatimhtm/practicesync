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

// Best-effort option pickers for the opened dropdowns. TODO(verify) once we
// capture an opened typeahead/clinician list on the real account.
const OPTION_SELECTORS = ['.select-box__option', '[role="option"]', 'li[role="option"]', '.typeahead-option', '.select-box__options li'];

async function clickOptionMatching(page, value) {
  const want = String(value || '').trim().toLowerCase();
  if (!want) return false;
  for (const os of OPTION_SELECTORS) {
    const opts = await page.$$(os).catch(() => []);
    for (const o of opts) {
      const t = ((await o.textContent().catch(() => '')) || '').trim().toLowerCase();
      if (t && (t.includes(want) || want.includes(t.split('(')[0].trim()))) { await o.click().catch(() => {}); return true; }
    }
  }
  return false;
}

// Click a typeahead trigger, type, and pick the matching option (with cursor).
async function typeaheadSelect(page, triggerSel, value, onStep, label) {
  try {
    await liveEngine.ensureStage(page);
    await liveEngine.stage(page, 'moveTo', triggerSel);
    await page.click(triggerSel, { timeout: 8000 }).catch(() => {});
    await sleep(350);
    await page.keyboard.type(String(value), { delay: 40 }); // types into the input the trigger reveals
    await sleep(700);
    const picked = await clickOptionMatching(page, value);
    if (!picked) await page.keyboard.press('Enter').catch(() => {}); // fall back to top match
    await liveEngine.stage(page, 'press');
    say(onStep, `${label}: ${value}`);
    return picked;
  } catch { return false; }
}

/**
 * @param appointment { patientName, date, mainDoctor, services:[{code,units,modifiers[]}] }
 * @param opts { onStep, dryRun=true } — dryRun fills but does not click Save.
 */
async function bookAppointment(page, appointment, { onStep, dryRun = true } = {}) {
  const S = presets.SP.selectors;
  // Open a fresh new-appointment dialog.
  await page.goto(presets.SP.newApptUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissPopups(page);
  await liveEngine.ensureStage(page);
  await liveEngine.stage(page, 'status', `Booking ${appointment.patientName}…`);

  // DATE (verified) — MM/DD/YYYY as SimplePractice shows it.
  if (appointment.date && await page.$(S.dateField)) {
    await liveEngine.stage(page, 'moveTo', S.dateField);
    await page.fill(S.dateField, '').catch(() => {});
    await page.type(S.dateField, appointment.date, { delay: 40 }).catch(() => {});
    await liveEngine.stage(page, 'press');
  }

  // CLIENT (typeahead; trigger verified, options best-effort).
  if (appointment.patientName) await typeaheadSelect(page, S.clientTrigger, appointment.patientName, onStep, 'Client');

  // CLINICIAN = the main doctor. On the demo it's a single non-editable name, so
  // this is a no-op there; on the real account it opens a list to pick from.
  if (appointment.mainDoctor) {
    const open = await page.$(S.clinicianOpen);
    if (open) {
      await open.click().catch(() => {});
      await sleep(400);
      await clickOptionMatching(page, appointment.mainDoctor.split(' ')[0]); // first name is enough
      say(onStep, `Clinician: ${appointment.mainDoctor}`);
    }
  }

  // LOCATION (best-effort) — the practice default.
  if (presets.SP.defaultLocation && await page.$(S.locationTrigger)) {
    await typeaheadSelect(page, S.locationTrigger, presets.SP.defaultLocation, onStep, 'Location');
  }

  // SERVICES — one line per code (native <select>, verified). Units + modifiers
  // are TODO(real): filled when those inputs exist (absent in the demo dialog).
  const services = appointment.services || [];
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    if (i > 0 && await page.$(S.addService)) { await page.click(S.addService).catch(() => {}); await sleep(500); }
    const codeSelects = await page.$$(S.codeSelect);
    const sel = codeSelects[i] || codeSelects[codeSelects.length - 1];
    if (sel) {
      await sel.selectOption({ value: svc.code }).catch(async () => { await sel.selectOption({ label: new RegExp('^' + svc.code) }).catch(() => {}); });
      say(onStep, `Service: ${svc.code}`);
    }
    // TODO(real): units input + the four modifier boxes for this line.
    const unitInputs = await page.$$(S.unitsField);
    if (unitInputs[i]) { await unitInputs[i].fill(String(svc.units || 1)).catch(() => {}); }
    const modInputs = await page.$$(S.modifierInputs);
    (svc.modifiers || []).forEach(async (m, mi) => { if (modInputs[mi]) await modInputs[mi].fill(String(m)).catch(() => {}); });
  }

  if (dryRun) { say(onStep, 'Filled (dry run — not saved).'); return { ok: true, dryRun: true }; }

  // SAVE (verified) — the button enables once required fields are valid.
  const save = await page.$(S.saveButton);
  if (!save) return { ok: false, error: 'Save button not found.' };
  await liveEngine.stage(page, 'moveTo', S.saveButton);
  if (await save.isDisabled().catch(() => false)) return { ok: false, error: 'Save is disabled — a required field did not fill (likely client/clinician). Needs verification on the full account.' };
  await save.click().catch(() => {});
  await liveEngine.stage(page, 'press');
  await sleep(1200);
  return { ok: true };
}

module.exports = { bookAppointment };
