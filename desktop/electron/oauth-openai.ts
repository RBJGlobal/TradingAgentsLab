/**
 * OpenAI OAuth (Codex / ChatGPT-subscription) service.
 *
 * The actual PKCE + browser callback + token exchange lives in the MIT-licensed
 * `@earendil-works/pi-ai` package (see NOTICE). This module is the Electron
 * adapter:
 *
 * - `startLogin()` opens the auth URL in the user's default browser, races
 *   the localhost callback against a 20-second manual-code-input fallback
 * - tokens (`{access, refresh, expires}` plus optional `email`) are stored
 *   as a single encrypted JSON blob via `safeStorage` under the secret key
 *   `oauth:openai`
 * - `getStatus()` decrypts and reports `{connected, email?, expiresAt?}`
 * - `disconnect()` removes the entry
 *
 * Renderer talks to this via `ipcMain` handlers (see `main.ts`) — never
 * directly via the `safeStorage` IPC, because OAuth tokens shouldn't be
 * fetched as a plain `secrets:get` (which returns the cipher-decrypted
 * string and exposes the JSON shape to the renderer).
 *
 * Pattern reference (Clawless Advisor, 2026-05-09): same shape Clawless
 * desktop uses, minus the OpenClaw-specific `auth-profiles.json` writer.
 */

import { shell } from 'electron';
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  type OAuthCredentials,
} from '@earendil-works/pi-ai/oauth';
import {
  deleteSecret,
  getSecret,
  isEncryptionAvailable,
  setSecret,
} from './secrets';

/** Storage key — single entry for the whole credential blob. */
export const OPENAI_OAUTH_SECRET_KEY = 'oauth:openai';

/** Window of safety before `expires` we treat as "needs refresh". */
const REFRESH_LEAD_MS = 60_000;

/** Manual-paste fallback timer if the localhost callback never arrives. */
const MANUAL_PASTE_FALLBACK_MS = 20_000;

export interface StoredOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;     // Unix timestamp; pi-ai docs are silent on s vs ms — we
                       // treat values >= 1e12 as ms and others as seconds.
  email?: string;
  /** Required by the Codex backend in the `chatgpt-account-id` header.
   * pi-ai returns this as `accountId` on OAuthCredentials. Without it,
   * Codex requests 401. */
  accountId?: string;
  /** ChatGPT plan tier extracted from the OAuth JWT
   * (`https://api.openai.com/auth.chatgpt_plan_type`). Examples:
   * `"free"`, `"plus"`, `"pro"`, `"team"`, `"enterprise"`. Codex routing
   * is unreliable on free-tier accounts (Clawless Advisor B34); we
   * surface a banner if this comes back as `"free"`. Unset when JWT
   * decode fails — treat that as "unknown, proceed normally." */
  planType?: string;
}

export interface OAuthStartResult {
  success: boolean;
  email?: string;
  error?: string;
}

export interface OAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;  // ms since epoch, normalized
  needsRefresh?: boolean;
  planType?: string;
  /** True when the OAuth JWT decoded `chatgpt_plan_type` to "free".
   * The Settings UI uses this to show a "Codex routing is unreliable
   * on free-tier accounts" banner. */
  isFreeTier?: boolean;
}

/** Renderer-facing event payloads (matches the preload bridge surface). */
export interface OAuthProgressEvent { message: string }
export interface OAuthPromptEvent { message: string; placeholder?: string }

type ProgressHandler = (event: OAuthProgressEvent) => void;
type PromptHandler = (event: OAuthPromptEvent) => void;

function normalizeExpiresMs(raw: number): number {
  // Heuristic: anything in seconds (1e9..1e12) → multiply; anything else → as-is.
  return raw >= 1e12 ? raw : raw * 1000;
}

/**
 * Decode an OAuth JWT and extract the ChatGPT plan tier from the
 * `https://api.openai.com/auth.chatgpt_plan_type` claim.
 *
 * Pattern from Clawless Advisor (B34): free-tier ChatGPT accounts hit
 * silent failures when issuing Codex requests with newer model variants.
 * Storing the plan tier alongside the credentials lets the UI surface a
 * "Codex routing is unreliable on free-tier accounts" warning before the
 * user wastes a session waiting for a hang.
 *
 * Defensive: returns `undefined` on any parse failure (malformed JWT,
 * missing claim, encoding error). The caller treats `undefined` as
 * "unknown plan tier, proceed normally" — never blocks login on this.
 */
