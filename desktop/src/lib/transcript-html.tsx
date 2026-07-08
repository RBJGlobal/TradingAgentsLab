/**
 * Standalone-HTML transcript generator.
 *
 * Turns a debate event stream into a self-contained HTML document: inline
 * CSS, no external assets, no scripts. It opens in any browser as a
 * full-page reading view (the in-app DebateStream is cramped for a full
 * transcript) and doubles as the generator for per-ticker showcase and
 * how-it-works content on the website, so keep this module free of
 * renderer-only dependencies (no bridge calls, no CSS modules) — callers
 * hand it events, it hands back a string.
 *
 * Rendering goes through the SAME pipeline the app uses on screen:
 * react-markdown + remark-gfm via renderToStaticMarkup. That keeps tables,
 * the single-tilde fix, and the no-raw-HTML XSS posture identical to the
 * in-app view with zero new dependencies. Model output can never inject
 * markup: react-markdown escapes it (we do not enable rehype-raw).
 *
 * Disclaimers are the locked three-tier set (2026-05-09): banner up top,
 * inline line under the decision card, full page-level text at the bottom.
 * They are baked into the document, not optional.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DebateEvent } from './engine-client';
import { riskLabel, stanceLabel, stanceLean } from './stance';
import {
  PHASE_LABEL,
  findDecision,
  findNews,
  findStart,
  findSummary,
  groupByPhase,
  stripChatArtifacts,
} from './transcript';

/** Render agent markdown to static HTML with the app's exact settings. */
function markdownToHtml(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]}>
      {md}
    </ReactMarkdown>,
  );
}

