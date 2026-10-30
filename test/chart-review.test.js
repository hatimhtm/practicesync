'use strict';

/*
 * The Client Chart Review checks, on the page text of the practice's test patient
 * (from their own walkthrough of "TestTwenttyTwenyFive Patient"), plus variations.
 */

const path = require('path');
const cr = require(path.join(__dirname, '..', 'src', 'main', 'chartReview'));
const m = require(path.join(__dirname, '..', 'src', 'main', 'model'));

let passed = 0;
let failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

const SUMMARY = `Flowsheets
Practice
Vitals
Launch SMART app
Diagnoses
Show by
ICD-10
Undefined
(R53.1) Weakness
Patient risk score
No patient risk score recorded
Encounters
04/19/2025 185349003 (SNOMED-CT) Office Visit`;

const PINNED = `TestTwenttyTwenyFive Patient - Pinned note
Services: PT
MD Referral Expires: 9/19/26
HQHT Authorized Visits: PER Client REQUEST
MD Signed POC for PT: Signed 4/24
PT Reassessment due: 10/17/26
Documentation Type: Basic note

Weekly Schedule: 3x/wk PT
Mo - Dr. Caryn
Tu - N/A
We - Dr. Caryn
Th - N/A
Fr - Dr. Caryn
Sa - N/A
Su - N/A
EDITED BY ABIN PURAYIDATHIL 08/27/2026, 10:18 AM`;

const INTAKES = `1:37 PM
Intake forms
TYPE/SOURCE
DETAILS
INTAKE FORM TITLE
STATUS
DATE RECEIVED
Intake form for 06/26/25
Appointment with Caryn McAllister
HQHT Intake Forms
Submitted by Patient
12/31/00`;

const ENCOUNTERS = `Encounters
New encounter
TYPE/SOURCE
DETAILS
STATUS
Office Visit
Caryn McAllister PT, DPT
SOAP Note
CC: No chief complaint recorded
04/19/2025
Office Visit
Caryn McAllister PT, DPT
SOAP Note
CC: PT eval (Appt time: 4/17/2025 11:00:00 AM) (Arrival time: 10:24 AM)
04/17/2025`;

const DOCUMENTS = `Pending
TITLE
TYPE
COMMENTS
PROVIDER
DATE
MD Signed Plan of Care on 08.27.26.pdf
Other
08/27/2026
MD Referral Expires 11/27/26
Other
Abin Purayidathil
08/27/2026`;

const PROFILE = `Patient
NAME
TestTwenttyTwenyFive Patient
SEX
Male
DATE OF BIRTH
10/21/2000
Contact
Phone
Edit
MOBILE
(203) 434-2296
HOME
--
Email
Edit
scheduling@highqualityhometherapy.com
Preferred method of communication
Provider did not ask
Appointment reminders and messaging
ON
Email reminders and messaging
ON
Text / SMS reminders and messaging
OFF
Voice reminders and messaging
Practice documented patient's voice and text consent
Address
Current address
30 Buxton Farm Road
Stamford, CT 06905
Demographics
Race
Provider did not ask
Care team
In practice
Caryn McAllister
Physical Therapy
RELATION TO PATIENT
Preferred provider in practice
My connections
Peter McAllister
Neurology
RELATION TO PATIENT
Primary care provider, Referring provider
Add provider
Next of kin`;

const PROFILE_SMS_OFF = PROFILE.replace('ON\nText / SMS reminders', 'OFF\nText / SMS reminders');
const providers = m.DEMO_PROVIDERS;
const today = new Date(2026, 9, 30); // Fri Oct 30, 2026
const ws0 = cr.mondayOf(today), ws1 = new Date(ws0.getTime() + 7 * 86400000);
const day = (y, mo, d) => new Date(y, mo - 1, d);
const visits3x = [day(2026, 10, 26), day(2026, 10, 28), day(2026, 10, 30), day(2026, 11, 2), day(2026, 11, 4), day(2026, 11, 6)].map((date) => ({ date, discipline: 'PT' }));
const base = { summary: SUMMARY, pinnedNote: PINNED, intakes: INTAKES, encounters: ENCOUNTERS, documents: DOCUMENTS, profile: PROFILE };
const run = (pages, visits = visits3x) => Object.fromEntries(cr.reviewChart(pages, { today, providers, visits, weekStarts: [ws0, ws1] }).map((i) => [i.key, i]));

