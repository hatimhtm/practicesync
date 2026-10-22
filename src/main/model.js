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

// A client split by discipline is stored in SimplePractice with the tag baked
// into their own name ("Luke PT/OT Bousseau" — see book.js DISC_TAG_RE/
// chooseOptionIndex), so the calendar's existing-appointment title carries it
// too. The Practice Fusion visit never does (it's just "Luke Bousseau") — so
// dedup must ignore these tokens or it can NEVER recognize the two as the same
// patient, and re-books them fresh (at the sync's starting time slot) on every
// run. Same token set book.js already treats as non-name discipline tags.
const DISC_TAG_TOKENS = new Set(['pt', 'ot', 'slp']);

/** Word-order-independent name equality ("Doe, Jane" ↔ "Jane Doe" ↔ "jane  doe"),
 *  ignoring any PT/OT/SLP discipline tag baked into a SimplePractice client's
 *  display name, so a name shown differently — or tagged — on the calendar is
 *  still recognized as the same patient (used to detect an existing
 *  appointment and avoid double-booking it). */
function sameName(a, b) {
  const strip = (s) => normalizeName(s).split(' ').filter((t) => t && !DISC_TAG_TOKENS.has(t)).sort();
  const ta = strip(a), tb = strip(b);
  return ta.length > 0 && ta.join(' ') === tb.join(' ');
}

// Some Practice Fusion rows are organizations, not patients — e.g. "All Pointe
// HomeCare Contract Agency". They have no SimplePractice client record and must
// never be booked. Matches the org markers the practice uses (chiefly "agency");
// these words don't occur in real patient names, so it won't skip a real person.
const NON_PATIENT_RE = /\b(agenc(y|ies)|contract agency|\bLLC\b|\bInc\b)\b/i;
function isNonPatient(name) {
  return NON_PATIENT_RE.test(String(name || ''));
}

// The practice's self-pay (private-pay) rule: when the Practice Fusion appointment
// TYPE is one of these, it's private pay — booked against the patient's "Self Pay"
// record with a preset service + fee, NOT insurance CPT codes. Everything else
// (New Patient Visit, Follow-Up Visit, Re-evaluation, …) is insurance.
const SELF_PAY_TYPES = /\b(physical|occupational|speech)\s+therapy\b|\b(home|office)\s+visit\b/i;
function isSelfPay(type) { return SELF_PAY_TYPES.test(String(type || '')); }

// An explicit override: patients the practice lists as ALWAYS self-pay, regardless
// of the appointment type. Matched by name, format-independent (sameName), so a
// list entry "Doe, Jane" still catches Practice Fusion's "Jane Doe".
function isSelfPayClient(name, list) {
  return Array.isArray(list) && list.some((entry) => sameName(name, entry));
}

// Per-client payer status, entered on Doctors & Codes and kept ONLY in this Mac's
// settings (patient names never ship in the app or the repo). It decides
// billing ahead of the appointment type:
//   contracted → never booked in SimplePractice (billed through the contract)
//   insurance  → booked with the doctor's CPT codes
//   private    → booked against the Self Pay record, no codes — just save
// Clients not on the list fall back to the appointment-type rule (isSelfPay).
const PAYER_STATUSES = ['private', 'insurance', 'contracted'];
function normPayer(s) {
  const t = String(s || '').trim().toLowerCase();
  if (/^contract/.test(t)) return 'contracted';
  if (/^insur/.test(t)) return 'insurance';
  if (/^(private|self)/.test(t)) return 'private';
  return '';
}
/** "Name, Status" / "Name<TAB>Status" / "Name Status" lines → [{ name, status }]. */
function parsePayerList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(.*?)[\s,;:\t-]+(private|self[\s-]?pay|insurance|contracted?)\s*$/i.exec(line);
    if (m && m[1].trim()) out.push({ name: m[1].trim(), status: normPayer(m[2]) });
  }
  return out;
}
function formatPayerList(list) {
  const label = { private: 'Private', insurance: 'Insurance', contracted: 'Contracted' };
  return (list || []).map((c) => `${c.name}, ${label[c.status] || c.status}`).join('\n');
}
/** The client's payer status ('private' | 'insurance' | 'contracted'), or '' if unlisted. */
function payerStatusFor(name, list) {
  const hit = clientFor(name, list);
  return hit ? normPayer(hit.status) : '';
}
/** The client's entry on the payer list ({ name, status, id?, codes? }), or null. */
function clientFor(name, list) {
  return (Array.isArray(list) ? list : []).find((c) => c && sameName(name, c.name)) || null;
}

