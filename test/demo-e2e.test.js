'use strict';

/*
 * End-to-end test of the REAL app engine against the bundled mock sites.
 *
 * Unlike demo/run-demo.js (which re-creates the flow in one window for a clean
 * recording), this drives the actual product entry points —
 * liveEngine.pullVisits() and liveEngine.createAppointmentLive() — exactly as
 * main.js does, just headless and pointed at the local mocks. If this passes,
 * the same code paths work on the real Practice Fusion → SimplePractice.
 *
 *   node test/demo-e2e.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { startServer, SOURCE_SELECTORS, DEST_SELECTORS, DEMO_PATIENT } = require(path.join(__dirname, '..', 'demo', 'mock'));
const liveEngine = require(path.join(__dirname, '..', 'src', 'main', 'liveEngine'));
const { planAppointments } = require(path.join(__dirname, '..', 'src', 'main', 'automation'));
const { DEMO_PROVIDERS, DEMO_MAIN_DOCTORS } = require(path.join(__dirname, '..', 'src', 'main', 'model'));

let pass = 0; const fails = [];
const check = (name, ok) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}`); ok ? pass++ : fails.push(name); };

(async () => {
  if (!fs.existsSync('/Applications/Google Chrome.app')) {
    console.log('  skip  demo-e2e (Google Chrome not installed here)');
    process.exit(0);
  }
  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-'));

  try {
    // 1) REAL read path: search a patient by name and read their visits.
    const read = await liveEngine.pullVisits({
      userDataDir: profile, url: srv.sourceUrl, selectors: SOURCE_SELECTORS,
      patientNames: [DEMO_PATIENT], limit: 10, headless: true,
    });
    check('pullVisits succeeded', read.ok === true);
    const visits = (read.visits || []).filter((v) => !v.notFound && !v.noVisits);
    check('pullVisits read 3 real visits', visits.length === 3);
    check('pullVisits captured the diagnosing doctors', ['Jess', 'Gianna', 'Sam Comrie'].every((d) => visits.some((v) => v.doctorName === d)));

    // 2) REAL planning: map to main doctors + coded services.
    const planned = planAppointments(visits, DEMO_PROVIDERS, DEMO_MAIN_DOCTORS);
    const matched = planned.filter((p) => p.matched);
    check('all 3 visits mapped to a roster entry', matched.length === 3);

    // 3) REAL write path: book each appointment (all service lines) and save.
    let bookedOk = 0; let withWarning = 0;
    for (const appt of matched) {
      const res = await liveEngine.createAppointmentLive({
        userDataDir: profile, url: srv.destUrl, selectors: DEST_SELECTORS,
        appointment: appt, headless: true,
      });
      if (res.ok) bookedOk++;
      if (res.warning) withWarning++;
      if (!res.ok) console.log('     · booking failed:', res.error);
    }
    check('createAppointmentLive booked all 3 appointments', bookedOk === 3);
    check('no appointment needed manual code entry (all lines automated)', withWarning === 0);
  } catch (e) {
    check('e2e ran without throwing', false);
    console.error('   error:', (e && e.stack) || e);
  } finally {
    await srv.close().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();
