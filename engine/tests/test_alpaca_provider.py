"""AlpacaProvider — locked-in safety + selection logic tests.

Doesn't hit the live Alpaca API. Verifies:
- The base URL constant points only at data.alpaca.markets (locked
  positioning — must never resolve to api.alpaca.markets)
- AlpacaProvider rejects empty credentials
- provider_from_data_config returns None for malformed configs and an
  AlpacaProvider for valid ones
- AlpacaProvider builds the expected URL + query params for the bars
  endpoint (free-tier-compatible: feed=sip, end ≥15 min ago)

Network-mocked via httpx's MockTransport. No real network calls.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from engine.data_providers import (
    ALPACA_DATA_BASE_URL,
    AlpacaProvider,
    DataUnavailable,
    QuoteSummary,
    YFinanceProvider,
    provider_from_data_config,
)


# ---- Locked-in safety ------------------------------------------------------


def test_alpaca_base_url_is_data_endpoint_only():
    """Locked positioning: AlpacaProvider must NEVER point at the live
    trading endpoint (api.alpaca.markets). The constant is the entire
    safety guarantee — defense in depth via endpoint constants, not
    runtime guard flags."""
    assert ALPACA_DATA_BASE_URL == "https://data.alpaca.markets"
    assert "api.alpaca.markets" not in ALPACA_DATA_BASE_URL


def test_alpaca_provider_rejects_empty_credentials():
    with pytest.raises(ValueError):
        AlpacaProvider(key_id="", secret="abc")
    with pytest.raises(ValueError):
        AlpacaProvider(key_id="abc", secret="")
    with pytest.raises(ValueError):
        AlpacaProvider(key_id="", secret="")


def test_alpaca_provider_name_is_alpaca():
    p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
    assert p.name == "alpaca"


# ---- provider_from_data_config dispatch ------------------------------------


def test_provider_from_data_config_returns_none_when_absent():
    assert provider_from_data_config(None) is None
    assert provider_from_data_config({}) is None


def test_provider_from_data_config_returns_none_for_unknown_provider():
    assert provider_from_data_config({"provider": "bloomberg", "key_id": "x", "secret": "y"}) is None


def test_provider_from_data_config_returns_none_when_missing_credentials():
    assert provider_from_data_config({"provider": "alpaca", "key_id": "x"}) is None
    assert provider_from_data_config({"provider": "alpaca", "secret": "y"}) is None
    assert provider_from_data_config({"provider": "alpaca", "key_id": "", "secret": "y"}) is None


def test_provider_from_data_config_returns_alpaca_provider_when_valid():
    p = provider_from_data_config(
        {"provider": "alpaca", "key_id": "PK_TEST", "secret": "secret_test"}
    )
    assert isinstance(p, AlpacaProvider)
    assert p.name == "alpaca"


def test_provider_from_data_config_normalizes_provider_case():
    p = provider_from_data_config(
        {"provider": "Alpaca", "key_id": "PK_TEST", "secret": "secret_test"}
    )
    assert isinstance(p, AlpacaProvider)


# ---- HTTP shape — using httpx MockTransport (no real network) -------------


@pytest.mark.asyncio
async def test_alpaca_quote_summary_builds_correct_request():
    """Verify the URL, query params, and headers we send to Alpaca."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        # Return a minimal successful body — 3 bars
        return httpx.Response(
            200,
            json={
                "bars": [
                    {"t": "2026-05-06T20:00:00Z", "o": 100.0, "h": 102.0, "l": 99.0, "c": 101.0, "v": 1_000_000},
                    {"t": "2026-05-07T20:00:00Z", "o": 101.0, "h": 103.5, "l": 100.5, "c": 103.0, "v": 1_200_000},
                    {"t": "2026-05-08T20:00:00Z", "o": 103.0, "h": 105.0, "l": 102.0, "c": 104.5, "v": 1_500_000},
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    # Patch httpx.AsyncClient to use our transport for this test only.
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        summary = await p.quote_summary(ticker="nvda", trade_date="2026-05-09", lookback_days=24)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert len(captured) == 1
    req = captured[0]
    assert str(req.url).startswith("https://data.alpaca.markets/v2/stocks/NVDA/bars")
    # Query params
    qp = dict(req.url.params)
    assert qp["timeframe"] == "1Day"
    assert qp["feed"] == "sip"
    assert "end" in qp and "start" in qp
    # Auth headers
    assert req.headers["APCA-API-KEY-ID"] == "PK_TEST"
    assert req.headers["APCA-API-SECRET-KEY"] == "secret_test"
    # Result mapping
    assert isinstance(summary, QuoteSummary)
    assert summary.source == "alpaca"
    assert summary.ticker == "NVDA"
    assert summary.last_close == 104.50
    assert summary.period_open == 100.0
    assert summary.sessions == 3


@pytest.mark.asyncio
async def test_alpaca_quote_summary_raises_on_401():
    """Bad credentials must raise DataUnavailable with a helpful message."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid credentials")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="bad", secret="bad")
        with pytest.raises(DataUnavailable) as exc_info:
            await p.quote_summary(ticker="NVDA", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    msg = str(exc_info.value)
    assert "401" in msg or "credentials" in msg.lower()
    # Helpful hint about paper-vs-live keys
    assert "paper" in msg.lower() or "live" in msg.lower()


@pytest.mark.asyncio
async def test_alpaca_quote_summary_raises_on_empty_bars():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"bars": []})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        with pytest.raises(DataUnavailable):
            await p.quote_summary(ticker="UNKNOWN", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]


@pytest.mark.asyncio
async def test_alpaca_news_returns_empty_list_on_failure():
    """News failures must not raise — they degrade silently to empty list,
    matching the existing yfinance behavior. Bars failures DO raise (we
    want loud signal that data is missing); news is supplementary."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal server error")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        out = await p.news_headlines(ticker="NVDA", limit=5)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert out == []


@pytest.mark.asyncio
async def test_alpaca_quote_summary_survives_all_null_lows():
    """Regression: Alpaca occasionally returns bars with null `l` (low) for
    incomplete / after-hours sessions. period_low used a filtered min() that
    raised ValueError on an empty sequence when EVERY low was null, crashing
    the summary (silently — swallowed by _fetch_summary_safe, so the data
    card just never appeared). It must degrade to 0.0 instead of raising."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"bars": [
            {"t": "2026-05-08T20:00:00Z", "o": 100.0, "h": 110.0, "l": None, "c": 105.0, "v": 1000},
            {"t": "2026-05-09T20:00:00Z", "o": 105.0, "h": 112.0, "l": None, "c": 108.0, "v": 1200},
        ]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        summary = await p.quote_summary(ticker="NVDA", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert summary.period_low == 0.0  # no crash; safe fallback
    assert summary.last_close == 108.0


@pytest.mark.asyncio
async def test_alpaca_quote_summary_skips_null_lows_but_keeps_valid():
    """The null-low filter must still work: a mix of null and real lows
    yields the min of the REAL lows, not 0.0."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"bars": [
            {"t": "2026-05-08T20:00:00Z", "o": 100.0, "h": 110.0, "l": None, "c": 105.0, "v": 1000},
            {"t": "2026-05-09T20:00:00Z", "o": 105.0, "h": 112.0, "l": 95.5, "c": 108.0, "v": 1200},
        ]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        summary = await p.quote_summary(ticker="NVDA", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert summary.period_low == 95.5


@pytest.mark.asyncio
async def test_alpaca_drops_trailing_incomplete_bar():
    """A forming session (last bar with null close) must not become last_close;
    the last COMPLETE bar wins. Mirrors the yfinance NaN-bar guard so a debate
    run mid-session never sees a fake $0.00 price."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"bars": [
            {"t": "2026-05-07T20:00:00Z", "o": 100.0, "h": 110.0, "l": 99.0, "c": 104.0, "v": 1000},
            {"t": "2026-05-08T20:00:00Z", "o": 104.0, "h": 112.0, "l": 103.0, "c": 108.0, "v": 1100},
            {"t": "2026-05-09T20:00:00Z", "o": 108.0, "h": 109.0, "l": 107.0, "c": None, "v": 50},
        ]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        summary = await p.quote_summary(ticker="NVDA", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert summary.last_close == 108.0  # last COMPLETE bar, not 0.0, not forming
    assert summary.as_of == "2026-05-08"


@pytest.mark.asyncio
async def test_alpaca_all_incomplete_bars_raises():
    """If every bar is incomplete (null close), there is no closed session to
    summarize — raise DataUnavailable so the endpoint 404s instead of emitting
    a $0.00 summary."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"bars": [
            {"t": "2026-05-09T20:00:00Z", "o": 108.0, "h": 109.0, "l": 107.0, "c": None, "v": 50},
        ]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        with pytest.raises(DataUnavailable):
            await p.quote_summary(ticker="NVDA", trade_date="2026-05-09")
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]


