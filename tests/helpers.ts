import { HOUR } from '../src/data/intervals';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { MarketData } from '../src/engine/market';
import { Exchange } from '../src/engine/exchange';
import { DEFAULT_FEES, DEFAULT_OPTION_MODEL, type SessionConfig } from '../src/engine/types';

export const T0 = Date.UTC(2025, 0, 6, 0); // понедельник

/** Рынок из массива [o,h,l,c]; перед стартом — 1 разогревочная свеча с close = первому open. */
export function mkMarket(bars: Record<string, [number, number, number, number][]>, warmup: [number, number, number, number][] = []) {
  const n = Math.max(...Object.values(bars).map((b) => b.length));
  const m = new MarketData('1h', T0, T0 + n * HOUR);
  for (const [sym, b] of Object.entries(bars)) {
    const pre = warmup.length ? warmup : [[b[0][0], b[0][0], b[0][0], b[0][0]] as [number, number, number, number]];
    const candles: Candle[] = [
      ...pre.map((x, i) => ({ t: T0 - (pre.length - i) * HOUR, o: x[0], h: x[1], l: x[2], c: x[3], v: 100 })),
      ...b.map((x, i) => ({ t: T0 + i * HOUR, o: x[0], h: x[1], l: x[2], c: x[3], v: 100 })),
    ];
    m.addSeries(sym, seriesFromCandles(sym, '1h', candles), 'synthetic');
  }
  return m;
}

export function mkConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 't',
    name: 'test',
    provider: 'synthetic',
    start: T0,
    end: T0 + 100 * HOUR,
    baseInterval: '1h',
    warmupDays: 0,
    initialBalance: 10_000,
    symbols: ['BTCUSDT'],
    fees: { ...DEFAULT_FEES },
    slippageBps: 0,
    fundingEnabled: false,
    defaultFundingRate: 0.0001,
    options: { ...DEFAULT_OPTION_MODEL },
    intrabar: 'auto',
    createdAt: 0,
    ...over,
  };
}

export function mkExchange(bars: Record<string, [number, number, number, number][]>, over: Partial<SessionConfig> = {}, warmup?: [number, number, number, number][]) {
  const m = mkMarket(bars, warmup);
  return Exchange.create(mkConfig({ symbols: Object.keys(bars), ...over }), m);
}

/** Флэт-бары с одинаковой ценой. */
export function flat(price: number, n: number): [number, number, number, number][] {
  return Array.from({ length: n }, () => [price, price, price, price]);
}

/** Синус-колебания цены (для грид-ботов). */
export function wave(center: number, amp: number, n: number, period = 12): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let prev = center;
  for (let i = 0; i < n; i++) {
    const c = center + amp * Math.sin((2 * Math.PI * (i + 1)) / period);
    const o = prev;
    out.push([o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c]);
    prev = c;
  }
  return out;
}
