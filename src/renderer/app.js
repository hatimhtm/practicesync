'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = {};
let draftProviders = []; // providers parsed/edited but not yet saved (codes held as text)
let draftMains = [];     // main doctors [{name, code}]

// Local mirror of model.formatCodes (renderer can't require main-process modules).
function formatCodes(codes) {
  if (typeof codes === 'string') return codes;
  return (codes || []).map((c) => {
    let s = c.code || '';
    if (c.units && c.units !== 1) s += ' x' + c.units;
    if (c.modifiers && c.modifiers.length) s += ' (' + c.modifiers.join(',') + ')';
    return s;
  }).join(', ');
}
function normMain(m) { return typeof m === 'string' ? { name: m, code: '' } : { name: m.name || '', code: m.code || '' }; }

/* ------------------------------ navigation ------------------------------ */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) showView(g.dataset.goto);
});

/* -------------------------------- helpers ------------------------------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const SCHEDULE_LABEL = { off: 'Off', '6h': 'Every 6 hours', daily: 'Daily' };

/* ------------------------------ load state ------------------------------ */
async function refresh() {
  settings = await window.api.getSettings();
  if (typeof refreshCreds === 'function') refreshCreds();
  const providers = settings.providers || [];

  // Version (so a screenshot always shows which build is running)
  if ($('#appVersion')) $('#appVersion').textContent = 'v' + (settings.appVersion || '?');

  // Overview
  $('#ovDoctors').textContent = String(providers.length);
  $('#ovMode').textContent = (settings.pfSelectors && settings.spSelectors) ? 'Connected ✓' : 'Not set up';
  $('#ovSchedule').textContent = SCHEDULE_LABEL[settings.schedule] || 'Off';

  const r = settings.lastResult;
  if (r && r.ok) {
    $('#statusIcon').textContent = '✅';
    $('#statusTitle').textContent = `${r.created} appointment${r.created === 1 ? '' : 's'} ${r.dryRun ? 'found (read-only)' : 'booked'}`;
    $('#statusSub').textContent = `${fmtTime(r.at)}${r.unmatched ? ` · ${r.unmatched} doctor(s) not recognized` : ''}`;
  } else if (r && !r.ok) {
    $('#statusIcon').textContent = '⚠️';
    $('#statusTitle').textContent = 'Last sync needs attention';
    $('#statusSub').textContent = r.error || 'Something went wrong.';
  } else {
    $('#statusIcon').textContent = '—';
    $('#statusTitle').textContent = 'No sync yet';
    $('#statusSub').textContent = 'Add your doctors, then run a test sync.';
  }

  // Doctors & Codes
  $('#rosterText').value = settings.rosterText || '';
  if (!draftMains.length) draftMains = (settings.mainDoctors || []).map(normMain);
  if (!draftProviders.length && providers.length) {
    draftProviders = providers.map((p) => ({ name: p.name, mainDoctor: p.mainDoctor, codes: formatCodes(p.codes) }));
  }
  renderMains();
  renderProviders();

  // Connection (live only)
  $('#pfUrl').value = settings.pfUrl || '';
  $('#spUrl').value = settings.spUrl || '';
  if ($('#pfDate')) $('#pfDate').value = settings.runDate || '';
  setPill($('#pfTaught'), settings.pfSelectors);
  setPill($('#spTaught'), settings.spSelectors);
  $$('#spModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.val === (settings.spMode || 'standard')));

  // AI
  $('#aiProvider').value = settings.aiProvider || 'auto';
  renderAIState();
  detectAndShowEngines();

  // Schedule
  const sched = settings.schedule || 'off';
  $$('#scheduleSeg button').forEach((b) => b.classList.toggle('active', b.dataset.val === sched));
  if ($('#syncDaysAhead') && document.activeElement !== $('#syncDaysAhead')) $('#syncDaysAhead').value = settings.syncDaysAhead || 7;
  renderSchedule(sched, r);
}

/* schedule status cards */
const SCHED_NOTE = {
  off: 'Off — Hope Assistant runs only when you press <strong>Sync now</strong>.',
  '6h': 'Runs automatically every 6 hours, plus whenever you press Sync now.',
  daily: 'Runs automatically once a day, plus whenever you press Sync now.',
};
function renderSchedule(sched, lastResult) {
  if ($('#scheduleNote')) $('#scheduleNote').innerHTML = SCHED_NOTE[sched] || SCHED_NOTE.off;
  const last = $('#schedLast'); const lastSub = $('#schedLastSub'); const next = $('#schedNext');
  if (last) {
    if (lastResult && lastResult.at) {
      last.textContent = fmtTime(lastResult.at);
      lastSub.textContent = lastResult.ok
        ? `${lastResult.created || 0} booked${lastResult.unmatched ? ` · ${lastResult.unmatched} unrecognized` : ''}`
        : 'needs attention';
    } else { last.textContent = 'No runs yet'; lastSub.textContent = ''; }
  }
  if (next) {
    if (sched === 'off') next.textContent = 'Only when you press Sync now';
    else {
      const ms = sched === '6h' ? 6 * 3600e3 : 24 * 3600e3;
      const base = settings.lastRun ? Date.parse(settings.lastRun) : Date.now();
      next.textContent = fmtTime(new Date(base + ms).toISOString());
    }
  }
}

/* ----------------------------- doctors & codes -------------------------- */
function mainsFromInput() {
  return draftMains.map((m) => m.name).filter(Boolean);
}
function renderMains() {
  const wrap = $('#mainList');
  wrap.innerHTML = '';
  $('#mainGridHead').classList.toggle('hidden', !draftMains.length);
  draftMains.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'main-row';
    row.innerHTML = `
      <input class="main-name" data-i="${i}" value="${escapeHtml(m.name)}" placeholder="e.g. Caryn McAllister" />
      <input class="main-code" data-i="${i}" value="${escapeHtml(m.code)}" maxlength="3" placeholder="GP" />
      <button class="btn prov-del main-del" data-i="${i}" title="Remove">✕</button>`;
    wrap.appendChild(row);
  });
  $$('.main-name').forEach((el) => el.addEventListener('input', () => { draftMains[+el.dataset.i].name = el.value; renderProviders(); }));
  $$('.main-code').forEach((el) => el.addEventListener('input', () => { draftMains[+el.dataset.i].code = el.value.toUpperCase(); }));
  $$('.main-del').forEach((el) => el.addEventListener('click', () => { draftMains.splice(+el.dataset.i, 1); renderMains(); renderProviders(); }));
}
$('#addMainBtn').addEventListener('click', () => { draftMains.push({ name: '', code: '' }); renderMains(); });
function renderProviders() {
  const wrap = $('#providerList');
  wrap.innerHTML = '';
  const mains = mainsFromInput();
  const has = draftProviders.length > 0;
  $('#saveRosterBtn').classList.toggle('hidden', !has);
  $('#rosterGridHead').classList.toggle('hidden', !has);

  draftProviders.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'roster-row';
    const opts = ['', ...mains].map((m) => `<option value="${escapeHtml(m)}"${m === p.mainDoctor ? ' selected' : ''}>${escapeHtml(m || '— choose —')}</option>`).join('');
    row.innerHTML = `
      <input class="prov-name" data-i="${i}" value="${escapeHtml(p.name)}" placeholder="e.g. Dr. Alan Patel" />
      <select class="prov-main" data-i="${i}">${opts}</select>
      <input class="prov-codes" data-i="${i}" value="${escapeHtml(formatCodes(p.codes))}" placeholder="97112 x2, 97530 x2 (59)" />
      <button class="btn prov-del" data-i="${i}" title="Remove this doctor">✕</button>`;
    wrap.appendChild(row);
  });

  $$('.prov-name').forEach((el) => el.addEventListener('input', () => { draftProviders[+el.dataset.i].name = el.value; }));
  $$('.prov-main').forEach((el) => el.addEventListener('change', () => { draftProviders[+el.dataset.i].mainDoctor = el.value; }));
  $$('.prov-codes').forEach((el) => el.addEventListener('input', () => { draftProviders[+el.dataset.i].codes = el.value; }));
  $$('.prov-del').forEach((el) => el.addEventListener('click', () => { draftProviders.splice(+el.dataset.i, 1); renderProviders(); }));
}

