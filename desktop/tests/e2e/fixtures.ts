/**
 * Test fixture for launching Electron + the engine sidecar against a
 * sandboxed userData directory + a sandboxed sessions DB.
 *
 * Isolation: every test gets a fresh tmp directory for both, so:
 * - Secrets the test writes never leak into the founder's real keyring file
 * - Persisted sessions never pollute the founder's real history
 * - Cost-guard state starts fresh per test
 *
 * Engine spawning happens via the normal main.ts startEngine() path —
 * we don't mock it. Tests exercise the actual contract from UI through
 * IPC through HTTP/WS to the Python sidecar.
 *
 * Orphan engine sweep on test teardown: if a test crashes between
 * `_electron.launch()` and `app.close()`, the engine survives. The teardown
 * below reads the engine's pidfile from *this test's sandbox* userData and
 * SIGTERMs exactly that pid. It deliberately does NOT broad-match every
 * `python -m engine` (the old `pkill -f` approach) — that would kill a dev
 * engine running in another terminal, the very bug Tier 1 fixed in
 * electron/main.ts. Sandbox-scoped pid targeting keeps the suite safe to run
 * alongside a live dev stack.
 */
import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');

interface TalFixtures {
  /** Launched Electron app. Closes on test teardown. */
  app: ElectronApplication;
  /** The first BrowserWindow's Page object. */
  window: Page;
  /** The sandbox dir for this test. Already passed to the app. Useful
   * for asserting against disk state (secrets.json, sessions.db). */
  sandboxDir: string;
}

/** Kill the engine recorded in this sandbox's pidfile, if it is still alive.
 * Targeted by pid — never a process-name pattern — so it can only ever reap
 * the engine this test launched, not an unrelated dev engine. */
function reapSandboxEngine(userDataDir: string): void {
  let pid: number | null = null;
  try {
    const raw = readFileSync(path.join(userDataDir, 'engine.pid'), 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return; // no pidfile — engine already cleaned up on close
  }
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone — the normal case after a clean app.close().
    }
  }
}

export const test = base.extend<TalFixtures>({
  sandboxDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tal-e2e-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },

  app: async ({ sandboxDir }, use) => {
    const userDataDir = path.join(sandboxDir, 'userData');
    const sessionsDb = path.join(sandboxDir, 'sessions.db');

    // Pre-seed the first-launch consent gate (7c.3): every fresh sandbox
    // would otherwise open on the blocking "Before you begin" dialog and
    // every locator in the suite times out behind it. Version 1 matches
    // electron/consent.ts CONSENT_VERSION; bump together when the
    // agreement copy materially changes.
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'consent.json'),
      JSON.stringify({ acceptedVersion: 1, timestamp: new Date().toISOString() }),
      'utf8',
    );

    const app = await electron.launch({
      args: [
        DESKTOP_ROOT,
        // Sandbox the secrets file and any other safeStorage-backed data.
        `--user-data-dir=${userDataDir}`,
      ],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        // Sandbox the SQLite session store the engine writes to.
        TAL_SESSIONS_DB: sessionsDb,
        // No Vite dev server — main.ts falls through to loading
        // dist/index.html. We rely on the caller having built first.
        VITE_DEV_SERVER_URL: '',
        // Disable the postinstall Info.plist patch's noisy stdout
        // during repeated test launches.
        TAL_QUIET: '1',
      },
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // App may already be down; fall through to the orphan sweep.
    }
    reapSandboxEngine(userDataDir);
  },

  window: async ({ app }, use) => {
    const win = await app.firstWindow();
    // Surface renderer console errors to the test output so a failing
    // assertion isn't the first hint that the renderer threw.
    win.on('pageerror', (err) => {
      console.error('[renderer pageerror]', err.message);
    });
    win.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('[renderer error]', msg.text());
      }
    });
    await use(win);
  },
});

export { expect };
