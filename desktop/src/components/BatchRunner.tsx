/**
 * Multi-ticker batch runner (Phase 8b).
 *
 * Sequentially runs analysis on each ticker in the supplied list, reusing
 * the shared `runAnalysis` helper so provider resolution, Alpaca data,
 * CostGuard reservation, and webhooks fire exactly the same as a single
 * Analyze click. Each completed debate is persisted by the engine and
 * shows up in History; each ticker fires its configured webhooks. No
 * batch summary webhook in v1.0 — receivers see per-ticker payloads.
 *
 * UX: compact progress table only — no DebateStream per ticker. Users
 * who want the transcript open History after the batch completes.
 * Stopping the batch closes the current WS and skips the remaining queue.
 *
 * CostGuard: when a ticker is blocked, the batch pauses on that ticker
 * and shows an inline override prompt. The caller-provided `onCostBlocked`
 * decides — for v1.0 the batch simply cancels on first block so the user
 * isn't surprised by a runaway override. Future: per-batch override
 * once-for-all that auto-applies to the rest of the queue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './BatchRunner.module.css';
import {
  PROVIDER_PRIORITY,
  PROVIDER_SECRET_KEY,
  getRecommendedModel,
  type DebateEvent,
  type LLMProvider,
  type Stance,
  type StreamHandle,
} from '../lib/engine-client';
import { listSecrets } from '../lib/secrets';
import { normalizeStance, stanceLabel, stanceLean } from '../lib/stance';
import { getOpenAIOAuthStatus } from '../lib/oauth';
import { runAnalysis } from '../lib/run-analysis';

const SELECTED_PROVIDER_STORAGE_KEY = 'tal:analyze:selected-provider';

interface BatchRunnerProps {
  tickers: string[];
}

type BatchPhase = 'idle' | 'running' | 'complete' | 'cancelled';

interface PerTickerState {
  ticker: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  decisionStance?: Stance;
  decisionConviction?: number;
  estCostUsd?: number;
  elapsedSec?: number;
  error?: string;
}

function BatchRunner({ tickers }: BatchRunnerProps) {
  const [phase, setPhase] = useState<BatchPhase>('idle');
  const [rows, setRows] = useState<PerTickerState[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [batchError, setBatchError] = useState<string | null>(null);

  const stopRequestedRef = useRef(false);
  const currentHandleRef = useRef<StreamHandle | null>(null);
  const currentStartRef = useRef<number>(0);
  const [elapsedTick, setElapsedTick] = useState(0);
  /** Mount-guard. Watchlist is conditionally rendered in App.tsx; if the
   * user navigates away mid-batch, the component unmounts but `onRun`'s
   * async loop keeps going. Without this guard, returning to Watchlist
   * and clicking Run again would start a SECOND concurrent loop while
   * the first is still firing webhooks + writing sessions. Mount-guard
   * + WS close on unmount stops both. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      currentHandleRef.current?.close();
      stopRequestedRef.current = true;
    };
  }, []);

  // 1Hz tick for the elapsed display on the active ticker. Cheap; only
  // runs while a batch is in flight.
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setElapsedTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const onStop = useCallback(() => {
    stopRequestedRef.current = true;
    currentHandleRef.current?.close();
  }, []);

  const onRun = useCallback(async () => {
    if (tickers.length === 0) return;
    setPhase('running');
    setBatchError(null);
    stopRequestedRef.current = false;
    const tradeDate = new Date().toISOString().split('T')[0];

    // Resolve the active provider once at start. We don't refresh per
    // ticker — the user's intent at click time governs the whole batch.
    const active = await resolveActiveProvider();
    if (!active.provider) {
      setBatchError('No LLM provider configured. Open Settings → LLM Providers.');
      setPhase('cancelled');
      return;
    }

    const initial: PerTickerState[] = tickers.map((t) => ({
      ticker: t,
      status: 'pending',
    }));
    setRows(initial);

    for (let i = 0; i < tickers.length; i++) {
      if (!mountedRef.current) return;
      if (stopRequestedRef.current) {
        setRows((prev) =>
          prev.map((r, idx) => (idx >= i ? { ...r, status: 'skipped' } : r)),
        );
        setPhase('cancelled');
        return;
      }
      setCurrentIndex(i);
      const ticker = tickers[i];
      currentStartRef.current = Date.now();
      setRows((prev) =>
        prev.map((r, idx) => (idx === i ? { ...r, status: 'running' } : r)),
      );

      // Per-ticker stream state. We watch session.complete for the
      // committee assessment; that fires before the WS close.
      let decisionStance: Stance | undefined;
      let decisionConviction: number | undefined;
      let estCostUsd: number | undefined;
      let perError: string | undefined;

      const onEvent = (event: DebateEvent) => {
        if (event.type === 'session.complete') {
          decisionStance = normalizeStance(event.decision.stance);
          decisionConviction = event.decision.conviction;
          if (typeof event.estimated_cost_usd === 'number') {
            estCostUsd = event.estimated_cost_usd;
          }
        }
      };

      try {
        const result = await runAnalysis(
          {
            ticker,
            trade_date: tradeDate,
            provider: active.provider,
            openaiAuthKind: active.openaiAuthKind ?? 'api_key',
            model: active.model,
          },
          {
            onEvent,
            onError: (err) => {
              perError = err instanceof Error ? err.message : String(err);
            },
            // First cost-block aborts the whole batch — safer than a
            // silent run-over for someone who set caps on purpose.
            onCostBlocked: async () => false,
          },
        );

        if (result.kind === 'cancelled') {
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? { ...r, status: 'failed', error: 'Cost guard cap reached' }
                : r,
            ),
          );
          setBatchError(
            `Cost guard blocked ${ticker}, adjust caps in Settings or stop the batch.`,
          );
          setPhase('cancelled');
          return;
        }

        currentHandleRef.current = result.handle;
        await result.handle.done;
        currentHandleRef.current = null;
        if (!mountedRef.current) return;
        const elapsed = Math.round((Date.now() - currentStartRef.current) / 1000);

        if (perError) {
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    status: 'failed',
                    error: perError,
                    elapsedSec: elapsed,
                  }
                : r,
            ),
          );
        } else {
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    status: 'done',
                    decisionStance,
                    decisionConviction,
                    estCostUsd,
                    elapsedSec: elapsed,
                  }
                : r,
            ),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const elapsed = Math.round((Date.now() - currentStartRef.current) / 1000);
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: 'failed', error: message, elapsedSec: elapsed }
              : r,
          ),
        );
      }
    }

    setCurrentIndex(-1);
    setPhase('complete');
  }, [tickers]);

  const summary = useSummary(rows);

  return (
    <div className={styles.batchCard} data-testid="batch-runner">
      <div className={styles.batchHeader}>
        <h2 className={styles.batchTitle}>The Diligence, in bulk</h2>
        <div className={styles.batchStatus}>{statusLine(phase, currentIndex, tickers.length, rows, elapsedTick)}</div>
        <div className={styles.batchActions}>
          {phase === 'running' ? (
            <button
              type="button"
              className={styles.stopButton}
              onClick={onStop}
              data-testid="batch-stop-button"
            >
              Stop batch
            </button>
          ) : (
            <button
              type="button"
              className={styles.runButton}
              onClick={() => void onRun()}
              disabled={tickers.length === 0}
              data-testid="batch-run-button"
            >
              Run all ({tickers.length})
            </button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <ul className={styles.progressList}>
          {rows.map((row, idx) => (
            <li
              key={row.ticker}
              className={`${styles.progressRow} ${idx === currentIndex && phase === 'running' ? styles.progressRow_current : ''} ${row.status === 'failed' ? styles.progressRow_failed : ''}`}
              data-testid={`batch-row-${row.ticker}`}
            >
              <span className={styles.progressTicker}>{row.ticker}</span>
              <span className={styles.progressState}>
                {row.status === 'pending' && 'queued'}
                {row.status === 'running' && 'running…'}
                {row.status === 'done' && 'done'}
                {row.status === 'failed' && `failed: ${row.error ?? 'unknown'}`}
                {row.status === 'skipped' && 'skipped'}
              </span>
              <span className={`${styles.progressDecision} ${row.decisionStance ? styles[`progressDecision_${stanceLean(row.decisionStance)}`] : ''}`}>
                {row.decisionStance
                  ? `${stanceLabel(row.decisionStance)}${typeof row.decisionConviction === 'number' ? ` ${Math.round(row.decisionConviction * 100)}%` : ''}`
                  : ''}
              </span>
              <span className={styles.progressMeta}>
                {typeof row.estCostUsd === 'number' && row.estCostUsd > 0
                  ? formatUsdShort(row.estCostUsd)
                  : ''}
              </span>
              <span className={styles.progressMeta}>
                {idx === currentIndex && phase === 'running'
                  ? `${Math.max(0, Math.round((Date.now() - currentStartRef.current) / 1000))}s`
                  : typeof row.elapsedSec === 'number'
                    ? `${row.elapsedSec}s`
                    : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {batchError && <p className={styles.summaryError}>{batchError}</p>}

      {(phase === 'complete' || phase === 'cancelled') && rows.length > 0 && (
        <div className={styles.summaryBar}>
          <span>
            {summary.done} of {tickers.length} complete
          </span>
          {summary.bullish > 0 && <span>Bullish: {summary.bullish}</span>}
          {summary.bearish > 0 && <span>Bearish: {summary.bearish}</span>}
          {summary.neutral > 0 && <span>Neutral: {summary.neutral}</span>}
          {summary.failed > 0 && <span>Failed: {summary.failed}</span>}
          {summary.totalCostUsd > 0 && (
            <span>Cost: {formatUsdShort(summary.totalCostUsd)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function statusLine(
  phase: BatchPhase,
  currentIndex: number,
  total: number,
  _rows: PerTickerState[],
  _tick: number,
): string {
  if (phase === 'idle') return total === 0 ? 'No tickers in watchlist' : `${total} tickers ready`;
  if (phase === 'running' && currentIndex >= 0) return `Running ${currentIndex + 1} of ${total}`;
  if (phase === 'complete') return 'Batch complete';
  if (phase === 'cancelled') return 'Batch cancelled';
  return '';
}

function useSummary(rows: PerTickerState[]) {
  let done = 0;
  // Summary buckets by lean: moderately_bullish counts as bullish, etc.
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let failed = 0;
  let totalCostUsd = 0;
  for (const r of rows) {
    if (r.status === 'done') {
      done += 1;
      if (r.decisionStance) {
        const lean = stanceLean(r.decisionStance);
        if (lean === 'bullish') bullish += 1;
        else if (lean === 'bearish') bearish += 1;
        else neutral += 1;
      }
      if (typeof r.estCostUsd === 'number') totalCostUsd += r.estCostUsd;
    } else if (r.status === 'failed') {
      failed += 1;
    }
  }
  return { done, bullish, bearish, neutral, failed, totalCostUsd };
}

function formatUsdShort(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

interface ActiveProvider {
  provider: LLMProvider | null;
  openaiAuthKind?: 'oauth' | 'api_key';
  model: string;
}

/**
 * Mirrors the Analyze page's active-provider resolution: respect the
 * user's manual dropdown choice (localStorage) when its credentials
 * still exist, otherwise fall back to the priority order's first
 * configured provider. OAuth wins over API key on the OpenAI path.
 */
