'use strict';

/*
 * Locks the integration to the REAL Practice Fusion / SimplePractice page
 * structure captured from the demo accounts (scripts/inspect-dom.js). The
 * fixtures below are trimmed copies of the actual DOM — same attributes the live
 * selectors target — so a site change that breaks the selectors fails here first.
 *
 *   node test/real-accounts.test.js
 */

const path = require('path');
const { JSDOM } = require('jsdom');
const { extractVisits } = require(path.join(__dirname, '..', 'src', 'main', 'extract'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const { DEMO_PROVIDERS, DEMO_MAIN_DOCTORS, matchProvider } = require(path.join(__dirname, '..', 'src', 'main', 'model'));
const presets = require(path.join(__dirname, '..', 'src', 'main', 'presets'));

let pass = 0; const fails = [];
const check = (n, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${n}`); ok ? pass++ : fails.push(n); };

/* A trimmed Practice Fusion Schedule → Appointments table (real attributes). */
const PF_ROW = (i, patient, provider) => `
  <tr aria-rowindex="${i + 1}" data-element="data-table-row-${i}" class="data-table__row ember-view">
    <td data-element="cell-patient-${i}" class="data-table__cell appointments-table__col--lg">
      <a data-element="cell-name" href="#/PF/charts/patients/x/summary">${patient}</a>
      <p><span data-element="cell-dob">01/02/1990</span><span data-element="cell-preferred-phone">M. (555) 555-5555</span></p>
    </td>
    <td data-element="cell-time-${i}" class="appointments-table__col--sm"><p data-element="start-time">${9 + i}:00 AM</p></td>
    <td data-element="cell-provider-name-${i}" class="appointments-table__col--sm">${provider}</td>
    <td data-element="cell-appointment-type-${i}"><p title="Follow-Up Visit">Follow-Up Visit</p></td>
  </tr>`;
const PF_HTML = `<!doctype html><html><body>
  <div class="item--TBn" data-element="scheduler-selected-date">Mon, Jun 29, 2026</div>
  <button data-element="btn-date-previous"></button><button data-element="btn-date-next"></button>
  <table class="data-table"><tbody>
    ${PF_ROW(0, 'Lochlann McNulty', 'Shanina s')}
    ${PF_ROW(1, 'Christopher Banks', 'Sally S')}
    ${PF_ROW(2, 'Amanda Patel', 'Sam Comrie')}
    ${PF_ROW(3, 'James Carter', 'Gianna G')}
  </tbody></table>
</body></html>`;

/* Trimmed SimplePractice new-appointment dialog (real attributes). */
const SP_HTML = `<!doctype html><html><body>
  <div data-validation-path="client" class="validated-input client-select">
    <div class="typeahead-trigger-container"><div class="select-box__selected-option typeahead-trigger"><span class="placeholder">Search Client</span></div></div>
  </div>
  <div class="picker date-picker"><input aria-label="Start date" name="startDate" type="text"></div>
  <div data-validation-path="officeId" class="validated-input">
    <div class="typeahead-trigger-container"><div class="select-box__selected-option typeahead-trigger"><div class="typeahead-label">Unassigned</div></div></div>
  </div>
  <div class="shared-clinician-dropdown-container"><label>Clinician</label><div class="non-editable-dropdown"><div class="typeahead-label">Nabil Mouzoun (You)</div></div></div>
  <div data-validation-path="code" class="validated-input code">
    <select name="code" aria-label="Services"><option disabled>Select service</option>
      <optgroup label="Practice Services"><option value="97112">97112 Neuromuscular re-education</option><option value="97530">97530 Therapeutic activities</option></optgroup>
    </select>
  </div>
  <button class="button ghost" aria-label="add service" type="button">Add service</button>
  <div class="appointment-ctas"><button class="button primary submit-form pull-right" type="button">Save</button></div>
</body></html>`;

(function testPfRead() {
  console.log('# Practice Fusion — read the day from the real Schedule structure');
  const doc = new JSDOM(PF_HTML).window.document;
  const v = extractVisits(doc, presets.PF.selectors, 50).map((x) => ({ ...x, patientName: x.patientName.trim(), doctorName: x.doctorName.trim() }));
  check('reads all 4 appointments', v.length === 4);
  check('patient names correct', v.map((x) => x.patientName).join('|') === 'Lochlann McNulty|Christopher Banks|Amanda Patel|James Carter');
  check('providers (small doctors) correct', v.map((x) => x.doctorName).join('|') === 'Shanina s|Sally S|Sam Comrie|Gianna G');
  check('day heading read as the date', v.every((x) => x.date === 'Mon, Jun 29, 2026'));
})();

(function testMatcherSingleNames() {
  console.log('# Doctor matcher — single first names + Practice Fusion surname initials');
  // Real roster: full names, Practice Fusion shows a surname initial or a nickname.
  for (const [pf, want] of [['Shanina s', 'Shanina Smith'], ['Sally S', 'Sally Connolly'], ['Gianna G', 'Gianna Hernandez'], ['Sam Comrie', 'Samantha Comrie'], ['Yamela Cando', 'Yamela Cando']]) {
    const r = matchProvider(pf, DEMO_PROVIDERS);
    check(`"${pf}" → ${want}`, !!r.provider && r.provider.name === want);
  }
})();

(function testMatcherNoWrongMainDoctor() {
  console.log('# Doctor matcher — a compound/hyphenated surname must never lose to a same-first-name provider under a DIFFERENT main doctor');
  // These three collided in the real roster: the correct person has a two-word
  // surname, and an unrelated same-first-name person with a one-word surname
  // used to win by arithmetic alone (see model.js matchProvider comments).
  for (const [pf, want, wantMain] of [
    ['Heather V', 'Heather Vines-Dubose', 'Heather Vines-Dubose'],
    ['Heather', null, null], // bare first name, no surname info at all — must refuse, not guess
    ['Nicole L', 'Nicole Lee-Williams', 'Heather Vines-Dubose'],
    ['Samantha S', 'Samantha Impellizeri (Scavo)', 'Heather Vines-Dubose'],
  ]) {
    const r = matchProvider(pf, DEMO_PROVIDERS);
    if (want === null) check(`"${pf}" → refused (ambiguous), never guessed`, r.provider === null);
    else check(`"${pf}" → ${want} (${wantMain})`, !!r.provider && r.provider.name === want && r.provider.mainDoctor === wantMain);
  }
  // Full sweep: for every real provider, a "FirstName SurnameInitial" or bare
  // first-name PF format must never confidently resolve to a DIFFERENT provider
  // under a DIFFERENT main doctor (booking under the wrong main doctor is the
  // one outcome this matcher exists to prevent — refusing as ambiguous is fine).
  let wrongMainDoctor = 0;
  for (const p of DEMO_PROVIDERS) {
    const tokens = p.name.replace(/[()]/g, '').split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    for (const variant of [p.name, `${tokens[0]} ${tokens[tokens.length - 1][0]}`, tokens[0]]) {
      const r = matchProvider(variant, DEMO_PROVIDERS);
      if (r.provider && r.provider.mainDoctor !== p.mainDoctor) wrongMainDoctor++;
    }
  }
  check('no PF-name variant of any real provider resolves to a different main doctor', wrongMainDoctor === 0);
})();

(function testPlan() {
  console.log('# Read → plan with the roster (main doctor + codes + GP/GO/GN + 59)');
  const doc = new JSDOM(PF_HTML).window.document;
  const visits = extractVisits(doc, presets.PF.selectors, 50).map((x) => ({ ...x, patientName: x.patientName.trim(), doctorName: x.doctorName.trim() }));
  const planned = planAppointments(visits, DEMO_PROVIDERS, DEMO_MAIN_DOCTORS);
  check('every appointment matched a provider', planned.every((p) => p.matched));
  const sh = planned.find((p) => p.doctorName === 'Shanina s');
  check('Shanina → Heather (GO) with 59 on 97530', sh.mainDoctor === 'Heather Vines-Dubose'
    && sh.services[0].modifiers.includes('GO')
    && sh.services[1].code === '97530' && sh.services[1].modifiers.includes('GO') && sh.services[1].modifiers.includes('59'));
  const gi = planned.find((p) => p.doctorName === 'Gianna G');
  check('Gianna → Caryn (GP)', gi.mainDoctor === 'Caryn McAllister' && gi.services[0].modifiers.includes('GP'));
  const sam = planned.find((p) => p.doctorName === 'Sam Comrie');
  check('Sam Comrie → Samantha Comrie / Karine (GN), 2 services', sam.mainDoctor === 'Karine Rocha de Benedicto' && sam.services.length === 2 && sam.services.every((s) => s.modifiers.includes('GN')));
})();

(function testNonPatientSkip() {
  console.log('# Non-patient rows (agencies) are skipped, real patients are not');
  const { isNonPatient } = require(path.join(__dirname, '..', 'src', 'main', 'model'));
  check('"All Pointe HomeCare Contract Agency" is skipped', isNonPatient('All Pointe HomeCare Contract Agency'));
  check('a generic agency is skipped', isNonPatient('Sunrise Home Care Agency'));
  check('a real patient is kept', !isNonPatient('Ronald Bruder') && !isNonPatient('Colin LaMura'));
  check('"Agnes" does not trigger the agency rule', !isNonPatient('Agnes Miller'));
})();

(function testSameNameDedup() {
  console.log('# sameName — word-order/format-independent match, used to dedupe already-booked patients');
  const { sameName } = require(path.join(__dirname, '..', 'src', 'main', 'model'));
  check('"Jane Doe" == "Doe, Jane"', sameName('Jane Doe', 'Doe, Jane'));
  check('extra spacing/case still matches', sameName('  jane   doe ', 'JANE DOE'));
  check('different patients do not match', !sameName('Jane Doe', 'John Doe'));
  check('a subset of tokens does not match', !sameName('Jane Doe', 'Jane'));
})();

(function testDisciplinePick() {
  console.log('# Client picker chooses the OT/PT/SLP variant by the appointment discipline');
  const { chooseOptionIndex } = require(path.join(__dirname, '..', 'src', 'main', 'book'));
  const J = ['Jennifer OT Burgand', 'Jennifer PT Burgand', 'Jennifer SLP Burgand'];
  check('GP/PT → Jennifer PT Burgand', chooseOptionIndex(J, 'Jennifer Burgand', { discipline: 'pt' }) === 1);
  check('GO/OT → Jennifer OT Burgand', chooseOptionIndex(J, 'Jennifer Burgand', { discipline: 'ot' }) === 0);
  check('GN/SLP → Jennifer SLP Burgand', chooseOptionIndex(J, 'Jennifer Burgand', { discipline: 'slp' }) === 2);
  check('right variant not loaded yet → WAIT (-2), never the wrong one', chooseOptionIndex(['Jennifer OT Burgand'], 'Jennifer Burgand', { discipline: 'pt' }) === -2);
  check('no variants → picks the single record fast', chooseOptionIndex(['Colin LaMura'], 'Colin LaMura', { discipline: 'pt' }) === 0);
  check('name variant Ronald→Ron still falls back to first', chooseOptionIndex(['Ron Bruder'], 'Ronald Bruder', { discipline: 'pt', allowFirst: true }) === 0);
  check('untagged record preferred over a mismatched tag', chooseOptionIndex(['Jane OT Doe', 'Jane Doe'], 'Jane Doe', { discipline: 'pt', allowFirst: true }) === 1);
  check('completely different name → -1, never guess a wrong client', chooseOptionIndex(['Unrelated Person'], 'Jamie Rivera', { discipline: 'pt', allowFirst: true }) === -1);
  check('no options at all → -1, not a blind pick', chooseOptionIndex([], 'Jamie Rivera', { discipline: 'pt', allowFirst: true }) === -1);
})();

(function testSpSelectors() {
  console.log('# SimplePractice — the booking fields resolve on the real dialog structure');
  const doc = new JSDOM(SP_HTML).window.document;
  const s = presets.SP.selectors;
  check('client typeahead resolves', !!doc.querySelector(s.clientTrigger));
  check('date field resolves', !!doc.querySelector(s.dateField));
  check('location typeahead resolves', !!doc.querySelector(s.locationTrigger));
  check('clinician container resolves', !!doc.querySelector(s.clinician));
  check('service <select> resolves + has codes', !!doc.querySelector(s.codeSelect) && doc.querySelectorAll(s.codeSelect + ' option[value]').length === 2);
  check('add-service button resolves', !!doc.querySelector(s.addService));
  check('save button resolves', !!doc.querySelector(s.saveButton));
  // client and location must be DIFFERENT elements (both are typeahead-triggers)
  check('client ≠ location (scoped correctly)', doc.querySelector(s.clientTrigger) !== doc.querySelector(s.locationTrigger));
})();

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
