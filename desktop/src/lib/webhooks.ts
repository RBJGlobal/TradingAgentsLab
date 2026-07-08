/**
 * Webhook config storage + types (Phase 8a).
 *
 * Where the config lives:
 * - Whole list is stored as a single JSON blob in safeStorage under the
 *   key `webhooks:configs`. The URLs and HMAC secrets in webhook configs
 *   are sensitive (Telegram/Discord URLs embed bot tokens), so
 *   safeStorage's OS-keychain encryption-at-rest is the right home.
 *   Storing per-webhook would multiply IPC round-trips with no benefit.
 *
 * What gets sent to the engine:
 * - The renderer attaches the entire configured list to the WS start
 *   frame on each analysis. Engine fires + emits `webhook.report`. No
 *   engine-side persistence — the engine is stateless about webhooks
 *   between sessions. Simplifies the contract; matches our data
 *   discipline (no cross-app telemetry hooks anywhere).
 *
 * Telegram chat_ids:
 * - chat_id isn't part of the Telegram bot-API URL (URL holds the bot
 *   token only). We carry it as a separate per-webhook field and pass
 *   {webhook_id: chat_id} alongside `webhooks` on the start frame.
 */

import type { Stance } from './engine-client';
import { getSecret, setSecret, deleteSecret } from './secrets';
import { normalizeStance } from './stance';

const STORAGE_KEY = 'webhooks:configs';

export type WebhookKind = 'generic' | 'slack' | 'discord' | 'telegram';

export interface WebhookFilter {
  /** Allowed stances. Empty array = fire on every stance. Configs saved
   * before the stance relabel carried `actions` (BUY/SELL/HOLD) +
   * `min_confidence`; loadWebhooks migrates them on read. */
  stances: Stance[];
  /** Inclusive floor on conviction (0..1). 0 = no floor. */
  min_conviction: number;
}

export interface WebhookConfig {
  id: string;
  name: string;
  /** Webhook URL. For Telegram this is the bot-API endpoint
   * (https://api.telegram.org/bot<TOKEN>/sendMessage); the token is in
   * the URL. For Slack/Discord this is the incoming-webhook URL from
   * those products' settings. For generic, anything HTTPS. */
  url: string;
  kind: WebhookKind;
  /** Telegram only — required for the Bot API to route the message.
   * Stored alongside the URL because chat_id isn't part of the URL. */
  telegram_chat_id?: string;
  /** Generic-only HMAC shared secret. Sent as `X-TAL-Signature:
   * sha256=<hex>`. Not used for Slack/Discord/Telegram (those use
   * URL-embedded auth). */
  secret?: string;
  filter: WebhookFilter;
}

export const KIND_LABEL: Record<WebhookKind, string> = {
  generic: 'Generic JSON',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
};

export const KIND_HINT: Record<WebhookKind, string> = {
  generic:
    'Full decision JSON. Sign optional via HMAC-SHA256 → X-TAL-Signature header.',
  slack: 'Slack incoming-webhook URL. Posts a short message to the channel.',
  discord: 'Discord webhook URL. Posts a short message to the channel.',
  telegram:
    'Telegram Bot API URL (with bot token). Requires a chat_id to route to.',
};

export function newWebhookId(): string {
  // Sortable + random — matches engine `storage._new_id` style.
  const ms = Date.now().toString(16).padStart(12, '0');
  const rand = crypto
    .getRandomValues(new Uint8Array(4))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  return `${ms}-${rand}`;
}

export function newWebhookFilter(): WebhookFilter {
  return { stances: [], min_conviction: 0 };
}

/** Migrate a filter saved before the stance relabel ({actions,
 * min_confidence} with BUY/SELL/HOLD values) to the stance shape.
 * Already-migrated filters pass through unchanged. */
function migrateFilter(f: Record<string, unknown>): WebhookFilter {
  const rawList = Array.isArray(f.stances)
    ? f.stances
    : Array.isArray(f.actions)
      ? f.actions
      : [];
  const floor = typeof f.min_conviction === 'number'
    ? f.min_conviction
    : typeof f.min_confidence === 'number'
      ? f.min_confidence
      : 0;
  return {
    stances: rawList.map((v) => normalizeStance(v)),
    min_conviction: floor,
  };
}

export async function loadWebhooks(): Promise<WebhookConfig[]> {
  const raw = await getSecret(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidConfig).map((c) => ({
      ...c,
      filter: migrateFilter(c.filter as unknown as Record<string, unknown>),
    }));
  } catch {
    return [];
  }
}

export async function saveWebhooks(configs: WebhookConfig[]): Promise<void> {
  if (configs.length === 0) {
    await deleteSecret(STORAGE_KEY);
    return;
  }
  await setSecret(STORAGE_KEY, JSON.stringify(configs));
}

function isValidConfig(c: unknown): c is WebhookConfig {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.url === 'string' &&
    typeof o.kind === 'string' &&
    ['generic', 'slack', 'discord', 'telegram'].includes(o.kind as string) &&
    typeof o.filter === 'object' &&
    o.filter !== null
  );
}

/** Per-receiver dispatch result echoed back via the `webhook.report` WS
 * event. Mirrors `WebhookResult.to_dict()` from engine/webhooks.py.
 * NEVER carries the URL — see engine/webhooks.py header. */
export interface WebhookResult {
  id: string;
  name: string;
  status: 'fired' | 'filtered' | 'failed';
  http_status?: number;
  error?: string;
}

export interface WebhookReportEvent {
  type: 'webhook.report';
  results: WebhookResult[];
}
