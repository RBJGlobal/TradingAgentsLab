// The app's use of the updater privacy hardening (electron/updater.ts):
// the hardening runs first, and when it does not hold no update check,
// download or install runs and the user is told (never a silent skip).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
const order: string[] = [];

const fakeUpdater = {
  _autoDownload: false,
  _throwOnSet: false,
  set autoDownload(v: boolean) {
    order.push('autoDownload');
    if (this._throwOnSet) throw new Error('frozen');
    this._autoDownload = v;
  },
  get autoDownload() { return this._autoDownload; },
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve(null)),
  quitAndInstall: vi.fn(),
};

const harden = vi.fn();
const removeId = vi.fn();
const app = { isPackaged: true, getVersion: () => '1.1.6', getPath: () => '/fake/userData' };

vi.mock('electron', () => ({
  app,
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })) },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: fakeUpdater } }));
vi.mock('../../electron/prefs', () => ({ getAutoUpdate: () => true, setAutoUpdate: (v: boolean) => v }));
vi.mock('../../electron/updater-privacy', () => ({
  hardenUpdaterPrivacy: (u: unknown) => { order.push('harden'); return harden(u); },
}));
vi.mock('../../electron/updater-id-file', () => ({ removeLeftoverUpdaterIdFile: (d: string) => removeId(d) }));

const win = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
};

async function register() {
  vi.resetModules();
  const mod = await import('../../electron/updater');
  mod.registerUpdater(() => win as never);
  return mod;
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  order.length = 0;
  vi.clearAllMocks();
  fakeUpdater._throwOnSet = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('registerUpdater', () => {
  it('hardens the updater before any other updater setting', async () => {
    harden.mockReturnValue({ ok: true, applied: { id: true, rollout: true, headers: true }, missing: [] });
    await register();
    expect(order[0]).toBe('harden');
    expect(harden).toHaveBeenCalledWith(fakeUpdater);
  });

  it('when the hardening holds: checks run and the leftover ID file is removed', async () => {
    harden.mockReturnValue({ ok: true, applied: { id: true, rollout: true, headers: true }, missing: [] });
    await register();
    expect(removeId).toHaveBeenCalledWith('/fake/userData');
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(await handlers.get('updates:get-state')!()).toMatchObject({ checksUnavailable: false });
  });

  it('when the hardening does not hold: no check, download or install, and the user is told', async () => {
    harden.mockReturnValue({ ok: false, applied: { id: false, rollout: true, headers: true }, missing: ['x'] });
    const mod = await register();
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(fakeUpdater.autoDownload).toBe(false);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    expect(removeId).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({
      channel: 'updates:status',
      payload: { state: 'unavailable', message: mod.UPDATES_UNAVAILABLE_MESSAGE },
    });

    expect(await handlers.get('updates:check')!()).toEqual({ ok: false, reason: 'unavailable' });
    await handlers.get('updates:install')!();
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(await handlers.get('updates:get-state')!()).toMatchObject({ checksUnavailable: true });
    expect(mod.UPDATES_UNAVAILABLE_MESSAGE).not.toMatch(/[–—]/);
  });

  it('when the hardening does not hold: the Restart now dialog cannot install', async () => {
    harden.mockReturnValue({ ok: false, applied: { id: false, rollout: true, headers: true }, missing: ['x'] });
    await register();
    const onDownloaded = fakeUpdater.on.mock.calls.find((c) => c[0] === 'update-downloaded')?.[1] as
      | ((info: { version: string }) => void)
      | undefined;
    expect(onDownloaded).toBeTypeOf('function');
    onDownloaded!({ version: '9.9.9' });
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('a library object that refuses the updater settings is refused, not a crash', async () => {
    harden.mockReturnValue({ ok: true, applied: { id: true, rollout: true, headers: true }, missing: [] });
    fakeUpdater._throwOnSet = true;
    await expect(register()).resolves.toBeDefined();
    expect(fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(removeId).not.toHaveBeenCalled();
    expect(sent.at(-1)?.payload.state).toBe('unavailable');
    expect(await handlers.get('updates:get-state')!()).toMatchObject({ checksUnavailable: true });
  });
});
