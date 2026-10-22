'use strict';

/*
 * The clinician (billing provider) step of booking, against a mock of
 * SimplePractice's appointment dialog: the client search's and the location's
 * leftover options stay on the page (the trap that left visits under the
 * default clinician), and the clinician list opens apart from the box.
 *   node test/clinician.test.js      (needs Google Chrome; skipped without it)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { selectClinician } = require(path.join(__dirname, '..', 'src', 'main', 'book'));

let passed = 0;
let failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

// mode: 'list' (a normal list), 'locked' (the box never opens), 'missing' (the wanted doctor isn't listed)
function dialog(mode, shown = 'Caryn McAllister') {
  const names = mode === 'missing' ? ['Caryn McAllister', 'Heather Meehan'] : ['Caryn McAllister', 'Heather Meehan', 'Heather Vines Dubose', 'Karine Rocha De Benedicto'];
  return `<!doctype html><html><body>
  <div data-validation-path="client"><div class="select-box__options"><div class="select-box__option">Pat Fakename</div></div></div>
  <div class="shared-clinician-dropdown"><div class="shared-clinician-dropdown-container"><label>Clinician</label>
    <div class="non-editable-dropdown"><div class="typeahead-label">${shown}</div></div></div></div>
  <div data-validation-path="officeId"><div class="select-box__options"><div class="select-box__option no-results">No locations found</div></div></div>
  <script>
    const box = document.querySelector('.non-editable-dropdown');
    ${mode === 'locked' ? '' : `box.addEventListener('click', () => {
      setTimeout(() => {   // the list draws a moment later, in its own layer at the end of the page
        const list = document.createElement('div');
        list.innerHTML = ${JSON.stringify(names)}.map((n) => '<div class="select-box__option">' + n + '</div>').join('');
        list.addEventListener('click', (e) => { document.querySelector('.typeahead-label').textContent = e.target.textContent; list.remove(); });
        document.body.appendChild(list);
      }, 600);
    });`}
  </script></body></html>`;
}

(async () => {
  if (!fs.existsSync('/Applications/Google Chrome.app')) { console.log('  skip  clinician (Google Chrome not installed here)'); return; }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const S = presets.SP.selectors;
  try {
    const run = async (mode, doctor, shown) => {
      const page = await browser.newPage();
      try {
        await page.setContent(dialog(mode, shown));
        const r = await selectClinician(page, S, doctor, () => {});
        const label = (await page.textContent('.typeahead-label')).trim();
        return { ...r, label };
      } finally { await page.close(); }
    };
    console.log('# The billing provider is set and checked, never left on the default');
    let r = await run('list', 'Heather Vines-Dubose');
    check('Heather Vines-Dubose is chosen (not Heather Meehan, not left on Caryn)', r.status === 'ok' && r.label === 'Heather Vines Dubose');
    r = await run('list', 'Karine Rocha de Benedicto');
    check('Karine Rocha de Benedicto is chosen', r.status === 'ok' && r.label === 'Karine Rocha De Benedicto');
    r = await run('list', 'Caryn McAllister');
    check('already showing the right one → nothing to change', r.status === 'ok' && r.label === 'Caryn McAllister');
    r = await run('missing', 'Heather Vines-Dubose');
    check('the doctor isn\'t in the list → "failed", so the visit is not saved', r.status === 'failed' && r.label === 'Caryn McAllister');
    r = await run('locked', 'Heather Vines-Dubose');
    check('a box that never opens → "locked" (booked, flagged on Alerts)', r.status === 'locked');
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