/* ------------------------- per-patient code lists ------------------------- */
// The practice keeps each insurance patient's codes per therapist, the way its
// "Payer Status for patients" sheet writes them, one therapist per line:
//   Caryn: 97112 x 2 (GP), 97530 x 2 (GP, 59)
//   Jessica/Danielle/Heather: 97112 x 2 (GO), 97530 x 2 (GO, 59)
//   Jade: $165                       ← that therapist's visits are private pay
// A patient's own list wins over a therapist's standard codes. Modifiers are
// used exactly as written (the sheet spells out GP/GO/GN and 59 per line).

const G_MOD = /^G[PON]$/;
// "Name:" / "Name/Name :" / "Nicole Williams:" — the label in front of each list.
const LABEL_RE = /([A-Za-z][A-Za-z'’.-]*(?:\s*\/\s*[A-Za-z][A-Za-z'’.-]*|\s+[A-Za-z][A-Za-z'’.-]*){0,3})\s*:/g;

/** One code list's text → [{ code, units, modifiers }] with modifiers from its brackets. */
function parseBankCodes(text) {
  const s = String(text || '');
  const codeRe = /\b(\d{5}|[A-Z]\d{4})\b/g;
  const hits = [];
  let m;
  while ((m = codeRe.exec(s))) hits.push({ code: m[1], start: m.index, end: codeRe.lastIndex });
  return hits.map((h, i) => {
    const seg = s.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : s.length);
    const u = /x\s*(\d+)|(\d+)\s*units?/i.exec(seg);
    const units = u ? (parseInt(u[1] || u[2], 10) || 1) : 1;
    const inBrackets = /\(([^)]*)\)/.exec(seg);
    const modifiers = [];
    for (const t of (inBrackets ? inBrackets[1] : '').split(/[\s,;]+/)) {
      const v = t.trim().toUpperCase();
      if (/^([A-Z]{2}|\d{2})$/.test(v) && !modifiers.includes(v)) modifiers.push(v);
    }
    return { code: h.code, units, modifiers };
  });
}

/** A client's code-list text → [{ names:[...], codes:[...], private:boolean, raw }]. */
function parseCodeBank(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const labels = [];
    let m;
    LABEL_RE.lastIndex = 0;
    while ((m = LABEL_RE.exec(line))) labels.push({ label: m[1], start: m.index, end: LABEL_RE.lastIndex });
    labels.forEach((l, i) => {
      const body = line.slice(l.end, i + 1 < labels.length ? labels[i + 1].start : line.length).trim();
      const names = l.label.split('/').map((n) => n.trim()).filter(Boolean);
      const isPrivate = /\$\s*\d|\b(private|self[\s-]?pay)\b/i.test(body);
      out.push({ names, codes: isPrivate ? [] : parseBankCodes(body), private: isPrivate, raw: `${l.label.trim()}: ${body}`.trim() });
    });
  }
  return out;
}

/** The GP/GO/GN a code list is written for, or ''. */
function bankDiscipline(codes) {
  for (const c of codes || []) for (const mod of c.modifiers || []) if (G_MOD.test(mod)) return mod;
  return '';
}

/** Does a list's label ("Sam", "JR", "Nicole Williams") name this therapist? */
function labelNames(label, provider) {
  const want = normalizeName(label).split(' ').filter(Boolean);
  const have = normalizeName(provider && provider.name).split(' ').filter(Boolean);
  if (!want.length || !have.length) return false;
  return want.every((w) => have.some((h) => h === w || (w.length >= 3 && h.length >= 3 && (h.startsWith(w) || w.startsWith(h)))));
}

