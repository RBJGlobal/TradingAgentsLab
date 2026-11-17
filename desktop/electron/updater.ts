/**
 * Auto-update over the air (Phase 7c.4).
 *
 * Uses electron-updater against the GitHub Releases feed configured in
 * electron-builder.yml (`publish: github`). Only active in a packaged app
 * (electron-updater can't update a dev/unpackaged build) and only auto-checks
 * when the user's `autoUpdate` preference is on (default on). A manual
 * "Check for updates" works regardless of the auto setting (still packaged-only).
 *
 * Privacy: electron-updater 6.8.9 would make a random ID per install, keep it
 * in <userData>/.updaterId, and send it as the header x-user-staging-id on
 * every check. hardenUpdaterPrivacy (updater-privacy.ts, ported unchanged from
 * Clawless Computer) removes that before anything else touches the updater:
 * fixed all-zero ID that is never stored, header dropped from every request.
 * If the hardening does not hold, this module refuses every check, download
 * and install and tells the user (fail closed, never a silent skip). Disclosed
 * in the KB + the first-launch consent gate. The user can disable the
 * automatic check.
 *
 * NOTE: the actual update flow can only be exercised once CI publishes the
 * first release (Phase 7c.5). This module wires + guards it; it is a safe no-op
 * until a feed with releases exists.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { getAutoUpdate, setAutoUpdate } from './prefs';
import { hardenUpdaterPrivacy } from './updater-privacy';
import { removeLeftoverUpdaterIdFile } from './updater-id-file';

const { autoUpdater } = electronUpdater;

/** Shown when the privacy hardening did not hold and update checks are refused. */
export const UPDATES_UNAVAILABLE_MESSAGE =
  'Update checks are not available in this build. To update, download the latest version from tradingagentslab.ai.';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev'
  | 'unavailable';

let getWin: (() => BrowserWindow | null) | null = null;

function send(state: UpdateState, extra: Record<string, unknown> = {}): void {
  const win = getWin?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updates:status', { state, ...extra });
  }
}

export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow;

  // First, before any other updater setting or check: take the per-install ID
  // out of every update request. If that does not hold, no update traffic runs.
  const privacy = hardenUpdaterPrivacy(autoUpdater);
  const checksUnavailable = !privacy.ok;
  if (checksUnavailable) {
    console.warn(`[updater] update checks refused: ${privacy.missing.join('; ')}`);
  } else if (app.isPackaged) {
    // An older build may have left the ID file; it is never read now, but a
    // downgrade would send it again, so remove it.
    removeLeftoverUpdaterIdFile(app.getPath('userData'));
  }
  const refuse = () => send('unavailable', { message: UPDATES_UNAVAILABLE_MESSAGE });

  autoUpdater.autoDownload = !checksUnavailable;
  autoUpdater.autoInstallOnAppQuit = !checksUnavailable;
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) =>
    send('available', { version: info.version }),
  );
  autoUpdater.on('update-not-available', () => send('not-available'));
  autoUpdater.on('download-progress', (p) =>
    send('downloading', { percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    send('downloaded', { version: info.version });
    // Proactively prompt: an update has finished downloading. Restart now to
    // install it, otherwise it installs automatically on the next quit
    // (autoInstallOnAppQuit). The renderer also shows status in Settings.
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Trading Agents Lab ${info.version} is ready to install.`,
      detail:
        'Restart now to update, or it will install automatically the next time you quit.',
    };
    const onChoice = (result: Electron.MessageBoxReturnValue) => {
      if (result.response === 0 && !checksUnavailable) autoUpdater.quitAndInstall();
    };
    const win = getWin?.();
    const prompt = win
      ? dialog.showMessageBox(win, opts)
      : dialog.showMessageBox(opts);
    void prompt.then(onChoice);
  });
  autoUpdater.on('error', (err) =>
    send('error', { message: String(err?.message ?? err) }),
  );

  ipcMain.handle('updates:get-state', () => ({
    autoUpdate: getAutoUpdate(),
    currentVersion: app.getVersion(),
    supported: app.isPackaged,
    checksUnavailable,
  }));
  ipcMain.handle('updates:set-auto', (_e, enabled: boolean) =>
    setAutoUpdate(Boolean(enabled)),
  );
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) {
      send('dev');
      return { ok: false, reason: 'dev' };
    }
    if (checksUnavailable) {
      refuse();
      return { ok: false, reason: 'unavailable' };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      send('error', { message: String(err) });
      return { ok: false };
    }
  });
  ipcMain.handle('updates:install', () => {
    // The reliable install path: quitAndInstall quits the app, applies the
    // downloaded update, and relaunches. The generic in-app Restart / Shut down
    // do NOT apply an update (only a true quit triggers autoInstallOnAppQuit),
    // which is confusing — so the UI offers an explicit "Restart & install".
    if (checksUnavailable) {
      refuse();
      return;
    }
    autoUpdater.quitAndInstall();
  });

  // Auto-check on launch AND periodically, when packaged and not opted out.
  // (Checking only at launch means a long-running app never notices updates.)
  // autoDownload pulls it in the background; update-downloaded pops the prompt.
  if (app.isPackaged && checksUnavailable) {
    refuse();
  } else if (app.isPackaged) {
    const check = () => {
      if (!getAutoUpdate()) return;
      autoUpdater
        .checkForUpdates()
        .catch((err) => send('error', { message: String(err) }));
    };
    check();
    setInterval(check, 4 * 60 * 60 * 1000); // re-check every 4 hours
  }
}
