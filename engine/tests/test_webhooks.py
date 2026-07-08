"""Webhook dispatcher tests.

httpx is mocked so the suite stays hermetic — no real POSTs to Slack /
Telegram / Discord / arbitrary localhost ports. Tests cover:

- Payload shape per kind (generic / slack / discord / telegram)
- HMAC signature on the generic kind, with the right algorithm
- Filter logic: stance allowlist + min_conviction
- Filtered receivers don't open a connection
- 200/4xx/timeout/exception map to fired/failed correctly
- WebhookResult NEVER carries the URL (security: URLs embed tokens)
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from engine.webhooks import (
    WebhookConfig,
    WebhookFilter,
    WebhookResult,
    dispatch_all,
)


def _config(
    *,
    kind: str = "generic",
    secret: str | None = None,
    stances: list[str] | None = None,
    min_conviction: float = 0.0,
    url: str = "https://example.com/hook",
    id_: str = "wh1",
) -> WebhookConfig:
    return WebhookConfig(
        id=id_,
        name=f"test-{kind}",
        url=url,
        kind=kind,  # type: ignore[arg-type]
        secret=secret,
        filter=WebhookFilter(stances=stances or [], min_conviction=min_conviction),
    )


_DECISION = {
    "stance": "bullish",
    "conviction": 0.78,
    "bull_strength": 78,
    "bear_strength": 52,
    "risk_level": "moderate",
    "reasoning": "Solid setup.",
}


def _mock_client(*, status_code: int = 200) -> tuple[Any, list[dict]]:
    """Returns (mock_client_cls, captured_posts) — patch in via
    `with patch('engine.webhooks.httpx.AsyncClient', mock):`."""
    captured: list[dict] = []

    response = MagicMock()
    response.status_code = status_code

    post = AsyncMock(return_value=response)

    async def _capturing_post(url: str, **kwargs):
        captured.append({"url": url, **kwargs})
        return response

    post.side_effect = _capturing_post

    instance = MagicMock()
    instance.post = post
    instance.__aenter__ = AsyncMock(return_value=instance)
    instance.__aexit__ = AsyncMock(return_value=None)

    cls = MagicMock(return_value=instance)
    return cls, captured


# ---- Payload shape tests --------------------------------------------------


@pytest.mark.asyncio
async def test_generic_payload_carries_full_decision_shape():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config(kind="generic")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
            session_id="sess-1",
            live=True,
            provider="openai",
            model="gpt-4o-mini",
            estimated_cost_usd=0.0042,
        )

    assert len(captured) == 1
    body = json.loads(captured[0]["content"])
    assert body["schema"] == "tradingagentslab.webhook.v2"
    assert body["event"] == "session.complete"
    assert body["ticker"] == "NVDA"
    assert body["trade_date"] == "2026-05-15"
    assert body["decision"]["stance"] == "bullish"
    assert body["decision"]["conviction"] == 0.78
    assert body["decision"]["bull_strength"] == 78
    assert body["decision"]["bear_strength"] == 52
    assert body["decision"]["risk_level"] == "moderate"
    assert body["session_id"] == "sess-1"
    assert body["live"] is True
    assert body["provider"] == "openai"
    assert body["model"] == "gpt-4o-mini"
    assert body["estimated_cost_usd"] == 0.0042

    assert results == [
        WebhookResult(id="wh1", name="test-generic", status="fired", http_status=200)
    ]


@pytest.mark.asyncio
async def test_slack_payload_is_just_text():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        await dispatch_all(
            configs=[_config(kind="slack")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    body = json.loads(captured[0]["content"])
    assert list(body.keys()) == ["text"]
    assert "NVDA" in body["text"]
    assert "Bullish" in body["text"]
    assert "78%" in body["text"]


@pytest.mark.asyncio
async def test_discord_payload_uses_content_field():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        await dispatch_all(
            configs=[_config(kind="discord")],
            ticker="ETH",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    body = json.loads(captured[0]["content"])
    assert "content" in body
    assert "text" not in body
    assert "ETH" in body["content"]


@pytest.mark.asyncio
async def test_telegram_payload_includes_chat_id_and_markdown():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        await dispatch_all(
            configs=[_config(kind="telegram", id_="tg1")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
            telegram_chat_ids={"tg1": "12345678"},
        )
    body = json.loads(captured[0]["content"])
    assert body["parse_mode"] == "Markdown"
    assert body["chat_id"] == "12345678"
    assert "NVDA" in body["text"]


@pytest.mark.asyncio
async def test_telegram_without_chat_id_still_posts_but_omits_field():
    """Engine doesn't reject — Telegram API responds 400, we surface as
    failed. This keeps the dispatcher contract simple."""
    cls, captured = _mock_client(status_code=400)
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config(kind="telegram")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    body = json.loads(captured[0]["content"])
    assert "chat_id" not in body
    assert results[0].status == "failed"
    assert results[0].http_status == 400


# ---- HMAC tests -----------------------------------------------------------


@pytest.mark.asyncio
async def test_generic_with_secret_signs_body_with_hmac_sha256():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        await dispatch_all(
            configs=[_config(kind="generic", secret="shh")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )

    headers = captured[0]["headers"]
    assert "X-TAL-Signature" in headers
    sig = headers["X-TAL-Signature"]
    assert sig.startswith("sha256=")

    body_bytes = captured[0]["content"]
    expected = hmac.new(b"shh", body_bytes, hashlib.sha256).hexdigest()
    assert sig == f"sha256={expected}"


@pytest.mark.asyncio
async def test_slack_does_not_sign_body_even_with_secret():
    """Notification presets use URL-embedded auth; signing would only confuse
    Slack's parser."""
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        await dispatch_all(
            configs=[_config(kind="slack", secret="ignored")],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    assert "X-TAL-Signature" not in captured[0]["headers"]


# ---- Filter tests ---------------------------------------------------------


@pytest.mark.asyncio
async def test_filter_stances_allowlist_blocks_neutral():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config(stances=["bullish", "bearish"])],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision={"stance": "neutral", "conviction": 0.9, "reasoning": ""},
        )
    assert captured == []
    assert results[0].status == "filtered"


