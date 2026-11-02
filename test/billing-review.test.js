'use strict';

/*
 * The practice's November 2026 billing review, on made-up patients only:
 *   1. place of service is never touched,
 *   2. cancellations: CX>24 / Therapist CX never added, CX<24 added, a
 *      cancellation with no term held, a cancelled visit still on the calendar flagged,
 *   3. a reminder for each new client,
 *   4. a private-pay service per therapist,
 *   5. per-client lines ("Jade: Massage") for clients on insurance and private pay,
 * and every code checked as it's picked (a speech visit once kept 97530).
 * The booking runs against a fake SimplePractice dialog served from this Mac;
 * the real site is never contacted.
 *   node test/billing-review.test.js   (the booking part needs Google Chrome; skipped without it)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { JSDOM } = require('jsdom');
const m = require(path.join(__dirname, '..', 'src', 'main', 'model'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));
const { extractVisits } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const book = require(path.join(__dirname, '..', 'src', 'main', 'book'));
const sync = require(path.join(__dirname, '..', 'src', 'main', 'sync'));

let passed = 0;
let failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

const ROSTER = m.DEMO_PROVIDERS;
const MAINS = m.DEMO_MAIN_DOCTORS;
const CLIENTS = [
  { name: 'Ida Placeholder', status: 'Insurance/Private', codes: 'JR: 97112 x 2 (GP), 97530 x 2 (GP, 59)\nJade: Massage' },
  { name: 'Rowan Testerly', status: 'Insurance', codes: 'Gianna: 97112 x 2 (GP), 97530 x 2 (GP, 59)' },
  { name: 'Max Example', status: 'Private Pay' },
  { name: 'Pia Privata', status: 'Private Pay', codes: 'Gianna: Physical Therapy\nJade: $140' },
];
const plan = (patient, therapist, extra = {}, clients = CLIENTS) =>
  planAppointments([{ patientName: patient, doctorName: therapist, date: '11/04/2026', type: 'Follow-Up Visit', ...extra }], ROSTER, MAINS, [], clients)[0];

(function testCancellationTerms() {
  console.log('# Cancellations — the three terms, anywhere on the visit, extra words allowed');
  const k = (v) => m.cancellationOf(v).kind;
  check('"Pending arrival" → not cancelled', k({ status: 'PN Pending arrival' }) === 'none');
  check('CX>24 in the chief complaint → never added', k({ status: 'CX Cancelled', note: 'CX>24 called Monday' }) === 'over24');
  check('"CX > 24 hrs" with spaces → CX>24', k({ note: 'cx > 24 hrs' }) === 'over24');
  check('"CX >= 24" → CX>24', k({ note: 'CX >= 24' }) === 'over24');
  check('CX<24 → late cancel', k({ status: 'Cancelled', note: 'CX<24 sick' }) === 'under24');
  check('"cx < 24h" → late cancel', k({ note: 'pt cx < 24h' }) === 'under24');
  check('"Therapist CX" → never added', k({ status: 'Cancelled', note: 'Therapist CX - covering another visit' }) === 'therapist');
  check('"cancelled by therapist" → Therapist CX', k({ note: 'cancelled by therapist' }) === 'therapist');
  check('the term in the confirmation column counts too', k({ confirmation: 'CX>24' }) === 'over24');
  check('status Cancelled with no term → held', k({ status: 'CX Cancelled' }) === 'no_term');
  check('status No show with no term → held', k({ status: 'NS No show' }) === 'no_term');
  check('two different terms → held', k({ note: 'CX>24 / CX<24' }) === 'conflict');
  check('a word like "cancer" in the complaint is not a cancellation', k({ status: 'Pending arrival', note: 'cancer rehab' }) === 'none');
  check('the term label is given back', m.cancellationOf({ note: 'cx<24' }).term === 'CX<24');
})();

(function testReadingTheSchedule() {
  console.log('# Reading the Practice Fusion schedule — status, chief complaint, confirmation');
  const row = (i, name, provider, status, complaint, title = '') => `
    <tr class="data-table__row" data-element="data-table-row-${i}">
      <td><div data-element="patient-pinned-note-${i}"><i aria-label="Add pin"></i></div></td>
      <td><div data-element="intake-status-select-${i}" class="composable-select"><button data-element="intake-status-select-${i}-dropdown">
        <span class="composable-select__selection"><div class="kendo-scheduler__event__badge--PN">${status.split(' ')[0]}</div>
        <div class="item--TBn text-truncate" title="${status.split(' ').slice(1).join(' ')}"><span>${status.split(' ').slice(1).join(' ')}</span></div></span></button></div></td>
      <td data-element="cell-patient-${i}"><a data-element="cell-name" href="#/x">${name}</a></td>
      <td data-element="cell-time-${i}"><p data-element="start-time">10:00 AM</p></td>
      <td data-element="cell-provider-name-${i}">${provider}</td>
      <td><p data-element="cell-appointment-type-${i}" title="Follow-Up Visit">Follow-Up Visit</p></td>
      <td title="${title}" data-element="cell-chief-complaint-${i}">${complaint}</td>
      <td data-element="cell-confirmation-${i}"><p data-element="status">Confirmed</p></td>
    </tr>`;
  const doc = new JSDOM(`<!doctype html><html><body><div data-element="scheduler-selected-date">Wed, Nov 4, 2026</div><table><tbody>
    ${row(0, 'Ida Placeholder', 'Gianna H', 'PN Pending arrival', '')}
    ${row(1, 'Rowan Testerly', 'Gianna H', 'CX Cancelled', 'CX>24')}
    ${row(2, 'Max Example', 'Jade L', 'CX Cancelled', 'CX<24 - fever, called 7am', 'CX<24 - fever, called 7am')}
    ${row(3, 'Pia Privata', 'Gianna H', 'CX Cancelled', '')}
  </tbody></table></body></html>`).window.document;
  const v = extractVisits(doc, presets.PF.selectors, 50);
  check('four visits read', v.length === 4);
  check('status is the CHOSEN value with its badge', v[0].status === 'PN Pending arrival' && v[1].status === 'CX Cancelled');
  check('chief complaint read (and not doubled by its tooltip)', v[1].note === 'CX>24' && v[2].note === 'CX<24 - fever, called 7am');
  check('confirmation read', v[0].confirmation === 'Confirmed');
  check('appointment type read from the <p> it sits on', v[0].type === 'Follow-Up Visit');
  check('→ none / CX>24 / CX<24 / held', v.map((x) => m.cancellationOf(x).kind).join() === 'none,over24,under24,no_term');
  const real = path.join(__dirname, '..', 'inspect-output', '04-pf-row.raw.html');
  if (fs.existsSync(real)) {
    const rv = extractVisits(new JSDOM(fs.readFileSync(real, 'utf8')).window.document, presets.PF.selectors, 50);
    check('the captured real schedule: every visit "Pending arrival", none cancelled', rv.length === 7 && rv.every((x) => /Pending arrival/.test(x.status) && m.cancellationOf(x).kind === 'none'));
  } else console.log('  skip  captured schedule (inspect-output not on this Mac)');
})();

(function testCodeLines() {
  console.log('# A client\'s line with a service name = private pay with that service');
  const bank = m.parseCodeBank([
    'Caryn: 97112 x 2 (GP), 97530 x 2 (GP, 59)',
    'Jade: Massage',
    'Ron: $165 Personal Training, no code',
    'Tom: $140',
    'Lee: private',
    'JR: x 2 (GP)',
    'Eileen: ',
  ].join('\n'));
  check('a code line stays insurance', !bank[0].private && bank[0].codes.length === 2 && bank[0].service === '');
  check('"Jade: Massage" → private, service Massage, no codes', bank[1].private && bank[1].service === 'Massage' && bank[1].codes.length === 0);
  check('"$165 Personal Training, no code" → Personal Training', bank[2].private && bank[2].service === 'Personal Training');
  check('"$140" → private, the therapist\'s usual service', bank[3].private && bank[3].service === '');
  check('"private" → private, no service', bank[4].private && bank[4].service === '');
  check('a broken code line is never read as a service', !bank[5].private && bank[5].service === '');
  check('an empty line is nothing', !bank[6].private && bank[6].codes.length === 0);
  check('the summary shows the service', m.codeBankSummary('Caryn: 97112 x 2 (GP)\nJade: Massage\nTom: $140') === 'Caryn, Jade (Massage), Tom (private)');
})();

(function testTherapistServices() {
  console.log('# Each therapist\'s private-pay service');
  check('LMT → Massage', m.suggestPrivateService('LMT') === 'Massage');
  check('CPT and "NASM - CPT" → Personal Training', m.suggestPrivateService('CPT') === 'Personal Training' && m.suggestPrivateService('NASM - CPT') === 'Personal Training');
  check('mixed or therapy disciplines are left to the office', ['LMT/CPT', 'LCSW/LMT', 'PT', 'OT', 'SLP', 'Nurse', ''].every((d) => m.suggestPrivateService(d) === ''));
  const jade = ROSTER.find((p) => p.name === 'Jade Lee MeeSook');
  check('the roster has Jade → Massage', jade.privateService === 'Massage');
  const seeded = m.seedPrivateServices([{ name: 'A', discipline: 'LMT', privateService: '' }, { name: 'B', discipline: 'LMT', privateService: 'Deep Tissue' }, { name: 'C', discipline: 'PT' }]);
  check('filling blanks never overwrites what the office typed', seeded.providers[0].privateService === 'Massage' && seeded.providers[1].privateService === 'Deep Tissue' && !seeded.providers[2].privateService);
  check('…and says what it filled', seeded.filled.join() === 'A: Massage');
  check('a saved therapist keeps their private-pay service', m.makeProvider({ name: 'X', mainDoctor: 'Y', codes: '', discipline: 'LMT', privateService: ' Massage ' }).privateService === 'Massage');
})();

(function testPlanning() {
  console.log('# Planning each visit');
  const jadeIda = plan('Ida Placeholder', 'Jade Lee MeeSook');
  check('"Jade: Massage" on Ida → private, Massage, no codes, from the client line', jadeIda.selfPay && jadeIda.privateDefinite && jadeIda.privateService === 'Massage' && jadeIda.serviceFrom === 'client' && jadeIda.services.length === 0);
  const jrIda = plan('Ida Placeholder', 'JR Meehan');
  check('JR on the same client → insurance with his line\'s codes', !jrIda.selfPay && jrIda.services.map((s) => s.code).join() === '97112,97530');
  const jadeMax = plan('Max Example', 'Jade Lee MeeSook');
  check('a Private client seen by Jade → Jade\'s Massage', jadeMax.selfPay && jadeMax.privateService === 'Massage' && jadeMax.serviceFrom === 'therapist');
  const giaPia = plan('Pia Privata', 'Gianna Hernandez');
  check('a Private client\'s line names the service per therapist (Gianna → Physical Therapy)', giaPia.selfPay && giaPia.privateService === 'Physical Therapy' && giaPia.services.length === 0);
  const giaMax = plan('Max Example', 'Gianna Hernandez');
  check('a Private client with no service anywhere → the preset (blank service)', giaMax.selfPay && giaMax.privateService === '' && giaMax.privateDefinite);
  const newbie = plan('Nora Newname', 'Gianna Hernandez');
  check('a client not on the list → new client, insurance codes as before', newbie.newClient && !newbie.selfPay && newbie.services.length === 2);
  check('the therapist\'s service still rides along (if the preset says private)', plan('Nora Newname', 'Jade Lee MeeSook').therapistService === 'Massage');
  check('no Clients list at all → nobody is "new"', !plan('Nora Newname', 'Gianna Hernandez', {}, []).newClient);
  check('the cancellation is carried on the plan', plan('Rowan Testerly', 'Gianna Hernandez', { status: 'CX Cancelled', note: 'CX>24' }).cancel.kind === 'over24');
})();

(function testSortingCancellations() {
  console.log('# A day\'s visits, sorted by cancellation');
  const day = [
    plan('Rowan Testerly', 'Gianna Hernandez', { status: 'CX Cancelled', note: 'CX>24' }),
    plan('Ida Placeholder', 'JR Meehan', { status: 'Cancelled', note: 'Therapist CX' }),
    plan('Max Example', 'Jade Lee MeeSook', { status: 'Cancelled', note: 'CX<24' }),
    plan('Pia Privata', 'Gianna Hernandez', { status: 'NS No show' }),
    plan('Nora Newname', 'Gianna Hernandez', { note: 'CX>24 CX<24' }),
    plan('Ida Placeholder', 'Gianna Hernandez', { status: 'PN Pending arrival' }),
  ];
  const r = sync.sortCancellations(day);
  check('CX>24 and Therapist CX → not added, kept for the calendar check', r.cancelled.map((p) => p.patientName).join() === 'Rowan Testerly,Ida Placeholder');
  check('…each a quiet "cancelled" outcome (not an alert)', r.outcomes.filter((o) => o.status === 'cancelled').length === 2 && !sync.PROBLEM.has('cancelled'));
  check('CX<24 → booked, flagged as a late cancel', r.keep.some((p) => p.patientName === 'Max Example' && p.warnings.some((w) => /Late cancel \(CX<24\)/.test(w))));
  const held = r.outcomes.filter((o) => o.status === 'cancel_unclear');
  check('no term (a no-show) and two terms → held on Alerts', held.map((o) => o.patientName).join() === 'Pia Privata,Nora Newname' && sync.PROBLEM.has('cancel_unclear'));
  check('…saying what Practice Fusion shows and what to add', /shows "NS No show" but none of CX>24, CX<24 or Therapist CX/.test(held[0].reason) && /two cancellation terms/.test(held[1].reason));
  check('the ordinary visit is booked as usual', r.keep.some((p) => p.patientName === 'Ida Placeholder' && p.cancel.kind === 'none'));
})();

(function testReminders() {
  console.log('# New clients — one reminder each');
  const plans = [plan('Nora Newname', 'Gianna Hernandez'), plan('Nora Newname', 'Jade Lee MeeSook'), plan('Rowan Testerly', 'Gianna Hernandez'), plan('Newname, Nora', 'Amanda Meyer')];
  const seen = new Set();
  const r = sync.newClientReminders(plans, seen);
  check('one reminder for Nora (three visits, any name order)', r.length === 1 && r[0].patientName === 'Nora Newname' && r[0].status === 'new_client');
  check('none for a client already on the list', !r.some((o) => o.patientName === 'Rowan Testerly'));
  check('a later day in the same run doesn\'t repeat it', sync.newClientReminders([plan('Nora Newname', 'Gianna Hernandez')], seen).length === 0);
  check('it\'s a reminder, not a failure', sync.REMINDER.has('new_client') && !sync.PROBLEM.has('new_client'));
})();

(function testCancelledStillOnCalendar() {
  console.log('# A cancelled visit still on the SimplePractice calendar');
  const cx = plan('Rowan Testerly', 'Gianna Hernandez', { note: 'CX>24' });
  let pool = [{ title: 'Rowan Testerly', clinician: 'Caryn McAllister' }];
  let r = sync.cancelledStillBooked(pool, [cx]);
  check('flagged: delete it in SimplePractice', r.length === 1 && r[0].status === 'cancelled_on_calendar' && /Delete it in SimplePractice/.test(r[0].reason) && /CX>24/.test(r[0].reason));
  pool = [];
  check('not on the calendar → nothing to do', sync.cancelledStillBooked(pool, [cx]).length === 0);
  pool = [{ title: 'Rowan Testerly', clinician: 'Heather Vines-Dubose' }];
  check('an entry in another provider\'s column is a different session, not this one', sync.cancelledStillBooked(pool, [cx]).length === 0);
  // The same client's real visit that day takes its entry first.
  pool = [{ title: 'Rowan Testerly', clinician: 'Caryn McAllister' }];
  sync.takeExistingFrom(pool, 'Rowan Testerly', 'pt', 'Caryn McAllister');
  check('…and an entry the day\'s real visit accounts for is never flagged', sync.cancelledStillBooked(pool, [cx]).length === 0);
})();

(function testRecordChoice() {
  console.log('# Which SimplePractice record a private visit goes on');
  const J = ['Jordan OT Sampleton', 'Jordan PT Sampleton', 'Jordan SLP Sampleton'];
  const strict = { selfPay: true, strictPrivate: true, allowFirst: true };
  check('private, only insurance records → -3 (held, never one of them)', book.chooseOptionIndex(J, 'Jordan Sampleton', strict) === -3);
  check('…while results may still load → wait', book.chooseOptionIndex(J, 'Jordan Sampleton', { ...strict, allowFirst: false }) === -2);
  check('a Self Pay record → that one', book.chooseOptionIndex([...J, 'Jordan Self Pay Sampleton'], 'Jordan Sampleton', strict) === 3);
  check('a record named for the service → that one', book.chooseOptionIndex([...J, 'Jordan Massage Sampleton'], 'Jordan Sampleton', { ...strict, service: 'Massage' }) === 3);
  check('a "PT" service never picks the PT insurance record', book.chooseOptionIndex(J, 'Jordan Sampleton', { ...strict, service: 'PT' }) === -3);
  check('a plain record next to the tagged ones → the plain one', book.chooseOptionIndex([...J, 'Jordan Sampleton'], 'Jordan Sampleton', strict) === 3);
  check('the client\'s only record, even tagged → that one', book.chooseOptionIndex(['Jordan PT Sampleton'], 'Jordan Sampleton', strict) === 0);
  check('a GUESSED private visit (by type) still follows the discipline', book.chooseOptionIndex(J, 'Jordan Sampleton', { selfPay: true, discipline: 'pt', allowFirst: true }) === 1);
  check('insurance visits unchanged: OT → the OT record', book.chooseOptionIndex(J, 'Jordan Sampleton', { discipline: 'ot' }) === 0);
})();

(function testServicePicking() {
  console.log('# Picking a service in SimplePractice\'s list');
  const opts = [
    { value: '', label: 'Select a service' }, { value: 's1', label: '97112 Neuromuscular re-education' },
    { value: 's5', label: '97535 Self-care / home management training' }, { value: 'hv', label: 'Home Visit' },
    { value: 'mt', label: 'Massage Therapy' }, { value: 'ptr', label: 'Personal Training' }, { value: 'phy', label: 'Physical Therapy' },
    { value: 'm60', label: 'Massage 60 min' }, { value: 'm90', label: 'Massage 90 min' },
  ];
  check('a code is found by its label when values aren\'t codes', book.codeOptionIndex(opts, '97535') === 2);
  check('…or by value', book.codeOptionIndex([{ value: '97535', label: 'Self care' }], '97535') === 0);
  check('a code SimplePractice doesn\'t have → -1', book.codeOptionIndex(opts, '92523') === -1);
  check('"97112" never matches "971120"', book.codeOptionIndex([{ value: 'x', label: '971120 Something' }], '97112') === -1);
  const pick = (want, preset = -1) => book.pickServiceOption(opts, want, preset).index;
  check('"Massage Therapy" written in full → exact', pick('Massage Therapy') === 4);
  check('"Massage" with three massage services → none picked (-2), never a guess', pick('Massage') === -2);
  check('…unless the preset is one of them: it stays', pick('Massage', 7) === 7);
  check('"Personal Training" → Personal Training', pick('Personal Training') === 5);
  check('"PT" → Physical Therapy, not Personal Training', pick('PT') === 6);
  check('"Advocacy" not offered → -1', pick('Advocacy') === -1);
  check('the blank "Select a service" row is never picked', book.pickServiceOption(opts, 'Select a service').index === -1);
})();

(function testBillingDecision() {
  console.log('# Private or insurance, once SimplePractice pre-fills its service');
  const coded = { found: true, label: '97535 Self-care / home management training', hasCode: true };
  const plain = { found: true, label: 'Home Visit', hasCode: false };
  const none = { found: false, label: '', hasCode: false };
  const d = book.decideBilling;
  const jadeIda = plan('Ida Placeholder', 'Jade Lee MeeSook');
  let r = d(jadeIda, coded);
  check('Jade on Ida ("Jade: Massage"), preset an OT code → private, Massage, must be found', r.mode === 'private' && r.wantService === 'Massage' && r.serviceRequired && !r.services.length);
  r = d({ ...plan('Max Example', 'Gianna Hernandez') }, coded);
  check('a Private client, no service anywhere, preset a code → held (no insurance code on a private visit)', r.mode === 'hold' && r.holdKind === 'service' && /Set Gianna's private-pay service/.test(r.holdReason));
  r = d(plan('Max Example', 'Gianna Hernandez'), plain);
  check('…preset without a code → private, the preset kept', r.mode === 'private' && r.wantService === '');
  r = d(plan('Rowan Testerly', 'Gianna Hernandez'), plain);
  check('Insurance on the list, preset with no code → the codes are ADDED and flagged', r.mode === 'insurance' && r.services.length === 2 && /client list says Insurance, so the codes were added/.test(r.warnings[0]));
  r = d(plan('Rowan Testerly', 'Gianna Hernandez'), coded);
  check('Insurance with a coded preset → codes, nothing to flag', r.mode === 'insurance' && r.services.length === 2 && !r.warnings.length);
  r = d(plan('Rowan Testerly', 'Jade Lee MeeSook'), coded);
  check('Insurance, but no codes for Jade anywhere → SimplePractice\'s preset kept and flagged', r.mode === 'insurance' && r.keptPreset && /preset "97535/.test(r.warnings[0]));
  r = d(plan('Rowan Testerly', 'Jade Lee MeeSook'), plain);
  check('…and with no coded preset either → held ("codes")', r.mode === 'hold' && r.holdKind === 'codes');
  r = d(plan('Nora Newname', 'Jade Lee MeeSook'), plain);
  check('not on the list, preset with no code → private with the therapist\'s service (Massage), not required', r.mode === 'private' && r.wantService === 'Massage' && !r.serviceRequired);
  r = d(plan('Nora Newname', 'Gianna Hernandez'), coded);
  check('not on the list, coded preset → insurance with the codes', r.mode === 'insurance' && r.services.length === 2);
  r = d(plan('Nora Newname', 'Gianna Hernandez'), none);
  check('no preset at all → the plan decides (insurance codes)', r.mode === 'insurance' && r.services.length === 2);
  check('what the client search showed goes into the alert', book.seenLine(['Sam Doe', 'No results found']) === "SimplePractice's search showed: Sam Doe" && /no matching client/.test(book.seenLine([])));
})();

(async function testPlaceholderIsNoPreset() {
  console.log('# SimplePractice\'s "Select service" row is not a preset');
  const fakePage = (html, pick) => {
    const doc = new JSDOM(html).window.document;
    const el = doc.querySelector('select');
    if (pick != null) el.selectedIndex = pick;
    return { $eval: async (sel, fn) => fn(doc.querySelector(sel)) };
  };
  // The markup SimplePractice draws (from the captured dialog).
  const SP = '<select name="code"><option disabled="">Select service</option><optgroup label="Practice Services"><option value="97124"> 97124 Therapeutic procedure; massage </option><option value="97112"> 97112 Neuromuscular re-education </option></optgroup></select>';
  const none = await book.readPresetService(fakePage(SP, 0), 'select[name="code"]');
  check('nothing chosen ("Select service" showing) → no preset, not "private with no code"', none.found === false);
  const chosen = await book.readPresetService(fakePage(SP, 2), 'select[name="code"]');
  check('a real service chosen → that preset, with its code', chosen.found && chosen.hasCode && chosen.label === '97112 Neuromuscular re-education');
  check('…so an unlisted client with no preset gets the therapist\'s codes', book.decideBilling(plan('Nora Newname', 'Gianna Hernandez'), none).mode === 'insurance');
})();

/* ---------------------- booking, on a fake SimplePractice ---------------------- */
const SERVICES = [
  { value: 's1', label: '97112 Neuromuscular re-education' }, { value: 's2', label: '97530 Therapeutic activities' },
  { value: 's3', label: '92507 Speech treatment' }, { value: 's4', label: '92523 Speech sound and language evaluation' },
  { value: 's5', label: '97535 Self-care / home management training' }, { value: 's6', label: '92626 Auditory rehabilitation' },
  { value: 'hv', label: 'Home Visit' }, { value: 'mt', label: 'Massage Therapy' }, { value: 'ptr', label: 'Personal Training' },
];
function fakeDialog(cfg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fake new appointment</title></head><body>
<div id="dlg">
  <div data-validation-path="client"><button class="typeahead-trigger" type="button"><span class="typeahead-label">Choose a client</span></button>
    <div class="box" style="display:none"><input class="select-box__input"><div class="select-box__options"></div></div></div>
  <div id="rest"></div>
</div>
<script>
const CFG = ${JSON.stringify(cfg)};
window.__locClicks = 0; window.__saved = null;
const cbox = document.querySelector('[data-validation-path="client"]');
const trig = cbox.querySelector('.typeahead-trigger'), box = cbox.querySelector('.box');
const input = cbox.querySelector('.select-box__input'), list = cbox.querySelector('.select-box__options');
trig.addEventListener('click', () => { box.style.display = 'block'; input.value = ''; list.innerHTML = ''; input.focus(); });
input.addEventListener('input', () => {
  const words = input.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  setTimeout(() => {   // results arrive a moment later
    const hits = CFG.clients.filter((c) => words.length && words.every((w) => c.name.toLowerCase().includes(w)));
    list.innerHTML = hits.length ? hits.map((c) => '<div class="select-box__option" data-i="' + CFG.clients.indexOf(c) + '"><span class="client-name">' + c.name + '</span></div>').join('')
      : '<div class="select-box__option no-results">No results found</div>';
  }, 120);
});
list.addEventListener('click', (e) => {
  const o = e.target.closest('.select-box__option'); if (!o || o.classList.contains('no-results')) return;
  const c = CFG.clients[+o.dataset.i];
  box.style.display = 'none'; trig.querySelector('.typeahead-label').textContent = c.name; window.__client = c.name;
  rest(c);
});
function line(preset) {
  const opts = ['<option disabled="">Select service</option>'].concat(CFG.services.map((s) => '<option value="' + s.value + '"' + (s.value === preset ? ' selected' : '') + '>' + s.label + '</option>')).join('');
  return '<div class="svc-line"><select name="code">' + opts + '</select><input name="numberOfUnits" aria-label="Number of Units" value="1">'
    + [1, 2, 3, 4].map((k) => '<input name="modifier' + k + '" placeholder="AA">').join('') + '</div>';
}
function rest(c) {
  const r = document.getElementById('rest');
  r.innerHTML = '<input name="startDate"><input name="startTime">'
    + '<div class="shared-clinician-dropdown-container"><label>Clinician</label><div class="non-editable-dropdown"><div class="typeahead-label">Caryn McAllister</div></div></div>'
    + '<div data-validation-path="officeId"><button class="typeahead-trigger" type="button"><span class="loc-label">' + (c.place || 'Preset place of service') + '</span></button></div>'
    + '<div id="lines">' + line(c.preset || '') + '</div>'
    + '<button type="button" aria-label="add service">+ Add service</button><button type="button" class="submit-form">Save</button>';
  r.querySelector('[data-validation-path="officeId"] .typeahead-trigger').addEventListener('click', () => { window.__locClicks++; });
  r.querySelector('[aria-label="add service"]').addEventListener('click', () => setTimeout(() => {
    // A new line starts on the client's preset service, as the reported speech visit did.
    document.getElementById('lines').insertAdjacentHTML('beforeend', line(c.preset || ''));
  }, 80));
  const clin = r.querySelector('.non-editable-dropdown');
  clin.addEventListener('click', () => setTimeout(() => {
    const l = document.createElement('div');
    l.innerHTML = ['Caryn McAllister', 'Heather Vines Dubose', 'Karine Rocha De Benedicto'].map((n) => '<div class="select-box__option">' + n + '</div>').join('');
    l.addEventListener('click', (e) => { clin.querySelector('.typeahead-label').textContent = e.target.textContent; l.remove(); });
    document.body.appendChild(l);
  }, 200));
  r.querySelector('.submit-form').addEventListener('click', () => {
    const lines = [...document.querySelectorAll('.svc-line')].map((d) => {
      const s = d.querySelector('select'); const o = s.options[s.selectedIndex];
      return { label: o && o.value ? o.textContent.trim() : '', units: d.querySelector('[name=numberOfUnits]').value, mods: [...d.querySelectorAll('[name^=modifier]')].map((i) => i.value).filter(Boolean) };
    });
    window.__saved = { client: window.__client, clinician: clin.querySelector('.typeahead-label').textContent.trim(), place: r.querySelector('.loc-label').textContent, lines };
    document.getElementById('dlg').innerHTML = '<p>Saved</p>';
  });
}
</script></body></html>`;
}

async function testBooking() {
  console.log('# Booking on a fake SimplePractice dialog');
  if (!fs.existsSync('/Applications/Google Chrome.app')) { console.log('  skip  booking (Google Chrome not installed here)'); return; }
  const { chromium } = require('playwright-core');
  const cases = {};
  const server = http.createServer((req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('case');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fakeDialog(cases[id] || { clients: [], services: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const realUrl = presets.SP.newApptUrl;
  const run = async (id, cfg, appt) => {
    cases[id] = { services: SERVICES, ...cfg };
    presets.SP.newApptUrl = `http://127.0.0.1:${port}/new?case=${id}`;
    const page = await browser.newPage();
    // Nothing but the fake page is ever loaded.
    await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    try {
      const steps = [];
      const res = await book.bookAppointment(page, { date: '11/04/2026', time: '10:00 AM', ...appt }, { dryRun: false, onStep: (t) => steps.push(t) });
      const saved = await page.evaluate(() => window.__saved).catch(() => null);
      const locClicks = await page.evaluate(() => window.__locClicks).catch(() => null);
      return { res, saved, locClicks, steps };
    } finally { await page.close(); }
  };
  const asPlan = (patient, therapist, clients = CLIENTS) => ({ ...plan(patient, therapist, {}, clients) });
  try {
    let r = await run('insurance', { clients: [{ name: 'Rowan Testerly', preset: 's2', place: '12 Home Street (preset)' }] }, asPlan('Rowan Testerly', 'Gianna Hernandez'));
    check('insurance visit saved', r.res.ok && !!r.saved);
    check('…both lines by their label (values aren\'t codes), units and modifiers on each', r.saved && JSON.stringify(r.saved.lines.map((l) => [l.label.slice(0, 5), l.units, l.mods.join(',')])) === JSON.stringify([['97112', '2', 'GP'], ['97530', '2', 'GP,59']]));
    check('…under Caryn', r.saved && r.saved.clinician === 'Caryn McAllister');
    check('…and the place of service was never touched', r.locClicks === 0 && r.saved && r.saved.place === '12 Home Street (preset)' && !r.steps.some((t) => /^Location/.test(t)));

    const speech = { ...asPlan('Rowan Testerly', 'Joan Black'), payer: 'insurance' };
    r = await run('missing-code', { clients: [{ name: 'Rowan Testerly', preset: 's2' }], services: SERVICES.filter((s) => s.value !== 's5') }, speech);
    check('a code SimplePractice doesn\'t offer (97535) → not saved', !r.res.ok && r.saved === null && r.res.reason === 'codes');
    check('…saying which code, and what the line would have kept', /no service 97535/.test(r.res.error) && /97530 Therapeutic activities/.test(r.res.error));
    r = await run('speech-ok', { clients: [{ name: 'Rowan Testerly', preset: 's2' }] }, speech);
    check('with 97535 offered, the speech visit gets 92523, 92507, 92626, 97535 x2 (never 97530)', r.res.ok && r.saved && r.saved.lines.map((l) => l.label.slice(0, 5)).join() === '92523,92507,92626,97535' && r.saved.lines[3].units === '2');

    r = await run('massage', { clients: [{ name: 'Ida Placeholder', preset: 's5' }] }, asPlan('Ida Placeholder', 'Jade Lee MeeSook'));
    check('"Jade: Massage", preset an insurance code → saved as Massage Therapy, one line, no codes', r.res.ok && r.saved && r.saved.lines.length === 1 && r.saved.lines[0].label === 'Massage Therapy' && !r.saved.lines[0].mods.length);
    check('…place of service untouched there too', r.locClicks === 0);
    r = await run('massage-missing', { clients: [{ name: 'Ida Placeholder', preset: 's5' }], services: SERVICES.filter((s) => s.value !== 'mt') }, asPlan('Ida Placeholder', 'Jade Lee MeeSook'));
    check('…SimplePractice without a massage service → not saved ("service"), its private services listed', !r.res.ok && r.saved === null && r.res.reason === 'service' && /Home Visit, Personal Training/.test(r.res.error));

    const priv = asPlan('Jordan Sampleton', 'Gianna Hernandez', [{ name: 'Jordan Sampleton', status: 'Private' }]);
    r = await run('records', { clients: [{ name: 'Jordan PT Sampleton', preset: 's1' }, { name: 'Jordan OT Sampleton', preset: 's1' }, { name: 'Jordan SLP Sampleton', preset: 's3' }] }, priv);
    check('a private client with only PT/OT/SLP records → not saved ("record"), records named', !r.res.ok && r.saved === null && r.res.reason === 'record' && /Jordan PT Sampleton/.test(r.res.error));

    r = await run('list-says-insurance', { clients: [{ name: 'Rowan Testerly', preset: 'hv' }] }, asPlan('Rowan Testerly', 'Gianna Hernandez'));
    check('client list Insurance, preset "Home Visit" → codes added, flagged to check', r.res.ok && r.saved && r.saved.lines.map((l) => l.label.slice(0, 5)).join() === '97112,97530' && (r.res.warnings || []).some((w) => /client list says Insurance/.test(w)));

    r = await run('therapist-service', { clients: [{ name: 'Nora Newname', preset: 'hv' }] }, asPlan('Nora Newname', 'Jade Lee MeeSook'));
    check('not on the list, preset "Home Visit", seen by Jade → booked as her Massage', r.res.ok && r.saved && r.saved.lines.length === 1 && r.saved.lines[0].label === 'Massage Therapy');
  } finally {
    presets.SP.newApptUrl = realUrl;
    await browser.close();
    server.close();
  }
}

