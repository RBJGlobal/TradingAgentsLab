"""Canned multi-agent debate sequence.

Mirrors the shape of events the real tradingagents pipeline will emit:
session.start → analysts → researchers → trader → risk → session.complete.

Each event includes a `_delay` field (popped before send) controlling how long
to wait before sending the NEXT event — enough for the UI to feel "live"
without dragging.

Phase 5 added optional `summary` injection: when a `QuoteSummary` is provided,
analyst messages reference real numbers (last close, period change, volume)
instead of opaque placeholders. When unavailable (network down, ticker not
recognized), messages fall back to the original purely canned form.
"""

from __future__ import annotations

from typing import Iterator, Optional

from .data_providers import Headline, QuoteSummary


def canned_debate(
    *,
    ticker: str,
    trade_date: str,
    summary: Optional[QuoteSummary] = None,
    headlines: Optional[list[Headline]] = None,
) -> Iterator[dict]:
    yield {
        "type": "session.start",
        "ticker": ticker,
        "trade_date": trade_date,
        "_delay": 0.5,
    }

    yield {
        "type": "agent.message",
        "agent": "technical_analyst",
        "phase": "analysts",
        "content": _technical_message(ticker, summary),
        "_delay": 0.6,
    }

    yield {
        "type": "agent.message",
        "agent": "fundamental_analyst",
        "phase": "analysts",
        "content": _fundamental_message(ticker, summary),
        "_delay": 0.6,
    }

    yield {
        "type": "agent.message",
        "agent": "news_analyst",
        "phase": "analysts",
        "content": _news_message(ticker, trade_date, headlines),
        "_delay": 0.6,
    }

    yield {
        "type": "agent.message",
        "agent": "sentiment_analyst",
        "phase": "analysts",
        "content": (
            f"[STUB] Social/retail sentiment on {ticker}: marginally positive but "
            f"low conviction. Mention volume below 30-day average."
        ),
        "_delay": 0.5,
    }

    yield {
        "type": "phase.transition",
        "from": "analysts",
        "to": "researchers",
        "_delay": 0.3,
    }

    yield {
        "type": "agent.message",
        "agent": "bull_researcher",
        "phase": "researchers",
        "content": _bull_message(ticker, summary),
        "_delay": 0.6,
    }

    yield {
        "type": "agent.message",
        "agent": "bear_researcher",
        "phase": "researchers",
        "content": _bear_message(ticker, summary),
        "_delay": 0.6,
    }

    yield {
        "type": "agent.message",
        "agent": "research_manager",
        "phase": "researchers",
        "content": (
            f"[STUB] Research judgment: insufficient asymmetry to favor either side. "
            f"Neutral read; re-evaluate on next earnings or technical break."
        ),
        "_delay": 0.5,
    }

    yield {
        "type": "phase.transition",
        "from": "researchers",
        "to": "trader",
        "_delay": 0.3,
    }

    yield {
        "type": "agent.message",
        "agent": "trader",
        "phase": "trader",
        "content": _trader_message(ticker, summary),
        "_delay": 0.5,
    }

    yield {
        "type": "phase.transition",
        "from": "trader",
        "to": "risk",
        "_delay": 0.3,
    }

    yield {
        "type": "agent.message",
        "agent": "risk_aggressive",
        "phase": "risk",
        "content": "[STUB] Aggressive view: take the small starter — opportunity cost matters.",
        "_delay": 0.4,
    }

    yield {
        "type": "agent.message",
        "agent": "risk_conservative",
        "phase": "risk",
        "content": "[STUB] Conservative view: stay on the sidelines until a clean signal emerges.",
        "_delay": 0.4,
    }

    yield {
        "type": "agent.message",
        "agent": "risk_neutral",
        "phase": "risk",
        "content": "[STUB] Neutral view: neutrality is the lowest-regret read here.",
        "_delay": 0.4,
    }

    yield {
        "type": "agent.message",
        "agent": "portfolio_manager",
        "phase": "risk",
        "content": (
            f"[STUB] Committee assessment on {ticker}: NEUTRAL. Final."
        ),
        "_delay": 0.5,
    }

    yield {
        "type": "session.complete",
        "ticker": ticker,
        "trade_date": trade_date,
        "decision": {
            "stance": "neutral",
            "conviction": 0.55,
            "bull_strength": 50,
            "bear_strength": 50,
            "risk_level": "moderate",
            "reasoning": (
                _decision_reasoning(summary) if summary else
                "Stub canned debate — replaced in Phase 3+ by real agents."
            ),
        },
        "_delay": 0,
    }


def _news_message(
    ticker: str, trade_date: str, headlines: Optional[list[Headline]]
) -> str:
    if not headlines:
        return (
            f"[STUB] News scan around {trade_date}: no company-specific catalysts "
            f"surfaced. Sector-level headlines neutral, macro backdrop steady."
        )
    lines = [
        f"[STUB · yfinance news] {len(headlines)} recent headlines reviewed for "
        f"{ticker}; the headline-only summary is enough for the stub. Real "
        f"sentiment analysis lands when the agent layer goes live.",
        "",
    ]
    for h in headlines[:4]:
        publisher = h.publisher or "unknown"
        lines.append(f"• {h.title} ({publisher})")
    return "\n".join(lines)


