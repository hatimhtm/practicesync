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
const { parseEncounters, therapistsIn, settledText } = require('./chartReview');

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
      pfProvider: v.doctorName || '', note, href: v.href || '',
      apptAt: apptAt ? apptAt.toISOString() : null,
      dueAt: dueAt ? dueAt.toISOString() : null,
      overdue: !!(dueAt && now >= dueAt),
    });
  }
  return out;
}

/**
 * Is this visit's note on the client's Timeline → Encounters page? Each encounter
 * row reads like "Office Visit · Jessica Trujillo · SOAP Note · CC: … (Appt time:
 * 11/13/2026 10:30:00 AM) … 11/13/2026". A row with this appointment's date and
 * time is the note; a row on that day with no appointment time counts when it
 * names the visit's therapist.
 */
function noteInTimeline(text, { date, time, therapist } = {}) {
  const at = apptDateTime(date, time);
  if (!at) return false;
  const sameDay = (d) => d && d.getFullYear() === at.getFullYear() && d.getMonth() === at.getMonth() && d.getDate() === at.getDate();
  const APPT = /appt\s*time:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*([AP]M)/ig;
  const hasTime = !!/(\d{1,2}):(\d{2})\s*[AP]\.?M/i.exec(String(time || ''));
  for (const { date: rowDay, chunk } of parseEncounters(text)) {
    const appts = [...chunk.matchAll(APPT)].map((m) => apptDateTime(m[1].replace(/^(\d)\//, '0$1/').replace(/\/(\d)\//, '/0$1/'), `${m[2]} ${m[3]}`));
    if (appts.some((a) => a && (hasTime ? a.getTime() === at.getTime() : sameDay(a)))) return true;
    if (!appts.length && sameDay(rowDay) && therapist && therapistsIn(chunk, [{ name: therapist }]).length) return true;
  }
  return false;
}

/* ------------------------------ the note itself ------------------------------ */

/** The four boxes of the encounter's Note — every one must be filled in. */
const SOAP = ['Subjective', 'Objective', 'Assessment', 'Plan'];

/** What the therapist actually wrote in one box: without the Diagnoses list Practice
 *  Fusion inserts in Assessment by itself, dividers, and template labels with
 *  nothing after them ("Chief Complaint:"). */
function writtenText(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/ /g, ' ').trim())
    .filter((l) => l
      && !/^[-–—_*•.\s]+$/.test(l)
      && !/^(diagnoses|subjective|objective|assessment|plan|assessment\s*&\s*plan)\s*:?$/i.test(l)
      && !/^[•\-*]?\s*\(?[A-Z]\d{2}(\.[0-9A-Z]{1,4})?\)?\s/.test(l)
      && !/^[^:]{1,40}:\s*$/.test(l))
    .join(' ');
}

/** The boxes left empty, e.g. ['Objective', 'Plan']; [] = all filled. null when the
 *  note couldn't be read (fewer than two of the boxes found on the page). */
function emptySections(sections) {
  const found = SOAP.filter((n) => sections && typeof sections[n] === 'string');
  if (found.length < 2) return null;
  return SOAP.filter((n) => writtenText(sections[n]).length < 10);
}

/* -------- the clicks from the recorded walkthrough (read only, real clicks) -------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the element a page function marked with data-hope-click — a real mouse
 *  click, like a person (Practice Fusion's links are app buttons, not addresses). */
async function clickMarked(page) {
  const el = await page.$('[data-hope-click]');
  if (!el) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 5000 }).catch(() => el.evaluate((e) => e.click()).catch(() => {}));
  await el.evaluate((e) => e.removeAttribute('data-hope-click')).catch(() => {});
  return true;
}

/** Step 1, on the schedule: click the client's name (on this visit's row when it
 *  can be told apart), and wait for the chart to open. */
