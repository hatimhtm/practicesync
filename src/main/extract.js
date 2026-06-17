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
  // The PATIENT name is the page header (one element); each ROW is a visit with
  // its own doctor + date. We read straight from the list — no drilling in.
  const patientName = text(sel.patientSelector ? doc.querySelector(sel.patientSelector) : null);
  const rows = [...doc.querySelectorAll(sel.rowSelector)];
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const date = text(sel.dateSelector ? row.querySelector(sel.dateSelector) : null);
    const doctorName = text(sel.doctorSelector ? row.querySelector(sel.doctorSelector) : null);
    if (doctorName || date) out.push({ patientName, date, doctorName });
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

module.exports = { buildSelector, extractVisits, planFormValues, stableClass };
