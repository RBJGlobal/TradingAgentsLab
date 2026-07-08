import type {
  DebateEvent,
  QuoteSummary,
  AnalyzeDecision,
  NewsHeadlinesEvent,
} from './engine-client';
import { riskLabel, stanceLabel } from './stance';

// Shared with the standalone-HTML transcript generator (transcript-html.tsx),
// which walks the same event stream — hence the exports below.
export const PHASE_LABEL: Record<string, string> = {
  analysts: 'Analysts',
  researchers: 'Researchers',
  trader: 'Trader',
  risk: 'Risk',
};

export function findStart(events: DebateEvent[]): { ticker: string; trade_date: string } | null {
  const ev = events.find((e) => e.type === 'session.start');
  return ev && ev.type === 'session.start' ? { ticker: ev.ticker, trade_date: ev.trade_date } : null;
}

export function findSummary(events: DebateEvent[]): QuoteSummary | null {
  const ev = events.find((e) => e.type === 'data.summary');
  if (ev && ev.type === 'data.summary') {
    const { type: _t, ...rest } = ev;
    return rest as QuoteSummary;
  }
  return null;
}

export function findDecision(events: DebateEvent[]): AnalyzeDecision | null {
  const ev = events.find((e) => e.type === 'session.complete');
  return ev && ev.type === 'session.complete' ? ev.decision : null;
}

export function findNews(events: DebateEvent[]): NewsHeadlinesEvent | null {
  const ev = events.find((e) => e.type === 'news.headlines');
  return ev && ev.type === 'news.headlines' ? ev : null;
}

export interface PhaseGroup {
  phase: string;
  messages: Array<{ agent: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Chat-artifact stripping
//
// The graph's agents are chat models, and their reports sometimes leak
// conversational framing that reads wrong in an exported document:
//   - leading preambles: "I now have a comprehensive dataset. Let me compile
//     the full report." / "All data has been collected. Here is the..."
//   - trailing offers: "If helpful, I can next turn this into: 1. ... 2. ..."
// Both were observed verbatim in real TSLA runs (2026-07-06, OpenAI AND
// Anthropic). Stripping is deliberately conservative: only short paragraphs
// matching known chat patterns go, and only when substantial content remains,
// so a real report can never be hollowed out by a false positive.
// ---------------------------------------------------------------------------

/** A paragraph that is only a markdown horizontal rule. */
const SEPARATOR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** A paragraph that is a list item (the continuation of a trailing offer). */
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*•])\s/;

/** Chatty lead-ins that precede the actual report. Anchored to paragraph
 * start; each observed in the wild (see block comment above). */
