import { useEffect, useState } from 'react';
import styles from './ConsentGate.module.css';

/**
 * First-launch consent gate (Phase 7c.3). Blocks the app until the user accepts
 * the educational-use / not-financial-advice agreement. No account, no signup:
 * acceptance is recorded locally (main-process `consent` bridge) and the user
 * is re-prompted only when the agreement version bumps. Decline quits the app.
 *
 * Wrap the app shell: <ConsentGate>{appContent}</ConsentGate>. Children render
 * only once consent for the current version is on record.
 */
type Status = 'loading' | 'needed' | 'ok';

export default function ConsentGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.tradingAgentsLab.consent
      .get()
      .then((s) => {
        if (cancelled) return;
        setStatus(s.acceptedVersion === s.requiredVersion ? 'ok' : 'needed');
      })
      .catch(() => {
        // Fail safe: if we can't read consent state, show the gate rather
        // than letting someone through unprompted.
        if (!cancelled) setStatus('needed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Brief: avoids flashing either the app or the gate before we know the state.
  if (status === 'loading') return null;
  if (status === 'ok') return <>{children}</>;

  const onAgree = async () => {
    setBusy(true);
    try {
      await window.tradingAgentsLab.consent.accept();
      setStatus('ok');
    } catch {
      setBusy(false); // let them try again
    }
  };

  const onDecline = () => {
    setBusy(true);
    void window.tradingAgentsLab.consent.decline(); // main quits the app
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className={styles.card}>
        <h1 id="consent-title" className={styles.title}>Before you begin</h1>
        <div className={styles.body}>
          <p>
            <strong>Trading Agents Lab is an educational research tool, not financial advice.</strong>{' '}
            It uses multi-agent LLM analysis to surface multiple perspectives on a ticker. The
            analysis can be wrong or incomplete. Any decision you make is your own.
          </p>
          <p>
            This app is for personal, educational use. It is free and open source (AGPL-3.0) and is
            provided without warranty of any kind.
          </p>
          <p>
            <strong>Zero data collection.</strong> Nothing about you leaves your machine. The only
            outbound calls the app initiates are an optional update check and the data and LLM
            providers you configure with your own keys.
          </p>
          <p className={styles.links}>
            Full terms:{' '}
            <a href="https://tradingagentslab.ai/legal/terms" target="_blank" rel="noreferrer">Terms</a>,{' '}
            <a href="https://tradingagentslab.ai/legal/privacy" target="_blank" rel="noreferrer">Privacy</a>,{' '}
            <a href="https://tradingagentslab.ai/legal/disclaimer" target="_blank" rel="noreferrer">Disclaimer</a>.
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.decline}
            onClick={onDecline}
            disabled={busy}
          >
            Decline and Quit
          </button>
          <button
            type="button"
            className={styles.agree}
            onClick={onAgree}
            disabled={busy}
          >
            I Agree
          </button>
        </div>
      </div>
    </div>
  );
}
