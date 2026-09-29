import { useSession, useTick, type Page } from '../store/session';
import { saveSession } from '../store/actions';
import { cx } from './ui';
import { fmtUsd, pnlClass, fmtPct } from '../lib/format';

const NAV: { page: Page; label: string }[] = [
  { page: 'trade', label: 'Деривативы' },
  { page: 'spot', label: 'Спот' },
  { page: 'options', label: 'Опционы' },
  { page: 'bots', label: 'Торговые боты' },
  { page: 'lab', label: 'Стратегии' },
  { page: 'assets', label: 'Активы' },
  { page: 'analytics', label: 'Аналитика' },
];

function Logo() {
  return (
    <div className="flex items-center gap-2 pr-4 select-none">
      <svg width="26" height="26" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="7" fill="#f7a600" />
        <path d="M8 22 L13 14 L17 18 L24 9" stroke="#101014" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="leading-tight">
        <div className="font-bold text-[14px] tracking-wide">
          BACK<span className="text-brand">TESTER</span>
        </div>
        <div className="text-[9px] text-dim -mt-0.5">симулятор биржи на истории</div>
      </div>
    </div>
  );
}

function EquityBadge() {
  useTick();
  const ex = useSession((s) => s.ex);
  if (!ex) return null;
  const eq = ex.totalEquity();
  const base = ex.config.initialBalance;
  const pnl = eq.total - base;
  return (
    <div className="flex items-center gap-4 text-right">
      <div>
        <div className="text-[10px] text-muted">Общий капитал</div>
        <div className="num font-semibold">{fmtUsd(eq.total)} USDT</div>
      </div>
      <div>
        <div className="text-[10px] text-muted">PnL сессии</div>
        <div className={cx('num font-semibold', pnlClass(pnl))}>
          {fmtUsd(pnl, 2, true)} ({fmtPct(pnl / base)})
        </div>
      </div>
    </div>
  );
}

export function TopNav() {
  const page = useSession((s) => s.page);
  const hasEx = useSession((s) => !!s.ex);
  const set = useSession((s) => s.set);
  const savedAt = useSession((s) => s.savedAt);
  return (
    <header className="h-12 flex items-center px-4 border-b border-line bg-panel shrink-0 gap-2">
      <Logo />
      {hasEx &&
        NAV.map((n) => (
          <button
            key={n.page}
            onClick={() => set({ page: n.page })}
            className={cx('px-3 h-12 text-[13px] border-b-2 transition-colors', page === n.page ? 'border-brand text-text font-semibold' : 'border-transparent text-muted hover:text-text')}
          >
            {n.label}
          </button>
        ))}
      <div className="ml-auto flex items-center gap-3">
        {hasEx && <EquityBadge />}
        {hasEx && (
          <button className="btn btn-ghost btn-sm" onClick={() => saveSession()} title={savedAt ? `Сохранено ${new Date(savedAt).toLocaleTimeString('ru-RU')}` : 'Сохранить сессию в браузере'}>
            💾 Сохранить
          </button>
        )}
        <button className={cx('btn btn-sm', page === 'setup' || !hasEx ? 'btn-brand' : 'btn-ghost')} onClick={() => set({ page: 'setup' })}>
          ⚙ Сессии
        </button>
      </div>
    </header>
  );
}
