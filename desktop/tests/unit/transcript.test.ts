// Chat-artifact stripping for the transcript exporter. Every fixture below
// is a (trimmed) verbatim artifact from the real TSLA runs of 2026-07-06 —
// one OpenAI OAuth run and one Anthropic API run leaked the same shapes.
import { describe, expect, it } from 'vitest';
import { stripChatArtifacts } from '../../src/lib/transcript';

const REPORT_BODY = [
  '## Price structure overview',
  '',
  'TSLA has been structurally weak over the longer horizon, though not in complete capitulation.',
  '',
  '## Momentum analysis',
  '',
  'MACD improved materially from late June into early July.',
].join('\n');

describe('stripChatArtifacts', () => {
  it('strips an "I now have..." preamble and its dangling separator (Anthropic run)', () => {
    const raw = [
      'I now have a comprehensive and rich dataset. Let me compile the full analytical report.',
      '',
      '---',
      '',
      REPORT_BODY,
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('strips an "All data has been collected. Here is..." preamble', () => {
    const raw = [
      'All data has been collected. Here is the comprehensive fundamental analysis report for **TSLA** as of **July 6, 2026**:',
      '',
      REPORT_BODY,
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('strips a short "Here is the ... :" lead-in', () => {
    const raw = [
      'Here is the comprehensive technical analysis report for **TSLA** as of **July 6, 2026**:',
      '',
      '---',
      '',
      REPORT_BODY,
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('strips a trailing "If helpful, I can next turn this into:" offer with its list (OpenAI run)', () => {
    const raw = [
      REPORT_BODY,
      '',
      'If helpful, I can next turn this into:',
      '',
      '1. a bullish vs bearish TSLA trading checklist for this week, or',
      '2. a concise bull-vs-bear read based only on this sentiment/news evidence.',
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('strips a trailing "If you want, I can turn this into:" offer', () => {
    const raw = [
      REPORT_BODY,
      '',
      'If you want, I can turn this into:',
      '',
      '1. a sharper **bull-vs-bear rebuttal script**, or',
      '2. a **formal BUY thesis with target drivers and risk matrix**.',
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('strips both ends at once', () => {
    const raw = [
      'I now have sufficient data to compile a comprehensive report. Let me synthesize both TSLA-specific and global macro news.',
      '',
      '---',
      '',
      REPORT_BODY,
      '',
      'Would you like me to expand any section?',
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(REPORT_BODY);
  });

  it('does NOT strip a first-person sentence that opens real analysis', () => {
    // Bull/bear researchers legitimately open in first person mid-debate.
    const raw = [
      "Bull Analyst: I get the bear case: valuation is rich, margins are compressed, the chart is messy.",
      '',
      REPORT_BODY,
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(raw);
  });

  it('does NOT strip a long paragraph even when it starts like a preamble', () => {
    const longOpen =
      'I have reviewed the full technical picture and ' + 'x'.repeat(300);
    const raw = [longOpen, '', REPORT_BODY].join('\n');
    expect(stripChatArtifacts(raw)).toBe(raw);
  });

  it('does NOT strip ordinary trailing list content without an offer anchor', () => {
    const raw = [
      REPORT_BODY,
      '',
      'Key levels to watch:',
      '',
      '1. Resistance at 406.4 (50 SMA)',
      '2. Support at 369.1 (lower Bollinger band)',
    ].join('\n');
    expect(stripChatArtifacts(raw)).toBe(raw);
  });

  it('never hollows out a message that is only a preamble-shaped line', () => {
    const raw = 'I now have the data.';
    expect(stripChatArtifacts(raw)).toBe(raw);
  });
});