# ---- yfinance fallback unchanged when no data_config ----------------------


def test_default_provider_remains_yfinance():
    """Smoke check: default_provider has not been monkey-patched away."""
    from engine.data_providers import default_provider
    assert isinstance(default_provider, YFinanceProvider)
    assert default_provider.name == "yfinance"


# ---- Crypto branch — separate endpoint + response shape -------------------


@pytest.mark.asyncio
async def test_alpaca_crypto_quote_summary_uses_v1beta3_endpoint():
    """BTC routes to /v1beta3/crypto/us/bars with symbols=BTC/USD,
    NOT /v2/stocks/BTC/bars (which would 404 or return wrong asset)."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        # Crypto response shape: bars keyed by symbol
        return httpx.Response(
            200,
            json={
                "bars": {
                    "BTC/USD": [
                        {"t": "2026-05-06T00:00:00Z", "o": 60000.0, "h": 61000.0, "l": 59500.0, "c": 60500.0, "v": 1500.5},
                        {"t": "2026-05-07T00:00:00Z", "o": 60500.0, "h": 62000.0, "l": 60000.0, "c": 61800.0, "v": 1800.2},
                        {"t": "2026-05-08T00:00:00Z", "o": 61800.0, "h": 63500.0, "l": 61500.0, "c": 63000.0, "v": 2100.7},
                    ]
                }
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        # Pass bare "BTC" — normalization should detect crypto + route correctly.
        summary = await p.quote_summary(ticker="BTC", trade_date="2026-05-09", lookback_days=24)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert len(captured) == 1
    req = captured[0]
    # MUST hit /v1beta3/crypto/us/bars, not /v2/stocks/BTC/bars
    assert "/v1beta3/crypto/us/bars" in str(req.url)
    assert "/v2/stocks" not in str(req.url)
    qp = dict(req.url.params)
    assert qp["symbols"] == "BTC/USD"
    assert qp["timeframe"] == "1Day"
    # Crypto requests do NOT include the SIP feed param
    assert "feed" not in qp
    # Result mapping
    assert summary.source == "alpaca"
    assert summary.asset_class == "crypto"
    assert summary.ticker == "BTC/USD"  # display form
    assert summary.last_close == 63000.00
    assert summary.sessions == 3


@pytest.mark.asyncio
async def test_alpaca_crypto_news_falls_back_to_yfinance_when_empty(monkeypatch):
    """When Alpaca returns 0 headlines for a crypto symbol, AlpacaProvider
    silently falls through to yfinance (which has broader coverage of mid-
    and small-cap crypto via Yahoo's CoinDesk/Decrypt/etc. aggregation)."""
    # Mock Alpaca news to return empty array (200 OK with no items)
    def alpaca_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"news": []})

    transport = httpx.MockTransport(alpaca_handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]

    # Mock the yfinance fallback function to return 2 headlines
    def fake_yfinance_news(ticker: str, limit: int):
        from engine.data_providers import Headline
        return [
            Headline(
                title="Cardano launches new staking feature",
                publisher="Decrypt",
                pub_date="2026-05-08T15:00:00Z",
                url="https://decrypt.co/ada-staking",
                summary="Network upgrade brings improved staking rewards",
            ),
            Headline(
                title="ADA technical analysis: bullish breakout",
                publisher="CoinDesk",
                pub_date="2026-05-08T12:00:00Z",
                url="https://coindesk.com/ada-ta",
                summary="Chartists see breakout above $0.30",
            ),
        ]

    monkeypatch.setattr(
        "engine.data_providers._yfinance_news_headlines", fake_yfinance_news
    )

    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        out = await p.news_headlines(ticker="ADA", limit=5)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    # Fallback delivered the headlines
    assert len(out) == 2
    assert out[0].title == "Cardano launches new staking feature"
    assert out[0].publisher == "Decrypt"