(function testParsers() {
  console.log('# Reading the test patient\'s pages');
  check('diagnosis (R53.1) Weakness', cr.parseDiagnoses(SUMMARY).map((d) => d.code).join() === 'R53.1');
  check('SNOMED codes in Encounters are not diagnoses', cr.parseDiagnoses('Diagnoses\nUndefined\nPatient risk score\n185349003 (SNOMED-CT)').length === 0);
  const n = cr.parsePinnedNote(PINNED);
  check('pinned: services PT', n.services.join() === 'PT');
  check('pinned: referral 9/19/26, doc type, POC, reassessment', n.referralExpires === '9/19/26' && /Basic/.test(n.documentationType) && n.poc.PT === 'Signed 4/24' && n.reassessment.PT === '10/17/26');
  check('pinned: 7-day mini calendar + 3x/wk PT', n.days.length === 7 && n.frequency.PT === 3);
  check('"PT, OT" and "PT/ST" disciplines', cr.parseDisciplines('PT, OT').join() === 'PT,OT' && cr.parseDisciplines('PT/ST').join() === 'PT,SLP');
  const p = cr.parseProfile(PROFILE);
  check('profile: name, sex, DOB, phone, email, address', p.name && p.sex === 'Male' && p.dob === '10/21/2000' && p.phone && p.email && p.address);
  check('profile: Email + Text/SMS reminders ON, as in the video', p.reminders.email === 'on' && p.reminders.sms === 'on');
  check('…and Text/SMS OFF is read as off', cr.parseProfile(PROFILE_SMS_OFF).reminders.sms === 'off');
  check('care team: 1 preferred, has referring', p.preferredCount === 1 && p.hasReferring);
  const e = cr.parseEncounters(ENCOUNTERS);
  check('encounters: 2 rows, appt-time dates ignored', e.length === 2 && cr.therapistsIn(e[0].chunk, providers).map((t) => t.name).join() === 'Caryn McAllister');
})();

(function testReviewOfTestPatient() {
  console.log('# The test patient, as in the walkthrough');
  const r = run(base);
  check('diagnosis OK', r.diagnosis.status === 'ok');
  check('intake forms OK', r.intake.status === 'ok');
  check('referral: pinned 9/19/26 vs document 11/27/26 → update the pinned note', r.referral.status === 'problem' && r.referral.notes.some((x) => /9\/19\/26.*11\/27\/26.*update the pinned note/.test(x)));
  check('referral also flagged as expired (9/19/26 is past)', r.referral.notes.some((x) => /expired 9\/19\/26/.test(x)));
  check('PT reassessment 10/17/26 overdue', r.reassessments.status === 'problem' && /PT reassessment was due 10\/17\/26/.test(r.reassessments.notes[0]));
  check('POC "Signed 4/24" → OK (signed, with a date)', !r.planOfCare.notes.some((x) => /4\/24/.test(x)));
  check('contact details + reminders OK', r.contact.status === 'ok');
  const r2 = run({ ...base, profile: PROFILE_SMS_OFF });
  check('Text/SMS OFF → turn it on', r2.contact.status === 'problem' && r2.contact.notes.some((x) => /Text\/SMS reminders are OFF/.test(x)));
  check('care team OK (Caryn preferred, referring MD, Caryn seen)', r.careTeam.status === 'ok');
  check('schedule 3x/wk both weeks OK', r.schedule.status === 'ok');
})();

