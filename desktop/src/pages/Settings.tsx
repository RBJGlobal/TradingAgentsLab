import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './Settings.module.css';
import UpdatesSection from '../components/UpdatesSection';
import {
  deleteSecret,
  getAvailability,
  getSecret,
  listSecrets,
  onSecretsRecovered,
  setSecret,
  type CorruptionRecovery,
  type SecretListing,
  type SecretsAvailability,
} from '../lib/secrets';
import {
  disconnectOpenAIOAuth,
  getOpenAICredentialsForRequest,
  getOpenAIOAuthStatus,
  onOAuthProgress,
  onOAuthPrompt,
  startOpenAIOAuthLogin,
  submitOAuthPromptResponse,
  type OAuthStatus,
} from '../lib/oauth';
import {
  getCostGuardState,
  updateCostGuardConfig,
  type CostGuardConfig,
  type SpendState,
} from '../lib/cost-guard';
import {
  approveTelegramChat,
  denyTelegramChat,
  getLocalRuntimes,
  getTelegramBotStatus,
  LOCAL_MODEL_SECRET_KEY,
  OPENAI_CODEX_DEFAULT_MODEL,
  PROVIDER_SECRET_KEY,
  refreshTelegramBotCredentials,
  startTelegramBot,
  stopTelegramBot,
  testLLMConnection,
  type LLMProvider,
  type LLMTestResult,
  type LocalRuntime,
  type TelegramBotStatus,
  type TelegramPendingApproval,
} from '../lib/engine-client';
import {
  loadLocalConfig,
  saveLocalConfig,
  type LocalLLMConfig,
} from '../lib/local-llm';
import {
  loadWebhooks,
  saveWebhooks,
  newWebhookId,
  newWebhookFilter,
  KIND_LABEL,
  KIND_HINT,
  type WebhookConfig,
  type WebhookKind,
} from '../lib/webhooks';

type Tab =
  | 'llm'
  | 'data'
  | 'webhooks'
  | 'channels'
  | 'clawless'
  | 'costguard'
  | 'about';

interface TabDef {
  id: Tab;
  label: string;
  description: string;
}

const TABS: TabDef[] = [
  {
    id: 'llm',
    label: 'LLM Providers',
    description:
      'Bring your own API key, sign in with OpenAI OAuth, or auto-detect a local runtime (Ollama / LM Studio). Anthropic API key only (OAuth is banned by their TOS).',
  },
  {
    id: 'data',
    label: 'Data Providers',
    description:
      'Where market data comes from. yfinance is the free default, no key required. Optionally connect Alpaca Markets for higher-quality real-time data.',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    description:
      'Push the decision to Telegram, Slack, Discord, or any HTTPS endpoint when a debate finishes. Analysis only. Trading Agents Lab never executes trades; users bridge to their own brokerage on the receiving side.',
  },
  {
    id: 'channels',
    label: 'Channels',
    description:
      'Two-way integrations where you can message Trading Agents Lab from outside the desktop app and get a Diligence back. Telegram is the first channel. More may follow as users ask.',
  },
  {
    id: 'clawless',
    label: 'Clawless',
    description:
      'Optional connector. Routes LLM calls through a Clawless gateway when one is reachable.',
  },
  {
    id: 'costguard',
    label: 'Cost Guard',
    description:
      'Daily / weekly / monthly USD caps + optional sessions-per-day rate cap. Applies to live LLM debates only; stub mode is always free.',
  },
  {
    id: 'about',
    label: 'About',
    description: 'Version, license, storage location, and project links.',
  },
];

interface SecretRow {
  /** Stable key in `secrets.json` — e.g. "llm:openai", "data:alpaca". */
  secretKey: string;
  /** Human label for the row. */
  name: string;
  /** Sub-line explaining the provider. */
  note: string;
  /** Pill content (no functional meaning yet). */
  pillLabel: string;
  pillVariant: 'default' | 'planned' | 'optional';
  /** Input affordance — `password` (default) or `text` for non-secret URLs. */
  fieldType?: 'password' | 'text';
  /** Placeholder for the input. */
  placeholder?: string;
  /** When set, a "Test" button appears once the key is stored. Clicking
   * runs a 1-token completion against the live provider to validate the
   * credential. Only meaningful for LLM rows. */
  testProvider?: Exclude<LLMProvider, 'local'>;
}

const LLM_PROVIDERS: SecretRow[] = [
  {
    secretKey: 'llm:openai',
    name: 'OpenAI (API key fallback)',
    note: 'GPT-5 and GPT-4o family via API key. The OAuth row above wins when both are configured. Keep an API key here only if you want a manual fallback.',
    pillLabel: 'Fallback',
    pillVariant: 'optional',
    placeholder: 'sk-…',
    testProvider: 'openai',
  },
  {
    secretKey: 'llm:anthropic',
    name: 'Anthropic',
    note: 'Claude family. API key only (Anthropic OAuth is banned by their TOS).',
    pillLabel: 'API key only',
    pillVariant: 'default',
    placeholder: 'sk-ant-…',
    testProvider: 'anthropic',
  },
  {
    secretKey: 'llm:openrouter',
    name: 'OpenRouter',
    note: 'Provider-agnostic gateway. One key, many models, defaults to openai/gpt-4o-mini.',
    pillLabel: 'Compatible',
    pillVariant: 'default',
    placeholder: 'sk-or-…',
    testProvider: 'openrouter',
  },
  {
    secretKey: 'llm:gemini',
    name: 'Google Gemini',
    note: 'Gemini 2.x and 3.x family. Cheap and fast, good for high-volume runs.',
    pillLabel: 'Compatible',
    pillVariant: 'default',
    placeholder: 'AIza…',
    testProvider: 'gemini',
  },
  {
    secretKey: 'llm:xai',
    name: 'xAI Grok',
    note: 'Grok 4.3 and the Grok 4.20 family. API key only. Get a key at console.x.ai.',
    pillLabel: 'API key only',
    pillVariant: 'default',
    placeholder: 'xai-…',
    testProvider: 'xai',
  },
  {
    secretKey: 'llm:minimax',
    name: 'MiniMax',
    note: 'MiniMax M2.x family (Global region), 204K context. API key only. Get a key at platform.minimax.io.',
    pillLabel: 'API key only',
    pillVariant: 'default',
    placeholder: 'eyJ… (JWT)',
    testProvider: 'minimax',
  },
];

// Alpaca auth requires TWO values — Key ID (sent as APCA-API-KEY-ID) and
// Secret Key (sent as APCA-API-SECRET-KEY). Both are minted together on the
// Alpaca dashboard; the Secret is shown only once at generation time.
//
// Per project positioning (locked 2026-05-09 — see CLAUDE.md §3 + memory):
// TradingAgentsLab is an analysis tool, not an execution platform. Alpaca
// is integrated for HIGH-QUALITY MARKET DATA only — not order execution.
// The engine's URL constants point to data.alpaca.markets and (read-only)
// paper-api.alpaca.markets. Live keys (api.alpaca.markets) have nowhere
// to go in our code: pasting a live key here will store it but the system
// will error out at request time. Defense-in-depth via endpoint constants,
// not a guard flag.
const DATA_PROVIDERS: SecretRow[] = [
  {
    secretKey: 'data:alpaca-key-id',
    name: 'Alpaca Markets: Key ID',
    note: 'Public key for high-quality market data (APCA-API-KEY-ID). Looks like PKxxxxxxxxxxxxxxxx. Paste alongside the Secret below. Use a paper-trading key. Trading Agents Lab connects only to data + paper-read endpoints; live keys will not function.',
    pillLabel: 'Key ID',
    pillVariant: 'default',
    placeholder: 'PKxxxxxxxxxxxxxxxx',
  },
  {
    secretKey: 'data:alpaca-secret',
    name: 'Alpaca Markets: Secret',
    note: 'Data secret (APCA-API-SECRET-KEY). Shown once at key generation on the Alpaca dashboard. Regenerate the pair if you missed it.',
    pillLabel: 'Secret',
    pillVariant: 'default',
    placeholder: 'data secret key',
  },
];

