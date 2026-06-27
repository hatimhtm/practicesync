'use strict';

/*
 * DRY-RUN booking demo (no 2FA, books NOTHING): log in to SimplePractice, open
 * the new-appointment dialog, and fill it for one sample appointment with the
 * visible cursor — client, date, time, service code. Screenshots the result.
 *
 *   node scripts/sp-book-demo.js
 */

const path = require('path');
const fs = require('fs');
const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { loginSimplePractice, dismissPopups } = require(path.join(__dirname, '..', 'src', 'main', 'login'));
const { bookAppointment } = require(path.join(__dirname, '..', 'src', 'main', 'book'));

const step = (m) => console.log('  •', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One sample appointment, using a client that exists in the demo (Lochlann
// McNulty) and a code present in the demo service list (97112).
const SAMPLE = {
  patientName: 'Lochlann McNulty',
  date: '2026-06-29',
  time: '12:00 PM',
  mainDoctor: 'Heather Vines-Dubose',
  services: [{ code: '97112', units: 2, modifiers: ['GO'] }],
};

(async () => {
  const secrets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'secrets.local.json'), 'utf8'));
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error('Could not open Chrome:', error.error || error); process.exit(1); }
  const page = context.pages()[0] || (await context.newPage());
  fs.mkdirSync('inspect-output', { recursive: true });

  try {
    const res = await loginSimplePractice(page, secrets.simplePractice, { onStep: step });
    if (!res.ok) { console.error('SP login failed:', res.error); await context.close(); process.exit(1); }

    step('Filling a sample appointment (DRY RUN — nothing will be saved)…');
    const r = await bookAppointment(page, SAMPLE, { onStep: step, dryRun: true });
    await dismissPopups(page);
    try { await page.screenshot({ path: 'inspect-output/book-01-filled.png' }); step('📸 inspect-output/book-01-filled.png'); } catch {}
    step(`Result: ${JSON.stringify(r)}`);
    step('Leaving the window open 12s so you can see the filled form…');
    await sleep(12000);
  } catch (e) {
    console.error('Book demo error:', (e && e.stack) || e);
  } finally {
    try { await context.close(); } catch {}
  }
  process.exit(0);
})();
