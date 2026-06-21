# CLAUDE.md — TradingAgentsLab Orchestration

> **Read this first.** This file is the orchestration contract for any Claude (or human) working in this repo. Other docs are reference; this is the rulebook.
>
> **Doc graph:** [`Handover.md`](Handover.md) (where we are now) · [`backlog.md`](backlog.md) (status by phase) · [`WORKLOG.md`](WORKLOG.md) (chronological session log) · [`docs/architecture.md`](docs/architecture.md) (how it's built) · [`docs/api.md`](docs/api.md) (engine API contract) · [`docs/kb/`](docs/kb/) (user-facing knowledge base)

## 1. Mission

**TradingAgentsLab** is the **standalone trading companion for Clawless** — an open-source educational lab and paper-trading desktop app, AGPL-3.0 licensed, forked from [Tauric Research's TradingAgents](https://github.com/TauricResearch/TradingAgents).

It uses multi-agent LLM analysis (analyst → researcher → trader → risk-manager debate via LangGraph) to produce trade recommendations on user-specified tickers and dates.

## 2. Read order at session start

1. **CLAUDE.md** (this file) — rules
2. **Handover.md** — current state, recent decisions, blockers
3. **backlog.md** — phased work items, status of each
4. **docs/architecture.md** — full design (read sections relevant to current task)
5. **Memory** at `~/.claude/projects/-Users-junaidsiddiqi-Projects-TradingAgents/memory/` — durable context (user preferences, cost discipline, locked decisions). The `MEMORY.md` index lists everything.

## 3. Posture (non-negotiable)

### Product positioning (locked 2026-05-09)

**Analysis tool, not an execution platform.** TradingAgentsLab empowers users with multi-agent LLM analysis to make their own trading decisions. We do NOT execute trades on their behalf — even via paper-trading suites that look like real trading apps. This is a regulatory firewall, not a temporary scope cut.

- **No live trading execution code, ever.** Not in the engine, not in the UI, not as a hidden flag. The system MUST refuse to place real-money orders.
- **No full trading suite.** No stop-loss management, no sell-order workflow, no order routing. Adding any of these shifts product identity from analysis lab to trading app and is rejected.
- **Defense in depth via endpoint hard-coding.** When a user pastes live API keys, the engine adapter MUST connect only to paper / data endpoints (e.g. `paper-api.alpaca.markets`, `data.alpaca.markets`). Live keys for `api.alpaca.markets` simply have nowhere to go in our code — the system errors out structurally, not by guard-flag.
- **Webhooks are the integration path for execution.** Like Clawless, users can configure outbound webhooks that push the analysis result to their own authorized broker (Interactive Brokers, Alpaca live, etc.). The actual trade execution happens on the regulated platform, never in our app. We expose the webhook surface; we do not own the trade.

Why: sidesteps the SEC / financial-advisor regulatory surface entirely. Avoids the legal complexity of being an execution platform. Keeps scope manageable and risk low. Full background in memory: `project_positioning_analysis_only.md`.

### Marketing / legal

- **Educational research only.** Never recommend, market, promote, or train on real-money trading in code, copy, or chat with the user.
- **Disclaimer language is locked** in three tiers (persistent footer / inline below decision card / page-level full text). See `project_disclaimer_language.md` in memory for verbatim copy. SEC's 2026 enforcement priority is "AI washing" — boilerplate alone doesn't shield. Always pair disclaimer with honest AI-capability disclosure.
- **Banned phrasing in user-facing copy:** "trading app," "execute trades," "broker integration," "live trading," "order management," "AI-powered trading," "outperforms the market," "predicts," "forecasts," any guarantee or performance claim.
- **Approved phrasing:** "analysis platform," "research tool," "educational lab," "multi-agent LLM analysis," "surfaces multiple perspectives."
- **No em-dashes or en-dashes in any public-facing text.** Applies to: website pages, marketing copy, docs, knowledge base, README, legal pages, error messages shown to users, anything a user might read. Use commas, periods, parentheses, or colons instead. Hyphens in compound words (paper-trading, multi-agent, AGPL-3.0) are fine. Internal-only files (CLAUDE.md, Handover.md, WORKLOG.md, code comments, memory entries) may use them. Founder's personal style rule, enforced universally for shipped copy.
- **Mission statement (canonical):** *"Trading Agents Lab provides a high-quality, professional-grade tool purely for educational purposes. We do not force user adoption and we do not provide trading tools — we provide a free resource for analysis and learning."*
- **Locked phrasing for Clawless relationship:**
  - ✅ "Standalone trading companion for Clawless"
  - ❌ NOT "Clawless extension / plugin / add-on / integration"
- **Brand name rendering (locked 2026-05-17):**
  - ✅ "Trading Agents Lab" (three words, spaces) in any human-readable text: body copy, marketing, docs, KB, README prose, OG cards, page titles, meta descriptions, LinkedIn, press kit, error messages a user might read.
  - ✅ "TradingAgentsLab" (compressed) reserved for URL/code contexts only: `github.com/RBJGlobal/TradingAgentsLab`, `tradingagentslab.ai`, `/products/tradingagentslab`, React component/function names, TypeScript identifiers, `package.json` `name` field, `git clone` directory, internal code comments.
  - Rule of thumb: if a human reads it as prose, three words. If a machine parses it as identifier or URL slug, compressed.

### Business model + privacy

- **Free, open-source, zero-monetization** for the foreseeable future. AGPL-3.0. No subscription, no paywall, no premium tier. If monetization is ever considered → engage securities counsel BEFORE shipping anything (the change in business model is the regulatory inflection point).
- **Public repo never includes broker / live-trading code.** Even feature-flagged. Users may fork for personal modifications; PRs adding execution code are rejected upstream regardless of quality. Per `project_risk_profile_and_education.md`.
- **Zero data collection — no exceptions.** No analytics SDKs, no telemetry beacons, no error reporting to remote services, no install pings, no user accounts, no email collection. Every renderer fetch goes to `127.0.0.1`. Engine outbound calls only to user-configured providers (yfinance, Alpaca data, LLM providers, future webhooks).
- **One soft external identifier:** OpenRouter requests carry HTTP-Referer + X-Title courtesy headers (their telemetry, our courtesy). Disclose in Privacy Policy.
- **Marketing website (when it lands):** brochure-only, no analytics, no tracking. Static site preferred.

### Educational integration

- Trading Agents Lab is a **practical case study for Clawdemy.org** (founder's AI education platform). Students read the source to learn multi-agent LLM design.
- **How to apply:** keep code readable and well-commented; documentation should explain the *why* of choices, not just the *what*. Avoid clever code that's hard to learn from. The codebase is a teaching artifact.

### Code / license

- **Apache 2.0 upstream code stays Apache 2.0** (preserved in `LICENSE-APACHE` + attributed in `NOTICE`).
- **Our additions are AGPL-3.0** (in `LICENSE`).
- **Files modified from upstream** must carry a "modified" notice (Apache 2.0 §4(b)). Use git history as the authoritative record.
- **No Clawless code inheritance.** TradingAgentsLab does not copy CSS, components, or settings code from the Clawless repo. Brand-level coherence yes, code reuse no.
- **Anthropic OAuth is BANNED by Anthropic TOS.** Use API key only for Anthropic. OpenAI may use API key OR OAuth.

### Architectural

- **Connection, not integration:** Clawless is one of N optional connectors (alongside Alpaca, Yahoo Finance, etc.). Treat it that way in code, settings UI, and copy.
- **Protocol source of truth for OpenClaw work:** the public **OpenClaw npm package** TypeScript types (MIT). Don't reverse-engineer Clawless's `gateway-client.ts`.
- **Brand-level coherence:** TradingAgentsLab's UI feels like a Clawless-family product through independent design choices (compatible dark palette, compatible humanist font pairing, complementary accent — *not* the same Clawless cyan).

## 4. Session discipline

### Every session

- **At start:** read this file + Handover.md + check inbox via `mcp__claudelink__read_inbox` (register as `trading-agents-lab` if not already registered).
- **As you work:** update `backlog.md` when items move (pending → in progress → done) and add new items as you discover them.
- **At end:** update `Handover.md` (current state, blockers, where to pick up) AND prepend a fresh entry to `WORKLOG.md` (date header, what shipped today, commit hashes, next-session-opens-with). Future-you (or a fresh Claude) will thank you.

### "wrap-up" — trigger word

When the founder says "wrap-up" (or "wrap up for the night," "let's wrap," etc.) treat it as a structured close-of-session command, not a generic farewell. Do all of the following before signing off:

1. **Memory sweep.** Save anything durable, surprising, or non-obvious from the session to `~/.claude/projects/.../memory/` (new file or update existing). Locked decisions, founder preferences, voice rules, architectural pivots, deferred-but-promised items.
2. **CLAUDE.md update.** If a new rule, posture, banned/approved term, or workflow trigger was introduced today, fold it into the right section here so it survives a fresh agent boot.
3. **Handover.md refresh.** Replace the "Where we are right now" section with today's state. Cover: what threads ran, what shipped, commits pushed, live state (dev stack running?), open issues, what tomorrow opens with. Pretend a fresh Claude with zero memory will read it first thing.
4. **WORKLOG.md prepend.** Add a new dated section at the top: goal, what shipped (with commit hashes), cross-product coordination, next-session-opens-with checklist.
5. **Commit + push the docs sweep.** One commit, descriptive message. Ask before push only if non-doc code changed; pure doc/memory updates push automatically.
6. **Inbox check.** Final `read_inbox` so nothing late stays unread until tomorrow.
7. **Report.** One short paragraph back to founder: what got saved, what's queued for tomorrow, any state to be aware of (e.g., dev stack still running, pending review on another agent's work).

Goal: if the terminal closes the moment the founder hits send on "wrap-up," next-day Claude can fully resume cold.

### Periodic upstream check

- **Run `bash tools/upstream-check.sh` weekly** (or at the start of any session that's been more than a few days since the last). It fetches `upstream/main`, reports whether we're behind on tagged releases or unreleased commits, and exits non-zero when there's a merge to consider.
- **Don't auto-merge.** Upstream changes can touch agent prompts, decision parser shape, or role definitions wrapped by `engine/live_debate.py`. Surface the diff to the founder, propose a merge plan, run the smoke + tests after merging.
- **Smoke after merge:** `bash tools/dev-smoke.sh` (engine HTTP/WS contract) + `engine/.venv/bin/python -m pytest engine/tests/` (CostGuard + storage). Spot-check the multi-agent debate end-to-end before pushing.

### Commits

- Confirm with founder before pushing to `origin/main`. The repo is public.
- **PR merge workflow (founder's standing rule, 2026-05-27):** open the PR, give the founder a clear summary in chat (what changed, risks, scope, gates), and on his authorization **merge it yourself** (`gh pr merge N --merge --delete-branch`). The founder does not click merge as a routine; the confirmation above IS the authorization-after-summary. The summary stays mandatory; a blanket "authorized" covers the batch just summarized, not all future PRs. For stacked PRs touching the same files, merge foundational-first, resolve the (mechanical) conflict on the second, re-run gates on the merged state, then merge. See memory `feedback_pr_merge_authorization.md`.
- Use HEREDOC commit messages following the pattern in earlier commits.
- Apache 2.0 modification notices belong in `NOTICE` and the `git log`, not in every file's header (one-line "Modified by TradingAgentsLab" comment is sufficient if a file's content was substantially changed).

### Memory

- Save durable, surprising, or non-obvious facts to memory (`~/.claude/projects/.../memory/`).
- Don't memorize anything derivable from the current code or git history.
- Update or remove memory entries when they become stale.

## 5. Sub-agent and cost discipline

**Founder is on a weekly Opus 4.7 quota and burns through it quickly.**

- Default sub-agents to `model: "sonnet"` (Sonnet 4.6) for routine work
- Use `model: "haiku"` (Haiku 4.5) for cheap read-only research (Explore agent, simple lookups)
- Reserve Opus 4.7 for the parent (the conversation owner) and only escalate sub-agents to Opus when the task genuinely needs frontier reasoning
- When parallelizing, default to economical models for the breadth; escalate specific ones if needed

## 6. Cross-product channels

| Topic | Channel |
|---|---|
| Clawless desktop or OpenClaw protocol questions | `mcp__claudelink__send` to role `Clawless Advisor` |
| The **entire** tradingagentslab.ai brochure site (content, family roster, llms.txt, SEO, JSON-LD, sitemap, crawlers) | Owned end-to-end by `Global Sites Developer` — hand off everything, don't action any of it yourself (founder expanded SEO-only ownership to the full site, 2026-06-12). I no longer commit to `Trading_agent_site` at all. |
| Anything else in TradingAgentsLab | I am principal developer/architect — make the call |

**Site working tree (`Trading_agent_site`):** as of 2026-06-12 `Global Sites Developer` owns this repo outright — I no longer commit to it. If a future task somehow requires a site change, route it to GSD via ClaudeLink rather than editing the tree. (Historical concurrency rules for the shared tree are preserved in memory `reference_shared_tree_concurrency.md` in case the arrangement ever reverts.) This ClaudeLink terminal is registered as role **Trading Agents Lab Developer**.

When messaging Clawless Advisor:
- Frame as "no Clawless team work needed" if applicable (they're in pre-launch sprint)
- Batch related questions into one message
- Advisor replies are not auto-fired; surface comes when founder is at that terminal

## 7. Repository conventions

### Layout

- `tradingagents/` — upstream Python core (Apache 2.0, mostly untouched)
- `tools/` — utilities and probes (e.g., `clawless-probe.mjs`)
- `desktop/` — Electron app (AGPL-3.0, NEW — Phase 1+)
- `engine/` — Python sidecar wrapping `tradingagents/` (AGPL-3.0, NEW — Phase 2+)
- `docs/` — long-form design docs
- Root: `LICENSE`, `LICENSE-APACHE`, `NOTICE`, `CLA.md`, `CONTRIBUTING.md`, `README.md`, `CLAUDE.md`, `Handover.md`, `backlog.md`

### Git remotes

- `origin` → `https://github.com/RBJGlobal/TradingAgentsLab.git` (push here)
- `upstream` → `https://github.com/TauricResearch/TradingAgents.git` (read-only — pull updates with `git fetch upstream && git merge upstream/main`)

### Secrets

- `.env` is gitignored. All API keys, tokens, and gateway credentials live there or in OS keychain — **never in code, never in chat transcripts**.

## 8. Verified facts

- Multi-client OpenClaw gateway access: **confirmed** 2026-05-07 via `tools/clawless-probe.mjs`
- Gateway URL: `ws://127.0.0.1:18789` · Protocol: 3 · Frame envelope: `{type, id (string), method, params}` · Schema-validated `client.id` and `client.mode`

## 9. Pending decisions (small, deferred)

- OpenClaw upstream PR for `client.id: "tradingagentslab"` (non-blocking, deferred)
- Massive.com / Polygon-class data provider (deferred — Alpaca sufficient for v1)
- Distribution: direct download / Mac App Store / signed installer (defer to Phase 7)
- Auto-update mechanism (defer to Phase 7)

## 10. Questions to escalate to the founder, not decide alone

- Real-money trading enablement in distribution builds
- Public marketing copy and positioning
- Commercial licensing offers (CLA preserves the right; founder makes the call)
- Distribution and pricing
- Coordinated OpenClaw version bumps (cross-product impact)
- Anything that touches Clawless-team work

Everything else: act as principal developer/architect.
