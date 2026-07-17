'use strict';

/*
 * VERIFIED page map for the demo Practice Fusion / SimplePractice accounts.
 *
 * Every selector here was captured from the real accounts (scripts/inspect-dom.js)
 * and checked against the captured DOM (test/real-accounts.test.js). This lets the
 * app run on these accounts WITHOUT Teach Mode. When the real hospital accounts are
 * available, re-capture and update these (the structure is expected to match — same
 * Practice Fusion EHR and SimplePractice calendar).
 *
 * Items marked TODO(real) are not present in the demo account (units / per-line
 * modifiers / multiple clinicians+locations) and must be confirmed on the full
 * account before the booking is trusted end to end.
 */

const PF = {
  // Practice Fusion is an Ember SPA with hash routes; logging in once in the
  // dedicated profile keeps the session.
  loginUrl: 'https://static.practicefusion.com/apps/ehr/index.html#/login',
  scheduleUrl: 'https://static.practicefusion.com/apps/ehr/index.html#/PF/schedule/scheduler/agenda',
  // The "security check" (phone 2FA) page — the app pauses here for the user.
  twoFactorUrlMatch: '/login/securitycheck',
  // Practice Fusion serves more than one login-page variant, so each field lists
  // candidate selectors (tried in order until one is present + visible).
  login: {
    username: ['#inputUsername', 'input[type="email"]', 'input[name*="ser" i]'],
    password: ['#inputPswd', 'input[type="password"]'],
    submit: ['#loginButton', 'button.btn-login', 'button[type="submit"]'],
  },
  nav: {
    schedule: '[data-element="left-navigation-schedule"]',
    dateHeading: '[data-element="scheduler-selected-date"]', // e.g. "Mon, Jun 29, 2026"
    prevDay: '[data-element="btn-date-previous"]',
    nextDay: '[data-element="btn-date-next"]',
    today: '[data-element="btn-date-today"]',
    datepicker: '[data-element="options-datepicker"]',
    calendarIcon: '[data-element="btn-calendar-icon"]',
  },
  // Read selectors — each appointment ROW, with patient + provider read inside it,
  // and the day heading used as the date (page-level). Verified: reads all 7 of
  // the demo day's appointments incl. two for "Amanda Patel" under two providers.
  selectors: {
    rowSelector: 'tr.data-table__row',
    patientSelector: 'a[data-element="cell-name"]',
    doctorSelector: 'td[data-element^="cell-provider-name-"]',
    timeSelector: '[data-element="start-time"]', // per-row appointment time, e.g. "12:00 PM"
    dateSelector: '[data-element="scheduler-selected-date"]',
  },
};

const SP = {
  loginUrl: 'https://account.simplepractice.com/',
  calendarUrl: 'https://secure.simplepractice.com/calendar/appointments',
  // Opening this route directly pops the new-appointment dialog.
  newApptUrl: 'https://secure.simplepractice.com/calendar/appointments/new',
  login: {
    email: ['#user_email', 'input[type="email"]', 'input[name="user[email]"]'],
    password: ['#user_password', 'input[type="password"]', 'input[name="user[password]"]'],
    submit: ['#submitBtn', 'button[type="submit"]', 'input[type="submit"]'],
  },
  // The default location for the real practice (not selectable in the demo).
  defaultLocation: 'High Quality Home Therapy LLC',
  // The calendar is FullCalendar; each appointment block carries the client name
  // in data-appt-title — used to navigate days and to de-dup (skip clients
  // already booked on a date).
  calendar: {
    title: '.fc-toolbar-title',       // e.g. "Sat, Jun 27, 2026"
    prevDay: '.fc-prev-button',
    nextDay: '.fc-next-button',
    today: '.fc-today-button',
    apptTitle: '[data-appt-title]',   // attribute value = client name
  },
  selectors: {
    // Client is a typeahead: click the trigger, type into the input that appears,
    // then click the matching option. Scoped by its validation path so it isn't
    // confused with the (identically-classed) Location typeahead.
    clientTrigger: '[data-validation-path="client"] .typeahead-trigger',
    // After clicking the trigger, a searchbox appears and options render below.
    clientSearchInput: '[data-validation-path="client"] .select-box__input',
    optionRow: '.select-box__option', // role="option" rows (has a .client-name)
    locationTrigger: '[data-validation-path="officeId"] .typeahead-trigger',
    locationSearchInput: '[data-validation-path="officeId"] .select-box__input',
    dateField: 'input[name="startDate"]',
    startTimeField: 'input[name="startTime"]',
    // Native <select>: set by value (the CPT code) or label.
    codeSelect: 'select[name="code"]',
    // Clinician: in the demo it's a single non-editable name; on the real account
    // it's a dropdown of clinicians — open it, READ the names, click the match
    // (no search box). Container is stable.
    clinician: '.shared-clinician-dropdown-container',
    clinicianOpen: '.shared-clinician-dropdown-container .non-editable-dropdown',
    addService: 'button[aria-label="add service"]',
    saveButton: 'button.submit-form',
    // VERIFIED from the real account's DevTools (client-sent Inspect screenshot):
    //   <input aria-label="Number of Units" class="number-of-units"
    //          id="number-of-units" name="numberOfUnits" type="text">
    // one per service line, inside div[data-validation-path="numberOfUnits"].
    unitsField: 'input[name="numberOfUnits"]',
    // Four per line, shown with the "AA" placeholder (first holds GP/GO/GN,
    // another holds 59). name^="modifier" is the primary; the AA-placeholder
    // net in book.js covers accounts where the name differs.
    modifierInputs: 'input[name^="modifier"]',
  },
};

/* Promo / upsell overlays to dismiss so a run is never blocked by a popup.
 * Tried in order: click a close/dismiss control, else press Escape. */
const POPUPS = {
  // Selectors whose presence means a blocking overlay is up.
  containers: [
    '[data-element="update-carbon-modal"]',
    '[data-element="trial-expire-days"]',
    '.modal-backdrop',
    '[role="dialog"].upgrade',
  ],
  // Things to click to close them (best-effort, all optional).
  closers: [
    '[aria-label="Close"]',
    '[data-element="modal-close"]',
    'button.close',
    'button[aria-label="close"]',
    '.modal .icon-close',
  ],
};

module.exports = { PF, SP, POPUPS };
