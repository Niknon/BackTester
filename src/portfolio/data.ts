/**
 * Данные для «Пробоя лидеров» (раздел 3): дневные свечи OHLCV вселенной и бенчмарка с кэшем в браузере.
 *  - us:     Yahoo Finance, цены скорректированы на сплиты и дивиденды (как yfinance auto_adjust=True), шаг — 1 акция;
 *  - crypto: спот к USDT (Binance, при недоступности — OKX), догружаются только недостающие дни, шаг — лот биржи;
 *  - moex:   MOEX ISS, режим TQBR; цены свечей ISS уже учитывают сплиты, объём приводится по списку сплитов ISS;
 *            шаг — лот (LOTSIZE). Дивиденды — MOEX ISS → dohod.ru → smart-lab.ru (см. dividends.ts).
 */
import { apiGet, pool, sleep } from '../data/http';
import { idbGet, idbSet } from '../data/cache';
import { adjustForDividends, DIV_SOURCE_LABEL, moexDividends, type DivAdjustStats, type DivSource, type MoexDividend } from './dividends';
import { DAY, type AssetData, type Dataset } from './backtest';
import { warmupBars, type LbConfig, type Market } from './config';
import type { Bars } from './rules';

export interface LoadOpts {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void;
}

interface Row {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Cached {
  fetchedAt: number;
  from: number;
  rows: Row[];
}

const toBars = (rows: Row[]): Bars => ({
  t: Float64Array.from(rows, (r) => r.t),
  o: Float64Array.from(rows, (r) => r.o),
  h: Float64Array.from(rows, (r) => r.h),
  l: Float64Array.from(rows, (r) => r.l),
  c: Float64Array.from(rows, (r) => r.c),
  v: Float64Array.from(rows, (r) => r.v),
});

const day = (t: number) => Math.floor(t / DAY) * DAY;
const valid = (r: Row) => [r.o, r.h, r.l, r.c].every((x) => Number.isFinite(x) && x > 0) && Number.isFinite(r.v);

function clean(rows: Row[]): Row[] {
  const m = new Map<number, Row>();
  for (const r of rows) if (valid(r)) m.set(day(r.t), { ...r, t: day(r.t), h: Math.max(r.h, r.o, r.c), l: Math.min(r.l, r.o, r.c) });
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** С какой даты грузить: прогрев индикаторов до старта теста (раздел 3) с запасом на выходные. */
export function loadFrom(c: LbConfig): number {
  const start = Date.parse(c.start + 'T00:00:00Z');
  const bars = Math.max(warmupBars(c), c.regime.sma_slow, c.trend_filter.rs_periods[1]) + 30;
  const calDays = c.market === 'crypto' ? bars : Math.ceil(bars * 1.5);
  return start - calDays * DAY;
}

export function loadTo(c: LbConfig): number {
  return c.end ? Date.parse(c.end + 'T00:00:00Z') + DAY : Date.now();
}

/* ───────────────────────── США: Yahoo ───────────────────────── */

const yahooTicker = (t: string) => t.replace(/\./g, '-');

async function yahooDaily(ticker: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const json = await apiGet(
    '/proxy/yahoo',
    'https://query1.finance.yahoo.com',
    `/v8/finance/chart/${encodeURIComponent(yahooTicker(ticker))}`,
    { period1: Math.floor(from / 1000), period2: Math.ceil(to / 1000), interval: '1d', events: 'div,split', includeAdjustedClose: 'true' },
    signal,
  );
  const err = json?.chart?.error;
  if (err) throw new Error(err.description || err.code);
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const rows: Row[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    // скорректированные цены: множитель adjclose / close применяется ко всем ценам бара (auto_adjust)
    const f = adj[i] != null && c ? adj[i]! / c : 1;
    // скорректированные цены Yahoo от запроса к запросу «шумят» в 7–8-м знаке — округляем до 6 значащих,
    // чтобы одинаковые данные давали одинаковые решения на пограничных сравнениях
    const r6 = (x: number) => Number((x * f).toPrecision(6));
    rows.push({ t: ts[i] * 1000, o: r6(q.open?.[i]), h: r6(q.high?.[i]), l: r6(q.low?.[i]), c: r6(c), v: Number(q.volume?.[i]) || 0 });
  }
  return clean(rows);
}

/** Yahoo отдаёт всю историю одним запросом; кэш действует до следующего торгового дня. */
async function usSeries(ticker: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const key = `lb|us|${ticker}`;
  const cached = await idbGet<Cached>('meta', key);
  const fresh = cached && cached.from <= from && (to < cached.fetchedAt - DAY || Date.now() - cached.fetchedAt < 12 * 3600_000);
  if (cached && fresh) return cached.rows.filter((r) => r.t >= from && r.t < to);
  const rows = await yahooDaily(ticker, from, Math.max(to, Date.now()), signal);
  await idbSet('meta', key, { fetchedAt: Date.now(), from, rows } satisfies Cached);
  return rows.filter((r) => r.t >= from && r.t < to);
}

/* ───────────────────────── Крипта: Binance / OKX спот ───────────────────────── */

type CryptoSrc = 'binance' | 'okx';
let cryptoSrc: CryptoSrc | null = null;

async function binanceDaily(sym: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const out: Row[] = [];
  for (let s = from; s < to; ) {
    const rows: any[][] = await apiGet('/proxy/binance-spot', 'https://api.binance.com', '/api/v3/klines', { symbol: `${sym}USDT`, interval: '1d', startTime: s, endTime: to, limit: 1000 }, signal, 2);
    if (!rows?.length) break;
    for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const next = rows[rows.length - 1][0] + DAY;
    if (next <= s || rows.length < 1000) break;
    s = next;
  }
  return out;
}

async function okxDaily(sym: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const out: Row[] = [];
  let after = to;
  for (let guard = 0; guard < 200; guard++) {
    const json = await apiGet('/proxy/okx', 'https://www.okx.com', '/api/v5/market/history-candles', { instId: `${sym}-USDT`, bar: '1Dutc', after, limit: 100 }, signal, 3);
    const rows: string[][] = json?.data ?? [];
    if (!rows.length) break;
    for (const k of rows) out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const oldest = +rows[rows.length - 1][0];
    if (oldest <= from || rows.length < 100) break;
    after = oldest;
    await sleep(120); // OKX ограничивает частоту запросов истории
  }
  return out.filter((r) => r.t >= from);
}

async function cryptoDaily(sym: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  if (cryptoSrc !== 'okx') {
    try {
      const r = await binanceDaily(sym, from, to, signal);
      cryptoSrc = 'binance';
      return r;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      if (cryptoSrc === 'binance' && !(e?.status === 451 || e?.status === 403)) throw e;
      cryptoSrc = 'okx'; // Binance недоступен из региона — берём OKX
    }
  }
  return okxDaily(sym, from, to, signal);
}

/** Догрузка только недостающих дней: кэш хранит сырые свечи (у крипты корректировок нет). */
async function cryptoSeries(sym: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const key = `lb|crypto|${sym}`;
  const cached = await idbGet<Cached>('meta', key);
  let rows: Row[] = cached?.rows ?? [];
  if (!cached || cached.from > from) rows = clean(await cryptoDaily(sym, from, to, signal));
  else {
    const last = rows.length ? rows[rows.length - 1].t : from - DAY;
    // последний (возможно, незавершённый) день перекачиваем
    if (last + 2 * DAY < to) rows = clean([...rows.filter((r) => r.t < last), ...(await cryptoDaily(sym, last, to, signal))]);
  }
  await idbSet('meta', key, { fetchedAt: Date.now(), from: Math.min(from, cached?.from ?? from), rows } satisfies Cached);
  // незавершённый текущий день в тест не берём
  const today = day(Date.now());
  return rows.filter((r) => r.t >= from && r.t < to && r.t < today);
}

async function cryptoSteps(syms: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    if (cryptoSrc !== 'okx') {
      const json = await apiGet('/proxy/binance-spot', 'https://api.binance.com', '/api/v3/exchangeInfo', { symbols: JSON.stringify(syms.map((s) => `${s}USDT`)) }, signal, 1);
      for (const s of json?.symbols ?? []) {
        const lot = (s.filters ?? []).find((f: any) => f.filterType === 'LOT_SIZE');
        if (lot) out.set(String(s.baseAsset), Number(lot.stepSize));
      }
      return out;
    }
  } catch {
    /* Binance недоступен — шаг с OKX */
  }
  try {
    const json = await apiGet('/proxy/okx', 'https://www.okx.com', '/api/v5/public/instruments', { instType: 'SPOT' }, signal, 2);
    for (const x of json?.data ?? []) if (String(x.quoteCcy) === 'USDT') out.set(String(x.baseCcy), Number(x.lotSz));
  } catch {
    /* шаг по умолчанию */
  }
  return out;
}

/** Топ-N монет к USDT по объёму за 24 часа (без стейблкоинов) — для обновления вселенной. */
export async function cryptoTopByVolume(n = 30): Promise<string[]> {
  const stables = /^(USDT|USDC|FDUSD|TUSD|DAI|USDE|USD1|PYUSD|USDP|EURC|EUR|USDD|BUSD|RLUSD|USDS|FRAX|XUSD|BFUSD|AEUR|UST|USTC|PAXG|XAUT|WBTC|WBETH|BETH)$/;
  try {
    const rows: any[] = await apiGet('/proxy/binance-spot', 'https://api.binance.com', '/api/v3/ticker/24hr', {}, undefined, 1);
    return rows
      .filter((r) => String(r.symbol).endsWith('USDT'))
      .map((r) => ({ base: String(r.symbol).slice(0, -4), vol: Number(r.quoteVolume) }))
      .filter((r) => !stables.test(r.base) && !/(UP|DOWN|BULL|BEAR)$/.test(r.base))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, n)
      .map((r) => r.base);
  } catch {
    throw new Error('Binance недоступен из вашего региона — список не обновлён');
  }
}

