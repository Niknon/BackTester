import { apiGet, pool, sleep } from '../http';
import { intervalDef } from '../intervals';
import type { Candle, FundingPoint, IntervalKey } from '../types';
import { getAsset } from '../assets';
import type { DataProvider, FetchOpts } from './provider';

const PROXY = '/proxy/okx';
const DIRECT = 'https://www.okx.com';

function instId(symbol: string) {
  const a = getAsset(symbol);
  if (a.okx === null) throw new Error(`${symbol}: нет на OKX`);
  return { id: a.okx || `${a.base}-USDT-SWAP`, mult: a.okxMult || 1 };
}

function check(json: any) {
  if (json?.code !== '0') throw new Error(`OKX: ${json?.msg || 'ошибка'} (${json?.code})`);
  return json.data as any[];
}

/** OKX: фолбэк-источник (history-candles отдаёт до 100 свечей за запрос). */
export const okxProvider: DataProvider = {
  id: 'okx',
  label: 'OKX',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const { id, mult } = instId(symbol);
    const def = intervalDef(interval);
    const span = 100 * def.ms;
    const windows: number[] = [];
    for (let s = start; s < end; s += span) windows.push(s);
    let done = 0;
    const parts = await pool(
      windows,
      4,
      async (ws) => {
        const we = Math.min(end, ws + span);
        const json = await apiGet(
          PROXY,
          DIRECT,
          '/api/v5/market/history-candles',
          { instId: id, bar: def.okx, after: we, before: ws - 1, limit: 100 },
          opts.signal,
          6,
        );
        const rows = check(json);
        done++;
        opts.onProgress?.(done, windows.length);
        await sleep(120); // лимит OKX: 20 запросов / 2 с
        return rows
          .map((r): Candle => ({ t: +r[0], o: +r[1] * mult, h: +r[2] * mult, l: +r[3] * mult, c: +r[4] * mult, v: +r[6] / mult }))
          .filter((k) => k.t >= ws && k.t < we);
      },
      opts.signal,
    );
    return parts.flat();
  },

  async fetchFunding(symbol: string, start: number, end: number, opts: FetchOpts = {}) {
    const { id } = instId(symbol);
    const out: FundingPoint[] = [];
    let after = end + 1;
    for (let guard = 0; guard < 200; guard++) {
      const json = await apiGet(
        PROXY,
        DIRECT,
        '/api/v5/public/funding-rate-history',
        { instId: id, after, limit: 100 },
        opts.signal,
      );
      const rows = check(json);
      if (!rows.length) break;
      let oldest = Infinity;
      for (const r of rows) {
        const t = +r.fundingTime;
        if (t >= start && t <= end) out.push({ t, rate: +(r.realizedRate || r.fundingRate) });
        oldest = Math.min(oldest, t);
      }
      if (rows.length < 100 || oldest <= start) break;
      after = oldest;
      await sleep(150);
    }
    return out;
  },
};
