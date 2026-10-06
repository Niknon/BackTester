import { useMemo, useState } from 'react';
import { ASSETS, getAsset, optionsAvailable } from '../data/assets';
import { DAY } from '../data/intervals';
import { lowerBound } from '../data/types';
import { realizedVolAt } from '../data/volatility';
import { ensureSymbol } from '../store/actions';
import { useSession, useTick } from '../store/session';
import { fmtNum, fmtPct, fmtPrice, pnlClass } from '../lib/format';
import { Badge, cx, Segmented, Sparkline, usePersistent } from '../components/ui';

type SortKey = 'symbol' | 'change' | 'turnover' | 'vol' | 'funding';

export function MarketsPage() {
  const v = useTick();
  const ex = useSession((s) => s.ex)!;
  const set = useSession((s) => s.set);
  const loading = useSession((s) => s.loadingSymbols);
  const [group, setGroup] = usePersistent<'all' | 'options' | 'crypto' | 'tradfi' | 'xstock'>('bt-markets-group', 'all', ['all', 'options', 'crypto', 'tradfi', 'xstock']);
  const [sort, setSort] = useState<SortKey>('turnover');
  const [q, setQ] = useState('');
  const slow = Math.floor(v / 5);
  const rows = useMemo(() => {
    const list = [...ASSETS, ...ex.market.symbols().filter((s) => !ASSETS.some((a) => a.symbol === s)).map(getAsset)];
    return list
      .filter((a) =>
        group === 'options'
          ? a.hasOptions
          : group === 'crypto'
            ? a.group === 'crypto'
            : group === 'tradfi'
              ? a.group === 'tradfi'
              : group === 'xstock'
                ? a.group === 'xstock' || a.group === 'commodity'
                : true,
      )
      .filter((a) => !q || a.symbol.includes(q.toUpperCase()) || a.name.toUpperCase().includes(q.toUpperCase()) || a.underlying === q.toUpperCase())
      .map((a) => {
        const loaded = ex.market.has(a.symbol);
        if (!loaded) return { a, loaded };
        const s = ex.market.series.get(a.symbol)!;
        const now = ex.now;
        const end = ex.market.lastClosedIndex(a.symbol, now);
        const from = lowerBound(s.t, s.length, now - DAY);
        let hi = -Infinity;
        let lo = Infinity;
        let turnover = 0;
        for (let i = from; i <= end; i++) {
          hi = Math.max(hi, s.h[i]);
          lo = Math.min(lo, s.l[i]);
          turnover += s.v[i] * s.c[i];
        }
        const px = ex.price(a.symbol);
        const p24 = ex.market.closeAgo(a.symbol, now, DAY);
        const from7 = lowerBound(s.t, s.length, now - 7 * DAY);
        const spark: number[] = [];
        const stepN = Math.max(1, Math.floor((end - from7) / 60));
        for (let i = from7; i <= end; i += stepN) spark.push(s.c[i]);
        if (end >= 0) spark.push(s.c[end]);
        const rv = realizedVolAt(ex.market.rv.get(a.symbol), now);
        const fr = a.spotOnly ? NaN : (ex.market.lastFunding(a.symbol, now)?.rate ?? ex.config.defaultFundingRate);
        return { a, loaded, px, change: p24 ? px / p24 - 1 : NaN, hi, lo, turnover, spark, vol: rv?.rv30 ?? NaN, funding: fr };
      })
      .sort((x: any, y: any) => {
        if (x.loaded !== y.loaded) return x.loaded ? -1 : 1;
        if (!x.loaded) return 0;
        switch (sort) {
          case 'symbol':
            return x.a.symbol.localeCompare(y.a.symbol);
          case 'change':
            return (y.change || 0) - (x.change || 0);
          case 'vol':
            return (y.vol || 0) - (x.vol || 0);
          case 'funding':
            return (y.funding || 0) - (x.funding || 0);
          default:
            return (y.turnover || 0) - (x.turnover || 0);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, group, sort, q, slow, loading.length]);
  const th = (k: SortKey, label: string, right = true) => (
    <th className={cx(right && 'text-right', 'cursor-pointer hover:text-text', sort === k && '!text-brand')} onClick={() => setSort(k)}>
      {label}
      {sort === k ? ' ↓' : ''}
    </th>
  );
  return (
    <div className="h-full overflow-auto p-2 flex flex-col gap-2">
      <div className="bg-panel rounded-lg p-3 flex items-center gap-3">
        <div className="font-semibold text-[14px]">Рынки</div>
        <Segmented
          size="sm"
          value={group}
          onChange={setGroup}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'options', label: 'С опционами' },
            { value: 'crypto', label: 'Крипто' },
            { value: 'tradfi', label: 'TradFi-перпетуалы' },
            { value: 'xstock', label: 'xStocks / золото (спот)' },
          ]}
        />
        <input className="field w-60" placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ml-auto text-[11px] text-muted">Данные на момент симуляции · 24ч по закрытым свечам · волатильность — реализованная за 30 дней</span>
      </div>
      <div className="bg-panel rounded-lg">
        <table className="tbl">
          <thead>
            <tr>
              {th('symbol', 'Инструмент', false)}
              <th className="text-right">Цена</th>
              {th('change', 'Изм. 24ч')}
              <th className="text-right">Макс / Мин 24ч</th>
              {th('turnover', 'Оборот 24ч')}
              {th('funding', 'Funding')}
              {th('vol', 'Волатильность')}
              <th>7 дней</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.a.symbol}>
                <td>
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-brand/15 text-brand text-[9px] font-bold flex items-center justify-center">{r.a.base.slice(0, 4)}</span>
                    <div>
                      <div className="font-semibold">
                        {r.a.symbol} {r.a.hasOptions && <Badge color="brand">OPT</Badge>} {r.a.group === 'tradfi' && <Badge color="info">{r.a.sector === 'commodity' ? 'COMMODITY' : r.a.sector === 'index' ? 'INDEX' : r.a.sector === 'etf' ? 'ETF' : 'STOCK'}</Badge>}
                        {r.a.group === 'xstock' && <Badge color="info">xStock</Badge>}
                        {r.a.group === 'commodity' && <Badge color="brand">GOLD</Badge>}
                      </div>
                      <div className="text-[10px] text-muted">
                        {r.a.name} · {r.a.spotOnly ? 'только спот' : `до ${r.a.maxLeverage}x`}
                      </div>
                    </div>
                  </div>
                </td>
                {r.loaded ? (
                  <>
                    <td className="text-right font-semibold">{fmtPrice(r.px, r.a.symbol)}</td>
                    <td className={cx('text-right', pnlClass(r.change))}>{fmtPct(r.change)}</td>
                    <td className="text-right text-muted">
                      {fmtPrice(r.hi, r.a.symbol)} / {fmtPrice(r.lo, r.a.symbol)}
                    </td>
                    <td className="text-right">{fmtNum(r.turnover, 2, { compact: true })}</td>
                    <td className={cx('text-right', r.funding >= 0 ? 'text-brand' : 'text-info')}>
                      {!ex.config.fundingEnabled ? <span className="text-dim">выкл.</span> : Number.isFinite(r.funding) ? `${(r.funding * 100).toFixed(4)}%` : <span className="text-dim">—</span>}
                    </td>
                    <td className="text-right">{fmtPct(r.vol, 1, false)}</td>
                    <td>
                      <Sparkline data={r.spark} width={120} height={28} />
                    </td>
                    <td>
                      <div className="flex gap-1 justify-end">
                        {!r.a.spotOnly && (
                          <button className="btn btn-sm" onClick={() => set({ page: 'trade', symbol: r.a.symbol })}>
                            Фьючерс
                          </button>
                        )}
                        <button className={cx('btn btn-sm', !r.a.spotOnly && 'btn-ghost')} onClick={() => set({ page: 'spot', symbol: r.a.symbol })}>
                          Спот
                        </button>
                        {optionsAvailable(r.a) && (
                          <button className="btn btn-sm btn-ghost" onClick={() => set({ page: 'options', optionBase: r.a.base })} title={r.a.hasOptions ? 'Опционы Bybit' : 'Модельные опционы (на Bybit их нет)'}>
                            Опционы
                          </button>
                        )}
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td colSpan={7} className="text-dim text-[11px]">
                      не загружен
                    </td>
                    <td className="text-right">
                      <button className="btn btn-sm btn-ghost" disabled={loading.includes(r.a.symbol)} onClick={() => ensureSymbol(r.a.symbol)}>
                        {loading.includes(r.a.symbol) ? 'Загрузка…' : '↓ Загрузить'}
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
