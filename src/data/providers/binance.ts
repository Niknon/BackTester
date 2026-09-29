import { apiGet, pool } from '../http';
import { intervalDef } from '../intervals';
import type { Candle, FundingPoint, IntervalKey } from '../types';
import { getAsset } from '../assets';
import type { DataProvider, FetchOpts } from './provider';

const PROXY = '/proxy/binance-fapi';
const DIRECT = 'https://fapi.binance.com';

function sym(symbol: string) {
  const a = getAsset(symbol);
  if (a.binance === null) throw new Error(`${symbol}: нет на Binance Futures`);
  return a.binance || symbol;
}

/** Binance USDⓈ-M Futures: альтернативный источник. */
export const binanceProvider: DataProvider = {
  id: 'binance',
  label: 'Binance Futures',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const s = sym(symbol);
    const def = intervalDef(interval);
    const span = 1500 * def.ms;
    const windows: number[] = [];
    for (let w = start; w < end; w += span) windows.push(w);
    let done = 0;
    const parts = await pool(
      windows,
      4,
      async (ws) => {
        const we = Math.min(end, ws + span) - 1;
        const rows: any[] = await apiGet(
          PROXY,
          DIRECT,
          '/fapi/v1/klines',
          { symbol: s, interval: def.binance, startTime: ws, endTime: we, limit: 1500 },
          opts.signal,
        );
        if (!Array.isArray(rows)) throw new Error(`Binance: ${(rows as any)?.msg || 'ошибка'}`);
        done++;
        opts.onProgress?.(done, windows.length);
        return rows.map((r): Candle => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      },
      opts.signal,
    );
    return parts.flat();
  },

  async fetchFunding(symbol: string, start: number, end: number, opts: FetchOpts = {}) {
    const s = sym(symbol);
    const out: FundingPoint[] = [];
    let from = start;
    for (let guard = 0; guard < 500; guard++) {
      const rows: any[] = await apiGet(
        PROXY,
        DIRECT,
        '/fapi/v1/fundingRate',
        { symbol: s, startTime: from, endTime: end, limit: 1000 },
        opts.signal,
      );
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ t: +r.fundingTime, rate: +r.fundingRate });
      if (rows.length < 1000) break;
      from = +rows[rows.length - 1].fundingTime + 1;
    }
    return out;
  },
};