const LEADING_PREAMBLE_RE =
  /^(?:i (?:now )?have\b|i['’]ve (?:now )?(?:gathered|collected|compiled|pulled)\b|all (?:the )?data (?:has|have) been (?:collected|gathered)\b|now i have\b|let me (?:now )?(?:compile|synthesize|put together)\b|here (?:is|are) (?:the|my|a)\b.*:\s*$|(?:great|perfect|excellent)[.,!])/is;

/** Chatty sign-offs offering follow-up work the export can't deliver. */
const TRAILING_OFFER_RE =
  /^(?:if (?:helpful|useful|you(?:['’]d| would)? (?:like|want|prefer)|you want|desired)\b|would you like me to\b|let me know if\b|i can (?:also|next|then|further)\b|want me to\b|shall i\b|happy to\b)/i;

const MAX_ARTIFACT_PARA_LEN = 300;

/**
 * Remove conversational preambles and trailing offers from an agent report.
 * Exported for the standalone-HTML transcript generator to reuse.
 */
export function stripChatArtifacts(content: string): string {
  const paras = content.split(/\n{2,}/);

  // Leading: drop up to one preamble paragraph, plus a dangling separator
  // it may have introduced. Require real content after the cut.
  let start = 0;
  if (
    paras.length > 1 &&
    paras[0].trim().length <= MAX_ARTIFACT_PARA_LEN &&
    LEADING_PREAMBLE_RE.test(paras[0].trim())
  ) {
    start = 1;
    if (start < paras.length - 1 && SEPARATOR_RE.test(paras[start])) start++;
  }

  // Trailing: scan backwards past separators and list items (the offer's
  // enumerated options), then require the anchor paragraph itself to be a
  // short offer. Anything else aborts the strip entirely.
  let end = paras.length;
  let probe = paras.length - 1;
  while (probe > start && (SEPARATOR_RE.test(paras[probe]) || LIST_ITEM_RE.test(paras[probe]))) {
    probe--;
  }
  if (
    probe > start &&
    paras[probe].trim().length <= MAX_ARTIFACT_PARA_LEN &&
    TRAILING_OFFER_RE.test(paras[probe].trim())
  ) {
    end = probe;
    // Drop a separator left dangling just above the removed offer.
    while (end - 1 > start && SEPARATOR_RE.test(paras[end - 1])) end--;
  }

  const kept = paras.slice(start, end).join('\n\n').trim();
  // Never hollow out a message: if stripping left nothing, keep the original.
  return kept.length > 0 ? kept : content;
}

export function groupByPhase(events: DebateEvent[]): PhaseGroup[] {
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

export function buildTranscriptMarkdown(events: DebateEvent[]): string {
  const start = findStart(events);
  const summary = findSummary(events);
  const decision = findDecision(events);
  const groups = groupByPhase(events);

  const lines: string[] = [];
  const header = start
    ? `# TradingAgentsLab: ${start.ticker} · ${start.trade_date}`
    : '# TradingAgentsLab: debate transcript';
  lines.push(header, '');
  lines.push(`_Generated ${new Date().toISOString()}_`, '');
  lines.push(
    '> **For educational research and paper trading.** TradingAgentsLab does not provide investment advice.',
    '',
  );

  if (decision) {
    lines.push('## Committee Assessment', '');
    const facts = [
      `**${stanceLabel(decision.stance)}**, conviction ${(decision.conviction * 100).toFixed(0)}%`,
    ];
    if (decision.bull_strength != null && decision.bear_strength != null) {
      facts.push(
        `bull thesis ${decision.bull_strength}/100, bear thesis ${decision.bear_strength}/100`,
      );
    }
    if (decision.risk_level != null) {
      facts.push(`risk ${riskLabel(decision.risk_level).toLowerCase()}`);
    }
    lines.push(facts.join(' · '), '');
    lines.push(decision.reasoning, '');
    lines.push(
      '_Analytical output of a simulated research committee, not a recommendation. Any investment decision is yours alone._',
      '',
    );
  }

  if (summary) {
    lines.push('## Data summary', '');
    lines.push(`- Last close: **${summary.last_close.toFixed(2)}**`);
    const sign = summary.period_change_pct >= 0 ? '+' : '';
    lines.push(`- Period change: **${sign}${summary.period_change_pct.toFixed(2)}%**`);
    lines.push(`- Range: ${summary.period_low.toFixed(2)} to ${summary.period_high.toFixed(2)}`);
    lines.push(`- Avg daily volume: ${Math.round(summary.avg_volume).toLocaleString()}`);
    lines.push(`- Sessions: ${summary.sessions}`);
    lines.push(`- Source: ${summary.source} · as of ${summary.as_of}`);
    lines.push('');
  }

  const news = findNews(events);
  if (news && news.headlines.length > 0) {
    lines.push('## News headlines', '');
    for (const h of news.headlines) {
      const meta = [h.publisher, h.pub_date].filter(Boolean).join(' · ');
      const heading = h.url ? `- [${h.title}](${h.url})` : `- ${h.title}`;
      lines.push(meta ? `${heading} _(${meta})_` : heading);
    }
    lines.push('');
  }

  for (const group of groups) {
    lines.push(`## ${PHASE_LABEL[group.phase] ?? group.phase}`, '');
    for (const msg of group.messages) {
      lines.push(`### ${msg.agent}`, '');
      lines.push(stripChatArtifacts(msg.content), '');
    }
  }

  lines.push('---', '');
  lines.push('Transcript exported from TradingAgentsLab.', '');
  return lines.join('\n');
}
