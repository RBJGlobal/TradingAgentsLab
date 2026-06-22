# TradingAgentsLab — Distribution & Auto-Update Plan (Phase 7c)

> **Status:** DRAFT for founder review (2026-06-20). Implementation starts after review, in a few days. Nothing here is built yet.
>
> **Goal:** Ship **Trading Agents Lab** as a signed, notarized macOS `.dmg` that users download for free and that **updates itself automatically over the air** when we publish a new version, gated by a **first-launch consent agreement**. Preserve every locked posture: free, no license, zero data collection, analysis-only, educational.

---

## 0. Prerequisites & current state

- ✅ Apple Developer Program (RBJ Global) certified (2026-06-20) → we can get a **Developer ID Application** certificate for distribution outside the Mac App Store.
- ✅ App is feature-complete + stable (v0.1.0, post stability sweep on `main`).
- ⚠️ **Packaging is greenfield.** No `electron-builder` / `electron-updater` config exists yet; `desktop/package.json` `build` is just the Vite build.
- ⚠️ **The #1 blocker (see §1):** in dev, the engine is spawned from `engine/.venv/bin/python` (`engine-runner.ts:102-106`). That venv does **not** exist in a packaged app. The Python engine must be frozen into a self-contained binary and bundled.

---

## 1. THE hard part: bundling the Python engine (do this first)

Electron ships fine on its own, but our engine is a Python FastAPI sidecar. A user's Mac has no `engine/.venv`. We must ship a self-contained engine.

- **Approach (recommended): PyInstaller in `onedir` mode** (NOT `onefile`) freezes `engine/` + deps (FastAPI, uvicorn, httpx, yfinance, pandas, etc.) into a folder of Mach-O binaries + dylibs. `engine-runner.ts` then spawns that bundled binary (under `process.resourcesPath`) instead of the venv python, gated on `app.isPackaged`.
  - **Why onedir, not onefile:** onefile re-extracts to a temp dir on *every launch* (hurts our cold-start/handshake budget) and is the harder case for notarization (code running from a re-extracted temp location under hardened runtime). onedir drops cleanly into `extraResources` and every Mach-O signs in electron-builder's normal pass.
  - Alternative: Nuitka (faster binaries, more finicky) or shipping a relocatable CPython. PyInstaller is the well-trodden path for Electron+Python.
- **Risks to spike before committing:** pandas/yfinance pull large native deps (numpy) — PyInstaller hidden-imports + binary size; cold-start time of a frozen binary; the bundled engine must be **code-signed and notarized inside the app bundle** (every Mach-O in the bundle must be signed).
- **`engine-runner.ts` change:** branch on `app.isPackaged` → packaged uses the bundled engine path; dev keeps the venv. Keep the handshake/kill logic unchanged.
- **Bundle size note:** Electron (~150MB) + frozen Python/pandas (~150-300MB) → expect a **300-500MB** DMG. Acceptable for a desktop research tool; worth noting.

> **Recommendation:** Phase 7c.1 is a PyInstaller spike that proves a frozen engine runs end-to-end (handshake + a real debate) on a clean Mac. Everything else depends on it.

---

## 2. Build & packaging (electron-builder)

- Add `electron-builder` + an `electron-builder.yml` (appId e.g. `ai.tradingagentslab.desktop`, productName "Trading Agents Lab").
- **Targets:** `dmg` (user download) **and** `zip` (electron-updater needs the zip on macOS).
- **Arch:** `universal` (arm64 + x64). [LOCKED]
- **Category:** `public.app-category.education` (NOT finance — matches positioning).
- **DMG cosmetics:** background image, icon layout, drag-to-Applications symlink, volume name.
- Bundle the frozen engine (from §1) into `extraResources`.
- **Min macOS version:** `macOS 12.0` (Monterey). [LOCKED]

---

## 3. Code signing & notarization

- **Developer ID Application** cert (from the RBJ Global Apple Developer account).
- **Hardened Runtime** + an entitlements plist. The Electron + spawned Python subprocess likely need: `com.apple.security.cs.allow-jit`, `...allow-unsigned-executable-memory` (Python/V8), `...inherit` for the child, and network client. Tune during the spike.
- **Notarization** via `notarytool`, then **staple** the ticket (so first launch is clean offline). electron-builder runs this in `afterSign`.
- **Everything in the bundle must be signed** — including the frozen engine binary and its embedded dylibs. This is the most common notarization failure point.

---

## 4. Auto-update over the air (electron-updater + GitHub Releases)

