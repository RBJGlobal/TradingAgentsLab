# Configuring LLM Providers

*How to connect OpenAI, Anthropic, OpenRouter, Google Gemini, xAI Grok, and MiniMax; how to pick which provider and model each debate uses; how keys are stored.*

> **For educational research and paper trading. This is not investment advice.**

---

## What ships today

Trading Agents Lab supports seven LLM provider families. All seven can drive a real-LLM debate end-to-end:

| Provider | Auth options | Default model | Notes |
|---|---|---|---|
| **OpenAI** | API key **or** ChatGPT OAuth | `gpt-4o-mini` (key) / `gpt-5.4` (OAuth) | OAuth routes through your ChatGPT subscription, not per-token API billing, see [oauth.md](oauth.md). |
| **Anthropic** | API key only | `claude-haiku-4-5` | OAuth is **not** supported, banned by Anthropic Terms of Service. |
| **OpenRouter** | API key | `openrouter/auto` | One key, hundreds of models. Useful as a single-key multi-model fallback. |
| **Google Gemini** | API key | `gemini-2.0-flash` | Gemini 2.x and 3.x; 3.1 Flash-Lite is the GA cost-efficient pick. |
| **xAI Grok** | API key | `grok-4.3` | Grok 4.3 plus the Grok 4.20 family. |
| **MiniMax** | API key | `MiniMax-M2.7-highspeed` | MiniMax M2.x (Global region, 204K context). |
| **Local LLM** | Auto-detect (no key) | Dynamic, whatever your runtime exposes | Ollama, LM Studio, or any OpenAI-compatible localhost server. Free, private, $0. See [local-llm.md](local-llm.md). |

All providers use the same shared `LLMAdapter` Protocol on the engine side, so adding more providers later is a matter of one new adapter class plus an entry in the priority list.

The **priority order** when multiple are configured is: OpenAI → Anthropic → OpenRouter → Gemini → xAI → MiniMax → Local. Local is last so paid keys auto-win for analysis quality, but you can override per-debate via the **Run with** dropdown on Analyze.

---

## Where to go in the UI

Open Settings from the sidebar or press `Cmd+,`. Select the **LLM Providers** tab.

Each provider appears as a row. Connected providers show a **green pill** ("Connected ✓") and the last 4 characters of the key as a hint. You can **Replace** or **Delete** a stored key at any time.

The OpenAI row has two sub-rows: **API key** and **OpenAI account (OAuth)**. You can connect both, one will be picked as the active path per session via the Analyze-page picker.

---

## Adding a key

1. Go to **Settings → LLM Providers**.
2. Click **Configure** next to the provider you want.
3. Paste your key into the password field. The field is masked.
4. Click **Save**.

The key is encrypted by your OS keychain before touching disk. You never see it again, only the `…last4` hint is displayed afterward.

To replace a key, click **Replace** and paste the new value. The old ciphertext is overwritten atomically.

To remove a key, click **Delete**. The encrypted entry is erased from `secrets.json`.

---

## Connecting via OAuth (OpenAI only)

If you have a paid ChatGPT account (Plus, Pro, Team, or Enterprise), you can connect it via OAuth instead of pasting an API key. This routes debates through your **ChatGPT subscription**, no per-token API billing.

1. In **Settings → LLM Providers**, find the **OpenAI account (OAuth)** row.
2. Click **Connect**.
3. A browser tab opens to ChatGPT. Sign in if needed and approve the connection.
4. The row updates to show your email and detected plan tier (e.g. *"you@example.com · plus plan"*).

If the JWT decodes to a **free** plan, a banner appears warning that Codex routing is unreliable on free accounts, paste an API key instead in that case.

OAuth tokens live in the same encrypted store as API keys. You can disconnect at any time with **Disconnect**, which clears both the access and refresh tokens.

For the full OAuth flow + Codex backend technical details, see [oauth.md](oauth.md).

