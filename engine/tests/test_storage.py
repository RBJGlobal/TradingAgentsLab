"""Tier 3 baseline coverage for engine/storage.py.

The storage module is load-bearing for History, the spend ledger, and
the watchlist UI. Previously its only test coverage was indirect through
the WS smoke and the new session-persistence tests; this file exercises
the public API directly: write/read/list/delete round-trip, filtering
behavior, watchlist CRUD + conflict, and concurrent-write tolerance
under the WAL + busy_timeout configuration (Tier 0 hardening).
"""

from __future__ import annotations

import sqlite3
import threading
import time

import pytest

from engine import storage


# ---- Sessions: write / read / list / delete -------------------------------


def _make_session(
    ticker: str = "NVDA",
    cost: float = 0.05,
    stance: str = "neutral",
    conviction: float = 0.5,
) -> str:
    sid = storage.write_session(
        ticker=ticker,
        trade_date="2026-05-24",
        events=[
            {"type": "session.start", "ticker": ticker, "trade_date": "2026-05-24"},
            {"type": "agent.message", "agent": "fundamental_analyst", "content": "..."},
            {"type": "session.complete", "ticker": ticker, "decision": {"stance": stance}},
        ],
        decision={
            "stance": stance,
            "conviction": conviction,
            "reasoning": "Synthetic test reasoning.",
        },
        live=True,
        provider="openai",
        model="gpt-4o-mini",
        input_tokens=1000,
        output_tokens=400,
        estimated_cost_usd=cost,
        auth_kind="api_key",
    )
    assert sid is not None
    return sid


def test_round_trip_write_and_read(tmp_db):
    sid = _make_session(ticker="AAPL", cost=0.08, stance="bullish", conviction=0.72)
    detail = storage.get_session(sid)
    assert detail is not None
    assert detail.id == sid
    assert detail.ticker == "AAPL"
    assert detail.decision_action == "bullish"
    assert detail.decision_confidence == pytest.approx(0.72)
    assert detail.estimated_cost_usd == pytest.approx(0.08)
    # Events round-tripped from the JSON blob.
    assert len(detail.events) == 3
    assert detail.events[0]["type"] == "session.start"


def test_get_session_returns_none_for_unknown_id(tmp_db):
    assert storage.get_session("not-a-real-id") is None


def test_list_sessions_newest_first(tmp_db):
    # created_at is stored at second-granularity (ISO without ms), so two
    # writes inside the same second tie. Sleep across a second boundary to
    # produce a deterministic ordering.
    older = _make_session(ticker="AAPL")
    time.sleep(1.1)
    newer = _make_session(ticker="NVDA")

    summaries = storage.list_sessions(limit=10)
    assert [s.id for s in summaries] == [newer, older]


def test_list_sessions_filters_by_ticker(tmp_db):
    _make_session(ticker="AAPL")
    nvda = _make_session(ticker="NVDA")
    _make_session(ticker="MSFT")

    summaries = storage.list_sessions(limit=10, ticker="NVDA")
    assert len(summaries) == 1
    assert summaries[0].id == nvda


def test_list_sessions_filter_is_case_insensitive(tmp_db):
    # Watchlist deliberately uppercases tickers; the same case-fold rule
    # should let `list_sessions(ticker="nvda")` find rows stored as "NVDA".
    _make_session(ticker="NVDA")
    summaries = storage.list_sessions(limit=10, ticker="nvda")
    assert len(summaries) == 1


def test_list_sessions_respects_limit(tmp_db):
    for _ in range(5):
        _make_session()
        time.sleep(0.005)
    summaries = storage.list_sessions(limit=3)
    assert len(summaries) == 3


def test_delete_session_removes_row(tmp_db):
    sid = _make_session()
    assert storage.delete_session(sid) is True
    assert storage.get_session(sid) is None
    # Second delete is a no-op (returns False).
    assert storage.delete_session(sid) is False


def test_summary_to_dict_and_detail_to_dict(tmp_db):
    sid = _make_session(ticker="TSLA")
    detail = storage.get_session(sid)
    assert detail is not None

    d = storage.detail_to_dict(detail)
    assert d["id"] == sid
    assert d["ticker"] == "TSLA"
    assert isinstance(d.get("events"), list)

    summaries = storage.list_sessions(limit=1)
    s = storage.summary_to_dict(summaries[0])
    assert "events" not in s  # summaries don't carry the event blob
    assert s["ticker"] == "TSLA"


# ---- Watchlist CRUD --------------------------------------------------------


def test_watchlist_add_and_list(tmp_db):
    entry = storage.add_watchlist(ticker="NVDA", note="GPU leader")
    assert entry.ticker == "NVDA"
    assert entry.note == "GPU leader"

    rows = storage.list_watchlist()
    assert [r.ticker for r in rows] == ["NVDA"]


def test_watchlist_add_uppercases_ticker(tmp_db):
    entry = storage.add_watchlist(ticker="aapl")
    assert entry.ticker == "AAPL"


def test_watchlist_duplicate_raises_conflict(tmp_db):
    storage.add_watchlist(ticker="NVDA")
    with pytest.raises(storage.WatchlistConflict):
        storage.add_watchlist(ticker="NVDA")
    # Case-insensitive: lowercase variant is still a conflict.
    with pytest.raises(storage.WatchlistConflict):
        storage.add_watchlist(ticker="nvda")


def test_watchlist_remove_existing_and_missing(tmp_db):
    storage.add_watchlist(ticker="NVDA")
    assert storage.remove_watchlist("NVDA") is True
    assert storage.list_watchlist() == []
    # Removing a row that doesn't exist returns False, no exception.
    assert storage.remove_watchlist("NVDA") is False


# ---- Best-effort robustness ------------------------------------------------


def test_write_session_swallows_errors_and_returns_none(tmp_db, monkeypatch):
    # If the DB layer fails (disk full, schema mismatch, etc.) write_session
    # must not raise — it would tear down the live_debate generator and
    # leave the WS hanging. Verified by monkey-patching _connect to raise.

    def boom(*_args, **_kwargs):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(storage, "_connect", boom)
    sid = storage.write_session(
        ticker="NVDA",
        trade_date="2026-05-24",
        events=[],
        decision={"stance": "neutral", "conviction": 0.0, "reasoning": ""},
        live=True,
    )
    assert sid is None


# ---- Concurrent writes (WAL + busy_timeout=5000 from Tier 0) --------------


def test_concurrent_writes_dont_collide(tmp_db):
    """Two threads writing to the same DB must both succeed.

    Tier 0 set `busy_timeout=5000` on the SQLite connection so the second
    writer doesn't immediately error with 'database is locked' when SQLite
    serializes the WAL writes. This test exercises the contract:
    SQLite chooses the order, but neither call drops its row.
    """
    errors: list[BaseException] = []
    sids: list[str] = []

    def worker(ticker: str) -> None:
        try:
            sid = _make_session(ticker=ticker)
            sids.append(sid)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=("AAPL",)),
        threading.Thread(target=worker, args=("NVDA",)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10.0)

    assert errors == [], f"unexpected errors: {errors}"
    assert len(sids) == 2
    assert len(set(sids)) == 2  # distinct row IDs

    summaries = storage.list_sessions(limit=10)
    tickers = {s.ticker for s in summaries}
    assert tickers == {"AAPL", "NVDA"}
