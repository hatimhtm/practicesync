'use strict';

/**
 * Pure, browser-free DOM logic — the data-handling core of live mode.
 *
 * Two responsibilities, both unit-tested against local fixtures so the behavior
 * is proven before it ever runs on the real Practice Fusion / SimplePractice
 * pages:
 *   1. buildSelector — during Teach Mode, turn an element the user clicked into
 *      a stable selector the app can reuse forever.
 *   2. extractVisits — given the taught selectors, read the first N visits off
 *      the Practice Fusion dashboard exactly the way they appear.
 *   3. planFormValues — map a planned appointment onto the SimplePractice form
 *      fields the user taught us (the values the live engine then types + saves).
 *
 * These functions take a `document` (real in the browser, jsdom in tests), so
 * the same code path is exercised in tests and in production.
 */

function cssEscapeIdent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

/** Is a string a valid bare CSS identifier (so `#id` / `.cls` is safe)? */
function isValidIdent(s) {
  return /^-?[A-Za-z_][\w-]*$/.test(s);
}

/** Escape a value for use inside [attr="..."]. */
function attrValue(v) {
  return String(v).replace(/(["\\])/g, '\\$1');
}

/** A class that is safe to use as a selector token (not auto-generated noise). */
function stableClass(el) {
  const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  // Prefer human-looking classes; skip hashed/utility-ish ones.
  return classes.find((c) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c) && c.length <= 30 && !/^(css|sc|jsx|[a-z]+-[0-9a-f]{4,})/.test(c)) || null;
}

/**
 * Build a stable selector for an element, optionally RELATIVE to an ancestor
 * (used for fields inside a repeating visit row). Preference order:
 * id → data-testid → name/aria-label → a stable class → tag:nth-of-type path.
 */
function buildSelector(el, ancestor = null) {
  if (!el || el.nodeType !== 1) return null;
  const scope = ancestor || el.ownerDocument;

  // Returns { sel, anchor } where `anchor` means "may be globally unique".
  const attrSel = (e) => {
    const tag = e.tagName.toLowerCase();
    if (e.id) return { sel: isValidIdent(e.id) ? '#' + e.id : `[id="${attrValue(e.id)}"]`, anchor: true };
    const testid = e.getAttribute('data-testid') || e.getAttribute('data-test');
    if (testid) return { sel: `[data-testid="${attrValue(testid)}"]`, anchor: true };
    const name = e.getAttribute('name');
    if (name) return { sel: `${tag}[name="${attrValue(name)}"]`, anchor: false, stopRelative: true };
    const aria = e.getAttribute('aria-label');
    if (aria) return { sel: `${tag}[aria-label="${attrValue(aria)}"]`, anchor: false };
    const cls = stableClass(e);
    if (cls) return { sel: `${tag}.${cssEscapeIdent(cls)}`, anchor: false };
    return null;
  };

  const uniqueIn = (sel) => {
    try { return scope.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== ancestor) {
    const a = attrSel(node);
    if (a && a.anchor && uniqueIn(a.sel)) {
      // Truly unique within scope → use this single token and stop.
      parts.unshift(a.sel);
      return parts.join(' > ');
    }
    if (a) {
      parts.unshift(a.sel + nthIfNeeded(node));
      if (ancestor && a.stopRelative) break;
    } else {
      parts.unshift(node.tagName.toLowerCase() + nthIfNeeded(node));
    }
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function nthIfNeeded(node, sel) {
  const parent = node.parentElement;
  if (!parent) return '';
  const tag = node.tagName;
  const sameTag = [...parent.children].filter((c) => c.tagName === tag);
  if (sameTag.length <= 1) return '';
  const idx = sameTag.indexOf(node) + 1;
  return `:nth-of-type(${idx})`;
}

function text(el) {
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

/**
 * Read visits off a dashboard document using taught selectors.
 * @param {Document} doc
 * @param {{rowSelector:string, nameSelector:string, dateSelector:string, doctorSelector:string}} sel
 * @param {number} limit  read at most this many (the 1/2/10 demo slice)
 * @returns {Array<{patientName:string,date:string,doctorName:string}>}
 */
function extractVisits(doc, sel, limit = 10) {
  if (!sel || !sel.rowSelector) return [];
  // Two real shapes are supported, and the SAME taught selectors work for both:
  //   • DAY SCHEDULE (the common case): each row is a DIFFERENT appointment —
  //     patient + doctor (and maybe the time/date) are all read from WITHIN the
  //     row. This is "show me the day, every patient and their doctor."
  //   • PATIENT CHART: one patient (a page header) with many visit rows; the
  //     patient name comes from the header and each row carries a doctor + date.
  // For each field we read it from the row first and fall back to a page-level
  // header, so a selector taught either way resolves correctly.
  const headerName = text(sel.patientSelector ? doc.querySelector(sel.patientSelector) : null);
  const headerDate = text(sel.dateSelector ? doc.querySelector(sel.dateSelector) : null);
  const rows = [...doc.querySelectorAll(sel.rowSelector)];
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const rowPatient = text(sel.patientSelector ? row.querySelector(sel.patientSelector) : null);
    const rowDate = text(sel.dateSelector ? row.querySelector(sel.dateSelector) : null);
    const doctorName = text(sel.doctorSelector ? row.querySelector(sel.doctorSelector) : null);
    const patientName = rowPatient || headerName;
    const date = rowDate || headerDate;
    // Push a row when it carries its OWN patient (day schedule) or its own
    // doctor/date (patient chart) — never an empty inherited-only row.
    if (rowPatient || doctorName || rowDate) out.push({ patientName, date, doctorName });
  }
  return out;
}

/**
 * Map a planned appointment onto the taught SimplePractice form fields.
 * Returns the field→value pairs the live engine will type before clicking Save.
 */
function planFormValues(sel, appointment) {
  const values = [];
  if (sel.patientField) values.push({ selector: sel.patientField, value: appointment.patientName, kind: 'patient' });
  if (sel.mainDoctorField) values.push({ selector: sel.mainDoctorField, value: appointment.mainDoctor, kind: 'doctor' });
  if (sel.dateField) values.push({ selector: sel.dateField, value: appointment.date, kind: 'date' });
  // One service line per code, each with units + modifiers (big-doctor code + e.g. 59).
  const services = appointment.services && appointment.services.length
    ? appointment.services
    : (appointment.codes || []).map((c) => (typeof c === 'string' ? { code: c, units: 1, modifiers: [] } : c));
  services.forEach((svc, i) => {
    if (sel.codeField) values.push({ selector: sel.codeField, value: svc.code, kind: 'codes', line: i });
    if (sel.unitsField) values.push({ selector: sel.unitsField, value: String(svc.units || 1), kind: 'units', line: i });
    if (sel.modifierField) values.push({ selector: sel.modifierField, value: (svc.modifiers || []).join(' '), kind: 'modifier', line: i });
  });
  return values;
}

/**
 * Infer the repeating appointment ROW from a few example fields the user pointed
 * at on ONE appointment (patient + provider, and optionally the date). The user
 * never has to point at "the row" — we find the smallest container that holds
 * both the patient and the provider, generalize a selector that matches every
 * appointment on the day, and re-express each field RELATIVE to that row so it
 * works for all of them.
 *
 * @param {Document} doc  the live schedule (real or jsdom)
 * @param {{patientSelector?:string, dateSelector?:string, doctorSelector?:string}} sel
 *        absolute selectors for the example appointment's fields
 * @returns {null | {rowSelector, patientSelector, doctorSelector, dateSelector?, rowCount, matchedRows}}
 */
function inferSchedule(doc, sel) {
  const pEl = sel && sel.patientSelector ? doc.querySelector(sel.patientSelector) : null;
  const docEl = sel && sel.doctorSelector ? doc.querySelector(sel.doctorSelector) : null;
  if (!pEl || !docEl) return null;
  // Smallest container holding BOTH patient and provider = the appointment row.
  const ancestors = new Set();
  for (let n = pEl; n; n = n.parentElement) ancestors.add(n);
  let row = docEl;
  while (row && !ancestors.has(row)) row = row.parentElement;
  if (!row || row === doc.documentElement || row === doc.body) return null;

  // Generalize the row so it matches EVERY appointment, not just this one.
  const rowSelector = generalizeRow(doc, row);
  const rel = (el) => (el && row.contains(el) ? buildSelector(el, row) : null);
  const out = {
    rowSelector,
    patientSelector: rel(pEl) || sel.patientSelector,
    doctorSelector: rel(docEl) || sel.doctorSelector,
  };
  const dtEl = sel.dateSelector ? doc.querySelector(sel.dateSelector) : null;
  if (dtEl && row.contains(dtEl)) out.dateSelector = buildSelector(dtEl, row);
  else if (sel.dateSelector) out.dateSelector = sel.dateSelector; // a page-level date heading

  // Confidence: how many generalized rows actually contain a patient + provider.
  const rows = [...doc.querySelectorAll(rowSelector)];
  out.rowCount = rows.length;
  out.matchedRows = rows.filter((r) => {
    try { return r.querySelector(out.patientSelector) && r.querySelector(out.doctorSelector); }
    catch { return false; }
  }).length;
  return out;
}

/** A selector for `row` that matches its repeating siblings too (not just it). */
function generalizeRow(doc, row) {
  const cls = stableClass(row);
  if (cls) {
    const byClass = '.' + cssEscapeIdent(cls);
    try { if (doc.querySelectorAll(byClass).length > 1) return byClass; } catch {}
  }
  // Otherwise: the unique path with its LAST positional :nth-of-type removed, so
  // it spans the siblings — but only if that actually matches more than one.
  const full = buildSelector(row);
  if (full) {
    const stripped = full.replace(/:nth-of-type\(\d+\)\s*$/, '');
    try { if (stripped !== full && doc.querySelectorAll(stripped).length > 1) return stripped; } catch {}
    return full;
  }
  return row.tagName.toLowerCase();
}

module.exports = { buildSelector, extractVisits, planFormValues, stableClass, inferSchedule };
