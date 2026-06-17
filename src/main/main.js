'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');

const store = require('./store');
const { runSync } = require('./automation');
const { parseRoster, appleIntelligenceAvailable } = require('./ai');
const { DEMO_MAIN_DOCTORS, DEMO_PROVIDERS, makeProvider, makeMainDoctor } = require('./model');
const { teach } = require('./liveEngine');
const { Scheduler } = require('./scheduler');
const updater = require('./updater');

let mainWindow = null;
let tray = null;
const scheduler = new Scheduler();
const APP_NAME = 'PracticeSync';

function nowISO() { return new Date().toISOString(); }

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

    const result = await runSync({
      providers: settings.providers,
      mainDoctors: settings.mainDoctors,
      count: overrides.count || 6,
      dryRun,
      patientNames,
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
    return result;
  } catch (err) {
    const result = { ok: false, error: 'Something went wrong during the sync. Please try again.', at: nowISO() };
    try { store.save({ lastRun: result.at, lastResult: result }); refreshTray(); } catch {}
    if (mainWindow) mainWindow.webContents.send('run-finished', result);
    return result;
  }
}

/* ------------------------------- the window ------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960, height: 740, minWidth: 820, minHeight: 600,
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
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const img = nativeImage.createFromBuffer(png);
  if (!img.isEmpty()) img.setTemplateImage(true);
  return img;
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
    tray.setTitle(` ${APP_NAME}`);
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
    return { ...s, hasAIKey: store.hasAIKey(), appleAvailable: appleIntelligenceAvailable() };
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

  ipcMain.handle('ai:set', (_e, { provider, apiKey }) => {
    try {
      store.save({ aiProvider: provider || 'none' });
      if (typeof apiKey === 'string') store.setAIKey(apiKey);
      return { ok: true, hasAIKey: store.hasAIKey() };
    } catch {
      return { ok: false, error: 'Could not securely save your API key on this Mac.' };
    }
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

  ipcMain.handle('run:sync', async (_e, opts) => performSync('manual', opts || {}));
  ipcMain.handle('run:now', async () => scheduler.runNow('manual'));

  // Manual update via GitHub Releases (works unsigned): check, then open the
  // new .dmg for the user to install.
  ipcMain.handle('update:check', async () => {
    await updater.check({ onStatus: (s) => sendToRenderer('update-status', s) });
    return { ok: true };
  });
  ipcMain.handle('update:install', () => { updater.openDownload(); return { ok: true }; });

  // Teach Mode: open the given page and let the user click each field once.
  // Saves the captured selectors so the app reuses them on every run.
  ipcMain.handle('teach:run', async (_e, { target, url }) => {
    const s = store.load();
    if (!url) return { ok: false, error: 'Enter the page address first.' };
    const steps = target === 'pf'
      ? [
          { key: 'searchBox', label: 'the patient SEARCH box — then TYPE a patient name into it' },
          { key: 'firstResult', label: 'the matching PATIENT in the results that appear', allowDefault: true },
          { key: 'patientSelector', label: 'the PATIENT NAME at the top of the page' },
          { key: 'rowSelector', label: 'one visit ROW in the list' },
          { key: 'doctorSelector', label: 'the DOCTOR NAME in that row', relativeTo: 'rowSelector' },
          { key: 'dateSelector', label: 'the DATE in that row', relativeTo: 'rowSelector' },
        ]
      : [
          { key: 'newApptButton', label: 'the "New appointment" button', allowDefault: true },
          { key: 'patientField', label: 'the PATIENT NAME field' },
          { key: 'mainDoctorField', label: 'the CLINICIAN (big doctor) field' },
          { key: 'dateField', label: 'the DATE field' },
          { key: 'codeField', label: 'the CPT CODE / service field' },
          { key: 'unitsField', label: 'the UNITS field' },
          { key: 'modifierField', label: 'the MODIFIER field (where GP/GO/GN and 59 go)' },
          { key: 'saveButton', label: 'the SAVE button' },
        ];
    try {
      const res = await teach({ userDataDir: s.chromeUserDataDir, profileDir: s.chromeProfileDir, url, steps });
      if (!res.ok) return res;
      if (target === 'pf') store.save({ pfUrl: url, pfSelectors: res.selectors });
      else store.save({ spUrl: url, spSelectors: res.selectors });
      return { ok: true, selectors: res.selectors };
    } catch {
      return { ok: false, error: 'Teach Mode could not open the page. Make sure Google Chrome is installed and closed.' };
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

// Single instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

app.whenReady().then(() => {
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
  if (app.isPackaged) updater.initAutoUpdates({ onStatus: (s) => sendToRenderer('update-status', s) });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});
