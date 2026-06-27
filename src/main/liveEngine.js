'use strict';

const os = require('os');
const path = require('path');
const { extractVisits, planFormValues, inferSchedule } = require('./extract');

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

/** Default macOS Chrome user-data dir (the user's real, logged-in profile). */
function defaultChromeUserDataDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/**
 * A DEDICATED Chrome profile that Hope Assistant drives. This is the key to the
 * "don't close my tabs" requirement: because it's a separate user-data-dir,
 * our automation Chrome runs ALONGSIDE the user's normal Chrome — they never
 * have to quit anything. The user signs into the target sites once in this
 * window and the persistent profile keeps them logged in for future runs.
 */
function automationUserDataDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Hope Assistant', 'chrome-automation');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remove single-instance lock files in OUR dedicated automation profile (left
 *  behind only if a previous Hope Assistant run crashed). Safe because nothing but
 *  Hope Assistant ever uses this profile. */
function clearStaleLocks(userDataDir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, f)); } catch {}
  }
}

function fail(error, detail) {
  return { ok: false, error, detail: detail ? String(detail).slice(0, 300) : undefined };
}

/**
 * Open the dedicated-profile Chrome and return its context (the caller owns
 * closing it). Shared by withBrowser (one-shot) and the recorder (long-lived).
 * Returns { context } on success or { error } (a friendly fail() object).
 */
