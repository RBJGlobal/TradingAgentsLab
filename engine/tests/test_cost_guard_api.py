"""Cost Guard — HTTP endpoint integration tests.

Drives the FastAPI app via TestClient (no real socket; in-process). Covers
the four endpoints (GET /cost-guard/state, PUT /cost-guard/config,
POST /cost-guard/check, POST /cost-guard/reserve) plus the WS handler's
auto-reserve fall-through behavior.

The WS-side reservation finalization is exercised indirectly here: we
verify that a stub debate run does NOT touch reservations (no provider_config
means the live path is skipped entirely).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine import cost_guard
from engine.server import build_app


TOKEN = "test-token-1234"


@pytest.fixture
def client(tmp_db):
    """Authenticated TestClient bound to a fresh per-test DB."""
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


# ---- /cost-guard/state ------------------------------------------------------


def test_state_returns_defaults_on_fresh_db(client):
    r = client.get("/cost-guard/state")
    assert r.status_code == 200
    data = r.json()
    assert data["spend"]["daily_usd"] == 0
    assert data["spend"]["weekly_usd"] == 0
    assert data["spend"]["monthly_usd"] == 0
    assert data["spend"]["sessions_today"] == 0
    assert data["config"]["enabled"] is True
    assert data["config"]["cap_daily_usd"] == 2.00
    assert data["config"]["cap_weekly_usd"] == 5.00
    assert data["config"]["cap_monthly_usd"] == 15.00


def test_state_requires_bearer_token(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        r = c.get("/cost-guard/state")  # no Authorization header
        assert r.status_code == 401


# ---- /cost-guard/config -----------------------------------------------------


def test_config_update_partial(client):
    r = client.put("/cost-guard/config", json={"cap_daily_usd": 2.50})
    assert r.status_code == 200
    data = r.json()
    assert data["cap_daily_usd"] == 2.50
    assert data["cap_weekly_usd"] == 5.00  # unchanged

    r2 = client.get("/cost-guard/state")
    assert r2.json()["config"]["cap_daily_usd"] == 2.50


def test_config_update_disable(client):
    r = client.put("/cost-guard/config", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False


def test_config_update_rejects_negative_daily(client):
    # Pydantic ge=0 should bounce this with a 422
    r = client.put("/cost-guard/config", json={"cap_daily_usd": -1})
    assert r.status_code == 422


# ---- /cost-guard/check ------------------------------------------------------


def test_check_allows_on_fresh_db(client):
    r = client.post(
        "/cost-guard/check",
        json={"model": "gpt-4o-mini", "auth_kind": "api_key", "max_tokens": 400},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["allow"] is True
    assert data["over_dimension"] is None
    assert data["est_reservation_usd"] > 0


def test_check_oauth_returns_zero_estimate(client):
    r = client.post(
        "/cost-guard/check",
        json={"model": "gpt-5.4", "auth_kind": "oauth", "max_tokens": 400},
    )
    assert r.status_code == 200
    assert r.json()["est_reservation_usd"] == 0.0


def test_check_blocks_after_seeding_session_near_cap(client):
    """Seed the sessions ledger with a near-cap row, then verify a check
    against gpt-4o-mini (~$0.008 worst case) tips us over a $0.01 cap."""
    from engine import storage

    client.put("/cost-guard/config", json={"cap_daily_usd": 0.01})
    # Write a real session row representing prior spend.
    storage.write_session(
        ticker="TEST",
        trade_date="2026-05-09",
        events=[],
        decision={"action": "HOLD", "confidence": 0.5, "reasoning": "seed"},
        live=True,
        provider="openai",
        model="gpt-4o-mini",
        input_tokens=100,
        output_tokens=100,
        estimated_cost_usd=0.005,
        auth_kind="api_key",
    )
    # daily cap = $0.01, prior spend = $0.005, est for next = $0.008
    # → 0.005 + 0.008 = $0.013 > $0.01 → block
    r = client.post(
        "/cost-guard/check",
        json={"model": "gpt-4o-mini", "auth_kind": "api_key", "max_tokens": 400},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["allow"] is False
    assert data["over_dimension"] == "daily"


def test_check_invalid_auth_kind_rejected(client):
    r = client.post(
        "/cost-guard/check",
        json={"model": "gpt-4o-mini", "auth_kind": "magic", "max_tokens": 400},
    )
    assert r.status_code == 422  # pydantic regex


# ---- /cost-guard/reserve ----------------------------------------------------


def test_reserve_returns_id_and_creates_row(client):
    r = client.post(
        "/cost-guard/reserve",
        json={"model": "gpt-4o-mini", "auth_kind": "api_key", "max_tokens": 400},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["reservation_id"]
    assert data["est_cost_usd"] > 0
    assert data["override"] is False
    # State should reflect the new reservation as in-flight cost
    state = client.get("/cost-guard/state").json()
    assert state["spend"]["daily_usd"] == pytest.approx(data["est_cost_usd"], rel=1e-6)


def test_reserve_blocks_with_402_when_over_cap(client):
    client.put("/cost-guard/config", json={"cap_daily_usd": 0.001})
    r = client.post(
        "/cost-guard/reserve",
        json={"model": "gpt-4o-mini", "auth_kind": "api_key", "max_tokens": 400},
    )
    assert r.status_code == 402
    detail = r.json()["detail"]
    assert detail["error"] == "cost_guard_blocked"
    assert detail["over_dimension"] == "daily"
    assert "spend" in detail
    assert "config" in detail
    assert detail["est_cost_usd"] > 0


def test_reserve_with_override_succeeds_over_cap(client):
    client.put("/cost-guard/config", json={"cap_daily_usd": 0.001})
    r = client.post(
        "/cost-guard/reserve",
        json={
            "model": "gpt-4o-mini",
            "auth_kind": "api_key",
            "max_tokens": 400,
            "override": True,
        },
    )
    assert r.status_code == 200
    assert r.json()["override"] is True


def test_oauth_reserve_does_not_count_against_cost(client):
    """OAuth reservations have est_cost_usd=0 and don't inflate cost spend."""
    r = client.post(
        "/cost-guard/reserve",
        json={"model": "gpt-5.4", "auth_kind": "oauth", "max_tokens": 400},
    )
    assert r.status_code == 200
    assert r.json()["est_cost_usd"] == 0.0
    state = client.get("/cost-guard/state").json()
    assert state["spend"]["daily_usd"] == 0.0
    assert state["spend"]["sessions_today"] == 1