const CLAWLESS_FIELDS: SecretRow[] = [
  {
    secretKey: 'clawless:gateway-url',
    name: 'Gateway URL',
    note: 'Default port for the OpenClaw gateway.',
    pillLabel: 'Connector',
    pillVariant: 'default',
    fieldType: 'text',
    placeholder: 'ws://127.0.0.1:18789',
  },
  {
    secretKey: 'clawless:gateway-token',
    name: 'Gateway token',
    note:
      'Grants broad read access; store via OS keychain only. Paste from your Clawless settings.',
    pillLabel: 'Connector',
    pillVariant: 'default',
    placeholder: 'paste from Clawless settings',
  },
];

function Settings() {
  const [active, setActive] = useState<Tab>('llm');
  const [availability, setAvailability] = useState<SecretsAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [listings, setListings] = useState<SecretListing[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  // null in the common case. Populated either from the initial `availability`
  // call (recovery happened before this page mounted) or from the
  // `secrets:recovered` IPC (recovery happened while we were watching).
  const [recovery, setRecovery] = useState<CorruptionRecovery | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAvailability()
      .then((info) => {
        if (cancelled) return;
        setAvailability(info);
        if (info.corruptionRecovery) setRecovery(info.corruptionRecovery);
        if (!info.available) {
          setAvailabilityError(
            'Encryption backend unavailable on this OS. Refusing to store secrets in plaintext.',
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setAvailabilityError(
            err instanceof Error ? err.message : 'failed to check encryption availability',
          );
        }
      });
    const unsubscribe = onSecretsRecovered((info) => {
      if (!cancelled) setRecovery(info);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!availability?.available) return;
    let cancelled = false;
    listSecrets()
      .then((rows) => {
        if (!cancelled) setListings(rows);
      })
      .catch(() => {
        if (!cancelled) setListings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [availability, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  const listingByKey = useMemo(() => {
    const map = new Map<string, SecretListing>();
    for (const l of listings) map.set(l.key, l);
    return map;
  }, [listings]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageSubtitle}>
          Configure providers and connections. Secrets are encrypted by your OS
          keychain (macOS Keychain / Windows DPAPI / Linux libsecret) before they
          touch disk.
        </p>
      </header>

      {availabilityError && (
        <div className={styles.availabilityBanner}>
          <strong>Secret storage offline.</strong> {availabilityError}
        </div>
      )}

      {recovery && (
        <div className={styles.availabilityBanner}>
          <strong>Encrypted secrets file recovered.</strong> The previous
          secrets.json could not be read and was backed up to{' '}
          <code>{recovery.backupPath}</code>. Re-enter your API keys below;
          your previous entries are intact in the backup if you need them.
        </div>
      )}

      <div className={styles.layout}>
        <nav className={styles.tabs} aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${active === t.id ? styles.tabActive : ''}`}
              onClick={() => setActive(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </nav>

        <section className={styles.panel}>
          <header className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>{tab.label}</h2>
            <p className={styles.panelDescription}>{tab.description}</p>
          </header>

          {active === 'llm' && (
            <>
              <OpenAIOAuthRow disabled={!availability?.available} />
              <SecretRowList
                rows={LLM_PROVIDERS}
                listingByKey={listingByKey}
                disabled={!availability?.available}
                onChange={refresh}
              />
              <LocalLLMRow
                disabled={!availability?.available}
                onChange={refresh}
              />
            </>
          )}
          {active === 'data' && (
            <>
              <YfinanceRow />
              <SecretRowList
                rows={DATA_PROVIDERS}
                listingByKey={listingByKey}
                disabled={!availability?.available}
                onChange={refresh}
              />
            </>
          )}
          {active === 'clawless' && (
            <SecretRowList
              rows={CLAWLESS_FIELDS}
              listingByKey={listingByKey}
              disabled={!availability?.available}
              onChange={refresh}
            />
          )}
          {active === 'webhooks' && <WebhooksTab availability={availability} />}
          {active === 'channels' && <ChannelsTab />}
          {active === 'costguard' && <CostGuardTab />}
          {active === 'about' && (
            <AboutTab availability={availability} secretsCount={listings.length} />
          )}
        </section>
      </div>
    </div>
  );
}

interface SecretRowListProps {
  rows: SecretRow[];
  listingByKey: Map<string, SecretListing>;
  disabled: boolean;
  onChange: () => void;
}

function SecretRowList({ rows, listingByKey, disabled, onChange }: SecretRowListProps) {
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <SecretRowItem
          key={row.secretKey}
          row={row}
          listing={listingByKey.get(row.secretKey) ?? null}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </ul>
  );
}

interface SecretRowItemProps {
  row: SecretRow;
  listing: SecretListing | null;
  disabled: boolean;
  onChange: () => void;
}

function SecretRowItem({ row, listing, disabled, onChange }: SecretRowItemProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Test-connection state. `null` = not tested this mount; otherwise the
   * most recent result is rendered inline. Re-running replaces. */
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LLMTestResult | null>(null);

  const onTest = async () => {
    if (!row.testProvider || !listing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const apiKey = await getSecret(row.secretKey);
      if (!apiKey) {
        setTestResult({ ok: false, error: 'no stored key' });
        return;
      }
      const result = await testLLMConnection({
        provider: row.testProvider,
        apiKey,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : 'test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await setSecret(row.secretKey, value);
      setValue('');
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!listing) return;
    if (!confirm(`Delete stored value for ${row.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSecret(row.secretKey);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>{row.name}</div>
        <div className={styles.rowNote}>{row.note}</div>
        {listing && (
          <div className={styles.rowMeta}>
            Stored {row.fieldType === 'text' ? 'value' : 'key'}{' '}
            <span className={styles.hint}>{listing.hint}</span> · saved{' '}
            {formatRelative(listing.updatedAt)}
          </div>
        )}
        {testResult && (
          <div
            className={styles.rowMeta}
            style={{
              color: testResult.ok
                ? 'var(--tal-buy, #4caf50)'
                : 'var(--tal-sell, #d64545)',
            }}
          >
            {testResult.ok
              ? `✓ Connection works${testResult.ms ? ` (${testResult.ms}ms)` : ''}${testResult.model ? ` · ${testResult.model}` : ''}`
              : `✗ ${testResult.error ?? 'failed'}`}
          </div>
        )}
        {editing && (
          <div className={styles.editor}>
            <input
              type={row.fieldType === 'text' ? 'text' : 'password'}
              className={styles.input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={row.placeholder ?? ''}
              autoFocus
              disabled={busy}
            />
            <div className={styles.editorActions}>
              <button
                className={styles.actionPrimary}
                onClick={onSave}
                disabled={busy || !value}
                type="button"
              >
                {busy ? 'Saving…' : listing ? 'Replace' : 'Save'}
              </button>
              <button
                className={styles.actionGhost}
                onClick={() => {
                  setEditing(false);
                  setValue('');
                  setError(null);
                }}
                disabled={busy}
                type="button"
              >
                Cancel
              </button>
            </div>
            {error && <div className={styles.editorError}>{error}</div>}
          </div>
        )}
      </div>
      <div className={styles.rowAside}>
        <span className={`${styles.pill} ${styles[`pill_${pillState(row, listing).variant}`]}`}>
          {pillState(row, listing).label}
        </span>
        {!editing && (
          <>
            {row.testProvider && listing && (
              <button
                className={styles.rowAction}
                onClick={() => void onTest()}
                disabled={disabled || busy || testing}
                type="button"
              >
                {testing ? 'Testing…' : 'Test'}
              </button>
            )}
            <button
              className={styles.rowAction}
              onClick={() => setEditing(true)}
              disabled={disabled || busy}
              type="button"
            >
              {listing ? 'Replace' : 'Configure'}
            </button>
            {listing && (
              <button
                className={styles.rowActionDanger}
                onClick={onDelete}
                disabled={disabled || busy}
                type="button"
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function YfinanceRow() {
  return (
    <div className={styles.staticRow}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>Yahoo Finance</div>
        <div className={styles.rowNote}>
          Free historical OHLCV via the yfinance package. Default, no configuration
          needed; the engine is already using it.
        </div>
      </div>
      <div className={styles.rowAside}>
        <span className={`${styles.pill} ${styles.pill_success}`}>Active · default</span>
      </div>
    </div>
  );
}

interface LocalLLMRowProps {
  disabled: boolean;
  onChange: () => void;
}

/**
 * Local LLM row — auto-detects running Ollama / LM Studio / llama.cpp
 * runtimes on localhost, and saves the user's (base_url, model) choice
 * as a pair of safeStorage entries.
 *
 * Detection runs once on mount + on demand via the Refresh button.
 * Empty detection is a normal state (user hasn't installed a runtime
 * yet); the manual-entry fallback covers anyone with a custom OpenAI-
 * compatible server on a non-standard port.
 *
 * No "Connect" button — once a runtime is detected, picking a model from
 * the dropdown saves the (URL, model) pair atomically. Cost is $0 by
 * design (the engine treats local sessions the same as OAuth for
 * CostGuard purposes).
 */
function LocalLLMRow({ disabled, onChange }: LocalLLMRowProps) {
  const [runtimes, setRuntimes] = useState<LocalRuntime[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [saved, setSaved] = useState<LocalLLMConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingFor, setSavingFor] = useState<string | null>(null); // base_url being saved
  /** Manual entry form state (used when nothing detected or user wants
   * a non-standard runtime). */
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState('http://localhost:11434/v1');
  const [manualModel, setManualModel] = useState('');

  const probe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const detected = await getLocalRuntimes();
      setRuntimes(detected);
    } catch (err) {
      // /llm/local-runtimes returns empty arrays cleanly; a thrown error
      // here means the engine is unreachable or returned a non-200. Show
      // it so the user knows detection isn't running silently broken.
      setProbeError(err instanceof Error ? err.message : 'probe failed');
      setRuntimes([]);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Load the saved (base_url, model) pair so the UI can highlight what's
  // currently active. Re-runs on every Settings refresh so saves from
  // sibling rows don't leave stale state.
  useEffect(() => {
    let cancelled = false;
    void loadLocalConfig().then((cfg) => {
      if (!cancelled) setSaved(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [savingFor]);

  const onPickModel = useCallback(
    async (baseUrl: string, model: string): Promise<boolean> => {
      if (disabled) return false;
      setSavingFor(baseUrl);
      setSaveError(null);
      try {
        await saveLocalConfig({ base_url: baseUrl, model });
        setSaved({ base_url: baseUrl, model });
        onChange();
        return true;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'save failed');
        return false;
      } finally {
        setSavingFor(null);
      }
    },
    [disabled, onChange],
  );

  const onSaveManual = useCallback(async () => {
    const url = manualUrl.trim();
    const model = manualModel.trim();
    if (!url || !model) {
      setSaveError('Both base URL and model are required.');
      return;
    }
    // Use onPickModel's return value, not the saveError state: state read
    // right after the await is the previous render's value (stale closure),
    // so the form would close on failure / stay open on success.
    const ok = await onPickModel(url, model);
    if (ok) {
      setManualOpen(false);
    }
  }, [manualUrl, manualModel, onPickModel]);

  const onClear = useCallback(async () => {
    if (!saved) return;
    if (!confirm('Clear the saved local LLM configuration?')) return;
    try {
      await Promise.all([
        deleteSecret(PROVIDER_SECRET_KEY.local),
        deleteSecret(LOCAL_MODEL_SECRET_KEY),
      ]);
      setSaved(null);
      onChange();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'clear failed');
    }
  }, [saved, onChange]);

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>Local LLM (Ollama / LM Studio)</div>
        <div className={styles.rowNote}>
          Auto-detects running OpenAI-compatible local runtimes on this
          machine. Free to run, fully private. Model quality depends on
          what you have installed. Cost guard treats local sessions as $0
          (same as OAuth subscription).
        </div>

        {saved && (
          <div className={styles.rowMeta}>
            Active: <strong>{saved.model}</strong> at <code>{saved.base_url}</code>
          </div>
        )}

        {probing && !runtimes && (
          <div className={styles.rowMeta}>Probing localhost…</div>
        )}

        {probeError && (
          <div className={styles.editorError} role="alert">
            Detection error: {probeError}
          </div>
        )}

        {runtimes && runtimes.length === 0 && (
          <div className={styles.rowMeta}>
            No local runtime detected. Install <a
              href="https://ollama.com"
              target="_blank"
              rel="noopener noreferrer"
            >Ollama</a> or <a
              href="https://lmstudio.ai"
              target="_blank"
              rel="noopener noreferrer"
            >LM Studio</a> and click Refresh, or use manual entry below.
          </div>
        )}

        {runtimes && runtimes.length > 0 && (
          <ul className={styles.list} style={{ marginTop: 8 }}>
            {runtimes.map((rt) => (
              <li key={rt.base_url} className={styles.staticRow}>
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>
                    {rt.runtime}
                    {saved?.base_url === rt.base_url && (
                      <span
                        className={`${styles.pill} ${styles.pill_success}`}
                        style={{ marginLeft: 8 }}
                      >
                        Connected
                      </span>
                    )}
                  </div>
                  <div className={styles.rowNote}>
                    <code>{rt.base_url}</code> · {rt.models.length} model{rt.models.length === 1 ? '' : 's'}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <label style={{ fontSize: 12, marginRight: 6 }}>
                      Model:
                    </label>
                    <select
                      disabled={disabled || savingFor === rt.base_url}
                      value={
                        saved?.base_url === rt.base_url ? saved.model : ''
                      }
                      onChange={(e) => {
                        if (e.target.value) {
                          void onPickModel(rt.base_url, e.target.value);
                        }
                      }}
                    >
                      <option value="">(pick a model)</option>
                      {rt.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {manualOpen && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--tal-bg-overlay)', borderRadius: 6 }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Base URL (OpenAI-compatible)
              </label>
              <input
                type="text"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                Model
              </label>
              <input
                type="text"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                placeholder="llama3.2:latest"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={onSaveManual}
                disabled={disabled}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setManualOpen(false)}
                disabled={disabled}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {saveError && (
          <div className={styles.editorError} role="alert">
            {saveError}
          </div>
        )}
      </div>

      <div className={styles.rowAside} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          onClick={() => void probe()}
          disabled={disabled || probing}
        >
          {probing ? 'Probing…' : 'Refresh'}
        </button>
        {!manualOpen && (
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            disabled={disabled}
          >
            Manual entry
          </button>
        )}
        {saved && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

interface OpenAIOAuthRowProps {
  disabled: boolean;
}

function OpenAIOAuthRow({ disabled }: OpenAIOAuthRowProps) {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ message: string; placeholder?: string } | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getOpenAIOAuthStatus();
      setStatus(next);
    } catch (err) {
      setStatus({ connected: false });
      setError(err instanceof Error ? err.message : 'oauth status check failed');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const offProgress = onOAuthProgress((event) => {
      setProgress(event.message);
    });
    const offPrompt = onOAuthPrompt((event) => {
      setPrompt({ message: event.message, placeholder: event.placeholder });
    });
    return () => {
      offProgress();
      offPrompt();
    };
  }, []);

  const onConnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress('Starting…');
    setPrompt(null);
    try {
      const result = await startOpenAIOAuthLogin();
      if (result.success) {
        setProgress(
          result.email
            ? `Connected as ${result.email}`
            : 'Connected.',
        );
      } else {
        setError(result.error ?? 'Login failed.');
        setProgress(null);
      }
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'oauth start failed');
      setProgress(null);
    } finally {
      setBusy(false);
      setPrompt(null);
      setPasteValue('');
    }
  }, [refreshStatus]);

  const onDisconnect = useCallback(async () => {
    if (!confirm('Disconnect the OpenAI account? Stored OAuth tokens will be erased.')) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectOpenAIOAuth();
      setProgress(null);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'disconnect failed');
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const onSubmitPaste = useCallback(() => {
    const value = pasteValue.trim();
    if (!value) return;
    submitOAuthPromptResponse(value);
    setPrompt(null);
    setPasteValue('');
  }, [pasteValue]);

  const connected = status?.connected ?? false;

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>OpenAI account (OAuth)</div>
        <div className={styles.rowNote}>
          Sign in with your OpenAI account. Wins over the API key when both
          are configured. <strong>Note:</strong> whether OAuth tokens route
          through your ChatGPT subscription vs. per-token billing depends on
          your OpenAI account configuration. Verify with a low-cost model
          first and check your billing dashboard before relying on this for
          cost savings.
        </div>
        {connected && (
          <div className={styles.rowMeta}>
            Connected{status?.email ? ` as ${status.email}` : ''}
            {status?.planType && ` · ${status.planType} plan`}
            {status?.needsRefresh && ' · token will refresh on next use'}
          </div>
        )}
        {connected && status?.isFreeTier && (
          <div className={styles.editorError} role="alert">
            ⚠ Free-tier ChatGPT accounts have unreliable Codex routing.
            Many models hang or return errors. Configure an OpenAI API key
            below as a fallback if debates fail to start.
          </div>
        )}
        {progress && !error && (
          <div className={styles.rowMeta}>{progress}</div>
        )}
        {prompt && (
          <div className={styles.editor}>
            <div className={styles.label}>{prompt.message}</div>
            <input
              className={styles.input}
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder={prompt.placeholder ?? 'paste here'}
              autoFocus
              disabled={busy && !prompt}
            />
            <div className={styles.editorActions}>
              <button
                className={styles.actionPrimary}
                onClick={onSubmitPaste}
                disabled={!pasteValue.trim()}
                type="button"
              >
                Submit
              </button>
            </div>
          </div>
        )}
        {error && <div className={styles.editorError}>{error}</div>}
      </div>
      <div className={styles.rowAside}>
        <span
          className={`${styles.pill} ${
            connected ? styles.pill_success : styles.pill_optional
          }`}
        >
          {connected ? 'Connected' : 'Recommended'}
        </span>
        {connected ? (
          <button
            className={styles.rowActionDanger}
            onClick={() => void onDisconnect()}
            disabled={disabled || busy}
            type="button"
          >
            Disconnect
          </button>
        ) : (
          <button
            className={styles.rowAction}
            onClick={() => void onConnect()}
            disabled={disabled || busy}
            type="button"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}

interface AboutTabProps {
  availability: SecretsAvailability | null;
  secretsCount: number;
}

function AboutTab({ availability, secretsCount }: AboutTabProps) {
  return (
    <div className={styles.formCard}>
      <dl className={styles.aboutList}>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Version</dt>
          <dd className={styles.aboutValue}>1.0.0</dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>License</dt>
          <dd className={styles.aboutValue}>
            AGPL-3.0 (project additions) · Apache-2.0 (upstream tradingagents core)
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Upstream</dt>
          <dd className={styles.aboutValue}>
            Forked from{' '}
            <a
              className={styles.link}
              href="https://github.com/TauricResearch/TradingAgents"
              target="_blank"
              rel="noreferrer"
            >
              TauricResearch/TradingAgents
            </a>
            <button
              type="button"
              className={styles.refreshLink}
              onClick={() => {
                const trigger = (window as unknown as { __talCheckUpstream?: () => void })
                  .__talCheckUpstream;
                if (trigger) trigger();
              }}
              style={{ marginLeft: 12 }}
            >
              Check for updates
            </button>
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Repository</dt>
          <dd className={styles.aboutValue}>
            <a
              className={styles.link}
              href="https://github.com/RBJGlobal/TradingAgentsLab"
              target="_blank"
              rel="noreferrer"
            >
              RBJGlobal/TradingAgentsLab
            </a>
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Posture</dt>
          <dd className={styles.aboutValue}>
            Educational research and paper trading. Not investment advice.
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Legal</dt>
          <dd className={styles.aboutValue}>
            <a
              className={styles.link}
              href="https://tradingagentslab.ai/legal/disclaimer/"
              target="_blank"
              rel="noreferrer"
            >
              Disclaimer
            </a>{' '}
            ·{' '}
            <a
              className={styles.link}
              href="https://tradingagentslab.ai/legal/terms/"
              target="_blank"
              rel="noreferrer"
            >
              Terms
            </a>{' '}
            ·{' '}
            <a
              className={styles.link}
              href="https://tradingagentslab.ai/legal/privacy/"
              target="_blank"
              rel="noreferrer"
            >
              Privacy
            </a>
            <div className={styles.aboutHint}>
              Full three-tier disclaimer, Terms of Service, and Privacy Policy
              on the website.
            </div>
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Encryption</dt>
          <dd className={styles.aboutValue}>
            {availability?.available
              ? 'OS keychain available · safeStorage active'
              : 'Unavailable; secret storage disabled'}
          </dd>
        </div>
        <div className={styles.aboutRow}>
          <dt className={styles.aboutKey}>Secrets file</dt>
          <dd className={styles.aboutValue}>
            <code className={styles.code}>
              {availability?.filePath ?? '(unavailable)'}
            </code>
            <div className={styles.aboutHint}>
              {secretsCount === 0
                ? 'Empty. No secrets stored yet.'
                : `${secretsCount} entr${secretsCount === 1 ? 'y' : 'ies'} stored (encrypted).`}
            </div>
          </dd>
        </div>
      </dl>
      <UpdatesSection />
    </div>
  );
}

/**
 * Pill state per row, applying the green-Connected convention from
 * commit `bdc1716` ("Green = wired and working right now") universally
 * to every SecretRowItem — not just OAuth + yfinance.
 *
 * Rules:
 * - listing != null AND pillVariant = 'planned' → "Stored · Inert" in the
 *   neutral optional style. Communicates "we have the key" without the
 *   green-confirming-active feel that would mislead on Restricted rows
 *   (e.g. Alpaca Live, where the engine refuses to place real-money
 *   orders even with keys configured).
 * - listing != null otherwise → "Connected ✓" in green pill_success.
 * - listing == null → static label/variant from the row definition.
 */
function pillState(
  row: SecretRow,
  listing: SecretListing | null,
): { label: string; variant: 'default' | 'planned' | 'optional' | 'success' } {
  if (!listing) {
    return { label: row.pillLabel, variant: row.pillVariant };
  }
  if (row.pillVariant === 'planned') {
    return { label: 'Stored · Inert', variant: 'optional' };
  }
  return { label: 'Connected ✓', variant: 'success' };
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- Webhooks tab ---------------------------------------------------------
//
// Single-key safeStorage backed. The full config list is serialized to one
// JSON blob (`webhooks:configs`) so a refresh round-trips in two IPC calls
// instead of one-per-webhook. URLs + secrets are sensitive (Telegram URLs
// embed bot tokens) — the OS keychain is the right home.

interface WebhooksTabProps {
  availability: SecretsAvailability | null;
}

function WebhooksTab({ availability }: WebhooksTabProps) {
  const [webhooks, setWebhooksState] = useState<WebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WebhookConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setWebhooksState(await loadWebhooks());
    } catch {
      setWebhooksState([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPersist = useCallback(
    async (next: WebhookConfig[]) => {
      try {
        await saveWebhooks(next);
        setWebhooksState(next);
        setSaveError(null);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'save failed');
      }
    },
    [],
  );

  const onAddNew = useCallback(() => {
    setEditing({
      id: newWebhookId(),
      name: '',
      url: '',
      kind: 'telegram',
      filter: newWebhookFilter(),
    });
  }, []);

  const onSave = useCallback(
    async (cfg: WebhookConfig) => {
      const trimmed: WebhookConfig = {
        ...cfg,
        name: cfg.name.trim() || 'Untitled webhook',
        url: cfg.url.trim(),
        secret: cfg.secret?.trim() || undefined,
        telegram_chat_id: cfg.telegram_chat_id?.trim() || undefined,
      };
      if (!trimmed.url.startsWith('https://') && !trimmed.url.startsWith('http://')) {
        setSaveError('URL must start with http:// or https://');
        return;
      }
      if (trimmed.kind === 'telegram') {
        const token = extractTelegramToken(trimmed.url);
        if (!token) {
          setSaveError('Bot Token is required for Telegram.');
          return;
        }
        if (!trimmed.telegram_chat_id) {
          setSaveError('Chat ID is required for Telegram.');
          return;
        }
      }
      const existing = webhooks.findIndex((w) => w.id === trimmed.id);
      const next =
        existing >= 0
          ? webhooks.map((w) => (w.id === trimmed.id ? trimmed : w))
          : [...webhooks, trimmed];
      await onPersist(next);
      setEditing(null);
    },
    [webhooks, onPersist],
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm('Delete this webhook? Configured receivers will stop firing.')) {
        return;
      }
      await onPersist(webhooks.filter((w) => w.id !== id));
    },
    [webhooks, onPersist],
  );

  if (availability && !availability.available) {
    return (
      <div className={styles.placeholder}>
        Webhook configs require encrypted storage. safeStorage is not available
        on this system.
      </div>
    );
  }

  return (
    <div>
      <div className={styles.webhooksToolbar}>
        <button
          type="button"
          className={styles.actionPrimary}
          onClick={onAddNew}
          disabled={loading}
          data-testid="webhooks-add-button"
        >
          + Add webhook
        </button>
      </div>

      {saveError && <p className={styles.formError}>{saveError}</p>}

      {loading && <p className={styles.hint}>Loading…</p>}

      {!loading && webhooks.length === 0 && !editing && (
        <div className={styles.phaseGuard}>
          <strong>No webhooks configured.</strong> Push every completed debate
          to Telegram, Slack, Discord, or your own HTTPS endpoint. Filter by
          action (BUY / SELL / HOLD) or confidence so you only get pinged on
          what matters.
          <br />
          <br />
          Webhooks are an analysis handoff. They push the decision JSON to
          your receivers. They never execute trades. If you want to bridge to
          a broker, your receiver (Cloudflare Worker, Lambda, etc.) calls the
          broker API.
        </div>
      )}

      {webhooks.length > 0 && (
        <ul className={styles.list} data-testid="webhooks-list">
          {webhooks.map((w) => (
            <li
              key={w.id}
              className={styles.row}
              data-testid={`webhook-row-${w.id}`}
            >
              <div className={styles.rowMain}>
                <div className={styles.rowName}>
                  {w.name}{' '}
                  <span className={styles.pill}>{KIND_LABEL[w.kind]}</span>
                  {w.filter.actions.length > 0 && (
                    <span className={styles.pill}>
                      {w.filter.actions.join(' / ')}
                    </span>
                  )}
                  {w.filter.min_confidence > 0 && (
                    <span className={styles.pill}>
                      ≥ {Math.round(w.filter.min_confidence * 100)}%
                    </span>
                  )}
                </div>
                <div className={styles.rowNote}>
                  {hostFromUrl(w.url) || '(invalid URL)'}
                </div>
              </div>
              <div className={styles.rowAside}>
                <button
                  type="button"
                  className={styles.rowAction}
                  onClick={() => setEditing({ ...w })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.rowActionDanger}
                  onClick={() => void onDelete(w.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <WebhookEditor
          config={editing}
          onCancel={() => setEditing(null)}
          onSave={onSave}
        />
      )}
    </div>
  );
}

// ---- Channels tab ---------------------------------------------------------
//
// Two-way integrations where the user reaches into Trading Agents Lab from
// outside the desktop app. Today this is just the Telegram bot. Future
// candidates (Discord, Slack, iMessage Shortcuts, etc.) would each get
// their own panel here. Kept separate from Webhooks because the mental
// model is different: webhooks are outbound HTTP push on session.complete;
// channels are inbound triggers that drive a new debate.

function ChannelsTab() {
  return (
    <div>
      <TelegramBotPanel />
    </div>
  );
}

/** Show just the hostname in the row preview so the bot token (Telegram /
 * Discord URLs) never appears in the UI even briefly. The Editor shows
 * the full URL in the password field for editing. */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Telegram URLs embed the bot token. Settings UI asks for the bare token
 * (closer to how BotFather presents it) and these helpers materialise the
 * full Bot API URL on the way to storage and back. */
const TELEGRAM_URL_PREFIX = 'https://api.telegram.org/bot';
const TELEGRAM_URL_SUFFIX = '/sendMessage';

function extractTelegramToken(url: string): string {
  if (!url.startsWith(TELEGRAM_URL_PREFIX)) return '';
  const rest = url.slice(TELEGRAM_URL_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(0, slash) : rest;
}

function buildTelegramUrl(token: string): string {
  return `${TELEGRAM_URL_PREFIX}${token.trim()}${TELEGRAM_URL_SUFFIX}`;
}

interface WebhookEditorProps {
  config: WebhookConfig;
  onCancel: () => void;
  onSave: (cfg: WebhookConfig) => void;
}

function WebhookEditor({ config, onCancel, onSave }: WebhookEditorProps) {
  const [draft, setDraft] = useState<WebhookConfig>(config);

  const setKind = (kind: WebhookKind) => {
    setDraft((d) => ({
      ...d,
      kind,
      // Reset Telegram-specific fields when switching away.
      telegram_chat_id: kind === 'telegram' ? d.telegram_chat_id : undefined,
      // HMAC only meaningful for generic.
      secret: kind === 'generic' ? d.secret : undefined,
    }));
  };

  return (
    <div className={styles.editor} data-testid="webhook-editor">
      <div className={styles.field}>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Telegram me on BUY"
          data-testid="webhook-name-input"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Kind</label>
        <select
          className={styles.input}
          value={draft.kind}
          onChange={(e) => setKind(e.target.value as WebhookKind)}
          data-testid="webhook-kind-select"
        >
          {(['telegram', 'slack', 'discord', 'generic'] as WebhookKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{KIND_HINT[draft.kind]}</p>
      </div>

      {draft.kind === 'telegram' ? (
        <>
          <div className={styles.field}>
            <label className={styles.label}>Bot Token</label>
            <input
              type="password"
              className={styles.input}
              value={extractTelegramToken(draft.url)}
              onChange={(e) =>
                setDraft({ ...draft, url: buildTelegramUrl(e.target.value) })
              }
              placeholder="123456789:ABCdef-GhIJklmnOPqrsTUVwxyz"
              data-testid="webhook-url-input"
            />
            <p className={styles.hint}>
              The token BotFather gave you on Telegram. Looks like{' '}
              <code className={styles.code}>123456789:ABC...</code>. Stored
              encrypted in your OS keychain; never shown back in the row preview.
            </p>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Chat ID</label>
            <input
              className={styles.input}
              value={draft.telegram_chat_id ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, telegram_chat_id: e.target.value })
              }
              placeholder="12345678 or -100123456789 for groups"
              data-testid="webhook-chat-id-input"
            />
            <p className={styles.hint}>
              Numeric Telegram chat id. Get yours by messaging{' '}
              <code className={styles.code}>@userinfobot</code> on Telegram. For
              group chats the id starts with a minus.
            </p>
          </div>
        </>
      ) : (
        <div className={styles.field}>
          <label className={styles.label}>URL</label>
          <input
            type="password"
            className={styles.input}
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder={
              draft.kind === 'slack'
                ? 'https://hooks.slack.com/services/...'
                : draft.kind === 'discord'
                  ? 'https://discord.com/api/webhooks/<id>/<token>'
                  : 'https://your-receiver.example.com/hook'
            }
            data-testid="webhook-url-input"
          />
        </div>
      )}

      {draft.kind === 'generic' && (
        <div className={styles.field}>
          <label className={styles.label}>HMAC shared secret (optional)</label>
          <input
            type="password"
            className={styles.input}
            value={draft.secret ?? ''}
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            placeholder="any string"
          />
          <p className={styles.hint}>
            When set, requests carry{' '}
            <code className={styles.code}>X-TAL-Signature: sha256=&lt;hex&gt;</code>{' '}
            so your receiver can verify the body.
          </p>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Fire on actions</label>
        <div className={styles.webhooksCheckboxes}>
          {(['BUY', 'SELL', 'HOLD'] as const).map((a) => {
            const checked = draft.filter.actions.includes(a);
            return (
              <label key={a} className={styles.webhooksCheckboxLabel}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      filter: {
                        ...draft.filter,
                        actions: e.target.checked
                          ? [...draft.filter.actions, a]
                          : draft.filter.actions.filter((x) => x !== a),
                      },
                    })
                  }
                />
                {a}
              </label>
            );
          })}
        </div>
        <p className={styles.hint}>
          Leave all unchecked to fire on every action.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>
          Minimum confidence: {Math.round(draft.filter.min_confidence * 100)}%
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(draft.filter.min_confidence * 100)}
          onChange={(e) =>
            setDraft({
              ...draft,
              filter: { ...draft.filter, min_confidence: Number(e.target.value) / 100 },
            })
          }
        />
      </div>

      <div className={styles.editorActions}>
        <button
          type="button"
          className={styles.actionGhost}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.actionPrimary}
          onClick={() => onSave(draft)}
          disabled={!draft.url.trim()}
          data-testid="webhook-save-button"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ---- Cost Guard tab --------------------------------------------------------

function CostGuardTab() {
  const [config, setConfig] = useState<CostGuardConfig | null>(null);
  const [spend, setSpend] = useState<SpendState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form draft state — separate from `config` so the user can edit without
  // clobbering displayed-current values until they hit Save.
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftDaily, setDraftDaily] = useState('');
  const [draftWeekly, setDraftWeekly] = useState('');
  const [draftMonthly, setDraftMonthly] = useState('');
  const [draftSessionsPerDay, setDraftSessionsPerDay] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const state = await getCostGuardState();
      setConfig(state.config);
      setSpend(state.spend);
      setDraftEnabled(state.config.enabled);
      setDraftDaily(String(state.config.cap_daily_usd));
      setDraftWeekly(String(state.config.cap_weekly_usd));
      setDraftMonthly(String(state.config.cap_monthly_usd));
      setDraftSessionsPerDay(String(state.config.cap_sessions_per_day));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load cost guard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updateCostGuardConfig({
        enabled: draftEnabled,
        cap_daily_usd: parseNonNegFloat(draftDaily, config?.cap_daily_usd ?? 0),
        cap_weekly_usd: parseNonNegFloat(draftWeekly, config?.cap_weekly_usd ?? 0),
        cap_monthly_usd: parseNonNegFloat(draftMonthly, config?.cap_monthly_usd ?? 0),
        cap_sessions_per_day: parseNonNegInt(
          draftSessionsPerDay,
          config?.cap_sessions_per_day ?? 0,
        ),
      });
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      // Refresh spend snapshot in case time crossed a window boundary.
      const state = await getCostGuardState();
      setSpend(state.spend);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save cost guard');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config || !spend) {
    return (
      <div className={styles.formCard}>
        <p className={styles.formHint}>{error ?? 'Loading cost guard…'}</p>
      </div>
    );
  }

  return (
    <div className={styles.formCard}>
      <div className={styles.formGroup}>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={draftEnabled}
            onChange={(e) => setDraftEnabled(e.target.checked)}
          />
          <span>
            <strong>Budget caps enabled</strong>
            <div className={styles.formHint}>
              When off, all live debates are allowed regardless of caps.
            </div>
          </span>
        </label>
      </div>

      <fieldset className={styles.formGroup} disabled={!draftEnabled}>
        <legend className={styles.formLegend}>API cost caps (USD)</legend>
        <p className={styles.formHint}>
          Applies to API-key sessions only. OAuth sessions cost $0
          (subscription-billed). Set to 0 to disable any window.
        </p>
        <CostInputRow
          label="Daily"
          value={draftDaily}
          onChange={setDraftDaily}
          step={0.25}
          placeholder="1.00"
        />
        <CostInputRow
          label="Weekly"
          value={draftWeekly}
          onChange={setDraftWeekly}
          step={1}
          placeholder="5.00"
        />
        <CostInputRow
          label="Monthly"
          value={draftMonthly}
          onChange={setDraftMonthly}
          step={5}
          placeholder="15.00"
        />
      </fieldset>

      <fieldset className={styles.formGroup} disabled={!draftEnabled}>
        <legend className={styles.formLegend}>Session rate cap</legend>
        <p className={styles.formHint}>
          Applies to all live sessions including OAuth. Use this to cap your
          ChatGPT subscription quota usage. Set to 0 to disable.
        </p>
        <CostInputRow
          label="Per day"
          value={draftSessionsPerDay}
          onChange={setDraftSessionsPerDay}
          step={1}
          placeholder="0 (disabled)"
          asInteger
        />
      </fieldset>

      <fieldset className={styles.formGroup}>
        <legend className={styles.formLegend}>Current period spend</legend>
        <SpendBar
          label="Daily"
          current={spend.daily_usd}
          cap={config.cap_daily_usd}
        />
        <SpendBar
          label="Weekly"
          current={spend.weekly_usd}
          cap={config.cap_weekly_usd}
        />
        <SpendBar
          label="Monthly"
          current={spend.monthly_usd}
          cap={config.cap_monthly_usd}
        />
        {config.cap_sessions_per_day > 0 && (
          <SpendBar
            label="Sessions today"
            current={spend.sessions_today}
            cap={config.cap_sessions_per_day}
            isCount
          />
        )}
        <button
          type="button"
          className={styles.refreshLink}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </fieldset>

      {error && <p className={styles.formError}>{error}</p>}
      {saved && <p className={styles.formSuccess}>Saved.</p>}

      <div className={styles.formActions}>
        <button
          type="button"
          className={styles.formSave}
          onClick={() => void onSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

interface CostInputRowProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: number;
  placeholder?: string;
  asInteger?: boolean;
}

function CostInputRow({
  label,
  value,
  onChange,
  step = 0.25,
  placeholder,
  asInteger,
}: CostInputRowProps) {
  return (
    <div className={styles.costInputRow}>
      <label className={styles.costInputLabel}>
        {label}
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={asInteger ? 1 : step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={styles.costInputField}
        />
      </label>
    </div>
  );
}

interface SpendBarProps {
  label: string;
  current: number;
  cap: number;
  isCount?: boolean;
}

function SpendBar({ label, current, cap, isCount }: SpendBarProps) {
  if (cap <= 0) {
    return (
      <div className={styles.spendRow}>
        <span className={styles.spendLabel}>{label}</span>
        <span className={styles.spendValue}>
          {isCount ? current : formatUsdShort(current)} · cap disabled
        </span>
      </div>
    );
  }
  const pct = Math.min(100, (current / cap) * 100);
  const tone = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className={styles.spendRow}>
      <span className={styles.spendLabel}>{label}</span>
      <div className={styles.spendProgress}>
        <div
          className={`${styles.spendBar} ${styles[`spendBar_${tone}`] ?? ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={styles.spendValue}>
        {isCount
          ? `${current} / ${cap}`
          : `${formatUsdShort(current)} / ${formatUsdShort(cap)}`}
      </span>
    </div>
  );
}

function parseNonNegFloat(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseNonNegInt(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function formatUsdShort(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

// ---- Telegram bot (bidirectional, Phase 8c) -------------------------------
//
// Sits at the bottom of the Webhooks tab because the user mental model for
// anything Telegram-related lives there. Webhooks above this panel are
// OUTBOUND only (engine pushes session.complete to Telegram). The bot
// below is BIDIRECTIONAL: it lets a user message the bot from Telegram
// to trigger a fresh Diligence run. Same bot token can power both.
//
// Persistence:
// - Bot token in OS keychain (safeStorage) under `telegram:bot-token`
// - Allowlist + cap + selected provider in localStorage (non-secret config)
// - Provider API key looked up in safeStorage from PROVIDER_SECRET_KEY at
//   start time, matched to the user's provider dropdown choice
//
// Engine side persists per-chat daily spend across restarts so the cap is
// resistant to app-reboot evasion; see engine/telegram_bot.py for details.

const TELEGRAM_BOT_TOKEN_KEY = 'telegram:bot-token';
const TELEGRAM_ALLOWLIST_LS_KEY = 'tal.telegram.allowlist';
const TELEGRAM_CAP_LS_KEY = 'tal.telegram.daily_cap';
const TELEGRAM_PROVIDER_LS_KEY = 'tal.telegram.provider';

// Supports all 6 API-key providers plus OpenAI OAuth (Codex). OAuth access
// tokens are short-lived, so when the bot is on OpenAI OAuth the panel kicks
// off a periodic refresh that pushes fresh tokens to the engine via
// /telegram/refresh-credentials. xAI and MiniMax are API-key only and ride
// the generic path (same as anthropic/openrouter/gemini), so they need no
// OAuth refresh. Local LLM is still excluded because the base_url + dynamic
// model picker plumbing isn't here yet.
type BotProvider = 'openai' | 'anthropic' | 'openrouter' | 'gemini' | 'xai' | 'minimax';
const BOT_PROVIDERS: { value: BotProvider; label: string }[] = [
  { value: 'openai',     label: 'OpenAI' },
  { value: 'anthropic',  label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'gemini',     label: 'Google Gemini' },
  { value: 'xai',        label: 'xAI Grok' },
  { value: 'minimax',    label: 'MiniMax' },
];
const BOT_PROVIDER_DEFAULT_MODEL: Record<BotProvider, string> = {
  openai:     'gpt-4o-mini',
  anthropic:  'claude-haiku-4-5',
  openrouter: 'openai/gpt-4o-mini',
  gemini:     'gemini-2.0-flash',
  // Fast/cheap defaults, matching the Analyze picker + engine _DEFAULT_MODELS.
  xai:        'grok-4.3',
  minimax:    'MiniMax-M2.7-highspeed',
};

function parseAllowlist(text: string): number[] {
  return text
    .split(/[\s,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Assemble the provider_config to ship to /telegram/start (or push via
 * /telegram/refresh-credentials). For OpenAI, prefer OAuth if connected
 * because the founder's intent on this product is "use the ChatGPT plan
 * I already pay for"; an API key in the fallback slot is the API-key
 * path. For everything else, pull the API key from safeStorage.
 *
 * Returns `null` if there's no usable credential for the chosen provider
 * (renderer surfaces this as the "configure a key" error). Returns
 * `{ kind: 'oauth' }` when OAuth was used, so the caller can decide
 * whether to start the periodic refresh interval; an `api_key` result
 * has stable creds and needs no refresh.
 */
async function buildBotProviderConfig(provider: BotProvider): Promise<
  | { kind: 'api_key'; config: Record<string, unknown> }
  | { kind: 'oauth'; config: Record<string, unknown> }
  | null
> {
  const model = BOT_PROVIDER_DEFAULT_MODEL[provider];

  if (provider === 'openai') {
    // OAuth preferred. `getOpenAICredentialsForRequest` refreshes silently
    // if the cached token is within 60s of expiry; on full failure it
    // returns null and we fall through to the API-key path.
    try {
      const creds = await getOpenAICredentialsForRequest();
      if (creds) {
        return {
          kind: 'oauth',
          config: {
            provider: 'openai',
            auth: {
              type: 'oauth',
              access: creds.access,
              refresh: creds.refresh,
              expires: creds.expires,
              account_id: creds.accountId,
            },
            // OpenAI Codex backend uses a different default model than the
            // API path (Codex rejects gpt-4o-mini etc.). Mirror the Analyze
            // page's OAuth default.
            model: OPENAI_CODEX_DEFAULT_MODEL,
            max_tokens: 400,
          },
        };
      }
    } catch {
      // Fall through to API-key path. The OAuth bridge may be unavailable
      // (preload not loaded) or the user may not have connected OAuth.
    }
  }

  const apiKey = await getSecret(PROVIDER_SECRET_KEY[provider]);
  if (!apiKey) {
    return null;
  }
  return {
    kind: 'api_key',
    config: {
      provider,
      auth: { type: 'api_key', api_key: apiKey },
      model,
      max_tokens: 400,
    },
  };
}

// Refresh OAuth tokens this often. OpenAI access tokens are typically 1hr;
// 45 minutes leaves comfortable headroom but doesn't churn unnecessarily.
const OAUTH_REFRESH_INTERVAL_MS = 45 * 60 * 1000;

function TelegramBotPanel() {
  const [token, setToken] = useState('');
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [allowlistText, setAllowlistText] = useState('');
  const [capText, setCapText] = useState('5.00');
  const [botProvider, setBotProvider] = useState<BotProvider>('openai');
  const [status, setStatus] = useState<TelegramBotStatus | null>(null);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OAuth refresh interval. Only armed when the bot is started with
  // OpenAI OAuth credentials; cleared on Stop or panel unmount. Holds
  // the interval handle so we can call clearInterval on stop / restart.
  const oauthRefreshRef = useRef<number | null>(null);

  const clearOAuthRefresh = useCallback(() => {
    if (oauthRefreshRef.current !== null) {
      window.clearInterval(oauthRefreshRef.current);
      oauthRefreshRef.current = null;
    }
  }, []);

  const startOAuthRefresh = useCallback((provider: BotProvider) => {
    // Refresh interval is only meaningful when OAuth is the auth path.
    // OAuth is OpenAI-only today; if more providers grow OAuth the gate
    // moves here.
    if (provider !== 'openai') return;
    clearOAuthRefresh();
    oauthRefreshRef.current = window.setInterval(async () => {
      try {
        const built = await buildBotProviderConfig(provider);
        if (built === null || built.kind !== 'oauth') {
          // OAuth no longer available (user disconnected, etc.). The
          // last-pushed token will eventually expire and the next debate
          // will fail with a friendly error. Stop refreshing.
          clearOAuthRefresh();
          return;
        }
        const refreshed = await refreshTelegramBotCredentials(built.config);
        if (refreshed === null) {
          // Engine says bot isn't running. Stop refreshing.
          clearOAuthRefresh();
        }
      } catch {
        // Network blips and other transient errors are fine; the next
        // tick will retry. Don't surface to the UI; it would be noise.
      }
    }, OAUTH_REFRESH_INTERVAL_MS);
  }, [clearOAuthRefresh]);

  // Clear the interval on unmount so we don't leak when the user
  // navigates away from Settings.
  useEffect(() => () => clearOAuthRefresh(), [clearOAuthRefresh]);

  const refresh = useCallback(async () => {
    try {
      const s = await getTelegramBotStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  // Initial load: pull persisted config + current bot status.
  useEffect(() => {
    void (async () => {
      try {
        const existing = await getSecret(TELEGRAM_BOT_TOKEN_KEY);
        setHasStoredToken(Boolean(existing));
      } catch {
        setHasStoredToken(false);
      }
      try {
        const al = localStorage.getItem(TELEGRAM_ALLOWLIST_LS_KEY);
        if (al) setAllowlistText(al);
      } catch {
        // localStorage failures are non-fatal for this read.
      }
      try {
        const cap = localStorage.getItem(TELEGRAM_CAP_LS_KEY);
        if (cap) setCapText(cap);
      } catch {
        // non-fatal
      }
      try {
        const p = localStorage.getItem(TELEGRAM_PROVIDER_LS_KEY);
        if (p && BOT_PROVIDERS.some((bp) => bp.value === p)) {
          setBotProvider(p as BotProvider);
        }
      } catch {
        // non-fatal
      }
      void refresh();
    })();
  }, [refresh]);

  // Poll status every 4s while the panel is mounted so the spend counters
  // and polling pill stay current as messages arrive from Telegram.
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const onStart = useCallback(async () => {
    setError(null);
    const effectiveToken = token.trim() || (hasStoredToken
      ? (await getSecret(TELEGRAM_BOT_TOKEN_KEY)) ?? ''
      : '');
    if (!effectiveToken) {
      setError('Bot token is required. Paste the token from BotFather.');
      return;
    }
    const allowlist = parseAllowlist(allowlistText);
    if (allowlist.length === 0) {
      setError(
        'Allowlist is empty. Add at least one numeric Telegram user ID, one per line. Message /start to your bot to discover yours.',
      );
      return;
    }
    const cap = parseFloat(capText);
    if (!Number.isFinite(cap) || cap < 0) {
      setError('Daily cap must be a non-negative dollar amount.');
      return;
    }
    // v1.2: build provider_config with OAuth-awareness for OpenAI. For
    // other providers and the OpenAI API-key fallback, this resolves to
    // the same API-key shape v1.1 used.
    const built = await buildBotProviderConfig(botProvider);
    if (built === null) {
      const label =
        BOT_PROVIDERS.find((p) => p.value === botProvider)?.label ?? botProvider;
      const oauthHint =
        botProvider === 'openai'
          ? ' Either sign in with OpenAI OAuth in the LLM Providers tab, or paste an API key in the OpenAI API-key fallback row.'
          : ' Set one in the LLM Providers tab, or pick a different provider above.';
      setError(`No ${label} credentials configured.${oauthHint}`);
      return;
    }
    setBusy('starting');
    try {
      // Persist before starting so a restart picks up the same config.
      if (token.trim()) {
        await setSecret(TELEGRAM_BOT_TOKEN_KEY, token.trim());
        setHasStoredToken(true);
        setToken('');
      }
      try {
        localStorage.setItem(TELEGRAM_ALLOWLIST_LS_KEY, allowlistText.trim());
        localStorage.setItem(TELEGRAM_CAP_LS_KEY, capText.trim());
        localStorage.setItem(TELEGRAM_PROVIDER_LS_KEY, botProvider);
      } catch {
        // non-fatal; engine state remains the source of truth
      }
      const s = await startTelegramBot({
        token: effectiveToken,
        allowlist,
        daily_cap_usd: cap,
        provider_config: built.config,
      });
      setStatus(s);
      // Arm the refresh loop after the bot is confirmed running. The
      // first refresh fires OAUTH_REFRESH_INTERVAL_MS after start, which
      // is well within the typical 1hr OAuth lifetime.
      if (built.kind === 'oauth') {
        startOAuthRefresh(botProvider);
      } else {
        // Switched away from OAuth (or chose a non-OAuth provider on
        // restart). Make sure any prior refresh loop is gone.
        clearOAuthRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [token, hasStoredToken, allowlistText, capText, botProvider, startOAuthRefresh, clearOAuthRefresh]);

  const onStop = useCallback(async () => {
    setBusy('stopping');
    setError(null);
    try {
      const s = await stopTelegramBot();
      setStatus(s);
      clearOAuthRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [clearOAuthRefresh]);

  const polling = status?.polling ?? false;
  const spendEntries = Object.entries(status?.daily_spend_usd ?? {});
  const pending: TelegramPendingApproval[] = status?.pending_approvals ?? [];

  const onApprove = useCallback(async (chatId: number) => {
    setError(null);
    try {
      const s = await approveTelegramChat(chatId);
      setStatus(s);
      // Reflect the new allowlist member in the textarea so the user sees
      // the change without having to reload.
      setAllowlistText((prev) => {
        const lines = parseAllowlist(prev);
        if (lines.includes(chatId)) return prev;
        const next = [...lines, chatId].join('\n');
        try {
          localStorage.setItem(TELEGRAM_ALLOWLIST_LS_KEY, next);
        } catch {
          // non-fatal
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onDeny = useCallback(async (chatId: number) => {
    setError(null);
    try {
      const s = await denyTelegramChat(chatId);
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className={styles.phaseGuard} style={{ marginTop: 32 }}>
      <strong>Telegram Bot (bidirectional)</strong>
      <br />
      <br />
      Message the bot a ticker like <code>NVDA</code> from your phone and get
      a Diligence run back. The bot polls Telegram outbound, so nothing is
      exposed to the internet from your machine. Allowlist is required; the
      bot drops messages from anyone else silently. Per-chat daily spend
      cap prevents token-drain abuse if your bot token leaks.
      <br />
      <br />
      <em>
        Educational and research purposes only. The bot returns the same
        decision text the desktop app shows, with the same disclaimers.
      </em>

      {pending.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            border: '1px solid var(--color-accent)',
            borderRadius: 4,
          }}
          data-testid="telegram-pending-list"
        >
          <strong>Pending approval{pending.length > 1 ? 's' : ''}</strong>
          <p className={styles.hint} style={{ marginTop: 4 }}>
            Someone messaged <code>/start</code> to the bot. Approve to add
            them to the allowlist and let them trigger Diligence runs; the
            bot will DM them on approval. Deny silently drops the request.
            Entries expire automatically after 30 minutes.
          </p>
          <ul className={styles.list} style={{ marginTop: 10 }}>
            {pending.map((p) => (
              <li
                key={p.chat_id}
                className={styles.row}
                data-testid={`telegram-pending-${p.chat_id}`}
              >
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>
                    {p.first_name || '(no name)'}{' '}
                    {p.username && (
                      <span className={styles.pill}>@{p.username}</span>
                    )}
                    <span className={styles.pill}>chat {p.chat_id}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className={styles.actionPrimary}
                    onClick={() => void onApprove(p.chat_id)}
                    data-testid={`telegram-approve-${p.chat_id}`}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={styles.actionSecondary}
                    onClick={() => void onDeny(p.chat_id)}
                    data-testid={`telegram-deny-${p.chat_id}`}
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <label style={{ display: 'block' }}>
          <span className={styles.fieldLabel}>
            Bot Token{hasStoredToken ? ' (stored, leave blank to keep)' : ''}
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasStoredToken ? '••••••••' : 'paste from BotFather'}
            className={styles.input}
            spellCheck={false}
            autoComplete="off"
            data-testid="telegram-bot-token"
          />
        </label>

        <label style={{ display: 'block' }}>
          <span className={styles.fieldLabel}>
            LLM provider for bot-triggered debates
          </span>
          <select
            value={botProvider}
            onChange={(e) => setBotProvider(e.target.value as BotProvider)}
            className={styles.input}
            style={{ maxWidth: 240 }}
            data-testid="telegram-bot-provider"
          >
            {BOT_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <span className={styles.hint} style={{ marginTop: 4, display: 'block' }}>
            Uses the credential stored for this provider in the LLM Providers
            tab. For OpenAI, OAuth (Codex) is preferred when connected; an
            API key in the OpenAI fallback row is used otherwise. Default
            model: {botProvider === 'openai'
              ? `${BOT_PROVIDER_DEFAULT_MODEL.openai} (API key) or ${OPENAI_CODEX_DEFAULT_MODEL} (OAuth)`
              : BOT_PROVIDER_DEFAULT_MODEL[botProvider]}.
            Local runtimes are not yet supported for the bot.
          </span>
        </label>

        <label style={{ display: 'block' }}>
          <span className={styles.fieldLabel}>
            Allowlist (numeric chat IDs, one per line)
          </span>
          <textarea
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            placeholder={'12345678\n23456789'}
            className={styles.input}
            rows={3}
            spellCheck={false}
            data-testid="telegram-bot-allowlist"
          />
        </label>

        <label style={{ display: 'block' }}>
          <span className={styles.fieldLabel}>
            Daily cap per chat (USD)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={capText}
            onChange={(e) => setCapText(e.target.value)}
            className={styles.input}
            style={{ maxWidth: 120 }}
            data-testid="telegram-bot-cap"
          />
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {polling ? (
            <>
              <button
                type="button"
                className={styles.actionSecondary}
                onClick={onStop}
                disabled={busy !== null}
                data-testid="telegram-bot-stop"
              >
                {busy === 'stopping' ? 'Stopping…' : 'Stop bot'}
              </button>
              <span className={styles.pill} data-testid="telegram-bot-status">
                polling
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.actionPrimary}
                onClick={onStart}
                disabled={busy !== null}
                data-testid="telegram-bot-start"
              >
                {busy === 'starting' ? 'Starting…' : 'Save & Start'}
              </button>
              <span className={styles.pill} data-testid="telegram-bot-status">
                stopped
              </span>
            </>
          )}
          {status?.last_error && (
            <span className={styles.formError}>
              last error: {status.last_error}
            </span>
          )}
        </div>

        {error && <p className={styles.formError}>{error}</p>}

        {spendEntries.length > 0 && (
          <div className={styles.hint} style={{ marginTop: 8 }}>
            <strong>Today&apos;s spend (UTC):</strong>{' '}
            {spendEntries
              .map(
                ([cid, usd]) =>
                  `chat ${cid}: ${formatUsdShort(Number(usd))}`,
              )
              .join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

export default Settings;