async function openAutomationContext(opts = {}) {
  const { pw, err } = getPlaywright();
  if (!pw) return { error: fail('The automation component could not load in this build.', err) };
  if (!fs.existsSync(CHROME_APP)) {
    return { error: fail('Google Chrome isn’t installed. Please install Google Chrome, then try again.') };
  }
  // Drive our OWN dedicated profile (not the user's everyday Chrome), so the
  // user never has to quit their browser — the two run side by side. Clearing
  // stale locks here is always safe: this directory belongs to Hope Assistant.
  const userDataDir = opts.userDataDir || automationUserDataDir();
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}
  clearStaleLocks(userDataDir);

  // The update/background-networking flags keep Chrome from launching its own
  // updater (Keystone) — that updater modifies /Applications/Google Chrome.app,
  // which is what makes macOS pop the "App Management" permission prompt.
  const launchOpts = {
    headless: !!opts.headless, // visible by default ("watch it work"); headless for tests / future background mode
    viewport: null,
    args: [
      `--profile-directory=${opts.profileDir || 'Default'}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-networking',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--restore-last-session=false',
    ],
  };
  const launch = () => pw.chromium.launchPersistentContext(userDataDir, { channel: 'chrome', ...launchOpts })
    .catch(() => pw.chromium.launchPersistentContext(userDataDir, { executablePath: CHROME_BIN, ...launchOpts }));
  try {
    return { context: await launch() };
  } catch (e) {
    const s = String((e && e.message) || e);
    // The only thing that can lock OUR profile is a previous Hope Assistant window
    // that's still open (or crashed). Clear the lock and retry once.
    if (/ProcessSingleton|cannot create|in use|locked|SingletonLock/i.test(s)) {
      clearStaleLocks(userDataDir);
      try { return { context: await launch() }; }
      catch (e2) { return { error: fail('A Hope Assistant browser window is already open — close it and click again.', String((e2 && e2.message) || e2)) }; }
    }
    return { error: fail('Could not open Chrome. Make sure Google Chrome is installed, then try again.', s) };
  }
}

async function withBrowser(opts, fn) {
  const { context, error } = await openAutomationContext(opts);
  if (error) return error;
  try {
    return await fn(context);
  } catch (e) {
    return fail('Something went wrong while controlling the browser. Please try again.', String((e && e.message) || e));
  } finally {
    try { await context.close(); } catch {}
  }
}

/**
 * Navigate the VISIBLE window (the one the user sees) to the page and bring it
 * to the front — not a hidden background tab. Returns the page.
 */
/** Accept what a non-technical user pastes: add https:// if they left off the scheme. */
function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return 'https://' + s; // looks like a domain
  return s;
}

/** Is the page sitting on a blank / new-tab page (i.e. nothing really loaded)? */
function isBlank(page) {
  try { const u = page.url(); return !u || u === 'about:blank' || u.startsWith('chrome://new'); }
  catch { return false; }
}

/**
 * Open the URL in the VISIBLE controlled window and make sure it actually lands
 * there (the whole "type a link → it opens in the browser" expectation). We
 * retry, fall back to a direct location assignment, and verify we left
 * about:blank — instead of silently sitting on a blank page.
 */
async function openPage(context, url) {
  const target = normalizeUrl(url);
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  // Close any other restored tabs so there's a single, obvious window to look at.
  for (const p of pages.slice(1)) { try { await p.close(); } catch {} }
  try { await page.bringToFront(); } catch {}
  if (target) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
      catch {
        try { await page.evaluate((u) => { window.location.href = u; }, target); } catch {}
        try { await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch {}
      }
      if (!isBlank(page)) break; // we actually navigated somewhere real
    }
  }
  try { await page.bringToFront(); } catch {}
  return page;
}

/**
 * If the controlled browser is still on a blank page (auto-open didn't land —
 * e.g. no URL given, or a redirect bounced us), show a big prompt INSIDE that
 * browser telling the user to type the address and press Enter, and wait for
 * them to navigate. Returns true once a real page is loaded.
 */
async function waitForRealPage(page, maxSeconds = 240) {
  if (!isBlank(page)) return true;
  try {
    await page.evaluate(() => {
      if (document.getElementById('__ps_navhint')) return;
      const b = document.createElement('div');
      b.id = '__ps_navhint';
      b.innerHTML = '⌨️ Type your page address in the bar at the top and press <b>Enter</b> — then I’ll show you what to click.';
      Object.assign(b.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', background: '#d6231f', color: '#fff', font: '700 16px/1.45 -apple-system, system-ui, sans-serif', padding: '14px 18px', textAlign: 'center', boxShadow: '0 3px 14px rgba(0,0,0,.45)', pointerEvents: 'none' });
      (document.body || document.documentElement).appendChild(b);
    });
  } catch {}
  for (let i = 0; i < maxSeconds * 2 && isBlank(page); i++) { await sleep(500); }
  try { await page.evaluate(() => { const e = document.getElementById('__ps_navhint'); if (e) e.remove(); }); } catch {}
  return !isBlank(page);
}

/* ===================================================================== *
 *  THE STAGE — "watch the robot work"
 *  A visible cursor + status HUD + highlight + click ripples injected INTO
 *  the page, so the client (and his bosses) literally see the automation move,
 *  point, type and click. CDP mouse events don't render a visible pointer, so
 *  we draw our own and animate it to each element right before Playwright does
 *  the real action. Everything is best-effort and wrapped in try/catch — if the
 *  visuals ever fail, the real automation underneath still runs.
 * ===================================================================== */
const STAGE_V = 4; // bump to force the on-page stage to rebuild after an update

/** Self-contained in-page script (serialized + injected). Defines window.__psStage. */
function stageSource() {
  return (cfg) => {
    try {
      if (window.__psStage && window.__psStage._v === cfg.v) return true;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const root = document.documentElement;
      ['__ps_hud', '__ps_cursor', '__ps_hl', '__ps_style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });

      const st = document.createElement('style'); st.id = '__ps_style';
      st.textContent = '@keyframes __psPulse{0%{box-shadow:0 0 0 0 rgba(61,123,255,.6)}70%{box-shadow:0 0 0 10px rgba(61,123,255,0)}100%{box-shadow:0 0 0 0 rgba(61,123,255,0)}}@keyframes __psRip{from{opacity:.5;transform:translate(-50%,-50%) scale(.2)}to{opacity:0;transform:translate(-50%,-50%) scale(1)}}';
      root.appendChild(st);

      const hud = document.createElement('div'); hud.id = '__ps_hud';
      hud.innerHTML = '<span id="__ps_dot"></span><span style="font-size:15px">🤖</span><span id="__ps_txt">Starting…</span>';
      Object.assign(hud.style, { position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', display: 'flex', alignItems: 'center', gap: '9px', background: 'rgba(17,24,40,.96)', color: '#eaf0fb', font: '600 14px/1.3 -apple-system,system-ui,sans-serif', padding: '11px 18px', borderRadius: '999px', boxShadow: '0 10px 30px rgba(0,0,0,.5)', border: '1px solid rgba(122,160,255,.45)', pointerEvents: 'none', maxWidth: '86vw' });
      root.appendChild(hud);
      const dot = hud.querySelector('#__ps_dot');
      Object.assign(dot.style, { width: '9px', height: '9px', borderRadius: '50%', background: '#3d7bff', flex: '0 0 auto', animation: '__psPulse 1.2s infinite' });

      const cur = document.createElement('div'); cur.id = '__ps_cursor';
      cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))"><path d="M5 2.5l15.5 8.8-6.6 1.4 3.9 6.7-2.9 1.7-3.9-6.7L5 20.6z" fill="#fff" stroke="#3d7bff" stroke-width="1.5"/></svg><span id="__ps_lbl">Hope Assistant</span>';
      Object.assign(cur.style, { position: 'fixed', left: '50%', top: '42%', zIndex: '2147483646', pointerEvents: 'none', transition: 'left .6s cubic-bezier(.22,.61,.36,1), top .6s cubic-bezier(.22,.61,.36,1)', transformOrigin: 'top left' });
      const lbl = cur.querySelector('#__ps_lbl');
      Object.assign(lbl.style, { position: 'absolute', left: '24px', top: '22px', background: '#3d7bff', color: '#fff', font: '700 10px -apple-system,sans-serif', padding: '2px 7px', borderRadius: '6px', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,.35)' });
      root.appendChild(cur);

      const hl = document.createElement('div'); hl.id = '__ps_hl';
      Object.assign(hl.style, { position: 'fixed', zIndex: '2147483645', border: '3px solid #3d7bff', borderRadius: '8px', background: 'rgba(61,123,255,.12)', boxShadow: '0 0 0 2px rgba(255,255,255,.55)', pointerEvents: 'none', display: 'none', transition: 'all .25s ease' });
      root.appendChild(hl);

      let cx = innerWidth / 2; let cy = innerHeight * 0.42;
      window.__psStage = {
        _v: cfg.v,
        status(t) { try { document.getElementById('__ps_txt').textContent = t; } catch {} },
        async moveTo(sel) {
          const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
          if (!el) return false;
          try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch {}
          await wait(350);
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) return false;
          cx = r.left + Math.min(r.width / 2, 26); cy = r.top + r.height / 2;
          cur.style.left = cx + 'px'; cur.style.top = cy + 'px';
          hl.style.display = 'block'; hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px'; hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
          await wait(640);
          return true;
        },
        async press() {
          const rp = document.createElement('div');
          Object.assign(rp.style, { position: 'fixed', left: cx + 'px', top: cy + 'px', width: '46px', height: '46px', borderRadius: '50%', background: 'rgba(61,123,255,.5)', zIndex: '2147483645', pointerEvents: 'none', animation: '__psRip .5s ease-out forwards' });
          root.appendChild(rp);
          cur.style.transition = 'transform .1s'; cur.style.transform = 'scale(.82)';
          await wait(120);
          cur.style.transform = 'scale(1)'; cur.style.transition = 'left .6s cubic-bezier(.22,.61,.36,1), top .6s cubic-bezier(.22,.61,.36,1)';
          setTimeout(() => { try { rp.remove(); } catch {} }, 520);
          await wait(140);
        },
        done(msg) { this.status(msg || 'Done ✓'); try { const d = document.getElementById('__ps_dot'); d.style.animation = 'none'; d.style.background = '#34d399'; } catch {} hl.style.display = 'none'; },
        hide() { ['__ps_hud', '__ps_cursor', '__ps_hl', '__ps_style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); }); window.__psStage = null; },
      };
      return true;
    } catch { return false; }
  };
}

/** Inject (or refresh) the stage. Cheap + idempotent, so call it freely — it
 *  rebuilds automatically after a page navigation wipes it. */
async function ensureStage(page) {
  try { await page.evaluate(`(${stageSource().toString()})(${JSON.stringify({ v: STAGE_V })})`); } catch {}
}
/** Call a stage method in-page (awaits its animation). Always safe. */
async function stage(page, method, arg) {
  try { return await page.evaluate(({ m, a }) => { const s = window.__psStage; return s && s[m] ? s[m](a) : false; }, { m: method, a: arg }); }
  catch { return false; }
}
/** Update the on-screen status AND notify the app window, in one call. */
async function announce(page, onStep, text) {
  try { if (typeof onStep === 'function') onStep(text); } catch {}
  await ensureStage(page);
  await stage(page, 'status', text);
}

/**
 * Open one patient by NAME: go to the search page, type the name, and open the
 * first result — so the user never has to paste a per-patient URL. Returns true
 * if it landed on a patient timeline. Requires `selectors.searchBox` (taught).
 */
async function searchPatient(page, selectors, name, baseUrl, onStep) {
  try {
    // Start each search from a clean search page.
    if (baseUrl) { try { await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {} }
    await page.waitForSelector(selectors.searchBox, { timeout: 15000 });
    await announce(page, onStep, `Searching for ${name}…`);
    await stage(page, 'moveTo', selectors.searchBox);
    await page.click(selectors.searchBox);
    await stage(page, 'press');
    try { await page.fill(selectors.searchBox, ''); } catch {}
    await page.type(selectors.searchBox, String(name), { delay: 90 }); // visibly typed, character by character
    await page.waitForTimeout(1200); // let the results / dropdown populate
    if (selectors.firstResult) {
      try { await page.waitForSelector(selectors.firstResult, { timeout: 8000 }); } catch {}
      await announce(page, onStep, `Opening ${name}…`);
      await stage(page, 'moveTo', selectors.firstResult);
      await page.click(selectors.firstResult, { timeout: 8000 });
      await stage(page, 'press');
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
async function pullVisits({ userDataDir, profileDir, url, selectors, limit = 10, patientNames = [], date = '', onStep, headless = false }) {
  if (!url || !selectors || !selectors.rowSelector) {
    return { ok: false, error: 'Practice Fusion isn\'t set up yet — use Teach Mode to show the app the patient page first.' };
  }
  const names = (patientNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  return withBrowser({ userDataDir, profileDir, headless }, async (context) => {
    const page = await openPage(context, url);
    await announce(page, onStep, 'Opening Practice Fusion…');
    const { JSDOM } = require('jsdom');

    // Name-based path: search each patient and collect their visits.
    if (names.length && selectors.searchBox) {
      const all = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const found = await searchPatient(page, selectors, name, url, onStep);
        if (!found) { await announce(page, onStep, `Couldn't find ${name} in Practice Fusion`); all.push({ patientName: name, date: '', doctorName: '', notFound: true }); continue; }
        await announce(page, onStep, `Reading ${name}'s visits…`);
        const doc = new JSDOM(await page.content()).window.document;
        const visits = extractVisits(doc, selectors, limit);
        if (!visits.length) { all.push({ patientName: name, date: '', doctorName: '', noVisits: true }); continue; }
        if (onStep) { try { onStep(`Found ${visits.length} visit${visits.length === 1 ? '' : 's'} for ${name}`); } catch {} }
        // Make sure each visit carries the patient we searched for.
        all.push(...visits.map((v) => ({ ...v, patientName: v.patientName || name })));
      }
      await stage(page, 'done', `Read ${all.filter((v) => !v.notFound).length} visit(s)`);
      return { ok: true, visits: all };
    }

    // DAY-SCHEDULE path (the real flow): read every appointment on the open
    // schedule. If the appointments aren't visible yet, GUIDE the user to open
    // the Schedule for the date instead of silently reading nothing and stopping.
    await announce(page, onStep, `Looking for the day's appointments${date ? ' for ' + date : ''}…`);
    await ensureSchedule(page, selectors, onStep, date);
    const doc = new JSDOM(await page.content()).window.document;
    const visits = extractVisits(doc, selectors, limit);
    await stage(page, 'done', `Read ${visits.length} appointment(s)`);
    if (onStep) { try { onStep(`Read ${visits.length} appointment${visits.length === 1 ? '' : 's'} off the schedule`); } catch {} }
    return { ok: true, visits };
  });
}

