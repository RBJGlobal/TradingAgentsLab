# Trading Agents Lab, Knowledge Base

*Entry point for users of Trading Agents Lab: what it is, how to set it up, and how to get the most out of it.*

Trading Agents Lab is an open-source desktop application for educational market research and paper trading. It runs a panel of AI analyst agents, technical, fundamental, news, and sentiment, that debate a ticker on a date you specify, then produce a committee assessment: an analytical stance, conviction score, thesis strength scores, and reasoning. The analysis is for research and paper-trading purposes only. It is not investment advice.

Trading Agents Lab is a standalone trading companion for Clawless. You can use it independently; connecting it to a running Clawless instance is optional and adds gateway routing for LLM calls.

> **For educational research and paper trading. This is not investment advice.**

---

## Files in this knowledge base

| File | What it covers |
|---|---|
| [getting-started.md](getting-started.md) | Clone the repo, create the engine venv, install desktop deps, run in dev mode |
| [how-it-works.md](how-it-works.md) | Conceptual walkthrough of the multi-agent debate pipeline (with diagrams) |
| [configuring-llm-providers.md](configuring-llm-providers.md) | Add API keys for OpenAI, Anthropic, OpenRouter, Google Gemini; model picker; how keys are stored |
| [local-llm.md](local-llm.md) | Auto-detected Ollama / LM Studio / llama.cpp runtimes, free + private debates |
| [oauth.md](oauth.md) | ChatGPT subscription routing via OAuth, what it is, how it works, plan-tier detection |
| [pro.md](pro.md) | Trading Agents Lab Pro: the free, open-source full-pipeline companion app, free-vs-Pro comparison, API key vs OAuth guidance |
| [data-providers.md](data-providers.md) | yfinance (free default) and Alpaca (optional); what data the engine fetches |
| [crypto-tickers.md](crypto-tickers.md) | BTC, ETH, BTC/USD, etc, how crypto tickers are normalized and routed |
| [sentiment.md](sentiment.md) | StockTwits + Reddit pre-fetch for the sentiment_analyst |
| [cost-guard.md](cost-guard.md) | Daily / weekly / monthly USD caps + rate cap; per-run override flow |
| [webhooks.md](webhooks.md) | Push committee assessments to Telegram / Slack / Discord / your own HTTPS endpoint |
| [clawless-connector.md](clawless-connector.md) | What the optional Clawless gateway tap is and when it activates (Phase 6) |
| [reading-the-debate.md](reading-the-debate.md) | Walk through every element of the Analyze page as a debate runs |
| [keyboard-shortcuts.md](keyboard-shortcuts.md) | Full table of menu accelerators and page-level shortcuts |
| [security-and-storage.md](security-and-storage.md) | Where keys, OAuth tokens, and session history live on disk; encryption model |
| [troubleshooting.md](troubleshooting.md) | Common problems and remedies |
| [faq.md](faq.md) | Posture, license, what Trading Agents Lab is not, upstream and Clawless relationships |

---

## Recommended reading order for new users

1. [getting-started.md](getting-started.md), get the app running
2. [configuring-llm-providers.md](configuring-llm-providers.md), connect at least one provider so debates run live
3. [reading-the-debate.md](reading-the-debate.md), understand what you are looking at
4. [how-it-works.md](how-it-works.md), go deeper on how the multi-agent debate pipeline works
5. [faq.md](faq.md), licensing, posture, and the Clawless relationship

If you have a paid ChatGPT account and want to use it instead of an OpenAI API key, jump to [oauth.md](oauth.md) after the getting-started page.

---

## Technical reference

- Engine API contract: [docs/api.md](../api.md)
- Full architecture: [docs/architecture.md](../architecture.md)
