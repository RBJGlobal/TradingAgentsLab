"""Cost Guard — unit tests for the pure-function + DAO layer.

Covers:
- worst_case_reservation math (per-model + OAuth + unknown)
- window math (day/week/month boundaries)
- initialize seeds defaults
- check() / reserve() / finalize_reservation() flow
- _exceeds_any_cap discrimination by auth_kind
- TTL sweep clears stale reservations
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest

from engine import cost_guard, storage
from engine.cost_guard import (
    CostGuardBlocked,
    RESERVATION_TTL_SECONDS,
    _compute_spend,
    _connect,
    _exceeds_any_cap,
    _iso,
    _sweep_expired_reservations,
    _window_start,
    check,
    finalize_reservation,
    get_config,
    get_state,
    initialize,
    reserve,
    update_config,
    worst_case_reservation,
)


# ---- worst_case_reservation -------------------------------------------------


def test_worst_case_reservation_gpt4o_mini_under_one_cent(tmp_db):
    """gpt-4o-mini × 12 agents × 400 tokens fits comfortably under $0.01."""
    est = worst_case_reservation(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert 0.005 < est < 0.012, f"expected ~$0.008, got ${est:.4f}"


def test_worst_case_reservation_oauth_always_zero(tmp_db):
    """OAuth path bills via subscription — zero per-token cost."""
    for model in ("gpt-5.4", "gpt-4o-mini", "claude-haiku-4-5", "literally-anything"):
        est = worst_case_reservation(model=model, auth_kind="oauth", max_tokens=400)
        assert est == 0.0


def test_worst_case_reservation_unknown_model_is_not_zero(tmp_db):
    """Changed 2026-11-11 with live model discovery. An unknown per-token
    model used to reserve $0 ("can't price it, so don't block it"), which let
    any model missing from the table bypass the spend cap. With discovery,
    unknown models are the normal case, so they now reserve the top ceiling
    (15/75 per 1M). Over-estimating is the safe direction."""
    est = worst_case_reservation(
        model="some-router/exotic-model", auth_kind="api_key", max_tokens=400
    )
    assert est > 0.0
    # 12 agents x 400 tokens at 15/75: 33,600 in + 4,800 out = $0.864.
    assert est == pytest.approx(0.864)


def test_worst_case_reservation_scales_with_max_tokens(tmp_db):
    """Doubling max_tokens roughly doubles output cost contribution."""
    low = worst_case_reservation(model="gpt-4o-mini", auth_kind="api_key", max_tokens=200)
    high = worst_case_reservation(model="gpt-4o-mini", auth_kind="api_key", max_tokens=800)
    assert high > low * 2  # super-linear due to triangular input growth


def test_refreshed_catalog_models_are_priced(tmp_db):
    """The 2026-05-27 catalog refresh added rates for models that were
    previously absent from the table (gpt-5/gpt-5-mini/gpt-5.5) plus the new
    gemini-3.1-flash-lite. Before, these fell through the 'unknown' path and
    reserved $0. Confirm each now reserves a positive amount.

    (Until 2026-11-12 this also asserted "< $1 at the 800-token hard cap".
    Reasoning models now reserve output for the thinking allowance too
    (max_tokens + 1200 per agent), so gpt-5 / gpt-5.5 exceed $1 there; the
    reservation numbers are pinned in test_thinking_allowance.py.)"""
    for model in ("gpt-5", "gpt-5-mini", "gpt-5.5", "gemini-3.1-flash-lite"):
        est = worst_case_reservation(model=model, auth_kind="api_key", max_tokens=800)
        assert est > 0.0, f"{model} should be priced, not the unknown $0 path"


# ---- _window_start ----------------------------------------------------------


def test_window_start_day_is_midnight_utc():
    now = datetime(2026, 5, 9, 14, 23, 45, tzinfo=timezone.utc)
    assert _window_start("day", now=now) == "2026-05-09T00:00:00Z"


def test_window_start_week_is_monday():
    # 2026-05-09 is a Saturday → Monday is 2026-05-04
    now = datetime(2026, 5, 9, 14, 23, 45, tzinfo=timezone.utc)
    assert _window_start("week", now=now) == "2026-05-04T00:00:00Z"


def test_window_start_week_on_monday_is_today():
    # 2026-05-04 is a Monday → start of week is itself
    now = datetime(2026, 5, 4, 9, 0, 0, tzinfo=timezone.utc)
    assert _window_start("week", now=now) == "2026-05-04T00:00:00Z"


def test_window_start_month_is_first_of_month():
    now = datetime(2026, 5, 9, 14, 23, 45, tzinfo=timezone.utc)
    assert _window_start("month", now=now) == "2026-05-01T00:00:00Z"


# ---- initialize / get_config / update_config --------------------------------


def test_initialize_seeds_default_config(tmp_db):
    initialize()
    config = get_config()
    assert config.enabled is True
    assert config.cap_daily_usd == 2.00
    assert config.cap_weekly_usd == 5.00
    assert config.cap_monthly_usd == 15.00
    assert config.cap_sessions_per_day == 0


def test_initialize_is_idempotent(tmp_db):
    initialize()
    config1 = get_config()
    initialize()
    config2 = get_config()
    assert config1 == config2


def test_update_config_partial(tmp_db):
    initialize()
    new_config = update_config(cap_daily_usd=2.50)
    assert new_config.cap_daily_usd == 2.50
    # Untouched fields preserved
    assert new_config.cap_weekly_usd == 5.00
    assert new_config.cap_monthly_usd == 15.00


def test_update_config_clamps_negative_to_zero(tmp_db):
    initialize()
    new_config = update_config(cap_daily_usd=-5, cap_sessions_per_day=-3)
    assert new_config.cap_daily_usd == 0.0
    assert new_config.cap_sessions_per_day == 0


# ---- _exceeds_any_cap -------------------------------------------------------


def _make_config(**overrides) -> cost_guard.CostGuardConfig:
    base = dict(
        enabled=True,
        cap_daily_usd=1.00,
        cap_weekly_usd=5.00,
        cap_monthly_usd=15.00,
        cap_sessions_per_day=0,
        updated_at=_iso(datetime.now(timezone.utc)),
    )
    base.update(overrides)
    return cost_guard.CostGuardConfig(**base)


def _make_spend(daily=0, weekly=0, monthly=0, sessions=0) -> cost_guard.SpendState:
    return cost_guard.SpendState(
        daily_usd=daily, weekly_usd=weekly, monthly_usd=monthly, sessions_today=sessions
    )


def test_exceeds_any_cap_under_all_returns_none():
    over = _exceeds_any_cap(
        spend=_make_spend(daily=0.5, weekly=2.0, monthly=8.0),
        config=_make_config(),
        est_cost=0.01,
        auth_kind="api_key",
    )
    assert over is None


def test_exceeds_any_cap_daily_first():
    over = _exceeds_any_cap(
        spend=_make_spend(daily=0.99, weekly=2.0, monthly=8.0),
        config=_make_config(),
        est_cost=0.05,
        auth_kind="api_key",
    )
    assert over == "daily"


def test_exceeds_any_cap_weekly_when_daily_disabled():
    over = _exceeds_any_cap(
        spend=_make_spend(daily=0.5, weekly=4.99, monthly=8.0),
        config=_make_config(cap_daily_usd=0),
        est_cost=0.05,
        auth_kind="api_key",
    )
    assert over == "weekly"


def test_exceeds_any_cap_oauth_skips_usd_caps():
    over = _exceeds_any_cap(
        spend=_make_spend(daily=10.0, weekly=50.0, monthly=200.0),
        config=_make_config(),
        est_cost=0.0,  # OAuth est is always 0 anyway
        auth_kind="oauth",
    )
    assert over is None


def test_exceeds_any_cap_oauth_still_hits_rate_cap():
    over = _exceeds_any_cap(
        spend=_make_spend(sessions=10),
        config=_make_config(cap_sessions_per_day=10),
        est_cost=0.0,
        auth_kind="oauth",
    )
    assert over == "rate"


def test_exceeds_any_cap_zero_disables_dimension():
    """Cap of 0 means disabled — never blocks regardless of spend."""
    over = _exceeds_any_cap(
        spend=_make_spend(daily=999.0, weekly=999.0, monthly=999.0),
        config=_make_config(cap_daily_usd=0, cap_weekly_usd=0, cap_monthly_usd=0),
        est_cost=999.0,
        auth_kind="api_key",
    )
    assert over is None


# ---- check() ----------------------------------------------------------------


def test_check_allows_on_fresh_db(tmp_db):
    result = check(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert result.allow is True
    assert result.over_dimension is None
    assert result.current.daily_usd == 0
    assert result.config.cap_daily_usd == 2.00


def test_check_oauth_returns_zero_estimate(tmp_db):
    result = check(model="gpt-5.4", auth_kind="oauth", max_tokens=400)
    assert result.allow is True
    assert result.est_reservation_usd == 0.0


def test_check_disabled_config_always_allows(tmp_db):
    initialize()
    update_config(enabled=False)
    # Seed a sessions row that would normally blow the cap
    _seed_session(cost=10.0, live=True, auth_kind="api_key")
    result = check(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert result.allow is True


def test_check_blocks_when_seeded_session_exceeds_daily(tmp_db):
    initialize()
    update_config(cap_daily_usd=0.10)  # tight cap
    # gpt-4o-mini est is ~$0.008. Seed enough cost that adding the est
    # tips us over $0.10.
    _seed_session(cost=0.095, live=True, auth_kind="api_key")
    result = check(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert result.allow is False
    assert result.over_dimension == "daily"


# ---- reserve() / finalize_reservation() -------------------------------------


def test_reserve_creates_row_and_returns_id(tmp_db):
    result = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert result.reservation_id
    assert result.est_cost_usd > 0
    assert result.expires_at > _iso(datetime.now(timezone.utc))
    assert result.override is False
    # Verify the row is in the DB
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM cost_reservations WHERE id = ?", (result.reservation_id,)
        ).fetchone()
    assert row is not None
    assert row["finalized"] == 0


def test_reserve_blocks_over_cap(tmp_db):
    initialize()
    update_config(cap_daily_usd=0.001)  # impossibly tight
    with pytest.raises(CostGuardBlocked) as exc_info:
        reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert exc_info.value.over_dimension == "daily"


def test_reserve_with_override_succeeds_over_cap(tmp_db):
    initialize()
    update_config(cap_daily_usd=0.001)
    result = reserve(
        model="gpt-4o-mini", auth_kind="api_key", max_tokens=400, override=True
    )
    assert result.override is True
    assert result.reservation_id


def test_finalize_reservation_marks_row_finalized(tmp_db):
    res = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    ok = finalize_reservation(res.reservation_id, actual_cost_usd=0.005)
    assert ok is True
    with _connect() as conn:
        row = conn.execute(
            "SELECT finalized, finalized_cost_usd FROM cost_reservations WHERE id = ?",
            (res.reservation_id,),
        ).fetchone()
    assert row["finalized"] == 1
    assert row["finalized_cost_usd"] == 0.005


def test_finalize_reservation_unknown_id_returns_false(tmp_db):
    initialize()
    ok = finalize_reservation("nonexistent-id", actual_cost_usd=0.1)
    assert ok is False


def test_finalize_reservation_idempotent(tmp_db):
    res = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    assert finalize_reservation(res.reservation_id, actual_cost_usd=0.005) is True
    # Second call: already finalized, so no row updated → False
    assert finalize_reservation(res.reservation_id, actual_cost_usd=0.005) is False


# ---- Sweep + crash recovery -------------------------------------------------


def test_sweep_expired_reservations(tmp_db):
    initialize()
    # Manually insert an already-expired reservation
    expired_at = _iso(datetime.now(timezone.utc) - timedelta(seconds=1))
    created_at = _iso(datetime.now(timezone.utc) - timedelta(minutes=20))
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO cost_reservations (
                id, created_at, expires_at, est_cost_usd, auth_kind,
                override, finalized, finalized_cost_usd
            ) VALUES ('stale-1', ?, ?, 0.5, 'api_key', 0, 0, NULL)
            """,
            (created_at, expired_at),
        )
        conn.commit()

    # Spend should NOT include the expired reservation
    with _connect() as conn:
        spend = _compute_spend(conn)
    assert spend.daily_usd == 0  # expires_at < now → filtered

    # Sweep should mark it finalized
    with _connect() as conn:
        swept = _sweep_expired_reservations(conn)
        conn.commit()
    assert swept == 1

    # Verify it's now marked finalized
    with _connect() as conn:
        row = conn.execute(
            "SELECT finalized FROM cost_reservations WHERE id = 'stale-1'"
        ).fetchone()
    assert row["finalized"] == 1


