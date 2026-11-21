# Cost Guard

*Stacked daily / weekly / monthly USD caps and an optional sessions-per-day rate cap. On by default for new installs: $2.00 a day, $5.00 a week, $15.00 a month in the Lite app, and $5.00 a day, $15.00 a week, $45.00 a month in Pro. Override per-run.*

> **For educational research and paper trading. This is not investment advice.**

---

## What it is

Cost Guard is a quota layer that sits in front of the live LLM debate. Before every paid-API session, the engine estimates the worst-case cost of the debate and checks it against the caps you've set. If the cost would push any cap over the limit, the request is blocked and a modal opens, you can either **Cancel** or **Override and run anyway**. The override is per-run; it does not raise the cap.

The four cap dimensions:

| Dimension | What it limits |
|---|---|
| **Daily** | USD spent across all debates that started today (UTC) |
| **Weekly** | USD spent across the rolling 7-day window |
| **Monthly** | USD spent across the rolling 30-day window |
| **Sessions per day** | Count of debates started today, regardless of cost |

A cap of `0` means **disabled**. You can enable any subset, e.g. monthly USD only, or sessions-per-day only.

> **Pro** A new Trading Agents Lab Pro install starts with a **$5.00 daily**, **$15.00 weekly** and **$45.00 monthly** cap, and no sessions-per-day cap. Updating from an earlier version: if your caps were still the old defaults ($1.00 a day, $5.00 a week, $15.00 a month, never changed), they are raised once to the new defaults, because a Pro analysis with all four analysts on Claude Sonnet 4.6 is estimated at about $1.31 and would not fit a $1.00 daily cap. Caps you set yourself are kept as they were. A market-only analysis (the setting a new install starts with) is estimated at about $0.75.

---

## Why we built it

LLM costs scale with model choice + token usage in ways that are easy to underestimate. A single debate with gpt-5 or Claude Opus 4.7 across 12 agents can easily cost more than you'd expect. Cost Guard turns "did I just spend $20 on three debates?" into a deliberate decision rather than a billing surprise.

It also protects against accidental loops, runaway scripts, and the occasional UI glitch that fires multiple debates. The rate cap (sessions-per-day) catches what the USD cap might miss.

---

## Where to go in the UI

**Settings → Cost Guard**.

Top of the page: a **status row** showing your current spend totals (daily / weekly / monthly USD, sessions today) with color bars indicating how close you are to each cap. Green = below 50%, amber = 50-90%, red = 90%+.

Below that: an **Enable / Disable** toggle and a form with four numeric inputs (one per cap dimension). Caps update via PUT on save. Settings can be changed at any time, including mid-session.

---

## What counts as spend?

The engine computes a per-session cost using a static **cost rate table** (`engine/llm_providers.py`). Rates are USD per million input/output tokens, refreshed manually when providers change them. Conservative numbers preferred.

| Provider / Auth | Cost behavior |
|---|---|
| API-key on any per-token-billed provider | Real token usage × rate table. Logged on `session.complete`. |
| **OpenAI OAuth** (ChatGPT subscription) | **$0**. Subscription billing happens outside our app; we record 0 so the cost ledger only reflects per-token API spend. |
| **Local LLM** (Ollama / LM Studio) | **$0**. Local sessions cost nothing in real dollars. |
| **OpenRouter** | Priced at the rate OpenRouter publishes for that model, read when the model list loads. Before the list has loaded (for example right after the app starts), the model is priced from our own rate for the same vendor model, or from a deliberately high estimate if we have none. |
| **A model newer than your copy of the app** | Priced from its model family at a deliberately high estimate (for example, $15 / $75 per million input / output tokens for an unknown Claude Opus class model). Never `0.0`: an unpriced model can make Cost Guard stop sooner, never later. A dated model name (such as `claude-haiku-4-5-20251001`) uses the rate of its plain name. |

