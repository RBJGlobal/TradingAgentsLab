"""Live model discovery for the API-key providers.

Why this module exists
----------------------
The model pickers used to be lists baked into each build. Providers ship and
retire models far more often than we ship releases, so the lists went stale
(the founder's 2026-11-11 report: new Claude models missing, four entries for
OpenRouter's hundreds). The OpenAI OAuth path already solved this with
``engine/codex_models.py``; this module applies the same pattern to every
provider a user can configure with an API key:

- ask the provider's own ``/models`` endpoint which models exist right now,
- keep the selection rules in pure ``parse_*`` functions (unit-testable with
  fixture JSON, no network),
- cache the answer for 15 minutes per (provider, key),
- raise ``ProviderModelsUnavailable`` on any failure so the caller can fall
  back to the built-in list in ``STATIC_MODELS``.

Privacy and secrets
-------------------
The engine calls ONLY the provider the user configured, with the key the
renderer sent for this request; the key is never persisted. The cache is
keyed by a SHA-256 of the key, never the raw key. Error strings returned to
the renderer carry the HTTP status and a category only, never the provider's
response body: some providers echo a masked fragment of the key in their 401
body, and that has no business in a UI string or a log line.

Cost safety
-----------
Discovery lets a user pick a model released after this build, which by
definition has no row in ``_COST_PER_M_TOKENS``. ``llm_providers.rates_for``
prices such models at a conservative ceiling so CostGuard never reserves $0
for them. OpenRouter is the one provider whose catalog includes prices; we
register those into the runtime price map so OpenRouter runs are priced at
OpenRouter's real rate instead of the ceiling.
"""

from __future__ import annotations

import hashlib
import re
import sys
import time
from typing import Any, Callable, Optional

import httpx

from .llm_providers import register_runtime_rates

_TIMEOUT_S = 10.0
_CACHE_TTL_S = 15 * 60
# Pagination guard: a buggy or hostile response that always says "more"
# must not loop forever.
_MAX_PAGES = 20

ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
XAI_MODELS_URL = "https://api.x.ai/v1/models"

# Providers with live discovery. MiniMax stays on its curated list, and the
# local provider has its own runtime detection (engine/local_llm_detect.py).
DISCOVERABLE = frozenset({"anthropic", "openai", "openrouter", "gemini", "xai"})


# ---- Built-in lists (fallback) -------------------------------------------
#
# Served when live discovery fails (offline, provider outage, key rejected)
# and for providers without discovery. MIRRORS the renderer's
# `PROVIDER_MODELS` in desktop/src/lib/engine-client.ts; a test
# (test_provider_models.py) fails if the two id lists drift apart.
# Every native id here must have a price row (test_catalog_consistency.py).

STATIC_MODELS: dict[str, list[dict[str, Any]]] = {
    "openai": [
        {"id": "gpt-5.5", "label": "gpt-5.5", "note": "Latest frontier, 1M context"},
        {"id": "gpt-5", "label": "gpt-5", "note": "Previous frontier"},
        {"id": "gpt-5-mini", "label": "gpt-5-mini", "note": "Balanced, cost-effective"},
        {"id": "gpt-4o", "label": "gpt-4o", "note": "Multimodal flagship"},
        {"id": "gpt-4o-mini", "label": "gpt-4o-mini", "note": "Cheapest", "recommended": True},
    ],
    "anthropic": [
        {"id": "claude-opus-5-5", "label": "Claude Opus 5.5", "note": "Most capable Opus"},
        {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "note": "Balanced",
         "recommended": True},
        {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5", "note": "Fast and low cost"},
        {"id": "claude-fable-5-2", "label": "Claude Fable 5.2", "note": "Largest model, highest cost"},
        {"id": "claude-opus-4-8", "label": "Claude Opus 4.8", "note": "Previous Opus"},
        {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "note": "Previous Sonnet"},
        {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "note": "Previous Haiku"},
    ],
    # OpenRouter slugs verified against openrouter.ai/api/v1/models on
    # 2026-11-11. OpenRouter writes Claude versions with DOTS
    # (anthropic/claude-opus-5.5), not Anthropic's dashes.
    "openrouter": [
        {"id": "openai/gpt-4o-mini", "label": "OpenAI · gpt-4o-mini", "note": "Cheapest",
         "recommended": True},
        {"id": "openai/gpt-5-mini", "label": "OpenAI · gpt-5-mini", "note": "Balanced"},
        {"id": "anthropic/claude-opus-5.5", "label": "Anthropic · Opus 5.5"},
        {"id": "anthropic/claude-sonnet-5.5", "label": "Anthropic · Sonnet 5.5"},
        {"id": "anthropic/claude-haiku-5.5", "label": "Anthropic · Haiku 5.5"},
        {"id": "google/gemini-2.5-flash", "label": "Google · Gemini 2.5 Flash"},
    ],
    "gemini": [
        {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "note": "Most capable"},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "note": "Balanced"},
        {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite",
         "note": "Most cost-efficient (GA)"},
        {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "note": "Cheapest",
         "recommended": True},
    ],
    "xai": [
        {"id": "grok-4.3", "label": "Grok 4.3", "note": "Current flagship, fastest",
         "recommended": True},
        {"id": "grok-4.20-reasoning", "label": "Grok 4.20 (reasoning)",
         "note": "Reasoning-optimized"},
        {"id": "grok-4.20-non-reasoning", "label": "Grok 4.20 (non-reasoning)",
         "note": "Speed-optimized"},
    ],
    "minimax": [
        {"id": "MiniMax-M2.7", "label": "MiniMax M2.7", "note": "Flagship, 204K context"},
        {"id": "MiniMax-M2.7-highspeed", "label": "MiniMax M2.7 Highspeed",
         "note": "Flagship speed (~100 TPS)", "recommended": True},
        {"id": "MiniMax-M2.5", "label": "MiniMax M2.5", "note": "Previous-gen flagship"},
    ],
    "local": [],
}


