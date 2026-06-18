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
const { execSync } = require('child_process');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is Google Chrome ACTUALLY running right now? (pgrep — not just a lock file,
 *  which can be stale after a crash and cause false "Chrome is open" errors.) */
function chromeIsRunning() {
  try { execSync('pgrep -x "Google Chrome"', { stdio: 'ignore' }); return true; } // exit 0 = a process matched
  catch (e) {
    // pgrep exits 1 ONLY when nothing matched → truly not running. Any other
    // failure (pgrep missing, permission) must NOT be read as "not running",
    // or we'd delete a live Chrome's lock files and corrupt its session.
    if (e && e.status === 1) return false;
    return true;
  }
}

/** Remove stale single-instance lock files left by a crashed Chrome. Safe to do
 *  only when Chrome is NOT running — these locks are the #1 cause of the new
 *  Playwright Chrome handing off to a dead session and getting stuck on about:blank. */
function clearStaleLocks(userDataDir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, f)); } catch {}
  }
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
  // If Chrome is genuinely running, a new launch just hands its URL to the open
  // window and exits → Playwright attaches to nothing → about:blank. So require
  // Chrome to be quit. Give a just-quit Chrome a few seconds to actually exit
  // (Cmd-Q isn't instant), then — only once it's really gone — clear any stale
  // lock files left by a previous crash.
  let running = chromeIsRunning();
  for (let i = 0; running && i < 8; i++) { await sleep(400); running = chromeIsRunning(); }
  if (running) {
    return fail('Google Chrome is open — please QUIT Chrome completely (Cmd-Q), then click again. PracticeSync borrows your signed-in Chrome, so it can’t run while Chrome is open.');
  }
  clearStaleLocks(userDataDir);

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
      // Suppress the "Chrome didn't shut down correctly / Restore pages?" bubble
      // that pops up after an unclean exit — it steals focus and confuses the user.
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--restore-last-session=false',
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
      cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))"><path d="M5 2.5l15.5 8.8-6.6 1.4 3.9 6.7-2.9 1.7-3.9-6.7L5 20.6z" fill="#fff" stroke="#3d7bff" stroke-width="1.5"/></svg><span id="__ps_lbl">PracticeSync</span>';
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
async function pullVisits({ userDataDir, profileDir, url, selectors, limit = 10, patientNames = [], onStep }) {
  if (!url || !selectors || !selectors.rowSelector) {
    return { ok: false, error: 'Practice Fusion isn\'t set up yet — use Teach Mode to show the app the patient page first.' };
  }
  const names = (patientNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  return withBrowser({ userDataDir, profileDir }, async (context) => {
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

    // Fallback: read the single patient page that's already open at `url`.
    await announce(page, onStep, 'Reading the visits…');
    try { await page.waitForSelector(selectors.rowSelector, { timeout: 15000 }); } catch {}
    const doc = new JSDOM(await page.content()).window.document;
    const visits = extractVisits(doc, selectors, limit);
    await stage(page, 'done', `Read ${visits.length} visit(s)`);
    return { ok: true, visits };
  });
}

/**
 * Create one appointment in SimplePractice via the taught form fields, then save.
 * (Used only when spMode === 'standard'; the 'enterprise' path uses the API.)
 */
async function createAppointmentLive({ userDataDir, profileDir, url, selectors, appointment, onStep }) {
  if (!url || !selectors || !selectors.saveButton) {
    return { ok: false, error: 'SimplePractice isn\'t set up yet — use Teach Mode to show the app the appointment form.' };
  }
  const who = appointment.patientName || 'the patient';
  return withBrowser({ userDataDir, profileDir }, async (context) => {
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
    // Every required field must actually fill — and we VERIFY each one took its
    // value (read it back) so we never save on a field that silently rejected
    // input. Abort before Save if anything required is missing.
    const required = ['doctor', 'date', 'codes', 'patient'];
    const filled = new Set();
    let extraCodeLines = 0;
    for (const f of planFormValues(selectors, appointment)) {
      const line = f.line || 0;
      // There is ONE taught code/units/modifier field, so only the first service
      // line can be entered. Never silently overwrite it with later codes —
      // count the extras and surface a warning instead of mis-booking.
      if (line > 0) { if (f.kind === 'codes') extraCodeLines += 1; continue; }
      try {
        const el = await page.$(f.selector);
        if (!el) continue;
        await announce(page, onStep, labelFor[f.kind] || 'Filling a field');
        await stage(page, 'moveTo', f.selector);
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          await page.selectOption(f.selector, { label: f.value }).catch(() => page.selectOption(f.selector, f.value));
          filled.add(f.kind); // a <select> doesn't expose a typed value to read back
        } else {
          await el.fill('');
          await el.type(String(f.value), { delay: 55 }); // visibly typed
          const got = String((await el.inputValue().catch(() => '')) || '').trim();
          const want = String(f.value).trim();
          if (got === want || (want && got.includes(want))) filled.add(f.kind); // verified it landed
        }
        await stage(page, 'press');
      } catch { /* field failed — handled by the required-check below */ }
    }
    const missing = required.filter((k) => !filled.has(k));
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
    if (extraCodeLines > 0) result.warning = `Entered the first code only — ${extraCodeLines} more code line(s) must be added by hand in SimplePractice.`;
    await stage(page, 'done', extraCodeLines ? `Booked ${who} — extra codes need manual entry` : `Booked ${who} ✓`);
    return result;
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
    // If the link didn't open on its own, prompt the user to type it and wait —
    // never start highlighting fields on a blank page.
    await waitForRealPage(page);
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

module.exports = { pullVisits, createAppointmentLive, teach, defaultChromeUserDataDir, openPage, normalizeUrl, isBlank, waitForRealPage, ensureStage, stage, announce };
