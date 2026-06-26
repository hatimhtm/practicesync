'use strict';

const path = require('path');
const fs = require('fs');
const {
  openAutomationContext, openPage, ensureStage, stage, announce,
} = require('./liveEngine');

/**
 * Workflow recorder. Opens the dedicated-profile Chrome and SILENTLY records
 * everything the user does across any sites (clicks, typed values, page
 * navigations) with a screenshot per click — without getting in the way. A small
 * "● Recording" badge + a ⌘⇧S hotkey let the user flag the moments that matter.
 *
 * The user does the real workflow once (e.g. open Practice Fusion → find a
 * patient → go to the calendar → create the appointment); afterwards they review
 * the captured timeline in the app and keep/delete/label the real steps. The
 * saved workflow can then be replayed with the visible cursor. Logins/cookies
 * persist because it's the same dedicated profile every time.
 */

let active = null; // the single in-progress recording

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/* The passive in-page recorder (serialized + injected on every page/frame). */
function recorderScript() {
  return () => {
    try {
      if (window.__psRecInstalled) { return; }
      window.__psRecInstalled = true;
      const nth = (n) => { const s = [...(n.parentElement ? n.parentElement.children : [])].filter((c) => c.tagName === n.tagName); return s.length > 1 ? ':nth-of-type(' + (s.indexOf(n) + 1) + ')' : ''; };
      const uniq = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
      const av = (v) => String(v).replace(/(["\\])/g, '\\$1');
      function sel(el) {
        const parts = []; let n = el;
        while (n && n.nodeType === 1) {
          const id = n.id;
          if (id) { const s = /^-?[A-Za-z_][\w-]*$/.test(id) ? '#' + id : '[id="' + av(id) + '"]'; if (uniq(s)) { parts.unshift(s); return parts.join(' > '); } }
          const t = n.getAttribute && (n.getAttribute('data-testid') || n.getAttribute('data-test'));
          if (t) { const s = '[data-testid="' + av(t) + '"]'; if (uniq(s)) { parts.unshift(s); return parts.join(' > '); } }
          let s = n.tagName.toLowerCase();
          const cls = (n.getAttribute('class') || '').split(/\s+/).find((c) => /^[a-zA-Z][\w-]{0,28}$/.test(c));
          if (cls) s += '.' + (window.CSS && CSS.escape ? CSS.escape(cls) : cls);
          s += nth(n); parts.unshift(s); n = n.parentElement;
        }
        return parts.join(' > ');
      }
      const label = (el) => {
        const a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'));
        return (a || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || el.tagName.toLowerCase());
      };
      const send = (ev) => { try { if (window.__psRecord) window.__psRecord(ev); } catch {} };

      // One input event per field (on commit) — NOT per keystroke, so typing
      // isn't recorded as a dozen "steps".
      document.addEventListener('change', (e) => { const el = e.target; if (!el || !('value' in el)) return; send({ type: 'input', selector: sel(el), label: label(el), value: String(el.value || '').slice(0, 200) }); }, true);
      document.addEventListener('click', (e) => { const el = e.target; if (!el || el.nodeType !== 1) return; send({ type: 'click', selector: sel(el), label: label(el) }); }, true);
      // ⌘⇧S / Ctrl⇧S — flag the action just taken as an important step.
      document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); send({ type: 'flag' }); } }, true);

      const addBadge = () => {
        if (document.getElementById('__ps_rec_badge') || !document.body) return;
        const b = document.createElement('div'); b.id = '__ps_rec_badge';
        b.innerHTML = '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#fff;margin-right:7px;vertical-align:-1px;animation:__psblink 1.1s infinite"></span>Recording — press ⌘⇧S to mark a step';
        Object.assign(b.style, { position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647', background: 'rgba(214,35,31,.96)', color: '#fff', font: '600 12px -apple-system,system-ui,sans-serif', padding: '8px 13px', borderRadius: '999px', boxShadow: '0 6px 18px rgba(0,0,0,.4)', pointerEvents: 'none' });
        const st = document.createElement('style'); st.textContent = '@keyframes __psblink{50%{opacity:.25}}';
        document.documentElement.appendChild(st);
        document.body.appendChild(b);
      };
      if (document.body) addBadge(); else document.addEventListener('DOMContentLoaded', addBadge);
    } catch {}
  };
}

async function handleEvent(page, ev) {
  if (!active) return;
  if (ev.type === 'flag') {
    const last = active.events[active.events.length - 1];
    if (last) last.flagged = true;
    try { if (active.onEvent) active.onEvent({ type: 'flag' }); } catch {}
    return;
  }
  const e = { ...ev, at: new Date().toISOString(), i: active.events.length };
  if (ev.type === 'click' && active.capturesDir) {
    active.clickN += 1;
    const name = `click-${String(active.clickN).padStart(3, '0')}.png`;
    try { await page.screenshot({ path: path.join(active.capturesDir, name) }); e.screenshot = name; } catch {}
  }
  active.events.push(e);
  try { if (active.onEvent) active.onEvent(e); } catch {}
}

function recordNav(page) {
  if (!active) return;
  const url = page.url();
  if (!url || url === 'about:blank') return;
  const last = active.events[active.events.length - 1];
  if (last && last.type === 'navigate' && last.url === url) return;
  const e = { type: 'navigate', url, at: new Date().toISOString(), i: active.events.length };
  active.events.push(e);
  try { if (active.onEvent) active.onEvent(e); } catch {}
}

async function startRecording({ onEvent, capturesDir, startUrl, userDataDir, profileDir, headless = false } = {}) {
  if (active) return { ok: false, error: 'A recording is already running.' };
  const { context, error } = await openAutomationContext({ userDataDir, profileDir, headless });
  if (error) return error;
  const page = context.pages()[0] || (await context.newPage());
  active = { context, page, events: [], capturesDir: capturesDir || null, onEvent, clickN: 0 };
  if (capturesDir) { try { fs.mkdirSync(capturesDir, { recursive: true }); } catch {} }

  try { await context.exposeBinding('__psRecord', async (source, ev) => { try { await handleEvent(source.page, ev); } catch {} }); } catch {}
  try { await context.addInitScript(`(${recorderScript().toString()})()`); } catch {}
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) recordNav(page); });

  try { if (startUrl) await openPage(context, startUrl); } catch {}
  try { await page.evaluate(`(${recorderScript().toString()})()`); } catch {} // current page (addInitScript covers future loads)
  return { ok: true, page }; // page returned for tests; main process ignores it
}

