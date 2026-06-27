'use strict';

/**
 * Data model for the PracticeFusion → SimplePractice automation.
 *
 * The job: read a patient VISIT from Practice Fusion (patient name, date, the
 * diagnosing doctor), then create a coded appointment in SimplePractice under
 * the correct MAIN doctor. Two pieces of user-provided knowledge drive it, both
 * keyed by the diagnosing doctor's name:
 *
 *   mainDoctor : which of the 3 main doctors this doctor sits under
 *   codes[]    : one or more treatment/diagnosis codes to enter (a doctor can
 *                have several)
 *
 * The user enters this as a roster; the app remembers it and reuses it until
 * changed. The AI layer only helps PARSE free text into this shape and MATCH a
 * Practice Fusion doctor name to a roster entry — it never invents codes.
 */

/** Normalize a person's name for tolerant matching (case/space/punct-insensitive). */
function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\b(dr|doctor|md|do|prof)\b/g, ' ') // drop honorifics/suffixes
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The big-doctor 2-letter modifier codes that go on every service line. */
const MAIN_CODES = ['GP', 'GO', 'GN'];

/** A big (main) doctor: a name plus their 2-letter modifier code (GP/GO/GN). */
function makeMainDoctor(m) {
  if (typeof m === 'string') return { name: m.trim(), code: '' };
  return { name: String(m.name || '').trim(), code: String(m.code || '').trim().toUpperCase() };
}

/**
 * Parse a code expression into structured services: code + units + modifiers.
 * Accepts the many shapes seen in real rosters, e.g.:
 *   "97112 (2 units) 97530 (2 units) w/59"
 *   "97112 x2, 97530 x2 modifier 59"
 *   "92523 1 unit, 92507 1 unit, 97550 2 units"
 * Returns [{ code, units, modifiers:[] }].
 */
function parseCodes(input) {
  if (Array.isArray(input) && input.length && typeof input[0] === 'object') {
    // already structured
    return input.map((c) => ({
      code: String(c.code || '').trim(),
      units: Number(c.units) > 0 ? Number(c.units) : 1,
      modifiers: (c.modifiers || []).map((x) => String(x).trim()).filter(Boolean),
    })).filter((c) => c.code);
  }
  const s = Array.isArray(input) ? input.join(', ') : String(input || '');
  const codeRe = /\b(\d{5}|[A-Z]\d{4})\b/g;
  const hits = [];
  let m;
  while ((m = codeRe.exec(s))) hits.push({ code: m[1], start: m.index, end: codeRe.lastIndex });
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const seg = s.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : s.length);
    const u = /x\s*(\d+)|\(?\s*(\d+)\s*un/i.exec(seg); // "x2" | "(2 units)" | "2 unit(s)"
    const units = u ? (parseInt(u[1] || u[2], 10) || 1) : 1;
    // 2-digit modifiers (e.g. 59); ignore the units value itself, dedupe.
    const modifiers = [];
    for (const x of seg.match(/\b\d{2}\b/g) || []) {
      if (parseInt(x, 10) !== units && !modifiers.includes(x)) modifiers.push(x);
    }
    out.push({ code: hits[i].code, units, modifiers });
  }
  return out;
}

/** Render structured services back to a compact editable string. */
function formatCodes(codes) {
  return (codes || []).map((c) => {
    let s = c.code;
    if (c.units && c.units !== 1) s += ' x' + c.units;
    if (c.modifiers && c.modifiers.length) s += ' (' + c.modifiers.join(',') + ')';
    return s;
  }).join(', ');
}

/** A roster entry maps one small (subordinate) doctor to a big doctor + codes. */
function makeProvider({ name, mainDoctor, codes }) {
  return {
    name: String(name || '').trim(),
    mainDoctor: String(mainDoctor || '').trim(),
    codes: parseCodes(codes),
  };
}

/** Look up a big doctor's 2-letter modifier code from the configured list. */
function mainCodeFor(mainDoctorName, mainDoctors) {
  const n = normalizeName(mainDoctorName);
  const hit = (mainDoctors || []).map(makeMainDoctor).find((m) => {
    const mn = normalizeName(m.name);
    return mn && (mn === n || mn.includes(n) || n.includes(mn));
  });
  return hit ? hit.code : '';
}

/**
 * Find the roster entry (subordinate doctor) for a Practice Fusion doctor name.
 *
 * Safety-first: a wrong match would book a patient under the WRONG primary
 * doctor, so we only accept a fuzzy match when the SURNAME is shared and the
 * token overlap is strong — a single shared FIRST name ("Alan") is never enough.
 * If two roster entries tie, we refuse and surface it as ambiguous rather than
 * silently picking one by array order.
 *
 * @returns {{provider:object|null, confidence:number, reason?:string}}
 */
