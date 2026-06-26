"""Data provider abstraction for the TradingAgentsLab engine.

Phase 5 introduces a `BaseDataProvider` interface so the engine can swap
between data sources (yfinance default, Alpaca optional, others later)
without leaking implementation details into the agent layer.

Phase 5b adds `AlpacaProvider` for users with Alpaca Markets API keys.
The renderer passes credentials on the WS start frame; engine picks the
provider per-stream based on whether `data_config` arrived.

## Locked positioning constraint

Per CLAUDE.md §3 + memory `project_positioning_analysis_only.md`,
TradingAgentsLab is an analysis tool, not an execution platform. The
`AlpacaProvider` MUST connect only to `data.alpaca.markets`. The live
trading endpoint `api.alpaca.markets` does not appear anywhere in this
file. If a user pastes a live key, requests still go to the data
endpoint — they'll fail authentication or rate-limit, but cannot
accidentally place an order. Defense in depth via endpoint constants.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date as date_t, datetime, timedelta, timezone
from typing import Optional, Protocol

import httpx

from .ticker import AssetClass, TickerSpec, normalize_ticker


@dataclass
class QuoteSummary:
    """A compact, agent-friendly view of recent price action.

    Fields are intentionally summary-level — full OHLCV dataframes don't belong
    in agent prompts (they're noisy and expensive). Analysts get the gist; if
    they need detail, they call a tool.
    """

    ticker: str                # canonical display form (e.g. "NVDA" or "BTC/USD")
    trade_date: str            # YYYY-MM-DD the analysis is anchored on
    as_of: str                 # YYYY-MM-DD of the latest bar actually used
    last_close: float
    period_open: float
    period_high: float
    period_low: float
    period_change_pct: float   # (last - first) / first * 100
    avg_volume: float          # mean daily volume across the lookback window
    sessions: int              # number of trading days in the lookback
    source: str                # "yfinance" | "alpaca" | ...
    asset_class: AssetClass = "equity"  # "equity" | "crypto"


@dataclass
class Headline:
    title: str
    publisher: str
    pub_date: str    # ISO-8601 UTC
    url: str
    summary: str


class BaseDataProvider(Protocol):
    """Read-only data provider interface.

    Implementations should be best-effort: when the upstream is unreachable
    or returns no data, raise `DataUnavailable` rather than silently returning
    a partial summary. The engine surfaces `DataUnavailable` to the renderer
    as a graceful "data offline" state.

    Both methods take `ticker: str` for backward compatibility — implementations
    call `normalize_ticker(ticker)` internally to get the asset-class-aware
    `TickerSpec` and route to equity vs crypto endpoints as needed.
    """

    name: str

    async def quote_summary(
        self, *, ticker: str, trade_date: str, lookback_days: int = 30
    ) -> QuoteSummary: ...

    async def news_headlines(
        self, *, ticker: str, limit: int = 5
    ) -> list[Headline]: ...


class DataUnavailable(RuntimeError):
    """Upstream data source returned no usable data for the request."""


class YFinanceProvider:
    """Default data provider — Yahoo Finance via the `yfinance` package.

    yfinance hits Yahoo's public endpoints with no API key required. It can
    rate-limit or return empty data on transient issues; we wrap each call
    in a retry-light pattern and convert empty frames into `DataUnavailable`.
    """

    name = "yfinance"

    async def quote_summary(
        self, *, ticker: str, trade_date: str, lookback_days: int = 30
    ) -> QuoteSummary:
        # Local import — yfinance pulls in pandas + lxml + requests; defer the
        # cost until a provider that needs it is actually instantiated.
        import asyncio

        spec = normalize_ticker(ticker)
        t0 = datetime.now(timezone.utc)
        try:
            summary = await asyncio.to_thread(
                _yfinance_quote_summary, spec, trade_date, lookback_days
            )
        except DataUnavailable as exc:
            sys.stderr.write(f"[yfinance] bars FAILED {spec.display} ({exc})\n")
            raise
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        sys.stderr.write(
            f"[yfinance] bars OK {summary.ticker} ({spec.asset_class}) → "
            f"{summary.sessions} bars · close=${summary.last_close} "
            f"change={summary.period_change_pct:+.2f}% in {elapsed_ms}ms\n"
        )
        return summary

    async def news_headlines(
        self, *, ticker: str, limit: int = 5
    ) -> list[Headline]:
        import asyncio

        spec = normalize_ticker(ticker)
        t0 = datetime.now(timezone.utc)
        try:
            headlines = await asyncio.to_thread(
                _yfinance_news_headlines, spec.yfinance_symbol, limit
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                f"[yfinance] news FAILED {spec.display} ({type(exc).__name__}: {exc})\n"
            )
            return []
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        sys.stderr.write(
            f"[yfinance] news OK {spec.display} → {len(headlines)} headlines in {elapsed_ms}ms\n"
        )
        return headlines


# A retained bar this many calendar days before the requested trade_date is
# treated as stale. Generous enough to span long holiday weekends, tight enough
# to catch the year-old frames yfinance occasionally returns (upstream #1021).
MAX_QUOTE_STALE_DAYS = 10


def _yfinance_quote_summary(
    spec: TickerSpec, trade_date: str, lookback_days: int
) -> QuoteSummary:
    import yfinance as yf

    end = _parse_date(trade_date) + timedelta(days=1)  # yfinance end is exclusive
    # Crypto trades 24/7 — no need for weekend cushion. Equities need ~5d
    # cushion for weekends + holidays inside the lookback window.
    cushion = 0 if spec.asset_class == "crypto" else 5
    start = end - timedelta(days=lookback_days + cushion)

    yt = yf.Ticker(spec.yfinance_symbol)
    hist = yt.history(start=start.isoformat(), end=end.isoformat())
    if hist is None or hist.empty:
        raise DataUnavailable(
            f"yfinance returned no data for {spec.display} (yf symbol "
            f"{spec.yfinance_symbol}) between {start.isoformat()} and "
            f"{end.isoformat()}"
        )

    # Drop timezone for cleaner display + ensure we use only complete bars.
    if hist.index.tz is not None:
        hist.index = hist.index.tz_localize(None)

    # Drop incomplete/forming bars. When the requested trade_date is the
    # current (or an in-progress) session, yfinance returns a trailing row
    # whose OHLC are NaN — the bar hasn't closed yet. Selecting it
    # positionally via .iloc[-1] would poison last_close with NaN, which
    # then surfaces as a fake "$NaN" price in the decision card and, worse,
    # feeds a fabricated number into the LLM debate context. Keep only rows
    # with a real close. (Aggregates like high/low/avg_volume already skip
    # NaN via pandas; only the positional first/last picks need this guard.)
    hist = hist.dropna(subset=["Open", "High", "Low", "Close"])
    if hist.empty:
        raise DataUnavailable(
            f"yfinance returned only incomplete bars for {spec.display} "
            f"(yf symbol {spec.yfinance_symbol}) up to {trade_date} — no "
            f"closed session to summarize yet"
        )
    hist = hist.tail(lookback_days)

    # Freshness guard. yfinance intermittently returns a stale frame (e.g. a
    # year-old partial response) that still has complete bars and a real Close,
    # so it clears the empty + incomplete-bar checks above and would feed a
    # wrong "current" price into the debate context and the decision card
    # (upstream #1021). Reject a frame whose newest retained bar is far older
    # than the requested trade_date. Comparing against trade_date (not today)
    # keeps historical/backtest dates valid: there the newest bar legitimately
    # sits on or near the requested date, so stale_days stays small.
    latest_bar = hist.index[-1].date()
    stale_days = (_parse_date(trade_date) - latest_bar).days
    if stale_days > MAX_QUOTE_STALE_DAYS:
        raise DataUnavailable(
            f"yfinance returned stale data for {spec.display} (yf symbol "
            f"{spec.yfinance_symbol}): newest bar is {latest_bar.isoformat()}, "
            f"{stale_days} days before the requested {trade_date}. Refusing to "
            f"report a stale price."
        )

    last = hist.iloc[-1]
    first = hist.iloc[0]
    as_of = hist.index[-1].date().isoformat()

    # Crypto prices can be fractional — round to 4 dp instead of 2 for
    # sub-dollar tokens, otherwise 2 dp like equities.
    price_dp = 4 if spec.asset_class == "crypto" and float(last["Close"]) < 10 else 2
    last_close = float(round(last["Close"], price_dp))
    first_open = float(round(first["Open"], price_dp))
    period_change_pct = (
        round((last_close - first_open) / first_open * 100, 2)
        if first_open
        else 0.0
    )

    return QuoteSummary(
        ticker=spec.display,
        trade_date=trade_date,
        as_of=as_of,
        last_close=last_close,
        period_open=first_open,
        period_high=float(round(hist["High"].max(), price_dp)),
        period_low=float(round(hist["Low"].min(), price_dp)),
        period_change_pct=period_change_pct,
        avg_volume=float(round(hist["Volume"].mean(), 0)),
        sessions=int(len(hist)),
        source="yfinance",
        asset_class=spec.asset_class,
    )


def _yfinance_news_headlines(ticker: str, limit: int) -> list[Headline]:
    import yfinance as yf

    yt = yf.Ticker(ticker.upper())
    raw = yt.news or []
    headlines: list[Headline] = []
    for item in raw[: max(0, limit)]:
        # The `t.news` shape is {id, content: {...}} with title, summary,
        # pubDate, provider, canonicalUrl, etc. Be defensive — Yahoo has
        # changed this shape before.
        content = item.get("content") if isinstance(item, dict) else None
        if not isinstance(content, dict):
            continue
        title = (content.get("title") or "").strip()
        if not title:
            continue
        summary = (content.get("summary") or content.get("description") or "").strip()
        pub_date = (content.get("pubDate") or content.get("displayTime") or "").strip()
        provider = content.get("provider") or {}
        publisher = (
            provider.get("displayName")
            if isinstance(provider, dict)
            else ""
        ) or ""
        url_holder = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
        url = url_holder.get("url") if isinstance(url_holder, dict) else ""
        headlines.append(
            Headline(
                title=title,
                publisher=publisher,
                pub_date=pub_date,
                url=url or "",
                summary=summary,
            )
        )
    return headlines


def _parse_date(s: str) -> date_t:
    return datetime.strptime(s, "%Y-%m-%d").date()


# ----- AlpacaProvider (Phase 5b) -----------------------------------------

# Locked-in base URL — see file docstring. Never change to api.alpaca.markets.
ALPACA_DATA_BASE_URL = "https://data.alpaca.markets"

# Free-tier SIP requires `end` parameter ≥15 minutes in the past.
# Pad slightly to avoid clock-skew flakiness.
_ALPACA_SIP_END_DELAY_SECONDS = 16 * 60


class AlpacaProvider:
    """Alpaca Markets data adapter — free Basic tier compatible.

    Reads OHLCV bars + news from `data.alpaca.markets`. Constructor takes
    credentials directly (renderer-passed via WS start frame); this class
    never touches the encrypted secrets store.

    Wire shape:
    - Auth: `APCA-API-KEY-ID` + `APCA-API-SECRET-KEY` headers
    - Bars: GET /v2/stocks/{symbol}/bars?timeframe=1Day&limit=N&feed=sip&end=<now-16min>
    - News: GET /v1beta1/news?symbols={symbol}&limit=N
    """

    name = "alpaca"

    def __init__(self, key_id: str, secret: str) -> None:
        if not key_id or not secret:
            raise ValueError("AlpacaProvider requires both key_id and secret")
        self._key_id = key_id
        self._secret = secret

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self._key_id,
            "APCA-API-SECRET-KEY": self._secret,
            "Accept": "application/json",
        }

    async def quote_summary(
        self, *, ticker: str, trade_date: str, lookback_days: int = 30
    ) -> QuoteSummary:
        spec = normalize_ticker(ticker)
        if spec.asset_class == "crypto":
            return await self._crypto_quote_summary(spec, trade_date, lookback_days)
        return await self._equity_quote_summary(spec, trade_date, lookback_days)

    async def _equity_quote_summary(
        self, spec: TickerSpec, trade_date: str, lookback_days: int
    ) -> QuoteSummary:
        symbol = spec.alpaca_symbol
        # Pin `end` to now-16min to satisfy the free-tier SIP recency cap.
        end_dt = datetime.now(timezone.utc) - timedelta(seconds=_ALPACA_SIP_END_DELAY_SECONDS)
        start_dt = end_dt - timedelta(days=lookback_days + 5)
        url = f"{ALPACA_DATA_BASE_URL}/v2/stocks/{symbol}/bars"
        params = {
            "timeframe": "1Day",
            "limit": str(max(1, lookback_days + 2)),
            "feed": "sip",
            "start": start_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "adjustment": "raw",
        }
        t0 = datetime.now(timezone.utc)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params, headers=self._headers())
        except Exception as exc:  # noqa: BLE001 — surface as DataUnavailable
            sys.stderr.write(
                f"[alpaca] bars FAILED {symbol} ({type(exc).__name__}: {exc})\n"
            )
            raise DataUnavailable(
                f"alpaca request failed for {symbol}: {type(exc).__name__}: {exc}"
            ) from exc
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

        if resp.status_code == 401 or resp.status_code == 403:
            sys.stderr.write(
                f"[alpaca] bars AUTH-FAIL {symbol} status={resp.status_code} "
                f"in {elapsed_ms}ms\n"
            )
            raise DataUnavailable(
                f"alpaca rejected credentials ({resp.status_code}). "
                "Check that you pasted PAPER keys (TradingAgentsLab connects only "
                "to data.alpaca.markets — live keys won't work here)."
            )
        if resp.status_code != 200:
            sys.stderr.write(
                f"[alpaca] bars NON-200 {symbol} status={resp.status_code} "
                f"body={resp.text[:120]!r}\n"
            )
            raise DataUnavailable(
                f"alpaca returned {resp.status_code} for {symbol}: {resp.text[:200]}"
            )

        body = resp.json() or {}
        bars = body.get("bars") or []
        if not bars:
            sys.stderr.write(
                f"[alpaca] bars EMPTY {symbol} ({start_dt.date().isoformat()} → "
                f"{end_dt.date().isoformat()})\n"
            )
            raise DataUnavailable(
                f"alpaca returned no bars for {symbol} between "
                f"{start_dt.date().isoformat()} and {end_dt.date().isoformat()}"
            )

        # Drop incomplete/forming bars (null close). A still-open session would
        # otherwise make last_close fall to 0.0 — a fake price on the decision
        # card and a fabricated number in the LLM context. Mirrors the yfinance
        # NaN-bar guard in _yfinance_quote_summary.
        bars = [b for b in bars if b.get("c") is not None]
        if not bars:
            raise DataUnavailable(
                f"alpaca returned only incomplete bars for {symbol} up to "
                f"{trade_date} — no closed session to summarize yet"
            )
        # Trim to the most recent lookback_days bars.
        bars = bars[-lookback_days:]
        first = bars[0]
        last = bars[-1]
        first_open = float(first.get("o") or 0.0)
        last_close = float(last.get("c") or 0.0)
        period_change_pct = (
            round((last_close - first_open) / first_open * 100, 2)
            if first_open
            else 0.0
        )
        period_high = max(float(b.get("h") or 0.0) for b in bars)
        period_low = min(
            (float(b["l"]) for b in bars if b.get("l") is not None), default=0.0
        )
        avg_volume = sum(float(b.get("v") or 0.0) for b in bars) / max(1, len(bars))
        as_of = (last.get("t") or "")[:10]  # "2026-05-08T20:00:00Z" -> "2026-05-08"

        sys.stderr.write(
            f"[alpaca] bars OK {spec.display} (equity) → {len(bars)} bars · "
            f"close=${round(last_close, 2)} change={period_change_pct:+.2f}% "
            f"in {elapsed_ms}ms\n"
        )
        return QuoteSummary(
            ticker=spec.display,
            trade_date=trade_date,
            as_of=as_of,
            last_close=round(last_close, 2),
            period_open=round(first_open, 2),
            period_high=round(period_high, 2),
            period_low=round(period_low, 2),
            period_change_pct=period_change_pct,
            avg_volume=float(round(avg_volume, 0)),
            sessions=int(len(bars)),
            source="alpaca",
            asset_class="equity",
        )

    async def _crypto_quote_summary(
        self, spec: TickerSpec, trade_date: str, lookback_days: int
    ) -> QuoteSummary:
        """Crypto bars via the v1beta3 endpoint.

        Differences from equities:
        - Different URL path (/v1beta3/crypto/us/bars)
        - Symbol passed as `symbols=BTC/USD` query param (not in path)
        - Response shape: `{"bars": {"BTC/USD": [{t,o,h,l,c,v,n,vw}, ...]}}`
        - No `feed` parameter (no SIP feed concept for crypto)
        - No 15-min recency cap (crypto data is real-time on free tier)
        - 24/7 market — no weekend cushion
        """
        end_dt = datetime.now(timezone.utc)
        start_dt = end_dt - timedelta(days=lookback_days + 2)
        url = f"{ALPACA_DATA_BASE_URL}/v1beta3/crypto/us/bars"
        params = {
            "symbols": spec.alpaca_symbol,
            "timeframe": "1Day",
            "limit": str(max(1, lookback_days + 2)),
            "start": start_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        t0 = datetime.now(timezone.utc)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params, headers=self._headers())
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                f"[alpaca] crypto bars FAILED {spec.alpaca_symbol} "
                f"({type(exc).__name__}: {exc})\n"
            )
            raise DataUnavailable(
                f"alpaca crypto request failed for {spec.alpaca_symbol}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

        if resp.status_code in (401, 403):
            sys.stderr.write(
                f"[alpaca] crypto bars AUTH-FAIL {spec.alpaca_symbol} "
                f"status={resp.status_code} in {elapsed_ms}ms\n"
            )
            raise DataUnavailable(
                f"alpaca rejected credentials ({resp.status_code}) for crypto. "
                "Check that you pasted PAPER keys."
            )
        if resp.status_code != 200:
            sys.stderr.write(
                f"[alpaca] crypto bars NON-200 {spec.alpaca_symbol} "
                f"status={resp.status_code} body={resp.text[:120]!r}\n"
            )
            raise DataUnavailable(
                f"alpaca crypto returned {resp.status_code} for "
                f"{spec.alpaca_symbol}: {resp.text[:200]}"
            )

        body = resp.json() or {}
        # Crypto response: {"bars": {"BTC/USD": [...]}, "next_page_token": ...}
        bars_by_symbol = body.get("bars") or {}
        bars = bars_by_symbol.get(spec.alpaca_symbol) or []
        if not bars:
            sys.stderr.write(
                f"[alpaca] crypto bars EMPTY {spec.alpaca_symbol} "
                f"({start_dt.date().isoformat()} → {end_dt.date().isoformat()})\n"
            )
            raise DataUnavailable(
                f"alpaca returned no crypto bars for {spec.alpaca_symbol} between "
                f"{start_dt.date().isoformat()} and {end_dt.date().isoformat()}"
            )

        # Drop incomplete/forming bars (null close) — see the equity path.
        bars = [b for b in bars if b.get("c") is not None]
        if not bars:
            raise DataUnavailable(
                f"alpaca returned only incomplete crypto bars for "
                f"{spec.alpaca_symbol} up to {trade_date} — no closed bar yet"
            )

        bars = bars[-lookback_days:]
        first = bars[0]
        last = bars[-1]
        first_open = float(first.get("o") or 0.0)
        last_close = float(last.get("c") or 0.0)
        period_change_pct = (
            round((last_close - first_open) / first_open * 100, 2)
            if first_open
            else 0.0
        )
        period_high = max(float(b.get("h") or 0.0) for b in bars)
        period_low = min(
            (float(b["l"]) for b in bars if b.get("l") is not None), default=0.0
        )
        avg_volume = sum(float(b.get("v") or 0.0) for b in bars) / max(1, len(bars))
        as_of = (last.get("t") or "")[:10]

        # Crypto can be sub-dollar; use 4dp precision when small.
        price_dp = 4 if last_close < 10 else 2
        sys.stderr.write(
            f"[alpaca] crypto bars OK {spec.display} → {len(bars)} bars · "
            f"close=${round(last_close, price_dp)} change={period_change_pct:+.2f}% "
            f"in {elapsed_ms}ms\n"
        )
        return QuoteSummary(
            ticker=spec.display,
            trade_date=trade_date,
            as_of=as_of,
            last_close=round(last_close, price_dp),
            period_open=round(first_open, price_dp),
            period_high=round(period_high, price_dp),
            period_low=round(period_low, price_dp),
            period_change_pct=period_change_pct,
            avg_volume=float(round(avg_volume, 0)),
            sessions=int(len(bars)),
            source="alpaca",
            asset_class="crypto",
        )

    async def news_headlines(
        self, *, ticker: str, limit: int = 5
    ) -> list[Headline]:
        spec = normalize_ticker(ticker)
        headlines = await self._alpaca_news(spec, limit)
        # Alpaca news is bias toward US equities + major crypto (BTC/ETH).
        # For other crypto we frequently get 0 headlines — fall through to
        # yfinance's crypto-news scrape, which pulls from Yahoo Finance's
        # crypto section (CoinDesk, Decrypt, Bloomberg, etc.) and has
        # broader coverage for mid- and small-cap tokens.
        if not headlines and spec.asset_class == "crypto":
            headlines = await self._yfinance_crypto_news_fallback(spec, limit)
        return headlines

    async def _alpaca_news(
        self, spec: TickerSpec, limit: int
    ) -> list[Headline]:
        # Alpaca's news endpoint accepts both equity tickers ("NVDA") and
        # crypto base symbols ("BTC") — use the base for crypto so we get
        # broader bitcoin coverage rather than just BTC/USD trade-pair news.
        symbol = spec.base if spec.asset_class == "crypto" else spec.alpaca_symbol
        url = f"{ALPACA_DATA_BASE_URL}/v1beta1/news"
        params = {
            "symbols": symbol,
            "limit": str(max(1, min(limit, 50))),
            "include_content": "false",
            "sort": "desc",
        }
        t0 = datetime.now(timezone.utc)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params, headers=self._headers())
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                f"[alpaca] news FAILED {symbol} ({type(exc).__name__}: {exc})\n"
            )
            return []
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

        if resp.status_code != 200:
            sys.stderr.write(
                f"[alpaca] news NON-200 {symbol} status={resp.status_code} "
                f"body={resp.text[:120]!r}\n"
            )
            return []

        body = resp.json() or {}
        items = body.get("news") or []
        headlines: list[Headline] = []
        for item in items[: max(0, limit)]:
            if not isinstance(item, dict):
                continue
            title = (item.get("headline") or "").strip()
            if not title:
                continue
            summary = (item.get("summary") or "").strip()
            pub_date = (item.get("created_at") or item.get("updated_at") or "").strip()
            publisher = (item.get("source") or item.get("author") or "").strip()
            article_url = (item.get("url") or "").strip()
            headlines.append(
                Headline(
                    title=title,
                    publisher=publisher,
                    pub_date=pub_date,
                    url=article_url,
                    summary=summary,
                )
            )
        sys.stderr.write(
            f"[alpaca] news OK {spec.display} → {len(headlines)} headlines in {elapsed_ms}ms\n"
        )
        return headlines

    async def _yfinance_crypto_news_fallback(
        self, spec: TickerSpec, limit: int
    ) -> list[Headline]:
        """When Alpaca returns 0 crypto headlines, scrape Yahoo Finance via
        yfinance. Same library + call pattern as `YFinanceProvider`, just
        invoked here as a tertiary news source. News failures degrade
        silently to empty list (matches the rest of the news-fetch error
        contract — news is supplementary, not load-bearing)."""
        import asyncio

        sys.stderr.write(
            f"[alpaca] news EMPTY {spec.display} (crypto) → falling back to yfinance\n"
        )
        t0 = datetime.now(timezone.utc)
        try:
            headlines = await asyncio.to_thread(
                _yfinance_news_headlines, spec.yfinance_symbol, limit
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                f"[yfinance fallback] news FAILED {spec.display} "
                f"({type(exc).__name__}: {exc})\n"
            )
            return []
        elapsed_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)
        sys.stderr.write(
            f"[yfinance fallback] news OK {spec.display} (yf={spec.yfinance_symbol}) → "
            f"{len(headlines)} headlines in {elapsed_ms}ms\n"
        )
        return headlines


def provider_from_data_config(
    data_config: Optional[dict],
) -> Optional[BaseDataProvider]:
    """Build a per-stream data provider from the WS start frame's data_config.

    Returns None when data_config is absent / empty / malformed — caller falls
    back to `default_provider` (yfinance). This matches the LLM provider_config
    fall-through pattern: misconfiguration degrades to defaults rather than
    erroring out the stream.
    """
    if not data_config or not isinstance(data_config, dict):
        return None
    provider = (data_config.get("provider") or "").lower().strip()
    if provider == "alpaca":
        key_id = (data_config.get("key_id") or "").strip()
        secret = (data_config.get("secret") or "").strip()
        if not key_id or not secret:
            return None
        try:
            return AlpacaProvider(key_id=key_id, secret=secret)
        except Exception:  # noqa: BLE001
            return None
    return None


# Module-level default provider so the server doesn't have to manage
# instantiation. Per-stream overrides (e.g. AlpacaProvider) build on top.
default_provider: BaseDataProvider = YFinanceProvider()
