"""Shared stance vocabulary for the committee-assessment model.

The app deliberately does not emit trade directives (buy/sell/hold). The
final output is an ANALYTICAL stance: how the simulated research committee
reads the balance of evidence. Any investment decision belongs to the user.

This module is the single source of truth for the stance strings on the
wire, their human-readable labels, and the mapping of legacy values
(BUY/SELL/HOLD rows persisted before the relabel) into the new vocabulary.
"""
from __future__ import annotations

# Wire values, most to least constructive.
STANCES = (
    "bullish",
    "moderately_bullish",
    "neutral",
    "moderately_bearish",
    "bearish",
)

RISK_LEVELS = ("low", "moderate", "elevated")

_DISPLAY = {
    "bullish": "Bullish",
    "moderately_bullish": "Moderately bullish",
    "neutral": "Neutral",
    "moderately_bearish": "Moderately bearish",
    "bearish": "Bearish",
}

# Sessions persisted before the stance model stored trade-action strings.
_LEGACY = {
    "BUY": "bullish",
    "SELL": "bearish",
    "HOLD": "neutral",
}


def normalize_stance(value: object) -> str:
    """Coerce a stored or wire value (including legacy BUY/SELL/HOLD) to a
    canonical stance string. Unknown values read as neutral."""
    raw = str(value or "").strip()
    if raw.lower() in STANCES:
        return raw.lower()
    return _LEGACY.get(raw.upper(), "neutral")


def stance_label(value: object) -> str:
    """Human-readable label for a stance (legacy values included)."""
    return _DISPLAY[normalize_stance(value)]


def decision_stance(decision: dict) -> str:
    """Canonical stance from a decision dict, tolerating legacy shapes."""
    if "stance" in decision:
        return normalize_stance(decision.get("stance"))
    return normalize_stance(decision.get("action"))


def decision_conviction(decision: dict) -> float:
    """Conviction 0..1 from a decision dict, tolerating legacy shapes."""
    try:
        return float(decision.get("conviction", decision.get("confidence", 0.0)))
    except (TypeError, ValueError):
        return 0.0
