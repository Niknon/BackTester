import { useMemo, useState } from 'react';
import { ASSETS, getAsset, kindLabel } from '../../data/assets';
import { DAY } from '../../data/intervals';
import { ensureSymbol } from '../../store/actions';
import { useSession, useTick } from '../../store/session';
import { fmtPct, fmtPrice } from '../../lib/format';
import { cx, Dropdown } from '../ui';

type SelTab = 'loaded' | 'all' | 'options' | 'crypto' | 'xstock' | 'tradfi';

export function SymbolSelector({
  symbol,
  onSelect,
  optionsOnly,
  spot,
}: {
  symbol: string;
  onSelect: (s: string) => void;
  optionsOnly?: boolean;
  /** спотовый рынок: доступны xStocks и токены золота; иначе — только перпетуалы */
  spot?: boolean;
}) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const loading = useSession((s) => s.loadingSymbols);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<SelTab>('loaded');
  const list = useMemo(() => {
    let l = ASSETS;
    if (!spot) l = l.filter((a) => !a.spotOnly);
    if (optionsOnly || tab === 'options') l = l.filter((a) => a.hasOptions);
    if (tab === 'crypto') l = l.filter((a) => a.group === 'crypto');
    if (tab === 'tradfi') l = l.filter((a) => a.group === 'tradfi');
    if (tab === 'xstock') l = l.filter((a) => a.group === 'xstock' || a.group === 'commodity');
    if (tab === 'loaded') l = l.filter((a) => ex.market.has(a.symbol));
    const extra = ex.market
      .symbols()
      .filter((s) => !ASSETS.some((a) => a.symbol === s))
      .map(getAsset)
      .filter((a) => spot || !a.spotOnly);
    if (tab === 'loaded' || tab === 'all') l = [...l, ...extra.filter((a) => !l.includes(a))];
    const qq = q.trim().toUpperCase();
    return qq ? l.filter((a) => a.symbol.includes(qq) || a.name.toUpperCase().includes(qq) || a.underlying === qq) : l;
  }, [q, tab, ex, optionsOnly, spot, loading.length]);
  const spec = getAsset(symbol);
  const tabs: [SelTab, string][] = spot
    ? [
        ['loaded', 'Загруженные'],
        ['crypto', 'Крипто'],
        ['xstock', 'xStocks / золото'],
        ['all', 'Все'],
      ]
    : [
        ['loaded', 'Загруженные'],
        ['crypto', 'Крипто'],
        ['tradfi', 'TradFi'],
        ['options', 'С опционами'],
        ['all', 'Все'],
      ];
  return (
    <Dropdown
      width={420}
      button={
        <button className="flex items-center gap-2 hover:bg-panel3 rounded-md px-2 py-1">
          <span className="w-6 h-6 rounded-full bg-brand/20 text-brand text-[10px] font-bold flex items-center justify-center">{spec.base.slice(0, 3)}</span>
          <div className="text-left leading-tight">
            <div className="font-bold text-[15px]">{symbol}</div>
            <div className="text-[10px] text-muted">{spot && !spec.spotOnly ? 'Спот' : kindLabel(spec)} · {spec.name}</div>
          </div>
          <span className="text-muted">▾</span>
        </button>
      }
    >
      {(close: () => void) => (
        <div className="flex flex-col">
          <div className="p-2">
            <input autoFocus className="field w-full" placeholder={spot ? 'Поиск: монета или акция (AAPL, TSLA…)' : 'Поиск монеты…'} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex gap-1 px-2 pb-1">
            {tabs.map(([k, l]) => (
              <button key={k} className={cx('chip', tab === k && 'active')} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Символ</th>
                  <th className="text-right">Цена</th>
                  <th className="text-right">24ч</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const loaded = ex.market.has(a.symbol);
                  const px = loaded ? ex.price(a.symbol) : NaN;
                  const prev = loaded ? ex.market.closeAgo(a.symbol, ex.now, DAY) : undefined;
                  const ch = prev ? px / prev - 1 : NaN;
                  const isLoading = loading.includes(a.symbol);
                  return (
                    <tr
                      key={a.symbol}
                      className={cx('cursor-pointer', a.symbol === symbol && 'bg-panel2')}
                      onClick={async () => {
                        if (!loaded) {
                          close();
                          const ok = await ensureSymbol(a.symbol);
                          if (ok) onSelect(a.symbol);
                          return;
                        }
                        onSelect(a.symbol);
                        close();
                      }}
                    >
                      <td>
                        <span className="font-semibold">{a.symbol}</span>
                        {a.hasOptions && <span className="ml-1.5 text-[9px] text-brand">OPT</span>}
                        {a.group === 'tradfi' && <span className="ml-1 text-[9px] text-info">{a.sector === 'commodity' ? 'COMMODITY' : a.sector === 'index' ? 'INDEX' : a.sector === 'etf' ? 'ETF' : 'STOCK'}</span>}
                        {a.group === 'xstock' && <span className="ml-1 text-[9px] text-info">xStock</span>}
                        {a.group === 'commodity' && <span className="ml-1 text-[9px] text-brand">GOLD</span>}
                        <div className="text-[10px] text-dim">
                          {a.name}
                          {a.spotOnly ? ' · спот' : spot ? '' : ` · до ${a.maxLeverage}x`}
                        </div>
                      </td>
                      <td className="text-right num">{loaded ? fmtPrice(px, a.symbol) : '—'}</td>
                      <td className={cx('text-right num', ch >= 0 ? 'text-up' : 'text-down')}>{Number.isFinite(ch) ? fmtPct(ch) : ''}</td>
                      <td className="text-right text-[10px]">
                        {isLoading ? <span className="text-brand">загрузка…</span> : loaded ? '' : <span className="text-muted">↓ загрузить</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dropdown>
  );
}
