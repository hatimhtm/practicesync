'use strict';
// Verify: navigate the SimplePractice calendar to a date and list booked clients.
//   node scripts/sp-verify.js 06/29/2026
const path = require('path');
const fs = require('fs');
const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const { loginSimplePractice } = require(path.join(__dirname, '..', 'src', 'main', 'login'));
const { spNavigateToDate, spClientsOnDate } = require(path.join(__dirname, '..', 'src', 'main', 'book'));
const step = (m) => console.log('  •', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const date = process.argv[2] || '06/29/2026';
  const secrets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'secrets.local.json'), 'utf8'));
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error(error.error || error); process.exit(1); }
  const page = context.pages()[0] || (await context.newPage());
  try {
    const r = await loginSimplePractice(page, secrets.simplePractice, { onStep: step });
    if (!r.ok) { console.error('login failed', r.error); await context.close(); process.exit(1); }
    await spNavigateToDate(page, date, step);
    await sleep(1500);
    const clients = await spClientsOnDate(page);
    console.log(`\n  Booked on ${date}: ${clients.length ? clients.join(', ') : '(none)'}`);
    await page.screenshot({ path: 'inspect-output/sp-verify.png' }).catch(() => {});
    await sleep(2000);
  } catch (e) { console.error(e.stack || e); } finally { try { await context.close(); } catch {} }
  process.exit(0);
})();
