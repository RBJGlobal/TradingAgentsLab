"""LLM provider adapters for the live debate path.

Each adapter exposes the same minimal Protocol so `live_debate.py` can call
any provider without per-provider branching. Cost caps (`max_tokens`,
`MAX_AGENTS_PER_SESSION`) are enforced by `live_debate.py`, not here —
adapters cannot accidentally raise them.

Today's allowlist: `openai`, `anthropic`, `openrouter`, `gemini`, `xai`,
`minimax`, `local`.
OpenAI also has a sibling `OpenAICodexAdapter` for the OAuth/subscription
path that hits `chatgpt.com/backend-api/codex/responses` instead of the
standard chat-completions endpoint — the factory picks based on
`config.auth.type`. The `local` provider is the generic OpenAI-compatible
adapter for runtimes like Ollama and LM Studio; the base_url comes from
the renderer at session time so any localhost runtime works.

Cost rates are local approximations refreshed manually. They are budgeting
hints for the founder, never billing records — providers update prices
quarterly and this table will drift. **Subscription-billed routes
(OpenAI Codex / OAuth) are NOT per-token billed**; the engine's logged
cost estimate overstates true cost for OAuth sessions. The founder's
billing dashboard is the source of truth.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

import httpx

# Per-request HTTP timeout for the API-key LLM clients. Without this the
# OpenAI and Anthropic SDKs default to a 600s / 10-minute read timeout, so a
# single unresponsive provider could freeze a debate (and its WebSocket) for
# up to ~2 hours across 12 agents. 90s read covers a slow-but-alive cloud
# model; a stalled endpoint fails fast instead. The OAuth/Codex adapter sets
# its own explicit timeout (it builds a raw httpx client), and Gemini uses the
# millisecond `HttpOptions.timeout` below.
_LLM_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=90.0, write=30.0, pool=10.0)
# Local runtimes (Ollama / LM Studio) are a different regime: a slow response
# is the user's own hardware doing real work (cold model load can take minutes,
# CPU inference of a large model is legitimately slow), NOT a stalled network.
# A 90s read here would kill valid local debates (and the OpenAI SDK's 2 built-
# in retries turn one timeout into ~3x the wait before failing). connect stays
# tight — if localhost can't accept in 10s the runtime simply isn't up.
_LOCAL_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)
# Gemini's google-genai client takes its timeout in milliseconds.
_GEMINI_TIMEOUT_MS = 90_000


# ---- Cost rate tables -----------------------------------------------------
#
# As of 2026-05-09 (catalog refresh 2026-05-27). Refresh annually; do not
# trust these for billing. Conservative numbers preferred — over-estimate so
# the logged total is a ceiling rather than a floor. Over-estimating is the
# safe direction here: CostGuard reserves more and stops sooner, never later.

_COST_PER_M_TOKENS: dict[str, dict[str, float]] = {
    # OpenAI
    "gpt-4o-mini":         {"input": 0.15, "output": 0.60},
    "gpt-4o":              {"input": 2.50, "output": 10.00},
    "gpt-4-turbo":         {"input": 10.00, "output": 30.00},
    "gpt-4.1-mini":        {"input": 0.40, "output": 1.60},
    "gpt-4.1":             {"input": 2.00, "output": 8.00},
    # gpt-5 family: conservative ceilings. Verified 2026-05-28 against OpenAI's
    # published API pricing — gpt-5.5 is $5/$30 per 1M (shipped 2026-04-24), so
    # our $10/$40 is a ~2x ceiling; gpt-5 and gpt-5-mini are likewise priced
    # above their real rates. Over-estimating is the safe direction (CostGuard
    # reserves more, stops sooner). Previously absent, so a gpt-5 run logged $0
    # (the "unknown model" path) — these rows close that.
    "gpt-5-mini":          {"input": 1.00, "output": 4.00},
    "gpt-5":               {"input": 8.00, "output": 30.00},
    "gpt-5.5":             {"input": 10.00, "output": 40.00},
    # Anthropic first-party prices, refreshed 2026-11-11 from Anthropic's
    # models reference (as of 2026-11-03). Ids are the aliases; a DATED id the
    # API may return (e.g. claude-haiku-4-5-20251001) resolves to its alias
    # row through `rates_for` below, so dated ids are never "unknown".
    "claude-fable-5-2":    {"input": 8.00,  "output": 40.00},
    "claude-fable-5-1":    {"input": 10.00, "output": 50.00},
    "claude-fable-5":      {"input": 10.00, "output": 50.00},
    "claude-opus-5-5":     {"input": 4.00,  "output": 20.00},
    "claude-opus-5":       {"input": 5.00,  "output": 25.00},
    "claude-opus-4-8":     {"input": 5.00,  "output": 25.00},
    "claude-opus-4-7":     {"input": 5.00,  "output": 25.00},  # kept for saved preferences
    "claude-opus-4-6":     {"input": 5.00,  "output": 25.00},
    "claude-sonnet-5-5":   {"input": 2.00,  "output": 10.00},
    "claude-sonnet-5":     {"input": 2.00,  "output": 10.00},
    "claude-sonnet-4-6":   {"input": 3.00,  "output": 15.00},
    "claude-sonnet-4-5":   {"input": 3.00,  "output": 15.00},  # deprecated, retires 2026-11-30
    # Haiku 5.5 bills $0.10/$0.50 normally but $0.50/$2.50 above 100K-token
    # prompts. We store the higher tier: this table is a ceiling, and a
    # ceiling has to hold for the expensive case too.
    "claude-haiku-5-5":    {"input": 0.50,  "output": 2.50},
    "claude-haiku-4-5":    {"input": 1.00,  "output": 5.00},
    # Google Gemini
    "gemini-2.0-flash":    {"input": 0.10, "output": 0.40},
    "gemini-2.5-flash":    {"input": 0.30, "output": 2.50},
    "gemini-2.5-pro":      {"input": 1.25, "output": 10.00},
    # Flash-Lite is cheaper than Flash, so pricing it AT the Flash rate is a
    # guaranteed ceiling (over-estimate, never under) — a real anchor, not a
    # guess.
    "gemini-3.1-flash-lite": {"input": 0.30, "output": 2.50},
    # xAI Grok. Verified 2026-05-28 against docs.x.ai and cross-checked vs
    # upstream's docs-aligned catalog: grok-4.3 and the grok-4.20 family bill
    # $1.25/$2.50 per 1M, so $2/$4 is a safe ceiling with headroom. We use the
    # bare grok-4.20-reasoning / grok-4.20-non-reasoning aliases (durable: they
    # track the latest dated snapshot, e.g. -0309, instead of pinning to one
    # that xAI will eventually retire). The older grok-4-fast-* / grok-4-0709
    # IDs were deprecated 2026-05-15 (redirected to grok-4.3), so they're dropped.
    "grok-4.3":                {"input": 2.00, "output": 4.00},
    "grok-4.20-reasoning":     {"input": 2.00, "output": 4.00},
    "grok-4.20-non-reasoning": {"input": 2.00, "output": 4.00},
    # MiniMax M2.x (Global region). One conservative ceiling across the line —
    # the M2.x models are cheap and close in price; $1/$3 over-estimates each.
    # Verify against platform.minimax.io pricing before billing relies on it.
    "MiniMax-M2.7":            {"input": 1.00, "output": 3.00},
    "MiniMax-M2.7-highspeed":  {"input": 1.00, "output": 3.00},
    "MiniMax-M2.5":            {"input": 1.00, "output": 3.00},
    # OpenRouter ids ("vendor/model") are NOT listed here. Their price comes
    # from OpenRouter's own catalog at discovery time (`register_runtime_rates`)
    # or, failing that, from the vendor rules in `rates_for` below.
}


# ---- Rate resolution (one resolver for logging AND CostGuard) -------------
#
# Why one shared resolver: the cost log (`estimate_cost`) and the spend cap
# (`cost_guard.worst_case_reservation`) used to look models up in the table
# independently, and both returned $0 for anything missing. Live model
# discovery makes "a model we have never priced" the normal case, so a $0
# fallback would let a newly listed model walk straight past the spend cap.
# Every unknown model now resolves to a conservative CEILING instead.
# Over-estimating is the safe direction: CostGuard stops sooner, never later.

# Prices learned from OpenRouter's /models catalog during discovery, keyed by
# the exact OpenRouter id. In memory only: an engine restart empties it, and
# the vendor rules below cover that gap until the next discovery call.
_RUNTIME_RATES: dict[str, dict[str, float]] = {}

# Family ceilings for models with no row. Deliberately at or above the most
# expensive current model in each family.
_CEIL_CLAUDE_TOP = {"input": 15.00, "output": 75.00}   # opus / fable / mythos / unrecognised claude
_CEIL_CLAUDE_MID = {"input": 5.00, "output": 25.00}    # sonnet, haiku
_CEIL_OPENAI = {"input": 15.00, "output": 60.00}       # gpt-*, o1/o3/o4...
_CEIL_GEMINI = {"input": 5.00, "output": 20.00}
_CEIL_GROK = {"input": 5.00, "output": 15.00}
# Anything else we cannot place (an unfamiliar OpenRouter vendor, a renamed
# MiniMax model). Same as the most expensive family.
_CEIL_UNKNOWN = {"input": 15.00, "output": 75.00}

# OpenRouter vendor prefixes whose model part follows the first-party naming.
_OPENROUTER_VENDORS = {"anthropic", "openai", "google", "x-ai"}

_DATE_SUFFIX = re.compile(r"-\d{8}$")  # Anthropic-style snapshot: -20251001


def normalize_model_id(model: str) -> str:
    """Strip a trailing ``-YYYYMMDD`` snapshot date and a trailing ``-latest``.

    ``claude-haiku-4-5-20251001`` -> ``claude-haiku-4-5``. Only the 8-digit
    form is stripped on purpose: OpenAI's ``gpt-4o-2024-05-13`` style dates
    can point at OLDER snapshots priced above the alias, so mapping them to the
    alias row could under-reserve. Those fall to the family ceiling instead.
    """
    m = (model or "").strip()
    if m.endswith("-latest"):
        m = m[: -len("-latest")]
    return _DATE_SUFFIX.sub("", m)


def register_runtime_rates(model: str, *, input_per_m: float, output_per_m: float) -> None:
    """Record a price learned at runtime (OpenRouter discovery)."""
    _RUNTIME_RATES[model] = {"input": float(input_per_m), "output": float(output_per_m)}


def _family_ceiling(model: str) -> Optional[dict[str, float]]:
    """Conservative per-family ceiling for a model with no exact price row."""
    m = model.lower()
    if m.startswith("claude-"):
        if "haiku" in m or "sonnet" in m:
            return _CEIL_CLAUDE_MID
        # opus, fable, mythos, and any Claude name we don't recognise yet.
        return _CEIL_CLAUDE_TOP
    if m.startswith("gpt-") or re.match(r"^o\d", m):
        return _CEIL_OPENAI
    if m.startswith("gemini-"):
        return _CEIL_GEMINI
    if m.startswith("grok-"):
        return _CEIL_GROK
    return None


def _table_lookup(model: str) -> Optional[dict[str, float]]:
    """Exact row, then the date/-latest-normalized row."""
    rates = _COST_PER_M_TOKENS.get(model)
    if rates is None:
        rates = _COST_PER_M_TOKENS.get(normalize_model_id(model))
    return rates


def _openrouter_rates(model: str) -> dict[str, float]:
    """Price an OpenRouter id (``vendor/model[:variant]``) we have no
    catalog price for (e.g. right after an engine restart).

    OpenRouter bills the vendor's own price, so for the four vendors we also
    support first-party we reuse our first-party row (itself a ceiling).
    Without this, the default ``openai/gpt-4o-mini`` would be priced at the
    15/60 family ceiling, about 100x its real cost, and one run would eat the
    daily cap. Unrecognised vendors get the top ceiling.
    """
    vendor, _, name = model.partition("/")
    vendor = vendor.lower()
    name = name.split(":", 1)[0]  # ":free" / ":beta" style variants
    if vendor not in _OPENROUTER_VENDORS or not name:
        return _CEIL_UNKNOWN
    rates = _table_lookup(name)
    if rates is None and vendor == "anthropic":
        # OpenRouter writes Claude versions with dots (claude-sonnet-4.6);
        # Anthropic's own ids use dashes (claude-sonnet-4-6).
        rates = _table_lookup(name.replace(".", "-"))
    if rates is not None:
        return rates
    return _family_ceiling(name) or _CEIL_UNKNOWN


def rates_for(model: str, provider: Optional[str] = None) -> Optional[dict[str, float]]:
    """Per-1M-token ``{"input", "output"}`` USD rates for ``model``, or None.

    Resolution order (first hit wins):

    1. exact row in ``_COST_PER_M_TOKENS``
    2. the row for the date/-latest-normalized id
    3. a price learned from OpenRouter's catalog (exact OpenRouter id)
    4. ceilings: OpenRouter vendor rules for ``vendor/model`` ids, else the
       model-family ceiling (claude / gpt / o-series / gemini / grok)

    Returns None only when ``provider == "local"`` (on-device, always $0), or
    when nothing matches AND no cloud ``provider`` is given. Callers that
    know the run is per-token billed (``worst_case_reservation``, or
    ``estimate_cost`` with a cloud provider) treat None as the top ceiling,
    never as $0. OAuth runs are handled by the callers before this is reached
    (subscription billed, $0).
    """
    if provider == "local":
        return None
    model = (model or "").strip()
    rates = _table_lookup(model)
    if rates is not None:
        return rates
    if model in _RUNTIME_RATES:
        return _RUNTIME_RATES[model]
    if "/" in model:
        return _openrouter_rates(model)
    rates = _family_ceiling(model)
    if rates is not None:
        return rates
    return _CEIL_UNKNOWN if provider else None


def estimate_cost(
    model: str, in_tokens: int, out_tokens: int, *, provider: Optional[str] = None
) -> float:
    """USD estimate for a finished (or partial) run. Pass ``provider`` so an
    unrecognised cloud model is priced at the ceiling instead of $0; local
    runs are $0. Without a provider, a model nothing matches logs $0 (the
    historical behaviour, kept for callers that cannot say)."""
    rates = rates_for(model, provider)
    if rates is None:
        return 0.0
    return (in_tokens * rates["input"] + out_tokens * rates["output"]) / 1_000_000


# ---- Provider config ------------------------------------------------------


@dataclass
class ProviderConfig:
    """Renderer-supplied config for a single live-debate session.

    `auth` is a discriminated dict:

    - `{"type": "api_key", "api_key": "sk-..."}`  — API-key flow (all providers)
    - `{"type": "oauth", "access": "...", "refresh": "...", "expires": 1234}` — OAuth (OpenAI only today)

    Use `bearer_token` to get the value to attach as `Authorization: Bearer ...`
    regardless of which flow is active. Adapters never branch on auth shape.
    """

    provider: str
    auth: dict[str, Any] = field(default_factory=dict)
    model: str = ""
    max_tokens: int = 400

    @property
    def bearer_token(self) -> str:
        """Token for the `Authorization: Bearer …` header.

        Works for api_key, oauth, and local auth types. For local runtimes
        (Ollama, LM Studio) the OpenAI SDK still requires a non-empty value
        — `"local"` is a sentinel that both Ollama and LM Studio accept.
        Raises ValueError on an unrecognised auth type so adapter-level
        mistakes are loud.
        """
        t = self.auth.get("type")
        if t == "api_key":
            return str(self.auth.get("api_key") or "")
        if t == "oauth":
            return str(self.auth.get("access") or "")
        if t == "local":
            return "local"
        raise ValueError(f"ProviderConfig.auth has unknown type: {t!r}")

    @property
    def auth_kind(self) -> str:
        """`"api_key"` or `"oauth"` — for telemetry / logging."""
        return str(self.auth.get("type") or "unknown")

    @classmethod
    def from_dict(cls, raw: Optional[dict]) -> "ProviderConfig | None":
        if not isinstance(raw, dict):
            return None

        provider = (raw.get("provider") or "openai").lower()
        if provider not in _ALLOWED_PROVIDERS:
            return None

        # Two accepted shapes:
        #   New (preferred): {"auth": {"type": "...", ...}, ...}
        #   Old (back-compat): {"api_key": "sk-..."} at top level
        # Renderers ship the new shape; we accept the old so that an
        # outdated WS frame (e.g. dev hot-reload race) doesn't drop the
        # session silently into the stub path.
        raw_auth = raw.get("auth")
        if isinstance(raw_auth, dict):
            auth = _normalize_auth(raw_auth)
        else:
            api_key = (raw.get("api_key") or "").strip()
            if not api_key:
                return None
            auth = {"type": "api_key", "api_key": api_key}

        if auth is None:
            return None

        # Only OpenAI accepts OAuth at the moment.
        if auth["type"] == "oauth" and provider != "openai":
            return None

        # Local auth only goes with the `local` provider, and `local` only
        # accepts the local auth shape. Keeps the two domains from leaking
        # into each other (e.g. you can't ship a base_url with an api_key
        # claim for OpenAI, and you can't ship an api_key against the
        # local runtime adapter — that's a config bug worth dropping).
        if auth["type"] == "local" and provider != "local":
            return None
        if provider == "local" and auth["type"] != "local":
            return None

        model = (raw.get("model") or "").strip() or _DEFAULT_MODELS[provider]
        try:
            requested_max = int(raw.get("max_tokens") or _DEFAULT_MAX_TOKENS)
        except (TypeError, ValueError):
            requested_max = _DEFAULT_MAX_TOKENS
        max_tokens = max(1, min(requested_max, _MAX_TOKENS_HARD_CAP))

        return cls(
            provider=provider,
            auth=auth,
            model=model,
            max_tokens=max_tokens,
        )


def _normalize_auth(raw: dict) -> Optional[dict[str, Any]]:
    t = (raw.get("type") or "").lower()
    if t == "api_key":
        api_key = (raw.get("api_key") or "").strip()
        if not api_key:
            return None
        return {"type": "api_key", "api_key": api_key}
    if t == "oauth":
        access = (raw.get("access") or "").strip()
        refresh = (raw.get("refresh") or "").strip()
        if not access:
            return None
        try:
            expires = int(raw.get("expires") or 0)
        except (TypeError, ValueError):
            expires = 0
        account_id = (raw.get("account_id") or raw.get("accountId") or "").strip()
        out: dict[str, Any] = {
            "type": "oauth",
            "access": access,
            "refresh": refresh,
            "expires": expires,
        }
        if account_id:
            out["account_id"] = account_id
        return out
    if t == "local":
        # `base_url` is the OpenAI-compatible endpoint of the local runtime
        # — e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1
        # for LM Studio. We require it explicitly rather than defaulting,
        # because there's no single "default" local runtime — making the
        # user pick one upstream surfaces config bugs early.
        base_url = (raw.get("base_url") or "").strip()
        if not base_url:
            return None
        return {"type": "local", "base_url": base_url}
    return None


_DEFAULT_MAX_TOKENS = 400
_MAX_TOKENS_HARD_CAP = 800  # Defense in depth — caller can't blow past this.

_DEFAULT_MODELS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5",
    "openrouter": "openai/gpt-4o-mini",
    "gemini": "gemini-2.0-flash",
    # xAI Grok and MiniMax are both OpenAI-compatible (API key only). The
    # default leans to a fast/cheap model so a misconfigured run isn't an
    # expensive surprise. See XaiAdapter / MiniMaxAdapter below.
    "xai": "grok-4.3",
    "minimax": "MiniMax-M2.7-highspeed",
    # Local model name is runtime-specific (Ollama: "llama3.2:latest";
    # LM Studio: whatever the user has loaded). The renderer picks from
    # the detection result and ships an explicit `model` on the WS frame;
    # this default is a last-resort fallback that won't actually work
    # against an arbitrary runtime — keep it obvious so a misconfigured
    # request errors visibly rather than runs against the wrong model.
    "local": "local-model",
}

_ALLOWED_PROVIDERS = frozenset(_DEFAULT_MODELS.keys())


def default_model_for(provider: str) -> str:
    return _DEFAULT_MODELS.get(provider, _DEFAULT_MODELS["openai"])


# ---- Sampling parameters per model family ---------------------------------
#
# Why this exists: we used to send `temperature=0.7` to every model. Newer
# models reject sampling parameters outright (HTTP 400), so a model the user
# picked from the live list would fail on the very first agent. The rule is
# an ALLOWLIST of older families that still accept temperature; anything
# unknown or new gets the provider's default sampling (we omit the param).
# Omitting is always accepted; sending is what breaks.

_TEMPERATURE = 0.7

# Anthropic: per Anthropic's API reference, Opus 4.7 and later, Fable 5.x,
# Sonnet 5 / 5.5 and Haiku 5.5 reject (or only accept the default) sampling
# params. These older ids still accept temperature. Compared after
# `normalize_model_id`, so dated snapshots (claude-haiku-4-5-20251001) match.
_ANTHROPIC_TEMPERATURE_OK = frozenset({
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-opus-4-0",
    "claude-opus-4",
    "claude-sonnet-4-0",
    "claude-sonnet-4",
})


def anthropic_accepts_temperature(model: str) -> bool:
    m = normalize_model_id(model).lower()
    # The whole Claude 3 generation (claude-3-5-haiku, claude-3-7-sonnet...).
    return m in _ANTHROPIC_TEMPERATURE_OK or m.startswith("claude-3-")


def openai_is_classic_chat_model(model: str) -> bool:
    """gpt-4o / gpt-4.1 / gpt-4-turbo / gpt-3.5 style: accept `temperature`
    and `max_tokens`. The gpt-5 family and the o-series are reasoning models:
    they reject a non-default temperature and reject `max_tokens` in favour of
    `max_completion_tokens` (the pinned openai SDK documents `max_tokens` as
    "not compatible with o-series models")."""
    m = (model or "").strip().lower()
    return m.startswith("gpt-4") or m.startswith("gpt-3.5")


def openai_sampling_kwargs(model: str, max_tokens: int) -> dict[str, Any]:
    """Kwargs for direct OpenAI Chat Completions."""
    if openai_is_classic_chat_model(model):
        return {"max_tokens": max_tokens, "temperature": _TEMPERATURE}
    return {"max_completion_tokens": max_tokens}


def _classic_sampling_kwargs(model: str, max_tokens: int) -> dict[str, Any]:
    """The original shape, unchanged, for xAI / MiniMax / local runtimes."""
    del model  # same for every model on these endpoints
    return {"max_tokens": max_tokens, "temperature": _TEMPERATURE}


def openrouter_sampling_kwargs(model: str, max_tokens: int) -> dict[str, Any]:
    """OpenRouter forwards sampling params to the vendor, so a vendor that
    rejects temperature rejects it here too. Apply the vendor's own rule to
    the part after the slash. OpenRouter itself accepts `max_tokens` for
    every model (its catalog lists it for openai/gpt-5 too), so the token
    kwarg stays `max_tokens`."""
    vendor, _, name = (model or "").partition("/")
    vendor = vendor.lower()
    name = name.split(":", 1)[0]
    if vendor == "anthropic":
        ok = anthropic_accepts_temperature(name.replace(".", "-"))
    elif vendor == "openai":
        ok = openai_is_classic_chat_model(name)
    else:
        ok = True  # other vendors: unchanged behaviour
    out: dict[str, Any] = {"max_tokens": max_tokens}
    if ok:
        out["temperature"] = _TEMPERATURE
    return out


# ---- Adapter Protocol -----------------------------------------------------


class LLMAdapter(Protocol):
    name: str

    async def open(self, *, api_key: str) -> None: ...
    async def close(self) -> None: ...
    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        """Returns (content, input_tokens, output_tokens)."""
        ...


# ---- OpenAI adapter (also covers OpenRouter via base_url override) --------


class OpenAIAdapter:
    """Direct OpenAI Chat Completions. Single client per session."""

    name = "openai"
    _base_url: Optional[str] = None
    _extra_headers: dict[str, str] = {}
    # Subclasses (e.g. LocalLLMAdapter) override this for a different regime.
    _http_timeout: "httpx.Timeout" = _LLM_HTTP_TIMEOUT

    def __init__(self) -> None:
        self._client = None  # type: ignore[assignment]

    async def open(self, *, api_key: str) -> None:
        """Open the client with a Bearer token.

        The argument name `api_key` is kept for adapter-Protocol consistency,
        but the value is whatever bearer token the caller supplies — for
        OpenAI's `/v1/chat/completions` endpoint, both `sk-…` API keys and
        OAuth access tokens are accepted as `Authorization: Bearer …`. The
        caller (`live_debate.py`) reads `config.bearer_token` so this stays
        auth-shape-agnostic.
        """
        from openai import AsyncOpenAI

        kwargs: dict = {"api_key": api_key, "timeout": self._http_timeout}
        if self._base_url:
            kwargs["base_url"] = self._base_url
        if self._extra_headers:
            kwargs["default_headers"] = self._extra_headers
        self._client = AsyncOpenAI(**kwargs)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001 — cleanup is best-effort
                pass
            self._client = None

    def _sampling_kwargs(self, model: str, max_tokens: int) -> dict[str, Any]:
        """Token-limit + sampling kwargs for direct OpenAI (api.openai.com).

        Subclasses that talk to other OpenAI-compatible endpoints override
        this (see `_classic_sampling_kwargs`), because those endpoints have
        their own rules and the OpenAI-specific ones below must not leak
        into them.
        """
        return openai_sampling_kwargs(model, max_tokens)

    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        if self._client is None:
            raise RuntimeError("adapter not opened")
        resp = await self._client.chat.completions.create(
            model=model,
            **self._sampling_kwargs(model, max_tokens),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        choice = resp.choices[0].message.content or ""
        usage = resp.usage
        in_tok = getattr(usage, "prompt_tokens", 0) if usage else 0
        out_tok = getattr(usage, "completion_tokens", 0) if usage else 0
        return choice.strip(), in_tok, out_tok


class OpenRouterAdapter(OpenAIAdapter):
    """OpenRouter is OpenAI-compatible at openrouter.ai."""

    name = "openrouter"
    _base_url = "https://openrouter.ai/api/v1"
    # OpenRouter recommends an HTTP-Referer + X-Title for analytics. These
    # don't gate access — they're courtesy headers.
    _extra_headers = {
        "HTTP-Referer": "https://github.com/RBJGlobal/TradingAgentsLab",
        "X-Title": "TradingAgentsLab",
    }

    def _sampling_kwargs(self, model: str, max_tokens: int) -> dict[str, Any]:
        return openrouter_sampling_kwargs(model, max_tokens)


# ---- xAI Grok + MiniMax adapters (OpenAI-compatible, API key only) --------


class XaiAdapter(OpenAIAdapter):
    """xAI Grok is OpenAI-compatible at api.x.ai.

    Grok reasoning models return their chain-of-thought in a separate
    ``reasoning_content`` field, not in ``message.content``, so the base
    adapter's plain content read already stays clean — no post-processing.
    """

    name = "xai"
    _base_url = "https://api.x.ai/v1"
    # Own the dict per class so an in-place mutation never leaks across
    # providers via the shared OpenAIAdapter default. xAI needs no extras.
    _extra_headers: dict[str, str] = {}

    def _sampling_kwargs(self, model: str, max_tokens: int) -> dict[str, Any]:
        # xAI's own rules, not OpenAI's: keep the original request shape.
        return _classic_sampling_kwargs(model, max_tokens)


def _strip_think_blocks(text: str) -> str:
    """Remove MiniMax M2.x ``<think>...</think>`` reasoning from content.

    MiniMax reasoning models embed their chain-of-thought directly inside
    ``message.content`` wrapped in ``<think>...</think>``. (Upstream avoids
    this by sending ``reasoning_split=True``, but non-reasoning MiniMax
    endpoints reject that kwarg — so we strip post-hoc instead, one code path
    for both kinds.) Handles two cases:

    - Complete blocks are removed wholesale (with or without tag attributes).
    - An unclosed ``<think>`` means the response hit ``max_tokens`` mid-thought
      (everything after it is reasoning with no final answer): drop it. If
      nothing real survives, return a sentinel so the transcript never shows
      raw chain-of-thought as though it were the agent's conclusion.
    - Any stray ``</think>`` left by pseudo-nested input is stripped too, so
      no reasoning markup ever reaches the transcript.
    """
    # ``<think[^>]*>`` tolerates attribute variants (e.g. ``<think id="1">``).
    cleaned = re.sub(r"<think[^>]*>.*?</think>", "", text, flags=re.DOTALL)
    dangling = cleaned.find("<think")
    if dangling != -1:
        cleaned = cleaned[:dangling]
    cleaned = re.sub(r"</think\s*>", "", cleaned)
    cleaned = cleaned.strip()
    if not cleaned:
        return "[truncated: model returned only reasoning, no final answer]"
    return cleaned


class MiniMaxAdapter(OpenAIAdapter):
    """MiniMax M2.x is OpenAI-compatible (Global region) at api.minimax.io.

    M2.x reasoning models embed ``<think>...</think>`` chain-of-thought in
    ``message.content``; we strip it post-hoc (see ``_strip_think_blocks``) so
    saved transcripts carry the conclusion, not the raw reasoning. The China
    region (``api.minimaxi.com``) is a separate provider key + endpoint and is
    deliberately out of scope for v1.
    """

    name = "minimax"
    _base_url = "https://api.minimax.io/v1"
    # Own the dict per class (see XaiAdapter). MiniMax needs no extra headers.
    _extra_headers: dict[str, str] = {}

    def _sampling_kwargs(self, model: str, max_tokens: int) -> dict[str, Any]:
        return _classic_sampling_kwargs(model, max_tokens)

    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        content, in_tok, out_tok = await super().complete(
            system=system, user=user, model=model, max_tokens=max_tokens
        )
        return _strip_think_blocks(content), in_tok, out_tok


# ---- Local LLM adapter (Ollama / LM Studio / generic OpenAI-compat) -------


class LocalLLMAdapter(OpenAIAdapter):
    """Generic OpenAI-compatible adapter for a user-supplied base_url.

    Works against any local runtime that exposes the OpenAI Chat Completions
    shape — verified targets are Ollama (`http://localhost:11434/v1`) and
    LM Studio (`http://localhost:1234/v1`). Both accept any non-empty value
    in the `Authorization: Bearer …` header by default.

    Unlike `OpenRouterAdapter` (which fixes `_base_url` at class level
    because the URL is constant), the local base URL comes from the
    renderer per session, so we override at instance level via
    `__init__(base_url=...)`.

    Cost note: local LLM cost is treated as $0 by the engine (CostGuard
    short-circuits the same way as OAuth, and `rates_for(...,
    provider="local")` returns None so `estimate_cost` logs 0.0).
    """

    name = "local"
    # Local inference can legitimately take minutes (cold load, CPU, large
    # models); use the generous local read timeout rather than the cloud 90s.
    _http_timeout = _LOCAL_HTTP_TIMEOUT

    def __init__(self, *, base_url: str) -> None:
        super().__init__()
        # Instance-level override of the class-var. Python attribute lookup
        # checks the instance dict first, so `open()` reading `self._base_url`
        # picks this up without further changes.
        self._base_url = base_url

    def _sampling_kwargs(self, model: str, max_tokens: int) -> dict[str, Any]:
        # Ollama / LM Studio: keep the original shape (some local runtimes
        # don't understand `max_completion_tokens`).
        return _classic_sampling_kwargs(model, max_tokens)


# ---- OpenAI Codex adapter (OAuth / ChatGPT-subscription path) -------------


class OpenAICodexAdapter:
    """OpenAI Codex Responses API — the path that routes through the user's
    ChatGPT subscription instead of their per-token API tier.

    OAuth tokens issued by `loginOpenAICodex` are NOT API tokens. Attaching
    them as `Authorization: Bearer …` to the standard `/v1/chat/completions`
    endpoint hits the user's API quota, not their subscription (founder
    smoke-tested this 2026-05-09 and got `insufficient_quota` 429).

    Subscription routing requires a different endpoint:

        URL: https://chatgpt.com/backend-api/codex/responses
        Headers: Authorization: Bearer <oauth_access>
                 chatgpt-account-id: <accountId from oauth credentials>
                 originator: pi
                 User-Agent: pi (...)
        Body: OpenAI Responses-API shape (`input` not `messages`,
              `instructions` not `system` role, etc.)

    This adapter implements the same `LLMAdapter` Protocol as the
    `OpenAIAdapter` (Chat Completions, API key) but talks to the Codex
    backend. The factory `adapter_for(config)` picks one or the other based
    on `config.auth["type"]`.

    Replicates the request shape pi-ai (@earendil-works/pi-ai/oauth) uses
    for Clawless desktop's OAuth path. The header set + body shape is taken
    directly from `openai-codex-responses.js` `buildBaseCodexHeaders` and
    `buildRequestBody`.

    Cost note: when a session runs through this adapter, the founder is
    NOT being billed per-token — the cost is amortized into their ChatGPT
    subscription. The cost-estimate the engine logs on session.complete is
    technically wrong-direction (overstates) for OAuth runs. We don't try
    to "fix" that with a $0 calculation; the founder's billing dashboard
    is the source of truth.
    """

    name = "openai-codex"
    BASE_URL = "https://chatgpt.com/backend-api/codex/responses"

    def __init__(self) -> None:
        self._client = None  # type: ignore[assignment]
        self._token: Optional[str] = None
        self._account_id: Optional[str] = None

    async def open(self, *, api_key: str) -> None:
        """Open with `api_key` carrying the OAuth access token (per
        `LLMAdapter` Protocol — name kept for consistency, value is the
        Bearer token regardless of auth flow). The `accountId` is supplied
        out-of-band via `set_account_id` because the Protocol surface
        doesn't pass arbitrary metadata.
        """
        import httpx

        self._token = api_key
        # 30s connect, 90s read — Codex responses can take a beat on big
        # context windows. No retries; the engine's outer error path
        # surfaces failures as session events.
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=30.0, read=90.0, write=30.0, pool=30.0),
        )

    def set_account_id(self, account_id: str) -> None:
        """Codex backend requires `chatgpt-account-id` — set after `open`
        from the same OAuth credential blob the renderer sent.
        """
        self._account_id = account_id

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._client = None
        self._token = None
        self._account_id = None

    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        if self._client is None or self._token is None:
            raise RuntimeError("OpenAICodexAdapter not opened")

        # Header set per pi-ai (openai-codex-responses.js:buildBaseCodexHeaders +
        # buildSSEHeaders). `chatgpt-account-id` is required; if we don't
        # have one the Codex backend will 401.
        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._token}",
            "originator": "pi",
            "User-Agent": "pi (TradingAgentsLab)",
            "OpenAI-Beta": "responses=experimental",
            "accept": "text/event-stream",
            "content-type": "application/json",
        }
        if self._account_id:
            headers["chatgpt-account-id"] = self._account_id

        # Body matches pi-ai's `buildRequestBody` exactly — every field
        # present here is one pi-ai sends unconditionally to Codex; every
        # field pi-ai sends conditionally (temperature, service_tier,
        # tools, reasoning, prompt_cache_key) is omitted because we
        # don't supply those options.
        #
        # On `max_output_tokens`: NOT in pi-ai's body. I tried adding
        # it as the Responses API equivalent of `max_tokens` and Codex
        # backend returned 400 Unsupported parameter (founder hit
        # this 2026-05-09). Output length is bounded by the system
        # prompts (each agent's prompt explicitly says "3-5
        # sentences" / "2-3 sentences"), not by an enforced cap. The
        # `max_tokens` arg here is ignored on the Codex path; the
        # API-key adapter (`OpenAIAdapter`) still enforces it via
        # `client.chat.completions.create(max_tokens=...)`.
        del max_tokens  # noqa — argument intentionally unused on this path
        body = {
            "model": model,
            "store": False,
            "stream": True,
            "instructions": system,
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": user}],
                }
            ],
            "text": {"verbosity": "low"},
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        }

        content_parts: list[str] = []
        in_tokens = 0
        out_tokens = 0

        # SSE response: each event is `event: <type>\ndata: <json>\n\n`.
        # We care about `response.output_text.delta` (incremental text)
        # and `response.completed` (final usage). We DON'T stream tokens
        # back to the WS — `LLMAdapter.complete` returns the full message
        # so the existing `live_debate.py` orchestration is unchanged.
        try:
            async with self._client.stream(
                "POST",
                self.BASE_URL,
                headers=headers,
                json=body,
            ) as response:
                if response.status_code != 200:
                    # Read error body before raising — Codex returns
                    # JSON error blobs that are useful to surface.
                    error_body = await response.aread()
                    error_text = error_body.decode("utf-8", errors="replace")[:500]
                    raise RuntimeError(
                        f"Codex {response.status_code}: {error_text}"
                    )

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:") :].strip()
                    if payload == "[DONE]" or not payload:
                        continue
                    try:
                        evt = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    evt_type = evt.get("type")
                    if evt_type == "response.output_text.delta":
                        delta = evt.get("delta") or ""
                        if isinstance(delta, str):
                            content_parts.append(delta)
                    elif evt_type == "response.completed":
                        # Final response carries `usage` and the full
                        # `output` array. Prefer `usage` from here.
                        resp = evt.get("response") or {}
                        usage = resp.get("usage") or {}
                        in_tokens = int(usage.get("input_tokens") or 0)
                        out_tokens = int(usage.get("output_tokens") or 0)
                        # If we missed the deltas (unlikely but possible),
                        # extract text from the completed output as fallback.
                        if not content_parts:
                            for item in resp.get("output") or []:
                                for part in item.get("content") or []:
                                    text = part.get("text")
                                    if isinstance(text, str):
                                        content_parts.append(text)
        except RuntimeError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Codex stream failed: {type(exc).__name__}: {exc}")

        return "".join(content_parts).strip(), in_tokens, out_tokens


# ---- Anthropic adapter ----------------------------------------------------


class AnthropicAdapter:
    """Anthropic Messages API. Single async client per session."""

    name = "anthropic"

    def __init__(self) -> None:
        self._client = None  # type: ignore[assignment]

    async def open(self, *, api_key: str) -> None:
        from anthropic import AsyncAnthropic

        self._client = AsyncAnthropic(api_key=api_key, timeout=_LLM_HTTP_TIMEOUT)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001
                pass
            self._client = None

    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        if self._client is None:
            raise RuntimeError("adapter not opened")
        # Anthropic puts the system prompt at the top level, NOT in messages.
        # `max_tokens` is required (not optional like OpenAI). Temperature is
        # sent only to older models that accept it; newer ones return HTTP
        # 400 for sampling params (see `anthropic_accepts_temperature`).
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if anthropic_accepts_temperature(model):
            kwargs["temperature"] = _TEMPERATURE
        resp = await self._client.messages.create(**kwargs)
        # `resp.content` is a list of content blocks. For non-tool responses
        # we expect a single TextBlock; concatenate all text blocks defensively.
        parts: list[str] = []
        for block in resp.content or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        content = "".join(parts).strip()
        # `resp.usage.input_tokens` / `output_tokens` are the canonical fields.
        usage = resp.usage
        in_tok = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        # Note on stop_reason: "max_tokens" indicates truncation. The content
        # is still valid text; we surface it as-is — the founder can see
        # truncation in the transcript and re-run with a higher cap if needed.
        # If we wanted to be stricter we could append "[truncated]" to the
        # content; intentionally not doing that to keep stub/live UX identical.
        return content, in_tok, out_tok


# ---- Google Gemini adapter ------------------------------------------------


class GeminiAdapter:
    """Google Gemini via the maintained `google-genai` SDK.

    The deprecated `google-generativeai` package is intentionally NOT used.
    """

    name = "gemini"

    def __init__(self) -> None:
        self._client = None  # type: ignore[assignment]

    async def open(self, *, api_key: str) -> None:
        from google import genai
        from google.genai import types

        # Sync client is fine — we run completions in a thread to keep the
        # asyncio loop responsive. (genai also offers an async client; the
        # sync one is simpler and we already pay the threading cost.)
        # `HttpOptions.timeout` is in milliseconds; without it the client has
        # no read timeout and a stalled Gemini call would block its thread-pool
        # thread indefinitely (and that thread can't be cancelled mid-call).
        self._client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=_GEMINI_TIMEOUT_MS),
        )

    async def close(self) -> None:
        # google-genai client has no explicit close; rely on GC.
        self._client = None

    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str,
        max_tokens: int,
    ) -> tuple[str, int, int]:
        if self._client is None:
            raise RuntimeError("adapter not opened")
        import asyncio

        from google.genai import types

        # Combine system + user. Gemini's `system_instruction` is a separate
        # config field; we pass it that way so the user message stays clean.
        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            temperature=0.7,
        )

        def _call() -> tuple[str, int, int]:
            assert self._client is not None
            resp = self._client.models.generate_content(
                model=model,
                contents=user,
                config=config,
            )
            # `resp.text` raises ValueError when the candidate was filtered
            # by Gemini's safety system (finish_reason=SAFETY/RECITATION).
            # Surface a clean empty-string in that case so the engine's
            # outer error handler turns it into a graceful debate event
            # rather than a SDK stacktrace.
            try:
                content = (resp.text or "").strip()
            except ValueError as exc:
                content = f"[gemini blocked: {exc}]"
            usage = getattr(resp, "usage_metadata", None)
            in_tok = int(getattr(usage, "prompt_token_count", 0) or 0) if usage else 0
            out_tok = int(getattr(usage, "candidates_token_count", 0) or 0) if usage else 0
            return content, in_tok, out_tok

        return await asyncio.to_thread(_call)


# ---- Factory --------------------------------------------------------------


def adapter_for(config: ProviderConfig) -> LLMAdapter:
    if config.provider == "openai":
        # OAuth → Codex backend (subscription-routed). API key → standard
        # /v1/chat/completions (per-token billed). The two endpoints have
        # totally different request/response shapes; the factory picks the
        # right adapter so `live_debate.py` stays auth-agnostic.
        if config.auth.get("type") == "oauth":
            return OpenAICodexAdapter()
        return OpenAIAdapter()
    if config.provider == "openrouter":
        return OpenRouterAdapter()
    if config.provider == "xai":
        return XaiAdapter()
    if config.provider == "minimax":
        return MiniMaxAdapter()
    if config.provider == "anthropic":
        return AnthropicAdapter()
    if config.provider == "gemini":
        return GeminiAdapter()
    if config.provider == "local":
        # `from_dict` guarantees `auth["type"] == "local"` and `base_url`
        # is present and non-empty when provider == "local".
        return LocalLLMAdapter(base_url=str(config.auth["base_url"]))
    # Allowlist guarantees this is unreachable, but defend anyway.
    raise ValueError(f"unsupported provider: {config.provider!r}")
