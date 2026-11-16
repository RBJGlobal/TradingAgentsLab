// Alpaca connection status for the two Alpaca rows in Settings, Data.
//
// The Key ID and the Secret are stored as two separate secrets, but whether
// Alpaca works is one fact about the pair. Before this module, each row showed
// "Connected" as soon as its own value was stored, even when Alpaca rejected
// the keys. Now the label comes from an actual check (POST /data/alpaca/test,
// one read-only request), and both rows show the same answer.
//
// Pure so it is unit tested; Settings owns the probe and passes the result in.

import type { AlpacaTestResult } from './engine-client';

/** Where the check is. `idle` = no check yet (or only one key stored). */
export type AlpacaProbeState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: AlpacaTestResult };

export type AlpacaPillVariant = 'success' | 'error' | 'warning' | 'optional';

export interface AlpacaStatus {
  /** Pill text shown on both Alpaca rows. */
  label: string;
  variant: AlpacaPillVariant;
  /** One sentence under the rows; null when the pill says enough. */
  detail: string | null;
}

/**
 * Status for the Alpaca pair, or null when neither key is stored (the rows
 * then keep their plain "Key ID" / "Secret" pills).
 */
export function alpacaStatus(
  hasKeyId: boolean,
  hasSecret: boolean,
  probe: AlpacaProbeState,
): AlpacaStatus | null {
  if (!hasKeyId && !hasSecret) return null;
  if (!hasKeyId || !hasSecret) {
    return {
      label: hasKeyId ? 'Needs Secret' : 'Needs Key ID',
      variant: 'warning',
      detail: 'Alpaca needs both the Key ID and the Secret. Paste the missing one below.',
    };
  }
  if (probe.phase !== 'done') {
    return { label: 'Checking…', variant: 'optional', detail: null };
  }
  const { result } = probe;
  switch (result.status) {
    case 'connected':
      return { label: 'Connected ✓', variant: 'success', detail: null };
    case 'rejected':
      return {
        label: 'Key rejected',
        variant: 'error',
        detail:
          `${result.detail} Analyses run without Alpaca data until this is fixed. ` +
          'Regenerate the key pair on the Alpaca dashboard and paste both values here.',
      };
    case 'missing':
      return {
        label: 'Needs both keys',
        variant: 'warning',
        detail: result.detail,
      };
    default:
      return {
        label: 'Not checked',
        variant: 'warning',
        detail: `${result.detail} The keys may still work. Use Check again to retry.`,
      };
  }
}