OAuth and Local sessions **skip** the three USD caps but **do count** against the sessions-per-day rate cap, even free runs benefit from quota discipline on runaway debate counts.

---

## The pre-debate reservation flow

Before a live debate kicks off, the renderer:

1. **Estimates worst-case cost** for the session (assumes every agent maxes out its output budget, transcript grows triangularly across agents). For a **reasoning model** the output budget per agent includes its thinking allowance (1,200 extra tokens on top of the answer budget), because thinking is billed as output. The growing transcript is budgeted at the same full size: the provider does not split that room between thinking and answer, so a model that thinks briefly can write a longer answer, and every later agent reads it.
2. **POSTs `/cost-guard/reserve`** with `{model, auth_kind, max_tokens, provider}` (`provider` is optional; the engine works it out from the model name when it is missing).
3. If the reservation succeeds → the debate proceeds with a `reservation_id` threaded on the WebSocket start frame.
4. If the reservation fails with `CostGuardBlocked` → the **Cost Guard modal** opens.

The modal shows:
- Which dimension would be exceeded (daily / weekly / monthly / rate)
- Your current spend in that dimension
- The configured cap
- The estimated cost of the requested run

You then choose:
- **Cancel**, the debate aborts. No tokens spent.
- **Override and run anyway**, the renderer re-reserves with `override=true`. The session runs, and the cost is added to the rolling totals just like any other run. **The cap itself does not change.**

A three-second anti-tamper countdown disables the Override button on first appearance so you can't accidentally double-click through it. The Cancel button is always enabled.

> **Pro** Trading Agents Lab Pro runs the full multi-agent graph, where analysts call data tools as many times as they need and no single step has a fixed length. No number computed before the run can be a true maximum, so the Pro estimate is a realistic figure instead: about 1.4 times what a typical run costs. It is built node by node: each analyst you selected, every bull and bear turn, the research manager, the trader, every risk-analyst turn, the portfolio manager, and the final thesis-scoring step. The research manager and portfolio manager are priced at your **deep** model and every other step at your **quick** model. Extra debate or risk rounds cost more than the round before, because each new turn reads the whole conversation so far. Models that think before they answer (for example Claude Sonnet 5.5 or gpt-5) get 2.5 times the output budget, since thinking is billed as output. With all four analysts, one round of each debate and Claude Sonnet 4.6 as both models, the estimate is about $1.31; with only the market analyst (the setting a new install starts with) it is about $0.75. The real protection is the mid-run stop below.

> **Pro** A **Quick analysis** (Mode picker on Analyze) is the shorter single-model debate, so Cost Guard reserves it like the Lite app does: a true worst case for twelve agents on your one model, including the extra thinking room reasoning models get. The full-graph estimate above applies only to a Full analysis.

---

## The mid-run stop

> **Pro** Because the estimate is not a ceiling, Trading Agents Lab Pro also watches spending while the analysis runs. Before every model call, it checks whether that call could push your spending past an enabled cap, using the same prices that get recorded when the run ends. If it could, the run stops there and the analysis screen says so, for example: "Stopped: This run reached your Cost Guard daily cap after spending $0.87. Raise the cap in Settings, Cost Guard, or use Override."
>
> - **A normal run** stops only when continuing could take you past the daily, weekly or monthly cap, whichever has the least room left. The room is rechecked after each step of the analysis, so a run started meanwhile is taken into account, and each run's real spend so far counts against the room the others see. A run that costs more than its estimate but stays under your caps finishes normally.
> - **An override run** ignores the caps, but stops if it reaches about **3 times its own estimate**. That catches a runaway (a step that never stops calling tools, or a model that keeps thinking). The same runaway stop applies when Cost Guard is off or no USD cap is set.
> - **ChatGPT sign-in (OAuth) runs** cost $0 per token, so they have no dollar stop. The optional token cap in Settings still applies.
>
> If the final thesis-scoring step could cross the limit, it is skipped and the analysis ends without the strength bars. **A run that stops early still counts:** what it spent up to that point is added to your daily, weekly and monthly totals, even though it does not appear in History.