/* In-browser guide shown when the day's appointments aren't visible yet, so the
 * run never just "gets confused and stops": a banner + a "Read this day" button.
 * Non-blocking (no page click handlers), re-injected across navigation. */
function scheduleGateSource() {
  return (cfg) => {
    try {
      if (document.getElementById('__ps_sched')) return;
      const ui = document.createElement('div'); ui.id = '__ps_sched';
      const bar = document.createElement('div');
      bar.innerHTML = '🗓️ <b>Open the Schedule' + (cfg.date ? ' for ' + cfg.date : '') + '</b> (under the Home icon) so the appointments are listed. I’ll read them automatically — or click <b>Read this day</b> when they’re showing.';
      Object.assign(bar.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483646', background: 'rgba(17,24,40,.97)', color: '#eaf0fb', font: '600 14px/1.45 -apple-system,system-ui,sans-serif', padding: '13px 18px', textAlign: 'center', boxShadow: '0 3px 14px rgba(0,0,0,.4)', pointerEvents: 'none' });
      ui.appendChild(bar);
      const wrap = document.createElement('div');
      Object.assign(wrap.style, { position: 'fixed', bottom: '22px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', pointerEvents: 'auto' });
      const btn = document.createElement('button');
      btn.textContent = 'Read this day ▶';
      Object.assign(btn.style, { font: '700 14px -apple-system,system-ui,sans-serif', border: '0', borderRadius: '12px', padding: '13px 22px', cursor: 'pointer', color: '#04240f', background: '#34d399', boxShadow: '0 10px 28px rgba(0,0,0,.45)' });
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { if (window[cfg.binding]) window[cfg.binding](); } catch {} }, true);
      wrap.appendChild(btn); ui.appendChild(wrap);
      document.documentElement.appendChild(ui);
    } catch {}
  };
}