function extractPlanType(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;
    // Base64URL → base64 (replace - with +, _ with /, pad to multiple of 4).
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
      [key: string]: unknown;
    };
    const auth = payload['https://api.openai.com/auth'] as
      | { chatgpt_plan_type?: unknown }
      | undefined;
    const planType = auth?.chatgpt_plan_type;
    return typeof planType === 'string' ? planType : undefined;
  } catch {
    return undefined;
  }
}

function loadStored(): StoredOAuthCredentials | null {
  try {
    const raw = getSecret(OPENAI_OAUTH_SECRET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredOAuthCredentials;
    if (!parsed.access || !parsed.refresh) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(credentials: StoredOAuthCredentials): void {
  setSecret(OPENAI_OAUTH_SECRET_KEY, JSON.stringify(credentials));
}

/** Map predictable failure modes to user-actionable messages. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use|1455/i.test(raw)) {
    return (
      'Port 1455 is in use — close any other OpenAI-account login windows ' +
      'and try again.'
    );
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return 'Authentication timed out. Please try again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(raw)) {
    return 'Network error reaching OpenAI. Check your internet connection.';
  }
  if (/cancel/i.test(raw)) {
    return 'Login cancelled.';
  }
  return raw;
}

/**
 * Holds the in-flight manual-paste resolver so the renderer can fulfil it
 * later via `handlePromptResponse`. Only one concurrent login is supported.
 */
let pendingPromptResolver: ((value: string) => void) | null = null;

/**
 * Per-login fallback timer + cleanup callback. pi-ai calls
 * `onManualCodeInput` unconditionally at flow start (not only when the
 * localhost callback fails), so we must cancel the 20s timer on EVERY
 * exit path or it fires post-login and stomps `pendingPromptResolver`,
 * wedging the next login attempt. See reviewer note B1.
 */
let activeFallbackCleanup: (() => void) | null = null;

/**
 * Refresh-token mutex — OpenAI may issue single-use refresh tokens and a
 * concurrent refresh would invalidate the first call's result, forcing
 * re-login. `refreshIfNeeded()` callers share the same in-flight Promise.
 * See reviewer note SR2.
 */
let refreshInFlight: Promise<StoredOAuthCredentials | null> | null = null;

export class OpenAIOAuthService {
  constructor(
    private readonly emitProgress: ProgressHandler,
    private readonly emitPrompt: PromptHandler,
  ) {}

  async startLogin(): Promise<OAuthStartResult> {
    if (!isEncryptionAvailable()) {
      return {
        success: false,
        error:
          'Encryption backend unavailable on this OS — refusing to store ' +
          'OAuth tokens in plaintext.',
      };
    }
    if (pendingPromptResolver) {
      return {
        success: false,
        error: 'Another OpenAI login is already in progress.',
      };
    }
    try {
      const credentials = await loginOpenAICodex({
        onAuth: ({ url, instructions }) => {
          // Open the user's default browser. shell.openExternal returns a
          // promise but we don't await — user will see the browser open
          // (or not) within a second or two.
          void shell.openExternal(url);
          this.emitProgress({
            message: instructions
              ? `Opening browser… ${instructions}`
              : 'Opening browser to complete sign-in…',
          });
        },
        onPrompt: async (prompt) => {
          // pi-ai falls back to this when the localhost callback hasn't
          // come back. Renderer shows a paste field; user pastes the URL
          // or code; we resolve with that string.
          this.emitPrompt({
            message: prompt.message,
            placeholder: prompt.placeholder,
          });
          return new Promise<string>((resolve) => {
            pendingPromptResolver = resolve;
          });
        },
        onProgress: (msg) => this.emitProgress({ message: msg }),
        onManualCodeInput: () =>
          new Promise<string>((resolve) => {
            // Race the browser callback with a 20s timer. If the callback
            // wins, the timer fires AFTER we've already returned credentials —
            // we must cancel it explicitly to avoid stomping
            // `pendingPromptResolver` post-login and wedging the next attempt
            // (reviewer B1).
            const timer = setTimeout(() => {
              this.emitPrompt({
                message:
                  'Browser callback not received. Paste the code from the ' +
                  'OpenAI page here:',
                placeholder: 'paste code',
              });
              pendingPromptResolver = resolve;
            }, MANUAL_PASTE_FALLBACK_MS);
            activeFallbackCleanup = () => {
              clearTimeout(timer);
            };
          }),
      });
      const stored = this.toStored(credentials);
      persist(stored);
      this.emitProgress({ message: 'Connected.' });
      return { success: true, email: stored.email };
    } catch (err) {
      pendingPromptResolver = null;
      return { success: false, error: friendlyError(err) };
    } finally {
      // Reset the pending resolver AND cancel the orphaned fallback timer.
      // Both are required — the timer's closure captures `resolve` and
      // would re-set `pendingPromptResolver` if it fired post-finally.
      activeFallbackCleanup?.();
      activeFallbackCleanup = null;
      pendingPromptResolver = null;
    }
  }

  /**
   * Resolve whichever in-flight Promise is waiting (manual paste, prompt
   * fallback, etc.). Renderer calls this when the user hits "Submit" on
   * the paste UI. No-op if nothing is waiting.
   */
  handlePromptResponse(value: string): void {
    const resolver = pendingPromptResolver;
    pendingPromptResolver = null;
    if (resolver) resolver(value);
  }

  getStatus(): OAuthStatus {
    if (!isEncryptionAvailable()) return { connected: false };
    const stored = loadStored();
    if (!stored) return { connected: false };
    const expiresMs = normalizeExpiresMs(stored.expires);
    const needsRefresh = Date.now() + REFRESH_LEAD_MS >= expiresMs;
    return {
      connected: true,
      email: stored.email,
      expiresAt: expiresMs,
      needsRefresh,
      planType: stored.planType,
      isFreeTier: stored.planType === 'free',
    };
  }

  /**
   * Refresh in place if the stored credentials are within
   * `REFRESH_LEAD_MS` of expiring; return the stored credentials
   * otherwise. Returns null when no credentials are stored.
   *
   * The renderer can call this just-before-debate to make sure the
   * Bearer token attached to the WS start frame won't expire mid-session.
   */
  async refreshIfNeeded(): Promise<StoredOAuthCredentials | null> {
    const stored = loadStored();
    if (!stored) return null;
    const expiresMs = normalizeExpiresMs(stored.expires);
    if (Date.now() + REFRESH_LEAD_MS < expiresMs) {
      return stored;
    }
    // Coalesce concurrent refresh attempts onto one in-flight Promise.
    // OpenAI's refresh tokens may be single-use, and two parallel refreshes
    // would race — one wins, the other 400s and forces re-login. Reviewer SR2.
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      try {
        const fresh = await refreshOpenAICodexToken(stored.refresh);
        const updated = this.toStored(fresh, stored.email);
        persist(updated);
        return updated;
      } catch (err) {
        // Refresh failure shouldn't drop the cached credentials — caller
        // (renderer) will get a 401 from OpenAI on the actual chat call,
        // which routes through the engine's adapter error path. We keep
        // what we have so the user can re-login manually.
        this.emitProgress({
          message: `Refresh failed: ${friendlyError(err)}`,
        });
        return stored;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  disconnect(): boolean {
    return deleteSecret(OPENAI_OAUTH_SECRET_KEY);
  }

  private toStored(
    credentials: OAuthCredentials,
    fallbackEmail?: string,
  ): StoredOAuthCredentials {
    // pi-ai's OAuthCredentials carries indexed extras; OpenAI Codex returns
    // `accountId` (UUID-shaped). There's no `email` from the OAuth flow
    // itself — we accept either if present and fall back to the previous
    // value on refresh.
    const extras = credentials as Record<string, unknown>;
    const accountId =
      typeof extras.accountId === 'string' ? (extras.accountId as string) : undefined;
    const email =
      typeof extras.email === 'string'
        ? (extras.email as string)
        : accountId
          ? `account ${accountId.slice(0, 8)}…`
          : fallbackEmail;
    // Decode plan tier from the JWT — best-effort, undefined on any parse
    // failure (we never block login on this).
    const planType = extractPlanType(credentials.access);
    return {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      email,
      accountId,
      planType,
    };
  }
}
