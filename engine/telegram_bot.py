"""Phase 8c: bidirectional Telegram bot for ad-hoc Diligence runs.

Architecture (verified with Clawless Advisor 2026-05-17):

- Bot connects OUTBOUND to Telegram via `getUpdates` long-polling. Telegram
  queues incoming messages, this module pulls them. No open ports on the
  user's machine, no public URL, no cloud relay. Sidecar in the same
  process as the FastAPI engine (lifecycle-tied to the desktop app for v1;
  detached mode is queued v1.1).

- Inbound message handler is strictly defensive:
    1. Pull message, extract chat_id and text.
    2. If chat_id not in allowlist AND command is not /start: silently drop.
       Silent drop avoids leaking bot existence to scanners.
    3. Parse text: bare ticker (`NVDA`), `/analyze TICKER`, `/start`, `/help`.
    4. Enforce per-chat per-UTC-day cost cap before any LLM work.
    5. Run live debate, format compact reply (Telegram caps at 4096 chars).
    6. Increment per-chat daily counter by actual session cost.

- Allowlist is the primary defense against token-drain abuse. Cap is the
  secondary defense in case the bot token leaks. Per-chat counter persists
  to a JSON file beside the SQLite DB so the cap survives engine restart
  (otherwise an app-restart loop would evade the cap).

- The bot reuses the existing `live_debate` orchestrator, the existing
  `ProviderConfig` shape, and the existing `cost_guard` reservation flow.
  It does NOT duplicate debate logic; it's a thin trigger surface.

What v1 does NOT include:
- Detached sidecar (survives app close). Queued v1.1.
- Pairing-code first-run flow (`/start` -> approve in app UI). User adds
  chat_ids manually in Settings for v1.
- Streaming live updates per-agent into Telegram. Too noisy; v1 sends the
  decision summary on session.complete only.
- Multi-provider routing per chat. v1 uses the single default provider
  config the renderer ships on `/telegram/start`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx

from . import cost_guard, storage
from .data_providers import (
    DataUnavailable,
    Headline,
    QuoteSummary,
    default_provider,
)
from .live_debate import ProviderConfig, SentimentBlock, live_debate

logger = logging.getLogger(__name__)

# Telegram API constants. Long-poll timeout balances responsiveness against
# request count; 25s is the value Clawless OpenClaw uses and it stays below
# most NAT idle limits.
_API_BASE = "https://api.telegram.org/bot"
_LONG_POLL_TIMEOUT_S = 25
_HTTP_TIMEOUT_S = _LONG_POLL_TIMEOUT_S + 10
_REPLY_MAX_CHARS = 3900  # leave headroom below Telegram's 4096 ceiling

# httpx error strings embed the failing request URL, which for us is
# https://api.telegram.org/bot<TOKEN>/<method>. last_error is serialized to
# the renderer via the /telegram/* status endpoints and logged on every
# poll, so any error text MUST be scrubbed of the bot token first. Telegram
# tokens look like 123456789:AA...  (numeric id, colon, [A-Za-z0-9_-]).
_TOKEN_IN_URL_RE = re.compile(r"bot\d+:[\w-]+")


def _redact_token(text: str) -> str:
    """Strip any Telegram bot token embedded in a URL so it never reaches a
    log line or the renderer-facing status payload."""
    return _TOKEN_IN_URL_RE.sub("bot<redacted>", text)

# Ticker regex. Accepts bare ticker (uppercase letters, 1-8 chars, optional
# `-XYZ` suffix for crypto and adrs). Anchored so partial matches in long
# sentences are not treated as analyze requests; the user must send the
# ticker by itself.
_TICKER_RE = re.compile(r"^([A-Z]{1,8}(?:-[A-Z]{1,4})?)$")
_ANALYZE_CMD_RE = re.compile(r"^/analyze(?:@\w+)?\s+([A-Z]{1,8}(?:-[A-Z]{1,4})?)$", re.IGNORECASE)

# v1.1 progress streaming. For each phase boundary the live_debate yields,
# the bot sends one short status message so the mobile user sees movement.
# Map keys are the engine's phase names (see live_debate.py); values are
# the human strings sent to Telegram. Unknown phases (future additions)
# are silently skipped to keep the noise floor bounded.
_PHASE_PROGRESS_LABEL: dict[str, str] = {
    "researchers": "Analyst phase complete. Researchers debating now.",
    "trader": "Researchers complete. Trader synthesizing.",
    "risk": "Trader complete. Risk committee reviewing.",
}

# v1.2 reply modes. "summary" sends the phase headers + final decision
# (current default). "full" additionally sends every agent.message as a
# separate Telegram message so the mobile user sees the full transcript.
# Mode is per-chat, persisted to telegram_chat_modes.json so it survives
# engine restart and feels stable across sessions.
ReplyMode = Literal["summary", "full"]
DEFAULT_REPLY_MODE: ReplyMode = "summary"

# Friendly labels for agent roles in full-mode Telegram replies. The
# upstream agent names are snake_case; we humanize for display. Anything
# missing from this map falls back to the raw agent name title-cased.
_AGENT_LABEL: dict[str, str] = {
    "technical_analyst": "Technical Analyst",
    "fundamental_analyst": "Fundamental Analyst",
    "news_analyst": "News Analyst",
    "sentiment_analyst": "Sentiment Analyst",
    "bull_researcher": "Bull Researcher",
    "bear_researcher": "Bear Researcher",
    "research_manager": "Research Manager",
    "trader": "Trader",
    "risk_conservative": "Risk (Conservative)",
    "risk_neutral": "Risk (Neutral)",
    "risk_aggressive": "Risk (Aggressive)",
    "portfolio_manager": "Portfolio Manager",
}

# Per-agent message length cap. Telegram allows 4096 chars per message;
# 3500 leaves room for the role header + truncation marker + any markdown
# the agent's content already contains.
_AGENT_REPLY_MAX_CHARS = 3500

# v1.2 command menu. Telegram clients show this list when the user types
# "/" in a chat with the bot. setMyCommands is bot-wide; published once
# on each start() so a token rotation or new feature flag picks up new
# entries. Order matters: Telegram shows the list in this order.
_BOT_COMMANDS: list[dict[str, str]] = [
    {"command": "analyze", "description": "Run a Diligence (e.g. /analyze NVDA)"},
    {"command": "full",    "description": "Stream every agent's reasoning live"},
    {"command": "summary", "description": "Phase headers + decision only (default)"},
    {"command": "mode",    "description": "Show the current reply mode"},
    {"command": "help",    "description": "Show all commands and current mode"},
    {"command": "start",   "description": "Request approval to use the bot"},
]

# v1.3 persistent reply keyboard. Telegram shows this 2x2 grid below the
# message input so approved users can tap a button instead of typing a
# slash command. Each button label is a human phrase; the handler maps it
# back to the matching slash command. Telegram persists the keyboard
# across the chat once shown, so we attach it to messages going to
# allowlisted users only (pending/non-allowlisted users keep the regular
# keyboard so they can type freely).
_REPLY_KEYBOARD: dict[str, Any] = {
    "keyboard": [
        [{"text": "Full debate mode"}, {"text": "Summary mode"}],
        [{"text": "Current mode"},     {"text": "Help"}],
    ],
    "resize_keyboard": True,
    "is_persistent": True,
    "input_field_placeholder": "Send a ticker or tap a button",
}

# Friendly-label -> command mapping. Tapping the keyboard sends the button
# text as a message; we normalize to the slash command before the existing
# command dispatch fires. Match is case-insensitive on the exact label.
_LABEL_TO_COMMAND: dict[str, str] = {
    "full debate mode": "/full",
    "summary mode":     "/summary",
    "current mode":     "/mode",
    "help":             "/help",
}


@dataclass
class TelegramBotConfig:
    """Inbound configuration. Renderer ships this on `/telegram/start`."""

    token: str
    """Bot token from BotFather. URL-embedded auth, treat as a secret."""

    allowlist: set[int] = field(default_factory=set)
    """Numeric Telegram user IDs (chat_id values) allowed to trigger debates.
    Empty set means: only /start replies, no debate triggers. Locked default."""

    daily_cap_usd: float = 5.0
    """Per-chat per-UTC-day spend cap. Enforced before each debate. The
    chat receives a friendly reply when the cap is hit instead of running
    a debate. Set to 0 to disable triggers for a chat (effectively kill
    switch even if the chat is allowlisted)."""

    provider_config: dict[str, Any] = field(default_factory=dict)
    """The ProviderConfig dict the renderer is currently using on Analyze.
    Bot-triggered debates run through the same provider, model, and key.
    Stored only in memory in this process; never written to disk."""

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "TelegramBotConfig":
        return TelegramBotConfig(
            token=str(d["token"]),
            allowlist={int(x) for x in (d.get("allowlist") or [])},
            daily_cap_usd=float(d.get("daily_cap_usd", 5.0)),
            provider_config=dict(d.get("provider_config") or {}),
        )


@dataclass
class PendingApproval:
    """A first-run /start from a non-allowlisted user. Operator approves or
    denies via the Settings panel. Entries auto-expire after PENDING_TTL_S
    so a forgotten queue doesn't grow without bound."""

    chat_id: int
    first_name: str
    username: str  # Telegram @handle without the @, or "" if user has none
    first_seen: float  # epoch seconds

    def to_dict(self) -> dict[str, Any]:
        return {
            "chat_id": self.chat_id,
            "first_name": self.first_name,
            "username": self.username,
            "first_seen": self.first_seen,
        }


