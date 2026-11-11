/**
 * Live model list for the OpenAI OAuth (Codex / ChatGPT-account) picker.
 *
 * OpenAI retires ChatGPT-sign-in models on its own schedule (the whole
 * gpt-5.x line was retired in 2026), so the picker must reflect what the
 * signed-in account can use TODAY rather than a list baked into the build.
 * This hook asks the engine (POST /llm/models -> OpenAI's Codex catalog) and
 * keeps the last good live list in localStorage so the picker is correct
 * instantly on the next launch, before the refetch lands. The shared
 * fetch/cache/retry machinery lives in lib/live-models.ts (the API-key
 * providers use it too, via lib/provider-models.ts).
 *
 * Order: cached live list (if any) -> built-in fallback, then replaced by the
 * fresh live list when it arrives. The first entry is marked recommended so
 * Analyze's existing "saved choice not in list -> use recommended" rule
 * automatically moves anyone off a retired model. (That auto-switch is
 * OAuth-only: Codex models cost the user nothing per token. The API-key
 * picker never auto-switches a saved model, see provider-models.ts.)
 */

import { useMemo } from 'react';
import {
  listCodexModels,
  OPENAI_CODEX_MODELS,
  type ModelChoice,
  type ProviderConfig,
} from './engine-client';
import { getOpenAICredentialsForRequest } from './oauth';
import { ENGINE_RETRY_DELAYS_MS, useLiveModels, type LiveModelsSource } from './live-models';

export { ENGINE_RETRY_DELAYS_MS };

const CACHE_KEY = 'tal:codex-models:v1';

export type CodexModelsSource = LiveModelsSource;

function withRecommended(models: ModelChoice[]): ModelChoice[] {
  return models.map((m, i) => ({ ...m, recommended: i === 0 }));
}

/** Build the same OAuth provider_config shape live runs send. */
async function oauthProviderConfig(): Promise<ProviderConfig | null> {
  const creds = await getOpenAICredentialsForRequest();
  if (!creds) return null;
  return {
    provider: 'openai',
    auth: {
      type: 'oauth',
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      account_id: creds.accountId,
    },
  };
}

export interface CodexModelsState {
  models: ModelChoice[];
  source: CodexModelsSource;
  loading: boolean;
  /** Why the live catalog is not in use (engine/OpenAI error), else null. */
  error: string | null;
  /** Re-query OpenAI's catalog, bypassing the engine's 15-minute cache. */
  refresh: () => void;
}

/**
 * @param enabled only fetch when the active provider is OpenAI via OAuth;
 *   when false the hook is inert and returns the cached/fallback list.
 */
export function useCodexModels(enabled: boolean): CodexModelsState {
  const live = useLiveModels({
    enabled,
    cacheKey: CACHE_KEY,
    fallback: OPENAI_CODEX_MODELS,
    loadConfig: oauthProviderConfig,
    missingConfigError: 'not signed in to ChatGPT',
    unavailableError: 'OpenAI catalog unavailable',
    fetchModels: listCodexModels,
  });
  const models = useMemo(() => withRecommended(live.models), [live.models]);
  return {
    models,
    source: live.source,
    loading: live.loading,
    error: live.error,
    refresh: live.refresh,
  };
}
