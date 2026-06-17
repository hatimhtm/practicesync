'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = {};
let draftProviders = []; // providers parsed/edited but not yet saved (codes held as text)
let draftMains = [];     // big doctors [{name, code}]

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
  const providers = settings.providers || [];

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
  if ($('#pfPatients')) $('#pfPatients').value = (settings.patientNames || []).join('\n');
  setPill($('#pfTaught'), settings.pfSelectors);
  setPill($('#spTaught'), settings.spSelectors);
  $$('#spModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.val === (settings.spMode || 'standard')));

  // AI
  $('#aiProvider').value = settings.aiProvider || 'apple';
  toggleAIKey('#aiProvider', '#aiKeyWrap');
  $('#appleNote').textContent = settings.appleAvailable
    ? 'This Mac supports on-device Apple Intelligence.'
    : 'Apple Intelligence may not be available on this Mac — the built-in matcher is used automatically.';
  renderAIState();

  // Schedule
  $$('#scheduleSeg button').forEach((b) => b.classList.toggle('active', b.dataset.val === (settings.schedule || 'off')));
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
  // If we're mid-setup, snap straight back into the mandatory tutorial.
  if (inSetup) openOnboarding(1);
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
    if (a.status === 'booked') return '✓ booked';
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
let demoCount = 2;
// Split a textarea/line of patient names into a clean list (newline or comma).
function parsePatientNames(raw) {
  return String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}
function setPill(el, taught) {
  el.textContent = taught ? 'taught ✓' : 'not taught';
  el.className = 'pill ' + (taught ? 'pill-good' : 'pill-pending');
}
$$('#spModeSeg button').forEach((b) => b.addEventListener('click', async () => {
  await window.api.saveSettings({ spMode: b.dataset.val });
  await refresh();
  toast(b.dataset.val === 'enterprise' ? 'Enterprise (API) selected.' : 'Standard (screen automation) selected.');
}));
$$('#demoCountSeg button').forEach((b) => b.addEventListener('click', () => {
  demoCount = parseInt(b.dataset.val, 10) || 2;
  $$('#demoCountSeg button').forEach((x) => x.classList.toggle('active', x === b));
}));
async function teachScreen(target, urlSel) {
  const url = $(urlSel).value.trim();
  if (!url) { toast('Enter the page address first.'); return; }
  await window.api.saveSettings(target === 'pf' ? { pfUrl: url } : { spUrl: url });
  toast('Opening the page — click each field as prompted…');
  const res = await window.api.teach(target, url);
  if (res && res.ok) toast('Screen taught ✓');
  else toast(res && res.error ? res.error : 'Teach Mode could not run here.');
  refresh();
}
$('#teachPf').addEventListener('click', () => teachScreen('pf', '#pfUrl'));
$('#teachSp').addEventListener('click', () => teachScreen('sp', '#spUrl'));
$('#demoPullBtn').addEventListener('click', async () => {
  const names = parsePatientNames($('#pfPatients') && $('#pfPatients').value);
  if (settings.pfSelectors && settings.pfSelectors.searchBox && !names.length) {
    toast('Type at least one patient name first.'); return;
  }
  await window.api.saveSettings({ patientNames: names }); // remember for scheduled / Sync-now runs
  $('#demoPullBtn').disabled = true;
  $('#demoPullBtn').textContent = 'Pulling…';
  const res = await window.api.runSync({ mode: 'live', count: demoCount, dryRun: true, patientNames: names });
  $('#demoPullBtn').disabled = false;
  $('#demoPullBtn').textContent = 'Pull real visits (read only)';
  renderSyncResult($('#demoResult'), res);
});

/* ------------------------------- AI engine ------------------------------ */
const PROVIDER_LABEL = { none: 'Built-in matching', apple: 'Apple Intelligence', claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };
function toggleAIKey(sel, wrap) {
  const v = $(sel).value;
  $(wrap).classList.toggle('hidden', v === 'none' || v === 'apple');
}
function renderAIState() {
  const p = settings.aiProvider || 'apple';
  const el = $('#aiState');
  if (p === 'none' || p === 'apple') { el.textContent = PROVIDER_LABEL[p]; el.className = 'pill pill-safe'; }
  else if (settings.hasAIKey) { el.textContent = `${PROVIDER_LABEL[p]} · key saved`; el.className = 'pill pill-good'; }
  else { el.textContent = `${PROVIDER_LABEL[p]} · needs key`; el.className = 'pill pill-pending'; }
}
$('#aiProvider').addEventListener('change', () => toggleAIKey('#aiProvider', '#aiKeyWrap'));
$('#saveAI').addEventListener('click', async () => {
  const provider = $('#aiProvider').value;
  const apiKey = $('#aiKey').value;
  const res = await window.api.setAI({ provider, apiKey: apiKey || undefined });
  $('#aiKey').value = '';
  toast(res && res.ok === false ? res.error : 'AI engine saved.');
  await refresh();
});

/* ------------------------------- schedule ------------------------------- */
$$('#scheduleSeg button').forEach((b) => b.addEventListener('click', async () => {
  await window.api.saveSettings({ schedule: b.dataset.val });
  await refresh();
  toast('Schedule updated.');
}));

/* -------------------- onboarding (mandatory, gated) --------------------- */
const SETUP_VERSION = 3; // bump forces everyone through setup again after an update
const OB_STEPS = 5;
let obStep = 0;
let obVerified = false; // a real read-only pull succeeded in the last step
let inSetup = false;    // true while the mandatory setup is active (can't escape it)

function obDots() {
  const w = $('#obProgress'); w.innerHTML = '';
  for (let i = 0; i < OB_STEPS; i++) { const d = document.createElement('div'); d.className = 'seg-dot' + (i <= obStep ? ' on' : ''); w.appendChild(d); }
}

// Each step's gate: can the user advance from `step`? Returns '' if allowed, else why-not.
function obGate(step) {
  if (step === 1) {
    if (!(settings.providers || []).length) return 'Load your doctor list and press Save.';
    if (!(settings.mainDoctors || []).some((m) => (m.code || '').trim())) return 'Give each big doctor a 2-letter code (GP/GO/GN).';
    return '';
  }
  if (step === 2) return settings.pfSelectors ? '' : 'Show the Practice Fusion fields to continue.';
  if (step === 3) return settings.spSelectors ? '' : 'Show the SimplePractice fields to continue.';
  if (step === 4) return obVerified ? '' : 'Pull your real visits and confirm they look right.';
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
  if (obStep === 2) setPill($('#obPfTaught'), settings.pfSelectors);
  if (obStep === 3) setPill($('#obSpTaught'), settings.spSelectors);
}

function openOnboarding(step = 0) {
  inSetup = true;
  $('#obPfUrl').value = settings.pfUrl || '';
  $('#obSpUrl').value = settings.spUrl || '';
  obShow(step);
  $('#onboard').classList.remove('hidden');
}
async function finishOnboarding() {
  if (obGate(4)) { obShow(4); return; } // safety: can't finish unverified
  await window.api.saveSettings({ setupComplete: true, setupVersion: SETUP_VERSION });
  inSetup = false;
  $('#onboard').classList.add('hidden');
  await refresh();
  toast("All set — PracticeSync is ready.");
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
  toast('Switch to Chrome. If the page isn’t open, type the address there and press Enter — then follow the red bar.');
  const res = await window.api.teach(target, url);
  $(btn).disabled = false; $(btn).textContent = 'Open & show the fields';
  if (res && res.ok) {
    toast('Got it ✓');
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
  const names = parsePatientNames($('#obPatient') && $('#obPatient').value);
  if (settings.pfSelectors && settings.pfSelectors.searchBox && !names.length) {
    toast('Type a patient name first.'); return;
  }
  await window.api.saveSettings({ patientNames: names });
  $('#obVerifyBtn').disabled = true; $('#obVerifyBtn').textContent = 'Pulling…';
  const res = await window.api.runSync({ count: 2, dryRun: true, patientNames: names });
  $('#obVerifyBtn').disabled = false; $('#obVerifyBtn').textContent = "Pull this patient's visits";
  renderSyncResult($('#obResult'), res);
  obVerified = !!(res && res.ok && (res.planned || []).length > 0);
  obShow(obStep);
});

$('#replayTutorial').addEventListener('click', () => openOnboarding());

/* ------------------------------- updates -------------------------------- */
$('#checkUpdateBtn').addEventListener('click', async () => {
  $('#updateState').textContent = 'Checking…';
  await window.api.checkForUpdates();
});
$('#installUpdateBtn').addEventListener('click', () => window.api.installUpdate());
window.api.onUpdateStatus((s) => {
  if (!s) return;
  const el = $('#updateState');
  const install = $('#installUpdateBtn');
  const map = {
    checking: 'Checking for updates…',
    none: "You're on the latest version.",
    available: `Version ${s.version || ''} is available.`,
    error: 'Couldn’t check right now — try again later.',
  };
  el.textContent = map[s.phase] || '';
  install.classList.toggle('hidden', s.phase !== 'available');
});

/* -------------------------------- events -------------------------------- */
window.api.onRunFinished(() => refresh());
window.api.onRunStatus((s) => { if (s && s.phase === 'running') $('#statusIcon').textContent = '⏳'; });

/* --------------------------------- init --------------------------------- */
(async () => {
  await refresh();
  // Force the full setup on first run AND after an update (version bump), and
  // whenever the screens aren't taught — so the app can never run on wrong data.
  const needsSetup = !settings.setupComplete
    || (settings.setupVersion || 0) < SETUP_VERSION
    || !settings.pfSelectors || !settings.spSelectors;
  if (needsSetup) openOnboarding();
})();
