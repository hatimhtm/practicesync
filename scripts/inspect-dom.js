'use strict';

/*
 * DOM INSPECTOR — capture the REAL Practice Fusion / SimplePractice page
 * structure so we can build verified selectors instead of guessing.
 *
 *   npm run inspect                 # opens to a blank page; type the URL yourself
 *   npm run inspect <start-url>     # opens straight to that page
 *
 * It opens the SAME dedicated Chrome window the app uses (so logging in here
 * also logs the app in). A floating "Inspector" panel (bottom-left) reacts to
 * every action:
 *
 *   • type a label, click 📸 Whole page   → saves the full page + screenshot,
 *     flashes "Saved", and adds it to the on-screen list.
 *   • click any element on the page        → the panel shows what you clicked.
 *   • click 📍 Last-clicked element        → saves just that element.
 *
 * Everything goes to ./inspect-output/ (git-ignored). The demo data is fake, so
 * the HTML is safe to send back. Press Ctrl-C here when done.
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

// Returns { ok, name } so the in-page panel can show real confirmation.
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
    return { ok: true, name: base };
  } catch (e) {
    n -= 1;
    console.log('  ✖ capture failed:', (e && e.message) || e);
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* Injected into every page (and re-checked for SPA route changes). Reactive:
 * shows what you clicked, a Saving→Saved state, a flash toast, and a running
 * list of saved captures. State persists across SPA re-renders via sessionStorage. */
