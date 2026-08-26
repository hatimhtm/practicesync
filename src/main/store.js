'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * Settings store for the PracticeFusion → SimplePractice automation.
 *
 * No login passwords are stored: the automation reuses the user's EXISTING
 * browser session, so there's nothing secret to keep here except an optional
 * cloud-AI key (encrypted via Keychain) for the non-default providers.
 */

const DEFAULTS = {
  mainDoctors: [],          // the 3 main doctors (display names)
  providers: [],            // roster: [{ name, mainDoctor, codes:[] }]
  rosterText: '',           // raw text the user typed (kept so they can re-edit)
  aiProvider: 'auto',       // 'auto' (smartest available) | 'apple' | 'ollama' | 'none'
  setupVersion: 0,          // bumped to force re-setup after an update
  // Live connection (the only mode — validated on the client's Mac):
  pfUrl: '',                // Practice Fusion dashboard URL
  pfSelectors: null,        // taught via Teach Mode: { rowSelector, nameSelector, dateSelector, doctorSelector }
  spUrl: '',                // SimplePractice appointment page URL
  spSelectors: null,        // taught: { newApptButton, mainDoctorField, dateField, codeField, saveButton }
  spMode: 'standard',       // 'standard' (screen automation) | 'enterprise' (API)
  chromeProfileDir: 'Default',
  chromeUserDataDir: '',    // blank → liveEngine uses its own dedicated automation profile (runs alongside the user's Chrome; no force-quit)
  patientNames: [],         // legacy search model only: patients looked up by NAME
  runDate: '',              // the day to read off the Practice Fusion schedule (YYYY-MM-DD)
  syncDaysAhead: 7,         // automatic runs sync a rolling window: today … today+N-1
  spFieldOverrides: null,   // first-run capture: SimplePractice field selectors not present in the demo
  selfPayClients: [],       // patients that are ALWAYS self-pay, regardless of appointment type
  rosterSeeded: false,      // whether the built-in doctor roster was pre-loaded on first run
  bookedKeys: [],           // visit keys already booked, so live runs never double-book
  workflows: [],            // recorded workflows: [{ id, name, steps:[...], createdAt }]
  schedule: 'off',          // 'off' | '6h' | 'daily'
  lastRun: null,
  lastResult: null,
  setupComplete: false,
  alertOnMissingPatient: true, // desktop notification when a patient can't be found in SimplePractice (agency/org rows never trigger this)
  alerts: [],               // persisted log of missing-patient alerts: [{ id, patientName, date, at }], newest first
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function aiKeyPath() {
  return path.join(app.getPath('userData'), 'ai-key.bin');
}
function credsPath() {
  return path.join(app.getPath('userData'), 'creds.bin');
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  const dir = path.dirname(settingsPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8'); // atomic write
  fs.renameSync(tmp, settingsPath());
  return next;
}

/** Optional cloud-AI key (encrypted at rest via macOS Keychain). */
function setAIKey(plaintext) {
  if (!plaintext) { try { fs.unlinkSync(aiKeyPath()); } catch {} return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable.');
  fs.writeFileSync(aiKeyPath(), safeStorage.encryptString(plaintext), { mode: 0o600 });
}
function getAIKey() {
  try {
    const buf = fs.readFileSync(aiKeyPath());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '';
  } catch { return ''; }
}
function hasAIKey() {
  try { return fs.statSync(aiKeyPath()).size > 0; } catch { return false; }
}

/**
 * Site logins, encrypted at rest via the macOS Keychain (safeStorage). Stored as
 * one JSON blob: { practiceFusion:{username,password}, simplePractice:{email,password} }.
 * Only the engine ever reads the plaintext; the UI only learns whether each is set.
 */
function setCreds(obj) {
  const cur = getCreds();
  const next = {
    practiceFusion: { ...cur.practiceFusion, ...(obj.practiceFusion || {}) },
    simplePractice: { ...cur.simplePractice, ...(obj.simplePractice || {}) },
  };
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable.');
  fs.writeFileSync(credsPath(), safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
  return next;
}
function getCreds() {
  try {
    const buf = fs.readFileSync(credsPath());
    const obj = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '{}');
    return { practiceFusion: obj.practiceFusion || {}, simplePractice: obj.simplePractice || {} };
  } catch { return { practiceFusion: {}, simplePractice: {} }; }
}
/** What the UI is allowed to know: which logins are filled (never the secrets). */
function credsStatus() {
  const c = getCreds();
  return {
    pf: !!(c.practiceFusion.username && c.practiceFusion.password),
    sp: !!(c.simplePractice.email && c.simplePractice.password),
    pfUsername: c.practiceFusion.username || '',
    spEmail: c.simplePractice.email || '',
  };
}

module.exports = { load, save, setAIKey, getAIKey, hasAIKey, setCreds, getCreds, credsStatus, DEFAULTS };
