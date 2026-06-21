# TradingAgentsLab — What's Remaining

> Companion to `backlog.md` (the larger "what's done" record). Intentionally short.
> Updated 2026-06-16 after the deferred-cleanup pass: the entire review-findings batch from the overnight sweep is now resolved. What's left is the real roadmap plus one small decision for you.

---

## Part 1 — Open roadmap work

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | **Phase 6 — Clawless gateway tap** | Not started | The one unstarted feature (~4-6h). Routes LLM calls through the OpenClaw gateway. Needs your Clawless token + a running gateway to test. RPC spec + scoping memo in memory. |
| 2 | **Watchlist daily re-analyze cadence** | Not started | Minor. Auto-reanalyze tracked tickers on a schedule. One design call: in-app scheduler vs. on-launch sweep. |
| 3 | **Signed macOS DMG + distribution** | Blocked (external) | Gated on the Apple Developer cert. Gatekeeper UX gate, not legal. Your call on method. |

The app is otherwise feature-complete and the codebase is clean.

---

## Part 2 — One decision for you

- **`auth_kind` in session storage.** The column is written to SQLite but never read back by any endpoint (History can't show OAuth-vs-API-key). Since cost is already surfaced ($0 for OAuth runs), surfacing `auth_kind` has low marginal value. Three clean options:
  1. **Leave it as stored provenance** (recommended) — harmless, queryable later, zero new API surface.
  2. **Surface it** in `/sessions*` + the History UI (I wire dataclass → SELECT → renderer interface; ~30 min).
  3. **Remove the write** entirely.
  Tell me which and I'll action 2 or 3 if you don't want 1.

---

## Part 3 — Resolved this session (for reference; detail in WORKLOG / REVIEW_FINDINGS.md)

All overnight review findings are now closed:
- **Fixed + tested:** `openExternal` protocol allowlist (security); Alpaca incomplete-bar guard (both equity + crypto); storage init-race (the flaky test, fixed at the source: 0/20); telegram `stop()` reply race; telegram token leak (last night); yfinance NaN bar (last night); the 3 renderer bugs → 2 real ones fixed (Settings form-close, DebateStream clock) with a new React Testing Library harness; webhooks timeout exception type; HealthInfo interface; `docs/api.md` CORS + asset_class.
- **Dead code removed:** `analyze()`/`AnalyzeResponse`, `getCredentials()`, unused exports (`EncryptionUnavailableError`, `buildMenu`, `estimate_cost` re-export).
- **Re-confirmed as already-fine (no change needed):** model-picker vs cost-catalog (already guarded by `test_catalog_consistency`); `AGENTS_PER_PHASE` cross-ref comment (already present); OAuth refresh-token bridge comment (accurate as written); Analyze Cmd+Enter keyboard shortcut (dep set is correct — theoretical non-bug, not changed to avoid touching the critical handler).
- **Accepted as-is (documented):** `__main__` port TOCTOU (harmless in single-process prod).

### Housekeeping note
The new React Testing Library dev-dependencies introduced 6 npm-audit advisories (dev-only test tooling, never shipped in the Electron app). Can run `npm audit fix` if you want them quiet; not a runtime concern.

### Optional live verification (your keys, ~$0.07-0.10)
The Alpaca data-path fixes are covered by mocked unit tests. If you want, paste Alpaca keys and I'll do a live round-trip to confirm end-to-end. (Phase 6 similarly needs your Clawless token when you're ready.)
