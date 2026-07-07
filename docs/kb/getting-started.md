# Getting Started

*How to clone the repo, set up the engine, install the desktop, and run Trading Agents Lab for the first time.*

> **For educational research and paper trading. This is not investment advice.**

---

## Prerequisites

- **macOS**, the app is developed and tested on macOS. Windows and Linux are not tested today; they may work but you may hit rough edges (see [troubleshooting.md](troubleshooting.md)).
- **Python 3.13**, the engine sidecar requires Python 3.13. Check with `python3 --version`.
- **Node.js 20+**, the desktop app requires Node.js. Check with `node --version`.
- **Git**, to clone the repo.

---

## Step 1: Clone the repository

```bash
git clone https://github.com/RBJGlobal/TradingAgentsLab.git
cd TradingAgentsLab
```

The repo has two main remotes:

- `origin`, `https://github.com/RBJGlobal/TradingAgentsLab.git` (this fork, AGPL-3.0)
- `upstream`, `https://github.com/TauricResearch/TradingAgents.git` (Apache 2.0 source)

You only need `origin` to run the app.

---

## Step 2: Set up the engine virtual environment

The engine is a Python sidecar (`engine/`). It needs its own virtual environment.

```bash
# Create a venv using Python 3.13
python3.13 -m venv engine/.venv

# Activate it (macOS / Linux)
source engine/.venv/bin/activate

# Install dependencies
pip install -r engine/requirements.txt
```

The `requirements.txt` installs:

- `fastapi` + `uvicorn`, the HTTP/WebSocket server
- `yfinance`, free market data (no key required)
- `openai`, for live-LLM debates once you configure a key
- `websockets`, WebSocket support for uvicorn

The venv must live at `engine/.venv`, that is the path the Electron main process uses to spawn the sidecar automatically.

### Verify the engine works

You can run the backend smoke test independently of the Electron app:

```bash
bash tools/dev-smoke.sh
```

This starts the engine sidecar, exercises every endpoint, and exits with a pass/fail summary. It takes about 15 seconds. If all 8 checks pass, the engine is healthy.

---

## Step 3: Install desktop dependencies

```bash
npm --prefix desktop install
```

This installs Electron, React, Vite, and TypeScript tooling into `desktop/node_modules/`.

---

## Step 4: Run in development mode

```bash
npm --prefix desktop run dev
```

This:

1. Starts a Vite dev server for the React renderer (hot-reload enabled).
2. Launches Electron, which opens the app window.
3. Electron's main process spawns the Python engine sidecar automatically, reads `{port, token}` from its stdout, and makes the handshake available to the renderer.

When the app opens, the Analyze page loads. The **Engine** status card in the middle of the page should flip from "Starting…" to "Running" (green dot) within 2-3 seconds.

---

## Step 5: Run your first analysis

1. The Analyze page defaults to ticker `NVDA` and today's date.
2. Click **Analyze** (or press `Cmd+Enter`).
3. The debate streams in over about 7 seconds, analysts, then researchers, then the trader, then the risk panel, then a final committee assessment.

By default, with no LLM provider configured, the debate is a **stub**: agent messages reference real Yahoo Finance data but the reasoning is canned. To activate real LLM reasoning, connect at least one provider (OpenAI, Anthropic, OpenRouter, Google Gemini, xAI Grok, or MiniMax, by API key or, for OpenAI, ChatGPT OAuth, or point it at a local runtime). See [configuring-llm-providers.md](configuring-llm-providers.md) and [oauth.md](oauth.md).

---

## Development tips

### Type-check the renderer

```bash
npm --prefix desktop run type-check
```

### Production build (renderer only)

```bash
npm --prefix desktop run build
```

Vite emits a production bundle to `desktop/dist/`. This is useful to check for build errors; you still need Electron to actually run the app.

### Running smoke tests against a specific ticker

```bash
bash tools/dev-smoke.sh AAPL 2026-05-01
```

The smoke script accepts an optional ticker and trade date. It exits 0 when all assertions pass.

---

## Next steps

- [Configuring LLM providers](configuring-llm-providers.md), paste your OpenAI key to turn on real-LLM debates
- [Reading the debate](reading-the-debate.md), understand the Analyze page
- [Keyboard shortcuts](keyboard-shortcuts.md), speed up your workflow
