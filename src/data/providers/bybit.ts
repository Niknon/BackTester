import { apiGet, pool } from '../http';
import { intervalDef } from '../intervals';
import type { Candle, FundingPoint, IntervalKey } from '../types';
import { ASSETS, BYBIT_OPTION_BASES, getAsset, registerExtra, updateAssetSpec, type AssetSpec } from '../assets';
import type { DataProvider, FetchOpts } from './provider';

const PROXY = '/proxy/bybit';
const DIRECT = 'https://api.bybit.com';

function checkRet(json: any) {
  if (json?.retCode !== 0) throw new Error(`Bybit: ${json?.retMsg ?? 'ошибка'} (${json?.retCode})`);
  return json.result;
}

export const bybitProvider: DataProvider = {
  id: 'bybit',
  label: 'Bybit',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const def = intervalDef(interval);
    const category = getAsset(symbol).bybitCategory ?? 'linear';
    const span = 1000 * def.ms;
    const windows: [number, number][] = [];
    for (let s = start; s < end; s += span) windows.push([s, Math.min(end, s + span) - 1]);
    let done = 0;
    const parts = await pool(
      windows,
      4,
      async ([s, e]) => {
        const json = await apiGet(
          PROXY,
          DIRECT,
          '/v5/market/kline',
          { category, symbol, interval: def.bybit, start: s, end: e, limit: 1000 },
          opts.signal,
        );
        const list: string[][] = checkRet(json).list || [];
        done++;
        opts.onProgress?.(done, windows.length);
        return list.map(
          (r): Candle => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }),
        );
      },
      opts.signal,
    );
    return parts.flat();
  },

  async fetchFunding(symbol: string, start: number, end: number, opts: FetchOpts = {}) {
    const out: FundingPoint[] = [];
    if (getAsset(symbol).spotOnly) return out;
    let endTime = end;
    for (let guard = 0; guard < 2000; guard++) {
      const json = await apiGet(
        PROXY,
        DIRECT,
        '/v5/market/funding/history',
        { category: 'linear', symbol, startTime: start, endTime, limit: 200 },
        opts.signal,
      );
      const list: any[] = checkRet(json).list || [];
      if (!list.length) break;
      let oldest = Infinity;
      for (const r of list) {
        const t = +r.fundingRateTimestamp;
        out.push({ t, rate: +r.fundingRate });
        oldest = Math.min(oldest, t);
      }
      if (list.length < 200 || oldest <= start) break;
      endTime = oldest - 1;
    }
    return out;
  },
};

/**
 * Синхронизация спецификаций инструментов с Bybit (тик, шаг лота, плечо, листинг).
 * Добавляет в каталог все USDT-перпетуалы, найденные на бирже.
 */
export async function syncInstrumentsFromBybit(signal?: AbortSignal): Promise<number> {
  let cursor = '';
  let count = 0;
  for (let guard = 0; guard < 20; guard++) {
    const json = await apiGet(
      PROXY,
      DIRECT,
      '/v5/market/instruments-info',
      { category: 'linear', limit: 1000, cursor: cursor || undefined },
      signal,
    );
    const res = checkRet(json);
    for (const it of res.list || []) {
      if (it.quoteCoin !== 'USDT' || it.contractType !== 'LinearPerpetual' || it.status !== 'Trading') continue;
      const patch: Partial<AssetSpec> = {
        tickSize: +it.priceFilter.tickSize,
        qtyStep: +it.lotSizeFilter.qtyStep,
        minQty: +it.lotSizeFilter.minOrderQty,
        maxLeverage: +it.leverageFilter.maxLeverage,
        listed: +it.launchTime,
      };
      const known = ASSETS.find((a) => a.symbol === it.symbol);
      if (known?.spotOnly) continue;
      if (known) updateAssetSpec(it.symbol, patch);
      else
        registerExtra({
          symbol: it.symbol,
          base: it.baseCoin,
          name: it.baseCoin,
          group: 'crypto',
          hasOptions: false,
          refPrice: 1,
          refVol: 0.9,
          okx: `${it.baseCoin}-USDT-SWAP`,
          binance: it.symbol,
          ...(patch as any),
        });
      count++;
    }
    cursor = res.nextPageCursor;
    if (!cursor) break;
  }
  return count;
}

/**
 * Уточняет спецификации токенизированных акций (xStocks) и токенов золота по споту Bybit
 * и добавляет новые xStocks, если биржа помечает их соответствующим типом.
 */
export async function syncSpotTradFiFromBybit(signal?: AbortSignal): Promise<number> {
  const json = await apiGet(PROXY, DIRECT, '/v5/market/instruments-info', { category: 'spot', limit: 1000 }, signal);
  const res = checkRet(json);
  let count = 0;
  for (const it of res.list || []) {
    if (it.quoteCoin !== 'USDT' || it.status !== 'Trading') continue;
    const patch: Partial<AssetSpec> = {
      tickSize: +it.priceFilter?.tickSize || undefined,
      qtyStep: +it.lotSizeFilter?.basePrecision || undefined,
      minQty: +it.lotSizeFilter?.minOrderQty || undefined,
    };
    for (const k of Object.keys(patch) as (keyof AssetSpec)[]) if (patch[k] === undefined) delete patch[k];
    const known = ASSETS.find((a) => a.symbol === it.symbol && a.spotOnly);
    if (known) {
      updateAssetSpec(it.symbol, patch);
      count++;
    } else if (/xstock/i.test(String(it.symbolType ?? '')) && /X$/.test(it.baseCoin)) {
      const ticker = String(it.baseCoin).slice(0, -1);
      registerExtra({
        symbol: it.symbol,
        base: it.baseCoin,
        name: `${ticker} (xStock)`,
        group: 'xstock',
        hasOptions: false,
        tickSize: 0.01,
        qtyStep: 0.001,
        minQty: 0.001,
        maxLeverage: 1,
        refPrice: 100,
        refVol: 0.4,
        okx: `${ticker}-USDT-SWAP`,
        binance: null,
        spotOnly: true,
        bybitCategory: 'spot',
        underlying: ticker,
        ...patch,
      });
      count++;
    }
  }
  return count;
}

/** Проверяет, какие базовые активы реально имеют опционы на Bybit сейчас. */
export async function fetchBybitOptionBases(candidates = BYBIT_OPTION_BASES, signal?: AbortSignal) {
  const found: string[] = [];
  await pool(
    candidates,
    4,
    async (base) => {
      try {
        const json = await apiGet(
          PROXY,
          DIRECT,
          '/v5/market/instruments-info',
          { category: 'option', baseCoin: base, limit: 1 },
          signal,
          1,
        );
        if ((checkRet(json).list || []).length) found.push(base);
      } catch {
        /* нет опционов */
      }
    },
    signal,
  );
  return found;
}
