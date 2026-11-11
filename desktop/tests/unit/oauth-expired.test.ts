import { describe, expect, it } from 'vitest';
import { isOAuthAuthFailure } from '../../src/lib/oauth';

describe('isOAuthAuthFailure', () => {
  it('flags the Codex 401 the engine raises for a dead sign-in', () => {
    expect(
      isOAuthAuthFailure(
        '[live debate error] RuntimeError: Codex 401: {"detail":"Could not parse your authentication token"}',
      ),
    ).toBe(true);
    expect(isOAuthAuthFailure('RuntimeError: Codex 401: Unauthorized')).toBe(true);
    expect(
      isOAuthAuthFailure("AuthenticationError: Error code: 401 - {'detail': 'Unauthorized'}"),
    ).toBe(true);
  });

  it('flags expired or invalid token wording', () => {
    expect(isOAuthAuthFailure('token_expired')).toBe(true);
    expect(isOAuthAuthFailure('invalid_token: refresh failed')).toBe(true);
  });

  it('ignores model, rate-limit and network errors', () => {
    expect(isOAuthAuthFailure('[live debate error] RuntimeError: Codex 404: model not found')).toBe(false);
    expect(isOAuthAuthFailure('[live debate error] RuntimeError: Codex 429: rate limited')).toBe(false);
    expect(isOAuthAuthFailure('Codex stream failed: ConnectError: timed out')).toBe(false);
    expect(isOAuthAuthFailure(null)).toBe(false);
  });
});
