export interface EngineHandshake {
  port: number;
  token: string;
}

export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'gemini'
  | 'xai'
  | 'minimax'
  | 'local';

/**
 * Auth shape on the WS start frame. Discriminated union so the engine
 * never has to guess whether `api_key` carries an API key or an OAuth
 * access token. OAuth is OpenAI-only today.
 *
 * `account_id` is required for the OAuth path — Codex backend uses it as
 * the `chatgpt-account-id` header. pi-ai returns it on the credential
 * blob as `accountId`; we forward it on the wire as `account_id` to keep
 * the engine's snake_case style consistent.
 */
export type ProviderAuth =
  | { type: 'api_key'; api_key: string }
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
      account_id?: string;
    }
  | {
      /** Local OpenAI-compatible runtime (Ollama, LM Studio, llama.cpp).
       * The `base_url` is what the OpenAI SDK accepts as `base_url=` —
       * e.g. `"http://localhost:11434/v1"`. No token; local runtimes
       * accept any non-empty Authorization header value. */
      type: 'local';
      base_url: string;
    };

export interface ProviderConfig {
  provider: LLMProvider;
  auth: ProviderAuth;
  model?: string;
  max_tokens?: number;
}

/** Canonical UI labels for each provider. Used in status cards + transcripts. */
export const PROVIDER_LABEL: Record<LLMProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  xai: 'xAI Grok',
  minimax: 'MiniMax',
  local: 'Local LLM',
};

/** Default model the engine assumes when ProviderConfig.model is not set.
 *
 * NOTE: OpenAI here is the API-key path (gpt-4o-mini against
 * `/v1/chat/completions`). The OAuth path routes through the Codex
 * backend at `chatgpt.com/backend-api`, which only accepts a different
 * model family — see OPENAI_CODEX_DEFAULT_MODEL.
 */
export const PROVIDER_DEFAULT_MODEL: Record<LLMProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  // xAI and MiniMax default to the current fast/cheap flagship. Must match
  // the engine's _DEFAULT_MODELS. grok-4.3 is xAI's current recommended model
  // (the old grok-4-fast-* IDs were deprecated 2026-05-15).
  xai: 'grok-4.3',
  minimax: 'MiniMax-M2.7-highspeed',
  // Local default is dynamic — the actual choice comes from the detected
  // runtime's model list. Empty string here forces the renderer to pick
  // a real model before submitting (the Analyze button disables when
  // local is selected and no model is stored).
  local: '',
};

/**
 * Default model when the OpenAI auth flow is OAuth (Codex). Subscription-
 * routed model availability differs from the API-tier list and even from
 * pi-ai's registry — both `gpt-4o-mini` AND `gpt-5.1-codex-mini` got
 * rejected with "not supported when using Codex with a ChatGPT account"
 * during founder smoke tests. `gpt-5.4` ("strong model for everyday
 * coding" per the official Codex model list) is the first entry on
 * Codex's own picker and should be reliably available across tiers.
 */
export const OPENAI_CODEX_DEFAULT_MODEL = 'gpt-5.4';

/** Per-provider model registry for the model picker. Each entry has an
 * id (sent to the engine), a display label, an optional `note` shown
 * inline, and a `recommended` flag for the suggested default.
 *
 * Curated to the 3-5 latest, non-legacy models per provider. Last
 * refreshed 2026-05-28: xAI lineup re-aligned to docs.x.ai (grok-4.3 +
 * grok-4.20-0309 family) after the grok-4-fast-* IDs were deprecated
 * 2026-05-15. gpt-5.5 / gemini-3.1-flash-lite GA verified current against
 * vendor docs. Refresh manually as providers ship new model families.
 */
export interface ModelChoice {
  id: string;
  label: string;
  note?: string;
  recommended?: boolean;
}

