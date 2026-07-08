/**
 * Settings page renders all tabs.
 *
 * Lightest smoke — just confirms the Settings shell mounts and each
 * tab heading is visible. Tab content (secret rows, OAuth flow) is
 * out of scope here; this catches the "Settings broke entirely"
 * regression class.
 */
import { test, expect } from './fixtures';

test('Settings tabs render', async ({ window }) => {
  await expect(
    window.locator('[data-testid="status-pill-engine"]'),
  ).toHaveAttribute('data-state', 'ok');

  await window.locator('[data-testid="nav-settings"]').click();

  // Each tab is a labeled button in the Settings sidebar. We assert by
  // visible text — testids on every tab button would be nice but the
  // current Settings.tsx renders them inline. Tab labels are stable
  // user-facing strings.
  for (const label of [
    'LLM Providers',
    'Data Providers',
    'Webhooks',
    'Cost Guard',
    'About',
  ]) {
    await expect(window.locator(`button:has-text("${label}")`).first()).toBeVisible();
  }
});
