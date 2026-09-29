import { getAsset, roundToStep } from '../../data/assets';
import { DAY } from '../../data/intervals';
import type { Exchange } from '../exchange';
import type { FuturesGridParams, SpotGridParams } from './types';

/**
 * «AI»-параметры в стиле Bybit: диапазон по недавней истории (без будущего),
 * число сеток — из волатильности так, чтобы шаг заметно превышал комиссии.
 */
export function recentStats(ex: Exchange, symbol: string, days = 7) {
  const s = ex.market.series.get(symbol);
  if (!s) return null;
  const now = ex.now;
  const end = ex.market.lastClosedIndex(symbol, now);
  if (end < 1) return null;
  const from = now - days * DAY;
  const closes: number[] = [];
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = end; i >= 0 && s.t[i] >= from; i--) {
    closes.push(s.c[i]);
    hi = Math.max(hi, s.h[i]);
    lo = Math.min(lo, s.l[i]);
  }
  if (closes.length < 5) return null;
  closes.reverse();
  const sorted = [...closes].sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  let sumR2 = 0;
  for (let i = 1; i < closes.length; i++) sumR2 += Math.log(closes[i] / closes[i - 1]) ** 2;
  const barVol = Math.sqrt(sumR2 / Math.max(1, closes.length - 1));
  const trend = Math.log(closes[closes.length - 1] / closes[0]);
  return { hi, lo, p05: pct(0.05), p95: pct(0.95), barVol, trend, last: closes[closes.length - 1] };
}

function gridsFor(lower: number, upper: number, targetStep: number) {
  return Math.max(5, Math.min(150, Math.round(Math.log(upper / lower) / Math.log(1 + targetStep))));
}

export function suggestSpotGrid(ex: Exchange, symbol: string, days = 7): Omit<SpotGridParams, 'sellOnStop'> | null {
  const st = recentStats(ex, symbol, days);
  if (!st) return null;
  const tick = getAsset(symbol).tickSize;
  const lower = roundToStep(Math.min(st.p05, st.last) * 0.99, tick);
  const upper = roundToStep(Math.max(st.p95, st.last) * 1.01, tick);
  const step = Math.max(0.004, 4 * ex.config.fees.spotMaker);
  return { symbol, lower, upper, grids: gridsFor(lower, upper, step), mode: 'geometric' };
}

export function suggestFuturesGrid(ex: Exchange, symbol: string, days = 7): Omit<FuturesGridParams, 'closeOnStop'> | null {
  const st = recentStats(ex, symbol, days);
  if (!st) return null;
  const tick = getAsset(symbol).tickSize;
  const lower = roundToStep(Math.min(st.lo, st.last) * 0.99, tick);
  const upper = roundToStep(Math.max(st.hi, st.last) * 1.01, tick);
  const range = Math.log(upper / lower);
  const direction = st.trend > range * 0.35 ? 'long' : st.trend < -range * 0.35 ? 'short' : 'neutral';
  const step = Math.max(0.003, 5 * ex.config.fees.linearMaker);
  const leverage = Math.max(1, Math.min(10, Math.round(0.25 / Math.max(0.02, range))));
  return { symbol, direction, lower, upper, grids: gridsFor(lower, upper, step), mode: 'geometric', leverage };
}
