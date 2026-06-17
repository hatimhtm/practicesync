'use strict';

const https = require('https');
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
      headers: { 'User-Agent': 'PracticeSync', Accept: 'application/vnd.github+json' },
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

/** Open the new installer in the browser so the user can install it. */
function openDownload() {
  if (downloadUrl) { try { shell.openExternal(downloadUrl); } catch {} }
}

/** Quiet check on launch — only surfaces if there's something newer. */
function initAutoUpdates({ onStatus } = {}) {
  check({ onStatus, quiet: true }).catch(() => {});
}

module.exports = { check, openDownload, initAutoUpdates };
