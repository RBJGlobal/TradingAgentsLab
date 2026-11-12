/**
 * Shared request-assembly + stream helper for analysis runs.
 *
 * Both single-ticker (Analyze page) and multi-ticker (Watchlist batch
 * runner) flows need the same provider resolution, Alpaca data config,
 * CostGuard reservation, and webhook attachment. Analyze.tsx still
 * inlines its own copy (refactor deferred to v1.1); BatchRunner uses
 * this. Keeping both means a single-purpose extraction that doesn't
 * destabilise the proven single-ticker path.
 *
 * The caller passes a cost-guard handler so this module never owns UI:
 * Analyze opens a modal, Batch can auto-cancel or prompt globally.
 */

import {
  PROVIDER_SECRET_KEY,
  streamDebate,
  type DebateEvent,
  type LLMProvider,
  type ProviderConfig,
  type StreamHandle,
} from './engine-client';
import {
  CostGuardBlocked,
  reserveCostGuard,
} from './cost-guard';
import { getSecret } from './secrets';
import { loadLocalConfig } from './local-llm';
import { getOpenAICredentialsForRequest } from './oauth';
import { loadWebhooks, type WebhookConfig } from './webhooks';

export interface RunAnalysisOptions {
  ticker: string;
  trade_date: string;
  /** Active LLM provider chosen by the caller (the priority resolver
   * + manual override happens upstream in the UI). Null → stub mode. */
  provider: LLMProvider | null;
  /** OpenAI-only: whether to prefer OAuth (subscription) over API key.
   * Ignored for other providers. */
  openaiAuthKind: 'oauth' | 'api_key';
  /** Pre-resolved model id (the UI knows the recommended-for-provider
   * default + user override). Empty string is acceptable for `local`,
   * where the model comes from the saved local-llm config. */
  model: string;
  /** Default 400 — same as Analyze.tsx. */
  maxTokens?: number;
}

export interface RunAnalysisCallbacks {
  /** Fires for every WS event from the engine. */
  onEvent: (event: DebateEvent) => void;
  /** Fires on stream-level errors. */
  onError?: (err: unknown) => void;
  /** Called when CostGuard blocks the reservation. Return `true` to
   * proceed with override, `false` to abort. If omitted, blocked
   * reservations propagate as a thrown CostGuardBlocked. */
  onCostBlocked?: (block: CostGuardBlocked) => Promise<boolean>;
}

export type RunAnalysisResult =
  | { kind: 'streaming'; handle: StreamHandle }
  | { kind: 'cancelled'; reason: 'cost_guard' };

/**
 * Build the request, optionally negotiate CostGuard, and open the WS.
 * Caller awaits `result.handle.done` for the streaming case.
 *
 * When `opts.provider` is null OR no credentials are stored for the
 * selected provider, providerConfig is left undefined and the engine
 * falls through to its stub debate path. The helper does NOT distinguish
 * this from a configured run on the return value — callers see the same
 * `{kind: 'streaming'}` either way. (Earlier drafts had a `no_provider`
 * variant; removed as dead code since the stub path is the right
 * fallback for both Analyze and BatchRunner.)
 *
 * Throws on unexpected errors (handshake failure, unrecognised CostGuard
 * error). Side effects beyond the WS open: dispatches a
 * `tal:session-complete` window event when the engine emits
 * `session.complete` so global subscribers (StatusStrip spend pill,
 * History page refresh) update in real time. Owning the dispatch here
 * means every caller of runAnalysis gets the same observable behaviour.
 */
