'use strict';

/*
 * LIVE read-and-plan against the demo accounts — the "watch the major stuff work"
 * run. It:
 *   1. opens the dedicated Chrome window,
 *   2. auto-signs in to Practice Fusion (pausing for your phone code if asked),
 *   3. opens the Schedule, clears any promo popup,
 *   4. reads every appointment on the day shown, and
 *   5. prints the booking plan (main doctor + codes), reading-only — books nothing.
 *
 *   1) cp secrets.local.example.json secrets.local.json   (then fill it in)
 *   2) npm run accounts
 *
 * It uses the verified selectors in src/main/presets.js and the roster in
 * src/main/model.js (DEMO_PROVIDERS). Booking (write) comes next, once this read
 * is confirmed working on the live account.
 */

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { loginPracticeFusion, dismissPopups } = require(path.join(__dirname, '..', 'src', 'main', 'login'));
const { extractVisits } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const { DEMO_PROVIDERS, DEMO_MAIN_DOCTORS } = require(path.join(__dirname, '..', 'src', 'main', 'model'));

const step = (m) => console.log('  •', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSecrets() {
  const p = path.join(process.cwd(), 'secrets.local.json');
  if (!fs.existsSync(p)) { console.error('\nMissing secrets.local.json — copy secrets.local.example.json to secrets.local.json and fill in the demo logins.\n'); process.exit(1); }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('secrets.local.json is not valid JSON:', e.message); process.exit(1); }
}

(async () => {
  const secrets = loadSecrets();
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error('Could not open Chrome:', error.error || error); process.exit(1); }
  const page = context.pages()[0] || (await context.newPage());

  try {
    const res = await loginPracticeFusion(page, secrets.practiceFusion, { onStep: step });
    if (!res.ok) { console.error('\nLogin failed:', res.error, '\n'); await context.close(); process.exit(1); }

    step('Opening the Schedule…');
    await page.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissPopups(page);
    await live.ensureStage(page).catch(() => {});
    await live.announce(page, step, 'Reading the day’s appointments…').catch(() => {});
    try { await page.waitForSelector(presets.PF.selectors.rowSelector, { timeout: 20000 }); } catch {}
    await sleep(1200);
    await dismissPopups(page);

    const html = await page.content();
    const doc = new JSDOM(html).window.document;
    const day = (doc.querySelector(presets.PF.nav.dateHeading) || {}).textContent || '';
    const visits = extractVisits(doc, presets.PF.selectors, 100)
      .map((v) => ({ ...v, patientName: (v.patientName || '').trim(), doctorName: (v.doctorName || '').trim() }));

    const planned = planAppointments(visits, DEMO_PROVIDERS, DEMO_MAIN_DOCTORS);

    console.log(`\n==== ${day.trim() || 'Schedule'} — ${planned.length} appointment(s) ====`);
    for (const p of planned) {
      const svc = (p.services || []).map((s) => `${s.code}x${s.units}${s.modifiers.length ? '[' + s.modifiers.join(',') + ']' : ''}`).join(' ');
      console.log(`  ${p.matched ? '✔' : '✖'} ${(p.patientName || '').padEnd(22)} ${(p.doctorName || '').padEnd(15)} → ${(p.mainDoctor || p.reason || '??').toString().padEnd(26)} ${svc}`);
    }
    const matched = planned.filter((p) => p.matched).length;
    console.log(`\n  ${matched}/${planned.length} ready to book (read-only — nothing was booked).`);
    await live.stage(page, 'done', `Read ${planned.length} appointment(s) — ${matched} ready to book`).catch(() => {});

    try { fs.mkdirSync('inspect-output', { recursive: true }); await page.screenshot({ path: 'inspect-output/run-schedule.png' }); console.log('  screenshot: inspect-output/run-schedule.png'); } catch {}
    console.log('\n  Leaving the window open for 20s so you can see it…');
    await sleep(20000);
  } catch (e) {
    console.error('Run error:', (e && e.stack) || e);
  } finally {
    try { await context.close(); } catch {}
  }
  process.exit(0);
})();