# Pending approvals expire after this many seconds. 30 minutes is long enough
# for a slow human approval workflow (operator may not be at the laptop) but
# short enough that a stale queue doesn't accumulate stranger requests over
# weeks.
PENDING_TTL_S = 30 * 60


@dataclass
class _BotStatus:
    enabled: bool = False
    polling: bool = False
    allowlist_size: int = 0
    last_update_id: Optional[int] = None
    last_error: Optional[str] = None
    daily_cap_usd: float = 0.0
    daily_spend_usd: dict[str, float] = field(default_factory=dict)
    """chat_id (str) -> dollars spent today (UTC). Reported to the renderer
    so a Settings UI can show real-time usage per chat."""
    pending_approvals: list[dict[str, Any]] = field(default_factory=list)
    """First-run /start requests awaiting operator approval. v1.1 pairing-
    flow UX. Each entry has chat_id, first_name, username, first_seen."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "polling": self.polling,
            "allowlist_size": self.allowlist_size,
            "last_update_id": self.last_update_id,
            "last_error": self.last_error,
            "daily_cap_usd": self.daily_cap_usd,
            "daily_spend_usd": dict(self.daily_spend_usd),
            "pending_approvals": list(self.pending_approvals),
        }


# ---- Persistence -----------------------------------------------------------
#
# Per-chat daily spend is persisted to a JSON file beside the SQLite DB.
# Format: {"date": "YYYY-MM-DD", "spend": {"<chat_id>": <usd>, ...}}.
# If `date` doesn't match today's UTC date on load, the file is treated
# as expired and the in-memory counter starts fresh. This way an app
# restart at any hour cannot reset the day's tally and evade the cap.


def _spend_file_path() -> Path:
    """Sibling to the SQLite DB. Imported lazily so the storage module's
    own initialization (which decides the user-data path) is not pulled
    in at import time."""
    from . import storage  # noqa: PLC0415 — circular avoidance

    return Path(storage.db_path()).parent / "telegram_spend.json"


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _load_spend() -> dict[str, float]:
    """Return today's spend dict, or empty if file missing / stale / corrupt."""
    path = _spend_file_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        if data.get("date") != _today_utc():
            return {}
        return {str(k): float(v) for k, v in (data.get("spend") or {}).items()}
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
        logger.warning("telegram_spend.json unreadable: %s", exc)
        return {}


