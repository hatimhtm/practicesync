'use strict';

// Proves the roster parser + fuzzy matcher behave for the hierarchy use-case.
// Run: node test/parser.test.js

const path = require('path');
const { parseRosterText } = require(path.join(__dirname, '..', 'src', 'main', 'ai'));
const { matchProvider } = require(path.join(__dirname, '..', 'src', 'main', 'model'));

let passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

const MAINS = ['Dr. Reed', 'Dr. Okafor', 'Dr. Castillo'];

(function parser() {
  console.log('# parseRosterText — hierarchy + delimiters');

  // comma format (the common copy/paste case) must not glue name+main
  const comma = parseRosterText('Dr. Alan Patel, Dr. Reed, 97110, 97530', MAINS).providers[0];
  check('comma: name parsed cleanly', comma && /alan patel/i.test(comma.name) && !/reed/i.test(comma.name));
  check('comma: primary = Dr. Reed', comma && comma.mainDoctor === 'Dr. Reed');
  check('comma: codes captured', comma && comma.codes.map((c) => c.code).join(',') === '97110,97530');

  // units + modifier + big-doctor 2-letter code
  const full = parseRosterText('Gianna - PT under Caryn - GP - 97112 2 units, 97530 2 units modifier 59', [{ name: 'Caryn McAllister', code: 'GP' }]);
  const g = full.providers[0];
  check('units captured (97112 ×2)', g && g.codes[0].code === '97112' && g.codes[0].units === 2);
  check('modifier 59 on 97530', g && g.codes[1].code === '97530' && g.codes[1].modifiers.includes('59'));
  check('big-doctor code hint detected (GP)', full.mainCodeHints['Caryn McAllister'] === 'GP');

  // "under X" canonicalizes to the registered primary, not the raw token
  const under = parseRosterText('Marcus Cohen under Okafor 97165', MAINS).providers[0];
  check('under: canonical primary = Dr. Okafor', under && under.mainDoctor === 'Dr. Okafor');

  // primary HEADER line sets context for following subordinates
  const nested = parseRosterText('Under Dr. Reed:\nAlan Patel 97110\nSara Nguyen 97161', MAINS);
  check('header: 2 subordinates parsed', nested.providers.length === 2);
  check('header: both nested under Dr. Reed', nested.providers.every((p) => p.mainDoctor === 'Dr. Reed'));
})();

(function matcher() {
  console.log('# matchProvider — safe matching');
  const roster = [
    { name: 'Dr. Alan Patel', mainDoctor: 'Dr. Reed', codes: ['97110'] },
    { name: 'Dr. Alan Brooks', mainDoctor: 'Dr. Okafor', codes: ['97165'] },
  ];
  // PF often writes "Surname, First" — must still match on surname
  check('matches "Patel, Alan" → Patel', matchProvider('Patel, Alan', roster).provider?.name === 'Dr. Alan Patel');
  // shared FIRST name only ("Alan") must NOT confidently match either Alan
  const justFirst = matchProvider('Dr. Alan', roster);
  check('ambiguous first-name-only is refused', justFirst.provider === null);
  // unknown doctor → not recognized (never guessed)
  check('unknown doctor → null', matchProvider('Dr. Zhang', roster).provider === null);
  // exact still wins
  check('exact match works', matchProvider('Dr. Alan Brooks', roster).provider?.name === 'Dr. Alan Brooks');
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
