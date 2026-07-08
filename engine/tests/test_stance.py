"""Unit tests for engine/stance.py — the single source of truth for the
analytical stance vocabulary.

Covers:
- normalize_stance: legacy BUY/SELL/HOLD mapping
- normalize_stance: unknown value → neutral
- normalize_stance: native stance strings (case-insensitive)
- stance_label: human-readable display strings for all five stances
- decision_stance: reads new-shape and legacy-shape decision dicts
- decision_conviction: reads new-shape and legacy-shape dicts, invalid/missing
"""

from __future__ import annotations

import pytest

from engine.stance import (
    STANCES,
    decision_conviction,
    decision_stance,
    normalize_stance,
    stance_label,
)


# ---- normalize_stance -------------------------------------------------------


class TestNormalizeStance:
    def test_legacy_buy_maps_to_bullish(self):
        assert normalize_stance("BUY") == "bullish"

    def test_legacy_sell_maps_to_bearish(self):
        assert normalize_stance("SELL") == "bearish"

    def test_legacy_hold_maps_to_neutral(self):
        assert normalize_stance("HOLD") == "neutral"

    def test_legacy_is_case_insensitive(self):
        assert normalize_stance("buy") == "bullish"
        assert normalize_stance("Sell") == "bearish"
        assert normalize_stance("hold") == "neutral"

    def test_unknown_value_maps_to_neutral(self):
        assert normalize_stance("STRONG_BUY") == "neutral"
        assert normalize_stance("ACCUMULATE") == "neutral"
        assert normalize_stance("") == "neutral"
        assert normalize_stance(None) == "neutral"
        assert normalize_stance(42) == "neutral"

    def test_native_bullish(self):
        assert normalize_stance("bullish") == "bullish"

    def test_native_bearish(self):
        assert normalize_stance("bearish") == "bearish"

    def test_native_neutral(self):
        assert normalize_stance("neutral") == "neutral"

    def test_native_moderately_bullish(self):
        assert normalize_stance("moderately_bullish") == "moderately_bullish"

    def test_native_moderately_bearish(self):
        assert normalize_stance("moderately_bearish") == "moderately_bearish"

    def test_native_stances_are_case_insensitive(self):
        assert normalize_stance("BULLISH") == "bullish"
        assert normalize_stance("Bearish") == "bearish"
        assert normalize_stance("NEUTRAL") == "neutral"
        assert normalize_stance("Moderately_Bullish") == "moderately_bullish"
        assert normalize_stance("MODERATELY_BEARISH") == "moderately_bearish"

    def test_covers_all_canonical_stances(self):
        for s in STANCES:
            assert normalize_stance(s) == s


# ---- stance_label -----------------------------------------------------------


class TestStanceLabel:
    def test_bullish_label(self):
        assert stance_label("bullish") == "Bullish"

    def test_bearish_label(self):
        assert stance_label("bearish") == "Bearish"

    def test_neutral_label(self):
        assert stance_label("neutral") == "Neutral"

    def test_moderately_bullish_label(self):
        assert stance_label("moderately_bullish") == "Moderately bullish"

    def test_moderately_bearish_label(self):
        assert stance_label("moderately_bearish") == "Moderately bearish"

    def test_legacy_buy_label(self):
        # BUY → bullish → "Bullish"
        assert stance_label("BUY") == "Bullish"

    def test_legacy_sell_label(self):
        assert stance_label("SELL") == "Bearish"

    def test_legacy_hold_label(self):
        assert stance_label("HOLD") == "Neutral"

    def test_unknown_falls_back_to_neutral_label(self):
        assert stance_label("WHATEVER") == "Neutral"


# ---- decision_stance --------------------------------------------------------


class TestDecisionStance:
    def test_new_shape_stance_key(self):
        d = {"stance": "bullish", "conviction": 0.78}
        assert decision_stance(d) == "bullish"

    def test_new_shape_moderately_bearish(self):
        d = {"stance": "moderately_bearish", "conviction": 0.4}
        assert decision_stance(d) == "moderately_bearish"

    def test_legacy_shape_action_key(self):
        d = {"action": "BUY", "confidence": 0.72}
        assert decision_stance(d) == "bullish"

    def test_legacy_hold_maps_to_neutral(self):
        d = {"action": "HOLD", "confidence": 0.5}
        assert decision_stance(d) == "neutral"

    def test_legacy_sell_maps_to_bearish(self):
        d = {"action": "SELL", "confidence": 0.6}
        assert decision_stance(d) == "bearish"

    def test_prefers_stance_over_action_when_both_present(self):
        d = {"stance": "bearish", "action": "BUY"}
        assert decision_stance(d) == "bearish"

    def test_missing_keys_defaults_to_neutral(self):
        assert decision_stance({}) == "neutral"


# ---- decision_conviction ----------------------------------------------------


class TestDecisionConviction:
    def test_new_shape_conviction_key(self):
        d = {"stance": "bullish", "conviction": 0.78}
        assert decision_conviction(d) == pytest.approx(0.78)

    def test_legacy_shape_confidence_key(self):
        d = {"action": "BUY", "confidence": 0.72}
        assert decision_conviction(d) == pytest.approx(0.72)

    def test_prefers_conviction_over_confidence_when_both_present(self):
        d = {"conviction": 0.9, "confidence": 0.5}
        assert decision_conviction(d) == pytest.approx(0.9)

    def test_missing_keys_defaults_to_zero(self):
        assert decision_conviction({}) == pytest.approx(0.0)

    def test_invalid_value_defaults_to_zero(self):
        assert decision_conviction({"conviction": "not-a-number"}) == pytest.approx(0.0)
        assert decision_conviction({"conviction": None}) == pytest.approx(0.0)

    def test_string_float_is_coerced(self):
        assert decision_conviction({"conviction": "0.65"}) == pytest.approx(0.65)
