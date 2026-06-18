'use strict';

/*
 * Live proof that the app can MOVE THE CURSOR, navigate INSIDE a site, and FIND
 * things in it — the same capabilities used to search a patient in Practice
 * Fusion and read their visits. Uses the app's real openPage + stage code and a
 * throwaway Chrome profile (touches no logins).
 *
 *   node test/interact-site.js            # headless, with screenshots
 *   HEADFUL=1 node test/interact-site.js  # watch the cursor move in a window
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { openPage, ensureStage, stage, announce } = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const log = (m) => console.log('   · ' + m);

(async () => {
  const headless = !process.env.HEADFUL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-interact-'));
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ishots-'));
  let context;
  try { context = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check'] }); }
  catch { context = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless, viewport: null, args: ['--no-first-run', '--no-default-browser-check'] }); }

  const checks = [];
  const check = (name, cond) => { checks.push({ name, ok: !!cond }); console.log(`${cond ? '  ok  ' : '  FAIL'}  ${name}`); };

  try {
    // 1) OPEN a page with a big, reliably-visible search box.
    const page = await openPage(context, 'https://en.wikipedia.org/wiki/Special:Search');
    check('opened the site (not about:blank)', /Special:Search/i.test(page.url()));
    await ensureStage(page);

    // 2) MOVE THE CURSOR to the search box and TYPE (like typing a patient name).
    await announce(page, log, 'Moving the cursor to the search box & typing…');
    const searchSel = '#searchText';
    await page.waitForSelector(searchSel, { timeout: 15000 });
    const moved = await stage(page, 'moveTo', searchSel);
    check('moved the visible cursor onto the search box', moved === true);
    check('visible cursor is rendered in the page', !!(await page.$('#__ps_cursor')));
    const box = page.locator(searchSel).first();
    await box.fill('').catch(() => {});
    await box.type('Octopus', { delay: 45 }).catch(() => {});
    await stage(page, 'press');
    await shot(page, shotDir, '1-typed');

    // 3) NAVIGATE INSIDE the site — submit; the query in the resulting URL is the
    //    proof the text was actually typed and entered.
    await announce(page, log, 'Submitting the search…');
    const before = page.url();
    await box.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    check('typed text was entered (it submitted with the query)', /octopus/i.test(page.url()));
    check('navigated to the results page', page.url() !== before);
    log(`now on: ${page.url()}`);

    // 4) FIND STUFF on the page (like reading the visit list).
    await announce(page, log, 'Reading the page…');
    const h1 = (await page.locator('h1').first().textContent().catch(() => '') || '').trim();
    check('found the page heading', h1.length > 0); log(`heading: "${h1}"`);
    const links = await page.locator('#bodyContent a[href^="/wiki/"]').count().catch(() => 0);
    check('found in-page links to follow', links > 5); log(`${links} internal links found`);
    await shot(page, shotDir, '2-found');

    // 5) Follow a real article link (not a Special:/Help: namespace one) to prove
    //    it can navigate DEEPER and read again.
    await announce(page, log, 'Opening a result…');
    const before2 = page.url();
    const linkSel = '#bodyContent a[href^="/wiki/"]:not([href*=":"])';
    await page.waitForSelector(linkSel, { timeout: 10000 }).catch(() => {});
    await stage(page, 'moveTo', linkSel);
    await page.locator(linkSel).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    check('navigated to an article inside the site', page.url() !== before2 && /\/wiki\//.test(page.url()));
    const h1b = (await page.locator('h1').first().textContent().catch(() => '') || '').trim();
    const parasb = await page.locator('#bodyContent p').count().catch(() => 0);
    check('read the article content', h1b.length > 0 && parasb > 0); log(`now on: ${page.url()} — "${h1b}" (${parasb} paragraphs)`);
    await shot(page, shotDir, '3-article');
  } catch (e) {
    check('harness ran without throwing', false);
    console.error('   error:', e && e.message);
  }

  await context.close().catch(() => {});
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed  ·  screenshots in ${shotDir}`);
  process.exit(failed ? 1 : 0);
})();

async function shot(page, dir, name) {
  const p = path.join(dir, name + '.png');
  try { await page.screenshot({ path: p }); console.log('     📸 ' + p); } catch {}
}
