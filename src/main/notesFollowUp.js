'use strict';

/*
 * Notes follow-up. Every visit marked "Seen" on the Practice Fusion schedule
 * needs its note within 24 hours of the appointment time (insurance won't pay
 * without it). The schedule row says whether the visit has an encounter:
 * "View in encounter" = a note is there, "Start Encounter" = no note yet.
 * Each therapist with a missing note gets one short reminder email listing them.
 * Read only: nothing in Practice Fusion is changed.
 */

const { matchProvider, isNonPatient } = require('./model');

const DUE_HOURS = 24;
const DEFAULT_TEST_TO = 'nabil@highqualityhometherapy.com';

/** A visit that happened: the status the therapist sets after the session. */
function isSeen(status) {
  return /\b(seen|checked[\s-]*out)\b/i.test(String(status || ''));
}

/** 'started' (View in encounter) | 'none' (Start Encounter) | '' (can't tell). */
function encounterState(rowText) {
  const t = String(rowText || '');
  if (/view\s*in\s*encounter/i.test(t)) return 'started';
  if (/start\s*encounter/i.test(t)) return 'none';
  return '';
}

/** "11/13/2026" + "10:30 AM" → that moment, local time (null if unreadable). */
function apptDateTime(date, time) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(date || '').trim());
  if (!d) return null;
  const t = /(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(String(time || ''));
  let h = 0, m = 0;
  if (t) {
    h = Number(t[1]) % 12 + (/p/i.test(t[3]) ? 12 : 0);
    m = Number(t[2]);
  }
  return new Date(Number(d[3]), Number(d[1]) - 1, Number(d[2]), h, m);
}