/**
 * Which of a patient's lists applies to this visit's therapist:
 *   { source:'patient', entry }     — the list names the therapist
 *   { source:'discipline', entry }  — it doesn't, but every list for the same
 *                                     discipline (GP/GO/GN) carries the same codes
 *   { source:'none' }               — use the therapist's standard codes
 * A list written for another discipline never applies ("Sam" with speech codes is
 * not Samantha the OT), and a private entry ("Jade: $165") wins as private pay.
 */
function patientCodesFor(bank, provider, mainCode) {
  const entries = Array.isArray(bank) ? bank : [];
  const fits = (e) => { const d = bankDiscipline(e.codes); return !d || !mainCode || d === mainCode; };
  const named = entries.find((e) => (e.private || e.codes.length) && e.names.some((n) => labelNames(n, provider)) && fits(e));
  if (named) return { source: 'patient', entry: named };
  if (mainCode) {
    const same = entries.filter((e) => !e.private && e.codes.length && bankDiscipline(e.codes) === mainCode);
    const sets = new Set(same.map((e) => formatServices(e.codes)));
    if (sets.size === 1) return { source: 'discipline', entry: same[0] };
  }
  return { source: 'none' };
}

/** Service lines as a comparable string ("97112 x2 (GO), 97530 x2 (GO,59)"). */
function formatServices(codes) {
  return (codes || []).map((c) => `${c.code} x${c.units || 1}${c.modifiers && c.modifiers.length ? ` (${c.modifiers.join(',')})` : ''}`).join(', ');
}

