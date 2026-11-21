// @vitest-environment happy-dom
//
// runAnalysis loads OpenRouter's catalog (prices + reasoning flags) before
// the Cost Guard reservation, so the reservation and the run read the same
// thinking allowance. A failed fetch never blocks the run.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const listProviderModels = vi.fn();
const reserveCostGuard = vi.fn();

vi.mock('../../src/lib/engine-client', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/engine-client')>()),
  streamDebate: async () => ({ close: () => {}, done: Promise.resolve() }),
  listProviderModels: (...a: unknown[]) => { order.push('catalog'); return listProviderModels(...a); },
}));
vi.mock('../../src/lib/cost-guard', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/cost-guard')>()),
  reserveCostGuard: (...a: unknown[]) => { order.push('reserve'); return reserveCostGuard(...a); },
}));
vi.mock('../../src/lib/secrets', () => ({
  getSecret: async (name: string) =>
    name === 'llm:openrouter' ? 'sk-or-test' : name === 'llm:anthropic' ? 'sk-ant-test' : null,
}));
vi.mock('../../src/lib/webhooks', () => ({ loadWebhooks: async () => [] }));

import { runAnalysis } from '../../src/lib/run-analysis';

beforeEach(() => {
  order.length = 0;
  listProviderModels.mockReset().mockResolvedValue({ ok: true, models: [] });
  reserveCostGuard.mockReset().mockResolvedValue({ reservation_id: 'r1' });
});

const go = (provider: 'openrouter' | 'anthropic', model: string) =>
  runAnalysis(
    { ticker: 'NVDA', trade_date: '2026-11-20', provider, openaiAuthKind: 'api_key', model },
    { onEvent: () => {} },
  );

describe('OpenRouter catalog before the reservation', () => {
  it('loads the catalog first', async () => {
    await go('openrouter', 'deepseek/deepseek-v4');
    expect(order).toEqual(['catalog', 'reserve']);
  });

  it('a failed fetch never blocks the run', async () => {
    listProviderModels.mockRejectedValue(new Error('offline'));
    await go('openrouter', 'deepseek/deepseek-v4');
    expect(reserveCostGuard).toHaveBeenCalledOnce();
  });

  it('other providers skip it', async () => {
    await go('anthropic', 'claude-haiku-4-5');
    expect(order).toEqual(['reserve']);
  });
});
