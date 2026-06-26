'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell } = require('electron');

const store = require('./store');
const { runSync } = require('./automation');
const { parseRoster, appleIntelligenceAvailable, detectEngines, appleHelperPath } = require('./ai');
const { DEMO_MAIN_DOCTORS, DEMO_PROVIDERS, makeProvider, makeMainDoctor } = require('./model');
const { teach, runSiteDemo } = require('./liveEngine');
const { startSheetServer } = require('./demoSheet');
const recorder = require('./recorder');
const { Scheduler } = require('./scheduler');
const updater = require('./updater');

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
    // Names come from this run (overrides) or fall back to the saved list.
    const patientNames = Array.isArray(overrides.patientNames) && overrides.patientNames.length
      ? overrides.patientNames
      : (settings.patientNames || []);

    if ((settings.providers || []).length === 0) {
      return { ok: false, error: 'Add your doctors and their codes first.', at: nowISO() };
    }
    if (!settings.pfSelectors) {
      return { ok: false, error: 'Teach the Practice Fusion screen first.', at: nowISO() };
    }
    // When the search box was taught, the app looks patients up by name — so it
    // needs at least one name to know who to sync.
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

  ipcMain.handle('run:sync', async (_e, opts) => performSync('manual', opts || {}));
  ipcMain.handle('run:now', async () => scheduler.runNow('manual'));

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
          { key: 'searchBox', label: 'Click the patient SEARCH box, type a patient name, then press Next' },
          { key: 'firstResult', label: 'Click the matching PATIENT in the results (Next opens them)', allowDefault: true },
          { key: 'patientSelector', label: 'Click the PATIENT NAME at the top of their chart' },
          { key: 'rowSelector', label: 'Click one VISIT row in the list' },
          { key: 'doctorSelector', label: 'Click the DOCTOR name inside that visit row', relativeTo: 'rowSelector' },
          { key: 'dateSelector', label: 'Click the DATE inside that visit row', relativeTo: 'rowSelector' },
        ]
      : [
          { key: 'newApptButton', label: 'Click the "New appointment" button (Next opens the form)', allowDefault: true },
          { key: 'patientField', label: 'Click the PATIENT NAME field' },
          { key: 'mainDoctorField', label: 'Click the CLINICIAN (main doctor) field' },
          { key: 'dateField', label: 'Click the DATE field' },
          { key: 'codeField', label: 'Click the CPT CODE / service field' },
          { key: 'unitsField', label: 'Click the UNITS field' },
          { key: 'modifierField', label: 'Click the MODIFIER field (GP/GO/GN and 59 go here)' },
          { key: 'addServiceBtn', label: 'Click the "Add service / Add line" button — or Skip if there isn\'t one', optional: true },
          { key: 'saveButton', label: 'Click the SAVE button' },
        ];
    // Each click is screenshotted into a per-session folder (with a gallery)
    // so the user can see exactly what they taught and spot anything wrong.
    const stamp = nowISO().replace(/[:.]/g, '-');
    const capturesDir = path.join(app.getPath('userData'), 'teach-captures', `${target}-${stamp}`);
    try {
      const res = await teach({ userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir, url, steps, capturesDir });
      if (!res.ok) return res;
      if (target === 'pf') store.save({ pfUrl: url, pfSelectors: res.selectors });
      else store.save({ spUrl: url, spSelectors: res.selectors });
      // Open the screenshots folder so the user can review what was captured.
      if (res.captureCount) { try { shell.openPath(res.capturesDir); } catch {} }
      return { ok: true, selectors: res.selectors, capturesDir: res.capturesDir, captureCount: res.captureCount };
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
    task: (trigger) => performSync(trigger === 'schedule' ? 'schedule' : 'manual'),
    onStatus: (s) => sendToRenderer('run-status', s),
  });
  const settings = store.load();
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
