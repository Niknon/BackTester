import { useEffect } from 'react';
import { useSession } from './store/session';
import { TopNav } from './components/TopNav';
import { ReplayBar } from './components/ReplayBar';
import { Toasts } from './components/Toasts';
import { LoadingOverlay } from './components/LoadingOverlay';
import { SetupPage } from './pages/SetupPage';
import { TradePage } from './pages/TradePage';
import { OptionsPage } from './pages/OptionsPage';
import { BotsPage } from './pages/BotsPage';
import { AssetsPage } from './pages/AssetsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { StrategyLabPage } from './pages/StrategyLabPage';
import { MarketsPage } from './pages/MarketsPage';
import { stepBars, stepCandle, togglePlay } from './store/actions';
import { PositionsDrawer } from './components/positions/AllPositions';

function useHotkeys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!useSession.getState().ex) return;
      if (e.code === 'Escape' && useSession.getState().positionsOpen) {
        useSession.setState({ positionsOpen: false });
        return;
      }
      if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        useSession.setState((s) => ({ positionsOpen: !s.positionsOpen }));
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        // не «нажимать» повторно кнопку, на которой остался фокус (например, «Купить»)
        if (t && t.tagName === 'BUTTON') t.blur();
        togglePlay();
      } else if (e.code === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        stepCandle();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepBars(1);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

export function App() {
  const page = useSession((s) => s.page);
  const hasEx = useSession((s) => !!s.ex);
  useHotkeys();
  const showSetup = page === 'setup' || !hasEx;
  return (
    <div className="h-full flex flex-col min-w-[1100px]">
      <TopNav />
      {hasEx && !showSetup && <ReplayBar />}
      <main className="flex-1 min-h-0 overflow-hidden">
        {showSetup ? (
          <SetupPage />
        ) : page === 'markets' ? (
          <MarketsPage />
        ) : page === 'trade' ? (
          <TradePage category="linear" />
        ) : page === 'spot' ? (
          <TradePage category="spot" />
        ) : page === 'options' ? (
          <OptionsPage />
        ) : page === 'bots' ? (
          <BotsPage />
        ) : page === 'assets' ? (
          <AssetsPage />
        ) : page === 'analytics' ? (
          <AnalyticsPage />
        ) : page === 'lab' ? (
          <StrategyLabPage />
        ) : null}
      </main>
      <PositionsDrawer />
      <LoadingOverlay />
      <Toasts />
    </div>
  );
}