$('#addDoctorBtn').addEventListener('click', () => { draftProviders.push({ name: '', mainDoctor: '', codes: '' }); renderProviders(); });

$('#interpretBtn').addEventListener('click', async () => {
  const text = $('#rosterText').value.trim();
  if (!text) { toast('Paste your doctor list first.'); return; }
  $('#interpretBtn').disabled = true;
  $('#interpretBtn').textContent = 'Interpreting…';
  const res = await window.api.parseRoster(text);
  $('#interpretBtn').disabled = false;
  $('#interpretBtn').textContent = 'Interpret with AI';
  draftProviders = (res.providers || []).map((p) => ({ name: p.name, mainDoctor: p.mainDoctor, codes: formatCodes(p.codes) }));
  // Fold in any detected big-doctor 2-letter codes (e.g. "under Heather - GO").
  if (res.mainCodeHints) {
    for (const [name, code] of Object.entries(res.mainCodeHints)) {
      let m = draftMains.find((x) => x.name === name);
      if (!m) { m = { name, code: '' }; draftMains.push(m); }
      if (!m.code) m.code = code;
    }
    renderMains();
  }
  renderProviders();
  $('#parseEngine').textContent = `Read ${draftProviders.length} doctor(s) using ${res.engine}.` + (res.unparsed && res.unparsed.length ? ` Couldn't read: ${res.unparsed.join(' / ')}` : '');
  toast(`Found ${draftProviders.length} doctor(s) — review and save.`);
});

$('#loadDemoBtn').addEventListener('click', async () => {
  await window.api.loadDemo();
  draftProviders = [];
  draftMains = [];
  await refresh();
  toast('Demo doctors loaded.');
});

$('#saveRosterBtn').addEventListener('click', async () => {
  const mains = draftMains.filter((m) => m.name.trim());
  await window.api.saveRoster({ mainDoctors: mains, providers: draftProviders, rosterText: $('#rosterText').value });
  await refresh();
  toast('Doctors saved.');
  // If we're mid-setup, snap straight back to the DOCTORS step of the tutorial
  // (role-indexed so it survives step reordering — not a hardcoded number).
  if (inSetup) openOnboarding(OB.indexOf('doctors'));
});