/** Escape a plain string for interpolation into HTML text content. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Locked tier-1 / tier-2 lines (verbatim from the shipped app copy).
const TIER1 =
  'Educational research only · Not a registered investment advisor · Not investment advice';
const TIER2 =
  'Not investment advice · LLM output may be inaccurate · Verify independently before any action';
// Locked tier-3 page-level disclaimer, exactly as shipped on the Analyze page.
const TIER3 =
  '<strong>For educational and research purposes only.</strong> Trading Agents Lab is ' +
  '<strong>not a registered investment advisor</strong> and does not provide investment, ' +
  'financial, legal, or tax advice. The multi-agent LLM analyses on this page may be ' +
  'inaccurate, incomplete, or outdated: large language models can and do hallucinate. ' +
  'Nothing produced by this software is a recommendation to buy, sell, or hold any ' +
  'security, cryptocurrency, or other asset. Consult a qualified financial professional ' +
  'before making any investment decision. You assume all risk for any action you take ' +
  'based on this analysis. The maintainers and contributors accept no liability for ' +
  'losses arising from use of this software.';

// Palette mirrors the free app's design tokens (src/styles/tokens.css):
// #0d1117 base, warm amber accent #f0a830, and the same text/border ramp — so
// the exported page reads as the same product as the app window. Values are
// copied, not imported: the document must be truly standalone, and CSS
// custom properties can't cross a file boundary. If tokens.css shifts,
// refresh these. System font stacks only (no bundled fonts in the export).
const STYLE = `
  :root {
    --bg: #0d1117; --panel: #161b22; --panel-2: #1c232c; --line: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #f0a830; --accent-strong: #ffb74d;
    --buy: #3fb950; --sell: #f85149; --hold: #9ea7b3;
    --mono: ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--sans); line-height: 1.65; font-size: 16px;
  }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }
  .brand { font-family: var(--mono); font-size: 13px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent-strong); }
  .banner { border: 1px solid var(--line); border-left: 3px solid var(--accent-strong);
    background: var(--panel); padding: 10px 14px; margin: 20px 0; border-radius: 6px;
    color: var(--muted); font-size: 13.5px; }
  h1 { font-family: var(--mono); font-size: 26px; margin: 14px 0 2px; }
  .meta { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  h2.section { font-family: var(--mono); font-size: 15px; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--accent-strong); border-bottom: 1px solid var(--line);
    padding-bottom: 6px; margin: 40px 0 16px; }
  .decision { background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 20px 22px; margin-top: 16px; }
  .action { font-family: var(--mono); font-size: 30px; font-weight: 700; }
  .action.buy { color: var(--buy); } .action.sell { color: var(--sell); }
  .action.hold { color: var(--hold); }
  .decision .facts { color: var(--muted); font-family: var(--mono);
    font-size: 13.5px; margin: 6px 0 12px; }
  .ownership { color: var(--muted); font-size: 12.5px; margin-top: 16px; }
  .tier2 { color: var(--muted); font-size: 12.5px; border-top: 1px dashed var(--line);
    margin-top: 10px; padding-top: 10px; }
  ul.data { list-style: none; padding: 0; margin: 0; }
  ul.data li { padding: 3px 0; }
  ul.data .k { color: var(--muted); display: inline-block; min-width: 170px; }
  .agent { background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 6px 22px 18px; margin: 0 0 18px; }
  .agent-name { font-family: var(--mono); font-size: 13px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent-strong); margin: 14px 0 4px; }
  .agent h1, .agent h2, .agent h3, .agent h4 { font-family: var(--mono);
    color: var(--text); line-height: 1.3; }
  .agent h1 { font-size: 19px; } .agent h2 { font-size: 17px; }
  .agent h3 { font-size: 15.5px; } .agent h4 { font-size: 14.5px; }
  .agent table { border-collapse: collapse; width: 100%; margin: 14px 0;
    font-size: 14px; display: block; overflow-x: auto; }
  .agent th, .agent td { border: 1px solid var(--line); padding: 6px 10px;
    text-align: left; vertical-align: top; }
  .agent th { background: var(--panel-2); font-family: var(--mono); font-size: 12.5px; }
  .agent code { font-family: var(--mono); background: var(--panel-2);
    padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  .agent hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
  .agent blockquote { border-left: 3px solid var(--accent); margin: 12px 0;
    padding: 2px 14px; color: var(--muted); }
  .agent a { color: var(--accent-strong); }
  .news a { color: var(--accent-strong); } .news .src { color: var(--muted); font-size: 13px; }
  footer { margin-top: 48px; border-top: 1px solid var(--line); padding-top: 18px;
    color: var(--muted); font-size: 13px; }
  footer .tier3 { line-height: 1.7; }
  footer .tier1 { font-family: var(--mono); font-size: 12px; margin-top: 14px;
    letter-spacing: 0.04em; }
  @media print {
    body { background: #ffffff; color: #1c1a15; }
    :root { --bg: #ffffff; --panel: #ffffff; --panel-2: #eef0f4; --line: #c3c9d4;
      --text: #16191f; --muted: #4d5560; --accent: #b97a10; --accent-strong: #b97a10; }
    .agent, .decision { border-color: #c3c9d4; }
  }
`;

export interface TranscriptHtmlResult {
  html: string;
  /** Filesystem-safe base name, e.g. "tsla-2026-07-06". */
  suggestedName: string;
}

