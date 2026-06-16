# TradingAgentsLab — Backlog

> **Organization:** by phase (see [`docs/architecture.md`](docs/architecture.md) §8).
>
> **Reconciliation note (2026-06-10):** This file had drifted badly behind the code. A verification pass (greps against actual source + commit refs, cross-checked with Handover) flipped a large batch of items from pending to done. The app is effectively feature-complete; the genuinely-remaining list is at the bottom under **"What actually remains."** Items marked 🟢 below were verified present in the codebase, not just assumed.

## Status legend

- 🟢 done · 🟡 in progress · ⚪ pending · 🔴 blocked · 🟣 deferred · 🚫 removed (positioning) · ✋ closed by founder decision

---

## Phase 0 — Foundation ✅ DONE

- 🟢 **Fork upstream + dual-license setup** — AGPL-3.0 + Apache 2.0 attribution, NOTICE, CLA, CONTRIBUTING. Pushed to `RBJGlobal/TradingAgentsLab`.
- 🟢 **Git remotes** — `origin` → TradingAgentsLab, `upstream` → TauricResearch/TradingAgents.
- 🟢 **Gateway probe** — `tools/clawless-probe.mjs`, multi-client OpenClaw access verified.
- 🟢 **Architecture doc** — `docs/architecture.md` v0.1 shipped. Iterates as later phases surface refinements.
- 🟢 **Backlog + Handover** — `backlog.md` + `Handover.md` in place and being maintained per-session.
- 🟢 **CLAUDE.md** — orchestration contract written from scratch (Clawless template was not portable per Advisor).
- 🟢 **Commit + push Phase 0 artifacts** — shipped in commit `f0125b8`.

## Phase 1 — Desktop shell ✅ DONE

- 🟢 Scaffold `desktop/` Electron app (TypeScript + React + Vite).
- 🟢 TradingAgentsLab theme tokens — dark surface (`#0d1117`), warm-amber accent (`#f0a830`), system humanist sans + monospace headings, subtle radial gradient.
- 🟢 App-shell window opens with title bar, sidebar nav (Analyze · Watchlist · History · Settings), main panel, footer with disclaimer.
- 🟢 Acceptance: founder approved on first look — *"I like the colors. It is nice light base, give that trading app feel. Great."*

## Phase 2 — Python sidecar ✅ DONE

