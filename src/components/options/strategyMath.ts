import type { Exchange } from '../../engine/exchange';
import { optionFee, parseOptionSymbol } from '../../engine/options';
import { legValueAt, type ResolvedLeg } from '../../engine/optionStrategies';
import { breakevens, payoffAtExpiry, type PayoffLeg } from './PayoffChart';

/** Ноги стратегии → профиль выплат (с комиссиями), премия, комиссии, маржа, дельта. */
export function strategyEconomics(ex: Exchange, legs: ResolvedLeg[], nearExpiry: number, S: number) {
  const fees = legs.map((l) => (l.category === 'option' ? optionFee(ex.config.fees.optionTaker, ex.config.fees.optionFeeCap, S, l.price, l.qty) : l.price * l.qty * ex.config.fees.linearTaker));
  const payoff: PayoffLeg[] = legs.map((l, i) => {
    const sign = l.side === 'Buy' ? 1 : -1;
    if (l.type === 'F') return { type: 'F', strike: 0, qty: sign * l.qty, entry: l.price + (sign * fees[i]) / l.qty };
    return {
      type: l.type,
      strike: l.strike,
      qty: sign * l.qty,
      entry: l.price + (sign * fees[i]) / l.qty,
      valueNow: (x: number) => ex.optionQuote(l.symbol, x)?.mark ?? 0,
      valueAtExpiry: l.expiry > nearExpiry ? (x: number) => legValueAt(ex, l, x, nearExpiry) : undefined,
    };
  });
  const premium = legs.filter((l) => l.category === 'option').reduce((s, l) => s + (l.side === 'Sell' ? 1 : -1) * l.price * l.qty, 0);
  const feeSum = fees.reduce((a, b) => a + b, 0);
  // маржа: перпетуал — по плечу; опционы — прирост IM книги по активу (в портфельном режиме купленные
  // крылья её уменьшают, в стандартном — сумма по проданным ногам)
  let margin = legs.reduce((s, l) => (l.type === 'F' ? s + (l.price * l.qty) / ex.leverageOf(ex.main, l.symbol) : s), 0);
  const opts = legs.filter((l) => l.category === 'option');
  const u = opts.length ? parseOptionSymbol(opts[0].symbol)?.underlying : undefined;
  if (u) {
    const before = ex.optionGroupMargin(ex.main, u).im;
    const after = ex.optionGroupMargin(ex.main, u, opts.map((l) => ({ symbol: l.symbol, size: (l.side === 'Buy' ? 1 : -1) * l.qty }))).im;
    margin += Math.max(0, after - before);
  }
  const delta = legs.reduce((s, l) => s + l.delta, 0);
  return { payoff, premium, feeSum, margin, delta };
}

/** Макс. прибыль/убыток (±Infinity — не ограничены) и точки безубыточности на дату расчёта. */
export function payoffStats(payoff: PayoffLeg[], S: number) {
  const lo = S * 0.02;
  const hi = S * 3;
  const f = (x: number) => payoffAtExpiry(payoff, x);
  let maxP = -Infinity;
  let minP = Infinity;
  for (let i = 0; i <= 600; i++) {
    const v = f(lo + ((hi - lo) * i) / 600);
    maxP = Math.max(maxP, v);
    minP = Math.min(minP, v);
  }
  const slope = f(S * 4) - f(S * 3);
  return {
    maxP: slope > 1e-9 ? Infinity : maxP,
    minP: slope < -1e-9 ? -Infinity : minP,
    bes: breakevens(payoff, lo, hi, 1500),
  };
}
