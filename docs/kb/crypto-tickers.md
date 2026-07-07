# Crypto tickers

*Analyze crypto pairs the same way you analyze equities. BTC, ETH, BTC/USD, BTC-USD all work; the engine routes to the right data source automatically.*

> **For educational research and paper trading. This is not investment advice.**

---

## What works today

Type any of the following in the **Ticker** field on the **Analyze** page:

| You type | Engine treats as |
|---|---|
| `BTC` | Bitcoin / USD pair |
| `BTC/USD` | Bitcoin / USD pair (Alpaca format) |
| `BTC-USD` | Bitcoin / USD pair (Yahoo Finance format) |
| `ETH/USDT` | Ethereum / Tether (Alpaca exact pair; yfinance falls back to ETH-USD) |
| `SOL/USD`, `ADA/USD`, `DOGE/USD`, etc. | Resolved per the same rules |

The full short-list of recognized bare crypto symbols is in `engine/ticker.py`. If you type a recognized base symbol like `ETH`, it becomes `ETH/USD`. If you type something the engine doesn't recognize (`FAKETOKEN`), it falls through to the equity validator and likely errors with "not a valid equity or crypto ticker".

---

## What you'll see on the Data card

The **Data** pill at the top of the page picks up a **"crypto"** badge when the active stream is a crypto ticker. The summary numbers come from the same provider you have configured:

- **yfinance** (default, free), uses the `BTC-USD` style symbol. Limited stablecoin pair support; `USDT`/`USDC` pairs collapse to `USD` for yfinance.
- **Alpaca** (optional, requires keys), uses the exact `BTC/USD` pair and hits the dedicated crypto endpoint at `/v1beta3/crypto/us/bars`. Better coverage for stablecoin pairs.

If you have Alpaca configured, the engine auto-routes crypto requests to Alpaca's crypto endpoint. The Data card shows **"alpaca · crypto"** when this happens.

---

## How the analysts handle crypto

The agent prompts are asset-class-aware. For crypto tickers, the **fundamental_analyst** is instructed to comment on:

- **Tokenomics**, supply schedule, burn mechanics, issuance
- **On-chain metrics**, active addresses, network volume, hash rate
- **Regulatory**, pending or recent regulatory actions
- **Macro liquidity**, broad market liquidity conditions

It explicitly says "if you do not have detailed data, say so", so when the LLM doesn't have current on-chain figures, it tells you what it would look for instead of fabricating numbers.

The other analysts (technical, news, sentiment) work the same way for crypto as for equities. The **sentiment_analyst** in particular benefits from the asset-class-aware Reddit routing: crypto tickers query `r/CryptoCurrency`, `r/CryptoMarkets`, `r/Bitcoin` instead of `r/wallstreetbets`. See [sentiment.md](sentiment.md) for details.

---

## What's NOT supported

- **Direct USD-pair quotes only.** No DEX prices, no specific exchange (Coinbase vs Kraken vs Binance), you get the consolidated tape from the data provider.
- **No futures or perpetuals.** Spot pairs only.
- **No on-chain data feeds.** The fundamental_analyst comments on tokenomics from what the LLM knows, not from live on-chain feeds. That's a possible future addition.
- **No execution.** Per [project positioning](faq.md), Trading Agents Lab is an analysis tool, not a trading app. Crypto analyses cannot place orders, even to Alpaca's crypto execution endpoints. The system is structurally incapable of it.

---

## News for crypto

The default Yahoo Finance news provider returns crypto news when the ticker is in their database (BTC-USD, ETH-USD, etc.). When Alpaca is the active data provider, crypto news falls back to yfinance because Alpaca's news API only covers equities. The transition is transparent, the News card just shows whichever provider returned headlines.

---

## Troubleshooting

**"not a valid equity or crypto ticker"**, the symbol isn't on the recognized list. Try the explicit pair form: `ETH/USD` instead of just `ETHEREUM`. Or use the yfinance form: `BTC-USD`.

**Data card stays empty for a crypto ticker**, yfinance occasionally doesn't have data for less-traded pairs. Check the engine log via **About → Open engine log** for the actual yfinance error. Alpaca usually has better crypto coverage for major pairs.

**Sentiment analyst says "no Reddit posts found"**, small crypto tickers don't get a lot of dedicated subreddit discussion. The bull/bear ratio from StockTwits is usually still informative.

**Wrong asset class detected**, the engine has a known-crypto list that determines which bare symbols get treated as crypto. If a symbol you expect to be crypto is being treated as an equity (or vice versa), file an issue or add the symbol to the list in `engine/ticker.py`.
