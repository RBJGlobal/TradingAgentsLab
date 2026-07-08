"""FastAPI application factory + route definitions.

Phase 2 endpoints:
- GET  /health         — sanity ping
- POST /analyze        — one-shot analysis (stub)
- WS   /stream         — streaming agent debate (canned sequence)

Auth: all endpoints require `Authorization: Bearer <token>` header (or
`?token=...` query param on WebSocket since browsers can't set headers there).
"""

from __future__ import annotations

import asyncio
import sys
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .data_providers import (
    BaseDataProvider,
    DataUnavailable,
    Headline,
    QuoteSummary,
    default_provider,
    provider_from_data_config,
)
from .live_debate import ProviderConfig, SentimentBlock, live_debate
from .llm_providers import adapter_for
from . import cost_guard, local_llm_detect, sentiment_sources, storage
from . import webhooks as webhook_dispatcher
from .stub_debate import canned_debate
from .telegram_bot import TelegramBot, TelegramBotConfig
from .ticker import normalize_ticker


def build_app(*, token: str) -> FastAPI:
    started_at = time.monotonic()

    # Phase 8c: the Telegram bot is owned by the app instance so the
    # lifespan hook can cleanly stop it on shutdown. Multiple in-process
    # apps (tests) get their own bot; renderer manages a single instance
    # in production via /telegram/start and /telegram/stop.
    telegram_bot = TelegramBot()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Engine starts with the bot stopped. Renderer must explicitly
        # call /telegram/start after the user enables it in Settings.
        # This keeps the engine bootable without any Telegram config and
        # lets the renderer carry the source-of-truth for enable state.
        try:
            yield
        finally:
            await telegram_bot.stop()

    app = FastAPI(
        title="TradingAgentsLab Engine",
        version=__version__,
        docs_url=None,        # Disable Swagger — sidecar is private
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.telegram_bot = telegram_bot

    # Renderer runs on http://localhost:5173 in dev (Vite) and on `file://`
    # (Origin: "null") in production-mode Electron — the built bundle loads
    # `dist/index.html` directly via Electron's file protocol. The sidecar
    # binds to 127.0.0.1 only and gates every request behind the bearer
    # token; CORS is not a security boundary here, it's just the browser's
    # preflight contract for non-simple requests. Use a wildcard so both
    # dev and prod work — and Playwright's e2e tests (also `file://`-loaded)
    # surfaced the prior production-mode breakage. WebSocket /stream is
    # unaffected by CORS but allow_methods covers OPTIONS preflight.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def require_bearer(authorization: Annotated[str | None, Header()] = None) -> None:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="missing bearer token",
            )
        if authorization.removeprefix("Bearer ") != token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid token",
            )

    bearer = [Depends(require_bearer)]

    @app.get("/health", dependencies=bearer)
    async def health() -> dict[str, Any]:
        from .llm_providers import _ALLOWED_PROVIDERS, _DEFAULT_MODELS

        return {
            "ok": True,
            "version": __version__,
            "uptime_seconds": round(time.monotonic() - started_at, 2),
            # "engine_state" describes the *capability* of the engine. The
            # WS path uses the canned stub when no provider_config arrives in
            # the start frame, and the live path otherwise — so the engine
            # itself reports "ready" rather than "stub" or "live".
            "engine_state": "ready",
            "data_provider": default_provider.name,
            "live_supported": True,
            # Per-provider default models the engine assumes when ProviderConfig
            # arrives without an explicit `model` field. Renderer should also
            # ship its own defaults (PROVIDER_DEFAULT_MODEL); these are the
            # source of truth.
            "live_providers": sorted(_ALLOWED_PROVIDERS),
            "live_default_models": dict(_DEFAULT_MODELS),
            "storage_path": storage.db_path(),
        }

    @app.get("/data/summary", dependencies=bearer)
    async def data_summary(ticker: str, trade_date: str) -> dict[str, Any]:
        try:
            summary = await default_provider.quote_summary(
                ticker=ticker, trade_date=trade_date
            )
        except DataUnavailable as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            )
        except Exception as exc:  # noqa: BLE001 — convert any provider error into 502
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"data provider error: {exc}",
            )
        return _summary_to_dict(summary)

    @app.get("/data/news", dependencies=bearer)
    async def data_news(ticker: str, limit: int = 5) -> dict[str, Any]:
        try:
            headlines = await default_provider.news_headlines(
                ticker=ticker, limit=max(1, min(limit, 20))
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"news provider error: {exc}",
            )
        return {
            "ticker": ticker.upper(),
            "source": default_provider.name,
            "headlines": [_headline_to_dict(h) for h in headlines],
        }

    @app.get("/sessions", dependencies=bearer)
    async def list_sessions_endpoint(
        limit: int = 50, ticker: str | None = None
    ) -> dict[str, Any]:
        rows = storage.list_sessions(limit=limit, ticker=ticker)
        return {"sessions": [storage.summary_to_dict(r) for r in rows]}

    @app.get("/sessions/{session_id}", dependencies=bearer)
    async def get_session_endpoint(session_id: str) -> dict[str, Any]:
        detail = storage.get_session(session_id)
        if detail is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"session {session_id!r} not found",
            )
        return storage.detail_to_dict(detail)

    @app.delete("/sessions/{session_id}", dependencies=bearer)
    async def delete_session_endpoint(session_id: str) -> dict[str, Any]:
        deleted = storage.delete_session(session_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"session {session_id!r} not found",
            )
        return {"deleted": True, "id": session_id}

    @app.get("/watchlist", dependencies=bearer)
    async def list_watchlist_endpoint() -> dict[str, Any]:
        rows = storage.list_watchlist()
        return {"watchlist": [storage.watchlist_to_dict(r) for r in rows]}

    @app.post("/watchlist", dependencies=bearer)
    async def add_watchlist_endpoint(req: WatchlistAddRequest) -> dict[str, Any]:
        try:
            entry = storage.add_watchlist(ticker=req.ticker, note=req.note)
        except storage.WatchlistConflict as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            )
        return storage.watchlist_to_dict(entry)

    @app.delete("/watchlist/{ticker}", dependencies=bearer)
    async def remove_watchlist_endpoint(ticker: str) -> dict[str, Any]:
        removed = storage.remove_watchlist(ticker)
        if not removed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"{ticker.upper()!r} not on the watchlist",
            )
        return {"removed": True, "ticker": ticker.upper()}

    @app.get("/cost-guard/state", dependencies=bearer)
    async def cost_guard_state() -> dict[str, Any]:
        spend, config = cost_guard.get_state()
        return {
            "spend": cost_guard.spend_to_dict(spend),
            "config": cost_guard.config_to_dict(config),
        }

    @app.put("/cost-guard/config", dependencies=bearer)
    async def cost_guard_update(req: CostGuardConfigRequest) -> dict[str, Any]:
        new_config = cost_guard.update_config(
            enabled=req.enabled,
            cap_daily_usd=req.cap_daily_usd,
            cap_weekly_usd=req.cap_weekly_usd,
            cap_monthly_usd=req.cap_monthly_usd,
            cap_sessions_per_day=req.cap_sessions_per_day,
        )
        return cost_guard.config_to_dict(new_config)

    @app.post("/cost-guard/check", dependencies=bearer)
    async def cost_guard_check(req: CostGuardCheckRequest) -> dict[str, Any]:
        result = cost_guard.check(
            model=req.model,
            auth_kind=req.auth_kind,
            max_tokens=req.max_tokens,
        )
        return cost_guard.check_result_to_dict(result)

    @app.post("/llm/test", dependencies=bearer)
    async def llm_test(req: LLMTestRequest) -> dict[str, Any]:
        """Validate stored LLM credentials with a 1-token completion.

        Explicit-trigger only (Settings → "Test connection" per row).
        Under ~$0.0001 per test for API-key providers; skips CostGuard
        entirely because this is a credential ping, not a debate.

        OAuth credentials live in the Electron main process and never
        reach the renderer, so OAuth is rejected here on principle;
        the OAuth row in Settings already shows live connection state
        via `oauth:openai:status`.
        """
        config = ProviderConfig.from_dict(req.provider_config)
        if config is None:
            return {"ok": False, "error": "invalid provider_config"}
        if config.auth.get("type") == "oauth":
            return {
                "ok": False,
                "error": "OAuth credentials cannot be tested here; "
                "use the OAuth row's status indicator instead.",
            }
        adapter = adapter_for(config)
        started = time.monotonic()
        try:
            await adapter.open(api_key=config.bearer_token)
            await adapter.complete(
                system="",
                user="ping",
                model=config.model,
                max_tokens=1,
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            return {"ok": True, "model": config.model, "ms": elapsed_ms}
        except Exception as exc:  # noqa: BLE001 — surface whatever blew up
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        finally:
            try:
                await adapter.close()
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass

    @app.get("/telegram/status", dependencies=bearer)
    async def telegram_status() -> dict[str, Any]:
        return telegram_bot.status().to_dict()

    @app.post("/telegram/start", dependencies=bearer)
    async def telegram_start(req: TelegramBotStartRequest) -> dict[str, Any]:
        """Start (or restart) the bot polling loop.

        Token + allowlist + cap + provider config all come from the
        renderer's safeStorage. Engine never persists the bot token or
        provider credentials; per-chat daily spend IS persisted to a
        sibling JSON file so an app restart cannot reset the cap.
        """
        try:
            config = TelegramBotConfig.from_dict(req.model_dump())
            await telegram_bot.start(config)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:  # noqa: BLE001 — surface, don't leak stack
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")
        return telegram_bot.status().to_dict()

    @app.post("/telegram/stop", dependencies=bearer)
    async def telegram_stop() -> dict[str, Any]:
        await telegram_bot.stop()
        return telegram_bot.status().to_dict()

    @app.post("/telegram/approve", dependencies=bearer)
    async def telegram_approve(req: TelegramChatActionRequest) -> dict[str, Any]:
        """Move a pending chat_id into the live allowlist. The bot DMs the
        user "you're approved" on success. Idempotent: re-approving an
        already-approved chat returns ok without side effect."""
        ok = await telegram_bot.approve(req.chat_id)
        if not ok:
            raise HTTPException(
                status_code=404,
                detail=f"no pending request for chat_id {req.chat_id}",
            )
        return telegram_bot.status().to_dict()

    @app.post("/telegram/deny", dependencies=bearer)
    async def telegram_deny(req: TelegramChatActionRequest) -> dict[str, Any]:
        """Drop a pending entry without DMing the user. Returns 404 if
        there was no pending entry for the chat_id (already approved /
        denied / expired)."""
        ok = telegram_bot.deny(req.chat_id)
        if not ok:
            raise HTTPException(
                status_code=404,
                detail=f"no pending request for chat_id {req.chat_id}",
            )
        return telegram_bot.status().to_dict()

    @app.post("/telegram/refresh-credentials", dependencies=bearer)
    async def telegram_refresh_credentials(
        req: TelegramRefreshCredentialsRequest,
    ) -> dict[str, Any]:
        """Update the bot's provider_config in place. Used by the renderer
        to push fresh OpenAI OAuth access tokens on a periodic interval
        before the previous one expires; the bot otherwise wouldn't be
        able to run debates more than ~1hr after start when on OAuth.

        Returns 409 if the bot is not running. The renderer is expected
        to silently skip the refresh in that case rather than treat it
        as a hard error."""
        ok = telegram_bot.refresh_credentials(req.provider_config)
        if not ok:
            raise HTTPException(
                status_code=409,
                detail="telegram bot is not running; nothing to refresh",
            )
        return telegram_bot.status().to_dict()

    @app.get("/llm/local-runtimes", dependencies=bearer)
    async def llm_local_runtimes() -> dict[str, Any]:
        """Probe localhost for OpenAI-compatible LLM runtimes.

        Empty `runtimes` array is a normal response, NOT an error — it
        means the user has no Ollama / LM Studio / llama.cpp server
        running. The renderer surfaces that as "Not detected" with a
        manual-entry fallback, not a failed fetch.
        """
        detected = await local_llm_detect.detect_runtimes()
        return {
            "runtimes": [local_llm_detect.runtime_to_dict(r) for r in detected],
        }

    @app.post("/cost-guard/reserve", dependencies=bearer)
    async def cost_guard_reserve(req: CostGuardReserveRequest) -> dict[str, Any]:
        try:
            result = cost_guard.reserve(
                model=req.model,
                auth_kind=req.auth_kind,
                max_tokens=req.max_tokens,
                override=req.override,
            )
        except cost_guard.CostGuardBlocked as exc:
            # 402 Payment Required — semantic match for "you can't afford
            # this without overriding"; pair with a JSON body the renderer
            # uses to populate the override modal.
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "cost_guard_blocked",
                    "over_dimension": exc.over_dimension,
                    "spend": cost_guard.spend_to_dict(exc.spend),
                    "config": cost_guard.config_to_dict(exc.config),
                    "est_cost_usd": round(exc.est_cost, 6),
                },
            )
        return cost_guard.reserve_result_to_dict(result)

    @app.post("/analyze", dependencies=bearer)
    async def analyze(req: AnalyzeRequest) -> dict[str, Any]:
        # Phase 2 stub — Phase 3+ wires this to the real tradingagents core.
        return {
            "ok": True,
            "ticker": req.ticker.upper(),
            "trade_date": req.trade_date,
            "decision": {
                "stance": "neutral",
                "conviction": 0.5,
                "bull_strength": 50,
                "bear_strength": 50,
                "risk_level": "moderate",
                "reasoning": (
                    "Stub response — engine not yet connected to tradingagents core."
                ),
            },
            "agents": [],
        }

    @app.websocket("/stream")
    async def stream(ws: WebSocket) -> None:
        # WS auth via query param (browsers cannot set Authorization headers on WS).
        provided = ws.query_params.get("token")
        if provided != token:
            await ws.close(code=1008, reason="invalid token")
            return
        await ws.accept()

        captured_events: list[dict] = []
        # Bound before the try so the `except WebSocketDisconnect` handler can
        # log it even when the client disconnects before sending the start
        # frame (otherwise referencing `ticker` there raises NameError).
        ticker = ""
        try:
            # Wait for the client's start frame:
            #   {
            #     "ticker": "NVDA",
            #     "trade_date": "2026-05-08",
            #     "provider_config": {                  # optional
            #       "provider": "openai",
            #       "api_key": "sk-...",
            #       "model": "gpt-4o-mini",
            #       "max_tokens": 400
            #     }
            #   }
            start = await ws.receive_json()
            ticker = (start.get("ticker") or "").upper()
            trade_date = start.get("trade_date") or ""
            config = ProviderConfig.from_dict(start.get("provider_config"))
            # Optional. Set by Analyze.tsx after a renderer-side cost-guard
            # check. If absent on a live debate, the WS handler auto-reserves
            # below for backward compatibility.
            reservation_id = start.get("reservation_id") or None
            # Optional. Per-stream webhook configs (Phase 8a). Renderer sends
            # the full list each time; engine fires them after persist + before
            # ws.close(1000). URLs ARE secrets (Telegram/Discord embed bot
            # tokens), so never log them and never include in events.
            raw_hooks = start.get("webhooks") or []
            telegram_chat_ids = start.get("telegram_chat_ids") or {}
            webhooks: list[webhook_dispatcher.WebhookConfig] = []
            if isinstance(raw_hooks, list):
                for h in raw_hooks:
                    if isinstance(h, dict):
                        parsed = webhook_dispatcher.WebhookConfig.from_dict(h)
                        if parsed is not None:
                            webhooks.append(parsed)
            # Optional. When the renderer has Alpaca data keys configured,
            # it sends them as data_config = {provider: "alpaca", key_id, secret}.
            # Engine instantiates a per-stream AlpacaProvider; otherwise falls
            # through to the module-level yfinance default. No fallback chain
            # on Alpaca failure — if user configured Alpaca and it errors, the
            # data card stays empty so they notice (silent fall-through to
            # yfinance would mask configuration issues).
            data_provider: BaseDataProvider = (
                provider_from_data_config(start.get("data_config")) or default_provider
            )
            llm_label = (
                f"{config.provider}/{config.auth_kind}/{config.model}"
                if config is not None
                else "stub"
            )
            sys.stderr.write(
                f"[ws] OPEN ticker={ticker} date={trade_date} "
                f"data={data_provider.name} llm={llm_label}\n"
            )

            # Best-effort data fetch; debate degrades gracefully if it fails.
            summary = await _fetch_summary_safe(
                ticker=ticker, trade_date=trade_date, provider=data_provider
            )
            if summary is not None:
                evt = {"type": "data.summary", **_summary_to_dict(summary)}
                await ws.send_json(evt)
                captured_events.append(evt)

            headlines = await _fetch_news_safe(
                ticker=ticker, limit=4, provider=data_provider
            )
            if headlines:
                evt = {
                    "type": "news.headlines",
                    "ticker": ticker,
                    "source": data_provider.name,
                    "headlines": [_headline_to_dict(h) for h in headlines],
                }
                await ws.send_json(evt)
                captured_events.append(evt)

            # Pre-fetch sentiment ONLY when we're about to run a live
            # debate. Stub mode skips entirely — the canned content
            # doesn't reference these sources and the fetch would just
            # burn ~6s of latency for nothing. Fetches run in parallel
            # via asyncio.gather; either failure surfaces as the
            # function's placeholder string, never as an exception.
            sentiment: Optional[SentimentBlock] = None
            if config is not None:
                try:
                    spec = normalize_ticker(ticker)
                    twits_text, reddit_text = await asyncio.gather(
                        sentiment_sources.fetch_stocktwits_messages_async(
                            spec.base
                        ),
                        sentiment_sources.fetch_reddit_posts_async(
                            spec.base, asset_class=spec.asset_class
                        ),
                    )
                    sentiment = SentimentBlock(
                        stocktwits=twits_text, reddit=reddit_text
                    )
                    sys.stderr.write(
                        f"[ws] sentiment fetched ticker={ticker} "
                        f"twits_chars={len(twits_text)} reddit_chars={len(reddit_text)}\n"
                    )
                except Exception as exc:  # noqa: BLE001 — sentiment is supplemental
                    sys.stderr.write(
                        f"[ws] sentiment fetch error ticker={ticker}: "
                        f"{type(exc).__name__}: {exc}\n"
                    )
                    sentiment = None

            if config is not None:
                # CostGuard auto-reserve when the renderer didn't pre-reserve.
                # Older renderer versions don't send reservation_id; rather
                # than reject them, we reserve server-side with override=False.
                # If the cap is exceeded, we send a structured error event
                # and close — renderer can surface this as a "configure caps
                # in Settings" hint.
                if not reservation_id:
                    try:
                        auto = cost_guard.reserve(
                            model=config.model,
                            auth_kind=config.auth_kind,
                            max_tokens=config.max_tokens,
                            override=False,
                        )
                        reservation_id = auto.reservation_id
                    except cost_guard.CostGuardBlocked as exc:
                        evt = {
                            "type": "cost.blocked",
                            "over_dimension": exc.over_dimension,
                            "spend": cost_guard.spend_to_dict(exc.spend),
                            "config": cost_guard.config_to_dict(exc.config),
                            "est_cost_usd": round(exc.est_cost, 6),
                            "message": (
                                f"Live debate blocked: would exceed {exc.over_dimension} "
                                f"cap. Configure higher caps in Settings or use override."
                            ),
                        }
                        await ws.send_json(evt)
                        captured_events.append(evt)
                        await ws.close(code=1008, reason="cost_guard_blocked")
                        return
                # Live debate path. Each agent.message arrives as the LLM
                # response completes — we throttle a little between events
                # so the UI's transition animations are still visible.
                async for event in live_debate(
                    ticker=ticker,
                    trade_date=trade_date,
                    summary=summary,
                    headlines=headlines,
                    config=config,
                    reservation_id=reservation_id,
                    sentiment=sentiment,
                ):
                    await ws.send_json(event)
                    captured_events.append(event)
                    await asyncio.sleep(0.15)
            else:
                # Stub debate path — same UX, deterministic content.
                for event in canned_debate(
                    ticker=ticker,
                    trade_date=trade_date,
                    summary=summary,
                    headlines=headlines,
                ):
                    delay = event.pop("_delay", 0.4)
                    await ws.send_json(event)
                    captured_events.append(event)
                    await asyncio.sleep(delay)

            # Persist the completed session — best-effort, never fails the
            # stream. The user already saw the debate; persistence is bonus.
            session_id = _persist_session_safe(
                ticker=ticker,
                trade_date=trade_date,
                events=captured_events,
            )

            # Phase 8a — fire webhooks. After persist (so we have a session_id)
            # and before ws.close(1000) (so the renderer is still listening for
            # the `webhook.report` event). Best-effort: dispatch errors never
            # fail the stream. Total wall-clock cap is ~5s via per-receiver
            # timeout in dispatcher.
            if webhooks:
                complete_evt = next(
                    (e for e in captured_events if isinstance(e, dict) and e.get("type") == "session.complete"),
                    None,
                )
                if complete_evt:
                    raw_decision = complete_evt.get("decision") or {}
                    decision = raw_decision if isinstance(raw_decision, dict) else {}
                    try:
                        results = await webhook_dispatcher.dispatch_all(
                            configs=webhooks,
                            ticker=ticker,
                            trade_date=trade_date,
                            decision=decision,
                            session_id=session_id,
                            live=bool(complete_evt.get("live", False)),
                            provider=complete_evt.get("provider"),
                            model=complete_evt.get("model"),
                            estimated_cost_usd=complete_evt.get("estimated_cost_usd"),
                            telegram_chat_ids=(
                                {str(k): str(v) for k, v in telegram_chat_ids.items()}
                                if isinstance(telegram_chat_ids, dict)
                                else None
                            ),
                        )
                        report_evt = {
                            "type": "webhook.report",
                            "results": [r.to_dict() for r in results],
                        }
                        await ws.send_json(report_evt)
                        captured_events.append(report_evt)
                    except Exception as exc:  # noqa: BLE001 — webhooks must never break the stream
                        sys.stderr.write(
                            f"[webhooks] dispatch crashed: {type(exc).__name__}: {exc}\n"
                        )

            sys.stderr.write(
                f"[ws] CLOSE ticker={ticker} events={len(captured_events)} code=1000\n"
            )
            await ws.close(code=1000)
        except WebSocketDisconnect:
            sys.stderr.write(f"[ws] DISCONNECT ticker={ticker} mid-stream\n")
            return

    return app


