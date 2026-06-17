'use strict';

const os = require('os');
const path = require('path');
const { extractVisits, planFormValues } = require('./extract');

/**
 * Live browser automation. Drives the user's EXISTING Chrome profile (so all
 * their Practice Fusion / SimplePractice logins and cookies are already there —
 * no new login, no stored passwords). Everything here is lazy-loaded and fully
 * isolated: if Playwright/Chrome isn't available, it returns a friendly error
 * and the rest of the app (and the simulated demo) keeps working.
 *
 * NOTE: this layer is validated on the client's Mac against the real sites.
 * The data-handling core it relies on (extract.js) is unit-tested against
 * local fixtures, so the parsing/mapping is proven before it ever runs live.
 */

const fs = require('fs');

const CHROME_APP = '/Applications/Google Chrome.app';
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function getPlaywright() {
  try {
    return { pw: require('playwright-core') };
  } catch (e) {
    return { err: String((e && e.message) || e) };
  }
}

/** Default macOS Chrome user-data dir (reuses the user's real, logged-in profile). */
function defaultChromeUserDataDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/** Is Chrome's profile locked because Chrome is already running? */
function chromeRunningLock(userDataDir) {
  try { return fs.existsSync(path.join(userDataDir, 'SingletonLock')); } catch { return false; }
}

function fail(error, detail) {
  return { ok: false, error, detail: detail ? String(detail).slice(0, 300) : undefined };
}

