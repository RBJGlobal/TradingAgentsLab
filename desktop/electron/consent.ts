/**
 * First-launch consent gate persistence (Phase 7c.3).
 *
 * Records that the user accepted the educational-use / not-financial-advice
 * agreement before using the app. This is non-secret state, so a plain JSON
 * file in userData (same family as window-state.json) rather than safeStorage.
 *
 * Versioned: bump CONSENT_VERSION whenever the agreement text MATERIALLY
 * changes, and every user is re-prompted on next launch. There is no account
 * and no signup — acceptance is local-only, consistent with the zero-data
 * posture (nothing about the user leaves the machine).
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the agreement copy materially changes -> everyone re-consents. */
export const CONSENT_VERSION = 1;

export interface ConsentRecord {
  acceptedVersion: number;
  timestamp: string;
}

function consentPath(): string {
  return path.join(app.getPath('userData'), 'consent.json');
}

/** The version the user last accepted, or null if never / unreadable. */
export function getAcceptedVersion(): number | null {
  try {
    const raw = fs.readFileSync(consentPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConsentRecord>;
    return typeof parsed.acceptedVersion === 'number'
      ? parsed.acceptedVersion
      : null;
  } catch {
    return null;
  }
}

/** True when the user has accepted the CURRENT agreement version. */
export function hasCurrentConsent(): boolean {
  return getAcceptedVersion() === CONSENT_VERSION;
}

/** Persist acceptance of the current agreement version. Best-effort + atomic. */
export function recordConsent(): ConsentRecord {
  const record: ConsentRecord = {
    acceptedVersion: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
  };
  try {
    const target = consentPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort: a failed write just means the user is re-prompted next launch.
  }
  return record;
}