function panelSource() {
  if (window.top !== window) return; // top frame only
  let lastClicked = null;

  const isOurs = (el) => el && el.closest && el.closest('#__inspect_ui');
  const desc = (el) => {
    if (!el || !el.tagName) return '(nothing yet)';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else { const c = (el.getAttribute('class') || '').trim().split(/\s+/)[0]; if (c) s += '.' + c; }
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return s + (t ? ' “' + t + '”' : '');
  };

  // Click anywhere on the page → remember it + show it (and briefly outline it).
  document.addEventListener('click', (e) => {
    if (isOurs(e.target)) return;
    lastClicked = e.target;
    const tgt = document.getElementById('__ins_target'); if (tgt) tgt.textContent = '📍 ' + desc(lastClicked);
    try {
      const o = e.target.style.outline; e.target.style.outline = '2px solid #7aa0ff';
      setTimeout(() => { try { e.target.style.outline = o; } catch {} }, 600);
    } catch {}
  }, true);

  const loadLog = () => { try { return JSON.parse(sessionStorage.getItem('__inspectLog') || '[]'); } catch { return []; } };
  const saveLog = (a) => { try { sessionStorage.setItem('__inspectLog', JSON.stringify(a.slice(-40))); } catch {} };

  const build = () => {
    if (document.getElementById('__inspect_ui')) { renderList(); return; }
    const ui = document.createElement('div'); ui.id = '__inspect_ui';
    Object.assign(ui.style, { position: 'fixed', bottom: '14px', left: '14px', zIndex: '2147483647', width: '250px', background: 'rgba(15,20,34,.98)', color: '#eaf0fb', font: '600 12px/1.45 -apple-system,system-ui,sans-serif', padding: '12px', borderRadius: '14px', boxShadow: '0 14px 40px rgba(0,0,0,.55)', border: '1px solid rgba(122,160,255,.5)' });

    const head = document.createElement('div');
    head.innerHTML = '🔎 <b>Inspector</b> · <span id="__ins_count">0</span> saved';
    head.style.marginBottom = '8px';

    const inp = document.createElement('input'); inp.id = '__ins_label'; inp.placeholder = 'label (e.g. pf-row)';
    Object.assign(inp.style, { width: '100%', padding: '7px 9px', borderRadius: '9px', border: '1px solid rgba(255,255,255,.22)', background: 'rgba(255,255,255,.07)', color: '#eaf0fb', font: '12px -apple-system,sans-serif', boxSizing: 'border-box' });

    const mk = (txt, bg, fg) => { const b = document.createElement('button'); b.textContent = txt; Object.assign(b.style, { display: 'block', width: '100%', margin: '8px 0 0', font: '700 12px -apple-system,system-ui,sans-serif', border: '0', borderRadius: '9px', padding: '9px 10px', cursor: 'pointer', color: fg, background: bg }); return b; };
    const bPage = mk('📸 Whole page', '#34d399', '#04240f');
    const bEl = mk('📍 Last-clicked element', '#7aa0ff', '#04122e');

    const target = document.createElement('div'); target.id = '__ins_target';
    Object.assign(target.style, { marginTop: '9px', padding: '6px 8px', borderRadius: '8px', background: 'rgba(255,255,255,.05)', color: '#9fb3da', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    target.textContent = '📍 (click an element to target it)';

    const list = document.createElement('div'); list.id = '__ins_list';
    Object.assign(list.style, { marginTop: '9px', maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' });

    ui.appendChild(head); ui.appendChild(inp); ui.appendChild(bPage); ui.appendChild(bEl); ui.appendChild(target); ui.appendChild(list);
    (document.body || document.documentElement).appendChild(ui);

    const flash = (msg, bad) => {
      let t = document.getElementById('__ins_toast');
      if (!t) { t = document.createElement('div'); t.id = '__ins_toast'; Object.assign(t.style, { position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '11px 18px', borderRadius: '12px', font: '700 14px -apple-system,system-ui,sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.5)', transition: 'opacity .25s', pointerEvents: 'none' }); document.documentElement.appendChild(t); }
      t.style.background = bad ? '#e0524d' : '#34d399'; t.style.color = bad ? '#fff' : '#04240f';
      t.textContent = msg; t.style.opacity = '1';
      clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, 1700);
    };

    const doCapture = async (kind, btn) => {
      const label = inp.value.trim();
      let element = '';
      if (kind === 'element') {
        if (!lastClicked) { flash('Click an element on the page first', true); return; }
        try { element = (lastClicked.parentElement || lastClicked).outerHTML.slice(0, 14000); } catch {}
      }
      const old = btn.textContent; btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = 'Saving…';
      let res;
      try { res = await window.__inspectCapture({ label, element, kind }); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
      btn.disabled = false; btn.style.opacity = '1'; btn.textContent = old;
      if (res && res.ok) {
        const log = loadLog(); log.push({ name: res.name, kind }); saveLog(log);
        renderList(); flash('✔ Saved ' + res.name);
        inp.value = ''; inp.focus();
      } else { flash('✖ ' + ((res && res.error) || 'capture failed'), true); }
    };
    bPage.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); doCapture('page', bPage); });
    bEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); doCapture('element', bEl); });
    renderList();
  };

  function renderList() {
    const list = document.getElementById('__ins_list'); const count = document.getElementById('__ins_count');
    if (!list) return;
    const log = loadLog();
    if (count) count.textContent = String(log.length);
    list.innerHTML = '';
    log.slice().reverse().forEach((it) => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 7px', borderRadius: '7px', background: 'rgba(52,211,153,.14)', color: '#bff3da', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      row.textContent = (it.kind === 'element' ? '📍 ' : '📸 ') + it.name;
      list.appendChild(row);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  setInterval(build, 1200); // survive SPA re-renders that wipe the panel
}

(async () => {
  const startUrl = process.argv[2] || '';
  const { context, error } = await live.openAutomationContext({ headless: false });
  if (error) { console.error('Could not open Chrome:', error.error || error); process.exit(1); }

  await context.exposeBinding('__inspectCapture', async (source, payload) => capture(source.page, payload));
  await context.addInitScript(panelSource);

  const page = context.pages()[0] || (await context.newPage());
  if (startUrl) { try { await page.goto(startUrl, { waitUntil: 'domcontentloaded' }); } catch {} }
  try { await page.evaluate(`(${panelSource.toString()})()`); } catch {} // inject into the already-open page

  console.log('\nInspector ready. The bottom-left panel will show every capture.');
  console.log('Files go to ./inspect-output/  — press Ctrl-C here when done.\n');

  context.on('close', () => process.exit(0));
  await new Promise(() => {});
})();