def test_sweep_does_not_touch_active_reservations(tmp_db):
    res = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    with _connect() as conn:
        swept = _sweep_expired_reservations(conn)
        conn.commit()
    assert swept == 0
    # Active reservation should still be finalized=0
    with _connect() as conn:
        row = conn.execute(
            "SELECT finalized FROM cost_reservations WHERE id = ?", (res.reservation_id,)
        ).fetchone()
    assert row["finalized"] == 0


def test_active_reservation_counts_toward_spend(tmp_db):
    """The reservation flow's TOCTOU guarantee: in-flight reservations
    inflate apparent spend so two parallel debates can't both think they
    fit under the cap."""
    initialize()
    res = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    spend, _ = get_state()
    # Active reservation should contribute its est_cost_usd to spend
    assert spend.daily_usd == pytest.approx(res.est_cost_usd, rel=1e-6)


def test_finalized_reservation_does_not_double_count(tmp_db):
    """Once finalized, the reservation row must not contribute to spend
    (the actual cost is recorded in sessions, not on the reservation)."""
    initialize()
    res = reserve(model="gpt-4o-mini", auth_kind="api_key", max_tokens=400)
    finalize_reservation(res.reservation_id, actual_cost_usd=0.005)
    spend, _ = get_state()
    # Finalized reservation drops out of in-flight contribution
    assert spend.daily_usd == 0.0