def _persist_session_safe(
    *, ticker: str, trade_date: str, events: list[dict]
) -> str | None:
    """Find session.complete in the captured events and write a row.

    Thin wrapper around `storage.write_session_from_events` so the WS
    handler keeps its existing call shape; the bot path uses the same
    helper directly. Returns the new session id, or None if the stream
    was aborted / the write failed. Caller uses the id as the
    `session_id` in webhook payloads so receivers can correlate alerts
    to History rows.
    """
    return storage.write_session_from_events(
        ticker=ticker, trade_date=trade_date, events=events
    )


async def _fetch_summary_safe(
    *,
    ticker: str,
    trade_date: str,
    provider: BaseDataProvider | None = None,
) -> QuoteSummary | None:
    if not ticker or not trade_date:
        return None
    p = provider or default_provider
    try:
        return await p.quote_summary(ticker=ticker, trade_date=trade_date)
    except Exception:  # noqa: BLE001 — never let data issues break the stream
        return None


async def _fetch_news_safe(
    *,
    ticker: str,
    limit: int,
    provider: BaseDataProvider | None = None,
) -> list[Headline]:
    if not ticker:
        return []
    p = provider or default_provider
    try:
        return await p.news_headlines(ticker=ticker, limit=limit)
    except Exception:  # noqa: BLE001
        return []


