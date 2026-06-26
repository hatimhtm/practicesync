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
  patientNames: [],         // patients to sync, looked up by NAME (no URLs needed)
  bookedKeys: [],           // visit keys already booked, so live runs never double-book
  workflows: [],            // recorded workflows: [{ id, name, steps:[...], createdAt }]
  schedule: 'off',          // 'off' | '6h' | 'daily'
  lastRun: null,
  lastResult: null,
  setupComplete: false,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function aiKeyPath() {
  return path.join(app.getPath('userData'), 'ai-key.bin');
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

module.exports = { load, save, setAIKey, getAIKey, hasAIKey, DEFAULTS };
