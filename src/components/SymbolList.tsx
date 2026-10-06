import { useMemo, useState } from 'react';
import { ASSETS, getAsset, optionsAvailable, registerUsStock, SECTOR_LABEL, type AssetSpec } from '../data/assets';
import { DAY } from '../data/intervals';
import { ensureSymbol } from '../store/actions';
import { toast, useSession, useTick } from '../store/session';
import { fmtPct, fmtPrice } from '../lib/format';
import { cx, usePersistent } from './ui';

type Tab = 'loaded' | 'crypto' | 'tradfi' | 'xstock' | 'options' | 'all';

/** Похоже ли на тикер американской акции (для добавления через Yahoo). */
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function badge(a: AssetSpec) {
  if (a.group === 'tradfi') return a.sector === 'commodity' ? 'СЫРЬЁ' : a.sector === 'index' ? 'ИНДЕКС' : a.sector === 'etf' ? 'ETF' : 'АКЦИЯ';
  if (a.group === 'xstock') return 'xStock';
  if (a.group === 'commodity') return 'ЗОЛОТО';
  return '';
}

/**
 * Список инструментов с поиском и группами. Незагруженный символ догружается при выборе.
 * Если введён тикер, которого нет в каталоге, — можно добавить любую акцию/ETF США (история с Yahoo Finance).
 */