- **Feed:** GitHub Releases. electron-builder publishes `dmg` + `zip` + `latest-mac.yml` + blockmaps; `electron-updater` reads `latest-mac.yml`.
- **Flow:** on launch (and a periodic check), download in the background, prompt the user, install on quit ("Restart to update"). Surface release notes in-app ("What's new in vX.Y.Z").
- **Updating the engine for free:** because the frozen engine is bundled inside the app, a normal app update replaces the engine too — **no separate engine update channel needed**. 
- **Security:** electron-updater verifies the package signature against our Developer ID cert; the feed is HTTPS (GitHub). A tampered update fails the signature check.
- **The update check is a NEW outbound network call** (to GitHub). This touches the zero-data posture:
  - **Add a Settings toggle "Automatically check for updates" (default ON).** Answers your "should we add the option for updates" — yes.
  - **Disclose it in the Privacy Policy** as the one app-initiated outbound call besides user-configured providers (alongside the existing OpenRouter courtesy-header disclosure).
  - No identifiers sent; it's an anonymous GET of a public release manifest.

---

## 5. First-launch consent agreement

- **Modal on first launch** (and again if the agreement *version* changes), blocking the app until accepted. Content, in our locked voice (no em/en dashes):
  - This is an **educational research tool**, **not financial advice**; multi-agent LLM analysis can be wrong; you make your own decisions.
  - **Personal / educational use.** Free, open-source (AGPL-3.0), no warranty.
  - **Zero data collection.** The only app-initiated outbound calls are (a) the optional update check and (b) the LLM/data providers *you* configure with *your* keys.
  - **"I Agree"** required to proceed; **Decline → quit.**
- **Persist** `{ accepted: true, agreementVersion, timestamp }` to `userData` (same store family as `secrets.json` / `window-state.json`). Re-prompt only when `agreementVersion` increments.
- Reuses the locked three-tier disclaimer language (memory `project_disclaimer_language.md`) — this is the "tier 0" gate.
- Links to the live ToS / Privacy / Disclaimer pages on the site.

---

## 6. Release workflow / CI (GitHub Actions)

