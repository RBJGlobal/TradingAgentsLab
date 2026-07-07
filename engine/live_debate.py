"""Phase 2.1-light: real-LLM debate with sequential per-agent calls.

This is intentionally *not* a wrapper around upstream's LangGraph. We pull the
spirit of the upstream agent roles (their system prompts, their phase
structure) but call the model directly with our own minimal orchestration.
The full upstream-graph integration is a later phase; the simpler approach is
controllable, debuggable, and stays under the founder's quota.

Cost discipline (non-negotiable, enforced HERE not in adapters):
- Total agents per session is bounded by `MAX_AGENTS_PER_SESSION = 12`
- `max_tokens` per agent message is capped to whatever `ProviderConfig` carries
  (which is itself capped by `_MAX_TOKENS_HARD_CAP` in `llm_providers.py`)
- Estimated cost per session is logged to stderr after `session.complete`

Rough budget per session at defaults (gpt-4o-mini, 400 tokens): ~7,400 input
tokens (each agent gets the prior turns appended) + ~2,400 output tokens
≈ ~$0.005 USD. Other providers in `llm_providers._COST_PER_M_TOKENS`.

When a provider key is not configured, the module is not invoked at all —
the WS path falls back to the canned `stub_debate.canned_debate` instead.
Multi-provider support: see `llm_providers.LLMAdapter` for the Protocol +
implementations (OpenAI, Anthropic, OpenRouter, Gemini).
"""

from __future__ import annotations

import asyncio
import random
import sys
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

from .data_providers import Headline, QuoteSummary
from .llm_providers import (
    LLMAdapter,
    ProviderConfig,
    adapter_for,
    estimate_cost,
)


# ---- Adapter retry/backoff --------------------------------------------------
#
# Wraps `adapter.complete` calls so a transient provider hiccup (rate limit,
# 503, dropped TCP) doesn't abort an entire debate. Lives at this layer (not
# inside each adapter) so retry policy is uniform across providers — caller
# can't accidentally ship a provider that retries differently. Retry is safe
# because every adapter returns the whole (content, in_tokens, out_tokens)
# tuple atomically; partial state isn't observable, so a replay produces no
# duplication in the WS stream.

_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 3
_BASE_BACKOFF_S = 1.0  # schedule: 1s, 2s, 4s (with ±30% jitter)
_RETRY_AFTER_CAP_S = 30.0  # don't honor a provider's wildly large retry-after


def _retry_after_seconds(exc: BaseException) -> Optional[float]:
    """Extract Retry-After (seconds) from a 429 response, if present.

    Both OpenAI and Anthropic SDK exceptions carry a `.response` with `.headers`.
    Anthropic occasionally sends Retry-After as an HTTP-date instead of a
    number; we only honor numeric values and fall through to backoff otherwise.
    """
    resp = getattr(exc, "response", None)
    if resp is None:
        return None
    headers = getattr(resp, "headers", None)
    if headers is None:
        return None
    raw = headers.get("retry-after") if hasattr(headers, "get") else None
    if not raw:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _is_retryable(exc: BaseException) -> bool:
    """Decide whether `exc` is a transient provider error worth one more attempt.

    Match by attribute (`status_code`) rather than `isinstance` so we don't
    have to import every optional provider SDK at module load. Network-layer
    transients (httpx timeouts/connect/read/protocol) cover the OpenAI,
    Anthropic, and Codex SDKs uniformly since they all sit on httpx.
    """
    import httpx

    if isinstance(
        exc,
        (
            httpx.TimeoutException,
            httpx.ConnectError,
            httpx.ReadError,
            httpx.RemoteProtocolError,
        ),
    ):
        return True

    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status in _RETRYABLE_STATUS:
        return True

    # The Codex adapter raises RuntimeError with "Codex <status>: ..." or
    # "Codex stream failed: ...". Parse defensively so a future log-format
    # tweak doesn't silently break the retry behavior.
    if isinstance(exc, RuntimeError):
        msg = str(exc)
        if msg.startswith("Codex "):
            try:
                code = int(msg.split(" ", 2)[1].rstrip(":"))
                if code in _RETRYABLE_STATUS:
                    return True
            except (ValueError, IndexError):
                pass
        if "Codex stream failed" in msg:
            return True

    return False


