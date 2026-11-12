import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Watchlist.module.css';
import {
  addWatchlist,
  listWatchlist,
  removeWatchlist,
  type WatchlistEntry,
} from '../lib/engine-client';
import { setPendingTicker } from '../lib/handoff';
import BatchRunner from '../components/BatchRunner';

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Watchlist() {
  const [entries, setEntries] = useState<WatchlistEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const tickerInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const rows = await listWatchlist();
      setEntries(rows);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load watchlist');
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cleaned = tickerInput.trim().toUpperCase();
      if (!cleaned) {
        setFormError('Enter a ticker symbol');
        return;
      }
      if (cleaned.length > 8) {
        setFormError('Ticker must be 8 characters or fewer');
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const newEntry = await addWatchlist({
          ticker: cleaned,
          note: noteInput.trim() || undefined,
        });
        setEntries((prev) => [newEntry, ...(prev ?? [])]);
        setTickerInput('');
        setNoteInput('');
        tickerInputRef.current?.focus();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'add failed');
      } finally {
        setBusy(false);
      }
    },
    [tickerInput, noteInput],
  );

  const onRemove = useCallback(
    async (ticker: string) => {
      if (!confirm(`Remove ${ticker} from the watchlist?`)) return;
      setBusy(true);
      try {
        await removeWatchlist(ticker);
        setEntries((prev) => (prev ?? []).filter((e) => e.ticker !== ticker));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'remove failed');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onAnalyze = useCallback((ticker: string) => {
    setPendingTicker(ticker);
    window.location.hash = '#analyze';
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Watchlist</h1>
        <p className={styles.pageSubtitle}>
          Tickers you want to keep an eye on. Click <strong>Analyze</strong> on any
          row to drop into the Analyze page with the ticker pre-filled, then run
          a debate on today's data.
        </p>
      </header>

      <form className={styles.addCard} onSubmit={onAdd}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="watchlist-ticker">Ticker</label>
            <input
              id="watchlist-ticker"
              ref={tickerInputRef}
              className={styles.input}
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
              placeholder="NVDA"
              maxLength={8}
              disabled={busy}
              autoFocus
              data-testid="watchlist-ticker-input"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="watchlist-note">
              Note <span className={styles.optional}>(optional)</span>
            </label>
            <input
              id="watchlist-note"
              className={styles.input}
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="watch earnings on the 23rd"
              maxLength={200}
              disabled={busy}
            />
          </div>
          <div className={styles.fieldButton}>
            <button
              type="submit"
              className={styles.addButton}
              disabled={busy || !tickerInput.trim()}
              data-testid="watchlist-add-button"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
        {formError && <p className={styles.formError}>{formError}</p>}
      </form>

      {loadError && <div className={styles.errorBanner}>{loadError}</div>}

      {entries && entries.length > 0 && (
        <BatchRunner tickers={entries.map((e) => e.ticker)} />
      )}

      {entries === null && !loadError && (
        <div className={styles.placeholder}>Loading watchlist…</div>
      )}

      {entries && entries.length === 0 && !loadError && (
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>Empty watchlist</h2>
          <p className={styles.emptyBody}>
            Add a ticker above to track it. The watchlist is local: it lives in{' '}
            <code className={styles.code}>sessions.db</code> on this computer and never leaves
            your machine.
          </p>
        </div>
      )}

      {entries && entries.length > 0 && (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li
              key={entry.ticker}
              className={styles.row}
              data-testid={`watchlist-row-${entry.ticker}`}
            >
              <div className={styles.rowMain}>
                <div className={styles.rowHeadline}>
                  <span className={styles.rowTicker}>{entry.ticker}</span>
                  <span className={styles.rowAdded}>
                    Added {formatRelative(entry.added_at)}
                  </span>
                </div>
                {entry.note && <p className={styles.rowNote}>{entry.note}</p>}
              </div>
              <div className={styles.rowActions}>
                <button
                  className={styles.actionPrimary}
                  onClick={() => onAnalyze(entry.ticker)}
                  disabled={busy}
                  type="button"
                >
                  Analyze
                </button>
                <button
                  className={styles.actionRemove}
                  onClick={() => void onRemove(entry.ticker)}
                  disabled={busy}
                  type="button"
                  aria-label={`Remove ${entry.ticker} from watchlist`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Watchlist;