def _headline_to_dict(h: Headline) -> dict[str, Any]:
    return {
        "title": h.title,
        "publisher": h.publisher,
        "pub_date": h.pub_date,
        "url": h.url,
        "summary": h.summary,
    }


def _summary_to_dict(summary: QuoteSummary) -> dict[str, Any]:
    return {
        "ticker": summary.ticker,
        "trade_date": summary.trade_date,
        "as_of": summary.as_of,
        "last_close": summary.last_close,
        "period_open": summary.period_open,
        "period_high": summary.period_high,
        "period_low": summary.period_low,
        "period_change_pct": summary.period_change_pct,
        "avg_volume": summary.avg_volume,
        "sessions": summary.sessions,
        "source": summary.source,
        "asset_class": summary.asset_class,
    }


class AnalyzeRequest(BaseModel):
    ticker: str = Field(min_length=1, max_length=8)
    trade_date: str = Field(min_length=8, max_length=10, description="YYYY-MM-DD")


class WatchlistAddRequest(BaseModel):
    ticker: str = Field(min_length=1, max_length=8)
    note: str | None = Field(default=None, max_length=200)


class CostGuardConfigRequest(BaseModel):
    """All fields optional — only provided fields are updated (PATCH semantics
    on a PUT for simplicity)."""

    enabled: bool | None = None
    cap_daily_usd: float | None = Field(default=None, ge=0)
    cap_weekly_usd: float | None = Field(default=None, ge=0)
    cap_monthly_usd: float | None = Field(default=None, ge=0)
    cap_sessions_per_day: int | None = Field(default=None, ge=0)