export const PROVIDER_MODELS: Record<LLMProvider, ModelChoice[]> = {
  openai: [
    { id: 'gpt-5.5',     label: 'gpt-5.5',      note: 'Latest frontier, 1M context' },
    { id: 'gpt-5',       label: 'gpt-5',        note: 'Previous frontier' },
    { id: 'gpt-5-mini',  label: 'gpt-5-mini',   note: 'Balanced, cost-effective' },
    { id: 'gpt-4o',      label: 'gpt-4o',       note: 'Multimodal flagship' },
    { id: 'gpt-4o-mini', label: 'gpt-4o-mini',  note: 'Cheapest', recommended: true },
  ],
  anthropic: [
    { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   note: 'Most capable' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: 'Balanced',  recommended: true },
    { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  note: 'Cheapest' },
  ],
  openrouter: [
    { id: 'openai/gpt-4o-mini',          label: 'OpenAI · gpt-4o-mini', note: 'Cheapest', recommended: true },
    { id: 'openai/gpt-5-mini',           label: 'OpenAI · gpt-5-mini',  note: 'Balanced' },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Anthropic · Sonnet 4.6' },
    { id: 'google/gemini-2.0-flash',     label: 'Google · Gemini 2.0 Flash' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        note: 'Most capable' },
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      note: 'Balanced' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'Most cost-efficient (GA)' },
    { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash',      note: 'Cheapest', recommended: true },
  ],
  xai: [
    { id: 'grok-4.3',                label: 'Grok 4.3',                  note: 'Current flagship, fastest', recommended: true },
    { id: 'grok-4.20-reasoning',     label: 'Grok 4.20 (reasoning)',     note: 'Reasoning-optimized' },
    { id: 'grok-4.20-non-reasoning', label: 'Grok 4.20 (non-reasoning)', note: 'Speed-optimized' },
  ],
  minimax: [
    { id: 'MiniMax-M2.7',           label: 'MiniMax M2.7',           note: 'Flagship, 204K context' },
    { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', note: 'Flagship speed (~100 TPS)', recommended: true },
    { id: 'MiniMax-M2.5',           label: 'MiniMax M2.5',           note: 'Previous-gen flagship' },
  ],
  // Local model list is empty here because it's populated dynamically
  // from the detected runtime's `/v1/models` response. `getAvailableModels`
  // special-cases this provider to return the renderer-side runtime
  // selection's models instead of consulting this static table.
  local: [],
};

/** OpenAI Codex (OAuth path) — list mirrors what the user's ChatGPT
 * Codex picker actually shows.
 *
 * Source: founder's own Codex picker (2026-05-09). Descriptions are
 * verbatim from the picker. Order matches founder's UI.
 *
 * Excluded: `gpt-5.4-pro` and `gpt-5.4-nano` (not on the picker — they
 * appear in pi-ai's general registry but Codex backend rejects them for
 * ChatGPT-account auth). Also excluded: `gpt-5.1-codex-mini` — picker
 * lists it but Codex returns 400 "not supported when using Codex with
 * a ChatGPT account" (verified 2026-05-09).
 *
 * Clawless Advisor flagged that codex-tuned variants (the *-codex,
 * *-codex-max, *-codex-mini family) are hit-or-miss across ChatGPT plan
 * tiers — they may work for the founder's plan but fail for free-tier
 * users. If any of these throws a 400, we demote/remove on a case-by-
 * case basis as the empirical data comes in.
 */
export const OPENAI_CODEX_MODELS: ModelChoice[] = [
  { id: 'gpt-5.4',           label: 'gpt-5.4',           note: 'Strong model for everyday coding', recommended: true },
  { id: 'gpt-5.2-codex',     label: 'gpt-5.2-codex',     note: 'Frontier agentic coding model' },
  { id: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max', note: 'Codex-optimized flagship for deep and fast reasoning' },
  { id: 'gpt-5.4-mini',      label: 'gpt-5.4-mini',      note: 'Small, fast, and cost-efficient model for simpler coding tasks' },
  { id: 'gpt-5.3-codex',     label: 'gpt-5.3-codex',     note: 'Coding-optimized model' },
  { id: 'gpt-5.2',           label: 'gpt-5.2',           note: 'Optimized for professional work and long-running agents' },
];

/** Returns the model list to show in the picker for a given provider +
 * OpenAI auth flow. The OAuth path picks from the Codex-specific list.
 *
 * For `provider === 'local'`, this returns an empty list — callers must
 * source the model list from the live runtime detection (the dynamic
 * model set is the user's locally-installed models, not a static table).
 * The Analyze page composes the local dropdown from the runtime's
 * detected models directly. */
export function getAvailableModels(
  provider: LLMProvider,
  authKind: 'oauth' | 'api_key' | 'local' | null,
): ModelChoice[] {
  if (provider === 'openai' && authKind === 'oauth') return OPENAI_CODEX_MODELS;
  return PROVIDER_MODELS[provider];
}

/** Returns the recommended model id for a provider + auth flow.
 *
 * For local, returns the empty string — the caller (Analyze page) is
 * responsible for falling back to the runtime's first detected model
 * when the user hasn't explicitly picked one. */
export function getRecommendedModel(
  provider: LLMProvider,
  authKind: 'oauth' | 'api_key' | 'local' | null,
): string {
  if (provider === 'local') return '';
  const list = getAvailableModels(provider, authKind);
  return (list.find((m) => m.recommended) ?? list[0]).id;
}

/** localStorage key for the user's saved model choice for a given
 * (provider, auth flow) tuple. Switching providers and back remembers
 * each provider's last manual choice independently. */
export function getModelStorageKey(
  provider: LLMProvider,
  authKind: 'oauth' | 'api_key' | 'local' | null,
): string {
  if (provider === 'openai' && authKind === 'oauth') {
    return 'tal:analyze:selected-model:openai-oauth';
  }
  return `tal:analyze:selected-model:${provider}`;
}

/**
 * Priority order when multiple keys are configured. First match wins.
 * Reordering here changes which provider runs the live debate; the
 * renderer surfaces the chosen one in the Analyze status card.
 */
export const PROVIDER_PRIORITY: readonly LLMProvider[] = [
  'openai',
  'anthropic',
  'openrouter',
  'gemini',
  'xai',
  'minimax',
  // Local last: when paid keys are present we default to those (better
  // analyst quality than most local models). User can still flip to
  // local via the Analyze "Run with" dropdown override. Reorder this
  // tuple if the project posture shifts toward local-first.
  'local',
];

export const PROVIDER_SECRET_KEY: Record<LLMProvider, string> = {
  openai: 'llm:openai',
  anthropic: 'llm:anthropic',
  openrouter: 'llm:openrouter',
  gemini: 'llm:gemini',
  xai: 'llm:xai',
  minimax: 'llm:minimax',
  // Local stores TWO secrets — base_url and model — because the runtime
  // identity is the (URL, model) pair. The "key" tracked here is the
  // base_url; the chosen model lives at `local:model`. Settings UI reads
  // both keys; isLocalConfigured() in lib/local-llm.ts checks both.
  local: 'local:base-url',
};

/** Companion secret key for the local provider's model selection. */
export const LOCAL_MODEL_SECRET_KEY = 'local:model';

/** Per-stream data provider override. When present on the WS start frame,
 * the engine instantiates the named provider for this debate's data fetches
 * (quote summary + news). When absent or malformed, the engine falls back
 * to its module-level yfinance default.
 *
 * Only "alpaca" is wired today. Engine hard-codes data.alpaca.markets — it
 * structurally cannot route to api.alpaca.markets, so even live keys can
 * never accidentally execute a trade through this path. */
export interface DataConfig {
  provider: 'alpaca';
  key_id: string;
  secret: string;
}

export interface AnalyzeRequest {
  ticker: string;
  trade_date: string;
  provider_config?: ProviderConfig;
  /** CostGuard reservation id from `reserveCostGuard()`. When present,
   * the engine skips its server-side auto-reserve. When absent on a live
   * debate, the engine auto-reserves with override=false and may block
   * with a `cost.blocked` event. */
  reservation_id?: string;
  /** Optional per-stream data provider override (e.g. Alpaca). Engine
   * falls through to yfinance default when absent. */
  data_config?: DataConfig;
  /** Webhook configs to fire after session.complete (Phase 8a). Engine
   * is stateless about webhooks; renderer sends the full list each
   * stream. Empty / undefined = no webhooks fire. */
  webhooks?: import('./webhooks').WebhookConfig[];
  /** Telegram chat_ids per webhook id, since chat_id isn't part of the
   * Bot API URL. {webhook_id: chat_id}. */
  telegram_chat_ids?: Record<string, string>;
}

export interface AnalyzeDecision {
  action: 'BUY' | 'SELL' | 'HOLD' | string;
  confidence: number;
  reasoning: string;
}

export interface SessionCompleteEvent {
  type: 'session.complete';
  ticker: string;
  trade_date: string;
  decision: AnalyzeDecision;
  /** True when the debate was generated by a live LLM. */
  live?: boolean;
  /** Provider id (one of LLMProvider). */
  provider?: LLMProvider;
  /** Model name used for a live debate. */
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number;
}

export type AssetClass = 'equity' | 'crypto';

export interface QuoteSummary {
  ticker: string;          // canonical display form (e.g. "NVDA" or "BTC/USD")
  trade_date: string;
  as_of: string;
  last_close: number;
  period_open: number;
  period_high: number;
  period_low: number;
  period_change_pct: number;
  avg_volume: number;
  sessions: number;
  source: string;
  /** "equity" or "crypto" — set by the engine based on ticker normalization. */
  asset_class?: AssetClass;
}

export interface Headline {
  title: string;
  publisher: string;
  pub_date: string;
  url: string;
  summary: string;
}

export interface NewsHeadlinesEvent {
  type: 'news.headlines';
  ticker: string;
  source: string;
  headlines: Headline[];
}

/** Engine emits this when a live debate's auto-reserve fails because caps
 * would be exceeded. Renderer surfaces it as a sessionError fallback in
 * case the pre-WS gate didn't catch it (e.g. older engine, race with
 * another window's run). Defensive — under normal flow the renderer
 * gate handles this before the WS opens. */
export interface CostBlockedEvent {
  type: 'cost.blocked';
  over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate';
  spend: { daily_usd: number; weekly_usd: number; monthly_usd: number; sessions_today: number };
  config: {
    enabled: boolean;
    cap_daily_usd: number;
    cap_weekly_usd: number;
    cap_monthly_usd: number;
    cap_sessions_per_day: number;
    updated_at: string;
  };
  est_cost_usd: number;
  message: string;
}

/** Running-total cost ticker emitted after every agent.message. `free=true`
 * marks OAuth subscription + local LLM runs which bill at $0 — the renderer
 * shows "subscription" / "on-device" rather than the cost number. */
export interface CostUsageEvent {
  type: 'cost.usage';
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
  free: boolean;
}

export type DebateEvent =
  | { type: 'session.start'; ticker: string; trade_date: string }
  | ({ type: 'data.summary' } & QuoteSummary)
  | NewsHeadlinesEvent
  | { type: 'agent.message'; agent: string; phase: string; content: string }
  | { type: 'phase.transition'; from: string; to: string }
  | CostUsageEvent
  | SessionCompleteEvent
  | CostBlockedEvent
  | import('./webhooks').WebhookReportEvent;

export interface StreamHandle {
  close(): void;
  done: Promise<void>;
}

let cachedHandshake: EngineHandshake | null = null;

/** Drop the cached port/token. Called when the engine exits so the next
 * handshake() re-fetches connection details from a freshly respawned engine,
 * rather than returning the dead port/token of the crashed one. */
export function invalidateHandshake(): void {
  cachedHandshake = null;
}

// Self-install the engine-exit listener once on module load. Main pushes
// `engine:exited` on an unexpected engine crash (see engine-runner.ts +
// preload `onEngineExited`); we drop the cache so the StatusStrip's next
// health poll re-fetches and lazily respawns the engine. Guarded for unit
// tests / any non-Electron context where the bridge is absent.
//
// A crash in the narrow window before this module loads delivers the event to
// nobody, but that's harmless: cachedHandshake is still empty then, so the
// first handshake() already re-fetches from a freshly respawned engine.
if (typeof window !== 'undefined' && window.tradingAgentsLab?.onEngineExited) {
  window.tradingAgentsLab.onEngineExited(() => invalidateHandshake());
}

export async function handshake(): Promise<EngineHandshake> {
  if (cachedHandshake) return cachedHandshake;
  if (!window.tradingAgentsLab?.getEngineHandshake) {
    throw new Error('engine bridge not available — preload not loaded');
  }
  const result = await window.tradingAgentsLab.getEngineHandshake();
  cachedHandshake = result;
  return result;
}

export async function getHandshake(): Promise<EngineHandshake> {
  return handshake();
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  uptime_seconds: number;
  engine_state: string;
  data_provider?: string;
  live_supported?: boolean;
  // Match what the engine actually emits (server.py /health): the list of
  // allowed providers and the per-provider default model map. (The old
  // singular `live_default_model` was a phantom field the engine never sent.)
  live_providers?: string[];
  live_default_models?: Record<string, string>;
  storage_path?: string;
}

export interface SessionSummary {
  id: string;
  ticker: string;
  trade_date: string;
  decision_action: string;
  decision_confidence: number;
  decision_reasoning: string;
  live: boolean;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  created_at: string;
}

export interface SessionDetail extends SessionSummary {
  events: DebateEvent[];
}

/** Default hard timeout for engine HTTP calls. The engine runs on
 * 127.0.0.1 so healthy latency is single-digit ms; this only exists to keep
 * a hung/blocked engine from freezing a button or view forever (e.g. the
 * Telegram "Starting…"/"Stopping…" state, or the StatusStrip health poll).
 * Callers that need a different budget pass `init.signal` and manage their
 * own AbortController — `fetchWithTimeout` then delegates untouched. */
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // Respect a caller-supplied abort signal (getSession / testLLMConnection
  // set their own timeouts + error messages); don't double-wrap.
  if (init.signal) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        /* keep full url if it doesn't parse */
      }
      throw new Error(`engine request ${path} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(): Promise<HealthInfo> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`/health failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as HealthInfo;
}

export async function listSessions(opts: { limit?: number; ticker?: string } = {}): Promise<SessionSummary[]> {
  const { port, token } = await handshake();
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.ticker) params.set('ticker', opts.ticker);
  const qs = params.toString();
  const url = `http://127.0.0.1:${port}/sessions${qs ? `?${qs}` : ''}`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`listSessions failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

/** Hard timeout for /sessions/{id}. Engine reads from local SQLite so
 * normal latency is ~ms; an 8s window covers cold-disk fetches without
 * letting a hung engine strand the History detail view indefinitely. */
const GET_SESSION_TIMEOUT_MS = 8000;

export async function getSession(id: string): Promise<SessionDetail> {
  const { port, token } = await handshake();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GET_SESSION_TIMEOUT_MS);
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      throw new Error(`getSession failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as SessionDetail;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `getSession timed out after ${GET_SESSION_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteSession(id: string): Promise<void> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new Error(`deleteSession failed: ${res.status} ${res.statusText}`);
  }
}

export interface WatchlistEntry {
  ticker: string;
  added_at: string;
  note: string | null;
}

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/watchlist`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`listWatchlist failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { watchlist: WatchlistEntry[] };
  return body.watchlist;
}

export async function addWatchlist(input: {
  ticker: string;
  note?: string;
}): Promise<WatchlistEntry> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/watchlist`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker: input.ticker, note: input.note ?? null }),
  });
  if (!res.ok) {
    if (res.status === 409) {
      throw new Error(`${input.ticker} is already on the watchlist`);
    }
    if (res.status === 400 || res.status === 422) {
      throw new Error(`Invalid ticker: ${input.ticker}`);
    }
    throw new Error(`addWatchlist failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as WatchlistEntry;
}

export async function removeWatchlist(ticker: string): Promise<void> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(
    `http://127.0.0.1:${port}/watchlist/${encodeURIComponent(ticker)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new Error(`removeWatchlist failed: ${res.status} ${res.statusText}`);
  }
}

