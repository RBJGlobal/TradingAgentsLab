import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './Analyze.module.css';
import DebateStream from '../components/DebateStream';
import { CostGuardModal, type OverDimension } from '../components/CostGuardModal';
import {
  getHandshake,
  getHealth,
  type DebateEvent,
  type LLMProvider,
  type StreamHandle,
  getAvailableModels,
  getModelStorageKey,
  getRecommendedModel,
  type ModelChoice,
  PROVIDER_LABEL,
  PROVIDER_PRIORITY,
  PROVIDER_SECRET_KEY,
} from '../lib/engine-client';
import {
  type CostGuardConfig,
  type SpendState,
} from '../lib/cost-guard';
import { runAnalysis } from '../lib/run-analysis';
import { buildTranscriptMarkdown } from '../lib/transcript';
import { listSecrets } from '../lib/secrets';
import { consumePendingTicker } from '../lib/handoff';
import { loadLocalConfig, saveLocalConfig } from '../lib/local-llm';
import ProviderSetupCallout from '../components/ProviderSetupCallout';
import { getLocalRuntimes } from '../lib/engine-client';
import { getOpenAIOAuthStatus } from '../lib/oauth';

/** Persists the dropdown choice across app sessions (per founder, 2026-05-09). */
const SELECTED_PROVIDER_STORAGE_KEY = 'tal:analyze:selected-provider';

type EngineStatus = 'pending' | 'running' | 'error';

interface AnalyzeProps {
  /** Increments when the App menu fires "New analysis" — clears prior results. */
  resetSignal?: number;
}

