/**
 * e2e for the "ChatGPT sign-in expired" notice (2026-11-01).
 *
 * Seeds a fake (never-used) OpenAI OAuth credential plus an OpenAI API key
 * into the sandbox secrets file through the main process's safeStorage, then
 * marks the sign-in expired the same way Analyze does after a 401, and checks:
 *   1. Analyze shows the soft notice with Open Settings + Use API key.
 *   2. Settings shows the Expired pill and a Sign in again button.
 *   3. Use API key hides the notice and switches the run to the API key.
 * No network call is made: the fake token expires far in the future, so the
 * main process never tries to refresh it.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';

test('expired ChatGPT sign-in shows the notice and the recovery paths', async ({ app, window }) => {
  // Encrypt in the main process (safeStorage lives there), write from here.
  const oauth = JSON.stringify({
    access: 'test-access',
    refresh: 'test-refresh',
    expires: Date.now() + 24 * 3600 * 1000,
    email: 'test account',
  });
  const seeded = await app.evaluate(({ app: electronApp, safeStorage }, values) => {
    const enc = (v: string) => safeStorage.encryptString(v).toString('base64');
    return {
      userData: electronApp.getPath('userData'),
      oauthCipher: enc(values.oauth),
      keyCipher: enc(values.key),
    };
  }, { oauth, key: 'sk-test' });
  const now = new Date().toISOString();
  writeFileSync(
    path.join(seeded.userData, 'secrets.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'oauth:openai': { hint: '…', updatedAt: now, cipher: seeded.oauthCipher },
        'llm:openai': { hint: '…test', updatedAt: now, cipher: seeded.keyCipher },
      },
    }),
  );

  await window.evaluate(() => window.tradingAgentsLab.oauth.openaiMarkExpired());

  // Leave and come back so Analyze re-reads the sign-in status.
  await window.evaluate(() => {
    window.location.hash = '#settings';
  });
  await expect(window.getByTestId('oauth-reauth-required')).toBeVisible();
  await expect(window.getByTestId('oauth-sign-in-again')).toBeVisible();

  await window.evaluate(() => {
    window.location.hash = '#analyze';
  });
  const notice = window.getByTestId('oauth-expired-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Your ChatGPT sign-in has expired');
  await expect(window.getByTestId('oauth-expired-settings')).toBeVisible();

  await window.getByTestId('oauth-expired-use-api-key').click();
  await expect(notice).toBeHidden();
  // The OAuth-only model source line disappears once runs use the API key.
  await expect(window.getByTestId('codex-models-source')).toBeHidden();
});