async function openClientFromSchedule(page, visit, sel) {
  const marked = await page.evaluate(({ sel, name, time }) => {
    document.querySelectorAll('[data-hope-click]').forEach((e) => e.removeAttribute('data-hope-click'));
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
    const clock = (x) => String(x || '').replace(/\s+/g, '').replace(/^0/, '').toUpperCase();
    const rows = [...document.querySelectorAll(sel.rowSelector)];
    const named = rows.map((r) => r.querySelector(sel.patientSelector)).filter((a) => a && norm(a.textContent) === norm(name));
    const timed = named.find((a) => { const t = a.closest(sel.rowSelector).querySelector(sel.timeSelector); return t && clock(t.textContent) === clock(time); });
    const link = timed || named[0];
    if (!link) return false;
    link.setAttribute('data-hope-click', '1');
    return true;
  }, { sel, name: visit.patientName, time: visit.time }).catch(() => false);
  if (!marked || !(await clickMarked(page))) return false;
  return waitForTab(page, 'Timeline', 20000);
}

/** Wait for a visible chart tab ("Timeline", "Summary"…) to show. */
function waitForTab(page, label, timeout) {
  return page.waitForFunction((label) => [...document.querySelectorAll('body *')].some((e) => e.offsetParent
    && [...e.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim() === label)), label, { timeout })
    .then(() => true).catch(() => false);
}

/** Step 2: click the chart's Timeline tab; returns the encounter list's text. */
async function openTimeline(page) {
  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-hope-click]').forEach((e) => e.removeAttribute('data-hope-click'));
    const tab = [...document.querySelectorAll('body *')].find((e) => e.offsetParent
      && [...e.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim() === 'Timeline'));
    if (!tab) return false;
    (tab.closest('a, button, [role="tab"], li') || tab).setAttribute('data-hope-click', '1');
    return true;
  }).catch(() => false);
  if (!marked || !(await clickMarked(page))) return null;
  return settledText(page, ['TYPE/SOURCE', /no encounters/i], 15000);
}

/**
 * Steps 3–4: on the Timeline, click this visit's "Office Visit" (the row with its
 * appointment date and time), scroll down to the Note and read its boxes. Read
 * only: nothing is typed and Save/Sign are never pressed.
 * Returns { sections: { Subjective, Objective, Assessment, Plan }, status } or null.
 */
