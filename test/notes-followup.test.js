'use strict';

/*
 * Notes follow-up: Seen visits need a note within 24 hours; reminders go to each
 * therapist (to the test address while test mode is on).
 *
 *   node test/notes-followup.test.js
 */

const path = require('path');
const { JSDOM } = require('jsdom');
const nf = require(path.join(__dirname, '..', 'src', 'main', 'notesFollowUp'));
const { compose } = require(path.join(__dirname, '..', 'src', 'main', 'mailer'));
const { extractVisits } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));

let pass = 0; const fails = [];
const check = (n, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${n}`); ok ? pass++ : fails.push(n); };

const providers = [
  { name: 'Jessica Trujillo', mainDoctor: 'A' },
  { name: 'Nardeen Abdelsayed', mainDoctor: 'B' },
  { name: 'Eileen McGonegal', mainDoctor: 'C' },
];

(function schedule() {
  console.log('# the schedule row says whether the note is there');
  check('"View in encounter" = note started', nf.encounterState('10:30 AMView in encounter') === 'started');
  check('"Start Encounter" = no note', nf.encounterState('10:30 AM Start Encounter') === 'none');
  check('neither = can\'t tell', nf.encounterState('10:30 AM') === '');
  check('Seen counts', nf.isSeen('Seen') && nf.isSeen('ZZ Seen'));
  check('Pending arrival does not', !nf.isSeen('PN Pending arrival'));
  check('Checked out counts', nf.isSeen('Checked out'));
})();

(function deadline() {
  console.log('# 24 hours from the appointment time');
  const at = nf.apptDateTime('11/13/2026', '10:30 AM');
  check('10:30 AM read', at.getHours() === 10 && at.getMinutes() === 30 && at.getDate() === 13);
  check('12:00 PM is noon', nf.apptDateTime('11/13/2026', '12:00 PM').getHours() === 12);
  check('12:15 AM is just after midnight', nf.apptDateTime('11/13/2026', '12:15 AM').getHours() === 0);
  check('01:30 PM is 13:30', nf.apptDateTime('11/13/2026', '01:30 PM').getHours() === 13);
  check('bad date → null', nf.apptDateTime('Nov 13', '10:30 AM') === null);

  const now = new Date(2026, 10, 13, 17, 30);
  const visits = [
    { patientName: 'Avery Stone', doctorName: 'Jessica Trujillo', date: '11/13/2026', time: '10:30 AM', status: 'Seen', encounter: 'none' },
    { patientName: 'Blake Morgan', doctorName: 'Nardeen Abdelsa...', date: '11/13/2026', time: '08:00 AM', status: 'Seen', encounter: 'started' },
    { patientName: 'Casey Hart', doctorName: 'Nardeen Abdelsa...', date: '11/12/2026', time: '09:15 AM', status: 'Seen', encounter: 'none' },
    { patientName: 'Emery Fox', doctorName: 'Eileen McGonegal', date: '11/13/2026', time: '09:30 AM', status: 'PN Pending arrival', encounter: 'none' },
    { patientName: 'Drew Ellis', doctorName: 'Samantha Comrie', date: '11/13/2026', time: '01:00 PM', status: 'Seen', encounter: '' },
  ];
  const list = nf.findNotes(visits, { providers, now });
  check('only Seen visits are checked (4 of 5)', list.length === 4);
  const avery = list.find((n) => n.patientName === 'Avery Stone');
  check('today\'s visit without a note is missing, not yet overdue', avery.note === 'missing' && !avery.overdue);
  check('…due 10:30 AM tomorrow', new Date(avery.dueAt).getDate() === 14 && new Date(avery.dueAt).getHours() === 10 && new Date(avery.dueAt).getMinutes() === 30);
  const casey = list.find((n) => n.patientName === 'Casey Hart');
  check('yesterday 9:15 AM without a note is overdue at 5:30 PM', casey.note === 'missing' && casey.overdue);
  check('a cut-off Practice Fusion name maps to the roster therapist', casey.therapist === 'Nardeen Abdelsayed');
  check('View in encounter = done', list.find((n) => n.patientName === 'Blake Morgan').note === 'done');
  check('no link seen = unknown (never emailed)', list.find((n) => n.patientName === 'Drew Ellis').note === 'unknown');

  console.log('# one reminder per therapist; test mode sends everything to the test address');
  const emails = { 'jessica trujillo': 'jess@x.com' };
  const test = nf.planReminders(list, { emails, testMode: true, testTo: 'nabil@highqualityhometherapy.com' });
  check('two therapists with missing notes → two reminders', test.length === 2);
  check('test mode: all go to the test address', test.every((r) => r.to === 'nabil@highqualityhometherapy.com'));
  check('…and still know who they were for', test.find((r) => r.therapist === 'Jessica Trujillo').intendedTo === 'jess@x.com');
  const live = nf.planReminders(list, { emails, testMode: false });
  check('live: the therapist\'s own email (name matched loosely)', live.find((r) => r.therapist === 'Jessica Trujillo').to === 'jess@x.com');
  check('live: no email on file → nowhere to send', live.find((r) => r.therapist === 'Nardeen Abdelsayed').to === '');
  check('done and unknown visits never get a reminder', !live.some((r) => r.items.some((i) => i.note !== 'missing')));

  console.log('# the email');
  const r = test.find((x) => x.therapist === 'Nardeen Abdelsayed');
  const mail = nf.reminderEmail({ therapist: r.therapist, items: r.items, intendedTo: r.intendedTo, test: true });
  check('subject says test + overdue + count', /^\[TEST\] Overdue: 1 visit note to complete/.test(mail.subject));
  check('says no note yet', mail.text.includes('No note yet'));
  check('greets by first name', mail.text.includes('Hi Nardeen,') && mail.html.includes('Hi Nardeen,'));
  check('client shown as first name + last initial only', mail.text.includes('Casey H.') && !mail.text.includes('Hart') && !mail.html.includes('Hart'));
  check('says the 24-hour rule, and nothing about insurance', /within 24 hours/.test(mail.text) && !/insurance/i.test(mail.text + mail.html));
  check('test banner names who it was for', mail.text.includes('this reminder is for Nardeen Abdelsayed (no email on file yet)'));
  const real = nf.reminderEmail({ therapist: 'Jessica Trujillo', items: [avery], test: false });
  check('a real reminder has no test banner', !/TEST/.test(real.subject) && !/TEST/.test(real.text) && !/TEST/.test(real.html));
  check('not overdue → "Due by"', /Due by Sat, Nov 14, 10:30 AM/.test(real.text));
  check('html escapes names', !nf.reminderEmail({ therapist: '<b>x</b> y', items: [avery] }).html.includes('<b>x</b>'));

  const msg = compose({ from: 'o@x.com', fromName: 'High Quality Home Therapy', to: ['n@x.com'], subject: mail.subject, body: mail.text, html: mail.html });
  check('message carries plain + html versions', /multipart\/alternative/.test(msg) && /text\/plain/.test(msg) && /text\/html/.test(msg));
  check('sender name is the practice', msg.includes('From: High Quality Home Therapy <o@x.com>'));
  check('no bare LFs', !msg.replace(/\r\n/g, '').includes('\n'));
})();

(function daily() {
  console.log('# the daily check at 5:30 PM');
  const at = (h, m) => new Date(2026, 10, 13, h, m);
  check('5:29 PM — not yet', !nf.dailyDue(at(17, 29), { time: '17:30' }));
  check('5:30 PM — runs', nf.dailyDue(at(17, 30), { time: '17:30' }));
  check('already ran today — no', !nf.dailyDue(at(18, 0), { time: '17:30', lastDay: '2026-11-13' }));
  check('ran yesterday — runs', nf.dailyDue(at(18, 0), { time: '17:30', lastDay: '2026-11-12' }));
  check('Mac woke at 8 PM — still runs', nf.dailyDue(at(20, 0), { time: '17:30' }));
  check('after 9 PM — waits for tomorrow', !nf.dailyDue(at(21, 5), { time: '17:30' }));
  check('bad time falls back to 5:30 PM', !nf.dailyDue(at(17, 0), { time: 'later' }) && nf.dailyDue(at(17, 45), { time: 'later' }));
  const days = nf.lookbackDates(at(17, 30), 7);
  check('look back 7 days ends today', days.length === 7 && days[6] === '11/13/2026' && days[0] === '11/07/2026');
  check('look back across DST (Nov 1)', nf.lookbackDates(new Date(2026, 10, 2, 17, 30), 3).join() === '10/31/2026,11/01/2026,11/02/2026');
})();

(function readsTheRealRow() {
  console.log('# a Practice Fusion schedule row');
  const row = (name, provider, status, link) => `
    <tr class="data-table__row">
      <td><div data-element="intake-status-select-1"><span class="composable-select__selection">${status}</span></div></td>
      <td><a data-element="cell-name" href="#/PF/charts/patients/abc/summary">${name}</a></td>
      <td><span data-element="start-time">10:30 AM</span><a>${link}</a></td>
      <td data-element="cell-provider-name-1">${provider}</td>
    </tr>`;
  const doc = new JSDOM(`<div data-element="scheduler-selected-date">Fri, Nov 13, 2026</div><table>${row('Blake Morgan', 'Caryn McAllister', 'Seen', 'View in encounter')}${row('Avery Stone', 'Jessica Trujillo', 'Seen', 'Start Encounter')}</table>`).window.document;
  const rows = extractVisits(doc, presets.PF.selectors, 400);
  const els = [...doc.querySelectorAll(presets.PF.selectors.rowSelector)];
  check('status read', rows[0].status === 'Seen');
  check('time read without the link', rows[1].time === '10:30 AM');
  check('encounter read per row', nf.encounterState(els[0].textContent) === 'started' && nf.encounterState(els[1].textContent) === 'none');
})();

(function timeline() {
  console.log('# the note on the client\'s Timeline → Encounters');
  const t = [
    'TYPE/SOURCE', 'DETAILS', 'STATUS',
    'Office Visit', 'Jessica Trujillo', 'SOAP Note', 'CC: *BF (Cover for Dr. caryn) (Appt time: 11/13/2026 10:30:00 AM) (Arrival time: 11:18 AM)', '11/13/2026',
    'Office Visit', 'Jessica Trujillo', 'SOAP Note', 'CC: * (Appt time: 11/5/2026 10:00:00 AM) (Arrival time: 11:03 AM)', '11/05/2026',
    'Office Visit', 'Caryn McAllister PT, DPT', 'SOAP Note', 'CC: *', '11/04/2026',
  ].join('\n');
  const v = (date, time, therapist) => ({ date, time, therapist });
  check('same appointment date + time = note there', nf.noteInTimeline(t, v('11/13/2026', '10:30 AM', 'Jessica Trujillo')));
  check('same day, other time = no note for this visit', !nf.noteInTimeline(t, v('11/13/2026', '01:30 PM', 'Jessica Trujillo')));
  check('a one-digit day in Appt time still matches', nf.noteInTimeline(t, v('11/05/2026', '10:00 AM', 'Someone Else')));
  check('no Appt time: the day + the therapist named = note there', nf.noteInTimeline(t, v('11/04/2026', '09:00 AM', 'Caryn McAllister')));
  check('no Appt time, a different therapist = not this visit\'s note', !nf.noteInTimeline(t, v('11/04/2026', '09:00 AM', 'Jessica Trujillo')));
  check('a day with no encounter = no note', !nf.noteInTimeline(t, v('11/12/2026', '10:00 AM', 'Jessica Trujillo')));
  check('"No encounters" page = no note', !nf.noteInTimeline('TYPE/SOURCE\nNo encounters', v('11/13/2026', '10:30 AM', 'Jessica Trujillo')));
  const rows = require(path.join(__dirname, '..', 'src', 'main', 'chartReview')).parseEncounters(t);
  check('encounter rows keep their therapist when the CC has an Appt time', rows.length === 3 && rows[0].chunk.includes('Jessica Trujillo') && rows[1].chunk.includes('Jessica Trujillo'));
})();

(function soap() {
  console.log('# all four note boxes must be filled in');
  const filled = {
    Subjective: 'Chief Complaint: "The most sore I\'ve ever been," back, core and legs after the previous workout.',
    Objective: 'Start Time: 8:30am Stop Time: 9:30 am Total Time: 60 mins.\n97112 (Neuromuscular reeducation) x2 for 15 min:',
    Assessment: 'Diagnoses\n(R42) Dizziness and giddiness\n(R26.2) Difficulty in walking, not elsewhere classified\nAssessment & Plan\nPost-exercise soreness improving; tolerated progressive strengthening.',
    Plan: 'Skilled PT Interventions. Neuromuscular re-education. Recommend continuation 2x/week.',
  };
  check('a complete note has no empty box', nf.emptySections(filled).length === 0);
  check('Assessment with only the Diagnoses list is empty', nf.emptySections({ ...filled, Assessment: 'Diagnoses\n(R42) Dizziness and giddiness\n(R26.2) Difficulty in walking\n---' }).join() === 'Assessment');
  check('labels with nothing after them are empty', nf.emptySections({ ...filled, Objective: 'Start Time:\nStop Time:\nTotal Time:' }).join() === 'Objective');
  check('a blank Plan is empty', nf.emptySections({ ...filled, Plan: '  \n ' }).join() === 'Plan');
  check('every empty box is named', nf.emptySections({ Subjective: '', Objective: '', Assessment: filled.Assessment, Plan: '' }).join() === 'Subjective,Objective,Plan');
  check('a page where the boxes can\'t be found = can\'t tell (null), never "empty"', nf.emptySections({ Subjective: null, Objective: null, Assessment: 'x', Plan: null }) === null);
  check('the same word inside a note isn\'t mistaken for a label', nf.writtenText('Subjective\nPt reports feeling better today.').includes('feeling better'));

  const now = new Date(2026, 10, 13, 17, 30);
  const list = [
    { patientName: 'Avery Stone', therapist: 'Jessica Trujillo', note: 'incomplete', emptySections: ['Objective', 'Plan'], apptAt: new Date(2026, 10, 13, 10, 30).toISOString(), dueAt: new Date(2026, 10, 14, 10, 30).toISOString(), overdue: false },
    { patientName: 'Blake Morgan', therapist: 'Jessica Trujillo', note: 'done', apptAt: new Date(2026, 10, 13, 8, 0).toISOString() },
    { patientName: 'Casey Hart', therapist: 'Jessica Trujillo', note: 'unknown', apptAt: new Date(2026, 10, 13, 9, 0).toISOString() },
  ];
  const plan = nf.planReminders(list, { testMode: true });
  check('a note with an empty box gets a reminder', plan.length === 1 && plan[0].items.length === 1 && plan[0].items[0].patientName === 'Avery Stone');
  check('a complete note or one that couldn\'t be read never does', !plan[0].items.some((i) => i.note !== 'incomplete'));
  const mail = nf.reminderEmail({ therapist: 'Jessica Trujillo', items: plan[0].items });
  check('the email names the empty boxes', mail.text.includes('Not filled in: Objective, Plan') && mail.html.includes('Not filled in: Objective, Plan'));
  check('the email says all four must be filled in', /Subjective, Objective, Assessment and Plan must all be filled in/.test(mail.text));
  void now;
})();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
