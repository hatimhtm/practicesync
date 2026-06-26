'use strict';

/*
 * Renders the real renderer UI (src/renderer/index.html) in headless Chrome with
 * a stubbed window.api, then screenshots every view + the onboarding steps so we
 * can review the ACTUAL pixels (light + dark). Output dir printed at the end.
 *
 *   node build/shoot-ui.js            # dark + light, all views & onboarding steps
 *   THEME=light node build/shoot-ui.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');
const INDEX = 'file://' + path.join(ROOT, 'src', 'renderer', 'index.html');

// Realistic settings so the views populate like a configured, mid-use app.
const STUB_SETTINGS = {
  appVersion: '1.0.7',
  providers: [
    { name: 'Jess', mainDoctor: 'Heather Vines-Dubose', codes: [{ code: '97112', units: 2, modifiers: [] }, { code: '97530', units: 2, modifiers: ['59'] }] },
    { name: 'Gianna', mainDoctor: 'Caryn McAllister', codes: [{ code: '97112', units: 2, modifiers: [] }, { code: '97530', units: 2, modifiers: ['59'] }] },
    { name: 'Sam Comrie', mainDoctor: 'Karine Rocha de Benedicto', codes: [{ code: '92523', units: 1, modifiers: [] }, { code: '92507', units: 1, modifiers: [] }, { code: '97550', units: 2, modifiers: [] }] },
  ],
  mainDoctors: [
    { name: 'Caryn McAllister', code: 'GP' },
    { name: 'Heather Vines-Dubose', code: 'GO' },
    { name: 'Karine Rocha de Benedicto', code: 'GN' },
  ],
  rosterText: '',
  aiProvider: 'auto',
  pfUrl: 'https://static.practicefusion.com/',
  spUrl: 'https://secure.simplepractice.com/',
  pfSelectors: { searchBox: '#x', rowSelector: '.r', doctorSelector: '.d', dateSelector: '.dt' },
  spSelectors: { saveButton: '#s', codeField: '#c' },
  spMode: 'standard',
  patientNames: ['Emma Johnson'],
  schedule: 'daily',
  setupComplete: true,
  setupVersion: 4,
  lastResult: { ok: true, at: new Date('2026-06-22T15:30:00').toISOString(), created: 3, unmatched: 0, dryRun: false },
};

const API_STUB = `
  window.api = {
    getSettings: async () => (${JSON.stringify(STUB_SETTINGS)}),
    saveSettings: async () => ({}),
    setAI: async () => ({ ok: true }),
    detectEngines: async () => ({ ollama: { available: true, model: 'gemma4:e4b', models: ['gemma4:e4b'] }, apple: true, builtin: true }),
    parseRoster: async () => ({ providers: [], unparsed: [], engine: 'local model (gemma4:e4b)' }),
    saveRoster: async () => ({}),
    loadDemo: async () => ({}),
    runSync: async () => ({ ok: true }),
    runNow: async () => ({ ok: true }),
    runSiteDemo: async () => ({ ok: true }),
    onDemoStep: () => {},
    recordStart: async () => ({ ok: true }), recordStop: async () => ({ ok: true, events: [] }),
    recordSave: async () => ({ ok: true }), recordList: async () => ({ ok: true, workflows: [] }),
    recordDelete: async () => ({ ok: true }), recordReplay: async () => ({ ok: true }), onRecordEvent: () => {},
    teach: async () => ({ ok: true }),
    onRunStatus: () => {}, onRunFinished: () => {}, onLiveStep: () => {},
    checkForUpdates: async () => {}, installUpdate: async () => {}, onUpdateStatus: () => {},
  };
`;

const VIEWS = ['home', 'doctors', 'connect', 'ai', 'schedule', 'test', 'record'];
const OB_STEPS = [0, 1, 2, 3, 4, 5];

async function main() {
  const theme = process.env.THEME === 'light' ? 'light' : 'dark';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-ui-${theme}-`));
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ executablePath: CHROME, headless: true }); }
  const context = await browser.newContext({ viewport: { width: 980, height: 820 }, colorScheme: theme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(API_STUB);
  await page.goto(INDEX, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // The app opens onboarding on load (setupComplete true here, so it won't) —
  // capture main views first with onboarding hidden.
  await page.evaluate(() => { const o = document.getElementById('onboard'); if (o) o.classList.add('hidden'); });

  for (const v of VIEWS) {
    await page.evaluate((name) => { window.showView ? window.showView(name) : document.querySelector(`.nav-item[data-view="${name}"]`).click(); }, v);
    await page.waitForTimeout(200);
    const out = path.join(outDir, `view-${v}.png`);
    await page.screenshot({ path: out });
  }

  // Onboarding steps.
  for (const s of OB_STEPS) {
    await page.evaluate((step) => {
      const o = document.getElementById('onboard'); o.classList.remove('hidden');
      document.querySelectorAll('.ob-step').forEach((el) => el.classList.toggle('hidden', Number(el.dataset.step) !== step));
      // progress dots
      const w = document.getElementById('obProgress'); if (w) { w.innerHTML = ''; for (let i = 0; i < 6; i++) { const d = document.createElement('div'); d.className = 'seg-dot' + (i <= step ? ' on' : ''); w.appendChild(d); } }
    }, s);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, `onboard-${s}.png`) });
  }

  await browser.close();
  console.log(outDir);
}

main();