/* -------- the whole sync, with Practice Fusion and SimplePractice stood in for -------- */
async function testSyncFlow() {
  console.log('# A full sync run: two days, cancellations, a new client, the calendar check');
  const login = require(path.join(__dirname, '..', 'src', 'main', 'login'));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const heading = (d) => `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const key = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const row = (i, name, provider, status = 'PN Pending arrival', note = '') => `<tr class="data-table__row">
    <td><div data-element="intake-status-select-${i}"><span class="composable-select__selection">${status}</span></div></td>
    <td><a data-element="cell-name">${name}</a></td><td data-element="cell-provider-name-${i}">${provider}</td>
    <td><p data-element="cell-appointment-type-${i}">Follow-Up Visit</p></td><td data-element="cell-chief-complaint-${i}">${note}</td></tr>`;
  const SCHEDULE = {
    '11/04/2026': [
      row(0, 'Rowan Testerly', 'Gianna Hernandez'),
      row(1, 'Ida Placeholder', 'JR Meehan', 'CX Cancelled', 'CX>24'),
      row(2, 'Max Example', 'Jade Lee MeeSook', 'CX Cancelled', 'CX<24 sick'),
      row(3, 'Pia Privata', 'Gianna Hernandez', 'NS No show'),
      row(4, 'Nora Newname', 'Gianna Hernandez'),
    ],
    '11/05/2026': [row(0, 'Rowan Testerly', 'Gianna Hernandez', 'Cancelled', 'Therapist CX')],
  };
  // On the calendar: Ida's visit (booked before it was cancelled) and Rowan's 11/05.
  const CALENDAR = {
    '11/04/2026': [{ title: 'Ida Placeholder', clinician: 'Caryn McAllister' }],
    '11/05/2026': [{ title: 'Rowan Testerly', clinician: 'Caryn McAllister' }],
  };
  let cur = new Date(2026, 10, 4);
  const page = {
    goto: async () => {}, waitForSelector: async () => true, $$: async () => [], $$eval: async () => 0,
    keyboard: { press: async () => {} }, evaluate: async () => undefined,
    $: async (sel) => (sel === presets.PF.nav.dateHeading ? { textContent: async () => heading(cur) } : null),
    click: async (sel) => { cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + (sel.includes('next') ? 1 : -1)); },
    content: async () => `<html><body><div data-element="scheduler-selected-date">${heading(cur)}</div><table><tbody>${(SCHEDULE[key(cur)] || []).join('')}</tbody></table></body></html>`,
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const saved = { pf: login.loginPracticeFusion, sp: login.loginSimplePractice, nav: book.spNavigateToDate, read: book.spReadDay, booking: book.bookAppointment };
  const booked = [];
  const daysRead = [];
  login.loginPracticeFusion = async () => ({ ok: true });
  login.loginSimplePractice = async () => ({ ok: true });
  book.spNavigateToDate = async () => true;
  book.spReadDay = async (_p, date) => { daysRead.push(date); return { ok: true, titles: (CALENDAR[date] || []).slice() }; };
  book.bookAppointment = async (_p, appt) => { booked.push(`${appt.date} ${appt.patientName}`); return { ok: true, warnings: [] }; };
  try {
    const res = await sync.runFullSync({
      secrets: { practiceFusion: {}, simplePractice: {} }, dates: ['11/04/2026', '11/05/2026'],
      providers: ROSTER, mainDoctors: MAINS, clientPayers: CLIENTS, save: true, onStep: () => {}, context,
    });
    const by = (s) => res.outcomes.filter((o) => o.status === s).map((o) => `${o.date} ${o.patientName}`);
    check('the run finishes', res.ok === true);
    check('booked: Rowan, the late cancel (CX<24), and the new client — nothing cancelled', booked.join(' | ') === '11/04/2026 Rowan Testerly | 11/04/2026 Max Example | 11/04/2026 Nora Newname');
    check('CX>24 and Therapist CX → "cancelled", not booked', by('cancelled').join(' | ') === '11/04/2026 Ida Placeholder | 11/05/2026 Rowan Testerly');
    check('the no-show with no term → held on Alerts', by('cancel_unclear').join() === '11/04/2026 Pia Privata');
    check('the late cancel is flagged on its booking', res.outcomes.some((o) => o.status === 'booked' && o.patientName === 'Max Example' && o.warnings.some((w) => /CX<24/.test(w))));
    check('one new-client reminder (Nora)', by('new_client').join() === '11/04/2026 Nora Newname');
    check('Ida (cancelled CX>24, still on the calendar) → "delete it in SimplePractice"', by('cancelled_on_calendar').includes('11/04/2026 Ida Placeholder'));
    check('11/05 has only a cancelled visit, and its calendar was still checked', daysRead.includes('11/05/2026') && by('cancelled_on_calendar').includes('11/05/2026 Rowan Testerly'));
    check('Rowan\'s real 11/04 visit wasn\'t taken for a cancelled one', !by('cancelled_on_calendar').includes('11/04/2026 Rowan Testerly'));
  } finally {
    login.loginPracticeFusion = saved.pf; login.loginSimplePractice = saved.sp;
    book.spNavigateToDate = saved.nav; book.spReadDay = saved.read; book.bookAppointment = saved.booking;
  }
}

(async () => {
  await testSyncFlow();
  await testBooking();
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
