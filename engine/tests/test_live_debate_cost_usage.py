"""Cost-usage event tests for the live_debate generator.

Verifies the engine emits a `cost.usage` event with running totals after
every `agent.message`, so the renderer can tick the Spend pill mid-stream
without waiting for `session.complete`.

Adapter is fully stubbed — no LLM calls hit the network. The stub returns
a fixed token count per call so we can predict the running cost.
"""

from __future__ import annotations

import pytest

from engine.live_debate import (
    MAX_AGENTS_PER_SESSION,
    ProviderConfig,
    SentimentBlock,
    live_debate,
)


class _StubAdapter:
    """Yields a deterministic (content, in_tokens, out_tokens) per call.

    `portfolio_manager` is the last agent and produces a parseable
    decision so the generator hits its normal `session.complete` path.
    """

    name = "stub"

    def __init__(self) -> None:
        self._call = 0

    async def open(self, *, api_key: str) -> None:
        return None

    async def close(self) -> None:
        return None

    async def complete(
        self, *, system: str, user: str, model: str, max_tokens: int
    ) -> tuple[str, int, int]:
        self._call += 1
        if self._call == MAX_AGENTS_PER_SESSION:
            return ("STANCE=NEUTRAL\nCONVICTION=0.5\nBULL_STRENGTH=50\nBEAR_STRENGTH=50\nRISK=MODERATE\nReason", 50, 25)
        return (f"agent {self._call} output", 100, 50)


@pytest.fixture
def _patch_adapter(monkeypatch: pytest.MonkeyPatch) -> _StubAdapter:
    stub = _StubAdapter()
    # estimate_cost is imported into live_debate's namespace at module
    # load — patch the live_debate-local reference so the running-cost
    # math is predictable regardless of the model price table.
    monkeypatch.setattr(
        "engine.live_debate.adapter_for", lambda _config: stub
    )
    monkeypatch.setattr(
        "engine.live_debate.estimate_cost",
        lambda model, in_tok, out_tok: round(0.000001 * (in_tok + out_tok), 6),
    )
    return stub


def _make_config(auth_kind: str = "api_key") -> ProviderConfig:
    auth: dict[str, str]
    if auth_kind == "api_key":
        auth = {"type": "api_key", "api_key": "sk-test"}
    elif auth_kind == "oauth":
        auth = {
            "type": "oauth",
            "access": "tok",
            "refresh": "ref",
            "expires": "2099-01-01T00:00:00Z",
        }
    elif auth_kind == "local":
        auth = {"type": "local", "base_url": "http://localhost:11434/v1"}
    else:
        raise ValueError(auth_kind)
    return ProviderConfig(
        provider="openai" if auth_kind != "local" else "local",
        auth=auth,
        model="gpt-4o-mini",
        max_tokens=400,
    )


@pytest.mark.asyncio
async def test_cost_usage_event_after_every_agent_message(_patch_adapter):
    """Every agent.message is followed by exactly one cost.usage event."""
    events: list[dict] = []
    async for ev in live_debate(
        ticker="NVDA",
        trade_date="2026-05-15",
        summary=None,
        headlines=None,
        config=_make_config("api_key"),
        sentiment=SentimentBlock(),
    ):
        events.append(ev)

    agent_idxs = [i for i, e in enumerate(events) if e["type"] == "agent.message"]
    usage_idxs = [i for i, e in enumerate(events) if e["type"] == "cost.usage"]
    assert len(agent_idxs) == len(usage_idxs) == MAX_AGENTS_PER_SESSION
    for a_idx, u_idx in zip(agent_idxs, usage_idxs):
        assert u_idx == a_idx + 1, "cost.usage must immediately follow its agent.message"


@pytest.mark.asyncio
async def test_cost_usage_running_total_monotonic(_patch_adapter):
    """Each cost.usage carries strictly non-decreasing input/output token
    counts so the renderer can tick without flicker."""
    events: list[dict] = []
    async for ev in live_debate(
        ticker="NVDA",
        trade_date="2026-05-15",
        summary=None,
        headlines=None,
        config=_make_config("api_key"),
        sentiment=SentimentBlock(),
    ):
        events.append(ev)

    usages = [e for e in events if e["type"] == "cost.usage"]
    last_in = last_out = -1
    last_cost = -1.0
    for u in usages:
        assert u["input_tokens"] >= last_in
        assert u["output_tokens"] >= last_out
        assert u["est_cost_usd"] >= last_cost
        last_in = u["input_tokens"]
        last_out = u["output_tokens"]
        last_cost = u["est_cost_usd"]


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_kind", ["oauth", "local"])
async def test_cost_usage_marks_free_for_oauth_and_local(_patch_adapter, auth_kind):
    """OAuth subscription + local LLM runs report free=true and cost=0.0
    so the Spend pill renders "subscription" / "on-device" instead of an
    alarming static number."""
    events: list[dict] = []
    async for ev in live_debate(
        ticker="NVDA",
        trade_date="2026-05-15",
        summary=None,
        headlines=None,
        config=_make_config(auth_kind),
        sentiment=SentimentBlock(),
    ):
        events.append(ev)

    usages = [e for e in events if e["type"] == "cost.usage"]
    assert len(usages) == MAX_AGENTS_PER_SESSION
    for u in usages:
        assert u["free"] is True
        assert u["est_cost_usd"] == 0.0
        # Token counts still reported for telemetry even when free.
        assert u["input_tokens"] > 0
        assert u["output_tokens"] > 0