/* -------------------------------- overview ------------------------------ */
$('#syncNowBtn').addEventListener('click', async () => {
  // Guard: never let a real booking run before setup is complete & screens taught.
  if (!settings.pfSelectors || !settings.spSelectors) {
    toast('Finish setup (Teach both screens) first.');
    openOnboarding();
    return;
  }
  if ((settings.providers || []).length === 0) {
    toast('Add your doctors first.');
    showView('doctors');
    return;
  }
  $('#syncNowBtn').disabled = true;
  $('#syncNowBtn').textContent = 'Syncing…';
  const res = await window.api.runNow();
  $('#syncNowBtn').disabled = false;
  $('#syncNowBtn').textContent = 'Sync now';
  if (res && res.ok) toast(`Booked ${res.created} appointment(s)${res.unmatched ? `, ${res.unmatched} unmatched` : ''}.`);
  else toast(res && res.error ? res.error : 'Sync failed.');
  refresh();
});

/* ------------------------------ test mode ------------------------------- */
function renderSyncResult(container, res) {
  container.classList.remove('hidden');
  if (!res || !res.ok) {
    container.innerHTML = `<div class="result"><h3>Couldn't run ⚠️</h3><p class="muted">${escapeHtml(res && res.error ? res.error : 'Unknown error')}</p></div>`;
    return;
  }
  const statusCell = (a) => {
    if (!a.matched) return `<span class="map-review">${escapeHtml(a.reason || 'not recognized')}</span>`;
    if (a.status === 'duplicate') return '↩ already booked';
    if (a.status === 'failed') return `<span class="map-review" title="${escapeHtml(a.error || '')}">failed</span>`;
    if (a.status === 'would-book' || res.dryRun) return 'would book';
    if (a.status === 'booked') return a.warning ? `<span class="map-review" title="${escapeHtml(a.warning)}">✓ booked ⚠</span>` : '✓ booked';
    return '—';
  };
  const svcText = (a) => (a.services && a.services.length)
    ? a.services.map((s) => `${s.code}${s.units && s.units !== 1 ? ' ×' + s.units : ''}${s.modifiers && s.modifiers.length ? ' [' + s.modifiers.join(',') + ']' : ''}`).join(', ')
    : formatCodes(a.codes);
  const mainCell = (a) => a.matched ? `${escapeHtml(a.mainDoctor)}${a.mainCode ? ` <span class="muted">(${escapeHtml(a.mainCode)})</span>` : ''}` : '<span class="map-review">—</span>';
  const rows = (res.planned || []).map((a) => `
    <tr class="${a.matched ? '' : 'row-unmatched'}">
      <td>${escapeHtml(a.date)}</td>
      <td>${escapeHtml(a.patientName)}</td>
      <td>${escapeHtml(a.doctorName)}</td>
      <td>${mainCell(a)}</td>
      <td>${escapeHtml(svcText(a))}</td>
      <td>${statusCell(a)}</td>
    </tr>`).join('');
  const bookedLabel = res.dryRun ? 'Would book' : 'Booked';
  const banner = res.dryRun
    ? '<div class="map-note">Read-only check — these are your <strong>real</strong> visits from Practice Fusion. Nothing was booked.</div>'
    : '<div class="map-note" style="color:var(--good);background:rgba(52,211,153,0.1);border-color:rgba(52,211,153,0.25)">✓ Booked into SimplePractice.</div>';
  container.innerHTML = `
    <div class="result">
      ${banner}
      <div class="stat-row">
        <div class="stat"><div class="stat-num good">${res.created}</div><div class="stat-lbl">${bookedLabel}</div></div>
        <div class="stat"><div class="stat-num muted">${res.unmatched}</div><div class="stat-lbl">Unrecognized</div></div>
        ${res.skipped ? `<div class="stat"><div class="stat-num muted">${res.skipped}</div><div class="stat-lbl">Already booked</div></div>` : ''}
        ${res.failed ? `<div class="stat"><div class="stat-num">${res.failed}</div><div class="stat-lbl">Failed</div></div>` : ''}
        <div class="stat"><div class="stat-num">${(res.planned || []).length}</div><div class="stat-lbl">Visits read</div></div>
      </div>
      <table class="appt-table">
        <thead><tr><th>Date</th><th>Patient</th><th>Diagnosing doctor</th><th>Main doctor</th><th>Codes (units · modifiers)</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ------------------------------ connection ------------------------------ */
let demoCount = 10;
// Split a textarea/line of patient names into a clean list (newline or comma).
function parsePatientNames(raw) {
  return String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}
function setPill(el, taught) {
  el.textContent = taught ? 'set up ✓' : 'needs setup';
  el.className = 'pill ' + (taught ? 'pill-good' : 'pill-todo');
}
$$('#spModeSeg button').forEach((b) => b.addEventListener('click', async () => {
  await window.api.saveSettings({ spMode: b.dataset.val });
  await refresh();
  toast(b.dataset.val === 'enterprise' ? 'Enterprise (API) selected.' : 'Standard (screen automation) selected.');
}));
$$('#demoCountSeg button').forEach((b) => b.addEventListener('click', () => {
  demoCount = parseInt(b.dataset.val, 10) || 10;
  $$('#demoCountSeg button').forEach((x) => x.classList.toggle('active', x === b));
}));
async function teachScreen(target, urlSel) {
  const url = $(urlSel).value.trim();
  if (!url) { toast('Enter the page address first.'); return; }
  await window.api.saveSettings(target === 'pf' ? { pfUrl: url } : { spUrl: url });
  toast('Opening the page — click each field as prompted…');
  const res = await window.api.teach(target, url);
  if (res && res.ok) {
    let extra = res.captureCount ? ` · ${res.captureCount} screenshots saved (folder opened)` : '';
    if (target === 'pf' && res.inference) {
      extra += res.inference.ok
        ? ` · found ${res.inference.matched} appointment${res.inference.matched === 1 ? '' : 's'} on the day ✓`
        : ' · ⚠ couldn’t detect the repeating appointments — open the Schedule to a day WITH appointments and teach again';
    }
    toast(`Screen set up ✓${extra}`);
  } else toast(res && res.error ? res.error : 'Teach Mode could not run here.');
  refresh();
}
$('#teachPf').addEventListener('click', () => teachScreen('pf', '#pfUrl'));
$('#teachSp').addEventListener('click', () => teachScreen('sp', '#spUrl'));
/* ---- Demo-account sync: logins (Keychain) + date-range run with live log ---- */
async function refreshCreds() {
  try {
    const st = await window.api.credsStatus();
    if ($('#pfUser') && !$('#pfUser').value) $('#pfUser').value = st.pfUsername || '';
    if ($('#spUser') && !$('#spUser').value) $('#spUser').value = st.spEmail || '';
    setCredPill($('#credsPf'), st.pf, 'PF login saved', 'PF needs login');
    setCredPill($('#credsSp'), st.sp, 'SP login saved', 'SP needs login');
  } catch {}
}
function setCredPill(el, ok, goodText, todoText) {
  if (!el) return;
  el.textContent = ok ? goodText : todoText;
  el.className = 'pill ' + (ok ? 'pill-good' : 'pill-todo');
}
if ($('#saveCredsBtn')) $('#saveCredsBtn').addEventListener('click', async () => {
  const creds = {
    practiceFusion: { username: $('#pfUser').value.trim(), password: $('#pfPass').value },
    simplePractice: { email: $('#spUser').value.trim(), password: $('#spPass').value },
  };
  const r = await window.api.saveCreds(creds);
  if (r && r.ok) { $('#pfPass').value = ''; $('#spPass').value = ''; toast('Logins saved (encrypted) ✓'); refreshCreds(); }
  else toast(r && r.error ? r.error : 'Could not save logins.');
});

function appendSyncLog(text) {
  const log = $('#syncLog'); if (!log) return;
  log.classList.remove('hidden');
  const line = document.createElement('div'); line.textContent = text;
  log.appendChild(line); log.scrollTop = log.scrollHeight;
}
if (window.api.onLiveStep) window.api.onLiveStep((s) => { if (s && s.reset) $('#syncLog') && ($('#syncLog').innerHTML = ''); if (s && s.text) appendSyncLog(s.text); });

async function runSyncFlow(save, btn) {
  const start = $('#syncStart') && $('#syncStart').value;
  const end = $('#syncEnd') && $('#syncEnd').value;
  if (!start) { toast('Pick a From date first.'); return; }
  const buttons = [$('#syncDryBtn'), $('#syncBookBtn')];
  buttons.forEach((b) => b && (b.disabled = true));
  const label = btn.textContent; btn.textContent = save ? 'Booking…' : 'Reading…';
  if ($('#syncLog')) $('#syncLog').innerHTML = '';
  const res = await window.api.syncRun({ start, end: end || start, save });
  buttons.forEach((b) => b && (b.disabled = false));
  btn.textContent = label;
  if ($('#syncResult')) {
    $('#syncResult').classList.remove('hidden');
    $('#syncResult').innerHTML = res && res.ok
      ? `<div class="ob-result">${save ? 'Booked' : 'Would book'} <b>${res.booked || 0}</b> · ${res.skipped || 0} already there${res.failed ? ` · <b>${res.failed} couldn’t book</b>` : ''}${res.unmatched ? ` · ${res.unmatched} unrecognized` : ''}</div>`
      : `<div class="ob-note">${(res && res.error) || 'Sync failed.'}</div>`;
  }
}
if ($('#syncDryBtn')) $('#syncDryBtn').addEventListener('click', (e) => runSyncFlow(false, e.target));
if ($('#syncBookBtn')) $('#syncBookBtn').addEventListener('click', (e) => runSyncFlow(true, e.target));

if ($('#captureFieldsBtn')) $('#captureFieldsBtn').addEventListener('click', async (e) => {
  const btn = e.target; const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Opening SimplePractice…';
  if ($('#syncLog')) $('#syncLog').innerHTML = '';
  const r = await window.api.captureFields();
  btn.disabled = false; btn.textContent = old;
  const pill = $('#captureStatus');
  if (pill) {
    pill.style.display = '';
    pill.textContent = r && r.ok ? `Saved “${r.folder}” to your Desktop ✓` : (r && r.error ? r.error : 'Capture stopped');
    pill.className = 'pill ' + (r && r.ok ? 'pill-good' : 'pill-todo');
  }
  if (r && r.ok) toast(`Saved to your Desktop — send me the “${r.folder}” folder.`);
});

/* ------------------------------- AI engine ------------------------------ */
const PROVIDER_LABEL = { auto: 'Smart (auto)', apple: 'Apple Intelligence', ollama: 'Local Gemma', none: 'Built-in' };
function renderAIState() {
  const p = settings.aiProvider || 'auto';
  const el = $('#aiState');
  el.textContent = PROVIDER_LABEL[p] || 'Smart (auto)';
  el.className = 'pill pill-safe';
}
// Ask the main process what's installed/running and show it, plus a one-line
// summary of what Smart mode will actually use.
function engineRow(name, ok, detail, active) {
  return `<div class="engine-row"><span class="seg-dot ${ok ? 'on' : ''}"></span><b>${escapeHtml(name)}</b>`
    + (active ? ' <span class="pill pill-good" style="padding:1px 8px;font-size:10px">active</span>' : '')
    + ` <span class="muted">— ${escapeHtml(detail)}</span></div>`;
}
async function detectAndShowEngines() {
  const box = $('#engineStatus');
  if (box) box.textContent = 'Checking what’s available on this Mac…';
  const e = await window.api.detectEngines();
  // Mirror ai.js 'auto' order (local model → Apple Intelligence → built-in).
  const active = e.ollama.available ? 'ollama' : (e.apple ? 'apple' : 'builtin');
  const rows = [
    engineRow('Apple Intelligence', e.apple, e.apple ? 'on-device' : 'needs an M-series Mac on macOS 26', active === 'apple'),
    engineRow('Local Gemma 4', e.ollama.available, e.ollama.available ? 'on-device' : 'not detected (install Ollama to enable)', active === 'ollama'),
    engineRow('Built-in matcher', true, 'always available, fully offline', active === 'builtin'),
  ];
  if (box) box.innerHTML = rows.join('');
  const picked = active === 'ollama' ? 'Local Gemma 4 (on-device)'
    : (active === 'apple' ? 'Apple Intelligence (on-device)' : 'the built-in matcher');
  $('#appleNote').textContent = `Smart mode uses the best engine on this Mac — currently ${picked}. Most people never need to change this.`;
}
$('#aiProvider').addEventListener('change', () => { settings.aiProvider = $('#aiProvider').value; renderAIState(); });
$('#saveAI').addEventListener('click', async () => {
  const provider = $('#aiProvider').value;
  const res = await window.api.setAI({ provider });
  toast(res && res.ok === false ? res.error : 'AI engine saved.');
  await refresh();
});

/* ------------------------------- schedule ------------------------------- */
$$('#scheduleSeg button').forEach((b) => b.addEventListener('click', async () => {
  await window.api.saveSettings({ schedule: b.dataset.val });
  await refresh();
  toast('Schedule updated.');
}));
if ($('#syncDaysAhead')) $('#syncDaysAhead').addEventListener('change', async (e) => {
  const n = Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 7));
  e.target.value = n;
  await window.api.saveSettings({ syncDaysAhead: n });
  toast(`Will sync the next ${n} day${n === 1 ? '' : 's'} on each run.`);
});

/* ------------------------------ test drive ------------------------------ */
let demoRunning = false;
async function runTestDrive(sourceUrl, colA, colB) {
  if (demoRunning) return;
  const url = String(sourceUrl || '').trim();
  if (!url) { toast('Paste a web page address or pick a preset.'); return; }
  demoRunning = true;
  const btn = $('#demoRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running… watch Chrome'; }
  $$('#demoPresets button').forEach((b) => (b.disabled = true));
  const res = await window.api.runSiteDemo({ sourceUrl: url, colA: colA || 'Item', colB: colB || 'Detail', rows: 6 });
  if (btn) { btn.disabled = false; btn.textContent = '▶ Run the test drive'; }
  $$('#demoPresets button').forEach((b) => (b.disabled = false));
  demoRunning = false;
  if (!res || !res.ok) toast(res && res.error ? res.error : 'The test drive could not run.');
}
$$('#demoPresets button').forEach((b) => b.addEventListener('click', () => {
  $('#demoUrl').value = b.dataset.url;
  runTestDrive(b.dataset.url, b.dataset.a, b.dataset.b);
}));
$('#demoRunBtn').addEventListener('click', () => runTestDrive($('#demoUrl').value, 'Item', 'Detail'));

window.api.onDemoStep((s) => {
  if (!s) return;
  const log = $('#demoLog'); const card = $('#demoCard');
  if (!log || !card) return;
  if (s.reset) { log.innerHTML = ''; card.classList.remove('hidden'); showView('test'); }
  const prev = log.querySelector('.live-line.cur'); if (prev) prev.classList.remove('cur');
  const line = document.createElement('div');
  line.className = 'live-line' + (s.done ? '' : ' cur');
  line.innerHTML = `<span class="t">${fmtClock(s.at)}</span><span>${escapeHtml(s.text || '')}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
});

