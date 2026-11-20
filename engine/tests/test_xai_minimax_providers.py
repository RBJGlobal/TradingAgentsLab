"""Tests for the xAI Grok + MiniMax native providers (added 2026-05-27).

Both are OpenAI-compatible (API key only), so they subclass OpenAIAdapter
with a fixed class-level base_url, exactly like OpenRouterAdapter. The one
wrinkle is MiniMax: its M2.x reasoning models embed <think>...</think>
chain-of-thought in message.content, which MiniMaxAdapter strips post-hoc.
These tests pin the dispatch, the base URLs, the config-validation rules,
the think-block stripping (including the truncated-at-cap edge case the
happy path misses), and the cost-table wiring.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from engine.cost_guard import worst_case_reservation
from engine.llm_providers import (
    MiniMaxAdapter,
    OpenAIAdapter,
    ProviderConfig,
    XaiAdapter,
    _strip_think_blocks,
    adapter_for,
    default_model_for,
    estimate_cost,
)


# ---- Dispatch + base URLs --------------------------------------------------


def test_xai_dispatch_and_base_url():
    cfg = ProviderConfig.from_dict(
        {"provider": "xai", "auth": {"type": "api_key", "api_key": "xai-test"}}
    )
    adapter = adapter_for(cfg)
    assert isinstance(adapter, XaiAdapter)
    assert isinstance(adapter, OpenAIAdapter)  # reuses the chat-completions path
    assert adapter.name == "xai"
    assert adapter._base_url == "https://api.x.ai/v1"


def test_minimax_dispatch_and_base_url():
    cfg = ProviderConfig.from_dict(
        {"provider": "minimax", "auth": {"type": "api_key", "api_key": "mm-test"}}
    )
    adapter = adapter_for(cfg)
    assert isinstance(adapter, MiniMaxAdapter)
    assert isinstance(adapter, OpenAIAdapter)
    assert adapter.name == "minimax"
    # Global region only — China (.minimaxi.com) is deliberately out of v1 scope.
    assert adapter._base_url == "https://api.minimax.io/v1"


def test_base_url_threads_into_client():
    """open() must hand the provider base_url to AsyncOpenAI so requests hit
    the provider's cloud, not OpenAI's."""
    for adapter, expected in (
        (XaiAdapter(), "https://api.x.ai/v1"),
        (MiniMaxAdapter(), "https://api.minimax.io/v1"),
    ):
        with patch("openai.AsyncOpenAI") as mock_client:
            asyncio.run(adapter.open(api_key="secret"))
            kwargs = mock_client.call_args.kwargs
            assert kwargs["base_url"] == expected
            assert kwargs["api_key"] == "secret"


# ---- Config validation -----------------------------------------------------


def test_from_dict_accepts_api_key_for_new_providers():
    for provider in ("xai", "minimax"):
        cfg = ProviderConfig.from_dict(
            {"provider": provider, "auth": {"type": "api_key", "api_key": "k"}}
        )
        assert cfg is not None
        assert cfg.provider == provider
        assert cfg.auth_kind == "api_key"


def test_from_dict_defaults_model_when_absent():
    cfg = ProviderConfig.from_dict(
        {"provider": "xai", "auth": {"type": "api_key", "api_key": "k"}}
    )
    assert cfg.model == default_model_for("xai") == "grok-4.3"


def test_new_providers_reject_oauth():
    """OAuth is OpenAI-only; xAI/MiniMax are API-key only."""
    for provider in ("xai", "minimax"):
        cfg = ProviderConfig.from_dict(
            {"provider": provider, "auth": {"type": "oauth", "access": "tok"}}
        )
        assert cfg is None


def test_new_providers_reject_local_auth():
    for provider in ("xai", "minimax"):
        cfg = ProviderConfig.from_dict(
            {"provider": provider, "auth": {"type": "local", "base_url": "http://x/v1"}}
        )
        assert cfg is None


# ---- MiniMax <think>-block stripping --------------------------------------


def test_strip_complete_think_block():
    out = _strip_think_blocks("<think>weighing the bull case</think>Final: BUY.")
    assert out == "Final: BUY."


def test_strip_multiple_think_blocks():
    out = _strip_think_blocks("<think>a</think>HOLD because<think>b</think> reasons.")
    assert out == "HOLD because reasons."


def test_strip_unclosed_think_at_token_cap_returns_sentinel():
    """Response hit max_tokens mid-thought: no </think>, no answer. We must
    NOT surface raw chain-of-thought as the agent's conclusion."""
    out = _strip_think_blocks("<think>still reasoning when the budget ran ou")
    assert out == "[truncated: model returned only reasoning, no final answer]"


