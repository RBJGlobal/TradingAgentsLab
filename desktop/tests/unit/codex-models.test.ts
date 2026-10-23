// @vitest-environment happy-dom
//
// useCodexModels: the OAuth (Codex) picker must show what the ChatGPT account
// can use today, not a list baked into the build. Covers fallback-first,
// swap-to-live, persisting the live list, inert when not on OAuth, and
// keeping the current list when the engine call fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listCodexModels = vi.fn();
vi.mock('../../src/lib/engine-client', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/engine-client')>();
  return { ...actual, listCodexModels: (...a: unknown[]) => listCodexModels(...a) };
});
vi.mock('../../src/lib/oauth', () => ({
  getOpenAICredentialsForRequest: vi.fn(async () => ({
    access: 'tok', refresh: 'r', expires: 9_999_999_999_999, accountId: 'acct-1',
  })),
}));

import { ENGINE_RETRY_DELAYS_MS, useCodexModels } from '../../src/lib/codex-models';
import { OPENAI_CODEX_MODELS } from '../../src/lib/engine-client';

const LIVE = [
  { id: 'gpt-7-nova', label: 'GPT-7 Nova', note: 'new' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: '' },
];

const REAL_DELAYS = [...ENGINE_RETRY_DELAYS_MS];
beforeEach(() => {
  listCodexModels.mockReset();
  localStorage.clear();
  // Keep the startup-retry behavior but make it instant for tests.
  ENGINE_RETRY_DELAYS_MS.splice(0, ENGINE_RETRY_DELAYS_MS.length, 1, 1, 1);
});
afterEach(() => {
  localStorage.clear();
  ENGINE_RETRY_DELAYS_MS.splice(0, ENGINE_RETRY_DELAYS_MS.length, ...REAL_DELAYS);
});

describe('useCodexModels', () => {
  it('starts on the built-in fallback, then swaps to the live catalog', async () => {
    listCodexModels.mockResolvedValue({ ok: true, source: 'live', default: 'gpt-7-nova', models: LIVE });
    const { result } = renderHook(() => useCodexModels(true));

    expect(result.current.models.map((m) => m.id)).toEqual(OPENAI_CODEX_MODELS.map((m) => m.id));
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.error).toBeNull();
    expect(result.current.models.map((m) => m.id)).toEqual(['gpt-7-nova', 'gpt-6.1-sol']);
    // First live entry becomes the recommended default.
    expect(result.current.models[0].recommended).toBe(true);
    expect(result.current.models[1].recommended).toBe(false);
  });

  it('persists the live list so the next launch is correct immediately', async () => {
    listCodexModels.mockResolvedValue({ ok: true, source: 'live', models: LIVE });
    const first = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(first.result.current.source).toBe('live'));

    listCodexModels.mockImplementation(() => new Promise(() => {})); // never resolves
    const second = renderHook(() => useCodexModels(true));
    expect(second.result.current.source).toBe('cached');
    expect(second.result.current.models[0].id).toBe('gpt-7-nova');
  });

  it('is inert when OpenAI OAuth is not the active provider', async () => {
    renderHook(() => useCodexModels(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(listCodexModels).not.toHaveBeenCalled();
  });

  it('keeps the current list when the engine call fails', async () => {
    listCodexModels.mockResolvedValue({ ok: false, error: 'engine down' });
    const { result } = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.map((m) => m.id)).toEqual(OPENAI_CODEX_MODELS.map((m) => m.id));
    expect(result.current.error).toBe('engine down');
  });

  it('retries while the engine is still starting, then goes live', async () => {
    // The founder's real case: first call at app launch fails to reach the
    // engine ("Failed to fetch"); a later attempt succeeds.
    listCodexModels
      .mockResolvedValueOnce({ ok: false, error: 'Failed to fetch' })
      .mockResolvedValueOnce({ ok: false, error: 'Failed to fetch' })
      .mockResolvedValue({ ok: true, source: 'live', models: LIVE });
    const { result } = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.error).toBeNull();
    expect(listCodexModels).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the engine answered with a fallback', async () => {
    listCodexModels.mockResolvedValue({ ok: true, source: 'fallback', models: LIVE, error: 'catalog HTTP 403' });
    const { result } = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(result.current.source).toBe('fallback'));
    expect(listCodexModels).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('catalog HTTP 403');
  });

  it('does not persist a fallback list as if it were live', async () => {
    listCodexModels.mockResolvedValue({ ok: true, source: 'fallback', models: LIVE });
    const { result } = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(result.current.source).toBe('fallback'));
    expect(localStorage.getItem('tal:codex-models:v1')).toBeNull();
    // The reason must surface so the UI never shows a fallback as success.
    expect(result.current.error).toBeTruthy();
  });
});