class CostGuardCheckRequest(BaseModel):
    model: str = Field(min_length=1, max_length=120)
    # Allowed auth kinds: api_key, oauth, local. Local runs are $0 and
    # bypass the USD caps the same way OAuth does (see cost_guard.py
    # `_exceeds_any_cap`); validating it here keeps the pattern + the
    # downstream cost-guard logic in agreement.
    auth_kind: str = Field(pattern=r"^(api_key|oauth|local)$")
    max_tokens: int = Field(default=400, ge=1, le=8000)


class CostGuardReserveRequest(CostGuardCheckRequest):
    override: bool = False


class LLMTestRequest(BaseModel):
    """ProviderConfig dict the renderer would normally attach to a WS
    start frame. Re-validated through `ProviderConfig.from_dict` so the
    test endpoint enforces the same allowlist + auth-shape rules as a
    real debate."""

    provider_config: dict[str, Any]


class TelegramBotStartRequest(BaseModel):
    """Renderer payload to start (or restart) the Telegram bot.

    The token is a secret URL-embedded auth credential; it ships from the
    renderer's safeStorage on each /telegram/start call and is held in
    memory only by the engine. Restart-to-update is the supported way to
    rotate the token or update the allowlist."""

    token: str = Field(min_length=20, max_length=120)
    allowlist: list[int] = Field(default_factory=list)
    daily_cap_usd: float = Field(default=5.0, ge=0, le=1000)
    provider_config: dict[str, Any] = Field(default_factory=dict)


class TelegramChatActionRequest(BaseModel):
    """Approve/Deny target. Telegram chat_ids are int64 on the wire; the
    Pydantic int type handles that range natively."""

    chat_id: int


class TelegramRefreshCredentialsRequest(BaseModel):
    """Renderer pushes fresh provider_config (OAuth-aware) on a periodic
    interval so the engine always has a non-expired access token for the
    next bot-triggered debate."""

    provider_config: dict[str, Any]
