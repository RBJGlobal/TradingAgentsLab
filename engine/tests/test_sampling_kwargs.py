"""Sampling parameters sent per model family (llm_providers).

Newer Claude models (Opus 4.7+, Fable 5.x, Sonnet 5/5.5, Haiku 5.5) reject
`temperature` with HTTP 400, and OpenAI's gpt-5 / o-series reject both a
non-default temperature and `max_tokens`. These tests assert the exact
kwargs each adapter hands its SDK client (the client is mocked; no network).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from engine import llm_providers
from engine.llm_providers import (
    THINKING_ALLOWANCE_TOKENS,
    GeminiAdapter,
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
        content=[SimpleNamespace(type="text", text="ok")],
        stop_reason="end_turn",
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


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5",
    "claude-haiku-5-5", "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2",
    "claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2",
    "claude-sonnet-5-5-20261001",  # dated id of a thinking model
])
async def test_anthropic_thinking_models_get_allowance_and_low_effort(model):
    kwargs = await _anthropic_kwargs(model)
    assert kwargs["max_tokens"] == 400 + THINKING_ALLOWANCE_TOKENS
    assert kwargs["output_config"] == {"effort": "low"}
    # Rejected (400) by these models, so never sent.
    assert "thinking" not in kwargs
    assert "budget_tokens" not in str(kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
    "claude-sonnet-4-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
])
async def test_anthropic_non_thinking_models_unchanged(model):
    kwargs = await _anthropic_kwargs(model)
    assert kwargs["max_tokens"] == 400
    assert "output_config" not in kwargs and "thinking" not in kwargs


def _anthropic_adapter(resp):
    adapter = AnthropicAdapter()
    adapter._client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=resp)))
    return adapter


@pytest.mark.asyncio
async def test_anthropic_reads_only_text_blocks_after_a_leading_thinking_block():
    resp = SimpleNamespace(
        content=[
            SimpleNamespace(type="thinking", thinking="secret reasoning", signature="sig"),
            SimpleNamespace(type="redacted_thinking", data="xxx"),
            SimpleNamespace(type="text", text="Bullish on margins. "),
            SimpleNamespace(type="text", text="Risks: rates."),
        ],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=10, output_tokens=900),
    )
    content, in_tok, out_tok = await _anthropic_adapter(resp).complete(
        system="s", user="u", model="claude-sonnet-5-5", max_tokens=400,
    )
    assert content == "Bullish on margins. Risks: rates."
    assert "secret" not in content
    assert (in_tok, out_tok) == (10, 900)


@pytest.mark.asyncio
async def test_anthropic_empty_refusal_raises_clear_error():
    from engine.llm_providers import ModelRefused

    resp = SimpleNamespace(content=[], stop_reason="refusal",
                           usage=SimpleNamespace(input_tokens=10, output_tokens=3))
    with pytest.raises(ModelRefused) as exc:
        await _anthropic_adapter(resp).complete(system="s", user="u", model="claude-sonnet-5-5", max_tokens=400)
    assert str(exc.value) == "The model declined to answer this request."
    assert (exc.value.input_tokens, exc.value.output_tokens) == (10, 3)


@pytest.mark.asyncio
async def test_anthropic_thinking_only_at_max_tokens_raises():
    resp = SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking="...", signature="sig")],
        stop_reason="max_tokens",
        usage=SimpleNamespace(input_tokens=10, output_tokens=1600),
    )
    with pytest.raises(ReasoningBudgetExhausted) as exc:
        await _anthropic_adapter(resp).complete(
            system="s", user="u", model="claude-opus-5-5", max_tokens=400,
        )
    assert (exc.value.input_tokens, exc.value.output_tokens) == (10, 1600)


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
@pytest.mark.parametrize("model,effort,limit", [
    ("gpt-5", "minimal", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gpt-5-mini", "minimal", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gpt-5-nano", "minimal", 400 + THINKING_ALLOWANCE_TOKENS),
    # Effort "none" = no thinking, so no allowance.
    ("gpt-5.1", "none", 400),
    ("gpt-5.5", "none", 400),
    ("gpt-6.1-sol", "none", 400),
    ("o4-mini", "low", 400 + THINKING_ALLOWANCE_TOKENS),
    ("o3", "low", 400 + THINKING_ALLOWANCE_TOKENS),
])
async def test_openai_reasoning_models_get_lowest_effort_and_max_completion_tokens(model, effort, limit):
    assert await _openai_kwargs(OpenAIAdapter(), model) == {
        "max_completion_tokens": limit, "reasoning_effort": effort,
    }


@pytest.mark.asyncio
async def test_openai_pro_gets_allowance_but_no_effort():
    # gpt-5-pro only supports "high" (its default), but it still reasons.
    assert await _openai_kwargs(OpenAIAdapter(), "gpt-5-pro") == {
        "max_completion_tokens": 400 + THINKING_ALLOWANCE_TOKENS,
    }


@pytest.mark.asyncio
async def test_openai_chat_model_gets_no_effort_and_no_allowance():
    # -chat is not a reasoning model.
    assert await _openai_kwargs(OpenAIAdapter(), "gpt-5-chat-latest") == {"max_completion_tokens": 400}


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


_THINK = 400 + THINKING_ALLOWANCE_TOKENS
_LOW = {"reasoning": {"effort": "low", "exclude": True}}


@pytest.fixture
def _clean_runtime_reasoning():
    llm_providers._RUNTIME_REASONING.clear()
    yield
    llm_providers._RUNTIME_REASONING.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,expected", [
    # Catalog not loaded: name rules for the known vendors.
    ("anthropic/claude-opus-5.5", {"max_tokens": _THINK, "extra_body": _LOW}),
    ("anthropic/claude-sonnet-5.5", {"max_tokens": _THINK, "extra_body": _LOW}),
    ("anthropic/claude-sonnet-4.6", {"max_tokens": 400, "temperature": 0.7}),
    ("anthropic/claude-haiku-4.5", {"max_tokens": 400, "temperature": 0.7}),
    # openai/*: exactly the direct OpenAI rules on the part after the slash.
    ("openai/gpt-5-mini", {"max_tokens": _THINK,
                           "extra_body": {"reasoning": {"effort": "minimal", "exclude": True}}}),
    ("openai/gpt-5.1", {"max_tokens": 400,
                        "extra_body": {"reasoning": {"effort": "none", "exclude": True}}}),
    ("openai/gpt-5.5", {"max_tokens": 400,
                        "extra_body": {"reasoning": {"effort": "none", "exclude": True}}}),
    ("openai/o4-mini", {"max_tokens": _THINK, "extra_body": _LOW}),
    # -pro only accepts "high": room to think, no reasoning object.
    ("openai/gpt-5-pro", {"max_tokens": _THINK}),
    ("openai/o3-pro", {"max_tokens": _THINK}),
    # -chat is not a reasoning model.
    ("openai/gpt-5-chat", {"max_tokens": 400}),
    ("openai/gpt-4o-mini", {"max_tokens": 400, "temperature": 0.7}),
    ("google/gemini-2.5-flash", {"max_tokens": _THINK, "temperature": 0.7, "extra_body": _LOW}),
    ("google/gemini-2.0-flash", {"max_tokens": 400, "temperature": 0.7}),
    ("x-ai/grok-4.3", {"max_tokens": 400, "temperature": 0.7}),
    # Unknown vendor, catalog not loaded: no allowance (guard still applies).
    ("qwen/qwen3.8-2.4t-a95b", {"max_tokens": 400, "temperature": 0.7}),
])
async def test_openrouter_applies_vendor_rule(model, expected, _clean_runtime_reasoning):
    assert await _openai_kwargs(OpenRouterAdapter(), model) == expected


@pytest.mark.asyncio
async def test_openrouter_catalog_flag_gives_allowance_and_lowest_listed_effort(_clean_runtime_reasoning):
    # The founder's failing model: reasoning learned from the catalog.
    llm_providers.register_runtime_reasoning(
        "qwen/qwen3.8-2.4t-a95b", capable=True, efforts=["high", "medium", "minimal"],
    )
    assert await _openai_kwargs(OpenRouterAdapter(), "qwen/qwen3.8-2.4t-a95b") == {
        "max_tokens": _THINK, "temperature": 0.7,
        "extra_body": {"reasoning": {"effort": "minimal", "exclude": True}},
    }


@pytest.mark.asyncio
async def test_openrouter_never_sends_none_to_a_default_thinker(_clean_runtime_reasoning):
    # "none" 400s on models that think by default, mandatory or not.
    for mid, mandatory in (("acme/thinker", True), ("acme/optional-flag", False)):
        llm_providers.register_runtime_reasoning(
            mid, capable=True, efforts=["none", "low", "high"], mandatory=mandatory,
        )
        kwargs = await _openai_kwargs(OpenRouterAdapter(), mid)
        assert kwargs["extra_body"]["reasoning"]["effort"] == "low", mid
        assert kwargs["max_tokens"] == _THINK
    # Optional reasoning that the catalog marks not-by-default: no allowance.
    llm_providers.register_runtime_reasoning("acme/optional", capable=False)
    assert await _openai_kwargs(OpenRouterAdapter(), "acme/optional") == {
        "max_tokens": 400, "temperature": 0.7,
    }


# ---- Gemini ------------------------------------------------------------------


def _gemini_adapter(resp):
    adapter = GeminiAdapter()
    gen = MagicMock(return_value=resp)
    adapter._client = SimpleNamespace(models=SimpleNamespace(generate_content=gen))
    return adapter, gen


def _gemini_resp(text, finish="STOP", thoughts=0):
    return SimpleNamespace(
        text=text,
        candidates=[SimpleNamespace(finish_reason=SimpleNamespace(value=finish))],
        usage_metadata=SimpleNamespace(
            prompt_token_count=10, candidates_token_count=50, thoughts_token_count=thoughts,
        ),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("model,expected", [
    ("gemini-2.5-flash", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gemini-2.5-pro", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gemini-3.1-flash-lite", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gemini-flash-latest", 400 + THINKING_ALLOWANCE_TOKENS),
    ("gemini-2.5-flash-lite", 400),  # does not think by default
    ("gemini-2.0-flash", 400),
])
async def test_gemini_thinking_models_get_allowance(model, expected):
    adapter, gen = _gemini_adapter(_gemini_resp("ok"))
    await adapter.complete(system="s", user="u", model=model, max_tokens=400)
    config = gen.call_args.kwargs["config"]
    assert config.max_output_tokens == expected
    # No ThinkingConfig: allowed values are model dependent per the SDK.
    assert config.thinking_config is None


@pytest.mark.asyncio
async def test_gemini_counts_thinking_tokens_as_output():
    adapter, _ = _gemini_adapter(_gemini_resp("ok", thoughts=700))
    assert await adapter.complete(system="s", user="u", model="gemini-2.5-flash", max_tokens=400) == (
        "ok", 10, 750,
    )


@pytest.mark.asyncio
async def test_gemini_empty_at_max_tokens_raises():
    adapter, _ = _gemini_adapter(_gemini_resp("", finish="MAX_TOKENS", thoughts=1550))
    with pytest.raises(ReasoningBudgetExhausted):
        await adapter.complete(system="s", user="u", model="gemini-2.5-pro", max_tokens=400)
