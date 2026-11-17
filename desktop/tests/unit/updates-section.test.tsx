// @vitest-environment happy-dom
//
// Functional test of the auto-update Settings control (Phase 7c.4): toggle
// wiring, the dev-vs-packaged "supported" state, manual check, and live status.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UpdatesSection from '../../src/components/UpdatesSection';

function stub(opts: {
  supported: boolean;
  autoUpdate?: boolean;
  setAuto?: (e: boolean) => Promise<boolean>;
  check?: () => Promise<{ ok: boolean }>;
}) {
  let statusHandler: ((s: unknown) => void) | null = null;
  (window as unknown as { tradingAgentsLab: unknown }).tradingAgentsLab = {
    updates: {
      getState: () =>
        Promise.resolve({
          autoUpdate: opts.autoUpdate ?? true,
          currentVersion: '0.1.0',
          supported: opts.supported,
        }),
      setAuto: opts.setAuto ?? ((e: boolean) => Promise.resolve(e)),
      check: opts.check ?? (() => Promise.resolve({ ok: true })),
      onStatus: (h: (s: unknown) => void) => {
        statusHandler = h;
        return () => {
          statusHandler = null;
        };
      },
    },
  };
  return { emit: (s: unknown) => statusHandler && statusHandler(s) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UpdatesSection', () => {
  it('reflects the stored autoUpdate setting and persists toggles', async () => {
    const setAuto = vi.fn((e: boolean) => Promise.resolve(e));
    stub({ supported: true, autoUpdate: true, setAuto });
    render(<UpdatesSection />);
    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
    fireEvent.click(checkbox);
    await waitFor(() => expect(setAuto).toHaveBeenCalledWith(false));
  });

  it('disables the check button and explains in a dev build', async () => {
    stub({ supported: false });
    render(<UpdatesSection />);
    const btn = (await screen.findByText('Check for updates')) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(screen.getByText(/installed app/i)).toBeTruthy();
  });

  it('runs a manual check when supported', async () => {
    const check = vi.fn(() => Promise.resolve({ ok: true }));
    stub({ supported: true, check });
    render(<UpdatesSection />);
    const btn = (await screen.findByText('Check for updates')) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
  });

  it('shows a live status when the updater reports one', async () => {
    const h = stub({ supported: true });
    render(<UpdatesSection />);
    await screen.findByText('Check for updates');
    act(() => h.emit({ state: 'downloaded', version: '0.2.0' }));
    expect(await screen.findByText(/Update ready \(v0\.2\.0\)/)).toBeTruthy();
  });
});

describe('UpdatesSection when update checks are refused', () => {
  it('says the check is not available and disables the button', async () => {
    stub({ supported: true });
    const bridge = (window as unknown as {
      tradingAgentsLab: { updates: { getState: () => Promise<unknown> } };
    }).tradingAgentsLab.updates;
    bridge.getState = () =>
      Promise.resolve({ autoUpdate: true, currentVersion: '1.1.6', supported: true, checksUnavailable: true });
    render(<UpdatesSection />);
    await waitFor(() => expect(screen.getByText(/Update check not available/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Update check not available/).textContent).not.toMatch(/[–—]/);
  });

  it('shows the refusal when main reports it as a status', async () => {
    const { emit } = stub({ supported: true });
    render(<UpdatesSection />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy());
    act(() => emit({ state: 'unavailable', message: 'x' }));
    expect(screen.getByText(/Update check not available/)).toBeTruthy();
  });
});