async function readVisitNote(page, visit, say = () => {}) {
  const at = apptDateTime(visit.date, visit.time);
  if (!at) return null;
  const surname = String(visit.therapist || '').trim().split(/\s+/).pop().toLowerCase();
  // Mark what can open this visit's encounter, best first: its "Office Visit"
  // link (1), the "SOAP Note" in the same row (2), the row itself (3).
  const marked = await page.evaluate(({ y, mo, d, h, mi, surname }) => {
    document.querySelectorAll('[data-hope-click]').forEach((e) => e.removeAttribute('data-hope-click'));
    const h12 = ((h + 11) % 12) + 1;
    const ap = h < 12 ? 'AM' : 'PM';
    const appt = new RegExp(`appt\\s*time:\\s*0?${mo}/0?${d}/${y}\\s+0?${h12}:${String(mi).padStart(2, '0')}(:\\d{2})?\\s*${ap}`, 'i');
    const day = new RegExp(`\\b0?${mo}/0?${d}/${y}\\b`);
    const own = (e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
    const visitLink = (box) => [...box.querySelectorAll('*')].find((x) => /^office visit$/i.test(own(x)))
      || [...box.querySelectorAll('a, [role="link"]')].find((x) => /visit|encounter/i.test(x.textContent || ''));
    const deepest = (test) => [...document.querySelectorAll('body *')]
      .filter((e) => test(e.textContent || '') && ![...e.children].some((c) => test(c.textContent || '')));
    const starts = deepest((t) => appt.test(t));
    if (!starts.length && surname) starts.push(...deepest((t) => day.test(t) && !/appt\s*time/i.test(t)));
    for (const start of starts) {
      for (let box = start; box && box !== document.body; box = box.parentElement) {
        const link = visitLink(box);
        if (!link) continue;
        if (!appt.test(box.textContent || '') && !((box.textContent || '').toLowerCase().includes(surname) && day.test(box.textContent || ''))) break;
        (link.closest('a, button, [role="link"]') || link).setAttribute('data-hope-click', '1');
        const soap = [...box.querySelectorAll('*')].find((x) => /^soap note$/i.test(own(x)));
        if (soap) soap.setAttribute('data-hope-click', '2');
        if (!box.hasAttribute('data-hope-click')) box.setAttribute('data-hope-click', '3');
        return true;
      }
    }
    return false;
  }, { y: at.getFullYear(), mo: at.getMonth() + 1, d: at.getDate(), h: at.getHours(), mi: at.getMinutes(), surname }).catch(() => false);
  if (!marked) {
    say(`  ${visit.time}: no Office Visit for this appointment on the Timeline.`);
    await snapshot(page, `office-visit-not-found-${visit.time}`);
    return null;
  }
  for (const which of ['1', '2', '3']) {
    const el = await page.$(`[data-hope-click="${which}"]`);
    if (!el) continue;
    say(`  ${visit.time}: clicking ${which === '1' ? 'Office Visit' : which === '2' ? 'SOAP Note' : 'the visit row'}…`);
    // If Practice Fusion opens the note in a new tab, read it there and close it.
    const popup = page.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 5000 }).catch(() => el.evaluate((e) => e.click()).catch(() => {}));
    const extra = await popup;
    if (extra) {
      try {
        await extra.waitForLoadState('domcontentloaded').catch(() => {});
        say(`  ${visit.time}: scrolling down to the note…`);
        return await readNoteOn(extra);
      } finally { await extra.close().catch(() => {}); }
    }
    if (await encounterOpened(page)) {
      await page.evaluate(() => document.querySelectorAll('[data-hope-click]').forEach((e) => e.removeAttribute('data-hope-click'))).catch(() => {});
      say(`  ${visit.time}: encounter open — scrolling down to the note…`);
      const r = await readNoteOn(page);
      if (!r || emptySections(r.sections) == null) { say(`  ${visit.time}: couldn't find the note's boxes.`); await snapshot(page, `note-not-found-${visit.time}`); }
      return r;
    }
  }
  say(`  ${visit.time}: the encounter didn't open.`);
  await snapshot(page, `encounter-did-not-open-${visit.time}`);
  return null;
}

/** Whether a visit's encounter is open: its toolbar (Minimize all, Sign) or its
 *  Note boxes show — up to 8 seconds. */
