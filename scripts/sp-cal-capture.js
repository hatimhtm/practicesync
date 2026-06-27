'use strict';
// Quick capture of the SimplePractice CALENDAR (day view) DOM + screenshot, so
// we can derive the date-nav arrows + appointment-block selectors for de-dup.
//   node scripts/sp-cal-capture.js
const path = require('path');
const fs = require('fs');
const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { loginSimplePractice, dismissPopups } = require(path.join(__dirname, '..', 'src', 'main', 'login'));
const step = (m) => console.log('  •', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>').replace(/<!--[\s\S]*?-->/g, '').replace(/(src|href)="data:[^"]*"/gi, '$1="data:…"').replace(/\n{2,}/g, '\n');
(async () => {
  const secrets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'secrets.local.json'), 'utf8'));
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error(error.error || error); process.exit(1); }
  const page = context.pages()[0] || (await context.newPage());
  try {
    const r = await loginSimplePractice(page, secrets.simplePractice, { onStep: step });
    if (!r.ok) { console.error('login failed', r.error); await context.close(); process.exit(1); }
    await page.goto(presets.SP.calendarUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissPopups(page); await sleep(3000);
    fs.mkdirSync('inspect-output', { recursive: true });
    fs.writeFileSync('inspect-output/spcal.html', strip(await page.content()));
    await page.screenshot({ path: 'inspect-output/spcal.png' }).catch(() => {});
    step('saved inspect-output/spcal.{html,png}');
    await sleep(2000);
  } catch (e) { console.error(e.stack || e); } finally { try { await context.close(); } catch {} }
  process.exit(0);
})();
