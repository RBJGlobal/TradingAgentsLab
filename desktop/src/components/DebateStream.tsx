import { useEffect, useRef, useState } from 'react';
import type {
  DebateEvent,
  AnalyzeDecision,
  QuoteSummary,
  Headline,
  NewsHeadlinesEvent,
} from '../lib/engine-client';
import styles from './DebateStream.module.css';

interface DebateStreamProps {
  events: DebateEvent[];
  isStreaming: boolean;
}

/**
 * Agents per phase — must match engine/live_debate.py `_AGENTS`. If the
 * agent roster changes upstream, update both. The progress strip uses
 * this to compute "done X of Y" per phase without having to know
 * individual agent names.
 */
const AGENTS_PER_PHASE: Record<string, number> = {
  analysts: 4,
  researchers: 3,
  trader: 1,
  risk: 4,
};

const PHASE_ORDER: string[] = ['analysts', 'researchers', 'trader', 'risk'];

const TOTAL_AGENTS = Object.values(AGENTS_PER_PHASE).reduce((a, b) => a + b, 0);

interface PhaseProgress {
  phase: string;
  done: number;
  total: number;
  state: 'pending' | 'active' | 'done';
}

/**
 * Walk the event stream and compute per-phase + aggregate progress.
 *
 * - `done` count = agent.message events seen in that phase.
 * - A phase is `done` once `done >= total`.
 * - The most recently active phase (latest agent.message or
 *   phase.transition target) is marked `active`; everything else
 *   pending. Backward-walking ensures a stalled phase doesn't keep
 *   showing "active" after the stream moved on.
 */
function computeProgress(events: DebateEvent[]): {
  phases: PhaseProgress[];
  totalDone: number;
} {
  const counts: Record<string, number> = {};
  let lastActivePhase: string | null = null;

  for (const ev of events) {
    if (ev.type === 'agent.message') {
      counts[ev.phase] = (counts[ev.phase] ?? 0) + 1;
      lastActivePhase = ev.phase;
    } else if (ev.type === 'phase.transition') {
      lastActivePhase = ev.to;
    }
  }

  const phases: PhaseProgress[] = PHASE_ORDER.map((phase) => {
    const done = counts[phase] ?? 0;
    const total = AGENTS_PER_PHASE[phase] ?? 0;
    let state: 'pending' | 'active' | 'done' = 'pending';
    if (done >= total) state = 'done';
    else if (lastActivePhase === phase || done > 0) state = 'active';
    return { phase, done, total, state };
  });

  const totalDone = phases.reduce((sum, p) => sum + p.done, 0);
  return { phases, totalDone };
}

/** Format elapsed milliseconds for the live clock. Compact: "12s",
 * "1m 24s", "1h 02m". Long-form (1h+) is for slow local models. */
