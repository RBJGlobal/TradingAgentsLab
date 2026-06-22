# RBJ Global — Desktop App Distribution Playbook (macOS)

> **What this is.** A reusable, app-agnostic playbook for taking an Electron desktop app (optionally with a bundled Python sidecar) to a **signed, notarized, auto-updating macOS `.dmg`** that users download for free. Written from the TradingAgentsLab Phase 7c work, but deliberately generalized.
>
> **Who it's for.** (1) The founder, as durable reference. (2) Any future agent doing this for another RBJ Global app — **point the agent at this file** instead of re-deriving the process. Follow it so every app ships the same way; do not reinvent per app.
>
> **How to use it.** Read "The model" first, then work top to bottom. Each step has a goal, the concrete actions, and the gotchas that bit us (the gotchas are the real value). The **Checklist** at the end is the fast path once you know the territory. TAL-specific file references are marked `[TAL]` as worked examples to copy from.

---

## The model: what a distributable Electron app actually is

A shipped macOS app is a signed `.app` bundle, delivered inside a `.dmg`, that:
1. **Packages all its code** (Electron renderer + main + every runtime dependency). If the app shells out to a **separate runtime** (a Python sidecar, a Go binary, etc.), that runtime is NOT on the user's machine — it must be **frozen into a self-contained binary and bundled** inside the app. This is usually the hardest part and the first thing to derisk.
2. Is **code-signed** with an Apple **Developer ID Application** certificate and runs under the **hardened runtime** with an **entitlements** file.
3. Is **notarized** by Apple (an automated malware scan) and has the notarization ticket **stapled** so first launch is clean offline.
4. **Updates itself** over the air (electron-updater reading a release feed), so shipping a new version reaches existing users automatically.

If your app is **pure Electron** (no separate runtime), skip Step 1 — everything else applies unchanged.

---

## Prerequisites (one-time, per org)