def test_oauth_reservation_does_not_inflate_cost_spend(tmp_db):
    """OAuth reservations are auth_kind='oauth' and est_cost_usd=0 so they
    must not contribute to USD spend aggregation."""
    initialize()
    res = reserve(model="gpt-5.4", auth_kind="oauth", max_tokens=400)
    assert res.est_cost_usd == 0.0
    spend, _ = get_state()
    assert spend.daily_usd == 0.0
    # But the session count should reflect the in-flight reservation
    assert spend.sessions_today == 1


# ---- Integration with sessions table ----------------------------------------


def test_session_with_oauth_excluded_from_cost_spend(tmp_db):
    """A completed OAuth session must not contribute to USD spend even if
    estimated_cost_usd is non-zero in storage (defensive)."""
    initialize()
    # Seed a session with auth_kind='oauth' and a non-zero cost (defensive
    # — in practice live_debate writes 0 for OAuth, but the aggregator
    # query should filter it out anyway)
    _seed_session(cost=5.0, live=True, auth_kind="oauth")
    spend, _ = get_state()
    assert spend.daily_usd == 0.0
    # Rate cap dimension — OAuth still counts toward sessions_today
    assert spend.sessions_today == 1


def test_session_with_null_auth_kind_treated_as_api_key(tmp_db):
    """Pre-migration sessions have auth_kind=NULL but recorded a real cost.
    Aggregator must include them so the historical ledger stays coherent."""
    initialize()
    _seed_session(cost=0.50, live=True, auth_kind=None)
    spend, _ = get_state()
    assert spend.daily_usd == 0.50


def test_stub_session_excluded_from_cost_spend(tmp_db):
    """Stub debates (live=0) must not appear in cost aggregation."""
    initialize()
    _seed_session(cost=10.0, live=False, auth_kind="api_key")
    spend, _ = get_state()
    assert spend.daily_usd == 0.0


# ---- Helpers ----------------------------------------------------------------


def _seed_session(*, cost: float, live: bool, auth_kind):
    """Insert a sessions row directly for test seeding."""
    storage._ensure_initialized()
    sid = storage._new_id()
    now = _iso(datetime.now(timezone.utc))
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO sessions (
                id, ticker, trade_date,
                decision_action, decision_confidence, decision_reasoning,
                live, provider, model, input_tokens, output_tokens,
                estimated_cost_usd, auth_kind, created_at, events_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sid,
                "TEST",
                "2026-05-09",
                "HOLD",
                0.5,
                "test seed",
                1 if live else 0,
                "openai",
                "gpt-4o-mini",
                100,
                100,
                cost,
                auth_kind,
                now,
                "[]",
            ),
        )
        conn.commit()
