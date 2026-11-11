/**
 * Shared machinery for "show the provider's live model list" pickers.
 *
 * Two hooks build on this: `useCodexModels` (OpenAI via ChatGPT sign-in,
 * lib/codex-models.ts) and `useProviderModels` (API-key providers,
 * lib/provider-models.ts). Both follow the same pattern:
 *
 *   built-in list or last good live list (instant, from localStorage)
 *     -> engine POST /llm/models (live)
 *     -> replace the list, and remember it for the next launch.
 *
 * The renderer only ever calls the local engine (127.0.0.1). The engine is
 * the one that talks to the provider, and only to the provider the request
 * names. Nothing here runs unless the caller enables it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listProviderModels,
  type ModelChoice,
  type ModelsListResult,
  type ProviderConfig,
} from './engine-client';

/** Backoff while the engine is still starting (~30s total). Exported (and
 * re-exported by codex-models.ts) so tests can shrink it in place. */
export const ENGINE_RETRY_DELAYS_MS: number[] = [1000, 2000, 3000, 5000, 8000, 10000];

export type LiveModelsSource = 'live' | 'cached' | 'fallback';

export function readModelsCache(key: string): ModelChoice[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const ok = parsed.every(
      (m) => m && typeof m === 'object' && typeof (m as ModelChoice).id === 'string',
    );
    return ok ? (parsed as ModelChoice[]) : null;
  } catch {
    return null;
  }
}

function writeModelsCache(key: string, models: ModelChoice[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(models));
  } catch {
    /* storage unavailable: non-fatal, we just refetch next launch */
  }
}

export interface LiveModelsOptions {
  /** When false the hook is inert: no engine call, cached/fallback list only. */
  enabled: boolean;
  /** localStorage key for the last good LIVE list. One per provider. */
  cacheKey: string;
  /** Built-in list shown before anything else is known. */
  fallback: ModelChoice[];
  /** Builds the provider_config for the engine call; null = no credentials. */
  loadConfig: () => Promise<ProviderConfig | null>;
  /** Error shown when `loadConfig` returns null. */
  missingConfigError: string;
  /** Error shown when the engine falls back without saying why. */
  unavailableError: string;
  /** Override for tests; defaults to the engine call. */
  fetchModels?: (cfg: ProviderConfig, refresh: boolean) => Promise<ModelsListResult>;
}

export interface LiveModelsState {
  /** The raw list (live, cached live, or built-in), in provider order. */
  models: ModelChoice[];
  source: LiveModelsSource;
  loading: boolean;
  /** Why the live list is not in use (engine/provider error), else null. */
  error: string | null;
  /** The engine's `default` from the last answer, if any. */
  engineDefault: string | null;
  /** Re-query the provider, bypassing the engine's 15-minute cache. */
  refresh: () => void;
}

interface Snapshot {
  forKey: string;
  models: ModelChoice[];
  source: LiveModelsSource;
  loading: boolean;
  error: string | null;
  engineDefault: string | null;
}

function initialSnapshot(cacheKey: string, fallback: ModelChoice[]): Snapshot {
  const cached = readModelsCache(cacheKey);
  return {
    forKey: cacheKey,
    models: cached ?? fallback,
    source: cached ? 'cached' : 'fallback',
    loading: false,
    error: null,
    engineDefault: null,
  };
}

export function useLiveModels(opts: LiveModelsOptions): LiveModelsState {
  const { enabled, cacheKey, fallback } = opts;
  const [snap, setSnap] = useState<Snapshot>(() => initialSnapshot(cacheKey, fallback));
  const [nonce, setNonce] = useState(0);
  // The callbacks change identity every render; read them through a ref so
  // the fetch effect only re-runs on what matters (enabled, key, refresh).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Switching provider switches cache key: show that provider's own list
  // immediately (during this render), not the previous provider's.
  const view = snap.forKey === cacheKey ? snap : initialSnapshot(cacheKey, fallback);

  useEffect(() => {
    setSnap((prev) =>
      prev.forKey === cacheKey ? prev : initialSnapshot(cacheKey, optsRef.current.fallback),
    );
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const key = cacheKey;
    const update = (patch: Partial<Snapshot>) =>
      setSnap((prev) => ({
        ...(prev.forKey === key ? prev : initialSnapshot(key, optsRef.current.fallback)),
        ...patch,
        forKey: key,
      }));
    (async () => {
      const o = optsRef.current;
      const fetchModels = o.fetchModels ?? listProviderModels;
      update({ loading: true });
      try {
        const cfg = await o.loadConfig();
        if (cancelled) return;
        if (!cfg) {
          update({ error: o.missingConfigError });
          return;
        }
        // Analyze mounts at app launch, often a second or two before the
        // engine sidecar is listening, so the first call can fail with a
        // network error ("Failed to fetch"). Retry with backoff while the
        // ENGINE is unreachable (res.ok === false). An answer from the
        // engine (even a fallback because the provider refused) is final.
        const refresh = nonce > 0;
        let res = await fetchModels(cfg, refresh);
        for (const delayMs of ENGINE_RETRY_DELAYS_MS) {
          if (cancelled || res.ok) break;
          await new Promise((r) => setTimeout(r, delayMs));
          if (cancelled) return;
          res = await fetchModels(cfg, refresh);
        }
        if (cancelled) return;
        if (!res.ok || !res.models || res.models.length === 0) {
          // Keep whatever list we have, but say why it is not live.
          update({ error: res.error ?? 'model list unavailable' });
          return;
        }
        const live = res.source === 'live';
        update({
          models: res.models,
          source: live ? 'live' : 'fallback',
          error: live ? null : (res.error ?? o.unavailableError),
          engineDefault: res.default ?? null,
        });
        if (live) writeModelsCache(key, res.models);
      } finally {
        if (!cancelled) update({ loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, cacheKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    models: view.models,
    source: view.source,
    loading: view.loading,
    error: view.error,
    engineDefault: view.engineDefault,
    refresh,
  };
}