- **Apple Developer Program** membership (the org's, e.g. RBJ Global). Required to get a distribution certificate. *(TAL: obtained 2026-06-20.)*
- **Developer ID Application** certificate, installed in the build machine's login keychain. This is the cert for distribution **outside** the Mac App Store. Verify with `security find-identity -v -p codesigning` — you want a line reading `Developer ID Application: <Name> (<TEAMID>)`.
- **Apple ID app-specific password** (appleid.apple.com -> Sign-In and Security -> App-Specific Passwords) **or** an **App Store Connect API key**. Needed for notarization only. Store as a secret, never in the repo.
- **Team ID** (the 10-char code in the cert, e.g. `6KR5F3225N`).

> Gotcha: notarization needs the Apple ID credential; **signing does not**. You can sign + verify locally with just the cert, and defer notarization until you have the password. Don't block local packaging on it.

---

## Step 1 — Freeze the sidecar runtime (skip if pure Electron)

**Goal:** a self-contained executable of your non-Electron runtime that runs with no interpreter/venv on the user's machine.

For a **Python** sidecar, use **PyInstaller**:

- Use **`onedir`, NOT `onefile`.** onefile re-extracts to a temp dir on *every launch* (slows cold start) and is the harder case for notarization (code executing from a re-extracted temp location under hardened runtime). onedir produces a folder of Mach-Os + dylibs that bundle and sign cleanly. `[TAL: engine/engine.spec]`
- If your entry point uses package-relative imports (`from .x import y`), add a tiny **entry shim** that imports the package normally, so PyInstaller's concrete entry script resolves them. `[TAL: engine/freeze_entry.py]`
- Be generous with **hidden imports / data collection** for dynamically-imported deps. Common offenders: `uvicorn` (loads loop/protocol modules by name — use `collect_submodules('uvicorn')` + `websockets`/`httptools`/`uvloop`), and anything with data files. Use `collect_all(pkg)` for the fussy ones. `[TAL: collect_all for uvicorn/fastapi/starlette/yfinance/openai/anthropic + google.genai]`
- Wrap the build in a script so CI and humans run it identically. `[TAL: tools/build-engine.sh]`
- **Smoke the frozen binary standalone** (run it from `/tmp` with no venv on PATH) before wiring it into Electron. Confirm it does its core job. This isolates "does it freeze" from "does Electron spawn it."

> **Arch gotcha (universal builds):** PyInstaller builds for the **host arch only**, and native deps (numpy/pandas) ship arch-specific binaries — there is **no trivial universal2** onedir. A universal app needs the sidecar built on **each** arch (arm64 + x64) and the right slice bundled per target. In practice: build arm64 locally, build x64 in CI (or a Rosetta/x64 toolchain), and let the universal app carry both. Decide early whether "universal" is worth this or whether per-arch DMGs are simpler.

---

## Step 2 — electron-builder configuration

**Goal:** electron-builder produces the `.app` / `.dmg` with the sidecar bundled.

- Add `electron-builder` as a dev dependency. Config in `electron-builder.yml` (auto-discovered). `[TAL: desktop/electron-builder.yml]`
- Key fields: `appId` (reverse-DNS), `productName` (the human name — this drives the packaged app's name; do NOT rely on dev-only Info.plist patch scripts), `directories.output` (e.g. `release`, gitignore it), `mac.category`, `mac.minimumSystemVersion`.
- **Bundle the frozen sidecar via `extraResources`** (`from: ../dist/<sidecar>` -> `to: <name>`). extraResources land in `Contents/Resources/` **outside the asar**, so they're real on-disk executables you can spawn. `[TAL: from ../dist/tal-engine -> engine]`
- **`files`**: include the build outputs (`dist/**`, `dist-electron/**`, `package.json`) **and any runtime asset your code reads by path from inside the app** — e.g. icons referenced at runtime. If you reference `APP_ROOT/build/icon.png`, that file must be in `files` or it won't be in the asar.
- Spawn the bundled runtime conditionally on `app.isPackaged`: packaged -> `process.resourcesPath/<name>/<exe>`; dev -> your local dev path. `[TAL: desktop/electron/engine-runner.ts]`

> Gotcha: the renderer load path differs dev vs packaged (`loadURL(devServer)` vs `loadFile(dist/index.html)`). Confirm the packaged `loadFile` branch exists before you build, or you'll ship a blank window.

---

## Step 3 — Code signing, hardened runtime, entitlements

**Goal:** a signed `.app` that runs under the hardened runtime, including the bundled sidecar.

- In `electron-builder.yml` `mac`: `hardenedRuntime: true`, `entitlements:` + `entitlementsInherit:` pointing at your plist. `[TAL: desktop/build/entitlements.mac.plist]`
- **Entitlements a bundled interpreter/JIT needs** (Electron's V8 and CPython both): `com.apple.security.cs.allow-jit`, `...allow-unsigned-executable-memory`, `...disable-library-validation` (so the app can load the sidecar's own bundled dylibs), `...allow-dyld-environment-variables` (PyInstaller's bootloader sets DYLD vars), plus `network.client` / `network.server` if the sidecar binds a port / makes calls.
- electron-builder auto-signs if a Developer ID cert is in the keychain. Verify the result:
  - `codesign -dv "<App>.app"` — look for `flags=...(runtime)` (hardened runtime on) and the right `TeamIdentifier`.
  - `codesign --verify --deep --strict "<App>.app"` — must exit 0. This is the catch-all that the **whole** bundle, including the sidecar, is validly signed.

> **THE classic notarization trap:** electron-builder's default pass does not *always* deep-sign Mach-Os under `extraResources` — the app gets signed but the sidecar binary/dylibs get missed, and notarization rejects. *(In TAL on electron-builder 26, the deep pass DID cover the engine and `--verify --deep --strict` passed — but verify this per app/version.)* If it misses, add an **`afterSign` hook** that runs `codesign --force --options runtime --deep --sign "<ID>"` over the sidecar dir before notarization.
>
> Gotcha: `CSC_IDENTITY_AUTODISCOVERY=false` did **not** prevent signing on electron-builder 26. For a deliberately unsigned build, set `mac.identity: null` in config.

---

## Step 4 — Notarization + stapling

**Goal:** Apple-blessed app that launches without Gatekeeper warnings.

- Provide credentials to electron-builder via env (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) or an API key. electron-builder runs `notarytool` in its `afterSign` phase and **staples** the ticket automatically when creds are present.
- If you see `skipped macOS notarization — notarize options were unable to be generated`, the credentials aren't set.
- After a notarized build: `xcrun stapler validate "<App>.app"` and `spctl -a -vvv "<App>.app"` should both pass.

> Notarization is an Apple **server** round-trip (minutes). It's the step most likely to surface a missed signature (Step 3 trap). A local `--verify --deep --strict` pass is a strong predictor but not a guarantee.

---

## Step 5 — Auto-update over the air (electron-updater + GitHub Releases)

**Goal:** existing installs update themselves when you publish a new version.

- Add `electron-updater`. Feed = GitHub Releases. electron-builder publishes `dmg` + `zip` (**the zip is required for mac auto-update**) + `latest-mac.yml` + blockmaps; electron-updater reads `latest-mac.yml`. Set `publish: { provider: github, owner, repo }`. `[TAL: in electron-builder.yml]`
- Flow: check on launch (+ periodic) -> download in background -> install on quit ("Restart to update"). Surface release notes in-app.
- **Updating a bundled sidecar is free:** it lives inside the app, so a normal app update replaces it too — no separate channel.
- **Security:** electron-updater verifies the package signature against your Developer ID cert; feed is HTTPS.
- **Privacy/posture:** the update check is a **new outbound call**. For zero-data-collection products, add a **Settings toggle** (default on) and **disclose it in the Privacy Policy**. No identifiers are sent (anonymous GET of a public manifest).

---

## Step 6 — First-launch consent gate (for educational / disclaimer apps)

**Goal:** a blocking agreement on first launch (and whenever the agreement text version bumps).

- Modal that blocks the app until accepted; **"I Agree" to proceed, "Decline" quits.** No accounts, no signup — a **local** consent gate (keeps zero-data posture intact).
- Persist `{ accepted, agreementVersion, timestamp }` to `userData` (same store family as other local state). Re-prompt only when `agreementVersion` increments.
- Content reuses your locked disclaimer language (for an educational/research tool: not financial/professional advice, personal use, the tool can be wrong, what data is and isn't collected). Link to the live ToS / Privacy / Disclaimer pages.

---

## Step 7 — CI release (GitHub Actions, tag-driven)

**Goal:** one `git tag vX.Y.Z` push produces a signed, notarized, published release — reproducibly.

- macOS runner. Steps: install deps -> (freeze sidecar, per arch if universal) -> `electron-builder --publish always`.
- **Secrets in Actions:** base64 Developer ID `.p12` + its password, `APPLE_ID`, app-specific password (or API key), `APPLE_TEAM_ID`, a `GH_TOKEN` for publishing.
- **Version single-source-of-truth:** drive the displayed version from `package.json` so a release is a one-line bump (don't hardcode the version in multiple UI spots).
- CI is also where the **x64 / universal** slice gets built if local is arm64-only.

---

## Step 8 — Issue tracker & support surface

- Enable **GitHub Issues** + issue templates (bug / feature) + a **`SECURITY.md`** (private vuln reporting). In-app **Help -> Report an Issue** and **Help -> Check for Updates**.
- For an open-source (e.g. AGPL) app: surface "source on GitHub" in About; the tagged release satisfies source-availability.

---

## Gotchas log (hard-won — read before you build)

1. **The sidecar freeze is the real project**, not the DMG cosmetics. Derisk it first, standalone.
2. **PyInstaller: onedir, not onefile** (cold start + notarization).
3. **Universal needs per-arch sidecar builds** — PyInstaller is host-arch-only; numpy/pandas are arch-specific. Plan CI for x64.
4. **Deep-signing extraResources** is the classic notarization failure. Always `codesign --verify --deep --strict` and be ready with an `afterSign` deep-sign hook.
5. **Dev-only code running in the packaged app.** Anything gated "for dev" by habit but not by `app.isPackaged` can fire in production. *(TAL: `app.dock.setIcon()` threw on a missing in-asar icon and broke the `whenReady` chain before the engine spawned — a silent, total failure. Gate dev-only calls on `!app.isPackaged`.)*
6. **Runtime asset paths must be in `files`.** If code reads `APP_ROOT/build/icon.png`, it must be bundled into the asar.
7. **`CSC_IDENTITY_AUTODISCOVERY=false` is ignored by electron-builder 26.** Use `mac.identity: null` to force unsigned.
8. **npm script env propagation** can silently drop inline env vars through chained `&&` scripts — verify the env actually reached the tool.
9. **Always smoke the *packaged* app, not just dev.** Launch `"<App>.app/Contents/MacOS/<App>"` from a terminal and read its stderr; `pgrep` for the sidecar to confirm it spawned. Dev passing tells you nothing about the bundle.
10. **An unsigned `--dir` build does NOT exercise the hardened runtime** (entitlements only apply once signed) — so it can't fully validate the sidecar-under-hardened-runtime path. Test a signed build for that.

---

## The fast checklist (once you know the territory)

```
[ ] Prereqs: Developer ID cert in keychain; Apple ID app-specific password available
[ ] (sidecar) PyInstaller onedir spec + entry shim + build script; smoke standalone
[ ] (sidecar) decide universal: arm64 local + x64 in CI, or per-arch DMGs
[ ] electron-builder.yml: appId, productName, category, minimumSystemVersion
[ ] extraResources stages the sidecar; files includes build outputs + runtime assets
[ ] engine/sidecar runner spawns from process.resourcesPath when app.isPackaged
[ ] hardenedRuntime + entitlements plist (jit / unsigned-exec / disable-lib-validation / dyld-env / network)
[ ] gate all dev-only main-process calls on !app.isPackaged
[ ] build: npm run dist:dir (fast) -> smoke the packaged .app spawns everything
[ ] codesign --verify --deep --strict  == exit 0
[ ] notarize (creds) -> xcrun stapler validate + spctl -a -vvv
[ ] electron-updater + publish:github + Settings toggle + Privacy disclosure
[ ] first-launch consent gate (if applicable)
[ ] GitHub Actions: tag-driven build/sign/notarize/publish; version from package.json
[ ] Issues templates + SECURITY.md + in-app report/update
```

---

## TAL worked-example files (copy from these)

- Sidecar freeze: `engine/engine.spec`, `engine/freeze_entry.py`, `tools/build-engine.sh`, `docs/engine-freeze-spike-notes.md`
- Packaging: `desktop/electron-builder.yml`, `desktop/build/entitlements.mac.plist`, `desktop/package.json` (`build:engine` / `dist:dir` / `dist:mac` scripts)
- Conditional spawn: `desktop/electron/engine-runner.ts` (`app.isPackaged` branch)
- The full TAL plan + decisions + phase results: `docs/distribution-plan.md`

> Keep this playbook updated as we learn more (notarization specifics, the CI workflow, universal builds). When the next app ships, fold any new gotchas back here.