/** Make sure the day's appointment rows are actually on screen before reading.
 *  Resolves true once rows appear (auto) or the user clicks "Read this day". */
async function ensureSchedule(page, selectors, onStep, date) {
  const countRows = async () => { try { return await page.evaluate((s) => document.querySelectorAll(s).length, selectors.rowSelector); } catch { return 0; } };
  try { await page.waitForSelector(selectors.rowSelector, { timeout: 8000 }); } catch {}
  if (await countRows() > 0) return true;

  // Not visible yet — guide, and wait for rows to appear OR an explicit click.
  await announce(page, onStep, `Open the Schedule${date ? ' for ' + date : ''} so I can read the appointments…`);
  const binding = '__psSched_' + Math.floor(Math.random() * 1e6);
  let resolve; let settled = false;
  const done = new Promise((r) => { resolve = r; });
  try { await page.exposeFunction(binding, () => { if (!settled) { settled = true; resolve('clicked'); } }); } catch {}
  const inject = `(${scheduleGateSource().toString()})(${JSON.stringify({ binding, date: date || '' })})`;
  const reinject = () => { page.evaluate(inject).catch(() => {}); };
  reinject();
  page.on('load', reinject); page.on('domcontentloaded', reinject);
  const poll = setInterval(async () => { if (!settled && (await countRows()) > 0) { settled = true; resolve('appeared'); } }, 1000);
  const to = setTimeout(() => { if (!settled) { settled = true; resolve('timeout'); } }, 180000);
  await done;
  clearInterval(poll); clearTimeout(to);
  page.off('load', reinject); page.off('domcontentloaded', reinject);
  try { await page.evaluate(() => { const e = document.getElementById('__ps_sched'); if (e) e.remove(); }); } catch {}
  return (await countRows()) > 0;
}

/**
 * Create one appointment in SimplePractice via the taught form fields, then save.
 * (Used only when spMode === 'standard'; the 'enterprise' path uses the API.)
 */
async function createAppointmentLive({ userDataDir, profileDir, url, selectors, appointment, onStep, headless = false }) {
  if (!url || !selectors || !selectors.saveButton) {
    return { ok: false, error: 'SimplePractice isn\'t set up yet — use Teach Mode to show the app the appointment form.' };
  }
  const who = appointment.patientName || 'the patient';
  return withBrowser({ userDataDir, profileDir, headless }, async (context) => {
    const page = await openPage(context, url);
    await announce(page, onStep, `Booking ${who} on ${appointment.date}…`);
    if (selectors.newApptButton) {
      await stage(page, 'moveTo', selectors.newApptButton);
      try { await page.click(selectors.newApptButton, { timeout: 10000 }); }
      catch { return { ok: false, error: 'Could not open the new-appointment form. Re-teach the SimplePractice screen.' }; }
      await stage(page, 'press');
      await page.waitForTimeout(500);
    }
    // Plain-English label for each field as the cursor lands on it.
    const labelFor = { patient: `Entering patient: ${who}`, doctor: `Selecting clinician: ${appointment.mainDoctor || ''}`, date: `Setting the date: ${appointment.date}`, codes: 'Adding the code', units: 'Setting the units', modifier: 'Adding the modifier' };

    // Fill one field and VERIFY it took its value (read it back), so we never
    // save on a field that silently rejected input. Returns true if it landed.
    const fillField = async (f) => {
      try {
        const el = await page.$(f.selector);
        if (!el) return false;
        await announce(page, onStep, labelFor[f.kind] || 'Filling a field');
        await stage(page, 'moveTo', f.selector);
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          await page.selectOption(f.selector, { label: f.value }).catch(() => page.selectOption(f.selector, f.value));
          await stage(page, 'press');
          return true; // a <select> doesn't expose a typed value to read back
        }
        await el.fill('');
        await el.type(String(f.value), { delay: 55 }); // visibly typed
        await stage(page, 'press');
        const got = String((await el.inputValue().catch(() => '')) || '').trim();
        const want = String(f.value).trim();
        return got === want || (want && got.includes(want));
      } catch { return false; }
    };

    const values = planFormValues(selectors, appointment);
    const filled = new Set();
    // Patient / clinician / date are entered once.
    for (const f of values.filter((v) => typeof v.line !== 'number')) {
      if (await fillField(f)) filled.add(f.kind);
    }

    // Every code is a SERVICE LINE. Line 0 uses the taught fields directly; each
    // additional line is created by clicking the taught "Add service" button
    // first, then re-filling those fields for the new row. If no add button was
    // taught, we enter the first line and flag the rest for manual entry rather
    // than mis-booking.
    const serviceVals = values.filter((v) => typeof v.line === 'number');
    const lineNos = [...new Set(serviceVals.map((v) => v.line))].sort((a, b) => a - b);
    let bookedLines = 0;
    let manualLines = 0;
    for (const li of lineNos) {
      if (li > 0) {
        if (!selectors.addServiceBtn) { manualLines += 1; continue; }
        try {
          await announce(page, onStep, `Adding service line ${li + 1}…`);
          await stage(page, 'moveTo', selectors.addServiceBtn);
          await page.click(selectors.addServiceBtn, { timeout: 8000 });
          await stage(page, 'press');
          await page.waitForTimeout(500);
        } catch { manualLines += 1; continue; }
      }
      const lineFields = serviceVals.filter((v) => v.line === li);
      const codeField = lineFields.find((v) => v.kind === 'codes');
      let codeOk = !codeField; // if no code on this line, nothing to verify
      for (const f of lineFields) {
        const ok = await fillField(f);
        if (f.kind === 'codes') codeOk = ok;
      }
      if (codeOk) bookedLines += 1; else manualLines += 1;
    }
    if (bookedLines > 0) filled.add('codes');

    // Require the essentials before saving.
    const missing = ['doctor', 'date', 'codes', 'patient'].filter((k) => !filled.has(k));
    if (missing.length) {
      await stage(page, 'done', `Stopped — couldn't fill ${missing.join(', ')}`);
      return { ok: false, error: `Didn't save — couldn't fill: ${missing.join(', ')}. Re-teach the SimplePractice screen.` };
    }
    await announce(page, onStep, 'Saving the appointment…');
    await stage(page, 'moveTo', selectors.saveButton);
    await page.click(selectors.saveButton, { timeout: 10000 });
    await stage(page, 'press');
    await page.waitForTimeout(900);
    const result = { ok: true };
    if (manualLines > 0) result.warning = `Entered ${bookedLines} service line(s); ${manualLines} more couldn't be added automatically — add them by hand in SimplePractice (teach the “Add service” button to automate this).`;
    await stage(page, 'done', manualLines ? `Booked ${who} — ${manualLines} line(s) need manual entry` : `Booked ${who} ✓`);
    return result;
  });
}

