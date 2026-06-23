# Phase 7c.1 — Engine-freeze spike notes

> **Verdict: PASS.** PyInstaller `onedir` produces a self-contained engine that runs end-to-end with no `engine/.venv`. Proceed to Phase 7c.2 (electron-builder DMG). Done 2026-06-20 on branch `phase-7c-distribution`.

## What was built
- **Entry shim:** `engine/freeze_entry.py` (imports the `engine` package so `__main__`'s relative imports resolve under PyInstaller).
- **Spec:** `engine/engine.spec` — `onedir`, `collect_all` for uvicorn/fastapi/starlette/yfinance/openai/anthropic + `google.genai`, `collect_submodules` for uvicorn + engine, plus websockets/httptools/uvloop. Excludes tkinter/matplotlib.
- **Build:** `engine/.venv/bin/pyinstaller engine/engine.spec --clean --noconfirm` → `dist/tal-engine/tal-engine`.

## Results (frozen binary, launched standalone from /tmp, no venv on PATH)
- Handshake `{"port","token"}` emitted on stdout ✓
- `/health` → 401 without bearer, 200 + valid JSON with bearer ✓ (yfinance provider initialized; all 6 live providers listed)
- `/data/summary?ticker=NVDA` → real OHLCV ($210.69 close, full range) ✓ — **the heavy deps (pandas/numpy/yfinance) froze correctly**, and the NaN incomplete-bar guard works (`as_of` = last complete bar)
- `/analyze` stub → clean end-to-end ✓
- **All hidden imports resolved first try** — no runtime import failures.

## Numbers
- Bundle (`dist/tal-engine/` onedir): **113 MB**.
- Cold start: server bound and serving ~1-1.5s after launch (comparable to the dev venv path).
- Arch: **arm64 only** in this spike (host arch). Universal is a 7c.2 concern (see below).

## Carry into 7c.2
1. **Universal binary is the real packaging puzzle.** PyInstaller builds for the host arch; numpy/pandas ship arch-specific `.so`, so there's no trivial universal2 onedir. Options: build the engine per-arch (arm64 + x64) and have electron-builder's universal app include the correct slice, or build on each arch in CI. Decide in 7c.2.
2. **Sign + notarize the bundle** — every Mach-O in `dist/tal-engine/` must be signed (the known notarization failure point).
3. **Wire `engine-runner.ts`** to branch on `app.isPackaged`: packaged → spawn the bundled `tal-engine` under `process.resourcesPath`; dev → unchanged venv path. Deferred to 7c.2 because it's only testable against a packaged build.
4. **Stale `__version__`:** the frozen `/health` reported `version: 0.0.1`. The engine's `__version__` wasn't bumped to 0.1.0 — fold into the version single-source-of-truth work (7c.5).
5. `pyinstaller` is installed in the dev venv but intentionally NOT added to `engine/requirements.txt` (build-only tool; belongs in the CI build step / a dev-requirements file).
