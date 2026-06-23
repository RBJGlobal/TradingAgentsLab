/**
 * Unit tests for the first-launch consent persistence (Phase 7c.3).
 * electron's `app.getPath` is mocked to a temp dir; real node:fs is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USERDATA = path.join(os.tmpdir(), 'tal-consent-test');

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
}));

import {
  CONSENT_VERSION,
  getAcceptedVersion,
  hasCurrentConsent,
  recordConsent,
} from '../../electron/consent';

const consentFile = path.join(USERDATA, 'consent.json');

describe('consent persistence', () => {
  beforeEach(() => fs.rmSync(USERDATA, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(USERDATA, { recursive: true, force: true }));

  it('reports no consent before anything is recorded', () => {
    expect(getAcceptedVersion()).toBeNull();
    expect(hasCurrentConsent()).toBe(false);
  });

  it('records and reads back the current agreement version', () => {
    const rec = recordConsent();
    expect(rec.acceptedVersion).toBe(CONSENT_VERSION);
    expect(rec.timestamp).toBeTruthy();
    expect(getAcceptedVersion()).toBe(CONSENT_VERSION);
    expect(hasCurrentConsent()).toBe(true);
  });

  it('treats an older accepted version as not-current (re-prompt on bump)', () => {
    fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(
      consentFile,
      JSON.stringify({ acceptedVersion: CONSENT_VERSION - 1, timestamp: 'x' }),
    );
    expect(getAcceptedVersion()).toBe(CONSENT_VERSION - 1);
    expect(hasCurrentConsent()).toBe(false);
  });

  it('fails safe (null, not throw) on a corrupt consent file', () => {
    fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(consentFile, '{ not valid json');
    expect(getAcceptedVersion()).toBeNull();
    expect(hasCurrentConsent()).toBe(false);
  });
});
