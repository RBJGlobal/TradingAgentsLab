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

You're connected. The Analyze-page "Run with" dropdown now lists *"OpenAI account (OAuth)"* as an option, with a separate model dropdown showing the Codex-supported model list.

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

The Codex backend supports a different (smaller) model list than the standard API. The Trading Agents Lab model dropdown for the OAuth path lists exactly the models that work with Codex:

- `gpt-5.4` (default, recommended)
- `gpt-5.4-mini`
- `gpt-5.1-codex-mini`
- `gpt-5.4-thinking`
- `gpt-5.4-thinking-mini`
- `gpt-5.4-thinking-high`

Unlike the API-key path, you cannot pick `gpt-4o`, `gpt-4o-mini`, or older models on the OAuth path, they're not exposed by the Codex backend.

---

## Anthropic and others

OAuth is **OpenAI only**. Anthropic explicitly bans OAuth flows in their Terms of Service, Trading Agents Lab respects this and only offers API-key auth for Anthropic. OpenRouter and Gemini are also API-key only (neither has a comparable subscription-routing mechanism today).

---

## OAuth in Trading Agents Lab Pro

> **Pro** This section describes Trading Agents Lab Pro, the full-depth companion app (free and open source). See [pro.md](pro.md) for what Pro is.

In Trading Agents Lab Pro, OAuth drives the **entire full-depth pipeline**, including the analysts' live tool calls (price history, indicators, fundamentals, news). The Codex backend speaks the same Responses API wire format the full engine already uses, so an OAuth run and an API-key run execute the identical twelve-role debate: same agents, same tools, same market data, same decision contract.

That makes the choice between an API key and OAuth a real decision in Pro, so here is an honest account of what actually differs.

### What is the same on both paths

- The engine, the agent roster, the debate structure, and the tool calls.
- The market data. Both paths fetch from the same sources for the same ticker and date.
- The committee assessment fields: stance, conviction, bull strength, bear strength, risk level, reasoning (plus Pro's modeled scenario range, time horizon, and written thesis).
- CostGuard, history, transcripts, and webhooks.

### What differs

| | API key | ChatGPT OAuth |
|---|---|---|
| Cost per run | Per-token, real money | $0 within your plan's rate limits |
| Model choice | Full API catalog, plus Anthropic, OpenRouter, and Gemini entirely | The Codex model list (GPT-5.4 family) only |
| Rate limits | API tier limits, predictable | Subscription rolling windows, not publicly documented |
| Endpoint | Official, versioned API | The Codex backend, an unofficial surface that OpenAI can change without notice |
| Provider style | You can pick a provider whose output style you prefer | OpenAI models only |

The "provider style" row deserves a plain explanation. We ran the same ticker on the same date through Pro twice, once over OAuth (OpenAI models) and once over an Anthropic API key, and compared the transcripts end to end. Both runs reached the **same committee assessment** at the same conviction level, grounded in the same market data with no numeric discrepancies. The differences were stylistic and structural: one run leaned harder on multi-year financial framing and produced more prescriptive risk parameters (specific allocation sizes, stop levels, hedge structures), the other was tighter, more hedged, and more explicit about the limits of its own sourcing. Neither style is objectively better; which one you prefer is a genuine matter of taste and workflow.

### Choosing, in practice

- **Prefer an API key** if you want the widest model and provider choice (including Anthropic and Gemini), predictable rate limits, or the specific analytical style of a non-OpenAI model. Analysts who treat the transcript as a research document to mine often land here.
- **Prefer OAuth** if you already pay for ChatGPT Plus or Pro and want full-depth runs at no marginal cost. A full Pro run makes dozens of model calls; on per-token billing that is real money per run, on OAuth it is covered by the subscription you already have.
- **You can keep both connected** and switch per run from the provider dropdown. Many users run OAuth day to day and switch to an API key when they want a second opinion in a different model's voice.

One practical caution: a twelve-role Pro run consumes a meaningful slice of a ChatGPT plan's rolling rate window. If you run several analyses back to back on OAuth, you may hit the window and see 429 errors until it resets. The API-key path is the escape hatch for the rest of the day.

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
