import { DAY, HOUR, bucketStart, intervalMs } from '../intervals';
import type { Candle, FundingPoint, IntervalKey } from '../types';
import { getAsset, roundToStep } from '../assets';
import type { DataProvider } from './provider';

/**
 * Детерминированный генератор синтетических данных (работает офлайн).
 * Дневной «каркас» (GBM с режимами волатильности и скачками) + мост Броуна внутри дня,
 * поэтому любые подотрезки истории согласованы между собой.
 */

const ANCHOR = Date.UTC(2018, 0, 1);
const REF_DATE = Date.UTC(2026, 8, 1);

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rnd: () => number) {
  let u = 0;
  while (u === 0) u = rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Backbone {
  closes: Float64Array; // закрытие дня d (d от ANCHOR)
  vols: Float64Array; // дневная сигма дня d
}

const backbones = new Map<string, Backbone>();

function backbone(symbol: string, days: number): Backbone {
  const cached = backbones.get(symbol);
  if (cached && cached.closes.length >= days) return cached;
  const spec = getAsset(symbol);
  const n = Math.max(days, Math.ceil((REF_DATE - ANCHOR) / DAY) + 800);
  const rnd = mulberry32(hashStr('bb:' + symbol));
  const closes = new Float64Array(n);
  const vols = new Float64Array(n);
  const baseSigma = spec.refVol / Math.sqrt(365);
  let logp = 0;
  let regime = 0; // лог-множитель волатильности (AR(1))
  let drift = 0;
  for (let d = 0; d < n; d++) {
    regime = 0.97 * regime + 0.18 * gaussian(rnd);
    drift = 0.99 * drift + 0.00025 * gaussian(rnd);
    const sigma = baseSigma * Math.exp(Math.max(-1, Math.min(1.2, regime)));
    // слабый возврат к среднему, чтобы цена за годы не уходила в бесконечность
    let r = drift + sigma * gaussian(rnd) - 0.004 * logp;
    if (rnd() < 0.015) r += (rnd() < 0.5 ? -1 : 1) * sigma * (2 + 3 * rnd()); // скачок
    logp += r;
    closes[d] = logp;
    vols[d] = sigma;
  }
  const refIdx = Math.floor((REF_DATE - ANCHOR) / DAY);
  const shift = Math.log(spec.refPrice) - closes[refIdx];
  for (let d = 0; d < n; d++) closes[d] = Math.exp(closes[d] + shift);
  const bb = { closes, vols };
  backbones.set(symbol, bb);
  return bb;
}

/** Шаги внутри дня (мост Броуна от open к close). */
function intraday(symbol: string, day: number, steps: number, bb: Backbone): Float64Array {
  const open = day > 0 ? bb.closes[day - 1] : bb.closes[0];
  const close = bb.closes[day];
  const sigma = bb.vols[day] / Math.sqrt(steps);
  const rnd = mulberry32(hashStr(`id:${symbol}:${day}:${steps}`));
  const path = new Float64Array(steps + 1);
  let x = 0;
  path[0] = 0;
  for (let i = 1; i <= steps; i++) {
    x += sigma * gaussian(rnd) * (rnd() < 0.01 ? 3 : 1);
    path[i] = x;
  }
  const target = Math.log(close / open);
  const out = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const bridged = path[i] - (i / steps) * (path[steps] - target);
    out[i] = open * Math.exp(bridged);
  }
  return out;
}

function genCandles(symbol: string, interval: IntervalKey, start: number, end: number): Candle[] {
  const spec = getAsset(symbol);
  const dt = intervalMs(interval);
  const fine = Math.min(dt, HOUR); // шаг генерации
  const stepsPerDay = Math.round(DAY / fine);
  const firstDay = Math.floor((bucketStart(start, dt) - ANCHOR) / DAY);
  const lastDay = Math.floor((end - ANCHOR) / DAY);
  const bb = backbone(symbol, lastDay + 2);
  const tick = spec.tickSize;
  const baseVol = 5e6 / spec.refPrice; // условный объём
  const fineBars: Candle[] = [];
  for (let d = Math.max(0, firstDay); d <= lastDay; d++) {
    const dayStart = ANCHOR + d * DAY;
    const pts = intraday(symbol, d, stepsPerDay, bb);
    const rnd = mulberry32(hashStr(`hl:${symbol}:${d}:${stepsPerDay}`));
    const sig = bb.vols[d] / Math.sqrt(stepsPerDay);
    for (let i = 0; i < stepsPerDay; i++) {
      const t = dayStart + i * fine;
      const o = pts[i];
      const c = pts[i + 1];
      const wick = Math.abs(gaussian(rnd)) * sig * 0.6;
      const wick2 = Math.abs(gaussian(rnd)) * sig * 0.6;
      const h = Math.max(o, c) * (1 + wick);
      const l = Math.min(o, c) * (1 - wick2);
      const move = Math.abs(Math.log(c / o)) / (sig || 1e-9);
      const v = baseVol * (fine / DAY) * (0.4 + 0.6 * move + 0.5 * rnd()) * (1 + 3 * Math.abs(bb.vols[d] * 20 - 0.4));
      fineBars.push({ t, o, h, l, c, v });
    }
  }
  // агрегация до нужного интервала
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const b of fineBars) {
    const bt = bucketStart(b.t, dt);
    if (!cur || cur.t !== bt) {
      if (cur) out.push(cur);
      cur = { ...b, t: bt };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out
    .filter((k) => k.t >= start && k.t < end)
    .map((k) => ({
      t: k.t,
      o: roundToStep(k.o, tick),
      h: roundToStep(k.h, tick, 'ceil'),
      l: roundToStep(k.l, tick, 'floor'),
      c: roundToStep(k.c, tick),
      v: Math.round(k.v * 1000) / 1000,
    }));
}

export const syntheticProvider: DataProvider = {
  id: 'synthetic',
  label: 'Синтетика (офлайн)',
  async fetchKlines(symbol, interval, start, end, opts = {}) {
    const res = genCandles(symbol, interval, start, end);
    opts.onProgress?.(1, 1);
    return res;
  },
  async fetchFunding(symbol, start, end) {
    const out: FundingPoint[] = [];
    const bb = backbone(symbol, Math.floor((end - ANCHOR) / DAY) + 2);
    const rnd = mulberry32(hashStr('fr:' + symbol));
    const step = 8 * HOUR;
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      const d = Math.floor((t - ANCHOR) / DAY);
      const mom = d > 3 ? Math.log(bb.closes[d - 1] / bb.closes[d - 4]) : 0;
      let rate = 0.0001 + 0.0004 * Math.tanh(mom * 8) + 0.00005 * (rnd() - 0.5);
      rate = Math.max(-0.0075, Math.min(0.0075, rate));
      out.push({ t, rate: Math.round(rate * 1e8) / 1e8 });
    }
    return out;
  },
};
