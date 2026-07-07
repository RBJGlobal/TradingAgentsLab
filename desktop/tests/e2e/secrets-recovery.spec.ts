/**
 * Tier 3 e2e gate for corrupt-secrets recovery (2026-05-25).
 *
 * Closes the "Settings banner not visually verified" honesty gap from the
 * Tier 2 PR. We pre-seed the sandbox userData with a malformed `secrets.json`
 * BEFORE Electron launches, then assert:
 *
 *   1. The Settings page renders without blanking (this was the original
 *      pre-Tier-2 bug: a JSON parse throw cascaded through the secrets
 *      bridge and the whole tab tree died).
 *   2. The recovery banner is visible above the tabs with the literal
 *      backup-path suffix `.bak`.
 *   3. The original corrupt file no longer exists at `secrets.json` — it
 *      got renamed away — and a `.corrupt-*.bak` sibling does exist.
 *
 * Uses `electron.launch` directly instead of the shared `app`/`window`
 * fixtures, because the pre-seed has to happen between sandbox creation
 * and app launch (the fixture chain launches eagerly).
 */
import { test as base, _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');

// Standalone sandbox fixture — no auto-launched app, because the seed-then-
// launch ordering is the whole point of this test.
const test = base.extend<{ sandboxDir: string }>({
  sandboxDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tal-secrets-e2e-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
});

test('Settings renders recovery banner when secrets.json is corrupt at launch', async ({
  sandboxDir,
}) => {
  test.setTimeout(60_000);

  // 1. Pre-seed the sandbox userData with a malformed secrets.json
  const userDataDir = path.join(sandboxDir, 'userData');
  mkdirSync(userDataDir, { recursive: true });
  const secretsPath = path.join(userDataDir, 'secrets.json');
  writeFileSync(secretsPath, '{this is not valid json', 'utf-8');
  // Pre-seed the first-launch consent gate — same as fixtures.ts; the
  // blocking dialog would otherwise hide the status pill this test waits on.
  writeFileSync(
    path.join(userDataDir, 'consent.json'),
    JSON.stringify({ acceptedVersion: 1, timestamp: new Date().toISOString() }),
    'utf-8',
  );

  // 2. Launch Electron against this sandbox
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      TAL_SESSIONS_DB: path.join(sandboxDir, 'sessions.db'),
      VITE_DEV_SERVER_URL: '',
      TAL_QUIET: '1',
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Wait for engine handshake before driving the UI — the Settings page
    // calls availability on mount and we want the IPC bridge live.
    await expect(
      window.locator('[data-testid="status-pill-engine"]'),
    ).toHaveAttribute('data-state', 'ok', { timeout: 20_000 });

    // 3. Navigate to Settings via the canonical sidebar testid (matches
    //    `settings.spec.ts` — by-role times out because the sidebar uses
    //    icon-buttons whose accessible name is a single letter, not "settings").
    await window.locator('[data-testid="nav-settings"]').click();

    // 4. Banner asserts. The wording is "Encrypted secrets file recovered"
    //    + the backup path with a `.bak` suffix. We assert on the banner
    //    text rather than a testid because banners are sparse — a single
    //    text match is decisive without coupling to layout.
    const banner = window.getByText(/Encrypted secrets file recovered/i);
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('code')).toContainText('.bak');

    // 5. Settings did NOT blank — at least one tab button is rendered.
    //    Pre-Tier-2 the throw would have killed this section entirely.
    await expect(window.getByRole('button', { name: 'LLM Providers' })).toBeVisible();

    // 6. Disk state matches the recovery: a `.corrupt-*.bak` sibling
    //    holds the original bytes. We do NOT assert secrets.json exists
    //    yet — readFile returns an in-memory empty store after the rename
    //    and only writes back when the user adds a secret. The renamed
    //    backup is what proves the recovery code ran.
    const files = readdirSync(userDataDir);
    const backups = files.filter((f) => f.match(/^secrets\.json\.corrupt-.*\.bak$/));
    expect(backups, 'a .corrupt-*.bak backup must exist').toHaveLength(1);
    expect(existsSync(secretsPath), 'original corrupt file should be gone').toBe(false);
  } finally {
    try {
      await app.close();
    } catch {
      /* swallow */
    }
  }
});