---

## Picking which provider runs your debate

When multiple providers are configured, the **Analyze page header** shows a "Run with" dropdown listing every connected provider plus the OpenAI OAuth row when present. The dropdown selection persists across sessions in `localStorage`.

Below it, a second dropdown lets you pick the specific model for the active provider. Each (provider, auth-mode) pair remembers its last-chosen model independently, switching from "OpenAI · gpt-4o" to "OpenAI account (OAuth) · gpt-5.4" and back will restore your previous picks for each.

If no provider is configured, the dropdown is disabled and debates run in **stub mode** (canned debate using real yfinance data, see [how-it-works.md](how-it-works.md)).

The default-active provider when you have multiple keys: first in the priority list (OpenAI → Anthropic → OpenRouter → Gemini). Use **Reset overrides** under the dropdown to clear manual selections and fall back to the recommended pre-selection.

---

## How keys are stored

Trading Agents Lab uses Electron's `safeStorage` API, which wraps:

- **macOS:** Keychain Services
- **Windows:** DPAPI (Data Protection API)
- **Linux:** libsecret / secret-service

The file at `<userData>/secrets.json` contains only base64-encoded ciphertext, never plaintext. The exact path is shown in **Settings → About**.

Each entry records:

- `hint`, the last 4 plaintext characters (for UI identification, not security)
- `updatedAt`, ISO-8601 timestamp of the last save
- `cipher`, base64 of the OS-encrypted bytes

OAuth credentials are stored under a separate `oauth:openai` key prefix, with the access token, refresh token, expiry, email, account ID, and decoded plan tier all encrypted as a single JSON blob.

**The encrypted blob is machine- and user-bound.** Copying `secrets.json` to another machine will not work, the ciphertext cannot be decrypted there. See [security-and-storage.md](security-and-storage.md).

---

## Cost expectations

| Path | Per-debate cost | Notes |
|---|---|---|
| Stub (no provider) | $0 | Canned debate with real yfinance data. Useful for UI verification. |
| OpenAI API · `gpt-4o-mini` | ~$0.001-$0.003 | Default. Cheap enough for hundreds of runs per dollar. |
| OpenAI API · `gpt-4o` | ~$0.02-$0.05 | Deeper reasoning, ~10× cost. |
| OpenAI OAuth · any Codex model | $0 (per-token) | Routes through your ChatGPT subscription. Subject to subscription rate limits, your plan tier determines how many debates per hour you can run. |
| Anthropic · `claude-haiku-4-5` | ~$0.005-$0.01 | Cheap baseline. |
| Anthropic · `claude-sonnet-4-6` | ~$0.03-$0.06 | Deeper reasoning. |
| OpenRouter · `openrouter/auto` | varies | Auto-routes to cheapest capable model. |
| Gemini · `gemini-3.0-flash` | ~$0.001-$0.005 | Cheap baseline. |

The `session.complete` event in live mode carries `estimated_cost_usd`, `input_tokens`, and `output_tokens` for cost tracking. OAuth sessions report `estimated_cost_usd: 0` since billing is via subscription.

A future **Cost Guard** feature will let you set per-day / per-week / per-month budget caps to prevent runaway spend.

To keep costs low:

- Default to `gpt-4o-mini`, `gemini-3.0-flash`, or `claude-haiku-4-5`.
- Use the Stop button (`Cmd+.`) if you want to abort mid-debate.
- Stub mode (no key configured) has zero API cost.
- ChatGPT OAuth has zero per-token cost, but eats your subscription quota.

---

## Further reading

- [how-it-works.md](how-it-works.md), stub mode vs. live mode explained
- [oauth.md](oauth.md), ChatGPT subscription routing in depth
- [security-and-storage.md](security-and-storage.md), detailed key storage model
- [troubleshooting.md](troubleshooting.md), what to do when a debate fails
- Engine API reference: [docs/api.md](../api.md)
