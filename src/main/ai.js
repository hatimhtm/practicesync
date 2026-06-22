'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { makeProvider, normalizeName, parseCodes } = require('./model');

/**
 * AI layer. Its job is to turn the FREE TEXT a user types about their doctors —
 * in whatever messy, natural shape they wrote it — into structured
 * doctor → {mainDoctor, codes[]} entries. It NEVER invents codes: a real model
 * does the natural-language understanding, then everything it returns is
 * re-validated through the deterministic model (parseCodes / makeProvider), and
 * if the model is unavailable or returns junk we fall back to the built-in
 * regex parser. So the feature degrades gracefully and can never break a demo.
 *
 * Engines, smartest first:
 *   'ollama'  — a local model (e.g. Gemma 4 / gemma4:e4b) served by Ollama on
 *               localhost:11434. Fully offline, no key. Detected at runtime.
 *   'apple'   — on-device Apple Intelligence (Foundation Models), reached through
 *               a tiny compiled Swift helper (macOS 26+, Apple Silicon).
 *   'none'    — the deterministic built-in parser. Always available, offline.
 * 'auto' picks the smartest available; an explicit engine forces that one.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
// Preferred local models, best→worst, by name prefix. First installed one wins.
const PREFERRED_OLLAMA = ['gemma4', 'gemma3', 'gemma', 'llama3', 'qwen', 'mistral'];
// The Apple Intelligence helper binary (built by build/build-apple-helper.sh).
// Resolve for both `npm start` (repo layout) and the packaged app (where it's
// shipped as an extraResource). Kept dependency-free so ai.js stays testable in
// plain Node — we don't require('electron') here.
function appleHelperPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'bin', 'apple-intelligence'),       // dev / repo
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'apple-intelligence'), // packaged
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return candidates[0];
}

/* ----------------------------- small HTTP client ---------------------------- */
function ollamaRequest(reqPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: OLLAMA_HOST, port: OLLAMA_PORT, path: reqPath,
      method: body ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ollama timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------- detection -------------------------------- */
/** List local Ollama models (empty array if Ollama isn't running). */
async function ollamaModels() {
  try {
    const r = await ollamaRequest('/api/tags', null, 1500);
    return Array.isArray(r && r.models) ? r.models.map((m) => m.name).filter(Boolean) : [];
  } catch { return []; }
}

/** Choose the best installed local model by our preference order. */
function pickOllamaModel(models) {
  for (const pref of PREFERRED_OLLAMA) {
    const hit = models.find((m) => m.toLowerCase().startsWith(pref));
    if (hit) return hit;
  }
  return models[0] || null;
}

/** Does this Mac look capable of on-device Apple Intelligence, AND is the helper built? */
function appleIntelligenceAvailable() {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
    return fs.existsSync(appleHelperPath());
  } catch { return false; }
}

/**
 * Report what engines are usable right now (for the UI). Cheap, best-effort.
 * @returns {Promise<{ollama:{available:boolean,model:string|null,models:string[]}, apple:boolean, builtin:true}>}
 */
async function detectEngines() {
  const models = await ollamaModels();
  return {
    ollama: { available: models.length > 0, model: pickOllamaModel(models), models },
    apple: appleIntelligenceAvailable(),
    builtin: true,
  };
}

