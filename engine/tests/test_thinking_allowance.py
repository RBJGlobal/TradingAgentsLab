"""Thinking allowance for reasoning models (llm_providers.thinking_allowance)
and its CostGuard reservation.

Reasoning models spend hidden reasoning tokens from the same output limit as
the visible answer. They get THINKING_ALLOWANCE_TOKENS on top of max_tokens,
and the SAME function sizes CostGuard's worst-case reservation. No network.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine import llm_providers, provider_models
from engine.cost_guard import worst_case_reservation
from engine.llm_providers import THINKING_ALLOWANCE_TOKENS, infer_provider, thinking_allowance
from engine.server import build_app

TOKEN = "test-token-1234"
A = THINKING_ALLOWANCE_TOKENS


@pytest.fixture(autouse=True)
def _clean_runtime_maps():
    llm_providers._RUNTIME_RATES.clear()
    llm_providers._RUNTIME_REASONING.clear()
    yield
    llm_providers._RUNTIME_RATES.clear()
    llm_providers._RUNTIME_REASONING.clear()


def test_allowance_constant():
    assert THINKING_ALLOWANCE_TOKENS == 1200


@pytest.mark.parametrize("provider,model,expected", [
    # Anthropic: thinks by default when `thinking` is omitted.
    ("anthropic", "claude-opus-5", A), ("anthropic", "claude-opus-5-5", A),
    ("anthropic", "claude-sonnet-5", A), ("anthropic", "claude-sonnet-5-5", A),
    ("anthropic", "claude-haiku-5-5", A), ("anthropic", "claude-fable-5-2", A),
    ("anthropic", "claude-mythos-5-1", A), ("anthropic", "claude-sonnet-5-5-20261001", A),
    # Anthropic: answers without thinking when it's omitted.
    ("anthropic", "claude-opus-4-8", 0), ("anthropic", "claude-opus-4-7", 0),
    ("anthropic", "claude-opus-4-6", 0), ("anthropic", "claude-sonnet-4-6", 0),
    ("anthropic", "claude-sonnet-4-5", 0), ("anthropic", "claude-haiku-4-5-20251001", 0),
    # OpenAI.
    ("openai", "gpt-5", A), ("openai", "gpt-5-mini", A),
    ("openai", "o4-mini", A), ("openai", "gpt-5-pro", A),
    # gpt-5.1+ are sent reasoning_effort "none": no thinking, no allowance.
    ("openai", "gpt-5.1", 0), ("openai", "gpt-5.5", 0),
    ("openai", "gpt-4o-mini", 0), ("openai", "gpt-4.1", 0), ("openai", "gpt-5-chat-latest", 0),
    # Gemini.
    ("gemini", "gemini-2.5-flash", A), ("gemini", "gemini-2.5-pro", A),
    ("gemini", "gemini-3.1-flash-lite", A), ("gemini", "gemini-2.0-flash", 0),
    ("gemini", "gemini-2.5-flash-lite", 0),
    ("gemini", "gemini-flash-latest", A), ("gemini", "gemini-pro-latest", A),
    # No change for these.
    ("xai", "grok-4.3", 0), ("minimax", "MiniMax-M2.7", 0), ("local", "gpt-5", 0),
    # OpenRouter by name (catalog not loaded).
    ("openrouter", "openai/gpt-5-mini", A), ("openrouter", "anthropic/claude-opus-5.5", A),
    ("openrouter", "anthropic/claude-sonnet-4.6", 0), ("openrouter", "google/gemini-2.5-pro", A),
    ("openrouter", "openai/gpt-4o-mini", 0), ("openrouter", "qwen/qwen3.8-2.4t-a95b", 0),
    ("openrouter", "openai/gpt-5.1", 0), ("openrouter", "openai/gpt-5-chat", 0),
    ("openrouter", "openai/gpt-5-pro", A), ("openrouter", "openai/o3-pro", A),
])
def test_thinking_allowance_by_family(provider, model, expected):
    assert thinking_allowance(provider, model) == expected


def test_openrouter_catalog_flag_wins_over_name_rules_except_for_openai():
    llm_providers.register_runtime_reasoning("qwen/qwen3.8-2.4t-a95b", capable=True)
    assert thinking_allowance("openrouter", "qwen/qwen3.8-2.4t-a95b") == A
    llm_providers.register_runtime_reasoning("anthropic/claude-opus-5.5", capable=False)
    assert thinking_allowance("openrouter", "anthropic/claude-opus-5.5") == 0
    # openai/* always follows the direct OpenAI rules, so both paths agree.
    llm_providers.register_runtime_reasoning("openai/gpt-5-mini", capable=False)
    assert thinking_allowance("openrouter", "openai/gpt-5-mini") == A
    llm_providers.register_runtime_reasoning("openai/gpt-5.1", capable=True)
    assert thinking_allowance("openrouter", "openai/gpt-5.1") == 0


@pytest.mark.parametrize("model,provider", [
    ("anthropic/claude-opus-5.5", "openrouter"), ("claude-opus-5-5", "anthropic"),
    ("gpt-5", "openai"), ("o3", "openai"), ("gemini-2.5-pro", "gemini"),
    ("grok-4.3", "xai"), ("MiniMax-M2.7", None), ("llama3.2:latest", None),
])
def test_infer_provider(model, provider):
    assert infer_provider(model) == provider


# ---- OpenRouter catalog parsing -------------------------------------------


def test_parse_openrouter_reasoning():
    body = {"data": [
        # The founder's failing model: lists "reasoning", unknown vendor.
        {"id": "qwen/qwen3.8-2.4t-a95b", "supported_parameters": ["reasoning", "max_tokens"]},
        # Optional reasoning, off by default, known vendor: NOT capable
        # (sending a reasoning object would turn thinking on).
        {"id": "anthropic/claude-sonnet-4.6", "supported_parameters": ["reasoning", "temperature"]},
        {"id": "anthropic/claude-sonnet-5.5", "supported_parameters": ["reasoning"]},
        # Explicit reasoning object (OpenRouter docs shape).
        {"id": "acme/always", "reasoning": {"supported_efforts": ["none", "low", "high"],
                                            "mandatory": True, "default_enabled": True}},
        {"id": "acme/optional", "reasoning": {"supported_efforts": ["low"], "default_enabled": False,
                                              "default_effort": "none"}},
        {"id": "openai/gpt-4o-mini", "supported_parameters": ["temperature"]},
        # Reasoning object with NO default signal (only efforts): known
        # vendors fall back to the name rules instead of reading it as "off".
        {"id": "anthropic/claude-opus-5.5", "reasoning": {"supported_efforts": ["low", "high"]}},
        {"id": "anthropic/claude-opus-4.8", "reasoning": {"supported_efforts": ["low", "high"]}},
        # Unknown vendor with only efforts listed: it can reason, assume it does.
        {"id": "acme/efforts-only", "reasoning": {"supported_efforts": ["low"]}},
    ]}
    info = provider_models.parse_openrouter_reasoning(body)
    assert info["qwen/qwen3.8-2.4t-a95b"]["capable"] is True
    assert info["anthropic/claude-sonnet-4.6"]["capable"] is False
    assert info["anthropic/claude-sonnet-5.5"]["capable"] is True
    assert info["acme/always"] == {"capable": True, "efforts": ["none", "low", "high"], "mandatory": True}
    assert info["acme/optional"]["capable"] is False
    assert info["openai/gpt-4o-mini"]["capable"] is False
    assert info["anthropic/claude-opus-5.5"]["capable"] is True
    assert info["anthropic/claude-opus-4.8"]["capable"] is False
    assert info["acme/efforts-only"]["capable"] is True


# ---- CostGuard reservation --------------------------------------------------
#
# 12 agents, per-agent output limit P = max_tokens + allowance.
# Output = 12 x P. Input = 12 x 600 fixed + 66 x P of transcript growth: the
# provider doesn't split P between thinking and answer, so a model that
# thinks little can return all of P as visible text, which later agents read.


@pytest.mark.parametrize("model,provider,expected", [
    ("claude-fable-5-2", "anthropic", 1.6704),     # 8/40, thinks
    ("claude-fable-5", "anthropic", 2.088),        # 10/50, thinks
    ("claude-opus-5-5", "anthropic", 0.8352),      # 4/20, thinks
    ("claude-sonnet-5-5", "anthropic", 0.4176),    # 2/10, thinks
    ("claude-haiku-5-5", "anthropic", 0.1044),     # 0.5/2.5 ceiling row, thinks
    ("claude-opus-4-8", "anthropic", 0.288),       # 5/25, no allowance
    ("gpt-5", "openai", 1.4784),                   # 8/30, reasons
    ("gpt-5.1", "openai", 0.792),                  # gpt ceiling 15/60, effort none
    ("gpt-5.5", "openai", 0.528),                  # 10/40, effort none
    ("openai/gpt-4o-mini", "openrouter", 0.00792), # first-party row, no allowance
    ("claude-opus-9", "anthropic", 3.132),         # unknown 15/75 reasoning model
])
def test_reservation_numbers_at_400(model, provider, expected):
    est = worst_case_reservation(model=model, auth_kind="api_key", max_tokens=400, provider=provider)
    assert est == pytest.approx(expected)


def test_reservation_without_provider_infers_it():
    with_p = worst_case_reservation(model="claude-opus-5-5", auth_kind="api_key", max_tokens=400,
                                    provider="anthropic")
    without = worst_case_reservation(model="claude-opus-5-5", auth_kind="api_key", max_tokens=400)
    assert with_p == without == pytest.approx(0.8352)


def test_allowance_adds_output_and_transcript_growth():
    # Same model with and without the allowance (4/20 per 1M): the difference
    # is 12 x 1200 extra output tokens plus 66 x 1200 extra input tokens.
    base = worst_case_reservation(model="claude-opus-5-5", auth_kind="api_key", max_tokens=400,
                                  provider="xai")  # provider with no allowance
    full = worst_case_reservation(model="claude-opus-5-5", auth_kind="api_key", max_tokens=400,
                                  provider="anthropic")
    assert full - base == pytest.approx((12 * A * 20 + 66 * A * 4) / 1_000_000)


def test_oauth_and_local_still_zero():
    for kind in ("oauth", "local"):
        assert worst_case_reservation(model="gpt-5", auth_kind=kind, max_tokens=400, provider="openai") == 0.0


# ---- /cost-guard/reserve and /check with and without provider -------------


@pytest.fixture
def client(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def test_reserve_endpoint_with_and_without_provider(client):
    body = {"model": "anthropic/claude-opus-5.5", "auth_kind": "api_key", "max_tokens": 400}
    # Opus 5.5 via OpenRouter: first-party row 4/20, reasons -> $0.8352.
    without = client.post("/cost-guard/reserve", json=body)
    assert without.status_code == 200
    assert without.json()["est_cost_usd"] == pytest.approx(0.8352)
    # (override: the first reservation is still pending, and two of these
    # would exceed the daily default before $2.00; kept for a pending-reservation path.)
    with_p = client.post("/cost-guard/reserve", json={**body, "provider": "openrouter", "override": True})
    assert with_p.status_code == 200
    assert with_p.json()["est_cost_usd"] == pytest.approx(0.8352)
    # An explicit provider that has no allowance changes the number.
    xai = client.post("/cost-guard/check", json={**body, "model": "grok-4.3", "provider": "xai"})
    assert xai.status_code == 200
    assert xai.json()["est_reservation_usd"] == pytest.approx(
        worst_case_reservation(model="grok-4.3", auth_kind="api_key", max_tokens=400)
    )


def test_check_endpoint_reports_allowance_and_fits_the_default_cap(client):
    body = {"model": "claude-fable-5-2", "auth_kind": "api_key", "max_tokens": 400,
            "provider": "anthropic"}
    res = client.post("/cost-guard/check", json=body).json()
    assert res["est_reservation_usd"] == pytest.approx(1.6704)
    # Fits the shipped $2.00 daily cap (raised from $1.00 for exactly this case).
    assert res["allow"] is True


def test_check_endpoint_blocks_a_reasoning_run_above_the_default_cap(client):
    body = {"model": "claude-fable-5", "auth_kind": "api_key", "max_tokens": 400,
            "provider": "anthropic"}
    res = client.post("/cost-guard/check", json=body).json()
    assert res["est_reservation_usd"] == pytest.approx(2.088)
    # Above the $2.00 daily cap: blocked unless the user overrides.
    assert res["allow"] is False and res["over_dimension"] == "daily"


@pytest.mark.asyncio
async def test_openrouter_discovery_registers_reasoning_next_to_price(monkeypatch):
    import httpx

    body = {"data": [{"id": "qwen/qwen3.8-2.4t-a95b", "name": "Qwen", "supported_parameters": ["reasoning"],
                      "architecture": {"output_modalities": ["text"]},
                      "pricing": {"prompt": "0.000001", "completion": "0.000004"}}]}
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=body))
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: real(*a, **{**k, "transport": transport}))
    provider_models._reset_cache_for_tests()
    await provider_models.list_provider_models("openrouter", "sk-fake-key")
    assert llm_providers._RUNTIME_RATES["qwen/qwen3.8-2.4t-a95b"] == pytest.approx({"input": 1.0, "output": 4.0})
    assert llm_providers._RUNTIME_REASONING["qwen/qwen3.8-2.4t-a95b"]["capable"] is True
    assert thinking_allowance("openrouter", "qwen/qwen3.8-2.4t-a95b") == A
    provider_models._reset_cache_for_tests()
