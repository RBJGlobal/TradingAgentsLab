// @vitest-environment happy-dom
//
// Alpaca key check in Settings and the run-time notice. Settings used to show
// "Connected" whenever an Alpaca key was stored, even one Alpaca rejected.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { alpacaStatus } from '../../src/lib/alpaca-status';
import type { AlpacaTestResult, DebateEvent } from '../../src/lib/engine-client';
import DebateStream, { findDataWarning } from '../../src/components/DebateStream';

afterEach(() => cleanup());

const done = (result: AlpacaTestResult) => ({ phase: 'done' as const, result });
const DASHES = /[–—]/;

describe('alpacaStatus', () => {
  it('returns null when neither key is stored', () => {
    expect(alpacaStatus(false, false, { phase: 'idle' })).toBeNull();
  });

  it('asks for the missing half when only one key is stored', () => {
    expect(alpacaStatus(true, false, { phase: 'idle' })).toMatchObject({
      label: 'Needs Secret',
      variant: 'warning',
    });
    expect(alpacaStatus(false, true, { phase: 'idle' })).toMatchObject({
      label: 'Needs Key ID',
      variant: 'warning',
    });
  });

  it('never says Connected before the check has answered', () => {
    for (const phase of ['idle', 'checking'] as const) {
      const s = alpacaStatus(true, true, { phase });
      expect(s?.label).toBe('Checking…');
      expect(s?.variant).not.toBe('success');
    }
  });

  it('says Connected only when Alpaca accepted the keys', () => {
    const s = alpacaStatus(
      true,
      true,
      done({ ok: true, status: 'connected', detail: 'Alpaca accepted the keys.' }),
    );
    expect(s).toEqual({ label: 'Connected ✓', variant: 'success', detail: null });
  });

  it('shows a red Key rejected with what to do', () => {
    const s = alpacaStatus(
      true,
      true,
      done({ ok: false, status: 'rejected', detail: 'Alpaca rejected these keys (HTTP 401).' }),
    );
    expect(s?.label).toBe('Key rejected');
    expect(s?.variant).toBe('error');
    expect(s?.detail).toContain('HTTP 401');
    expect(s?.detail).toContain('Regenerate');
  });

  it('shows amber Not checked when Alpaca could not be reached', () => {
    const s = alpacaStatus(
      true,
      true,
      done({ ok: false, status: 'unreachable', detail: 'Could not reach Alpaca to check the keys.' }),
    );
    expect(s?.label).toBe('Not checked');
    expect(s?.variant).toBe('warning');
    expect(s?.detail).toContain('may still work');
  });

  it('has no em or en dashes in any user-facing text', () => {
    const results: AlpacaTestResult[] = [
      { ok: true, status: 'connected', detail: 'x' },
      { ok: false, status: 'rejected', detail: 'x' },
      { ok: false, status: 'unreachable', detail: 'x' },
      { ok: false, status: 'missing', detail: 'x' },
    ];
    const all = [
      alpacaStatus(true, false, { phase: 'idle' }),
      alpacaStatus(true, true, { phase: 'checking' }),
      ...results.map((r) => alpacaStatus(true, true, done(r))),
    ];
    for (const s of all) {
      expect(`${s?.label} ${s?.detail ?? ''}`).not.toMatch(DASHES);
    }
  });
});

describe('data.warning in the stream', () => {
  const WARNING: DebateEvent = {
    type: 'data.warning',
    source: 'alpaca',
    reason: 'rejected',
    message:
      'Alpaca rejected your saved keys, so this analysis has no Alpaca price card or headlines. Check the keys in Settings, Data Providers.',
  };

  it('is found among the events', () => {
    expect(findDataWarning([WARNING])).toEqual(WARNING);
    expect(findDataWarning([])).toBeNull();
  });

  it('renders the engine message as a notice', () => {
    render(
      <DebateStream
        events={[
          { type: 'session.start', ticker: 'NVDA', trade_date: '2026-11-13' } as DebateEvent,
          WARNING,
        ]}
        isStreaming
      />,
    );
    const notice = screen.getByTestId('data-warning');
    expect(notice.textContent).toContain('Alpaca rejected your saved keys');
    expect(notice.textContent).not.toMatch(DASHES);
  });

  it('shows nothing when the run had no warning', () => {
    render(
      <DebateStream
        events={[{ type: 'session.start', ticker: 'NVDA', trade_date: '2026-11-13' } as DebateEvent]}
        isStreaming
      />,
    );
    expect(screen.queryByTestId('data-warning')).toBeNull();
  });
});