/* ------------------------------ the prompt -------------------------------- */
function rosterSystemPrompt(mains) {
  const mainNames = (mains || []).map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
  return [
    'You convert a clinic\'s free-text staff/treatment list into structured JSON.',
    'Each line describes a treating (subordinate) doctor, optionally which MAIN doctor they work under, and the billing/treatment codes they use.',
    'Codes look like 5 digits (e.g. 97112) or a letter+4 digits. They may carry units and 2-digit modifiers (e.g. 59).',
    mainNames.length ? `The known MAIN doctors are: ${mainNames.join('; ')}. Map any "under X" / "with X" / "reports to X" reference to the closest one of these EXACT names; if none fits, leave mainDoctor "".` : 'If a main/supervising doctor is named, copy their name into mainDoctor; else "".',
    'Return ONLY JSON of this exact shape, nothing else:',
    '{"providers":[{"name":"<doctor name>","mainDoctor":"<one of the known mains or \\"\\">","codes":"<normalized code list>"}],"unparsed":["<any line you could not interpret>"]}',
    'For "codes": list each code as `NUMBER xUNITS (MODIFIERS)`, e.g. `97112 x2, 97530 x2 (59)`. Express units as a DIGIT after x: "twice"/"two units"→x2, "once"/"one unit"→x1, "three"→x3. Omit "(MODIFIERS)" if none. Default to x1 only when no count is stated.',
    'Do NOT invent or change the code NUMBERS — keep them exactly. Ignore discipline words (OT/PT/speech/SLP) when reading the name. One object per treating doctor.',
  ].join('\n');
}

/**
 * Snap a free-text fragment (e.g. "Caryn doing", "with dr reed") to one of the
 * known main doctors. First tries containment; then a distinctive shared token
 * (so prose like "under Caryn doing 97112" still resolves to "Caryn McAllister")
 * — but only when exactly one main matches, never a guess. Used by both the
 * built-in parser and the model-output normalizer.
 */
function snapToMain(frag, mainNorms) {
  const n = normalizeName(frag);
  if (!n) return '';
  const direct = mainNorms.find((m) => m.norm && (n === m.norm || n.includes(m.norm) || m.norm.includes(n)));
  if (direct) return direct.raw;
  const fragTokens = n.split(' ').filter((t) => t.length >= 3);
  const byToken = mainNorms.filter((m) => m.norm && m.norm.split(' ').some((mt) => mt.length >= 3 && fragTokens.includes(mt)));
  if (byToken.length === 1) return byToken[0].raw;
  return String(frag || '').trim();
}

/** Pull the JSON object out of a model reply that may have stray text around it. */
function extractJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf('{'); const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return null;
}

/**
 * Normalize whatever a model returned into the same shape the deterministic
 * parser produces, re-validating every code through parseCodes (so the model
 * can never smuggle in malformed codes) and snapping mainDoctor to a known name.
 */
function normalizeModelRoster(obj, mains) {
  const mainNorms = (mains || []).map((m) => {
    const raw = typeof m === 'string' ? m : m.name;
    return { raw, norm: normalizeName(raw) };
  });
  const snapMain = (val) => snapToMain(val, mainNorms);
  const providers = [];
  const unparsed = Array.isArray(obj && obj.unparsed) ? obj.unparsed.map(String) : [];
  for (const p of (obj && Array.isArray(obj.providers) ? obj.providers : [])) {
    const name = String((p && p.name) || '').trim();
    const codes = parseCodes((p && p.codes) || []);
    const mainDoctor = snapMain(p && p.mainDoctor);
    if (name && (mainDoctor || codes.length)) providers.push(makeProvider({ name, mainDoctor, codes }));
    else if (name) unparsed.push(name);
  }
  return { providers, unparsed };
}

/* ----------------------------- engine calls ------------------------------- */
async function runOllama(text, mains, model) {
  const body = {
    model,
    stream: false,
    format: 'json',
    think: false, // skip hidden chain-of-thought — this is a structured extraction, not reasoning; keeps it fast
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: rosterSystemPrompt(mains) },
      { role: 'user', content: String(text || '') },
    ],
  };
  const r = await ollamaRequest('/api/chat', body, 60000);
  const content = r && r.message && r.message.content;
  const obj = extractJson(content);
  if (!obj) throw new Error('model did not return JSON');
  return normalizeModelRoster(obj, mains);
}

