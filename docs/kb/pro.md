# Trading Agents Lab Pro

*What the Pro desktop app is, how it differs from the free open-source app, and how to choose between an API key and ChatGPT OAuth for full-depth analysis.*

> **For educational research and paper trading. This is not investment advice.**

---

## How Pro content is marked in this knowledge base

Most of this knowledge base applies to the free open-source app. Where a section describes something that exists only in Trading Agents Lab Pro, it is marked with a **Pro** callout like this:

> **Pro** This feature is part of Trading Agents Lab Pro, the full-depth companion app.

If a page has no Pro callouts, everything on it applies to both apps.

---

## What Trading Agents Lab Pro is

Trading Agents Lab Pro is a separate desktop application from the same maker, and it is **free and open source** under AGPL-3.0, just like this app. Its source lives at [github.com/RBJGlobal/TradingAgentsLab-Pro](https://github.com/RBJGlobal/TradingAgentsLab-Pro). It shares the desktop interface you know from this app, but wires it to the full research-grade multi-agent pipeline from the upstream TradingAgents project, the same code that this repository bundles under `tradingagents/` and that this app deliberately simplifies.

Concretely, a Pro analysis runs:

- **Tool-using analysts.** The market, sentiment, news, and fundamentals analysts call real data tools mid-run (price history, indicator series, fundamentals, news) and iterate on the results, rather than working from a single pre-fetched summary.
- **Multi-round researcher debate.** A bull researcher and a bear researcher argue the case in turns, and a research manager rules on the debate with an explicit rationale.
- **A trader and a three-voice risk debate.** Aggressive, conservative, and neutral risk analysts stress-test the trader's plan before anything is finalized.
- **A portfolio manager verdict.** The final assessment lands on one of five analytical stances (Bullish, Moderately bullish, Neutral, Moderately bearish, Bearish), a modeled scenario range, a time horizon, and a written investment thesis.
- **A deep/quick model split.** Reasoning-heavy roles run on a stronger model while high-volume roles run on a faster one, configurable per run.
- **Cross-run memory.** Past decisions on the same ticker are surfaced to the agents as context for the next run.

A full Pro run typically takes 8 to 15 minutes depending on provider, models, debate rounds, and how many analysts you select.

---

## Free app vs Pro at a glance

| | Free app | Trading Agents Lab Pro |
|---|---|---|
| License | AGPL-3.0, open source | AGPL-3.0, open source |
| Engine | Simplified single-pass debate | Full upstream LangGraph graph |
| Analysts | Pre-fetched data summary | Tool-using, iterate mid-run |
| Researcher debate | Single exchange | Multi-round with a ruling research manager |
| Risk phase | Single pass | Aggressive / conservative / neutral debate |
| Decision | Committee assessment: stance + conviction + strengths + reasoning | Adds the full five-stance scale, modeled scenario range, time horizon, investment thesis |
| Typical runtime | Under a minute | 8 to 15 minutes |
| Transcript export | Copy as Markdown | Copy as Markdown, plus a full-page HTML reading view |
| Cost controls | CostGuard caps | Same CostGuard caps |
| Privacy posture | Zero data collection | Same: zero data collection, keys stay in the OS-encrypted store |

The free app is not a demo. It is a complete educational lab. Pro exists for users who want the full-depth pipeline the upstream research project describes. Both apps are free, open source, and collect zero data.

---

## LLM providers in Pro

> **Pro** This section describes provider behavior in Trading Agents Lab Pro.

Pro runs on your own credentials, exactly like the free app. Two paths are supported:

1. **API keys** for OpenAI, Anthropic, OpenRouter, or Google Gemini. Per-token billing against your provider account.
2. **OpenAI OAuth** through your paid ChatGPT subscription. No per-token charges; runs bill against your plan's rate limits.

Both paths drive the same full pipeline, including the analysts' tool calls. The differences that matter when choosing are documented in [oauth.md](oauth.md#oauth-in-trading-agents-lab-pro), including what we observed running the two side by side on the same ticker and date.

CostGuard applies to Pro runs the same way it applies to free runs. OAuth and local runs meter at $0; API-key runs reserve against your configured daily, weekly, and monthly caps before the run starts.

---

## Availability

The Pro source code is public now at [github.com/RBJGlobal/TradingAgentsLab-Pro](https://github.com/RBJGlobal/TradingAgentsLab-Pro); you can build and run it from source today. A signed, notarized macOS download with automatic updates is in pre-release testing and is coming soon. This page will be updated when it ships.

---

## Are both apps really free?

Yes. Both applications are free and open source under AGPL-3.0, with no subscriptions, no paywalls, no feature gates, and no telemetry in either. This project is an educational contribution; it is how we build trust, not revenue.
