# Data Providers

*Where market data and news come from, what the engine fetches, and how to connect a free Alpaca account for fuller news coverage.*

---

## Overview

The engine fetches two types of data before running a debate:

1. **A price summary**, last close, period range, average volume, session count
2. **News headlines**, recent news for the ticker (Yahoo Finance by default, Alpaca when connected)

Both are fetched at the start of every WS session, before any agent speaks. If a fetch fails, the engine degrades gracefully: the debate runs with reduced context rather than failing entirely.

---

## Yahoo Finance: the free default

Yahoo Finance is the default data source. It requires no API key and no configuration. The engine is already using it when you first launch the app.

The Settings page shows **Yahoo Finance, Active · default** in the Data Providers tab with no Configure button, there is nothing to configure.

### What it provides

- **Price summary:** OHLCV bars via the `yfinance` Python package. The engine fetches a 30-session lookback window anchored on the trade date you specify. From that window it computes:
  - Last close (as of the most recent complete trading day before your trade date)
  - Period open, high, low
  - Period change percentage
  - Average daily volume
  - Session count

- **News headlines:** up to 5 recent headlines from Yahoo Finance's news feed for the ticker. Each headline has a title, publisher, publication date, URL, and summary.

### Limitations

- **No API key → no rate-limit guarantee.** Yahoo Finance is a public feed. It can rate-limit or return empty data on transient network issues. If this happens, the engine logs the error and the debate runs in data-offline mode.
- **Weekend and holiday bars are absent.** If you request a trade date that falls on a weekend or holiday, yfinance will anchor to the most recent trading day. The `as_of` field in the data summary shows which day was actually used.
- **Future dates return no data.** The date picker is capped at today to prevent this, but the data provider will raise `DataUnavailable` if the date range contains no bars.
- **Unknown tickers return 404.** The engine returns HTTP 404 from `GET /data/summary` when yfinance has no data for the ticker. The debate still runs, in data-offline mode.

---

## Alpaca Markets: optional, free data upgrade

Alpaca Markets is an optional second data source. A free Alpaca account (the Basic data plan) is enough; Trading Agents Lab never needs a paid Alpaca subscription.

Alpaca is used **for market data and news only**. The app connects only to Alpaca's data endpoints and has no code path that places orders, so a connected Alpaca account can never trade from Trading Agents Lab.

### Connecting Alpaca

1. Create a free account at alpaca.markets and generate an API key pair in the dashboard. The **Secret** is shown only once, so copy it right away (regenerate the pair if you missed it).
2. In Trading Agents Lab, go to **Settings → Data Providers**.
3. Click **Configure** next to **Alpaca Markets: Key ID** and paste the Key ID.
4. Click **Configure** next to **Alpaca Markets: Secret** and paste the Secret.

Both values are stored in your operating system's encrypted credential store, like your LLM keys. See [security-and-storage.md](security-and-storage.md).

### What changes when Alpaca is connected

As soon as both the Key ID and the Secret are saved, every new analysis uses Alpaca automatically. There is no separate switch to flip:

- **Price summary** comes from Alpaca's daily bars instead of yfinance. The **Data** pill and the data summary strip show `alpaca` as the source.
- **News headlines** come from Alpaca's news feed (sourced from Benzinga) instead of Yahoo Finance. Alpaca's feed is often fuller than Yahoo's, which can return no headlines at all for some well-known tickers.

Remove either value to go back to Yahoo Finance for both.

---

## News sources

There are two news feeds the app can use:

| Source | Needs a key | Notes |
|---|---|---|
| **Yahoo Finance** | No | The default. Coverage varies by ticker; some tickers return no headlines. |
| **Alpaca (Benzinga)** | Free Alpaca key pair | Used automatically when Alpaca is connected. Strong coverage for US equities and major crypto. |

For crypto tickers, if Alpaca returns no headlines the engine falls back to Yahoo Finance's crypto news so the News card is not left empty. See [crypto-tickers.md](crypto-tickers.md).

The News card in the debate view always shows which source supplied its headlines.

### News source in Trading Agents Lab Pro

> **Pro** In Trading Agents Lab Pro, the news analyst looks up news itself during the run, and you can choose where it looks. Go to **Settings → Analysis → News source**:
>
> - **Auto (Alpaca when connected, else Yahoo)**: the default. Uses Alpaca (Benzinga) when your Alpaca keys are saved, otherwise Yahoo Finance.
> - **Alpaca (Benzinga)**: always tries Alpaca first. If Alpaca is not connected or returns nothing, the analyst falls back to Yahoo Finance.
> - **Yahoo Finance**: Yahoo Finance only.
>
> Whenever Alpaca is in use, Yahoo Finance stays as the fallback, so an empty result from one source never leaves the news analyst with no news at all. The News card in the debate view follows the same rule as the Lite app (Alpaca when connected, otherwise Yahoo).

---

## What the analysts see

Each agent in the debate receives a context block containing:

```
Ticker: NVDA
Trade date (anchor): 2026-05-08

Recent price action (compact summary):
- last close: 211.50 (as of 2026-05-07)
- 24-session window: open 177.16, high 216.83, low 173.66, change +19.38%
- avg daily volume: 147,571,146
- source: yfinance

Recent news headlines:
- <headline title> (<publisher>)
- <headline title> (<publisher>)
...
```

This is a deliberate summary, not a raw dataframe. Raw OHLCV tables are noisy and expensive in LLM prompts. If agents need more detail in later phases, per-agent tools (e.g., RSI/MACD calculation) will be added.

---

## Crypto data

Both yfinance and Alpaca handle crypto, but their coverage differs:

- **yfinance** uses the `BTC-USD` style symbol. Major pairs (BTC, ETH, SOL, etc.) are well covered. Stablecoin-quoted pairs (`USDT`/`USDC` quotes) collapse to the USD pair, yfinance doesn't expose USDT pairs reliably.
- **Alpaca** uses the exact `BTC/USD` pair format and hits a dedicated endpoint at `/v1beta3/crypto/us/bars`. Better coverage for stablecoin-quoted pairs and altcoins.

The engine **auto-routes** crypto tickers to the right endpoint per provider. The **Data** pill on the Analyze page gains a **"crypto"** badge when the active stream is crypto, so you can confirm the engine routed correctly.

See [crypto-tickers.md](crypto-tickers.md) for how tickers are normalized (`BTC`, `BTC/USD`, `BTC-USD` all work).

---

## Social sentiment data

Separately from market data, the engine fetches public social signal (StockTwits + Reddit) for the **sentiment_analyst** agent. This is no-auth, no-key, and runs in parallel with the market data fetch. See [sentiment.md](sentiment.md) for the full details.

---

## Deferred providers

**Massive.com / Polygon-class providers**, institutional-grade tick data and alternative data. Deferred until a feature specifically requires it. Alpaca covers current needs.

---

## Further reading

- [How it works](how-it-works.md), how data fits into the debate flow
- [Crypto tickers](crypto-tickers.md), symbol normalization and routing
- [Sentiment](sentiment.md), StockTwits + Reddit pre-fetch
- [Troubleshooting](troubleshooting.md), yfinance returns no data or no news
- Engine API reference for data endpoints: [docs/api.md](../api.md)
