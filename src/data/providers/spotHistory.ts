import { apiGet, pool, sleep } from '../http';
import { bucketStart, intervalDef } from '../intervals';
import { getAsset } from '../assets';
import type { Candle, IntervalKey } from '../types';
import type { DataProvider, FetchOpts } from './provider';

/**
 * История крипты до запуска перпетуалов. USDT-перпетуалы BTC/ETH на Bybit, OKX и Binance появились
 * в 2019–2020 гг., у альткоинов — позже, а спотом монеты торговались годами раньше. Чтобы сессия
 * «за 10 лет» не начиналась с пустоты, старую часть берём со спота: Binance (с 08.2017, все интервалы,
 * публичное зеркало без гео-блока) и Coinbase (BTC-USD с 2015, ETH-USD с 2016).
 */

/** Монета спота для перпетуала: 1000PEPE → PEPE с множителем цены 1000. Не крипта — null. */
export function spotCoin(symbol: string): { coin: string; mult: number } | null {
  const a = getAsset(symbol);
  if (a.group !== 'crypto') return null;
  const m = /^(10{2,})([A-Z].*)$/.exec(a.base);
  return m ? { coin: m[2], mult: Number(m[1]) } : { coin: a.base, mult: 1 };
}

function needCoin(symbol: string) {
  const c = spotCoin(symbol);
  if (!c) throw new Error(`${symbol}: не криптовалюта`);
  return c;
}

/** Binance Spot (data-api.binance.vision — публичное зеркало рыночных данных). */
export const binanceSpotProvider: DataProvider = {
  id: 'binanceSpot',
  label: 'Binance Spot',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const { coin, mult } = needCoin(symbol);
    const def = intervalDef(interval);
    const span = 1000 * def.ms;
    const windows: number[] = [];
    for (let w = start; w < end; w += span) windows.push(w);
    let done = 0;
    const parts = await pool(
      windows,
      4,
      async (ws) => {
        const we = Math.min(end, ws + span);
        const rows: any[] = await apiGet(
          '/proxy/binance-data',
          'https://data-api.binance.vision',
          '/api/v3/klines',
          { symbol: `${coin}USDT`, interval: def.binance, startTime: ws, endTime: we - 1, limit: 1000 },
          opts.signal,
        );
        if (!Array.isArray(rows)) throw new Error(`Binance Spot: ${(rows as any)?.msg || 'ошибка'}`);
        done++;
        opts.onProgress?.(done, windows.length);
        return rows.map((r): Candle => ({ t: +r[0], o: +r[1] * mult, h: +r[2] * mult, l: +r[3] * mult, c: +r[4] * mult, v: +r[5] / mult }));
      },
      opts.signal,
    );
    return parts.flat();
  },
};

/** Шаги свечей Coinbase, с: остальные интервалы собираются из ближайшего меньшего. */
const CB_GRAN = [86400, 21600, 3600, 900, 300, 60];

/** Coinbase Exchange: монеты к USD (BTC с 07.2015, ETH с 05.2016), до 300 свечей за запрос. */
export const coinbaseProvider: DataProvider = {
  id: 'coinbase',
  label: 'Coinbase',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const { coin, mult } = needCoin(symbol);
    const dt = intervalDef(interval).ms;
    const g = CB_GRAN.find((x) => x * 1000 <= dt && dt % (x * 1000) === 0) ?? 60;
    const span = 300 * g * 1000;
    const windows: number[] = [];
    for (let w = start; w < end; w += span) windows.push(w);
    let done = 0;
    const iso = (t: number) => new Date(t).toISOString();
    const parts = await pool(
      windows,
      3,
      async (ws) => {
        const we = Math.min(end, ws + span);
        const rows: any[] = await apiGet(
          '/proxy/coinbase',
          'https://api.exchange.coinbase.com',
          `/products/${coin}-USD/candles`,
          { granularity: g, start: iso(ws), end: iso(we - g * 1000) },
          opts.signal,
        );
        if (!Array.isArray(rows)) throw new Error(`Coinbase: ${(rows as any)?.message || 'ошибка'}`);
        done++;
        opts.onProgress?.(done, windows.length);
        await sleep(120); // публичный лимит ~10 запросов/с
        // [время (с), минимум, максимум, открытие, закрытие, объём]
        return rows
          .map((r): Candle => ({ t: r[0] * 1000, l: r[1] * mult, h: r[2] * mult, o: r[3] * mult, c: r[4] * mult, v: r[5] / mult }))
          .filter((k) => k.t >= ws && k.t < we);
      },
      opts.signal,
    );
    const raw = parts.flat().sort((a, b) => a.t - b.t);
    if (g * 1000 === dt) return raw;
    // сборка интервала из более мелких свечей (4ч из часовых, неделя из дневных и т.п.)
    const out: Candle[] = [];
    for (const k of raw) {
      const b = bucketStart(k.t, dt);
      const last = out[out.length - 1];
      if (last && last.t === b) {
        last.h = Math.max(last.h, k.h);
        last.l = Math.min(last.l, k.l);
        last.c = k.c;
        last.v += k.v;
      } else out.push({ ...k, t: b });
    }
    return out;
  },
};