/* ───────────────────────── Мосбиржа: ISS ───────────────────────── */

const MOEX = ['/proxy/moex', 'https://iss.moex.com'] as const;
const isoDate = (t: number) => new Date(t).toISOString().slice(0, 10);

async function moexCandles(path: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const out: Row[] = [];
  for (let start = 0; start < 100_000; ) {
    const json = await apiGet(MOEX[0], MOEX[1], path, { from: isoDate(from), till: isoDate(to), interval: 24, start, 'iss.meta': 'off', 'iss.only': 'candles' }, signal, 3);
    const cd = json?.candles;
    const cols: string[] = cd?.columns ?? [];
    const data: any[][] = cd?.data ?? [];
    const ix = (k: string) => cols.indexOf(k);
    for (const r of data) out.push({ t: Date.parse(String(r[ix('begin')]).slice(0, 10) + 'T00:00:00Z'), o: r[ix('open')], h: r[ix('high')], l: r[ix('low')], c: r[ix('close')], v: r[ix('volume')] });
    if (data.length < 500) break;
    start += data.length;
  }
  return out;
}

async function moexSeries(secid: string, path: string, from: number, to: number, signal?: AbortSignal): Promise<Row[]> {
  const key = `lb|moex|${secid}`;
  const cached = await idbGet<Cached>('meta', key);
  let rows: Row[] = cached?.rows ?? [];
  if (!cached || cached.from > from) rows = clean(await moexCandles(path, from, to, signal));
  else {
    const last = rows.length ? rows[rows.length - 1].t : from - DAY;
    if (last + 2 * DAY < to) rows = clean([...rows.filter((r) => r.t < last), ...(await moexCandles(path, last, to, signal))]);
  }
  await idbSet('meta', key, { fetchedAt: Date.now(), from: Math.min(from, cached?.from ?? from), rows } satisfies Cached);
  const today = day(Date.now());
  return rows.filter((r) => r.t >= from && r.t < to && r.t < today);
}