async function resolveActiveProvider(): Promise<ActiveProvider> {
  const [secrets, oauth] = await Promise.all([
    listSecrets().catch(() => []),
    getOpenAIOAuthStatus().catch(() => ({ connected: false } as const)),
  ]);
  const stored = new Set(secrets.map((s) => s.key));
  const configured = new Set<LLMProvider>();
  for (const p of PROVIDER_PRIORITY) {
    const hasKey = stored.has(PROVIDER_SECRET_KEY[p]);
    if (p === 'openai' && (oauth.connected || hasKey)) configured.add(p);
    else if (p === 'local' && stored.has(PROVIDER_SECRET_KEY.local) && stored.has('local:model')) configured.add(p);
    else if (p !== 'openai' && p !== 'local' && hasKey) configured.add(p);
  }
  if (configured.size === 0) {
    return { provider: null, model: '' };
  }
  let manual: LLMProvider | null = null;
  try {
    const raw = localStorage.getItem(SELECTED_PROVIDER_STORAGE_KEY);
    if (raw && (PROVIDER_PRIORITY as readonly string[]).includes(raw)) {
      manual = raw as LLMProvider;
    }
  } catch {
    // ignore
  }
  const provider =
    (manual && configured.has(manual) ? manual : null) ??
    PROVIDER_PRIORITY.find((p) => configured.has(p)) ??
    null;
  const openaiAuthKind: 'oauth' | 'api_key' =
    oauth.connected ? 'oauth' : 'api_key';
  const model = provider ? getRecommendedModel(provider, openaiAuthKind) : '';
  return { provider, openaiAuthKind, model };
}

export default BatchRunner;
