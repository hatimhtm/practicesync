# PracticeSync

A macOS app that reads each patient visit from **Practice Fusion** (patient name,
date, diagnosing doctor) and books the matching coded appointment in
**SimplePractice** under the correct main doctor — automatically. It rides the
Chrome session you're already logged into: no new login, no stored passwords, and
no patient data ever leaves the Mac.

You teach it each screen once (a red highlight follows your cursor so you can see
exactly what to click), then it works by **patient name** — no URLs to paste.

**Watch it work.** During a run, PracticeSync injects a visible cursor + status HUD
into Chrome (`src/main/liveEngine.js` → the "stage"): the pointer glides to each
field, types character by character, and clicks with a ripple, so the user and
their bosses can see exactly what's happening. The app window mirrors every step
as a live log. It needs **no macOS permissions** to do this (launching + CDP-driving
Chrome touches nothing TCC-protected); the cursor is cosmetic and the real,
trusted click/type is always issued by Playwright underneath.

## Develop

```bash
npm install
npm start                                                # run the app
node test/extract.test.js && node test/parser.test.js    # tests
```

## Build a local installer

```bash
npx electron-builder --mac --universal      # → dist/PracticeSync-Installer.dmg
npm run icon                                # regenerate the icon from build/icon-1024.png
```

The build is **unsigned**: it installs fine (right-click → **Open** the first
time) but won't auto-update, and macOS may re-show the **App Management** prompt —
click **Later**, it doesn't block anything.

## Releases & updates (works unsigned)

Pushing a version tag triggers `.github/workflows/release.yml`, which builds the
universal app and publishes the `.dmg` to GitHub Releases:

```bash
npm version patch && git push --follow-tags
```

The app checks GitHub on launch and via **Overview → Check for updates**. When a
newer release exists, it shows **Download the update**, which opens the new `.dmg`
for the user to install (drag to Applications, right-click → Open the first time).
No code signing needed — `src/main/updater.js` compares versions and hands over
the installer rather than silently swapping the bundle.

### Optional: sign + notarize for a smoother install

Signing isn't required for updates, but a **Developer ID Application** certificate
(paid Apple Developer account) removes the right-click-to-open step and stops the
recurring **App Management** permission prompt. Add these as repository secrets
and uncomment them in the workflow:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for notarization |
| `APPLE_TEAM_ID` | your team ID |

## Project layout (`src/main/`)
- `main.js` — window, menu-bar tray, IPC, the sync run, auto-update wiring
- `automation.js` — engine: read visits → plan appointments → create them
- `liveEngine.js` — Playwright automation of your existing Chrome (teach, search by name, book)
- `extract.js` — pure DOM logic (selector building, visit extraction, form planning); unit-tested
- `model.js` — main doctors, the doctor→{mainDoctor, codes[]} roster, fuzzy name matching
- `ai.js` — provider abstraction (Apple Intelligence / built-in / cloud) + roster text parser
- `store.js` — settings (atomic writes); optional cloud-AI key encrypted via Keychain
- `updater.js` — safe GitHub auto-update (no-ops until the app is signed)
- `scheduler.js` — interval scheduler
- `src/renderer/` — UI (index.html / styles.css / app.js)