function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hr}h ${String(min).padStart(2, '0')}m`;
}

const PHASE_SHORT_LABEL: Record<string, string> = {
  analysts: 'Analysts',
  researchers: 'Researchers',
  trader: 'Trader',
  risk: 'Risk',
};

function findSummary(events: DebateEvent[]): QuoteSummary | null {
  const ev = events.find((e) => e.type === 'data.summary');
  if (ev && ev.type === 'data.summary') {
    const { type: _t, ...summary } = ev;
    return summary as QuoteSummary;
  }
  return null;
}

function findHeadlines(events: DebateEvent[]): NewsHeadlinesEvent | null {
  const ev = events.find((e) => e.type === 'news.headlines');
  return ev && ev.type === 'news.headlines' ? ev : null;
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

interface PhaseGroup {
  phase: string;
  messages: Array<{ agent: string; content: string }>;
}

function groupByPhase(events: DebateEvent[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (const ev of events) {
    if (ev.type !== 'agent.message') continue;
    const last = groups[groups.length - 1];
    if (last && last.phase === ev.phase) {
      last.messages.push({ agent: ev.agent, content: ev.content });
    } else {
      groups.push({
        phase: ev.phase,
        messages: [{ agent: ev.agent, content: ev.content }],
      });
    }
  }
  return groups;
}

function findStart(events: DebateEvent[]): { ticker: string; trade_date: string } | null {
  const start = events.find((e) => e.type === 'session.start');
  if (start && start.type === 'session.start') {
    return { ticker: start.ticker, trade_date: start.trade_date };
  }
  return null;
}

function findDecision(events: DebateEvent[]): AnalyzeDecision | null {
  const complete = events.find((e) => e.type === 'session.complete');
  if (complete && complete.type === 'session.complete') {
    return complete.decision;
  }
  return null;
}

interface WebhookReport {
  results: import('../lib/webhooks').WebhookResult[];
}

function findWebhookReport(events: DebateEvent[]): WebhookReport | null {
  const evt = events.find((e) => e.type === 'webhook.report');
  if (evt && evt.type === 'webhook.report') {
    return { results: evt.results };
  }
  return null;
}

interface DecisionMeta {
  live: boolean;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

function findDecisionMeta(events: DebateEvent[]): DecisionMeta {
  const complete = events.find((e) => e.type === 'session.complete');
  if (complete && complete.type === 'session.complete') {
    return {
      live: complete.live === true,
      provider: complete.provider,
      model: complete.model,
      inputTokens: complete.input_tokens,
      outputTokens: complete.output_tokens,
      estimatedCostUsd: complete.estimated_cost_usd,
    };
  }
  return { live: false };
}

const PHASE_LABEL: Record<string, string> = {
  analysts: 'Analysts',
  researchers: 'Researchers',
  trader: 'Trader',
  risk: 'Risk',
};

const PHASE_DESCRIPTION: Record<string, string> = {
  analysts: 'Technical · Fundamental · News · Sentiment',
  researchers: 'Bull · Bear · Research Manager',
  trader: 'Trade plan',
  risk: 'Aggressive · Conservative · Neutral · Portfolio Manager',
};

function DebateStream({ events, isStreaming }: DebateStreamProps) {
  const start = findStart(events);
  const summary = findSummary(events);
  const news = findHeadlines(events);
  const groups = groupByPhase(events);
  const decision = findDecision(events);
  const meta = findDecisionMeta(events);
  const progress = computeProgress(events);
  const webhookReport = findWebhookReport(events);

  // Live elapsed clock — captured on first event arrival, frozen when
  // session.complete lands. For History replay (events present from the
  // start, !isStreaming), we never start the clock — duration was a
  // server-side concern that didn't make it onto the wire and faking
  // "0s" would be worse than not showing it.
  const startedAtRef = useRef<number | null>(null);
  const endedAtRef = useRef<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (events.length === 0) {
      // A new/cleared run. This component stays mounted across runs (it just
      // renders null when empty), so the refs survive — reset them or the
      // next run would reuse the previous run's start/end and the clock would
      // never tick (endedAt already set) or show a bogus elapsed.
      startedAtRef.current = null;
      endedAtRef.current = null;
      return;
    }
    if (startedAtRef.current === null && isStreaming) {
      startedAtRef.current = Date.now();
    }
    if (decision !== null && endedAtRef.current === null) {
      endedAtRef.current = Date.now();
    }
  }, [events.length, isStreaming, decision]);

  // Tick the clock while a stream is in flight. 500ms gives a smooth
  // second-by-second feel without burning render budget. Stopped as
  // soon as the decision lands (endedAt is set).
  useEffect(() => {
    if (!isStreaming) return;
    if (endedAtRef.current !== null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (events.length === 0) {
    return null;
  }

  // Compute the elapsed value for render. While the stream is live we
  // sample `now`; once the decision lands we freeze on endedAt.
  const elapsedMs =
    startedAtRef.current !== null
      ? (endedAtRef.current ?? now) - startedAtRef.current
      : null;

  return (
    <section className={styles.stream}>
      {start && (
        <header className={styles.header}>
          <div className={styles.headerLabel}>Session</div>
          <div className={styles.headerTitle}>
            <span className={styles.ticker}>{start.ticker}</span>
            <span className={styles.headerSep}>·</span>
            <span className={styles.tradeDate}>{start.trade_date}</span>
          </div>
          {isStreaming && (
            <div className={styles.streamingBadge}>
              <span className={styles.streamingDot} />
              Diligence
            </div>
          )}
        </header>
      )}

      {summary && (
        <div className={styles.summaryStrip}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Last close</span>
            <span className={styles.summaryValue}>{summary.last_close.toFixed(2)}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Period change</span>
            <span
              className={
                summary.period_change_pct >= 0
                  ? styles.summaryValuePositive
                  : styles.summaryValueNegative
              }
            >
              {summary.period_change_pct >= 0 ? '+' : ''}
              {summary.period_change_pct.toFixed(2)}%
            </span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Range</span>
            <span className={styles.summaryValue}>
              {summary.period_low.toFixed(2)} to {summary.period_high.toFixed(2)}
            </span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Avg volume</span>
            <span className={styles.summaryValue}>{formatVolume(summary.avg_volume)}</span>
          </div>
          <div className={styles.summarySource}>
            {summary.sessions} sessions · {summary.source} · as of {summary.as_of}
          </div>
        </div>
      )}

      {/* Progress strip — visible from the moment session.start lands.
          During the live stream it surfaces the 4-phase structure of the
          debate (Analysts → Researchers → Trader → Risk), telegraphs
          which agents are done / which phase is currently running, and
          ticks a live elapsed clock. After the decision lands, it
          freezes on the final state so the user can see "12 of 12
          agents · 1m 24s" alongside the conclusion. */}
      <div className={styles.progress} aria-label="Debate progress">
        <div className={styles.progressPhases}>
          {progress.phases.map((p) => (
            <div
              key={p.phase}
              className={`${styles.progressPhase} ${
                styles[`progressPhase_${p.state}`] ?? ''
              }`}
              aria-current={p.state === 'active' ? 'step' : undefined}
            >
              <span className={styles.progressPhaseMark}>
                {p.state === 'done' ? '✓' : p.state === 'active' ? '●' : '○'}
              </span>
              <span className={styles.progressPhaseLabel}>
                {PHASE_SHORT_LABEL[p.phase] ?? p.phase}
              </span>
              <span className={styles.progressPhaseCount}>
                {p.done}/{p.total}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.progressFooter}>
          <span>
            {progress.totalDone} of {TOTAL_AGENTS} agents
          </span>
          {elapsedMs !== null && (
            <>
              <span className={styles.progressSep}>·</span>
              <span>
                {endedAtRef.current !== null
                  ? `Diligence complete in ${formatElapsed(elapsedMs)}`
                  : `Diligence in progress · ${formatElapsed(elapsedMs)}`}
              </span>
            </>
          )}
        </div>
      </div>

      {news && news.headlines.length > 0 && (
        <div className={styles.news}>
          <div className={styles.newsHeader}>
            <span className={styles.newsLabel}>News</span>
            <span className={styles.newsSource}>
              {news.headlines.length} headline{news.headlines.length === 1 ? '' : 's'} · {news.source}
            </span>
          </div>
          <ul className={styles.newsList}>
            {news.headlines.map((h: Headline, idx: number) => (
              <li key={`${h.url || h.title}-${idx}`} className={styles.newsItem}>
                {h.url ? (
                  <a
                    className={styles.newsTitle}
                    href={h.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {h.title}
                  </a>
                ) : (
                  <span className={styles.newsTitle}>{h.title}</span>
                )}
                <span className={styles.newsMeta}>
                  {[h.publisher, h.pub_date && formatRelativeTime(h.pub_date)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.map((group, groupIdx) => (
        <div
          key={`${group.phase}-${groupIdx}`}
          className={`${styles.phase} ${styles[`phase_${group.phase}`] ?? ''}`}
        >
          <div className={styles.phaseHeader}>
            <span className={styles.phaseLabel}>
              {PHASE_LABEL[group.phase] ?? group.phase}
            </span>
            <span className={styles.phaseDescription}>
              {PHASE_DESCRIPTION[group.phase] ?? ''}
            </span>
          </div>
          <div className={styles.messages}>
            {group.messages.map((msg, idx) => (
              <article key={`${msg.agent}-${idx}`} className={styles.message}>
                <div className={styles.messageAgent}>{msg.agent}</div>
                <div className={styles.messageContent}>{msg.content}</div>
              </article>
            ))}
          </div>
        </div>
      ))}

      {decision && (
        <div
          className={`${styles.decision} ${styles[`decision_${decision.action}`] ?? ''}`}
          data-testid="decision-card"
          data-action={decision.action}
        >
          <div className={styles.decisionLabel}>
            Decision
            {meta.live && (
              <span className={styles.decisionLiveBadge}>
                Live · {meta.provider ?? 'openai'} · {meta.model ?? '?'}
              </span>
            )}
          </div>
          <div className={styles.decisionAction} data-testid="decision-action">
            {decision.action}
          </div>
          <div className={styles.decisionConfidence}>
            Confidence{' '}
            <span className={styles.decisionConfidenceValue}>
              {(decision.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <div className={styles.decisionReasoning}>{decision.reasoning}</div>
          {meta.live && (meta.estimatedCostUsd !== undefined || meta.inputTokens !== undefined) && (
            <div className={styles.decisionUsage}>
              {meta.inputTokens !== undefined && meta.outputTokens !== undefined && (
                <span>
                  {meta.inputTokens.toLocaleString()} in · {meta.outputTokens.toLocaleString()} out tokens
                </span>
              )}
              {meta.estimatedCostUsd !== undefined && (
                <span>
                  est cost ${meta.estimatedCostUsd.toFixed(4)}
                </span>
              )}
            </div>
          )}
          <div className={styles.decisionDisclaimer}>
            Not investment advice · LLM output may be inaccurate · Verify
            independently before any action
          </div>
        </div>
      )}

      {webhookReport && webhookReport.results.length > 0 && (
        <div className={styles.webhooks} data-testid="webhook-report">
          <div className={styles.webhooksHeader}>
            <span className={styles.webhooksLabel}>Webhooks</span>
            <span className={styles.webhooksSummary}>
              {(() => {
                const fired = webhookReport.results.filter((r) => r.status === 'fired').length;
                const filtered = webhookReport.results.filter((r) => r.status === 'filtered').length;
                const failed = webhookReport.results.filter((r) => r.status === 'failed').length;
                const parts: string[] = [];
                if (fired) parts.push(`${fired} fired`);
                if (filtered) parts.push(`${filtered} filtered`);
                if (failed) parts.push(`${failed} failed`);
                return parts.join(' · ') || 'none';
              })()}
            </span>
          </div>
          <ul className={styles.webhooksList}>
            {webhookReport.results.map((r) => (
              <li
                key={r.id}
                className={`${styles.webhookItem} ${
                  styles[`webhookItem_${r.status}`] ?? ''
                }`}
              >
                <span className={styles.webhookStatus}>
                  {r.status === 'fired' ? '✓' : r.status === 'filtered' ? '○' : '✗'}
                </span>
                <span className={styles.webhookName}>{r.name}</span>
                <span className={styles.webhookDetail}>
                  {r.status === 'filtered' && 'filter did not match'}
                  {r.status === 'fired' && r.http_status && `HTTP ${r.http_status}`}
                  {r.status === 'failed' &&
                    (r.error || (r.http_status ? `HTTP ${r.http_status}` : 'failed'))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default DebateStream;