def _technical_message(ticker: str, summary: Optional[QuoteSummary]) -> str:
    if summary is None:
        return (
            f"[STUB · data offline] Technical setup on {ticker}: price action "
            f"consolidating in a tightening range over the past 10 sessions. "
            f"RSI neutral at 52, MACD histogram flattening. No decisive breakout."
        )
    direction = "up" if summary.period_change_pct >= 0 else "down"
    pct = abs(summary.period_change_pct)
    return (
        f"[STUB · {summary.source}] Technical setup on {summary.ticker} "
        f"(as of {summary.as_of}): last close {summary.last_close:.2f}, "
        f"{pct:.2f}% {direction} over the {summary.sessions}-session window "
        f"(range {summary.period_low:.2f}–{summary.period_high:.2f}). "
        f"Avg daily volume ≈ {int(summary.avg_volume):,}. RSI/MACD analysis "
        f"will land when the agent layer goes live."
    )


def _fundamental_message(ticker: str, summary: Optional[QuoteSummary]) -> str:
    if summary is None:
        return (
            f"[STUB] Fundamentals review for {ticker}: revenue growth steady, "
            f"margin profile intact. Forward P/E in line with sector median. "
            f"No material balance sheet changes since last earnings."
        )
    return (
        f"[STUB] Fundamentals review for {summary.ticker}: detailed earnings, "
        f"margin, and balance-sheet analysis lands when the fundamentals tool "
        f"is wired in. For now, anchoring on the quoted last close of "
        f"{summary.last_close:.2f}."
    )


def _bull_message(ticker: str, summary: Optional[QuoteSummary]) -> str:
    if summary is None:
        return (
            f"[STUB] Bull case: consolidation absorbs supply ahead of next leg up. "
            f"Fundamentals support a re-rating if sector rotation favors growth."
        )
    if summary.period_change_pct >= 0:
        return (
            f"[STUB] Bull case for {summary.ticker}: trend is constructive — up "
            f"{summary.period_change_pct:.2f}% over {summary.sessions} sessions. "
            f"Continuation thesis intact while {summary.last_close:.2f} holds above "
            f"period open of {summary.period_open:.2f}."
        )
    return (
        f"[STUB] Bull case for {summary.ticker}: counter-trend bounce setup — "
        f"price is {summary.period_change_pct:.2f}% off the period open of "
        f"{summary.period_open:.2f}. Mean reversion candidates favor the long side "
        f"on a hold of the {summary.period_low:.2f} low."
    )


def _bear_message(ticker: str, summary: Optional[QuoteSummary]) -> str:
    if summary is None:
        return (
            f"[STUB] Bear case: lack of catalyst risks further chop. Valuation "
            f"already pricing in the steady-state. Drawdown risk if sentiment turns."
        )
    if summary.period_change_pct < 0:
        return (
            f"[STUB] Bear case for {summary.ticker}: trend is broken — down "
            f"{abs(summary.period_change_pct):.2f}% over {summary.sessions} "
            f"sessions. Lower-low bias intact below {summary.period_open:.2f}; "
            f"target the {summary.period_low:.2f} sweep before any re-entry."
        )
    return (
        f"[STUB] Bear case for {summary.ticker}: extension risk after a "
        f"{summary.period_change_pct:.2f}% rally over {summary.sessions} sessions. "
        f"At {summary.last_close:.2f} the move is mature; pullback to the "
        f"{summary.period_open:.2f} period open is a reasonable expectation."
    )


def _trader_message(ticker: str, summary: Optional[QuoteSummary]) -> str:
    if summary is None:
        return (
            f"[STUB] Hypothetical structure for {ticker}: setup does not look "
            f"actionable, no new exposure warranted. If the picture improved, a "
            f"small starter with invalidation below the consolidation low would "
            f"be the shape."
        )
    return (
        f"[STUB] Hypothetical structure for {summary.ticker} (ref "
        f"{summary.last_close:.2f}): setup does not look actionable, no new "
        f"exposure warranted. A constructive shape would be strength above the "
        f"period open {summary.period_open:.2f} with the thesis invalidated on "
        f"a daily close below the {summary.period_low:.2f} low."
    )


def _decision_reasoning(summary: QuoteSummary) -> str:
    direction = "up" if summary.period_change_pct >= 0 else "down"
    return (
        f"Stub canned debate using real {summary.source} quotes — replaced in "
        f"Phase 3+ by real agents. Anchor: {summary.ticker} last close "
        f"{summary.last_close:.2f} as of {summary.as_of}, "
        f"{abs(summary.period_change_pct):.2f}% {direction} over "
        f"{summary.sessions} sessions."
    )