async def _complete_with_retry(
    adapter: LLMAdapter,
    *,
    provider: str,
    system: str,
    user: str,
    model: str,
    max_tokens: int,
) -> tuple[str, int, int]:
    """Call `adapter.complete` with bounded retry on transient errors.

    Local provider short-circuits — the OpenAI SDK already does 2 built-in
    retries against the localhost runtime, so adding a third at this layer
    burns the user's own hardware time for no real-world benefit. asyncio
    CancelledError is never caught: it's the WS-disconnect / generator-teardown
    signal and must propagate so `live_debate`'s finally-block runs cleanly.
    """
    if provider == "local":
        return await adapter.complete(
            system=system, user=user, model=model, max_tokens=max_tokens
        )

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            return await adapter.complete(
                system=system, user=user, model=model, max_tokens=max_tokens
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if attempt == _MAX_ATTEMPTS or not _is_retryable(exc):
                raise
            after = _retry_after_seconds(exc)
            if after is not None:
                delay = min(max(0.05, after), _RETRY_AFTER_CAP_S)
            else:
                base = _BASE_BACKOFF_S * (2 ** (attempt - 1))
                # symmetric ±30% jitter so retries don't synchronize across
                # parallel debates after a shared upstream blip.
                jitter = base * 0.3 * (2 * random.random() - 1)
                delay = max(0.05, base + jitter)
            sys.stderr.write(
                f"[live_debate] retry {attempt}/{_MAX_ATTEMPTS - 1} after "
                f"{type(exc).__name__}: sleeping {delay:.2f}s\n"
            )
            await asyncio.sleep(delay)

    # Unreachable: the loop either returns the adapter result or raises.
    raise RuntimeError("retry loop exited without result")


# ---- Sentiment block ---------------------------------------------------------
#
# Pre-fetched social data the sentiment_analyst agent grounds in.
# `stocktwits` and `reddit` are formatted plaintext blocks from
# `engine.sentiment_sources`. Both default to the empty string when
# pre-fetch was skipped (no provider config) or both endpoints failed —
# the agent prompt then surfaces a clear "no social data" line instead
# of fabricating.


@dataclass
class SentimentBlock:
    stocktwits: str = ""
    reddit: str = ""

    @property
    def is_empty(self) -> bool:
        return not (self.stocktwits or self.reddit)


# ---- Cost / quota guardrails -------------------------------------------------

MAX_AGENTS_PER_SESSION = 12  # same as the canned debate count

# Backwards-compat re-exports — keep callers importing from live_debate working.
__all__ = ["live_debate", "ProviderConfig", "MAX_AGENTS_PER_SESSION"]


@dataclass
class _Agent:
    name: str
    phase: str
    system_prompt: str


# Spirit-of-upstream prompts — short, focused, role-defining. Not copied from
# upstream verbatim. Each agent receives the same user-message context block
# (ticker / date / data summary / news / prior turns) and is asked to play one
# specific part of the debate.

_AGENTS: list[_Agent] = [
    _Agent(
        name="technical_analyst",
        phase="analysts",
        system_prompt=(
            "You are a senior technical analyst on a multi-agent trading research "
            "team. Read the provided price action and volume context, identify "
            "the most decision-relevant technical setup in 3-5 sentences. Focus "
            "on trend, momentum, support/resistance, and volume confirmation. "
            "No disclaimers. No greetings. Output is logged into a transcript."
        ),
    ),
    _Agent(
        name="fundamental_analyst",
        phase="analysts",
        system_prompt=(
            "You are a fundamental analyst. Given the ticker and any quoted "
            "price levels, comment briefly on what fundamentals would matter "
            "most right now (3-5 sentences). For equities, focus on earnings, "
            "balance sheet health, valuation multiples, and competitive moat. "
            "For crypto / digital assets, focus on tokenomics (supply schedule, "
            "burn mechanics, issuance), on-chain metrics (active addresses, "
            "network volume, hash rate), regulatory developments, and macro "
            "liquidity. If you do not have detailed data, say so explicitly "
            "and explain what you would look for."
        ),
    ),
    _Agent(
        name="news_analyst",
        phase="analysts",
        system_prompt=(
            "You are a news analyst. Read the provided headlines list. In 3-5 "
            "sentences, identify any catalysts that materially affect the "
            "ticker, distinguish noise from signal, and note what is missing "
            "from the available news that you would want to know."
        ),
    ),
    _Agent(
        name="sentiment_analyst",
        phase="analysts",
        system_prompt=(
            "You are a sentiment analyst. When StockTwits and Reddit blocks "
            "are present in the context, ground your assessment in the "
            "actual messages — quote a bullish/bearish ratio, name a "
            "subreddit where conviction is highest or lowest, flag if "
            "tone diverges from the price action. When social data is "
            "missing or sparse, say so explicitly and fall back to what "
            "the tape and headlines imply. 4-6 sentences. Do not "
            "fabricate posts you cannot see in the provided blocks."
        ),
    ),
    _Agent(
        name="bull_researcher",
        phase="researchers",
        system_prompt=(
            "You are the bull researcher. Make the strongest defensible long "
            "case in 3-5 sentences, anchored on the provided data. Do not "
            "hedge. Do not list. Argue."
        ),
    ),
    _Agent(
        name="bear_researcher",
        phase="researchers",
        system_prompt=(
            "You are the bear researcher. Make the strongest defensible short "
            "or avoid case in 3-5 sentences, anchored on the provided data. "
            "Do not hedge. Do not list. Argue."
        ),
    ),
    _Agent(
        name="research_manager",
        phase="researchers",
        system_prompt=(
            "You are the research manager. You have just heard a bull and bear "
            "case. In 3-5 sentences, weigh the asymmetry, decide which side "
            "carries the better risk-adjusted argument *for the next few "
            "trading sessions*, and state a directional lean."
        ),
    ),
    _Agent(
        name="trader",
        phase="trader",
        system_prompt=(
            "You are the trader seat on this simulated research desk. Given "
            "the analyst and researcher views, describe in 3-5 sentences how "
            "a hypothetical practitioner might structure this idea: whether "
            "the setup looks actionable, what size posture it would merit "
            "(small / standard / sized up), and what invalidation level would "
            "break the thesis. If the setup does not look actionable, say so "
            "and explain why. This is an analytical exercise, not an "
            "instruction to trade."
        ),
    ),
    _Agent(
        name="risk_aggressive",
        phase="risk",
        system_prompt=(
            "You are the aggressive risk seat. Argue in 2-3 sentences for the "
            "more opportunistic course of action — what does the team risk by "
            "being too cautious here?"
        ),
    ),
    _Agent(
        name="risk_conservative",
        phase="risk",
        system_prompt=(
            "You are the conservative risk seat. Argue in 2-3 sentences for "
            "the more defensive course of action — what does the team risk by "
            "being too aggressive here?"
        ),
    ),
    _Agent(
        name="risk_neutral",
        phase="risk",
        system_prompt=(
            "You are the neutral risk seat. In 2-3 sentences, propose the "
            "lowest-regret course of action that respects both the aggressive "
            "and conservative arguments."
        ),
    ),
    _Agent(
        name="portfolio_manager",
        phase="risk",
        system_prompt=(
            "You are the portfolio manager chairing a research committee. "
            "Summarize the committee's analytical stance. You do NOT issue "
            "trade instructions; you assess how the evidence balances. "
            "Output exactly five lines:\n"
            "Line 1: one of: STANCE=BULLISH | STANCE=MODERATELY_BULLISH | "
            "STANCE=NEUTRAL | STANCE=MODERATELY_BEARISH | STANCE=BEARISH\n"
            "Line 2: CONVICTION=<float between 0 and 1>\n"
            "Line 3: BULL_STRENGTH=<integer 0-100, how strong the bull case "
            "argued in this debate is>\n"
            "Line 4: BEAR_STRENGTH=<integer 0-100, how strong the bear case "
            "argued in this debate is>\n"
            "Line 5: RISK=LOW | RISK=MODERATE | RISK=ELEVATED\n"
            "Then 2-3 sentences of reasoning. Be decisive in your assessment."
        ),
    ),
]

# Sanity check matches the explicit cap.
assert len(_AGENTS) == MAX_AGENTS_PER_SESSION, "agent count must match the cap"


@dataclass
class _DebateState:
    transcript: list[dict] = field(default_factory=list)  # {agent, content}
    input_tokens: int = 0
    output_tokens: int = 0


def _format_context(
    *,
    ticker: str,
    trade_date: str,
    summary: Optional[QuoteSummary],
    headlines: Optional[list[Headline]],
    state: _DebateState,
    sentiment: Optional[SentimentBlock] = None,
    include_full_sentiment: bool = False,
) -> str:
    """Build the user message for a given agent.

    All agents share the same price + news + transcript context. The
    full StockTwits / Reddit blocks are routed only to the
    `sentiment_analyst` agent (via `include_full_sentiment=True`) to
    keep prompt size bounded — other agents read the sentiment
    analyst's conclusion via the transcript, the way a research desk
    would consume a teammate's summary turn.
    """
    lines: list[str] = []
    lines.append(f"Ticker: {ticker}")
    lines.append(f"Trade date (anchor): {trade_date}")
    if summary is not None:
        lines.append("")
        lines.append("Recent price action (compact summary):")
        lines.append(f"- last close: {summary.last_close:.2f} (as of {summary.as_of})")
        lines.append(
            f"- {summary.sessions}-session window: "
            f"open {summary.period_open:.2f}, "
            f"high {summary.period_high:.2f}, "
            f"low {summary.period_low:.2f}, "
            f"change {summary.period_change_pct:+.2f}%"
        )
        lines.append(f"- avg daily volume: {int(summary.avg_volume):,}")
        lines.append(f"- source: {summary.source}")
    if headlines:
        lines.append("")
        lines.append("Recent news headlines:")
        for h in headlines[:6]:
            pub = f" ({h.publisher})" if h.publisher else ""
            lines.append(f"- {h.title}{pub}")
    if include_full_sentiment and sentiment is not None and not sentiment.is_empty:
        if sentiment.stocktwits:
            lines.append("")
            lines.append("StockTwits messages (most recent):")
            lines.append(sentiment.stocktwits)
        if sentiment.reddit:
            lines.append("")
            lines.append("Reddit posts (past 7 days):")
            lines.append(sentiment.reddit)
    if state.transcript:
        lines.append("")
        lines.append("Prior turns in this debate (most recent last):")
        for turn in state.transcript:
            lines.append(f"[{turn['agent']}] {turn['content']}")
    return "\n".join(lines)


# The five analytical stances the committee can land on, from most to least
# constructive. These are ANALYTICAL assessments, deliberately not trade
# directives (no buy/sell/hold): the app summarizes how the evidence balances
# and the user makes any investment decision themselves.
STANCES = (
    "bullish",
    "moderately_bullish",
    "neutral",
    "moderately_bearish",
    "bearish",
)

RISK_LEVELS = ("low", "moderate", "elevated")


def _parse_decision(content: str) -> dict:
    """Extract the committee assessment from the portfolio_manager output.

    Tolerant of formatting drift — any line that isn't found falls back to a
    neutral default (NEUTRAL / 0.5 conviction / 50-50 strengths / moderate
    risk) with the raw content as reasoning.
    """
    import re

    stance = "neutral"
    conviction = 0.5
    bull_strength = 50
    bear_strength = 50
    risk_level = "moderate"

    m = re.search(
        r"STANCE\s*=\s*(BULLISH|MODERATELY_BULLISH|NEUTRAL|MODERATELY_BEARISH|BEARISH)",
        content,
        re.IGNORECASE,
    )
    if m:
        stance = m.group(1).lower()
    m = re.search(r"CONVICTION\s*=\s*([0-9]*\.?[0-9]+)", content, re.IGNORECASE)
    if m:
        try:
            v = float(m.group(1))
            if 0 <= v <= 1:
                conviction = v
            elif 0 <= v <= 100:
                conviction = v / 100
        except ValueError:
            pass
    for key in ("BULL_STRENGTH", "BEAR_STRENGTH"):
        m = re.search(rf"{key}\s*=\s*([0-9]+)", content, re.IGNORECASE)
        if m:
            try:
                v = int(m.group(1))
                if 0 <= v <= 100:
                    if key == "BULL_STRENGTH":
                        bull_strength = v
                    else:
                        bear_strength = v
            except ValueError:
                pass
    m = re.search(r"RISK\s*=\s*(LOW|MODERATE|ELEVATED)", content, re.IGNORECASE)
    if m:
        risk_level = m.group(1).lower()
    # Strip the directives from the reasoning so it reads naturally.
    reasoning = re.sub(
        r"^\s*(STANCE|CONVICTION|BULL_STRENGTH|BEAR_STRENGTH|RISK)\s*=.*$",
        "",
        content,
        flags=re.IGNORECASE | re.MULTILINE,
    ).strip()
    if not reasoning:
        reasoning = content.strip()
    return {
        "stance": stance,
        "conviction": conviction,
        "bull_strength": bull_strength,
        "bear_strength": bear_strength,
        "risk_level": risk_level,
        "reasoning": reasoning,
    }


# Imported lazily inside finalize so cost_guard's import chain (which pulls
# in this module's symbols) doesn't fight at module-load time.


async def live_debate(
    *,
    ticker: str,
    trade_date: str,
    summary: Optional[QuoteSummary],
    headlines: Optional[list[Headline]],
    config: ProviderConfig,
    reservation_id: Optional[str] = None,
    sentiment: Optional[SentimentBlock] = None,
) -> AsyncIterator[dict]:
    """Real-LLM debate. Yields the same event shapes as `canned_debate`.

    Caller is responsible for sending these events down the WebSocket and
    enforcing per-event delays — this generator does NOT include `_delay`
    fields because the LLM round trips already provide natural pacing.
    """
    # `ProviderConfig.from_dict` rejects unknown providers; `adapter_for` is
    # the second guard. If neither catches a misconfiguration, surface a
    # graceful session.complete instead of crashing the WS handler.
    try:
        adapter: LLMAdapter = adapter_for(config)
    except ValueError as exc:
        yield {
            "type": "session.start",
            "ticker": ticker,
            "trade_date": trade_date,
        }
        yield {
            "type": "session.complete",
            "ticker": ticker,
            "trade_date": trade_date,
            "decision": {
                "stance": "neutral",
                "conviction": 0.0,
                "bull_strength": 0,
                "bear_strength": 0,
                "risk_level": "moderate",
                "reasoning": (
                    f"Live debate aborted: {exc}. Configure a supported "
                    "provider in Settings, or leave the LLM unconfigured "
                    "to run the stub."
                ),
            },
            "live": False,
        }
        return

    started_at = time.time()
    state = _DebateState()
    # `bearer_token` works for both api_key and oauth auth shapes; the
    # adapter's `api_key` kwarg is named for Protocol consistency but
    # accepts any Bearer token. For OpenAI's standard chat-completions
    # endpoint both `sk-…` and OAuth tokens go in the same Authorization
    # header. For the Codex backend (OAuth path) the same header carries
    # the access token, AND a separate `chatgpt-account-id` header is
    # required — passed via the adapter's `set_account_id` if it has one.
    await adapter.open(api_key=config.bearer_token)
    if config.auth.get("type") == "oauth":
        account_id = config.auth.get("account_id")
        if account_id and hasattr(adapter, "set_account_id"):
            adapter.set_account_id(str(account_id))

    # try/finally guarantees adapter cleanup even when the client disconnects
    # mid-stream (FastAPI raises WebSocketDisconnect, which throws GeneratorExit
    # into this generator). Without this, the adapter's pooled httpx client
    # leaks for the lifetime of the engine process.
    yielded_complete = False
    try:
        yield {
            "type": "session.start",
            "ticker": ticker,
            "trade_date": trade_date,
        }

        last_phase: Optional[str] = None
        final_decision: Optional[dict] = None

        # Defensive cap: never exceed the agent count even if the table grows.
        for agent in _AGENTS[:MAX_AGENTS_PER_SESSION]:
            if last_phase is not None and agent.phase != last_phase:
                yield {"type": "phase.transition", "from": last_phase, "to": agent.phase}
            last_phase = agent.phase

            user_msg = _format_context(
                ticker=ticker,
                trade_date=trade_date,
                summary=summary,
                headlines=headlines,
                state=state,
                sentiment=sentiment,
                include_full_sentiment=(agent.name == "sentiment_analyst"),
            )
            try:
                content, in_tok, out_tok = await _complete_with_retry(
                    adapter,
                    provider=config.provider,
                    system=agent.system_prompt,
                    user=user_msg,
                    model=config.model,
                    max_tokens=config.max_tokens,
                )
            except Exception as exc:  # noqa: BLE001 — convert any provider error into a stream event
                yield {
                    "type": "agent.message",
                    "agent": agent.name,
                    "phase": agent.phase,
                    "content": f"[live debate error] {type(exc).__name__}: {exc}",
                }
                # If the very first agent fails, abort early — no point continuing.
                if not state.transcript:
                    final_decision = {
                        "stance": "neutral",
                        "conviction": 0.0,
                        "bull_strength": 0,
                        "bear_strength": 0,
                        "risk_level": "moderate",
                        "reasoning": (
                            f"Live debate aborted: {type(exc).__name__}. "
                            f"Check the configured {config.provider} key and model availability."
                        ),
                    }
                    break
                continue

            state.input_tokens += in_tok
            state.output_tokens += out_tok
            state.transcript.append({"agent": agent.name, "content": content})

            if agent.name == "portfolio_manager":
                final_decision = _parse_decision(content)

            yield {
                "type": "agent.message",
                "agent": agent.name,
                "phase": agent.phase,
                "content": content,
            }

            # Emit a running-total cost.usage event after every agent message
            # so the renderer can tick a live spend pill mid-stream. OAuth +
            # local runs are billed at $0 (subscription / on-device); flag
            # via `free=true` so the UI can render "$0.0000 · subscription"
            # instead of an alarmingly-static number.
            free = config.auth_kind in ("oauth", "local")
            running_cost = (
                0.0
                if free
                else estimate_cost(
                    config.model, state.input_tokens, state.output_tokens
                )
            )
            yield {
                "type": "cost.usage",
                "input_tokens": state.input_tokens,
                "output_tokens": state.output_tokens,
                "est_cost_usd": round(running_cost, 4),
                "free": free,
            }

        cost = estimate_cost(config.model, state.input_tokens, state.output_tokens)
        duration = time.time() - started_at
        sys.stderr.write(
            f"[live_debate] provider={config.provider} auth={config.auth_kind} "
            f"ticker={ticker} model={config.model} "
            f"in_tokens={state.input_tokens} out_tokens={state.output_tokens} "
            f"est_cost_usd={cost:.4f} duration_s={duration:.1f}\n"
        )
        sys.stderr.flush()

        if final_decision is None:
            final_decision = {
                "stance": "neutral",
                "conviction": 0.5,
                "bull_strength": 50,
                "bear_strength": 50,
                "risk_level": "moderate",
                "reasoning": (
                    "Live debate finished without an explicit committee "
                    "assessment. Defaulting to a neutral stance."
                ),
            }

        yield {
            "type": "session.complete",
            "ticker": ticker,
            "trade_date": trade_date,
            "decision": final_decision,
            "live": True,
            "provider": config.provider,
            "auth_kind": config.auth_kind,
            "model": config.model,
            "input_tokens": state.input_tokens,
            "output_tokens": state.output_tokens,
            # OAuth (subscription) and local LLM runs both record 0 so the
            # cost ledger only reflects per-token API spend. Tokens still
            # recorded above for telemetry.
            "estimated_cost_usd": (
                0.0
                if config.auth_kind in ("oauth", "local")
                else round(cost, 4)
            ),
        }
        yielded_complete = True
    finally:
        # Best-effort adapter cleanup. Runs on normal exit AND on
        # GeneratorExit (client disconnect mid-stream) — without this the
        # pooled httpx client inside Anthropic / OpenAI adapters leaks for
        # the engine process lifetime.
        try:
            await adapter.close()
        except Exception:  # noqa: BLE001 — cleanup is best-effort
            pass
        # Finalize the CostGuard reservation regardless of how we exited.
        # Imported lazily so test setups that don't hit cost_guard don't
        # pay the import cost.
        if reservation_id:
            try:
                from . import cost_guard as _cost_guard

                # Bill the actual partial cost on early exit; full cost on
                # normal completion. OAuth always finalizes at 0.0.
                final_cost = (
                    0.0
                    if config.auth_kind == "oauth"
                    else estimate_cost(
                        config.model, state.input_tokens, state.output_tokens
                    )
                )
                _cost_guard.finalize_reservation(
                    reservation_id, actual_cost_usd=final_cost
                )
            except Exception as exc:  # noqa: BLE001 — finalize is best-effort
                sys.stderr.write(
                    f"[live_debate] cost_guard finalize failed: "
                    f"{type(exc).__name__}: {exc}\n"
                )
        if not yielded_complete:
            sys.stderr.write(
                f"[live_debate] disconnected mid-stream provider={config.provider} "
                f"ticker={ticker} agents_completed={len(state.transcript)}\n"
            )
            sys.stderr.flush()
