'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, dialog } = require('electron');
const fs = require('fs');

// The app is shown as "Hope Billing Assistant", but it keeps its original
// INTERNAL name: Electron derives both the settings folder and the Keychain item
// that encrypts the saved logins from it, so renaming it would orphan both.
// This must run before anything touches app paths or safeStorage.
const INTERNAL_NAME = 'Hope Assistant';
app.setName(INTERNAL_NAME);
app.setPath('userData', path.join(app.getPath('appData'), INTERNAL_NAME));
// Development only: run against a throwaway settings folder (tests of the startup updates).
if (process.env.PS_DATA_DIR) app.setPath('userData', process.env.PS_DATA_DIR);

const store = require('./store');
const { runSync } = require('./automation');
const { parseRoster, appleIntelligenceAvailable, detectEngines, appleHelperPath } = require('./ai');
const { DEMO_MAIN_DOCTORS, DEMO_PROVIDERS, UNIT_CODES, OLD_SPEECH_CODES, parseCodes, formatCodes, makeProvider, makeMainDoctor, ROSTER_VERSION, mergeRoster, normalizeName, seedPrivateServices, clientFor } = require('./model');
const liveEngine = require('./liveEngine');
const { teach, runSiteDemo } = liveEngine;
const { runFullSync, readPfSchedule, expandDates, pfNavigateToDate, waitForDayRows, PROBLEM, REMINDER } = require('./sync');
const chartReview = require('./chartReview');
const presets = require('./presets');
const { loginSimplePractice, loginPracticeFusion, dismissPopups } = require('./login');
const { startSheetServer } = require('./demoSheet');
const recorder = require('./recorder');
const { Scheduler } = require('./scheduler');
const updater = require('./updater');
const mailer = require('./mailer');
const notes = require('./notesFollowUp');

let mainWindow = null;
let tray = null;
const scheduler = new Scheduler();
// Practice Fusion runs share one Chrome profile, so only one opens it at a time.
let chartReviewRunning = false;
let notesRunning = false;
const APP_NAME = 'Hope Billing Assistant'; // display name (see INTERNAL_NAME above)

function nowISO() { return new Date().toISOString(); }

/** Friendly desktop notification when a run finishes (the one macOS permission
 *  the app actually asks for — and only the first time). Always best-effort. */
function notify(body) {
  try { if (Notification.isSupported()) new Notification({ title: APP_NAME, body }).show(); } catch {}
}

/** Every visit a sync couldn't book (and every booking to check) goes to the
 *  Alerts screen — therapist, discipline and reason included, since several
 *  therapists can see one patient on one day. A visit already on the screen isn't
 *  added again by the next run (the rolling window re-reads the same days), so
 *  the list only grows with something new. One desktop notification and, if on,
 *  one summary email per run. Capped at the newest MAX_ALERTS. */
const MAX_ALERTS = 500;
const ALERT_KIND = {
  unmatched: 'Therapist not recognized',
  client_not_found: 'Patient not found in SimplePractice',
  clinician: 'Billing provider could not be set',
  failed: 'Could not be saved',
  unverified: 'Not booked — calendar could not be checked',
  possible_duplicate: 'Not booked — may already be on the calendar',
  cancel_unclear: 'Not booked — cancelled without CX>24, CX<24 or Therapist CX',
  cancelled_on_calendar: 'Cancelled — still on SimplePractice',
  record: 'Not booked — which SimplePractice record',
  service: 'Not booked — private-pay service',
  codes: 'Not booked — codes',
  new_client: 'New client — add their codes',
  check: 'Booked — check it',
};
function alertKey(a) {
  // A new-client reminder is one per client, whatever the day or therapist.
  if (a.kind === 'new_client') return ['', normalizeName(a.patientName).split(' ').sort().join(' '), '', 'new_client'].join('|');
  return [a.date || '', normalizeName(a.patientName), normalizeName(a.therapist), a.kind || 'client_not_found'].join('|');
}
/** New-client reminders whose client is on the Clients list now are done: drop them. */
function withoutResolvedReminders(alerts, clientPayers) {
  return (alerts || []).filter((a) => !(a && a.kind === 'new_client' && clientFor(a.patientName, clientPayers)));
}
/** Save each booking the moment it's made (not at the end of the run), so a crash
 *  or quit mid-run can never lose the record and lead to a second booking.
 *  Entries older than 180 days are dropped. */