interface MoexMeta {
  lots: Map<string, number>;
  splits: { t: number; secid: string; before: number; after: number }[];
}

async function moexMeta(signal?: AbortSignal): Promise<MoexMeta> {
  const lots = new Map<string, number>();
  const js = await apiGet(MOEX[0], MOEX[1], '/iss/engines/stock/markets/shares/boards/TQBR/securities.json', { 'iss.meta': 'off', 'iss.only': 'securities', 'securities.columns': 'SECID,LOTSIZE' }, signal);
  for (const [s, lot] of js?.securities?.data ?? []) lots.set(String(s), Number(lot) || 1);
  const sp = await apiGet(MOEX[0], MOEX[1], '/iss/statistics/engines/stock/splits.json', { 'iss.meta': 'off' }, signal);
  const cols: string[] = sp?.splits?.columns ?? [];
  const splits = ((sp?.splits?.data ?? []) as any[][]).map((r) => ({
    t: Date.parse(String(r[cols.indexOf('tradedate')]) + 'T00:00:00Z'),
    secid: String(r[cols.indexOf('secid')]),
    before: Number(r[cols.indexOf('before')]),
    after: Number(r[cols.indexOf('after')]),
  }));
  return { lots, splits };
}

/**
 * Сплиты и консолидации. Свечи ISS (candles) уже пересчитаны по ценам задним числом (GMKN до сплита 1:100 — ~153,
 * а не ~15 300), но объём в штуках остаётся прежним. Без поправки оборот close × volume до сплита занижался бы в 100 раз
 * (у консолидации VTBR 5000:1 — завышался), поэтому приводим объём: × after/before для баров до даты сплита.
 */
