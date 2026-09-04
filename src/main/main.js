'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell } = require('electron');

const store = require('./store');
const { runSync } = require('./automation');
const { parseRoster, appleIntelligenceAvailable, detectEngines, appleHelperPath } = require('./ai');
const { DEMO_MAIN_DOCTORS, DEMO_PROVIDERS, makeProvider, makeMainDoctor } = require('./model');
const { teach, runSiteDemo } = require('./liveEngine');
const { runFullSync, expandDates } = require('./sync');
const presets = require('./presets');
const { loginSimplePractice } = require('./login');
const { startSheetServer } = require('./demoSheet');
const recorder = require('./recorder');
const { Scheduler } = require('./scheduler');
const updater = require('./updater');
const mailer = require('./mailer');

let mainWindow = null;
let tray = null;
const scheduler = new Scheduler();
const APP_NAME = 'Hope Assistant';

function nowISO() { return new Date().toISOString(); }

/** Friendly desktop notification when a run finishes (the one macOS permission
 *  the app actually asks for — and only the first time). Always best-effort. */
function notify(body) {
  try { if (Notification.isSupported()) new Notification({ title: 'Hope Assistant', body }).show(); } catch {}
}

/** One alert per missing patient, gated by the "Alert on missing patient"
 *  setting. Never fires for agency/org rows — those are dropped before
 *  booking is even attempted (isNonPatient), so this is patients only.
 *  Persisted to the Alerts screen (a desktop notification alone is easy to
 *  miss if no one's looking at the moment it fires) AND shown as a native
 *  notification. Capped at the most recent 200 so the file never grows
 *  unbounded. */
const MAX_ALERTS = 200;
function notifyMissingPatient(name, date) {
  const settings = store.load();
  if (settings.alertOnMissingPatient === false) return;
  const entry = { id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), patientName: name, date: date || '', at: nowISO() };
  const alerts = [entry, ...(settings.alerts || [])].slice(0, MAX_ALERTS);
  store.save({ alerts });
  sendToRenderer('alert-added', entry);
  notify(`Patient not found in SimplePractice: "${name}" — sync skipped booking them.`);
  if (settings.emailAlertsEnabled) emailMissingPatient(name, date);
}

/** Mirrors the desktop alert into an email, through the agency's own mailbox
 *  (see mailer.js) — best-effort: a failed/unconfigured send never breaks the
 *  sync, it just records the error for the Alerts screen to show. */
async function emailMissingPatient(name, date) {
  try {
    const settings = store.load();
    const config = mailer.configFrom(settings, store.getCreds().smtp);
    const subject = `Hope Assistant: patient not found — ${name}`;
    const body = `Hope Assistant could not find "${name}" in SimplePractice while booking${date ? ` (appointment date ${date})` : ''}.\n\nNothing was booked for them — check the name in SimplePractice, or add/correct it, then re-run the sync.`;
    await mailer.send({ subject, body, config });
    store.save({ emailLastSentAt: nowISO(), emailLastError: null, emailLastErrorAt: null });
  } catch (e) {
    store.save({ emailLastError: (e && e.message) || String(e), emailLastErrorAt: nowISO() });
  }
}

/** Safely send to the renderer (no-op if the window is gone/destroyed). */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ----------------------------- the core run ----------------------------- */
/**
 * One sync: read REAL visits from Practice Fusion, plan each appointment from
 * the doctor roster, create them in SimplePractice. Live data only.
 * `overrides.dryRun` reads-and-plans without booking (used to verify setup).
 */