const BOOKING_KEEP_MS = 180 * 86400e3;
function recordBooking(key) {
  try {
    const now = Date.now();
    const list = (store.load().bookedVisits || []).filter((b) => b && b.key && now - Date.parse(b.at || 0) < BOOKING_KEEP_MS && b.key !== key);
    list.push({ key, at: new Date(now).toISOString() });
    store.save({ bookedVisits: list });
  } catch {}
}

// Alerts that aren't "not booked": a booking to check, a cancelled visit to delete
// from SimplePractice, a new client to add to the list.
const TODO_KINDS = new Set(['check', 'cancelled_on_calendar', 'new_client']);
function recordRunAlerts(res) {
  if (!res || res.dryRun || !Array.isArray(res.outcomes)) return [];
  const settings = store.load();
  const existing = settings.alerts || [];
  const seen = new Set(existing.map(alertKey));
  const fresh = [];
  const at = nowISO();
  for (const o of res.outcomes) {
    const problem = PROBLEM.has(o.status) || REMINDER.has(o.status);
    const check = o.status === 'booked' && o.warnings && o.warnings.length;
    if (!problem && !check) continue;
    if (o.status === 'new_client' && clientFor(o.patientName, settings.clientPayers || [])) continue;
    const a = {
      id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: problem ? o.status : 'check', patientName: o.patientName, patientId: o.patientId || '',
      therapist: o.therapist || '', discipline: o.discipline || '', billingProvider: o.billingProvider || '',
      date: o.date || '', reason: problem ? o.reason : o.warnings.join(' · '), at,
    };
    if (seen.has(alertKey(a))) continue;
    seen.add(alertKey(a));
    fresh.push(a);
  }
  if (!fresh.length) return [];
  store.save({ alerts: [...fresh, ...existing].slice(0, MAX_ALERTS) });
  sendToRenderer('alert-added', fresh[0]);
  const notBooked = fresh.filter((a) => !TODO_KINDS.has(a.kind)).length;
  const checks = fresh.length - notBooked;
  if (settings.alertOnMissingPatient !== false) {
    notify([notBooked && `${notBooked} visit${notBooked === 1 ? '' : 's'} not booked`, checks && `${checks} to check`].filter(Boolean).join(' · ') + ' — see Alerts.');
  }
  if (settings.emailAlertsEnabled) emailRunAlerts(fresh);
  return fresh;
}

/** One email per run listing what's new on the Alerts screen, through the
 *  agency's own mailbox (see mailer.js) — best-effort: a failed/unconfigured send
 *  never breaks the sync, it just records the error for the Alerts screen. */
