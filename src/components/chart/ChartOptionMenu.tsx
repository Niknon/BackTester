import { getAsset } from '../../data/assets';
import { optionQtyStep } from '../../engine/options';
import type { Side } from '../../engine/types';
import { fmtShortDate, fmtNum, exactDecimals } from '../../lib/format';
import { bump, toast, useSession } from '../../store/session';
import { cx, usePersistent } from '../ui';
import { dte } from '../options/OptionPositions';

/**
 * Раздел контекстного меню графика: открыть колл/пут по рынку на страйке,
 * ближайшем к уровню, по которому кликнули правой кнопкой.
 */
export function ChartOptionMenu({ symbol, price, onDone }: { symbol: string; price: number; onDone: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const spec = getAsset(symbol);
  const [expIdx, setExpIdx] = usePersistent<number>('bt-ctx-opt-exp', 3);
  const [lots, setLots] = usePersistent<number>('bt-ctx-opt-lots', 10);
  if (!spec.hasOptions || spec.spotOnly || !ex.market.has(symbol)) return null;
  const expiries = ex.optionExpiries(spec.base);
  if (!expiries.length) return null;
  const idx = Math.max(0, Math.min(expIdx, expiries.length - 1));
  const expiry = expiries[idx];
  const chain = ex.optionChain(spec.base, expiry);
  if (!chain?.rows.length) return null;
  const row = chain.rows.reduce((b, r) => (Math.abs(r.strike - price) < Math.abs(b.strike - price) ? r : b));
  const step = optionQtyStep(chain.S);
  const qty = Number((step * lots).toPrecision(6));
  const kd = exactDecimals(row.strike);

  const open = (type: 'C' | 'P', side: Side) => {
    const q = type === 'C' ? row.call : row.put;
    const px = side === 'Buy' ? q.ask : q.bid;
    if (!(px > 0)) return toast('warn', 'Нет котировки', side === 'Buy' ? 'Ask = 0' : 'Bid = 0 — продать нельзя');
    const o = ex.placeOrder({ category: 'option', symbol: q.inst.symbol, side, orderType: 'Market', qty });
    if (o.status === 'Rejected') toast('error', 'Опцион не открыт', o.rejectReason);
    bump(true);
    onDone();
  };

  const btn = (type: 'C' | 'P', side: Side) => {
    const q = type === 'C' ? row.call : row.put;
    const px = side === 'Buy' ? q.ask : q.bid;
    return (
      <button
        className={cx('rounded px-2 py-1 text-left hover:bg-panel3 border border-line2 disabled:opacity-40', side === 'Buy' ? 'text-up' : 'text-down')}
        disabled={!(px > 0)}
        onClick={() => open(type, side)}
        title={`${side === 'Buy' ? 'Купить' : 'Продать'} ${q.inst.symbol} по рынку (${side === 'Buy' ? 'Ask' : 'Bid'})`}
      >
        <div className="font-semibold">
          {side === 'Buy' ? 'Купить' : 'Продать'} {type === 'C' ? 'колл' : 'пут'}
        </div>
        <div className="num text-[10px] text-muted">≈ {fmtNum(px * qty, 2)} USDT</div>
      </button>
    );
  };

  return (
    <div className="border-t border-line mt-1 pt-1.5 px-2 pb-1 flex flex-col gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
      <div className="text-[10px] text-muted px-1">
        Опцион по рынку · страйк <span className="text-text num font-semibold">{fmtNum(row.strike, kd)}</span>
        {Math.abs(row.strike - price) / price > 0.001 && <span> (ближайший к уровню)</span>}
      </div>
      <div className="flex gap-1">
        <select className="field !h-7 flex-1 text-[11px]" value={idx} onChange={(e) => setExpIdx(Number(e.target.value))}>
          {expiries.map((e, i) => (
            <option key={e} value={i}>
              {fmtShortDate(e)} · {dte(e, ex.now)}
            </option>
          ))}
        </select>
        <select className="field !h-7 w-[110px] text-[11px]" value={lots} onChange={(e) => setLots(Number(e.target.value))} title="Количество контрактов">
          {[1, 5, 10, 50, 100, 500].map((k) => (
            <option key={k} value={k}>
              {Number((step * k).toPrecision(6))} {spec.base}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {btn('C', 'Buy')}
        {btn('P', 'Buy')}
        {btn('C', 'Sell')}
        {btn('P', 'Sell')}
      </div>
    </div>
  );
}