(function testProblems() {
  console.log('# Problems it must catch');
  let r = run({ ...base, summary: 'Diagnoses\nShow by\nICD-10\nPatient risk score' });
  check('no diagnosis → flagged', r.diagnosis.status === 'problem');
  r = run({ ...base, intakes: 'Intake forms\nTYPE/SOURCE\nDETAILS', documents: DOCUMENTS });
  check('no intake form anywhere → alert (mentions Abin)', r.intake.status === 'problem' && /Abin/.test(r.intake.notes[0]));
  r = run({ ...base, intakes: 'Intake forms\nTYPE/SOURCE', documents: DOCUMENTS + '\nHQHT Intake Forms signed.pdf' });
  check('intake only in Documents → OK', r.intake.status === 'ok');
  r = run({ ...base, profile: PROFILE.replace('ON\nEmail reminders', 'OFF\nEmail reminders').replace('Appointment reminders and messaging', 'Appointment reminders and messaging\nOverride') });
  check('Override lock → reminders left alone, not flagged', !r.contact.notes.some((x) => /OFF/.test(x)) && r.contact.notes.some((x) => /Override/.test(x)));
  r = run({ ...base, profile: PROFILE.replace('Primary care provider, Referring provider', 'Primary care provider') });
  check('no referring provider → flagged', r.careTeam.notes.some((x) => /No referring provider/.test(x)));
  r = run({ ...base, profile: PROFILE.replace('Neurology\nRELATION TO PATIENT\nPrimary care provider', 'Neurology\nRELATION TO PATIENT\nPreferred provider in practice, Primary care provider') });
  check('two preferred providers → flagged', r.careTeam.notes.some((x) => /2 preferred providers/.test(x)));
  r = run({ ...base, encounters: ENCOUNTERS + '\nOffice Visit\nJessica Trujillo OT\nSOAP Note\n10/01/2026' });
  check('therapist seen recently but not on care team → named', r.careTeam.notes.some((x) => /Jessica Trujillo/.test(x)));
  r = run({ ...base, encounters: 'Office Visit\nJessica Trujillo OT\nSOAP Note\n01/05/2026' });
  check('…but not one last seen over 4 months ago', !r.careTeam.notes.some((x) => /Jessica Trujillo/.test(x)));
  r = run({ ...base, pinnedNote: PINNED.replace('Services: PT', 'Services: PT, OT') });
  check('OT service without OT POC / reassessment → flagged', r.planOfCare.notes.some((x) => /plan of care line for OT/.test(x)) && r.reassessments.notes.some((x) => /no OT reassessment/.test(x)));
  check('…and no OT visits scheduled → flagged', r.schedule.notes.some((x) => /No OT visit this week/.test(x)));
  r = run(base, visits3x.filter((v) => v.date < ws1));
  check('not scheduled next week → flagged', r.schedule.status === 'problem' && r.schedule.notes.some((x) => /next week/.test(x)));
  r = run(base, visits3x.filter((_, i) => i !== 1));
  check('2 of 3 visits this week → check', r.schedule.status === 'check');
  r = run({ ...base, pinnedNote: '' });
  check('no pinned note → flagged', r.pinnedNote.status === 'problem');
  r = run({ ...base, documents: null });
  check('a page that couldn\'t be read → "check by hand", never OK', r.referral.status !== 'ok' && r.referral.notes.some((x) => /Couldn't read/.test(x)));
})();

(function testFollowUps() {
  console.log('# Follow-ups — tracked until resolved');
  const res = (items) => [{ ok: true, patientKey: 'patient testtwenttytwenyfive', patientName: 'TestTwenttyTwenyFive Patient', items }];
  const withOff = { ...base, profile: PROFILE_SMS_OFF };
  const first = cr.mergeFollowUps([], res(cr.reviewChart(withOff, { today, providers, visits: visits3x, weekStarts: [ws0, ws1] })), 'T1');
  check('each finding becomes one follow-up', first.length >= 4 && first.every((f) => !f.resolvedAt));
  const again = cr.mergeFollowUps(first, res(cr.reviewChart(withOff, { today, providers, visits: visits3x, weekStarts: [ws0, ws1] })), 'T2');
  check('re-running doesn\'t duplicate them', again.length === first.length);
  const fixed = base;
  const later = cr.mergeFollowUps(again, res(cr.reviewChart(fixed, { today, providers, visits: visits3x, weekStarts: [ws0, ws1] })), 'T3');
  const sms = later.find((f) => /Text\/SMS/.test(f.note));
  check('a fixed item is closed automatically on the next review', sms && sms.resolvedAt === 'T3' && sms.resolvedBy === 'review');
})();

(function testRealNotes() {
  console.log('# The way staff actually write the pinned note (from the first real run)');
  const sent = cr.parsePinnedNote('Services: PT\nMD Referral Expires: 10/15\nMD Signed POC for PT: Sent on PF 10/20 LS\nPT Reassessment due: 11/8/26');
  let r = run({ ...base, pinnedNote: PINNED.replace('MD Signed POC for PT: Signed 4/24', 'MD Signed POC for PT: Sent on PF 10/20 LS') });
  check('"Sent on PF 10/20 LS" → PT plan of care not signed yet', r.planOfCare.notes.some((x) => /PT plan of care isn't signed yet/.test(x)));
  check('"10/15" with no year → Oct 15 2026, not 2015', cr.parseLooseDate(sent.referralExpires, today).date.getFullYear() === 2026);
  r = run({ ...base, pinnedNote: PINNED.replace('MD Referral Expires: 9/19/26', 'MD Referral Expires: 10/15') });
  check('…so it says "expired 10/15 (15 days ago)"', r.referral.notes.some((x) => /expired 10\/15/.test(x)));
  const alt = cr.parsePinnedNote(`Services: PT, OT, ST
Referral exp: 12/1/26
PT POC: signed 9/2/26
OT POC - signed 9/3/26
Plan of Care (ST): signed 9/4/26
PT re-eval due: 12/2/26
OT Re-assessment due 12/3/26
ST reassess: 12/4/26
Documentation type: Insurance note`);
  check('3 services incl. ST → SLP', alt.services.join() === 'PT,OT,SLP');
  check('"Referral exp: 12/1/26" is the referral date', alt.referralExpires === '12/1/26');
  check('"PT POC:", "OT POC -", "Plan of Care (ST):" all read', alt.poc.PT && alt.poc.OT && alt.poc.SLP);
  check('"re-eval due", "Re-assessment due", "reassess:" all read', alt.reassessment.PT === '12/2/26' && /12\/3\/26/.test(alt.reassessment.OT) && alt.reassessment.SLP === '12/4/26');
  check('"Documentation type:" lower case read', /Insurance/.test(alt.documentationType));
  r = run({ ...base, pinnedNote: 'Services: PT\nMD Referral Expires: 11/27/26\nMD Signed POC for PT: Signed 4/24\nPT Reassessment due: 12/17/26\nDocumentation Type: Basic note\nWeekly Schedule: 3x/wk PT\nMo - Caryn' }, visits3x.map((v) => ({ ...v, discipline: '' })));
  check('visits whose discipline couldn\'t be told → "couldn\'t tell", not "No PT visit"', !r.schedule.notes.some((x) => /^No PT visit/.test(x)) && r.schedule.notes.some((x) => /Couldn't tell/.test(x)));
})();

(function testDaylightSaving() {
  console.log('# Clocks change Sun Nov 1, 2026');
  const w = cr.weeksInRange(day(2026, 10, 26), day(2026, 11, 8), today);
  check('next week starts Mon 11/2, not "11/1"', w[1].start.getDate() === 2 && w[1].start.getMonth() === 10);
  check('Monday of a week after the change is a Monday', cr.mondayOf(day(2026, 11, 4)).getDay() === 1 && cr.mondayOf(day(2026, 11, 4)).getDate() === 2);
})();

(function testRanges() {
  console.log('# Date ranges');
  const w = cr.weeksInRange(day(2026, 10, 26), day(2026, 11, 8), today);
  check('this + next week → 2 full weeks, labelled', w.length === 2 && w[0].weekdays === 5 && w[1].weekdays === 5 && w[0].label === 'this week' && w[1].label === 'next week');
  const p = cr.weeksInRange(day(2026, 10, 30), day(2026, 11, 28), today);
  check('Fri 10/30 → Sat 11/28: first week has 1 weekday, then 3 full weeks + 1 partial', p.length === 5 && p[0].weekdays === 1 && p[1].weekdays === 5 && p[4].weekdays === 5);
  const r = Object.fromEntries(cr.reviewChart(base, { today, providers, visits: visits3x.filter((v) => v.date >= day(2026, 10, 30)), weeks: cr.weeksInRange(day(2026, 10, 30), day(2026, 11, 8), today) }).map((i) => [i.key, i]));
  check('a 1-weekday partial week isn\'t judged on frequency', r.schedule.status === 'ok');
  const later = cr.reviewChart(base, { today, providers, visits: visits3x, weeks: cr.weeksInRange(day(2026, 11, 9), day(2026, 11, 22), today) }).find((i) => i.key === 'schedule');
  check('weeks with no visits later in the range → "not scheduled the week of 11/9/26"', later.status === 'problem' && later.notes.some((x) => /week of 11\/9\/26/.test(x)));
})();

(async function testParallel() {
  console.log('# Several charts at once');
  let open = 0, peak = 0;
  const fakeTab = () => ({
    goto: async () => { open += 1; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 15)); open -= 1; },
    evaluate: async () => 'Diagnoses\nTYPE/SOURCE\nTITLE\nContact\nCare team', evaluateHandle: async () => null, $: async () => null, keyboard: { press: async () => {} }, url: () => '',
  });
  const visits = Array.from({ length: 8 }, (_, i) => ({ patientName: `Test Client${i}`, doctorName: 'Gianna G', date: '11/02/2026', href: `#/PF/charts/patients/00000000-0000-0000-0000-00000000000${i}/summary` }));
  let asked = [];
  await cr.runChartReview({ pages: [fakeTab()], readSchedule: async (d) => { asked = d; return []; }, providers, today, start: '10/30/2026', end: '11/03/2026' });
  check('days across the clock change: 10/30, 10/31, 11/01, 11/02, 11/03 — none twice, none skipped', asked.join(' ') === '10/30/2026 10/31/2026 11/01/2026 11/02/2026 11/03/2026');
  const res = await cr.runChartReview({ pages: [fakeTab(), fakeTab(), fakeTab(), fakeTab()], readSchedule: async () => visits, providers, mainDoctors: m.DEMO_MAIN_DOCTORS, today, start: '11/02/2026', end: '11/02/2026' });
  check('all 8 clients reviewed, each once', res.length === 8 && new Set(res.map((r) => r.patientKey)).size === 8);
  check('up to 4 at the same time', peak > 1 && peak <= 4);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