async function emailRunAlerts(alerts) {
  try {
    const settings = store.load();
    const config = mailer.configFrom(settings, store.getCreds().smtp);
    const notBooked = alerts.filter((a) => !TODO_KINDS.has(a.kind));
    const checks = alerts.filter((a) => a.kind === 'check');
    const onCalendar = alerts.filter((a) => a.kind === 'cancelled_on_calendar');
    const newClients = alerts.filter((a) => a.kind === 'new_client');
    const line = (a) => `• ${a.date ? `${a.date} — ` : ''}${a.patientName}${a.therapist ? ` — ${a.therapist}${a.discipline ? ` (${a.discipline})` : ''}` : ''}\n  ${a.reason}`;
    const parts = [];
    if (notBooked.length) parts.push(`NOT BOOKED (${notBooked.length}) — nothing was added to SimplePractice for these:\n\n${notBooked.map(line).join('\n\n')}`);
    if (onCalendar.length) parts.push(`CANCELLED, BUT ON SIMPLEPRACTICE (${onCalendar.length}) — delete these there:\n\n${onCalendar.map(line).join('\n\n')}`);
    if (checks.length) parts.push(`BOOKED, BUT CHECK (${checks.length}):\n\n${checks.map(line).join('\n\n')}`);
    if (newClients.length) parts.push(`NEW CLIENTS TO ADD ON THE CLIENTS SCREEN (${newClients.length}):\n\n${newClients.map((a) => `• ${a.patientName}`).join('\n')}`);
    const subject = `Hope Billing Assistant: ${[notBooked.length && `${notBooked.length} not booked`, onCalendar.length && `${onCalendar.length} cancelled to delete`, checks.length && `${checks.length} to check`, newClients.length && `${newClients.length} new client${newClients.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`;
    const body = `${parts.join('\n\n\n')}\n\nThe same list is on the Alerts screen in Hope Billing Assistant.`;
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
      else notify('Sync needs attention — open Hope Billing Assistant to see why.');
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
    const res = await runFullSync({ secrets: creds, dates, providers, mainDoctors, clientPayers: s.clientPayers || [], bookedVisits: s.bookedVisits || [], onBooked: recordBooking, save: true, overrides: s.spFieldOverrides, onStep });
    res.at = nowISO();
    recordRunAlerts(res);
    store.save({ lastRun: res.at, lastResult: { ok: res.ok, at: res.at, mode: 'live', trigger, created: res.booked || 0, skipped: res.skipped || 0, failed: res.failed || 0, unmatched: res.unmatched || 0, error: res.error } });
    refreshTray();
    sendToRenderer('run-finished', res);
    if (res.ok) notify(`Synced the next ${n} days — booked ${res.booked || 0}, ${res.skipped || 0} already there${res.failed ? `, ${res.failed} need attention` : ''} ✓`);
    else notify('Sync needs attention — open Hope Billing Assistant to see why.');
    return res;
  } catch (err) {
    const r = { ok: false, error: 'Something went wrong during the sync. Please try again.', at: nowISO() };
    sendToRenderer('run-finished', r); return r;
  }
}

/* ---------------------------- notes follow-up ---------------------------- */
/**
 * Read the Practice Fusion schedule for `dates` and list every Seen visit with
 * whether its note is there; with `send`, email each therapist their missing
 * notes. Read only in Practice Fusion.
 */
async function performNotesCheck({ dates, send = false, trigger = 'manual' }) {
  if (notesRunning) return { ok: false, error: 'A notes check is already running.' };
  if (chartReviewRunning || scheduler.isRunning) return { ok: false, error: 'Practice Fusion is busy with another run — try again when it finishes.', busy: true };
  const creds = store.getCreds();
  if (!creds.practiceFusion.password) return { ok: false, error: 'Add your Practice Fusion login first (Connection).' };
  notesRunning = true;
  const step = (text) => sendToRenderer('notes-step', { text, at: nowISO() });
  sendToRenderer('notes-step', { text: `${trigger === 'daily' ? 'Daily notes check' : 'Notes check'} — ${dates[0]}${dates.length > 1 ? ` → ${dates[dates.length - 1]}` : ''}…`, at: nowISO(), reset: true });
  let context = null;
  try {
    const r = await liveEngine.openAutomationContext({ headless: false });
    if (r.error) return { ok: false, error: r.error.error || r.error };
    context = r.context;
    const page = context.pages()[0] || (await context.newPage());
    const pf = await loginPracticeFusion(page, creds.practiceFusion, { onStep: step });
    if (!pf.ok) return { ok: false, error: pf.error };
    const visits = await readPfSchedule(page, dates, step);
    const s = store.load();
    const providers = (s.providers && s.providers.length) ? s.providers : DEMO_PROVIDERS;
    const list = notes.findNotes(visits, { providers, now: new Date() });
    await checkNoteTimelines(context, page, list, step);
    const missing = list.filter((n) => n.note === 'missing' || n.note === 'incomplete');
    const unknown = list.filter((n) => n.note === 'unknown').length;
    step(`${list.length} visit${list.length === 1 ? '' : 's'} marked Seen · ${missing.length} with a note missing or not filled in${unknown ? ` · ${unknown} couldn't be read` : ''}.`);
    store.save({ notesCheck: { at: nowISO(), start: dates[0], end: dates[dates.length - 1], trigger, notes: list } });
    sendToRenderer('notes-result', {});
    let sent = null;
    if (send) sent = await sendNoteReminders(list, trigger);
    return { ok: true, seen: list.length, missing: missing.length, sent };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    notesRunning = false;
    if (context) { try { await context.close(); } catch {} }
    sendToRenderer('notes-finished', {});
  }
}

/** Extra Practice Fusion tabs that share the signed-in session (several charts
 *  at once). A tab only counts once it shows the signed-in schedule; one that
 *  lands on the login page is closed, and no more are tried — the run goes on in
 *  the signed-in tab instead of waiting on a login screen. */
const PF_SIGNED_OUT = /#\/login|securitycheck/i;
async function extraPfTabs(context, page, count, step) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    // Opened FROM the signed-in tab (like a click), so the new tab carries its
    // sign-in — a blank new tab lands on Practice Fusion's login page.
    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await page.evaluate((u) => { window.open(u, '_blank'); }, presets.PF.scheduleUrl).catch(() => {});
    const t = (await popup) || (await context.newPage().catch(() => null));
    if (!t) break;
    if (!/#\/PF\//.test(t.url())) await t.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ok = await t.waitForSelector(presets.PF.nav.dateHeading, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok || PF_SIGNED_OUT.test(t.url())) {
      await t.close().catch(() => {});
      step('  Extra tabs aren\'t signed in to Practice Fusion — continuing in one tab.');
      break;
    }
    tabs.push(t);
  }
  return tabs;
}

/** Back to the Practice Fusion schedule, on `date`, with its rows loaded. */
async function toScheduleDay(tab, date) {
  // Already there (the first client of a day) — nothing to do but wait for rows.
  const onSchedule = /\/schedule\//.test(tab.url()) && await tab.$(presets.PF.nav.dateHeading).catch(() => null);
  if (!onSchedule) {
    // The Schedule button on the left, like a person (no reload); else the address.
    await tab.click(presets.PF.nav.schedule, { timeout: 4000 }).catch(() => {});
    const there = await tab.waitForSelector(presets.PF.nav.dateHeading, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!there || !/agenda/.test(tab.url())) await tab.goto(presets.PF.scheduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await dismissPopups(tab).catch(() => {});
  if (!(await pfNavigateToDate(tab, date))) return false;
  await waitForDayRows(tab);
  return true;
}

/** For each Seen visit, the steps of the recorded walkthrough: on the schedule,
 *  click the client's name → Timeline → that visit's Office Visit → scroll down to
 *  the Note, and check Subjective, Objective, Assessment and Plan are all filled in.
 *  If the name can't be clicked, the chart is opened by its address instead; if
 *  the chart can't be opened at all, the schedule's "View in encounter" / "Start
 *  Encounter" link decides. Read only. Up to 3 signed-in tabs at once. */
async function checkNoteTimelines(context, page, list, step) {
  // One job per client per day: their visits that day are on one Timeline.
  const jobs = new Map();
  for (const n of list) {
    const k = `${n.date}|${normalizeName(n.patientName)}`;
    if (!jobs.has(k)) jobs.set(k, []);
    jobs.get(k).push(n);
  }
  const queue = [...jobs.values()].sort((a, b) => String(a[0].apptAt).localeCompare(String(b[0].apptAt)));
  const total = queue.length;
  if (!total) return;
  step(`Opening ${total} client${total === 1 ? '' : 's'}' notes…`);
  // A step that fails leaves a screenshot + page map here, to fix it from.
  notes.setDebugDir(path.join(app.getPath('desktop'), 'Hope Notes Check'));
  const tabs = [page, ...(await extraPfTabs(context, page, Math.min(3, total) - 1, step))];
  let done = 0;
  sendToRenderer('notes-progress', { done: 0, total });
  const said = (n) => (n.note === 'missing' ? `${n.time || n.date}: no note`
    : n.note === 'incomplete' ? `${n.time || n.date}: ${n.emptySections.join(', ')} not filled in`
    : n.note === 'unknown' ? `${n.time || n.date}: couldn't read the note` : `${n.time || n.date}: note complete ✓`);
  await Promise.all(tabs.map(async (tab) => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      // A tab that got signed out hands its client back and closes.
      if (tab !== page && PF_SIGNED_OUT.test(tab.url())) { queue.unshift(group); await tab.close().catch(() => {}); return; }
      const name = group[0].patientName;
      const href = group.find((n) => n.href)?.href || '';
      // 1) Schedule → click the client's name → 2) Timeline.
      let text = null;
      step(`${name}: opening the chart from the schedule…`);
      if (!(await toScheduleDay(tab, group[0].date))) { step(`  couldn't open the schedule on ${group[0].date}.`); await notes.snapshot(tab, 'schedule-day'); }
      else if (!(await notes.openClientFromSchedule(tab, group[0], presets.PF.selectors))) { step('  clicking the name didn\'t open the chart.'); await notes.snapshot(tab, 'client-name-click'); }
      else {
        step('  clicking Timeline…');
        text = await notes.openTimeline(tab);
        if (text == null) { step('  the Timeline didn\'t open.'); await notes.snapshot(tab, 'timeline'); }
      }
      if (text == null) { step('  opening the chart by its address instead…'); text = await chartReview.readEncounters(tab, name, href, step).catch(() => null); }
      for (const [i, n] of group.entries()) {
        // The client's next visit: back to their Timeline.
        if (i > 0 && text != null) text = (await notes.openTimeline(tab)) || (await chartReview.readEncounters(tab, name, href, step).catch(() => null));
        if (text == null) { n.source = 'schedule'; continue; }
        n.source = 'chart';
        if (!notes.noteInTimeline(text, n)) { n.note = 'missing'; step(`  ${n.time}: no encounter on the Timeline — no note.`); continue; }
        // 3) Office Visit → 4) scroll down to the Note and read it.
        const r = await notes.readVisitNote(tab, n, step).catch(() => null);
        const gaps = r ? notes.emptySections(r.sections) : null;
        n.signed = r ? r.status : '';
        if (gaps == null) n.note = 'unknown';
        else if (gaps.length) { n.note = 'incomplete'; n.emptySections = gaps; }
        else n.note = 'done';
      }
      done += 1;
      sendToRenderer('notes-progress', { done, total, patientName: name, visits: group.map((n) => ({ time: n.time, date: n.date, therapist: n.therapist, note: n.note, emptySections: n.emptySections || [], source: n.source })) });
      step(`(${done}/${total}) ${name} — ${group.every((n) => n.source === 'schedule') ? 'couldn\'t open the chart; went by the schedule' : group.map(said).join(' · ')}`);
    }
  }));
}