async function stopRecording() {
  if (!active) return { ok: false, error: 'Nothing is recording.' };
  const events = active.events.slice();
  const capturesDir = active.capturesDir;
  try { await active.context.close(); } catch {}
  active = null;
  return { ok: true, events, capturesDir };
}

function isRecording() { return !!active; }

/**
 * Replay kept steps with the visible cursor. `steps` = the curated workflow
 * ([{type:'navigate'|'click'|'input', url?, selector?, value?, label?}]).
 */
async function replayWorkflow({ steps = [], onStep, userDataDir, profileDir, headless = false } = {}) {
  const real = (steps || []).filter((s) => s && (s.type === 'navigate' ? s.url : s.selector));
  if (!real.length) return { ok: false, error: 'This workflow has no steps to replay.' };
  const { context, error } = await openAutomationContext({ userDataDir, profileDir, headless });
  if (error) return error;
  try {
    let page = context.pages()[0] || (await context.newPage());
    for (let i = 0; i < real.length; i++) {
      const s = real[i];
      if (s.type === 'navigate') { page = await openPage(context, s.url); await ensureStage(page); await announce(page, onStep, `Opening ${hostOf(s.url)}…`); continue; }
      await ensureStage(page);
      if (s.type === 'click') {
        await announce(page, onStep, `Clicking ${s.label || s.selector}`);
        await stage(page, 'moveTo', s.selector);
        try { await page.click(s.selector, { timeout: 8000 }); } catch {}
        await stage(page, 'press');
      } else if (s.type === 'input') {
        await announce(page, onStep, `Typing “${String(s.value || '').slice(0, 30)}” into ${s.label || 'a field'}`);
        await stage(page, 'moveTo', s.selector);
        try { await page.fill(s.selector, ''); await page.type(s.selector, String(s.value || ''), { delay: 45 }); } catch {}
        await stage(page, 'press');
      }
      await page.waitForTimeout(headless ? 100 : 500);
    }
    await stage(page, 'done', 'Replay complete ✓');
    if (onStep) try { onStep('Replay complete ✓'); } catch {}
    await page.waitForTimeout(headless ? 100 : 1800);
    return { ok: true, replayed: real.length };
  } catch (e) {
    return { ok: false, error: 'Replay hit a problem. Re-record the workflow and try again.', detail: String((e && e.message) || e) };
  } finally {
    try { await context.close(); } catch {}
  }
}

module.exports = { startRecording, stopRecording, isRecording, replayWorkflow, recorderScript };
