import { getAsset } from '../../data/assets';
import { optionQtyStep, optionSymbol, strikeStep, yearsTo } from '../../engine/options';
import type { Side } from '../../engine/types';
import { fmtShortDate, fmtNum, exactDecimals } from '../../lib/format';
import { bump, toast, useSession } from '../../store/session';
import { cx, NumInput, usePersistent } from '../ui';
import { dte } from '../options/OptionPositions';

/**
 * Раздел контекстного меню графика: открыть колл/пут по рынку на страйке,
 * ближайшем к уровню, по которому кликнули правой кнопкой.
 */
export function ChartOptionMenu({ symbol, price, onDone }: { symbol: string; price: number; onDone: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const spec = getAsset(symbol);
  const [expIdx, setExpIdx] = usePersistent<number>('bt-ctx-opt-exp', 3);
  // количество — своё для каждого актива, вводится вручную или кнопками
  const [qtyMap, setQtyMap] = usePersistent<Record<string, number>>('bt-ctx-opt-qty', {});
  if (!spec.hasOptions || spec.spotOnly || !ex.market.has(symbol)) return null;
  const expiries = ex.optionExpiries(spec.base);
  if (!expiries.length) return null;
  const idx = Math.max(0, Math.min(expIdx, expiries.length - 1));
  const expiry = expiries[idx];
  const S = ex.price(symbol);
  if (!Number.isFinite(S) || !(price > 0)) return null;
  // страйк — уровень клика, округлённый до шага страйков этой экспирации (не ограничиваемся
  // видимой цепочкой: иначе дальние уровни «прилипали» к краю цепочки или к страйку открытой позиции)
  const kStep = strikeStep(S, yearsTo(expiry, ex.now));
  const strike = Math.max(kStep, Number((Math.round(price / kStep) * kStep).toPrecision(10)));
  const call = ex.optionQuote(optionSymbol(spec.base, expiry, strike, 'C'));
  const put = ex.optionQuote(optionSymbol(spec.base, expiry, strike, 'P'));
  if (!call || !put) return null;
  const row = { strike, call, put };
  const step = optionQtyStep(S);
  const qty = qtyMap[spec.base] ?? Number((step * 10).toPrecision(6));
  const setQty = (v: number) => setQtyMap({ ...qtyMap, [spec.base]: v });
  const kd = exactDecimals(row.strike);

  const open = (type: 'C' | 'P', side: Side) => {
    const q = type === 'C' ? row.call : row.put;
    const px = side === 'Buy' ? q.ask : q.bid;
    if (!(qty >= step)) return toast('warn', 'Укажите количество', `Минимум ${step} ${spec.base}`);
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
        {Math.abs(row.strike - price) / price > 0.001 && <span> (уровень округлён до шага страйков {fmtNum(kStep, exactDecimals(kStep))})</span>}
      </div>
      <div className="flex gap-1">
        <select className="field !h-7 flex-1 text-[11px]" value={idx} onChange={(e) => setExpIdx(Number(e.target.value))}>
          {expiries.map((e, i) => (
            <option key={e} value={i}>
              {fmtShortDate(e)} · {dte(e, ex.now)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <NumInput label="Кол-во" value={qty || ''} onChange={(v) => setQty(v === '' ? 0 : v)} step={step} suffix={spec.base} className="!h-7" />
        <div className="flex gap-1">
          {[1, 5, 10, 50, 100].map((k) => {
            const v = Number((step * k).toPrecision(6));
            return (
              <button key={k} className={cx('chip flex-1 border border-line2 !px-0 text-[10px]', qty === v && 'active')} onClick={() => setQty(v)}>
                {v}
              </button>
            );
          })}
        </div>
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
