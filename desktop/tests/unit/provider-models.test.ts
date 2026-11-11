// @vitest-environment happy-dom
//
// useProviderModels + helpers: the API-key pickers show each provider's live
// model list, pin our curated entries, never default to "newest" (often the
// most expensive), never fetch without a saved key, and never drop a saved
// model just because the live list doesn't contain it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listProviderModels = vi.fn();
vi.mock('../../src/lib/engine-client', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/engine-client')>();
  return { ...actual, listProviderModels: (...a: unknown[]) => listProviderModels(...a) };
});
const getSecret = vi.fn();
vi.mock('../../src/lib/secrets', () => ({
  getSecret: (...a: unknown[]) => getSecret(...a),
}));

import { ENGINE_RETRY_DELAYS_MS } from '../../src/lib/live-models';
import {
  mergeWithCurated,
  normalizeModelId,
  providerModelsCacheKey,
  useProviderModels,
  withSavedChoice,
} from '../../src/lib/provider-models';
import { PROVIDER_MODELS, type LLMProvider } from '../../src/lib/engine-client';

const FAKE_KEY = 'sk-fake-test-key';

// Newest first, as the engine returns it. Includes a DATED twin of a curated
// alias (claude-haiku-4-5) and a brand-new model we have never curated.
const ANTHROPIC_LIVE = [
  { id: 'claude-mythos-1', label: 'Claude Mythos 1', note: '' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: '' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: '' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: '' },
];

const REAL_DELAYS = [...ENGINE_RETRY_DELAYS_MS];
beforeEach(() => {
  listProviderModels.mockReset();
  getSecret.mockReset();
  getSecret.mockResolvedValue(FAKE_KEY);
  localStorage.clear();
  ENGINE_RETRY_DELAYS_MS.splice(0, ENGINE_RETRY_DELAYS_MS.length, 1, 1, 1);
});
afterEach(() => {
  localStorage.clear();
  ENGINE_RETRY_DELAYS_MS.splice(0, ENGINE_RETRY_DELAYS_MS.length, ...REAL_DELAYS);
});

describe('normalizeModelId', () => {
  it('strips a dated snapshot and -latest, like the engine', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-sonnet-4-6-latest')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId('gpt-4o-2024-08-06')).toBe('gpt-4o-2024-08-06');
  });
});

describe('mergeWithCurated', () => {
  it('pins curated entries the provider still lists, then the rest', () => {
    const merged = mergeWithCurated(PROVIDER_MODELS.anthropic, ANTHROPIC_LIVE);
    const pinned = merged.filter((m) => m.group === 'Recommended').map((m) => m.id);
    const rest = merged.filter((m) => m.group === 'All available').map((m) => m.id);
    // Curated order; the dated live id pins our alias entry.
    expect(pinned).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
    // The dated twin is not listed again.
    expect(rest).toEqual(['claude-mythos-1']);
    expect(merged.find((m) => m.id === 'claude-sonnet-5-5')?.recommended).toBe(true);
    expect(merged.find((m) => m.id === 'claude-mythos-1')?.recommended).toBe(false);
  });
});

describe('withSavedChoice', () => {
  it('keeps a saved model the live list does not contain', () => {
    const out = withSavedChoice([{ id: 'a', label: 'A' }], 'claude-opus-4-7', 'a');
    expect(out.map((m) => m.id)).toEqual(['claude-opus-4-7', 'a']);
    expect(out[0].label).toContain('saved choice');
  });

  it('adds nothing when saved and recommended are both listed', () => {
    const list = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    expect(withSavedChoice(list, 'b', 'a')).toEqual(list);
  });

  it('keeps the recommended pick selectable if the provider stopped listing it', () => {
    const out = withSavedChoice([{ id: 'x', label: 'X' }], null, 'claude-sonnet-5-5');
    expect(out.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'x']);
  });
});

