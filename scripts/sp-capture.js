'use strict';

/*
 * Autonomous SimplePractice capture (no 2FA): log in, open the new-appointment
 * dialog, open each control (client typeahead, clinician, location) and the
 * services row, and save a screenshot + the OPENED DOM of each — so the booking
 * selectors can be finalized against reality. Books nothing.
 *
 *   node scripts/sp-capture.js
 */

const path = require('path');
const fs = require('fs');
const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { loginSimplePractice, dismissPopups } = require(path.join(__dirname, '..', 'src', 'main', 'login'));

const OUT = path.join(process.cwd(), 'inspect-output');
const step = (m) => console.log('  •', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>').replace(/<!--[\s\S]*?-->/g, '').replace(/(src|href)="data:[^"]*"/gi, '$1="data:…"').replace(/\n{2,}/g, '\n');

function loadSecrets() {
  const p = path.join(process.cwd(), 'secrets.local.json');
  if (!fs.existsSync(p)) { console.error('Missing secrets.local.json'); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const secrets = loadSecrets();
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error('Could not open Chrome:', error.error || error); process.exit(1); }
  const page = context.pages()[0] || (await context.newPage());
  let n = 0;
  const save = async (name) => {
    n += 1; const base = `sp-${String(n).padStart(2, '0')}-${name}`;
    try { await page.screenshot({ path: path.join(OUT, base + '.png') }); } catch {}
    try { fs.writeFileSync(path.join(OUT, base + '.html'), strip(await page.content())); } catch {}
    step(`saved ${base}`);
  };

  try {
    const res = await loginSimplePractice(page, secrets.simplePractice, { onStep: step });
    if (!res.ok) { console.error('SP login failed:', res.error); await save('login-FAILED'); await context.close(); process.exit(1); }

    step('Opening the new-appointment dialog…');
    await page.goto(presets.SP.newApptUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissPopups(page);
    await sleep(1500);
    await save('dialog');

    const S = presets.SP.selectors;
    // SELECT A CLIENT first — clinician + services only render afterwards.
    if (await page.$(S.clientTrigger)) {
      await page.click(S.clientTrigger).catch(() => {});
      await sleep(500);
      await page.keyboard.type('Lochlann', { delay: 45 }); // a known demo client
      await sleep(1300);
      await save('client-open');
      // Click the matching option row.
      const opts = await page.$$(S.optionRow);
      let clicked = false;
      for (const o of opts) { const t = ((await o.textContent()) || '').toLowerCase(); if (t.includes('lochlann')) { await o.click().catch(() => {}); clicked = true; break; } }
      step(clicked ? 'Selected client: Lochlann McNulty' : 'Could not click the client option');
      await sleep(1800);
      await save('after-client'); // clinician + services should now be present
    } else { step('client trigger not found'); }

    // CLINICIAN (now rendered).
    if (await page.$(S.clinicianOpen)) { await page.click(S.clinicianOpen).catch(() => {}); await sleep(900); await save('clinician-open'); }
    else { step('clinician dropdown still not found'); }

    // SERVICES — pick a code so units + modifier boxes (if any) render.
    if (await page.$(S.codeSelect)) {
      await page.selectOption(S.codeSelect, { index: 1 }).catch(() => {});
      await sleep(1000);
      await save('service-picked');
    } else { step('service <select> still not found'); }

    // LOCATION.
    if (await page.$(S.locationTrigger)) { await page.click(S.locationTrigger).catch(() => {}); await sleep(800); await save('location-open'); }
    else { step('location trigger not found'); }

    step('Done — captures in inspect-output/sp-*.{png,html}');
    await sleep(3000);
  } catch (e) {
    console.error('Capture error:', (e && e.stack) || e);
  } finally {
    try { await context.close(); } catch {}
  }
  process.exit(0);
})();
