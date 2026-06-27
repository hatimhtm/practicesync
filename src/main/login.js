'use strict';

/*
 * Auto-login for the dedicated browser, with a hands-off pause for Practice
 * Fusion's phone 2FA. The app types the saved username + password; if Practice
 * Fusion shows its "security check" page, we put a banner in the window and WAIT
 * for the user to enter the code, then continue automatically once they're in.
 * SimplePractice has no 2FA, so it logs straight in.
 *
 * Selectors come from src/main/presets.js (captured + verified from the real
 * accounts). Everything is best-effort and logged via onStep.
 */

const presets = require('./presets');
const liveEngine = require('./liveEngine');

const say = (onStep, m) => { try { if (typeof onStep === 'function') onStep(m); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Type into a field the "watch it work" way: the visible cursor glides to the
 * field and the value is typed character by character (same stage the test drive
 * uses). Best-effort — if the visuals fail, the plain fill still happens. */
async function typeVisibly(page, sel, value, visual) {
  if (visual) { try { await liveEngine.ensureStage(page); await liveEngine.stage(page, 'moveTo', sel); } catch {} }
  try { await page.click(sel, { timeout: 8000 }).catch(() => {}); } catch {}
  try { await page.fill(sel, '').catch(() => {}); } catch {}
  try { await page.type(sel, String(value), { delay: visual ? 55 : 0 }); } catch {}
  if (visual) { try { await liveEngine.stage(page, 'press'); } catch {} }
}
async function clickVisibly(page, sel, visual) {
  if (visual) { try { await liveEngine.ensureStage(page); await liveEngine.stage(page, 'moveTo', sel); } catch {} }
  try { await page.click(sel, { timeout: 8000 }); } catch {}
  if (visual) { try { await liveEngine.stage(page, 'press'); } catch {} }
}

/* Close promo / upgrade overlays so a run is never blocked by a popup. */
async function dismissPopups(page) {
  let closed = 0;
  for (const sel of presets.POPUPS.closers) {
    try {
      const els = await page.$$(sel);
      for (const el of els) { if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 800 }).catch(() => {}); closed += 1; } }
    } catch {}
  }
  // A stray modal with no obvious close button → Escape.
  try {
    for (const c of presets.POPUPS.containers) {
      const el = await page.$(c);
      if (el && await el.isVisible().catch(() => false)) { await page.keyboard.press('Escape').catch(() => {}); break; }
    }
  } catch {}
  return closed;
}

/* Is a selector present + visible right now? */
async function visible(page, sel) {
  try { const el = await page.$(sel); return !!el && (await el.isVisible().catch(() => false)); } catch { return false; }
}

/* Banner shown in the controlled window while we wait for the user's 2FA code. */
function twoFactorBannerSource() {
  return () => {
    try {
      if (document.getElementById('__ps_2fa')) return;
      const b = document.createElement('div'); b.id = '__ps_2fa';
      b.innerHTML = '📲 <b>Enter the verification code Practice Fusion just sent you</b>, right here in this window. I’ll continue automatically once you’re in.';
      Object.assign(b.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', background: 'rgba(17,24,40,.97)', color: '#eaf0fb', font: '600 14px/1.45 -apple-system,system-ui,sans-serif', padding: '13px 18px', textAlign: 'center', boxShadow: '0 3px 14px rgba(0,0,0,.4)', pointerEvents: 'none' });
      document.documentElement.appendChild(b);
    } catch {}
  };
}
const removeBanner = (page) => page.evaluate(() => { const e = document.getElementById('__ps_2fa'); if (e) e.remove(); }).catch(() => {});

/**
 * Log in to Practice Fusion. Pauses (up to maxWaitMs) on the phone-2FA page.
 * Returns { ok } once the EHR is reached, or { ok:false, error }.
 */
async function loginPracticeFusion(page, creds, { onStep, maxWaitMs = 5 * 60 * 1000, visual = true } = {}) {
  const { PF } = presets;
  if (!creds || !creds.username || !creds.password) return { ok: false, error: 'Practice Fusion username/password not set.' };
  say(onStep, 'Opening Practice Fusion…');
  try { await page.goto(PF.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
  await dismissPopups(page);

  // Already signed in? (the dedicated profile may remember the session)
  if (/#\/PF\//.test(page.url())) { say(onStep, 'Already signed in to Practice Fusion.'); return { ok: true }; }

  // Fill + submit when the form is there — with the visible cursor.
  if (await visible(page, PF.login.username)) {
    say(onStep, 'Signing in to Practice Fusion…');
    if (visual) { try { await liveEngine.ensureStage(page); await liveEngine.stage(page, 'status', 'Signing in to Practice Fusion…'); } catch {} }
    try {
      await typeVisibly(page, PF.login.username, creds.username, visual);
      await typeVisibly(page, PF.login.password, creds.password, visual);
      await clickVisibly(page, PF.login.submit, visual);
    } catch (e) { return { ok: false, error: 'Could not fill the Practice Fusion login form.' }; }
  }

  // Wait for: the EHR (success), or the 2FA security-check page (pause).
  const deadline = Date.now() + maxWaitMs;
  let warned = false;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/#\/PF\//.test(url)) { await removeBanner(page); say(onStep, 'Signed in to Practice Fusion ✓'); return { ok: true }; }
    if (url.includes(PF.twoFactorUrlMatch)) {
      if (!warned) { say(onStep, 'Practice Fusion needs your phone code — enter it in the window.'); warned = true; }
      await page.evaluate(`(${twoFactorBannerSource().toString()})()`).catch(() => {});
    }
    await sleep(1000);
  }
  return { ok: false, error: 'Timed out waiting for Practice Fusion sign-in / verification.' };
}

/**
 * Log in to SimplePractice (no 2FA). Returns { ok } once the calendar is reached.
 */
async function loginSimplePractice(page, creds, { onStep, maxWaitMs = 90 * 1000, visual = true } = {}) {
  const { SP } = presets;
  if (!creds || !creds.email || !creds.password) return { ok: false, error: 'SimplePractice email/password not set.' };
  say(onStep, 'Opening SimplePractice…');
  try { await page.goto(SP.calendarUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
  await dismissPopups(page);

  if (/secure\.simplepractice\.com\/calendar/.test(page.url()) && !(await visible(page, SP.login.email))) {
    say(onStep, 'Already signed in to SimplePractice.'); return { ok: true };
  }
  if (await visible(page, SP.login.email)) {
    say(onStep, 'Signing in to SimplePractice…');
    if (visual) { try { await liveEngine.ensureStage(page); await liveEngine.stage(page, 'status', 'Signing in to SimplePractice…'); } catch {} }
    try {
      await typeVisibly(page, SP.login.email, creds.email, visual);
      await typeVisibly(page, SP.login.password, creds.password, visual);
      await clickVisibly(page, SP.login.submit, visual);
    } catch { return { ok: false, error: 'Could not fill the SimplePractice login form.' }; }
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (/secure\.simplepractice\.com\/calendar/.test(page.url())) { say(onStep, 'Signed in to SimplePractice ✓'); return { ok: true }; }
    await dismissPopups(page);
    await sleep(1000);
  }
  return { ok: false, error: 'Timed out waiting for SimplePractice sign-in.' };
}

module.exports = { loginPracticeFusion, loginSimplePractice, dismissPopups };
