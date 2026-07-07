"""Webhook dispatcher — fires HTTP POSTs to user-configured receivers after
session.complete.

Posture (locked, per CLAUDE.md §3):
- TradingAgentsLab does NOT execute trades. Webhooks are an analysis-handoff
  surface: alert, log, or push the decision to user-controlled systems. We
  ship presets for notification platforms (Slack, Discord, Telegram) + a
  generic JSON shape for arbitrary receivers. We do NOT ship broker presets.
  Users who wire to their own broker do so via their own Cloudflare Worker /
  Lambda / script consuming the generic payload — the execution happens on
  the regulated platform, never in TAL's wire shape.

Security:
- Webhook URLs are SECRETS. Telegram (`https://api.telegram.org/bot<TOKEN>/...`)
  and Discord (`https://discord.com/api/webhooks/<id>/<token>`) embed auth in
  the URL itself. Never log the URL. Never echo it into the WS event stream
  (which gets persisted into History). The `webhook.report` event carries
  `{id, name, status, http_status?}` only — no URLs.
- HMAC-SHA256 of the body with a shared secret is supported for the `generic`
  kind, sent as `X-TAL-Signature: sha256=<hex>`. Receivers verify by recomputing.
  The notification kinds use URL-embedded tokens and don't need HMAC.

Concurrency + timeout:
- Dispatch is `asyncio.gather` with a per-webhook 5s timeout so 5 slow
  receivers don't stack to 25s before the WS closes. Total wall-clock cap is
  effectively 5s + cancellation overhead.

What v1 does NOT do:
- No persistent retry queue. If a webhook fails, we report it and move on.
  The user re-runs the analysis (or fixes the receiver) if they care. v2
  would survive WS close + retry across app restarts — but that's a separate
  Phase 8b concern.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

import httpx


WebhookKind = Literal["generic", "slack", "discord", "telegram"]
WebhookStatus = Literal["fired", "filtered", "failed"]

# Telegram caps text at 4096 chars. Discord at 2000. Slack is more generous
# but we apply the strictest limit uniformly so the same payload works for
# all kinds without per-kind truncation logic.
_MAX_REASONING_CHARS = 500
_DISPATCH_TIMEOUT_S = 5.0


@dataclass
class WebhookFilter:
    """Per-webhook filter — both clauses AND together. Empty filter = fire
    on every session.complete (the sensible default for first-time users)."""

    stances: list[str] = field(default_factory=list)
    """Allowlist of stance strings ('bullish' | 'moderately_bullish' |
    'neutral' | 'moderately_bearish' | 'bearish'). Legacy BUY/SELL/HOLD
    values are normalized on read. Empty = all."""

    min_conviction: float = 0.0
    """Inclusive floor. 0.0 = no floor."""

    def passes(self, *, stance: str, conviction: float) -> bool:
        from .stance import normalize_stance

        if self.stances:
            allowed = {normalize_stance(s) for s in self.stances}
            if normalize_stance(stance) not in allowed:
                return False
        if conviction < self.min_conviction:
            return False
        return True


@dataclass
class WebhookConfig:
    id: str
    name: str
    url: str
    kind: WebhookKind = "generic"
    secret: Optional[str] = None
    """Optional HMAC-SHA256 shared secret. Only applied to `generic` kind —
    notification presets carry URL-embedded auth and signing the body would
    only confuse Slack/Discord/Telegram receivers."""
    filter: WebhookFilter = field(default_factory=WebhookFilter)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Optional["WebhookConfig"]:
        try:
            kind = d.get("kind", "generic")
            if kind not in {"generic", "slack", "discord", "telegram"}:
                kind = "generic"
            f = d.get("filter") or {}
            return WebhookConfig(
                id=str(d["id"]),
                name=str(d.get("name", d["id"])),
                url=str(d["url"]),
                kind=kind,  # type: ignore[arg-type]
                secret=(str(d["secret"]) if d.get("secret") else None),
                # Legacy config keys (actions / min_confidence) from
                # pre-stance installs are accepted and normalized.
                filter=WebhookFilter(
                    stances=list(f.get("stances") or f.get("actions") or []),
                    min_conviction=float(
                        f.get("min_conviction") or f.get("min_confidence") or 0.0
                    ),
                ),
            )
        except (KeyError, ValueError, TypeError):
            return None


@dataclass
class WebhookResult:
    """Per-receiver dispatch outcome. NEVER carries the URL — see header."""

    id: str
    name: str
    status: WebhookStatus
    http_status: Optional[int] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "name": self.name, "status": self.status}
        if self.http_status is not None:
            out["http_status"] = self.http_status
        if self.error is not None:
            out["error"] = self.error
        return out


# ---- Payload builders ------------------------------------------------------


def _truncate(text: str, n: int = _MAX_REASONING_CHARS) -> str:
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"


def _summary_text(
    *, ticker: str, trade_date: str, decision: dict[str, Any]
) -> str:
    """Shared human-readable summary used by all notification kinds. Stays
    under the strictest platform limit (Telegram 4096) by design."""
    from .stance import decision_conviction, decision_stance, stance_label

    stance = stance_label(decision_stance(decision))
    pct = f"{round(decision_conviction(decision) * 100)}%"
    strengths = ""
    if (
        decision.get("bull_strength") is not None
        and decision.get("bear_strength") is not None
    ):
        strengths = (
            f"Bull thesis {decision['bull_strength']}/100 · "
            f"Bear thesis {decision['bear_strength']}/100"
        )
        risk = str(decision.get("risk_level", "")).strip()
        if risk:
            strengths += f" · Risk {risk}"
        strengths += "\n"
    return (
        f"📊 *{ticker}* — *{stance}* (conviction {pct})\n"
        f"As-of {trade_date}\n"
        f"{strengths}\n"
        f"{_truncate(str(decision.get('reasoning', '')))}\n\n"
        f"_Analytical stance, not a recommendation. Any investment "
        f"decision is yours alone._"
    )


def _generic_payload(
    *,
    config: WebhookConfig,
    ticker: str,
    trade_date: str,
    decision: dict[str, Any],
    session_id: Optional[str],
    live: bool,
    provider: Optional[str],
    model: Optional[str],
    estimated_cost_usd: Optional[float],
) -> dict[str, Any]:
    """Generic JSON payload — full decision shape. Receivers (Cloudflare
    Workers, Lambdas, custom scripts) consume this directly."""
    from .stance import decision_conviction, decision_stance

    # v2: the decision block carries the analytical stance model. The app
    # does not emit trade directives; receivers that automate on this feed
    # own any mapping from stance to action on their side.
    return {
        "schema": "tradingagentslab.webhook.v2",
        "event": "session.complete",
        "ticker": ticker,
        "trade_date": trade_date,
        "decision": {
            "stance": decision_stance(decision),
            "conviction": decision_conviction(decision),
            "bull_strength": decision.get("bull_strength"),
            "bear_strength": decision.get("bear_strength"),
            "risk_level": decision.get("risk_level"),
            "reasoning": decision.get("reasoning", ""),
        },
        "session_id": session_id,
        "live": live,
        "provider": provider,
        "model": model,
        "estimated_cost_usd": estimated_cost_usd,
    }


def _slack_payload(
    *, ticker: str, trade_date: str, decision: dict[str, Any]
) -> dict[str, Any]:
    """Slack incoming-webhook shape. `text` is the fallback for clients that
    don't render Block Kit."""
    text = _summary_text(ticker=ticker, trade_date=trade_date, decision=decision)
    return {"text": text}


