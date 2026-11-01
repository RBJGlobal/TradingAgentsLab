/**
 * Renderer-side wrapper for the OpenAI OAuth bridge exposed by preload.
 *
 * The renderer never holds the access/refresh tokens longer than necessary —
 * `getOpenAICredentialsForRequest()` is called just before building the WS
 * start frame, attaches the access token, and returns. Tokens never live in
 * React state.
 */

export interface OAuthStartResult {
  success: boolean;
  email?: string;
  error?: string;
}

export interface OAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;
  needsRefresh?: boolean;
  /** ChatGPT plan tier from the OAuth JWT — `"free"`, `"plus"`, `"pro"`,
   * `"team"`, `"enterprise"`, etc. `undefined` when JWT decode failed. */
  planType?: string;
  /** True when `planType === "free"`. Codex routing is unreliable on
   * free-tier accounts; UI surfaces a banner. */
  isFreeTier?: boolean;
  /** The saved sign-in no longer works; the user must sign in again. */
  reauthRequired?: boolean;
}

export interface OAuthProgressEvent { message: string }
export interface OAuthPromptEvent { message: string; placeholder?: string }

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  /** Required for the Codex backend's `chatgpt-account-id` header. */
  accountId?: string;
}

function bridge() {
  if (!window.tradingAgentsLab?.oauth) {
    throw new Error('oauth bridge not available — preload not loaded');
  }
  return window.tradingAgentsLab.oauth;
}

export function startOpenAIOAuthLogin(): Promise<OAuthStartResult> {
  return bridge().openaiStart();
}

export function getOpenAIOAuthStatus(): Promise<OAuthStatus> {
  return bridge().openaiStatus();
}

export function disconnectOpenAIOAuth(): Promise<boolean> {
  return bridge().openaiDisconnect();
}

/** Tell the main process a run failed because the sign-in is dead, so
 * Settings shows "sign in again" too. */
export function markOpenAIOAuthExpired(): Promise<void> {
  return bridge().openaiMarkExpired();
}

/**
 * True when an engine error text means the ChatGPT sign-in itself was
 * rejected (expired, revoked, or unparseable token), as opposed to a model
 * or network problem. The engine's Codex adapter raises "Codex <status>:
 * <body>" (Pro's full graph surfaces the OpenAI SDK's AuthenticationError
 * instead), and the error reaches the renderer inside an agent message
 * ("[live debate error] ...") or a Pro `run.error` event.
 */
export function isOAuthAuthFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /\bCodex 401\b/.test(text) ||
    // Pro's full graph calls Codex through the OpenAI SDK, which raises
    // "AuthenticationError: Error code: 401 - ...".
    /\bAuthenticationError\b|Error code: 401\b/.test(text) ||
    /authentication token|token[_ ]expired|invalid[_ ]token|refresh[_ ]token/i.test(text)
  );
}

export function submitOAuthPromptResponse(value: string): void {
  bridge().openaiPromptResponse(value);
}

/**
 * Fetch fresh credentials from the main process. The main-process service
 * silently refreshes if the cached access token is within a 60s window of
 * expiry. Used by `Analyze.tsx` immediately before calling `streamDebate`.
 */
export function getOpenAICredentialsForRequest(): Promise<OAuthCredentials | null> {
  return bridge().openaiCredentials();
}

export function onOAuthProgress(
  handler: (event: OAuthProgressEvent) => void,
): () => void {
  return bridge().onProgress(handler);
}

export function onOAuthPrompt(
  handler: (event: OAuthPromptEvent) => void,
): () => void {
  return bridge().onPrompt(handler);
}
