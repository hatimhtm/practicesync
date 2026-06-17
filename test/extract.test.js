'use strict';

// Proves the live-mode data-handling core against realistic local fixtures,
// with no browser and no real websites. Run: node test/extract.test.js

const path = require('path');
const { JSDOM } = require('jsdom');
const { buildSelector, extractVisits, planFormValues } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

/* ---- Fixture: a Practice Fusion patient TIMELINE (one patient, many visits).
 *      Patient name is the page header; each row has a doctor + date. ---- */
function dashboardHTML(n) {
  const rows = Array.from({ length: n }, (_, i) => `
    <tr class="visit-row" data-testid="visit-${i}">
      <td class="dx-doctor">Gianna Hernandez ${i}</td>
      <td class="visit-date">2026-01-${String((i % 28) + 1).padStart(2, '0')}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html><body>
    <div id="patient-name">LOCHLANN MCNULTY</div>
    <table id="schedule"><tbody>${rows}</tbody></table>
  </body></html>`;
}

const SEL = { patientSelector: '#patient-name', rowSelector: '.visit-row', dateSelector: '.visit-date', doctorSelector: '.dx-doctor' };

(function testExtract() {
  console.log('# extractVisits — patient from header, doctor+date per row');
  const doc = new JSDOM(dashboardHTML(12)).window.document;
  check('limit 1 returns 1', extractVisits(doc, SEL, 1).length === 1);
  check('limit 2 returns 2', extractVisits(doc, SEL, 2).length === 2);
  check('limit 10 returns 10', extractVisits(doc, SEL, 10).length === 10);
  const v = extractVisits(doc, SEL, 1)[0];
  check('patient name comes from the header', v.patientName === 'LOCHLANN MCNULTY');
  check('reads date per row', v.date === '2026-01-01');
  check('reads doctor per row', v.doctorName === 'Gianna Hernandez 0');
  check('every row shares the header patient', extractVisits(doc, SEL, 3).every((x) => x.patientName === 'LOCHLANN MCNULTY'));
  check('empty timeline → []', extractVisits(new JSDOM(dashboardHTML(0)).window.document, SEL, 10).length === 0);
})();

(function testBuildSelector() {
  console.log('# buildSelector — taught selectors actually resolve back');
  const doc = new JSDOM(dashboardHTML(5)).window.document;
  const row = doc.querySelectorAll('.visit-row')[2];
  const rowSel = buildSelector(row);
  check('row selector resolves', doc.querySelector(rowSel) !== null);
  const docEl = row.querySelector('.dx-doctor');
  const relSel = buildSelector(docEl, row);
  check('relative doctor selector resolves within row', row.querySelector(relSel) === docEl);

  // id / data-testid preference
  const idDom = new JSDOM('<div><span id="save">S</span><button data-testid="go">G</button></div>').window.document;
  check('prefers #id', buildSelector(idDom.querySelector('span')) === '#save');
  check('prefers data-testid', buildSelector(idDom.querySelector('button')) === '[data-testid="go"]');

  // digit-leading id must not produce invalid #123 (use [id="..."])
  const digitDom = new JSDOM('<div><input id="123field"></div>').window.document;
  const digSel = buildSelector(digitDom.querySelector('input'));
  check('digit-leading id is valid + resolves', digitDom.querySelector(digSel) !== null);

  // REPEATED data-testid across rows must NOT anchor to the wrong element
  const repDom = new JSDOM(dashboardHTML(3).replace(/data-testid="visit-\d+"/g, 'data-testid="row"')).window.document;
  const r1 = repDom.querySelectorAll('.visit-row')[1];
  const repSel = buildSelector(r1);
  check('repeated testid resolves to the correct unique element', repDom.querySelector(repSel) === r1);
})();

(function testPlanForm() {
  console.log('# planFormValues — appointment → SimplePractice fields');
  const sel = { mainDoctorField: '#doc', dateField: '#date', codeField: '#codes', unitsField: '#u', modifierField: '#m', patientField: '#pt' };
  const appt = { patientName: 'Smith, Jane', date: '2026-02-03', mainDoctor: 'Dr. Reed',
    services: [{ code: '97112', units: 2, modifiers: ['GP'] }, { code: '97530', units: 2, modifiers: ['GP', '59'] }] };
  const vals = planFormValues(sel, appt);
  check('patient mapped', vals.some((v) => v.kind === 'patient' && v.value === 'Smith, Jane'));
  check('doctor mapped', vals.some((v) => v.kind === 'doctor' && v.value === 'Dr. Reed'));
  check('date mapped', vals.some((v) => v.kind === 'date' && v.value === '2026-02-03'));
  const codeLines = vals.filter((v) => v.kind === 'codes');
  check('one service line per code', codeLines.length === 2 && codeLines[0].value === '97112' && codeLines[1].value === '97530');
  check('units per line', vals.filter((v) => v.kind === 'units').map((v) => v.value).join(',') === '2,2');
  check('modifiers per line (big-doctor code + 59)', vals.filter((v) => v.kind === 'modifier').map((v) => v.value).join('|') === 'GP|GP 59');
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
