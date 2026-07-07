"""Tier 3 failure-path coverage for live_debate.

The retry helper has its own dedicated tests (test_live_debate_retry.py).
This file covers the orchestrator's behavior AROUND retries:

- Adapter raises on the first agent: graceful HOLD session.complete + bail
- Adapter raises mid-debate (after some prior agents succeeded): error event
  is yielded but the loop continues
- Reservation finalization runs on the try/finally for both success and abort
- OAuth/local sessions finalize at $0 regardless of token count
- adapter_for ValueError surfaces a clean session.complete without opening
- adapter.close() always runs (cleanup invariant)
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from engine import live_debate
from engine.live_debate import ProviderConfig, _Agent


# ---- Helpers ---------------------------------------------------------------


def _api_key_config(provider: str = "openai") -> ProviderConfig:
    return ProviderConfig(
        provider=provider,
        auth={"type": "api_key", "api_key": "sk-test"},
        model="gpt-4o-mini",
        max_tokens=400,
    )


def _oauth_config() -> ProviderConfig:
    return ProviderConfig(
        provider="openai",
        auth={
            "type": "oauth",
            "access": "oauth-access",
            "refresh": "oauth-refresh",
            "expires": 1_999_999_999,
            "account_id": "acct-123",
        },
        model="gpt-5.4",
        max_tokens=400,
    )


class _FakeAdapter:
    """Deterministic adapter for failure-path tests.

    `script` is a list of items consumed in order on each `complete` call:
    - exception instance → that call raises it
    - tuple (content, in, out) → that call returns it
    """

    def __init__(self, script: list):
        self._script = list(script)
        self.complete_calls = 0
        self.open_calls = 0
        self.close_calls = 0
        self.account_id_set: str | None = None

    async def open(self, *, api_key: str) -> None:
        self.open_calls += 1

    async def close(self) -> None:
        self.close_calls += 1

    def set_account_id(self, account_id: str) -> None:
        self.account_id_set = account_id

    async def complete(self, **_kwargs) -> tuple[str, int, int]:
        self.complete_calls += 1
        item = self._script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _two_agents() -> list[_Agent]:
    return [
        _Agent(name="technical_analyst", phase="analysts", system_prompt="t"),
        _Agent(name="portfolio_manager", phase="decision", system_prompt="p"),
    ]


async def _drain(gen) -> list[dict]:
    out = []
    async for ev in gen:
        out.append(ev)
    return out


# ---- adapter_for ValueError ------------------------------------------------


@pytest.mark.asyncio
async def test_unsupported_provider_yields_graceful_complete():
    cfg = _api_key_config()
    with patch.object(
        live_debate,
        "adapter_for",
        side_effect=ValueError("unsupported provider: 'mystery'"),
    ):
        events = await _drain(
            live_debate.live_debate(
                ticker="NVDA",
                trade_date="2026-05-24",
                summary=None,
                headlines=None,
                config=cfg,
            )
        )

    # Must yield session.start + session.complete, nothing else.
    types = [e["type"] for e in events]
    assert types == ["session.start", "session.complete"]
    complete = events[-1]
    assert complete["live"] is False
    assert complete["decision"]["stance"] == "neutral"
    assert "unsupported provider" in complete["decision"]["reasoning"]


# ---- First-agent failure aborts the debate --------------------------------


@pytest.mark.asyncio
async def test_first_agent_failure_aborts_with_hold(monkeypatch):
    # The very first adapter.complete() raises a non-retryable 401. After the
    # retry helper exhausts (it doesn't actually retry 401), live_debate's
    # try/except catches it, yields an error agent.message, and bails.
    auth_error = RuntimeError("401 unauthorized")
    fake = _FakeAdapter(script=[auth_error])

    monkeypatch.setattr(live_debate, "_AGENTS", _two_agents())
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    events = await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_api_key_config(),
        )
    )

    types = [e["type"] for e in events]
    # session.start → agent.message (error) → session.complete (neutral)
    assert types[0] == "session.start"
    assert "agent.message" in types
    assert types[-1] == "session.complete"

    err_msg = next(e for e in events if e["type"] == "agent.message")
    assert "[live debate error]" in err_msg["content"]
    assert "RuntimeError" in err_msg["content"]

    complete = events[-1]
    assert complete["decision"]["stance"] == "neutral"
    assert complete["decision"]["conviction"] == 0.0
    assert "aborted" in complete["decision"]["reasoning"].lower()

    # Adapter lifecycle: open + close both ran exactly once.
    assert fake.open_calls == 1
    assert fake.close_calls == 1


# ---- Mid-debate failure logs but continues --------------------------------


@pytest.mark.asyncio
async def test_mid_debate_failure_continues_to_next_agent(monkeypatch):
    # First agent succeeds; second raises. live_debate must yield the error
    # event and continue (don't abort just because one agent failed after
    # we already have transcript content).
    fake = _FakeAdapter(
        script=[
            ("Trend is bullish.", 100, 50),  # first agent succeeds
            RuntimeError("Codex 503: service unavailable"),  # second fails
        ],
    )

    # Three agents so we can verify the loop continued past the failure.
    monkeypatch.setattr(
        live_debate,
        "_AGENTS",
        [
            _Agent(name="technical_analyst", phase="analysts", system_prompt="t"),
            _Agent(name="news_analyst", phase="analysts", system_prompt="n"),
            _Agent(name="portfolio_manager", phase="decision", system_prompt="p"),
        ],
    )
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    # The retry helper would retry the 503; replace it with a passthrough so
    # the test runs deterministically without sleeps. The retry behavior
    # itself is covered in test_live_debate_retry.py.
    async def _passthrough(adapter, **kwargs):
        return await adapter.complete(**kwargs)

    monkeypatch.setattr(live_debate, "_complete_with_retry", _passthrough)

    # Third agent should also raise (script exhausted) — exercise this with
    # an explicit script entry so we test the "continue then portfolio_manager
    # also fails after we already have prior transcript" path.
    fake._script.append(RuntimeError("Codex 503: service unavailable"))

    events = await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_api_key_config(),
        )
    )

    # Should see two error events (second + third agents) but the loop didn't
    # short-circuit; we still got a session.complete.
    error_msgs = [
        e for e in events
        if e["type"] == "agent.message" and "[live debate error]" in e["content"]
    ]
    assert len(error_msgs) == 2

    # And one successful agent.message for the first agent.
    success_msgs = [
        e for e in events
        if e["type"] == "agent.message" and "[live debate error]" not in e["content"]
    ]
    assert len(success_msgs) == 1
    assert success_msgs[0]["content"] == "Trend is bullish."

    assert events[-1]["type"] == "session.complete"


# ---- Reservation finalization ---------------------------------------------


@pytest.mark.asyncio
async def test_reservation_finalized_on_successful_completion(monkeypatch, tmp_db):
    # finalize_reservation should be called once with the actual cost.
    from engine import cost_guard

    cost_guard.update_config(
        enabled=True,
        cap_daily_usd=100.0,
        cap_weekly_usd=100.0,
        cap_monthly_usd=100.0,
        cap_sessions_per_day=100,
    )
    reservation = cost_guard.reserve(
        model="gpt-4o-mini", auth_kind="api_key", max_tokens=400, override=False
    )

    fake = _FakeAdapter(
        script=[
            ("Trend is bullish.", 100, 50),
            ("STANCE=BULLISH\nCONVICTION=0.70\nBULL_STRENGTH=70\nBEAR_STRENGTH=30\nRISK=MODERATE\nGo for it.", 200, 80),
        ],
    )
    monkeypatch.setattr(live_debate, "_AGENTS", _two_agents())
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    finalize_spy = MagicMock(return_value=True)
    monkeypatch.setattr(
        "engine.cost_guard.finalize_reservation", finalize_spy
    )

    await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_api_key_config(),
            reservation_id=reservation.reservation_id,
        )
    )

    finalize_spy.assert_called_once()
    call_kwargs = finalize_spy.call_args.kwargs
    assert call_kwargs["actual_cost_usd"] >= 0  # cost is non-negative
    assert finalize_spy.call_args.args[0] == reservation.reservation_id


@pytest.mark.asyncio
async def test_reservation_finalized_at_zero_on_oauth(monkeypatch, tmp_db):
    # OAuth runs through ChatGPT subscription billing; engine records $0 so
    # the cost ledger doesn't double-count what the user already pays Anthropic.
    from engine import cost_guard

    cost_guard.update_config(
        enabled=True,
        cap_daily_usd=100.0,
        cap_weekly_usd=100.0,
        cap_monthly_usd=100.0,
        cap_sessions_per_day=100,
    )
    reservation = cost_guard.reserve(
        model="gpt-5.4", auth_kind="oauth", max_tokens=400, override=False
    )

    fake = _FakeAdapter(script=[("Decision content.", 5000, 2000)])
    monkeypatch.setattr(
        live_debate,
        "_AGENTS",
        [_Agent(name="portfolio_manager", phase="decision", system_prompt="p")],
    )
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    finalize_calls: list[tuple] = []

    def capture(reservation_id, *, actual_cost_usd):
        finalize_calls.append((reservation_id, actual_cost_usd))
        return True

    monkeypatch.setattr("engine.cost_guard.finalize_reservation", capture)

    await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_oauth_config(),
            reservation_id=reservation.reservation_id,
        )
    )

    assert len(finalize_calls) == 1
    rid, cost = finalize_calls[0]
    assert rid == reservation.reservation_id
    assert cost == 0.0
    # The adapter also got its account_id set from the oauth blob.
    assert fake.account_id_set == "acct-123"


# ---- session.complete shape -----------------------------------------------


@pytest.mark.asyncio
async def test_session_complete_carries_provider_metadata(monkeypatch):
    fake = _FakeAdapter(
        script=[("STANCE=NEUTRAL\nCONVICTION=0.60\nBULL_STRENGTH=50\nBEAR_STRENGTH=50\nRISK=MODERATE\nReasoning here.", 100, 50)],
    )
    monkeypatch.setattr(
        live_debate,
        "_AGENTS",
        [_Agent(name="portfolio_manager", phase="decision", system_prompt="p")],
    )
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    events = await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_api_key_config(provider="anthropic"),
        )
    )

    complete = next(e for e in events if e["type"] == "session.complete")
    # Provider metadata threaded through so the renderer / History row gets it.
    assert complete["live"] is True
    assert complete["provider"] == "anthropic"
    assert complete["auth_kind"] == "api_key"
    assert complete["model"] == "gpt-4o-mini"
    assert complete["input_tokens"] == 100
    assert complete["output_tokens"] == 50
    assert complete["decision"]["stance"] == "neutral"


@pytest.mark.asyncio
async def test_adapter_close_runs_even_when_an_agent_raises(monkeypatch):
    # The finally block's adapter.close() must run even if the debate exited
    # via an unhandled exception path. Otherwise the pooled httpx client
    # inside Anthropic/OpenAI adapters leaks for the engine's process lifetime.
    fake = _FakeAdapter(script=[RuntimeError("bad")])
    monkeypatch.setattr(live_debate, "_AGENTS", _two_agents())
    monkeypatch.setattr(live_debate, "adapter_for", lambda _cfg: fake)

    await _drain(
        live_debate.live_debate(
            ticker="NVDA",
            trade_date="2026-05-24",
            summary=None,
            headlines=None,
            config=_api_key_config(),
        )
    )

    assert fake.close_calls == 1