async function withBrowser(opts, fn) {
  const { pw, err } = getPlaywright();
  if (!pw) return fail('The automation component could not load in this build.', err);
  if (!fs.existsSync(CHROME_APP)) {
    return fail('Google Chrome isn’t installed. Please install Google Chrome, sign into Practice Fusion & SimplePractice in it, then try again.');
  }
  const userDataDir = opts.userDataDir || defaultChromeUserDataDir();
  if (chromeRunningLock(userDataDir)) {
    return fail('Google Chrome is open — please QUIT Chrome completely (Cmd-Q), then click again. The app needs to borrow your Chrome profile.');
  }

  // The update/background-networking flags keep Chrome from launching its own
  // updater (Keystone) — that updater modifies /Applications/Google Chrome.app,
  // which is what makes macOS pop the "App Management" permission prompt.
  const launchOpts = {
    headless: false,
    viewport: null,
    args: [
      `--profile-directory=${opts.profileDir || 'Default'}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-networking',
    ],
  };
  let context;
  try {
    // Prefer the installed Chrome channel; fall back to its explicit binary path.
    try {
      context = await pw.chromium.launchPersistentContext(userDataDir, { channel: 'chrome', ...launchOpts });
    } catch (e1) {
      context = await pw.chromium.launchPersistentContext(userDataDir, { executablePath: CHROME_BIN, ...launchOpts });
    }
  } catch (e) {
    const s = String((e && e.message) || e);
    if (/ProcessSingleton|cannot create|in use|locked|SingletonLock/i.test(s)) {
      return fail('Google Chrome is open — please QUIT Chrome completely (Cmd-Q), then click again.', s);
    }
    return fail('Could not open Chrome. Make sure Google Chrome is installed and fully quit, then try again.', s);
  }
  try {
    return await fn(context);
  } catch (e) {
    return fail('Something went wrong while controlling the browser. Try again with Chrome fully quit.', String((e && e.message) || e));
  } finally {
    try { await context.close(); } catch {}
  }
}

/**
 * Navigate the VISIBLE window (the one the user sees) to the page and bring it
 * to the front — not a hidden background tab. Returns the page.
 */
async function openPage(context, url) {
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  // Close any other restored tabs so there's a single, obvious window to look at.
  for (const p of pages.slice(1)) { try { await p.close(); } catch {} }
  try { await page.bringToFront(); } catch {}
  // BEST EFFORT navigation. 'commit' resolves the instant the load starts (so we
  // never hang on a slow SPA), and we never throw — if it doesn't land, the user
  // can just type the address into Chrome themselves and the teach overlay will
  // follow them there.
  if (url) {
    try { await page.goto(url, { waitUntil: 'commit', timeout: 30000 }); }
    catch { try { await page.evaluate((u) => { try { location.href = u; } catch {} }, url); } catch {} }
  }
  try { await page.bringToFront(); } catch {}
  return page;
}

/**
 * Open one patient by NAME: go to the search page, type the name, and open the
 * first result — so the user never has to paste a per-patient URL. Returns true
 * if it landed on a patient timeline. Requires `selectors.searchBox` (taught).
 */
async function searchPatient(page, selectors, name, baseUrl) {
  try {
    // Start each search from a clean search page.
    if (baseUrl) { try { await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {} }
    await page.waitForSelector(selectors.searchBox, { timeout: 15000 });
    await page.click(selectors.searchBox);
    try { await page.fill(selectors.searchBox, ''); } catch {}
    await page.type(selectors.searchBox, String(name), { delay: 30 });
    await page.waitForTimeout(1200); // let the results / dropdown populate
    if (selectors.firstResult) {
      try { await page.waitForSelector(selectors.firstResult, { timeout: 8000 }); } catch {}
      await page.click(selectors.firstResult, { timeout: 8000 });
    } else {
      await page.keyboard.press('Enter'); // no result taught → submit the search
    }
    // Wait for the patient's visit list to render.
    try { await page.waitForSelector(selectors.rowSelector, { timeout: 15000 }); } catch {}
    return true;
  } catch { return false; }
}

/**
 * Read the first `limit` visits off Practice Fusion, reusing the tested
 * extraction logic on the live page's HTML.
 *
 * If `patientNames` is given and a search box was taught, the app SEARCHES each
 * patient by name (no URL needed) and reads their visits. Otherwise it just
 * reads whatever patient page is already open at `url` (the old behavior).
 */
async function pullVisits({ userDataDir, profileDir, url, selectors, limit = 10, patientNames = [] }) {
  if (!url || !selectors || !selectors.rowSelector) {
    return { ok: false, error: 'Practice Fusion isn\'t set up yet — use Teach Mode to show the app the patient page first.' };
  }
  const names = (patientNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  return withBrowser({ userDataDir, profileDir }, async (context) => {
    const page = await openPage(context, url);
    const { JSDOM } = require('jsdom');

    // Name-based path: search each patient and collect their visits.
    if (names.length && selectors.searchBox) {
      const all = [];
      for (const name of names) {
        const found = await searchPatient(page, selectors, name, url);
        if (!found) { all.push({ patientName: name, date: '', doctorName: '', notFound: true }); continue; }
        const doc = new JSDOM(await page.content()).window.document;
        const visits = extractVisits(doc, selectors, limit);
        if (!visits.length) { all.push({ patientName: name, date: '', doctorName: '', notFound: true }); continue; }
        // Make sure each visit carries the patient we searched for.
        all.push(...visits.map((v) => ({ ...v, patientName: v.patientName || name })));
      }
      return { ok: true, visits: all };
    }

    // Fallback: read the single patient page that's already open at `url`.
    try { await page.waitForSelector(selectors.rowSelector, { timeout: 15000 }); } catch {}
    const doc = new JSDOM(await page.content()).window.document;
    return { ok: true, visits: extractVisits(doc, selectors, limit) };
  });
}

/**
 * Create one appointment in SimplePractice via the taught form fields, then save.
 * (Used only when spMode === 'standard'; the 'enterprise' path uses the API.)
 */
async function createAppointmentLive({ userDataDir, profileDir, url, selectors, appointment }) {
  if (!url || !selectors || !selectors.saveButton) {
    return { ok: false, error: 'SimplePractice isn\'t set up yet — use Teach Mode to show the app the appointment form.' };
  }
  return withBrowser({ userDataDir, profileDir }, async (context) => {
    const page = await openPage(context, url);
    if (selectors.newApptButton) {
      try { await page.click(selectors.newApptButton, { timeout: 10000 }); }
      catch { return { ok: false, error: 'Could not open the new-appointment form. Re-teach the SimplePractice screen.' }; }
    }
    // Every required field must actually fill; otherwise abort BEFORE saving so
    // we never save a half-filled appointment.
    const required = ['doctor', 'date', 'codes', 'patient'];
    const filled = new Set();
    for (const f of planFormValues(selectors, appointment)) {
      try {
        const el = await page.$(f.selector);
        if (!el) continue;
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') await page.selectOption(f.selector, { label: f.value }).catch(() => page.selectOption(f.selector, f.value));
        else { await el.fill(''); await el.type(String(f.value)); }
        filled.add(f.kind);
      } catch { /* field failed — handled by the required-check below */ }
    }
    const missing = required.filter((k) => !filled.has(k));
    if (missing.length) {
      return { ok: false, error: `Didn't save — couldn't fill: ${missing.join(', ')}. Re-teach the SimplePractice screen.` };
    }
    await page.click(selectors.saveButton, { timeout: 10000 });
    await page.waitForTimeout(800);
    return { ok: true };
  });
}

/**
 * Teach Mode: open a page and let the user click the fields the app needs.
 * Each step waits for one click and captures a stable selector for it.
 * `steps` = [{ key, label, relativeTo? }]; returns { ok, selectors }.
 */
async function teach({ userDataDir, profileDir, url, steps }) {
  return withBrowser({ userDataDir, profileDir }, async (context) => {
    const page = await openPage(context, url);
    const selectors = {};
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Fields inside a repeating row are captured RELATIVE to that row so they
      // generalize across every row.
      const ancestor = step.relativeTo ? selectors[step.relativeTo] : null;
      const sel = await captureClick(page, step.label, ancestor, { index: i + 1, total: steps.length }, !!step.allowDefault);
      if (sel) selectors[step.key] = sel;
    }
    return { ok: true, selectors };
  });
}

/* The in-page picker: a big red banner + a highlight box ("⬆ click here") that
 * follows the cursor, so the user SEES what they're about to click. It is
 * re-installed on every page load, so the user can freely navigate Chrome to the
 * right page themselves and the overlay just follows them. On click it calls a
 * Node binding with a stable selector for the element. */
function pickerSource() {
  return (cfg) => {
    try {
      // Already showing for this exact step? Don't double-install.
      if (window.__psBinding === cfg.binding && document.getElementById('__ps_teach_banner')) return;
      window.__psBinding = cfg.binding;
      ['__ps_teach_banner', '__ps_teach_box', '__ps_teach_tag'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
      const root = document.documentElement;

      const banner = document.createElement('div'); banner.id = '__ps_teach_banner';
      banner.innerHTML = '<span style="font-size:20px;vertical-align:-2px">👉</span>  ' + cfg.stepText + 'Click: <b>' + cfg.label + '</b>';
      Object.assign(banner.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', background: '#d6231f', color: '#fff', font: '700 16px/1.45 -apple-system, system-ui, sans-serif', padding: '14px 18px', textAlign: 'center', boxShadow: '0 3px 14px rgba(0,0,0,.45)', pointerEvents: 'none' });
      root.appendChild(banner);

      const box = document.createElement('div'); box.id = '__ps_teach_box';
      Object.assign(box.style, { position: 'fixed', zIndex: '2147483646', border: '3px solid #d6231f', borderRadius: '6px', background: 'rgba(214,35,31,0.12)', boxShadow: '0 0 0 2px rgba(255,255,255,.7)', pointerEvents: 'none', display: 'none' });
      root.appendChild(box);

      const tag = document.createElement('div'); tag.id = '__ps_teach_tag'; tag.textContent = '⬆ click here';
      Object.assign(tag.style, { position: 'fixed', zIndex: '2147483647', background: '#d6231f', color: '#fff', font: '700 12px -apple-system, sans-serif', padding: '3px 8px', borderRadius: '5px', pointerEvents: 'none', display: 'none', whiteSpace: 'nowrap' });
      root.appendChild(tag);

      const ours = (el) => el === banner || el === box || el === tag;
      function onMove(e) {
        const el = e.target;
        if (!el || ours(el)) { box.style.display = tag.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) { box.style.display = tag.style.display = 'none'; return; }
        box.style.display = 'block'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
        tag.style.display = 'block'; tag.style.left = r.left + 'px'; tag.style.top = Math.max(0, r.top - 24) + 'px';
      }
      function nth(n) { const sibs = [...(n.parentElement ? n.parentElement.children : [])].filter((c) => c.tagName === n.tagName); return sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : ''; }
      function uniq(s, scope) { try { return (scope || document).querySelectorAll(s).length === 1; } catch { return false; } }
      function av(v) { return String(v).replace(/(["\\])/g, '\\$1'); }
      function sel(el, stop, scope) {
        const parts = []; let n = el;
        while (n && n.nodeType === 1 && n !== stop) {
          const id = n.id;
          if (id && !scope) { const s = /^-?[A-Za-z_][\w-]*$/.test(id) ? '#' + id : '[id="' + av(id) + '"]'; if (uniq(s)) { parts.unshift(s); return parts.join(' > '); } }
          const t = n.getAttribute && (n.getAttribute('data-testid') || n.getAttribute('data-test'));
          if (t) { const s = '[data-testid="' + av(t) + '"]'; if (uniq(s, scope)) { parts.unshift(s); return parts.join(' > '); } }
          let s = n.tagName.toLowerCase();
          const cls = (n.getAttribute('class') || '').split(/\s+/).find((c) => /^[a-zA-Z][\w-]{0,28}$/.test(c));
          if (cls) s += '.' + (window.CSS && CSS.escape ? CSS.escape(cls) : cls);
          s += nth(n); parts.unshift(s); n = n.parentElement;
        }
        return parts.join(' > ');
      }
      function onClick(e) {
        if (window.__psBinding !== cfg.binding) return; // a newer step owns the page now
        if (ours(e.target)) return;
        if (!cfg.allowDefault) { e.preventDefault(); e.stopPropagation(); }
        const stop = cfg.ancestorSelector ? e.target.closest(cfg.ancestorSelector) : null;
        const result = sel(e.target, stop, stop);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('mousemove', onMove, true);
        [banner, box, tag].forEach((x) => { try { x.remove(); } catch {} });
        try { if (window[cfg.binding]) window[cfg.binding](result); } catch {}
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
    } catch {}
  };
}

/**
 * Capture ONE click. Survives page navigation: the overlay is re-installed on
 * every load, so the user can navigate Chrome to the right page themselves.
 * `allowDefault` lets the click do its normal thing (e.g. open a patient / the
 * New-Appointment form) instead of being swallowed.
 */
async function captureClick(page, label, ancestorSelector = null, stepInfo = null, allowDefault = false) {
  const stepText = stepInfo ? `Step ${stepInfo.index} of ${stepInfo.total} — ` : '';
  const binding = '__psPick_' + (stepInfo ? stepInfo.index : 0) + '_' + Math.floor(Math.random() * 1e6);
  let resolveSel; let settled = false;
  const done = new Promise((r) => { resolveSel = r; });
  try { await page.exposeFunction(binding, (s) => { if (!settled) { settled = true; resolveSel(s || null); } }); } catch {}

  const cfg = { label, ancestorSelector, stepText, binding, allowDefault };
  const inject = `(${pickerSource().toString()})(${JSON.stringify(cfg)})`;
  const reinject = () => { page.evaluate(inject).catch(() => {}); };
  reinject();
  const onNav = (frame) => { if (frame === page.mainFrame()) setTimeout(reinject, 250); };
  page.on('framenavigated', onNav);
  page.on('load', reinject);
  page.on('domcontentloaded', reinject);

  const selector = await done;
  page.off('framenavigated', onNav);
  page.off('load', reinject);
  page.off('domcontentloaded', reinject);
  return selector || null;
}

module.exports = { pullVisits, createAppointmentLive, teach, defaultChromeUserDataDir };
