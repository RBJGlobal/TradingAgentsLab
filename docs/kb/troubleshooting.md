# Troubleshooting

*Common problems and how to fix them.*

---

## Engine problems

### "Engine starting, sidecar handshake pending" never clears

The Python sidecar didn't start or didn't emit its handshake line.

**Steps:**

1. Check that the engine venv exists:
   ```bash
   ls engine/.venv/bin/python
   ```
   If missing, run:
   ```bash
   python3.13 -m venv engine/.venv
   source engine/.venv/bin/activate
   pip install -r engine/requirements.txt
   ```

2. Try starting the engine manually to see the error:
   ```bash
   engine/.venv/bin/python -m engine
   ```
   The first line of stdout should be JSON `{"port": ..., "token": "..."}`. If instead you see a Python traceback, that is the problem.

3. Run the smoke test for a full self-check:
   ```bash
   bash tools/dev-smoke.sh
   ```
   This starts the engine, exercises all endpoints, and prints pass/fail for each assertion. Any failures include the relevant output.

### "Engine failed to start: \<message>"

The Analyze page shows this in the helper text when `getHealth()` fails after the handshake.

Common causes:
- Port conflict, another process is already on the randomly chosen port (rare, since the port is dynamic).
- `requirements.txt` not installed, the venv is missing `fastapi` or `uvicorn`. Reinstall with `pip install -r engine/requirements.txt`.
- Python version mismatch, the engine requires Python 3.13. Check `engine/.venv/bin/python --version`.

---

## Debate / stream problems

### Debate runs but shows stub messages even after configuring a provider

The Analyze page should inject your stored credentials automatically. If you still see stub messages:

1. Check that the **"Run with"** dropdown in the Analyze header shows your provider (not "Stub mode"). If only stub is offered, the credentials weren't successfully decrypted, try **Replace** in Settings to re-save the key.
2. If the dropdown shows your provider but the assessment card still says "Stub canned debate", look at engine stderr (visible in the Vite terminal) for messages prefixed `[live_debate]`. A fall-through to stub usually means the provider name in the WS start frame doesn't match the engine's allowlist (`openai`, `anthropic`, `openrouter`, `gemini`).
3. For OAuth specifically, if **Settings → OpenAI account** shows "Connected" but debates run as stub, click **Disconnect** and **Connect** again to refresh the tokens.

The assessment card's reasoning text says "Stub canned debate" to make this visible.

### OAuth: 429 rate limit error

You've exceeded your ChatGPT subscription's rate window. ChatGPT Plus/Pro accounts have rolling-window limits (often ~80 messages per 3 hours for GPT-4-class models). Wait an hour or switch to the API-key path for the rest of the day. See [oauth.md](oauth.md).

### OAuth: free-tier banner appears

Codex routing is unreliable on free-tier ChatGPT accounts. Paste an OpenAI API key on the API-key row and pick that path on the Analyze "Run with" dropdown instead.

### Stream error banner appears mid-debate

The WebSocket closed with an unexpected code. Common causes:
- The engine process was killed externally (e.g., OS memory pressure, manual kill).
- A network condition interrupted the loopback connection (rare on 127.0.0.1).

Fix: click **Analyze** again to start a new session. If the error recurs, restart the app.

### Debate completes instantly with no agent messages

The WebSocket opened and closed in under a second. This usually means authentication failed (wrong token) or the engine was restarted between when the renderer fetched the handshake and when it opened the stream. Restarting the app resets the handshake cache.

---

## Data problems

### "yfinance returns no data" / data summary strip is absent

The price summary strip is absent when `data.summary` was not emitted. This happens when:

- **Unknown ticker:** yfinance has no data for that symbol. Check the ticker spelling.
- **Weekend or holiday date:** the date you entered falls on a non-trading day. The engine will anchor to the most recent prior trading day, but if the entire lookback window has no bars, it raises `DataUnavailable`. Try a weekday date.
- **Future date:** the date picker is capped at today, but if you bypass this, future dates produce no bars.
- **Network issue:** yfinance can rate-limit or time out. Wait a minute and try again.

The debate still runs when data is unavailable, analyst messages fall back to generic language rather than referencing specific prices.

### yfinance news headlines are empty

This is normal for some tickers or at certain times of day. Yahoo Finance's news API does not guarantee coverage for every ticker. The debate runs without the news card.

---

## Settings / secret storage problems

### "Encryption backend unavailable on this OS"

This error appears at the top of the Settings page on Linux when no keyring is running.

`safeStorage` on Linux requires a running secret-service implementation (GNOME Keyring, KWallet, etc.). Without it, the app refuses to store secrets in plaintext, the hard-fail is intentional.

**Fix on Linux:**
- Install and start GNOME Keyring: `gnome-keyring-daemon --start`
- Or install and configure KWallet.
- Then restart Trading Agents Lab.

On macOS and Windows, encryption is always available and this error should not occur.

### secrets.json is corrupt

The app will show an error if `secrets.json` cannot be parsed. To recover:

```bash
# macOS
rm ~/Library/Application\ Support/TradingAgentsLab/secrets.json
```

The file will be recreated empty on next launch. You will need to re-enter your API keys.

---

## Desktop / Electron problems

### App window doesn't open

- Confirm `npm --prefix desktop install` was run.
- Try `npm --prefix desktop run dev` from the repo root and look for errors in the terminal output.
- Check that Node.js 20+ is installed: `node --version`.

### Type-check errors during development

Run:
```bash
npm --prefix desktop run type-check
```

Fix any errors before running the app, type errors in `electron/` can prevent the main process from starting.

---

## Verifying the backend independently

If the UI is not streaming and you want to rule out a backend problem, run the smoke test:

```bash
bash tools/dev-smoke.sh
```

The smoke test starts the engine, runs 8 assertions (auth, CORS, HTTP endpoints, WebSocket), and prints a pass/fail summary. It does not involve Electron or the renderer. If all 8 pass, the problem is in the renderer or Electron main process.

---

## Further reading

- [Getting started](getting-started.md), initial setup, venv creation
- [Security and storage](security-and-storage.md), secrets.json location, Linux keyring
- [How it works](how-it-works.md), stub mode vs. live mode