export function SymbolList({
  value,
  onPick,
  close,
  spot = false,
  optionsOnly = false,
  storeKey,
}: {
  value?: string;
  onPick: (symbol: string) => void;
  close: () => void;
  /** спотовый рынок: xStocks и золото доступны, а перпетуалы показываются как спот-пары */
  spot?: boolean;
  optionsOnly?: boolean;
  /** ключ для запоминания вкладки */
  storeKey: string;
}) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const loading = useSession((s) => s.loadingSymbols);
  const [q, setQ] = useState('');
  const tabs: [Tab, string][] = spot
    ? [
        ['loaded', 'Загруженные'],
        ['crypto', 'Крипто'],
        ['xstock', 'xStocks / золото'],
        ['all', 'Все'],
      ]
    : [
        ['loaded', 'Загруженные'],
        ['crypto', 'Крипто'],
        ['tradfi', 'Акции и TradFi'],
        ['options', 'С опционами'],
        ['all', 'Все'],
      ];
  const [tab, setTab] = usePersistent<Tab>(`bt-symlist-${storeKey}`, 'loaded', tabs.map((t) => t[0]));
  const qq = q.trim().toUpperCase();
  const list = useMemo(() => {
    const extra = ex.market.symbols().filter((s) => !ASSETS.some((a) => a.symbol === s)).map(getAsset);
    let l = [...ASSETS, ...extra];
    if (!spot) l = l.filter((a) => !a.spotOnly);
    if (optionsOnly) l = l.filter(optionsAvailable);
    // при поиске ищем по всем вкладкам
    if (!qq) {
      if (tab === 'loaded') l = l.filter((a) => ex.market.has(a.symbol));
      if (tab === 'crypto') l = l.filter((a) => a.group === 'crypto');
      if (tab === 'tradfi') l = l.filter((a) => a.group === 'tradfi');
      if (tab === 'xstock') l = l.filter((a) => a.group === 'xstock' || a.group === 'commodity');
      if (tab === 'options') l = l.filter(optionsAvailable);
    } else l = l.filter((a) => a.symbol.includes(qq) || a.base === qq || a.name.toUpperCase().includes(qq) || a.underlying === qq || a.yahoo === qq);
    // загруженные — первыми
    return [...l].sort((a, b) => Number(ex.market.has(b.symbol)) - Number(ex.market.has(a.symbol)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qq, tab, ex, spot, optionsOnly, loading.length, ASSETS.length]);
  const canAddStock = !spot && TICKER_RE.test(qq) && !ASSETS.some((a) => a.base === qq.replace(/[^A-Z0-9]/g, '') || a.yahoo === qq);

  const pick = async (sym: string) => {
    close();
    if (!ex.market.has(sym)) {
      const ok = await ensureSymbol(sym);
      if (!ok) return;
    }
    onPick(sym);
  };
  const addStock = async () => {
    const spec = registerUsStock(qq);
    toast('info', `Добавлена акция ${qq}`, 'Торгуется как USDT-перпетуал в симуляторе; реальная история — с Yahoo Finance', 4000);
    await pick(spec.symbol);
  };

  const row = (a: AssetSpec) => {
    const loaded = ex.market.has(a.symbol);
    const px = loaded ? ex.price(a.symbol) : NaN;
    const prev = loaded ? ex.market.closeAgo(a.symbol, ex.now, DAY) : undefined;
    const ch = prev ? px / prev - 1 : NaN;
    const b = badge(a);
    return (
      <button key={a.symbol} className={cx('w-full grid grid-cols-[1fr_auto_64px] gap-2 items-center px-2 py-1 text-left rounded hover:bg-panel3', a.symbol === value && 'bg-panel2')} onClick={() => pick(a.symbol)}>
        <span className="min-w-0">
          <span className="font-semibold">{a.symbol}</span>
          {a.hasOptions && <span className="ml-1.5 text-[9px] text-brand">OPT</span>}
          {b && <span className="ml-1 text-[9px] text-info">{b}</span>}
          <span className="block text-[10px] text-dim truncate">
            {a.name}
            {a.spotOnly ? ' · спот' : spot ? '' : ` · до ${a.maxLeverage}x`}
          </span>
        </span>
        <span className="num text-right text-[12px]">{loaded ? fmtPrice(px, a.symbol) : ''}</span>
        <span className="text-right text-[10px]">
          {loading.includes(a.symbol) ? (
            <span className="text-brand">загрузка…</span>
          ) : loaded ? (
            <span className={cx('num', ch >= 0 ? 'text-up' : 'text-down')}>{Number.isFinite(ch) ? fmtPct(ch) : ''}</span>
          ) : (
            <span className="text-muted">↓ загрузить</span>
          )}
        </span>
      </button>
    );
  };

  // вкладка TradFi — по разделам
  const grouped = !qq && tab === 'tradfi';
  return (
    <div className="flex flex-col">
      <div className="p-2">
        <input
          autoFocus
          className="field w-full"
          placeholder={spot ? 'Поиск: монета или акция (AAPLX, золото…)' : 'Поиск: BTC, AAPL, золото… или любой тикер США'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (list[0]) pick(list[0].symbol);
              else if (canAddStock) addStock();
            }
          }}
        />
      </div>
      <div className="flex gap-1 px-2 pb-1 flex-wrap">
        {tabs.map(([k, l]) => (
          <button key={k} className={cx('chip', !qq && tab === k && 'active')} onClick={() => (setTab(k), setQ(''))}>
            {l}
          </button>
        ))}
      </div>
      <div className="max-h-[420px] overflow-auto px-1 pb-1">
        {canAddStock && (
          <button className="w-full text-left px-2 py-2 rounded border border-dashed border-brand/50 text-brand hover:bg-brand/10 mb-1" onClick={addStock}>
            ＋ Добавить акцию / ETF США «{qq}» — история с Yahoo Finance
          </button>
        )}
        {grouped
          ? (['stock', 'etf', 'index', 'commodity'] as const).map((sec) => {
              const items = list.filter((a) => a.sector === sec);
              if (!items.length) return null;
              return (
                <div key={sec}>
                  <div className="text-[10px] text-muted px-2 pt-1.5 pb-0.5">{SECTOR_LABEL[sec]}</div>
                  {items.map(row)}
                </div>
              );
            })
          : list.map(row)}
        {!list.length && !canAddStock && <div className="text-dim text-center py-6">Ничего не найдено</div>}
        {!spot && !qq && (
          <div className="text-[10px] text-dim px-2 pt-2">Нет нужной акции? Введите её тикер (например DIS, KO, ARKK) — она добавится с историей Yahoo Finance.</div>
        )}
      </div>
    </div>
  );
}
