/**
 * Правила «Пробоя лидеров» (разделы 5.1–5.6) — чистые функции. Их вызывают и бэктест, и сканер.
 */
import { warmupBars, type LbConfig } from './config';
import { atr, highestIncl, highestPrev, lowestPrev, meanPrev, ret, sma } from './indicators';

/** Дневные бары актива (время — полночь UTC дня торгов), по возрастанию времени. */
export interface Bars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

/** Индикаторы актива, посчитанные по его собственным барам. */
export interface AssetInd {
  bars: Bars;
  smaShort: Float64Array;
  smaMid: Float64Array;
  smaLong: Float64Array;
  atrFast: Float64Array;
  atrSlow: Float64Array;
  atrRisk: Float64Array;
  hh: Float64Array; // HH20: max(high[t-20 .. t-1])
  ll: Float64Array; // LL10: min(low[t-10 .. t-1])
  volAvg: Float64Array; // VolAvg50: mean(volume[t-50 .. t-1])
  turnover: Float64Array; // Turnover50: mean(close·volume[t-50 .. t-1])
  high: Float64Array; // High252: max(high[t-251 .. t])
  retA: Float64Array; // Ret63
  retB: Float64Array; // Ret126
}

export function assetIndicators(b: Bars, c: LbConfig): AssetInd {
  const tf = c.trend_filter;
  const e = c.entry;
  const cv = new Float64Array(b.c.length);
  for (let i = 0; i < cv.length; i++) cv[i] = b.c[i] * b.v[i];
  return {
    bars: b,
    smaShort: sma(b.c, tf.sma_short),
    smaMid: sma(b.c, tf.sma_mid),
    smaLong: sma(b.c, tf.sma_long),
    atrFast: atr(b.h, b.l, b.c, e.atr_fast),
    atrSlow: atr(b.h, b.l, b.c, e.atr_slow),
    atrRisk: atr(b.h, b.l, b.c, c.risk.atr_period),
    hh: highestPrev(b.h, e.breakout_lookback),
    ll: lowestPrev(b.l, c.exits.trail_lookback),
    volAvg: meanPrev(b.v, e.volume_avg_lookback),
    turnover: meanPrev(cv, e.volume_avg_lookback),
    high: highestIncl(b.h, tf.high_lookback),
    retA: ret(b.c, tf.rs_periods[0]),
    retB: ret(b.c, tf.rs_periods[1]),
  };
}

export interface BenchInd {
  bars: Bars;
  fast: Float64Array;
  slow: Float64Array;
}

export function benchIndicators(b: Bars, c: LbConfig): BenchInd {
  return { bars: b, fast: sma(b.c, c.regime.sma_fast), slow: sma(b.c, c.regime.sma_slow) };
}

/* ───────── 5.1 Режим рынка ───────── */

/** regime_ok[t] = close > SMA200 и SMA50 > SMA200; пока у бенчмарка меньше sma_slow баров — ложно. */
export function regimeOk(b: BenchInd, i: number, c: LbConfig): boolean {
  if (i < 0 || i + 1 < c.regime.sma_slow) return false;
  const close = b.bars.c[i];
  return close > b.slow[i] && b.fast[i] > b.slow[i];
}

/* ───────── 5.2 Фильтр актива (условия 1–4; условие 5 — у вызывающего) ───────── */

export function assetFilter(a: AssetInd, i: number, pctA: number, pctB: number, c: LbConfig): boolean {
  const tf = c.trend_filter;
  if (i + 1 < warmupBars(c)) return false; // прогрев
  const close = a.bars.c[i];
  // 1. close > SMA50 > SMA150 > SMA200
  if (!(close > a.smaShort[i] && a.smaShort[i] > a.smaMid[i] && a.smaMid[i] > a.smaLong[i])) return false;
  // 2. SMA200[t] > SMA200[t-21]
  if (!(a.smaLong[i] > a.smaLong[i - tf.sma_long_rising_bars])) return false;
  // 3. close >= (1 - 0.25) * High252
  if (!(close >= (1 - tf.max_dist_from_high) * a.high[i])) return false;
  // 4. pct(Ret63) >= 0.80 и pct(Ret126) >= 0.80
  return pctA >= tf.rs_min_percentile && pctB >= tf.rs_min_percentile;
}

/* ───────── 5.3 Сигнал входа ───────── */

export function entrySignal(a: AssetInd, i: number, c: LbConfig): boolean {
  if (i < 1) return false;
  const b = a.bars;
  // 1. ATR10[t-1] < ATR50[t-1] — накануне волатильность сжата
  if (!(a.atrFast[i - 1] < a.atrSlow[i - 1])) return false;
  // 2. close[t] > HH20[t]
  if (!(b.c[i] > a.hh[i])) return false;
  // 3. volume[t] >= 1.5 * VolAvg50[t]
  return b.v[i] >= c.entry.volume_mult * a.volAvg[i];
}

/* ───────── 5.4 Ранжирование ───────── */

export interface Candidate {
  symbol: string;
  rs: number;
  volRatio: number;
}

export const rsScore = (pctA: number, pctB: number) => (pctA + pctB) / 2;

/** По убыванию rs_score; при равенстве — по volume[t] / VolAvg50[t]. */
export function rankCandidates<T extends Candidate>(list: T[]): T[] {
  return [...list].sort((x, y) => y.rs - x.rs || y.volRatio - x.volRatio || (x.symbol < y.symbol ? -1 : 1));
}

/* ───────── 5.6 Сопровождение позиции ───────── */

export interface PositionState {
  E: number;
  R_ps: number;
  stop: number;
  barsHeld: number;
  /** было ли закрытие >= E + time_stop_min_r · R_ps с момента входа (включая текущее) */
  reachedMinR: boolean;
  pyramided: boolean;
}

export type ManageAction = { action: 'exit'; reason: 'trail' | 'time' } | { action: 'add'; newStop: number } | { action: 'hold' };

/** Проверки по порядку, срабатывает первое подходящее: трейлинг → тайм-стоп → докупка. */
export function manage(p: PositionState, a: AssetInd, i: number, ok: { regime: boolean; halted: boolean }, c: LbConfig): ManageAction {
  const close = a.bars.c[i];
  // 1. Трейлинг: close[t] < LL10[t]
  if (close < a.ll[i]) return { action: 'exit', reason: 'trail' };
  // 2. Тайм-стоп: bars_held >= 10 и ни одно закрытие не было >= E + 1.0·R_ps
  if (p.barsHeld >= c.exits.time_stop_bars && !p.reachedMinR) return { action: 'exit', reason: 'time' };
  // 3. Докупка (один раз за сделку)
  const py = c.pyramid;
  if (py.enabled && !p.pyramided && close >= p.E + py.trigger_r * p.R_ps && (!py.requires_regime || ok.regime) && !ok.halted)
    return { action: 'add', newStop: Math.max(p.stop, p.E + py.stop_r * p.R_ps) };
  return { action: 'hold' };
}
