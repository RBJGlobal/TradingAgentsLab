/**
 * Live model list for the API-key providers (Anthropic, OpenAI with a key,
 * OpenRouter, Gemini, xAI).
 *
 * Providers ship new models far more often than we ship releases, so the
 * picker asks the engine (POST /llm/models) for the provider's own list. The
 * engine calls only that provider, with the key saved for it. This hook:
 *
 * - fetches ONLY for the provider that is active in the picker, and ONLY
 *   when a key is saved for it (the caller passes `enabled`); nothing runs
 *   for the other providers, and nothing runs on boot "just in case";
 * - remembers the last good live list per provider in localStorage;
 * - pins our curated entries that the provider still lists at the top
 *   ("Recommended"), then everything else ("All available"). OpenRouter
 *   returns hundreds of models, so the curated group keeps the picker usable.
 *
 * One deliberate difference from the OAuth (Codex) picker: this list's
 * first entry is NOT the default. Lists are sorted newest first, and the
 * newest model is often the most expensive one. The recommended model is
 * the curated `recommended` entry, then the engine's provider default.
 * Analyze also never swaps a saved model that is missing from the live list
 * (an alias vs dated id mismatch must not silently change a user's model or
 * cost); it keeps the saved one selectable instead.
 */

import { useMemo } from 'react';
import {
  getRecommendedModel,
  PROVIDER_MODELS,
  PROVIDER_SECRET_KEY,
  type LLMProvider,
  type ModelChoice,
  type ProviderConfig,
} from './engine-client';
import { getSecret } from './secrets';
import { useLiveModels, type LiveModelsSource } from './live-models';

/** Providers with live discovery. MiniMax keeps its curated list; the local
 * provider has its own runtime detection. Mirrors engine DISCOVERABLE. */
export const DISCOVERABLE_PROVIDERS: readonly LLMProvider[] = [
  'openai',
  'anthropic',
  'openrouter',
  'gemini',
  'xai',
];

export function hasLiveDiscovery(provider: LLMProvider | null): boolean {
  return provider !== null && DISCOVERABLE_PROVIDERS.includes(provider);
}

export function providerModelsCacheKey(provider: LLMProvider): string {
  return `tal:provider-models:v1:${provider}`;
}

/** Same normalization as the engine's `normalize_model_id`: a dated
 * snapshot (`claude-haiku-4-5-20251001`) or `-latest` alias is the same
 * model as the plain alias for matching purposes. */
export function normalizeModelId(id: string): string {
  let m = id.trim();
  if (m.endsWith('-latest')) m = m.slice(0, -'-latest'.length);
  return m.replace(/-\d{8}$/, '');
}

/**
 * Merge our curated list with the provider's live list.
 *
 * - "Recommended": curated entries the provider still lists (matched on the
 *   normalized id, so a dated live id still pins our alias entry). We show
 *   the curated entry (its alias id, label, note, recommended flag).
 * - "All available": every other live model, in provider order. A live id
 *   that is just a dated twin of a pinned entry is dropped as a duplicate.
 */
export function mergeWithCurated(
  curated: ModelChoice[],
  live: ModelChoice[],
): ModelChoice[] {
  const liveNorm = new Set(live.map((m) => normalizeModelId(m.id)));
  const pinned = curated
    .filter((c) => liveNorm.has(normalizeModelId(c.id)))
    .map((c) => ({ ...c, group: 'Recommended' as const }));
  const pinnedNorm = new Set(pinned.map((c) => normalizeModelId(c.id)));
  const rest = live
    .filter((m) => !pinnedNorm.has(normalizeModelId(m.id)))
    .map((m) => ({ ...m, recommended: false, group: 'All available' as const }));
  return [...pinned, ...rest];
}

/**
 * Make sure the user's saved model (and the recommended pick) stay
 * selectable even when the live list doesn't contain them. Returned entries
 * go first, ungrouped, so they are visible above a long live list.
 *
 * Why not auto-switch like the OAuth picker: on an API key every token is
 * billed. The live list can name a saved model differently (alias vs dated
 * id) or briefly omit it, and silently moving the user to another model
 * would change both what runs and what it costs.
 */
export function withSavedChoice(
  list: ModelChoice[],
  saved: string | null,
  recommendedId: string,
): ModelChoice[] {
  const ids = new Set(list.map((m) => m.id));
  const extras: ModelChoice[] = [];
  if (saved && !ids.has(saved)) {
    extras.push({ id: saved, label: `${saved} (your saved choice)` });
    ids.add(saved);
  }
  if (recommendedId && !ids.has(recommendedId)) {
    extras.push({ id: recommendedId, label: recommendedId });
  }
  return [...extras, ...list];
}

export interface ProviderModelsState {
  /** Picker entries. Grouped when the list is live (or cached live). */
  models: ModelChoice[];
  source: LiveModelsSource;
  loading: boolean;
  error: string | null;
  /** The model to use when the user has not picked one. */
  recommendedId: string;
  refresh: () => void;
}

/**
 * @param provider the active provider (null = nothing configured)
 * @param enabled true only when `provider` is active, uses an API key, and
 *   a key is saved for it. When false the hook makes no engine call.
 */
export function useProviderModels(
  provider: LLMProvider | null,
  enabled: boolean,
): ProviderModelsState {
  // A stable stand-in when there is no discoverable provider, so the shared
  // hook always has a key; `enabled` is false in that case anyway.
  const p: LLMProvider = provider && hasLiveDiscovery(provider) ? provider : 'anthropic';
  const curated = PROVIDER_MODELS[p];
  const live = useLiveModels({
    enabled: enabled && hasLiveDiscovery(provider),
    cacheKey: providerModelsCacheKey(p),
    fallback: curated,
    loadConfig: async (): Promise<ProviderConfig | null> => {
      const apiKey = await getSecret(PROVIDER_SECRET_KEY[p]);
      return apiKey ? { provider: p, auth: { type: 'api_key', api_key: apiKey } } : null;
    },
    missingConfigError: 'no API key saved',
    unavailableError: 'provider model list unavailable',
  });

  const models = useMemo(
    // Only a real provider list gets grouped. The built-in list IS the
    // curated list, so it is shown as-is.
    () => (live.source === 'fallback' ? live.models : mergeWithCurated(curated, live.models)),
    [live.source, live.models, curated],
  );

  const recommendedId = useMemo(() => {
    const curatedPick = models.find((m) => m.recommended)?.id;
    if (curatedPick) return curatedPick;
    if (live.engineDefault && models.some((m) => m.id === live.engineDefault)) {
      return live.engineDefault;
    }
    // Neither is in the live list: keep our curated recommendation anyway
    // (Analyze keeps it selectable). Never "first in list": that is the
    // newest and often the most expensive model.
    return getRecommendedModel(p, 'api_key');
  }, [models, live.engineDefault, p]);

  return {
    models,
    source: live.source,
    loading: live.loading,
    error: live.error,
    recommendedId,
    refresh: live.refresh,
  };
}