async function performSync(trigger = 'manual', overrides = {}) {
  try {
    const settings = store.load();
    const dryRun = overrides.dryRun === true;
    // The run is DATE-driven: read every appointment on the chosen day's
    // schedule. `date` is what the user picked (also the date booked in
    // SimplePractice). Patient names remain only for the legacy search model.
    const date = String(overrides.date || settings.runDate || '').trim();
    const patientNames = Array.isArray(overrides.patientNames) && overrides.patientNames.length
      ? overrides.patientNames
      : (settings.patientNames || []);

    if ((settings.providers || []).length === 0) {
      return { ok: false, error: 'Add your doctors and their codes first.', at: nowISO() };
    }
    if (!settings.pfSelectors) {
      return { ok: false, error: 'Teach the Practice Fusion screen first.', at: nowISO() };
    }
    // Legacy search model only: when a search box was taught, names are required.
    if (settings.pfSelectors.searchBox && patientNames.length === 0) {
      return { ok: false, error: 'Add at least one patient name on the Connection screen first.', at: nowISO() };
    }
    // Real booking (not a verify dry-run) requires the full, completed setup.
    if (!dryRun) {
      if (!settings.setupComplete) return { ok: false, error: 'Finish the setup first.', at: nowISO() };
      if (!settings.spSelectors) return { ok: false, error: 'Teach the SimplePractice screen first.', at: nowISO() };
    }

    // Mirror every live step into the app window so the bosses can watch
    // progress there too (in addition to the visible cursor in Chrome).
    sendToRenderer('live-step', { text: dryRun ? 'Starting a read-only check…' : 'Starting the sync…', at: nowISO(), reset: true });
    const onStep = (text) => sendToRenderer('live-step', { text, at: nowISO() });

    const result = await runSync({
      providers: settings.providers,
      mainDoctors: settings.mainDoctors,
      count: overrides.count || 6,
      dryRun,
      patientNames,
      date,
      onStep,
      bookedKeys: settings.bookedKeys || [],
      live: {
        userDataDir: settings.chromeUserDataDir,
        profileDir: settings.chromeProfileDir,
        pfUrl: settings.pfUrl,
        pfSelectors: settings.pfSelectors,
        spUrl: settings.spUrl,
        spSelectors: settings.spSelectors,
        spMode: settings.spMode,
      },
    });
    result.at = nowISO();
    result.mode = 'live';
    result.trigger = trigger;

    // Persist only a sanitized SUMMARY — never patient rows (no PHI on disk).
    const summary = {
      ok: result.ok, at: result.at, mode: 'live', trigger, dryRun: result.dryRun,
      created: result.created, unmatched: result.unmatched, skipped: result.skipped, failed: result.failed,
      error: result.error,
    };
    const patch = { lastRun: result.at, lastResult: summary };
    if (Array.isArray(result.bookedKeys) && result.newlyBooked && result.newlyBooked.length) patch.bookedKeys = result.bookedKeys;
    store.save(patch);
    refreshTray();
    sendToRenderer('run-finished', result);
    if (!dryRun) {
      if (result.ok) notify(result.created ? `Booked ${result.created} appointment${result.created === 1 ? '' : 's'}${result.unmatched ? ` · ${result.unmatched} not recognized` : ''} ✓` : 'No new appointments to book.');
      else notify('Sync needs attention — open Hope Assistant to see why.');
    }
    return result;
  } catch (err) {
    const result = { ok: false, error: 'Something went wrong during the sync. Please try again.', at: nowISO() };
    try { store.save({ lastRun: result.at, lastResult: result }); refreshTray(); } catch {}
    sendToRenderer('run-finished', result); // null-safe (window may be gone)
    return result;
  }
}

/**
 * The real automatic/manual sync: a ROLLING WINDOW of the next N days
 * (today … today+N-1, N = syncDaysAhead, default 7). Each run re-checks the
 * future days, so appointments added later get picked up; the SimplePractice
 * calendar de-dup means nothing is ever booked twice.
 */