/** Detected local LLM runtime + the models it exposes.
 *
 * `base_url` is what the OpenAI SDK accepts as `base_url=`. The engine
 * sends this exact string back; renderer ships it unchanged on the WS
 * start frame as `provider_config.auth.base_url`. */
export interface LocalRuntime {
  runtime: string;
  base_url: string;
  models: string[];
}

export interface LLMTestResult {
  ok: boolean;
  ms?: number;
  model?: string;
  error?: string;
}

/** 15s hard timeout for /llm/test. LLM APIs are slower than SQLite so
 * the cap is higher than getSession's 8s, but capped to prevent a
 * firewalled or rate-limited provider from leaving the Settings
 * "Testing…" spinner stuck forever with no recovery path. */
const LLM_TEST_TIMEOUT_MS = 15000;

/**
 * Issue a 1-token completion against the supplied API-key + provider to
 * validate the credentials. Skips CostGuard; under $0.0001 per call.
 *
 * The renderer only stores API keys (OAuth credentials live in main),
 * so this endpoint is API-key only. The OAuth row has its own status
 * indicator wired through `getOpenAIOAuthStatus()`.
 */
export async function testLLMConnection(args: {
  provider: Exclude<LLMProvider, 'local'>;
  apiKey: string;
  model?: string;
}): Promise<LLMTestResult> {
  const { port, token } = await handshake();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TEST_TIMEOUT_MS);
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/llm/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider_config: {
          provider: args.provider,
          auth: { type: 'api_key', api_key: args.apiKey },
          model: args.model,
          max_tokens: 1,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}` };
    }
    return (await res.json()) as LLMTestResult;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        error: `Test timed out after ${LLM_TEST_TIMEOUT_MS / 1000}s`,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Phase 8c: bidirectional Telegram bot ---------------------------------
//
// Engine owns the polling loop. Renderer ships the bot token + allowlist +
// daily cap + provider config on /telegram/start, calls /telegram/stop to
// halt, and polls /telegram/status for the running state shown in the
// Settings UI. The engine never persists the bot token; it lives only in
// memory until the next /telegram/start.

export interface TelegramPendingApproval {
  chat_id: number;
  first_name: string;
  username: string;
  first_seen: number; // epoch seconds
}

export interface TelegramBotStatus {
  enabled: boolean;
  polling: boolean;
  allowlist_size: number;
  last_update_id: number | null;
  last_error: string | null;
  daily_cap_usd: number;
  daily_spend_usd: Record<string, number>;
  pending_approvals: TelegramPendingApproval[];
}

export interface TelegramBotStartArgs {
  token: string;
  allowlist: number[];
  daily_cap_usd: number;
  provider_config?: Record<string, unknown>;
}

export async function getTelegramBotStatus(): Promise<TelegramBotStatus> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `getTelegramBotStatus failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as TelegramBotStatus;
}

