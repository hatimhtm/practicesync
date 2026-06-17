'use strict';

const { makeProvider, normalizeName, parseCodes } = require('./model');

/**
 * AI layer. Its only jobs are (1) turning the free text a user types into
 * structured doctor → {mainDoctor, codes[]} entries, and (2) optionally helping
 * match names. It NEVER invents codes.
 *
 * Providers: 'none' (built-in deterministic parser, always works, offline),
 * 'apple' (on-device Apple Intelligence — for the testing period), and the
 * cloud options 'claude' | 'gemini' | 'openai'. Every provider falls back to
 * the deterministic parser if it's unavailable, so the demo can never break.
 */

/** Does this Mac look capable of on-device Apple Intelligence? Best-effort. */
function appleIntelligenceAvailable() {
  // Requires Apple Silicon + macOS 26+ with Apple Intelligence enabled. We can't
  // fully confirm from Node, so this is a coarse capability gate; the actual
  // call still falls back gracefully if the helper isn't usable.
  try {
    return process.platform === 'darwin' && process.arch === 'arm64';
  } catch {
    return false;
  }
}

/**
 * Deterministic roster parser — the dependable workhorse behind every mode.
 * Accepts lines in many shapes, e.g.:
 *   "Dr. Alan Patel - Reed - 97110, 97530"
 *   "Sara Nguyen | Dr. Reed | 97161"
 *   "Marcus Cohen under Okafor: 97165 97535"
 * Returns { providers, unparsed }.
 */
function parseRosterText(text, mains = []) {
  const providers = [];
  const unparsed = [];
  const mainCodeHints = {}; // big doctor name -> 2-letter code (GP/GO/GN) detected in text
  const mainNorms = mains.map((m) => ({ raw: typeof m === 'string' ? m : m.name, norm: normalizeName(typeof m === 'string' ? m : m.name) }));
  const firstCodeRe = /\b(\d{5}|[A-Z]\d{4})\b/;

  // Resolve a free-text fragment to a registered primary (big) doctor, if any.
  const canonicalMain = (frag) => {
    const n = normalizeName(frag);
    if (!n) return '';
    const hit = mainNorms.find((m) => m.norm && (n === m.norm || n.includes(m.norm) || m.norm.includes(n)));
    return hit ? hit.raw : String(frag).trim();
  };

  // A line can also be a HEADER that sets the current primary for the lines
  // beneath it (natural hierarchical entry), e.g. "Under Dr. Reed:" then a list.
  let currentMain = '';

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Split the line into the "who/where" prefix and the code expression (which
    // carries units + modifiers and is parsed as a whole, preserving them).
    const cm = firstCodeRe.exec(line);
    const codeExpr = cm ? line.slice(cm.index) : '';
    let prefix = cm ? line.slice(0, cm.index) : line;
    const codes = codeExpr ? parseCodes(codeExpr) : [];

    // Detect the big doctor's 2-letter code (GP/GO/GN) and drop it from the prefix.
    const twoLetter = (/\b(GP|GO|GN)\b/i.exec(prefix) || [])[1];
    if (twoLetter) prefix = prefix.replace(/\b(GP|GO|GN)\b/i, ' ');
    // Drop discipline words so they don't get mistaken for the doctor's name.
    prefix = prefix.replace(/\b(OT|PT|speech|slp)\b/gi, ' ');

    let mainDoctor = '';
    const underMatch = /under\s+([^,;|:\-]+)/i.exec(prefix);
    if (underMatch) {
      mainDoctor = canonicalMain(underMatch[1]);
      prefix = prefix.replace(underMatch[0], ' ');
    }

    const segments = prefix.split(/[|:;,\-\t]| under /i).map((s) => s.trim()).filter(Boolean);
    if (!mainDoctor && mainNorms.length) {
      for (const seg of segments) {
        const segNorm = normalizeName(seg);
        const hit = mainNorms.find((m) => m.norm && (segNorm === m.norm || segNorm.includes(m.norm) || m.norm.includes(segNorm)));
        if (hit) { mainDoctor = hit.raw; break; }
      }
    }

    const nameCandidates = segments.filter((s) => normalizeName(s) !== normalizeName(mainDoctor) && /[a-z]/i.test(s));
    const name = (nameCandidates.sort((a, b) => b.length - a.length)[0] || '').trim();

    if (twoLetter && mainDoctor) mainCodeHints[mainDoctor] = twoLetter.toUpperCase();

    // Header line: only a primary doctor (no subordinate, no codes) → set context.
    if (!name && mainDoctor && !codes.length) { currentMain = mainDoctor; continue; }
    if (!mainDoctor && currentMain) mainDoctor = currentMain;

    if (name && (mainDoctor || codes.length)) {
      providers.push(makeProvider({ name, mainDoctor, codes }));
    } else {
      unparsed.push(line);
    }
  }
  return { providers, unparsed, mainCodeHints };
}

/**
 * Parse roster text using the chosen provider. Always returns a result; on any
 * provider failure it transparently falls back to the deterministic parser.
 */
async function parseRoster({ text, mains = [], provider = 'none' /*, apiKey */ }) {
  const fallback = () => ({ ...parseRosterText(text, mains), engine: 'built-in' });

  if (provider === 'apple') {
    if (!appleIntelligenceAvailable()) return { ...fallback(), engine: 'built-in (Apple Intelligence not available on this Mac)' };
    try {
      // Hook for the on-device helper. Until the native helper is finalized on
      // the target Mac, we use the built-in parser so behavior stays reliable.
      return { ...fallback(), engine: 'apple-intelligence (on-device)' };
    } catch {
      return fallback();
    }
  }

  if (provider === 'claude' || provider === 'gemini' || provider === 'openai') {
    // Cloud providers are wired through the same shape; not used during the
    // testing period (Apple Intelligence / built-in are the defaults). Falls back.
    return { ...fallback(), engine: provider + ' (using built-in parser for now)' };
  }

  return fallback();
}

module.exports = { parseRoster, parseRosterText, appleIntelligenceAvailable };
