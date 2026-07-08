"""Catalog-consistency guards (added 2026-05-28 after the provider audit).

These tests prevent the *internal* drift that the May 2026 audit flagged as
the top structural risk: the model catalog now lives in several parallel maps
(engine ``_DEFAULT_MODELS`` / ``_COST_PER_M_TOKENS`` / ``_ALLOWED_PROVIDERS``
and the renderer's ``PROVIDER_MODELS`` picker), and nothing stopped them from
silently disagreeing. The concrete failure they catch:

  A model is offered in the renderer picker (or set as a provider default) but
  has no row in ``_COST_PER_M_TOKENS`` -> CostGuard reserves $0 for it (the
  "unknown model" path) -> the per-run budget cap silently can't see its cost.

What these tests do NOT catch is *vendor* staleness: a model ID that is
internally consistent here but has been deprecated or renamed by the provider
(e.g. xAI retiring grok-4-fast-* on 2026-05-15). That class of drift is caught
by the periodic upstream check (``tools/upstream-check.sh``) and audits like
the one that produced this file, not by a unit test. Layered defense:
consistency test (here) + upstream check + periodic audit.
"""

from __future__ import annotations

import re
from pathlib import Path

from engine.llm_providers import (
    _ALLOWED_PROVIDERS,
    _COST_PER_M_TOKENS,
    _DEFAULT_MODELS,
    ProviderConfig,
    adapter_for,
)

# Defaults that are intentionally NOT in the cost table:
#   - openrouter: passthrough, real cost depends on the underlying model.
#   - local: billed by the user's own runtime, never by us.
_POLICY_ZERO_DEFAULTS = {"openrouter", "local"}

_ENGINE_CLIENT_TS = (
    Path(__file__).resolve().parents[2] / "desktop" / "src" / "lib" / "engine-client.ts"
)


def test_every_default_model_is_priced_or_policy_zero():
    """The model a user gets with no explicit pick must always have a cost row
    (or be a documented policy-$0 provider), so default-config runs reserve a
    real dollar amount."""
    for provider, model in _DEFAULT_MODELS.items():
        if provider in _POLICY_ZERO_DEFAULTS:
            continue
        assert model in _COST_PER_M_TOKENS, (
            f"default model for {provider!r} ({model!r}) has no cost row — a "
            f"default-config run would silently reserve $0"
        )


def test_every_allowed_provider_has_an_adapter():
    """Every provider on the allowlist must dispatch to a real adapter. Guards
    against adding a provider to _DEFAULT_MODELS without an adapter_for branch
    (e.g. if a gateway provider lands)."""
    auth_by_provider = {
        "openai": {"type": "api_key", "api_key": "k"},
        "anthropic": {"type": "api_key", "api_key": "k"},
        "openrouter": {"type": "api_key", "api_key": "k"},
        "gemini": {"type": "api_key", "api_key": "k"},
        "xai": {"type": "api_key", "api_key": "k"},
        "minimax": {"type": "api_key", "api_key": "k"},
        "local": {"type": "local", "base_url": "http://localhost:11434/v1"},
    }
    for provider in _ALLOWED_PROVIDERS:
        assert provider in auth_by_provider, (
            f"new provider {provider!r} is on the allowlist but this test "
            f"doesn't know how to build a config for it — extend auth_by_provider"
        )
        cfg = ProviderConfig.from_dict(
            {"provider": provider, "auth": auth_by_provider[provider]}
        )
        assert cfg is not None, f"{provider!r} config failed to validate"
        adapter = adapter_for(cfg)  # raises ValueError if no dispatch branch
        assert adapter.name, f"{provider!r} adapter has no name"


def _picker_model_ids() -> list[str]:
    """Extract every model id from the renderer's PROVIDER_MODELS block."""
    src = _ENGINE_CLIENT_TS.read_text(encoding="utf-8")
    start = src.index("export const PROVIDER_MODELS")
    # The block ends at the next top-level declaration.
    tail = src[start:]
    end = tail.index("\nexport const", len("export const PROVIDER_MODELS"))
    block = tail[:end]
    return re.findall(r"id:\s*'([^']+)'", block)


def test_every_native_picker_model_is_priced():
    """Cross-file guard: every native model offered in the renderer picker has
    an engine cost row. OpenRouter passthroughs (ids containing '/') are exempt
    by policy — their cost depends on the underlying routed model."""
    if not _ENGINE_CLIENT_TS.exists():
        # Engine-only checkout (no desktop tree) — nothing to cross-check.
        import pytest

        pytest.skip(f"renderer source not present at {_ENGINE_CLIENT_TS}")

    ids = _picker_model_ids()
    assert ids, "failed to parse any model ids from PROVIDER_MODELS"
    native = [m for m in ids if "/" not in m]
    missing = [m for m in native if m not in _COST_PER_M_TOKENS]
    assert not missing, (
        f"renderer picker offers native model(s) with no engine cost row "
        f"(they would silently reserve $0): {missing}"
    )
