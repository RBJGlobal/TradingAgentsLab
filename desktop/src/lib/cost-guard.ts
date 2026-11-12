/**
 * Renderer-side client for the engine's CostGuard endpoints.
 *
 * Pattern: every call uses the same handshake() bearer token as
 * engine-client.ts. We keep this module separate so cost-guard concerns
 * don't leak into the analyze/stream module, which is already large.
 *
 * Errors:
 * - HTTP non-2xx → throws Error with status text
 * - 402 from /cost-guard/reserve → throws CostGuardBlocked with structured
 *   `detail` so the caller can populate the override modal
 */

import { handshake } from './engine-client';

// ---- Types ------------------------------------------------------------------

export interface CostGuardConfig {
  enabled: boolean;
  cap_daily_usd: number;
  cap_weekly_usd: number;
  cap_monthly_usd: number;
  cap_sessions_per_day: number;
  updated_at: string;
}

export interface SpendState {
  daily_usd: number;
  weekly_usd: number;
  monthly_usd: number;
  sessions_today: number;
}

export interface CostGuardStateResponse {
  spend: SpendState;
  config: CostGuardConfig;
}

export interface CostGuardCheckResult {
  allow: boolean;
  over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate' | null;
  override_available: boolean;
  current: SpendState;
  config: CostGuardConfig;
  est_reservation_usd: number;
}

export interface CostGuardReserveResult {
  reservation_id: string;
  est_cost_usd: number;
  expires_at: string;
  auth_kind: 'api_key' | 'oauth' | 'local';
  override: boolean;
}

export interface CostGuardConfigUpdate {
  enabled?: boolean;
  cap_daily_usd?: number;
  cap_weekly_usd?: number;
  cap_monthly_usd?: number;
  cap_sessions_per_day?: number;
}

export interface CostGuardCheckRequest {
  model: string;
  auth_kind: 'api_key' | 'oauth' | 'local';
  max_tokens: number;
  /** Lets the engine size the thinking allowance for reasoning models.
   * Optional: the engine infers it from the model id when absent. */
  provider?: string;
}

export interface CostGuardReserveRequest extends CostGuardCheckRequest {
  override?: boolean;
}

/** Returned in the WS `cost.blocked` event when the engine auto-reserve
 * fails. Structurally identical to the 402 detail body from /reserve. */
export interface CostGuardBlockedEvent {
  type: 'cost.blocked';
  over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate';
  spend: SpendState;
  config: CostGuardConfig;
  est_cost_usd: number;
  message: string;
}

// ---- Errors -----------------------------------------------------------------

export class CostGuardBlocked extends Error {
  readonly over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate';
  readonly spend: SpendState;
  readonly config: CostGuardConfig;
  readonly est_cost_usd: number;

  constructor(detail: {
    over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate';
    spend: SpendState;
    config: CostGuardConfig;
    est_cost_usd: number;
  }) {
    super(`cost guard blocked: ${detail.over_dimension} cap exceeded`);
    this.name = 'CostGuardBlocked';
    this.over_dimension = detail.over_dimension;
    this.spend = detail.spend;
    this.config = detail.config;
    this.est_cost_usd = detail.est_cost_usd;
  }
}

// ---- HTTP helpers -----------------------------------------------------------

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { port, token } = await handshake();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ---- Public API -------------------------------------------------------------

export async function getCostGuardState(): Promise<CostGuardStateResponse> {
  const res = await authFetch('/cost-guard/state');
  if (!res.ok) {
    throw new Error(`cost-guard state failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CostGuardStateResponse;
}

export async function updateCostGuardConfig(
  patch: CostGuardConfigUpdate,
): Promise<CostGuardConfig> {
  const res = await authFetch('/cost-guard/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`cost-guard update failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CostGuardConfig;
}

export async function checkCostGuard(
  req: CostGuardCheckRequest,
): Promise<CostGuardCheckResult> {
  const res = await authFetch('/cost-guard/check', {
    method: 'POST',
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`cost-guard check failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CostGuardCheckResult;
}

/**
 * Reserve a session quota slot. On a successful 200, returns the reservation
 * to attach to the WS start frame. On a 402, throws CostGuardBlocked with
 * the structured detail the modal needs.
 */
export async function reserveCostGuard(
  req: CostGuardReserveRequest,
): Promise<CostGuardReserveResult> {
  const res = await authFetch('/cost-guard/reserve', {
    method: 'POST',
    body: JSON.stringify(req),
  });
  if (res.status === 402) {
    const body = (await res.json()) as { detail: {
      error: string;
      over_dimension: 'daily' | 'weekly' | 'monthly' | 'rate';
      spend: SpendState;
      config: CostGuardConfig;
      est_cost_usd: number;
    } };
    throw new CostGuardBlocked(body.detail);
  }
  if (!res.ok) {
    throw new Error(`cost-guard reserve failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CostGuardReserveResult;
}