/* --------------------------- record a workflow -------------------------- */
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function recDesc(e) {
  if (e.type === 'navigate') return '🌐 Opened ' + escapeHtml(hostOf(e.url));
  if (e.type === 'click') return '🖱 Clicked ' + escapeHtml(e.label || e.selector || 'something');
  if (e.type === 'input') return '⌨️ Typed “' + escapeHtml(e.value || '') + '” into ' + escapeHtml(e.label || 'a field');
  return escapeHtml(e.type || '');
}
let recReviewItems = []; // events from the last recording (with .keep)

function recLogLine(logSel, text, cls) {
  const log = $(logSel); if (!log) return;
  const prev = log.querySelector('.live-line.cur'); if (prev) prev.classList.remove('cur');
  const line = document.createElement('div');
  line.className = 'live-line' + (cls ? ' ' + cls : '');
  line.innerHTML = `<span class="t">${fmtClock(new Date().toISOString())}</span><span>${text}</span>`;
  log.appendChild(line); log.scrollTop = log.scrollHeight;
}

$('#recStartBtn').addEventListener('click', async () => {
  const res = await window.api.recordStart({ startUrl: $('#recUrl').value.trim() });
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Could not start recording.'); return; }
  $('#recLog').innerHTML = '';
  $('#recStartCard').classList.add('hidden');
  $('#recReviewCard').classList.add('hidden');
  $('#recLiveCard').classList.remove('hidden');
  toast('Recording — do your task in the Chrome window, then press Stop.');
});

