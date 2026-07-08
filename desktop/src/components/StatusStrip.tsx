/**
 * Compact status strip — always visible at the top of the app shell.
 *
 * Shows 3 pills (Engine / Data / LLM) so the user can confirm
 * at a glance that nothing is failing or disconnected. Replaces the bulky
 * 4-card status grid that previously took up real estate at the top of the
 * Analyze page (founder feedback 2026-05-09).
 *
 * State sourcing:
 * - Engine: polls /health every 10s; pending → ok | error
 * - Data: seeded from /health, updated per-stream via window CustomEvent
 *         "tal:data-provider" dispatched by Analyze on data.summary events
 * - LLM: derived from secrets list — first-configured-wins per
 *        PROVIDER_PRIORITY (OpenAI OAuth wins over OpenAI API key when both)
 *             counts as "configured"; today's actual gateway probe is
 *             Phase 6 work so we just show "configured" or "disconnected"
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PROVIDER_LABEL,
  PROVIDER_PRIORITY,
  PROVIDER_SECRET_KEY,
  getHealth,
  type LLMProvider,
} from '../lib/engine-client';
import {
  getCostGuardState,
  type CostGuardConfig,
  type SpendState,
} from '../lib/cost-guard';
import { listSecrets } from '../lib/secrets';
import { getOpenAIOAuthStatus } from '../lib/oauth';
import styles from './StatusStrip.module.css';

const HEALTH_POLL_MS = 10_000;
const SPEND_POLL_MS = 30_000;

// Custom-event channel Analyze (or any future page) uses to notify the
// strip of per-stream data-provider changes (alpaca · crypto, etc.).
export const DATA_PROVIDER_EVENT = 'tal:data-provider';

// Per-stream running cost from `cost.usage` WS events. Dispatched by
// Analyze; consumed by the Spend pill so it can tick mid-stream.
export const COST_USAGE_EVENT = 'tal:cost-usage';

// Fired by Analyze (or any future stream owner) on `session.complete` so
// the Spend pill can immediately re-poll /cost-guard/state instead of
// waiting for the 30s tick.
export const SESSION_COMPLETE_EVENT = 'tal:session-complete';

export interface DataProviderEventDetail {
  source: string;          // "yfinance" | "alpaca" | ...
  asset_class?: 'equity' | 'crypto';
}

export interface CostUsageEventDetail {
  est_cost_usd: number;
  free: boolean;
}

type PillState = 'ok' | 'warn' | 'error' | 'off' | 'pending';

interface PillProps {
  label: string;
  detail?: string;
  state: PillState;
  title?: string;
}

function Pill({ label, detail, state, title }: PillProps) {
  return (
    <span
      className={`${styles.pill} ${styles[`pill_${state}`]}`}
      title={title ?? `${label}${detail ? `: ${detail}` : ''}`}
      data-testid={`status-pill-${label.toLowerCase()}`}
      data-state={state}
    >
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </span>
  );
}

function StatusStrip() {
  const [engineState, setEngineState] = useState<PillState>('pending');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [dataAssetClass, setDataAssetClass] = useState<'equity' | 'crypto' | null>(null);
  const [llmProvider, setLlmProvider] = useState<LLMProvider | null>(null);
  const [llmIsOauth, setLlmIsOauth] = useState(false);
  // CostGuard spend state — polled from /cost-guard/state and refreshed on
  // session.complete dispatch. `runCost`/`runIsFree` track the in-flight
  // running total from cost.usage events so the pill can tick mid-stream
  // without waiting for the next poll.
  const [spend, setSpend] = useState<SpendState | null>(null);
  const [cgConfig, setCgConfig] = useState<CostGuardConfig | null>(null);
  const [runCost, setRunCost] = useState<number | null>(null);
  const [runIsFree, setRunIsFree] = useState<boolean>(false);

  // ---- Engine health polling ---------------------------------------------
  //
  // Engine startup is racy — Vite renders the React app before the Python
  // sidecar has emitted its handshake JSON. We don't want to flash a red
  // "Engine error" pill for the 1-3s it takes the engine to come up. So:
  //   1. Stay in 'pending' (pulsing dot) on every failure UNTIL we've
  //      seen at least one success OR the grace window has elapsed
  //   2. After grace window: show 'error'
  //   3. After first success: subsequent failures DO show 'error' fast
  //      (we know engine was alive — failure now is a real signal)
  const STARTUP_GRACE_MS = 12_000;
  const everSucceededRef = useRef(false);
  const mountedAtRef = useRef<number>(Date.now());

  const pollHealth = useCallback(async (): Promise<boolean> => {
    try {
      const h = await getHealth();
      everSucceededRef.current = true;
      setEngineState('ok');
      setEngineError(null);
      // Initial seed only — per-stream Alpaca/crypto routing comes via
      // the CustomEvent below. Don't override an event-set source.
      setDataSource((cur) => cur ?? h.data_provider ?? null);
      return true;
    } catch (err) {
      const elapsed = Date.now() - mountedAtRef.current;
      const stillStarting = !everSucceededRef.current && elapsed < STARTUP_GRACE_MS;
      setEngineState(stillStarting ? 'pending' : 'error');
      setEngineError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  // ---- Engine-crash fast recovery ----------------------------------------
  //
  // When the engine crashes, main pushes `engine:exited` and engine-client
  // drops its cached handshake. Rather than wait up to HEALTH_POLL_MS (10s)
  // for the ambient poll to notice, kick an immediate burst of polls: the
  // first getHealth() re-fetches the handshake, which lazily respawns a fresh
  // engine, and we flip back to 'ok' within ~1-3s. Bounded so a genuinely
  // dead engine (bad venv) doesn't poll forever.
  useEffect(() => {
    const bridge = window.tradingAgentsLab;
    if (!bridge?.onEngineExited) return;
    let recovering = false;
    const unsubscribe = bridge.onEngineExited(() => {
      if (recovering) return;
      recovering = true;
      setEngineState('pending');
      let attempts = 0;
      const tick = async () => {
        attempts += 1;
        const ok = await pollHealth();
        if (ok || attempts >= 20) {
          recovering = false;
          return;
        }
        setTimeout(() => void tick(), 1000);
      };
      void tick();
    });
    return unsubscribe;
  }, [pollHealth]);

  useEffect(() => {
    // Tight retry cadence during the startup grace window so we transition
    // pending→ok within 1-2s of the engine becoming ready, not 10s+.
    void pollHealth();
    const fastInterval = setInterval(() => {
      if (everSucceededRef.current) return;
      void pollHealth();
    }, 1000);
    const slowInterval = setInterval(() => void pollHealth(), HEALTH_POLL_MS);
    // Stop the fast retry once we've succeeded once (or grace expires).
    const stopFastTimeout = setTimeout(
      () => clearInterval(fastInterval),
      STARTUP_GRACE_MS,
    );
    return () => {
      clearInterval(fastInterval);
      clearInterval(slowInterval);
      clearTimeout(stopFastTimeout);
    };
  }, [pollHealth]);

  // ---- Data-provider per-stream override (Analyze dispatches) ------------

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<DataProviderEventDetail>;
      const detail = ce.detail;
      if (detail?.source) setDataSource(detail.source);
      if (detail?.asset_class) setDataAssetClass(detail.asset_class);
    };
    window.addEventListener(DATA_PROVIDER_EVENT, handler as EventListener);
    return () => window.removeEventListener(DATA_PROVIDER_EVENT, handler as EventListener);
  }, []);

  // ---- CostGuard spend polling + in-flight tick --------------------------
  //
  // Poll /cost-guard/state on mount + every 30s. Also refresh immediately
  // when Analyze fires `tal:session-complete` so the pill jumps to the new
  // total the moment a debate ends, not 30s later. Cost.usage events from
  // an active stream populate `runCost` for the mid-stream tick.

  const spendEverSucceededRef = useRef(false);
  const pollSpend = useCallback(async () => {
    try {
      const res = await getCostGuardState();
      spendEverSucceededRef.current = true;
      setSpend(res.spend);
      setCgConfig(res.config);
    } catch {
      // Engine offline or cost-guard not initialized — leave previous values.
    }
  }, []);

  // Same tight-retry pattern as engine health: cold-start poll the cost-
  // guard endpoint every second until the FIRST success (engine sidecar
  // typically reachable within 2-3s of app launch), then back off to the
  // 30s ambient interval. Without the fast retry the pill stays "pending"
  // for up to 30s after engine ready — and Playwright's 20s wait window
  // surfaced that as a flake before any user could see it.
  useEffect(() => {
    void pollSpend();
    const fastInterval = setInterval(() => {
      if (spendEverSucceededRef.current) return;
      void pollSpend();
    }, 1000);
    const slowInterval = setInterval(() => void pollSpend(), SPEND_POLL_MS);
    const stopFastTimeout = setTimeout(
      () => clearInterval(fastInterval),
      STARTUP_GRACE_MS,
    );
    return () => {
      clearInterval(fastInterval);
      clearInterval(slowInterval);
      clearTimeout(stopFastTimeout);
    };
  }, [pollSpend]);

  useEffect(() => {
    const onUsage = (e: Event) => {
      const ce = e as CustomEvent<CostUsageEventDetail>;
      if (ce.detail) {
        setRunCost(ce.detail.est_cost_usd);
        setRunIsFree(ce.detail.free);
      }
    };
    const onComplete = () => {
      // Clear the in-flight tick; the new persisted total comes from
      // the immediate re-poll below.
      setRunCost(null);
      setRunIsFree(false);
      // The session.complete WS frame can land before the engine's
      // finally block has run finalize_reservation() against SQLite.
      // The immediate poll wins that race ~50% of the time on a warm
      // machine, leaving the pill showing the pre-debate total for 30s
      // until the next interval tick. A delayed re-poll closes the
      // window: by 500ms the finally block has finished its UPDATE.
      void pollSpend();
      setTimeout(() => void pollSpend(), 500);
    };
    window.addEventListener(COST_USAGE_EVENT, onUsage as EventListener);
    window.addEventListener(SESSION_COMPLETE_EVENT, onComplete as EventListener);
    return () => {
      window.removeEventListener(COST_USAGE_EVENT, onUsage as EventListener);
      window.removeEventListener(SESSION_COMPLETE_EVENT, onComplete as EventListener);
    };
  }, [pollSpend]);

  // ---- LLM from secrets ---------------------------------------------------

  const refreshSecrets = useCallback(async () => {
    try {
      const [secrets, oauthStatus] = await Promise.all([
        listSecrets(),
        getOpenAIOAuthStatus().catch(() => null),
      ]);
      const stored = new Set(secrets.map((s) => s.key));

      // OpenAI special case: OAuth wins over API key when both are present.
      let resolved: LLMProvider | null = null;
      let oauth = false;
      if (oauthStatus?.connected) {
        resolved = 'openai';
        oauth = true;
      } else {
        for (const p of PROVIDER_PRIORITY) {
          // Local needs BOTH `local:base-url` and `local:model` to count
          // as configured. Single-key check (the default branch) would
          // over-report local as ready when only the URL is saved.
          if (p === 'local') {
            if (
              stored.has(PROVIDER_SECRET_KEY.local) &&
              stored.has('local:model')
            ) {
              resolved = p;
              break;
            }
            continue;
          }
          if (stored.has(PROVIDER_SECRET_KEY[p])) {
            resolved = p;
            break;
          }
        }
      }
      setLlmProvider(resolved);
      setLlmIsOauth(oauth);
    } catch {
      // safeStorage offline — leave previous values as-is
    }
  }, []);

  useEffect(() => {
    void refreshSecrets();
    // Re-resolve if the user updates secrets in another tab. We can't
    // listen for safeStorage writes directly; poll lightly.
    const id = setInterval(() => void refreshSecrets(), 30_000);
    return () => clearInterval(id);
  }, [refreshSecrets]);

  // ---- Render ------------------------------------------------------------

  // Engine pill — during startup grace window, pending reads as "starting"
  // (with a short detail label visible) so the user has positive context
  // rather than a silent dot. Once running, the dot alone communicates state.
  const enginePill = (
    <Pill
      label="Engine"
      detail={engineState === 'pending' ? 'starting…' : undefined}
      state={engineState}
      title={
        engineState === 'error'
          ? `Engine error: ${engineError ?? 'unknown'}`
          : engineState === 'pending'
            ? 'Engine starting, waiting for Python sidecar handshake'
            : 'Python sidecar running'
      }
    />
  );

  // Data pill — green when any source resolved; pending otherwise
  const dataDetail = dataSource
    ? dataAssetClass === 'crypto'
      ? `${dataSource} · crypto`
      : dataSource
    : 'pending';
  const dataPill = (
    <Pill
      label="Data"
      detail={dataDetail}
      state={dataSource ? 'ok' : 'pending'}
      title={
        dataSource
          ? `Data provider: ${dataDetail}`
          : 'Waiting for engine handshake'
      }
    />
  );

  // LLM pill
  const llmDetail = llmProvider
    ? llmIsOauth
      ? 'OpenAI · OAuth'
      : PROVIDER_LABEL[llmProvider]
    : 'unconfigured';
  const llmPill = (
    <Pill
      label="LLM"
      detail={llmDetail}
      state={llmProvider ? 'ok' : 'off'}
      title={
        llmProvider
          ? `Active provider: ${llmDetail}`
          : 'No LLM provider configured; debates will run as stub'
      }
    />
  );

  // Spend pill — daily $ spent vs cap. Green under 50% / amber 50-90% / red
  // >90% of the daily cap. With cap_daily_usd=0 (cap disabled), shows the
  // bare daily total with neutral colour. During a stream, runCost is shown
  // inline (e.g. "$0.42 + $0.0012"); free runs show "subscription" so the
  // tick doesn't read as alarmingly static.
  let spendDetail = 'pending';
  let spendState: PillState = 'pending';
  let spendTitle = 'Loading cost-guard state…';
  if (spend && cgConfig) {
    const daily = spend.daily_usd;
    const cap = cgConfig.cap_daily_usd;
    const base = `$${daily.toFixed(2)}`;
    const live =
      runCost !== null
        ? runIsFree
          ? ' · subscription'
          : ` + $${runCost.toFixed(4)}`
        : '';
    if (!cgConfig.enabled || cap <= 0) {
      spendDetail = `${base}${live}`;
      spendState = 'ok';
      spendTitle = `Spent today: ${base}${
        runCost !== null && !runIsFree ? ` (in-flight: $${runCost.toFixed(4)})` : ''
      } · no daily cap`;
    } else {
      const pct = cap > 0 ? daily / cap : 0;
      spendDetail = `${base} / $${cap.toFixed(2)}${live}`;
      spendState = pct >= 0.9 ? 'error' : pct >= 0.5 ? 'warn' : 'ok';
      spendTitle = `Spent today: ${base} of $${cap.toFixed(2)} cap (${Math.round(
        pct * 100,
      )}%)${runCost !== null && !runIsFree ? ` · in-flight $${runCost.toFixed(4)}` : ''}`;
    }
  }
  const spendPill = (
    <Pill label="Spend" detail={spendDetail} state={spendState} title={spendTitle} />
  );

  return (
    <div className={styles.strip}>
      {enginePill}
      {dataPill}
      {llmPill}
      {spendPill}
    </div>
  );
}

export default StatusStrip;