/** Does a roster-name token appear in the Practice Fusion name (allowing
 *  first-name/nickname prefixes, e.g. "sam" ⊂ "samantha")? Practice Fusion shows
 *  a surname INITIAL ("Shanina s", "Sally S"); a 1–2 char token must match
 *  EXACTLY, never by prefix, or the initial "s" would match Sally/Sam/Shanina
 *  alike and make every single-name provider look ambiguous. */
function tokenIn(rosterTok, pfTokens) {
  return pfTokens.some((pt) => pt === rosterTok || (rosterTok.length >= 3 && pt.length >= 3 && (pt.startsWith(rosterTok) || rosterTok.startsWith(pt))));
}

function matchProvider(doctorName, providers) {
  const target = normalizeName(doctorName);
  if (!target) return { provider: null, confidence: 0, reason: 'no doctor name' };
  const pfTokens = target.split(' ').filter(Boolean);

  // 1) exact normalized match
  for (const p of providers) {
    if (normalizeName(p.name) === target) return { provider: p, confidence: 1 };
  }

  // 2) containment: the roster name (often just a first name, e.g. "Gianna")
  //    should be fully present in the Practice Fusion name ("Gianna Hernandez").
  const scored = providers.map((p) => {
    const rt = normalizeName(p.name).split(' ').filter(Boolean);
    if (!rt.length) return { p, score: 0 };
    const found = rt.filter((t) => tokenIn(t, pfTokens)).length;
    return { p, score: found / rt.length };
  });

  const full = scored.filter((s) => s.score >= 0.99); // every roster token found
  if (full.length === 1) return { provider: full[0].p, confidence: 1 };
  if (full.length > 1) return { provider: null, confidence: 1, reason: 'ambiguous — more than one doctor matches' };

  // 3) partial fallback — accept only if exactly one roster entry is a clear, single best
  const partial = scored.filter((s) => s.score >= 0.5).sort((a, b) => b.score - a.score);
  if (partial.length === 1) return { provider: partial[0].p, confidence: partial[0].score };
  if (partial.length > 1 && partial[0].score - partial[1].score >= 0.5) return { provider: partial[0].p, confidence: partial[0].score };
  if (partial.length > 1) return { provider: null, confidence: partial[0].score, reason: 'ambiguous — more than one doctor matches' };
  return { provider: null, confidence: 0, reason: 'not recognized' };
}

// Demo data mirrors the client's REAL roster (from their photo) so the client
// sees their own doctors/codes in Test Mode — zero live dependencies, fake
// patients only. Big doctors carry their 2-letter modifier code.
const DEMO_MAIN_DOCTORS = [
  { name: 'Caryn McAllister', code: 'GP' },
  { name: 'Heather Vines-Dubose', code: 'GO' },
  { name: 'Karine Rocha de Benedicto', code: 'GN' },
];

const DEMO_PROVIDERS = [
  makeProvider({ name: 'Jess', mainDoctor: 'Heather Vines-Dubose', codes: '97112 x2, 97530 x2 (59)' }),
  makeProvider({ name: 'Shanina', mainDoctor: 'Heather Vines-Dubose', codes: '97112 x2, 97530 x2 (59)' }),
  makeProvider({ name: 'Sam Comrie', mainDoctor: 'Karine Rocha de Benedicto', codes: '92523 x1, 92507 x1, 97550 x2' }),
  makeProvider({ name: 'Gianna', mainDoctor: 'Caryn McAllister', codes: '97112 x2, 97530 x2 (59)' }),
  makeProvider({ name: 'Sally', mainDoctor: 'Karine Rocha de Benedicto', codes: '92507 x1, 97550 x2' }),
  makeProvider({ name: 'Eleni', mainDoctor: 'Heather Vines-Dubose', codes: '97112 x2, 97530 x2' }),
  makeProvider({ name: 'Joanne Paulino', mainDoctor: 'Caryn McAllister', codes: '97112 x2, 97530 x2' }),
  makeProvider({ name: 'Leah Santalis', mainDoctor: 'Karine Rocha de Benedicto', codes: '92523 x1, 92507 x1, 97550 x2' }),
  makeProvider({ name: 'Yamela Cando', mainDoctor: 'Karine Rocha de Benedicto', codes: '92523 x1, 92507 x1' }),
  makeProvider({ name: 'Nicki Mancusi', mainDoctor: 'Heather Vines-Dubose', codes: '97112 x1, 97530 x3' }),
  makeProvider({ name: 'Olivia Misiak', mainDoctor: 'Caryn McAllister', codes: '97112 x2, 97530 x2' }),
];

module.exports = {
  normalizeName,
  makeProvider,
  makeMainDoctor,
  matchProvider,
  parseCodes,
  formatCodes,
  mainCodeFor,
  MAIN_CODES,
  DEMO_MAIN_DOCTORS,
  DEMO_PROVIDERS,
};