@pytest.mark.asyncio
async def test_alpaca_equity_news_does_NOT_fall_back_to_yfinance(monkeypatch):
    """Equity tickers that return 0 from Alpaca should NOT fall through
    to yfinance — fallback is crypto-only (Alpaca is fine for equity news,
    we only need backup for crypto coverage gaps)."""
    def alpaca_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"news": []})

    transport = httpx.MockTransport(alpaca_handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]

    fallback_called = {"count": 0}

    def fake_yfinance_news(ticker: str, limit: int):
        fallback_called["count"] += 1
        return []

    monkeypatch.setattr(
        "engine.data_providers._yfinance_news_headlines", fake_yfinance_news
    )

    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        out = await p.news_headlines(ticker="NVDA", limit=5)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert out == []
    # yfinance fallback NOT called for equity
    assert fallback_called["count"] == 0


@pytest.mark.asyncio
async def test_alpaca_crypto_news_uses_base_symbol_not_pair():
    """News endpoint takes the base ('BTC') for crypto, not the pair ('BTC/USD'),
    for broader headline coverage."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "news": [
                    {
                        "headline": "Bitcoin breaks $63k",
                        "summary": "BTC rallies on ETF inflows",
                        "created_at": "2026-05-08T12:00:00Z",
                        "source": "test_source",
                        "url": "https://example.com/btc",
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    import httpx as httpx_mod
    httpx_mod.AsyncClient = patched_client  # type: ignore[assignment]
    try:
        p = AlpacaProvider(key_id="PK_TEST", secret="secret_test")
        out = await p.news_headlines(ticker="BTC/USD", limit=5)
    finally:
        httpx_mod.AsyncClient = real_client  # type: ignore[assignment]

    assert len(captured) == 1
    req = captured[0]
    # News endpoint takes the BASE ("BTC"), not the pair ("BTC/USD")
    assert dict(req.url.params)["symbols"] == "BTC"
    assert len(out) == 1
    assert out[0].title == "Bitcoin breaks $63k"