export async function startTelegramBot(
  args: TelegramBotStartArgs,
): Promise<TelegramBotStatus> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`startTelegramBot failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as TelegramBotStatus;
}

export async function stopTelegramBot(): Promise<TelegramBotStatus> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `stopTelegramBot failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as TelegramBotStatus;
}

/** Move a pending chat_id into the live allowlist. The bot DMs the user
 * "you're approved" on success. 404 if there's no pending entry (already
 * approved, denied, or expired). */
export async function approveTelegramChat(
  chatId: number,
): Promise<TelegramBotStatus> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ chat_id: chatId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`approveTelegramChat failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as TelegramBotStatus;
}

/** Push fresh provider_config to a running bot. Used to keep OAuth
 * access tokens current; for API-key providers this is a no-op call
 * the renderer can simply skip. Returns 409 if the bot is not running;
 * the caller should treat that as a quiet skip, not an error to surface. */
export async function refreshTelegramBotCredentials(
  providerConfig: Record<string, unknown>,
): Promise<TelegramBotStatus | null> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/refresh-credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ provider_config: providerConfig }),
  });
  if (res.status === 409) {
    // Bot not running. Renderer should clear its refresh interval.
    return null;
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `refreshTelegramBotCredentials failed: ${res.status} ${detail}`,
    );
  }
  return (await res.json()) as TelegramBotStatus;
}

/** Drop a pending entry without DMing the user. */
export async function denyTelegramChat(
  chatId: number,
): Promise<TelegramBotStatus> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/telegram/deny`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ chat_id: chatId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`denyTelegramChat failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as TelegramBotStatus;
}

/** Probe localhost for running OpenAI-compatible LLM runtimes.
 *
 * Empty array is a normal response — it means the user has nothing
 * running. Settings UI surfaces that as "Not detected" with a manual-
 * entry fallback, not a failed fetch. */
export async function getLocalRuntimes(): Promise<LocalRuntime[]> {
  const { port, token } = await handshake();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/llm/local-runtimes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `getLocalRuntimes failed: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { runtimes: LocalRuntime[] };
  return body.runtimes;
}