function Analyze({ resetSignal = 0 }: AnalyzeProps) {
  // Honor a watchlist hand-off if one is queued in sessionStorage. Falls
  // back to the default NVDA when there isn't one. Since 2026-05-17 App.tsx
  // hides-not-unmounts pages (so an in-flight debate's WebSocket survives
  // navigation), the useState initializer only runs once at app start; the
  // hashchange effect below re-consumes the pending ticker on subsequent
  // navigations to #analyze.
  const [ticker, setTicker] = useState(() => consumePendingTicker() ?? 'NVDA');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('pending');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [dataProvider, setDataProvider] = useState<string | null>(null);
  /** Per-stream asset class set from the latest data.summary event. Used to
   * surface a "crypto" badge on the Data card so users can confirm the
   * engine routed to the crypto endpoint, not the equities one. */
  const [assetClass, setAssetClass] = useState<'equity' | 'crypto' | null>(null);
  const [events, setEvents] = useState<DebateEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Set of providers the user has configured (any auth flow). Drives both
   * the dropdown's enabled/disabled state and the priority resolver
   * fallback when no manual selection is saved.
   */
  const [configuredProviders, setConfiguredProviders] = useState<Set<LLMProvider>>(
    () => new Set(),
  );
  /**
   * The user's *manual* dropdown choice (persisted to localStorage). null
   * means "use the priority resolver" — the dropdown still pre-fills with
   * the resolver's pick so the user can see what's about to run.
   */
  const [manualProvider, setManualProvider] = useState<LLMProvider | null>(() => {
    try {
      const raw = localStorage.getItem(SELECTED_PROVIDER_STORAGE_KEY);
      if (raw && (PROVIDER_PRIORITY as readonly string[]).includes(raw)) {
        return raw as LLMProvider;
      }
    } catch {
      // localStorage can throw in private mode — fall through.
    }
    return null;
  });
  /**
   * Whether OpenAI auth resolves to OAuth (subscription plan) vs API key.
   * Internal to the OpenAI provider — OAuth wins when both are stored.
   * Surfaced in the LLM status hint so the founder can see which billing
   * path the next debate will hit when the active provider is OpenAI.
   */
  const [openaiAuthKind, setOpenaiAuthKind] = useState<'oauth' | 'api_key' | null>(null);

  /**
   * CostGuard override modal state. When `blocked` is non-null, the modal
   * is open and the user must Cancel or Override before the debate runs.
   * The Promise resolver lets the async onAnalyze flow await the user's
   * choice without resorting to event-based callback gymnastics.
   */
  const [costGuardBlocked, setCostGuardBlocked] = useState<{
    over_dimension: OverDimension;
    spend: SpendState;
    config: CostGuardConfig;
    est_cost_usd: number;
  } | null>(null);
  const costGuardResolverRef = useRef<((proceed: boolean) => void) | null>(null);

  /**
   * The provider that will actually run the next debate, after considering
   * (a) the user's manual dropdown choice and (b) the priority resolver.
   * Stays in sync with `configuredProviders` and `manualProvider` via
   * `useMemo` rather than living in its own state — single source of truth.
   */
  const activeProvider = useMemo<LLMProvider | null>(() => {
    if (manualProvider && configuredProviders.has(manualProvider)) {
      return manualProvider;
    }
    return (
      PROVIDER_PRIORITY.find((p) => configuredProviders.has(p)) ?? null
    );
  }, [manualProvider, configuredProviders]);

  // Ref mirrors of the resolution state. `onAnalyze` is async (multiple
  // awaits between mousedown and the WS open frame) — reading via refs
  // means a Settings-driven state change racing with a click can't leave
  // the request using a now-stale provider/auth combo. Same pattern as
  // `isStreamingRef`/`engineReadyRef` above.
  const activeProviderRef = useRef<LLMProvider | null>(null);
  const openaiAuthKindRef = useRef<'oauth' | 'api_key' | null>(null);
  useEffect(() => {
    activeProviderRef.current = activeProvider;
  }, [activeProvider]);
  useEffect(() => {
    openaiAuthKindRef.current = openaiAuthKind;
  }, [openaiAuthKind]);

  // Re-consume any watchlist hand-off when the user navigates BACK to
  // #analyze. Since the page stays mounted across nav (so an in-flight
  // debate's WS survives), the useState initialiser only runs once at
  // app start — this listener catches the hand-off on every subsequent
  // arrival.
  useEffect(() => {
    const onHashChange = () => {
      const route = window.location.hash.replace(/^#/, '');
      if (route === 'analyze') {
        const pending = consumePendingTicker();
        if (pending) setTicker(pending);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /**
   * Local LLM dynamic state. The model list is whatever the saved runtime
   * exposes right now — populated by probing `/llm/local-runtimes` and
   * filtering to the runtime whose base_url matches the saved config.
   * `localSavedBaseUrl` is the (URL) half of the saved pair so we know
   * which runtime to filter the detection result against and so we can
   * persist a new model choice back to safeStorage without re-loading.
   */
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localSavedBaseUrl, setLocalSavedBaseUrl] = useState<string | null>(null);
  const [localSavedModel, setLocalSavedModel] = useState<string | null>(null);

  /**
   * Available models for the current provider+auth combo. Recomputed
   * whenever the active provider, OpenAI auth flow, or local-runtime
   * model list changes. For local, the list is dynamic (per-runtime);
   * for everyone else it's the static `PROVIDER_MODELS` table.
   */
  const availableModels = useMemo(() => {
    if (!activeProvider) return [];
    if (activeProvider === 'local') {
      // Build ModelChoice entries from the detected runtime. If the
      // saved model isn't in the detected list (runtime offline or
      // model was uninstalled), prepend it so the dropdown still shows
      // the user's last choice — better than silently swapping models.
      const ids = new Set(localModels);
      const seed: ModelChoice[] = localSavedModel && !ids.has(localSavedModel)
        ? [{ id: localSavedModel, label: `${localSavedModel} (last used, runtime offline)` }]
        : [];
      const detected: ModelChoice[] = localModels.map((m) => ({ id: m, label: m }));
      return [...seed, ...detected];
    }
    return getAvailableModels(activeProvider, openaiAuthKind);
  }, [activeProvider, openaiAuthKind, localModels, localSavedModel]);

  /**
   * The model that will run the next debate. Pulls from per-(provider,auth)
   * localStorage memory if the user picked one before; falls back to the
   * recommended entry. Validates against the current available list — if
   * the saved id no longer exists in the registry (model deprecated), we
   * drop it and use the recommendation.
   */
  const [activeModel, setActiveModel] = useState<string | null>(null);

  // Resync the model selection whenever the (provider, authKind) tuple
  // changes. Reads from localStorage; falls back to recommended.
  //
  // For local: source-of-truth is safeStorage (`local:model`), not
  // localStorage — the same value the Settings "Active:" line shows.
  // We mirror it into `activeModel` so the dropdown initializes
  // correctly when switching to local.
  useEffect(() => {
    if (!activeProvider) {
      setActiveModel(null);
      return;
    }
    if (activeProvider === 'local') {
      // localSavedModel was just hydrated by the refreshLocal effect
      // above. If the saved model is in the live detected list, use
      // it; if not, still use it (the dropdown surfaces "runtime
      // offline" inline via the seed entry in `availableModels`).
      setActiveModel(localSavedModel ?? null);
      return;
    }
    const key = getModelStorageKey(activeProvider, openaiAuthKind);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      // ignore
    }
    const inList = saved && availableModels.some((m) => m.id === saved);
    setActiveModel(inList ? saved : getRecommendedModel(activeProvider, openaiAuthKind));
  }, [activeProvider, openaiAuthKind, availableModels, localSavedModel]);

  /** Ref mirror so onAnalyze sees the right model under racing state. */
  const activeModelRef = useRef<string | null>(null);
  useEffect(() => {
    activeModelRef.current = activeModel;
  }, [activeModel]);

  const onSelectModel = useCallback(
    (modelId: string) => {
      if (!activeProvider) return;
      setActiveModel(modelId);
      if (activeProvider === 'local') {
        // For local, the canonical store is safeStorage so the Settings
        // "Active:" line and the WS frame agree on the same model.
        // Write back immediately so a subsequent Analyze run picks it up
        // even before the refreshLocal effect re-fires.
        if (localSavedBaseUrl) {
          setLocalSavedModel(modelId);
          void saveLocalConfig({
            base_url: localSavedBaseUrl,
            model: modelId,
          }).catch(() => {
            // safeStorage offline — the activeModel state still reflects
            // the choice for the current session but persistence failed.
          });
        }
        return;
      }
      try {
        const key = getModelStorageKey(activeProvider, openaiAuthKind);
        localStorage.setItem(key, modelId);
      } catch {
        // ignore
      }
    },
    [activeProvider, openaiAuthKind, localSavedBaseUrl],
  );
  const handleRef = useRef<StreamHandle | null>(null);
  const isStreamingRef = useRef(false);
  const engineReadyRef = useRef(false);

  useEffect(() => {
    // Engine startup is racy — Vite renders the React app before the
    // Python sidecar has emitted its handshake JSON. Retry the
    // handshake + health check with backoff for up to ~10s before
    // surfacing 'error'. Without this, every fresh app launch shows
    // "Engine error" for a beat before flipping to 'running' — visually
    // alarming for a non-error state. Stays in 'pending' during retries.
    let cancelled = false;
    const ATTEMPTS = [0, 500, 1000, 1500, 2000, 3000, 3000]; // ~11s total
    const tryOnce = async (): Promise<void> => {
      await getHandshake();
      const health = await getHealth();
      if (cancelled) return;
      setEngineStatus('running');
      engineReadyRef.current = true;
      setEngineError(null);
      // Seed from /health (the engine's default — usually yfinance).
      // The data.summary event handler below overrides this per-debate
      // when the user has Alpaca configured.
      setDataProvider(health.data_provider ?? null);
    };

    (async () => {
      let lastErr: unknown = null;
      for (const delay of ATTEMPTS) {
        if (cancelled) return;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        try {
          await tryOnce();
          return; // success — done
        } catch (err) {
          lastErr = err;
        }
      }
      if (!cancelled) {
        setEngineStatus('error');
        engineReadyRef.current = false;
        setEngineError(
          lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reflect the actual data provider + asset class used per stream. The
  // engine emits source ("yfinance" | "alpaca") and asset_class ("equity"
  // | "crypto") on every data.summary event. The /health seed only knows
  // the engine's default provider; per-stream routing + asset class show up
  // here once the first data.summary arrives. Also dispatches a
  // window-level CustomEvent so the App-shell <StatusStrip> can reflect
  // per-stream changes without us having to lift state.
  //
  // While we're here, dispatch cost.usage + session.complete to the strip
  // so the Spend pill can tick mid-stream and re-poll the daily total the
  // instant a debate ends. The idx ref avoids re-firing the same event
  // when this effect re-runs on unrelated state changes.
  const lastDispatchedIdxRef = useRef(0);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.type === 'data.summary') {
        const src = (evt as { source?: string }).source;
        const ac = (evt as { asset_class?: 'equity' | 'crypto' }).asset_class;
        if (src && src !== dataProvider) setDataProvider(src);
        if (ac && ac !== assetClass) setAssetClass(ac);
        if (src) {
          window.dispatchEvent(
            new CustomEvent('tal:data-provider', {
              detail: { source: src, asset_class: ac },
            }),
          );
        }
        break;
      }
    }
    for (let i = lastDispatchedIdxRef.current; i < events.length; i++) {
      const evt = events[i];
      if (evt.type === 'cost.usage') {
        window.dispatchEvent(
          new CustomEvent('tal:cost-usage', {
            detail: { est_cost_usd: evt.est_cost_usd, free: evt.free },
          }),
        );
      } else if (evt.type === 'session.complete') {
        window.dispatchEvent(new CustomEvent('tal:session-complete'));
      }
    }
    lastDispatchedIdxRef.current = events.length;
  }, [events, dataProvider, assetClass]);

  // When the stream resets (new analysis), reset the dispatched-idx so the
  // first event of the next run isn't skipped.
  useEffect(() => {
    if (events.length === 0) lastDispatchedIdxRef.current = 0;
  }, [events.length]);

  // Reset state when the menu fires "New analysis".
  useEffect(() => {
    if (resetSignal === 0) return;
    handleRef.current?.close();
    setEvents([]);
    setStreamError(null);
    setCopied(false);
  }, [resetSignal]);

  // Re-poll secret presence + OAuth status whenever the page mounts, when
  // the user returns from Settings (resetSignal), and when a session ends.
  // The *only* meaningful transition for is-streaming is `true → false` —
  // skip the redundant call when streaming begins (the key set didn't
  // change). Updates `configuredProviders` (drives the dropdown) and
  // `openaiAuthKind` (drives the OAuth-vs-API-key hint).
  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [rows, oauth] = await Promise.all([
          listSecrets(),
          getOpenAIOAuthStatus().catch(() => ({ connected: false } as const)),
        ]);
        if (cancelled) return;
        const stored = new Set(rows.map((r) => r.key));
        const next = new Set<LLMProvider>();
        for (const p of PROVIDER_PRIORITY) {
          const hasKey = stored.has(PROVIDER_SECRET_KEY[p]);
          if (p === 'openai' && (oauth.connected || hasKey)) next.add(p);
          // Local needs BOTH base_url AND model — the secrets:list result
          // is keyed by individual entries, so we check both directly.
          else if (p === 'local' && stored.has(PROVIDER_SECRET_KEY.local) && stored.has('local:model')) next.add(p);
          else if (p !== 'openai' && p !== 'local' && hasKey) next.add(p);
        }
        setConfiguredProviders(next);
        // OAuth wins over API key when both are present (founder
        // preference). Surfaced when openai is the active provider.
        setOpenaiAuthKind(
          oauth.connected
            ? 'oauth'
            : stored.has(PROVIDER_SECRET_KEY.openai)
              ? 'api_key'
              : null,
        );
      } catch {
        if (!cancelled) {
          setConfiguredProviders(new Set());
          setOpenaiAuthKind(null);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [resetSignal, isStreaming]);

  // Refresh local runtime detection + saved-model state whenever the
  // Settings tab might have updated them. Probes /llm/local-runtimes and
  // filters to the saved base_url so the Analyze model dropdown shows
  // exactly the models for the user's chosen runtime. Empty list when
  // runtime is offline is the realistic state; we still seed the dropdown
  // with the saved model so the user can see what's about to run.
  useEffect(() => {
    if (isStreaming) return;
    if (!configuredProviders.has('local')) {
      setLocalModels([]);
      setLocalSavedBaseUrl(null);
      setLocalSavedModel(null);
      return;
    }
    let cancelled = false;
    const refreshLocal = async () => {
      try {
        const cfg = await loadLocalConfig();
        if (cancelled) return;
        if (!cfg) {
          setLocalSavedBaseUrl(null);
          setLocalSavedModel(null);
          setLocalModels([]);
          return;
        }
        setLocalSavedBaseUrl(cfg.base_url);
        setLocalSavedModel(cfg.model);
        // Probe the engine for the live model list. If the runtime is
        // offline this returns an empty array — the saved model is
        // surfaced via the seed in `availableModels`.
        const runtimes = await getLocalRuntimes().catch(() => []);
        if (cancelled) return;
        const match = runtimes.find((r) => r.base_url === cfg.base_url);
        setLocalModels(match?.models ?? []);
      } catch {
        if (!cancelled) {
          setLocalModels([]);
        }
      }
    };
    void refreshLocal();
    return () => {
      cancelled = true;
    };
  }, [resetSignal, isStreaming, configuredProviders]);

  // When the saved manual choice no longer has credentials (user deleted
  // the key in Settings), drop it so the priority resolver takes over.
  // localStorage stays in sync — a stale key shouldn't survive across
  // app launches once we know it's invalid.
  useEffect(() => {
    if (manualProvider && !configuredProviders.has(manualProvider)) {
      setManualProvider(null);
      try {
        localStorage.removeItem(SELECTED_PROVIDER_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, [manualProvider, configuredProviders]);

  const onSelectProvider = useCallback((value: LLMProvider | '') => {
    if (value === '') {
      // "Auto" sentinel — clear the manual override and let priority resolver win.
      setManualProvider(null);
      try {
        localStorage.removeItem(SELECTED_PROVIDER_STORAGE_KEY);
      } catch {
        // ignore
      }
      return;
    }
    setManualProvider(value);
    try {
      localStorage.setItem(SELECTED_PROVIDER_STORAGE_KEY, value);
    } catch {
      // ignore
    }
  }, []);

  /**
   * Reset BOTH provider and model overrides. Provider falls back to the
   * priority resolver; model falls back to the recommended entry for
   * whatever provider then resolves. Per-provider model memories in
   * localStorage are also cleared so "Reset" really means "give me the
   * recommended setup."
   *
   * Reads the current provider/auth via refs so the callback's identity
   * doesn't churn on every state change AND doesn't capture stale state
   * if the user changed providers between renders. Reset of `activeModel`
   * has to happen explicitly here — the sync effect at line ~132 only
   * re-fires when `[activeProvider, openaiAuthKind, availableModels]`
   * changes, so a model-only reset (provider unchanged) wouldn't trigger
   * it on its own.
   */
  const onResetOverrides = useCallback(() => {
    setManualProvider(null);
    try {
      localStorage.removeItem(SELECTED_PROVIDER_STORAGE_KEY);
      // Clear per-(provider,auth) model memories.
      for (const p of PROVIDER_PRIORITY) {
        localStorage.removeItem(getModelStorageKey(p, null));
        if (p === 'openai') {
          localStorage.removeItem(getModelStorageKey('openai', 'oauth'));
        }
      }
    } catch {
      // ignore
    }
    // Snap the in-memory model state back to the recommendation for the
    // currently-resolved provider so a model-only override clears
    // immediately (not only after the next provider/auth change).
    const provider = activeProviderRef.current;
    const authKind = openaiAuthKindRef.current;
    if (provider) {
      setActiveModel(getRecommendedModel(provider, authKind));
    } else {
      setActiveModel(null);
    }
  }, []);

  const onAnalyze = async () => {
    if (!engineReadyRef.current || isStreamingRef.current) return;
    setEvents([]);
    setStreamError(null);
    setCopied(false);
    // Reset asset class so the previous run's "crypto" badge doesn't bleed
    // into a new equity analysis (or vice versa) before the first
    // data.summary event arrives. dataProvider stays as-is — it's the
    // engine default until overridden.
    setAssetClass(null);
    isStreamingRef.current = true;
    setIsStreaming(true);

    // Snapshot the provider/auth/model at click-time through refs so a
    // Settings-tab state change racing with the multiple awaits inside
    // runAnalysis can't leave the request using a now-stale combo.
    const provider = activeProviderRef.current;
    const authKind = openaiAuthKindRef.current ?? 'api_key';
    const model =
      activeModelRef.current ??
      (provider ? getRecommendedModel(provider, authKind) : '');

    try {
      const result = await runAnalysis(
        {
          ticker,
          trade_date: date,
          provider,
          openaiAuthKind: authKind,
          model,
        },
        {
          onEvent: (event) => setEvents((prev) => [...prev, event]),
          onError: (err) => {
            setStreamError(err instanceof Error ? err.message : 'stream error');
          },
          // Open the existing CostGuard modal and await the user's choice.
          // Preserves the established UX where Cancel aborts and Override
          // re-tries the reservation with override=true (handled inside
          // runAnalysis).
          onCostBlocked: (block) =>
            new Promise<boolean>((resolve) => {
              costGuardResolverRef.current = resolve;
              setCostGuardBlocked({
                over_dimension: block.over_dimension,
                spend: block.spend,
                config: block.config,
                est_cost_usd: block.est_cost_usd,
              });
            }),
        },
      );

      if (result.kind === 'cancelled') {
        setStreamError(
          'Cost guard cap reached. Adjust caps in Settings or override at run time.',
        );
        return;
      }

      handleRef.current = result.handle;
      await result.handle.done;
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : 'stream failed');
    } finally {
      handleRef.current = null;
      isStreamingRef.current = false;
      setIsStreaming(false);
    }
  };

  const onStop = () => {
    handleRef.current?.close();
  };

  // Listen for the App menu "Stop streaming" command.
  useEffect(() => {
    const bridge = window.tradingAgentsLab;
    if (!bridge?.onMenuCommand) return;
    return bridge.onMenuCommand('menu:stop-stream', () => {
      handleRef.current?.close();
    });
  }, []);

  // Page-level keyboard shortcuts:
  //   Cmd/Ctrl + Enter → run analysis
  //   Cmd/Ctrl + .     → stop streaming
  // (Cmd+, for Settings + Cmd+1..3 for nav are handled by the App menu.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (engineReadyRef.current && !isStreamingRef.current) onAnalyze();
      } else if (e.key === '.') {
        e.preventDefault();
        handleRef.current?.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, date]);

  const onCopyTranscript = async () => {
    if (!events.length) return;
    const md = buildTranscriptMarkdown(events);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setStreamError(`copy failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  const buttonDisabled = engineStatus !== 'running' || isStreaming;
  const transcriptReady = events.some((e) => e.type === 'session.complete');

  const onCostGuardConfirm = useCallback(() => {
    setCostGuardBlocked(null);
    costGuardResolverRef.current?.(true);
    costGuardResolverRef.current = null;
  }, []);

  const onCostGuardCancel = useCallback(() => {
    setCostGuardBlocked(null);
    costGuardResolverRef.current?.(false);
    costGuardResolverRef.current = null;
  }, []);

  return (
    <div className={styles.page}>
      {costGuardBlocked && (
        <CostGuardModal
          overDimension={costGuardBlocked.over_dimension}
          spend={costGuardBlocked.spend}
          config={costGuardBlocked.config}
          estCostUsd={costGuardBlocked.est_cost_usd}
          onConfirm={onCostGuardConfirm}
          onCancel={onCostGuardCancel}
        />
      )}
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderTitleBlock}>
          <h1 className={styles.pageTitle}>Analyze</h1>
          <p className={styles.pageSubtitle}>
            Run <strong>the Diligence</strong> on a ticker — twelve AI agents
            (analyst, researcher, trader, risk-manager) deliberate from
            independent angles and converge on a recommendation. Educational
            research only; not investment advice.
          </p>
        </div>
        <div className={styles.pageHeaderProvider}>
          <label className={styles.providerLabel} htmlFor="run-with">
            Run with
          </label>
          <select
            id="run-with"
            className={styles.providerSelect}
            value={activeProvider ?? ''}
            onChange={(e) => onSelectProvider(e.target.value as LLMProvider | '')}
            disabled={isStreaming || engineStatus !== 'running'}
            data-testid="provider-select"
          >
            {PROVIDER_PRIORITY.map((p) => {
              const configured = configuredProviders.has(p);
              const isOpenAIOAuth = p === 'openai' && openaiAuthKind === 'oauth';
              const label = configured
                ? `${PROVIDER_LABEL[p]}${isOpenAIOAuth ? ' (OAuth)' : ''}`
                : `${PROVIDER_LABEL[p]} — configure in Settings`;
              return (
                <option key={p} value={p} disabled={!configured}>
                  {label}
                </option>
              );
            })}
            {configuredProviders.size === 0 && (
              <option value="" disabled>
                Stub debate — no LLM configured
              </option>
            )}
          </select>
          {activeProvider && availableModels.length > 0 && (
            <select
              className={styles.providerSelect}
              value={activeModel ?? ''}
              onChange={(e) => onSelectModel(e.target.value)}
              disabled={isStreaming || engineStatus !== 'running'}
              aria-label="Select model"
              data-testid="model-select"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? ' (recommended)' : ''}
                  {m.note ? ` — ${m.note}` : ''}
                </option>
              ))}
            </select>
          )}
          {(manualProvider ||
            (activeProvider &&
              activeModel !== null &&
              activeModel !== getRecommendedModel(activeProvider, openaiAuthKind))) && (
            <button
              type="button"
              className={styles.providerReset}
              onClick={onResetOverrides}
              disabled={isStreaming}
              title="Reset provider and model to recommended defaults"
              aria-label="Reset provider and model to recommended defaults"
            >
              Reset
            </button>
          )}
        </div>
      </header>

      {activeProvider === null && <ProviderSetupCallout />}

      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ticker">Ticker</label>
            <input
              id="ticker"
              className={styles.input}
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="NVDA"
              maxLength={8}
              disabled={isStreaming}
              data-testid="ticker-input"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="date">As-of date</label>
            <input
              id="date"
              type="date"
              className={styles.input}
              value={date}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setDate(e.target.value)}
              disabled={isStreaming}
              data-testid="date-input"
            />
          </div>
          <div className={styles.fieldButton}>
            {isStreaming ? (
              <button
                className={`${styles.button} ${styles.buttonStop}`}
                onClick={onStop}
                type="button"
                data-testid="stop-button"
              >
                Stop
              </button>
            ) : (
              <button
                className={styles.button}
                disabled={buttonDisabled}
                onClick={onAnalyze}
                type="button"
                data-testid="analyze-button"
              >
                Analyze
              </button>
            )}
          </div>
        </div>
        <div className={styles.cardFooter}>
          <p className={styles.helper}>
            {engineStatus === 'pending' && 'Engine starting, please wait — Python sidecar is coming online.'}
            {engineStatus === 'running' && !isStreaming && activeProvider && activeModel &&
              `Live debate — ${PROVIDER_LABEL[activeProvider]}${openaiAuthKind === 'oauth' && activeProvider === 'openai' ? ' (OAuth)' : ''} · ${activeModel}, capped per agent.`}
            {engineStatus === 'running' && !isStreaming && !activeProvider &&
              'Stub debate — paste an LLM key in Settings to switch to live agents.'}
            {engineStatus === 'running' && isStreaming &&
              'Streaming agent debate from sidecar — Stop to abort.'}
            {engineStatus === 'error' &&
              `Engine could not start after several retries: ${engineError ?? 'unknown error'}. Use the app menu (⏻ top right) to Restart.`}
          </p>
          {transcriptReady && !isStreaming && (
            <button
              className={styles.transcriptButton}
              onClick={onCopyTranscript}
              type="button"
            >
              {copied ? 'Copied ✓' : 'Copy transcript (Markdown)'}
            </button>
          )}
        </div>
        {streamError && (
          <p className={styles.errorBanner}>Stream error: {streamError}</p>
        )}
      </section>

      {/* Status cards used to live here; lifted to the App-shell `<StatusStrip>`
          so the user can glance up from any page (founder feedback 2026-05-09).
          The Analyze page surfaces engine error inline below the streamError
          banner when needed; everything else is on the strip. */}

      {engineStatus === 'error' && engineError && (
        <div className={styles.engineErrorBanner}>
          <strong>Engine error:</strong> {engineError}
        </div>
      )}

      <DebateStream events={events} isStreaming={isStreaming} />

      <section className={styles.disclaimer}>
        <strong>For educational and research purposes only.</strong> Trading
        Agents Lab is <strong>not a registered investment advisor</strong> and
        does not provide investment, financial, legal, or tax advice. The
        multi-agent LLM analyses on this page may be inaccurate, incomplete,
        or outdated — large language models can and do hallucinate. Nothing
        produced by this software is a recommendation to buy, sell, or hold
        any security, cryptocurrency, or other asset. Consult a qualified
        financial professional before making any investment decision. You
        assume all risk for any action you take based on this analysis. The
        maintainers and contributors accept no liability for losses arising
        from use of this software.
      </section>
    </div>
  );
}

export default Analyze;
