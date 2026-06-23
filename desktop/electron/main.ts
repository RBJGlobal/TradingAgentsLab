import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  onEngineExit,
  startEngine,
  stopEngine,
  type EngineHandshake,
} from './engine-runner';
import { registerAppMenu } from './menu';
import { OpenAIOAuthService } from './oauth-openai';
import {
  deleteSecret,
  getCorruptionRecovery,
  getSecret,
  isEncryptionAvailable,
  listSecrets,
  onSecretsRecovered,
  secretsFileLocation,
  setSecret,
} from './secrets';
import { checkUpstream, type UpstreamCheckResult } from './upstream-check';
import { loadWindowState, saveWindowState } from './window-state';
import { waitForPreload } from './preload-ready';
import { CONSENT_VERSION, getAcceptedVersion, recordConsent } from './consent';
import { registerUpdater } from './updater';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '..');

// Display name for the macOS menu bar, dock tooltip, and the first menu
// item next to the Apple logo. Must be called before `app.whenReady()`
// resolves and before the menu template references `app.name`.
// Repo / package names stay one word ("TradingAgentsLab") — only the
// user-facing display surface is three words.
app.setName('Trading Agents Lab');

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

// App icon resolution.
// - macOS dock + production .app bundle prefer `build/icon.icns` (multi-
//   resolution; OS picks the right size per surface).
// - Linux + Windows + the BrowserWindow `icon` option use `build/icon.png`.
// In dev mode `process.env.APP_ROOT` resolves to `desktop/`, where the
// generated assets live at `build/icon.{icns,png}`. Production builds
// (electron-builder, Phase 7) will read the same paths.
const ICON_PNG_PATH = path.join(process.env.APP_ROOT, 'build', 'icon.png');
// build/icon.icns is generated alongside (sips + iconutil) for the
// production .app bundle. Not referenced from TypeScript today —
// electron-builder reads it at package time — but kept beside the PNG
// so the two stay in sync if regenerated.

let win: BrowserWindow | null = null;

async function createWindow() {
  const saved = await loadWindowState();
  const preloadPath = path.join(__dirname, 'preload.mjs');
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    title: 'Trading Agents Lab',
    // BrowserWindow takes a single icon for cross-platform use. macOS reads
    // it but defers to the app bundle's icon at runtime — `app.dock.setIcon`
    // below is what actually swaps the dock icon in dev mode.
    icon: ICON_PNG_PATH,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Persist bounds on close so the next launch restores them. Pulling the
  // bounds inside the event handler (not from a stale snapshot) avoids
  // saving an intermediate value if the user resized just before quitting.
  win.on('close', () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    void saveWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only hand http(s) links off to the OS browser. A file:, javascript:,
    // or other-scheme URL from a renderer bug must never reach the OS via
    // shell.openExternal. The window itself is never opened either way.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (VITE_DEV_SERVER_URL) {
    // Cold-boot race guard: vite-plugin-electron can spawn Electron before the
    // preload bundle is written, leaving the window with no contextBridge that
    // never self-heals on reload. Wait for the preload file before loading so
    // the bridge is always present on first paint. See waitForPreload.
    await waitForPreload(preloadPath);
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

ipcMain.handle('engine:get-handshake', async (): Promise<EngineHandshake> => {
  return startEngine();
});

// First-launch consent gate (Phase 7c.3). The renderer asks for the accepted
// vs required version on mount and blocks the UI until they match.
ipcMain.handle('consent:get', () => ({
  acceptedVersion: getAcceptedVersion(),
  requiredVersion: CONSENT_VERSION,
}));
ipcMain.handle('consent:accept', () => {
  recordConsent();
  return true;
});
// Decline = the user does not agree to the educational-use terms, so we quit.
ipcMain.handle('consent:decline', () => {
  app.quit();
});

ipcMain.handle('secrets:availability', () => ({
  available: isEncryptionAvailable(),
  filePath: secretsFileLocation(),
  // null in the common case; populated if a corrupt secrets.json was
  // backed-up-and-replaced during this process lifetime. Lets the
  // Settings page show a recovery banner even if it mounted after the
  // recovery happened (the push IPC below covers the live case).
  corruptionRecovery: getCorruptionRecovery(),
}));

ipcMain.handle(
  'secrets:set',
  (_evt, key: string, value: string) => setSecret(key, value),
);

ipcMain.handle('secrets:get', (_evt, key: string) => {
  // OAuth tokens have a dedicated bridge (`oauth:openai:credentials`) that
  // refreshes-on-stale and never returns the raw blob to the renderer.
  // Block the `oauth:` prefix here so the renderer cannot accidentally
  // (or maliciously) read the token JSON via the generic secrets channel.
  if (typeof key === 'string' && key.startsWith('oauth:')) return null;
  return getSecret(key);
});

ipcMain.handle('secrets:list', () => listSecrets());

ipcMain.handle('secrets:delete', (_evt, key: string) => deleteSecret(key));

// ---- OAuth (OpenAI Codex / ChatGPT subscription) -------------------------
//
// Renderer never sees the access/refresh tokens — they're decrypted in main
// and attached as a Bearer header by `engine-client.ts` only at WS-frame
// build time. The renderer only sees status (connected/email/expires).

let openaiOAuth: OpenAIOAuthService | null = null;

function ensureOAuthService(): OpenAIOAuthService {
  if (!openaiOAuth) {
    openaiOAuth = new OpenAIOAuthService(
      (event) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('oauth:openai:progress', event);
        }
      },
      (event) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('oauth:openai:prompt', event);
        }
      },
    );
  }
  return openaiOAuth;
}