function mdy(d) { return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`; }
async function performWindowSync(trigger = 'manual') {
  try {
    const s = store.load();
    const creds = store.getCreds();
    if (!creds.practiceFusion.password || !creds.simplePractice.password) {
      const r = { ok: false, error: 'Add your Practice Fusion and SimplePractice logins on the Connection screen first.', at: nowISO() };
      sendToRenderer('run-finished', r); return r;
    }
    const n = Math.max(1, Math.min(31, Number(s.syncDaysAhead) || 7));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = [];
    for (let i = 0; i < n; i++) { const d = new Date(today); d.setDate(d.getDate() + i); dates.push(mdy(d)); }
    sendToRenderer('live-step', { text: `${trigger === 'schedule' ? 'Morning auto-sync' : 'Sync'} — checking the next ${n} day(s): ${dates[0]} → ${dates[dates.length - 1]}…`, at: nowISO(), reset: true });
    const onStep = (text) => sendToRenderer('live-step', { text, at: nowISO() });
    const providers = (s.providers && s.providers.length) ? s.providers : DEMO_PROVIDERS;
    const mainDoctors = (s.mainDoctors && s.mainDoctors.length) ? s.mainDoctors : DEMO_MAIN_DOCTORS;
    const res = await runFullSync({ secrets: creds, dates, providers, mainDoctors, selfPayClients: s.selfPayClients || [], save: true, overrides: s.spFieldOverrides, onStep, onMissingPatient: notifyMissingPatient });
    res.at = nowISO();
    store.save({ lastRun: res.at, lastResult: { ok: res.ok, at: res.at, mode: 'live', trigger, created: res.booked || 0, skipped: res.skipped || 0, failed: res.failed || 0, unmatched: res.unmatched || 0, error: res.error } });
    refreshTray();
    sendToRenderer('run-finished', res);
    if (res.ok) notify(`Synced the next ${n} days — booked ${res.booked || 0}, ${res.skipped || 0} already there${res.failed ? `, ${res.failed} need attention` : ''} ✓`);
    else notify('Sync needs attention — open Hope Assistant to see why.');
    return res;
  } catch (err) {
    const r = { ok: false, error: 'Something went wrong during the sync. Please try again.', at: nowISO() };
    sendToRenderer('run-finished', r); return r;
  }
}

/* ------------------------------- the window ------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980, height: 820, minWidth: 820, minHeight: 600,
    show: false, titleBarStyle: 'hiddenInset', backgroundColor: '#0f1422',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.on('did-create-window', (w) => w.close()); // deny child windows
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* -------------------------------- the tray ------------------------------- */
function trayImage() {
  // A real monochrome "sync" glyph (generated by build/make-icon.js). As a
  // template image, macOS auto-tints it for light/dark menu bars.
  const img = nativeImage.createFromBuffer(Buffer.from(require('./trayIcon'), 'base64'));
  const sized = img.isEmpty() ? img : img.resize({ width: 18, height: 18 });
  if (!sized.isEmpty()) sized.setTemplateImage(true);
  return sized;
}

function refreshTray() {
  if (!tray) return;
  const last = store.load().lastResult;
  let statusLine = 'No sync yet';
  if (last && last.ok) statusLine = `Last sync: ${last.created} appointment(s)${last.unmatched ? `, ${last.unmatched} unmatched` : ''}`;
  else if (last && !last.ok) statusLine = 'Last sync needs attention';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: statusLine, enabled: false },
    { type: 'separator' },
    { label: 'Sync now', click: () => scheduler.runNow('manual') },
    { label: 'Check for updates…', click: () => updater.check({ onStatus: (s) => sendToRenderer('update-status', s) }) },
    { label: 'Open window', click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`${APP_NAME} — ${statusLine}`);
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    refreshTray();
  } catch {
    tray = null;
    if (mainWindow) mainWindow.show();
  }
}

/* -------------------------------- IPC API -------------------------------- */
function registerIpc() {
  ipcMain.handle('settings:get', () => {
    const s = store.load();
    return { ...s, hasAIKey: store.hasAIKey(), appleAvailable: appleIntelligenceAvailable(), appVersion: app.getVersion() };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const next = store.save(patch || {});
    if (patch && typeof patch.schedule === 'string') {
      scheduler.setMode(patch.schedule);
      applyLoginItem(patch.schedule);
    }
    refreshTray();
    return next;
  });

  ipcMain.handle('ai:set', (_e, { provider }) => {
    try {
      store.save({ aiProvider: provider || 'auto' });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not save the AI engine setting.' };
    }
  });

  // Report which engines are usable right now (local Gemma / Apple Intelligence
  // / built-in), so the UI can show the user what it will use.
  ipcMain.handle('ai:detect', async () => {
    try { return await detectEngines(); }
    catch { return { ollama: { available: false, model: null, models: [] }, apple: false, builtin: true }; }
  });

  // Parse the free text a user typed into structured doctor entries.
  ipcMain.handle('roster:parse', async (_e, { text }) => {
    const s = store.load();
    const res = await parseRoster({ text, mains: s.mainDoctors || [], provider: s.aiProvider || 'none' });
    return res;
  });

  // Save the roster (main doctors + providers + the raw text for re-editing).
  ipcMain.handle('roster:save', (_e, { mainDoctors, providers, rosterText }) => {
    const cur = store.load();
    return store.save({
      // Normalize through the model so codes (text) become structured {code,units,modifiers}.
      mainDoctors: Array.isArray(mainDoctors) ? mainDoctors.map(makeMainDoctor) : cur.mainDoctors,
      providers: Array.isArray(providers) ? providers.map(makeProvider) : cur.providers,
      rosterText: typeof rosterText === 'string' ? rosterText : cur.rosterText,
    });
  });

  // Pre-fill the doctor roster from our records so the user can review + save
  // it instead of retyping (it's their real roster, not patient data).
  ipcMain.handle('demo:load', () => {
    return store.save({ mainDoctors: DEMO_MAIN_DOCTORS, providers: DEMO_PROVIDERS });
  });

  // "Test drive": read rows from a real page and type them into the bundled
  // sheet, with the visible cursor — a self-contained demo of the engine.
  ipcMain.handle('demo:run-site', async (_e, opts) => {
    const { sourceUrl, colA = 'Item', colB = 'Detail', rows = 6 } = opts || {};
    const onStep = (text) => sendToRenderer('demo-step', { text, at: nowISO() });
    let server;
    try {
      sendToRenderer('demo-step', { text: 'Starting the test drive…', at: nowISO(), reset: true });
      server = await startSheetServer();
      const destUrl = `${server.url}?a=${encodeURIComponent(colA)}&b=${encodeURIComponent(colB)}`;
      const s = store.load();
      const res = await runSiteDemo({
        userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir,
        sourceUrl, destUrl, rows, onStep,
      });
      sendToRenderer('demo-step', { text: res.ok ? 'Test drive finished.' : (res.error || 'Stopped.'), at: nowISO(), done: true });
      return res;
    } catch (err) {
      return { ok: false, error: 'The test drive could not run. Make sure Google Chrome is installed.' };
    } finally {
      if (server) try { await server.close(); } catch {}
    }
  });

  // ---- Workflow recorder: record a workflow once, review/mark it, replay it ----
  ipcMain.handle('record:start', async (_e, { startUrl } = {}) => {
    const s = store.load();
    const stamp = nowISO().replace(/[:.]/g, '-');
    const capturesDir = path.join(app.getPath('userData'), 'recordings', `rec-${stamp}`);
    return recorder.startRecording({
      startUrl, capturesDir,
      userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir,
      onEvent: (ev) => sendToRenderer('record-event', ev),
    });
  });
  ipcMain.handle('record:stop', async () => recorder.stopRecording());
  ipcMain.handle('record:save', (_e, { name, steps }) => {
    const cur = store.load();
    const wf = { id: 'wf_' + Date.now().toString(36), name: String(name || 'Untitled workflow').slice(0, 80), steps: Array.isArray(steps) ? steps : [], createdAt: nowISO() };
    store.save({ workflows: [...(cur.workflows || []), wf] });
    return { ok: true, workflow: wf };
  });
  ipcMain.handle('record:list', () => ({ ok: true, workflows: store.load().workflows || [] }));
  ipcMain.handle('record:delete', (_e, { id }) => {
    const cur = store.load();
    store.save({ workflows: (cur.workflows || []).filter((w) => w.id !== id) });
    return { ok: true };
  });
  ipcMain.handle('record:replay', async (_e, { id, steps } = {}) => {
    const s = store.load();
    const wf = id ? (s.workflows || []).find((w) => w.id === id) : null;
    const useSteps = (wf && wf.steps) || steps || [];
    sendToRenderer('record-event', { type: 'replay', text: 'Starting replay…', reset: true });
    const res = await recorder.replayWorkflow({
      steps: useSteps, userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir,
      onStep: (text) => sendToRenderer('record-event', { type: 'replay', text }),
    });
    sendToRenderer('record-event', { type: 'replay', text: res.ok ? 'Replay finished ✓' : (res.error || 'Replay stopped.'), done: true });
    return res;
  });

  // Alerts screen: patients the SimplePractice search couldn't find while booking.
  ipcMain.handle('alerts:list', () => store.load().alerts || []);
  ipcMain.handle('alerts:clear', () => { store.save({ alerts: [] }); return []; });

  // Email alerts (same mailbox-of-your-own approach as Hope Reminder). The
  // Test button proves the setup works before the real thing depends on it.
  ipcMain.handle('email:test', async () => {
    try {
      const settings = store.load();
      const config = mailer.configFrom(settings, store.getCreds().smtp);
      await mailer.send({
        subject: 'Hope Assistant: test email',
        body: 'This is a test message — email alerts are working.\n\nYou will get an email like this whenever a sync can\'t find a patient in SimplePractice.',
        config,
      });
      store.save({ emailLastSentAt: nowISO(), emailLastError: null, emailLastErrorAt: null });
      return { ok: true };
    } catch (e) {
      const error = (e && e.message) || String(e);
      store.save({ emailLastError: error, emailLastErrorAt: nowISO() });
      return { ok: false, error };
    }
  });

  ipcMain.handle('run:sync', async (_e, opts) => performSync('manual', opts || {}));
  ipcMain.handle('run:now', async () => scheduler.runNow('manual'));

  // --- Demo-account sync (Practice Fusion → SimplePractice), wired to the engine ---
  // First-run helper: open SimplePractice's booking form and let the user POINT
  // at the fields that aren't in the demo (units + the GP/GO/GN and 59 modifier
  // boxes, etc.). Saves a folder to the Desktop (HTML + screenshots + the
  // selectors found) and applies them — non-blocking, his mouse stays free.
  ipcMain.handle('capture:fields', async () => {
    const s = store.load();
    const creds = store.getCreds();
    if (!creds.simplePractice || !creds.simplePractice.password) return { ok: false, error: 'Add your SimplePractice login on the Connection screen first.' };
    const stamp = nowISO().replace(/[:.]/g, '-');
    const dir = path.join(app.getPath('desktop'), `Hope Assistant Setup ${stamp}`);
    const onStep = (t) => sendToRenderer('live-step', { text: t, at: nowISO() });
    sendToRenderer('live-step', { text: 'Opening SimplePractice to capture the booking fields…', at: nowISO(), reset: true });
    const steps = [
      { key: 'unitsField', label: 'The UNITS box (how many units a service line is)' },
      { key: 'modifierField', label: 'The first MODIFIER box — where GP / GO / GN goes' },
      { key: 'modifier2Field', label: 'The SECOND modifier box — where “59” goes (Skip if you don’t use it)', optional: true },
      { key: 'clinicianPick', label: 'The CLINICIAN field — to pick the main doctor (Skip if it’s already set)', optional: true },
      { key: 'locationPick', label: 'The LOCATION field (Skip if it’s already correct)', optional: true },
    ];
    try {
      const res = await teach({
        userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir,
        url: presets.SP.newApptUrl, steps, capturesDir: dir, savePageHtml: true,
        loginFirst: (page) => loginSimplePractice(page, creds.simplePractice, { onStep, visual: false }),
        gate: { text: '🩺 <b>Open a new appointment and pick any client + a service</b>, so the Units and Modifier boxes appear. Then click below and point at each box I name.', btn: 'I have a client + service showing — Start pointing ▶' },
      });
      if (!res.ok) return res;
      // Save what we found so booking can use it (merged over the built-ins).
      const overrides = { ...(s.spFieldOverrides || {}) };
      const map = { unitsField: 'unitsField', modifierField: 'modifierInputs', modifier2Field: 'modifier2', clinicianPick: 'clinicianOpen', locationPick: 'locationTrigger' };
      for (const [k, v] of Object.entries(res.selectors || {})) if (v) overrides[map[k] || k] = v;
      store.save({ spFieldOverrides: overrides });
      try { shell.openPath(res.capturesDir); } catch {}
      onStep(`Saved to your Desktop → “${path.basename(dir)}”. Send me that folder and I’ll lock it in.`);
      return { ok: true, capturesDir: res.capturesDir, captureCount: res.captureCount, folder: path.basename(dir) };
    } catch (e) { return { ok: false, error: 'The capture could not run. Make sure Google Chrome is installed.' }; }
  });
  ipcMain.handle('creds:status', () => store.credsStatus());
  ipcMain.handle('creds:save', (_e, creds) => {
    try { store.setCreds(creds || {}); return { ok: true, status: store.credsStatus() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // Run the full Practice Fusion → SimplePractice sync over a date (or range).
  // save=false fills the forms without saving (a safe dry run).
  ipcMain.handle('sync:run', async (_e, opts = {}) => {
    const s = store.load();
    const creds = store.getCreds();
    if (!creds.practiceFusion.password || !creds.simplePractice.password) {
      return { ok: false, error: 'Add your Practice Fusion and SimplePractice logins first.' };
    }
    const dates = expandDates(opts.start, opts.end || opts.start);
    if (!dates.length) return { ok: false, error: 'Pick a date (or a start–end range) first.' };
    const providers = (s.providers && s.providers.length) ? s.providers : DEMO_PROVIDERS;
    const mainDoctors = (s.mainDoctors && s.mainDoctors.length) ? s.mainDoctors : DEMO_MAIN_DOCTORS;
    sendToRenderer('live-step', { text: `Starting sync for ${dates.join(', ')}…`, at: nowISO(), reset: true });
    const onStep = (text) => sendToRenderer('live-step', { text, at: nowISO() });
    const res = await runFullSync({ secrets: creds, dates, providers, mainDoctors, selfPayClients: s.selfPayClients || [], save: !!opts.save, overrides: s.spFieldOverrides, onStep, onMissingPatient: notifyMissingPatient });
    res.at = nowISO();
    sendToRenderer('run-finished', res);
    if (res.ok) notify(opts.save ? `Booked ${res.booked} · skipped ${res.skipped}${res.failed ? ' · ' + res.failed + ' failed' : ''}` : `Dry run: ${res.planned.length} would book`);
    return res;
  });

  // Manual update via GitHub Releases (works unsigned): check, then open the
  // new .dmg for the user to install.
  ipcMain.handle('update:check', async () => {
    await updater.check({ onStatus: (s) => sendToRenderer('update-status', s) });
    return { ok: true };
  });
  ipcMain.handle('update:install', async () => { await updater.downloadAndOpen({ onStatus: (s) => sendToRenderer('update-status', s) }); return { ok: true }; });

  // Teach Mode: open the given page and let the user click each field once.
  // Saves the captured selectors so the app reuses them on every run.
  ipcMain.handle('teach:run', async (_e, { target, url }) => {
    const s = store.load();
    if (!url) return { ok: false, error: 'Enter the page address first.' };
    const steps = target === 'pf'
      ? [
          // The real Practice Fusion flow is READ-ONLY, on the SCHEDULE screen
          // (under Home): the user opens the day and the app reads every
          // appointment — each is a patient + their provider. No searching, no
          // clicking. The user points at just THREE things on ONE appointment;
          // the app figures out the repeating row itself (infer:'schedule').
          { key: 'patientSelector', label: 'A PATIENT’s name on the Schedule', hint: 'Open the Schedule (under the Home icon) for your day, then point at one patient’s name.' },
          { key: 'dateSelector', label: 'That same patient’s DATE or time', hint: 'The date/time shown right with that patient. If there’s no per-appointment date, Skip it.', optional: true },
          { key: 'doctorSelector', label: 'That same patient’s PROVIDER (the diagnosing / small doctor)', hint: 'The provider shown for that same appointment.' },
        ]
      : [
          // SimplePractice is a calendar, but the app books through the New-Appointment
          // dialog (where Clinician + Date are FIELDS) rather than clicking a grid
          // cell — same result, far more reliable. Teach the button/“+” that opens
          // that dialog, then point out each field inside it. The app picks the
          // clinician (main doctor) from your roster, so you don’t click columns.
          { key: 'newApptButton', label: 'The “+” / “New appointment” button that opens the booking form', hint: 'Teach the button that opens the appointment dialog — not an empty calendar slot. Next opens it for you.', allowDefault: true },
          { key: 'patientField', label: 'The CLIENT / patient name field' },
          { key: 'mainDoctorField', label: 'The CLINICIAN field (this is the main doctor)', hint: 'The app fills this with the main doctor your roster maps the patient’s doctor to.' },
          { key: 'dateField', label: 'The DATE field' },
          { key: 'codeField', label: 'The CPT CODE / service field' },
          { key: 'unitsField', label: 'The UNITS field' },
          { key: 'modifierField', label: 'The MODIFIER field (the 2-letter GP/GO/GN and the 2-digit 59 go here)' },
          { key: 'addServiceBtn', label: 'The “Add service / Add line” button — or Skip if there isn’t one', hint: 'This lets the app add a second, third… service line when a doctor provides more than one.', optional: true },
          { key: 'saveButton', label: 'The SAVE button' },
        ];
    // Each click is screenshotted into a per-session folder (with a gallery)
    // so the user can see exactly what they taught and spot anything wrong.
    const stamp = nowISO().replace(/[:.]/g, '-');
    const capturesDir = path.join(app.getPath('userData'), 'teach-captures', `${target}-${stamp}`);
    try {
      const res = await teach({ userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir, url, steps, capturesDir, infer: target === 'pf' ? 'schedule' : null });
      if (!res.ok) return res;
      if (target === 'pf') store.save({ pfUrl: url, pfSelectors: res.selectors });
      else store.save({ spUrl: url, spSelectors: res.selectors });
      // Open the screenshots folder so the user can review what was captured.
      if (res.captureCount) { try { shell.openPath(res.capturesDir); } catch {} }
      return { ok: true, selectors: res.selectors, capturesDir: res.capturesDir, captureCount: res.captureCount, inference: res.inference };
    } catch {
      return { ok: false, error: 'Teach Mode could not open the page. Make sure Google Chrome is installed.' };
    }
  });
}

function applyLoginItem(schedule) {
  try {
    app.setLoginItemSettings({ openAtLogin: schedule === '6h' || schedule === 'daily', openAsHidden: true });
  } catch {}
}

function maybeCatchUp() {
  const s = store.load();
  const intervalMs = { '6h': 6 * 3600e3, daily: 24 * 3600e3 }[s.schedule];
  if (!intervalMs) return;
  const last = s.lastRun ? Date.parse(s.lastRun) : 0;
  if (!last || Date.now() - last >= intervalMs) scheduler.runNow('schedule');
}

/* ------------------------------- lifecycle ------------------------------- */
app.on('window-all-closed', () => { /* stay alive in the menu bar */ });
// Cmd-Q from the app menu should really quit (the window 'close' handler hides
// instead of closing, so without this the app can feel unquittable).
app.on('before-quit', () => { app.isQuitting = true; });

// Single instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

/** Best-effort: clear the quarantine flag macOS puts on the bundled Apple
 *  Intelligence helper when the app is downloaded unsigned, so it can run on the
 *  client's Mac without a manual step. Harmless if it's not quarantined; if it
 *  fails, the app just falls back to local Gemma / the built-in parser. */
function dequarantineHelper() {
  if (process.platform !== 'darwin') return;
  try {
    const { execFile } = require('child_process');
    const p = appleHelperPath();
    if (p && require('fs').existsSync(p)) execFile('/usr/bin/xattr', ['-d', 'com.apple.quarantine', p], () => {});
  } catch {}
}

app.whenReady().then(() => {
  dequarantineHelper();
  registerIpc();
  scheduler.configure({
    task: (trigger) => performWindowSync(trigger === 'schedule' ? 'schedule' : 'manual'),
    onStatus: (s) => sendToRenderer('run-status', s),
  });
  const settings = store.load();
  // First run for this practice: pre-load the doctor roster so Doctors & Codes
  // shows the doctors (they're exactly what the sync already uses). Seeded once —
  // never re-added if the user later edits or clears it.
  if (!settings.rosterSeeded && !(settings.providers && settings.providers.length)) {
    try { store.save({ providers: DEMO_PROVIDERS, mainDoctors: DEMO_MAIN_DOCTORS, rosterSeeded: true }); } catch {}
  }
  scheduler.setMode(settings.schedule || 'off');
  applyLoginItem(settings.schedule || 'off');

  createTray();
  createWindow();
  maybeCatchUp();

  // Boot self-check: `PS_BOOTCHECK=1 npm start` loads everything, confirms the
  // window is ready, prints a marker, and exits — a fast smoke test that the app
  // launches without touching anything.
  if (process.env.PS_BOOTCHECK) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => { console.log('PS_BOOT_OK'); app.exit(0); }, 800);
    });
  }
  if (app.isPackaged) updater.initAutoUpdates({ onStatus: (s) => sendToRenderer('update-status', s) });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});
