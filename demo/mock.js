'use strict';

/**
 * Shared demo harness: serves the two bundled mock sites (ChartFlow EHR →
 * BookWell scheduler) on localhost, and exports the selectors that match them.
 *
 * These mocks stand in for Practice Fusion → SimplePractice so the exact same
 * app engine (search a patient, read visits, map the roster, book coded
 * appointments) can be shown end-to-end with NO logins and NO internet — perfect
 * for a screen recording, and used by the end-to-end test to prove the real
 * engine works. On the client's machine the same app points at the real sites.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const FILES = {
  '/': 'source.html',
  '/source.html': 'source.html',
  '/dest.html': 'dest.html',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const file = FILES[req.url.split('?')[0]] || null;
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = fs.readFileSync(path.join(__dirname, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        sourceUrl: `${base}/source.html`,
        destUrl: `${base}/dest.html`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Selectors that match the mock pages (what Teach Mode would capture on the real
// sites). Source = read a patient's visits; dest = the coded-appointment form.
const SOURCE_SELECTORS = {
  searchBox: '#patientSearch',
  firstResult: '.result',
  patientSelector: '#patientName',
  rowSelector: '.visit-row',
  doctorSelector: '.visit-doctor',
  dateSelector: '.visit-date',
};

const DEST_SELECTORS = {
  newApptButton: '#newAppt',
  patientField: '#patientField',
  mainDoctorField: '#clinicianField',
  dateField: '#dateField',
  codeField: '#codeField',
  unitsField: '#unitsField',
  modifierField: '#modifierField',
  addServiceBtn: '#addService',
  saveButton: '#saveAppt',
};

const DEMO_PATIENT = 'Emma Johnson'; // has 3 visits across PT / OT / Speech

module.exports = { startServer, SOURCE_SELECTORS, DEST_SELECTORS, DEMO_PATIENT };
