# Regression Sweep — Raw Findings (2026-06-16)

> Working scratchpad for the overnight stability sweep on branch `regression-sweep-2026-06-16`.
> Triage status: ✅ fixed · 📋 logged to REMAINING.md · ❌ rejected (false positive / won't-fix).
> Final curated open items live in `REMAINING.md`; fixed items get written up in `WORKLOG.md`.

## Baseline (pre-sweep, all green except known-flaky)
- engine pytest: 255 passed (now 258 with the NaN regression tests)
- desktop type-check: clean · vitest: 15 passed · prod build: clean
- known-flaky: `test_storage.py::test_concurrent_writes_dont_collide` (SQLite WAL contention, pre-existing, environmental — Handover open item #3)

## Already fixed this session
- ✅ **yfinance NaN trailing-bar** (`data_providers.py` `_yfinance_quote_summary`): analyzing "today" / an in-progress session made yfinance return a trailing NaN-OHLC row → `last_close = NaN` → fake "$NaN" price in the decision card + fabricated number in the LLM context. Fix: `dropna(subset=OHLC)` before `.tail()/.iloc`, raise `DataUnavailable` if nothing complete remains. Regression test: `engine/tests/test_yfinance_summary.py` (3 cases). Verified NVDA-today now resolves to last complete close.

---

## Engine — core (agent 1)
- **MAJOR [CONFIRMED]** `data_providers.py:383` and `:489` — `min(float(b.get("l") or 0.0) for b in bars if b.get("l") is not None)` for `period_low` raises `ValueError` on empty sequence when ALL Alpaca bars have null low. `period_high` (`max`) is immune (no filter). Crash is swallowed by `_fetch_summary_safe` → data card silently never appears for that Alpaca session. Same class as the yfinance NaN bug. Fix: `min(..., default=0.0)` on both lines. → CANDIDATE FIX (needs verify + test)
- **MINOR [CONFIRMED]** `__main__.py:27-33` — TOCTOU on port reservation (`_pick_port` binds, releases, uvicorn re-binds). Harmless in prod (single Electron process, sub-ms window). → LOG
- **DEAD [UNCERTAIN]** `llm_providers.py:283` — `default_model_for()` only referenced from tests. Exported; not clearly dead. → LOG (do not remove; test-referenced)

## Engine — integrations (agent 2)
- **MAJOR [CONFIRMED]** `telegram_bot.py:553` — Telegram bot token leaks into `_BotStatus.last_error`: `str(httpx.HTTPStatusError)` includes the full URL `https://api.telegram.org/bot<TOKEN>/getUpdates`, which is serialized to the renderer by every `/telegram/*` status endpoint and logged on each poll. Violates zero-data / secret-safety posture. Fix: store `f"network: HTTP {status_code}"`, drop the URL. → CANDIDATE FIX (needs verify + test)
- **MINOR [CONFIRMED]** `webhooks.py:312-314` — `except asyncio.TimeoutError` is unreachable (httpx raises its own `TimeoutException`, not builtin/asyncio TimeoutError); timeouts fall through to the generic `except Exception` → "failed" (correct result). Dead branch, harmless. → LOG
- **MINOR [CONFIRMED]** `telegram_bot.py:428-449,952` — `stop()` cancels the poll loop but not in-flight fire-and-forget `_handle_message` tasks; one resuming after `_client=None` hits `assert self._client is not None` in `_reply()`. Impact limited to restart; loses the final user reply + adds asyncio log noise. Fix: guard `_reply` with `if self._client is None: return`. → LOG (edge case, lifecycle change is riskier than the bug)
- **MINOR [CONFIRMED]** `cost_guard.py:683` — `estimate_cost` in `__all__` but never imported via `cost_guard` (callers import from `llm_providers`). Dead re-export surface. → LOG

### Explicitly checked CLEAN (agents 1+2)
server.py auth/WS/CORS/dispatch · live_debate retry+adapter cleanup+finalization · storage.py schema/WAL/parameterized SQL · stub_debate event shapes · ticker.py · HMAC correctness · webhook URL/secret never logged · cost-guard reservation math (no TOCTOU/double-spend) · atomic spend writes · allowlist enforcement · sentiment_sources thread-offload · local_llm_detect connection scoping.

## Desktop renderer (agent 3)
- **MAJOR [CONFIRMED]** `Settings.tsx:719` — `onSaveManual` reads stale `saveError` state right after `await onPickModel(...)`; the Local-LLM manual-entry form doesn't close on success (and may close on failure). → 📋 LOG (no React component-test harness to guard the fix; UX-only, niche path)
- **MAJOR [CONFIRMED, low-prob]** `Analyze.tsx:635-649` — keydown effect's lint-suppress hides that `onAnalyze` isn't a dep; theoretical stale ticker/date on Cmd+Enter under React 19 batching. Agent itself rates "very low probability". → 📋 LOG (fix = useCallback refactor of a central handler; risk > value tonight)
- **MINOR [CONFIRMED]** `DebateStream.tsx:251-256` — elapsed clock won't start on a 2nd analysis in the same session (`endedAtRef`/`startedAtRef` never reset on re-run). → 📋 LOG (real UX bug; bundle with renderer-fix batch + test harness)
- **MINOR [CONFIRMED]** `StatusStrip.tsx:155-166` — engine-crash recovery tick loop lacks a mount guard; up to 20 IPC calls after teardown. Benign. → 📋 LOG
- **DEAD [CONFIRMED]** `engine-client.ts:887-901` — `analyze()` + `AnalyzeResponse` (HTTP POST path) have zero renderer callers; all analysis goes through `streamDebate()`. → 📋 LOG (dead-code batch)
- Renderer CLEAN: WS lifecycle + hide-not-unmount, BatchRunner mount guard, all setInterval/timeout cleanup, no bare JSON.parse, WS event null-safety, History getSession generation-counter race guard.

## Electron main + IPC (agent 4)
- **MAJOR [CONFIRMED]** `main.ts:94-96` — `setWindowOpenHandler` forwards all `window.open` URLs to `shell.openExternal` with no protocol allowlist (`file:`/`javascript:` structurally undefended; narrow in prod since only local bundle loads). → 📋 LOG (security hardening; clear fix: gate to http/https. Strong candidate for the approved batch)
- **MINOR [CONFIRMED]** `engine-runner.ts:165` — handshake parse error can embed a partial bearer token in the error string if JSON splits across pipe buffers. → 📋 LOG
- **MINOR [CONFIRMED]** `oauth-openai.ts:264`/`preload.ts:68-75` — refresh token crosses the bridge despite a comment saying it doesn't (127.0.0.1 only, so exposure nil; comment is inaccurate). → 📋 LOG (fix or correct the comment)
- **MINOR [CONFIRMED]** `window-state.ts:34-50` — restored window dims have a lower bound but no upper cap vs screen size; corrupt state file → unusably large window. → 📋 LOG
- **DEAD [CONFIRMED]** `oauth-openai.ts:346` `getCredentials()` (zero refs); `secrets.ts:52` `EncryptionUnavailableError` export (thrown internally only). [UNCERTAIN] `OPENAI_OAUTH_SECRET_KEY`, `menu.ts:23 buildMenu` (verify not test-referenced). → 📋 LOG (dead-code batch, verify each grep before removal)
- Electron CLEAN: contextIsolation true / nodeIntegration false, safeStorage hard-fail + 0o600 + corrupt-recovery doesn't log secrets, bearer token only on 127.0.0.1, upstream-check uses execFile (no shell), engine kill paths (stopEngine idempotent, reapOrphanEngine pid-targeted), OAuth single-flight mutex, handshake timeout cleanup.

## Architect / cross-cutting (agent 5)
- **MINOR [CONFIRMED]** `engine-client.ts:450` `HealthInfo` — declares phantom `live_default_model?: string`; engine actually emits `live_default_models` (dict) + `live_providers` (array). No consumer today. → 📋 LOG (doc/interface tidy)
- **MINOR [CONFIRMED]** `storage.py` — `auth_kind` written to SQLite (schema v2) but absent from `SessionSummary`/`SessionDetail` dataclasses → never returned by `/sessions*`; History can't surface OAuth-vs-API-key. → 📋 LOG (data-pipeline gap, not breakage)
- **MINOR [CONFIRMED]** `docs/api.md` drift: CORS section says origin-locked but code is `allow_origins=["*"]` (documented rationale); `data.summary` example missing `asset_class`. → 📋 LOG (doc fixes, zero runtime risk)
- **NOTE [CONFIRMED]** Sync hazard: renderer `PROVIDER_MODELS` vs engine `_COST_PER_M_TOKENS` — a picker model with no cost entry bills $0 through CostGuard (e.g. gpt-5.5, gemini-3.1-flash-lite). Same item already logged from the model-picker review. → 📋 LOG (add a cross-check test)
- **NOTE [CONFIRMED]** `DebateStream.tsx AGENTS_PER_PHASE` must match engine `_AGENTS` (12); engine has an assert, renderer has no guard. → 📋 LOG (add cross-ref comment)
- **Stability verdict (architect, verbatim-summary):** "genuinely clean for a feature-complete v0.1 codebase. The WS `/stream` contract is tight and the discriminated union covers every emitted event. Highest residual risk is the two-registry sync hazard (model picker vs cost catalog) and the `auth_kind` pipeline gap. Neither is a production blocker."

---

## TONIGHT'S TRIAGE SUMMARY
- ✅ **Fixed + tested (3 confirmed-breaking):** yfinance NaN trailing-bar; Alpaca `period_low` empty-`min()` crash; Telegram bot-token leak into `last_error`. +7 tests, all gates green (engine 262 / smoke 17 / type-check / vitest 15 / build).
- 📋 **Deferred to `REMAINING.md` for founder review:** 1 security hardening (openExternal allowlist), 3 renderer UX bugs (no component-test harness yet), a confirmed dead-code batch, several minor robustness items, doc drift, 2 known sync hazards.
- ❌ **Rejected false positives** (by the agents themselves): `Optional` annotation safe under `from __future__`, retry-log denominator correct, stub `session.complete` defaults handled, HMAC alias correct, cost-guard reservation math has no TOCTOU.
- **No regressions introduced.** Diff = 3 fixes + 7 tests only.
