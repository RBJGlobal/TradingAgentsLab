"""Live model discovery for API-key providers: engine/provider_models.py, the
API-key branch of POST /llm/models, and the shared price resolver that keeps
CostGuard honest for models discovered after this build.

No real network: httpx.AsyncClient is swapped for an httpx.MockTransport (the
same pattern as test_codex_models.py). Every key below is a fake.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from engine import llm_providers, provider_models
from engine.cost_guard import worst_case_reservation
from engine.llm_providers import estimate_cost, rates_for
from engine.server import build_app

TOKEN = "test-token-1234"
FAKE_KEY = "sk-fake-not-a-real-key-000"


@pytest.fixture(autouse=True)
def _clean_state():
    provider_models._reset_cache_for_tests()
    llm_providers._RUNTIME_RATES.clear()
    yield
    provider_models._reset_cache_for_tests()
    llm_providers._RUNTIME_RATES.clear()


def _mock_async_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)


# ---- Fixtures shaped like each provider's real /models response ------------

ANTHROPIC_PAGE = {
    "data": [
        {"type": "model", "id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5",
         "created_at": "2025-10-01T00:00:00Z"},
        {"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
         "created_at": "2026-10-20T00:00:00Z"},
        {"type": "model", "id": "not-a-claude-model", "display_name": "x",
         "created_at": "2026-11-01T00:00:00Z"},
        "garbage-entry",
    ],
    "has_more": False, "first_id": "claude-opus-5-5", "last_id": "claude-haiku-4-5-20251001",
}

OPENAI_LIST = {
    "object": "list",
    "data": [
        {"id": "gpt-4o-mini", "created": 100},
        {"id": "gpt-6.1-sol", "created": 900},
        {"id": "o4-mini", "created": 500},
        {"id": "gpt-5-pro", "created": 800},            # -pro: priced far above ceilings
        {"id": "gpt-4o-audio-preview", "created": 300},
        {"id": "gpt-4o-realtime-preview", "created": 300},
        {"id": "gpt-4o-mini-tts", "created": 300},
        {"id": "gpt-4o-transcribe", "created": 300},
        {"id": "whisper-1", "created": 1},
        {"id": "text-embedding-3-large", "created": 1},
        {"id": "gpt-image-1", "created": 1},
        {"id": "dall-e-3", "created": 1},
        {"id": "omni-moderation-latest", "created": 1},
        {"id": "gpt-4o-search-preview", "created": 1},
        {"id": "computer-use-preview", "created": 1},
        {"id": "gpt-5-codex", "created": 1},
        {"id": "o3-deep-research", "created": 1},
        {"id": "gpt-3.5-turbo-instruct", "created": 1},
        {"id": "babbage-002", "created": 1},
    ],
}

OPENROUTER_LIST = {
    "data": [
        {"id": "anthropic/claude-haiku-5.5", "name": "Anthropic: Claude Haiku 5.5",
         "context_length": 1000000,
         "architecture": {"output_modalities": ["text"]},
         "pricing": {"prompt": "0.0000001", "completion": "0.0000005",
                     "overrides": [{"min_prompt_tokens": 100000,
                                    "prompt": "0.0000005", "completion": "0.0000025"}]}},
        {"id": "anthropic/claude-haiku-5.5:batch", "name": "batch",
         "architecture": {"output_modalities": ["text"]},
         "pricing": {"prompt": "0.00000005", "completion": "0.00000025"}},
        {"id": "openrouter/auto", "name": "Auto Router",
         "architecture": {"output_modalities": ["text"]},
         "pricing": {"prompt": "-1", "completion": "-1"}},
        {"id": "google/some-image-model", "name": "img",
         "architecture": {"output_modalities": ["image"]},
         "pricing": {"prompt": "0.000001", "completion": "0.000001"}},
        {"id": "acme/no-arch", "name": "No architecture block",
         "pricing": {"prompt": "0.000002", "completion": "0.000004"}},
        {"id": "acme/bad-price", "name": "bad", "pricing": {"prompt": "n/a", "completion": "1"}},
        {"id": "acme/free:free", "name": "Free one",
         "architecture": {"output_modalities": ["text"]},
         "pricing": {"prompt": "0", "completion": "0"}},
    ]
}

GEMINI_PAGE_1 = {
    "models": [
        {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash",
         "supportedGenerationMethods": ["generateContent", "countTokens"]},
        {"name": "models/gemini-embedding-001", "displayName": "Embedding",
         "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/gemini-2.5-flash-image", "displayName": "Image",
         "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-2.5-flash-preview-tts", "displayName": "TTS",
         "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-live-2.5-flash", "displayName": "Live",
         "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/aqa", "displayName": "AQA",
         "supportedGenerationMethods": ["generateAnswer"]},
        {"name": "models/gemma-3-27b-it", "displayName": "Gemma",
         "supportedGenerationMethods": ["generateContent"]},
    ],
    "nextPageToken": "page-2",
}
GEMINI_PAGE_2 = {
    "models": [
        {"name": "models/gemini-3.5-flash", "displayName": "Gemini 3.5 Flash",
         "supportedGenerationMethods": ["generateContent"]},
    ],
}

XAI_LIST = {
    "data": [
        {"id": "grok-4.3", "created": 200},
        {"id": "grok-4.7", "created": 300},
        {"id": "grok-2-image-1212", "created": 100},
        {"id": "grok-2-vision-1212", "created": 100},
        {"id": "grok-imagine-video", "created": 100},
        {"id": "other-model", "created": 100},
    ]
}


# ---- Pure parsers ---------------------------------------------------------


def test_parse_anthropic_keeps_claude_newest_first_and_dated_ids():
    out = provider_models.parse_anthropic(ANTHROPIC_PAGE)
    assert [m["id"] for m in out] == ["claude-opus-5-5", "claude-haiku-4-5-20251001"]
    assert out[0]["label"] == "Claude Opus 5.5"


def test_parse_openai_keeps_chat_models_only():
    out = provider_models.parse_openai(OPENAI_LIST)
    assert [m["id"] for m in out] == ["gpt-6.1-sol", "o4-mini", "gpt-4o-mini"]


def test_parse_openrouter_filters_and_captures_highest_price_tier():
    choices, rates = provider_models.parse_openrouter(OPENROUTER_LIST)
    ids = [m["id"] for m in choices]
    assert ids == ["anthropic/claude-haiku-5.5", "acme/no-arch", "acme/free:free"]
    # Tiered price: the higher (above-100K) tier is the ceiling we keep.
    assert rates["anthropic/claude-haiku-5.5"] == pytest.approx({"input": 0.5, "output": 2.5})
    assert rates["acme/no-arch"] == pytest.approx({"input": 2.0, "output": 4.0})
    assert choices[0]["label"] == "Anthropic: Claude Haiku 5.5"
    assert "1000K context" in choices[0]["note"]


def test_parse_gemini_filters_and_strips_prefix():
    out = provider_models.parse_gemini(GEMINI_PAGE_1)
    assert [m["id"] for m in out] == ["gemini-2.5-flash"]


def test_parse_xai_keeps_text_grok_newest_first():
    out = provider_models.parse_xai(XAI_LIST)
    assert [m["id"] for m in out] == ["grok-4.7", "grok-4.3"]


@pytest.mark.parametrize("parser", [
    provider_models.parse_anthropic, provider_models.parse_openai,
    provider_models.parse_gemini, provider_models.parse_xai,
])
def test_parsers_reject_wrong_shape(parser):
    with pytest.raises(provider_models.ProviderModelsUnavailable):
        parser({"unexpected": True})
    with pytest.raises(provider_models.ProviderModelsUnavailable):
        parser(["not", "an", "object"])


# ---- Network layer (mocked) -----------------------------------------------


@pytest.mark.asyncio
async def test_anthropic_paginates_and_sends_the_right_headers(monkeypatch):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if "after_id" not in req.url.params:
            return httpx.Response(200, json={
                "data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                          "created_at": "2026-10-20T00:00:00Z"}],
                "has_more": True, "last_id": "claude-opus-5-5"})
        return httpx.Response(200, json={
            "data": [{"id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5",
                      "created_at": "2025-10-01T00:00:00Z"}],
            "has_more": False, "last_id": "claude-haiku-4-5"})

    _mock_async_client(monkeypatch, handler)
    out = await provider_models.list_provider_models("anthropic", FAKE_KEY)
    assert [m["id"] for m in out] == ["claude-opus-5-5", "claude-haiku-4-5"]
    assert len(seen) == 2
    assert seen[0].headers["x-api-key"] == FAKE_KEY
    assert seen[0].headers["anthropic-version"] == "2023-06-01"
    assert seen[1].url.params["after_id"] == "claude-opus-5-5"


@pytest.mark.asyncio
async def test_gemini_follows_page_token_and_keeps_key_out_of_the_url(monkeypatch):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.params.get("pageToken") == "page-2":
            return httpx.Response(200, json=GEMINI_PAGE_2)
        return httpx.Response(200, json=GEMINI_PAGE_1)

    _mock_async_client(monkeypatch, handler)
    out = await provider_models.list_provider_models("gemini", FAKE_KEY)
    assert [m["id"] for m in out] == ["gemini-2.5-flash", "gemini-3.5-flash"]
    for req in seen:
        assert FAKE_KEY not in str(req.url)
        assert req.headers["x-goog-api-key"] == FAKE_KEY


@pytest.mark.asyncio
async def test_openrouter_discovery_registers_runtime_prices(monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(200, json=OPENROUTER_LIST))
    await provider_models.list_provider_models("openrouter", FAKE_KEY)
    assert rates_for("acme/no-arch") == pytest.approx({"input": 2.0, "output": 4.0})
    # A free OpenRouter model really is free: its catalog price wins.
    assert rates_for("acme/free:free") == {"input": 0.0, "output": 0.0}


@pytest.mark.asyncio
async def test_error_messages_never_carry_the_response_body(monkeypatch):
    # OpenAI's real 401 body includes a masked fragment of the key.
    body = '{"error": {"message": "Incorrect API key provided: sk-fake***000"}}'
    _mock_async_client(monkeypatch, lambda r: httpx.Response(401, text=body))
    with pytest.raises(provider_models.ProviderModelsUnavailable) as exc:
        await provider_models.list_provider_models("openai", FAKE_KEY)
    msg = str(exc.value)
    assert msg == "key rejected (HTTP 401)"
    assert "sk-" not in msg


@pytest.mark.asyncio
async def test_transport_error_reports_type_only(monkeypatch):
    def handler(req):
        raise httpx.ConnectError(f"failed to reach {req.url}")

    _mock_async_client(monkeypatch, handler)
    with pytest.raises(provider_models.ProviderModelsUnavailable) as exc:
        await provider_models.list_provider_models("gemini", FAKE_KEY)
    assert str(exc.value) == "request failed: ConnectError"


@pytest.mark.asyncio
async def test_empty_after_filtering_is_unavailable(monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(200, json={"data": [{"id": "whisper-1"}]}))
    with pytest.raises(provider_models.ProviderModelsUnavailable):
        await provider_models.list_provider_models("openai", FAKE_KEY)


@pytest.mark.asyncio
async def test_cache_is_keyed_by_key_hash_and_refresh_bypasses_it(monkeypatch):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json=XAI_LIST)

    _mock_async_client(monkeypatch, handler)
    await provider_models.list_provider_models("xai", FAKE_KEY)
    await provider_models.list_provider_models("xai", FAKE_KEY)
    assert calls["n"] == 1
    await provider_models.list_provider_models("xai", FAKE_KEY, force_refresh=True)
    assert calls["n"] == 2
    # A different key is a different cache entry.
    await provider_models.list_provider_models("xai", FAKE_KEY + "-other")
    assert calls["n"] == 3
    # The raw key is never a cache key.
    for provider, digest in provider_models._cache:
        assert FAKE_KEY not in digest
        assert re.fullmatch(r"[0-9a-f]{64}", digest)


@pytest.mark.asyncio
async def test_static_providers_make_no_network_call(monkeypatch):
    def handler(req):  # pragma: no cover - must not be reached
        raise AssertionError("minimax/local must not hit the network")

    _mock_async_client(monkeypatch, handler)
    out = await provider_models.list_provider_models("minimax", FAKE_KEY)
    assert [m["id"] for m in out] == [m["id"] for m in provider_models.STATIC_MODELS["minimax"]]


# ---- POST /llm/models, API-key branch -------------------------------------


@pytest.fixture
def client(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def _cfg(provider: str) -> dict:
    return {"provider": provider, "auth": {"type": "api_key", "api_key": FAKE_KEY}}


def test_endpoint_api_key_live(client, monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(200, json=ANTHROPIC_PAGE))
    body = client.post("/llm/models", json={"provider_config": _cfg("anthropic")}).json()
    assert body["ok"] is True and body["source"] == "live"
    # The default is the engine's provider default, NOT the newest model.
    assert body["default"] == llm_providers._DEFAULT_MODELS["anthropic"]
    assert [m["id"] for m in body["models"]] == ["claude-opus-5-5", "claude-haiku-4-5-20251001"]
    assert "error" not in body


def test_endpoint_api_key_fallback(client, monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(503, text="down"))
    body = client.post("/llm/models", json={"provider_config": _cfg("xai")}).json()
    assert body["ok"] is True and body["source"] == "fallback"
    assert body["default"] == "grok-4.3"
    assert body["models"] == provider_models.STATIC_MODELS["xai"]
    assert body["error"] == "provider error (HTTP 503)"


# ---- Renderer mirror -------------------------------------------------------

_ENGINE_CLIENT_TS = (
    Path(__file__).resolve().parents[2] / "desktop" / "src" / "lib" / "engine-client.ts"
)


def _renderer_ids_by_provider() -> dict[str, list[str]]:
    src = _ENGINE_CLIENT_TS.read_text(encoding="utf-8")
    start = src.index("export const PROVIDER_MODELS")
    tail = src[start:]
    block = tail[: tail.index("\nexport const", len("export const PROVIDER_MODELS"))]
    out: dict[str, list[str]] = {}
    current = None
    for line in block.splitlines():
        m = re.match(r"\s{2}(\w+):\s*\[", line)
        if m:
            current = m.group(1)
            out[current] = []
        for mid in re.findall(r"id:\s*'([^']+)'", line):
            assert current is not None
            out[current].append(mid)
    return out


def test_engine_static_lists_mirror_the_renderer():
    """The engine serves STATIC_MODELS as the fallback; the renderer shows
    PROVIDER_MODELS before the engine answers. They must be the same list."""
    if not _ENGINE_CLIENT_TS.exists():
        pytest.skip("renderer source not present")
    renderer = _renderer_ids_by_provider()
    engine = {p: [m["id"] for m in ms] for p, ms in provider_models.STATIC_MODELS.items()}
    assert renderer == engine


# ---- Price resolution (the CostGuard safety property) ---------------------


def test_dated_anthropic_id_resolves_to_alias_row():
    assert rates_for("claude-haiku-4-5-20251001") == llm_providers._COST_PER_M_TOKENS["claude-haiku-4-5"]
    assert rates_for("claude-sonnet-4-6-latest") == llm_providers._COST_PER_M_TOKENS["claude-sonnet-4-6"]


@pytest.mark.parametrize("model,expected", [
    ("claude-mythos-1", (15.0, 75.0)),
    ("claude-opus-9", (15.0, 75.0)),
    ("claude-fable-6", (15.0, 75.0)),
    ("claude-sonnet-9", (5.0, 25.0)),
    ("claude-haiku-9", (5.0, 25.0)),
    ("gpt-7-nova", (15.0, 60.0)),
    ("o5-mini", (15.0, 60.0)),
    ("gemini-9-pro", (5.0, 20.0)),
    ("grok-9", (5.0, 15.0)),
    ("anthropic/claude-opus-9.1", (15.0, 75.0)),
    ("openai/gpt-7", (15.0, 60.0)),
    ("google/gemini-9", (5.0, 20.0)),
    ("x-ai/grok-9", (5.0, 15.0)),
    ("mystery-vendor/model", (15.0, 75.0)),
])
def test_unknown_models_get_family_ceilings(model, expected):
    r = rates_for(model)
    assert (r["input"], r["output"]) == expected


def test_openrouter_ids_reuse_first_party_rows_before_ceilings():
    """After an engine restart the runtime map is empty. The default
    openai/gpt-4o-mini must not be priced at the 15/60 ceiling (100x)."""
    assert rates_for("openai/gpt-4o-mini") == llm_providers._COST_PER_M_TOKENS["gpt-4o-mini"]
    # OpenRouter writes Claude versions with dots.
    assert rates_for("anthropic/claude-sonnet-4.6") == llm_providers._COST_PER_M_TOKENS["claude-sonnet-4-6"]
    assert rates_for("anthropic/claude-haiku-5.5") == llm_providers._COST_PER_M_TOKENS["claude-haiku-5-5"]


def test_runtime_price_beats_first_party_mapping():
    llm_providers.register_runtime_rates("openai/gpt-4o-mini", input_per_m=0.2, output_per_m=0.8)
    assert rates_for("openai/gpt-4o-mini") == {"input": 0.2, "output": 0.8}


def test_unknown_api_key_model_reserves_non_zero():
    for model in ("claude-brand-new-model", "gpt-7", "totally-unknown", "vendor/unknown"):
        est = worst_case_reservation(model=model, auth_kind="api_key", max_tokens=400)
        assert est > 0.0, model


def test_oauth_and_local_still_reserve_zero():
    for model in ("claude-brand-new-model", "gpt-7", "llama3.2:latest", "vendor/unknown"):
        assert worst_case_reservation(model=model, auth_kind="oauth", max_tokens=400) == 0.0
        assert worst_case_reservation(model=model, auth_kind="local", max_tokens=400) == 0.0


def test_estimate_cost_local_zero_cloud_ceiling():
    assert estimate_cost("llama3.2:latest", 10_000, 1_000, provider="local") == 0.0
    # Unknown name, cloud provider: ceiling, not $0.
    assert estimate_cost("MiniMax-M9", 1_000_000, 0, provider="minimax") == pytest.approx(15.0)
    # Unknown name, no provider: historical $0 (callers that cannot say).
    assert estimate_cost("llama3.2:latest", 10_000, 1_000) == 0.0


def test_costguard_worst_case_numbers_for_a_15_75_model():
    """Documents the numbers reported to the founder. 12 agents x 400 tokens
    (the renderer's default max_tokens): 33,600 in + 4,800 out tokens."""
    assert worst_case_reservation(model="claude-mythos-1", auth_kind="api_key", max_tokens=400) == pytest.approx(0.864)
    # At the engine's 800-token hard cap: 60,000 in + 9,600 out.
    assert worst_case_reservation(model="claude-mythos-1", auth_kind="api_key", max_tokens=800) == pytest.approx(1.62)
