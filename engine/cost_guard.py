"""Cost Guard — budget caps + reservation gating for live LLM debates.

Enforces per-(day, week, month) USD spending caps plus an optional
sessions-per-day rate cap. Lives entirely in the Python engine because the
LLM transport, token counts, and cost calculations all happen here — putting
the gate in Electron main would require cross-process TOCTOU sync between
"reservation" (Node) and "finalization" (Python). One process is cleaner.

## Tables

Three new tables join the existing `sessions` schema:

- `cost_guard_config` — single row (id=1) holding the user's cap settings.
- `cost_reservations` — one row per in-flight session. TOCTOU gate.
- `sessions.auth_kind` — additive column on the existing sessions table so
  we can exclude OAuth sessions from the cost-cap aggregation (their
  per-token cost is $0 — they bill against the ChatGPT subscription).

## Flow

1. Renderer calls `check()` to preview whether a debate would fit under caps.
2. If it fits (or user clicks Override), renderer calls `reserve()` — which
   atomically reads current spend, computes a worst-case ceiling for the
   new session, decides allow/deny, and (on allow) inserts a reservation row.
3. The reservation_id rides on the WS start frame.
4. Inside `live_debate.py`'s try/finally, `finalize_reservation()` updates
   the row with the actual cost and marks it finalized.

## TTL & crash recovery

Reservations have a 15-minute TTL. If the engine is killed mid-debate, the
reservation stays as `finalized=0` until either:

- The next `reserve()` call sweeps it (every reserve runs `_sweep_expired()`)
- The startup sweep runs it (called from `initialize()`)

Until swept, an expired reservation is filtered out of spend aggregation by
the `expires_at > now` clause in `_compute_spend()` — so a hard crash
doesn't permanently inflate apparent spend. 15 min is long enough for the
slowest realistic Anthropic debate, short enough that the user isn't
blocked on a stale reservation.

## OAuth policy

OAuth sessions (auth_kind='oauth') skip the cost cap entirely (cost is $0,
billed via subscription) but still count toward the rate cap if enabled.
The architect's call: don't double-charge subscription users on a
per-token cap that doesn't apply to them, but optionally protect their
finite ChatGPT quota with a rate cap.
"""

from __future__ import annotations

import os
import secrets as _secrets
import sqlite3
import sys
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal, Optional

from .llm_providers import _COST_PER_M_TOKENS
from .live_debate import MAX_AGENTS_PER_SESSION


# ---- Schema -----------------------------------------------------------------

# Schema version for the CostGuard subsystem. Storage.py owns the master
# version; this is only here so tests + diagnostics can sanity-check.
COST_GUARD_SCHEMA_VERSION = 1


_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS cost_guard_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    cap_daily_usd REAL NOT NULL DEFAULT 1.00,
    cap_weekly_usd REAL NOT NULL DEFAULT 5.00,
    cap_monthly_usd REAL NOT NULL DEFAULT 15.00,
    cap_sessions_per_day INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_reservations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    est_cost_usd REAL NOT NULL,
    auth_kind TEXT NOT NULL,
    override INTEGER NOT NULL DEFAULT 0,
    finalized INTEGER NOT NULL DEFAULT 0,
    finalized_cost_usd REAL
);

CREATE INDEX IF NOT EXISTS cost_reservations_finalized_idx
    ON cost_reservations(finalized, expires_at);
