// @vitest-environment happy-dom
//
// Functional test of the first-launch consent gate (Phase 7c.3): it must block
// the app until consent for the current version is on record, render children
// once it is, and route Agree/Decline to the right bridge calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConsentGate from '../../src/components/ConsentGate';

function stubBridge(consent: {
  get: () => Promise<{ acceptedVersion: number | null; requiredVersion: number }>;
  accept?: () => Promise<boolean>;
  decline?: () => Promise<void>;
}) {
  (window as unknown as { tradingAgentsLab: unknown }).tradingAgentsLab = {
    consent: {
      get: consent.get,
      accept: consent.accept ?? (() => Promise.resolve(true)),
      decline: consent.decline ?? (() => Promise.resolve()),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConsentGate', () => {
  it('renders children when the current version is already accepted', async () => {
    stubBridge({ get: () => Promise.resolve({ acceptedVersion: 1, requiredVersion: 1 }) });
    render(<ConsentGate><div>APP CONTENT</div></ConsentGate>);
    expect(await screen.findByText('APP CONTENT')).toBeTruthy();
    expect(screen.queryByText('Before you begin')).toBeNull();
  });

  it('blocks with the agreement when consent is missing/stale', async () => {
    stubBridge({ get: () => Promise.resolve({ acceptedVersion: null, requiredVersion: 1 }) });
    render(<ConsentGate><div>APP CONTENT</div></ConsentGate>);
    expect(await screen.findByText('Before you begin')).toBeTruthy();
    expect(screen.queryByText('APP CONTENT')).toBeNull();
  });

  it('accepts on "I Agree" and then reveals the app', async () => {
    const accept = vi.fn(() => Promise.resolve(true));
    stubBridge({
      get: () => Promise.resolve({ acceptedVersion: null, requiredVersion: 1 }),
      accept,
    });
    render(<ConsentGate><div>APP CONTENT</div></ConsentGate>);
    fireEvent.click(await screen.findByText('I Agree'));
    await waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(await screen.findByText('APP CONTENT')).toBeTruthy();
  });

  it('calls decline on "Decline and Quit"', async () => {
    const decline = vi.fn(() => Promise.resolve());
    stubBridge({
      get: () => Promise.resolve({ acceptedVersion: null, requiredVersion: 1 }),
      decline,
    });
    render(<ConsentGate><div>APP CONTENT</div></ConsentGate>);
    fireEvent.click(await screen.findByText('Decline and Quit'));
    await waitFor(() => expect(decline).toHaveBeenCalledOnce());
  });

  it('fails safe to the gate if consent state cannot be read', async () => {
    stubBridge({ get: () => Promise.reject(new Error('ipc down')) });
    render(<ConsentGate><div>APP CONTENT</div></ConsentGate>);
    expect(await screen.findByText('Before you begin')).toBeTruthy();
    expect(screen.queryByText('APP CONTENT')).toBeNull();
  });
});