/**
 * Teach Mode: open a page and let the user point at the fields the app needs.
 *
 * One field at a time, the user CLICKS the element to select it (it highlights
 * green) and then presses a "Next step" button to move on — they're never rushed
 * by a click, and can re-click to fix a selection or press Back. Every click is
 * screenshotted into `capturesDir` (with a visual gallery) so you can see exactly
 * what was taught and diagnose anything that looks off.
 *
 * `steps` = [{ key, label, relativeTo?, allowDefault?, optional? }].
 * Returns { ok, selectors, capturesDir, captureCount }.
 */
async function teach({ userDataDir, profileDir, url, steps, headless = false, capturesDir = null, infer = null }) {
  return withBrowser({ userDataDir, profileDir, headless }, async (context) => {
    const page = await openPage(context, url);
    // If the link didn't open on its own, prompt the user to type it and wait —
    // never start highlighting fields on a blank page.
    await waitForRealPage(page);

    // FREE-ROAM phase: let the user sign in, enter a 2-factor code, and navigate
    // to the page they want WITHOUT the app intercepting their clicks. Field
    // teaching (which blocks clicks to "select") only begins once they say
    // they're ready. This is what lets them actually log in.
    await waitForReady(page);

    const manifest = [];
    if (capturesDir) { try { fs.mkdirSync(capturesDir, { recursive: true }); } catch {} }
    // Save a screenshot (+ the element's HTML) for every click during a step.
    const capture = async (stepIndex, clickN, selector) => {
      if (!capturesDir) return;
      const step = steps[stepIndex - 1] || {};
      const name = `step${String(stepIndex).padStart(2, '0')}-${String(step.key || 'field').replace(/[^\w-]/g, '')}-click${clickN}.png`;
      try { await page.screenshot({ path: path.join(capturesDir, name) }); } catch {}
      let html = '';
      try { html = await page.evaluate((s) => { try { const el = document.querySelector(s); return el ? el.outerHTML.slice(0, 300) : ''; } catch { return ''; } }, selector); } catch {}
      manifest.push({ step: stepIndex, key: step.key, label: step.label, click: clickN, selector, screenshot: name, html, at: new Date().toISOString() });
    };

    const selectors = {};
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      // Fields inside a repeating row are captured RELATIVE to that row so they
      // generalize across every row.
      const ancestor = step.relativeTo ? selectors[step.relativeTo] : null;
      const payload = await captureStep(page, step, { index: i + 1, total: steps.length, hasBack: i > 0 }, ancestor, capture);
      if (payload.action === 'back') { i = Math.max(0, i - 1); continue; }
      if (payload.action === 'skip') { delete selectors[step.key]; i += 1; continue; }
      if (payload.selector) selectors[step.key] = payload.selector;
      // Steps marked allowDefault actually perform their action now (open the
      // patient / the New-Appointment form) so the next field is on the new page.
      if (step.allowDefault && payload.selector) {
        try { await page.click(payload.selector, { timeout: 8000 }); } catch {}
        try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
        await page.waitForTimeout(700);
      }
      i += 1;
    }

    // SCHEDULE inference: the user pointed at one appointment's patient + date +
    // provider — derive the repeating row and rewrite those as row-relative, so
    // the app reads EVERY appointment on the day without the user ever pointing
    // at "a row". Falls back to the absolute selectors if it can't generalize.
    let inference = null;
    if (infer === 'schedule' && selectors.patientSelector && selectors.doctorSelector && !selectors.rowSelector) {
      try {
        const doc = new JSDOM(await page.content()).window.document;
        const got = inferSchedule(doc, selectors);
        if (got && got.rowSelector && got.matchedRows >= 1) {
          Object.assign(selectors, {
            rowSelector: got.rowSelector,
            patientSelector: got.patientSelector,
            doctorSelector: got.doctorSelector,
            ...(got.dateSelector ? { dateSelector: got.dateSelector } : {}),
          });
          inference = { ok: true, rows: got.rowCount, matched: got.matchedRows };
        } else {
          inference = { ok: false, reason: 'Could not see repeating appointments to generalize from.' };
        }
      } catch (e) { inference = { ok: false, reason: String((e && e.message) || e) }; }
    }

    if (capturesDir && manifest.length) { try { writeGallery(capturesDir, manifest); } catch {} }
    return { ok: true, selectors, capturesDir: capturesDir || null, captureCount: manifest.length, inference };
  });
}

/* The free-roam gate: a NON-blocking banner + a "Start teaching" button. It adds
 * NO click handlers to the page, so the user can sign in, type a 2-factor code,
 * click "Send code", and navigate completely normally. Re-installed on every
 * page load. When the user clicks "Start teaching", it resolves. */