"""

_SEED_CONFIG_SQL = """
INSERT OR IGNORE INTO cost_guard_config (
    id, enabled, cap_daily_usd, cap_weekly_usd, cap_monthly_usd,
    cap_sessions_per_day, updated_at
) VALUES (1, 1, 1.00, 5.00, 15.00, 0, ?);
"""


# Reservations expire after this many seconds. Slowest realistic Anthropic
# Claude debate is ~6 min; 15 min covers it with headroom and recovers
# quickly from a hard crash.
RESERVATION_TTL_SECONDS = 15 * 60


# ---- Dataclasses ------------------------------------------------------------


@dataclass
class CostGuardConfig:
    enabled: bool
    cap_daily_usd: float
    cap_weekly_usd: float
    cap_monthly_usd: float
    cap_sessions_per_day: int
    updated_at: str


@dataclass
class SpendState:
    """Aggregated spend across the three windows + session counts."""

    daily_usd: float
    weekly_usd: float
    monthly_usd: float
    sessions_today: int


@dataclass
class CheckResult:
    allow: bool
    over_dimension: Optional[str]  # "daily" | "weekly" | "monthly" | "rate" | None
    override_available: bool
    current: SpendState
    config: CostGuardConfig
    est_reservation_usd: float


@dataclass
class ReserveResult:
    reservation_id: str
    est_cost_usd: float
    expires_at: str
    auth_kind: str
    override: bool


# ---- Window math ------------------------------------------------------------


_WindowName = Literal["day", "week", "month"]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    """ISO-8601 in UTC with trailing Z (matches storage.py's format)."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _window_start(window: _WindowName, *, now: Optional[datetime] = None) -> str:
    """ISO-8601 start of the window containing `now` (or current UTC time).

    - day: 00:00:00Z of today
    - week: 00:00:00Z of Monday of this ISO week
    - month: 00:00:00Z of the first day of this calendar month
    """
    n = now or _utcnow()
    n = n.astimezone(timezone.utc)
    if window == "day":
        start = n.replace(hour=0, minute=0, second=0, microsecond=0)
    elif window == "week":
        # ISO week starts Monday. weekday() = 0 for Mon, 6 for Sun.
        start = n.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=n.weekday())
    elif window == "month":
        start = n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:  # pragma: no cover — Literal guards this
        raise ValueError(f"unknown window: {window!r}")
    return _iso(start)


# ---- Worst-case reservation -------------------------------------------------