$('#recStopBtn').addEventListener('click', async () => {
  const res = await window.api.recordStop();
  $('#recLiveCard').classList.add('hidden');
  $('#recStartCard').classList.remove('hidden');
  if (!res || !res.ok) { toast(res && res.error ? res.error : 'Nothing was recording.'); return; }
  recReviewItems = (res.events || []).map((e) => ({ ...e, keep: true }));
  renderRecReview();
  $('#recReviewCard').classList.remove('hidden');
  if (!recReviewItems.length) toast('No actions were captured — try again and click/type in the Chrome window.');
});

function renderRecReview() {
  const wrap = $('#recReview'); wrap.innerHTML = '';
  recReviewItems.forEach((e, i) => {
    if (e.type === 'flag') return;
    const row = document.createElement('label');
    row.className = 'rec-row';
    row.innerHTML = `<input type="checkbox" data-i="${i}" ${e.keep ? 'checked' : ''} />`
      + `<span class="rec-desc">${e.flagged ? '<span class="rec-star">★</span> ' : ''}${recDesc(e)}</span>`;
    wrap.appendChild(row);
  });
  $$('#recReview input[type="checkbox"]').forEach((c) => c.addEventListener('change', () => { recReviewItems[+c.dataset.i].keep = c.checked; }));
}