/** One email per therapist with missing notes (all to the test address while
 *  test mode is on). Every attempt is logged on the Notes page. */
async function sendNoteReminders(list, trigger = 'manual') {
  const s = store.load();
  const testMode = s.notesTestMode !== false;
  const plan = notes.planReminders(list, { emails: s.therapistEmails || {}, testMode, testTo: s.notesTestTo || notes.DEFAULT_TEST_TO });
  if (!plan.length) return { ok: true, sent: 0, skipped: 0 };
  const step = (text) => sendToRenderer('notes-step', { text, at: nowISO() });
  const log = [];
  let sent = 0, skipped = 0;
  for (const r of plan) {
    const entry = { at: nowISO(), trigger, therapist: r.therapist, to: r.to, intendedTo: r.intendedTo, count: r.items.length, overdue: r.items.filter((i) => i.overdue).length, test: testMode };
    if (!r.to) {
      skipped += 1;
      log.push({ ...entry, ok: false, error: 'No email on file for this therapist.' });
      step(`  ✉︎ ${r.therapist}: no email on file — not sent.`);
      continue;
    }
    try {
      const config = mailer.configFrom(s, store.getCreds().smtp, r.to);
      const mail = notes.reminderEmail({ therapist: r.therapist, items: r.items, intendedTo: r.intendedTo, test: testMode });
      await mailer.send({ subject: mail.subject, body: mail.text, html: mail.html, fromName: 'High Quality Home Therapy', config });
      sent += 1;
      log.push({ ...entry, ok: true });
      step(`  ✉︎ ${r.therapist}: reminder sent to ${r.to} (${r.items.length} note${r.items.length === 1 ? '' : 's'}).`);
    } catch (e) {
      const error = (e && e.message) || String(e);
      log.push({ ...entry, ok: false, error });
      step(`  ⚠︎ ${r.therapist}: email not sent — ${error}`);
      if (e && e.kind === 'notConfigured') { skipped += plan.length - log.length; break; }
    }
  }
  const prev = store.load().notesEmailLog || [];
  store.save({ notesEmailLog: [...log.reverse(), ...prev].slice(0, 300) });
  sendToRenderer('notes-result', {});
  return { ok: true, sent, skipped, failed: log.filter((l) => !l.ok).length };
}