function encounterOpened(page) {
  return page.waitForFunction(() => {
    const own = (e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
    const words = new Set([...document.querySelectorAll('body *')].filter((e) => e.offsetParent || e.getClientRects().length).map(own));
    return words.has('Minimize all') || words.has('Sign') || (words.has('Subjective') && words.has('Objective')) || words.has('Chief complaint');
  }, null, { timeout: 8000 }).then(() => true).catch(() => false);
}

/* ------------------------- proof when a step fails ------------------------- */

let debugDir = null;
let snapshots = 0;
/** Where failed steps are saved (a folder on the Desktop); cleared each run. */
function setDebugDir(dir) {
  debugDir = dir;
  snapshots = 0;
  try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch {}
}
/** A screenshot of the page and a map of its layout — element names and the
 *  page's own labels only, never the text in it (no client details) — so a
 *  failed step can be fixed from what Practice Fusion really shows. */
async function snapshot(page, label) {
  if (!debugDir || snapshots >= 12) return;
  snapshots += 1;
  const fs = require('fs');
  const path = require('path');
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const base = path.join(debugDir, `${String(snapshots).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '_')}`);
    await page.screenshot({ path: `${base}.png` }).catch(() => {});
    const map = await page.evaluate(() => {
      const LABEL = /^(office visit|soap note|timeline|summary|documents|profile|encounters?|type\/source|details|status|note|subjective|objective|assessment|plan|minimize|minimize all|sign|save|print|unsigned|signed|chief complaint|go to.*|view templates|import past encounter|subjective note|objective note|assessment note|plan note|care plan|new encounter|schedule|appointments|day|week|seen|pending arrival|start encounter|view in encounter)$/i;
      const out = [];
      const walk = (el, depth) => {
        if (out.length > 5000 || depth > 60) return;
        if (/^(SCRIPT|STYLE|SVG|PATH|NOSCRIPT|LINK|META)$/.test(el.tagName)) return;
        const own = [...el.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
        const attrs = [];
        if (el.id) attrs.push(`#${el.id}`);
        const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
        if (cls.length) attrs.push(`.${cls.join('.')}`);
        for (const a of ['data-element', 'role', 'contenteditable', 'href', 'type', 'name', 'aria-label']) {
          const v = el.getAttribute(a);
          if (v != null) attrs.push(`[${a}=${a === 'href' ? v.replace(/[0-9a-f-]{20,}/gi, '<id>').slice(0, 60) : v.slice(0, 40)}]`);
        }
        const r = el.getBoundingClientRect();
        const text = own ? (LABEL.test(own) ? ` "${own}"` : /appt\s*time/i.test(own) ? ' "(Appt time …)"' : ` (${own.length} chars)`) : '';
        out.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${attrs.join('')}${r.width ? '' : ' (hidden)'}${text}`);
        if (el.tagName === 'IFRAME') { try { walk(el.contentDocument.body, depth + 1); } catch { out.push(`${'  '.repeat(depth + 1)}(frame not readable)`); } }
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(document.body, 0);
      return `${location.hash.replace(/[0-9a-f-]{20,}/gi, '<id>')}\n\n${out.join('\n')}`;
    }).catch((e) => `couldn't map the page: ${e && e.message}`);
    fs.writeFileSync(`${base}.txt`, map, 'utf8');
  } catch {}
}

/** Scroll down the encounter until the Note's four boxes are on the page (they're
 *  far below the chief complaint, vitals and medications), then bring each one
 *  into view so its text loads. */
async function scrollToNote(page, timeoutMs = 25000) {
  // Fastest: the encounter toolbar's "Go to…" menu jumps straight to the Note.
  const jumped = await page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      const opt = [...sel.options].find((o) => /^\s*(note|subjective)\s*$/i.test(o.text));
      if (opt && [...sel.options].some((o) => /go to/i.test(o.text))) return { value: opt.value, index: [...document.querySelectorAll('select')].indexOf(sel) };
    }
    return null;
  }).catch(() => null);
  if (jumped) {
    const sel = (await page.$$('select'))[jumped.index];
    if (sel) { await sel.selectOption({ value: jumped.value }).catch(() => {}); await sleep(500); }
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await page.evaluate((names) => {
      const own = (e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
      const got = new Set([...document.querySelectorAll('body *')]
        .filter((e) => names.includes(own(e)) && !e.closest('[contenteditable="true"]')).map(own));
      if (got.size < names.length) {
        const boxes = [document.scrollingElement, ...[...document.querySelectorAll('body *')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))];
        for (const b of boxes) if (b) b.scrollTop += Math.max(500, b.clientHeight * 0.8);
      }
      return got.size;
    }, SOAP).catch(() => 0);
    if (found === SOAP.length) break;
    await sleep(450);
  }
  for (const n of SOAP) {
    await page.evaluate((n) => {
      const own = (e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
      const h = [...document.querySelectorAll('body *')].find((e) => own(e) === n && !e.closest('[contenteditable="true"]'));
      if (h) h.scrollIntoView({ block: 'start' });
    }, n).catch(() => {});
    await sleep(300);
  }
}

/** Read the Note boxes of the encounter open on `page`. */
async function readNoteOn(page) {
  await scrollToNote(page);
  const read = () => page.evaluate((names) => {
    const EDITOR = '[contenteditable="true"], iframe, textarea';
    const ownText = (e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('').trim();
    const textOf = (el) => {
      if (el.tagName === 'IFRAME') { try { return el.contentDocument.body.innerText || ''; } catch { return ''; } }
      return el.tagName === 'TEXTAREA' ? el.value : (el.innerText || '');
    };
    const all = [...document.querySelectorAll('body *')];
    const out = {};
    for (const n of names) {
      out[n] = null;
      // The box's heading — never the same word written inside a note.
      for (const head of all.filter((e) => ownText(e) === n && !e.closest(EDITOR))) {
        let box = head.parentElement;
        while (box && box !== document.body && !box.querySelector(EDITOR)) box = box.parentElement;
        if (!box || box === document.body) continue;
        const ed = [...box.querySelectorAll(EDITOR)].find((e) => head.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (ed) { out[n] = textOf(ed); break; }
      }
    }
    const st = /\bSTATUS\s*\n?\s*(Unsigned|Signed)\b/i.exec(document.body.innerText || '');
    return { sections: out, status: st ? st[1] : '' };
  }, SOAP).catch(() => null);
  // The boxes fill in after the page appears: read until two reads agree.
  let last = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 450));
    const cur = await read();
    if (cur && last && JSON.stringify(cur) === JSON.stringify(last)) return cur;
    last = cur;
  }
  return last;
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
    if (n.note !== 'missing' && n.note !== 'incomplete') continue;
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
  const subject = `${test ? '[TEST] ' : ''}${overdue ? 'Overdue: ' : ''}${n} visit note${n === 1 ? '' : 's'} to complete in Practice Fusion`;
  const need = (i) => (i.note === 'incomplete' && i.emptySections && i.emptySections.length ? `Not filled in: ${i.emptySections.join(', ')}` : 'No note yet');
  const when = (i) => (i.dueAt ? (i.overdue ? `Overdue since ${fmtDay(i.dueAt)}, ${fmtClock(i.dueAt)}` : `Due by ${fmtDay(i.dueAt)}, ${fmtClock(i.dueAt)}`) : 'Due within 24 hours of the visit');
  const visitDay = (i) => (i.apptAt ? `${fmtDay(i.apptAt)}, ${fmtClock(i.apptAt)}` : i.date);
  const testLine = test ? `TEST — this reminder is for ${therapist} (${intendedTo || 'no email on file yet'}).` : '';

  const text = [
    test ? `${testLine}\n` : null,
    `Hi ${first},`,
    '',
    `The following visit${n === 1 ? ' is' : 's are'} marked Seen in Practice Fusion, but the note is missing or not complete. Subjective, Objective, Assessment and Plan must all be filled in.`,
    '',
    ...items.map((i) => `• ${visitDay(i)} — ${shortName(i.patientName)} — ${need(i)} — ${when(i)}`),
    '',
    'Please complete the note in Practice Fusion. Notes are due within 24 hours of the visit; insurance companies need them to pay for the session.',
    '',
    'If you have already finished it, thank you, and please disregard this reminder.',
    '',
    'High Quality Home Therapy',
  ].filter((l) => l !== null).join('\n');

  // HQHT brand: the logo's gray wordmark (#626466) and its blue dots (#269db6, #88c5d8).
  const C = { gray: '#626466', ink: '#3a3c3e', blue: '#269db6', blueDark: '#1b7d92', light: '#88c5d8', mist: '#f2f4f5', line: '#e3e6e8', late: '#b42318' };
  const cell = `padding:12px 14px;border-bottom:1px solid ${C.line};vertical-align:top`;
  const rows = items.map((i) => `
              <tr>
                <td style="${cell};white-space:nowrap;color:${C.ink}">${i.apptAt ? `${escapeHtml(fmtDay(i.apptAt))}<br><span style="color:${C.gray}">${escapeHtml(fmtClock(i.apptAt))}</span>` : escapeHtml(i.date)}</td>
                <td style="${cell};color:${C.ink};font-weight:600">${escapeHtml(shortName(i.patientName))}</td>
                <td style="${cell};color:${C.ink}">${escapeHtml(need(i))}</td>
                <td style="${cell};white-space:nowrap;${i.overdue ? `color:${C.late};font-weight:700` : `color:${C.blueDark};font-weight:600`}">${i.dueAt ? `${i.overdue ? 'Overdue since' : 'Due by'}<br>${escapeHtml(fmtDay(i.dueAt))}, ${escapeHtml(fmtClock(i.dueAt))}` : 'Within 24 hours'}</td>
              </tr>`).join('');
  const th = `padding:10px 14px;border-bottom:1px solid ${C.line};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.gray};text-align:left`;
  const dot = (bg, border) => `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${bg};border:2px solid ${border};margin-right:3px"></span>`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.mist}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.mist};padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${C.ink}">
        <tr><td style="height:6px;background:${C.blue};font-size:0;line-height:0">&nbsp;</td></tr>
        ${test ? `<tr><td style="background:#eef7fa;color:${C.blueDark};padding:10px 28px;font-size:13px;border-bottom:1px solid ${C.line}">${escapeHtml(testLine)}</td></tr>` : ''}
        <tr><td style="padding:24px 28px 18px;border-bottom:1px solid ${C.line}">
          <div style="font-size:34px;font-weight:700;letter-spacing:-1px;line-height:1;color:${C.gray}">hqht</div>
          <div style="margin-top:6px;line-height:0">${dot(C.blue, C.blue)}${dot(C.light, C.light)}${dot('#ffffff', C.light)}</div>
          <div style="margin-top:12px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${C.gray}">High Quality Home Therapy</div>
        </td></tr>
        <tr><td style="padding:26px 28px 8px">
          <div style="font-size:21px;font-weight:700;color:${C.ink};margin:0 0 14px">Visit note reminder</div>
          <p style="margin:0 0 12px">Hi ${escapeHtml(first)},</p>
          <p style="margin:0 0 18px">The following visit${n === 1 ? ' is' : 's are'} marked <b>Seen</b> in Practice Fusion, but the note is missing or not complete. <b>Subjective, Objective, Assessment and Plan</b> must all be filled in.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;font-size:14px">
            <tr style="background:${C.mist}">
              <td style="${th}">Visit</td><td style="${th}">Client</td><td style="${th}">Needed</td><td style="${th}">Due</td>
            </tr>${rows}
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${C.blue};border-radius:8px">
            <a href="https://static.practicefusion.com/apps/ehr/index.html" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none">Open Practice Fusion</a>
          </td></tr></table>
          <p style="margin:18px 0 0">Notes are due <b>within 24 hours of the visit</b>; insurance companies need them to pay for the session.</p>
          <p style="margin:10px 0 0;color:${C.gray}">If you have already finished it, thank you, and please disregard this reminder.</p>
        </td></tr>
        <tr><td style="padding:22px 28px 26px">
          <p style="margin:0;color:${C.ink}">Thank you,<br><b>High Quality Home Therapy</b></p>
        </td></tr>
        <tr><td style="background:${C.mist};border-top:1px solid ${C.line};padding:14px 28px;font-size:12px;color:${C.gray}">This is an automatic reminder from High Quality Home Therapy.</td></tr>
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
  noteInTimeline, SOAP, writtenText, emptySections, openClientFromSchedule, openTimeline, readVisitNote, setDebugDir, snapshot, emailFor, planReminders, reminderEmail, parseHHMM, dailyDue, dayKey, lookbackDates,
};