function runApple(text, mains) {
  return new Promise((resolve, reject) => {
    const child = execFile(appleHelperPath(), ['--task', 'roster'], { timeout: 60000 }, (err, stdout) => {
      if (err) return reject(err);
      const obj = extractJson(String(stdout || ''));
      if (!obj) return reject(new Error('helper did not return JSON'));
      resolve(normalizeModelRoster(obj, mains));
    });
    // Feed the prompt + text on stdin so we never hit argv length limits.
    try { child.stdin.write(JSON.stringify({ system: rosterSystemPrompt(mains), text: String(text || '') })); child.stdin.end(); }
    catch (e) { reject(e); }
  });
}

/* ------------------------------- deterministic ----------------------------- */
/**
 * Deterministic roster parser — the dependable workhorse and the safety net
 * behind every model. Accepts lines in many shapes, e.g.:
 *   "Dr. Alan Patel - Reed - 97110, 97530"
 *   "Sara Nguyen | Dr. Reed | 97161"
 *   "Marcus Cohen under Okafor: 97165 97535"
 * Returns { providers, unparsed, mainCodeHints }.
 */
function parseRosterText(text, mains = []) {
  const providers = [];
  const unparsed = [];
  const mainCodeHints = {};
  const mainNorms = mains.map((m) => ({ raw: typeof m === 'string' ? m : m.name, norm: normalizeName(typeof m === 'string' ? m : m.name) }));
  const firstCodeRe = /\b(\d{5}|[A-Z]\d{4})\b/;

  const canonicalMain = (frag) => snapToMain(frag, mainNorms);

  let currentMain = '';

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cm = firstCodeRe.exec(line);
    const codeExpr = cm ? line.slice(cm.index) : '';
    let prefix = cm ? line.slice(0, cm.index) : line;
    const codes = codeExpr ? parseCodes(codeExpr) : [];

    const twoLetter = (/\b(GP|GO|GN)\b/i.exec(prefix) || [])[1];
    if (twoLetter) prefix = prefix.replace(/\b(GP|GO|GN)\b/i, ' ');
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

/* ------------------------------- dispatch --------------------------------- */
/**
 * Parse roster text using the chosen (or smartest available) engine. ALWAYS
 * returns a result; any model failure transparently falls back to the next
 * engine and finally to the deterministic parser. Adds mainCodeHints (from the
 * deterministic pass) so the UI can still auto-fill GP/GO/GN codes.
 */
async function parseRoster({ text, mains = [], provider = 'auto' }) {
  const deterministic = () => ({ ...parseRosterText(text, mains), engine: 'built-in' });
  // Always compute the deterministic pass — it's the fallback AND the source of
  // the GP/GO/GN main-code hints we fold in regardless of which engine ran.
  const base = parseRosterText(text, mains);
  const withHints = (res, engine) => ({
    providers: res.providers,
    unparsed: res.unparsed || [],
    mainCodeHints: base.mainCodeHints,
    engine,
  });

  const engines = await detectEngines();

  // Resolve the order of engines to try.
  let order;
  if (provider === 'ollama') order = ['ollama', 'builtin'];
  else if (provider === 'apple') order = ['apple', 'builtin'];
  else if (provider === 'none') order = ['builtin'];
  else order = ['ollama', 'apple', 'builtin']; // 'auto' — smartest first

  for (const eng of order) {
    try {
      if (eng === 'ollama' && engines.ollama.available) {
        const res = await runOllama(text, mains, engines.ollama.model);
        if (res.providers.length) return withHints(res, `local model (${engines.ollama.model})`);
      } else if (eng === 'apple' && engines.apple) {
        const res = await runApple(text, mains);
        if (res.providers.length) return withHints(res, 'Apple Intelligence (on-device)');
      } else if (eng === 'builtin') {
        return withHints(base, 'built-in');
      }
    } catch { /* try the next engine */ }
  }
  return deterministic();
}

module.exports = {
  parseRoster, parseRosterText, appleIntelligenceAvailable,
  detectEngines, normalizeModelRoster, rosterSystemPrompt, appleHelperPath,
};
