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

/** A roster entry maps one small (subordinate) doctor to a big doctor + codes.
 *  `discipline` (PT/OT/SLP/…) is a free-text label the user can see and edit; it
 *  doesn't affect booking (the modifier comes from the big doctor), but it keeps
 *  the roster readable and matches how the practice organizes its therapists. */
function makeProvider({ name, mainDoctor, codes, discipline }) {
  return {
    name: String(name || '').trim(),
    mainDoctor: String(mainDoctor || '').trim(),
    discipline: String(discipline || '').trim(),
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
  { name: 'Caryn McAllister', code: 'GP' },        // Physical Therapy
  { name: 'Heather Vines-Dubose', code: 'GO' },    // Occupational Therapy
  { name: 'Karine Rocha de Benedicto', code: 'GN' }, // Speech
];

// Each unit's standard billing codes. The big-doctor 2-letter code (GP/GO/GN) is
// added to every line automatically at booking; 97530 also carries the 59 modifier.
const UNIT_CODES = {
  'Caryn McAllister': '97112 x2, 97530 x2 (59)',       // PT
  'Heather Vines-Dubose': '97112 x2, 97530 x2 (59)',   // OT
  'Karine Rocha de Benedicto': '92507 x1, 97550 x2',   // Speech
};
// Disciplines that actually bill their unit's therapy codes. Everyone else (nurse,
// intern, admin, social work, massage, aide) is still listed for completeness but
// seeded with NO codes, so they can never book a wrong service until the user sets
// codes themselves. The user can edit any of this on the Doctors & Codes screen.
const THERAPY_DISCIPLINE = /\b(PT|DPT|CPT|OT|COTA|SOT|SLP|SLPA|CF|Cognition)\b/i;
function seedProvider(name, discipline, mainDoctor) {
  const codes = THERAPY_DISCIPLINE.test(discipline) ? (UNIT_CODES[mainDoctor] || '') : '';
  return makeProvider({ name, discipline, mainDoctor, codes });
}

// The client's real roster (from their July 2026 sheet): every therapist under one
// of the three main doctors. Loaded via "Load full roster" on Doctors & Codes.
const C = 'Caryn McAllister', H = 'Heather Vines-Dubose', K = 'Karine Rocha de Benedicto';
const DEMO_PROVIDERS = [
  // — Caryn McAllister · Physical Therapy —
  seedProvider('Abby Ramage', 'PT', C),
  seedProvider('Caryn McAllister', 'PT', C),
  seedProvider('Dave Quirante', 'PT', C),
  seedProvider('Delicatina Osipow', 'CPT', C),
  seedProvider('Erica Cutler', 'PT', C),
  seedProvider('Ernie Bojorquez', 'CPT', C),
  seedProvider('Francesca Fidaleo', 'Nurse', C),
  seedProvider('Gianna Hernandez', 'PT', C),
  seedProvider('Gloria Lombardi', 'Intern', C),
  seedProvider('Heather Meehan', 'Nurse', C),
  seedProvider('Jade Lee MeeSook', 'LMT', C),
  seedProvider('Jennifer Barstrom', 'PT', C),
  seedProvider('John Pender', 'Flexologist', C),
  seedProvider('JR Meehan', 'PT', C),
  seedProvider('Kempton Brisport', 'MSW', C),
  seedProvider('Lindsay Richard', 'PT', C),
  seedProvider('Mayra Recine', 'DPT', C),
  seedProvider('Michael Goldsmith', 'PT', C),
  seedProvider('Michelle Minnocci', 'PT', C),
  seedProvider('Michelle Broggi', 'PT', C),
  seedProvider('Monica Jain', 'PT', C),
  seedProvider('Nathalia (Lesly) Fajardo', 'LCSW/LMT', C),
  seedProvider('Nicole Nelson', 'Nurse', C),
  seedProvider('Norma Dray', 'LMT', C),
  seedProvider('Olga Vera', 'Psychologist', C),
  seedProvider('Rebecca Passante', 'PT', C),
  seedProvider('Regis Saget', 'LMT', C),
  seedProvider('Ron Hylton', 'LMT/CPT', C),
  seedProvider('Sarah Zahner', 'PT', C),
  seedProvider('Thayly Santos Ponce', 'Intern/PT Aide', C),
  // — Heather Vines-Dubose · Occupational Therapy —
  seedProvider('Alexis Parker', 'COTA', H),
  seedProvider('Amanda Meyer', 'OT', H),
  seedProvider('Danielle Reichert', 'COTA', H),
  seedProvider('Hayley Brooks-Wallin', 'OT', H),
  seedProvider('Heather Vines-Dubose', 'OT', H),
  seedProvider('Jessica Trujillo', 'OT', H),
  seedProvider('Nicki Mancusi', 'COTA', H),
  seedProvider('Nicole Lee-Williams', 'OT', H),
  seedProvider('Raquel Godoi', 'SOT', H),
  seedProvider('Samantha Impellizeri (Scavo)', 'OT', H),
  seedProvider('Sara Florio', 'OT', H),
  seedProvider('Shanina Smith', 'COTA', H),
  // — Karine Rocha de Benedicto · Speech —
  seedProvider('Carolyn Finch-Hulme', 'SLP', K),
  seedProvider('Colleen Kopchik', 'SLPA', K),
  seedProvider('Joan Black', 'SLP', K),
  seedProvider('Kaitlyn Van Heusden', 'Rehab Aide', K),
  seedProvider('Karine Rocha de Benedicto', 'SLP', K),
  seedProvider('Laurits (Mikel) Bensend', 'LMT', K),
  seedProvider('Paul Bertuglia', 'SLPA', K),
  seedProvider('Sally Connolly', 'SLP', K),
  seedProvider('Samantha Comrie', 'SLP CF', K),
  seedProvider('Shandley McMurray-Brown', 'Cognition Specialist', K),
  seedProvider('Yamela Cando', 'SLP', K),
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