/** The daily check at the chosen time (default 5:30 PM): looks back over the
 *  last days so overdue notes keep getting reminded until they're written. A
 *  minute tick (not one long timer) so a Mac that slept through 5:30 still runs
 *  it when it wakes — until 9 PM. A busy or failed run is retried every 10 minutes. */
let notesTimer = null;
let notesLastTry = 0;
function startNotesTimer() {
  if (notesTimer) return;
  notesTimer = setInterval(async () => {
    const s = store.load();
    const now = new Date();
    if (!s.notesDaily || notesRunning || !notes.dailyDue(now, { time: s.notesDailyTime, lastDay: s.notesLastDailyRun })) return;
    if (Date.now() - notesLastTry < 10 * 60e3) return;
    notesLastTry = Date.now();
    const r = await performNotesCheck({ dates: notes.lookbackDates(now, s.notesLookbackDays), send: true, trigger: 'daily' });
    if (r.ok) {
      store.save({ notesLastDailyRun: notes.dayKey(now), notesLastDailyError: null });
      const sent = r.sent ? r.sent.sent : 0;
      notify(r.missing ? `Notes check: ${r.missing} visit${r.missing === 1 ? '' : 's'} without a note — ${sent} reminder${sent === 1 ? '' : 's'} emailed.` : 'Notes check: every Seen visit has its note ✓');
    } else {
      store.save({ notesLastDailyError: r.error, notesLastDailyErrorAt: nowISO() });
    }
    sendToRenderer('notes-result', {});
  }, 60e3);
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
  mainWindow.once('ready-to-show', () => { if (!process.env.PS_BOOTCHECK) mainWindow.show(); });
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
    if (patch && typeof patch.schedule === 'string') scheduler.setMode(patch.schedule);
    if (patch && (typeof patch.schedule === 'string' || 'notesDaily' in patch)) applyLoginItem();
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
  ipcMain.handle('alerts:list', () => {
    const s = store.load();
    const alerts = s.alerts || [];
    const kept = withoutResolvedReminders(alerts, s.clientPayers || []);
    if (kept.length !== alerts.length) store.save({ alerts: kept });
    return kept;
  });
  ipcMain.handle('alerts:clear', () => { store.save({ alerts: [] }); return []; });

  // Email alerts (same mailbox-of-your-own approach as Hope Reminder). The
  // Test button proves the setup works before the real thing depends on it.
  ipcMain.handle('email:test', async () => {
    try {
      const settings = store.load();
      const config = mailer.configFrom(settings, store.getCreds().smtp);
      await mailer.send({
        subject: 'Hope Billing Assistant: test email',
        body: 'This is a test message — email alerts are working.\n\nAfter each sync, you will get one email listing any visits it couldn\'t book, with the therapist and the reason.',
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
    const dir = path.join(app.getPath('desktop'), `Hope Billing Assistant Setup ${stamp}`);
    const onStep = (t) => sendToRenderer('live-step', { text: t, at: nowISO() });
    sendToRenderer('live-step', { text: 'Opening SimplePractice to capture the booking fields…', at: nowISO(), reset: true });
    const steps = [
      { key: 'unitsField', label: 'The UNITS box (how many units a service line is)' },
      { key: 'modifierField', label: 'The first MODIFIER box — where GP / GO / GN goes' },
      { key: 'modifier2Field', label: 'The SECOND modifier box — where “59” goes (Skip if you don’t use it)', optional: true },
      { key: 'clinicianPick', label: 'The CLINICIAN field — to pick the main doctor (Skip if it’s already set)', optional: true },
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
    const res = await runFullSync({ secrets: creds, dates, providers, mainDoctors, clientPayers: s.clientPayers || [], bookedVisits: s.bookedVisits || [], onBooked: recordBooking, save: !!opts.save, overrides: s.spFieldOverrides, onStep });
    res.at = nowISO();
    recordRunAlerts(res);
    sendToRenderer('run-finished', res);
    if (res.ok) notify(opts.save ? `Booked ${res.booked} · skipped ${res.skipped}${res.failed ? ' · ' + res.failed + ' failed' : ''}` : `Dry run: ${res.planned.length} would book`);
    return res;
  });

  // CHART REVIEW — the practice's Client Chart Review Guide on every client
  // scheduled this week and next. Read only: nothing in Practice Fusion is changed.
  const CHART_TABS = 3; // charts reviewed at the same time
  ipcMain.handle('chart:run', async (_e, opts = {}) => {
    if (chartReviewRunning) return { ok: false, error: 'A chart review is already running.' };
    if (notesRunning) return { ok: false, error: 'A notes check is using Practice Fusion — try again when it finishes.' };
    const creds = store.getCreds();
    if (!creds.practiceFusion.password) return { ok: false, error: 'Add your Practice Fusion login first (Connection).' };
    chartReviewRunning = true;
    const s = store.load();
    const step = (text) => sendToRenderer('chart-step', { text, at: nowISO() });
    sendToRenderer('chart-step', { text: 'Starting the chart review…', at: nowISO(), reset: true });
    let context = null;
    try {
      const r = await liveEngine.openAutomationContext({ headless: false });
      if (r.error) return { ok: false, error: r.error.error || r.error };
      context = r.context;
      // Speed: skip pictures, fonts, video and ads — the review only reads text.
      await context.route('**/*', (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (type === 'image' || type === 'media' || type === 'font' || /doubleclick|googlesyndication|adservice|adnxs|googletagservices/i.test(req.url())) return route.abort().catch(() => {});
        return route.continue().catch(() => {});
      }).catch(() => {});
      const page = context.pages()[0] || (await context.newPage());
      const pf = await loginPracticeFusion(page, creds.practiceFusion, { onStep: step });
      if (!pf.ok) return { ok: false, error: pf.error };
      // Several charts at once: extra tabs share the signed-in session (only
      // tabs that are really signed in are used).
      const tabs = [page, ...(await extraPfTabs(context, page, CHART_TABS - 1, step))];
      await page.bringToFront().catch(() => {});
      const providers = (s.providers && s.providers.length) ? s.providers : DEMO_PROVIDERS;
      const mainDoctors = (s.mainDoctors && s.mainDoctors.length) ? s.mainDoctors : DEMO_MAIN_DOCTORS;
      const results = await chartReview.runChartReview({
        page, pages: tabs, start: opts.start || null, end: opts.end || null,
        providers, mainDoctors, onStep: step, only: opts.only || null,
        readSchedule: (dates) => readPfSchedule(page, dates, step),
        onResult: (res) => {
          // Save each chart as it's done, so a long run never loses its work.
          const cur = store.load();
          const prev = (cur.chartReview && cur.chartReview.results) || [];
          store.save({
            chartReview: { at: nowISO(), start: opts.start || '', end: opts.end || '', results: [...prev.filter((x) => x.patientKey !== res.patientKey), res] },
            chartFollowUps: chartReview.mergeFollowUps(cur.chartFollowUps || [], [res]),
          });
          sendToRenderer('chart-result', res);
        },
      });
      const bad = results.filter((x) => x.ok && x.items.some((i) => i.status !== 'ok')).length;
      const failedOpen = results.filter((x) => !x.ok).length;
      step(`Done — ${results.length} chart${results.length === 1 ? '' : 's'} reviewed, ${bad} with items to fix${failedOpen ? `, ${failedOpen} couldn't be opened` : ''}.`);
      return { ok: true, count: results.length };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      chartReviewRunning = false;
      if (context) { try { await context.close(); } catch {} }
      sendToRenderer('chart-finished', {});
    }
  });
  // NOTES FOLLOW-UP — Seen visits with no note yet; reminders to each therapist.
  ipcMain.handle('notes:run', async (_e, opts = {}) => {
    const dates = expandDates(opts.start, opts.end || opts.start);
    if (!dates.length) return { ok: false, error: 'Pick a date (or a start–end range) first.' };
    return performNotesCheck({ dates, send: !!opts.send, trigger: 'manual' });
  });
  // A sample reminder (made-up client) to the test address: proves the mailbox
  // works, and shows the exact reason when it doesn't.
  ipcMain.handle('notes:testEmail', async () => {
    const s = store.load();
    const to = s.notesTestTo || notes.DEFAULT_TEST_TO;
    try {
      const config = mailer.configFrom(s, store.getCreds().smtp, to);
      const now = new Date();
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30);
      const mail = notes.reminderEmail({ therapist: 'Sample Therapist', intendedTo: 'sample@example.com', test: true,
        items: [{ patientName: 'Sample Client', note: 'incomplete', emptySections: ['Objective', 'Plan'], apptAt: at.toISOString(), dueAt: new Date(at.getTime() + 864e5).toISOString(), overdue: false }] });
      await mailer.send({ subject: mail.subject, body: mail.text, html: mail.html, fromName: 'High Quality Home Therapy', config });
      return { ok: true, to };
    } catch (e) {
      return { ok: false, to, error: (e && e.message) || String(e), notConfigured: !!(e && e.kind === 'notConfigured') };
    }
  });
  ipcMain.handle('notes:send', async () => {
    const last = store.load().notesCheck;
    if (!last || !last.notes) return { ok: false, error: 'Run a check first.' };
    // Re-judge "overdue" against now — the check may have run hours ago.
    const now = new Date();
    const fresh = last.notes.map((n) => ({ ...n, overdue: !!(n.dueAt && now >= new Date(n.dueAt)) }));
    return sendNoteReminders(fresh, 'manual');
  });

  ipcMain.handle('bookings:forget', () => { store.save({ bookedVisits: [] }); return { ok: true }; });
  ipcMain.handle('chart:followup', (_e, { id, done }) => {
    const s = store.load();
    const list = (s.chartFollowUps || []).map((f) => (f.id === id ? { ...f, resolvedAt: done ? nowISO() : null, resolvedBy: done ? 'staff' : '' } : f));
    store.save({ chartFollowUps: list });
    return list;
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

/** Open at login whenever something runs on its own (the sync schedule or the
 *  daily notes check), so a restart doesn't quietly switch it off. */
function applyLoginItem() {
  const s = store.load();
  try {
    app.setLoginItemSettings({ openAtLogin: s.schedule === '6h' || s.schedule === 'daily' || !!s.notesDaily, openAsHidden: true });
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

/** App menu with the display name (Electron's default menu would show the
 *  internal "Hope Assistant"). Keeps Edit so copy/paste work in every field. */
function setAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: APP_NAME, submenu: [
      { role: 'about', label: `About ${APP_NAME}` },
      { type: 'separator' },
      { role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, accelerator: 'Command+Q', click: () => { app.isQuitting = true; app.quit(); } },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
}

/** After updating to the renamed app, the old "Hope Assistant.app" is still in
 *  Applications. Offer once to move it to the Trash so there's only one app. */
async function offerOldAppCleanup() {
  const old = '/Applications/Hope Assistant.app';
  try {
    if (!app.isPackaged || store.load().oldAppCleanupAsked) return;
    if (!fs.existsSync(old) || app.getPath('exe').startsWith(old + '/')) return;
    store.save({ oldAppCleanupAsked: true });
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Move to Trash', 'Keep it'], defaultId: 0, cancelId: 1,
      message: 'Remove the old Hope Assistant app?',
      detail: 'Hope Assistant is now Hope Billing Assistant. The old app is still in your Applications folder. Your settings, doctors, clients and logins are already in the new app.',
    });
    if (response === 0) await shell.trashItem(old);
  } catch {}
}

app.whenReady().then(() => {
  setAppMenu();
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
  // Oct 2026 roster (once): the practice's updated "Billing Providers" list.
  // Adds therapists who are missing and moves anyone to their new billing
  // provider; nobody's codes change and no one the office added is removed.
  if ((store.load().rosterVersion || 0) < ROSTER_VERSION) {
    try {
      const cur = store.load();
      if (cur.providers && cur.providers.length) {
        const merged = mergeRoster(cur.providers);
        store.save({ providers: merged.providers, rosterVersion: ROSTER_VERSION, rosterMergedAt: nowISO(), rosterMergeNote: { added: merged.added, moved: merged.moved } });
      } else store.save({ rosterVersion: ROSTER_VERSION });
    } catch {}
  }
  // Oct 2026 billing update (once): move speech doctors still on the old default
  // codes to the new speech set. Doctors whose codes were customised are left alone.
  // (The client payer list is entered by the practice — never shipped in the app.)
  if ((store.load().billingVersion || 0) < 2) {
    try {
      const cur = store.load();
      const oldSpeech = formatCodes(parseCodes(OLD_SPEECH_CODES));
      const newSpeech = parseCodes(UNIT_CODES['Karine Rocha de Benedicto']);
      const providers = (cur.providers || []).map((p) =>
        formatCodes(parseCodes(p.codes)) === oldSpeech ? { ...p, codes: newSpeech } : p);
      store.save({ providers, billingVersion: 2 });
    } catch {}
  }
  // Nov 2026 (once): each therapist's private-pay service, from their discipline
  // where it's clear (LMT → Massage, CPT → Personal Training). Blanks only.
  if (!store.load().privateServicesSeeded) {
    try {
      const cur = store.load();
      const seeded = seedPrivateServices(cur.providers || []);
      store.save({ providers: seeded.providers, privateServicesSeeded: true, privateServicesNote: seeded.filled });
    } catch {}
  }
  // Earlier chart reviews misread pages (the "Go to…" dropdown was taken for the
  // real sections), so their findings can't be trusted — clear them once.
  if ((store.load().chartReviewVersion || 0) < 3) {
    try { store.save({ chartReview: null, chartFollowUps: [], chartReviewVersion: 3 }); } catch {}
  }
  scheduler.setMode(settings.schedule || 'off');
  applyLoginItem();
  startNotesTimer();

  createTray();
  createWindow();
  maybeCatchUp();
  mainWindow.webContents.once('did-finish-load', () => setTimeout(offerOldAppCleanup, 1500));

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
