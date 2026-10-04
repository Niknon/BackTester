import { idbGet, idbSet } from './cache';
import { intervalMs } from './intervals';
import type { Candle, FundingPoint, IntervalKey, ProviderId, SeriesData } from './types';
import { seriesFromCandles } from './types';
import type { DataProvider } from './providers/provider';
import { bybitProvider } from './providers/bybit';
import { okxProvider } from './providers/okx';
import { binanceProvider } from './providers/binance';
import { syntheticProvider } from './providers/synthetic';
import { yahooProvider } from './providers/yahoo';
import { getAsset } from './assets';
import { DAY } from './intervals';

export const PROVIDERS: Record<ProviderId, DataProvider> = {
  bybit: bybitProvider,
  okx: okxProvider,
  binance: binanceProvider,
  yahoo: yahooProvider,
  synthetic: syntheticProvider,
};

export const PROVIDER_LIST: { id: ProviderId; label: string; note: string }[] = [
  { id: 'bybit', label: 'Bybit', note: 'Основной источник: свечи и funding USDT-перпетуалов Bybit' },
  { id: 'okx', label: 'OKX', note: 'Фолбэк: те же активы (кроме MNT/TON), funding — только ~3 мес.' },
  { id: 'binance', label: 'Binance Futures', note: 'Фолбэк: крипто-перпетуалы Binance (без TradFi и xStocks)' },
  {
    id: 'yahoo',
    label: 'Yahoo Finance (акции США)',
    note: 'Акции, ETF, индексы и сырьё США за десятилетия: дневные свечи — вся история, 1ч — 2 года, 5–30 мин — 60 дней. Для старых периодов при мелком интервале — дневные свечи. Крипту берёт с Bybit/OKX/Binance',
  },
  { id: 'synthetic', label: 'Синтетика', note: 'Офлайн-генератор: для тестов логики без интернета' },
];

const CHUNK_BARS = 5000;
/** Самая ранняя дата запроса: криптобиржи — с 2018, Yahoo (акции США) — с 1980. */
const EARLIEST: Partial<Record<ProviderId, number>> = { yahoo: Date.UTC(1980, 0, 1) };
const DEFAULT_EARLIEST = Date.UTC(2018, 0, 1);

type CachedChunk = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array; complete: boolean };

function toChunk(candles: Candle[], complete: boolean): CachedChunk {
  const s = seriesFromCandles('', '1m', candles);
  return { t: s.t, o: s.o, h: s.h, l: s.l, c: s.c, v: s.v, complete };
}

function chunkCandles(ch: CachedChunk): Candle[] {
  const out: Candle[] = new Array(ch.t.length);
  for (let i = 0; i < ch.t.length; i++) out[i] = { t: ch.t[i], o: ch.o[i], h: ch.h[i], l: ch.l[i], c: ch.c[i], v: ch.v[i] };
  return out;
}

export interface LoadOptions {
  provider: ProviderId;
  symbol: string;
  interval: IntervalKey;
  start: number;
  end: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message?: string) => void;
  /** пробовать другие реальные источники, если выбранный недоступен */
  fallback?: boolean;
}

export interface LoadResult {
  series: SeriesData;
  provider: ProviderId;
  errors: string[];
}

async function loadFrom(p: DataProvider, o: LoadOptions): Promise<SeriesData> {
  const dt = intervalMs(o.interval);
  const span = CHUNK_BARS * dt;
  const now = Date.now();
  const first = Math.floor(o.start / span) * span;
  const chunks: number[] = [];
  for (let cs = first; cs < o.end; cs += span) chunks.push(cs);
  const all: Candle[] = [];
  let done = 0;
  for (const cs of chunks) {
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = `${p.id}|${o.symbol}|${o.interval}|${cs}`;
    let chunk = p.id === 'synthetic' ? undefined : await idbGet<CachedChunk>('klines', key);
    if (!chunk || !chunk.complete) {
      const from = Math.max(cs, EARLIEST[p.id] ?? DEFAULT_EARLIEST);
      const to = Math.min(cs + span, Math.floor(now / dt) * dt + dt);
      const candles = from < to ? await p.fetchKlines(o.symbol, o.interval, from, to, {
        signal: o.signal,
        onProgress: (d, t) => o.onProgress?.(done + d / t, chunks.length, `${p.label}: ${o.symbol}`),
      }) : [];
      const complete = cs + span <= now - dt;
      chunk = toChunk(dedupe(candles), complete);
      if (p.id !== 'synthetic' && (complete || candles.length)) await idbSet('klines', key, chunk);
    }
    done++;
    o.onProgress?.(done, chunks.length, `${p.label}: ${o.symbol}`);
    for (const k of chunkCandles(chunk)) if (k.t >= o.start && k.t < o.end) all.push(k);
  }
  return seriesFromCandles(o.symbol, o.interval, dedupe(all));
}