def worst_case_reservation(
    *,
    model: str,
    auth_kind: str,
    max_tokens: int,
) -> float:
    """Conservative upper-bound USD estimate for a single live debate.

    OAuth sessions always return 0.0 — they bill via subscription, not
    per-token. Unknown models (e.g. OpenRouter passthrough) also return
    0.0 so the cost cap doesn't block what we can't price; the rate cap
    can still be set if the user wants quota discipline there.

    For known per-token models: assumes all 12 agents max out their output
    cap (the expensive direction) AND the input transcript grows
    triangularly across agents (later agents see all prior turns).
    """
    # OAuth (subscription) and local LLM runs are both effectively $0 from
    # the engine's perspective — OAuth bills via the user's ChatGPT plan,
    # local runs entirely on the user's machine. Skip the USD math.
    if auth_kind in ("oauth", "local"):
        return 0.0
    rates = _COST_PER_M_TOKENS.get(model)
    if rates is None:
        return 0.0
    n = MAX_AGENTS_PER_SESSION
    # Output: every agent maxes its budget. (Worst case.)
    max_out_tokens = n * max_tokens
    # Input: per-agent ~600 tokens of fixed context, plus prior turns.
    # Sum over agents 0..n-1 of prior agents' output: 0+1+2+…+(n-1) = n*(n-1)/2.
    fixed_input_per_agent = 600
    growth_input_tokens = (n * (n - 1) // 2) * max_tokens
    max_in_tokens = n * fixed_input_per_agent + growth_input_tokens
    return (max_in_tokens * rates["input"] + max_out_tokens * rates["output"]) / 1_000_000


# ---- DB plumbing (delegates to storage._connect via a path lookup) --------
#
# We don't import _connect from storage.py to avoid coupling test setups; the
# DB path is the same. Tests can override TAL_SESSIONS_DB before initialize().


def _default_db_path() -> Path:
    override = os.environ.get("TAL_SESSIONS_DB")
    if override:
        return Path(override).expanduser().resolve()
    repo = Path.cwd()
    return (repo / "data" / "sessions.db").resolve()


_db_path: Path = _default_db_path()


def _reset_for_tests() -> None:
    """Test helper — re-resolve the path after a TAL_SESSIONS_DB change."""
    global _db_path
    _db_path = _default_db_path()


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        # Wait up to 5s for a competing writer instead of immediately raising
        # "database is locked". The bot and the WS handler can finalize spend
        # concurrently; without this a lock collision is swallowed by the
        # finalize except-block and silently understates the cost ledger.
        conn.execute("PRAGMA busy_timeout=5000")
        yield conn
    finally:
        conn.close()


def _new_reservation_id() -> str:
    """Same shape as storage._new_id — sortable + URL-safe."""
    ms = int(time.time() * 1000)
    rand = _secrets.token_hex(4)
    return f"{ms:012x}-{rand}"


# ---- Public API -------------------------------------------------------------


def initialize() -> None:
    """Create CostGuard tables, seed the config row, sweep stale reservations.

    Also ensures the parent `sessions` table exists by re-entering
    `storage._ensure_initialized()` (which sets `_initialized=True` before
    calling us, so the re-entry is a no-op).

    Idempotent. Called from `storage._ensure_initialized()` AND from every
    public CostGuard function so callers don't need to know the order.
    """
    # Ensure the sessions table exists before _compute_spend queries it.
    # storage sets `_initialized = True` before calling cost_guard.initialize,
    # so this re-entry is a cheap no-op when called from storage. When called
    # standalone (tests, direct API entry), this creates the sessions table.
    from . import storage as _storage

    _storage._ensure_initialized()
    _reset_for_tests()  # re-resolve path in case TAL_SESSIONS_DB changed
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(_SCHEMA_DDL)
        conn.execute(_SEED_CONFIG_SQL, (_iso(_utcnow()),))
        # Sweep any reservations that expired while the engine was down.
        _sweep_expired_reservations(conn)
        conn.commit()


def get_config() -> CostGuardConfig:
    initialize()
    with _connect() as conn:
        row = conn.execute(
            "SELECT enabled, cap_daily_usd, cap_weekly_usd, cap_monthly_usd, "
            "cap_sessions_per_day, updated_at FROM cost_guard_config WHERE id=1"
        ).fetchone()
    return _row_to_config(row)


def update_config(
    *,
    enabled: Optional[bool] = None,
    cap_daily_usd: Optional[float] = None,
    cap_weekly_usd: Optional[float] = None,
    cap_monthly_usd: Optional[float] = None,
    cap_sessions_per_day: Optional[int] = None,
) -> CostGuardConfig:
    """Patch the singleton config row. Only provided fields are updated."""
    initialize()
    current = get_config()
    new_enabled = current.enabled if enabled is None else bool(enabled)
    new_daily = current.cap_daily_usd if cap_daily_usd is None else max(0.0, float(cap_daily_usd))
    new_weekly = current.cap_weekly_usd if cap_weekly_usd is None else max(0.0, float(cap_weekly_usd))
    new_monthly = current.cap_monthly_usd if cap_monthly_usd is None else max(0.0, float(cap_monthly_usd))
    new_rate = current.cap_sessions_per_day if cap_sessions_per_day is None else max(0, int(cap_sessions_per_day))
    updated_at = _iso(_utcnow())
    with _connect() as conn:
        conn.execute(
            """
            UPDATE cost_guard_config
            SET enabled = ?, cap_daily_usd = ?, cap_weekly_usd = ?,
                cap_monthly_usd = ?, cap_sessions_per_day = ?, updated_at = ?
            WHERE id = 1
            """,
            (1 if new_enabled else 0, new_daily, new_weekly, new_monthly, new_rate, updated_at),
        )
        conn.commit()
    return CostGuardConfig(
        enabled=new_enabled,
        cap_daily_usd=new_daily,
        cap_weekly_usd=new_weekly,
        cap_monthly_usd=new_monthly,
        cap_sessions_per_day=new_rate,
        updated_at=updated_at,
    )


def get_state() -> tuple[SpendState, CostGuardConfig]:
    """Return current spend + config for renderer status displays."""
    initialize()
    config = get_config()
    with _connect() as conn:
        _sweep_expired_reservations(conn)
        spend = _compute_spend(conn)
        conn.commit()
    return spend, config


def check(
    *,
    model: str,
    auth_kind: str,
    max_tokens: int,
) -> CheckResult:
    """Non-mutating preview: would this session be allowed under current caps?

    Computes worst-case cost, reads current spend, returns allow/deny. Does
    NOT create a reservation. Safe for "preview" UI calls.
    """
    initialize()
    config = get_config()
    est = worst_case_reservation(model=model, auth_kind=auth_kind, max_tokens=max_tokens)
    with _connect() as conn:
        _sweep_expired_reservations(conn)
        spend = _compute_spend(conn)
        conn.commit()
    if not config.enabled:
        return CheckResult(
            allow=True,
            over_dimension=None,
            override_available=True,
            current=spend,
            config=config,
            est_reservation_usd=est,
        )
    over = _exceeds_any_cap(spend=spend, config=config, est_cost=est, auth_kind=auth_kind)
    return CheckResult(
        allow=over is None,
        over_dimension=over,
        override_available=True,
        current=spend,
        config=config,
        est_reservation_usd=est,
    )


def reserve(
    *,
    model: str,
    auth_kind: str,
    max_tokens: int,
    override: bool = False,
) -> ReserveResult:
    """Atomically check-and-insert a reservation row.

    Raises CostGuardBlocked if the caps would be exceeded and override=False.
    On success, the reservation_id must accompany the WS start frame and be
    finalized via `finalize_reservation()` when the debate ends.
    """
    initialize()
    config = get_config()
    est = worst_case_reservation(model=model, auth_kind=auth_kind, max_tokens=max_tokens)
    rid = _new_reservation_id()
    now = _utcnow()
    expires = now + timedelta(seconds=RESERVATION_TTL_SECONDS)
    with _connect() as conn:
        # Single transaction: sweep, check, insert.
        _sweep_expired_reservations(conn)
        spend = _compute_spend(conn)
        if config.enabled and not override:
            over = _exceeds_any_cap(spend=spend, config=config, est_cost=est, auth_kind=auth_kind)
            if over is not None:
                conn.rollback()
                raise CostGuardBlocked(
                    over_dimension=over,
                    spend=spend,
                    config=config,
                    est_cost=est,
                )
        conn.execute(
            """
            INSERT INTO cost_reservations (
                id, created_at, expires_at, est_cost_usd, auth_kind,
                override, finalized, finalized_cost_usd
            ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
            """,
            (rid, _iso(now), _iso(expires), est, auth_kind, 1 if override else 0),
        )
        conn.commit()
    return ReserveResult(
        reservation_id=rid,
        est_cost_usd=est,
        expires_at=_iso(expires),
        auth_kind=auth_kind,
        override=override,
    )


def finalize_reservation(reservation_id: str, *, actual_cost_usd: float) -> bool:
    """Mark a reservation as finalized with the real cost.

    Idempotent — calling twice is fine. Returns True if a row was updated,
    False if the reservation_id was unknown (which is logged but not raised
    so live_debate's finally block is robust to weird states).
    """
    if not reservation_id:
        return False
    try:
        initialize()
        with _connect() as conn:
            cur = conn.execute(
                """
                UPDATE cost_reservations
                SET finalized = 1, finalized_cost_usd = ?
                WHERE id = ? AND finalized = 0
                """,
                (max(0.0, float(actual_cost_usd)), reservation_id),
            )
            conn.commit()
            return cur.rowcount > 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            f"[cost_guard] finalize failed for {reservation_id}: "
            f"{type(exc).__name__}: {exc}\n"
        )
        return False