/** The therapists a code list names, for a short summary ("Caryn, Jessica/Danielle"). */
function codeBankSummary(text) {
  return parseCodeBank(text).map((e) => e.names.join('/') + (e.private ? ' (private)' : '')).join(', ');
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
 *  alike and make every single-name provider look ambiguous.
 *  `allowInitial` lets a bare one-letter PF token confirm a roster token by
 *  matching its first letter — e.g. "v" confirms "vines" in "Heather Vines
 *  Dubose" — but the CALLER only ever passes it for a surname token once the
 *  roster's FIRST name has already matched. An initial checked on its own is
 *  near-meaningless (any of ~26 surnames could start with it), so allowing it
 *  unconditionally let a bare "s" confirm a totally unrelated person's surname
 *  (e.g. "Sally S" scoring "Regis Saget" a tie via "Saget" alone) — the exact
 *  class of collision this function exists to prevent, just moved one token
 *  over. Gating it on the first name already having matched keeps it safe. */
function tokenIn(rosterTok, pfTokens, allowInitial = false) {
  return pfTokens.some((pt) => pt === rosterTok
    || (rosterTok.length >= 3 && pt.length >= 3 && (pt.startsWith(rosterTok) || rosterTok.startsWith(pt)))
    || (allowInitial && pt.length === 1 && rosterTok[0] === pt));
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
    // The surname-initial credit (see tokenIn) only ever applies once the
    // FIRST name itself matched — never as standalone evidence.
    const firstNameMatches = tokenIn(rt[0], pfTokens);
    const found = rt.filter((t, idx) => (idx === 0 ? firstNameMatches : tokenIn(t, pfTokens, firstNameMatches))).length;
    // Score against how many roster tokens COULD possibly be confirmed by the
    // given PF tokens (never more than pfTokens.length), not the roster name's
    // full length. Otherwise a compound/hyphenated surname (more tokens) always
    // scores WORSE than a same-first-name provider with a one-word surname for
    // identical evidence — e.g. a bare "Heather" penalized "Heather Vines
    // Dubose" (1/3) less than an unrelated "Heather Meehan" (1/2), so the
    // shorter name won by arithmetic alone. Capping the denominator makes a
    // bare first name tie (correctly ambiguous) instead of picking whichever
    // roster entry happens to have the shortest name.
    return { p, score: found / Math.min(rt.length, pfTokens.length) };
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
  'Karine Rocha de Benedicto': '92523 x1, 92507 x1, 92626 x1, 97535 x2', // Speech
};
// The speech codes seeded before Oct 2026 — existing installs still holding
// exactly this set are migrated to the new UNIT_CODES on startup.
const OLD_SPEECH_CODES = '92507 x1, 97550 x2';
// Disciplines that actually bill their unit's therapy codes. Everyone else (nurse,
// intern, admin, social work, massage, aide) is still listed for completeness but
// seeded with NO codes, so they can never book a wrong service until the user sets
// codes themselves. The user can edit any of this on the Doctors & Codes screen.
const THERAPY_DISCIPLINE = /\b(PT|PTA|DPT|CPT|OT|COTA|SOT|SLP|SLPA|CF|Cognition)\b/i;
function seedProvider(name, discipline, mainDoctor) {
  const codes = THERAPY_DISCIPLINE.test(discipline) ? (UNIT_CODES[mainDoctor] || '') : '';
  return makeProvider({ name, discipline, mainDoctor, codes });
}

// The client's roster, from their October 2026 "Billing Providers for AI App"
// sheet: every therapist and the billing provider (big doctor) they bill under.
// A fresh install starts with it; an existing install merges it in once (see
// mergeRoster) without touching anyone's codes.
const C = 'Caryn McAllister', H = 'Heather Vines-Dubose', K = 'Karine Rocha de Benedicto';
const DEMO_PROVIDERS = [
  // — Caryn McAllister · Physical Therapy —
  seedProvider('Caryn McAllister', 'PT', C),
  seedProvider('Delicatina Osipow', 'CPT', C),
  seedProvider('Erica Cutler', 'PT', C),
  seedProvider('Ernie Bojorquez', 'CPT', C),
  seedProvider('Francesca Fidaleo', 'Nurse', C),
  seedProvider('Gianna Hernandez', 'PT', C),
  seedProvider('Heather Meehan', 'Nurse', C),
  seedProvider('Jade Lee MeeSook', 'LMT', C),
  seedProvider('Jennifer Barstrom', 'PT', C),
  seedProvider('Joanne Paulino', 'PTA', C),
  seedProvider('John Pender', 'Flexologist', C),
  seedProvider('JR Meehan', 'PT', C),
  seedProvider('Julie Connery-Smith', 'PT', C),
  seedProvider('Kempton Brisport', 'MSW', C),
  seedProvider('Laurits (Mikel) Bensend', 'LMT', C),
  seedProvider('Lindsay Richard', 'PT', C),
  seedProvider('Michael Goldsmith', 'PT', C),
  seedProvider('Michelle Minnocci', 'PT', C),
  seedProvider('Michelle Broggi', 'PT', C),
  seedProvider('Monica Jain', 'PT', C),
  seedProvider('Nardeen Abdelsayed', 'PT', C),
  seedProvider('Nathalia (Lesly) Fajardo', 'LCSW/LMT', C),
  seedProvider('Nicole Nelson', 'Nurse', C),
  seedProvider('Olga Vera', 'Psychologist', C),
  seedProvider('Rebecca Passante', 'PT', C),
  seedProvider('Regis Saget', 'LMT', C),
  seedProvider('Richard Boehmcke', 'NASM - CPT', C),
  seedProvider('Ron Hylton', 'LMT/CPT', C),
  seedProvider('Sarah Zahner', 'PT', C),
  // — Heather Vines-Dubose · Occupational Therapy —
  seedProvider('Alexis Parker', 'COTA', H),
  seedProvider('Amanda Meyer', 'OT', H),
  seedProvider('Bruce Francisco', 'COTA', H),
  seedProvider('Danielle Reichert', 'COTA', H),
  seedProvider('Diana Alvarado', 'COTA', H),
  seedProvider('Hayley Brooks-Wallin', 'OT', H),
  seedProvider('Heather Vines-Dubose', 'OT', H),
  seedProvider('Jessica Trujillo', 'OT', H),
  seedProvider('Nicki Mancusi', 'COTA', H),
  seedProvider('Nicole Lee-Williams', 'OT', H),
  seedProvider('Raquel Godoi', 'SOT', H),
  seedProvider('Samantha Impellizeri (Scavo)', 'OT', H),
  seedProvider('Sara Florio', 'OT', H),
  seedProvider('Shanina Smith', 'COTA', H),
  seedProvider('Susan Gainty', 'OT', H),
  // — Karine Rocha de Benedicto · Speech —
  seedProvider('Carolyn Finch-Hulme', 'SLP', K),
  seedProvider('Colleen Kopchik', 'SLPA', K),
  seedProvider('Eileen McGonegal', 'SLP', K),
  seedProvider('Elisa Isabella-Valenzi', 'SLP', K),
  seedProvider('Evelyn Marin', 'SLP', K),
  seedProvider('Francesca Day', 'SLP', K),
  seedProvider('Joan Black', 'SLP', K),
  seedProvider('Karine Rocha de Benedicto', 'SLP', K),
  seedProvider('Paul Bertuglia', 'SLPA', K),
  seedProvider('Samantha Comrie', 'SLP CF', K),
  seedProvider('Shandley McMurray-Brown', 'Cognition Specialist', K),
  seedProvider('Yamela Cando', 'SLP', K),
];

// Bumped whenever DEMO_PROVIDERS changes, so existing installs merge it once.
const ROSTER_VERSION = 3;

/** Is roster entry `a` the same therapist as sheet entry `b`? Tolerates a name the
 *  office typed short ("Nardeen A", "Nardeen") or in another order. */
function sameStaff(a, b) {
  if (sameName(a, b)) return true;
  const ta = normalizeName(a).split(' ').filter(Boolean);
  const tb = normalizeName(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const pre = (x, y) => x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x)));
  if (!pre(ta[0], tb[0])) return false;
  if (ta.length === 1 || tb.length === 1) return true;
  const la = ta[ta.length - 1], lb = tb[tb.length - 1];
  return la === lb || (la.length === 1 && lb[0] === la) || (lb.length === 1 && la[0] === lb) || pre(la, lb);
}

