import { useCallback, useEffect, useState } from 'react';
import styles from './UpdatesSection.module.css';

/**
 * Auto-update controls (Phase 7c.4): a toggle for the automatic check (default
 * on), a manual "Check for updates" button, and a live status line. The actual
 * update flow only works in a packaged build (and once releases are published);
 * in dev `supported` is false and the control explains that.
 */

// Local shapes, structurally compatible with the (module-scoped) bridge types
// in vite-env.d.ts. Components can't name those directly, so we mirror them.
interface UpdatesState {
  autoUpdate: boolean;
  currentVersion: string;
  supported: boolean;
}
interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'dev';
  version?: string;
  percent?: number;
  message?: string;
}

function statusLabel(status: UpdateStatus | null, supported: boolean): string {
  if (!supported) return 'Updates apply to the installed app (not this dev build).';
  switch (status?.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update available${status.version ? ` (v${status.version})` : ''}, downloading…`;
    case 'downloading':
      return `Downloading update… ${status.percent ?? 0}%`;
    case 'downloaded':
      return `Update ready${status.version ? ` (v${status.version})` : ''}. It installs when you quit.`;
    case 'not-available':
      return 'You are on the latest version.';
    case 'error':
      return `Update check failed${status.message ? `: ${status.message}` : ''}.`;
    case 'dev':
      return 'Updates apply to the installed app (not this dev build).';
    default:
      return '';
  }
}

export default function UpdatesSection() {
  const [state, setState] = useState<UpdatesState | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.tradingAgentsLab.updates
      .getState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        /* leave state null; toggle stays at the default-checked display */
      });
    const unsub = window.tradingAgentsLab.updates.onStatus((s) => setStatus(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const onToggle = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const enabled = e.target.checked;
      await window.tradingAgentsLab.updates.setAuto(enabled);
      setState((prev) => (prev ? { ...prev, autoUpdate: enabled } : prev));
    },
    [],
  );

  const onCheck = useCallback(async () => {
    setBusy(true);
    try {
      await window.tradingAgentsLab.updates.check();
    } finally {
      setBusy(false);
    }
  }, []);

  const onInstall = useCallback(() => {
    // Explicit, reliable install. The in-app Restart / Shut down do NOT apply an
    // update; this calls quitAndInstall in main.
    void window.tradingAgentsLab.updates.install();
  }, []);

  const supported = state?.supported ?? false;
  const downloaded = status?.state === 'downloaded';
  const label = statusLabel(status, supported);

  return (
    <div className={styles.section}>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={state?.autoUpdate ?? true}
          onChange={onToggle}
          disabled={!state}
        />
        <span>Automatically check for updates</span>
      </label>
      <p className={styles.hint}>
        The app checks our GitHub releases for a newer version. This is the only
        update-related network call, it sends no information about you, and you
        can turn it off here.
      </p>
      <div className={styles.actions}>
        {downloaded ? (
          <button type="button" onClick={onInstall} className={styles.installBtn}>
            Restart &amp; install{status?.version ? ` v${status.version}` : ''}
          </button>
        ) : (
          <button
            type="button"
            onClick={onCheck}
            disabled={busy || !supported}
            className={styles.checkBtn}
          >
            {busy ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {label && <span className={styles.status}>{label}</span>}
      </div>
    </div>
  );
}
