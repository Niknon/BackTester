import { apiGet, sleep } from '../http';
import { DAY, intervalMs } from '../intervals';
import type { Candle, IntervalKey } from '../types';
import { getAsset } from '../assets';
import type { DataProvider, FetchOpts } from './provider';

const PROXY = '/proxy/yahoo';
const DIRECT = 'https://query1.finance.yahoo.com';

/**
 * Yahoo Finance — история американских акций, ETF, индексов и сырьевых фьючерсов.
 * Ограничения Yahoo: дневные свечи — за десятилетия; 1ч — за последние 730 дней;
 * 5/15/30 мин — 60 дней; 1 мин — 30 дней (не более 7 дней за запрос).
 * Если нужный интервал для старого периода недоступен, используются дневные свечи
 * (одна свеча на торговый день). Цены скорректированы на сплиты.
 */
const SRC: Record<IntervalKey, { yi: string; limitDays: number; maxSpanDays: number }> = {
  '1m': { yi: '1m', limitDays: 29, maxSpanDays: 7 },
  '3m': { yi: '1m', limitDays: 29, maxSpanDays: 7 },
  '5m': { yi: '5m', limitDays: 59, maxSpanDays: 59 },
  '15m': { yi: '15m', limitDays: 59, maxSpanDays: 59 },
  '30m': { yi: '30m', limitDays: 59, maxSpanDays: 59 },
  '1h': { yi: '60m', limitDays: 729, maxSpanDays: 729 },
  '4h': { yi: '60m', limitDays: 729, maxSpanDays: 729 },
  '1d': { yi: '1d', limitDays: Infinity, maxSpanDays: 365 * 60 },
} as Record<IntervalKey, { yi: string; limitDays: number; maxSpanDays: number }>;

function tickerOf(symbol: string) {
  const a = getAsset(symbol);
  if (!a.yahoo) throw new Error(`${symbol}: нет на Yahoo Finance`);
  return a.yahoo;
}

interface RawBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function chart(ticker: string, yi: string, from: number, to: number, signal?: AbortSignal): Promise<RawBar[]> {
  const json = await apiGet(
    PROXY,
    DIRECT,
    `/v8/finance/chart/${encodeURIComponent(ticker)}`,
    { period1: Math.floor(from / 1000), period2: Math.ceil(to / 1000), interval: yi, includePrePost: yi === '1d' ? 'false' : 'true', events: 'split' },
    signal,
  );
  const err = json?.chart?.error;
  if (err) throw new Error(`Yahoo: ${err.description || err.code}`);
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const out: RawBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (![o, h, l, c].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) continue;
    out.push({ t: ts[i] * 1000, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number(q.volume?.[i]) || 0 });
  }
  return out;
}

/** Сведение сырых свечей в свечи базового интервала (выравнивание по UTC-сетке). */
function bucket(raw: RawBar[], dt: number, start: number, end: number): Candle[] {
  const map = new Map<number, Candle>();
  raw.sort((a, b) => a.t - b.t);
  for (const b of raw) {
    const t = Math.floor(b.t / dt) * dt;
    if (t < start || t >= end) continue;
    const cur = map.get(t);
    if (!cur) map.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return [...map.values()];
}

export const yahooProvider: DataProvider = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const ticker = tickerOf(symbol);
    const dt = intervalMs(interval);
    const src = SRC[interval] ?? SRC['1d'];
    const now = Date.now();
    const intradayFrom = src.limitDays === Infinity ? -Infinity : now - src.limitDays * DAY;
    const raw: RawBar[] = [];
    // старая часть — дневные свечи
    if (start < intradayFrom) {
      raw.push(...(await chart(ticker, '1d', start, Math.min(end, intradayFrom), opts.signal)));
      opts.onProgress?.(1, 2);
    }
    // свежая часть — нужный интервал, окнами не длиннее лимита Yahoo
    const from = Math.max(start, intradayFrom);
    for (let s = from; s < end; s += src.maxSpanDays * DAY) {
      const e = Math.min(end, s + src.maxSpanDays * DAY);
      raw.push(...(await chart(ticker, src.yi, s, e, opts.signal)));
      await sleep(150); // бережём лимиты Yahoo
    }
    opts.onProgress?.(2, 2);
    return bucket(raw, dt, start, end);
  },
  // funding у акций нет: для перпетуалов используется ставка по умолчанию
};
