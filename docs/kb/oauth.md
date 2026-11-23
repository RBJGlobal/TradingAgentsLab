---
order: 50
---

# ChatGPT OAuth

*Use your paid ChatGPT subscription to power Trading Agents Lab debates, no API key, no per-token billing.*

> **For educational research and paper trading. This is not investment advice.**

---

## Why OAuth?

The standard OpenAI API charges per token. A power user running 50 debates per day on `gpt-4o-mini` spends pennies; the same user running 50 debates per day on `gpt-4o` or `gpt-5.4-pro` can rack up real money.

If you already pay $20-$200/month for a **ChatGPT** account (Plus, Pro, Team, Enterprise), you've already paid for substantial daily LLM usage, but that quota lives behind a different endpoint family than `api.openai.com`. Trading Agents Lab's OAuth flow lets you route debates through that subscription endpoint instead.

The result: $0 per debate (within your subscription's rate limits), with the deeper reasoning of GPT-5.4-class models available for free at point of use.

---

## How to connect

1. Open **Settings → LLM Providers**.
2. Find the **OpenAI account (OAuth)** row (separate from the OpenAI API-key row, you can have both connected).
3. Click **Connect**. A browser tab opens to chatgpt.com.
4. Sign in to ChatGPT if not already.
5. Approve the OAuth scope request.
6. The row updates to show your email and plan tier.

You're connected. The Analyze-page "Run with" dropdown now lists *"OpenAI (OAuth)"* as an option, with a separate model dropdown showing the Codex-supported model list.

To disconnect, click **Disconnect** on the same row. Both access and refresh tokens are wiped from the encrypted store.

---

## Plan-tier detection

When the OAuth flow completes, Trading Agents Lab decodes the access JWT and reads the `chatgpt_plan_type` claim from the `https://api.openai.com/auth` namespace. The detected tier is shown next to your email, *"plus plan"*, *"pro plan"*, *"team plan"*, etc.

If the tier comes back as **`free`**, a banner appears in Settings warning that Codex routing is unreliable on free-tier accounts. Free-tier debates may fail with quota errors or fall back to lower-quality models. **Paste an API key instead** if you're on the free tier.

This detection is defensive, if the JWT can't be decoded for any reason, the banner doesn't appear and you can still attempt debates. But the UI surfaces the plan tier as much as it can so you know what you're paying for.

---

## What's actually happening under the hood

Conventional OpenAI API calls (e.g. with an `sk-...` API key) hit:

```
https://api.openai.com/v1/chat/completions
```

This is the **per-token billing** endpoint family. OAuth tokens against this endpoint will not route through your ChatGPT subscription, they'll be charged at API rates against the API tier of your account, which is a separate billing surface from your ChatGPT plan.

ChatGPT's web client and the official Codex CLI hit a different endpoint:

```
https://chatgpt.com/backend-api/codex/responses
```

This is the **Codex backend**, the same family that powers the ChatGPT web app and the Codex CLI, with billing handled via your ChatGPT subscription rate limits rather than per-token charges.

Trading Agents Lab's OAuth path uses the Codex backend, sending requests with:

- `Authorization: Bearer <access_token>`
- `chatgpt-account-id: <account_id>` (also extracted from the JWT)
- A request body matching the Codex CLI's wire format (no `temperature`, no `max_output_tokens`, the Codex backend rejects both)
- Server-Sent Events (SSE) parsing on the response stream

The OpenAI Codex adapter (`engine/llm_providers.py::OpenAICodexAdapter`) wraps all of this behind the same `LLMAdapter` Protocol used for API-key paths, so the rest of the engine doesn't have to care.

This integration is built on `@earendil-works/pi-ai` (MIT-licensed npm package) for the OAuth flow itself. The Codex routing logic is hand-rolled in the Python engine to keep the runtime fully under our control.

---

## Cost & quota model

| Path | Cost | Limit |
|---|---|---|
| OpenAI API key | Per-token ($/1M tokens) | API tier rate limits (RPM/TPM) |
| OpenAI OAuth | $0 per request | ChatGPT subscription rate limits, varies by plan |

**Important:** OAuth debates eat your ChatGPT subscription quota. If you hit your plan's rate limit, debates will fail until the limit resets. The exact rate limits are not publicly documented and can change, ChatGPT Plus, for example, has historically been ~80 messages per 3-hour window for GPT-4 class models.

**Verification:** After your first OAuth debate, check your **OpenAI billing dashboard** to confirm the run did *not* add to your API tier. If it did, the request routed through the API endpoint instead of Codex, open an issue on GitHub.

---

## Models available via OAuth

The Codex backend supports a different (smaller) model list than the standard API, and OpenAI changes it on its own schedule. The model dropdown for the OAuth path is therefore **live**: it shows the models your ChatGPT account can use right now, read from OpenAI when you open Analyze. The first model in that list is the default. If a model you picked is retired, the dropdown and the next run move to your account's current default. A line under the dropdown shows whether the list is live, saved from last time, or the built-in list (if OpenAI could not be reached), with a **Refresh** button.

Unlike the API-key path, you cannot pick `gpt-4o`, `gpt-4o-mini`, or older models on the OAuth path, they're not exposed by the Codex backend.

---

## Anthropic and others

OAuth is **OpenAI only**. Anthropic explicitly bans OAuth flows in their Terms of Service, Trading Agents Lab respects this and only offers API-key auth for Anthropic. OpenRouter and Gemini are also API-key only (neither has a comparable subscription-routing mechanism today).

---

## Troubleshooting

**"Free tier detected" banner appears.** You're connected with a free-tier ChatGPT account. Codex routing is unreliable here, paste an OpenAI API key in the API-key row instead.

**429 rate limit error.** You've hit your subscription's rate window. Wait an hour or switch to the API-key path for the rest of the day.

**400 "Unsupported parameter" error.** The Codex backend rejects parameters the standard API accepts. This shouldn't happen in normal operation, if you see it, file an issue on GitHub with the full error message.

**Connection appears to succeed but debates fail.** Try **Disconnect** then **Connect** again to refresh the OAuth tokens. If the failure persists, fall back to API-key auth and check your OpenAI account status.

---

## Further reading

- [configuring-llm-providers.md](configuring-llm-providers.md), main provider configuration page
- [security-and-storage.md](security-and-storage.md), how OAuth tokens are encrypted at rest
- [troubleshooting.md](troubleshooting.md), broader troubleshooting guide
- Engine API reference: [docs/api.md](../api.md)