$('#recSaveBtn').addEventListener('click', async () => {
  const steps = recReviewItems.filter((e) => e.keep && e.type !== 'flag').map((e) => ({ type: e.type, selector: e.selector, value: e.value, url: e.url, label: e.label }));
  if (!steps.length) { toast('Keep at least one step first.'); return; }
  const name = $('#recName').value.trim() || 'Untitled workflow';
  const res = await window.api.recordSave({ name, steps });
  if (res && res.ok) {
    toast('Workflow saved ✓');
    $('#recReviewCard').classList.add('hidden');
    $('#recName').value = '';
    renderWorkflowList();
  } else toast('Could not save the workflow.');
});

async function renderWorkflowList() {
  const res = await window.api.recordList();
  const list = $('#recList'); list.innerHTML = '';
  const wfs = (res && res.workflows) || [];
  if (!wfs.length) { list.innerHTML = '<p class="muted" style="font-size:13px;margin:6px 0 0">No workflows yet — record one above.</p>'; return; }
  wfs.forEach((w) => {
    const stepCount = (w.steps || []).filter((s) => s.type !== 'flag').length;
    const row = document.createElement('div');
    row.className = 'wf-row';
    row.innerHTML = `<div class="wf-meta"><b>${escapeHtml(w.name)}</b><span class="muted"> · ${stepCount} step${stepCount === 1 ? '' : 's'}</span></div>`
      + `<div class="wf-actions"><button class="btn btn-primary wf-replay" data-id="${w.id}">▶ Replay</button><button class="btn wf-del" data-id="${w.id}" title="Delete">✕</button></div>`;
    list.appendChild(row);
  });
  $$('.wf-replay').forEach((b) => b.addEventListener('click', async () => {
    $('#recReplayLog').innerHTML = '';
    $('#recReplayCard').classList.remove('hidden');
    b.disabled = true;
    const res2 = await window.api.recordReplay({ id: b.dataset.id });
    b.disabled = false;
    if (!res2 || !res2.ok) toast(res2 && res2.error ? res2.error : 'Replay failed.');
  }));
  $$('.wf-del').forEach((b) => b.addEventListener('click', async () => { await window.api.recordDelete(b.dataset.id); renderWorkflowList(); }));
}

window.api.onRecordEvent((s) => {
  if (!s) return;
  if (s.type === 'replay') {
    if (s.reset) $('#recReplayLog').innerHTML = '';
    recLogLine('#recReplayLog', escapeHtml(s.text || ''), s.done ? '' : 'cur');
    return;
  }
  if (s.type === 'flag') { recLogLine('#recLog', '<b>★ step marked</b>', ''); toast('Step marked ★'); return; }
  recLogLine('#recLog', recDesc(s), 'cur');
});

