# Local LLM (Ollama / LM Studio)

*Run the multi-agent debate entirely on your own machine with Ollama or LM Studio: no API key, no per-token bill, no data leaves your computer.*

> **For educational research and paper trading. This is not investment advice.**

---

## What it is

TradingAgentsLab can route the multi-agent debate through a local LLM runtime, Ollama, LM Studio, llama.cpp's server, or any OpenAI-compatible server you run on your machine. Cost is $0. Data stays local. Trade-off: model quality depends entirely on what you have installed (a 3-billion-parameter model on a laptop is meaningfully weaker than gpt-5 or Claude Opus 4.7 on a paid API).

This is fully optional. If you have an OpenAI / Anthropic / OpenRouter / Gemini key configured, the system will prefer it for debate quality. Local appears in the **Run with** dropdown so you can flip to it explicitly whenever you want zero-cost / private runs.

---

## Auto-detection

Open **Settings → LLM Providers** and scroll to the **Local LLM (Ollama / LM Studio)** section. On mount, the engine probes three well-known localhost endpoints in parallel:

| Runtime | Probe URL |
|---|---|
| Ollama | `http://localhost:11434/v1/models` |
| LM Studio | `http://localhost:1234/v1/models` |
| llama.cpp server | `http://localhost:8080/v1/models` |

Each probe has a 1.5-second timeout, so the section appears almost instantly even if nothing is running. A runtime that responds with a model list gets a row showing its name, URL, and a **Model** dropdown listing every installed model. Pick a model from the dropdown, the system stores your (URL, model) choice and the **Connected ✓** badge appears.

