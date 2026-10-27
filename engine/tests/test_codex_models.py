"""OpenAI OAuth (Codex) live model discovery: engine/codex_models.py + the
POST /llm/models endpoint.

No real network: httpx.AsyncClient is swapped for an httpx.MockTransport, the
same pattern test_alpaca_provider.py uses. The catalog payloads below follow
the real /models shape from openai/codex (codex-rs protocol ModelInfo).
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from engine import codex_models
from engine.server import build_app

TOKEN = "test-token-1234"

CATALOG = {
    "models": [
        # Deliberately out of priority order to prove we sort.
        {"slug": "gpt-6-luna", "display_name": "GPT-6 Luna", "description": "fast",
         "visibility": "list", "priority": 30, "supported_in_api": True},
        {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "description": "default",
         "visibility": "list", "priority": 10, "supported_in_api": True},
        {"slug": "gpt-reserve", "display_name": "reserve", "visibility": "hide",
         "priority": 1, "supported_in_api": False},
        {"slug": "codex-auto-review", "display_name": "auto", "visibility": "none",
         "priority": 2, "supported_in_api": False},
        {"slug": "gpt-6-astra", "display_name": "GPT-6 Astra", "description": "big",
         "visibility": "list", "priority": 20, "supported_in_api": True},
    ]
}


@pytest.fixture(autouse=True)
def _clear_cache():
    codex_models._reset_cache_for_tests()
    yield
    codex_models._reset_cache_for_tests()


def _mock_async_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)


# ---- pure selection rules -------------------------------------------------


def test_parse_keeps_only_list_visibility_sorted_by_priority():
    models = codex_models.parse_catalog(CATALOG)
    assert [m.slug for m in models] == ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]


def test_parse_rejects_empty_or_malformed():
    with pytest.raises(codex_models.CodexModelsUnavailable):
        codex_models.parse_catalog({"models": []})
    with pytest.raises(codex_models.CodexModelsUnavailable):
        codex_models.parse_catalog({"models": [{"slug": "x", "visibility": "hide"}]})
    with pytest.raises(codex_models.CodexModelsUnavailable):
        codex_models.parse_catalog(["not", "a", "dict"])


def test_pick_keeps_available_model():
    models = codex_models.parse_catalog(CATALOG)
    assert codex_models.pick_model("gpt-6-luna", models) == ("gpt-6-luna", False)


def test_pick_substitutes_retired_model_with_catalog_default():
    models = codex_models.parse_catalog(CATALOG)
    # The exact failure the founder hit: a saved gpt-5.x choice.
    assert codex_models.pick_model("gpt-5.4", models) == ("gpt-6.1-sol", True)
    # A hidden model is not selectable either.
    assert codex_models.pick_model("gpt-reserve", models) == ("gpt-6.1-sol", True)


def test_pick_on_empty_list_never_raises():
    assert codex_models.pick_model("gpt-6-luna", []) == ("gpt-6-luna", False)
    assert codex_models.pick_model(None, []) == (codex_models.FALLBACK_DEFAULT, False)


# ---- network behavior -----------------------------------------------------


@pytest.mark.asyncio
async def test_list_sends_codex_headers_and_client_version(monkeypatch):
    captured: list[httpx.Request] = []

    def handler(request):
        captured.append(request)
        return httpx.Response(200, json=CATALOG)

    _mock_async_client(monkeypatch, handler)
    models = await codex_models.list_codex_models("tok", "acct-1")

    assert [m.slug for m in models][0] == "gpt-6.1-sol"
    req = captured[0]
    assert str(req.url).startswith("https://chatgpt.com/backend-api/codex/models")
    assert req.url.params["client_version"] == codex_models.CLIENT_VERSION_SENTINEL
    assert req.headers["Authorization"] == "Bearer tok"
    assert req.headers["chatgpt-account-id"] == "acct-1"
    assert req.headers["OpenAI-Beta"] == "responses=experimental"


@pytest.mark.asyncio
async def test_retries_known_good_version_when_sentinel_rejected(monkeypatch):
    versions: list[str] = []

    def handler(request):
        v = request.url.params["client_version"]
        versions.append(v)
        if v == codex_models.CLIENT_VERSION_SENTINEL:
            return httpx.Response(400, text="bad client_version")
        return httpx.Response(200, json=CATALOG)

    _mock_async_client(monkeypatch, handler)
    models = await codex_models.list_codex_models("tok", "acct-1")
    assert versions == [codex_models.CLIENT_VERSION_SENTINEL, codex_models.CLIENT_VERSION_KNOWN_GOOD]
    assert models[0].slug == "gpt-6.1-sol"


@pytest.mark.asyncio
async def test_caches_per_account_and_refresh_bypasses(monkeypatch):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, json=CATALOG)

    _mock_async_client(monkeypatch, handler)
    await codex_models.list_codex_models("tok", "acct-1")
    await codex_models.list_codex_models("tok", "acct-1")
    assert calls["n"] == 1
    await codex_models.list_codex_models("tok", "acct-1", force_refresh=True)
    assert calls["n"] == 2
    await codex_models.list_codex_models("tok", "acct-2")  # different account
    assert calls["n"] == 3


@pytest.mark.asyncio
async def test_non_200_raises(monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(401, text="nope"))
    with pytest.raises(codex_models.CodexModelsUnavailable):
        await codex_models.list_codex_models("tok", "acct-1")


@pytest.mark.asyncio
async def test_resolve_substitutes_retired_model(monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    model, note = await codex_models.resolve_model("gpt-5.4", "tok", "acct-1")
    assert model == "gpt-6.1-sol"
    assert note and "gpt-5.4" in note


@pytest.mark.asyncio
async def test_resolve_keeps_requested_when_discovery_down(monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(503, text="down"))
    model, note = await codex_models.resolve_model("gpt-6-luna", "tok", "acct-1")
    assert (model, note) == ("gpt-6-luna", None)


# ---- POST /llm/models -----------------------------------------------------


@pytest.fixture
def client(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


OAUTH_CFG = {
    "provider": "openai",
    "auth": {"type": "oauth", "access": "tok", "refresh": "r", "expires": 9999999999999,
             "account_id": "acct-1"},
    "model": "gpt-5.4",
}


def test_endpoint_returns_live_catalog(client, monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    body = client.post("/llm/models", json={"provider_config": OAUTH_CFG}).json()
    assert body["ok"] is True and body["source"] == "live"
    assert body["default"] == "gpt-6.1-sol"
    assert [m["id"] for m in body["models"]] == ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]


def test_endpoint_falls_back_when_catalog_unreachable(client, monkeypatch):
    _mock_async_client(monkeypatch, lambda r: httpx.Response(500, text="boom"))
    body = client.post("/llm/models", json={"provider_config": OAUTH_CFG}).json()
    assert body["ok"] is True and body["source"] == "fallback"
    assert body["default"] == codex_models.FALLBACK_DEFAULT
    assert body["models"] == codex_models.FALLBACK_MODELS


def test_endpoint_rejects_non_oauth(client):
    cfg = {"provider": "openai", "auth": {"type": "api_key", "api_key": "sk-x"}}
    body = client.post("/llm/models", json={"provider_config": cfg}).json()
    assert body["ok"] is False