class ProviderModelsUnavailable(Exception):
    """The provider's model list could not be fetched or parsed."""


def static_models(provider: str) -> list[dict[str, Any]]:
    """Copy of the built-in list, so callers can't mutate the module copy."""
    return [dict(m) for m in STATIC_MODELS.get(provider, [])]


def _choice(model_id: str, label: str = "", note: str = "") -> dict[str, Any]:
    """The renderer's ModelChoice shape ({id, label, note})."""
    return {"id": model_id, "label": label or model_id, "note": note}


# ---- Pure parsers (one per provider) --------------------------------------
#
# Each takes the decoded JSON of ONE page and returns picker choices. They
# skip malformed entries rather than failing, but raise when the response
# shape itself is wrong (so we fall back instead of showing an empty list).


def _require_list(body: object, key: str) -> list:
    if not isinstance(body, dict):
        raise ProviderModelsUnavailable("response is not a JSON object")
    raw = body.get(key)
    if not isinstance(raw, list):
        raise ProviderModelsUnavailable(f"response has no '{key}' list")
    return raw


def parse_anthropic(body: object) -> list[dict[str, Any]]:
    """Anthropic ``/v1/models``: keep ``claude-*`` ids, newest first.

    Some ids may be DATED (claude-haiku-4-5-20251001). We keep exactly what
    the API returns: it is a valid id to send, and `rates_for` maps it to
    the alias price row. ``created_at`` is RFC 3339, which sorts correctly
    as a string.
    """
    items = []
    for item in _require_list(body, "data"):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        if not mid.startswith("claude-"):
            continue
        items.append((str(item.get("created_at") or ""), mid,
                      str(item.get("display_name") or mid)))
    items.sort(key=lambda t: t[0], reverse=True)
    return [_choice(mid, label) for _, mid, label in items]


# Substrings that mark OpenAI models a text debate can't use, or tiers whose
# price is far above our ceilings (-pro, deep-research), which would make the
# spend cap dishonest.
_OPENAI_EXCLUDE = (
    "audio", "realtime", "tts", "transcribe", "whisper", "embedding", "image",
    "dall-e", "moderation", "search", "computer-use", "codex", "-pro",
    "deep-research", "instruct",
)
_O_SERIES = re.compile(r"^o\d")


def parse_openai(body: object) -> list[dict[str, Any]]:
    """OpenAI ``/v1/models``: ids only. Keep chat text models (``gpt-*`` and
    the o-series), drop the excluded kinds, newest ``created`` first."""
    items = []
    for item in _require_list(body, "data"):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        low = mid.lower()
        if not (low.startswith("gpt-") or _O_SERIES.match(low)):
            continue
        if any(bad in low for bad in _OPENAI_EXCLUDE):
            continue
        try:
            created = int(item.get("created") or 0)
        except (TypeError, ValueError):
            created = 0
        items.append((created, mid))
    items.sort(key=lambda t: t[0], reverse=True)
    return [_choice(mid) for _, mid in items]


def _per_token_to_per_million(value: object) -> Optional[float]:
    """OpenRouter prices are USD per TOKEN as strings ("0.000003")."""
    try:
        f = float(str(value))
    except (TypeError, ValueError):
        return None
    if f != f or f < 0:  # NaN, or the "-1" OpenRouter uses for routers
        return None
    return f * 1_000_000


