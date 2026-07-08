"""Tier 2 session persistence tests.

Covers the shared helper that bridges the WS and Telegram-bot debate paths
into a single `sessions` table write. Two surfaces, one ledger.

The motivating regression: bot-triggered debates were never writing to
`sessions`, so a debate that outlived its 15-min reservation TTL silently
dropped its cost from the global spend ledger (sweep marks the reservation
finalized=NULL before finalize_reservation runs, then there's nothing in
the sessions table to recover the actual cost from). The fix routes both
paths through `storage.write_session_from_events`.
"""

from __future__ import annotations

import pytest

from engine import storage


# ---- write_session_from_events ---------------------------------------------


def _complete_event(cost_usd: float = 0.0123) -> dict:
    return {
        "type": "session.complete",
        "ticker": "NVDA",
        "trade_date": "2026-05-24",
        "decision": {
            "stance": "neutral",
            "conviction": 0.55,
            "bull_strength": 50,
            "bear_strength": 50,
            "risk_level": "moderate",
            "reasoning": "Synthetic test reasoning.",
        },
        "live": True,
        "provider": "openai",
        "model": "gpt-4o-mini",
        "input_tokens": 1234,
        "output_tokens": 567,
        "estimated_cost_usd": cost_usd,
        "auth_kind": "api_key",
    }


def test_persists_full_session(tmp_db):
    events = [
        {"type": "session.start", "ticker": "NVDA", "trade_date": "2026-05-24"},
        {"type": "agent.message", "agent": "fundamental_analyst", "content": "..."},
        _complete_event(),
    ]
    sid = storage.write_session_from_events(
        ticker="NVDA", trade_date="2026-05-24", events=events
    )
    assert sid is not None

    detail = storage.get_session(sid)
    assert detail is not None
    assert detail.ticker == "NVDA"
    assert detail.decision_action == "neutral"
    assert detail.estimated_cost_usd == pytest.approx(0.0123)
    assert detail.input_tokens == 1234
    assert detail.output_tokens == 567
    assert detail.provider == "openai"
    assert detail.model == "gpt-4o-mini"
    # auth_kind is stored in the DB column but not surfaced on the dataclass
    # in v1; the DB row is what the spend ledger reads from. Asserting the
    # DB column directly is overkill — the integration test below covers it.


def test_skips_aborted_stream(tmp_db):
    # No session.complete event — the stream was aborted (Stop button on the
    # desktop, or the bot crashed mid-debate). We must not persist a partial
    # transcript; History shouldn't show debates that never finished.
    events = [
        {"type": "session.start", "ticker": "NVDA", "trade_date": "2026-05-24"},
        {"type": "agent.message", "agent": "fundamental_analyst", "content": "..."},
    ]
    sid = storage.write_session_from_events(
        ticker="NVDA", trade_date="2026-05-24", events=events
    )
    assert sid is None
    assert storage.list_sessions(limit=10) == []


def test_skips_empty_events(tmp_db):
    sid = storage.write_session_from_events(
        ticker="NVDA", trade_date="2026-05-24", events=[]
    )
    assert sid is None


def test_synthesizes_decision_when_malformed(tmp_db):
    # Defensive: a buggy adapter could yield session.complete with no decision
    # dict. We persist a neutral placeholder rather than crashing the writer.
    bad_complete = _complete_event()
    bad_complete["decision"] = "not a dict"
    sid = storage.write_session_from_events(
        ticker="NVDA", trade_date="2026-05-24", events=[bad_complete]
    )
    assert sid is not None
    detail = storage.get_session(sid)
    assert detail is not None
    assert detail.decision_action == "neutral"
    assert detail.decision_confidence == 0.0


# ---- Regression: helper lands cost in the spend ledger after TTL ----


def test_write_session_from_events_lands_after_ttl_expiry(tmp_db, monkeypatch):
    """The original bug pathway: a bot debate completes after its reservation
    has been swept (TTL expired). The fix routes its cost through
    write_session_from_events; this test proves that helper's output is
    picked up by _compute_spend.cost_sum regardless of reservation state.

    Note: this covers the *helper*. The companion test in
    `test_telegram_bot.py` (`test_run_debate_persists_via_helper`) covers
    that the bot path actually calls the helper — together they prevent
    silent regressions on either side of the bridge.
    """
    from engine import cost_guard

    # Set a high cap so reserve() doesn't block.
    cost_guard.update_config(
        enabled=True,
        cap_daily_usd=100.0,
        cap_weekly_usd=100.0,
        cap_monthly_usd=100.0,
        cap_sessions_per_day=100,
    )

    # 1. Bot reserves $0.50 worst-case for an API-key debate
    reservation = cost_guard.reserve(
        model="gpt-4o-mini", auth_kind="api_key", max_tokens=400, override=False
    )
    rid = reservation.reservation_id

    # 2. Simulate TTL expiry by directly aging the row. _sweep_expired_reservations
    #    marks finalized=1 with NULL finalized_cost_usd — the original bug.
    import sqlite3

    with sqlite3.connect(str(tmp_db)) as conn:
        conn.execute(
            "UPDATE cost_reservations SET expires_at = ? WHERE id = ?",
            ("2020-01-01T00:00:00Z", rid),
        )
        conn.commit()

    # 3. get_state runs the sweep organically (every call). spend_before is
    #    whatever the active-reservation cost contributed before the row got
    #    swept — should drop to zero because the sweep marks finalized=1.
    spend_before, _ = cost_guard.get_state()

    # 4. Bot persists the real cost via write_session_from_events (the fix)
    real_cost = 0.0234
    events = [_complete_event(cost_usd=real_cost)]
    sid = storage.write_session_from_events(
        ticker="NVDA", trade_date="2026-05-24", events=events
    )
    assert sid is not None

    # 5. _compute_spend.cost_sum now sees the row; spend reflects actual cost.
    spend_after, _ = cost_guard.get_state()
    assert spend_after.daily_usd >= spend_before.daily_usd + real_cost - 1e-9

    # 6. finalize_reservation on the expired-and-swept row is a no-op (returns
    #    False because finalized=1 already), but that no longer matters for
    #    the ledger — the cost is already recorded in `sessions`.
    finalized = cost_guard.finalize_reservation(rid, actual_cost_usd=real_cost)
    assert finalized is False  # already swept

    # Spend must NOT double-count after the no-op finalize.
    spend_final, _ = cost_guard.get_state()
    assert spend_final.daily_usd == pytest.approx(spend_after.daily_usd)