export function adjustSplitVolumes(rows: Row[], splits: { t: number; before: number; after: number }[]): Row[] {
  const out = rows.map((r) => ({ ...r }));
  for (const s of splits) {
    const k = s.after / s.before;
    if (!(k > 0) || k === 1) continue;
    for (const r of out) {
      if (r.t >= s.t) break;
      r.v *= k;
    }
  }
  return out;
}

/** Корректировка на дивиденды (реализация и правила даты отсечки — в dividends.ts). */
export function adjustDividends(rows: Row[], divs: MoexDividend[], stats?: DivAdjustStats): Row[] {
  return adjustForDividends(rows, divs, stats);
}

/* ───────────────────────── Сборка датасета ───────────────────────── */

export async function loadDataset(market: Market, universe: string[], c: LbConfig, opts: LoadOpts = {}): Promise<Dataset> {
  const from = loadFrom(c);
  const to = loadTo(c);
  const warnings: string[] = [];
  const total = universe.length + 1;
  let done = 0;
  const step = (msg: string) => opts.onProgress?.(++done, total, msg);

  if (market === 'us') {
    const benchSym = c.benchmark || '^GSPC';
    const bench = await usSeries(benchSym, from, to, opts.signal);
    step(`Бенчмарк ${benchSym}`);
    const assets = await pool(
      universe,
      6,
      async (sym) => {
        let rows: Row[] = [];
        try {
          rows = await usSeries(sym, from, to, opts.signal);
        } catch (e: any) {
          if (e?.name === 'AbortError') throw e;
          warnings.push(`${sym}: не загрузился (${String(e?.message || e).slice(0, 60)})`);
        }
        step(sym);
        return rows.length ? ({ symbol: sym, bars: toBars(rows), step: 1 } satisfies AssetData) : null;
      },
      opts.signal,
    );
    return finish('us', benchSym, bench, assets, warnings);
  }

  if (market === 'crypto') {
    const benchBase = (c.benchmark || 'BTC/USDT').split('/')[0];
    const bench = await cryptoSeries(benchBase, from, to, opts.signal);
    step(`Бенчмарк ${benchBase}/USDT (${cryptoSrc === 'okx' ? 'OKX' : 'Binance'})`);
    const steps = await cryptoSteps(universe, opts.signal);
    const assets = await pool(
      universe,
      3,
      async (sym) => {
        let rows: Row[] = [];
        try {
          rows = await cryptoSeries(sym, from, to, opts.signal);
        } catch (e: any) {
          if (e?.name === 'AbortError') throw e;
          warnings.push(`${sym}/USDT: не загрузился (${String(e?.message || e).slice(0, 60)})`);
        }
        step(`${sym}/USDT`);
        return rows.length ? ({ symbol: sym, bars: toBars(rows), step: steps.get(sym) ?? 1e-8 } satisfies AssetData) : null;
      },
      opts.signal,
    );
    if (cryptoSrc === 'okx') warnings.push('Binance недоступен из вашего региона — свечи спота взяты с OKX (пары к USDT).');
    return finish('crypto', `${benchBase}/USDT`, bench, assets, warnings);
  }

  // moex
  const meta = await moexMeta(opts.signal);
  const benchSym = c.benchmark || 'IMOEX';
  const bench = await moexSeries(benchSym, `/iss/engines/stock/markets/index/securities/${benchSym}/candles.json`, from, to, opts.signal);
  step(`Бенчмарк ${benchSym}`);
  const divBySource: Record<DivSource, number> = { iss: 0, dohod: 0, smartlab: 0 };
  const noDivs: string[] = [];
  const divStats: DivAdjustStats = { applied: 0, suspicious: 0 };
  const assets = await pool(
    universe,
    4,
    async (secid) => {
      let rows: Row[] = [];
      try {
        rows = await moexSeries(secid, `/iss/engines/stock/markets/shares/boards/TQBR/securities/${secid}/candles.json`, from, to, opts.signal);
        rows = adjustSplitVolumes(
          rows,
          meta.splits.filter((s) => s.secid === secid),
        );
        const dr = await moexDividends(secid, opts.signal);
        if (!dr) noDivs.push(secid);
        else {
          divBySource[dr.source]++;
          rows = adjustDividends(rows, dr.divs, divStats);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        warnings.push(`${secid}: не загрузился (${String(e?.message || e).slice(0, 60)})`);
      }
      step(secid);
      if (rows.length && !meta.lots.has(secid)) warnings.push(`${secid}: нет в режиме TQBR сейчас — лот принят за 1`);
      return rows.length ? ({ symbol: secid, bars: toBars(rows), step: meta.lots.get(secid) ?? 1 } satisfies AssetData) : null;
    },
    opts.signal,
  );
  if (noDivs.length)
    warnings.push(
      `Дивиденды не найдены ни в одном источнике (${Object.values(DIV_SOURCE_LABEL).join(', ')}) для ${noDivs.length} из ${universe.length} бумаг ` +
        `(${noDivs.slice(0, 12).join(', ')}${noDivs.length > 12 ? ', …' : ''}) — их цены НЕ скорректированы на дивиденды: дивидендные гэпы могут давать ложные выходы по стопам и трейлингу.`,
    );
  if (divStats.suspicious)
    warnings.push(`${divStats.suspicious} дивидендных выплат пропущено: сумма больше половины цены акции — похоже на ошибку источника.`);
  const used = (Object.entries(divBySource) as [DivSource, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${DIV_SOURCE_LABEL[k]} — ${n}`);
  const notes = used.length
    ? [
        `Дивиденды: ${used.join(', ')} бумаг; поправок на дивиденды в ценах: ${divStats.applied}. Сплиты и консолидации учтены (MOEX ISS).`,
      ]
    : [];
  return finish('moex', benchSym, bench, assets, warnings, notes);
}

function finish(market: Market, benchSymbol: string, benchRows: Row[], assets: (AssetData | null)[], warnings: string[], notes: string[] = []): Dataset {
  if (!benchRows.length) throw new Error(`Нет данных бенчмарка ${benchSymbol}`);
  const ok = assets.filter((a): a is AssetData => !!a);
  if (!ok.length) throw new Error('Не загрузился ни один актив вселенной');
  return { market, benchSymbol, bench: toBars(benchRows), assets: ok, warnings, notes };
}
