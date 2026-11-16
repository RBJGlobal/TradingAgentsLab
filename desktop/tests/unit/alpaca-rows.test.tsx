// @vitest-environment happy-dom
//
// The Alpaca rows' key check in Settings, Data Providers: only the latest
// check's answer may land, and nothing stale lands after a key is removed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AlpacaTestResult } from '../../src/lib/engine-client';
import type { SecretListing } from '../../src/lib/secrets';

const getSecret = vi.fn<(key: string) => Promise<string | null>>();
const testAlpacaConnection = vi.fn<(args: { keyId: string; secret: string }) => Promise<AlpacaTestResult>>();

vi.mock('../../src/lib/secrets', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/secrets')>()),
  getSecret: (key: string) => getSecret(key),
}));
vi.mock('../../src/lib/engine-client', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/engine-client')>()),
  testAlpacaConnection: (args: { keyId: string; secret: string }) => testAlpacaConnection(args),
}));

const { AlpacaRows } = await import('../../src/pages/Settings');

const KEY_ID = 'data:alpaca-key-id';
const SECRET = 'data:alpaca-secret';

function listing(key: string, updatedAt: string): SecretListing {
  return { key, hint: '••••1234', updatedAt } as SecretListing;
}

function listings(stampKeyId: string | null, stampSecret: string | null) {
  const m = new Map<string, SecretListing>();
  if (stampKeyId) m.set(KEY_ID, listing(KEY_ID, stampKeyId));
  if (stampSecret) m.set(SECRET, listing(SECRET, stampSecret));
  return m;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const pillText = () => screen.getByTestId(`pill-${KEY_ID}`).textContent;

beforeEach(() => {
  getSecret.mockImplementation(async (key) => (key === KEY_ID ? 'PKVALUE' : 'SECRETVALUE'));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AlpacaRows', () => {
  it('shows Connected only after the check accepts the keys', async () => {
    const d = deferred<AlpacaTestResult>();
    testAlpacaConnection.mockReturnValueOnce(d.promise);
    render(<AlpacaRows listingByKey={listings('t1', 't1')} disabled={false} onChange={() => {}} />);
    expect(pillText()).toBe('Checking…');
    await act(async () => d.resolve({ ok: true, status: 'connected', detail: 'ok' }));
    expect(pillText()).toBe('Connected ✓');
    expect(screen.getByTestId(`pill-${SECRET}`).textContent).toBe('Connected ✓');
  });

  it('keeps only the latest check when two finish out of order', async () => {
    const first = deferred<AlpacaTestResult>();
    const second = deferred<AlpacaTestResult>();
    testAlpacaConnection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(
      <AlpacaRows listingByKey={listings('t1', 't1')} disabled={false} onChange={() => {}} />,
    );
    // A replaced key starts a second check before the first answers.
    await act(async () => {
      rerender(<AlpacaRows listingByKey={listings('t2', 't1')} disabled={false} onChange={() => {}} />);
    });
    await act(async () => second.resolve({ ok: false, status: 'rejected', detail: 'Alpaca rejected these keys (HTTP 401).' }));
    expect(pillText()).toBe('Key rejected');
    // The older check answering late must not overwrite the newer answer.
    await act(async () => first.resolve({ ok: true, status: 'connected', detail: 'ok' }));
    expect(pillText()).toBe('Key rejected');
  });

  it('drops a check that finishes after a key was deleted', async () => {
    const d = deferred<AlpacaTestResult>();
    testAlpacaConnection.mockReturnValueOnce(d.promise);
    const { rerender } = render(
      <AlpacaRows listingByKey={listings('t1', 't1')} disabled={false} onChange={() => {}} />,
    );
    await act(async () => {
      rerender(<AlpacaRows listingByKey={listings('t1', null)} disabled={false} onChange={() => {}} />);
    });
    await act(async () => d.resolve({ ok: true, status: 'connected', detail: 'ok' }));
    expect(pillText()).toBe('Needs Secret');
    expect(screen.queryByText('Checking…')).toBeNull();
  });

  it('does not check when only one key is stored', () => {
    render(<AlpacaRows listingByKey={listings('t1', null)} disabled={false} onChange={() => {}} />);
    expect(testAlpacaConnection).not.toHaveBeenCalled();
    expect(pillText()).toBe('Needs Secret');
  });

  it('says Not checked when a saved key cannot be read', async () => {
    getSecret.mockResolvedValue(null);
    render(<AlpacaRows listingByKey={listings('t1', 't1')} disabled={false} onChange={() => {}} />);
    await act(async () => {});
    expect(testAlpacaConnection).not.toHaveBeenCalled();
    expect(pillText()).toBe('Not checked');
  });
});
