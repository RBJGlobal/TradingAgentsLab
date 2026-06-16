# TradingAgentsLab — Worklog

> **Purpose:** Chronological day-by-day record of what shipped each session. Complement to [`backlog.md`](backlog.md) (status by phase) and [`Handover.md`](Handover.md) (current state). When you want "what did we do yesterday vs today," read this. When you want "what's left," read `backlog.md`. When you want "where do I pick up," read `Handover.md`.
>
> **Format:** Newest entries on top. Each session gets a date header, a one-line goal, bulleted commits with hashes, and a "next session opens with" line.

---

## 2026-06-16 (cont.) — deferred-cleanup pass: cleared the entire REMAINING.md Part 2

**Goal:** Founder reviewed the overnight sweep and authorized working through every deliberately-deferred item so the codebase is clean and we don't repeat the exercise. Re-confirmed each agent-reported finding against source before acting (several turned out to be already-fine — see below). Same branch `regression-sweep-2026-06-16`, unpushed.

**Fixed + tested:**
- **Security** — `main.ts setWindowOpenHandler`: only http(s) URLs reach `shell.openExternal` (file:/javascript:/other denied).
- **Alpaca incomplete-bar guard** — drop null-close bars in both equity and crypto summaries (mirrors last night's yfinance NaN fix); +2 tests.
- **storage init race (the flaky test, fixed at the source)** — `_ensure_initialized` now serializes under an RLock (double-checked); also moved `busy_timeout` to be the first pragma. Root cause was two threads racing the DDL + WAL-mode switch on a fresh DB (busy_timeout doesn't cover the journal_mode change). Stress: **0/20 failures** (was ~8/12). Real prod robustness fix, not just test tolerance.
- **telegram `stop()` race** — `_reply` guards `_client is None` instead of asserting; +1 test.
- **webhooks** — catch `httpx.TimeoutException` (the real type), not the unreachable `asyncio.TimeoutError`.
- **Renderer (new React Testing Library + happy-dom harness)** — Settings Local-LLM manual form now closes on success via `onPickModel` returning a bool (was a stale-closure read of `saveError`); DebateStream elapsed clock resets its refs when events clear so a 2nd run in the same session times fresh. New `debate-stream.test.tsx` (bug-sensitive, fake-timer based) + the harness wired into `vitest.config.ts` via per-file `@vitest-environment`.
- **Contract/docs** — `HealthInfo` interface matches what the engine emits (`live_providers` + `live_default_models`, dropped phantom `live_default_model`); `engine-runner` handshake error redacts a partial token; `window-state` caps restored size to the display work area; `docs/api.md` CORS description + `asset_class` example corrected.

**Dead code removed / de-exported (all confirmed zero-ref):** `analyze()` + `AnalyzeResponse`, `getCredentials()`, `EncryptionUnavailableError`/`buildMenu` exports, `estimate_cost` re-export.

**Re-confirmed as already-fine (NO change — re-confirmation prevented redundant/incorrect edits):** model-picker vs cost-catalog sync (already guarded by `test_catalog_consistency`, and the flagged models already have cost rows); `AGENTS_PER_PHASE` cross-ref comment (already present); OAuth refresh-token bridge comment (accurate as written); Analyze Cmd+Enter shortcut (the `[ticker, date]` dep set is correct — the agent's "stale onAnalyze" was theoretical; left untouched to avoid churning the critical handler).

**Accepted as-is:** `__main__` port TOCTOU (harmless single-process prod).

**Deferred to a founder decision (not breaking):** `auth_kind` is written to SQLite but never read back — leave as provenance (recommended) / surface in History / remove the write. See REMAINING.md Part 2.

**Two commits this pass:** `812131f` (security + dead code + robustness) and the renderer/harness/docs commit. **Gates green:** engine **265**, type-check clean, vitest **17** (+2 component), build clean, dev-smoke **17/17**.

**Note:** RTL dev-deps added 6 npm-audit advisories (dev-only test tooling, not shipped). `npm audit fix` optional.

**Next session opens with:** founder's `auth_kind` decision; then Phase 6 Clawless (needs token) or watchlist cadence. Branch unpushed — merge after founder review.

---

## 2026-06-16 — overnight stability sweep: aggressive regression review + 3 confirmed-breaking fixes

**Goal:** Founder asked for an aggressive regression/code-review sweep (architect + code-reviewers teamed up) to confirm a stable, clean codebase, fix anything breaking, and leave two review files for the morning: a small "what's remaining" + the existing larger "what's done" (`backlog.md`). Autonomous overnight run on branch `regression-sweep-2026-06-16` (NOT pushed — founder reviews local state).

**Baseline established (all green):** engine pytest 255, type-check clean, vitest 15, prod build clean. `dev-smoke` caught a live bug on the first run (below).

**3 confirmed-breaking bugs fixed + tested (diff = these fixes + 7 tests only):**

- **yfinance NaN trailing-bar** — `engine/data_providers.py` `_yfinance_quote_summary`. Analyzing "today"/an in-progress session made yfinance return a trailing NaN-OHLC row, so `last_close` became `NaN` → fake "$NaN" in the decision card + a fabricated number fed into the LLM debate context. Found via `dev-smoke` (`/data/summary?trade_date=<today>` threw `'>' not supported between NoneType and int`). Fix: `dropna(subset=OHLC)` before `.tail()/.iloc`, raise `DataUnavailable` if nothing complete remains. Verified NVDA-today now resolves to the last complete close (205.19 / as_of prior session). Tests: new `engine/tests/test_yfinance_summary.py` (3 cases).
- **Alpaca `period_low` empty-`min()` crash** — `engine/data_providers.py:383,489`. `min(... if b.get("l") is not None)` raised `ValueError` when ALL Alpaca bars had a null low (incomplete/after-hours), crashing the summary silently (swallowed by `_fetch_summary_safe` → data card just vanished). `period_high` (max) was immune. Fix: `min(..., default=0.0)`, preserving the null-skip intent. Tests: 2 added to `test_alpaca_provider.py` (all-null → 0.0 no-raise; mixed → real min).
- **Telegram bot-token leak** — `engine/telegram_bot.py`. httpx error strings embed the request URL `https://api.telegram.org/bot<TOKEN>/...`; that landed verbatim in `_BotStatus.last_error`, which every `/telegram/*` status endpoint serializes to the renderer and logs each poll. Violates the zero-data / secret-safety posture. Fix: `_redact_token()` helper (regex `bot\d+:[\w-]+` → `bot<redacted>`) applied at both `last_error` assignment sites. Tests: 2 added to `test_telegram_bot.py` (hand-built + real `HTTPStatusError` str).

**Review fleet:** 5 read-only Sonnet agents (cost discipline) — engine-core, engine-integrations, renderer, Electron-main, architect/cross-cutting. Each returned file:line + confirmed/uncertain tags; high-impact findings adversarially re-verified against source before acting. Full evidence in `REVIEW_FINDINGS.md`.

**Deferred (NOT auto-fixed) → `REMAINING.md` for founder review:** 1 security hardening (`openExternal` protocol allowlist), 3 renderer UX bugs (held pending a React component-test harness), a confirmed dead-code batch, minor robustness items, doc drift, 2 known sync hazards. Held back deliberately: the dominant overnight risk is *introducing* a regression via unsupervised cleanup; founder wanted to review remaining items anyway.

**Final gates (post-fix):** engine pytest **262** (+7), `dev-smoke` **17/17** (the `/data/summary`-today crash now passes), type-check clean, vitest **15**, prod build clean. Known-flaky `test_concurrent_writes_dont_collide` passed this run (intermittent, environmental).

**Architect stability verdict:** "genuinely clean for a feature-complete v0.1 codebase; the WS `/stream` contract is tight; highest residual risk is the model-picker-vs-cost-catalog sync hazard and the `auth_kind` pipeline gap — neither a production blocker."

**Next session opens with:** founder reviews `REMAINING.md` (small) + `backlog.md` (done). Decide: (1) approve the security + dead-code batch, (2) greenlight React test harness + renderer fixes, (3) Phase 6 Clawless when token is handy. Branch `regression-sweep-2026-06-16` is unpushed; merge after founder review. Doc sweep (backlog reconciliation + CLAUDE.md §6 + memory) also still unpushed on this branch.

---

## 2026-05-29 — v0.1.0 released: full audit + xAI Grok / MiniMax + dev preload-race fix + docs + UI polish

**Goal:** What started as "is upstream stable?" turned into a full v0.1.0 release. Catalog refresh -> native xAI + MiniMax providers -> Telegram parity -> two-reviewer audit pattern -> xAI catalog re-alignment + dev preload-race fix -> v0.1.0 docs + UI polish + canonical marketing screenshot. Eight PRs merged across this session (bridged 2026-05-28 -> 2026-05-29).

**Eight PRs merged (in order):**

- **#5** `9f9f610` (← `61c6542` `feat(catalog): refresh model picker + cost table from upstream v0.2.5`) — adds gpt-5.5, gemini-3.1-flash-lite + cost rows.
- **#6** `f6de57b` (← `0359f15` `feat(providers): add xAI Grok + MiniMax as native LLM providers`) — `XaiAdapter`/`MiniMaxAdapter` subclass `OpenAIAdapter` with fixed class-level `_base_url`; `_strip_think_blocks` helper for MiniMax M2.x inline reasoning; renderer union extended; two secret tiles in Settings.
- **#7** `ed591e9` (← `c51249b` `docs(claude): record founder's PR merge workflow`) — codifies the founder's standing rule: I summarize, founder authorizes, I merge.
- **#8** `68fd908` (← `42d0310` `feat(telegram): offer xAI Grok + MiniMax in the bot provider picker`) — `BotProvider` union + bot picker gain xAI/MiniMax; engine bot needed zero change (routes through `ProviderConfig.from_dict` + `adapter_for`).
- **#9** `a133c6f` (← `433b02a` `fix(catalog): refresh xAI lineup to grok-4.3 + audit hygiene` + `a7ca5d2` `refine(xai): use durable bare grok-4.20 aliases`) — **audit follow-up**. xAI catalog was stale (grok-4-fast-* deprecated 2026-05-15, redirect to grok-4.3). Re-aligned. Cost rows fixed (were wrong in BOTH directions: grok-4.20 over-reserved 5x at $5/$15; the fast row under-reserved on input at $1 vs real $1.25). Catalog-consistency pytest added (cross-checks renderer `PROVIDER_MODELS` against engine `_COST_PER_M_TOKENS`). `_strip_think_blocks` hardened (attribute variants + orphaned-close strip). Stale module docstring + anchor comment fixed. `_extra_headers` isolated per subclass.
- **#10** `786a766` (← `913b8be` `fix(dev): wait for preload bundle before first window load`) — **dev preload-race guard**. `createWindow()` awaits `dist-electron/preload.mjs` before `loadURL` in dev. Closes the cold-boot race where vite-plugin-electron spawns Electron before the preload bundle is written, leaving the window with no `contextBridge` that never self-heals on reload. `waitForPreload` helper + unit tests (present-now / appears-mid-wait / never-appears-timeout).
- **#11** `42b1596` (← `241d81f` `docs: v0.1.0 — document xAI Grok + MiniMax providers + refreshed catalog`) — **docs v0.1.0**. README adds version badge + "What's new in v0.1.0"; xAI Grok + MiniMax + Local LLM added to feature bullet, screenshot caption, architecture Mermaid diagram, provider table; "five adapters" reworded to the actual seven. KB: `configuring-llm-providers.md` 7-provider table + corrected priority order + fixed a stale Gemini default (`gemini-3.0-flash` -> `gemini-2.0-flash`). `faq.md` + `getting-started.md` provider enumerations updated. `desktop/package.json` `0.0.1 -> 0.1.0`.
- **#12** `08766d8` (← `147c51d` `chore(version): bump displayed app version to v0.1.0` + `6b554db` `copy: refresh stale LLM provider tile descriptions` + `fcfbeec` `docs(readme): refresh settings-llm.png`) — **v0.1.0 UI polish**. Version strings on App.tsx footer + Settings About + preload.ts all updated to `0.1.0` (PR #11's package.json bump alone hadn't changed the displayed version, hardcoded separately). Three stale provider tile descriptions refreshed (xAI "fast variants" -> "Grok 4.3 + 4.20"; OpenAI "GPT-4o family" -> "GPT-5 + GPT-4o family"; Gemini "2.0 Flash family" -> "Gemini 2.x and 3.x family"). Canonical `settings-llm.png` (founder's Snagit capture, full provider list, real CONNECTED states, blurred secrets) mirrored to README `assets/screenshots/`.

**Diagnostic discipline (what we learned):**

- Two-reviewer audit pattern (per `feedback_independent_review_pattern.md`) caught the xAI catalog staleness, the catalog-consistency drift gap, and the version-string SSOT gap.
- `WebSearch` + `WebFetch` on docs.x.ai turned around an initial "phantom model IDs" hypothesis: gpt-5.5 / gemini-3.1-flash-lite (GA) / MiniMax-M2.7 are all real and current; only the xAI lineup was stale.
- Founder's "research before changing, hold off if it risks working functionality" instinct prevented a misguided rename of working models.

**Dev preload-race debugging (PR #10):**

- Misdiagnosed twice (HMR transient -> `.cjs` format) before the actual cold-boot race.
- The `.cjs` was a probe artifact: Playwright's `firstWindow()` grabbed the detached devtools window in dev mode, not the app, giving a false "bridge missing" reading. Lesson saved as `reference_electron_dev_debug_gotchas.md`.
- After cleanup + corrected probe, the original `.mjs` preload was confirmed to load fine; the real failure mode was Electron launching before the preload bundle finished writing on a cold first boot.

**Marketing-screenshot workflow established:**

- Founder bought **Snagit** (paid) for marketing captures (full-page scroll-stitch + blur). Standardize on it.
- Three stale provider tile descriptions caught during the screenshot review — would have been enshrined in the canonical asset. Lesson saved as `reference_marketing_screenshot_hygiene.md` (verify in-app catalog references match current state BEFORE capture).

**Cross-product:**

- GSD picked up the site v0.1.0 update — doc-mirror + provider mentions across home / tour / security / family / download / `llms.txt` / metadata. Staged on branch `tal-providers-v0.1.0` at GSD's tree (typecheck + static build green); awaiting founder's Cloudflare preview review + direct go for production.
- Long-scroll / scrollytelling pattern considered for WhisprDesk + family sites, deferred (GSD's SEO investment). Open for new apps. Memory: `project_long_scroll_deferred.md`.

**Live state at session end:** TAL `main` at `08766d8`. Combined-state gates green (pytest 255, type-check, vitest 15, prod build). Dev stack RUNNING at `http://localhost:5173` on cold-booted merged main. Inbox clear.

**Next session opens with:** Check inbox. Check whether dev stack still running (founder mentioned clearing terminal). Check GSD's production-deploy status. Founder's queue likely: Phase 6 Clawless tap, or single-source version-string refactor, or flaky storage test hardening.

---

## 2026-05-23 — Tier 0 stability hardening (engine + desktop) merged + branded FlowStage chart wrapper shipped

**Goal:** Founder asked "what do we need to make Trading Agents more stable." Ran a 3-agent robustness audit, implemented the cheap-but-high-leverage Tier 0 set with tests, smoke-tested with a real local debate, merged via PR. Then implemented the RBJ Global family "branded stage" wrapper on the `/flow` chart (recipe relayed from Global Sites Developer). Also: reviewed the founder's separate AlgoWave project (advised reopen, deferred), registered on ClaudeLink, navigated a shared-working-tree concurrency situation with Global Sites Developer.

**Tier 0 stability (app repo) — PR #1, merged as `ce04eca`:**
- `c97e601` `fix(stability): Tier 0 — crash/hang/cost-cap hardening` (10 files, +402/−26):
  - React `ErrorBoundary` around `<App/>` — render throws now recoverable (the "Settings blank" class).
  - LLM request timeouts — `_LLM_HTTP_TIMEOUT` (cloud, 90s read) + `_LOCAL_HTTP_TIMEOUT` (local, 600s read). The live smoke proved the split is necessary: a 14b Ollama model's agents legitimately exceed 90s; a uniform 90s killed the debate at agent 1 (with SDK retries → ~270s wasted).
  - Telegram debates now `cost_guard.reserve()`/finalize against the global USD caps (they were bypassing them — real money hole).
  - WS `ticker=""` pre-bind (NameError on early disconnect); `fetchWithTimeout` (15s) on 14 unguarded renderer calls; atomic Telegram JSON writes (tmp+fsync+os.replace); SQLite `busy_timeout=5000`.
  - +4 tests (cost-cap block, atomic write, cloud timeout, local timeout). Engine **187 pass**, dev-smoke 17/17, type-check + build clean.
  - Verified with a **real 12-agent local Ollama debate** end to end (BUY@0.80, reservation finalized).

**Branded FlowStage (site repo) — `bed572f` pushed:**
- New `components/flow/FlowStage.tsx` (amber translation of ClaudeLink's MeshStage: dark radial gradient + glow, masked grid, logo watermark, brand lockup). Wraps `<ReactFlow>` transparent, drops `<Background>`.
- Removed `hideAttribution` (no React Flow Pro license) + restyled `.react-flow__attribution` in `globals.css` to blend (founder caught a gray box; fixed).

**Cross-product:**
- Global Sites Developer shares the same local `Trading_agent_site` tree; his SEO commit `045e39b` (16 docs meta descriptions, 25 canonicals, SoftwareApplication JSON-LD, Bing resubmit) fast-forwarded on top of `bed572f`. SEO now fully his (founder decision). Memory: `reference_shared_tree_concurrency.md`.
- AlgoWave reviewed (advised reopen as backtest+paper v1.0; one-directional code firewall vs TAL); founder deferred to next week+. Memory: `project_algowave_sibling.md`.
- Registered on ClaudeLink as **Trading Agents Lab Developer**.

**Next session opens with:** Tier 1–4 stability backlog (engine respawn/watchdog, WS reconnect, retry/backoff, secrets recovery, live_debate failure-path + renderer + storage tests, persist-bot-sessions), OR the AlgoWave `REOPEN_PLAN.md` doc, OR Phase 6 Clawless tap. Verify dev stack off; check inbox.

---

## 2026-05-21 — Telegram polish (v1.2 + v1.3) ships + interactive React Flow lands on the site + ClaudeLink family reciprocal

**Goal:** Continue Phase 8c Telegram work the founder kicked off 2026-05-18, dogfood-iterate-ship the remaining polish, then surface Telegram on the marketing site so it's discoverable from the front door. End-of-day surprise: interactive flowchart prototype (founder excited about it after we discussed Anthropic's "Claude Design" product, which turned out to be Figma-style not React-component-style).

**Outcome:** Phase 8c is fully done. Site has a new interactive `/flow` page, a Telegram section on `/tour`, a homepage Telegram callout, and a ClaudeLink sibling card on `/family`. Six commits across the two repos. Both repos are clean on main, zero processes running.

### Engine + desktop (TAL repo)

All merged in one v1.2 bundle to main as `122c12a`. The branch (`phase-8c-v1.2-oauth-and-full`) was already pushed Tuesday with three commits, founder reviewed via Telegram dogfooding today and gave per-piece feedback that became three additional commits before the merge:

- `1965876` (Tuesday, on branch) — Channels tab (Telegram moves out of Webhooks into its own dedicated Settings tab), full-debate streaming with per-chat `/full` / `/summary` modes (persisted to `telegram_chat_modes.json`), OAuth-for-bot plumbing with `/telegram/refresh-credentials` endpoint + 45-min token refresh interval on the renderer.
- `5b5abc5` (today, on branch) — `setMyCommands` publishes the 6 bot commands so `/` autocomplete works in Telegram.
- `8284ff7` (today, on branch) — Persistent reply keyboard (2x2 grid with friendly labels) + handler normalization back to slash commands.
- `4f684b2` (today, on branch) — Wording fix per founder voice feedback: "Trading Agents Lab is ready. Mode: *summary*..." replaces the awkward "You're already approved" reply on `/start` from operator pings.
- `122c12a` (today) — Merge to main. 183 engine tests + 43 telegram-specific pass; renderer tsc clean.

### Site (Trading_agent_site repo)

Four pushes to site main, all live on `tradingagentslab.ai` via Cloudflare:

- `0349c0a` — `/tour` page gets a new "08 · Channels" section with 6 redacted Telegram screenshots (PII removed: left chat sidebar cropped via Pillow at x=590, real chat_id cropped off the desktop Channels-tab screenshot). Memory SOP at `project_tour_page_refresh_sop.md` extended with canonical Telegram filenames + redaction requirement.
- `41cbf61` — Homepage gains "Run a Diligence from anywhere" section between FlowSection and PostureSection. Surfaces the bidirectional Telegram bot as a differentiator vs the upstream Python terminal.
- `e16f6c5` — `/flow` page: interactive React Flow visualization (`@xyflow/react` v12) of the twelve-agent debate. Auto-loops, click any node for detail panel, canvas locked. Built from scratch in ~400 LOC. Discoverable via homepage "See the flow live" CTA.
- `163d81c` — ClaudeLink reciprocal: new SiblingCard on `/family` + JSON-LD subOrganization entry + one line in `llms.txt` Family section. Per Global Sites Developer FYI.

### Cross-product coordination

- **WhisprDesk SIGTERM cross-app issue from 2026-05-21 morning:** ruled out as TAL-side via static audit on both codebases (all `pkill` patterns are path-scoped to `TradingAgents/...` or absolute to TAL's venv; vite-plugin-electron's tree-kill stays within its own Electron PID; no single-instance lock). WhisprDesk dev confirmed timing (TAL Electron start at 23:30:14 = their SIGTERM exitCode 15) but the kill is environmental — coming from the founder's launch workflow (a shell script he runs to "restart TAL"). Founder is investigating his own script. Nothing for us to fix on either side.
- **ClaudeLink (claudelink.ai) joined the RBJ Global family today.** Global Sites Developer dispatched the canonical copy + asked for reciprocal entries. Bundled with the React Flow push. Reply sent confirming the family graph is now consistent on our end.
- **Global Sites Developer is building a mesh viz on claudelink.ai with the same React Flow stack.** They asked five technical questions after seeing our `/flow` prototype; replied inline with package version (`@xyflow/react` v12), Next 15 static-export gotchas (no `dynamic ssr:false` from Server Components — just `'use client'` and direct import), built-in `animated: true` for flowing edges, custom node TypeScript shape, the module-scope `nodeTypes` footgun, and a layout pitfall I hit on the prototype. All captured permanently in memory `reference_xyflow_react_notes.md`.

### Memory updates

- Created `project_claude_design.md` — what Claude Design (Anthropic, launched 2026-04-17) is and isn't a fit for, so we don't re-evaluate next time.
- Created `reference_xyflow_react_notes.md` — concrete @xyflow/react v12 gotchas under Next 15 static export, for any future family site adding interactive viz.
- Extended `project_tour_page_refresh_sop.md` with canonical Telegram screenshot filenames and the redaction requirement.

### Next session opens with

- Check inbox (`mcp__claudelink__read_inbox`).
- Verify dev stack is off (`ps aux | grep TradingAgents | grep -v grep`).
- Founder's morning queue per his wrap message: "tomorrow on the app itself any items in the backlog." Phase 6 Clawless gateway tap (~4-6 hours) is the largest queued sprint; smaller items from the v1.1 review backlog (WebhookConfig `telegram_bot_token` field, Playwright nav-away regression test, detached sidecar for the Telegram bot) are also fair game.
- Optional: glance at Bing Search Console (was Processing as of 2026-05-18), delete merged Phase 8c branches.

---

## 2026-05-17 (late evening) — Phase 1 closeout v1.0 sprint: 14 commits merged to main + Bing/Google Search Console set up

**Goal:** Founder's brief at start of day: "close phase 1 by end of day today" + "make sure we close phase 1 by end of day today, then talk about phase 2 which we were thinking about a paid plan and license server." Ambitious scope on a feature branch, independent reviews before merge, then site SEO housekeeping.

**Outcome: v1.0 shipped to main.** Merge commit `bd94ea0` on `origin/main`. 14 commits across desktop renderer, Electron main, Python engine, e2e tests, docs. Independent code review (`coderabbit:code-reviewer` subagent) + independent architect review (`general-purpose` subagent) both confirmed merge-ready after 3 pre-merge fixes.

### Sprint chronology

**Morning:** Scoped the work into Tier A (Phase 6 Clawless tap + Settings blank-page bug + Phase 8b multi-ticker batch) + Tier B (polish bundle: Test Connection, Settings persistence, getSession timeout, Legal link). Created feature branch `phase-1-closeout` and pushed empty branch to origin for visibility.

**Mid-morning to lunch:** Settings blank-page bug (`#64`) — not reproducible after fresh dev stack start; founder confirmed clean. Closed task. Phase 8b multi-ticker batch runner shipped (`e6ffea6`) with new `runAnalysis` helper in `desktop/src/lib/run-analysis.ts`. Tier B Legal & Disclaimers link (`4655110`) + em-dash scrub on Settings.tsx.

**Afternoon:** Tier B remaining items — `getSession` 8s AbortController timeout (`56864a8`), Test Connection button with new `POST /llm/test` engine endpoint + 6 mocked pytests (`cd58183`), window-state persistence (`e0fe81d`). Em-dash scrub across all remaining renderer files (`0431a2b`). Analyze.tsx refactor: ~180 lines of inlined request-assembly swapped for the shared `runAnalysis` helper (`067895a`).

**Late afternoon:** Telegram webhook UX surfaced via founder testing — "what does URL mean?" — refactored to Bot Token + Chat ID fields (`5ab767c`). Pinged Clawless Advisor about Phase 6 LLM-proxy RPC + Phase 8c bidirectional Telegram architecture; both answered comprehensively. Phase 6 deferred to v1.1 sprint per founder. Phase 8c queued with full architecture spec captured in memory.

**Evening:** Founder discovered the navigate-away bug — debate WS dies when clicking Watchlist/History mid-stream. Fixed via asymmetric routing in App.tsx (`2f9e9fc`). Founder verified the fix works.

**Late evening (pre-merge):** Independent reviews. Code-reviewer flagged 10 items (2 High, 5 Medium, 3 Low). Architect flagged 6 items (1 Medium, 5 Low + forward-compat notes). Fixed the 3 pre-merge blockers: BatchRunner unmount cleanup (`8a376cd`), testLLMConnection timeout (`b01fcf4`), runAnalysis dispatching `tal:session-complete` + dead `no_provider` variant removed (`addb706`). Queued everything else as v1.1 backlog. Merged to main, pushed.

**End of day:** Site SEO housekeeping. Bing verification file at `public/BingSiteAuth.xml` on the site repo (`f2ac440`). Cloudflare auto-deployed. Founder verified Bing site ownership. Submitted sitemap to Bing (initially submitted the verification file URL by mistake; corrected to actual `tradingagentslab.ai/sitemap.xml`) — Bing Processing. Submitted same sitemap to Google Search Console — Success immediately. Robots.txt + sitemap.xml verified correct (legal pages excluded per family-wide SEO rule).

### Shipped today (commit hashes)

Desktop / engine (all on `main` after merge `bd94ea0`):

```
addb706  refactor(run-analysis): dispatch tal:session-complete from helper, drop dead no_provider variant
b01fcf4  fix(engine-client): 15s AbortController timeout on testLLMConnection
8a376cd  fix(batch): unmount cleanup prevents leaked loops + concurrent re-runs
2f9e9fc  fix(analyze): debate WebSocket survives navigation away from Analyze
e551f4e  docs(backlog): mark Phase 8a/8b done + queue Phase 8c bidirectional Telegram
5ab767c  ui(webhooks): Telegram editor asks for Bot Token + Chat ID, not raw URL
067895a  refactor(analyze): swap inlined request assembly for the shared runAnalysis helper
0431a2b  ui: em-dash scrub across remaining renderer pages + components
e0fe81d  feat(window): persist + restore window bounds across launches
cd58183  feat(settings): "Test connection" button per LLM provider row
56864a8  fix(engine-client): 8s AbortController timeout on getSession
4655110  ui(settings): Legal & Disclaimers link + em-dash scrub + drop stale Phase row
e6ffea6  feat(watchlist): Phase 8b — multi-ticker batch runner
8035398  docs: lock brand-name rendering rule in CLAUDE.md §3   (earlier in day)
```

Site repo (`RBJGlobal/TradingAgentsLab-Site`):

```
f2ac440  chore(seo): add Bing Webmaster Tools verification file
```

### Cross-product coordination

- **Clawless Advisor** (two architecture deep-dives):
  - Phase 6 OpenClaw LLM RPC spec: `sessions.create` → `chat.send` (deliver:false) → poll `sessions.history`, one long-lived `tal-debate-runner` agent per debate conversation. Memory: `project_openclaw_llm_rpc.md`.
  - Phase 8c bidirectional Telegram architecture: outbound long-polling pattern, zero internet exposure, ~4-5 days for parity. Memory: `project_phase_8c_bidirectional_telegram.md`.
- **iLoveMD developer**: replied (FYI) with brand naming + sibling list + family-wide SEO rule for their cross-family footer build. We owe iluvmd.com on our footer in return.
- **Clawless Site Developer**: confirmed brand naming locked overnight ("Trading Agents Lab" three words for readable, compressed for code).

### Verification at end-of-day

- 140/140 engine pytests
- 6/6 Playwright e2e (including the analyze-stub debate stream)
- 17/17 `bash tools/dev-smoke.sh`
- `npm run type-check` + `npm run build` clean
- Founder smoke-tested navigate-away survival manually before authorising merge
- Bing sitemap submitted (Processing). Google sitemap submitted (Success).

### Live state at session end (clean shutdown)

- All TAL dev processes killed at wrap: 0 Electron, 0 vite, 0 engine. Two dock icons came from stale Electron mains; both terminated. Port 5173 free.
- `main` at `bd94ea0` on origin.
- `phase-1-closeout` branch still exists locally + remote; deletable on founder's call.

### Next session opens with

1. `mcp__claudelink__read_inbox` — iLoveMD developer may have followed up; Clawless Advisor may have pinged.
2. Verify dev stack still OFF; restart only if founder wants to use the app.
3. Bing + Google Search Console status check overnight (Processing → Success flip on Bing).
4. **Smallest unfinished item: add iluvmd.com to TAL site footer** (~10 min). Then bigger v1.1 sprints are wide open: Phase 6 Clawless tap (4-6 hr), Phase 8c bidirectional Telegram (4-5 days), or the smaller v1.1 backlog items from the independent reviews (History tal:session-complete listener, Playwright nav-away regression test, e2e pkill PID-file fix, WebhookConfig telegram_bot_token field).

---

## 2026-05-17 (evening) — Em-dash style rule locked universal, rbjglobal subpage brief delivered, "wrap-up" formalised as a trigger

**Goal:** Short maintenance session on the back of yesterday's website day. Founder declared a new style rule mid-session and asked for a structured definition of the "wrap-up" command.

### Three shipments

**1. "No em-dashes anywhere public-facing" locked as universal style rule.**
- Extended what was previously a legal-pages-only rule to all user-visible text across all projects (TradingAgentsLab, Clawless, WhisprDesk, RBJ Global, Clawdemy).
- `CLAUDE.md §3 Marketing / legal` bullet added right after banned-phrasing list. Exempts internal-only files (CLAUDE.md, Handover, WORKLOG, code comments, memory).
- Memory file `feedback_no_em_dashes.md` written and added to `MEMORY.md` index.
- Mechanical scrub: perl with UTF-8 mode hitting U+2014 (em-dash) and U+2013 (en-dash). Hand-tuned where bulk replace fell short:
  - Hero copy on `/` rewritten with parentheses: "Twelve specialised AI agents (analysts, researchers, a trader, risk seats) independently study a stock..."
  - 4 comma-splices patched (period + capital)
  - 5 heading captions converted to colons (`## sessions.db: local debate history`, `## Yahoo Finance: the free default`, `## Privacy: zero data collection`, etc.)
- Build + typecheck clean on site. Static export shape unchanged.
- Commits pushed:
  - `RBJGlobal/TradingAgentsLab`  `5f1a0a1`  19 files (README + 16 KB pages + CLAUDE.md)
  - `RBJGlobal/TradingAgentsLab-Site`  `5bfdc7e`  31 files (all pages + components + re-synced KB)

**2. `/products/tradingagentslab` subpage brief delivered to Clawless Site Developer via ClaudeLink.**
- He asked for project folder paths, 2-3 sentence positioning paragraph, 5 capability beats, disclaimers to name, license posture, primary CTA target.
- Replied with all 6 + banned/approved phrasing reminder + locked "Standalone trading companion for Clawless" framing + "The Diligence" as the multi-agent process brand.
- Capability beats given: multi-agent debate via LangGraph / BYO API keys (incl. local LLMs via Ollama or LM Studio) / Yahoo + Alpaca data / per-session Cost Guard with hard budget caps / webhooks for forwarding to user's own broker.
- License posture given for the subpage: "Free and open source (AGPL-3.0). Runs on the user's own machine." Stage 2 paid binary explicitly excluded from the subpage scope.
- CTA: `https://tradingagentslab.ai/` primary, `github.com/RBJGlobal/TradingAgentsLab` secondary.
- He drafted the subpage end-to-end as `da22f72` on rbjglobal-site main, LOCAL ONLY, awaiting founder's morning review. Founder previews via `bun run dev` then signs off or sends tweaks.

**3. "wrap-up" formalised as a structured close-of-session trigger.**
- Founder defined it explicitly: when he says "wrap-up," do the full structured close (memory sweep + CLAUDE.md update + Handover refresh + WORKLOG prepend + commit + push + inbox check + report), not a generic farewell.
- Added explicit subsection to `CLAUDE.md §4 Session discipline` enumerating the 7-step sequence.
- Saved memory file `feedback_wrapup_command.md`. Supersedes `feedback_session_wrapup.md` (kept for back-reference).

### Commits this session

```
5f1a0a1  docs: remove em-dashes from public-facing copy           (main repo)
5bfdc7e  copy: remove em-dashes site-wide                          (site repo)
```

Plus this WORKLOG + Handover + CLAUDE.md wrap-up sweep about to be committed.

### Cross-product coordination

- Clawless Site Developer: subpage brief delivered → he drafted `da22f72` on rbjglobal-site main → awaiting founder review. He confirmed no em-dashes already enforced on rbjglobal-site (family-wide rule, not just ours now).

### Live state at end of session

- Desktop dev stack state unknown. Left running yesterday for regression testing; today was pure docs work, no app interaction. Confirm tomorrow before starting.
- Cloudflare Pages auto-deploy of `5bfdc7e` lives within a couple minutes of the push.
- `da22f72` on rbjglobal-site LOCAL ONLY pending founder approval.

### Next session opens with

1. `mcp__claudelink__read_inbox`. Clawless Site Developer may have follow-ups.
2. Confirm desktop dev stack state. If killed, restart with `npm --prefix desktop run dev`.
3. Founder's morning review on rbjglobal `/products/tradingagentslab`. Either greenlit (no action TAL-side) or tweaks (fold into ClaudeLink reply).
4. Settings blank-page bug, still queued from 2026-05-15. Founder may have hit it during last night's regression testing → check first thing.
5. Founder regression notes from yesterday's testing become morning queue.
6. Optional, on founder's explicit go: Stage 2 monetization research dispatch (5 questions queued in `project_monetization_roadmap.md`) or OG image generation from Clawless Site Dev's Python script (queued from 2026-05-16 inbox).

---

## 2026-05-16 (late evening, second session) — Marketing+docs website built end-to-end, both repos transferred to RBJGlobal org, monetization roadmap locked

**Goal:** Founder asked for a full marketing + docs website for TradingAgentsLab — brochure-only, AGPL-3.0 educational positioning, teaching artifact quality, distinct personality from the rest of the family. Delivered end-to-end live in one session.

### Website — `RBJGlobal/TradingAgentsLab-Site`

**Stack chosen by coordination with WhisprDesk dev + matching Clawless / RBJ family precedent:**
- Next.js 15 App Router + React 19 + TypeScript strict
- Tailwind CSS v4 CSS-first `@theme` tokens (no `tailwind.config.js`)
- Static export → Cloudflare Pages dashboard Git integration (NOT GH Actions — explicitly deleted the `.github/workflows/deploy.yml` I'd added)
- `react-markdown` + `remark-gfm` + `rehype-slug` + `rehype-autolink-headings` for docs renderer (hand-rolled instead of Fumadocs — v1 simplicity)

**Personality:**
- Dark `#0d1117` + warm amber `#f0a830` + JetBrains Mono headings
- Tagline shape: "AI-driven Diligence on any ticker."
- "The Diligence" branded prominently as the multi-agent process
- Distinct from sister sites: RBJ Global = warm cream + Newsreader serif (anthropic.com vibe), Clawless = B&W anti-corporate, WhisprDesk = royal blue + SF Pro

**31 static routes shipped:**
- `/` — hero, The Diligence demo card, agent flow, capabilities 3-up, posture
- `/how-it-works/` — four-phase breakdown with per-agent descriptions
- `/about/` — positioning lock + Family section with RBJ Global parent hierarchy callout + "you are here" badge on TAL product card
- `/security/` — zero-data-collection posture, network-call disclosure
- `/download/` — build-from-source steps (DMG TBD on Apple Dev cert)
- `/docs/` — sidebar grouping over 16 KB pages synced from `docs/kb/` via `scripts/sync-docs.sh`
- `/legal/{disclaimer,privacy,terms}/` — three-tier SEC-aware copy, em-dash-free per family rule, `robots: noindex` + excluded from sitemap, Travis County TX venue per family precedent

**Cross-product coordination (via ClaudeLink):**
- WhisprDesk dev → full stack handoff (Tailwind v4 patterns, CSP/HSTS, LinkedIn CTA pattern, `metadataBase` gotcha, GH Actions deploy.yml shape)
- Clawless Site Dev → family OG-card generator pattern (Python+PIL, 1200x630, Georgia Bold wordmark, amber accent for TAL); also shipped parent-site coverage on rbjglobal.com (homepage product grid + /products/ + /about/ + JSON-LD subOrganization+sameAs)
- Clawless Advisor → green-lit founder-bio question (founder picked B / defer)

**Independent senior-level audit (CodeRabbit + general-purpose architect, parallel):**
- 3 blockers: SITE_URL `.com` → `.ai` canonical, cross-doc markdown links 404, hardcoded fake price ticker = AI-washing risk
- 1 high: mobile drawer focus management
- All four fixed in `a26c0a4` on the site repo. Medium follow-ups (DocsSidebar active highlight, CSP font-src cleanup, PostureRow dead prop, AgentFlow dead color field, sync-docs stamp) all cleared in `a4abc5b`.

**Deploy + DNS:**
- Cloudflare Pages project `tradingagentslab-site` connected via dashboard Git integration to `RBJGlobal/TradingAgentsLab-Site` main → autobuild on every push, free PR previews
- Both `.com` and `.ai` added as custom domains, certs auto-provisioned
- `.com → .ai` 301 redirect rule deployed on the `.com` zone (NOT the .ai zone — common Cloudflare UI gotcha). Verified with `curl -sI https://tradingagentslab.com/about` → `HTTP/2 301 location: https://tradingagentslab.ai/about`
- `.ai` is canonical (Pattern 1 in our taxonomy)

**Site commits (10 total, all on origin/main):**
```
a4abc5b  chore: audit-pass medium-priority follow-ups
a26c0a4  fix: audit-pass — canonical domain, doc links, fake ticker, drawer focus
257f1f3  ui(nav): proper mobile menu (hamburger + drawer)
4969ec7  ui(family): RBJ Global on top as parent, products underneath
d136743  chore: fix WhisprDesk URL (whisprdesk.com, not whisperdesk.ai)
094e3d6  chore: point LinkedIn link to dedicated TAL company page
460cfbf  chore: drop GH Actions deploy in favour of Cloudflare dashboard Git integration
ab7f38d  chore: repoint repo URLs jaysidd → RBJGlobal
eba0de8  polish: legal page rules + LinkedIn footer link
6131910  init: marketing + docs site scaffold
```

### GitHub org transfer

- Founder created `github.com/RBJGlobal` org (matches LLC name).
- `gh api -X POST repos/jaysidd/TradingAgentsLab/transfer` and same for `-Site` → both repos now under RBJGlobal.
- All hardcoded `jaysidd/TradingAgentsLab` URLs swept across both repos. This repo commit: `738c42f`. Files touched: CLAUDE.md, Handover.md, README.md, backlog.md, docs/kb/getting-started.md (also the upstream copy synced into the site), desktop/electron/menu.ts, desktop/src/pages/Settings.tsx, engine/llm_providers.py (OpenRouter HTTP-Referer), engine/sentiment_sources.py (User-Agent).
- Local remotes already repointed.

### Monetization roadmap locked in memory

`~/.claude/projects/-Users-junaidsiddiqi-Projects-TradingAgents/memory/project_monetization_roadmap.md` is comprehensive. Three stages, license-enforcement design (compile-time `TAL_BUILD_MODE` env-var gate), explicit rejection of Clawless-mirror close-source path, Stage 2 launch sequence triggered by Apple Developer cert approval.

Highlights:
- Stage 1 (current) — free OSS, AGPL-3.0, desktop-only, BYO key
- Stage 2 (~half-day work once Apple cert lands) — 7-day trial → Lemon Squeezy $4.95/mo or $60/yr → signed DMG → license activation → read-only after expiry. **Source stays fully open on GitHub** — paying customers buy convenience, not source access. Pattern source: Clawless team (engage Advisor + Clawless team via ClaudeLink when timing arrives, ~half-day port).
- Stage 3 (later, speculative) — hosted SaaS with free + paid tiers. Requires securities counsel review of the DESIGN before code. Cleanest path: hosted but BYO-key-in-browser.

Per founder direct quote 2026-05-16: *"as far as the license server is concerned, Clawless Advisor is your best bet. And we're going to engage Clawless team because we have already built, polished, and have the design architect ready."*

### Verification at session end

- Site: `npm run typecheck` clean · `npm run build` clean · 31 static routes · ~106 KB First Load JS · live + indexed at tradingagentslab.ai
- Desktop dev stack still running (founder regression-testing); engine logs show successful NVDA Diligence against Alpaca + OAuth gpt-5.4 path
- Both repos all-pushed on `RBJGlobal` org
- 10 site commits + 1 this-repo commit (`738c42f`) shipped today
- Inbox processed (3 messages: WhisprDesk dev twice + Clawless Advisor + Clawless Site Dev twice; all FYIs, no action pending)

### Next-session opens with

1. **Check inbox first** — pattern from CLAUDE.md global instructions.
2. **Confirm desktop dev stack state** — if still running from tonight's session, leave it; if killed, restart with `npm --prefix desktop run dev`.
3. **Settings blank-page bug** — still queued from yesterday, untouched today. If founder hit it during tonight's regression run, debug accordingly. DevTools console approach unchanged.
4. **Founder regression notes** — founder said "continue to regression test." Whatever they surface from tonight's runs becomes the morning's queue.
5. **Possible OG image generation** — Clawless Site Dev's Python script is in inbox. Pick title (recommended: `TradingAgents` per their advisory), pick sub-tagline, generate PNG, drop at `app/opengraph-image.png` (NOT `public/og-image.png` — Next.js convention).
6. **Possible Stage 2 monetization research dispatch** — founder said "research tomorrow." Five research questions queued at bottom of `project_monetization_roadmap.md`.

---

## 2026-05-16 — Brand the multi-agent process "The Diligence"

**Goal:** Founder wanted to name the multi-agent debate process with a trademark-able term that distinguishes from algorithmic trading + the overused "agentic AI" buzzword. Done.

**Decision:** **The Diligence.** Captures institutional "due diligence" — multi-angle vetting before commitment. Trademark-able single word. Verb-friendly ("run Diligence on TSLA"). Shortlisted alternatives rejected: The Floor (cinematic but trades on trading-pit nostalgia), The Symposium / Quorum / Concordance (academic / democratic / esoteric), Polylogue (coined, needs learning), GPT's suggestions (The Neural Floor / Exchange / Syndicate / Nexus / Forge all either dated, generic, off-metaphor, or unownable). Locked in memory: `project_diligence_brand_name.md`.

**UX touches landed (uncommitted, queued for push tomorrow after Settings bug is sorted):**
- `desktop/src/pages/Analyze.tsx` — subtitle now reads "Run **the Diligence** on a ticker — twelve AI agents…"
- `desktop/src/components/DebateStream.tsx` — streaming badge reads "Diligence" not "Streaming"
- `desktop/src/components/DebateStream.tsx` — progress strip footer reads "Diligence in progress · 12s" / "Diligence complete in 54s"

Deliberately NOT touched yet (defer):
- README, docs/kb/* — full brand sweep
- Engine code internals (`live_debate.py`, WS event names like `session.complete`) — keep wire contract stable
- Webhook payload schema field names — same
- Marketing copy / tagline — needs founder eye

**🟡 Open bug — blank Settings page in dev mode.** Founder noticed during a live spin of the Phase 8a build that the Settings page renders as a black blank in dev mode (Vite + Electron). Production build is fine — Playwright e2e suite passes 6/6 including the Settings tab list assertion. Vite serves Settings.tsx with HTTP 200, no compile errors in the dev log, type-check + build both clean. Most likely a runtime exception that React swallows silently.

Founder said "push it anyway, we'll roll back if needed" — so `3480ee8` (Phase 8a) is live on origin/main. Rollback path: `git revert 3480ee8 && git push origin main` (clean, no history rewrite) OR hide just the Webhooks tab by removing the TabDef entry. Both preserve the dispatcher + tests.

Next-session first action: open DevTools in dev mode (Cmd+Opt+I), click Settings, capture the Console error text. That'll point at the exact module / line.

**Picked up next:** (1) fix the blank-Settings bug, (2) push the Diligence UX commit, (3) optionally start Phase 8b (multi-ticker Watchlist batch runner) or Phase 6 (Clawless gateway tap) — founder's call.

**Verification at end-of-session:**
- Memory saved: `project_diligence_brand_name.md` + MEMORY.md index updated
- Type-check clean
- Dev stack torn down cleanly (no orphan engines)
- Branch ahead of origin by 0 commits (Phase 8a pushed; Diligence UX changes uncommitted, in working tree)

---

## 2026-05-15 (continued) — Phase 8a webhooks (Telegram / Slack / Discord / Generic)

**Goal:** Founder-prioritized after morning Playwright work. Push completed debates to user-configured webhooks so daily-driving doesn't require babysitting the app. Locked-positioning answer to broker integration: TAL hands the analysis to user's own systems; execution happens on the regulated platform via the user's own auth.

**Headline shipped (single commit):**

- **feat(webhooks): Phase 8a — Telegram/Slack/Discord/Generic webhooks v1.**
  - Engine: new `engine/webhooks.py` dispatcher. 4 presets — Telegram (Bot API with chat_id), Slack (incoming-webhook), Discord (webhook URL), Generic (full decision JSON + optional HMAC-SHA256). Filter per receiver (action allowlist + min_confidence). asyncio.gather with 5s per-receiver timeout. No retry queue (v1). NEVER logs URLs (Telegram URLs contain bot tokens). 17 hermetic pytests with mocked httpx.
  - Server: WS start frame accepts `webhooks: WebhookConfig[]` + `telegram_chat_ids: {webhook_id: chat_id}`. After persist + before ws.close, dispatches via `webhooks.dispatch_all` and emits a `webhook.report` event with per-receiver fire/filter/fail status. The event NEVER carries URLs (security: URLs leak via History replay otherwise). `_persist_session_safe` now returns the session_id so it can be embedded in the generic payload for correlation.
  - Renderer types: new `desktop/src/lib/webhooks.ts` with `WebhookConfig`, presets, kind labels/hints. Single-blob safeStorage under `webhooks:configs` — URLs + HMAC secrets are sensitive (Telegram URLs embed bot tokens), so OS keychain is the right home. `DebateEvent` union extended with `WebhookReportEvent`.
  - Settings → Webhooks tab: full add/edit/delete UI. Per-kind form (Telegram exposes chat_id; Generic exposes HMAC secret; Slack/Discord just URL). Action checkboxes + confidence slider for the filter. URL field is `type=password` so token-bearing URLs aren't visible at rest. The list view shows hostname only — never the path with the bot token.
  - DebateStream: new "Webhooks" card below the decision card. Compact list with status icon (✓ fired / ○ filtered / ✗ failed) + name + detail (HTTP status or error text). URLs intentionally absent.
  - Analyze.tsx: loads webhooks before WS open, attaches to start frame, builds `telegram_chat_ids` map from configured Telegram receivers.

- **Documentation:**
  - `docs/api.md`: cost.usage renumbered to event #6; webhook.report added as #7; session.complete is now #8. Start frame docs gained the `webhooks` + `telegram_chat_ids` shape.
  - `docs/kb/webhooks.md`: new user-facing page. Telegram setup walkthrough (BotFather → @userinfobot → chat_id), Slack/Discord steps, generic JSON shape + HMAC verification example, Cloudflare Worker broker-bridge illustrative example. Privacy + mechanics + "what v1 doesn't do" sections.
  - KB index updated.

- **Tests:**
  - 17 new pytests in `test_webhooks.py` cover payload shape per kind, HMAC sig math, filter (actions + min_confidence), 2xx/4xx/timeout/exception mapping, parallel dispatch, the URL-leak guard (error string never contains the URL), `from_dict` validation.
  - 1 new Playwright test (`webhooks.spec.ts`) — Settings round-trip: add a generic webhook → save → row visible → click Edit → name+URL still present. Per advisor: we do NOT actually fire a webhook in Playwright (would either spam a real receiver or require a local listener). The 17 hermetic pytests cover dispatch correctness.

**Security posture (load-bearing — keep this in mind for any v2):**

1. **Webhook URLs are SECRETS.** Telegram URL embeds bot token (`/bot<TOKEN>/sendMessage`). Discord URL embeds channel token (`/webhooks/<id>/<token>`). Slack URL embeds team+channel signature. Therefore:
   - Stored via safeStorage (OS keychain), never plain SQLite.
   - Engine never logs the URL — only `[webhooks] dispatched ticker=X fired=2 filtered=1 failed=0`.
   - `webhook.report` event sent over WS carries `{id, name, status, http_status?, error?}` — NO URL field. (Persisted into History along with all other events; URL must never end up there.)
   - Error strings carry the exception type+message, not the URL (mock test asserts this with a token-bearing URL).
   - Settings list view shows hostname only via `URL(url).host`. Edit form uses `type=password` for the URL input.

2. **Locked positioning enforced.** Four presets ONLY. No "Alpaca live trade" / "IBKR order" preset. KB explicitly tells users who want broker bridging to write their own receiver consuming the Generic payload. We are not shipping broker payload shapes even if asked — that crosses the regulatory firewall.

**Verification at end-of-session:**

- 134/134 engine pytests (17 new for webhooks)
- 6/6 Playwright tests (1 new)
- bash tools/dev-smoke.sh 17/17
- npm --prefix desktop run type-check clean
- npm --prefix desktop run build clean
- Dev stack torn down before commit

**Picked up next:** Phase 8b multi-ticker batch runner (Watchlist "Analyze all" button + optional summary webhook) OR Phase 6 Clawless gateway tap. Founder's call.

---

## 2026-05-15 (continued) — Playwright + Electron UI smoke suite

**Goal:** Close the long-carried "UI not click-tested autonomously" gap. Founder explicitly asked for Playwright as the next pickup after the morning's CostGuard polish.

**Headline shipped:**

- **test(e2e): Playwright + Electron smoke suite — 5 tests, ~27s wall-clock.** New `desktop/tests/e2e/`:
  - `launch.spec.ts` — app launches, engine handshake reaches ok, Spend pill flips to ok, LLM pill renders off (no creds in sandbox)
  - `navigation.spec.ts` — sidebar navigates Analyze ↔ Watchlist ↔ History ↔ Settings, hash updates, active item gets `data-active`
  - `analyze-stub.spec.ts` — stub debate end-to-end: click Analyze, button flips to Stop, decision card renders HOLD, History page lists the just-completed session
  - `settings.spec.ts` — all 5 Settings tabs visible (LLM Providers, Data Providers, Clawless, Cost Guard, About)
  - `watchlist.spec.ts` — add AAPL, see row, click Analyze → ticker pre-fills, navigate back, remove
- **Two real bugs surfaced + fixed in the same commit:**
  - `engine/server.py` CORS allowlist was `[http://localhost:5173]` only — production-mode Electron loads `file://`, sending `Origin: null`, so any non-simple request (Content-Type: application/json on GET, PUT, DELETE) got preflight-rejected. Widened to `allow_origins=["*"]` since bearer token + 127.0.0.1 bind are the actual defenses. CORS was just preflight ceremony for an in-process Electron sidecar.
  - `desktop/src/components/StatusStrip.tsx` Spend pill cold-start: first `pollSpend()` fired before engine ready (~2s window of `ERR_CONNECTION_REFUSED`), and the next attempt was 30s away because of the interval. Pill stayed "pending" up to 30s after engine ready. Added the same fast-retry pattern Engine pill uses (1s ticks during 12s grace window, then back off to 30s).

- Added `data-testid` attributes to ~10 stable selectors (StatusStrip pills, nav items, Analyze input/button, Watchlist row, decision card). Without these the tests would target CSS-module-hashed classnames and break every time CSS changed.

- `desktop/package.json`: new `test:e2e` script (`npm run build && playwright test`) and `test:e2e:ui` (interactive Playwright UI mode for debugging).

- `.gitignore`: `desktop/test-results/`, `desktop/playwright-report/`, `desktop/playwright/.cache/`.

**Process notes (carry forward):**

- Workers: 1 — each test launches its own Electron + Python engine; secrets/DB/userData would collide otherwise. Suite is small so single-worker is the right call.
- Sandbox per test: each gets a `mkdtemp` userData dir + `TAL_SESSIONS_DB` so the founder's real keyring + history are untouched.
- Orphan-engine sweep in fixture teardown via `pkill -f "engine/.venv/bin/python -m engine"` — mirrors `electron/main.ts`'s `sweepOrphanEngines`.
- Pre-existing `npm audit` warning: Electron 33.2.1 has a high-severity "ASAR Integrity Bypass via resource modification" advisory. Not introduced by this PR; we'd need to bump Electron major. Out of scope; flag for the Phase 7 distribution prep.

**Verification at end-of-session:**

- 5/5 Playwright tests pass · 117/117 engine pytests pass · `dev-smoke.sh` 17/17 · type-check clean
- All processes torn down cleanly before commit

**Picked up next:** Phase 8 webhooks (founder's call this morning), then Phase 6 Clawless gateway tap.

---

## 2026-05-15 — CostGuard polish: Spend pill in StatusStrip + History sort

**Goal:** Founder asked first-thing what to pick from backlog. Per Handover next-session priorities (daily-driving phase), picked the CostGuard 5/6 + 6/6 polish — two visible improvements he'll see every session, bounded scope.

**Headline shipped:**

- **feat(cost-guard): Spend pill on StatusStrip with mid-stream tick + History sort.**
  - Engine: `live_debate.py` now yields a `cost.usage` event immediately after every `agent.message` with running total tokens + USD estimate. `free=true` for OAuth subscription + local LLM runs (both bill at $0 — pill renders "subscription" / "on-device" inline instead of an alarming static number). Stub-mode sessions never emit it.
  - Renderer: 5th pill in `StatusStrip` ("Spend $0.42 / $5.00"). Polls `/cost-guard/state` on mount + every 30s + immediately + 500ms after every `tal:session-complete` (closes race vs engine's SQLite finalize_reservation UPDATE). Mid-stream tick from `tal:cost-usage` events Analyze dispatches. Colour states: green <50% of daily cap / amber 50-90% / red ≥90%. Disabled-cap mode shows bare daily total with neutral colour.
  - History: sort dropdown ("Most recent" / "Most expensive" / "Ticker A-Z") above the list. Choice persists to `localStorage` (`tal:history:sort`). Tiebreaker is always created_at DESC so two free runs at the same cost don't shuffle between renders.
  - `docs/api.md`: added `cost.usage` event shape between `phase.transition` and `session.complete`. Renumbered.
  - 4 new pytests in `test_live_debate_cost_usage.py` covering: cost.usage after every agent.message, monotonic running totals, free=true for oauth+local with cost=0.0.

**Verification at end-of-session:**

- 117/117 engine pytests pass (4 new for cost.usage)
- `bash tools/dev-smoke.sh` 17/17
- `npm --prefix desktop run type-check` clean
- Dev stack launched cleanly, all pills render on first paint
- Dev stack torn down (no orphans) before commit

**Picked up next:** TBD — daily-driving continues; remaining next-session candidates: Playwright UI tests, Phase 6 Clawless tap, Phase 8 webhooks.

---

## 2026-05-14 — Overnight autonomous block: local LLM + upstream port + KB sweep

**Goal:** Founder asked for local LLM support ("auto-detect Ollama / LM Studio"), then went to sleep. Per his direction, also verified upstream and ported good new features. Three commits, all local — push deferred to morning per CLAUDE.md §4.

**Headline shipped:**

- `2ab4be1` — **Local LLM support (Ollama / LM Studio / generic OpenAI-compat).** Engine: new `LocalLLMAdapter` subclasses `OpenAIAdapter` with instance-level `base_url` override. `ProviderConfig` accepts a third auth branch `{type: 'local', base_url}`. New `engine/local_llm_detect.py` probes Ollama (11434), LM Studio (1234), llama.cpp (8080) in parallel (1.5s timeout each). New `GET /llm/local-runtimes` endpoint. CostGuard treats local sessions as $0 (same path as OAuth) — still hit the rate cap. Renderer: `'local'` added to `LLMProvider` type + `PROVIDER_PRIORITY` (last, so paid keys auto-win). Dual-secret storage (`local:base-url` + `local:model`) via new `lib/local-llm.ts` helper. New Settings → LLM Providers → **Local LLM** section auto-probes on mount + Refresh button, model dropdown per detected runtime, manual entry fallback. 14 new pytests; full engine suite still 113/113.

- `6d514e8` — **Sentiment_analyst grounded in StockTwits + Reddit (port from upstream `0fcf136`).** New `engine/sentiment_sources.py` with `fetch_stocktwits_messages` + `fetch_reddit_posts`. Public no-auth endpoints, polite UA, asyncio.to_thread wrappers. Server pre-fetches in parallel with summary + headlines before live debate. New `SentimentBlock` dataclass; `_format_context` parameterized with `include_full_sentiment` — only the sentiment_analyst's prompt gets the full StockTwits + Reddit blocks; other agents read its conclusion via transcript (research-desk pattern, also keeps prompt budget bounded). Asset-class-aware Reddit routing: equity tickers → r/wallstreetbets / r/stocks / r/investing; crypto → r/CryptoCurrency / r/CryptoMarkets / r/Bitcoin. Sentiment_analyst system prompt rewritten to require quoting ratios + naming specific subreddits, and to explicitly say "data missing" rather than fabricate. 14 new pytests. Live probe against NVDA confirmed both public endpoints return real current data (StockTwits: 5 messages with bull/bear tags; Reddit: real posts from r/wallstreetbets and r/stocks).

- `adc9380` — **KB sweep.** Four new pages: `local-llm.md` (auto-detect, Settings flow, manual entry, performance tips), `cost-guard.md` (TOCTOU reservation, modal flow, spend bars, rolling windows), `crypto-tickers.md` (BTC/ETH/SOL normalization, yfinance vs Alpaca crypto routing, what's NOT supported), `sentiment.md` (StockTwits + Reddit pre-fetch design, why only sentiment_analyst gets full blocks, privacy). Index README updated. `configuring-llm-providers.md` extended to 5 providers + priority order. `data-providers.md` gained Crypto + Sentiment cross-links.

**Upstream check findings (TauricResearch/TradingAgents):**

- 26 commits behind upstream's `main` (v0.2.5 + a few past). Inventory in this session's analysis:
  - **Ported:** `0fcf136` sentiment_analyst + StockTwits + Reddit (above)
  - **Skipped (already covered, out of scope, or against positioning):** Provider catalog refreshes (we maintain our own), new providers MiniMax/GLM/Qwen (out of v1 scope), Ollama upstream work (our local LLM impl is richer with auto-detect across 3 runtimes), env-var overlay (we use Settings UI by design), i18n researchers (English-only scope), reflection alpha benchmark (we don't run reflection cycles), news config (our news layer already reasonable), Docker/CLI/DeepSeek fixes (not applicable to our engine sidecar architecture).

**Verification at end-of-session:**
- 113/113 engine pytests pass (14 new for local_llm + 14 new for sentiment_sources)
- `bash tools/dev-smoke.sh` 17/17 (full backend contract green)
- `npm --prefix desktop run type-check` clean
- `npm --prefix desktop run build` clean (155 KB JS gzipped)
- `/llm/local-runtimes` returns `{"runtimes":[]}` cleanly with no runtime present (empty-detection path works)
- Live probe of StockTwits + Reddit against NVDA returned real current data — both public endpoints alive

## 2026-05-14 (continued) — Founder woke up, smoke + ship cycle

After the overnight block landed, founder daily-tested everything live. Five more commits landed in the afternoon/evening, plus one final polish.

**Headline shipped (this block):**

- `1abf604` — **fix(local-llm): two bugs from live smoke.** (1) Engine's `CostGuardCheckRequest` pydantic model rejected `auth_kind='local'` with 422 (pattern was `(api_key|oauth)$`). Extended to include `local`. (2) Analyze page didn't show a model dropdown when **Local LLM** was the active provider — `PROVIDER_MODELS.local` is empty by design (dynamic per runtime). Wired Analyze to probe `/llm/local-runtimes` on mount/refresh, filter to the saved base_url, and surface those models in the dropdown. Changing the model on Analyze writes back to safeStorage so Settings stays in sync. If the saved model isn't in the live detected list (runtime offline / model uninstalled), it's still surfaced as a seed entry labeled "(last used, runtime offline)" so the dropdown doesn't blank out.

- `1094865` — **feat(icon): Trading Agents Lab app icon — amber compass on dark navy.** Founder generated icon via Grok image gen → Figma reframed to 1024×1024 square PNG with alpha. We generated multi-resolution `.icns` via `sips` + `iconutil`. Wired into `main.ts`: `BrowserWindow.icon` points at PNG, macOS dev mode `app.dock.setIcon(icon.png)` swaps Electron's default for the new mark. Caught a footgun: `dock.setIcon` rejects `.icns` paths — wants PNG-based NativeImage. Both paths kept; the wire-up uses the right one per surface. `.gitignore` updated to whitelist `desktop/build/` (global Python `build/` ignore was hiding icon assets). Design: amber compass needle (decision direction) + white perimeter markers (multi-agent voices) on dark navy rounded square — sister-product family resemblance to Clawless but distinct color (amber vs Clawless green) and metaphor (compass vs C-letterform).

- `ce0207f` — **fix(dev): dock tooltip + Force Quit + Spotlight read "Trading Agents Lab".** Founder noticed dock tooltip still showed "Electron" even though the menu bar said "Trading Agents Lab". Root cause: `app.setName()` only catches the menu bar — Launch-Services-cached surfaces (dock tooltip, Force Quit list, Spotlight) read `CFBundleName` from the vanilla Electron.app's `Info.plist` BEFORE main.ts runs. Fix: `tools/patch-electron-info-plist.sh` patches `CFBundleName` + `CFBundleDisplayName` via PlistBuddy, wired as a `desktop/package.json` `postinstall` so it survives `npm install`. Bails cleanly on non-Darwin (PlistBuddy is macOS-specific) and when electron's binary hasn't downloaded yet. Caveat noted to founder: Launch Services caches stickily even after touch — full effect needs `killall Dock` or a log-out. Founder OK with leaving the cache imperfect since production builds (Phase 7) sidestep this entirely (fresh .app bundle, no cache hit).

- `25bd7e3` — **feat(analyze): streaming progress strip — phase chips + agent counter + live clock.** Founder's 2026-05-09 ask, sharpened by local LLM support (slow models = 5-10 min debates). Sits between News block and phase groups, visible from the first event onward. 4 chips show the debate's phase structure (Analysts/Researchers/Trader/Risk) with done/active/pending states (✓ green / pulsing amber / hollow gray). Footer shows aggregate "X of 12 agents · elapsed/completed in Ym Zs". Live clock ticks every 500ms during streaming, freezes on decision land. Uses existing `pulse` keyframes for single-source-of-rhythm with the streaming pill. AGENTS_PER_PHASE mirrors engine/live_debate.py `_AGENTS` table (no runtime cross-check; both must move together). Founder signed off ("Looks great. I like it.").

**Live testing during this block:**

- Local LLM end-to-end against founder's Ollama (3 models detected: deepseek-v3.1:671b-cloud, deepseek-r1:8b, qwen2.5-coder:14b). After fix `1abf604`, model dropdown works and Cost Guard reserve clears.
- New app icon visible in dock alongside Clawless — clear distinguishability (amber-compass vs green-C). Solves the original founder complaint ("hard to find which Electron app is which when three or four are open").
- Streaming progress strip verified rendering live during NVDA analysis. Phase chips light up left-to-right as expected.

**Strategic context captured this block:**
- Founder is awaiting LLC + Apple Developer Program registration (2-3 weeks) before production DMG builds. Distribution gated on that. Phase 7b launch-prep correctly blocked — perfect timing window for daily-driver UX discovery.
- Founder will daily-drive the app for ~2-3 weeks; expects to surface real usability issues that should drive the next round of polish.

**Verification at session end:**
- All commits type-check clean
- 113/113 engine pytests passing
- `bash tools/dev-smoke.sh` 17/17
- Live UI verified: local LLM + new icon + new progress strip
- Dev stack stopped cleanly (no orphan processes)

**Live state at session end:**
- 8 commits on local `main`, **NOT pushed to origin**. CLAUDE.md §4 push gate respected.
- No background processes running.

**Next session opens with:**
- Founder daily-driving the app — capturing usability notes for the next round.
- Outstanding autonomous-friendly work, in priority order:
  1. **Playwright UI tests** — regression net for daily use; closes the long-carried "UI not click-tested autonomously" gap. Pays back every commit going forward.
  2. **CostGuard 5/6 + 6/6 polish** — spend pill on Analyze header (real-time cost during runs), History page cost column with sort, background TTL sweep cleanup. Closes task #37 thread that's been in_progress forever.
  3. **Phase 6 Clawless gateway tap** OR **Phase 8 webhooks** — both unblocked; founder's call.
  4. **Phase 7b launch prep** — blocked on LLC + Apple Developer Program (~2-3 weeks). Will resume when ready.

---

## 2026-05-09 — Daylong session: docs cleanup → CostGuard → Alpaca → crypto → strategic posture

**Goal:** Continue from yesterday's OAuth wrap-up. Founder authorized a long autonomous block plus interactive testing. By end-of-day: 18 commits shipping CostGuard end-to-end, locked positioning + memory, Alpaca data adapter (Phase 5b), full crypto support (auto-routed by ticker), compact app-shell status strip, tightened SEC-aware disclaimers, and an upstream-check tool.

**Headline shipped (in order):**

- `8c0db38` — **docs:** rewrote README around TradingAgentsLab + refresh KB. Added 3 Mermaid diagrams (system arch, debate pipeline, sequence). Killed the upstream-dominant 358-line README in favor of 99-line Lab-focused content + acknowledgements at bottom. Updated 8 KB pages including `oauth.md` (NEW) — all stale "wiring in progress" / "OpenAI only" claims cleared.
- `0b3bc20` — **CostGuard 1/6:** `engine/cost_guard.py` (DAO + math + dataclasses). Storage schema v1→v2 with in-place ALTER for `auth_kind`. 36 unit tests covering window math, worst-case reservation, OAuth bypass, TTL sweep, crash recovery.
- `d501238` — **CostGuard 2/6:** wire reserve/finalize into `live_debate.py` finally + 4 HTTP endpoints. WS `/stream` reads optional `reservation_id`, auto-reserves on backward-compat path, emits `cost.blocked` event. 15 API integration tests.
- `6e15c8e` — **CostGuard 3/6:** renderer-side reservation gate in Analyze.tsx + `<CostGuardModal>` with 3-second anti-tamper countdown.
- `3ccbd05` — **CostGuard 4/6:** Settings → Cost Guard tab with toggle, USD cap inputs, session rate cap, current-period spend bars (green→amber→red).
- `e96bb30` — **app name:** "Trading Agents Lab" (3 words) for user-facing surfaces. Repo / npm package stay one word.
- `43bd8df` — **CORS fix:** `engine/server.py` `allow_methods` was missing PUT — Settings → Cost Guard save was failing with "Failed to fetch."
- `d8fb196` — **green Connected pill universal:** applied yesterday's convention to every SecretRowItem so any stored key flips to green. Alpaca Live rows show "Stored · Inert" (preserves safety messaging).
- `dcde744` — **Alpaca split-fields:** Settings → Broker now splits Alpaca Paper into Key ID + Secret rows (Alpaca needs both APCA headers).
- `5d73d7c` — **Positioning lock:** founder formally locked analysis-only-no-execution-ever positioning. Removed Settings → Broker tab. Moved Alpaca to Data Providers as "Alpaca Markets — Key ID/Secret". Backlog Phase 5 part 2 marked REMOVED. New Phase 8 (webhooks) added. CLAUDE.md §3 expanded. Memory: `project_positioning_analysis_only.md`.
- `5f2e6e3` — **upstream-check tool:** `tools/upstream-check.sh` reports behind-by count; CLAUDE.md gets weekly cadence rule. Verified at upstream/main HEAD (2 commits past v0.2.4 already in our tree).
- `146933d` — **Phase 5b: Alpaca data adapter end-to-end.** AlpacaProvider hits `data.alpaca.markets/v2/stocks/{symbol}/bars` with `feed=sip` + `end=now-16min`. Auto-routes when keys configured; falls back to yfinance otherwise. Hard-coded base URL (locked positioning safety). 13 unit tests.
- `0ff70e3` — **Crypto support proper path.** New `engine/ticker.py` for symbol normalization (BTC, BTC-USD, BTC/USD all canonicalize). AlpacaProvider gains `_crypto_quote_summary` using `/v1beta3/crypto/us/bars`. YFinance routes crypto via `BTC-USD`. `fundamental_analyst` prompt updated for crypto fundamentals (tokenomics, on-chain, macro). `asset_class` propagates through `data.summary` event to UI. 17 ticker + 2 alpaca crypto tests.
- `517d99d` — **yfinance crypto news fallback:** when Alpaca returns 0 headlines for crypto (sparse outside BTC/ETH), silently fall through to yfinance. Equity path unchanged.
- `fbf226a` — **Compact StatusStrip at app shell.** Founder feedback: 4 bulky cards on Analyze were taking the prime real estate above the debate output. Lifted to 28px row between titleBar and main grid — visible on every page. CustomEvent (`tal:data-provider`) lets per-stream Data routing flow through.
- `b8e395c` — **Disclaimer tightening (SEC AI-washing aware):** three-tier system locked. Tier 1 footer, Tier 2 inline below decision card, Tier 3 page bottom. Memory: `project_disclaimer_language.md` with banned/approved phrasing.
- (this commit) — **Strategic posture + README refresh + wrap-up.** Memory: `project_risk_profile_and_education.md` covering free-OSS, Clawdemy.org integration, zero-data-collection, public-repo-never-includes-broker-code, launch-prep gating items. README updated with crypto, Alpaca, Cost Guard, mission, privacy section, Tier 3 disclaimer. Backlog Phase 7b (launch prep) added. CLAUDE.md §3 expanded with business model + privacy + educational integration.

**Engine logging mid-day:** Added `[ws] OPEN/CLOSE`, `[alpaca] bars/news OK/FAILED/AUTH-FAIL/NON-200/EMPTY`, `[yfinance] bars/news OK/FAILED`, `[yfinance fallback] news OK` log lines for live-monitor visibility. Founder requested per-step progress visibility; we live-tailed engine stderr via Monitor tool through testing.

**Live testing this session (real LLM, all OAuth/$0):**
- Equities through Alpaca: NVDA, AAPL, CRCL, BAC — all clean
- BTC (equity ticker collision — surfaced design gap → backlog item → fixed in 0ff70e3)
- Crypto via Alpaca v1beta3: ETH ($2,329, +6.37%), ADA ($0.2725, +7.29% — sub-dollar 4dp validated), DOGE ($0.1094, +18.21%)
- ADA + DOGE confirmed Alpaca news sparseness for non-major crypto → motivated 517d99d yfinance fallback

**Founder strategic statements captured to memory:**
1. **Locked positioning** — analysis only, no execution code in public repo, even feature-flagged. Webhooks for external broker handoff is the integration model.
2. **Risk profile + education** — free OSS, no monetization (legal counsel before any change), Clawdemy.org case-study integration, zero data collection, brochure-only marketing site, polish to professional standard before public DMG.

**Verification at end-of-day:**
- 100 engine tests pass (cost_guard 36 + cost_guard_api 15 + ticker 17 + alpaca_provider 15 + others)
- `dev-smoke.sh` 17/17
- `npm run type-check` + `npm run build` clean
- Live UI verified across multiple equities + 3 crypto symbols end-to-end

**Next session opens with:**
- 18 commits pushed at end-of-day (founder authorized)
- Live dev stack PID 96112 still running — `pkill -f "engine/.venv/bin/python -m engine"; pkill -f "TradingAgents.*electron"` if not needed
- Most natural next priorities (founder's call):
  1. Phase 7b launch-prep items (ToS, Privacy Policy, Cookie Policy, brochure site, DMG distribution)
  2. KB sweep to add pages for crypto + Alpaca + Cost Guard
  3. Playwright UI tests (originally planned today; deferred for the strategic-posture work that emerged)
  4. Phase 6 Clawless gateway tap or Phase 8 webhooks

---

## 2026-05-09 (continued) — Codex adapter (OAuth → ChatGPT-subscription routing)

**Founder bug report:** OAuth path 429'd with `insufficient_quota`. The OAuth access token was being attached to the standard `/v1/chat/completions` endpoint, which OpenAI treats as a regular API-tier key (and the founder's API quota was exhausted, hence the 429).

**Root cause** (per pi-ai source — `desktop/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js`): subscription-routed Codex requests live at a completely different endpoint family — `https://chatgpt.com/backend-api/codex/responses` — using the OpenAI Responses API shape (not Chat Completions). The reviewer flagged this exact concern as B2 in the previous OAuth commit; we couldn't verify without the founder's token. Now we have the empirical answer.

**Architect protocol:**
- Pre-design advisor: required raw `httpx` adapter first (don't trust SDK transparency for `chatgpt.com/backend-api`), single-commit scope (no test-connection bundling, no streaming UX, no cost-table updates), reviewer-must-check items (account_id required header, error body surfacing, missing-usage-fields handling, OAuth-runs-aren't-per-token-billed log note).
- Implementation followed: hand-rolled httpx adapter using SSE parsing.
- Reviewer pass pending — committing now and going through reviewer in the next chunk so founder has the fix to test immediately. (Will queue any reviewer-flagged items into a follow-up.)

**Shipped:**

- New `engine/llm_providers.OpenAICodexAdapter` — sibling of `OpenAIAdapter`, same `LLMAdapter` Protocol, talks to `https://chatgpt.com/backend-api/codex/responses` instead. All headers replicated from pi-ai's `buildBaseCodexHeaders` + `buildSSEHeaders`:
  - `Authorization: Bearer <oauth_access>`
  - `chatgpt-account-id: <accountId from oauth credentials>` (required — without it, 401)
  - `originator: pi`, `User-Agent: pi (TradingAgentsLab)`
  - `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`, `content-type: application/json`
- Body shape from pi-ai's `buildRequestBody`: `model`, `instructions` (system prompt), `input: [{role, content: [{type: "input_text", text}]}]`, `text.verbosity: "low"`, `include: ["reasoning.encrypted_content"]`, `tool_choice: "auto"`, `parallel_tool_calls: true`, `temperature`, `max_output_tokens` (Responses API uses this, not `max_tokens`), `store: false`, `stream: true`.
- SSE response parser: accumulates `response.output_text.delta` events into a complete message, reads `usage.input_tokens` / `usage.output_tokens` from `response.completed`. Returns the same `(content, in_tokens, out_tokens)` tuple as every other adapter — `live_debate.py` doesn't change.
- Factory routing: `adapter_for(config)` picks `OpenAICodexAdapter` when `config.auth["type"] == "oauth"`, otherwise `OpenAIAdapter`. The api-key path is completely unaffected.
- `account_id` plumbed end-to-end: pi-ai's `accountId` → `oauth-openai.ts` `StoredOAuthCredentials.accountId` → `tradingAgentsLab.oauth.openaiCredentials()` → `Analyze.tsx` → `provider_config.auth.account_id` (snake_case for engine consistency) → `ProviderConfig.from_dict` (accepts both `account_id` and `accountId`) → `live_debate.py` calls `adapter.set_account_id(...)` on the Codex adapter via `hasattr` duck-typing.
- Doc note: cost estimate for OAuth-routed sessions overstates actual cost (subscription billing amortizes; the per-token math is wrong-direction). Founder's billing dashboard is source of truth — we don't try to calculate "free" because the cost is real, just not directly per-call.

**Verification:**
- `npm run type-check`: clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: 17 passed (stub regression preserved)
- Engine boots clean with the new adapter
- `ProviderConfig.from_dict` round-trips `account_id` correctly (both snake_case and camelCase)
- Adapter selection: OAuth → `OpenAICodexAdapter`, API key → `OpenAIAdapter`, Anthropic OAuth still rejected
- **Live OAuth call against the Codex endpoint NOT verified** — founder needs to test with their token. If the request 4xx's with anything other than `insufficient_quota`, header/body shape needs adjustment. Most likely failure modes:
  - `401` — account_id missing or wrong format
  - `400` — body shape doesn't match what Codex expects (most likely culprit: missing/extra field)
  - Model availability error — gpt-4o-mini may not be available on all subscription tiers; founder may need to switch to a model their tier offers
- Reviewer pass queued for follow-up (committing now so founder can test immediately).

**Commit:** TBD.

---

## 2026-05-09 (continued) — Provider selector on Analyze page

**Founder feedback live:** smoke-tested OAuth + Anthropic API key configured simultaneously. OpenAI quota was exhausted but the silent priority resolver kept picking OpenAI; the only way to fall back to Anthropic was to disconnect OpenAI entirely. Bad workflow. Founder asked for a model selector on the Analyze page so the user can pick which provider runs the next debate without disconnecting others.

**Architect protocol followed (advisor before, write, reviewer after):**
- Pre-design advisor: required one entry per provider (NOT splitting OpenAI dual-auth into two dropdown items — that's feature creep), pre-select the resolver's pick on mount with the choice visibly displayed, persist in localStorage with mount-time validation against current credentials, keep state local to `Analyze.tsx` (no context lifting), no explicit "Stub debate" option (debug affordance, not user-facing).
- Reviewer (Sonnet): one strong-recommend (closure-capture race in async `onAnalyze`), three nice-to-haves (a11y label, doc drift in §7, stub-only-option fragility). Race fix applied via `activeProviderRef` + `openaiAuthKindRef` mirrors — same pattern the codebase already uses for `isStreamingRef`/`engineReadyRef`. aria-label on Reset added. Doc drift can travel.

**Shipped:**

- New "Run with" `<select>` between the form row and helper text. All 4 providers shown in priority order (`openai > anthropic > openrouter > gemini`). Configured providers show "{Provider} · {model}"; unconfigured show "{Provider} — configure in Settings" and are `disabled`.
- For OpenAI specifically: when OAuth is configured, the dropdown label reads "OpenAI (OAuth) · gpt-4o-mini". OAuth-vs-API-key resolution stays internal — one entry per provider, advisor's call.
- "Reset" button next to dropdown when a manual override is active. Clears localStorage and falls back to the priority resolver.
- Persistence: `tal:analyze:selected-provider` localStorage key. Mount-time validation: if the saved choice's credentials are gone (key deleted in Settings since last session), `useEffect` clears both state and localStorage so the priority resolver wins on next render.
- Refactored: `activeProvider` is now a `useMemo` derived from `manualProvider` + `configuredProviders` rather than its own state. Single source of truth.
- Race guard: `activeProviderRef` + `openaiAuthKindRef` mirror the resolution state. `onAnalyze` reads from the refs at click-time, so a Settings-driven state change racing with the multiple awaits between mousedown and the WS open frame can't leave the request using stale provider/auth state.

**Verification:**
- `npm run type-check` clean
- `npm run build` clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: 17 passed, 0 failed (no engine-side change in this commit)
- Vite HMR live on the running app — founder will see the dropdown immediately

**Open question queued for founder:** persistence policy. Default is "persist with mount-time validation" — saved choice survives across launches but auto-drops if its credentials disappear. Fine to keep, or want to reset on launch every time?

**Commit:** TBD.

---

## 2026-05-09 (continued) — UX polish: green pill for active connections

**Context:** Founder smoke-testing the live OAuth flow noticed the "Connected" pill on the Settings → LLM Providers row stayed amber (brand accent) instead of flipping to green. Same amber as the disconnected "Recommended" state — no visual confirmation. Status dots elsewhere in the app already use green for the "wired and working" state; the Settings pill needed to match.

**Shipped:**
- `desktop/src/pages/Settings.module.css` adds `.pill_success` (green using `--tal-positive`).
- OAuth row pill flips `pill_default` → `pill_success` on Connected.
- yfinance "Active · default" pill also flipped (same semantic — actively serving).

**Convention now:**
- Green = "this is wired and working right now" (OAuth connected, default data provider serving)
- Amber `pill_default` = brand-accent labels (Recommended, Compatible, API key only) — descriptive, not connection state
- Neutral / red kept as-is

Vite HMR picked up the CSS change with no restart needed — verified by founder.

---

## 2026-05-10 (early hours) — Reviewer fix + JWT plan-tier + lessons doc

**Quiet wrap-up after the long OAuth-debug-loop day.** Founder gave another autonomous block but advisor reframed: building CostGuard or Playwright at 2:30 AM unsupervised is bad — money on the line for CostGuard, no escalation path if Electron Playwright hits the macOS gauntlet. Instead, three small reversible commits and stop.

**Shipped:**

- `f0c8fbb` Analyze: fix Reset leaving activeModel stale. Reviewer pass on c81b1d0 caught a real bug — `onResetOverrides` cleared localStorage and `manualProvider` but never reset the in-memory `activeModel` state. The model-sync useEffect only re-fires on (provider, authKind) changes, so a model-only reset (provider unchanged) silently failed in memory. Fix: snap `activeModel` to recommended explicitly at end of reset, reading provider/authKind via refs (consistent with `onAnalyze`'s pattern).
- `b9c6b3b` OAuth JWT plan-tier detection. Decode `chatgpt_plan_type` from the access JWT at receive time (and on refresh), store in `StoredOAuthCredentials.planType`. Surface as `OAuthStatus.planType` + `isFreeTier`. Settings UI shows plan tier inline ("Connected as ... · plus plan") and a banner if free-tier ("⚠ Codex routing is unreliable on free-tier accounts"). 9-case unit verification of the decoder against synthetic JWTs all pass. Defensive — never blocks login.

---

### Lessons from the OAuth iteration loop (for next session)

The OAuth/Codex chunk shipped 8 commits in ~2 hours of founder-supervised testing. Looking back, 4-6 of those commits were avoidable. Distilling for the next time we integrate against an undocumented endpoint:

**1. Read the working reference implementation in full BEFORE the first commit.**

We had `@earendil-works/pi-ai/openai-codex-responses.js` available locally — it's the working reference for exactly this integration. Today's debug loop followed a "ship → empirical 400 → diagnose → ship" cycle when the cure was a single 30-minute source dive into pi-ai's `buildRequestBody` + `buildBaseCodexHeaders`. After that dive, the body and headers are deterministic; everything else is infrastructure.

The pattern to internalize: **when integrating against an undocumented endpoint where a working reference implementation exists, read the reference's request construction in full FIRST, mirror it exactly, then iterate from there**. Don't ship a partial implementation that's 80% guessed.

**2. Codex backend rejects more parameters than it accepts.**

Empirically learned today (in commit-by-commit order):
- `gpt-4o-mini`: rejected ("not supported when using Codex with a ChatGPT account")
- `gpt-5.1-codex-mini`: rejected (same wording — codex-tuned variants are restricted)
- `temperature`: rejected as unsupported parameter (GPT-5 family is reasoning-tuned)
- `max_output_tokens`: rejected as unsupported parameter (Codex doesn't accept ANY token-limit field)
- Working: `gpt-5.4` model + body matching pi-ai's exact shape (no temperature, no max_output_tokens, with `text.verbosity`, `include`, `tool_choice`, `parallel_tool_calls`, `store: false`, `stream: true`)

For next time: pi-ai's body shape is the contract. Don't add fields it doesn't have.

**3. Plan-tier matters for model availability.**

Per Clawless Advisor B34: codex-tuned variants (`*-codex`, `*-codex-max`, `*-codex-mini`) work on paid tiers but hang/fail on free-tier accounts. Even `gpt-4o-mini` is available on the API tier but rejected on Codex routing. There is no public allowlist — the empirical data is the only reliable source. Curated UI lists must be conservative (general-flagship variants only) with codex-tuned ones as opt-in or excluded.

**4. Engine restart matters whenever the engine code changes.**

Shipped a temperature fix → founder retested → got the SAME error → realized the engine sidecar was a leftover process from before the fix. Vite HMR delivers renderer changes immediately, but the Python engine has to be killed and respawned. **Always communicate "engine restart required" loudly when the fix is in `engine/`** — and in autonomous chunks, kill the engine before declaring the fix verified.

**5. Reviewer's pre-commit warnings are a leading indicator. Heed them.**

The OAuth commit (`ed35277`) shipped with reviewer's B2 ("subscription routing not contractually guaranteed by either pi-ai or this integration") flagged loudly in the commit message. We shipped anyway because we couldn't verify without the founder's token. Founder's first run hit the exact failure that B2 predicted (429 against API tier instead of subscription routing). The reviewer was right; we just didn't have a way to verify. Pattern: **when the reviewer flags something we can't verify, ship with the loudest possible warning AND prepare the most-likely-needed fix in advance** so the iteration loop is one commit instead of five.

**6. Authorization is not a directive.**

Founder offered another autonomous block tonight — generous, but advisor (correctly) flagged that CostGuard at 2:30 AM with money on the line is bad. Stopping at a high-water mark IS a feature. The bias toward "use all the runway" produces reactive cycles like today's OAuth loop. Tomorrow with founder awake = better verification loop, much faster correction cycle, less wasted code.

---

## 2026-05-09 (end-of-day) — OAuth empirical fixes + per-provider model picker

**Founder back from sleep, smoke-tested live OAuth, hit a series of empirical issues with the Codex backend. Fixed each iteratively in tight commits.**

### What founder caught that I didn't anticipate

Reviewer's B2 concern (subscription routing not contractually guaranteed) was the headline gap. Standing it up against the founder's actual ChatGPT account exposed several layered issues nobody had verified:

1. **`/v1/chat/completions` doesn't subscription-route OAuth tokens.** First debate hit `429 insufficient_quota` against the founder's exhausted API tier — not the subscription. Per pi-ai source: subscription routing requires `chatgpt.com/backend-api/codex/responses` (a totally different endpoint family using OpenAI's Responses API shape, not Chat Completions). Built `OpenAICodexAdapter` (`9a09d08`).

2. **Codex backend rejects `gpt-4o-mini`** for ChatGPT-account auth ("not supported when using Codex with a ChatGPT account"). Switched OAuth default to `gpt-5.1-codex-mini` (`6b6a187`).

3. **Codex backend ALSO rejects `gpt-5.1-codex-mini`** with the same error. Switched OAuth default to `gpt-5.4` per Clawless Advisor's recommendation — general flagship variants work reliably, codex-tuned ones are hit-or-miss across plan tiers (`7986ae2`, `bb2d19a`).

4. **Codex rejects `temperature`** as unsupported parameter (GPT-5 family is reasoning-tuned, doesn't expose temperature control). Removed from body — pi-ai also only sends temperature conditionally (`4dbbd25`).

5. **Codex rejects `max_output_tokens`** too. I'd added it as the Responses API equivalent of `max_tokens`; pi-ai's source confirms they DON'T send any token limit field on the Codex body. Removed (`abe37f9`). Output length now bounded by system prompts ("3-5 sentences" / "2-3 sentences") instead of an enforced cap.

6. **`gpt-5.4` finally worked end-to-end.** First successful subscription-routed debate, ~60-90s total session.

### Per-provider model picker

Founder asked for it after step 5: "Why don't we just give users a full list of models available once they sign up… mark recommended… 3-4 latest, no legacy." Built (`c81b1d0`):

- Two side-by-side dropdowns in page header: Provider + Model
- Per-provider curated lists with `recommended: true` flag for default
- OpenAI Codex (OAuth) gets its OWN model list distinct from API-key OpenAI
- Per-(provider, auth) localStorage memory — switching between providers remembers each one's last manual choice
- Race-guarded via `activeModelRef` mirror like `activeProviderRef` / `openaiAuthKindRef`
- Reset clears BOTH provider AND model overrides + per-provider model memories

### Codex model list aligned to founder's actual picker (`2cfa560`)

Founder caught that my list included `gpt-5.4-pro` and `gpt-5.4-nano` — which appear in pi-ai's general OpenAI registry but NOT in the founder's actual ChatGPT Codex picker. Replaced with the 6 models from their picker (verbatim labels + descriptions), excluding the one we'd already confirmed broken.

### Layout fix (`c2a87c7`)

Founder spotted a layout inconsistency: short model descriptions (Anthropic) let the provider row fit beside the title and squeezed the subtitle into a narrow column; long descriptions (OpenAI) wrapped below cleanly. Forced `flex-direction: column` on the page header so layout is deterministic regardless of model description length — title → subtitle → provider row, always stacked.

### Clawless Advisor delivered both pinged questions

Got back at 07:10 with two detailed answers (~600 lines of design surface):

**OAuth model availability:** plan-tier-dependent. Codex-tuned variants require additional authorization scopes beyond standard OAuth + chatgpt-account-id. Free-tier accounts hit silent failures. Their fix: decode the OAuth JWT at receive-time, store `chatgpt_plan_type`, demote Codex provider in priority order for free tiers. Filed for tomorrow.

**CostGuard pattern:** full design handed over. SQLite-backed config + state at `costguard_config_v1` / `costguard_state_v1`. TOCTOU reservation pattern for race safety (5-min TTL). IPC surface: `getState/updateConfig/recompute/check/complete`. Modal override UX with anti-tamper. **Global budget**, not per-provider. **OAuth naturally skips** because subscription `usage.cost === 0`. Suggested extension: stacked daily/weekly/monthly caps + rate-cap dimension for OAuth (rate-cap because cost-cap doesn't apply). Fully scoped — ~3h chunk.

### Verification

- `npm run type-check`: clean across every commit
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: 17 passed throughout
- **First end-to-end live OAuth debate succeeded** with `gpt-5.4` (founder confirmed)
- Subscription routing claim awaiting OpenAI billing dashboard confirmation by founder

### Tomorrow's queue (founder authorized unsupervised work)

Founder explicitly said *"do not worry about tokens, I have enough tokens for this week"* and queued:

1. **CostGuard + budget caps** (Clawless Advisor pattern, with stacked daily/weekly/monthly + OAuth rate-cap)
2. **Playwright testing** — set up Electron Playwright driver, add UI smoke tests, finally close the "UI not click-tested autonomously" gap
3. **JWT plan-tier detection** in OAuth handler (small, defensive)
4. **Reviewer pass on the model picker** (skipped earlier in the rush)

Founder's policy directive on cost calculation — important: *"When user is using OAuth, you do not want to calculate cost. It's going to be zero. When user is using API, if model selection is via API, then you collect token cost."* Aligns with Advisor's pattern (`usage.cost === 0` for subscription paths means cap naturally skips).

**Commits today (in chronological order):**

```
75d020e  Phase 2.1-light: real-LLM debate via sequential OpenAI calls
7dbbeff  SQLite session storage + user-facing knowledge base
d736e6e  History page: list + detail of persisted debates
4b88894  Watchlist page: SQLite-backed tickers + deep-link
7fcbefa  End-of-block: reconcile architecture.md §7 + refresh inbox
8a9526b  Multi-provider: Anthropic + OpenRouter + Gemini
d8d3585  Doc sync: backfill 8a9526b hash + Advisor OAuth deferral
ed35277  OpenAI OAuth (Codex) via @earendil-works/pi-ai
8053245  Doc sync: backfill ed35277 hash
bdc1716  UX: green pill for active connections
27f138e  "Run with" provider dropdown + localStorage persistence
6b6a187  OAuth default model + dropdown moved to header
9a09d08  Codex adapter: route OAuth via chatgpt.com/backend-api
4dbbd25  Codex: drop temperature
c81b1d0  Per-provider model picker
7986ae2  Switch default Codex model to gpt-5.4 (unblock)
bb2d19a  Codex models: drop codex-tuned variants (Advisor)
abe37f9  Codex: drop max_output_tokens
2cfa560  Codex models: align with founder's actual picker
c2a87c7  Analyze: stack header vertically
```

**20 feature commits today.** All type-check + smoke clean. **First end-to-end live LLM debate succeeded** — biggest milestone.

---

## 2026-05-09 (continued) — OpenAI OAuth (Codex / subscription path)

**Goal:** Founder explicitly stated they prefer routing through their ChatGPT subscription rather than per-token billing. Wire OAuth alongside the API-key path that shipped in `8a9526b`. Per Clawless Advisor's pattern reply (received 01:33 — they did the code dive after founder bumped priority), the heavy lifting belongs to a third-party MIT-licensed package (`@earendil-works/pi-ai`) that handles PKCE + browser callback + token exchange internally.

**Architect protocol followed:**
- ClaudeLink consult with Clawless Advisor for OAuth pattern reference. Detailed reply with five gotchas (port 1455, silent browser callback, `shell.openExternal` quirks, token expiry timestamp units, subscription routing).
- Pre-design advisor: required discriminated-union wire shape (not muddled `api_key`-as-Bearer-slot), single-key JSON-blob storage in `safeStorage` (not three keys), no DIY refresh loop (use pi-ai's primitive), `npm view` verification before installing, scope kept to OAuth wiring only (no test-connection bundling).
- pi-ai package verification: `@mariozechner/pi-ai` is **deprecated** with forward-pointer to `@earendil-works/pi-ai@0.74.0` (same MIT license, fresh fork by same authors). Switched to maintained namespace before installing.
- Code reviewer (Sonnet) on the working tree pre-commit. **Two blocking issues + three strong-recommends + four nice-to-haves** flagged. All addressed before commit.

**Reviewer fixes applied:**

1. **B1 — `setTimeout` orphan that wedges next login.** pi-ai calls `onManualCodeInput` unconditionally at flow start (not only on browser-callback failure). The 20s timer kept running post-success and stomped `pendingPromptResolver` after the `finally` reset, blocking subsequent login attempts until app restart. Fix: capture `timer` ID in an `activeFallbackCleanup` closure, `clearTimeout` from the outer `finally`. Reviewer's deterministic app-restart-required bug — caught + fixed before commit.
2. **B2 — Subscription-plan routing was unverified.** Reviewer dug into pi-ai source: `loginOpenAICodex` issues against `auth.openai.com` with `client_id: "app_EMoamEEZ73f0CkXaXp7hrann"` and `offline_access` scope. Whether OpenAI routes the resulting token through ChatGPT subscription or bills per-token is account-configuration-dependent and not contractually guaranteed by either pi-ai or our integration. Documented loudly: Settings UI text now reads *"verify with a low-cost model first and check your billing dashboard before relying on this for cost savings"*; status hint dropped the "(subscription)" qualifier; architecture.md §5 calls out the verification gap; commit message reproduces the warning.
3. **SR1 — `secrets:get` IPC could expose raw OAuth JSON.** Renderer-side convention prevented this in practice (Settings only calls `oauth.openaiStatus`), but the `secrets:get` handler accepted any key including `oauth:*`. Hardened: handler returns `null` for any `oauth:`-prefixed key. OAuth tokens flow via the dedicated `oauth:openai:credentials` bridge that auto-refreshes before returning, never via `secrets:get`.
4. **SR2 — refresh-token race.** OpenAI may issue single-use refresh tokens; concurrent `refreshIfNeeded` calls would race and force re-login. Added module-level `refreshInFlight: Promise<...> | null` mutex so concurrent callers share one in-flight refresh. pi-ai doesn't export `refreshOAuthTokenWithLock` so we implement the lock locally.
5. **SR3 — stale Settings copy.** OpenAI API-key row still read "OAuth lands in a follow-up commit." Updated to "OpenAI (API key fallback)" with note that OAuth wins above when both are configured.
6. **N1 — `email` field doesn't exist on pi-ai response.** pi-ai returns `accountId` (UUID), not `email`. `toStored` updated to extract `accountId` and surface as "account abc-123…" prefix in the UI. Falls back gracefully when neither is present.
7. **N3 — NOTICE author attribution.** Removed "Armin Ronacher" since the installed package only confirms Mario Zechner via `package.json` author field; no LICENSE file ships in the npm tarball. Wording now reflects what's verifiable.
8. **N4 — neutral copy.** Removed "(subscription)" qualifier from the Analyze status hint.

**Architecture choices:**

- **Wire shape (discriminated union):** `provider_config.auth = {type: "api_key", api_key} | {type: "oauth", access, refresh, expires}`. Engine has a `bearer_token` accessor that collapses both into one string for the `Authorization: Bearer …` header; adapters never branch on auth shape. Old `{api_key: ...}` top-level is still accepted for back-compat with stale renderer builds.
- **OAuth-only-for-OpenAI:** the engine rejects `{type: "oauth"}` for any non-openai provider at `from_dict` time, falling through to the stub. Anthropic OAuth stays banned per their TOS.
- **Storage:** single `oauth:openai` secret key with the credential JSON inside the cipher field (not three keys per advisor's recommendation). One decrypt per check; one delete clears all OAuth state.
- **Renderer priority:** when both OAuth tokens AND an API key are stored for OpenAI, OAuth wins (founder's stated preference). Surfaced in the LLM status hint. User-facing override is Phase 7 polish (commented in code).
- **Token confinement:** access/refresh tokens never enter renderer React state. `getOpenAICredentialsForRequest()` is called just-before-WS, attaches the access token to the start frame, returns. Main process is the only place tokens persist.

**Shipped:**

- Engine: `engine/llm_providers.py` `ProviderConfig` rewritten as discriminated-union dataclass with `bearer_token` + `auth_kind` accessors. `from_dict` accepts both new + legacy shapes. `engine/live_debate.py` calls `adapter.open(api_key=config.bearer_token)` and logs `auth=auth_kind` in the per-session stderr line.
- Renderer client: `desktop/src/lib/engine-client.ts` `ProviderConfig.auth` is a TypeScript discriminated union; `streamDebate` threads it into the start frame.
- New: `desktop/electron/oauth-openai.ts` — `OpenAIOAuthService` wrapping pi-ai. Friendly error mapping (port 1455, network, timeout). Single-flight refresh mutex. Cancel-on-success for the manual-paste timer.
- New: `desktop/src/lib/oauth.ts` — typed renderer wrapper for the OAuth bridge.
- `desktop/electron/main.ts` — IPC handlers `oauth:openai:start/status/disconnect/prompt-response/credentials` + event channels `oauth:openai:progress` / `:prompt`. `secrets:get` blocks `oauth:` prefix.
- `desktop/electron/preload.ts` — `tradingAgentsLab.oauth` bridge.
- `desktop/src/vite-env.d.ts` — types for the new bridge surface.
- `desktop/src/pages/Settings.tsx` — `<OpenAIOAuthRow>` above the LLM-providers list. Connect / Disconnect, status display, manual-paste fallback UI, friendly error surface. API-key row reframed as "fallback".
- `desktop/src/pages/Analyze.tsx` — priority resolver: OAuth wins over API key for OpenAI. Just-in-time credential fetch via `getOpenAICredentialsForRequest()` (silent refresh inside 60s expiry window).
- `engine/requirements.txt` unchanged (engine doesn't speak to pi-ai). `desktop/package.json` adds `@earendil-works/pi-ai@^0.74.0`.
- `NOTICE` adds the pi-ai MIT attribution under a new "THIRD-PARTY DEPENDENCIES" section.
- `docs/api.md` updates the WS start-frame documentation to reflect the new `auth` discriminator + back-compat note.
- `docs/architecture.md` §5 updates to describe the OAuth flow and the verification caveat.

**Verification:**
- `npm run type-check`: clean
- `npm run build`: clean (main.js bumped 8 KB → 479 KB to bundle pi-ai's transitive deps; Electron main process only — no renderer impact)
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: **17 passed, 0 failed** (back-compat shape preserved end-to-end)
- Direct unit verification of `ProviderConfig.from_dict` for both shapes + rejection cases (oauth-on-anthropic, empty access, unknown auth type, bogus bearer_token)
- Engine boots clean with the new module
- **Live OAuth flow NOT smoke-tested in this autonomous session** — there's no browser, no founder paste-back, no real OpenAI account. The pi-ai integration is verified by type-check + back-compat smoke + IPC handler registration; the actual "click Connect → browser opens → paste code → token round-trips → live debate uses the OAuth bearer" flow only verifies in the founder's window.
- **Subscription-plan routing claim is account-configuration-dependent** and unverified by either pi-ai or TradingAgentsLab. Founder must verify with a low-cost call + check OpenAI billing dashboard.

**Commit:** `ed35277`.

---

## 2026-05-09 (continued) — Multi-provider live debate (Anthropic, OpenRouter, Gemini)

**Goal:** Founder confirmed they have keys for OpenAI, Anthropic, OpenRouter, Google Gemini (no DeepSeek). Wire all four through one shared `LLMAdapter` abstraction so the live debate path isn't OpenAI-only. Reviewer required this be ONE commit (not three) so the abstraction itself is the review surface.

**Architect protocol followed:**
- ClaudeLink ping to Clawless Advisor for OpenAI OAuth pattern (replied-when-convenient).
- Pre-design advisor consult: required one commit, dictated `LLMAdapter` Protocol shape, said cost caps stay in `live_debate.py` not adapters, said remove DeepSeek from Settings (no engine wiring → bad UX), conservative cost numbers with "as of 2026-05-09" comment.
- Reviewer agent (Sonnet) on the working tree pre-commit. Two functional issues + three doc drifts + several nice-to-haves. All addressed before commit.

**Reviewer fixes applied:**
1. **Adapter resource leak on `WebSocketDisconnect` mid-stream** — `live_debate` wrapped in `try/finally`; `adapter.close()` runs even when `GeneratorExit` is thrown by FastAPI. Logs disconnect reason + agents-completed count to stderr.
2. **`/health.live_default_model` was hardcoded "gpt-4o-mini"** — replaced with `live_providers` (allowlist) + `live_default_models` (per-provider dict).
3. **`docs/api.md` three stale lines** + `docs/architecture.md` §5/§7 stale passages — all updated to reflect 4-provider reality.
4. **Gemini `resp.text` raises `ValueError` on safety-blocked candidates** — wrapped in `try/except` with `[gemini blocked: ...]` fallback so the engine's outer error handler turns it into a clean debate event instead of a SDK stacktrace.
5. **`session.complete.provider` not persisted** — added `provider` column to `sessions` table with in-place `ALTER TABLE` migration for existing DBs (additive, schema_version stays at 1). `SessionSummary` + `SessionDetail` carry it; History row pill + detail pill show "Live · provider · model".

**Architecture choices:**
- `LLMAdapter` is a `Protocol` (structural, not nominal). Four implementations: `OpenAIAdapter`, `OpenRouterAdapter` (extends OpenAI with `_base_url` + `HTTP-Referer`/`X-Title` headers), `AnthropicAdapter` (`AsyncAnthropic`, system prompt at top level not in messages, content block list joined defensively, `usage.input_tokens`/`output_tokens`), `GeminiAdapter` (uses maintained `google-genai`, NOT deprecated `google-generativeai`; sync client wrapped in `asyncio.to_thread`; `system_instruction` as config field; `usage_metadata.prompt_token_count`/`candidates_token_count`).
- `ProviderConfig.from_dict` extended allowlist: `{openai, anthropic, openrouter, gemini}`. `_MAX_TOKENS_HARD_CAP = 800` clamps any caller's request — defense in depth.
- Cost rate table moved to `llm_providers._COST_PER_M_TOKENS` with "As of 2026-05-09. Refresh annually" comment. OpenRouter passthrough has no rate entries (cost depends on the underlying model — surfaces as $0.00 in the UI).
- `default_model` per provider: `gpt-4o-mini` / `claude-haiku-4-5` / `openai/gpt-4o-mini` / `gemini-2.0-flash`. Cheap defaults, founder can override per key by setting model in their config.
- `live_debate.py` import-time assertion: `len(_AGENTS) == MAX_AGENTS_PER_SESSION` — drift fails on import.
- `PROVIDER_PRIORITY` in renderer: openai > anthropic > openrouter > gemini. First-configured-key wins. Surfaced in LLM status card.

**Removed:**
- DeepSeek from `Settings.tsx` LLM Providers tab. Founder doesn't have a key, no engine wiring planned. Bad UX to ship configurable-with-no-engine. 5-line restore if a key appears later.

**Verification:**
- `npm run type-check`: clean
- `npm run build`: clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: **17 passed, 0 failed** (stub regression preserved end-to-end; sessions migration works on fresh + existing DBs)
- Direct storage round-trip of `provider` field verified outside the smoke
- Provider rate table cost estimate sanity-checked at import

**Commit:** `8a9526b`.

**Clawless Advisor reply (received 2026-05-09 01:21):** OAuth substance deferred to founder's morning audit — Advisor doesn't have direct working knowledge of Clawless's OpenAI OAuth pointers and won't pull clawless-developer off the launch-blocker (~5 days to GA on Clawless v5). Will surface back to me when founder picks which OAuth path to mirror (OpenClaw-engine vs Clawless-wrapper). Validates the multi-provider-first sequencing — "build all three API-key paths cleanly first; the OAuth path will land cleaner on top of stable API-key plumbing." Anthropic + OpenRouter share the `messages` API shape; Gemini is the outlier (different shape + `x-goog-api-key` header). All three already shipped in `8a9526b`.

---

## 2026-05-09 (continued) — Watchlist page + dead-code cleanup

**Goal:** Replace the ComingSoon Watchlist placeholder with a real, SQLite-backed page that lets the founder track tickers and one-click into Analyze. Per advisor, this is a separate commit from History.

**Architect protocol followed:**
- Skipped pre-design advisor (constrained shape: add/list/remove + a deep-link).
- Reviewer agent (Sonnet) on the working tree pre-commit. Verdict: "Ready to commit, with follow-ups." 3 strong-recommends + 1 cosmetic — all four addressed in the same commit.

**Shipped:**

- Engine: `engine/storage.py` adds `watchlist` table to the schema DDL (additive — schema_version stays 1, `IF NOT EXISTS` covers in-place upgrades), `WatchlistEntry` dataclass, `list_watchlist`, `add_watchlist` (raises `WatchlistConflict` on duplicate via narrow `IntegrityError` mapping), `remove_watchlist`. `engine/server.py` adds `GET /watchlist`, `POST /watchlist` (409 on duplicate, 400 on empty-after-strip, 422 on Pydantic length violation), `DELETE /watchlist/{ticker}` (404 on missing). `WatchlistAddRequest` Pydantic model with `max_length=8` ticker + `max_length=200` note.
- Renderer: `desktop/src/lib/engine-client.ts` adds `WatchlistEntry` type + `listWatchlist`, `addWatchlist`, `removeWatchlist` typed wrappers. 409 surfaces as a friendly "already on the watchlist" error.
- Renderer: `desktop/src/pages/Watchlist.tsx` + `Watchlist.module.css` — add-ticker form (auto-focus on mount + refocus after success), card-style row list with ticker + relative timestamp + optional note, primary "Analyze" button per row, secondary "Remove" with confirm. Empty state guides user to add a ticker.
- Renderer: `desktop/src/lib/handoff.ts` (NEW) — exports `PENDING_TICKER_KEY`, `setPendingTicker`, `consumePendingTicker`. Both Watchlist and Analyze import from here so the constant doesn't drift.
- Renderer: `desktop/src/pages/Analyze.tsx` — uses `consumePendingTicker()` in the initial-state initializer to honor a watchlist hand-off. Aligned `maxLength` from 6 to 8 to match the engine's accepted range.
- Renderer: `desktop/src/App.tsx` — `<Watchlist />` replaces `ComingSoon` on the `'watchlist'` route. Removed the `ComingSoon` import (now unused).
- Cleanup: deleted `desktop/src/pages/ComingSoon.tsx` and `ComingSoon.module.css` — no remaining usages now that all four routes have real pages.

**Reviewer fixes applied:**

1. `docs/api.md` — added full documentation for the three new watchlist endpoints (request/response shapes, status codes, CORS note).
2. `tools/dev-smoke.sh` — extended from 12 to 17 assertions. Added `POST /watchlist` accept, 409 on duplicate, GET shows the ticker, DELETE returns 200, second DELETE returns 404.
3. `desktop/src/lib/handoff.ts` — extracted to remove the cross-file constant duplication between Watchlist and Analyze.
4. `Analyze.tsx` ticker `maxLength` aligned 6 → 8.

**Verification:**
- `npm run type-check`: clean
- `npm run build`: clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: **17 passed, 0 failed**

**Commit:** `4b88894`.

---

## 2026-05-09 (continued) — History page

**Goal:** Replace the ComingSoon placeholder with a real History page that reads from the SQLite session storage shipped in `7dbbeff`. Per advisor, this is its own commit + reviewer pass — separate from the engine layer and the Watchlist that comes next.

**Architect protocol followed:**
- Skipped pre-design advisor (paved path: list view + detail view + delete, types are dictated by `docs/api.md`).
- Reviewer agent (Sonnet) on the working tree pre-commit. Verdict: "Ready to commit" with one race condition (rapid row clicks) and one backlog note (no fetch timeout).
- Race condition fixed via generation counter; timeout queued in backlog as Phase 7 follow-up.

**Shipped:**

- New: `desktop/src/pages/History.tsx` (~250 LoC). Two-view state machine: `'list'` and `'detail'`. List shows newest-first session rows with ticker, action pill (BUY/SELL/HOLD color-coded), confidence %, live/stub badge, relative timestamp, est cost, two-line clamped reasoning. Empty state guides the user to the Analyze page. Stat strip across the top: total sessions, live count, stub count, total live cost. Detail view: header with Back + Copy transcript + Delete buttons, ticker/date summary block with live/stub pill + cost meta, and the full debate replayed via the existing `DebateStream` component (with `isStreaming={false}`).
- New: `desktop/src/pages/History.module.css` (~330 LoC). All styles use the existing token system. Action pill variants for buy/sell/hold. Row hover lifts border-color to amber.
- Updated: `desktop/src/lib/engine-client.ts` — added `SessionSummary`, `SessionDetail` types matching `engine/storage.py` field-for-field; new `listSessions`, `getSession`, `deleteSession` typed wrappers; expanded `HealthInfo` to include `live_supported`, `live_default_model`, `storage_path`.
- Updated: `desktop/src/App.tsx` — swapped `<ComingSoon ...>` for `<History />` on the `'history'` route.

**Reviewer fixes applied:**

- Race condition: rapid row clicks could let a slow earlier fetch land after a faster later one, stomping the UI with the wrong session. Added a `detailGenRef` generation counter; `onOpen` increments and only commits the result when its generation matches the latest. Same guard on the error path.

**Verification:**
- `npm run type-check`: clean
- `npm run build`: clean
- Engine smoke (12/12) preserved (no engine changes in this commit)

**Commit:** `d736e6e`.

---

## 2026-05-09 (continued, third autonomous block) — SQLite session storage + parallel KB

**Goal (storage chunk):** Persist completed debates so the History page (next chunk) and any future analytics have something to read. Per advisor, ship the engine layer alone first; History UI is a separate commit.

**Architect protocol followed (advisor before, write, reviewer after):**
- Pre-design advisor consult: said skip the design call ("paved path"), specified schema, file location (`<repo>/data/sessions.db`), env override (`TAL_SESSIONS_DB`), and the must-include endpoints (list / get / delete). Followed verbatim.
- Implementation: `engine/storage.py` (220 LoC) + 3 endpoints in `server.py` + best-effort write-on-stream-end + extended `tools/dev-smoke.sh` from 8 → 12 assertions.
- Code reviewer (Sonnet) caught 1 blocking issue (missing `DELETE` in CORS allowlist) + 3 strong-recommends (decision dict guard, docs/api.md drift, style consistency). All 4 fixed before commit.

**Shipped:**

- New: `engine/storage.py` — versioned-schema SQLite layer. WAL mode, atomic file create, hard-fail on schema-version-newer-than-supported. Public surface: `write_session`, `list_sessions(limit, ticker)`, `get_session(id)`, `delete_session(id)`, plus `db_path()` for `/health` to surface. ULID-style ids (millisecond epoch + 8 random bytes hex). Best-effort everywhere — every public function returns gracefully on errors and logs to stderr; the WS handler treats persistence as non-blocking.
- Updated: `engine/server.py` — captures the WS event sequence in memory while streaming, calls `_persist_session_safe` after `session.complete` (skips write entirely on aborted streams). New endpoints: `GET /sessions?limit&ticker`, `GET /sessions/{id}`, `DELETE /sessions/{id}`. CORS `allow_methods` now includes `DELETE`. `/health` gains `storage_path` field.
- Updated: `.gitignore` — adds `data/` so user session data never gets committed.
- Updated: `tools/dev-smoke.sh` — extended from 8 to 12 assertions covering the full sessions round-trip (list → get-by-id → delete → 404 verification).
- Updated: `docs/api.md` — full documentation of the three new endpoints + `/health.storage_path` + persistence model section. Removed the stale "session manager + persistence is Phase 7" line.

**Parallel knowledge base (`docs/kb/`):**

A documentation specialist sub-agent (Sonnet) built 11 user-facing KB files in parallel while this storage chunk was implemented. Files are cross-linked, voice is educational/calm, posture is locked ("educational + paper trading"). The agent caught one bug — the original `reading-the-debate.md` referenced a fabricated "Analyzing…" button label state; corrected against the real `Analyze.tsx` ternary. Also flagged that `docs/architecture.md` §7 lists Gemini/xAI/Qwen/GLM as LLM providers but `Settings.tsx` only ships OpenAI / Anthropic / DeepSeek / OpenRouter — needs reconciliation in a follow-up.

**Verification:**
- `npm run type-check`: clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: **12 passed, 0 failed** (was 8/8 — added 4 new assertions for sessions round-trip)
- KB files manually inventoried; all 11 present and linked

**Commits:** `7dbbeff` (storage + KB combined).

---

## 2026-05-08 (continued, third autonomous block) — Phase 2.1-light real-LLM debate

**Goal:** Replace the canned stub debate with real OpenAI calls when a key is configured. Keep the stub path as the default so the demo still works without one. Per advisor design review, ship the *minimal own-prompts* implementation rather than a full upstream-graph wrapper — smaller blast radius, controllable cost, debuggable.

**Architect protocol (advisor before, write, reviewer after):**

- Pre-design advisor consult: scoped Phase 2.1-light, flagged five pitfalls (architecture.md drift, cost caps, reviewer protocol, storage chunk landmine, token-streaming-vs-complete), required OpenAI reachability test before building.
- OpenAI reachability test: `urllib.request.urlopen('https://api.openai.com/v1/models', timeout=5)` returned 401 (reachable, just unauthorized). Plan locked.
- Built engine/live_debate.py + provider_config plumbing in server.py + renderer wiring in Analyze.tsx + DebateStream.tsx
- Code review (general-purpose Sonnet agent) on the working tree before commit. 3 strong-recommends + 2 nice-to-haves; addressed all five before commit.

**Reviewer fixes applied:**

1. **Unsupported provider crash** — `ProviderConfig.from_dict` now rejects non-openai providers at the boundary (returns `None` → WS falls through to stub). Defense-in-depth inside `live_debate()` yields a graceful `session.complete` with HOLD@0.0 if a future caller bypasses `from_dict`.
2. **Client per call** — lifted `AsyncOpenAI` construction from per-agent (12×) to per-session (1×). Explicit `await client.close()` after the agent loop.
3. **docs/api.md stale fields** — updated `engine_state` to `"ready"` (always — capability not session-state), added `provider_config` to WS start frame example, refreshed `session.complete` schema with live fields, removed "Provider-config plumbing not yet defined here" line.
4. **`hasOpenAIKey` effect dep** — skip refresh when streaming starts; only re-poll on stream end + page mount + resetSignal.
5. **Cost-budget comment** — added one-liner documenting ~$0.005/session estimate at defaults.

**Shipped:**

- New: `engine/live_debate.py` — sequential per-agent OpenAI loop. 12 agents in 4 phases mirroring upstream. Cost caps: `max_tokens=400`, `MAX_AGENTS_PER_SESSION=12` (asserted at import), default `gpt-4o-mini`. Per-session estimated cost logged to stderr.
- `engine/server.py` — `ProviderConfig.from_dict(start.get("provider_config"))`. When config returns non-None, run `live_debate()`; else `canned_debate()`. `engine_state` flipped from `"stub"` to `"ready"` (capability), added `live_supported`, `live_default_model`.
- `engine/requirements.txt` — added `openai>=1.50.0`.
- Renderer: `engine-client.ts` adds `ProviderConfig` + `SessionCompleteEvent` types with optional live metadata. `streamDebate` includes `provider_config` in start frame when present.
- `desktop/src/pages/Analyze.tsx` — reads `llm:openai` from secrets bridge before each session, threads into start frame. LLM status card flips from "Not configured" to "OpenAI · live". Helper text adapts.
- `DebateStream.tsx` — decision card shows "Live · model" badge when `session.complete.live === true`, plus token counts + estimated cost beneath.
- `docs/api.md` — updated to match the new wire shape (engine_state, provider_config, session.complete live fields, out-of-scope refreshed).
- `docs/architecture.md` §5 — replaced the original "wrap upstream" sketch with the actual Phase 2.1-light design, calling out the deferred full-upstream integration as future work.

**Verification:**

- `npm run type-check`: clean
- `npm run build`: clean
- `bash tools/dev-smoke.sh NVDA 2026-05-08`: 8 passed, 0 failed (stub path preserved end-to-end)
- **Live path: NOT smoke-tested in autonomous block** — the autonomous session has no OpenAI key (it lives in the founder's OS keychain). The `provider_config` plumbing is verified by the type-checker + the from_dict allowlist + the reviewer; the actual OpenAI call path is verified when the founder pastes a key and clicks Analyze.

**Commit:** `75d020e`.

---

## 2026-05-08 (continued) — tooling + docs + small UX cap

**Goal:** Wrap the autonomous block with durable assets — a one-shot smoke script future sessions can run instead of curl-by-hand, and a contract doc so a fresh Claude doesn't have to re-derive the engine API by reading source.

**Shipped:**

- New: `tools/dev-smoke.sh` (executable). Spawns the engine sidecar, parses the handshake, and runs 8 assertions against the contract:
  1. `/health` returns 401 without bearer
  2. `/health` returns 200 + `data_provider` with bearer
  3. `OPTIONS /analyze` CORS preflight from `http://localhost:5173` returns 200
  4. `POST /analyze` returns the `HOLD` stub
  5. `GET /data/summary` returns real OHLCV (`last_close > 0`, `sessions ≥ 1`)
  6. `GET /data/summary` returns 404 on bogus ticker
  7. `GET /data/news` returns a list
  8. `WS /stream` sends ≥16 events covering all 4 phases, ends with `session.complete` and clean close 1000
  - Tears down the engine on exit (trap). Exit code 0 on all-pass, non-zero otherwise. Verified all 8 pass against current commit.
- New: `docs/api.md` — full engine API contract: auth, every HTTP endpoint shape, WS event types and order, agent name canon per phase, process model (spawn / handshake / teardown), smoke entry point, and the explicit out-of-scope list. ~6 KB; expected to be the first thing a fresh Claude session reads after CLAUDE.md.
- Updated: `CLAUDE.md` doc graph adds `docs/api.md`.
- Updated: `desktop/src/pages/Analyze.tsx` — date input gains `max=<today>` so users can't request future bars (yfinance returns empty for them; this is a small UX cap, not a hard guard).

**Verification:**

- `bash tools/dev-smoke.sh NVDA 2026-05-08` → 8 passed, 0 failed
- npm run type-check clean

**Commits:** `be6d12d` (one bundled commit).

---

## 2026-05-08 (continued) — keyboard shortcuts + Electron app menu

**Goal:** Make the desktop app feel like a real desktop app — proper menu bar with accelerators, page-level shortcuts for the streaming flow.

**Shipped:**

- New: `desktop/electron/menu.ts` — full app menu template with mac-aware structure (App / File / Edit / Go / View / Window / Help on macOS; same minus App on others). Accelerators wired:
  - **Cmd/Ctrl + N** — File → New analysis (clears prior results, focuses Analyze)
  - **Cmd/Ctrl + .** — File → Stop streaming
  - **Cmd/Ctrl + 1/2/3** — Go → Analyze / Watchlist / History
  - **Cmd/Ctrl + ,** — Go → Settings (also under macOS App menu as the conventional Settings…)
  - Standard cut/copy/paste, reload, devtools, zoom, fullscreen, minimize/zoom under their conventional menus
  - Help → opens repo URL or new-issue URL via `shell.openExternal`
- Updated: `main.ts` registers the menu via `registerAppMenu(() => win)` on `whenReady`. Menu actions send IPC messages (`menu:navigate`, `menu:new-analysis`, `menu:stop-stream`) to the focused window.
- Updated: `preload.ts` adds `tradingAgentsLab.onMenuCommand(channel, handler) => unsubscribe` returning a teardown so the renderer can drop listeners on unmount.
- Updated: `vite-env.d.ts` types the menu bridge.
- Updated: `App.tsx` wires the menu bridge — `menu:navigate` updates the route, `menu:new-analysis` increments a `resetSignal` prop forwarded to `Analyze`.
- Updated: `Analyze.tsx`:
  - Accepts `resetSignal` prop; bumping it clears `events`, `streamError`, `copied` and aborts an in-flight stream.
  - Listens for `menu:stop-stream` and calls `handle.close()`.
  - Page-level `keydown` handler binds **Cmd+Enter to run** and **Cmd+. to stop**. Engine-ready + streaming state is read from refs to avoid stale-closure issues across the keydown lifetime.
  - Footer label bumped to `Phase 4`.

**Verification:**

- npm run type-check + production build clean (main.js 4.99 KB → 7.96 KB to fit menu module + accelerator template)
- IPC bridge surface remains backward-compatible (`tradingAgentsLab.onMenuCommand` is additive)

**Commits:** `0de893a` (one bundled commit with menu + main + preload + types + App + Analyze + docs).

---

## 2026-05-08 (continued, second autonomous block) — news headlines via yfinance

**Goal:** Per advisor, the highest-leverage stretch after Phase 4 was real news headlines via `yfinance.Ticker.news` — additive, no new deps, no architectural commitment.

**Shipped:**

- `engine/data_providers.py` adds `Headline` dataclass + `news_headlines(ticker, limit)` on the `BaseDataProvider` Protocol + `YFinanceProvider` impl. Handles defensive shape-checks on Yahoo's payload (it's changed before).
- `engine/server.py` exposes `GET /data/news?ticker=X&limit=N` (502 on provider errors, never 404 — empty list is valid).
- WS `/stream` emits a `news.headlines` event after `data.summary` and before the debate. Best-effort: failures yield an empty list, debate still runs with the legacy "no catalysts" canned message.
- `engine/stub_debate.py` rewires the news_analyst message to bullet the real headlines + publishers when present, falls back to the canned message when none.
- Renderer:
  - `engine-client.ts` adds `Headline` + `NewsHeadlinesEvent` types and extends the `DebateEvent` union.
  - `DebateStream.tsx` renders a "News" section between the data summary strip and the phase cards. Each headline links to the canonical Yahoo Finance URL (`target="_blank"`); publisher + relative pub time render below in mono.
  - `DebateStream.module.css` adds `.news`, `.newsList`, `.newsItem` styles consistent with the existing card aesthetic.
  - `transcript.ts` includes a "News headlines" section in the Markdown export with linked titles and publisher/timestamp metadata.

**Verification:**

- `/data/news?ticker=NVDA` returns real headlines from real publishers (Motley Fool, Yahoo Finance Video, MarketBeat) with valid URLs
- WS stream emits 4 headlines pre-debate, news_analyst message bullets them
- npm run type-check + production build clean

**Commits:** `a984179` (one bundled commit with engine + renderer + docs).

---

## 2026-05-08 (continued) — Phase 4 main: secret storage + Settings UI

**Goal:** Wire Phase 4 secrets end-to-end so founder can paste API keys (OpenAI, Anthropic, etc.) and they persist encrypted at rest. Per advisor scope guard, the "engine consumes the keys" wiring stays held for Phase 2.1.

**Architecture decision:** chose Electron `safeStorage` over `keytar` — no native dependency, same OS-level encryption guarantee on Mac/Windows (Linux without keyring hard-fails as designed). Storage is a versioned JSON file at `<userData>/secrets.json` containing only base64-encoded encrypted blobs. Plaintext never touches disk.

**Pre-empts in this commit (per advisor):**

- Hard-fail on `safeStorage.isEncryptionAvailable() === false` — UI surfaces a banner; no silent plaintext fallback
- Versioned schema (`{version: 1, entries: {...}}`) — cheap now, painful to retrofit
- Never re-display stored values — UI shows last-4 hint only (`…sk-1234`)
- No "Test connection" button that calls the provider — would burn founder's quota autonomously while they sleep
- No localStorage Watchlist/History — that decision belongs in SQLite per `architecture.md`

**Shipped:**

- New: `desktop/electron/secrets.ts` — safeStorage wrapper with atomic file writes (write-tmp + rename) and 0600 file mode. Exports `setSecret`, `getSecret`, `deleteSecret`, `listSecrets`, `isEncryptionAvailable`, `secretsFileLocation`.
- Updated: `desktop/electron/main.ts` — registers IPC handlers `secrets:{availability,set,get,list,delete}`.
- Updated: `desktop/electron/preload.ts` — exposes `tradingAgentsLab.secrets` on the contextBridge.
- Updated: `desktop/src/vite-env.d.ts` — ambient types for the new bridge surface.
- New: `desktop/src/lib/secrets.ts` — typed renderer wrapper.
- Rewritten: `desktop/src/pages/Settings.tsx` — every tab now calls into the bridge. Each row has Configure / Replace / Delete; stored entries show last-4 hint + relative timestamp. About tab shows the encryption status, secrets file path, and entry count so founder knows where to back up.
- Updated: `desktop/src/pages/Settings.module.css` — editor inline form, action variants, danger button, code block, availability banner.

**Verification:**

- npm run type-check: clean
- npm run build: clean (main.js bumped from 2.56 KB → 4.99 KB to fit the new IPC + secrets module)
- Dev launch smoke: Electron starts, Vite ready, engine spawned, no IPC registration errors
- Manual functional smoke pending founder review (same caveat as Phase 3 — needs UI click-through that autonomy can't drive)

---

## 2026-05-08 — Phase 3: end-to-end debate streaming + autonomous block

**Goal:** Wire the Electron renderer to the Python sidecar so clicking "Analyze NVDA" streams the canned debate into the UI. Stretch: scaffold Phase 4 settings page (no keychain yet) per advisor green-light.

**Shipped (Phase 3):**

- New: `desktop/electron/engine-runner.ts` — spawns sidecar with `cwd: repoRoot` (so `python -m engine` resolves the package via `sys.path[0]`), parses first-line `{port, token}` JSON via `stdout.once('data')`, tees uvicorn stderr with `[engine]` prefix, kills child on `before-quit` and `window-all-closed`.
- Updated: `desktop/electron/main.ts` — calls `startEngine()` eagerly on `app.whenReady`, exposes `engine:get-handshake` IPC handler that awaits the cached promise (no race between renderer mount and sidecar boot).
- Updated: `desktop/electron/preload.ts` — exposes `getEngineHandshake()` on the `tradingAgentsLab` contextBridge.
- New: `desktop/src/lib/engine-client.ts` — typed wrappers: `getHandshake()` (cached), `analyze()` (POST `/analyze` with bearer header), `streamDebate(req, onEvent, onError)` (WS `/stream?token=...`, returns `{close, done}` handle, treats close codes 1000 + 1005 as clean).
- New: `desktop/src/components/DebateStream.tsx` + `DebateStream.module.css` — phase-grouped messages with color-coded left borders (analysts amber, researchers darker amber, trader bright amber, risk neutral gray), animated streaming badge, prominent decision card with action-aware coloring (HOLD amber, BUY green, SELL red).
- Updated: `desktop/src/pages/Analyze.tsx` — Analyze button enabled once handshake lands ("Analyzing…" while in flight), Engine status card flips to Running/Error/Starting, error banner on stream failure, ticker/date inputs disabled during stream.
- Updated: `desktop/src/pages/Analyze.module.css` — added `statusDotOk`, `statusDotError`, `errorBanner` styles.
- Updated: `engine/server.py` — added `CORSMiddleware` for `http://localhost:5173` (renderer origin). Required so the renderer's POST to `/analyze` passes its CORS preflight; WS `/stream` bypasses CORS but is harmlessly covered.
- New: `desktop/src/vite-env.d.ts` — ambient type declarations for `*.module.css` and the `tradingAgentsLab` window bridge. Phase 1 had been silently failing type-check on the CSS module imports — fixed in passing as part of Phase 3 since the same file declares the bridge.

**Verification:**

- `npm run type-check` clean
- `npm run build` clean (155 KB JS gzip 50 KB, plus electron main + preload bundles)
- Engine endpoint contract green via curl + node WebSocket smoke:
  - `/health` 401 without bearer / 200 with bearer ✓
  - CORS preflight (`OPTIONS /analyze` from origin `http://localhost:5173`) returns 200 with correct allow-origin/methods/headers ✓
  - `/analyze` returns stub HOLD@0.5 ✓
  - `WS /stream?token=...` streams 17 events covering all 4 phases (analysts, researchers, trader, risk), ends with `session.complete` carrying decision HOLD@0.55, clean close code 1000 ✓
- Electron successfully spawns the engine via `app.getAppPath()` path resolution — verified by inspecting `ps` after `npm run dev` (sidecar PID listening on `127.0.0.1:<random-port>`)
- Final UI click-through: pending founder review when they return (no Electron Playwright driver was set up to drive the button — every other piece of the contract is verified)

**Commits:**

- `c5815fa` — Phase 3: wire desktop renderer to engine sidecar end-to-end

**Stretch shipped after Phase 3:**

1. **Phase 4 UI spike** (commit `e716d86`) — Settings page reachable from the sidebar with hash-based routing, 5 tabs (LLM Providers, Data Providers, Broker, Clawless, About) showing the provider matrix with disabled `Configure` buttons and a phase-guard footer. Watchlist + History pages render `ComingSoon` placeholders. **No keytar / native dep / secret storage** — that's gated on founder check-in per advisor scope guard.

3. **Phase 5 polish: Stop button + accurate Data status + transcript export** (commit `de030ee`) — three small UX wins in one commit. Stop button replaces Analyze while streaming and calls `handle.close()` to abort the WS. The Data status card now reads `/health.data_provider` after handshake, flipping from "Pending…" to "yfinance · live" with a green dot. A "Copy transcript (Markdown)" button appears once `session.complete` lands; clicking copies a structured Markdown transcript (header, decision, data summary, all phases, all agent messages) to the clipboard with a transient "Copied ✓" affordance.

2. **Phase 5 part 1: yfinance data integration** (commit `5273904`) — engine sidecar now ships a `BaseDataProvider` Protocol + `YFinanceProvider` default. Real NVDA data verified: $211.50 last close, +19.38% over 24 sessions, 147M avg volume. New endpoints + WS event:
   - `GET /data/summary?ticker=X&trade_date=Y` returns real OHLCV summary or 404 on unknown ticker
   - WS `/stream` emits a `data.summary` event before the canned debate
   - analyst/researcher/trader messages inject real numbers — e.g., technical_analyst now reads "*last close 211.50, 19.38% up over the 24-session window (range 173.66–216.83). Avg daily volume ≈ 147,571,146.*"
   - Decision reasoning anchors on the real ticker + price + window
   - Network-failure path: stream gracefully falls back to original canned messages
   - Renderer surfaces a compact summary strip (last close · period change · range · avg volume · source) at the top of the debate panel. Period change is colored green/red.

**Next session opens with:** founder smoke-tests the four-commit run end-to-end:

1. `npm run dev` from `/Users/junaidsiddiqi/Projects/TradingAgents/desktop` — Engine status flips to "Running" within 2-3s, Data status flips to "yfinance · live"
2. Click **Analyze** with default ticker `NVDA` — summary strip appears (last close ~$211, +19% period change), 17 debate events stream over ~7s, decision card lands with HOLD@55% confidence
3. Click **Stop** mid-stream on a second run — abort is clean, no errors
4. Click **Copy transcript (Markdown)** after a complete run — paste somewhere; expect a structured Markdown doc with decision, data summary, all 4 phases
5. Navigate to **Settings** in the sidebar — see the tab structure, all `Configure` buttons disabled with the phase-guard footer

**If any of those don't work, fix that before continuing.** Likely candidates: the IPC handshake promise (Phase 3), CORS preflight against the actual sidecar port (Phase 3), or yfinance reachability if Yahoo is rate-limiting (Phase 5). All are diagnosable from the engine sidecar's stderr in the Electron console.

**Next chunks (founder's call):**

- **Phase 4 secrets wiring** — `keytar` install + first BYO LLM key (OpenAI). Gated on founder go-ahead because adding a native dep deserves a yes.
- **Phase 2.1 — replace stub debate with real `tradingagents` core.** Needs founder to pick the first LLM provider (OpenAI seems most likely) and supply a key.
- **Phase 5 part 2** — Alpaca data provider (needs API key + keychain), `BaseBroker` abstraction, paper-trading order endpoint.
- **Phase 6** — Clawless gateway tap. The probe (`tools/clawless-probe.mjs`) is the working reference protocol code.

---

## 2026-05-07 — Phases 0, 1, 2: foundation → desktop shell → sidecar

**Goal:** Stand up the project from a fresh fork through a working app shell + a sidecar that can stream a fake debate. Three phases shipped.

**Commits (chronological):**

- `f68a7d7` — Re-license fork as TradingAgentsLab under AGPL-3.0 + CLA (LICENSE, LICENSE-APACHE, NOTICE, CLA.md, CONTRIBUTING.md)
- `f0125b8` — **Phase 0**: orchestration docs + gateway probe (`tools/clawless-probe.mjs`, `docs/architecture.md`, `CLAUDE.md`, `Handover.md`, `backlog.md`)
- `86f0185` — **Phase 1**: scaffold Electron + Vite + React desktop shell (warm-amber theme on dark base, founder approved on first look)
- `a44b935` — **Phase 2**: Python sidecar with FastAPI + stub canned debate (`/health`, `/analyze`, `/stream` with bearer auth)
- `81f7414` — Handover checkpoint at end of Phase 2 (paused to save Opus quota)
- `e527632` — Pre-reboot wrap-up: refresh Handover + backlog for clean session resume

**Verified during the session:**

- Multi-client OpenClaw gateway access — TradingAgentsLab connected as a second client alongside Clawless desktop on `ws://127.0.0.1:18789`, ran `connect` + `health`, full agent inventory returned (gateway protocol is `req/res/event` envelope, not JSON-RPC; protocol version 3; `client.id: "cli"`, `client.mode: "ui"` are the working schema constants)
- Engine sidecar acceptance: `/health` 200 with bearer / 401 without, `/analyze` returns stub HOLD decision, `/stream` streams 16 canned events over ~7s, clean WS close (code 1000)
- Visual identity: warm amber `#f0a830` accent on `#0d1117` dark surface ratified by founder

**Decisions locked in:**

- "Connection, not integration" — TradingAgentsLab connects to Clawless the way it connects to Alpaca/yfinance (one of N optional connectors). No code inheritance, no shared CSS.
- Anthropic OAuth banned (TOS); API key only. OpenAI accepts both.
- yfinance default, Alpaca optional. Massive.com deferred.
- Sub-agents default to Sonnet/Haiku (cost discipline).
- `Clawless Advisor` is the cross-product channel (ClaudeLink role).

**Next session opens with:** Phase 3 — wire renderer ↔ engine. File plan in `Handover.md`.