function readyGateSource() {
  return (cfg) => {
    try {
      if (window.__psGate === cfg.binding && document.getElementById('__ps_gate')) return;
      window.__psGate = cfg.binding;
      const old = document.getElementById('__ps_gate'); if (old) old.remove();
      const ui = document.createElement('div'); ui.id = '__ps_gate';

      const bar = document.createElement('div');
      bar.innerHTML = '<span style="font-size:17px;vertical-align:-2px">👋</span> <b>First, sign in and open the page you want to teach.</b> Do anything you need — log in, enter a verification code, navigate. Nothing here is saved.';
      Object.assign(bar.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483646', background: 'rgba(17,24,40,.97)', color: '#eaf0fb', font: '600 14px/1.45 -apple-system,system-ui,sans-serif', padding: '13px 18px', textAlign: 'center', boxShadow: '0 3px 14px rgba(0,0,0,.4)', pointerEvents: 'none' });
      ui.appendChild(bar);

      const wrap = document.createElement('div');
      Object.assign(wrap.style, { position: 'fixed', bottom: '22px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', pointerEvents: 'auto' });
      const btn = document.createElement('button');
      btn.textContent = "I'm on the right page — Start teaching ▶";
      Object.assign(btn.style, { font: '700 14px -apple-system,system-ui,sans-serif', border: '0', borderRadius: '12px', padding: '13px 22px', cursor: 'pointer', color: '#04240f', background: '#34d399', boxShadow: '0 10px 28px rgba(0,0,0,.45)' });
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { if (window[cfg.binding]) window[cfg.binding](); } catch {} }, true);
      wrap.appendChild(btn); ui.appendChild(wrap);

      document.documentElement.appendChild(ui);
    } catch {}
  };
}

/** Wait (non-blocking) until the user has signed in / navigated and clicks
 *  "Start teaching". Survives page navigation. */
async function waitForReady(page) {
  const binding = '__psGate_' + Math.floor(Math.random() * 1e6);
  let resolve; let settled = false;
  const done = new Promise((r) => { resolve = r; });
  try { await page.exposeFunction(binding, () => { if (!settled) { settled = true; resolve(); } }); } catch {}
  const inject = `(${readyGateSource().toString()})(${JSON.stringify({ binding })})`;
  const reinject = () => { page.evaluate(inject).catch(() => {}); };
  reinject();
  const onNav = (frame) => { if (frame === page.mainFrame()) setTimeout(reinject, 300); };
  page.on('framenavigated', onNav);
  page.on('load', reinject);
  page.on('domcontentloaded', reinject);
  await done;
  page.off('framenavigated', onNav);
  page.off('load', reinject);
  page.off('domcontentloaded', reinject);
  try { await page.evaluate(() => { const e = document.getElementById('__ps_gate'); if (e) e.remove(); window.__psGate = null; }); } catch {}
}

/* The in-page teach overlay — TWO MODES, so navigating and selecting never fight.
 *
 *  • NAVIGATE (default): every click passes straight through. The user signs in,
 *    opens menus, browses to the client section, types a name so results appear —
 *    nothing is intercepted.
 *  • PICK (one click): the user presses "Point at a field", then clicks the
 *    element. That single click is captured AND suppressed (preventDefault), so
 *    even a link or button is marked WITHOUT navigating or submitting. We record
 *    exactly the element they clicked — no hover-travel guessing — then return to
 *    navigate mode.
 *
 *  Back / Skip / Next manage the short list of things the app needs pointed out.
 *  Re-installed on every page load, so it follows the user wherever they go. */