export async function streamDebate(
  req: AnalyzeRequest,
  onEvent: (event: DebateEvent) => void,
  onError?: (err: unknown) => void,
): Promise<StreamHandle> {
  const { port, token } = await handshake();
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/stream?token=${encodeURIComponent(token)}`,
  );

  let resolveDone: () => void;
  let rejectDone: (err: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  ws.addEventListener('open', () => {
    // Send the start frame. provider_config is optional — when present, the
    // engine runs a real-LLM debate; when absent, it falls back to the canned
    // stub. Either way the wire shape downstream is the same.
    //
    // The `auth` field is a discriminated union {type: "api_key" | "oauth"}.
    // Engine accepts both the new shape and legacy {api_key: ...} top-level
    // for backward compat with older renderer builds.
    ws.send(
      JSON.stringify({
        ticker: req.ticker,
        trade_date: req.trade_date,
        provider_config: req.provider_config,
        reservation_id: req.reservation_id,
        data_config: req.data_config,
        webhooks: req.webhooks,
        telegram_chat_ids: req.telegram_chat_ids,
      }),
    );
  });

  ws.addEventListener('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.data as string) as DebateEvent;
      onEvent(parsed);
    } catch (err) {
      onError?.(err);
    }
  });

  ws.addEventListener('error', (event) => {
    onError?.(event);
  });

  ws.addEventListener('close', (event) => {
    if (event.code === 1000) {
      resolveDone();
    } else if (event.code === 1005) {
      // 1005 = no status received — treat as clean if server closed before
      // browser saw the close frame. Server explicitly sends 1000, so this
      // path is only hit on edge timing.
      resolveDone();
    } else {
      rejectDone(new Error(`stream closed with code ${event.code}: ${event.reason}`));
    }
  });

  return {
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
    done,
  };
}
