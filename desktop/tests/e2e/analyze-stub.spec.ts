/**
 * End-to-end stub debate.
 *
 * No provider config (no LLM key in the sandbox secrets), so the WS
 * stream runs the canned 17-event debate that ships with the engine.
 * Verifies the full UI critical path:
 *   - Analyze button enabled once engine ready
 *   - Click → button flips to Stop
 *   - Events stream → assessment card renders
 *   - Assessment card carries `data-stance="neutral"` (the stub always
 *     produces neutral@0.55)
 *   - History page lists the just-completed session (engine writes
 *     a row post-stream, sandboxed DB starts empty)
 */
import { test, expect } from './fixtures';

test('stub debate completes and persists to History', async ({ window }) => {
  await expect(
    window.locator('[data-testid="status-pill-engine"]'),
  ).toHaveAttribute('data-state', 'ok');

  // Ticker pre-fills with 'NVDA' on a fresh launch (no handoff).
  const tickerInput = window.locator('[data-testid="ticker-input"]');
  await expect(tickerInput).toHaveValue('NVDA');

  // Analyze. Button becomes Stop while streaming.
  await window.locator('[data-testid="analyze-button"]').click();
  await expect(window.locator('[data-testid="stop-button"]')).toBeVisible();

  // Assessment card appears once session.complete arrives. Stub always
  // produces neutral@55%. Bumping timeout to 30s for safety on slow CI
  // machines — typical local stub run is ~7s.
  const decisionCard = window.locator('[data-testid="decision-card"]');
  await expect(decisionCard).toBeVisible({ timeout: 30_000 });
  await expect(decisionCard).toHaveAttribute('data-stance', 'neutral');
  await expect(window.locator('[data-testid="decision-stance"]')).toHaveText('Neutral');

  // History should now have 1 row (sandbox started empty).
  await window.locator('[data-testid="nav-history"]').click();
  // The History list renders rows as <li class="row"> with ticker
  // markup; we don't have a per-row testid yet, so target the heading
  // text the row surfaces. Scope to the history page wrapper so we
  // don't accidentally match the Analyze ticker span (Analyze stays
  // mounted across navigation as of 2026-05-17 fix).
  await expect(
    window.locator('[data-testid="history-page"]').getByText('NVDA').first(),
  ).toBeVisible();
});
