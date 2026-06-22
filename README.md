# PracticeSync

A macOS app that reads each patient visit from **Practice Fusion** (patient name,
date, diagnosing doctor) and books the matching coded appointment in
**SimplePractice** under the correct main doctor — automatically.

It opens its **own** Chrome window (a dedicated profile), so your everyday Chrome
can stay open — no quitting, no new passwords stored. You sign into each site
once in that window and it stays signed in. You teach it each screen once (a red
highlight follows your cursor), then it works by **patient name** — no URLs to
paste — and you **watch it work**: a visible cursor glides to each field, types,
and clicks.

## Watch it work

During a run, PracticeSync injects a visible cursor + status HUD into the
controlled Chrome window (`src/main/liveEngine.js` → the "stage"): the pointer
moves to each field, types character by character, and clicks with a ripple, so
the user and their bosses can see exactly what's happening. The app window
mirrors every step as a live log.

## The AI engine (reads your typed doctor list)

The only place AI is used is turning the free text you type about your doctors
into a clean roster. It auto-selects the best engine available on the Mac and
falls back gracefully, so it can never break:

1. **Local Gemma 4** — Google's on-device model via [Ollama](https://ollama.com)
   (`gemma4:e4b`) on `localhost:11434`. Fully offline, no key.
2. **Apple Intelligence** — Apple's on-device Foundation Models (Apple Silicon +
   macOS 26), via a small bundled Swift helper (`build/apple-intelligence.swift`).
3. **Built-in matcher** — a deterministic parser. Always available, fully offline.

`auto` (the default) picks the smartest available; the others can be forced in
**AI Engine**. Whatever runs, it runs **on this Mac** — your doctor list never
leaves the device. Every model's output is re-validated by the deterministic
layer, so the AI can never invent a billing code.

## Develop

```bash
npm install
npm start          # run the app
npm test           # extract + parser unit tests + a real-engine end-to-end test
npm run demo       # the recordable demo (a Chrome window opens; watch the cursor)
```

### The demo (record this)

When you can't reach the real Practice Fusion / SimplePractice, `npm run demo`
runs the **exact same engine** against two bundled mock sites
(`demo/source.html` → `demo/dest.html`): it searches a patient, reads their
visits, maps each to a main doctor + codes, and books every coded appointment —
end to end, no logins, no internet. `HEADLESS=1 npm run demo` runs it as a test.

## Build a local installer

```bash
npm run dist       # builds the Apple Intelligence helper, then dist/PracticeSync-Installer.dmg
npm run make-icon  # regenerate the app + tray icons (build/make-icon.js)
```

The build is **unsigned**: it installs fine (right-click → **Open** the first
time) but won't auto-update, and macOS may re-show the **App Management** prompt —
click **Don't Allow**, it doesn't block anything. The app clears the macOS
quarantine flag from its Apple Intelligence helper on first launch so it runs on
the client's Mac without a manual step.

## Releases & updates (works unsigned)

Pushing a version tag triggers `.github/workflows/release.yml`, which builds the
universal app (and the Apple Intelligence helper) and publishes the `.dmg` to
GitHub Releases:

```bash
npm version patch && git push --follow-tags
```

The app checks GitHub on launch and via the sidebar **Check for updates** button.
When a newer release exists it shows a banner; one click downloads the new `.dmg`
and opens it. No code signing needed — `src/main/updater.js` compares versions
and hands over the installer rather than silently swapping the bundle.

## Project layout
- `src/main/main.js` — window, menu-bar tray, IPC, the sync run, auto-update wiring
- `src/main/automation.js` — engine: read visits → plan appointments → create them
- `src/main/liveEngine.js` — Playwright automation of a dedicated Chrome profile (teach, search by name, book) + the visible "stage"
- `src/main/extract.js` — pure DOM logic (selector building, visit extraction, form planning); unit-tested
- `src/main/model.js` — main doctors, the doctor→{mainDoctor, codes[]} roster, fuzzy name matching
- `src/main/ai.js` — engine abstraction (Smart / Apple Intelligence / local Gemma / built-in) + roster text parser
- `src/main/store.js` — settings (atomic writes)
- `src/main/updater.js` — GitHub-release auto-update (works unsigned)
- `src/main/scheduler.js` — interval scheduler
- `src/renderer/` — UI (index.html / styles.css / app.js)
- `demo/` — bundled mock sites + the recordable end-to-end demo
- `build/` — icon generator, the Apple Intelligence Swift helper, the UI screenshot harness
