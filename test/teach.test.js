'use strict';

/*
 * End-to-end test of TEACH MODE's in-page picker (the part the client uses to
 * point out fields), driven by a real headless Chrome. It reproduces the exact
 * bug the user reported — "I click the search box but it selects other items" —
 * and proves the two-mode fix:
 *
 *   1. NAVIGATE mode (default): a click on a link passes through and navigates.
 *   2. PICK mode: after "Point at a field", the next click is captured AND
 *      suppressed — a link is marked WITHOUT navigating.
 *   3. The marked selector is exactly the element clicked, and is immune to
 *      moving the mouse around afterwards (the old hover-travel bug).
 *   4. An input (the search box) marks as itself.
 *   5. Clicking the picker's own buttons is never mistaken for a field.
 *
 *   node test/teach.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));

let pass = 0; const fails = [];
const check = (name, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`); ok ? pass++ : fails.push(name); };

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>teach-fixture</title>
<body style="font:16px sans-serif;margin:0;padding:20px">
  <a id="goClients" href="#clients">Clients</a>
  <input id="search" placeholder="search patients" style="margin:14px 0;display:block;width:240px;height:30px" />
  <ul id="results">
    <li id="r1"><a id="r1link" href="#patient1">Alice Adams</a></li>
    <li id="r2"><a id="r2link" href="#patient2">Bob Brown</a></li>
  </ul>
  <button id="save" onclick="document.title='SAVED'">Save</button>
  <div style="height:1400px"></div>
</body>`;

let stepSeq = 0;
// Wire the bindings exactly like captureStep does, inject the picker, and return
// handles to drive it from the test.
async function startStep(page, opts = {}) {
  stepSeq += 1;
  const binding = '__psStep_test_' + stepSeq;
  const shotBinding = '__psShot_test_' + stepSeq;
  const shots = [];
  let resolveStep; const done = new Promise((r) => { resolveStep = r; });
  await page.exposeFunction(binding, (p) => resolveStep(p));
  await page.exposeFunction(shotBinding, (s) => { shots.push(s); });
  const cfg = {
    label: opts.label || 'A field', hint: opts.hint || null,
    ancestorSelector: opts.ancestorSelector || null,
    binding, shotBinding,
    index: opts.index || 1, total: opts.total || 1,
    optional: !!opts.optional, hasBack: !!opts.hasBack,
  };
  await page.evaluate(`(${live.pickerSource().toString()})(${JSON.stringify(cfg)})`);
  return { done, shots };
}

// Click one of the picker's own buttons by its visible text.
const clickPickerButton = (page, txt) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('#__ps_teach_ui button')].find((x) => x.textContent.includes(t));
  if (!b) throw new Error('picker button not found: ' + t);
  b.click();
}, txt);

const isPicking = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('#__ps_teach_ui button')].find((x) => /Point at a field|Cancel/.test(x.textContent));
  return b ? b.textContent.includes('Cancel') : false;
});

const resetHash = (page) => page.evaluate(() => { history.replaceState(null, '', location.pathname); document.title = 'teach-fixture'; });

(async () => {
  if (!fs.existsSync('/Applications/Google Chrome.app')) { console.log('  skip  teach (no Chrome)'); process.exit(0); }
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE_HTML); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-teach-'));
  const { context, error } = await live.openAutomationContext({ userDataDir: profile, headless: true });
  if (error) { console.log('  skip  teach (could not launch Chrome)'); try { srv.close(); } catch {} process.exit(0); }

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // ---- 1. NAVIGATE mode: a click passes through and navigates. ----
    {
      const { shots } = await startStep(page, { label: 'The patient SEARCH box' });
      await resetHash(page);
      await page.click('#goClients');
      await page.waitForTimeout(150);
      check('navigate mode: link click passes through (page navigated)', /#clients$/.test(page.url()));
      check('navigate mode: nothing was captured as a field', shots.length === 0);
      await page.evaluate(() => { const e = document.getElementById('__ps_teach_ui'); if (e) e.remove(); window.__psTeachBinding = null; });
    }

    // ---- 2 & 3. PICK mode: link is marked WITHOUT navigating; selector is the
    //            clicked element and survives moving the mouse afterwards. ----
    {
      const { done, shots } = await startStep(page, { label: 'A matching PATIENT in the results' });
      await resetHash(page);
      await clickPickerButton(page, 'Point at a field');
      check('pick mode armed by the button', (await isPicking(page)) === true);

      await page.click('#r1link');               // the element the user means
      await page.waitForTimeout(120);
      check('pick mode: the link did NOT navigate (default suppressed)', !/#patient1$/.test(page.url()));
      check('pick mode: captured a selector for the clicked element', shots.length === 1 && /r1link|#r1/.test(shots[0]));
      check('pick mode: auto-returned to navigate mode after one pick', (await isPicking(page)) === false);

      // The OLD bug: moving the mouse to other elements changed the selection.
      // Prove it doesn't anymore — wander the cursor, then press Next.
      await page.hover('#r2link');
      await page.hover('#save');
      await page.hover('#search');
      const payload = await (async () => { await clickPickerButton(page, 'Finish'); return done; })();
      check('Next resolves with the originally-clicked element, not a hovered one', payload && payload.action === 'next' && /r1link|#r1/.test(payload.selector || ''));
      await page.evaluate(() => { const e = document.getElementById('__ps_teach_ui'); if (e) e.remove(); window.__psTeachBinding = null; });
    }

    // ---- 4. The search box (an input) marks as itself. ----
    {
      const { done, shots } = await startStep(page, { label: 'The patient SEARCH box' });
      await clickPickerButton(page, 'Point at a field');
      await page.click('#search');
      await page.waitForTimeout(120);
      check('input field: marked as the input itself', shots.length === 1 && /#search/.test(shots[0]));
      await clickPickerButton(page, 'Finish');
      const payload = await done;
      check('input field: Next returns the input selector', payload && /#search/.test(payload.selector || ''));
      await page.evaluate(() => { const e = document.getElementById('__ps_teach_ui'); if (e) e.remove(); window.__psTeachBinding = null; });
    }

    // ---- 5. Clicking the picker's own UI is never captured as a field. ----
    {
      const { shots } = await startStep(page, { label: 'The SAVE button' });
      await clickPickerButton(page, 'Point at a field');     // arm
      await clickPickerButton(page, 'Cancel');               // click our own button while armed-ish
      check('clicking the picker UI captured nothing', shots.length === 0);
      check('Cancel returned to navigate mode', (await isPicking(page)) === false);
    }
  } catch (e) {
    check('teach picker test ran without throwing', false);
    console.error('   error:', (e && e.stack) || e);
  } finally {
    try { await context.close(); } catch {}
    try { srv.close(); } catch {}
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();
