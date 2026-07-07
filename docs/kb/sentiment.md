# Social sentiment (StockTwits + Reddit)

*The sentiment_analyst agent grounds its analysis in real social data, bullish/bearish ratios from StockTwits and recent discussion from finance subreddits. No API key required.*

> **For educational research and paper trading. This is not investment advice.**

---

## What it does

Before the multi-agent debate runs, the engine pre-fetches two social data sources for the ticker:

1. **StockTwits**, recent messages tagged with the ticker (e.g. `$NVDA`, `$BTC.X`). Each message includes a user-labeled **Bullish** / **Bearish** / no-label tag.
2. **Reddit**, recent posts from finance subreddits that mention the ticker, scored by upvote count and comment volume.

Both are public, no-auth, no-API-key endpoints. The fetch happens in parallel with summary + headlines so it doesn't add measurable latency.

The data is injected into the **sentiment_analyst**'s prompt as structured plaintext blocks. The agent uses them to produce grounded commentary (e.g. "StockTwits is 60% bullish but r/wallstreetbets is uniformly skeptical, divergence suggests retail enthusiasm without institutional follow-through") instead of fabricating posts.

---

## Why it matters

The previous version of the sentiment_analyst had a prompt asking for "what the tape and headlines collectively imply about market sentiment", but it had no actual social signal to ground in. LLMs under prompt pressure will invent Reddit posts and StockTwits messages, which is misleading and unfalsifiable.

The fix: hand the agent the actual messages. The prompt now explicitly instructs the agent to **quote ratios**, **name specific subreddits**, and **flag divergence** between the social tone and the price action. If the data is missing or sparse (small-cap tickers, weekends, new symbols), the agent is told to say so explicitly and fall back to the tape + headlines.

---

## How the data is sourced

| Source | URL | Auth | Volume |
|---|---|---|---|
| StockTwits | `api.stocktwits.com/api/2/streams/symbol/{ticker}.json` | None | Up to 30 most-recent messages |
| Reddit | `reddit.com/r/{sub}/search.json` | None | Up to 5 posts per subreddit, past 7 days |

Reddit is queried across **asset-class-aware subreddit sets**:

- **Equities:** `r/wallstreetbets`, `r/stocks`, `r/investing`
- **Crypto:** `r/CryptoCurrency`, `r/CryptoMarkets`, `r/Bitcoin`

The routing happens automatically based on how the ticker is normalized (see [crypto-tickers.md](crypto-tickers.md)). A small inter-request delay keeps us under Reddit's public ~10 req/min IP-level rate limit.

Both fetchers **degrade gracefully**, any failure (timeout, HTTP error, malformed body) returns a placeholder string, never an exception. The agent always sees either real data or a clear `<unavailable>` marker.

---

## What the prompt sees

The sentiment_analyst's user message includes structured blocks like:

```
StockTwits messages (most recent):
Bullish: 12 (40%) · Bearish: 6 (20%) · Unlabeled: 12 · Total: 30 most-recent messages

[2026-05-14T10:00:00Z · @user1 · Bullish] long calls into earnings
[2026-05-14T10:05:00Z · @user2 · Bearish] overvalued imo
...

Reddit posts (past 7 days):
r/wallstreetbets, 4 recent posts mentioning NVDA:
  [2026-05-13 ·   42↑ ·  15c] DD on NVDA earnings setup
    body excerpt: I think this prints...
  ...
```

Long message bodies are truncated to ~280 chars (StockTwits) / ~240 chars (Reddit) to keep prompt size bounded. Total context for the sentiment_analyst is typically under 10KB.

---

## Why the data goes only to sentiment_analyst (not all 12 agents)

The full StockTwits + Reddit blocks are only injected into the sentiment_analyst's prompt. The other 11 agents, analysts, researchers, trader, risk seats, portfolio manager, read the sentiment_analyst's **conclusion** via the transcript instead. This is by design:

- **Token budget.** Putting the full social blocks into every prompt would roughly double total session input tokens.
- **Role separation.** A real research desk doesn't have every analyst staring at raw StockTwits, they read the sentiment analyst's summary note. Multi-agent debate quality is better when each role has the data tailored to its decision.

If you want to expose the raw blocks to other agents, the parameter is `_format_context(..., include_full_sentiment=True)` in `engine/live_debate.py`.

---

## Privacy

The only data leaving your machine for sentiment purposes is **the ticker symbol**, same as for any other data fetch. StockTwits and Reddit see:

- An HTTP GET with the ticker in the URL
- A polite User-Agent identifying Trading Agents Lab

No user identifier, no auth token, no account ID. The fetchers don't collect or persist anything from the responses beyond the formatted plaintext that goes into the prompt.

---

## What's NOT covered

- **Twitter / X**, no public no-auth API exists post-2023. We don't currently fetch this.
- **Discord**, no public API for ticker-specific discussion at scale.
- **YouTube**, no targeted ticker-discussion endpoint that fits the pre-fetch pattern.
- **TradingView ideas**, no public API.

The current sources are a useful baseline. They're a 2-source signal, not exhaustive social coverage. The sentiment_analyst's role is to make this signal-vs-noise judgment in its commentary.

---

## Troubleshooting

**Sentiment analyst says "no StockTwits messages found"**, the ticker doesn't have a StockTwits stream, or has very few messages. Less-traded equities and obscure crypto pairs often hit this. The agent will fall back to tape + headlines analysis explicitly.

**"stocktwits unavailable: HTTPError" / "URLError"**, the StockTwits API is rate-limiting or unreachable. The agent runs without that block; the Reddit block (when present) still gives useful signal.

**Reddit posts feel stale**, the search is over the past 7 days. For a fast-moving event (earnings day, an outage), the most recent posts may already be hours old. For more current signal, check the news headlines block instead.

**Want to use different subreddits**, the defaults are in `engine/sentiment_sources.py` (`DEFAULT_EQUITY_SUBREDDITS` and `DEFAULT_CRYPTO_SUBREDDITS`). Currently not user-configurable from the UI; modify the constants and restart the engine if you want different subs.

---

## Credits

The StockTwits + Reddit integration was ported from upstream [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) commit `0fcf136`. The upstream version was redesigned after fabricated-content reports in the previous social-media-analyst variant. Our port adapts the fetchers to our engine's async architecture and adds asset-class-aware subreddit routing.