# ---- Internals --------------------------------------------------------------


def _row_to_config(row: sqlite3.Row) -> CostGuardConfig:
    return CostGuardConfig(
        enabled=bool(row["enabled"]),
        cap_daily_usd=float(row["cap_daily_usd"]),
        cap_weekly_usd=float(row["cap_weekly_usd"]),
        cap_monthly_usd=float(row["cap_monthly_usd"]),
        cap_sessions_per_day=int(row["cap_sessions_per_day"]),
        updated_at=str(row["updated_at"]),
    )


def _sweep_expired_reservations(conn: sqlite3.Connection) -> int:
    """Mark reservations finalized whose expires_at is in the past.

    Returns the number of swept rows. Caller is responsible for commit.
    """
    cur = conn.execute(
        "UPDATE cost_reservations SET finalized = 1 "
        "WHERE finalized = 0 AND expires_at < ?",
        (_iso(_utcnow()),),
    )
    return cur.rowcount


def _compute_spend(conn: sqlite3.Connection) -> SpendState:
    """Aggregate completed-session cost + active-reservation cost per window.

    OAuth sessions are excluded from the cost sums (they're $0). Session
    counts include all live sessions regardless of auth_kind so the rate
    cap covers OAuth quota.
    """
    now = _iso(_utcnow())
    day_start = _window_start("day")
    week_start = _window_start("week")
    month_start = _window_start("month")

    def cost_sum(since: str) -> float:
        # Older sessions may have NULL auth_kind (predates the column). Treat
        # NULL as api_key — they recorded a non-zero estimated_cost_usd, so
        # they were definitely API-tier billing. The ledger remains coherent.
        row = conn.execute(
            """
            SELECT COALESCE(SUM(estimated_cost_usd), 0)
            FROM sessions
            WHERE live = 1
              AND estimated_cost_usd IS NOT NULL
              AND (auth_kind IS NULL OR auth_kind = 'api_key')
              AND created_at >= ?
            """,
            (since,),
        ).fetchone()
        return float(row[0])

    def reserved_cost(since: str) -> float:
        row = conn.execute(
            """
            SELECT COALESCE(SUM(est_cost_usd), 0)
            FROM cost_reservations
            WHERE finalized = 0
              AND expires_at > ?
              AND auth_kind = 'api_key'
              AND created_at >= ?
            """,
            (now, since),
        ).fetchone()
        return float(row[0])

    def session_count(since: str) -> int:
        row = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE live = 1 AND created_at >= ?",
            (since,),
        ).fetchone()
        return int(row[0])

    def reserved_count(since: str) -> int:
        row = conn.execute(
            """
            SELECT COUNT(*) FROM cost_reservations
            WHERE finalized = 0 AND expires_at > ? AND created_at >= ?
            """,
            (now, since),
        ).fetchone()
        return int(row[0])

    return SpendState(
        daily_usd=round(cost_sum(day_start) + reserved_cost(day_start), 6),
        weekly_usd=round(cost_sum(week_start) + reserved_cost(week_start), 6),
        monthly_usd=round(cost_sum(month_start) + reserved_cost(month_start), 6),
        sessions_today=session_count(day_start) + reserved_count(day_start),
    )