def parse_openrouter(body: object) -> tuple[list[dict[str, Any]], dict[str, dict[str, float]]]:
    """OpenRouter ``/api/v1/models``: returns ``(choices, rates)``.

    Keeps text-output models with a usable price. ``rates`` maps each kept
    id to its per-1M price. Where a model has tiered pricing
    (``pricing.overrides``, e.g. a higher rate above 100K-token prompts) we
    keep the HIGHEST tier: the rate is used as a ceiling.

    Dropped on purpose:
    - negative prices (OpenRouter's auto-routers report -1: the real price
      depends on the model they pick, so we can't reserve for them honestly)
    - ``:batch`` variants (asynchronous batch pricing, not a live debate)
    - ``openai/*`` ids matching the direct-OpenAI exclusions (``-pro``,
      audio, image, codex, ...)
    """
    choices: list[dict[str, Any]] = []
    rates: dict[str, dict[str, float]] = {}
    for item in _require_list(body, "data"):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        if not mid or mid.endswith(":batch"):
            continue
        vendor, _, name = mid.partition("/")
        if vendor == "openai" and any(bad in name.lower() for bad in _OPENAI_EXCLUDE):
            # Same exclusions as direct OpenAI. The -pro tiers in particular
            # cost far more than the gpt family ceiling (e.g. 30/180 per 1M),
            # so after an engine restart, before this catalog's prices are
            # re-learned, they would be UNDER-reserved.
            continue
        arch = item.get("architecture")
        if isinstance(arch, dict) and isinstance(arch.get("output_modalities"), list):
            if "text" not in arch["output_modalities"]:
                continue
        pricing = item.get("pricing")
        if not isinstance(pricing, dict):
            continue
        p_in = _per_token_to_per_million(pricing.get("prompt"))
        p_out = _per_token_to_per_million(pricing.get("completion"))
        if p_in is None or p_out is None:
            continue
        for tier in pricing.get("overrides") or []:
            if not isinstance(tier, dict):
                continue
            t_in = _per_token_to_per_million(tier.get("prompt"))
            t_out = _per_token_to_per_million(tier.get("completion"))
            if t_in is not None:
                p_in = max(p_in, t_in)
            if t_out is not None:
                p_out = max(p_out, t_out)
        note_parts = []
        try:
            ctx = int(item.get("context_length") or 0)
        except (TypeError, ValueError):
            ctx = 0
        if ctx >= 1000:
            note_parts.append(f"{ctx // 1000}K context")
        note_parts.append(f"${p_in:g}/${p_out:g} per 1M tokens")
        choices.append(_choice(mid, str(item.get("name") or mid), ", ".join(note_parts)))
        rates[mid] = {"input": p_in, "output": p_out}
    return choices, rates


_GEMINI_EXCLUDE = ("embedding", "image", "tts", "live", "aqa")


def parse_gemini(body: object) -> list[dict[str, Any]]:
    """Gemini ``/v1beta/models``: keep ``models/gemini-*`` that support
    ``generateContent``; strip the ``models/`` prefix; drop the excluded
    kinds. API order is kept (it has no creation date)."""
    out = []
    for item in _require_list(body, "models"):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name.startswith("models/gemini-"):
            continue
        methods = item.get("supportedGenerationMethods")
        if not isinstance(methods, list) or "generateContent" not in methods:
            continue
        mid = name[len("models/"):]
        if any(bad in mid.lower() for bad in _GEMINI_EXCLUDE):
            continue
        out.append(_choice(mid, str(item.get("displayName") or mid)))
    return out


_XAI_EXCLUDE = ("image", "vision", "imagine")


def parse_xai(body: object) -> list[dict[str, Any]]:
    """xAI ``/v1/models`` (OpenAI-compatible): keep ``grok-*`` text models,
    newest ``created`` first."""
    items = []
    for item in _require_list(body, "data"):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "").strip()
        low = mid.lower()
        if not low.startswith("grok-") or any(bad in low for bad in _XAI_EXCLUDE):
            continue
        try:
            created = int(item.get("created") or 0)
        except (TypeError, ValueError):
            created = 0
        items.append((created, mid))
    items.sort(key=lambda t: t[0], reverse=True)
    return [_choice(mid) for _, mid in items]


# ---- Network ----------------------------------------------------------------


def _http_error(status: int) -> ProviderModelsUnavailable:
    """Status + category only. The body is deliberately NOT included (see the
    module docstring: some providers echo part of the key on a 401)."""
    if status in (401, 403):
        category = "key rejected"
    elif status == 429:
        category = "rate limited"
    elif status >= 500:
        category = "provider error"
    else:
        category = "request failed"
    return ProviderModelsUnavailable(f"{category} (HTTP {status})")


