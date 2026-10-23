'use strict';

/*
 * The October 2026 billing update, on made-up patients only:
 *   - each patient's own code list per therapist (the practice's payer sheet),
 *   - the updated roster merged into an existing install without losing anything,
 *   - the clinician (billing provider) matched on the whole name,
 *   - "already booked" that respects a PT/OT/SLP tag,
 *   - every visit that isn't booked named, with its therapist and reason.
 */

const path = require('path');
const m = require(path.join(__dirname, '..', 'src', 'main', 'model'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const { pickClinicianIndex, namesPerson } = require(path.join(__dirname, '..', 'src', 'main', 'book'));
const { takeExistingFrom, unmatchedReason, looseSameClient, ledgerKey } = require(path.join(__dirname, '..', 'src', 'main', 'sync'));

let passed = 0;
let failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

const ROSTER = m.DEMO_PROVIDERS;
const MAINS = m.DEMO_MAIN_DOCTORS;
const plan = (patient, therapist, clients, type = 'Follow-Up Visit') =>
  planAppointments([{ patientName: patient, doctorName: therapist, date: '10/21/2026', type }], ROSTER, MAINS, [], clients)[0];
const lines = (p) => p.services.map((s) => `${s.code}x${s.units}${s.modifiers.length ? `(${s.modifiers.join(',')})` : ''}`).join(' ');

(function testCodeBankParsing() {
  console.log('# A patient\'s code list, written the way the payer sheet writes it');
  const bank = m.parseCodeBank([
    'Caryn: 97112 x 2 (GP), 97530 x 2 (GP, 59)',
    'Jessica/Danielle/Heather: 97112 x 2 (GO). 97530 x 2 (GO,59)',
    'Sam: 92523 x 1 (GN), 92507 x 1(GN) 97550 x 1 (GN)',
    'Nathalia : 90837 x 1',
    'Jade: $165',
    'Eileen: ',
  ].join('\n'));
  check('six therapist lines', bank.length === 6);
  check('Caryn: 2 lines, units 2, GP then 59', m.formatServices(bank[0].codes) === '97112 x2 (GP), 97530 x2 (GP,59)');
  check('three names on one line', bank[1].names.join('|') === 'Jessica|Danielle|Heather');
  check('a full stop between codes still reads both', bank[1].codes.length === 2);
  check('"92507 x 1(GN)" without a space reads GN', bank[2].codes[1].modifiers.join() === 'GN');
  check('"Nathalia :" with a space before the colon', bank[3].names[0] === 'Nathalia' && bank[3].codes[0].code === '90837');
  check('"Jade: $165" means private pay', bank[4].private === true && bank[4].codes.length === 0);
  check('an empty line ("Eileen:") has no codes', bank[5].codes.length === 0 && !bank[5].private);
  check('two lines on one row still split', m.parseCodeBank('Caryn: 97112 x 2 (GP) Jessica: 97112 x 2 (GO)').length === 2);
  check('summary lists who is on it', m.codeBankSummary('Caryn: 97112 x 2 (GP)\nJade: $165') === 'Caryn, Jade (private)');
})();

(function testPatientCodes() {
  console.log('# Codes come from the patient\'s list first');
  const clients = [
    { name: 'Rowan Testerly', status: 'Insurance', id: '000901', codes: 'Gianna: 97110 x 2 (GP), 97140 x 2 (GP)\nJessica: 97112 x 2 (GO), 97530 x 2 (GO, 59)\nSam: 92523 x 1 (GN), 92507 x 1 (GN)' },
    { name: 'Ida Placeholder', status: 'Insurance/Private', id: '000902', codes: 'JR: 97112 x 2 (GP), 97530 x 2 (GP, 59)\nJade: $165' },
    { name: 'Max Example', status: 'Private Pay', id: '000903' },
    { name: 'Quinn Sample', status: 'Insurance', id: '000904', codes: 'Jessica/Danielle: 97112 x 2 (GO), 97530 x 2 (GO, 59)\nCaryn: 97112 x 2 (GP), 97530 x 2 (GP, 59)\nGianna: 97112 x 2 (GP), 97140 x 2 (GP)' },
  ];
  const g = plan('Rowan Testerly', 'Gianna Hernandez', clients);
  check('Gianna on Rowan → Rowan\'s own Gianna codes, not her standard set', lines(g) === '97110x2(GP) 97140x2(GP)' && g.codeSource === 'patient' && !g.warnings.length);
  check('…booked under Caryn (her billing provider)', g.mainDoctor === 'Caryn McAllister' && g.patientId === '000901');
  const s = plan('Rowan Testerly', 'Sam Comrie', clients);
  check('"Sam" (speech) → Samantha Comrie\'s speech lines', lines(s) === '92523x1(GN) 92507x1(GN)');
  const so = plan('Rowan Testerly', 'Samantha Impellizeri', clients);
  check('"Sam" with speech codes never applies to Samantha the OT — she gets the OT line', lines(so) === '97112x2(GO) 97530x2(GO,59)' && so.codeSource === 'discipline' && so.warnings.length === 1);
  const n = plan('Rowan Testerly', 'Nicki Mancusi', clients);
  check('an OT not on the list → the patient\'s only OT line, flagged', n.codeSource === 'discipline' && /isn't on Rowan Testerly's code list/.test(n.warnings[0]));
  const jade = plan('Ida Placeholder', 'Jade Lee MeeSook', clients);
  check('"Jade: $165" → Jade\'s visit is private pay, no codes', jade.selfPay === true && jade.services.length === 0);
  const jr = plan('Ida Placeholder', 'JR Meehan', clients);
  check('…the same patient with JR is insurance with JR\'s codes ("Insurance/Private")', jr.selfPay === false && lines(jr) === '97112x2(GP) 97530x2(GP,59)');
  const priv = plan('Max Example', 'Gianna Hernandez', clients);
  check('Private Pay → no codes, whatever the therapist', priv.selfPay === true && priv.services.length === 0 && !priv.warnings.length);
  const mix = plan('Quinn Sample', 'Monica Jain', clients);
  check('a PT not on the list, two different PT lines → her standard codes, flagged', mix.codeSource === 'standard' && lines(mix) === '97112x2(GP) 97530x2(GP,59)' && /standard codes/.test(mix.warnings[0]));
  const dani = plan('Quinn Sample', 'Dani Reichert', clients);
  check('"Danielle" on the list matches Practice Fusion\'s "Dani Reichert"', dani.codeSource === 'patient' && dani.mainDoctor === 'Heather Vines-Dubose');
  const nolist = plan('Unlisted Person', 'Gianna Hernandez', clients);
  check('a client not on the list keeps the standard codes with no flag (as before)', nolist.codeSource === 'standard' && !nolist.warnings.length && nolist.services.length === 2);
  const nath = m.parseCodeBank('Nathalia : 90837 x 1');
  check('a line with no modifiers is used as written (no GP forced onto 90837)', m.patientCodesFor(nath, ROSTER.find((p) => /Nathalia/.test(p.name)), 'GP').entry.codes[0].modifiers.length === 0);
})();

(function testRosterMerge() {
  console.log('# The October roster merged into an install from July, losing nothing');
  const july = [
    m.makeProvider({ name: 'Gianna Hernandez', discipline: 'PT', mainDoctor: 'Caryn McAllister', codes: '97110 x2, 97140 x2' }), // the office's own codes
    m.makeProvider({ name: 'Laurits (Mikel) Bensend', discipline: 'LMT', mainDoctor: 'Karine Rocha de Benedicto', codes: '' }),
    m.makeProvider({ name: 'Nardeen A', discipline: 'PT', mainDoctor: 'Caryn McAllister', codes: '97112 x2' }), // typed short by the office
    m.makeProvider({ name: 'Sally Connolly', discipline: 'SLP', mainDoctor: 'Karine Rocha de Benedicto', codes: '92507 x1' }), // not on the new sheet
    m.makeProvider({ name: 'Michelle', discipline: 'PT', mainDoctor: 'Caryn McAllister', codes: '' }), // could be either Michelle
  ];
  const r = m.mergeRoster(july);
  const by = (n) => r.providers.filter((p) => p.name === n);
  check('the office\'s own codes are kept', m.formatCodes(by('Gianna Hernandez')[0].codes) === '97110 x2, 97140 x2');
  check('Laurits moves to Caryn, as on the sheet', by('Laurits (Mikel) Bensend')[0].mainDoctor === 'Caryn McAllister' && r.moved.length === 1);
  check('"Nardeen A" is recognized, not added twice', by('Nardeen Abdelsayed').length === 0 && by('Nardeen A').length === 1);
  check('someone the office had who isn\'t on the sheet stays', by('Sally Connolly').length === 1);
  check('a bare "Michelle" is left alone; both Michelles are added', by('Michelle').length === 1 && by('Michelle Minnocci').length === 1 && by('Michelle Broggi').length === 1);
  check('new therapists are added (Eileen, Evelyn, Joanne...)', ['Eileen McGonegal', 'Evelyn Marin', 'Joanne Paulino', 'Susan Gainty'].every((n) => by(n).length === 1));
  check('a PTA gets PT codes as a backup', m.formatCodes(by('Joanne Paulino')[0].codes) === '97112 x2, 97530 x2 (59)');
  check('every sheet therapist ends up exactly once', m.DEMO_PROVIDERS.every((s) => r.providers.filter((p) => m.sameName(p.name, s.name) || (s.name === 'Nardeen Abdelsayed' && p.name === 'Nardeen A')).length === 1));
  const again = m.mergeRoster(r.providers);
  check('merging twice changes nothing', JSON.stringify(again.providers) === JSON.stringify(r.providers) && !again.added.length && !again.moved.length);
  check('a fresh install is just the sheet (56 therapists)', m.mergeRoster([]).providers.length === 56);
  for (const [pf, want] of [['Joanne P', 'Joanne Paulino'], ['Joan B', 'Joan Black'], ['Francesca D', 'Francesca Day'], ['Francesca F', 'Francesca Fidaleo'], ['Eileen M', 'Eileen McGonegal'], ['Nardeen Abdelsayed', 'Nardeen Abdelsayed'], ['Evelyn Marin', 'Evelyn Marin']]) {
    const hit = m.matchProvider(pf, m.DEMO_PROVIDERS);
    check(`"${pf}" → ${want}`, hit.provider && hit.provider.name === want);
  }
})();

(function testClinician() {
  console.log('# The billing provider is picked on the whole name, never the first Heather');
  const list = ['Heather Meehan', 'Heather Vines Dubose', 'Caryn McAllister (You)', 'Karine Rocha De Benedicto'];
  check('Heather Vines-Dubose → the Vines Dubose entry, not Heather Meehan', pickClinicianIndex(list, 'Heather Vines-Dubose') === 1);
  check('Caryn → "Caryn McAllister (You)"', pickClinicianIndex(list, 'Caryn McAllister') === 2);
  check('Karine, case and "de" differences ignored', pickClinicianIndex(list, 'Karine Rocha de Benedicto') === 3);
  check('a bare "Heather" with two Heathers in the list → refused, never a guess', pickClinicianIndex(list, 'Heather') === -1);
  check('not in the list → -1', pickClinicianIndex(list, 'Pat Unknown') === -1);
  check('the shown clinician "Caryn McAllister" is not Heather', !namesPerson('Caryn McAllister', 'Heather Vines-Dubose'));
  check('"Heather Vines Dubose, OTR/L" shows Heather Vines-Dubose', namesPerson('Heather Vines Dubose, OTR/L', 'Heather Vines-Dubose'));
})();

(function testAlreadyBooked() {
  console.log('# "Already booked" respects the discipline on the calendar');
  let pool = ['Toby OT Fakename'];
  check('an OT entry doesn\'t count as the PT visit', takeExistingFrom(pool, 'Toby Fakename', 'pt') === false && pool.length === 1);
  check('…but does count as the OT visit', takeExistingFrom(pool, 'Toby Fakename', 'ot') === true && pool.length === 0);
  pool = ['Toby PT/OT Fakename', 'Toby PT/OT Fakename'];
  check('"PT/OT" covers the OT visit', takeExistingFrom(pool, 'Toby Fakename', 'ot') === true);
  check('…and the second one covers the PT visit', takeExistingFrom(pool, 'Toby Fakename', 'pt') === true && pool.length === 0);
  pool = ['Fakename, Toby'];
  check('an untagged entry counts for any visit, as before', takeExistingFrom(pool, 'Toby Fakename', 'slp') === true);
  pool = ['Toby Self Pay Fakename'];
  check('a "Self Pay" record on the calendar is the same patient', takeExistingFrom(pool, 'Toby Fakename', '') === true);
  pool = ['Someone Else'];
  check('another patient never counts', takeExistingFrom(pool, 'Toby Fakename', 'pt') === false);
})();

(function testUnmatchedReasons() {
  console.log('# A visit that isn\'t booked says why, by name');
  const u = plan('Toby Fakename', 'Pat Unknown', []);
  check('an unknown therapist is unmatched', u.matched === false);
  check('…and the reason names them', unmatchedReason(u) === '“Pat Unknown” isn\'t on Doctors & Codes — add them under their billing provider');
  const amb = plan('Toby Fakename', 'Michelle', []);
  check('a bare first name shared by two therapists → asks for the full name', /could be more than one therapist/.test(unmatchedReason(amb)));
})();

(function testPrivateNeverGetsCodes() {
  console.log('# Private pay — never any codes, even with a code list or an insurance-looking visit');
  const clients = [
    { name: 'Avery Example', status: 'Private', codes: 'Gianna: 97110 x 2 (GP), 97140 x 2 (GP)' },
    { name: 'Blake Example', status: 'Private' },
  ];
  const a = plan('Avery Example', 'Gianna G', clients, 'Follow-Up Visit');
  const b = plan('Blake Example', 'Gianna G', clients, 'New Patient Visit');
  check('private with a code list → self-pay, no services', a.selfPay === true && a.services.length === 0);
  check('private on an insurance visit type → self-pay, no services', b.selfPay === true && b.services.length === 0);
})();

(function testDuplicateGuards() {
  console.log('# Duplicate guards — a name variation is held, a different person is not');
  check('"Sam Placeholder" ~ "Samuel Placeholder"', looseSameClient('Sam Placeholder', 'Samuel Placeholder'));
  check('"Placeholder, Samuel" ~ "Sam Placeholder"', looseSameClient('Placeholder, Samuel', 'Sam Placeholder'));
  check('tagged title "Kate PT Testerly" ~ "Katherine Testerly"', looseSameClient('Kate PT Testerly', 'Katherine Testerly'));
  check('"Jane Doe" is NOT "John Doe"', !looseSameClient('Jane Doe', 'John Doe'));
  check('"Jane Doe" is NOT "Jane Smith"', !looseSameClient('Jane Doe', 'Jane Smith'));
  check('a single name never matches', !looseSameClient('Doe', 'Jane Doe'));
  const v = { date: '10/21/2026', patientName: 'Doe, Jane', discipline: 'PT', therapist: 'Gianna Hernandez' };
  check('ledger key ignores name order', ledgerKey(v) === ledgerKey({ ...v, patientName: 'Jane Doe' }));
  check('a second same-day visit gets its own key', ledgerKey(v, 1) !== ledgerKey(v, 2));
  check('a different day is a different visit', ledgerKey(v) !== ledgerKey({ ...v, date: '10/22/2026' }));
})();

(async function testPresetService() {
  console.log('# Preset service — no code means private, a code means insurance');
  const { JSDOM } = require('jsdom');
  const { readPresetService, SERVICE_CODE_RE } = require(path.join(__dirname, '..', 'src', 'main', 'book'));
  const fakePage = (html) => {
    const doc = new JSDOM(html).window.document;
    return { $eval: async (sel, fn) => { const el = doc.querySelector(sel); if (!el) throw new Error('none'); return fn(el); } };
  };
  const sel = 'select[name="code"]';
  const home = await readPresetService(fakePage('<select name="code"><option value="">Choose</option><option value="hv" selected>Home Visit</option></select>'), sel);
  const ins = await readPresetService(fakePage('<select name="code"><option value="">Choose</option><option value="97112" selected>97112 Neuromuscular re-education</option></select>'), sel);
  check('"Home Visit" → found, no code (private)', home.found && !home.hasCode);
  check('"97112 Neuromuscular re-education" → has a code (insurance)', ins.found && ins.hasCode);
  check('"Physical Therapy" / "Speech Therapy" have no code', !SERVICE_CODE_RE.test('Physical Therapy') && !SERVICE_CODE_RE.test('Speech Therapy'));
  check('"L3807 Wrist hand finger orthosis" has a code', SERVICE_CODE_RE.test('L3807 Wrist hand finger orthosis'));
  const p = plan('Casey Example', 'Gianna G', [], 'Physical Therapy');
  check('unlisted private-looking visit still carries codes in reserve for an insurance preset', p.selfPay === true && p.services.length === 0 && p.insuranceServices.length > 0);
  const q = plan('Avery Example', 'Gianna G', [{ name: 'Avery Example', status: 'Private' }]);
  check('a client marked Private never has codes in reserve', q.insuranceServices.length === 0);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
