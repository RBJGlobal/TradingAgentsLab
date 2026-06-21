// @vitest-environment happy-dom
//
// Renderer component test (the first one — establishes the React Testing
// Library + happy-dom harness). Guards the DebateStream elapsed-clock reset:
// the component stays mounted across analyses (it renders null when empty),
// so its startedAt/endedAt refs must reset when events clear, or a 2nd run in
// the same session never starts its clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import DebateStream from '../../src/components/DebateStream';
import type { DebateEvent } from '../../src/lib/engine-client';

const START: DebateEvent = {
  type: 'session.start',
  ticker: 'NVDA',
  trade_date: '2026-06-16',
} as DebateEvent;

const AGENT: DebateEvent = {
  type: 'agent.message',
  agent: 'market_analyst',
  phase: 'analysts',
  content: 'analysis',
} as DebateEvent;

const COMPLETE: DebateEvent = {
  type: 'session.complete',
  ticker: 'NVDA',
  trade_date: '2026-06-16',
  decision: { action: 'HOLD', confidence: 0.55, reasoning: 'steady' },
} as DebateEvent;

describe('DebateStream elapsed clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('restarts the clock on a second run in the same mounted component', () => {
    const run = [START, AGENT];

    // Run 1, streaming: the tick interval must be active.
    const { rerender } = render(<DebateStream events={run} isStreaming />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Run 1 completes: decision lands, streaming stops, interval cleared.
    rerender(
      <DebateStream events={[...run, COMPLETE]} isStreaming={false} />,
    );
    expect(vi.getTimerCount()).toBe(0);

    // Page clears events for a new run (component stays mounted, renders null).
    rerender(<DebateStream events={[]} isStreaming={false} />);

    // Run 2 starts. Before the fix, the stale endedAt ref made the tick effect
    // early-return so the clock never restarted. After the fix the refs reset
    // on the empty render, so the interval is active again.
    rerender(<DebateStream events={run} isStreaming />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('renders nothing when there are no events', () => {
    const { container } = render(
      <DebateStream events={[]} isStreaming={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
