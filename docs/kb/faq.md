# Frequently Asked Questions

*Posture, license, what Trading Agents Lab is and is not, and the relationships with upstream and Clawless.*

---

## Purpose and posture

### What is Trading Agents Lab for?

Trading Agents Lab is an educational research tool and analysis desktop app. It runs a multi-agent AI debate to produce a committee assessment: an analytical stance and thesis strength scores for any ticker you specify.

**For educational research and paper trading. This is not investment advice.**

The app is designed to help you understand how AI agents reason about market data, to practice paper trading, and to build intuition for multi-agent analysis. It is not designed to drive real-money trading decisions.

### Can I use it to trade real money?

You can connect a live Alpaca account, but:
- Live trading is intentionally restricted in the current distribution.
- The app produces AI-generated analytical assessments, not financial advice.
- Any real-money trading decision is entirely your own. Trading Agents Lab is not a registered investment advisor.

### Does it guarantee profitable trades?

No. The agent debate produces a committee assessment: an analytical stance on how the bull and bear cases argued, a conviction score, and thesis strength scores. These are model outputs, not probabilities of profit. Past analysis results have no predictive value for future returns. This is a research tool, not a signal service.

---

## What Trading Agents Lab is not

- **Not a brokerage.** It does not execute trades on its own.
- **Not a registered investment advisor.** Nothing it produces is investment advice.
- **Not a Clawless extension, plugin, add-on, or integration.** It is a standalone product that can optionally connect to a Clawless gateway, the same way it can optionally connect to Alpaca or Yahoo Finance.
- **Not a live trading platform.** Paper trading is the intended use case.

---

## License

### What license is Trading Agents Lab under?

Trading Agents Lab additions (the desktop app and engine sidecar) are licensed under **AGPL-3.0**. The upstream Python core (`tradingagents/`) is Apache 2.0 and remains Apache 2.0.

The `LICENSE` file contains AGPL-3.0. `LICENSE-APACHE` contains the Apache 2.0 text. `NOTICE` records modification and attribution. `CLA.md` describes the Contributor License Agreement.

### What does AGPL-3.0 mean for users?

You can use, modify, and distribute Trading Agents Lab. If you distribute a modified version, you must make the source code of your modifications available under AGPL-3.0. Running it for your own use (even on a server) does not require publishing source.

### What does Apache 2.0 mean for the upstream code?

The `tradingagents/` directory contains code from Tauric Research's TradingAgents, licensed Apache 2.0. It can be used, modified, and distributed freely. Trading Agents Lab preserves this license in `LICENSE-APACHE` and records modifications in `NOTICE` as required by Apache 2.0 §4(b).

---

## Trading Agents Lab Pro

### What is Trading Agents Lab Pro?

Trading Agents Lab Pro is a separate desktop app, also free and open source under AGPL-3.0, that wires the same interface to the full research-grade multi-agent pipeline from the upstream project: tool-using analysts, multi-round bull/bear and risk debates, a deep/quick model split, and a portfolio-manager assessment with the five-stance scale, modeled scenario range, and time horizon. The source is public now at github.com/RBJGlobal/TradingAgentsLab-Pro; a signed download is coming. See [pro.md](pro.md).

### Does the free app stay free?

Yes. The open-source app remains AGPL-3.0 and free, with no feature removals and no telemetry. Pro is a separate application, not a paywall inside this one. Content in this knowledge base that applies only to Pro is marked with a **Pro** callout; everything unmarked applies to both.

---

## Upstream relationship

### Where does Trading Agents Lab come from?

Trading Agents Lab is forked from [Tauric Research's TradingAgents](https://github.com/TauricResearch/TradingAgents), a multi-agent LLM trading research framework. The upstream project implements a full LangGraph-based pipeline with analyst, researcher, trader, and risk-manager agents.

Trading Agents Lab wraps this core in a desktop UI and a FastAPI sidecar, adds key management, data provider integrations, and the Clawless connector option.

### Are changes being contributed back upstream?

Not at this time. Trading Agents Lab is an independent fork under AGPL-3.0 for its additions.

---

## Clawless relationship

### What is the relationship between Trading Agents Lab and Clawless?

Trading Agents Lab is a **standalone trading companion for Clawless**. It is an independent product with its own codebase, license, and UI.

Clawless is one of several optional connectors in Trading Agents Lab, alongside Alpaca, Yahoo Finance, and direct LLM provider keys. Connecting the two is optional. Trading Agents Lab works fully without a running Clawless instance.

No code is shared between the two products. Brand-level coherence (compatible dark palette, compatible font choices) is achieved through independent design decisions, not code reuse.

### Does Trading Agents Lab require Clawless?

No. You can run Trading Agents Lab entirely without Clawless. The Clawless connector (Phase 6) adds an optional gateway routing path for LLM calls.

---

## LLM providers

### Which LLM providers can I use?

Six cloud provider families are wired end-to-end today: **OpenAI**, **Anthropic**, **OpenRouter**, **Google Gemini**, **xAI Grok**, and **MiniMax**, plus any **local OpenAI-compatible runtime** (Ollama, LM Studio). All cloud providers work with API keys; OpenAI also supports OAuth via your ChatGPT subscription. See [configuring-llm-providers.md](configuring-llm-providers.md).

### Can I use my paid ChatGPT account instead of an API key?

Yes, for OpenAI only. The OAuth flow routes debates through `chatgpt.com/backend-api/codex/responses` (the Codex backend, same as the ChatGPT web app and Codex CLI), so debates bill against your ChatGPT subscription rate limits rather than per-token API charges. See [oauth.md](oauth.md). Free-tier ChatGPT accounts are unreliable here, paste an API key instead.

### Why is there no Anthropic OAuth?

Anthropic's Terms of Service prohibit OAuth flows for their API. Trading Agents Lab respects this, Anthropic is API-key only.

### Can I use multiple providers simultaneously?

You can have keys (and OAuth) for all of them connected at once. Each individual debate uses one provider, picked via the **"Run with"** dropdown on the Analyze page. Your last selection persists per (provider, auth-mode) combination.

---

## Data and privacy

### Where does market data come from?

Yahoo Finance by default (free, no API key required). Optionally Alpaca for power users with an Alpaca subscription. See [data-providers.md](data-providers.md).

### Does Trading Agents Lab send data to any server?

- Market data is fetched from Yahoo Finance's public endpoints.
- LLM calls go to your configured provider (OpenAI, Anthropic, OpenRouter, Gemini) using your own key, or, for OpenAI OAuth, through the Codex backend using your ChatGPT subscription.
- No data is sent to Trading Agents Lab's own servers, the app has none. No telemetry, no analytics, no error reports. All processing happens locally.

### Are my API keys safe?

Yes. Keys are encrypted by your OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux) before touching disk. Plaintext is never written anywhere. OAuth tokens are encrypted the same way. See [security-and-storage.md](security-and-storage.md).

### Where is my debate history stored?

Locally, in `<repo>/data/sessions.db` (SQLite). The History page reads from this file. Delete the file to wipe history. It is not encrypted at rest, store the repo on an encrypted volume (FileVault, BitLocker, LUKS) if you want at-rest encryption for transcripts.

---

## Further reading

- [Getting started](getting-started.md), install and run
- [How it works](how-it-works.md), the multi-agent pipeline
- [Configuring LLM providers](configuring-llm-providers.md), set up your providers
- [OAuth](oauth.md), ChatGPT subscription routing
- [Clawless connector](clawless-connector.md), optional gateway tap
- [Security and storage](security-and-storage.md), how keys are protected
