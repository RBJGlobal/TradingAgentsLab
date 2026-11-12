"""POST /llm/test — credential validation endpoint.

Mocks `adapter_for` so the test never touches a real provider. Verifies:
- Invalid provider_config returns ok=false with a helpful error.
- OAuth auth shape is rejected at this endpoint.
- Successful adapter.complete returns ok=true with elapsed ms + model.
- Adapter exceptions surface as ok=false + the exception class+message.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from engine.server import build_app


TOKEN = "test-token-1234"


@pytest.fixture
def client(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def test_invalid_provider_config_rejected(client):
    r = client.post("/llm/test", json={"provider_config": {}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "invalid" in body["error"].lower()


def test_unknown_provider_rejected(client):
    r = client.post(
        "/llm/test",
        json={
            "provider_config": {
                "provider": "not-a-real-provider",
                "auth": {"type": "api_key", "api_key": "sk-fake"},
            }
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False


def test_oauth_auth_rejected(client):
    r = client.post(
        "/llm/test",
        json={
            "provider_config": {
                "provider": "openai",
                "auth": {
                    "type": "oauth",
                    "access": "fake",
                    "refresh": "fake",
                    "expires": 0,
                },
            }
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "oauth" in body["error"].lower()


def test_success_returns_ok_ms_and_model(client):
    mock_adapter = MagicMock()
    mock_adapter.open = AsyncMock()
    mock_adapter.close = AsyncMock()
    mock_adapter.complete = AsyncMock(return_value=("pong", 5, 1))

    with patch("engine.server.adapter_for", return_value=mock_adapter):
        r = client.post(
            "/llm/test",
            json={
                "provider_config": {
                    "provider": "openai",
                    "auth": {"type": "api_key", "api_key": "sk-fake"},
                    "model": "gpt-4o-mini",
                    "max_tokens": 1,
                }
            },
        )

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["model"] == "gpt-4o-mini"
    assert isinstance(body["ms"], int)
    mock_adapter.open.assert_awaited_once()
    mock_adapter.close.assert_awaited_once()
    mock_adapter.complete.assert_awaited_once()
    call_kwargs = mock_adapter.complete.call_args.kwargs
    assert call_kwargs["max_tokens"] == 1


def test_adapter_exception_returns_error(client):
    mock_adapter = MagicMock()
    mock_adapter.open = AsyncMock()
    mock_adapter.close = AsyncMock()
    mock_adapter.complete = AsyncMock(
        side_effect=RuntimeError("invalid_api_key: 401"),
    )

    with patch("engine.server.adapter_for", return_value=mock_adapter):
        r = client.post(
            "/llm/test",
            json={
                "provider_config": {
                    "provider": "openai",
                    "auth": {"type": "api_key", "api_key": "sk-bogus"},
                }
            },
        )

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "RuntimeError" in body["error"]
    assert "401" in body["error"]
    # Cleanup must still run.
    mock_adapter.close.assert_awaited_once()


def test_requires_bearer_token():
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        r = c.post("/llm/test", json={"provider_config": {}})
        assert r.status_code == 401


def test_reasoning_budget_exhausted_counts_as_a_pass(client):
    """A reasoning model that only thought (no text) still proves the key and
    the model work: the provider accepted and billed the request."""
    from engine.llm_providers import ReasoningBudgetExhausted

    mock_adapter = MagicMock()
    mock_adapter.open = AsyncMock()
    mock_adapter.close = AsyncMock()
    mock_adapter.complete = AsyncMock(side_effect=ReasoningBudgetExhausted(5, 1201))
    with patch("engine.server.adapter_for", return_value=mock_adapter):
        r = client.post("/llm/test", json={"provider_config": {
            "provider": "anthropic", "auth": {"type": "api_key", "api_key": "sk-fake"},
            "model": "claude-sonnet-5-5", "max_tokens": 1,
        }})
    body = r.json()
    assert body["ok"] is True and body["model"] == "claude-sonnet-5-5"
    mock_adapter.close.assert_awaited_once()
