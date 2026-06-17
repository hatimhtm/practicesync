'use strict';

const { matchProvider, mainCodeFor } = require('./model');
const liveEngine = require('./liveEngine');

/**
 * The automation engine: read REAL visits from Practice Fusion (the user's
 * existing browser session), decide each appointment from the doctor roster,
 * then create them in SimplePractice. Live data only — there is no simulated
 * mode. `dryRun` reads-and-plans without booking (used to verify before going).
 */

/* --------------------------- Practice Fusion (read) --------------------------- */
async function readVisits({ count = 6, live = {}, patientNames = [] }) {
  const r = await liveEngine.pullVisits({
    userDataDir: live.userDataDir,
    profileDir: live.profileDir,
    url: live.pfUrl,
    selectors: live.pfSelectors,
    limit: count,
    patientNames,
  });
  return r.ok ? { ok: true, visits: r.visits } : { ok: false, visits: [], error: r.error };
}

/* ------------------------- SimplePractice (create) --------------------------- */
async function createAppointment({ appointment, live = {} }) {
  if (live.spMode === 'enterprise') {
    // API path: drops in once Enterprise API access is confirmed.
    return { ok: false, error: 'SimplePractice Enterprise API is not connected yet.' };
  }
  return liveEngine.createAppointmentLive({
    userDataDir: live.userDataDir,
    profileDir: live.profileDir,
    url: live.spUrl,
    selectors: live.spSelectors,
    appointment,
  });
}

/**
 * Turn raw visits into planned appointments using the roster (doctor → main
 * doctor + codes). Unmatched doctors are flagged for the user, never guessed.
 */
function visitKey(v) {
  return [v.patientName, v.date, v.doctorName].map((s) => String(s || '').trim().toLowerCase()).join('|');
}

function planAppointments(visits, providers, mainDoctors = []) {
  return visits.map((v) => {
    // A patient we searched for but couldn't open — surface it, never guess.
    if (v.notFound) {
      return {
        patientName: v.patientName, date: v.date || '', doctorName: v.doctorName || '',
        matched: false, mainDoctor: null, mainCode: '', codes: [], services: [],
        confidence: 0, reason: 'patient not found in Practice Fusion', key: visitKey(v),
      };
    }
    const { provider, confidence, reason } = matchProvider(v.doctorName, providers);
    const mainCode = provider ? mainCodeFor(provider.mainDoctor, mainDoctors) : '';
    // Each service line = code + units + modifiers (the big doctor's 2-letter
    // code first, then any per-code modifier like 59).
    const services = provider ? (provider.codes || []).map((c) => ({
      code: c.code,
      units: c.units || 1,
      modifiers: [...(mainCode ? [mainCode] : []), ...((c.modifiers) || [])],
    })) : [];
    return {
      patientName: v.patientName,
      date: v.date,
      doctorName: v.doctorName,
      matched: Boolean(provider),
      mainDoctor: provider ? provider.mainDoctor : null,
      mainCode,
      codes: provider ? provider.codes : [],
      services,
      confidence,
      reason: provider ? undefined : (reason || 'not recognized'),
      key: visitKey(v),
    };
  });
}

/**
 * One full sync. In `dryRun` (the Test Mode default), it plans everything and
 * reports what it WOULD create without writing — the safety check before the
 * fully-automatic live runs.
 *
 * @returns {Promise<{ok:boolean, dryRun:boolean, planned:Array, created:number, unmatched:number, error?:string}>}
 */
async function runSync({ providers = [], mainDoctors = [], count = 6, dryRun = true, live = {}, bookedKeys = [], patientNames = [] } = {}) {
  const read = await readVisits({ count, live, patientNames });
  if (!read.ok) return { ok: false, dryRun, planned: [], created: 0, unmatched: 0, skipped: 0, error: read.error, bookedKeys };

  // De-duplication applies to real bookings (not a dry run): never book a visit
  // we've already booked on a previous/scheduled run.
  const dedup = !dryRun;
  const already = new Set(bookedKeys);
  const newlyBooked = [];

  const planned = planAppointments(read.visits, providers, mainDoctors);
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const appt of planned) {
    if (!appt.matched) continue;
    if (dedup && already.has(appt.key)) { appt.status = 'duplicate'; skipped += 1; continue; }
    if (dryRun) { appt.status = 'would-book'; created += 1; continue; }

    const res = await createAppointment({ appointment: appt, live });
    appt.createdOk = res.ok;
    if (res.ok) {
      appt.status = 'booked';
      created += 1;
      if (dedup) { already.add(appt.key); newlyBooked.push(appt.key); }
    } else {
      appt.status = 'failed';
      appt.error = res.error;
      failed += 1;
    }
  }
  const unmatched = planned.filter((p) => !p.matched).length;
  return { ok: true, dryRun, planned, created, unmatched, skipped, failed, bookedKeys: dedup ? [...already] : bookedKeys, newlyBooked };
}

module.exports = { runSync, planAppointments, readVisits, createAppointment };
