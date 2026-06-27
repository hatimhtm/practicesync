'use strict';

/*
 * Full Practice Fusion → SimplePractice sync over a date (or date range).
 *
 *   node scripts/sync-run.js 06/29/2026                 # one day, DRY RUN
 *   node scripts/sync-run.js 06/29/2026 --save          # one day, actually book
 *   node scripts/sync-run.js 06/29/2026 07/03/2026 --save   # a range, book
 *
 * Reads logins from secrets.local.json and the roster from model.js (DEMO_*).
 */

const path = require('path');
const fs = require('fs');
const { runFullSync, expandDates } = require(path.join(__dirname, '..', 'src', 'main', 'sync'));
const { DEMO_PROVIDERS, DEMO_MAIN_DOCTORS } = require(path.join(__dirname, '..', 'src', 'main', 'model'));

const step = (m) => console.log('  •', m);

(async () => {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const dateArgs = args.filter((a) => !a.startsWith('--'));
  const start = dateArgs[0]; const end = dateArgs[1] || dateArgs[0];
  if (!start) { console.error('Usage: node scripts/sync-run.js <start MM/DD/YYYY> [end] [--save]'); process.exit(1); }
  const secrets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'secrets.local.json'), 'utf8'));
  const dates = expandDates(start, end);
  console.log(`\nSyncing ${dates.length} day(s): ${dates.join(', ')}  —  ${save ? 'WILL BOOK (save)' : 'dry run (no save)'}\n`);

  const res = await runFullSync({ secrets, dates, providers: DEMO_PROVIDERS, mainDoctors: DEMO_MAIN_DOCTORS, save, onStep: step });

  console.log('\n==== Result ====');
  console.log(JSON.stringify({ ok: res.ok, booked: res.booked, skipped: res.skipped, failed: res.failed, unrecognized: res.unmatched, error: res.error }, null, 2));
  process.exit(res.ok ? 0 : 1);
})();
