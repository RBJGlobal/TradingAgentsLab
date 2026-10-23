"""Live model discovery for the OpenAI OAuth (Codex / ChatGPT-account) path.

Why this module exists
----------------------
ChatGPT-account OAuth runs go through OpenAI's Codex backend
(``chatgpt.com/backend-api/codex``), and that backend only accepts the models
currently entitled for ChatGPT sign-in. OpenAI retires and replaces those
models on its own schedule: in 2026 the whole gpt-5.x line was retired from
ChatGPT sign-in (the codex variants in June, gpt-5.4 / gpt-5.4-mini on Aug 31,
gpt-5.5 on Oct 14). A hardcoded model list therefore breaks in production
every time OpenAI moves, with ``400 "The '<model>' model is not supported when
using Codex with a ChatGPT account."``

Instead of hardcoding, we ask the backend which models this account can use
right now, the same way OpenAI's own Codex CLI does:

    GET https://chatgpt.com/backend-api/codex/models?client_version=<v>
    -> {"models": [{"slug", "display_name", "description",
                    "visibility": "list" | "hide" | "none",
                    "priority": int, ...}, ...]}

Selection mirrors the Codex CLI (codex-rs models-manager):
sort by ``priority`` ascending, keep only ``visibility == "list"`` models
(``hide`` / ``none`` entries exist in the catalog but are not meant to be
picked), and the first remaining model is the default.

Scope line (be honest about what this does NOT cover): discovery removes the
need for an app release when OpenAI adds or retires MODELS. It does not
protect against OpenAI changing the Codex API shape itself, or against the
``client_version`` gate below aging out.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from typing import Optional

import httpx

# Same backend + client identity the Lite app's OpenAICodexAdapter uses for
# /responses (engine/llm_providers.py), so discovery and inference present one
# consistent client to OpenAI. (Pro keeps these in engine/codex_llm.py.)
CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
_CODEX_HEADERS_BASE = {
    "originator": "pi",
    "User-Agent": "pi (TradingAgentsLab)",
    "OpenAI-Beta": "responses=experimental",
}

CODEX_MODELS_URL = f"{CODEX_BASE_URL}/models"

# ``client_version`` gates the catalog PER MODEL: each model is listed only
# from its own minimum client version upward, so a stale (low) version
# silently hides newer models, and omitting the param is a 400. The gate is a
# minimum, not an exact match (observed: 0.163.0 and 99.0.0 return the same
# set), so we deliberately send a high sentinel. Do NOT "helpfully" pin this
# back to a real Codex release number: a real number ages, and an aged number
# reintroduces exactly the silent-staleness bug this module exists to remove.
# The real-release value is only a retry if the backend ever rejects the
# sentinel itself.
CLIENT_VERSION_SENTINEL = "99.0.0"
CLIENT_VERSION_KNOWN_GOOD = "0.163.0"  # openai/codex rust-v0.163.0, 2026-10-15

_TIMEOUT_S = 10.0
_CACHE_TTL_S = 15 * 60

# Last-resort list, used ONLY when the live catalog cannot be fetched (offline,
# backend outage). Current ChatGPT-sign-in models per OpenAI's Codex model docs
# (2026-10). Order = our preference; the first is the fallback default.
FALLBACK_MODELS: list[dict] = [
    {"id": "gpt-6.1-sol", "label": "gpt-6.1-sol",
     "note": "Strong all-round model, a good default for the debate"},
    {"id": "gpt-6-astra", "label": "gpt-6-astra",
     "note": "Most capable, slower per turn"},
    {"id": "gpt-6-luna", "label": "gpt-6-luna",
     "note": "Fast and focused, lighter reasoning"},
]
FALLBACK_DEFAULT = FALLBACK_MODELS[0]["id"]


class CodexModelsUnavailable(Exception):
    """The live catalog could not be fetched or parsed."""


@dataclass(frozen=True)
class CodexModel:
    slug: str
    display_name: str
    description: str
    priority: int

    def to_choice(self) -> dict:
        """Shape the renderer's ModelChoice expects ({id, label, note})."""
        return {"id": self.slug, "label": self.display_name or self.slug,
                "note": self.description}


# account_id -> (fetched_at_monotonic, models)
_cache: dict[str, tuple[float, list[CodexModel]]] = {}


def _headers(access_token: str, account_id: str) -> dict[str, str]:
    # Same header set the /responses calls send (codex_llm), so discovery and
    # inference present one consistent client identity to the backend.
    headers = dict(_CODEX_HEADERS_BASE)
    headers["Authorization"] = f"Bearer {access_token}"
    headers["chatgpt-account-id"] = account_id
    headers["Accept"] = "application/json"
    return headers