/** "Avery Stone" → "Avery S." — enough for the therapist, no more. */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const first = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
  return `${first} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/**
 * Every Seen visit, with whether its note is there. `visits` come from
 * readPfSchedule ({ patientName, doctorName, date, time, status, encounter }).
 * Returns [{ date, time, patientName, therapist, pfProvider, note, apptAt, dueAt, overdue }]
 * — note is 'done' | 'missing' | 'unknown'.
 */
function findNotes(visits, { providers = [], now = new Date() } = {}) {
  const out = [];
  for (const v of visits || []) {
    if (!v.patientName || isNonPatient(v.patientName) || !isSeen(v.status)) continue;
    const { provider } = matchProvider(v.doctorName, providers);
    const apptAt = apptDateTime(v.date, v.time);
    const dueAt = apptAt ? new Date(apptAt.getTime() + DUE_HOURS * 3600e3) : null;
    const note = v.encounter === 'started' ? 'done' : v.encounter === 'none' ? 'missing' : 'unknown';
    out.push({
      date: v.date, time: v.time || '', patientName: v.patientName,
      therapist: provider ? provider.name : (v.doctorName || '').replace(/\.{2,}|…$/g, '').trim(),
      pfProvider: v.doctorName || '', note,
      apptAt: apptAt ? apptAt.toISOString() : null,
      dueAt: dueAt ? dueAt.toISOString() : null,
      overdue: !!(dueAt && now >= dueAt),
    });
  }
  return out;
}

/** The therapist's email, from the list on the Notes page (names compared loosely). */
function emailFor(therapist, emails = {}) {
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const want = key(therapist);
  for (const [name, email] of Object.entries(emails || {})) if (key(name) === want && /@/.test(email || '')) return String(email).trim();
  return '';
}

/**
 * One reminder per therapist with missing notes. In test mode every reminder goes
 * to `testTo` instead (each still says who it was for).
 * Returns [{ therapist, intendedTo, to, items }]; `to` is '' when there's nowhere to send.
 */
function planReminders(notes, { emails = {}, testMode = true, testTo = DEFAULT_TEST_TO } = {}) {
  const byTherapist = new Map();
  for (const n of notes) {
    if (n.note !== 'missing') continue;
    const list = byTherapist.get(n.therapist) || [];
    list.push(n);
    byTherapist.set(n.therapist, list);
  }
  return [...byTherapist.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([therapist, items]) => {
      const intendedTo = emailFor(therapist, emails);
      items.sort((a, b) => String(a.apptAt).localeCompare(String(b.apptAt)));
      return { therapist, intendedTo, to: testMode ? testTo : intendedTo, items };
    });
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The reminder email: { subject, text, html }. */
function reminderEmail({ therapist, items, intendedTo = '', test = false }) {
  const first = String(therapist || '').split(/\s+/)[0] || 'there';
  const overdue = items.filter((i) => i.overdue).length;
  const n = items.length;
  const subject = `${test ? '[TEST] ' : ''}${overdue ? 'Overdue: ' : ''}${n} visit note${n === 1 ? '' : 's'} needed in Practice Fusion`;
  const when = (i) => (i.dueAt ? (i.overdue ? `Overdue since ${fmtDay(i.dueAt)}, ${fmtClock(i.dueAt)}` : `Due by ${fmtDay(i.dueAt)}, ${fmtClock(i.dueAt)}`) : 'Due within 24 hours of the visit');
  const visitDay = (i) => (i.apptAt ? `${fmtDay(i.apptAt)}, ${fmtClock(i.apptAt)}` : i.date);
  const testLine = test ? `TEST — this reminder is for ${therapist} (${intendedTo || 'no email on file yet'}).` : '';

  const text = [
    test ? `${testLine}\n` : null,
    `Hi ${first},`,
    '',
    `The following visit${n === 1 ? ' is' : 's are'} marked Seen in Practice Fusion but ${n === 1 ? 'has' : 'have'} no note yet:`,
    '',
    ...items.map((i) => `• ${visitDay(i)} — ${shortName(i.patientName)} — ${when(i)}`),
    '',
    'Please complete the note in Practice Fusion. Notes are due within 24 hours of the visit; insurance companies need them to pay for the session.',
    '',
    'If you have already finished it, thank you, and please disregard this reminder.',
    '',
    'High Quality Home Therapy',
  ].filter((l) => l !== null).join('\n');

  const rows = items.map((i) => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e6ebf1;white-space:nowrap">${escapeHtml(visitDay(i))}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e6ebf1">${escapeHtml(shortName(i.patientName))}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e6ebf1;white-space:nowrap;color:${i.overdue ? '#b42318;font-weight:600' : '#344054'}">${escapeHtml(when(i))}</td>
          </tr>`).join('');
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2939">
        ${test ? `<tr><td style="background:#fff4e5;color:#7a4b00;padding:10px 24px;font-size:13px">${escapeHtml(testLine)}</td></tr>` : ''}
        <tr><td style="background:#0e5a8a;color:#ffffff;padding:18px 24px">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">High Quality Home Therapy</div>
          <div style="font-size:19px;font-weight:600;margin-top:2px">Visit note reminder</div>
        </td></tr>
        <tr><td style="padding:22px 24px 6px">
          <p style="margin:0 0 12px">Hi ${escapeHtml(first)},</p>
          <p style="margin:0 0 16px">The following visit${n === 1 ? ' is' : 's are'} marked <b>Seen</b> in Practice Fusion but ${n === 1 ? 'has' : 'have'} no note yet:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6ebf1;border-radius:8px;border-collapse:separate;font-size:14px">
            <tr style="background:#f8fafc;color:#475467;font-size:12px;text-transform:uppercase;letter-spacing:.04em">
              <td style="padding:8px 12px;border-bottom:1px solid #e6ebf1">Visit</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e6ebf1">Client</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e6ebf1">Note</td>
            </tr>${rows}
          </table>
          <p style="margin:18px 0 0">Please complete the note in Practice Fusion. Notes are due <b>within 24 hours of the visit</b>; insurance companies need them to pay for the session.</p>
          <p style="margin:12px 0 0;color:#475467">If you have already finished it, thank you, and please disregard this reminder.</p>
        </td></tr>
        <tr><td style="padding:20px 24px 22px;color:#475467;font-size:13px">Thank you,<br><b style="color:#1d2939">High Quality Home Therapy</b></td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}

/** "17:30" → { h: 17, m: 30 } (default 5:30 PM). */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { h: 17, m: 30 };
  return { h: Number(m[1]), m: Number(m[2]) };
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Last hour a missed daily check still runs (a Mac asleep at 5:30 catches up until 9 PM). */
const LATEST_HOUR = 21;

/** Whether the daily check should run now: past its time today, not yet done today,
 *  and not so late that the emails would land in the night. */
function dailyDue(now, { time = '17:30', lastDay = '' } = {}) {
  const { h, m } = parseHHMM(time);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  return now >= at && now.getHours() < Math.max(LATEST_HOUR, h + 1) && lastDay !== dayKey(now);
}

/** The days a check covers: the last `lookback` days through today, MM/DD/YYYY. */
function lookbackDates(now, lookback = 7) {
  const n = Math.max(1, Math.min(31, Number(lookback) || 7));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`);
  }
  return out;
}

module.exports = {
  DUE_HOURS, DEFAULT_TEST_TO, isSeen, encounterState, apptDateTime, shortName, findNotes,
  emailFor, planReminders, reminderEmail, parseHHMM, dailyDue, dayKey, lookbackDates,
};