/* -------------------- onboarding (mandatory, gated) --------------------- */
const SETUP_VERSION = 4; // bump forces everyone through setup again after an update
// Steps by ROLE so inserting/reordering never breaks the gates.
const OB = ['welcome', 'permissions', 'doctors', 'pf', 'sp', 'verify'];
const OB_STEPS = OB.length;
let obStep = 0;
let obVerified = false; // a real read-only pull succeeded in the last step
let inSetup = false;    // true while the mandatory setup is active (can't escape it)

function obDots() {
  const w = $('#obProgress'); w.innerHTML = '';
  for (let i = 0; i < OB_STEPS; i++) { const d = document.createElement('div'); d.className = 'seg-dot' + (i <= obStep ? ' on' : ''); w.appendChild(d); }
}

// Each step's gate: can the user advance from `step`? Returns '' if allowed, else why-not.
function obGate(step) {
  const role = OB[step];
  if (role === 'doctors') {
    if (!(settings.providers || []).length) return 'Load your doctor list and press Save.';
    if (!(settings.mainDoctors || []).some((m) => (m.code || '').trim())) return 'Give each main doctor a 2-letter code (GP/GO/GN).';
    return '';
  }
  if (role === 'pf') return settings.pfSelectors ? '' : 'Show the Practice Fusion fields to continue.';
  if (role === 'sp') return settings.spSelectors ? '' : 'Show the SimplePractice fields to continue.';
  if (role === 'verify') return obVerified ? '' : 'Pull your real visits and confirm they look right.';
  return '';
}

function obShow(n) {
  obStep = Math.max(0, Math.min(OB_STEPS - 1, n));
  $$('.ob-step').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== obStep));
  obDots();
  $('#obBack').disabled = obStep === 0;
  const last = obStep === OB_STEPS - 1;
  $('#obNext').textContent = last ? 'Finish' : 'Next';
  // gate the Next button
  const why = obGate(obStep);
  $('#obNext').disabled = !!why;
  $('#obGateMsg').textContent = why;
  // reflect taught state on the step pills
  const role = OB[obStep];
  if (role === 'pf') setPill($('#obPfTaught'), settings.pfSelectors);
  if (role === 'sp') setPill($('#obSpTaught'), settings.spSelectors);
}

function openOnboarding(step = 0) {
  inSetup = true;
  $('#obPfUrl').value = settings.pfUrl || '';
  $('#obSpUrl').value = settings.spUrl || '';
  obShow(step);
  $('#onboard').classList.remove('hidden');
}
async function finishOnboarding() {
  const verifyIdx = OB.indexOf('verify');
  if (obGate(verifyIdx)) { obShow(verifyIdx); return; } // safety: can't finish unverified
  await window.api.saveSettings({ setupComplete: true, setupVersion: SETUP_VERSION });
  inSetup = false;
  $('#onboard').classList.add('hidden');
  await refresh();
  toast("All set — Hope Assistant is ready.");
}

$('#obBack').addEventListener('click', () => { $('#obError').classList.add('hidden'); obShow(obStep - 1); });
$('#obNext').addEventListener('click', () => { if (obGate(obStep)) return; $('#obError').classList.add('hidden'); if (obStep === OB_STEPS - 1) finishOnboarding(); else obShow(obStep + 1); });

// Step 1 — doctors
$('#obLoadDemo').addEventListener('click', async () => {
  await window.api.loadDemo();
  draftProviders = []; draftMains = [];
  await refresh();
  $('#obDoctorsOk').classList.remove('hidden');
  $('#obDoctorsOk').textContent = `✓ Loaded ${(settings.providers || []).length} doctors. Review them and press Save on the Doctors & Codes screen.`;
  obShow(obStep);
});
$('#obOpenDoctors').addEventListener('click', () => { $('#onboard').classList.add('hidden'); showView('doctors'); toast('Review your doctors and press Save — setup will continue automatically.'); });

// Step 3/4 — teach screens (inside the tutorial)
async function obTeach(target, urlSel, btn) {
  const url = $(urlSel).value.trim();
  if (!url) { toast('Paste the page address first.'); return; }
  $('#obError').classList.add('hidden');
  $(btn).disabled = true; $(btn).textContent = '→ Switch to Chrome & click each field…';
  toast('Switch to Chrome. Click the field the bar shows, then press “Next step”. You can re-click to fix a choice, or press Back.');
  const res = await window.api.teach(target, url);
  $(btn).disabled = false; $(btn).textContent = 'Open & show the fields';
  if (res && res.ok) {
    toast(`Got it ✓${res.captureCount ? ` · ${res.captureCount} screenshots saved` : ''}`);
  } else {
    // Show the exact reason, persistently, so it's never a silent no-op.
    const err = $('#obError');
    err.classList.remove('hidden');
    err.innerHTML = `<strong>Couldn't open Chrome.</strong> ${escapeHtml(res && res.error ? res.error : 'Unknown error.')}` +
      (res && res.detail ? `<br><span class="muted" style="font-size:11px">Details: ${escapeHtml(res.detail)}</span>` : '');
  }
  await refresh();
  obShow(obStep); // re-evaluate the gate
}
$('#obTeachPf').addEventListener('click', () => obTeach('pf', '#obPfUrl', '#obTeachPf'));
$('#obTeachSp').addEventListener('click', () => obTeach('sp', '#obSpUrl', '#obTeachSp'));