def _exceeds_any_cap(
    *,
    spend: SpendState,
    config: CostGuardConfig,
    est_cost: float,
    auth_kind: str,
) -> Optional[str]:
    """Return the first cap dimension exceeded by adding `est_cost` to spend.

    OAuth and local sessions skip the three USD caps (cost is $0) but still
    hit the rate cap — even free LLM runs benefit from quota discipline on
    runaway debate counts. A USD cap of 0 means "disabled" (skipped), per
    UI convention. Same for sessions_per_day = 0.
    """
    if auth_kind not in ("oauth", "local"):
        if config.cap_daily_usd > 0 and spend.daily_usd + est_cost > config.cap_daily_usd:
            return "daily"
        if config.cap_weekly_usd > 0 and spend.weekly_usd + est_cost > config.cap_weekly_usd:
            return "weekly"
        if config.cap_monthly_usd > 0 and spend.monthly_usd + est_cost > config.cap_monthly_usd:
            return "monthly"
    if config.cap_sessions_per_day > 0 and spend.sessions_today + 1 > config.cap_sessions_per_day:
        return "rate"
    return None


# ---- Errors -----------------------------------------------------------------


class CostGuardBlocked(RuntimeError):
    """Raised by reserve() when caps would be exceeded and override=False."""

    def __init__(
        self,
        *,
        over_dimension: str,
        spend: SpendState,
        config: CostGuardConfig,
        est_cost: float,
    ) -> None:
        self.over_dimension = over_dimension
        self.spend = spend
        self.config = config
        self.est_cost = est_cost
        super().__init__(
            f"cost guard blocked: would exceed {over_dimension} cap "
            f"(est_cost={est_cost:.4f})"
        )


# ---- Serialization helpers --------------------------------------------------


def config_to_dict(c: CostGuardConfig) -> dict[str, Any]:
    return asdict(c)


def spend_to_dict(s: SpendState) -> dict[str, Any]:
    return asdict(s)


def check_result_to_dict(r: CheckResult) -> dict[str, Any]:
    return {
        "allow": r.allow,
        "over_dimension": r.over_dimension,
        "override_available": r.override_available,
        "current": spend_to_dict(r.current),
        "config": config_to_dict(r.config),
        "est_reservation_usd": round(r.est_reservation_usd, 6),
    }


def reserve_result_to_dict(r: ReserveResult) -> dict[str, Any]:
    return {
        "reservation_id": r.reservation_id,
        "est_cost_usd": round(r.est_cost_usd, 6),
        "expires_at": r.expires_at,
        "auth_kind": r.auth_kind,
        "override": r.override,
    }


__all__ = [
    "CostGuardBlocked",
    "CostGuardConfig",
    "SpendState",
    "CheckResult",
    "ReserveResult",
    "RESERVATION_TTL_SECONDS",
    "initialize",
    "get_config",
    "update_config",
    "get_state",
    "check",
    "reserve",
    "finalize_reservation",
    "worst_case_reservation",
    "config_to_dict",
    "spend_to_dict",
    "check_result_to_dict",
    "reserve_result_to_dict",
]