ipcMain.handle('oauth:openai:start', () => ensureOAuthService().startLogin());
ipcMain.handle('oauth:openai:status', () => ensureOAuthService().getStatus());
ipcMain.handle('oauth:openai:disconnect', () =>
  ensureOAuthService().disconnect(),
);
ipcMain.on('oauth:openai:prompt-response', (_evt, value: string) => {
  ensureOAuthService().handlePromptResponse(value);
});
// Used by `engine-client.ts` to fetch fresh credentials right before
// building the WS start frame. Returns the credentials object (or null).
ipcMain.handle('app:check-upstream', async (): Promise<UpstreamCheckResult> => {
  return checkUpstream();
});

// ---- Graceful shutdown / restart ---------------------------------------
//
// Founder ask 2026-05-09: surface a way to cleanly stop + relaunch the app
// without going to the terminal. The macOS red traffic-light just hides
// the window; closing all windows fires `window-all-closed` which calls
// stopEngine() — but only on non-darwin platforms does it `app.quit()`.
// Result: on macOS the app sits in the dock with no window AND the engine
// is killed, leaving the user in a weird state.
//
// These IPC handlers make Shutdown + Restart explicit. Both SIGTERM the
// tracked engine via stopEngine() and then quit / relaunch.
//
// Orphan engines from a *previously crashed* session are reaped by the
// pidfile-targeted reapOrphanEngine() inside startEngine() on the next launch
// (Tier 1, 2026-05-23). That replaced the old broad `pkill -f 'engine/.venv/
// bin/python -m engine'` here, which also killed unrelated dev engines running
// in other terminals.

const IS_DEV = Boolean(process.env['VITE_DEV_SERVER_URL']);