export function buildTranscriptHtml(events: DebateEvent[]): TranscriptHtmlResult {
  const start = findStart(events);
  const summary = findSummary(events);
  const decision = findDecision(events);
  const news = findNews(events);
  const groups = groupByPhase(events);

  const ticker = start?.ticker ?? 'transcript';
  const date = start?.trade_date ?? '';
  const title = start
    ? `${start.ticker} · ${start.trade_date} · Trading Agents Lab`
    : 'Debate transcript · Trading Agents Lab';
  const suggestedName = `${ticker}-${date || 'session'}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const parts: string[] = [];

  parts.push('<header>');
  parts.push('<div class="brand">Trading Agents Lab · The Diligence</div>');
  parts.push(
    `<h1>${esc(start ? `${start.ticker} · ${start.trade_date}` : 'Debate transcript')}</h1>`,
  );
  parts.push(`<div class="meta">Generated ${esc(new Date().toISOString())}</div>`);
  parts.push(
    '<div class="banner"><strong>For educational research and paper trading.</strong> ' +
      'Trading Agents Lab does not provide investment advice.</div>',
  );
  parts.push('</header>');

  if (decision) {
    const lean = stanceLean(decision.stance);
    const cls = lean === 'bullish' ? 'buy' : lean === 'bearish' ? 'sell' : 'hold';
    const facts: string[] = [`conviction ${(decision.conviction * 100).toFixed(0)}%`];
    if (decision.bull_strength != null && decision.bear_strength != null) {
      facts.push(
        `bull thesis ${decision.bull_strength}/100`,
        `bear thesis ${decision.bear_strength}/100`,
      );
    }
    if (decision.risk_level != null) {
      facts.push(`risk ${riskLabel(decision.risk_level).toLowerCase()}`);
    }
    parts.push('<h2 class="section">Committee Assessment</h2>');
    parts.push('<div class="decision">');
    parts.push(`<div class="action ${cls}">${esc(stanceLabel(decision.stance))}</div>`);
    parts.push(`<div class="facts">${esc(facts.join(' · '))}</div>`);
    parts.push(markdownToHtml(decision.reasoning));
    parts.push(
      `<div class="ownership">${esc(
        'This assessment is an analytical output of a simulated research committee, not a recommendation. Any investment decision is yours alone.',
      )}</div>`,
    );
    parts.push(`<div class="tier2">${esc(TIER2)}</div>`);
    parts.push('</div>');
  }

  if (summary) {
    const sign = summary.period_change_pct >= 0 ? '+' : '';
    parts.push('<h2 class="section">Data summary</h2>');
    parts.push('<ul class="data">');
    parts.push(
      `<li><span class="k">Last close</span><strong>${summary.last_close.toFixed(2)}</strong></li>`,
      `<li><span class="k">Period change</span>${sign}${summary.period_change_pct.toFixed(2)}%</li>`,
      `<li><span class="k">Range</span>${summary.period_low.toFixed(2)} to ${summary.period_high.toFixed(2)}</li>`,
      `<li><span class="k">Avg daily volume</span>${Math.round(summary.avg_volume).toLocaleString()}</li>`,
      `<li><span class="k">Sessions</span>${summary.sessions}</li>`,
      `<li><span class="k">Source</span>${esc(summary.source)} · as of ${esc(summary.as_of)}</li>`,
    );
    parts.push('</ul>');
  }

  if (news && news.headlines.length > 0) {
    parts.push('<h2 class="section">News headlines</h2>');
    parts.push('<ul class="news">');
    for (const h of news.headlines) {
      const meta = [h.publisher, h.pub_date].filter(Boolean).join(' · ');
      const label = h.url
        ? `<a href="${esc(h.url)}" rel="noreferrer noopener">${esc(h.title)}</a>`
        : esc(h.title);
      parts.push(`<li>${label}${meta ? ` <span class="src">(${esc(meta)})</span>` : ''}</li>`);
    }
    parts.push('</ul>');
  }

  for (const group of groups) {
    parts.push(`<h2 class="section">${esc(PHASE_LABEL[group.phase] ?? group.phase)}</h2>`);
    for (const msg of group.messages) {
      parts.push('<article class="agent">');
      parts.push(`<div class="agent-name">${esc(msg.agent)}</div>`);
      parts.push(markdownToHtml(stripChatArtifacts(msg.content)));
      parts.push('</article>');
    }
  }

  parts.push('<footer>');
  parts.push(`<div class="tier3">${TIER3}</div>`);
  parts.push(`<div class="tier1">${esc(TIER1)}</div>`);
  parts.push('</footer>');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><div class="wrap">',
    parts.join('\n'),
    '</div></body>',
    '</html>',
  ].join('\n');

  return { html, suggestedName };
}