describe('useProviderModels', () => {
  it('is inert when disabled: no secret read, no engine call', async () => {
    renderHook(() => useProviderModels('anthropic', false));
    await new Promise((r) => setTimeout(r, 10));
    expect(getSecret).not.toHaveBeenCalled();
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it('never fetches for providers without discovery (minimax, local)', async () => {
    renderHook(() => useProviderModels('minimax', true));
    renderHook(() => useProviderModels('local', true));
    await new Promise((r) => setTimeout(r, 10));
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it('starts on the built-in list, then goes live with curated pins', async () => {
    listProviderModels.mockResolvedValue({
      ok: true, source: 'live', default: 'claude-haiku-4-5', models: ANTHROPIC_LIVE,
    });
    const { result } = renderHook(() => useProviderModels('anthropic', true));
    expect(result.current.models.map((m) => m.id)).toEqual(
      PROVIDER_MODELS.anthropic.map((m) => m.id),
    );
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.error).toBeNull();
    expect(result.current.models[0].group).toBe('Recommended');
    // Sends the API-key config for THIS provider only.
    expect(listProviderModels).toHaveBeenCalledWith(
      { provider: 'anthropic', auth: { type: 'api_key', api_key: FAKE_KEY } },
      false,
    );
  });

  it('recommends the curated pick, never the newest (first) model', async () => {
    listProviderModels.mockResolvedValue({
      ok: true, source: 'live', default: 'claude-haiku-4-5', models: ANTHROPIC_LIVE,
    });
    const { result } = renderHook(() => useProviderModels('anthropic', true));
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.recommendedId).toBe('claude-sonnet-5-5');
    expect(result.current.recommendedId).not.toBe('claude-mythos-1');
  });

  it('falls back to the engine default when the curated pick is not listed', async () => {
    listProviderModels.mockResolvedValue({
      ok: true, source: 'live', default: 'claude-haiku-4-5',
      models: [
        { id: 'claude-mythos-1', label: 'Mythos' },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
      ],
    });
    const { result } = renderHook(() => useProviderModels('anthropic', true));
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.recommendedId).toBe('claude-haiku-4-5');
  });

  it('does not call the engine when no key is saved', async () => {
    getSecret.mockResolvedValue(null);
    const { result } = renderHook(() => useProviderModels('openrouter', true));
    await waitFor(() => expect(result.current.error).toBe('no API key saved'));
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it('caches the live list per provider', async () => {
    listProviderModels.mockResolvedValue({ ok: true, source: 'live', models: ANTHROPIC_LIVE });
    const first = renderHook(() => useProviderModels('anthropic', true));
    await waitFor(() => expect(first.result.current.source).toBe('live'));
    expect(localStorage.getItem(providerModelsCacheKey('anthropic'))).toBeTruthy();
    expect(localStorage.getItem(providerModelsCacheKey('xai'))).toBeNull();

    listProviderModels.mockImplementation(() => new Promise(() => {})); // never resolves
    const second = renderHook(() => useProviderModels('anthropic', true));
    expect(second.result.current.source).toBe('cached');
    expect(second.result.current.models.some((m) => m.id === 'claude-mythos-1')).toBe(true);
  });

  it("switching provider shows that provider's own list immediately", async () => {
    listProviderModels.mockResolvedValue({ ok: true, source: 'live', models: ANTHROPIC_LIVE });
    const { result, rerender } = renderHook(
      ({ p }: { p: LLMProvider }) => useProviderModels(p, true),
      { initialProps: { p: 'anthropic' as LLMProvider } },
    );
    await waitFor(() => expect(result.current.source).toBe('live'));
    listProviderModels.mockImplementation(() => new Promise(() => {}));
    rerender({ p: 'xai' });
    expect(result.current.models.map((m) => m.id)).toEqual(PROVIDER_MODELS.xai.map((m) => m.id));
    expect(result.current.source).toBe('fallback');
  });

  it('shows the built-in list ungrouped and does not cache it on engine fallback', async () => {
    listProviderModels.mockResolvedValue({
      ok: true, source: 'fallback', models: PROVIDER_MODELS.gemini, error: 'key rejected (HTTP 401)',
    });
    const { result } = renderHook(() => useProviderModels('gemini', true));
    await waitFor(() => expect(result.current.error).toBe('key rejected (HTTP 401)'));
    expect(result.current.source).toBe('fallback');
    expect(result.current.models.every((m) => m.group === undefined)).toBe(true);
    expect(localStorage.getItem(providerModelsCacheKey('gemini'))).toBeNull();
  });
});