- 🟢 Scaffold `engine/` FastAPI service (Python 3.13 venv via uv-managed interpreter).
- 🟢 Endpoints: `GET /health`, `POST /analyze` (one-shot stub), `WS /stream` (canned 16-event multi-agent debate over ~7s).
- 🟢 Stub debate sequence (`engine/stub_debate.py`) — analysts → phase.transition → researchers → trader → risk → portfolio_manager → session.complete.
- 🟢 Sidecar process startup: emits `{"port": <int>, "token": "..."}` JSON to stdout for Electron main to read.
- 🟢 Bearer-token auth on all endpoints (`Authorization: Bearer <token>` for HTTP, `?token=` query param for WS).
- 🟢 Acceptance verified: `/health` 200 with auth / 401 without; `/analyze` returns stub decision; `/stream` streams 16 events with realistic phasing.
- 🟢 **Phase 2.1-light: real-LLM debate** — `engine/live_debate.py` sequential per-agent loop (4 analysts → 3 researchers → trader → 4 risk seats). `provider_config` in the WS start frame triggers it; absent → canned stub. Cost discipline baked in. Phase 2.1-full (wrapping upstream's `TradingAgentsGraph`) deferred — see `docs/architecture.md` §5.
- 🟢 **Multi-provider** — OpenAI + Anthropic + OpenRouter + Google Gemini + xAI Grok + MiniMax. `engine/llm_providers.py` shared `LLMAdapter` Protocol. `PROVIDER_PRIORITY` first-found-key wins. try/finally adapter lifecycle.
- 🟢 **User-facing "Run with: …" provider override on Analyze** — dropdown, localStorage persistence + mount-time validation, reset button, closure-capture race guarded.
- 🟢 **OpenAI OAuth (subscription-plan path)** — `@earendil-works/pi-ai` PKCE flow, `desktop/electron/oauth-openai.ts`, safeStorage, single-flight refresh mutex, 20s paste fallback. OAuth wins over API key when both stored.

## Phase 3 — End-to-end demo ✅ DONE

- 🟢 Renderer ↔ engine wired end-to-end (`c5815fa`). `engine-runner.ts` spawn + handshake, `main.ts` IPC, `preload.ts` contextBridge, `engine-client.ts` typed wrapper, `DebateStream.tsx`, `Analyze.tsx`, CORS for renderer origin.
- 🟢 Acceptance: type-check + prod build + engine contract green; Electron spawns engine via `app.getAppPath()`. **Founder-accepted** through daily-driving since 2026-05-14.

## Phase 4 — Settings page ✅ DONE

- 🟢 **Phase 4 spike (UI scaffolding)** — Settings page, hash router, tabs, phase-guard footer.
- 🟢 **Phase 4 main: secret storage layer** — Electron `safeStorage`-backed, versioned JSON at `<userData>/secrets.json`, hard-fails when encryption unavailable, IPC `secrets:*`, renderer wrapper.
- 🟢 **Phase 4 main: Settings UI wiring** — all provider tabs wired through the secrets bridge with masked-tail + relative timestamp; About tab shows the secrets file path.
- 🟢 **Real LLM key validation ("Test connection")** — `POST /llm/test` (`engine/server.py:256`) + `testLLMConnection` (15s timeout, `engine-client.ts:676`) + per-row button. Shipped `cd58183`. *(Was deferred pending founder go-ahead; landed during Phase 1 closeout.)*
- 🟢 **OAuth flow for OpenAI** — see Phase 2.1 OAuth row above. No Anthropic OAuth (TOS).
- 🟢 **Engine consumption: provider config threaded into `/analyze` + WS start frame** — via the shared `runAnalysis` helper (`067895a`).
- 🟢 Acceptance: founder daily-drives with his real OpenAI key; persists across restarts. **Founder-accepted** through daily use.

## Phase 5 — Data only (broker work removed per locked positioning 2026-05-09) ✅ DONE

> **Positioning lock (2026-05-09):** analysis tool, not execution platform. Broker execution is OUT — see CLAUDE.md §3 + memory `project_positioning_analysis_only.md`.

- 🟢 **Phase 5 part 1 (yfinance default data)** — `engine/data_providers.py` `YFinanceProvider`, `GET /data/summary`, `data.summary` WS event, renderer summary strip.
- 🟢 **Phase 5b: AlpacaDataProvider** — `engine/data_providers.py:259` `AlpacaProvider`, hardcoded `ALPACA_DATA_BASE_URL = "https://data.alpaca.markets"` (line 252) so a pasted live key structurally cannot execute orders. Auto-routed when keys configured; Data card flips to "Alpaca · live". Shipped `146933d`. **Founder-accepted** (his Alpaca Basic-tier creds verified live across equities + crypto, 2026-05-09).
- 🚫 ~~`BaseBroker` / `AlpacaBroker` paper-trading~~ — REMOVED per locked positioning.
- 🚫 ~~Broker settings tab~~ — REMOVED from UI.

## Phase 6 — Optional Clawless tap ⚪ THE ONE REMAINING FEATURE SPRINT

> Pre-implementation memo in memory `project_phase_6_clawless_tap_scoping.md` + RPC spec in `project_openclaw_llm_rpc.md`. ~4-6h. **Needs founder's Clawless gateway token + a running gateway to test end-to-end** → joint session.

- ⚪ `ClawlessGatewayClient` — translates LLM calls to OpenClaw RPCs (`sessions.create` → `chat.send` deliver:false → poll `sessions.history`, one long-lived `tal-debate-runner` agent per conversation).
- ⚪ Protocol negotiation: try max=4, fall back to 3 on `protocol mismatch`.
- ⚪ Settings tab: "Connect to Clawless (optional)" — gateway URL + token paste. *(Settings tab shell already exists.)*
- ⚪ Detect-and-route: if configured + reachable, route through gateway; else fall through to BYO.
- ⚪ UI badge: "Standalone" vs "Connected to Clawless".
- ⚪ Acceptance: founder pastes his Clawless token, analyses route through the gateway, badge updates.

## Phase 7 — Real product surface ✅ MOSTLY DONE

- 🟢 **Watchlist page** — SQLite-backed, add/list/remove, Analyze deep-link, endpoints `GET/POST/DELETE /watchlist`.
- 🟢 **History page** — list + replay detail + delete + copy transcript, race-guarded, `GET/DELETE /sessions`.
- 🟢 **Detail-fetch timeout** — 8s AbortController on `getSession` (`56864a8`).
- 🟢 **Settings persistence (window size)** — `desktop/electron/window-state.ts`, persists bounds to `<userData>/window-state.json` (`e0fe81d`).
- ⚪ **Watchlist daily re-analyze cadence** — minor unstarted feature (auto-reanalyze tracked tickers on a schedule). Buildable autonomously; needs a small design call (in-app scheduler vs. on-launch sweep).
- ⚪ **Distribution: signed macOS DMG + Windows installer** — 🔴 gated on Apple Developer cert (~weeks out). Auto-update mechanism deferred. See Phase 7b.

## Phase 7b — Launch prep ✅ MOSTLY DONE / RELAXED (founder decision 2026-06-10)

> **Founder posture (2026-06-10):** free, open-source, educational, analysis-only, zero monetization → minimal regulatory surface. The legal inflection point is *charging money*, not distribution. Relax this phase; do not over-build it. See "Legal read" note at bottom.

- 🟢 **Terms of Service** — live on site at `app/legal/terms`.
- 🟢 **Privacy Policy** — live on site at `app/legal/privacy` (zero-data-collection statement).
- 🟢 **Disclaimer page** — live on site at `app/legal/disclaimer` (three-tier SEC-aware copy).
- 🟢 **Brochure marketing site** — live at tradingagentslab.ai (.com 301→.ai). Static, no analytics, no tracking.
- 🟢 **Settings → About "Legal & Disclaimers"** — three external links to the site legal pages (`4655110`).
- ✋ **Cookie Policy** — CLOSED by founder. No cookies, no login, localStorage only → nothing to disclose. Covered by Privacy Policy.
- ✋ **Pre-launch securities-lawyer review** — CLOSED by founder. Not engaging counsel for a free, non-monetized, analysis-only educational app. Revisit ONLY at the monetization inflection point (per CLAUDE.md §3 + memory `project_monetization_roadmap.md`).
- 🔴 **DMG distribution build** — signed + notarized via `electron-builder`. Gated on Apple Developer cert. **This is a UX gate (Gatekeeper warning on unsigned apps), not a legal one.** Distribution method is a founder call per CLAUDE.md §10.

## Phase 8 — Webhooks for external broker handoff ✅ DONE

- 🟢 **Phase 8a** — Settings → Webhooks tab + engine dispatcher + Telegram/Slack/Discord/Generic presets + per-receiver filter + HMAC for generic + URL secret-safety.
- 🟢 **Phase 8b** — Multi-ticker batch runner on Watchlist ("Run all"), each debate persists + fires its own webhooks.
- 🟢 **Phase 8c: Bidirectional Telegram bot** — SHIPPED (was marked deferred; verified `engine/telegram_bot.py`, 1014 lines: `getUpdates` long-polling, chat_id allowlist, pairing/approval flow, per-chat daily spend cap, `/full` `/summary` modes, reply keyboard, `setMyCommands`). MVP `269d353` → v1.2/v1.3 `122c12a`.
- 🟣 **Phase 8c+ : detached sidecar** — bot survives app close (PID file + Electron menu changes). Future enhancement, ~1 day. Not started. Don't start before Phase 6 is stable (both add long-running loops).

---

## Stretch — feature spikes ✅ DONE

- 🟢 **News headlines via yfinance** — `GET /data/news`, `news.headlines` WS event, linked News card, transcript section.
- 🟢 **Keyboard shortcuts + Electron app menu** — full menu bar + accelerators (Cmd+N/./,/1/2/3, page-level Cmd+Enter).
- 🟢 **Streaming progress UX** — phase chips + agent counter + live elapsed clock in DebateStream (`25bd7e3`). Founder signed off ("Looks great. I like it.").
- 🟢 **Crypto ticker routing** — FIXED. `engine/ticker.py` normalization (19 crypto refs) + `AlpacaProvider._crypto_quote_summary` via `/v1beta3/crypto/us/bars` + yfinance crypto branch + asset-class-aware prompts + Crypto badge (`0ff70e3`, `517d99d`). The "BTC silently analyzes the wrong asset" bug is resolved.
- 🟢 **Local LLM support** — Ollama / LM Studio / generic OpenAI-compat auto-detect, Settings UI, model picker, $0 CostGuard path (`2ab4be1`).
- 🟢 **Sentiment analyst** — grounded in StockTwits + Reddit (`6d514e8`).

---

## CostGuard ✅ DONE (was mislabeled "Tomorrow's queue")

- 🟢 **CostGuard end-to-end** — `engine/cost_guard.py` math + 4 HTTP endpoints (`/cost-guard/state`, `/cost-guard/config`, reserve/finalize) + renderer modal + Settings tab. TOCTOU-safe reservation, OAuth-aware ($0 path), 3-second anti-tamper override, global (not per-provider). `0b3bc20`→`3ccbd05`.
- 🟢 **Spend pill in StatusStrip** — daily $ vs cap, green/amber/red, polls every 30s + 500ms re-poll on `tal:session-complete` (`6b0d110`).
- 🟢 **TTL sweep / crash recovery** — 15-min reservation TTL, `_sweep_expired()` runs on every `reserve()`. The "low-priority background GC" remnant is already handled.
- 🟢 **Telegram debates take a global cost_guard reservation** — closed a real-money bypass hole (Tier 0, `c97e601`).

## Testing + tooling ✅ DONE

- 🟢 **Playwright + Electron e2e** — `bf2217d`, 6 tests (provider dropdown, Settings round-trip, webhooks, debate render) in ~25s via `npm --prefix desktop run test:e2e`.
- 🟢 **`tools/dev-smoke.sh`** — backend smoke runner (17 assertions: auth + CORS + every HTTP endpoint + WS contract + sessions round-trip).
- 🟢 **`tools/upstream-check.sh`** — weekly upstream-drift check.
- 🟢 **`docs/api.md`** — engine API contract.
- 🟢 **`docs/kb/`** — 11-file user-facing knowledge base.
- 🟢 **Engine SQLite session storage** — `engine/storage.py`, versioned schema, WAL, write-on-stream-end, list/get/delete.
- 🟢 **JWT plan-tier detection** — `oauth-openai.ts` decodes `chatgpt_plan_type`, `isFreeTier` flag for free-tier banner. (Was a "Tomorrow's queue" item; already implemented.)
- 🟢 **Reviewer pass on model picker** (`c81b1d0` "Per-provider model picker on Analyze") — DONE 2026-06-10. No bugs. Registry kept in sync (xai/minimax present, refreshed 2026-05-28), `Record<LLMProvider, …>` gives compile-time completeness, saved-model resync validates against the live list + falls back to recommended (deprecation-safe), refs race-guard `onAnalyze`, recommended defaults are the cheap tier. Type-check clean. **One optional hardening logged**: renderer `PROVIDER_MODELS` and the engine cost catalog are two hand-maintained lists; `test_catalog_consistency.py` guards the engine but not the renderer registry, so a picker id absent from the engine cost table would run but show a blank cost estimate. Low priority.
- 🟣 **Flaky `test_storage.py::test_concurrent_writes_dont_collide`** — environmental SQLite WAL contention. Harden (bump `busy_timeout` or assert "both eventually land") if it becomes annoying.

---

## What actually remains (post-reconciliation, 2026-06-10)

**Real work, needs the founder (joint session):**
1. **Phase 6 Clawless gateway tap** — the one unstarted feature sprint (~4-6h). Needs his Clawless token + running gateway to test.

**Real work, buildable autonomously:**
2. **Watchlist daily re-analyze cadence** — minor; needs a quick design call (in-app scheduler vs. on-launch sweep).
3. **Reviewer pass on model picker** — in progress; read-only, no keys.

**Externally gated (not actionable now):**
4. **Signed macOS DMG + distribution** — Apple Developer cert (~weeks). UX gate, not legal.
5. **Phase 8c+ detached Telegram sidecar** — deferred future enhancement.

**Closed by founder decision (not doing):**
- Cookie Policy (no cookies), securities-lawyer review (free/non-monetized/educational).

**Key-requiring re-verification (founder offered keys, low cost ~$0.07-0.10/run):**
- Live re-run of `/llm/test` against each real provider key; OAuth subscription-plan routing sanity check; live Alpaca data round-trip. All shipped + unit-tested; this is confidence verification, not new build.

---

## Cross-cutting / deferred

- 🟣 OpenClaw upstream PR to register `client.id: "tradingagentslab"` constant (non-blocking — `"cli"` works).
- 🟣 Massive.com / Polygon-class data provider (defer until a feature needs it).
- 🟣 Tauri/Wails port (not happening — Electron is the right call).
- 🟣 Live-trading enablement for general public (founder-only; revisit post-GA per CLAUDE.md §10).
- 🟣 Mobile companion (out of scope).
- ⚪ Version-string single-source-of-truth refactor (source App.tsx footer + Settings About + preload.ts from `package.json`) — nicety from PR #12.

## Resolved Advisor questions (2026-05-07 reply)

- 🟢 CLAUDE.md template, Handover/backlog skeletons, Settings component tree, theme tokens, multi-client gateway gotchas — all resolved (build our own; no Clawless code inheritance).