def test_strip_answer_then_dangling_think_keeps_answer():
    """A real partial answer before a truncated think block survives."""
    out = _strip_think_blocks("Verdict: SELL.<think>more detail truncated here")
    assert out == "Verdict: SELL."


def test_strip_think_only_complete_block_returns_sentinel():
    out = _strip_think_blocks("<think>only reasoning, model gave no answer</think>")
    assert out == "[truncated: model returned only reasoning, no final answer]"


def test_strip_leaves_clean_content_untouched():
    out = _strip_think_blocks("Just a normal answer with no reasoning block.")
    assert out == "Just a normal answer with no reasoning block."


def test_strip_handles_think_tag_with_attributes():
    """A <think> opener carrying attributes must still be stripped, not leaked
    raw into the transcript."""
    out = _strip_think_blocks('<think id="1">weighing it</think>Final: BUY.')
    assert out == "Final: BUY."


def test_strip_removes_orphaned_closing_tag_from_pseudo_nesting():
    """Pseudo-nested input can leave a stray </think>; no reasoning markup
    (opening or closing) should survive into the conclusion."""
    out = _strip_think_blocks("<think>a<think>b</think>c</think>Final answer.")
    assert "<think" not in out and "</think" not in out


def test_minimax_complete_strips_think_block():
    """End-to-end through the adapter: a MiniMax response carrying a <think>
    block returns clean content while preserving the usage token counts."""
    adapter = MiniMaxAdapter()

    msg = MagicMock()
    msg.content = "<think>chain of thought</think>Recommendation: HOLD."
    usage = MagicMock(prompt_tokens=1200, completion_tokens=300)
    resp = MagicMock(choices=[MagicMock(message=msg)], usage=usage)

    adapter._client = MagicMock()
    adapter._client.chat.completions.create = AsyncMock(return_value=resp)

    content, in_tok, out_tok = asyncio.run(
        adapter.complete(system="s", user="u", model="MiniMax-M2.7", max_tokens=400)
    )
    assert content == "Recommendation: HOLD."
    assert (in_tok, out_tok) == (1200, 300)


# ---- Cost-table wiring -----------------------------------------------------


def test_new_provider_models_are_priced():
    """Curated xAI + MiniMax models must reserve > $0 (not the unknown path)
    and stay bounded at the hard token cap."""
    for model in (
        "grok-4.3",
        "grok-4.20-reasoning",
        "grok-4.20-non-reasoning",
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
    ):
        assert estimate_cost(model, 1000, 400) > 0.0
        est = worst_case_reservation(model=model, auth_kind="api_key", max_tokens=800)
        assert 0.0 < est < 1.0, f"{model} worst-case ${est:.4f} out of range"


def test_gemini_default_is_not_the_retired_2_0_flash():
    # Google retired gemini-2.0-flash (404 "no longer available", checked
    # with a real key 2026-11-20). The default must be a live, priced model
    # that is also the recommended static pick.
    from engine.llm_providers import _COST_PER_M_TOKENS as PRICES
    from engine.provider_models import STATIC_MODELS

    assert default_model_for("gemini") == "gemini-3.1-flash-lite"
    assert "gemini-3.1-flash-lite" in PRICES
    gem = STATIC_MODELS["gemini"]
    assert "gemini-2.0-flash" not in [m["id"] for m in gem]
    assert [m["id"] for m in gem if m.get("recommended")] == ["gemini-3.1-flash-lite"]