- **Tag-driven:** push `vX.Y.Z` → GitHub Action on a **macOS runner** → install deps, PyInstaller-freeze the engine, `electron-builder --publish always` → builds, signs, notarizes, uploads to the GitHub Release.
- **Secrets in Actions:** base64 Developer ID `.p12` + password, `APPLE_ID`, app-specific password (or App Store Connect API key), `APPLE_TEAM_ID`. GitHub token for publishing.
- **Version single-source-of-truth:** finally do the deferred refactor — source the displayed version (App.tsx footer, Settings About, preload.ts) from `package.json`, so a release is a one-line bump. (Carried since PR #12.)
- **Changelog** per release → drives both the GitHub Release notes and the in-app "What's new".

---

## 7. Professional polish / support surface

- **GitHub Issues** enabled + **issue templates** (bug report, feature request) + **`SECURITY.md`** (private vuln reporting). `CONTRIBUTING.md` already exists.
- In-app **Help → Report an Issue** (the Help menu already links to the repo/issues) and **Help → Check for Updates** (manual trigger).
- Consider **GitHub Discussions** for Q&A.
- **About / Settings:** show version, "source on GitHub" (AGPL source-availability good practice), and the legal links.

---

## What you might be missing (my additions)

1. **Engine freeze is the real project** (§1) — not the DMG cosmetics. Derisk it first.
2. **Crash reporting: intentionally NONE.** Pro apps usually add Sentry/crash dumps; that would violate the zero-telemetry posture. Calling it out so the omission is a *decision*, not an oversight.
3. **Windows is a separate effort** — different signing (an EV/OV cert, additional cost), different installer (NSIS), same electron-updater pattern. Recommend **macOS first, Windows later**.
4. **Rollback plan:** if a bad version ships, yank the GitHub Release / publish a fixed patch version fast (electron-updater only moves users forward, so a quick `vX.Y.Z+1` is the fix).
5. **Privacy Policy update is mandatory** before the first OTA release (the update-check disclosure, §4).
6. **Universal vs arm64-only**, **min macOS version**, **DMG size expectations** — see decisions.
7. **Notarization of the embedded Python binary** is the most likely failure point — bake it into the spike.

---

## Recommended phasing

| Phase | What | Gates it before |
|---|---|---|
| 7c.1 | **PyInstaller engine-freeze spike** — frozen engine runs a real debate on a clean Mac | everything |
| 7c.2 | electron-builder config → signed + notarized DMG (manual local build) | distribution |
| 7c.3 | First-launch consent gate + persistence | any public download |
| 7c.4 | electron-updater + GitHub Releases + Settings toggle + Privacy disclosure | OTA |
| 7c.5 | GitHub Actions tag-driven release (build/sign/notarize/publish) + version SSOT | repeatable releases |
| 7c.6 | Issue templates + SECURITY.md + in-app "What's new" / "Check for updates" polish | launch |

---

## Phase 7c.1 — Engine-freeze spike: runbook

> Goal: prove a PyInstaller `onedir` build of the engine runs a real debate, signed-and-notarizable, before investing in DMG/updater/CI. Self-contained; reversible (branch `phase-7c-distribution`). Success or a documented blocker either way.

**Steps**
1. `engine/.venv/bin/pip install pyinstaller` (dev-only; not added to `requirements.txt`).
2. Author `engine/engine.spec` — `onedir`, entry `engine/__main__.py`, name `tal-engine`. Collect hidden imports / data for the known-fussy deps: `uvicorn` (its lifecycle/protocol submodules), `pandas`/`numpy`, `yfinance`, `httpx`, `fastapi`. Use `--collect-submodules` / `collect_all` as needed.
3. Build: `engine/.venv/bin/pyinstaller engine/engine.spec --clean` → `dist/tal-engine/tal-engine`.
4. **Smoke the frozen binary directly** (no Electron): run `dist/tal-engine/tal-engine`, confirm it emits the first-line `{"port":...,"token":"..."}` handshake, then hit `/health` (bearer) and run one stub WS debate against it. This is the pass/fail gate.
5. Wire `engine-runner.ts` to branch on `app.isPackaged`: packaged → spawn the bundled `tal-engine` under `process.resourcesPath`; dev → keep the `.venv` python path unchanged. (Guard behind the spike; don't regress dev.)
6. Note: cold-start time of the frozen binary, the `dist/tal-engine` folder size, and any hidden-import fixes needed (these feed §1/§3).

**Success criteria**
- Frozen `tal-engine` emits a valid handshake and serves a full stub debate end-to-end, launched standalone on this Mac, with no `engine/.venv` on the PATH.
- `engine-runner.ts` dev path still works (existing `dev-smoke` + app launch unaffected).

**If blocked** (e.g. a dep won't freeze cleanly): document the exact failure in the spike notes and we evaluate Nuitka / relocatable-CPython alternatives before proceeding to 7c.2.

**Deliverable:** `engine/engine.spec` + a short `docs/engine-freeze-spike-notes.md` (what worked, size, cold-start, hidden-imports, verdict). No DMG/signing yet — that's 7c.2+.

---

## Phase 7c.2 — results (2026-06-21)

> Status: **packaging pipeline proven end-to-end on arm64.** A signed, hardened-runtime `.app` packages the frozen engine and spawns it on launch. Remaining gaps are credential- and arch-gated, not unknowns.

**Built:** `desktop/electron-builder.yml`, `desktop/build/entitlements.mac.plist`, `tools/build-engine.sh`, npm scripts (`build:engine`, `dist:dir`, `dist:mac`), and `engine-runner.ts` now spawns `Resources/engine/tal-engine` when `app.isPackaged` (dev path unchanged).

**Verified (`npm run dist:dir`, arm64):**
- electron-builder bundles the frozen engine into `Contents/Resources/engine/` (431 MB .app).
- The build **auto-signed with the founder's Developer ID** (cert is in this machine's keychain), with **hardened runtime** on. `codesign --verify --deep --strict` **passes** — electron-builder 26's pass deep-signed the bundled engine binary + dylibs too, so the classic extraResources-not-signed notarization trap did **not** bite here (still verify under real notarization).
- The signed packaged app **launches and spawns the bundled engine** (`pgrep` confirms `Resources/engine/tal-engine` running under the hardened-runtime app). The hardened-runtime entitlements (`allow-jit`, `disable-library-validation`, etc.) are sufficient for the frozen CPython to run.

**Bug found + fixed:** the dev-only `app.dock.setIcon()` ran in the packaged app too and threw on a missing in-asar icon path, breaking the `whenReady` chain before `startEngine()`. Now gated to `!app.isPackaged`, and `build/icon.png/.icns` added to the electron-builder `files`.

**Still gated (not unknowns):**
- **Notarization** — needs Apple ID app-specific password / API key (founder). The signature + deep-sign already validate locally, so this should be mechanical.
- **Universal x64 slice** — still needs an x64 engine build (CI), per 7c.1 notes. This local proof is arm64.
- **DMG cosmetics** (7c) + **electron-updater wiring** (7c.4) + **CI release** (7c.5) remain.

> Note: passing `CSC_IDENTITY_AUTODISCOVERY=false` did NOT prevent signing on electron-builder 26 (it signed anyway). For an intentionally-unsigned build, set `mac.identity: null` in config. Not a problem here — signed is what we want.

---

## Phase 7c.3 + 7c.4 — results (2026-06-21)

**7c.3 first-launch consent gate — done.** Blocking gate (`ConsentGate` wraps `<App/>` in `main.tsx`); App's startup effects don't run behind it. Versioned local persistence (`electron/consent.ts` -> `consent.json`), re-prompts on `CONSENT_VERSION` bump, no account/signup. Decline -> `app.quit()`. Locked disclaimer copy + links to live legal pages. Tested: 4 persistence unit tests + 5 RTL component tests (block / reveal / Agree / Decline / fail-safe).

**7c.4 auto-update — done (wiring; OTA flow gated on first release).**
- `electron-updater` (GitHub Releases feed from `publish:` config). `electron/updater.ts` wires events -> renderer, packaged-only, respects the user pref. Bundles cleanly into `main.js` (no externalization needed).
- `electron/prefs.ts`: `autoUpdate` toggle (default on), `preferences.json`. Tested (5 unit tests).
- Settings -> About -> `UpdatesSection`: toggle + "Check for updates" + live status. Tested (4 RTL tests).
- **Privacy disclosed** in `docs/kb/security-and-storage.md` (anonymous GET of the public release manifest, no user data, toggleable). The first-launch gate already mentions it. (Site Privacy Policy update is GSD's domain.)
- Verified: packaged app launches + engine spawns with the updater wired; a missing feed (`app-update.yml`, only generated in the full dmg build) is handled gracefully, no crash.
- **Not yet validated (needs 7c.5):** the real download/install flow, which requires a published release to update from/to.

**7c remaining:** notarization (Apple ID app-specific password), CI release + universal x64 (7c.5), dmg cosmetics. The first shippable, auto-updating DMG comes out of CI with the cert + Apple ID creds.

## Phase 7c.5 — CI release pipeline (written 2026-06-22; awaiting credentials)

- **`.github/workflows/release.yml`** — tag-driven (`v*`). Matrix: macos-14 (arm64) + macos-13 (Intel), `max-parallel: 1`. Each job sets up the engine venv, freezes the engine for its host arch, builds, then `electron-builder --mac --publish always` (signs with the Developer ID via `CSC_LINK`, notarizes via `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, publishes to a GitHub Release). `electron-builder.yml` arch lock removed -> each runner builds its native slice (two native DMGs, not universal2+lipo).
- **`docs/release-setup.md`** — the founder's one-time secret setup (5 GitHub secrets: cert p12 base64 + password, Apple ID, app-specific password, team id). ~10-15 min.
- **Status: VALIDATED end-to-end on arm64 (2026-06-22).** First run (`v0.1.0-rc.1`, arm64-only) went green in 6m27s: engine freeze -> build -> **sign (new RBJ Global Developer ID) -> notarize (Apple accepted) -> publish**. Produced a **draft** GitHub Release with a signed + notarized `Trading-Agents-Lab-0.1.0-arm64.dmg` + `-mac.zip` + `latest-mac.yml` + blockmap. The `postinstall` Info.plist patch ran fine under CI.
- **Gotcha found:** the git tag must match `package.json` version. We tagged `v0.1.0-rc.1` while the version was `0.1.0`, so electron-builder created its own `v0.1.0` draft (and a duplicate stray one, deleted). For the GA, bump `package.json` and tag the matching `vX.Y.Z`.
- **Remaining:** re-add Intel (macos-13) -> validate the dual-arch `latest-mac.yml` feed; founder test-install of the draft DMG; merge `phase-7c-distribution` to main; cut the real v0.1.0 (matching tag); dmg cosmetics.

---

## Locked decisions (founder, 2026-06-20)

1. **Architecture:** ~~universal (arm64 + x64)~~ -> **arm64-only for v1; Intel deferred** (founder, 2026-06-22). Apple Silicon has been mainstream since late 2020; the Intel audience is small + aging, and it's open-source for the rare Intel user to build from source. NOTE: arm64-only will not run on Intel at all (no Rosetta the other way). Re-add `macos-13` to the release matrix when Intel is prioritized.
2. **Auto-update:** **default-ON**, with a Settings toggle to disable. Disclose the update check in the Privacy Policy.
3. **Minimum macOS version:** **macOS 12 (Monterey).**
4. **Engine freeze:** **PyInstaller spike approved as Phase 7c.1** (the long pole — derisk first).
5. **Consent gate on decline:** **quit the app.**
