"""YFinanceProvider.quote_summary — incomplete-bar (NaN) handling.

Regression guard for the "analyze today before the session closes" bug:
yfinance returns a trailing row with NaN OHLC for the current in-progress
session. Selecting it positionally poisoned last_close with NaN, which
surfaced as a fake "$NaN" price in the decision card and fed a fabricated
number into the LLM debate context.

Uses a synthetic history frame (no live network / no date-of-day
flakiness) by monkeypatching yfinance.Ticker.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.data_providers import DataUnavailable, default_provider


def _fake_yfinance(monkeypatch, frame: pd.DataFrame) -> None:
    """Patch yfinance.Ticker so .history() returns the given frame."""

    class _FakeTicker:
        def __init__(self, symbol: str) -> None:
            self.symbol = symbol

        def history(self, start: str, end: str):  # noqa: ANN001
            return frame

    monkeypatch.setattr("yfinance.Ticker", _FakeTicker)


def _frame(rows: dict[str, list], dates: list[str]) -> pd.DataFrame:
    return pd.DataFrame(rows, index=pd.to_datetime(dates))


@pytest.mark.asyncio
async def test_trailing_nan_bar_is_dropped(monkeypatch):
    """A forming session (trailing NaN row) must not become last_close.
    The summary should report the last COMPLETE bar instead."""
    frame = _frame(
        {
            "Open": [100.0, 101.0, 102.0, np.nan],
            "High": [105.0, 106.0, 107.0, np.nan],
            "Low": [99.0, 98.0, 101.0, np.nan],
            "Close": [104.0, 102.0, 205.19, np.nan],
            "Volume": [1000.0, 1100.0, 1200.0, np.nan],
        },
        ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-15"],
    )
    _fake_yfinance(monkeypatch, frame)

    summary = await default_provider.quote_summary(
        ticker="NVDA", trade_date="2026-06-15"
    )

    assert summary.last_close == 205.19  # last complete close, not NaN
    assert summary.as_of == "2026-06-12"  # date of the last complete bar
    assert summary.sessions == 3  # the NaN row is excluded from the count
    assert summary.period_high == 107.0
    assert summary.period_low == 98.0
    # last_close must be a real, comparable number (the bug produced NaN,
    # which silently fails > 0 checks and renders as "$NaN").
    assert summary.last_close == summary.last_close  # not NaN


@pytest.mark.asyncio
async def test_all_incomplete_bars_raises_data_unavailable(monkeypatch):
    """If EVERY bar is incomplete (all-NaN), there's no closed session to
    summarize — raise DataUnavailable so the endpoint 404s cleanly rather
    than returning a garbage summary."""
    frame = _frame(
        {
            "Open": [np.nan, np.nan],
            "High": [np.nan, np.nan],
            "Low": [np.nan, np.nan],
            "Close": [np.nan, np.nan],
            "Volume": [np.nan, np.nan],
        },
        ["2026-06-15", "2026-06-16"],
    )
    _fake_yfinance(monkeypatch, frame)

    with pytest.raises(DataUnavailable):
        await default_provider.quote_summary(ticker="NVDA", trade_date="2026-06-16")


@pytest.mark.asyncio
async def test_clean_frame_unaffected(monkeypatch):
    """No NaN rows → behavior is unchanged (last row wins)."""
    frame = _frame(
        {
            "Open": [100.0, 101.0],
            "High": [105.0, 106.0],
            "Low": [99.0, 100.0],
            "Close": [104.0, 105.5],
            "Volume": [1000.0, 1100.0],
        },
        ["2026-06-11", "2026-06-12"],
    )
    _fake_yfinance(monkeypatch, frame)

    summary = await default_provider.quote_summary(
        ticker="NVDA", trade_date="2026-06-12"
    )

    assert summary.last_close == 105.5
    assert summary.sessions == 2
    assert summary.as_of == "2026-06-12"