@pytest.mark.asyncio
async def test_filter_min_conviction_blocks_low_conviction():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config(min_conviction=0.75)],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision={"stance": "bullish", "conviction": 0.5, "reasoning": ""},
        )
    assert captured == []
    assert results[0].status == "filtered"


@pytest.mark.asyncio
async def test_filter_empty_means_fire_on_everything():
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config()],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision={"stance": "neutral", "conviction": 0.0, "reasoning": ""},
        )
    assert len(captured) == 1
    assert results[0].status == "fired"


# ---- Outcome mapping ------------------------------------------------------


@pytest.mark.asyncio
async def test_non_2xx_response_maps_to_failed():
    cls, _ = _mock_client(status_code=403)
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config()],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    assert results[0].status == "failed"
    assert results[0].http_status == 403


@pytest.mark.asyncio
async def test_exception_maps_to_failed_without_leaking_url():
    """A network error must not echo the URL — URLs embed bot tokens."""
    response = MagicMock()
    instance = MagicMock()

    async def _raise(*args, **kwargs):
        raise ConnectionError("could not resolve host")

    post = AsyncMock(side_effect=_raise)
    instance.post = post
    instance.__aenter__ = AsyncMock(return_value=instance)
    instance.__aexit__ = AsyncMock(return_value=None)
    cls = MagicMock(return_value=instance)

    secret_url = "https://api.telegram.org/bot1234:secret-token/sendMessage"
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[_config(url=secret_url)],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    assert results[0].status == "failed"
    # The error string carries the exception, NOT the URL.
    assert "secret-token" not in (results[0].error or "")
    # And the result dict (which the renderer reads) carries no URL field.
    assert "url" not in results[0].to_dict()


# ---- Parallelism ----------------------------------------------------------


@pytest.mark.asyncio
async def test_multiple_receivers_fire_in_parallel():
    """All three configured receivers should appear in the result list."""
    cls, captured = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[
                _config(kind="generic", id_="g"),
                _config(kind="slack", id_="s"),
                _config(kind="discord", id_="d"),
            ],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    assert len(captured) == 3
    assert {r.id for r in results} == {"g", "s", "d"}
    assert all(r.status == "fired" for r in results)


@pytest.mark.asyncio
async def test_no_configs_returns_empty_no_client_created():
    cls = MagicMock()
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision=_DECISION,
        )
    assert results == []
    cls.assert_not_called()


# ---- WebhookConfig.from_dict ---------------------------------------------


def test_from_dict_accepts_valid_shape():
    # from_dict accepts legacy `actions`/`min_confidence` keys (saved-config
    # compat) and stores them under the current `stances`/`min_conviction` attrs.
    c = WebhookConfig.from_dict(
        {
            "id": "wh1",
            "name": "my hook",
            "url": "https://x/y",
            "kind": "slack",
            "secret": "shh",
            "filter": {"actions": ["BUY"], "min_confidence": 0.5},
        }
    )
    assert c is not None
    assert c.id == "wh1"
    assert c.kind == "slack"
    assert c.filter.stances == ["BUY"]
    assert c.filter.min_conviction == 0.5


@pytest.mark.asyncio
async def test_from_dict_legacy_actions_filter_correctly():
    """A config persisted with old `actions`/`min_confidence` keys must still
    filter correctly. BUY→bullish, SELL→bearish, HOLD→neutral at passes() time."""
    cls, captured = _mock_client()
    legacy_cfg = WebhookConfig.from_dict(
        {
            "id": "leg1",
            "name": "legacy hook",
            "url": "https://example.com/hook",
            "kind": "generic",
            "filter": {"actions": ["BUY", "SELL"], "min_confidence": 0.5},
        }
    )
    assert legacy_cfg is not None

    # neutral (maps from HOLD) does NOT match [BUY,SELL] → filtered
    with patch("engine.webhooks.httpx.AsyncClient", cls):
        results = await dispatch_all(
            configs=[legacy_cfg],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision={"stance": "neutral", "conviction": 0.9, "reasoning": ""},
        )
    assert captured == []
    assert results[0].status == "filtered"

    # bullish (maps from BUY) with conviction ≥ 0.5 → fires
    cls2, captured2 = _mock_client()
    with patch("engine.webhooks.httpx.AsyncClient", cls2):
        results2 = await dispatch_all(
            configs=[legacy_cfg],
            ticker="NVDA",
            trade_date="2026-05-15",
            decision={"stance": "bullish", "conviction": 0.75, "reasoning": ""},
        )
    assert len(captured2) == 1
    assert results2[0].status == "fired"


def test_from_dict_rejects_missing_required():
    assert WebhookConfig.from_dict({"name": "no id or url"}) is None


def test_from_dict_normalizes_bad_kind_to_generic():
    c = WebhookConfig.from_dict({"id": "x", "url": "https://x/y", "kind": "broker"})
    assert c is not None
    assert c.kind == "generic"