def _discord_payload(
    *, ticker: str, trade_date: str, decision: dict[str, Any]
) -> dict[str, Any]:
    """Discord webhook shape. Discord accepts markdown in `content` — same
    summary text as Slack."""
    text = _summary_text(ticker=ticker, trade_date=trade_date, decision=decision)
    return {"content": text}


def _telegram_payload(
    *, ticker: str, trade_date: str, decision: dict[str, Any], chat_id: Optional[str]
) -> dict[str, Any]:
    """Telegram Bot API `sendMessage` shape. The bot token lives in the URL;
    chat_id is required and is configured per-receiver. If chat_id is None
    here, the dispatch will fail at the API with a clear 400 — better than
    silently sending to no one.

    Markdown is set explicitly so the *bold* + `_italic_` markers in the
    summary render. parse_mode=MarkdownV2 has stricter escaping rules; we
    use the legacy `Markdown` mode for forgiveness on ticker symbols with
    underscores etc.
    """
    text = _summary_text(ticker=ticker, trade_date=trade_date, decision=decision)
    payload: dict[str, Any] = {"text": text, "parse_mode": "Markdown"}
    if chat_id:
        payload["chat_id"] = chat_id
    return payload


# ---- Dispatch --------------------------------------------------------------


async def _fire_one(
    *,
    client: httpx.AsyncClient,
    config: WebhookConfig,
    ticker: str,
    trade_date: str,
    decision: dict[str, Any],
    session_id: Optional[str],
    live: bool,
    provider: Optional[str],
    model: Optional[str],
    estimated_cost_usd: Optional[float],
    telegram_chat_id: Optional[str],
) -> WebhookResult:
    """Build payload per kind, POST, return a status. Catches every exception
    so a single broken receiver can't take down the gather."""
    headers: dict[str, str] = {"Content-Type": "application/json"}

    if config.kind == "generic":
        body = _generic_payload(
            config=config,
            ticker=ticker,
            trade_date=trade_date,
            decision=decision,
            session_id=session_id,
            live=live,
            provider=provider,
            model=model,
            estimated_cost_usd=estimated_cost_usd,
        )
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        if config.secret:
            sig = hmac.new(
                config.secret.encode("utf-8"), encoded, hashlib.sha256
            ).hexdigest()
            headers["X-TAL-Signature"] = f"sha256={sig}"
    elif config.kind == "slack":
        body = _slack_payload(ticker=ticker, trade_date=trade_date, decision=decision)
        encoded = json.dumps(body).encode("utf-8")
    elif config.kind == "discord":
        body = _discord_payload(
            ticker=ticker, trade_date=trade_date, decision=decision
        )
        encoded = json.dumps(body).encode("utf-8")
    else:  # telegram
        body = _telegram_payload(
            ticker=ticker,
            trade_date=trade_date,
            decision=decision,
            chat_id=telegram_chat_id,
        )
        encoded = json.dumps(body).encode("utf-8")

    try:
        resp = await client.post(
            config.url,
            content=encoded,
            headers=headers,
            timeout=_DISPATCH_TIMEOUT_S,
        )
        if 200 <= resp.status_code < 300:
            return WebhookResult(id=config.id, name=config.name, status="fired", http_status=resp.status_code)
        return WebhookResult(
            id=config.id,
            name=config.name,
            status="failed",
            http_status=resp.status_code,
            error=f"HTTP {resp.status_code}",
        )
    except httpx.TimeoutException:
        # httpx raises its own TimeoutException (ReadTimeout/ConnectTimeout/…),
        # NOT the builtin/asyncio TimeoutError — catch the right type so a slow
        # receiver is reported as "timeout" rather than the generic failure.
        return WebhookResult(
            id=config.id, name=config.name, status="failed", error="timeout"
        )
    except Exception as exc:  # noqa: BLE001 — any error is a "failed" status
        # Deliberately do NOT include the URL in the error string. Telegram /
        # Discord URLs are tokens.
        return WebhookResult(
            id=config.id,
            name=config.name,
            status="failed",
            error=f"{type(exc).__name__}: {exc}",
        )


