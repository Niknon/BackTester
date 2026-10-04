/** Колоночное хранение свечей: компактно и быстро для больших историй. */
export interface SeriesData {
  symbol: string;
  interval: IntervalKey;
  /** время открытия свечи, мс UTC */
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  length: number;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingPoint {
  t: number;
  rate: number;
}

export type IntervalKey =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w';

export type ProviderId = 'bybit' | 'okx' | 'binance' | 'yahoo' | 'synthetic';

export interface LoadProgress {
  symbol: string;
  done: number;
  total: number;
  message?: string;
}

export function emptySeries(symbol: string, interval: IntervalKey): SeriesData {
  return {
    symbol,
    interval,
    t: new Float64Array(0),
    o: new Float64Array(0),
    h: new Float64Array(0),
    l: new Float64Array(0),
    c: new Float64Array(0),
    v: new Float64Array(0),
    length: 0,
  };
}

export function seriesFromCandles(symbol: string, interval: IntervalKey, candles: Candle[]): SeriesData {
  const n = candles.length;
  const s: SeriesData = {
    symbol,
    interval,
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
    length: n,
  };
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    s.t[i] = k.t;
    s.o[i] = k.o;
    s.h[i] = k.h;
    s.l[i] = k.l;
    s.c[i] = k.c;
    s.v[i] = k.v;
  }
  return s;
}

export function candleAt(s: SeriesData, i: number): Candle {
  return { t: s.t[i], o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v: s.v[i] };
}

/** Индекс первой свечи с t >= time (бинарный поиск). */
export function lowerBound(t: Float64Array, len: number, time: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
