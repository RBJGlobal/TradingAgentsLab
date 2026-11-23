---
order: 110
---

# Webhooks

Push every completed debate's committee assessment to your own systems, Telegram, Slack, Discord, or any HTTPS endpoint. Useful for getting notified on a phone while an overnight analysis runs, logging assessments to a spreadsheet for backtesting later, or bridging the analysis output to your own broker via a small script.

**Trading Agents Lab does not execute trades.** Webhooks are an analysis handoff. They push the JSON assessment payload to your receivers; if you want to act on it (e.g. place an order with your brokerage), your receiving script does that part with your own broker credentials, on the regulated platform. This is the locked-positioning firewall, your app, your auth, your responsibility.

## Where to configure

`Settings → Webhooks → + Add webhook`

Per-webhook you set:

- **Name**, anything human-readable, shown in the post-debate report
- **Kind**, Telegram, Slack, Discord, or Generic JSON
- **URL**, the webhook endpoint (treated as a secret; stored via OS keychain)
- **Chat ID** (Telegram only)
- **HMAC secret** (Generic only), sent as `X-TAL-Signature: sha256=<hex>`
- **Filter**, fire only on certain stances and/or above a conviction threshold

Filters are optional. Leave the stance checkboxes empty and conviction slider at 0% to fire on every debate.

## Recipes

### Telegram (recommended for phone alerts)

1. On Telegram, message [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts. Save the **bot token** it gives you.
2. Message your new bot anything (it has to send first, you can't DM it cold).
3. Message [@userinfobot](https://t.me/userinfobot), it replies with your numeric **chat ID**.
4. In TAL: `+ Add webhook` → Kind: **Telegram** → URL: `https://api.telegram.org/bot<TOKEN>/sendMessage` → Chat ID: your numeric ID.

For group chats: add the bot to the group, send a message in the group, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to find the negative chat ID (e.g. `-100123456789`).

### Slack

1. In Slack: `Apps → Incoming Webhooks → Add to Slack → pick channel → save`. Slack gives you a webhook URL.
2. In TAL: Kind: **Slack** → paste the URL. No other fields needed.

### Discord

1. In a Discord server: `Server Settings → Integrations → Webhooks → New Webhook → pick channel → copy URL`.
2. In TAL: Kind: **Discord** → paste the URL.

### Generic (your own script / Cloudflare Worker / Lambda)

The payload schema is `tradingagentslab.webhook.v2`. The `decision` block carries the full analytical stance model:

```json
{
  "schema": "tradingagentslab.webhook.v2",
  "event": "session.complete",
  "ticker": "NVDA",
  "trade_date": "2026-05-15",
  "decision": {
    "stance": "bullish",
    "conviction": 0.78,
    "bull_strength": 78,
    "bear_strength": 42,
    "risk_level": "moderate",
    "reasoning": "..."
  },
  "session_id": "01923f...",
  "live": true,
  "provider": "openai",
  "model": "gpt-4o-mini",
  "estimated_cost_usd": 0.0042
}
```

Stance values: `bullish` | `moderately_bullish` | `neutral` | `moderately_bearish` | `bearish`. Conviction is 0..1. Bull and bear strengths are 0-100 integer scores. Risk level is `low` | `moderate` | `elevated`.

Set an **HMAC shared secret** on the generic webhook to sign the body. Your receiver verifies by recomputing:

```python
import hmac, hashlib
sig = request.headers["X-TAL-Signature"].removeprefix("sha256=")
expected = hmac.new(SECRET.encode(), request.body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(sig, expected):
    return 403
```

### Building your own rule on top (illustrative)

The assessment is analysis, not an instruction: nothing in the payload tells any system to trade, and the app never will. If you choose to build automation on top of it, that mapping from stance to action is a rule **you** define, running on **your** receiver, under **your** credentials and authority. Example of such a rule, a Cloudflare Worker that keeps your own research log:

```ts
export default {
  async fetch(req: Request, env: Env) {
    if (req.method !== 'POST') return new Response('only POST', { status: 405 });
    const body = await req.json<TalAssessment>();

    // Your own rule: keep only bullish assessments with conviction of 75% or more.
    if (!['bullish', 'moderately_bullish'].includes(body.decision.stance)) return new Response('skip');
    if (body.decision.conviction < 0.75) return new Response('skip');

    // Append a row to your own research log (a KV namespace you created).
    const key = `${body.ticker}:${body.trade_date}`;
    await env.RESEARCH_LOG.put(key, JSON.stringify({
      stance: body.decision.stance,
      conviction: body.decision.conviction,
      received_at: new Date().toISOString(),
    }));
    return new Response('ok');
  },
};
```

What you do with your own log is up to you. The app does not see your receiver's data and does not know whether you acted on an assessment.

## Mechanics

- Webhooks fire **once per debate**, after `session.complete`, before the WebSocket closes.
- Each webhook gets a **5-second timeout**. Multiple webhooks fire in parallel, total wall-clock is roughly the slowest receiver.
- **No retry queue** in v1. If a receiver is down, it shows up as `failed` in the post-debate report and that's the end of it. Re-run the analysis if you care.
- Stub debates fire webhooks too. Handy for testing your receiver without burning provider quota.
- The post-debate **Webhooks** card on the Analyze page shows `fired`, `filtered`, or `failed` per receiver. URLs are never displayed, bot tokens stay private.

## Privacy

- Webhook URLs are stored via Electron's `safeStorage`, encrypted at rest by the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
- URLs and HMAC secrets never appear in the engine's stderr logs.
- URLs never appear in the `webhook.report` event the renderer receives, so they never end up in History replays.

## What v1 doesn't do

- No retry queue. If a webhook fails, it fails for that debate.
- No batch / summary webhook across multiple tickers. The Watchlist **Run all** batch runs each ticker in turn, and each ticker fires your configured webhooks as its own debate finishes, so receivers get one payload per ticker.
- No per-receiver custom payload template, Telegram/Slack/Discord get short-form text; Generic gets the full JSON.
- No scheduled / cron-style runs. Set this up via your own watchlist + cron + the engine HTTP API if you want morning auto-analysis today.
