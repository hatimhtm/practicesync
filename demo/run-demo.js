'use strict';

/*
 * THE DEMO — record this.
 *
 * One Chrome window, the visible PracticeSync cursor, end to end:
 *   ChartFlow EHR  →  search a patient, read their visits
 *   (map each diagnosing clinician → main doctor + billing codes — the REAL roster brain)
 *   BookWell       →  create a coded appointment per visit, every service line, and save
 *
 * No logins, no internet, can't fail on stage. On the client's Mac the same app
 * points at the real Practice Fusion → SimplePractice instead of these mocks.
 *
 *   npm run demo               # watch it (a Chrome window opens, cursor moves)
 *   HEADLESS=1 npm run demo    # no window; runs + asserts (used as a test)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { JSDOM } = require('jsdom');

const { startServer, SOURCE_SELECTORS, DEST_SELECTORS, DEMO_PATIENT } = require('./mock');
const { openPage, ensureStage, stage, announce } = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const { extractVisits } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const { DEMO_PROVIDERS, DEMO_MAIN_DOCTORS } = require(path.join(__dirname, '..', 'src', 'main', 'model'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = !!process.env.HEADLESS;
const SHOTS = process.env.SHOTS; // optional dir: capture preview frames of the demo
let shotN = 0;
const snap = async (page, name) => { if (SHOTS) { try { await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) }); } catch {} } };
const log = (m) => console.log('   · ' + m);
const fails = [];
const check = (name, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`); if (!ok) fails.push(name); };

// Type a value into a field with the visible cursor (move → click → type → ripple).
async function typeInto(page, onStep, selector, value, label) {
  if (value == null || value === '') return;
  await announce(page, onStep, label);
  await stage(page, 'moveTo', selector);
  await page.click(selector).catch(() => {});
  await page.fill(selector, '').catch(() => {});
  await page.type(selector, String(value), { delay: HEADLESS ? 0 : 45 });
  await stage(page, 'press');
}

(async () => {
  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-demo-'));
  let context;
  const launch = (opts) => chromium.launchPersistentContext(profile, opts);
  const base = { headless: HEADLESS, viewport: null, args: ['--no-first-run', '--no-default-browser-check', '--disable-component-update', '--start-maximized'] };
  try { context = await launch({ channel: 'chrome', ...base }); }
  catch { context = await launch({ executablePath: CHROME, ...base }); }

  try {
    /* 1) SOURCE — find the patient and read their visits */
    const page = await openPage(context, srv.sourceUrl);
    await ensureStage(page);
    await announce(page, log, `Opening ChartFlow EHR — looking up ${DEMO_PATIENT}…`);
    await stage(page, 'moveTo', SOURCE_SELECTORS.searchBox);
    await page.click(SOURCE_SELECTORS.searchBox);
    await stage(page, 'press');
    await page.type(SOURCE_SELECTORS.searchBox, DEMO_PATIENT, { delay: HEADLESS ? 0 : 70 });
    await page.waitForSelector(SOURCE_SELECTORS.firstResult, { timeout: 8000 });
    await announce(page, log, `Opening ${DEMO_PATIENT}'s chart…`);
    await stage(page, 'moveTo', SOURCE_SELECTORS.firstResult);
    await page.click(SOURCE_SELECTORS.firstResult);
    await stage(page, 'press');
    await page.waitForSelector(SOURCE_SELECTORS.rowSelector, { timeout: 8000 });

    await snap(page, 'source-visits');
    const doc = new JSDOM(await page.content()).window.document;
    const visits = extractVisits(doc, SOURCE_SELECTORS, 10);
    await stage(page, 'done', `Read ${visits.length} visit(s)`);
    log(`visits: ${visits.map((v) => v.date + '/' + v.doctorName).join(', ')}`);
    check('read all 3 visits from the EHR', visits.length === 3);

    /* 2) BRAIN — map each visit to a main doctor + codes (the real roster logic) */
    const planned = planAppointments(visits, DEMO_PROVIDERS, DEMO_MAIN_DOCTORS);
    const matched = planned.filter((p) => p.matched);
    log('plan:');
    for (const a of planned) log(`   ${a.patientName} ${a.date} — ${a.doctorName} → ${a.matched ? a.mainDoctor + ' :: ' + a.services.map((s) => s.code + 'x' + s.units + (s.modifiers.length ? '[' + s.modifiers.join(',') + ']' : '')).join(', ') : '(' + a.reason + ')'}`);
    check('every visit mapped to a main doctor + codes', matched.length === 3);
    check('multi-code visit kept all its service lines', matched.some((a) => a.services.length >= 3));
    check('GP/GO/GN modifier applied to services', matched.every((a) => a.services.every((s) => s.modifiers.length >= 1)));

    /* 3) DEST — book each appointment, every service line, with the cursor */
    await page.goto(srv.destUrl, { waitUntil: 'domcontentloaded' });
    await ensureStage(page);
    for (const appt of matched) {
      await announce(page, log, `Booking ${appt.patientName} on ${appt.date}…`);
      await stage(page, 'moveTo', DEST_SELECTORS.newApptButton);
      await page.click(DEST_SELECTORS.newApptButton);
      await stage(page, 'press');
      await page.waitForSelector(DEST_SELECTORS.patientField, { state: 'visible', timeout: 5000 });

      await typeInto(page, log, DEST_SELECTORS.patientField, appt.patientName, `Patient: ${appt.patientName}`);
      await typeInto(page, log, DEST_SELECTORS.mainDoctorField, appt.mainDoctor, `Clinician: ${appt.mainDoctor}`);
      await typeInto(page, log, DEST_SELECTORS.dateField, appt.date, `Date: ${appt.date}`);

      for (let i = 0; i < appt.services.length; i++) {
        const s = appt.services[i];
        if (i > 0) {
          await announce(page, log, `Adding service line ${i + 1}…`);
          await stage(page, 'moveTo', DEST_SELECTORS.addServiceBtn);
          await page.click(DEST_SELECTORS.addServiceBtn);
          await stage(page, 'press');
        }
        await typeInto(page, log, DEST_SELECTORS.codeField, s.code, `Code: ${s.code}`);
        await typeInto(page, log, DEST_SELECTORS.unitsField, String(s.units), `Units: ${s.units}`);
        await typeInto(page, log, DEST_SELECTORS.modifierField, (s.modifiers || []).join(' '), `Modifiers: ${(s.modifiers || []).join(' ') || '—'}`);
        if (i === 0) await snap(page, 'dest-filling');
      }
      await announce(page, log, 'Saving the appointment…');
      await stage(page, 'moveTo', DEST_SELECTORS.saveButton);
      await page.click(DEST_SELECTORS.saveButton);
      await stage(page, 'press');
      await page.waitForTimeout(HEADLESS ? 100 : 700);
    }

    const bookedCount = await page.$$eval('.booked-card', (els) => els.length);
    await stage(page, 'done', `Booked ${bookedCount} appointment(s) ✓`);
    await snap(page, 'dest-booked');
    check('every appointment appears in BookWell', bookedCount === matched.length);
    // Spot-check that a multi-service card shows all its codes.
    const cardText = await page.$$eval('.booked-card .svc-line', (els) => els.map((e) => e.textContent));
    check('booked card shows multiple service codes', cardText.some((t) => (t.match(/\d{5}/g) || []).length >= 3));

    if (!HEADLESS) { log('Demo complete — leaving the window open for 4s…'); await page.waitForTimeout(4000); }
  } catch (e) {
    check('demo ran without throwing', false);
    console.error('   error:', (e && e.stack) || e);
  } finally {
    await context.close().catch(() => {});
    await srv.close().catch(() => {});
  }

  console.log(`\n${fails.length ? fails.length + ' CHECK(S) FAILED' : 'all checks passed ✓'}`);
  process.exit(fails.length ? 1 : 0);
})();
