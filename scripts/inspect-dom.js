'use strict';

/*
 * DOM INSPECTOR — capture the REAL Practice Fusion / SimplePractice page
 * structure so we can build verified selectors instead of guessing.
 *
 *   npm run inspect                 # opens to a blank page; type the URL yourself
 *   npm run inspect <start-url>     # opens straight to that page
 *
 * It opens the SAME dedicated Chrome window the app uses (so logging in here
 * also logs the app in). A small "Inspector" panel floats at the bottom-left:
 *
 *   • 📸 Whole page          — saves the full page's HTML + a screenshot
 *   • 📍 Last-clicked element — saves just the element you last clicked
 *                               (click one appointment ROW, or the appointment
 *                                dialog, then press this) + its parent for context
 *
 * Everything is written to ./inspect-output/ (git-ignored). Nothing is uploaded.
 * The data on these demo screens is fake, so the HTML is safe to send back.
 *
 * Log in manually the first time, navigate to the screen you want, then capture.
 * Capture, in order, ideally:
 *   1. The Practice Fusion LOGIN page (before you log in)        → for auto-login
 *   2. The Practice Fusion 2-factor page (if it appears)         → for the 2FA pause
 *   3. The Schedule → Appointments table (whole page)            → for the day read
 *   4. ONE appointment row (click the row, then 📍)              → for the row read
 *   5. The SimplePractice LOGIN page                             → for auto-login
 *   6. The calendar with the New-Appointment dialog open (📸)    → for booking
 *   7. The Search-Client box / Date / Save (click each, then 📍) → for booking
 *
 * Press Ctrl-C in this terminal when you're done.
 */

const path = require('path');
const fs = require('fs');
const live = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));

const OUT = path.join(process.cwd(), 'inspect-output');
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

/* Keep the selector-relevant bits (id, class, data- attrs, aria), drop the
 * noise that bloats the file (scripts, styles, inline SVG paths, base64 blobs). */
function strip(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(src|href)="data:[^"]*"/gi, '$1="data:…"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

async function capture(page, payload) {
  n += 1;
  let label = (payload && payload.label) || '';
  if (!label) { try { label = await page.title(); } catch {} }
  label = String(label || 'page').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  const base = String(n).padStart(2, '0') + '-' + label;
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(OUT, base + '.html'), strip(html));
    fs.writeFileSync(path.join(OUT, base + '.raw.html'), html);
    fs.writeFileSync(path.join(OUT, base + '.url.txt'), page.url() + '\n');
    await page.screenshot({ path: path.join(OUT, base + '.png') }).catch(() => {});
    if (payload && payload.element) fs.writeFileSync(path.join(OUT, base + '.element.html'), payload.element);
    console.log(`  ✔ saved  ${base}   ${page.url()}`);
  } catch (e) {
    console.log('  ✖ capture failed:', (e && e.message) || e);
  }
}

/* Injected into every page (and re-checked for SPA route changes). Builds the
 * floating panel and tracks the last element the user clicked — without blocking
 * any clicks, so the sites work completely normally. */
function panelSource() {
  if (window.top !== window) return; // top frame only
  let lastClicked = null;
  const isOurs = (el) => el && el.closest && el.closest('#__inspect_ui');
  document.addEventListener('click', (e) => { if (!isOurs(e.target)) lastClicked = e.target; }, true);

  const build = () => {
    if (document.getElementById('__inspect_ui')) return;
    const ui = document.createElement('div');
    ui.id = '__inspect_ui';
    Object.assign(ui.style, { position: 'fixed', bottom: '14px', left: '14px', zIndex: '2147483647', background: 'rgba(17,24,40,.97)', color: '#eaf0fb', font: '600 12px/1.4 -apple-system,system-ui,sans-serif', padding: '10px 12px', borderRadius: '12px', boxShadow: '0 12px 34px rgba(0,0,0,.5)', border: '1px solid rgba(122,160,255,.45)', maxWidth: '240px' });
    const mk = (txt) => { const b = document.createElement('button'); b.textContent = txt; Object.assign(b.style, { display: 'block', width: '100%', margin: '6px 0 0', font: '600 12px -apple-system,system-ui,sans-serif', border: '0', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer', color: '#04240f', background: '#34d399' }); return b; };
    const title = document.createElement('div'); title.innerHTML = '🔎 <b>Inspector</b> — capture this screen';
    const inp = document.createElement('input'); inp.placeholder = 'label (e.g. pf-row)'; Object.assign(inp.style, { width: '100%', marginTop: '6px', padding: '6px 8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.06)', color: '#eaf0fb', font: '12px -apple-system,sans-serif', boxSizing: 'border-box' });
    const bPage = mk('📸 Whole page');
    const bEl = mk('📍 Last-clicked element');
    Object.assign(bEl.style, { background: '#7aa0ff', color: '#04122e' });
    bPage.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { window.__inspectCapture({ label: inp.value }); } catch {} });
    bEl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      let html = '';
      if (lastClicked) { try { html = (lastClicked.parentElement || lastClicked).outerHTML.slice(0, 12000); } catch {} }
      try { window.__inspectCapture({ label: inp.value || 'element', element: html }); } catch {}
    });
    ui.appendChild(title); ui.appendChild(inp); ui.appendChild(bPage); ui.appendChild(bEl);
    (document.body || document.documentElement).appendChild(ui);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  setInterval(build, 1500); // survive SPA re-renders that wipe the panel
}

(async () => {
  const startUrl = process.argv[2] || '';
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error('Could not open Chrome:', error.error || error); process.exit(1); }

  await context.exposeBinding('__inspectCapture', async (source, payload) => { await capture(source.page, payload); });
  await context.addInitScript(panelSource);

  const page = context.pages()[0] || (await context.newPage());
  if (startUrl) { try { await page.goto(startUrl, { waitUntil: 'domcontentloaded' }); } catch {} }
  else { try { await page.evaluate(() => {}); } catch {} }
  // The init script only runs on navigation; inject once into the page already open.
  try { await page.evaluate(`(${panelSource.toString()})()`); } catch {}

  console.log('\nInspector ready. Log in, open each screen, and use the panel');
  console.log('(bottom-left) to capture. Files go to ./inspect-output/');
  console.log('Press Ctrl-C here when you are done.\n');

  // Keep alive until the user closes the window or Ctrl-C.
  context.on('close', () => process.exit(0));
  await new Promise(() => {});
})();