def _atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` atomically: write a temp file in the same
    directory, fsync, then os.replace() into place. A process kill mid-write
    can only leave a stray .tmp file behind, never a truncated/corrupt target
    (the spend + modes files are the bot's only durable state)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        # If os.replace already succeeded the temp is gone; this only cleans
        # up when the write failed partway through.
        try:
            tmp.unlink()
        except OSError:
            pass


def _save_spend(spend: dict[str, float]) -> None:
    """Best-effort write. Failures are logged but do not abort dispatch."""
    path = _spend_file_path()
    try:
        _atomic_write_text(
            path,
            json.dumps({"date": _today_utc(), "spend": spend}, separators=(",", ":")),
        )
    except OSError as exc:
        logger.warning("failed to persist telegram_spend.json: %s", exc)


# Per-chat reply mode persistence. Separate file from spend because modes
# don't expire daily and benefit from being independent of the date check.
# Format: {"<chat_id>": "summary" | "full", ...}.


def _modes_file_path() -> Path:
    from . import storage  # noqa: PLC0415

    return Path(storage.db_path()).parent / "telegram_chat_modes.json"


def _load_modes() -> dict[str, ReplyMode]:
    path = _modes_file_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        out: dict[str, ReplyMode] = {}
        for k, v in data.items():
            if v in ("summary", "full"):
                out[str(k)] = v  # type: ignore[assignment]
        return out
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
        logger.warning("telegram_chat_modes.json unreadable: %s", exc)
        return {}


def _save_modes(modes: dict[str, ReplyMode]) -> None:
    path = _modes_file_path()
    try:
        _atomic_write_text(path, json.dumps(modes, separators=(",", ":")))
    except OSError as exc:
        logger.warning("failed to persist telegram_chat_modes.json: %s", exc)


# ---- The bot ---------------------------------------------------------------


class TelegramBot:
    """Owns the polling task, the inbound handler, and the per-chat spend
    counter. One instance per engine process. Start/stop are idempotent."""

    def __init__(self) -> None:
        self._config: Optional[TelegramBotConfig] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._status = _BotStatus()
        # Per-chat in-flight tracker: chat_id -> bool. Prevents stacking
        # multiple debates for the same user (each debate can be expensive
        # and the user would just see overlapping replies).
        self._busy: dict[int, bool] = {}
        self._spend: dict[str, float] = {}
        # Pending approval queue: chat_id -> PendingApproval. v1.1 first-
        # run flow. Operator approves via /telegram/approve; stays in
        # memory only because the queue is short-lived (PENDING_TTL_S).
        self._pending: dict[int, PendingApproval] = {}
        # Per-chat reply mode. v1.2 user preference: summary (phase
        # headers + decision) or full (every agent.message streamed).
        # Persisted to telegram_chat_modes.json so restarts are seamless.
        self._modes: dict[str, ReplyMode] = {}

    # ---- Public API ---------------------------------------------------

    async def start(self, config: TelegramBotConfig) -> None:
        """Start polling. Idempotent: if already running, a new start
        cancels the existing task and restarts with fresh config. This
        is how the renderer updates the allowlist or cap on the fly."""
        if not config.token:
            raise ValueError("telegram bot token is required")
        await self.stop()
        self._config = config
        self._status = _BotStatus(
            enabled=True,
            polling=False,
            allowlist_size=len(config.allowlist),
            daily_cap_usd=config.daily_cap_usd,
        )
        self._spend = _load_spend()
        self._status.daily_spend_usd = dict(self._spend)
        self._modes = _load_modes()
        self._client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S)
        # Publish the command menu so typing "/" in Telegram autocompletes
        # the available commands with descriptions. Fire-and-forget: this
        # is best-effort UX, not a startup precondition. A network blip
        # should not block the polling loop.
        asyncio.create_task(self._publish_commands(), name="telegram-bot-publish-commands")
        self._task = asyncio.create_task(self._poll_loop(), name="telegram-bot-poll")

    async def _publish_commands(self) -> None:
        """Register the command list with Telegram so the / menu populates.

        Idempotent on Telegram's side: calling setMyCommands with the same
        list is a no-op. Failures are logged but don't abort bot startup.
        """
        if self._client is None or self._config is None:
            return
        url = f"{_API_BASE}{self._config.token}/setMyCommands"
        try:
            await self._client.post(
                url,
                json={"commands": _BOT_COMMANDS},
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            logger.warning("telegram setMyCommands failed: %s", exc)

    async def stop(self) -> None:
        """Stop polling. Idempotent; safe to call when not running."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:  # noqa: BLE001 — best-effort
                pass
            self._client = None
        self._config = None
        self._status = _BotStatus()
        self._busy.clear()
        self._pending.clear()
        # Modes are NOT cleared here: they persist on disk and survive a
        # restart by design. Clearing in-memory just frees a small map.
        self._modes.clear()

    def status(self) -> _BotStatus:
        # Refresh dynamic fields before returning.
        self._status.daily_spend_usd = dict(self._spend)
        self._prune_pending()
        self._status.pending_approvals = [
            p.to_dict() for p in self._pending.values()
        ]
        if self._config is not None:
            self._status.allowlist_size = len(self._config.allowlist)
        return self._status

    def _prune_pending(self) -> None:
        """Drop expired pending entries. Called on status reads and on
        each handler invocation so a stranger's old /start eventually
        disappears even if the operator never opens Settings."""
        cutoff = time.time() - PENDING_TTL_S
        for cid in [c for c, p in self._pending.items() if p.first_seen < cutoff]:
            self._pending.pop(cid, None)

    async def approve(self, chat_id: int) -> bool:
        """Move a pending chat_id into the allowlist and DM the user.

        Returns True if the entry was approved, False if there was no
        pending entry for that chat_id (already approved or expired).
        Idempotent: re-approving an already-allowlisted chat is a no-op
        that returns True so the renderer can confirm state without
        racing the prune.
        """
        if self._config is None:
            return False
        self._prune_pending()
        pending = self._pending.pop(chat_id, None)
        already_in = chat_id in self._config.allowlist
        if pending is None and not already_in:
            return False
        self._config.allowlist.add(chat_id)
        try:
            await self._reply(
                chat_id,
                (
                    "You're approved. Send a ticker like `NVDA` or "
                    "`/analyze NVDA` to run a Diligence.\n\n"
                    "Modes:\n"
                    "  /summary  phase headers + final decision (default)\n"
                    "  /full     stream every agent's reasoning live\n"
                    "  /help     full command list\n\n"
                    "Daily spend cap is ${cap:.2f}.\n\n"
                    "_Educational output only. Not investment advice._"
                ).format(cap=self._config.daily_cap_usd),
                with_keyboard=True,
            )
        except Exception:  # noqa: BLE001 — DM failure shouldn't roll back approval
            logger.warning("approval DM failed for chat %s", chat_id)
        return True

    def deny(self, chat_id: int) -> bool:
        """Drop a pending entry without notifying the user. Returns True
        if there was an entry to drop, False otherwise."""
        self._prune_pending()
        return self._pending.pop(chat_id, None) is not None

    def refresh_credentials(self, provider_config: dict[str, Any]) -> bool:
        """Update the in-memory provider_config used for bot-triggered
        debates. Called by the renderer on a periodic interval when the
        active provider is OpenAI OAuth, so the engine always has a
        non-expired access token ready for the next debate.

        Returns True if the bot is running and credentials were updated,
        False if the bot is stopped (the renderer should handle the
        latter by simply skipping the refresh until next interval)."""
        if self._config is None:
            return False
        self._config.provider_config = dict(provider_config)
        return True

    # ---- Reply mode (v1.2) --------------------------------------------

    def _mode_for(self, chat_id: int) -> ReplyMode:
        return self._modes.get(str(chat_id), DEFAULT_REPLY_MODE)

    def _set_mode(self, chat_id: int, mode: ReplyMode) -> None:
        if mode not in ("summary", "full"):
            return
        self._modes[str(chat_id)] = mode
        _save_modes(self._modes)

    # ---- Polling loop -------------------------------------------------

    async def _poll_loop(self) -> None:
        """Pull updates from Telegram and dispatch handlers. Re-entrant
        on transient errors with exponential backoff."""
        assert self._client is not None and self._config is not None
        backoff = 1.0
        self._status.polling = True
        try:
            while True:
                try:
                    updates = await self._get_updates(self._status.last_update_id)
                    backoff = 1.0  # reset on success
                except asyncio.CancelledError:
                    raise
                except httpx.HTTPError as exc:
                    self._status.last_error = _redact_token(f"network: {exc}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                    continue
                except Exception as exc:  # noqa: BLE001 — keep loop alive
                    self._status.last_error = _redact_token(
                        f"{type(exc).__name__}: {exc}"
                    )
                    logger.exception("telegram bot poll error")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                    continue

                for update in updates:
                    self._status.last_update_id = int(update.get("update_id", 0))
                    message = update.get("message")
                    if isinstance(message, dict):
                        # Fire-and-forget so the polling loop keeps draining
                        # Telegram's queue while a debate runs in another task.
                        asyncio.create_task(
                            self._handle_message(message),
                            name=f"telegram-handle-{self._status.last_update_id}",
                        )
        finally:
            self._status.polling = False

    async def _get_updates(self, offset: Optional[int]) -> list[dict[str, Any]]:
        assert self._client is not None and self._config is not None
        params: dict[str, Any] = {
            "timeout": _LONG_POLL_TIMEOUT_S,
            "allowed_updates": ["message"],
        }
        if offset is not None:
            params["offset"] = offset + 1
        url = f"{_API_BASE}{self._config.token}/getUpdates"
        resp = await self._client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"telegram getUpdates not ok: {data}")
        return list(data.get("result", []))

    # ---- Handler ------------------------------------------------------

    async def _handle_message(self, message: dict[str, Any]) -> None:
        assert self._config is not None
        text = str(message.get("text", "")).strip()
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if not isinstance(chat_id, int):
            return  # bot DMs only carry int chat_ids; ignore the rest

        # v1.3 reply-keyboard normalization. Tapping a button on the
        # persistent keyboard sends the friendly label as text; map it
        # back to the matching slash command so the existing dispatch
        # below treats both inputs identically.
        normalized = _LABEL_TO_COMMAND.get(text.lower())
        if normalized is not None:
            text = normalized

        cmd = text.split()[0].lower() if text else ""

        # /start handler. Three states:
        #   1. already allowlisted -> friendly "you're already in" reply
        #   2. has a pending entry -> "still waiting" reply
        #   3. brand new          -> create pending entry, reply queued
        # /start always replies so the user knows the bot heard them; the
        # silent-drop posture only applies to debate triggers, not pairing.
        if cmd.startswith("/start") or cmd.startswith("/whoami"):
            self._prune_pending()
            if chat_id in self._config.allowlist:
                # /start from an already-allowlisted user is typically the
                # operator pinging the bot after a restart to confirm it's
                # online. Skip the "you're approved" framing (they know);
                # surface system-ready status + the current mode so the
                # ping returns useful state, not just a yes.
                mode = self._mode_for(chat_id)
                await self._reply(
                    chat_id,
                    (
                        "Trading Agents Lab is ready.\n\n"
                        "Mode: *{mode}*. Send a ticker like `NVDA` or "
                        "`/analyze NVDA` to run a Diligence. Send `/help` "
                        "for the command list."
                    ).format(mode=mode),
                    with_keyboard=True,
                )
                return
            first_name = str(
                (chat.get("first_name") or message.get("from", {}).get("first_name") or "")
            )[:80]
            username = str(
                (chat.get("username") or message.get("from", {}).get("username") or "")
            )[:64]
            if chat_id not in self._pending:
                self._pending[chat_id] = PendingApproval(
                    chat_id=chat_id,
                    first_name=first_name,
                    username=username,
                    first_seen=time.time(),
                )
            ttl_min = PENDING_TTL_S // 60
            await self._reply(
                chat_id,
                (
                    "Hello{name}. Your chat_id is `{cid}`.\n\n"
                    "I've queued your request. The bot operator can approve "
                    "you from the Trading Agents Lab Settings panel. The "
                    "queue entry expires in {ttl} minutes if not approved; "
                    "send `/start` again to re-queue."
                ).format(
                    name=f" {first_name}" if first_name else "",
                    cid=chat_id,
                    ttl=ttl_min,
                ),
            )
            return

        if chat_id not in self._config.allowlist:
            # Silent drop for debate triggers. Don't leak the bot's
            # existence to randoms who didn't go through /start.
            return

        # Mode toggles. /full and /summary set the per-chat reply mode
        # and persist it across restarts. /mode echoes the current state
        # so the user can sanity-check before sending a ticker.
        if cmd.startswith("/full"):
            self._set_mode(chat_id, "full")
            await self._reply(
                chat_id,
                (
                    "Full debate mode on. You'll get every agent's reasoning "
                    "streamed as the debate runs (around a dozen messages "
                    "per ticker), followed by the final decision card. Send "
                    "`/summary` to switch back."
                ),
                with_keyboard=True,
            )
            return
        if cmd.startswith("/summary"):
            self._set_mode(chat_id, "summary")
            await self._reply(
                chat_id,
                (
                    "Summary mode on. You'll get phase headers and the final "
                    "decision card. Send `/full` to get the full transcript "
                    "streamed instead."
                ),
                with_keyboard=True,
            )
            return
        if cmd.startswith("/mode"):
            mode = self._mode_for(chat_id)
            await self._reply(
                chat_id,
                f"Current mode: *{mode}*. Toggle with `/full` or `/summary`.",
                with_keyboard=True,
            )
            return

        if cmd.startswith("/help"):
            mode = self._mode_for(chat_id)
            await self._reply(
                chat_id,
                (
                    "Trading Agents Lab bot.\n\n"
                    "Send a ticker by itself (`NVDA`, `BTC-USD`) to run a "
                    "Diligence. Or use `/analyze NVDA`.\n\n"
                    "Modes (per chat, persisted across restarts):\n"
                    "  /summary  phase headers + final decision (default)\n"
                    "  /full     every agent's reasoning streamed live\n"
                    "  /mode     show the current mode\n\n"
                    "Currently: *{mode}*. Daily spend cap is ${cap:.2f}.\n\n"
                    "Output is educational only. Not investment advice."
                ).format(mode=mode, cap=self._config.daily_cap_usd),
                with_keyboard=True,
            )
            return

        ticker = self._parse_ticker(text)
        if ticker is None:
            await self._reply(
                chat_id,
                (
                    "I didn't see a ticker. Send `NVDA`, `/analyze NVDA`, or "
                    "`/help`."
                ),
                with_keyboard=True,
            )
            return

        if self._busy.get(chat_id):
            await self._reply(
                chat_id,
                "Still working on your previous request. Hold tight.",
                with_keyboard=True,
            )
            return

        # Cap check BEFORE any LLM work.
        spent = self._spend.get(str(chat_id), 0.0)
        if spent >= self._config.daily_cap_usd:
            await self._reply(
                chat_id,
                (
                    "Daily cap reached for this chat (${cap:.2f}). The cap "
                    "resets at UTC midnight. Currently spent: ${spent:.2f}."
                ).format(cap=self._config.daily_cap_usd, spent=spent),
                with_keyboard=True,
            )
            return

        self._busy[chat_id] = True
        try:
            await self._run_debate(chat_id=chat_id, ticker=ticker)
        finally:
            self._busy[chat_id] = False

    @staticmethod
    def _parse_ticker(text: str) -> Optional[str]:
        """Return ticker uppercase, or None if the message isn't a ticker
        request. Supports bare ticker and `/analyze TICKER`."""
        if not text:
            return None
        cleaned = text.strip()
        # `/analyze TICKER` (case-insensitive command, ticker uppercased)
        m = _ANALYZE_CMD_RE.match(cleaned)
        if m:
            return m.group(1).upper()
        # Bare ticker, all caps
        m = _TICKER_RE.match(cleaned.upper())
        if m:
            return m.group(1)
        return None

    # ---- Debate runner ------------------------------------------------

    async def _run_debate(self, *, chat_id: int, ticker: str) -> None:
        assert self._config is not None
        trade_date = _today_utc()

        # Fetch data block for the prompt context. Failures are non-fatal:
        # the debate still runs without summary / headlines if the data
        # provider is unreachable.
        summary: Optional[QuoteSummary] = None
        headlines: list[Headline] = []
        try:
            summary = await default_provider.quote_summary(
                ticker=ticker, trade_date=trade_date
            )
        except DataUnavailable:
            pass
        except Exception:  # noqa: BLE001
            pass
        try:
            headlines = list(
                await default_provider.news_headlines(ticker=ticker, limit=5)
            )
        except Exception:  # noqa: BLE001
            pass

        provider_config = ProviderConfig.from_dict(self._config.provider_config)
        if provider_config is None:
            await self._reply(
                chat_id,
                (
                    "No LLM provider configured. Set one up in Trading "
                    "Agents Lab Settings -> LLM Providers and restart the "
                    "bot from Settings -> Telegram Bot."
                ),
            )
            return

        # Global CostGuard reservation. The per-chat daily cap above limits
        # abuse per Telegram chat; this reservation makes bot debates also
        # count against the SAME global daily/weekly/monthly USD caps the
        # desktop Analyze page uses, so a user can't bypass their budget by
        # running from Telegram. live_debate finalizes this with the actual
        # cost when the stream ends. OAuth/local runs reserve $0 (worst-case
        # cost is zero), so they never block here — matching the WS path.
        reservation_id: Optional[str] = None
        try:
            reservation = cost_guard.reserve(
                model=provider_config.model,
                auth_kind=provider_config.auth_kind,
                max_tokens=provider_config.max_tokens,
                override=False,
            )
            reservation_id = reservation.reservation_id
        except cost_guard.CostGuardBlocked as exc:
            await self._reply(
                chat_id,
                (
                    f"Global spend cap reached: this run would exceed your "
                    f"{exc.over_dimension} cap. Raise the caps in Trading "
                    f"Agents Lab Settings -> Cost Guard, then try again."
                ),
                with_keyboard=True,
            )
            return

        await self._reply(
            chat_id,
            f"Running Diligence on {ticker} for {trade_date}. This usually takes a few minutes.",
            with_keyboard=True,
        )

        mode = self._mode_for(chat_id)
        decision: Optional[dict[str, Any]] = None
        cost_usd: float = 0.0
        live = False
        # Capture every event so the debate lands in the same `sessions` table
        # the WS path writes to. Without this, bot debates never appear in
        # History and — more importantly — the global spend ledger loses
        # their cost when the 15-min reservation TTL expires before
        # finalize_reservation runs (slow Claude / large local models).
        events: list[dict] = []
        try:
            async for event in live_debate(
                ticker=ticker,
                trade_date=trade_date,
                summary=summary,
                headlines=headlines,
                config=provider_config,
                reservation_id=reservation_id,
                sentiment=SentimentBlock(),
            ):
                events.append(event)
                etype = event.get("type")
                if etype == "phase.transition":
                    # v1.1: forward mid-debate phase boundaries so the user
                    # on mobile sees progress instead of a 5-minute silence.
                    # Only forward transitions with a recognized "to" phase
                    # to avoid spam from spurious or future-added phases.
                    label = _PHASE_PROGRESS_LABEL.get(str(event.get("to") or ""))
                    if label:
                        await self._reply(chat_id, label)
                elif etype == "agent.message" and mode == "full":
                    # v1.2: in full mode, forward every agent's reasoning
                    # as its own Telegram message. The Analyze page shows
                    # these tagged by role; we mirror the same shape so a
                    # mobile reader gets the full transcript.
                    await self._reply(
                        chat_id, _format_agent_message(event)
                    )
                elif etype == "session.complete":
                    decision = event.get("decision")
                    cost_usd = float(event.get("estimated_cost_usd") or 0.0)
                    live = bool(event.get("live"))
        except Exception as exc:  # noqa: BLE001 — surface, don't crash bot
            logger.exception("debate failed for chat %s ticker %s", chat_id, ticker)
            await self._reply(chat_id, f"Debate failed: {type(exc).__name__}: {exc}")
            return

        # Persist before checking `decision is None`: the helper itself only
        # writes when session.complete is present, so this is a no-op for
        # aborted streams. write_session_from_events is best-effort and
        # never raises — failures log to stderr.
        storage.write_session_from_events(
            ticker=ticker, trade_date=trade_date, events=events
        )

        if decision is None:
            await self._reply(
                chat_id, "Debate finished without a decision. Please try again."
            )
            return

        # Record spend before sending the reply. If the reply fails for any
        # reason we still want the cap to reflect work that did happen.
        if cost_usd > 0:
            self._spend[str(chat_id)] = self._spend.get(str(chat_id), 0.0) + cost_usd
            _save_spend(self._spend)
            self._status.daily_spend_usd = dict(self._spend)

        await self._reply(
            chat_id,
            _format_decision_reply(
                ticker=ticker,
                trade_date=trade_date,
                decision=decision,
                cost_usd=cost_usd,
                live=live,
                cap_usd=self._config.daily_cap_usd,
                spent_today=self._spend.get(str(chat_id), 0.0),
            ),
            with_keyboard=True,
        )

    # ---- Outbound -----------------------------------------------------

    async def _reply(
        self,
        chat_id: int,
        text: str,
        *,
        with_keyboard: bool = False,
    ) -> None:
        """Send a Telegram DM. Pass `with_keyboard=True` to attach the
        persistent reply keyboard (for allowlisted users). Pending users
        get the standard keyboard so they can still type freely."""
        # stop() cancels the poll loop but not in-flight fire-and-forget
        # message handlers; one resuming after stop() has nulled _client must
        # drop its reply gracefully rather than raise from an assert.
        if self._client is None or self._config is None:
            return
        # Truncate to Telegram's effective ceiling, preserving headroom for
        # the trailing disclaimer line in the formatter (already accounted
        # for via _REPLY_MAX_CHARS but defensive trim is cheap).
        if len(text) > _REPLY_MAX_CHARS:
            text = text[: _REPLY_MAX_CHARS - 1] + "…"
        url = f"{_API_BASE}{self._config.token}/sendMessage"
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }
        if with_keyboard:
            payload["reply_markup"] = _REPLY_KEYBOARD
        try:
            await self._client.post(url, json=payload, timeout=10.0)
        except httpx.HTTPError as exc:
            logger.warning("telegram sendMessage failed: %s", exc)


def _format_agent_message(event: dict[str, Any]) -> str:
    """Render an `agent.message` event for Telegram full-mode streaming.

    The Analyze page tags each message with role + phase; we surface the
    same info as a Markdown header so a mobile reader gets the same
    structure they'd see on the desktop transcript.
    """
    agent = str(event.get("agent") or "agent")
    phase = str(event.get("phase") or "")
    content = str(event.get("content") or "").strip()
    label = _AGENT_LABEL.get(agent, agent.replace("_", " ").title())
    if len(content) > _AGENT_REPLY_MAX_CHARS:
        content = content[: _AGENT_REPLY_MAX_CHARS - 1] + "…"
    header = f"*[{label}]*"
    if phase:
        header += f" _phase: {phase}_"
    return f"{header}\n\n{content}"


def _format_decision_reply(
    *,
    ticker: str,
    trade_date: str,
    decision: dict[str, Any],
    cost_usd: float,
    live: bool,
    cap_usd: float,
    spent_today: float,
) -> str:
    action = str(decision.get("action", "HOLD")).upper()
    confidence = float(decision.get("confidence", 0.0))
    reasoning = str(decision.get("reasoning", "")).strip()
    if len(reasoning) > 600:
        reasoning = reasoning[:597] + "…"
    mode = "live" if live else "stub"
    return (
        f"*{ticker}* on {trade_date}\n"
        f"Decision: *{action}*  ({confidence * 100:.0f}% confidence)\n\n"
        f"{reasoning}\n\n"
        f"_Run mode: {mode}. Cost: ${cost_usd:.4f}. Today: "
        f"${spent_today:.4f} / ${cap_usd:.2f}._\n"
        f"_Educational output. Not investment advice. Not a recommendation._"
    )
