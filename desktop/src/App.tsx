import { useCallback, useEffect, useState } from 'react';
import Analyze from './pages/Analyze';
import Settings from './pages/Settings';
import History from './pages/History';
import Watchlist from './pages/Watchlist';
import LearnAI from './pages/LearnAI';
import StatusStrip from './components/StatusStrip';
import { UpstreamCheckModal } from './components/UpstreamCheckModal';
import { checkUpstream, type UpstreamCheckResult } from './lib/upstream';
import styles from './App.module.css';

type Route = 'analyze' | 'watchlist' | 'history' | 'learn' | 'settings';

const ROUTES: Route[] = ['analyze', 'watchlist', 'history', 'learn', 'settings'];

function parseHash(hash: string): Route {
  const cleaned = hash.replace(/^#/, '') as Route;
  return ROUTES.includes(cleaned) ? cleaned : 'analyze';
}

function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [newAnalysisTick, setNewAnalysisTick] = useState(0);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  /** Upstream-check modal state. null = closed; "checking" = in flight;
   * UpstreamCheckResult once the IPC round-trip returns. */
  const [upstreamModal, setUpstreamModal] = useState<
    'checking' | UpstreamCheckResult | null
  >(null);

  const runUpstreamCheck = useCallback(async () => {
    setUpstreamModal('checking');
    try {
      const result = await checkUpstream();
      setUpstreamModal(result);
    } catch (err) {
      setUpstreamModal({
        status: 'error',
        latestTag: '',
        upstreamHead: '',
        ourHead: '',
        behindCount: 0,
        aheadCount: 0,
        behindCommits: [],
        checkedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        compareUrl: 'https://github.com/TauricResearch/TradingAgents',
      });
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // App menu accelerators come in via IPC.
  useEffect(() => {
    const bridge = window.tradingAgentsLab;
    if (!bridge?.onMenuCommand) return;
    const unsubNav = bridge.onMenuCommand('menu:navigate', (...args: unknown[]) => {
      const target = args[0];
      if (typeof target === 'string' && ROUTES.includes(target as Route)) {
        window.location.hash = `#${target}`;
      }
    });
    const unsubNew = bridge.onMenuCommand('menu:new-analysis', () => {
      window.location.hash = '#analyze';
      setNewAnalysisTick((n) => n + 1);
    });
    const unsubUpstream = bridge.onMenuCommand('menu:check-upstream', () => {
      void runUpstreamCheck();
    });
    return () => {
      unsubNav();
      unsubNew();
      unsubUpstream();
    };
  }, [runUpstreamCheck]);

  // Expose the trigger globally so Settings → About can call it without
  // prop-drilling. Slightly hacky vs proper context but cheap and contained.
  useEffect(() => {
    (window as unknown as { __talCheckUpstream?: () => void }).__talCheckUpstream =
      () => void runUpstreamCheck();
    return () => {
      delete (window as unknown as { __talCheckUpstream?: () => void }).__talCheckUpstream;
    };
  }, [runUpstreamCheck]);

  // Close the app menu on Escape or click outside.
  useEffect(() => {
    if (!appMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAppMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.appMenuWrapper}`)) {
        setAppMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [appMenuOpen]);

  const navItem = (target: Route, label: string) => {
    const active = route === target;
    return (
      <a
        className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
        href={`#${target}`}
        data-testid={`nav-${target}`}
        data-active={active ? 'true' : 'false'}
      >
        <span className={styles.navItemDot} />
        {label}
      </a>
    );
  };

  return (
    <div className={styles.shell}>
      <header className={`${styles.titleBar} app-drag-region`}>
        <div className={styles.titleBarContent}>
          <span className={styles.brand}>
            <span className={styles.brandMark}>◆</span>
            <span className={styles.brandText}>Trading Agents Lab</span>
          </span>
          <div className={styles.titleBarRight}>
            <span className={styles.connectionPill}>Standalone</span>
            <div className={`${styles.appMenuWrapper} app-no-drag`}>
              <button
                type="button"
                className={`${styles.titleBarButton} ${appMenuOpen ? styles.titleBarButtonActive : ''}`}
                onClick={() => setAppMenuOpen((open) => !open)}
                title="App actions: Restart or Shut down"
                aria-label="App actions"
                aria-haspopup="menu"
                aria-expanded={appMenuOpen}
              >
                ⏻
              </button>
              {appMenuOpen && (
                <div className={styles.appMenu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.appMenuItem}
                    onClick={() => {
                      setAppMenuOpen(false);
                      window.tradingAgentsLab?.restart?.();
                    }}
                  >
                    <span className={styles.appMenuIcon}>↻</span>
                    <span className={styles.appMenuLabel}>Restart</span>
                    <span className={styles.appMenuHint}>Relaunch with a fresh engine</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${styles.appMenuItem} ${styles.appMenuItemDanger}`}
                    onClick={() => {
                      setAppMenuOpen(false);
                      window.tradingAgentsLab?.shutdown?.();
                    }}
                  >
                    <span className={styles.appMenuIcon}>⏻</span>
                    <span className={styles.appMenuLabel}>Shut down</span>
                    <span className={styles.appMenuHint}>Stop engine and quit</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className={`${styles.statusStripRow} app-no-drag`}>
        <StatusStrip />
      </div>

      <nav className={`${styles.sidebar} app-no-drag`}>
        {navItem('analyze', 'Analyze')}
        {navItem('watchlist', 'Watchlist')}
        {navItem('history', 'History')}
        {navItem('learn', 'Learn AI')}
        <div className={styles.navSpacer} />
        {navItem('settings', 'Settings')}
      </nav>

      <main className={`${styles.main} app-no-drag`}>
        {/* Analyze stays mounted (hide-don't-unmount) so an in-flight
            debate's WebSocket survives navigation. Founder ask 2026-05-17:
            "user may have to start the analysis and then go to their
            watchlist or history and then come back to analysis." Pre-fix,
            Analyze unmount closed the WS and engine aborted mid-stream.

            The other three pages keep their original mount/unmount
            behaviour so their on-mount fetches re-run on each visit. */}
        <div style={{ display: route === 'analyze' ? 'contents' : 'none' }}>
          <Analyze resetSignal={newAnalysisTick} />
        </div>
        {route === 'watchlist' && <Watchlist />}
        {route === 'history' && <History />}
        {route === 'learn' && <LearnAI />}
        {route === 'settings' && <Settings />}
      </main>

      {upstreamModal !== null && (
        <UpstreamCheckModal
          state={upstreamModal}
          onDismiss={() => setUpstreamModal(null)}
        />
      )}

      <footer className={styles.footer}>
        <span>Trading Agents Lab v1.0.0 · AGPL-3.0</span>
        <span className={styles.footerRight}>
          Educational research only · Not a registered investment advisor · Not investment advice
        </span>
      </footer>
    </div>
  );
}

export default App;