function pickerSource() {
  return (cfg) => {
    try {
      if (window.__psTeachBinding === cfg.binding && document.getElementById('__ps_teach_ui')) return;
      window.__psTeachBinding = cfg.binding;
      const stale = document.getElementById('__ps_teach_ui'); if (stale) stale.remove();
      const root = document.documentElement;
      const ui = document.createElement('div'); ui.id = '__ps_teach_ui';

      const navMsg = 'Browse to the screen you need — <b>clicking works normally</b>. When the field below is on screen, press <b>🎯 Point at a field</b>.';
      const pickMsg = '<b>Now click the field on the page</b> — just one click. (Press <b>Esc</b> to cancel.)';

      // top status pill
      const top = document.createElement('div');
      Object.assign(top.style, { position: 'fixed', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', background: 'rgba(17,24,40,.97)', color: '#eaf0fb', font: '600 14px/1.4 -apple-system,system-ui,sans-serif', padding: '12px 20px', borderRadius: '14px', boxShadow: '0 12px 34px rgba(0,0,0,.5)', border: '1px solid rgba(122,160,255,.45)', pointerEvents: 'none', maxWidth: '92vw', textAlign: 'center' });
      let dots = '';
      for (let d = 0; d < cfg.total; d++) { const col = d < cfg.index - 1 ? '#34d399' : (d === cfg.index - 1 ? '#3d7bff' : 'rgba(255,255,255,.25)'); dots += '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin:0 2px;vertical-align:middle;background:' + col + '"></span>'; }
      top.innerHTML = '<div style="font-size:11px;letter-spacing:.5px;color:#9fb3da;margin-bottom:6px">POINT OUT ' + cfg.index + ' OF ' + cfg.total + '&nbsp;&nbsp;' + dots + '</div>'
        + '<div style="font-size:15px;font-weight:700">' + cfg.label + '</div>'
        + (cfg.hint ? '<div style="font-size:12px;color:#cdd9f2;margin-top:5px">' + cfg.hint + '</div>' : '')
        + '<div id="__ps_teach_status" style="font-size:12px;color:#9fb3da;margin-top:6px">' + navMsg + '</div>';
      ui.appendChild(top);

      // hover (only while picking) + marked outlines
      const hover = document.createElement('div');
      Object.assign(hover.style, { position: 'fixed', zIndex: '2147483645', border: '2px dashed #3d7bff', borderRadius: '7px', background: 'rgba(61,123,255,.10)', pointerEvents: 'none', display: 'none' });
      ui.appendChild(hover);
      const pick = document.createElement('div');
      Object.assign(pick.style, { position: 'fixed', zIndex: '2147483645', border: '3px solid #34d399', borderRadius: '7px', background: 'rgba(52,211,153,.16)', boxShadow: '0 0 0 2px rgba(255,255,255,.5)', pointerEvents: 'none', display: 'none' });
      const pickTag = document.createElement('div'); pickTag.textContent = '✓ marked';
      Object.assign(pickTag.style, { position: 'absolute', top: '-22px', left: '0', background: '#34d399', color: '#04240f', font: '700 11px -apple-system,sans-serif', padding: '2px 7px', borderRadius: '5px', whiteSpace: 'nowrap' });
      pick.appendChild(pickTag); ui.appendChild(pick);

      // control bar
      const bar = document.createElement('div');
      Object.assign(bar.style, { position: 'fixed', bottom: '22px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', display: 'flex', gap: '10px', alignItems: 'center', background: 'rgba(17,24,40,.97)', padding: '10px 12px', borderRadius: '14px', boxShadow: '0 12px 34px rgba(0,0,0,.5)', border: '1px solid rgba(122,160,255,.35)', pointerEvents: 'auto' });
      const mkBtn = (txt, primary, disabled) => {
        const b = document.createElement('button'); b.textContent = txt;
        Object.assign(b.style, { font: '600 13px -apple-system,system-ui,sans-serif', border: '0', borderRadius: '9px', padding: '9px 16px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? '.45' : '1', color: primary ? '#fff' : '#dbe6ff', background: primary ? '#3d7bff' : 'rgba(255,255,255,.08)' });
        b.disabled = !!disabled; return b;
      };
      const backBtn = mkBtn('◀ Back', false, !cfg.hasBack);
      const skipBtn = cfg.optional ? mkBtn('Skip this', false, false) : null;
      const pickBtn = mkBtn('🎯 Point at a field', false, false);
      Object.assign(pickBtn.style, { background: '#f0a93d', color: '#241300', fontWeight: '700' });
      const nextBtn = mkBtn(cfg.index === cfg.total ? '✓ Finish' : 'Next ▶', true, true);
      bar.appendChild(backBtn); if (skipBtn) bar.appendChild(skipBtn); bar.appendChild(pickBtn); bar.appendChild(nextBtn);
      ui.appendChild(bar);
      root.appendChild(ui);

      // selector builders
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

      const ourEls = [top, hover, pick, pickTag, bar, backBtn, pickBtn, nextBtn]; if (skipBtn) ourEls.push(skipBtn);
      const ours = (el) => el && (ourEls.indexOf(el) >= 0 || ui.contains(el));
      let selectedEl = null; let selectedSel = ''; let picking = false;
      function drawPick() { if (!selectedEl) { pick.style.display = 'none'; return; } const r = selectedEl.getBoundingClientRect(); pick.style.display = 'block'; pick.style.left = r.left + 'px'; pick.style.top = r.top + 'px'; pick.style.width = r.width + 'px'; pick.style.height = r.height + 'px'; }
      function setStatus(t) { const s = document.getElementById('__ps_teach_status'); if (s) s.innerHTML = t; }

      // Toggle PICK mode. While armed, the cursor is a crosshair and the very next
      // page click is captured-and-suppressed (so links/buttons don't fire).
      function setPicking(on) {
        picking = on;
        pickBtn.textContent = on ? '✕ Cancel' : '🎯 Point at a field';
        Object.assign(pickBtn.style, on ? { background: 'rgba(255,255,255,.10)', color: '#dbe6ff', fontWeight: '600' } : { background: '#f0a93d', color: '#241300', fontWeight: '700' });
        try { root.style.cursor = on ? 'crosshair' : ''; } catch {}
        if (!on) hover.style.display = 'none';
        setStatus(on ? pickMsg : (selectedSel ? 'Marked ✓ — press <b>Next</b>, or <b>Point at a field</b> again to change it.' : navMsg));
      }

      function onMove(e) {
        if (!picking) { hover.style.display = 'none'; return; } // navigate mode → no highlight, no distraction
        const el = e.target;
        if (!el || ours(el)) { hover.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) { hover.style.display = 'none'; return; }
        hover.style.display = 'block'; hover.style.left = r.left + 'px'; hover.style.top = r.top + 'px'; hover.style.width = r.width + 'px'; hover.style.height = r.height + 'px';
      }

      // The ONE intercepted click: mark exactly what the user clicked, suppress its
      // default (no navigation/submit), capture a stable selector, exit pick mode.
      function onClick(e) {
        if (!picking) return;              // navigate mode → let the click through
        const el = e.target;
        if (!el || ours(el)) return;       // our own buttons handle themselves
        e.preventDefault(); e.stopPropagation();
        const stop = cfg.ancestorSelector ? el.closest(cfg.ancestorSelector) : null;
        selectedEl = el; selectedSel = sel(el, stop, stop);
        hover.style.display = 'none';
        drawPick();
        nextBtn.disabled = false; nextBtn.style.opacity = '1'; nextBtn.style.cursor = 'pointer';
        setPicking(false);
        try { if (window[cfg.shotBinding]) window[cfg.shotBinding](selectedSel); } catch {}
      }

      function finish(action) {
        try { root.style.cursor = ''; } catch {}
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', drawPick, true);
        window.removeEventListener('resize', drawPick);
        try { ui.remove(); } catch {}
        try { if (window[cfg.binding]) window[cfg.binding](action); } catch {}
      }
      function onKey(e) {
        if (e.key === 'Escape') { if (picking) { e.preventDefault(); setPicking(false); return; } if (cfg.optional) { e.preventDefault(); finish({ action: 'skip' }); } }
      }
      pickBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setPicking(!picking); });
      backBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (cfg.hasBack) finish({ action: 'back' }); });
      if (skipBtn) skipBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finish({ action: 'skip' }); });
      nextBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!nextBtn.disabled) finish({ action: 'next', selector: selectedSel }); });
      // Capture-phase listeners: we see the click FIRST, so in pick mode we can
      // suppress a link/button before it navigates; in navigate mode we do nothing.
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', drawPick, true);
      window.addEventListener('resize', drawPick);
    } catch {}
  };
}

/**
 * Drive ONE teach step: inject the overlay, screenshot each click, and resolve
 * when the user presses Back / Skip / Next. Survives navigation (re-injects).
 * Returns { action:'next'|'back'|'skip', selector? }.
 */