---

## The TOCTOU-safe reservation

Cost Guard uses a **time-of-check-to-time-of-use safe** reservation pattern: the database insert of the reservation row is the atomic check. Two simultaneous debates cannot both squeeze under the same cap, the first to insert wins; the second sees the bumped totals and gets blocked.

Reservations have a **15-minute TTL**. If a debate ends cleanly, the reservation is finalized with real token usage replacing the worst-case estimate. If the renderer crashes mid-debate, the reservation expires and the slot frees up. A background sweeper cleans expired reservations on every state read.

> **Pro** A Trading Agents Lab Pro reservation lives for **60 minutes**, because a full-graph analysis can take 6 to 11 minutes at the default settings and longer with extra rounds. If the app crashes mid-run, the reservation frees itself within the hour. A run that lasts longer than its reservation still records what it really spent.

---

## When to use which cap

Tune to your risk tolerance:

- **Strict daily cap (e.g. $1/day)**, pairs well with `gpt-4o-mini`/`claude-haiku-4-5` and frequent experimentation. ~200 debates/day at this budget.
- **Monthly cap only (e.g. $30/month)**, pairs with mixed-model use; lets you have expensive days as long as the month averages out.
- **Sessions-per-day cap (e.g. 20)**, disciplines OAuth + Local users where USD caps don't fire. Also a sane secondary cap alongside USD limits.
- **All four enabled**, paranoid mode. Useful for long-running unattended scenarios.

---

## What does NOT count as spend

- **Stub debates** (no provider configured), never charged. They run for free against the canned content.
- **OAuth debates**, subscription billing is out-of-band. We record $0.
- **Local LLM debates**, $0.
- **Failed sessions**, if the LLM provider errors before any tokens are spent, the reservation is finalized at 0.

---

## Reading the spend bars

The status row at the top of the Cost Guard tab shows each cap dimension as a bar. The bar color reflects "how close are you to this cap":

| Color | % of cap used | What it means |
|---|---|---|
| 🟢 Green | 0-49% | Plenty of headroom. |
| 🟡 Amber | 50-89% | You're past halfway. Next runs may push you near the limit. |
| 🔴 Red | 90-100% | You're at or above the cap. Next live debate will be blocked. |

For unset caps (value = 0 / disabled), the bar shows the raw spend with no fill, just a number, no progress visualization.

---

## Resetting spend

Spend totals are **rolling windows**, not user-resettable values. They automatically roll forward as time passes:

- Daily totals reset at **00:00 UTC**.
- Weekly totals shed entries older than 7 days each midnight.
- Monthly totals shed entries older than 30 days each midnight.

There is **no manual reset**, by design, so spend history can't be wiped to dodge a cap. If you need to forget historical data entirely, you can quit the app and delete `sessions.db` (plus any `sessions.db-wal` and `sessions.db-shm` beside it). The installed app keeps it at `~/Library/Application Support/Trading Agents Lab/sessions.db`; running from source, it is `<repo>/data/sessions.db`. See [security-and-storage.md](security-and-storage.md). This is destructive and not recommended; debate history is the same DB.

---

## Tracking historical spend

The History page shows per-session `estimated_cost_usd` next to each entry. Sort by date or by cost to see what your expensive runs were. This is independent of the Cost Guard windows, History never expires.

---

## Engine API surface

For developers integrating against the engine:

| Endpoint | Purpose |
|---|---|
| `GET /cost-guard/state` | Current spend + config |
| `PUT /cost-guard/config` | Update caps + enable/disable |
| `POST /cost-guard/check` | Dry-run: would this debate be blocked? |
| `POST /cost-guard/reserve` | Atomic check + reservation; returns `reservation_id` or 402 `CostGuardBlocked` |

Full request/response shapes in [docs/api.md](../api.md).
