'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Ad-hoc sign the packaged app. We have no paid Apple Developer ID, so
 * electron-builder skips real signing (identity: null) — but an app shipped with
 * NO valid seal reads as "damaged and can't be opened" once macOS quarantines
 * the download (Apple Silicon is strict about this). A valid ad-hoc signature
 * fixes the seal, so a downloaded copy shows the ordinary "unidentified
 * developer" prompt instead — which the user clears with right-click → Open.
 *
 * Runs after the .app is fully assembled (Electron + our extra resources) and
 * before the DMG is built, so the DMG contains the signed app.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
    console.log('  • ad-hoc signed ' + appPath);
  } catch (e) {
    console.warn('  ! ad-hoc signing failed (app may show as "damaged" on download): ' + ((e && e.message) || e));
  }
};
