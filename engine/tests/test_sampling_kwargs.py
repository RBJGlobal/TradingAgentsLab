"""Sampling parameters sent per model family (llm_providers).

Newer Claude models (Opus 4.7+, Fable 5.x, Sonnet 5/5.5, Haiku 5.5) reject
`temperature` with HTTP 400, and OpenAI's gpt-5 / o-series reject both a
non-default temperature and `max_tokens`. These tests assert the exact
kwargs each adapter hands its SDK client (the client is mocked; no network).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from engine.llm_providers import (
    AnthropicAdapter,
    LocalLLMAdapter,
    MiniMaxAdapter,
    OpenAIAdapter,
    OpenRouterAdapter,
    ReasoningBudgetExhausted,
    XaiAdapter,
)


def _openai_resp():
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))],
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
    )


async def _openai_kwargs(adapter, model: str) -> dict:
    create = AsyncMock(return_value=_openai_resp())
    adapter._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    await adapter.complete(system="s", user="u", model=model, max_tokens=400)
    kwargs = dict(create.call_args.kwargs)
    kwargs.pop("messages")
    kwargs.pop("model")
    return kwargs


async def _anthropic_kwargs(model: str) -> dict:
    create = AsyncMock(return_value=SimpleNamespace(
        content=[SimpleNamespace(text="ok")],
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    ))
    adapter = AnthropicAdapter()
    adapter._client = SimpleNamespace(messages=SimpleNamespace(create=create))
    await adapter.complete(system="s", user="u", model=model, max_tokens=400)
    return dict(create.call_args.kwargs)


# ---- Anthropic ---------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2",
    "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5",
    "claude-opus-5", "claude-some-future-model",
])
async def test_anthropic_omits_temperature_for_new_and_unknown_models(model):
    kwargs = await _anthropic_kwargs(model)
    assert "temperature" not in kwargs
    assert kwargs["max_tokens"] == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-6",
    "claude-haiku-4-5-20251001",  # dated snapshot of an allowed model
    "claude-3-7-sonnet-latest",
])
async def test_anthropic_keeps_temperature_for_older_models(model):
    kwargs = await _anthropic_kwargs(model)
    assert kwargs["temperature"] == 0.7
    assert kwargs["max_tokens"] == 400


# ---- Direct OpenAI -----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4-turbo"])
async def test_openai_classic_models_keep_max_tokens_and_temperature(model):
    assert await _openai_kwargs(OpenAIAdapter(), model) == {"max_tokens": 400, "temperature": 0.7}


@pytest.mark.asyncio
@pytest.mark.parametrize("model,effort", [
    ("gpt-5", "minimal"),
    ("gpt-5-mini", "minimal"),
    ("gpt-5-nano", "minimal"),
    ("gpt-5.1", "none"),
    ("gpt-5.5", "none"),
    ("gpt-6.1-sol", "none"),
    ("o4-mini", "low"),
    ("o3", "low"),
])
async def test_openai_reasoning_models_get_lowest_effort_and_max_completion_tokens(model, effort):
    assert await _openai_kwargs(OpenAIAdapter(), model) == {
        "max_completion_tokens": 400, "reasoning_effort": effort,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-5-pro", "gpt-5-chat-latest"])
async def test_openai_effort_left_out_where_unsupported(model):
    # gpt-5-pro only supports "high" (its default); -chat is not a reasoning model.
    assert await _openai_kwargs(OpenAIAdapter(), model) == {"max_completion_tokens": 400}


# ---- Empty answer after spending the whole budget on reasoning --------------


def _empty_length_resp():
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=""), finish_reason="length")],
        usage=SimpleNamespace(prompt_tokens=900, completion_tokens=400),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("adapter,model", [
    (OpenAIAdapter(), "gpt-5"),
    (OpenRouterAdapter(), "openai/gpt-5-mini"),
])
async def test_empty_length_response_raises_visible_error(adapter, model):
    create = AsyncMock(return_value=_empty_length_resp())
    adapter._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    with pytest.raises(ReasoningBudgetExhausted) as exc:
        await adapter.complete(system="s", user="u", model=model, max_tokens=400)
    assert "returned no text" in str(exc.value)
    assert "—" not in str(exc.value) and "–" not in str(exc.value)
    # The billed reasoning tokens travel with the error.
    assert (exc.value.input_tokens, exc.value.output_tokens) == (900, 400)


@pytest.mark.asyncio
async def test_empty_but_finished_response_is_not_an_error():
    adapter = OpenAIAdapter()
    resp = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=""), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=0),
    )
    adapter._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
        create=AsyncMock(return_value=resp))))
    assert await adapter.complete(system="s", user="u", model="gpt-5", max_tokens=400) == ("", 1, 0)


# ---- OpenAI-compatible endpoints keep the original shape ---------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("adapter,model", [
    (XaiAdapter(), "grok-4.3"),
    (MiniMaxAdapter(), "MiniMax-M2.7"),
    (LocalLLMAdapter(base_url="http://localhost:11434/v1"), "llama3.2:latest"),
    # A gpt-5-looking name on a local runtime must NOT get OpenAI's rules.
    (LocalLLMAdapter(base_url="http://localhost:11434/v1"), "gpt-5"),
])
async def test_compatible_endpoints_unchanged(adapter, model):
    assert await _openai_kwargs(adapter, model) == {"max_tokens": 400, "temperature": 0.7}


# ---- OpenRouter: the vendor's rule on the part after the slash -------------


@pytest.mark.asyncio
@pytest.mark.parametrize("model,expected", [
    ("anthropic/claude-opus-5.5", {"max_tokens": 400}),
    ("anthropic/claude-sonnet-5.5", {"max_tokens": 400}),
    ("anthropic/claude-sonnet-4.6", {"max_tokens": 400, "temperature": 0.7}),
    ("anthropic/claude-haiku-4.5", {"max_tokens": 400, "temperature": 0.7}),
    ("openai/gpt-5-mini", {"max_tokens": 400, "reasoning_effort": "minimal"}),
    ("openai/gpt-5.5", {"max_tokens": 400, "reasoning_effort": "none"}),
    ("openai/o4-mini", {"max_tokens": 400}),
    ("openai/gpt-4o-mini", {"max_tokens": 400, "temperature": 0.7}),
    ("google/gemini-2.5-flash", {"max_tokens": 400, "temperature": 0.7}),
    ("x-ai/grok-4.3", {"max_tokens": 400, "temperature": 0.7}),
])
async def test_openrouter_applies_vendor_rule(model, expected):
    assert await _openai_kwargs(OpenRouterAdapter(), model) == expected
