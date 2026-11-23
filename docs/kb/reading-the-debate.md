---
order: 120
---

# Reading the Debate

*A guided tour of the Analyze page, every element explained, from the input form to the committee assessment.*

---

## The Analyze page at a glance

The Analyze page has these sections, top to bottom:

1. **Page header**, title and one-line description
2. **Input card**, ticker, date, Analyze/Stop button
3. **Debate stream**, session header, data summary strip, news card, phase cards, committee assessment
4. **Disclaimer footer**

A status strip at the top of the window (Engine, Data, LLM, Spend) is visible on every page; see [Status strip](#status-strip) below.

---

## Input card

### Ticker field

Type any exchange-listed ticker symbol. The input converts to uppercase automatically. Maximum 8 characters. The field is disabled while a debate is streaming.

### As-of date field

The date the analysis is anchored to. The engine fetches data up to and including this date. The date picker is capped at today, future dates would produce empty data. The field is disabled while streaming.

### Analyze button

Enabled when the engine is running and no debate is in flight. Click it, or press `Cmd+Enter`, to start a new debate. While a debate is streaming, the Analyze button is replaced by the Stop button (see below).

### Stop button

Appears in place of the Analyze button while a debate is streaming. Click it, or press `Cmd+.`, to close the WebSocket immediately. The engine handles the disconnect cleanly, no data corruption or error. Partial results already received remain visible in the debate stream.

### Helper text

Below the buttons, a one-line status describes the engine state:

- **Engine starting, sidecar handshake pending.** The Python sidecar is spawning. Usually clears within 2-3 seconds.
- **Stub debate, analyst messages reference real data when reachable.** Engine is ready; no LLM key is configured.
- **Streaming agent debate from sidecar, Stop to abort.** A debate is in flight.
- **Engine failed to start: \<message>.** The sidecar didn't start. See [troubleshooting.md](troubleshooting.md).

### Copy transcript button

Appears after a debate completes (after `session.complete` is received). Click it to copy the full debate transcript to your clipboard in Markdown format. The transcript includes the session header, data summary, news headlines, and every agent message, organized by phase. The button label briefly shows "Copied ✓" to confirm success.

### Error banner

If the stream closes unexpectedly (non-1000 close code, parse error, or connection failure), a red error banner appears below the input card with the error message.

---

## Status strip

A status strip at the top of the app window (visible on every page) shows four pills: Engine, Data, LLM, and Spend.

### Engine pill

Shows whether the Python sidecar is running.

| State | Indicator |
|---|---|
| starting… | Pulsing dot while the engine starts (up to about 12 seconds) |
| Running | Green dot |
| Error | Red dot |

When the engine is in "Error" state, the Analyze button remains disabled. Hover the pill to see the error message. If the engine stops unexpectedly, the app tries to restart it automatically; if the pill stays red, quit and reopen the app.

### Data pill

Shows the active data provider. It reads "pending" until the engine confirms the provider (for example "yfinance"), and shows the provider used for the current run once a debate starts (for example "alpaca" or "yfinance · crypto").

### LLM pill

Shows which LLM provider the app will use: the provider name (for example "Anthropic"), or "OpenAI · OAuth" when you signed in with ChatGPT. It reads "unconfigured" when no provider is set up, in which case debates run in stub mode. Set up a provider in Settings → LLM Providers.

### Spend pill

Shows what you have spent today against your daily Cost Guard cap, for example "$0.42 / $2.00". It ticks up during a run. The dot is green below 50% of the cap, amber from 50% to 90%, and red at 90% or more. With the cap disabled it shows the day's total with no color warning. See [cost-guard.md](cost-guard.md).


---

## Debate stream

The debate stream section appears once the first event arrives from the engine. It is organized in rendering order from top to bottom.

### Session header

Shows the ticker and trade date for the current session. While the stream is open, a pulsing "Streaming" badge with a green dot appears in the top-right of the header.

### Data summary strip

Appears after the `data.summary` event arrives (one of the first events). A compact horizontal strip shows:

- **Last close**, closing price as of the last complete trading day before your trade date
- **Period change**, percent change over the lookback window; green for positive, red for negative
- **Range**, period low,  period high
- **Avg volume**, mean daily volume over the window, formatted as M (millions) or K (thousands)
- A metadata line: number of sessions, data source, and the `as_of` date

If yfinance could not fetch data (offline, unknown ticker, future date), the summary strip is absent. Agent messages that reference prices fall back to generic language.

### News card

Appears after the `news.headlines` event arrives. Shows up to 4 recent headlines for the ticker, from Yahoo Finance by default or from Alpaca (Benzinga) when Alpaca is connected. The card names its source. Each headline is a clickable link to the original article, with the publisher name and a relative timestamp. If no headlines were found, the card is absent.

### Phase cards

Agent messages are grouped into phase cards. Each phase card has:

- A phase header with the phase name (Analysts, Researchers, Trader, Risk) and a subtitle listing the agents in that phase
- A colored left border, each phase has a distinct color for quick visual scanning
- Agent message articles, each showing the agent name and its message content

Phases render in order as their first message arrives: Analysts → Researchers → Trader → Risk. Within a phase, messages append as they stream in.

#### Agent names by phase

| Phase | Agents |
|---|---|
| Analysts | technical_analyst, fundamental_analyst, news_analyst, sentiment_analyst |
| Researchers | bull_researcher, bear_researcher, research_manager |
| Trader | trader |
| Risk | risk_aggressive, risk_conservative, risk_neutral, portfolio_manager |

### Committee Assessment

Appears after `session.complete` arrives. The app deliberately scores how the bull and bear cases argued rather than telling you what to do. The card is titled "Committee Assessment" and carries this disclaimer: "This assessment is an analytical output of a simulated research committee, not a recommendation. Any investment decision is yours alone."

The card is color-coded by analytical stance:

- **Bullish / Moderately bullish**, green
- **Neutral**, amber
- **Moderately bearish / Bearish**, red

The card shows the stance, conviction percentage, bull and bear thesis strength scores (0-100), risk level, and the portfolio manager's reasoning. In stub mode the reasoning includes "Stub canned debate" and may reference real price data. In live mode the reasoning is the portfolio manager's actual model output.

---

## Disclaimer footer

The Analyze page ends with:

> **For educational research and paper trading.** Trading Agents Lab does not provide investment advice. Trading decisions and any real-money outcomes are entirely your own.

This is not decorative. The app is designed for research and paper trading only.

---

## Further reading

- [How it works](how-it-works.md), what each agent is doing and why
- [Keyboard shortcuts](keyboard-shortcuts.md), Cmd+Enter, Cmd+., and navigation shortcuts
- [Troubleshooting](troubleshooting.md), when the stream doesn't start or stops unexpectedly