export async function runAnalysis(
  opts: RunAnalysisOptions,
  callbacks: RunAnalysisCallbacks,
): Promise<RunAnalysisResult> {
  const maxTokens = opts.maxTokens ?? 400;
  const providerConfig = await resolveProviderConfig(opts, maxTokens);
  const dataConfig = await resolveDataConfig();

  let reservationId: string | undefined;
  if (providerConfig) {
    const cgModel = providerConfig.model ?? '';
    const reserveReq = {
      model: cgModel,
      auth_kind: providerConfig.auth.type,
      max_tokens: maxTokens,
      provider: providerConfig.provider,
    };
    try {
      const reservation = await reserveCostGuard(reserveReq);
      reservationId = reservation.reservation_id;
    } catch (err) {
      if (err instanceof CostGuardBlocked) {
        if (!callbacks.onCostBlocked) throw err;
        const proceed = await callbacks.onCostBlocked(err);
        if (!proceed) return { kind: 'cancelled', reason: 'cost_guard' };
        const reservation = await reserveCostGuard({
          ...reserveReq,
          override: true,
        });
        reservationId = reservation.reservation_id;
      } else {
        throw err;
      }
    }
  }

  const { webhookConfigs, telegramChatIds } = await loadWebhooksForStream();

  // Wrap the caller's onEvent so the global tal:session-complete signal
  // fires regardless of caller. StatusStrip's spend pill + History
  // refresh listen on this event; without it the spend pill stays stale
  // for up to 30s after session.complete (the StatusStrip's 30s poll
  // interval).
  const wrappedOnEvent = (event: DebateEvent) => {
    callbacks.onEvent(event);
    if (event.type === 'session.complete') {
      window.dispatchEvent(new CustomEvent('tal:session-complete'));
    }
  };

  const handle = await streamDebate(
    {
      ticker: opts.ticker,
      trade_date: opts.trade_date,
      provider_config: providerConfig,
      reservation_id: reservationId,
      data_config: dataConfig,
      webhooks: webhookConfigs.length > 0 ? webhookConfigs : undefined,
      telegram_chat_ids:
        Object.keys(telegramChatIds).length > 0 ? telegramChatIds : undefined,
    },
    wrappedOnEvent,
    callbacks.onError,
  );
  return { kind: 'streaming', handle };
}

async function resolveProviderConfig(
  opts: RunAnalysisOptions,
  maxTokens: number,
): Promise<ProviderConfig | undefined> {
  const { provider, openaiAuthKind, model } = opts;
  if (!provider) return undefined;

  try {
    if (provider === 'openai') {
      if (openaiAuthKind === 'oauth') {
        const creds = await getOpenAICredentialsForRequest();
        if (creds) {
          return {
            provider: 'openai',
            auth: {
              type: 'oauth',
              access: creds.access,
              refresh: creds.refresh,
              expires: creds.expires,
              account_id: creds.accountId,
            },
            model,
            max_tokens: maxTokens,
          };
        }
      }
      const apiKey = await getSecret(PROVIDER_SECRET_KEY.openai);
      if (apiKey) {
        return {
          provider: 'openai',
          auth: { type: 'api_key', api_key: apiKey },
          model,
          max_tokens: maxTokens,
        };
      }
      return undefined;
    }

    if (provider === 'local') {
      const localCfg = await loadLocalConfig();
      if (!localCfg) return undefined;
      return {
        provider: 'local',
        auth: { type: 'local', base_url: localCfg.base_url },
        model: localCfg.model,
        max_tokens: maxTokens,
      };
    }

    const apiKey = await getSecret(PROVIDER_SECRET_KEY[provider]);
    if (!apiKey) return undefined;
    return {
      provider,
      auth: { type: 'api_key', api_key: apiKey },
      model,
      max_tokens: maxTokens,
    };
  } catch {
    return undefined;
  }
}

async function resolveDataConfig(): Promise<
  { provider: 'alpaca'; key_id: string; secret: string } | undefined
> {
  try {
    const [keyId, secret] = await Promise.all([
      getSecret('data:alpaca-key-id'),
      getSecret('data:alpaca-secret'),
    ]);
    if (keyId && secret) {
      return { provider: 'alpaca', key_id: keyId, secret };
    }
  } catch {
    // safeStorage offline. Fall through to engine's yfinance default.
  }
  return undefined;
}

async function loadWebhooksForStream(): Promise<{
  webhookConfigs: WebhookConfig[];
  telegramChatIds: Record<string, string>;
}> {
  try {
    const configs = await loadWebhooks();
    const chatIds: Record<string, string> = {};
    for (const w of configs) {
      if (w.kind === 'telegram' && w.telegram_chat_id) {
        chatIds[w.id] = w.telegram_chat_id;
      }
    }
    return { webhookConfigs: configs, telegramChatIds: chatIds };
  } catch {
    return { webhookConfigs: [], telegramChatIds: {} };
  }
}