async def _get_json(client: httpx.AsyncClient, url: str, *,
                    headers: dict[str, str], params: Optional[dict] = None) -> object:
    try:
        resp = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        # Exception TYPE only: httpx messages can include the request URL.
        raise ProviderModelsUnavailable(f"request failed: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        raise _http_error(resp.status_code)
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderModelsUnavailable("response was not valid JSON") from exc


async def _fetch_anthropic(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    params: dict[str, Any] = {"limit": 1000}
    out: list[dict[str, Any]] = []
    for _ in range(_MAX_PAGES):
        body = await _get_json(client, ANTHROPIC_MODELS_URL, headers=headers, params=params)
        out.extend(parse_anthropic(body))  # raises unless body is a dict
        last_id = body.get("last_id") if isinstance(body, dict) else None
        if not (isinstance(body, dict) and body.get("has_more")) or not last_id:
            break
        params = {"limit": 1000, "after_id": last_id}
    # Each page is sorted newest first, and Anthropic pages newest first, so
    # the concatenation is newest first too. (With limit=1000 there is
    # normally a single page.)
    return out


async def _fetch_openai(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    body = await _get_json(client, OPENAI_MODELS_URL,
                           headers={"Authorization": f"Bearer {api_key}"})
    return parse_openai(body)


async def _fetch_openrouter(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    # The endpoint is public, but we only call it for a user who configured
    # OpenRouter, and we send their key like every other OpenRouter request.
    body = await _get_json(client, OPENROUTER_MODELS_URL,
                           headers={"Authorization": f"Bearer {api_key}"})
    choices, rates = parse_openrouter(body)
    for mid, r in rates.items():
        register_runtime_rates(mid, input_per_m=r["input"], output_per_m=r["output"])
    return choices


async def _fetch_gemini(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    # The key goes in the documented `x-goog-api-key` header rather than the
    # `?key=` query parameter, so it can never appear in a URL (and therefore
    # never in an httpx exception message or a log line).
    headers = {"x-goog-api-key": api_key}
    params: dict[str, Any] = {"pageSize": 1000}
    out: list[dict[str, Any]] = []
    for _ in range(_MAX_PAGES):
        body = await _get_json(client, GEMINI_MODELS_URL, headers=headers, params=params)
        out.extend(parse_gemini(body))  # raises unless body is a dict
        token = body.get("nextPageToken") if isinstance(body, dict) else None
        if not token:
            break
        params = {"pageSize": 1000, "pageToken": token}
    return out


async def _fetch_xai(client: httpx.AsyncClient, api_key: str) -> list[dict[str, Any]]:
    body = await _get_json(client, XAI_MODELS_URL,
                           headers={"Authorization": f"Bearer {api_key}"})
    return parse_xai(body)


_FETCHERS: dict[str, Callable[[httpx.AsyncClient, str], Any]] = {
    "anthropic": _fetch_anthropic,
    "openai": _fetch_openai,
    "openrouter": _fetch_openrouter,
    "gemini": _fetch_gemini,
    "xai": _fetch_xai,
}

# (provider, sha256(api_key)) -> (fetched_at_monotonic, models)
_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


def _cache_key(provider: str, api_key: str) -> tuple[str, str]:
    return provider, hashlib.sha256(api_key.encode("utf-8")).hexdigest()


async def list_provider_models(
    provider: str, api_key: str, *, force_refresh: bool = False
) -> list[dict[str, Any]]:
    """Models this provider offers this key right now, as picker choices.

    Providers without discovery (minimax, local) get the built-in list.
    Raises ``ProviderModelsUnavailable`` on any failure, or when filtering
    leaves nothing; the caller decides whether to fall back. Cached for 15
    minutes per (provider, key); ``force_refresh`` bypasses the cache (the
    picker's Refresh button).
    """
    if provider not in DISCOVERABLE:
        return static_models(provider)
    if not api_key:
        raise ProviderModelsUnavailable("missing API key")

    key = _cache_key(provider, api_key)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached and not force_refresh and now - cached[0] < _CACHE_TTL_S:
        return [dict(m) for m in cached[1]]

    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        models = await _FETCHERS[provider](client, api_key)
    if not models:
        raise ProviderModelsUnavailable("provider listed no usable models")

    _cache[key] = (now, models)
    # Count only: never the key, and the ids are long for OpenRouter.
    sys.stderr.write(f"[provider-models] OK provider={provider} models={len(models)}\n")
    return [dict(m) for m in models]


def _reset_cache_for_tests() -> None:
    _cache.clear()
