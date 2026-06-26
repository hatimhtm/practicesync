'use strict';

/*
 * End-to-end test of the workflow recorder + replay (headless) against the
 * bundled sheet page. Simulates a user navigating, typing, and clicking, then
 * checks the recorder captured those as clean events, and that replay runs.
 *
 *   node test/recorder.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { startSheetServer } = require(path.join(__dirname, '..', 'src', 'main', 'demoSheet'));
const recorder = require(path.join(__dirname, '..', 'src', 'main', 'recorder'));

let pass = 0; const fails = [];
const check = (name, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`); ok ? pass++ : fails.push(name); };

(async () => {
  if (!fs.existsSync('/Applications/Google Chrome.app')) { console.log('  skip  recorder (no Chrome)'); process.exit(0); }
  const srv = await startSheetServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rec-'));
  const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-reccap-'));
  const events = [];

  try {
    const started = await recorder.startRecording({ headless: true, startUrl: srv.url, userDataDir: profile, capturesDir, onEvent: (e) => events.push(e) });
    check('recording started', started.ok === true && !!started.page);
    const page = started.page;
    await page.waitForSelector('#cellA', { timeout: 8000 });

    // Simulate the user: type into a field (commit with blur), then click a button.
    await page.fill('#cellA', 'Hello world');
    await page.click('#cellB');                 // blur #cellA → 'change' → input event
    await page.fill('#cellB', 'Second');
    await page.click('#addRow');                // click event
    await page.waitForTimeout(400);

    const res = await recorder.stopRecording();
    check('recording stopped with events', res.ok && Array.isArray(res.events) && res.events.length >= 3);
    const types = res.events.map((e) => e.type);
    check('captured the navigation', types.includes('navigate'));
    check('captured typed input (one per field, with value)', res.events.some((e) => e.type === 'input' && /Hello world/.test(e.value || '')));
    check('captured the button click', res.events.some((e) => e.type === 'click' && /addRow|Add row/i.test((e.selector || '') + (e.label || ''))));
    check('clicks were screenshotted', res.events.some((e) => e.type === 'click' && e.screenshot) && fs.readdirSync(capturesDir).some((f) => f.endsWith('.png')));
    check('not recording after stop', recorder.isRecording() === false);

    // Replay the captured workflow headless.
    const replay = await recorder.replayWorkflow({ steps: res.events, userDataDir: profile, headless: true });
    check('replay ran without error', replay.ok === true && replay.replayed >= 3);
  } catch (e) {
    check('recorder test ran without throwing', false);
    console.error('   error:', (e && e.stack) || e);
  } finally {
    try { await srv.close(); } catch {}
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();