async function captureStep(page, step, stepInfo, ancestorSelector, capture) {
  const rnd = Math.floor(Math.random() * 1e6);
  const binding = '__psStep_' + stepInfo.index + '_' + rnd;
  const shotBinding = '__psShot_' + stepInfo.index + '_' + rnd;
  let resolveStep; let settled = false;
  const done = new Promise((r) => { resolveStep = r; });
  try { await page.exposeFunction(binding, (payload) => { if (!settled) { settled = true; resolveStep(payload && payload.action ? payload : { action: 'skip' }); } }); } catch {}
  let clickN = 0;
  try { await page.exposeFunction(shotBinding, async (selector) => { clickN += 1; try { await capture(stepInfo.index, clickN, selector); } catch {} }); } catch {}

  const cfg = { label: step.label, hint: step.hint || null, ancestorSelector: ancestorSelector || null, binding, shotBinding, index: stepInfo.index, total: stepInfo.total, optional: !!step.optional, hasBack: !!stepInfo.hasBack };
  const inject = `(${pickerSource().toString()})(${JSON.stringify(cfg)})`;
  const reinject = () => { page.evaluate(inject).catch(() => {}); };
  reinject();
  const onNav = (frame) => { if (frame === page.mainFrame()) setTimeout(reinject, 250); };
  page.on('framenavigated', onNav);
  page.on('load', reinject);
  page.on('domcontentloaded', reinject);

  const payload = await done;
  page.off('framenavigated', onNav);
  page.off('load', reinject);
  page.off('domcontentloaded', reinject);
  return payload;
}

function escapeHtmlNode(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Write a tiny self-contained gallery (index.html + captures.json) so opening
 *  the folder shows every taught click as a labelled screenshot. */
function writeGallery(dir, manifest) {
  try { fs.writeFileSync(path.join(dir, 'captures.json'), JSON.stringify(manifest, null, 2)); } catch {}
  const cards = manifest.map((m) => `
    <div class="card">
      <div class="cap"><b>Step ${m.step}</b> — ${escapeHtmlNode(m.label)}<div class="sel">${escapeHtmlNode(m.selector || '')}</div></div>
      <img src="${escapeHtmlNode(m.screenshot)}" alt="" />
    </div>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Hope Assistant — teach captures</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;background:#0f1422;color:#eaf0fb;margin:0;padding:26px}
h1{font-size:18px;margin:0 0 4px} p.sub{color:#9fb3da;margin:0 0 22px;font-size:13px}
.card{background:#1a2336;border:1px solid #2a3650;border-radius:12px;padding:14px;margin:0 0 16px}
.cap{margin-bottom:10px} .sel{color:#9fb3da;font:12px ui-monospace,Menlo,monospace;margin-top:4px;word-break:break-all}
img{max-width:100%;border-radius:8px;border:1px solid #2a3650;display:block}</style>
<h1>What you taught Hope Assistant</h1><p class="sub">${manifest.length} screenshot(s) — one per click. Each card shows the field, the element the app will use, and what the screen looked like.</p>${cards}`;
  try { fs.writeFileSync(path.join(dir, 'index.html'), html); } catch {}
}

/**
 * "Test drive" demo: read rows from ANY real page (a table, or a bulleted list
 * as fallback) and type each one — with the visible cursor — into the bundled
 * DataDesk sheet at `destUrl`. Same engine and stage as the real sync, so it's a
 * faithful "watch it work" demonstration on a site anyone can see.
 */
async function runSiteDemo({ userDataDir, profileDir, sourceUrl, destUrl, rows = 6, onStep, headless = false }) {
  const url = normalizeUrl(sourceUrl);
  if (!url) return { ok: false, error: 'Enter a page address first.' };
  let host = 'the page';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  return withBrowser({ userDataDir, profileDir, headless }, async (context) => {
    const page = await openPage(context, url);
    await ensureStage(page);
    await announce(page, onStep, `Reading data from ${host}…`);
    try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch {}
    await page.waitForTimeout(800);

    // Read the first table's rows (first two text cells each); fall back to the
    // first bulleted list. Pure in-page extraction, works on most pages.
    const data = await page.evaluate((limit) => {
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
        for (const li of [...document.querySelectorAll('.mw-parser-output ul li, ul li')].slice(0, limit)) {
          const t = clean(li.textContent); if (t) out.push({ a: t.slice(0, 60), b: '' });
        }
      }
      return out;
    }, rows);

    if (!data.length) {
      await stage(page, 'done', "Couldn't find a table or list to read");
      return { ok: false, error: "Couldn't find a table or list on that page. Try a Wikipedia article with a table." };
    }
    await stage(page, 'done', `Read ${data.length} row(s)`);
    if (onStep) try { onStep(`Read ${data.length} rows from ${host}`); } catch {}

    // Type each row into the bundled sheet, with the visible cursor.
    await page.goto(destUrl, { waitUntil: 'domcontentloaded' });
    await ensureStage(page);
    const typeInto = async (sel, val) => {
      if (!val) return;
      await stage(page, 'moveTo', sel);
      await page.click(sel).catch(() => {});
      await page.fill(sel, '').catch(() => {});
      await page.type(sel, String(val), { delay: 45 });
      await stage(page, 'press');
    };
    for (let i = 0; i < data.length; i++) {
      await announce(page, onStep, `Copying row ${i + 1} of ${data.length}: ${data[i].a}…`);
      await typeInto('#cellA', data[i].a);
      await typeInto('#cellB', data[i].b);
      await stage(page, 'moveTo', '#addRow');
      await page.click('#addRow').catch(() => {});
      await stage(page, 'press');
      await page.waitForTimeout(450);
    }
    await stage(page, 'done', `Copied ${data.length} row(s) ✓`);
    if (onStep) try { onStep(`Done — copied ${data.length} rows into the sheet ✓`); } catch {}
    await page.waitForTimeout(2800); // hold the finished state so it's visible before the window closes
    return { ok: true, read: data.length, copied: data.length };
  });
}

module.exports = { pullVisits, createAppointmentLive, teach, runSiteDemo, defaultChromeUserDataDir, automationUserDataDir, openAutomationContext, openPage, normalizeUrl, isBlank, waitForRealPage, ensureStage, stage, announce, pickerSource, readyGateSource };