/**
 * Merge the practice's latest roster into what's saved on this Mac, never losing
 * anything: a therapist on the sheet who's missing is added (with the standard
 * codes of their unit); one already there gets the sheet's billing provider and
 * discipline but KEEPS their codes; anyone the office added who isn't on the
 * sheet stays as they are. A short or same-first-name entry that could be two
 * sheet people is left alone rather than guessed.
 */
function mergeRoster(current, sheet = DEMO_PROVIDERS) {
  const providers = (Array.isArray(current) ? current : []).map((p) => ({ ...p }));
  const changes = { added: [], moved: [] };
  for (const s of sheet) {
    const exact = providers.findIndex((p) => sameName(p.name, s.name));
    let i = exact;
    if (i === -1) {
      const near = providers.map((p, j) => (sameStaff(p.name, s.name) ? j : -1)).filter((j) => j >= 0);
      // Only a single, unambiguous near-match counts (one "Michelle" vs two on the sheet does not).
      const rivals = sheet.filter((o) => o !== s && near.some((j) => sameStaff(providers[j].name, o.name)));
      if (near.length === 1 && !rivals.length) i = near[0];
    }
    if (i === -1) { providers.push({ ...s, codes: (s.codes || []).map((c) => ({ ...c })) }); changes.added.push(s.name); continue; }
    const p = providers[i];
    if (normalizeName(p.mainDoctor) !== normalizeName(s.mainDoctor)) { changes.moved.push(`${p.name} → ${s.mainDoctor}`); p.mainDoctor = s.mainDoctor; }
    if (s.discipline) p.discipline = s.discipline;
  }
  return { providers, ...changes };
}

module.exports = {
  normalizeName,
  sameName,
  isNonPatient,
  isSelfPay,
  isSelfPayClient,
  PAYER_STATUSES,
  parsePayerList,
  formatPayerList,
  payerStatusFor,
  clientFor,
  parseCodeBank,
  parseBankCodes,
  bankDiscipline,
  labelNames,
  patientCodesFor,
  formatServices,
  codeBankSummary,
  ROSTER_VERSION,
  mergeRoster,
  UNIT_CODES,
  OLD_SPEECH_CODES,
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