// Step 5 — verify with a real read-only pull
$('#obVerifyBtn').addEventListener('click', async () => {
  const legacy = settings.pfSelectors && settings.pfSelectors.searchBox;
  const date = ($('#obDate') && $('#obDate').value) || '';
  if (!legacy && !date) { toast('Pick the date to read first.'); return; }
  await window.api.saveSettings({ runDate: date });
  $('#obVerifyBtn').disabled = true; $('#obVerifyBtn').textContent = 'Reading…';
  const res = await window.api.runSync({ count: 25, dryRun: true, date });
  $('#obVerifyBtn').disabled = false; $('#obVerifyBtn').textContent = "Read this day’s appointments";
  renderSyncResult($('#obResult'), res);
  obVerified = !!(res && res.ok && (res.planned || []).length > 0);
  obShow(obStep);
});

if ($('#openConnFromHome')) $('#openConnFromHome').addEventListener('click', () => showView('connect'));

/* ------------------------------- updates -------------------------------- */
// Updates live entirely in the sidebar button + the auto banner (no duplicate
// controls in the Overview body).
let updateReady = false; // a newer version was found and is ready to install
async function checkUpdates() {
  const sb = $('#sidebarUpdateBtn'); if (sb && !updateReady) sb.textContent = 'Checking…';
  await window.api.checkForUpdates();
}
function startUpdate() { window.api.installUpdate(); }
$('#ubBtn').addEventListener('click', startUpdate);
// Always-visible sidebar button: if an update is ready, install it; else check.
$('#sidebarUpdateBtn').addEventListener('click', () => {
  if (updateReady) { showView('home'); startUpdate(); }
  else { showView('home'); checkUpdates(); }
});

window.api.onUpdateStatus((s) => {
  if (!s) return;
  const banner = $('#updateBanner');
  const ubTitle = $('#ubTitle');
  const ubSub = $('#ubSub');
  const ubBtn = $('#ubBtn');
  const sb = $('#sidebarUpdateBtn');
  switch (s.phase) {
    case 'checking':
      if (sb) sb.textContent = 'Checking…';
      break;
    case 'none':
      banner.classList.add('hidden');
      updateReady = false;
      if (sb) sb.textContent = 'Up to date ✓';
      break;
    case 'available':
      ubTitle.textContent = `Update ${s.version || ''} is ready`;
      ubSub.textContent = 'Click Update now — it downloads the new version and opens the installer.';
      ubBtn.textContent = 'Update now'; ubBtn.disabled = false;
      banner.classList.remove('hidden');
      updateReady = true;
      if (sb) sb.textContent = `Update to ${s.version || 'the new version'} →`;
      showView('home');
      break;
    case 'downloading':
      ubTitle.textContent = 'Downloading the update…';
      ubSub.textContent = `${s.percent || 0}% — hang tight, this is the new app coming down.`;
      ubBtn.textContent = `${s.percent || 0}%`; ubBtn.disabled = true;
      banner.classList.remove('hidden');
      if (sb) sb.textContent = `Downloading… ${s.percent || 0}%`;
      break;
    case 'opening':
      ubTitle.textContent = 'Last step — finish in the window that opened';
      ubSub.textContent = 'Quit Hope Assistant, drag the new version onto Applications (replace the old one), then reopen it.';
      ubBtn.textContent = 'Open installer again'; ubBtn.disabled = false;
      banner.classList.remove('hidden');
      if (sb) sb.textContent = 'Finish in Finder →';
      break;
    case 'error':
      if (ubBtn) { ubBtn.disabled = false; ubBtn.textContent = 'Try update again'; }
      updateReady = false;
      if (sb) sb.textContent = 'Check for updates';
      break;
    default:
      break;
  }
});

/* -------------------------------- events -------------------------------- */
function fmtClock(iso) {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ''; }
}
window.api.onLiveStep((s) => {
  if (!s) return;
  const log = $('#liveLog'); const card = $('#liveCard');
  if (!log || !card) return;
  if (s.reset) { log.innerHTML = ''; card.classList.remove('hidden'); showView('home'); }
  const prev = log.querySelector('.live-line.cur'); if (prev) prev.classList.remove('cur');
  const line = document.createElement('div');
  line.className = 'live-line cur';
  line.innerHTML = `<span class="t">${fmtClock(s.at)}</span><span>${escapeHtml(s.text || '')}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
});
window.api.onRunFinished(() => { const c = $('#liveLog .live-line.cur'); if (c) c.classList.remove('cur'); refresh(); });
window.api.onRunStatus((s) => { if (s && s.phase === 'running') $('#statusIcon').textContent = '⏳'; });

/* --------------------------------- init --------------------------------- */
(async () => {
  await refresh();
  renderWorkflowList();
  // The step-by-step tutorial is retired: the screens are already built in, so
  // first-run setup is just "enter your logins" on the Connection page.
})();
