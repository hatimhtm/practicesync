'use strict';

/*
 * GENERIC "read from a real site → type it elsewhere" demo.
 *
 * Reads rows from a real Wikipedia page (or any page you point it at) and types
 * each one, with the visible PracticeSync cursor, into a destination — by
 * default a bundled spreadsheet page (demo/sheet.html), or any real form you
 * specify. This is the "enter any page and watch it copy the data" demo.
 *
 *   npm run demo:site                                   # default Wikipedia table → local sheet
 *   SOURCE_URL="https://en.wikipedia.org/wiki/<Article>" npm run demo:site
 *   HEADLESS=1 npm run demo:site                        # no window; runs + asserts (a test)
 *
 * Point the destination at a REAL form instead of the bundled sheet:
 *   DEST_URL="https://…"  DEST_A="#field1"  DEST_B="#field2"  DEST_ADD="button[type=submit]"  npm run demo:site
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');
const { openPage, ensureStage, stage, announce } = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = !!process.env.HEADLESS;

// --- what to read ---
const SOURCE_URL = process.env.SOURCE_URL || 'https://en.wikipedia.org/wiki/List_of_largest_cities';
const ROWS = Number(process.env.SOURCE_ROWS || 6);
// Default labels match the default source (largest-cities table); override with
// COL_A / COL_B when you point SOURCE_URL at a different page.
const COL_A = process.env.COL_A || 'City';
const COL_B = process.env.COL_B || 'Country';

// --- where to write (default: bundled sheet; or a real form via DEST_URL) ---
const DEST_URL = process.env.DEST_URL || '';
const DEST_A = process.env.DEST_A || '#cellA';
const DEST_B = process.env.DEST_B || '#cellB';
const DEST_ADD = process.env.DEST_ADD || '#addRow';

const SHOTS = process.env.SHOTS; let shotN = 0;
const snap = async (page, name) => { if (SHOTS) { try { await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) }); } catch {} } };
const log = (m) => console.log('   · ' + m);
const fails = [];
const check = (name, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`); if (!ok) fails.push(name); };

function serveSheet() {
  const html = fs.readFileSync(path.join(__dirname, 'sheet.html'));
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
  }));
}

async function typeInto(page, selector, value) {
  if (!value) return;
  await stage(page, 'moveTo', selector);
  await page.click(selector).catch(() => {});
  await page.fill(selector, '').catch(() => {});
  await page.type(selector, String(value), { delay: HEADLESS ? 0 : 45 });
  await stage(page, 'press');
}

(async () => {
  const sheet = DEST_URL ? null : await serveSheet();
  const destUrl = DEST_URL || `${sheet.url}?a=${encodeURIComponent(COL_A)}&b=${encodeURIComponent(COL_B)}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-site-'));
  let context;
  const base = { headless: HEADLESS, viewport: null, args: ['--no-first-run', '--no-default-browser-check', '--disable-component-update', '--start-maximized'] };
  try { context = await chromium.launchPersistentContext(profile, { channel: 'chrome', ...base }); }
  catch { context = await chromium.launchPersistentContext(profile, { executablePath: CHROME, ...base }); }

  try {
    /* 1) READ from the real source page */
    const page = await openPage(context, SOURCE_URL);
    await ensureStage(page);
    await announce(page, log, `Reading data from ${new URL(SOURCE_URL).hostname}…`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(800);

    const rows = await page.evaluate((limit) => {
      const clean = (s) => String(s || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
      const out = [];
      const table = document.querySelector('table.wikitable') || document.querySelector('table');
      if (table) {
        for (const tr of table.querySelectorAll('tbody tr')) {
          const cells = [...tr.querySelectorAll('th,td')].map((c) => clean(c.textContent)).filter(Boolean);
          if (cells.length >= 2 && /[a-z]/i.test(cells[0] + cells[1])) out.push({ a: cells[0].slice(0, 60), b: cells[1].slice(0, 60) });
          if (out.length >= limit) break;
        }
      }
      if (!out.length) {
        for (const li of [...document.querySelectorAll('.mw-parser-output ul li')].slice(0, limit)) {
          const t = clean(li.textContent); if (t) out.push({ a: t.slice(0, 60), b: '' });
        }
      }
      return out;
    }, ROWS);

    log(`read ${rows.length} row(s): ${rows.map((r) => r.a + (r.b ? ' / ' + r.b : '')).join('  |  ')}`);
    await stage(page, 'done', `Read ${rows.length} row(s)`);
    await snap(page, 'source-read');
    check('read rows from the source page', rows.length >= 2);

    /* 2) WRITE each row into the destination, with the visible cursor */
    await page.goto(destUrl, { waitUntil: 'domcontentloaded' });
    await ensureStage(page);
    for (let i = 0; i < rows.length; i++) {
      await announce(page, log, `Copying row ${i + 1} of ${rows.length}: ${rows[i].a}…`);
      await typeInto(page, DEST_A, rows[i].a);
      await typeInto(page, DEST_B, rows[i].b);
      await stage(page, 'moveTo', DEST_ADD);
      await page.click(DEST_ADD).catch(() => {});
      await stage(page, 'press');
      await page.waitForTimeout(HEADLESS ? 60 : 500);
    }
    await stage(page, 'done', `Copied ${rows.length} row(s) ✓`);
    await snap(page, 'dest-filled');

    if (!DEST_URL) {
      const added = await page.$$eval('#sheet tr.row', (els) => els.length);
      check('every row was added to the sheet', added === rows.length);
    }
    if (!HEADLESS) { log('Demo complete — leaving the window open for 4s…'); await page.waitForTimeout(4000); }
  } catch (e) {
    check('demo ran without throwing', false);
    console.error('   error:', (e && e.stack) || e);
  } finally {
    await context.close().catch(() => {});
    if (sheet) await sheet.close().catch(() => {});
  }
  console.log(`\n${fails.length ? fails.length + ' CHECK(S) FAILED' : 'all checks passed ✓'}`);
  process.exit(fails.length ? 1 : 0);
})();