def parse_catalog(body: object) -> list[CodexModel]:
    """Turn a /models response into picker-ready models.

    Pure function (no I/O) so the selection rules are unit-testable: keep
    ``visibility == "list"``, sort by ``priority`` ascending. Tolerant of
    missing optional fields; skips malformed entries rather than failing.
    """
    if not isinstance(body, dict):
        raise CodexModelsUnavailable("catalog response is not a JSON object")
    raw = body.get("models")
    if not isinstance(raw, list):
        raise CodexModelsUnavailable("catalog response has no 'models' list")

    out: list[CodexModel] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or "").strip()
        if not slug:
            continue
        if str(item.get("visibility") or "").strip().lower() != "list":
            continue
        try:
            priority = int(item.get("priority", 0))
        except (TypeError, ValueError):
            priority = 0
        out.append(CodexModel(
            slug=slug,
            display_name=str(item.get("display_name") or slug),
            description=str(item.get("description") or ""),
            priority=priority,
        ))
    out.sort(key=lambda m: m.priority)
    if not out:
        raise CodexModelsUnavailable("catalog listed no selectable models")
    return out


async def _get(access_token: str, account_id: str, client_version: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        return await client.get(
            CODEX_MODELS_URL,
            params={"client_version": client_version},
            headers=_headers(access_token, account_id),
        )


async def list_codex_models(
    access_token: str, account_id: str, *, force_refresh: bool = False
) -> list[CodexModel]:
    """Fetch (or return cached) selectable Codex models for this account.

    Raises ``CodexModelsUnavailable`` on any failure; callers decide whether
    to fall back. Cached per account for 15 minutes; ``force_refresh``
    bypasses the cache (the Settings/Analyze refresh path).
    """
    if not access_token or not account_id:
        raise CodexModelsUnavailable("missing OAuth access token or account id")

    now = time.monotonic()
    cached = _cache.get(account_id)
    if cached and not force_refresh and now - cached[0] < _CACHE_TTL_S:
        return cached[1]

    try:
        resp = await _get(access_token, account_id, CLIENT_VERSION_SENTINEL)
        if resp.status_code == 400:
            # Backend may one day reject the sentinel; retry with a real
            # release before giving up.
            resp = await _get(access_token, account_id, CLIENT_VERSION_KNOWN_GOOD)
    except httpx.HTTPError as exc:
        raise CodexModelsUnavailable(f"catalog request failed: {type(exc).__name__}") from exc

    if resp.status_code != 200:
        sys.stderr.write(
            f"[codex-models] NON-200 status={resp.status_code} body={resp.text[:160]!r}\n"
        )
        # Surface OpenAI's own short message (e.g. a rejected header) so the
        # renderer can show WHY discovery fell back. It is an error string,
        # never a credential; trimmed and single-lined for the UI.
        detail = " ".join((resp.text or "").split())[:140]
        raise CodexModelsUnavailable(
            f"catalog HTTP {resp.status_code}" + (f": {detail}" if detail else "")
        )

    try:
        models = parse_catalog(resp.json())
    except ValueError as exc:  # bad JSON
        raise CodexModelsUnavailable("catalog response was not valid JSON") from exc

    _cache[account_id] = (now, models)
    sys.stderr.write(
        f"[codex-models] OK {len(models)} models: {', '.join(m.slug for m in models)}\n"
    )
    return models


def pick_model(requested: Optional[str], models: list[CodexModel]) -> tuple[str, bool]:
    """Keep ``requested`` if the account can use it, else the catalog default.

    Returns ``(model, substituted)``. This is the self-heal that fixes users
    whose saved choice OpenAI has since retired, without them touching
    Settings.
    """
    if not models:
        # parse_catalog never caches an empty list today, but don't let a
        # future "be tolerant" refactor turn that into an IndexError mid-run.
        return ((requested or "").strip() or FALLBACK_DEFAULT), False
    slugs = {m.slug for m in models}
    req = (requested or "").strip()
    if req and req in slugs:
        return req, False
    return models[0].slug, True


async def resolve_model(
    requested: Optional[str], access_token: str, account_id: str
) -> tuple[str, Optional[str]]:
    """Resolve the model to actually run for an OAuth (Codex) session.

    Returns ``(model, note)``; ``note`` is a human-readable explanation when
    the model was substituted, else None. If discovery itself fails we keep
    the requested model unchanged (never make a working setup worse because
    the catalog endpoint hiccupped); the run will surface the backend's own
    error if that model really is gone.
    """
    try:
        models = await list_codex_models(access_token, account_id)
    except CodexModelsUnavailable as exc:
        sys.stderr.write(f"[codex-models] discovery unavailable ({exc}); keeping {requested!r}\n")
        return (requested or FALLBACK_DEFAULT), None

    model, substituted = pick_model(requested, models)
    if not substituted:
        return model, None
    note = (
        f"'{requested}' is not available for your ChatGPT account "
        f"(OpenAI has retired or not enabled it); using '{model}' instead."
        if requested else f"Using your account's default model '{model}'."
    )
    sys.stderr.write(f"[codex-models] {note}\n")
    return model, note


def _reset_cache_for_tests() -> None:
    _cache.clear()
