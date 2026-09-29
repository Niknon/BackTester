import { bucketStart } from '../data/intervals';
import type { SeriesData } from '../data/types';

export interface Ohlcv {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export function emptyOhlcv(): Ohlcv {
  return { t: [], o: [], h: [], l: [], c: [], v: [] };
}

/** Агрегация базовых свечей [from, to) в таймфрейм tfMs. */
export function aggregate(s: SeriesData, tfMs: number, from = 0, to = s.length): Ohlcv {
  const out = emptyOhlcv();
  let cur = -1;
  for (let i = from; i < to; i++) {
    const b = bucketStart(s.t[i], tfMs);
    if (b !== cur) {
      out.t.push(b);
      out.o.push(s.o[i]);
      out.h.push(s.h[i]);
      out.l.push(s.l[i]);
      out.c.push(s.c[i]);
      out.v.push(s.v[i]);
      cur = b;
    } else {
      const k = out.t.length - 1;
      if (s.h[i] > out.h[k]) out.h[k] = s.h[i];
      if (s.l[i] < out.l[k]) out.l[k] = s.l[i];
      out.c[k] = s.c[i];
      out.v[k] += s.v[i];
    }
  }
  return out;
}

/** Добавить базовые бары [from, to) к существующей агрегации (для инкрементального обновления). */
export function appendAggregate(agg: Ohlcv, s: SeriesData, tfMs: number, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const b = bucketStart(s.t[i], tfMs);
    const k = agg.t.length - 1;
    if (k < 0 || agg.t[k] !== b) {
      agg.t.push(b);
      agg.o.push(s.o[i]);
      agg.h.push(s.h[i]);
      agg.l.push(s.l[i]);
      agg.c.push(s.c[i]);
      agg.v.push(s.v[i]);
    } else {
      if (s.h[i] > agg.h[k]) agg.h[k] = s.h[i];
      if (s.l[i] < agg.l[k]) agg.l[k] = s.l[i];
      agg.c[k] = s.c[i];
      agg.v[k] += s.v[i];
    }
  }
}
