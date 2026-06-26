'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, shell } = require('electron');

/**
 * Manual update check against GitHub Releases — works WITHOUT code signing.
 *
 * We don't silently swap the app bundle (that path needs Apple signing). Instead
 * we ask GitHub for the latest release, compare versions, and if there's a newer
 * one we hand the user the new installer (.dmg) to drop in. One click → download
 * → install. Exactly how an unsigned app ships updates.
 */

const REPO = 'hatimhtm/practicesync'; // owner/repo holding the public releases

function getLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'Hope Assistant', Accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

/** Compare dotted versions: 1 if a>b, -1 if a<b, 0 if equal. */
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

let downloadUrl = null; // the .dmg (or release page) for the newest version

async function check({ onStatus, quiet } = {}) {
  // On the launch check (quiet) we only speak up if there's actually an update —
  // no "checking…" or "couldn't check" noise. The manual button reports all.
  const say = (s) => { if (quiet && s.phase !== 'available') return; try { onStatus && onStatus(s); } catch {} };
  say({ phase: 'checking' });
  try {
    const rel = await getLatestRelease();
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    if (latest && cmpVer(latest, current) > 0) {
      const dmg = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name || ''));
      downloadUrl = (dmg && dmg.browser_download_url) || rel.html_url || null;
      say({ phase: 'available', version: latest.replace(/^v/i, '') });
    } else {
      say({ phase: 'none', version: current });
    }
  } catch (e) {
    // No releases yet, offline, etc. — stay quiet, just report it.
    say({ phase: 'error', error: String((e && e.message) || e) });
  }
}

/** Download a URL to a file, following GitHub's redirect to S3, reporting %. */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const fail = (e) => { try { fs.unlink(dest, () => {}); } catch {} reject(e); }; // never leave a truncated .dmg
    const get = (u, redirects) => {
      https.get(u, { headers: { 'User-Agent': 'Hope Assistant' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
          res.resume(); return get(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (c) => { done += c.length; if (total && onProgress) onProgress(Math.round((done / total) * 100)); });
        res.on('error', fail);
        file.on('error', fail);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    };
    get(url, 0);
  });
}

/**
 * The "Update now" action: download the new .dmg in-app (with progress), then
 * open it so the user just drags Hope Assistant onto Applications. Falls back to a
 * plain browser download if anything goes wrong. Unsigned apps can't silently
 * self-replace on macOS, so this is the cleanest one-button update there is.
 */
async function downloadAndOpen({ onStatus } = {}) {
  const say = (s) => { try { onStatus && onStatus(s); } catch {} };
  if (!downloadUrl) { say({ phase: 'error', error: 'Nothing to download yet — check for updates first.' }); return; }
  // Not a direct .dmg (e.g. a release page) → just open it in the browser.
  if (!/\.dmg(\?|$)/i.test(downloadUrl)) { try { shell.openExternal(downloadUrl); } catch {} say({ phase: 'opening' }); return; }
  const dest = path.join(os.tmpdir(), 'Hope Assistant-Update.dmg');
  try {
    say({ phase: 'downloading', percent: 0 });
    await download(downloadUrl, dest, (p) => say({ phase: 'downloading', percent: p }));
    say({ phase: 'opening' });
    try { await shell.openPath(dest); } catch { shell.openExternal(downloadUrl); }
  } catch (e) {
    try { shell.openExternal(downloadUrl); } catch {} // browser fallback
    say({ phase: 'opening' });
  }
}

/** Quiet check on launch — only surfaces if there's something newer. */
function initAutoUpdates({ onStatus } = {}) {
  check({ onStatus, quiet: true }).catch(() => {});
}

module.exports = { check, downloadAndOpen, initAutoUpdates };