function dedupe(c: Candle[]): Candle[] {
  c.sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const k of c) {
    if (!Number.isFinite(k.o) || !Number.isFinite(k.c)) continue;
    if (out.length && out[out.length - 1].t === k.t) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** Источники, заблокированные в этой сессии браузера (гео-блок 403) — не дёргаем повторно. */
const blocked = new Set<ProviderId>();

/** Насколько полно серия покрывает запрошенный период (0..1) — по времени первой свечи. */
function coverage(series: SeriesData, start: number, end: number) {
  if (!series.length) return 0;
  const first = series.t[0];
  return Math.max(0, Math.min(1, (end - Math.max(start, first)) / Math.max(1, end - start)));
}

export async function loadSeries(o: LoadOptions): Promise<LoadResult> {
  const spec = getAsset(o.symbol);
  // для акций/ETF/сырья: если основной источник дал только недавнюю историю (перпетуалы листингованы в 2025–2026),
  // берём длинную историю с Yahoo Finance
  const stockLike = !!spec.yahoo;
  const order: ProviderId[] = [o.provider];
  if (o.fallback !== false && o.provider !== 'synthetic') {
    const rest: ProviderId[] = stockLike ? ['yahoo', 'bybit', 'okx'] : ['bybit', 'okx', 'binance'];
    for (const id of rest) if (!order.includes(id)) order.push(id);
  }
  const errors: string[] = [];
  let best: { series: SeriesData; provider: ProviderId; cov: number } | null = null;
  for (const id of order) {
    if (blocked.has(id)) continue;
    if (id === 'yahoo' && !spec.yahoo) continue;
    try {
      const series = await loadFrom(PROVIDERS[id], o);
      if (series.length === 0) {
        errors.push(`${PROVIDERS[id].label}: нет данных ${o.symbol} за период`);
        continue;
      }
      const cov = coverage(series, o.start, o.end);
      if (!best || cov > best.cov + 0.02) best = { series, provider: id, cov };
      // почти полное покрытие (допуск — выходные/праздники) — дальше не ищем
      if (!stockLike || o.provider === 'synthetic' || series.t[0] <= o.start + 5 * DAY || cov > 0.97) break;
      errors.push(`${PROVIDERS[id].label}: ${o.symbol} есть только с ${new Date(series.t[0]).toISOString().slice(0, 10)} — ищем более длинную историю`);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      const msg = String(e?.message || e);
      if (e?.status === 403 || /403|block|restricted/i.test(msg)) {
        blocked.add(id);
        errors.push(`${PROVIDERS[id].label} недоступен из вашего региона (HTTP 403) — используется резервный источник`);
      } else errors.push(`${PROVIDERS[id].label}: ${msg.slice(0, 160)}`);
    }
  }
  if (best) return { series: best.series, provider: best.provider, errors };
  throw new Error(`Не удалось загрузить ${o.symbol}:\n${errors.join('\n')}`);
}

export async function loadFunding(
  provider: ProviderId,
  symbol: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<FundingPoint[]> {
  const p = PROVIDERS[provider];
  // спотовые инструменты (xStocks, золото) — без funding
  if (!p.fetchFunding || getAsset(symbol).spotOnly) return [];
  const key = `${provider}|${symbol}|${start}|${end}`;
  if (provider !== 'synthetic') {
    const cached = await idbGet<FundingPoint[]>('funding', key);
    if (cached) return cached;
  }
  const pts = await p.fetchFunding(symbol, start, end, { signal });
  pts.sort((a, b) => a.t - b.t);
  const uniq = pts.filter((x, i) => i === 0 || x.t !== pts[i - 1].t);
  if (provider !== 'synthetic' && end < Date.now()) await idbSet('funding', key, uniq);
  return uniq;
}

/** Импорт CSV: time,open,high,low,close[,volume]; время — мс, секунды или ISO. */
export function parseCsvCandles(text: string): Candle[] {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Candle[] = [];
  for (const row of rows) {
    const cols = row.split(/[;,\t]/).map((x) => x.trim());
    if (cols.length < 5) continue;
    let t = Number(cols[0]);
    if (!Number.isFinite(t)) {
      t = Date.parse(cols[0]);
      if (!Number.isFinite(t)) continue; // заголовок
    } else if (t < 1e11) t *= 1000;
    const [o, h, l, c] = cols.slice(1, 5).map(Number);
    const v = cols[5] !== undefined ? Number(cols[5]) : 0;
    if ([o, h, l, c].some((x) => !Number.isFinite(x))) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return dedupe(out);
}
