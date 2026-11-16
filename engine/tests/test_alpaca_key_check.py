"""Alpaca key check: the Settings probe and the run-time "keys rejected" notice.

Settings used to show "Connected" whenever an Alpaca key was stored, even a
dead one. These tests pin the fix:

- `probe_alpaca_keys` makes one read-only request to data.alpaca.markets and
  maps the answer to connected / rejected / unreachable / missing.
- POST /data/alpaca/test exposes it behind the bearer token.
- A 401/403 on the bars request raises AlpacaAuthError (still a
  DataUnavailable), while "no bars" stays a plain DataUnavailable.
- A run whose saved Alpaca keys are rejected gets one `data.warning` event
  instead of a silently empty data card.

Network-mocked via httpx's MockTransport. No real network calls.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from engine.data_providers import (
    AlpacaAuthError,
    AlpacaProvider,
    DataUnavailable,
    probe_alpaca_keys,
)
from engine.server import ALPACA_REJECTED_MESSAGE, build_app

TOKEN = "test-token-1234"
KEY_ID = "PKSECRETKEYIDVALUE01"
SECRET = "secret-value-never-echoed"


class _MockAlpaca:
    """Patch httpx.AsyncClient so every request goes to `handler`."""

    def __init__(self, handler):
        self.handler = handler
        self.requests: list[httpx.Request] = []
        self._real = httpx.AsyncClient

    def __enter__(self):
        transport = httpx.MockTransport(self._record)
        real = self._real

        def patched(*args, **kwargs):
            kwargs["transport"] = transport
            return real(*args, **kwargs)

        httpx.AsyncClient = patched  # type: ignore[assignment]
        return self

    def __exit__(self, *exc):
        httpx.AsyncClient = self._real  # type: ignore[assignment]

    def _record(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


# ---- probe_alpaca_keys -----------------------------------------------------


@pytest.mark.asyncio
async def test_probe_connected_on_200_and_uses_read_only_news_request():
    with _MockAlpaca(lambda r: httpx.Response(200, json={"news": []})) as m:
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    assert out["ok"] is True
    assert out["status"] == "connected"
    assert len(m.requests) == 1
    req = m.requests[0]
    assert req.method == "GET"
    assert req.url.host == "data.alpaca.markets"
    assert req.url.path == "/v1beta1/news"
    assert req.url.params["limit"] == "1"
    assert req.headers["APCA-API-KEY-ID"] == KEY_ID
    assert req.headers["APCA-API-SECRET-KEY"] == SECRET


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [401, 403])
async def test_probe_rejected_on_auth_failure(code):
    with _MockAlpaca(lambda r: httpx.Response(code, text="Authorization Required")):
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    assert out["ok"] is False
    assert out["status"] == "rejected"
    assert str(code) in out["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [429, 500, 502, 404])
async def test_probe_unreachable_when_the_keys_could_not_be_checked(code):
    with _MockAlpaca(lambda r: httpx.Response(code, text="nope")):
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    assert out["ok"] is False
    assert out["status"] == "unreachable"


@pytest.mark.asyncio
async def test_probe_unreachable_on_network_error():
    def boom(request):
        raise httpx.ConnectError("no route", request=request)

    with _MockAlpaca(boom):
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    assert out["ok"] is False
    assert out["status"] == "unreachable"


@pytest.mark.asyncio
@pytest.mark.parametrize("key_id,secret", [("", SECRET), (KEY_ID, ""), ("  ", "  ")])
async def test_probe_missing_makes_no_request(key_id, secret):
    with _MockAlpaca(lambda r: httpx.Response(200, json={})) as m:
        out = await probe_alpaca_keys(key_id, secret)
    assert out["status"] == "missing"
    assert m.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [200, 401, 429])
async def test_probe_result_never_contains_key_values(code):
    with _MockAlpaca(lambda r: httpx.Response(code, json={})):
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    text = repr(out)
    assert KEY_ID not in text
    assert SECRET not in text


# ---- AlpacaAuthError on the bars request -----------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("ticker", ["NVDA", "BTC"])
async def test_bars_auth_failure_raises_alpaca_auth_error(ticker):
    with _MockAlpaca(lambda r: httpx.Response(401, text="Authorization Required")):
        with pytest.raises(AlpacaAuthError) as info:
            await AlpacaProvider(KEY_ID, SECRET).quote_summary(
                ticker=ticker, trade_date="2026-11-13"
            )
    # Still a DataUnavailable, so every existing handler keeps catching it.
    assert isinstance(info.value, DataUnavailable)


SIP_403 = '{"message":"subscription does not permit querying recent SIP data"}'


@pytest.mark.asyncio
async def test_free_tier_sip_403_is_not_an_auth_error():
    """A valid free key asking for too-recent SIP bars (e.g. a fast clock)
    gets 403 'subscription does not permit...'. That is not a bad key."""
    with _MockAlpaca(lambda r: httpx.Response(403, text=SIP_403)):
        with pytest.raises(DataUnavailable) as info:
            await AlpacaProvider(KEY_ID, SECRET).quote_summary(
                ticker="NVDA", trade_date="2026-11-13"
            )
    assert not isinstance(info.value, AlpacaAuthError)


@pytest.mark.asyncio
async def test_probe_subscription_403_is_not_rejected():
    with _MockAlpaca(lambda r: httpx.Response(403, text=SIP_403)):
        out = await probe_alpaca_keys(KEY_ID, SECRET)
    assert out["status"] == "unreachable"


@pytest.mark.asyncio
async def test_probe_refuses_over_long_values_without_a_request():
    long_value = "K" * 300
    with _MockAlpaca(lambda r: httpx.Response(200, json={})) as m:
        out = await probe_alpaca_keys(long_value, SECRET)
    assert out["status"] == "rejected"
    assert m.requests == []
    assert long_value not in repr(out)


def test_endpoint_never_echoes_an_over_long_value(client):
    long_value = "S" * 5000
    r = client.post("/data/alpaca/test", json={"key_id": KEY_ID, "secret": long_value})
    assert r.status_code == 200
    assert long_value not in r.text
    assert r.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_no_bars_is_not_an_auth_error():
    with _MockAlpaca(lambda r: httpx.Response(200, json={"bars": []})):
        with pytest.raises(DataUnavailable) as info:
            await AlpacaProvider(KEY_ID, SECRET).quote_summary(
                ticker="NVDA", trade_date="2026-11-13"
            )
    assert not isinstance(info.value, AlpacaAuthError)


# ---- POST /data/alpaca/test ------------------------------------------------


@pytest.fixture
def client(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def test_endpoint_returns_probe_status(client):
    with _MockAlpaca(lambda r: httpx.Response(401, text="no")):
        r = client.post("/data/alpaca/test", json={"key_id": KEY_ID, "secret": SECRET})
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"


def test_endpoint_requires_bearer_token(tmp_db):
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        r = c.post("/data/alpaca/test", json={"key_id": KEY_ID, "secret": SECRET})
    assert r.status_code in (401, 403)


# ---- run-time notice --------------------------------------------------------


def _run_stub(client, start_frame):
    events = []
    with client.websocket_connect(f"/stream?token={TOKEN}") as ws:
        ws.send_json(start_frame)
        try:
            while True:
                event = ws.receive_json()
                events.append(event)
                if event.get("type") == "session.complete":
                    break
        except Exception:  # noqa: BLE001 — socket closed
            pass
    return events


def test_rejected_keys_emit_one_data_warning(client):
    with _MockAlpaca(lambda r: httpx.Response(401, text="Authorization Required")):
        events = _run_stub(
            client,
            {
                "ticker": "NVDA",
                "trade_date": "2026-11-13",
                "data_config": {"provider": "alpaca", "key_id": KEY_ID, "secret": SECRET},
            },
        )
    warnings = [e for e in events if e.get("type") == "data.warning"]
    assert len(warnings) == 1
    w = warnings[0]
    assert w["source"] == "alpaca"
    assert w["reason"] == "rejected"
    assert w["message"] == ALPACA_REJECTED_MESSAGE
    assert not any(e.get("type") == "data.summary" for e in events)
    # The analysis still ran to the end: the warning is not terminal.
    assert events and events[-1].get("type") == "session.complete"


def test_no_warning_when_alpaca_just_has_no_data(client):
    with _MockAlpaca(lambda r: httpx.Response(200, json={"bars": [], "news": []})):
        events = _run_stub(
            client,
            {
                "ticker": "NVDA",
                "trade_date": "2026-11-13",
                "data_config": {"provider": "alpaca", "key_id": KEY_ID, "secret": SECRET},
            },
        )
    assert not any(e.get("type") == "data.warning" for e in events)


def test_warning_message_has_no_dashes():
    assert "–" not in ALPACA_REJECTED_MESSAGE
    assert "—" not in ALPACA_REJECTED_MESSAGE