async function confirmAction(action: 'shutdown' | 'restart'): Promise<boolean> {
  const w = win;
  const messages = {
    shutdown: {
      title: 'Shut down Trading Agents Lab?',
      detail: 'The engine sidecar will stop and the app will quit. Any in-flight debate is aborted.',
      confirmLabel: 'Shut down',
    },
    restart: {
      title: 'Restart Trading Agents Lab?',
      detail: 'The engine sidecar will stop and the app will relaunch. Any in-flight debate is aborted.',
      confirmLabel: 'Restart',
    },
  };
  const cfg = messages[action];
  const result = await dialog.showMessageBox(w ?? undefined!, {
    type: 'question',
    buttons: ['Cancel', cfg.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    title: cfg.title,
    message: cfg.title,
    detail: cfg.detail,
  });
  return result.response === 1;
}

ipcMain.handle('app:shutdown', async (): Promise<void> => {
  const ok = await confirmAction('shutdown');
  if (!ok) return;
  stopEngine();
  app.quit();
});

ipcMain.handle('app:restart', async (): Promise<void> => {
  const ok = await confirmAction('restart');
  if (!ok) return;
  stopEngine();
  if (IS_DEV) {
    // Dev mode quirk: app.relaunch() respawns Electron but the npm
    // script that owns Vite dies with the old Electron, leaving the new
    // Electron loading from a dead localhost:5173. Delegate to a
    // detached helper script that waits for our quit, kills any
    // leftovers, then spawns a fresh `npm run dev`. See tools/dev-restart.sh
    // for the full dance. Production builds use the simple relaunch.
    const repoRoot = path.resolve(app.getAppPath(), '..');
    const restartScript = path.join(repoRoot, 'tools', 'dev-restart.sh');
    const devProcess = spawn(restartScript, [], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    devProcess.unref();
  } else {
    app.relaunch();
  }
  app.quit();
});

ipcMain.handle('oauth:openai:credentials', async () => {
  return ensureOAuthService().refreshIfNeeded();
});

app.whenReady().then(() => {
  // macOS: replace Electron's default dock icon with the Trading Agents
  // Lab mark. Only needed in dev mode (`npm run dev` runs vanilla
  // Electron via vite-plugin-electron, which doesn't carry the bundled
  // .app icon). Production builds bake the icon into the .app bundle
  // and ignore this call. `app.dock` is undefined on non-darwin
  // platforms, so the optional chain keeps this cross-platform.
  // NOTE: `setIcon` accepts PNG-based NativeImage paths only — .icns is
  // for the bundled .app, not for the dynamic dock-icon API. Production
  // electron-builder will still read build/icon.icns for the bundle.
  //
  // Gated to dev only: in a packaged app ICON_PNG_PATH points inside the
  // asar and the bundle already carries its own icon, so calling setIcon
  // there is both unnecessary and a hard failure (a missing-image rejection
  // here previously broke the whenReady chain before startEngine ran).
  if (!app.isPackaged) {
    app.dock?.setIcon(ICON_PNG_PATH);
  }

  // When the engine crashes after a good handshake, the renderer is holding a
  // now-dead port/token. Push an event so it drops its cached handshake; its
  // next health poll re-fetches via getEngineHandshake(), which lazily respawns
  // a fresh engine. Registered before startEngine() so an early crash is caught.
  onEngineExit(() => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('engine:exited');
    }
  });

  // If the encrypted secrets file is unreadable at session start, the
  // secrets module quietly backs it up and starts fresh. Forward that to
  // the renderer so Settings shows a banner ("your keys couldn't be read,
  // backup saved to <path>, re-enter them"). The push covers a recovery
  // that happens AFTER the renderer mounts; first-mount state is read
  // via `secrets:availability` so the banner appears either way.
  onSecretsRecovered((info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('secrets:recovered', info);
    }
  });

  // Start the sidecar eagerly so the handshake is ready by the time the
  // renderer asks for it. The IPC handler awaits the same promise.
  startEngine().catch((err) => {
    console.error('[engine] failed to start:', err);
  });

  registerAppMenu(() => win);

  void createWindow();

  // Auto-update (packaged only). Registered after the window exists so its
  // status events reach the renderer. No-op in dev / until a release feed exists.
  registerUpdater(() => win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.on('before-quit', () => {
  stopEngine();
});