async def dispatch_all(
    *,
    configs: list[WebhookConfig],
    ticker: str,
    trade_date: str,
    decision: dict[str, Any],
    session_id: Optional[str] = None,
    live: bool = False,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    estimated_cost_usd: Optional[float] = None,
    telegram_chat_ids: Optional[dict[str, str]] = None,
) -> list[WebhookResult]:
    """Fire every configured webhook in parallel, return per-receiver results.

    Filter evaluation happens here, not in the dispatcher — filtered receivers
    yield a `WebhookResult(status='filtered')` so the renderer can surface
    "fired 2, filtered 1, failed 0" without a separate count of skipped
    configs.

    `telegram_chat_ids` is a map of {webhook_id: chat_id} for the telegram
    kind, since chat_id isn't part of the URL. Per-receiver UI in Settings
    collects this.
    """
    if not configs:
        return []

    from .stance import decision_conviction, decision_stance

    stance = decision_stance(decision)
    conviction = decision_conviction(decision)

    # Filter first — filtered receivers don't open httpx connections.
    to_fire: list[WebhookConfig] = []
    results: list[WebhookResult] = []
    for c in configs:
        if not c.filter.passes(stance=stance, conviction=conviction):
            results.append(
                WebhookResult(id=c.id, name=c.name, status="filtered")
            )
            continue
        to_fire.append(c)

    if not to_fire:
        return results

    async with httpx.AsyncClient() as client:
        fired = await asyncio.gather(
            *(
                _fire_one(
                    client=client,
                    config=c,
                    ticker=ticker,
                    trade_date=trade_date,
                    decision=decision,
                    session_id=session_id,
                    live=live,
                    provider=provider,
                    model=model,
                    estimated_cost_usd=estimated_cost_usd,
                    telegram_chat_id=(telegram_chat_ids or {}).get(c.id),
                )
                for c in to_fire
            )
        )

    results.extend(fired)

    # Stderr summary for engine logs — NEVER include URLs.
    fired_n = sum(1 for r in results if r.status == "fired")
    filtered_n = sum(1 for r in results if r.status == "filtered")
    failed_n = sum(1 for r in results if r.status == "failed")
    sys.stderr.write(
        f"[webhooks] dispatched ticker={ticker} fired={fired_n} "
        f"filtered={filtered_n} failed={failed_n}\n"
    )
    sys.stderr.flush()

    return results