# ---- WS handler auto-reserve fallthrough -----------------------------------


def test_ws_stub_debate_does_not_touch_cost_guard(client):
    """No provider_config means stub mode → no reservation is created."""
    with client.websocket_connect(f"/stream?token={TOKEN}") as ws:
        ws.send_json({"ticker": "AAPL", "trade_date": "2026-05-09"})
        events = []
        try:
            while True:
                event = ws.receive_json()
                events.append(event)
                if event.get("type") == "session.complete":
                    break
        except Exception:
            pass
    # No reservation was created — daily spend stays 0
    state = client.get("/cost-guard/state").json()
    assert state["spend"]["sessions_today"] == 0
    assert state["spend"]["daily_usd"] == 0


def test_ws_live_debate_blocked_by_cost_guard(client):
    """When a live debate request would exceed caps, the WS sends a
    cost.blocked event and closes with 1008."""
    # Tighten cap so any live debate is blocked
    client.put("/cost-guard/config", json={"cap_daily_usd": 0.001})
    with client.websocket_connect(f"/stream?token={TOKEN}") as ws:
        ws.send_json(
            {
                "ticker": "NVDA",
                "trade_date": "2026-05-09",
                "provider_config": {
                    "provider": "openai",
                    "auth": {"type": "api_key", "api_key": "sk-fake"},
                    "model": "gpt-4o-mini",
                    "max_tokens": 400,
                },
            }
        )
        # The first non-data event should be cost.blocked. Skip data events.
        blocked_event = None
        try:
            for _ in range(5):
                event = ws.receive_json()
                if event.get("type") == "cost.blocked":
                    blocked_event = event
                    break
        except Exception:
            pass
    assert blocked_event is not None
    assert blocked_event["over_dimension"] == "daily"
    assert "message" in blocked_event
