'use strict';

/*
 * Live proof that "paste a link → it opens in the controlled browser" works.
 * Drives a real Google Chrome with the SAME openPage() code the app uses, against
 * random sites, and verifies each actually left about:blank (+ saves a screenshot
 * as proof it rendered).
 *
 *   node test/open-site.js                      # default sites, headless
 *   HEADFUL=1 node test/open-site.js            # watch it in a real window
 *   node test/open-site.js example.com nytimes.com   # your own sites
 *
 * Uses a throwaway scratch profile (NOT your real Chrome), so it needs nothing
 * quit and touches no logins.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { openPage, normalizeUrl, isBlank } = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const args = process.argv.slice(2);
  const targets = args.length ? args : ['example.com', 'https://www.wikipedia.org', 'https://www.bbc.com', 'practicefusion.com'];
  const headless = !process.env.HEADFUL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-opentest-'));
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shots-'));

  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check'] });
  } catch (e1) {
    context = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check'] });
  }

  let pass = 0; let fail = 0;
  for (const site of targets) {
    const t0 = Date.now();
    let page; let url = ''; let title = ''; let ok = false; let shot = '';
    try {
      page = await openPage(context, site);          // the REAL app code path
      url = page.url();
      title = await page.title().catch(() => '');
      ok = !isBlank(page) && /^https?:/i.test(url);   // really navigated, not about:blank
      shot = path.join(shotDir, site.replace(/[^a-z0-9]+/gi, '_') + '.png');
      await page.screenshot({ path: shot }).catch(() => { shot = '(screenshot failed)'; });
    } catch (e) { title = 'ERROR: ' + (e && e.message); }
    const ms = Date.now() - t0;
    console.log(`${ok ? '  ok  ' : '  FAIL'}  ${normalizeUrl(site)}\n        → landed: ${url || '(none)'}  | title: "${title}"  | ${ms}ms\n        → screenshot: ${shot}`);
    if (ok) pass++; else fail++;
  }

  await context.close().catch(() => {});
  console.log(`\n${pass} opened, ${fail} failed${headless ? '  (headless — set HEADFUL=1 to watch the window)' : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Harness error:', e && e.message); process.exit(2); });