If nothing is detected, the section shows installation links for [Ollama](https://ollama.com) and [LM Studio](https://lmstudio.ai). Install one, click **Refresh**, and your runtime should appear.

> **What auto-detection does NOT do:** it does **not** scan your filesystem for model files (`.gguf`, `.safetensors`, etc.). Models on disk without a runtime cannot be invoked, you need Ollama or LM Studio to provide the HTTP serving layer.

---

## Setting up Ollama

1. Install Ollama from [ollama.com](https://ollama.com).
2. Pull a model. For trading agent work, decent baselines:
   - `ollama pull llama3.2` (~2GB, fast on most machines, baseline quality)
   - `ollama pull qwen2.5:7b` (~5GB, stronger reasoning, slower)
   - `ollama pull llama3.1:8b` (~5GB, the standard mid-tier choice)
3. Ollama starts as a daemon automatically on macOS / Windows, on `http://localhost:11434`. TradingAgentsLab expects the OpenAI-compatible base URL `http://localhost:11434/v1`. Verify it is up with `curl http://localhost:11434/v1/models`.
4. In TradingAgentsLab, open **Settings → LLM Providers**, click **Refresh**, and you should see "Ollama" listed with your pulled models in the dropdown.

> **Ollama vs LM Studio:** Ollama runs as a background daemon and serves *every* model you have pulled, so there is no "start server" step and no need to pre-load a single model the way LM Studio does. The flip side is the model-name gotcha: the id you select must match the `ollama list` tag exactly, and Ollama defaults the tag to `:latest` (so `ollama pull llama3.2` is served as `llama3.2:latest`). When you pick from the **Refresh**-populated dropdown this is handled for you; it only bites if you type a model id by hand in the manual Base URL field.

---

## Setting up LM Studio

1. Install LM Studio from [lmstudio.ai](https://lmstudio.ai).
2. Download a model through LM Studio's UI (it has a built-in catalog browser).
3. Open LM Studio's **Local Server** tab and click **Start Server**. By default it binds to `http://localhost:1234`.
4. In TradingAgentsLab, click **Refresh** in the Local LLM section. LM Studio appears with the currently-loaded model.

> **Heads-up:** LM Studio only exposes the model that's actively loaded in its UI. If you switch models in LM Studio, click **Refresh** in TradingAgentsLab so the dropdown reflects the new selection.

---

## Manual entry (custom or non-standard runtimes)

If your runtime listens on a non-standard port or you're running an OpenAI-compatible server we don't auto-probe, click **Manual entry**. Fill in:

- **Base URL**, the OpenAI-compatible chat-completions root. Examples:
  - `http://localhost:11434/v1` (Ollama default)
  - `http://localhost:1234/v1` (LM Studio default)
  - `http://192.168.1.50:11434/v1` (Ollama on another machine on your LAN)
- **Model**, the exact model id the runtime accepts. For Ollama, this is the model tag (`llama3.2:latest`, `qwen2.5:7b`). For LM Studio, it's whatever's listed in `GET /v1/models`.

Click **Save**. The (URL, model) pair is encrypted via your OS keychain just like API keys.

---

## Picking a model for a debate

When **local** is the active provider, the Run-with dropdown on the **Analyze** page shows it like any other provider. The model used is whatever you saved in Settings, there's no separate model picker on Analyze for local runtimes, because the model list is dynamic per runtime.

To switch models, return to **Settings → LLM Providers** and pick a different one from the dropdown next to your detected runtime.

---

## Cost behavior

Local LLM sessions are treated as **$0** by the Cost Guard:

- They are **exempt** from the daily / weekly / monthly USD caps.
- They **still hit** the optional sessions-per-day rate cap, even free runs benefit from quota discipline on runaway debate counts.

This mirrors how Cost Guard treats OpenAI OAuth sessions, which also have no per-token cost from our perspective.

---

## Performance tips

- **Memory matters more than core count.** A 7B model in 4-bit quantization needs roughly 5GB of free RAM (Ollama) or VRAM (LM Studio with GPU offload). Going larger than your machine can hold causes swapping that makes the debate take minutes instead of seconds.
- **First-call latency** can be high if the runtime has to load the model from disk. Run a test query through Ollama's `ollama run` CLI or LM Studio's chat UI before clicking **Analyze**.
- **Context window**. Our debate context (summary + headlines + transcript so far) is typically under 4k tokens. Most Ollama and LM Studio models handle 8k+ comfortably, so this is rarely the bottleneck.

---

## Privacy

When **local** is the active provider:
- The ticker symbol and trade date are sent to your local runtime.
- That's the entire outbound LLM transmission. Nothing routes through OpenAI, Anthropic, OpenRouter, or Gemini.
- The runtime's models, and any conversations with them, stay on your machine.

TradingAgentsLab itself still makes outbound requests for **data**, yfinance for OHLCV, optionally Alpaca for higher-quality market data, and (when the sentiment_analyst runs) StockTwits + Reddit for social signal. These are unrelated to the LLM provider you've chosen. See [data-providers.md](data-providers.md) and [security-and-storage.md](security-and-storage.md) for the full network-call inventory.

---

## Troubleshooting

**"No local runtime detected"**, none of Ollama / LM Studio / llama.cpp's server is listening on the expected port. Verify with `curl http://localhost:11434/v1/models` (Ollama) or `curl http://localhost:1234/v1/models` (LM Studio). If they respond but TradingAgentsLab still doesn't detect them, check that the URL you can `curl` is exactly one of those defaults.

**"Detection error: …"**, the engine sidecar couldn't reach its own `/llm/local-runtimes` endpoint. Restart the app and try again. If it persists, check the engine log in **About → Open engine log**.

**Debate fails with a model error**, confirm the model is loaded:
- Ollama: `ollama list` should include the exact model id you saved (with `:latest` or whatever tag).
- LM Studio: the model must be loaded in the **Local Server** tab, not just downloaded.

**Debate takes much longer than with an API provider**, local runtimes are CPU-bound (or GPU-bound) on your machine. A 7B model on a laptop CPU can take 30-60 seconds per agent. The 12-agent debate totals ~5-10 minutes on slower setups. If this is too slow, either use a smaller model (e.g. `llama3.2:1b`) or use an API provider.

**The model produces low-quality analysis**, small local models (under ~7B parameters) often struggle with the multi-step reasoning the debate demands. Try a stronger model (`qwen2.5:14b`, `llama3.1:70b`), or keep local for development testing and use a paid API for real analysis.

---

For the underlying engine API contract, including the `/llm/local-runtimes` endpoint and the WS start frame `auth: { type: 'local', base_url }` shape, see [docs/api.md](../api.md).
