import { idbGet, idbSet } from './cache';
import { intervalMs } from './intervals';
import type { Candle, FundingPoint, IntervalKey, ProviderId, SeriesData } from './types';
import { lowerBound, seriesFromCandles } from './types';
import type { DataProvider, Klines } from './providers/provider';
import { bybitProvider } from './providers/bybit';
import { okxProvider } from './providers/okx';
import { binanceProvider } from './providers/binance';
import { syntheticProvider } from './providers/synthetic';
import { allSplits, fetchSplits, yahooDaily, yahooIntradayFrom, yahooProvider, type Split } from './providers/yahoo';
import { DUKA_MINUTE_DAYS, dukaInstrument, dukascopyDown, dukascopyProvider } from './providers/dukascopy';
import { getAsset } from './assets';
import { DAY, HOUR } from './intervals';

export const PROVIDERS: Record<ProviderId, DataProvider> = {
  bybit: bybitProvider,
  okx: okxProvider,
  binance: binanceProvider,
  yahoo: yahooProvider,
  dukascopy: dukascopyProvider,
  synthetic: syntheticProvider,
};

export const PROVIDER_LIST: { id: ProviderId; label: string; note: string }[] = [
  { id: 'bybit', label: 'Bybit', note: 'Основной источник: свечи и funding USDT-перпетуалов Bybit' },
  { id: 'okx', label: 'OKX', note: 'Фолбэк: те же активы (кроме MNT/TON), funding — только ~3 мес.' },
  { id: 'binance', label: 'Binance Futures', note: 'Фолбэк: крипто-перпетуалы Binance (без TradFi и xStocks)' },
  {
    id: 'yahoo',
    label: 'Yahoo Finance (акции США)',
    note: 'Акции, ETF, индексы и сырьё США за десятилетия: дневные свечи — вся история, 1ч — 2 года, 5–30 мин — 60 дней. Более старую внутридневную историю автоматически добирает с Dukascopy. Крипту берёт с Bybit/OKX/Binance',
  },
  {
    id: 'dukascopy',
    label: 'Dukascopy (внутридневная история)',
    note: 'Минутные и часовые свечи ~680 акций и ETF США (с 2017), S&P 500 и Nasdaq-100 (с 2012), золота (с 2003), серебра, нефти, газа, меди. Цены приводятся к сплитам по Yahoo. Крипту берёт с Bybit/OKX/Binance',
  },
  { id: 'synthetic', label: 'Синтетика', note: 'Офлайн-генератор: для тестов логики без интернета' },
];

const CHUNK_BARS = 5000;
/** Версия кэша свечей источника: меняется, когда исправлена обработка его данных (старый кэш перекачивается). */
const CACHE_VER: Partial<Record<ProviderId, string>> = { yahoo: '#3' };
/** Самая ранняя дата запроса: криптобиржи — с 2018, Yahoo (акции США) — с 1980, Dukascopy — с 2003. */
const EARLIEST: Partial<Record<ProviderId, number>> = { yahoo: Date.UTC(1980, 0, 1), dukascopy: Date.UTC(2003, 0, 1) };
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
  /** догружать старую внутридневную историю с Dukascopy (false — только основной источник) */
  archive?: boolean;
}

export interface LoadResult {
  series: SeriesData;
  provider: ProviderId;
  errors: string[];
}

async function loadFrom(p: DataProvider, o: LoadOptions, stats?: { partial: number }): Promise<SeriesData> {
  const dt = intervalMs(o.interval);
  const span = CHUNK_BARS * dt;
  const now = Date.now();
  const first = Math.floor(o.start / span) * span;
  const chunks: number[] = [];
  for (let cs = first; cs < o.end; cs += span) chunks.push(cs);
  const all: Candle[] = [];
  let done = 0;
  const tag = p.cacheTag && p.id !== 'synthetic' ? await p.cacheTag(o.symbol, o.signal).catch(() => '') : '';
  for (const cs of chunks) {
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = `${p.id}${CACHE_VER[p.id] ?? ''}|${o.symbol}|${o.interval}|${cs}${tag ? `|${tag}` : ''}`;
    let chunk = p.id === 'synthetic' ? undefined : await idbGet<CachedChunk>('klines', key);
    if (!chunk || !chunk.complete) {
      const from = Math.max(cs, EARLIEST[p.id] ?? DEFAULT_EARLIEST);
      const to = Math.min(cs + span, Math.floor(now / dt) * dt + dt);
      const candles = from < to ? await p.fetchKlines(o.symbol, o.interval, from, to, {
        signal: o.signal,
        onProgress: (d, t, m) => o.onProgress?.(done + (t ? d / t : 0), chunks.length, m ?? `${p.label}: ${o.symbol}`),
      }) : [];
      const partial = (candles as Klines).partial ?? 0;
      if (partial && stats) stats.partial += partial;
      const complete = cs + span <= now - dt && !partial;
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
  // берём длинную историю с Yahoo Finance, а внутридневную старше лимитов Yahoo — с Dukascopy
  const stockLike = !!spec.yahoo;
  // Dukascopy — дополнение к основному источнику (сплиты и свежие свечи берутся с Yahoo)
  const primary: ProviderId = o.provider === 'dukascopy' ? (stockLike ? 'yahoo' : 'bybit') : o.provider;
  const order: ProviderId[] = [primary];
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
  if (best && stockLike && o.provider !== 'synthetic' && o.fallback !== false) {
    const merged = await withIntradayHistory(o, best, errors);
    if (merged) return { series: await repairSplitBlocks(merged, o, errors, best.provider === 'yahoo' ? best.series : undefined), provider: 'dukascopy', errors };
  }
  if (best) return { series: stockLike && best.provider !== 'synthetic' ? await repairSplitBlocks(best.series, o, errors) : best.series, provider: best.provider, errors };
  throw new Error(`Не удалось загрузить ${o.symbol}:\n${errors.join('\n')}`);
}

const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Куски истории акции без поправки на сплит. Цена там отличается от остальной истории ровно в «сплитовое»
 * число раз (×10 у NFLX/NVDA), и на стыках — ложные скачки цены: купленный колл на таком «скачке» даёт
 * тысячи процентов. Источники: внутридневные окна Yahoo, закончившиеся до сплита, перпетуалы бирж,
 * архивы. Сверяем каждый день с дневной ценой Yahoo (она скорректирована на все сплиты) и делим дни,
 * где расхождение совпадает с произведением последующих сплитов.
 */
/** Типичные коэффициенты сплитов — если список сплитов получить не удалось. */
const COMMON_SPLITS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];

export function fixSplitBlocks(s: SeriesData, splits: Split[] | null, ref: { t: number; c: number }[]): { series: SeriesData; fixed: { from: number; to: number; factor: number }[] } {
  const fixed: { from: number; to: number; factor: number }[] = [];
  if (!s.length || (splits && !splits.length) || !ref.length) return { series: s, fixed };
  const refDay = new Map<number, number>();
  for (const r of ref) refDay.set(Math.floor(r.t / DAY), r.c);
  const sp = splits ? [...splits].sort((a, b) => a.t - b.t) : [];
  const generic = [1, ...COMMON_SPLITS, ...COMMON_SPLITS.map((x) => 1 / x)];
  // множитель цены дня d: произведение сплитов после него (и его «хвосты» — если часть сплитов учтена);
  // обратные — если поправку на сплит применили к уже скорректированным ценам
  const candidates = (dayStart: number) => {
    if (!splits) return generic;
    const later = sp.filter((x) => x.t > dayStart);
    const out = [1];
    for (let k = 0; k < later.length; k++) {
      const f = later.slice(k).reduce((a, x) => a * x.factor, 1);
      out.push(f, 1 / f);
    }
    return out;
  };
  const factorOfDay = new Map<number, number>();
  let i = 0;
  let prevF = 1;
  while (i < s.length) {
    const day = Math.floor(s.t[i] / DAY);
    let j = i;
    while (j < s.length && Math.floor(s.t[j] / DAY) === day) j++;
    const ref = refDay.get(day);
    let f = prevF;
    if (ref) {
      const r = Math.log(s.c[j - 1] / ref);
      f = 1;
      if (Math.abs(r) > 0.3) {
        let best = 1;
        for (const c of candidates(day * DAY)) if (Math.abs(r - Math.log(c)) < Math.abs(r - Math.log(best))) best = c;
        if (best !== 1 && Math.abs(r - Math.log(best)) < 0.2) f = best;
      }
    }
    if (f !== 1) factorOfDay.set(day, f);
    prevF = f;
    i = j;
  }
  if (!factorOfDay.size) return { series: s, fixed };
  const c: Candle[] = [];
  let prev = 1;
  for (let k = 0; k < s.length; k++) {
    const day = Math.floor(s.t[k] / DAY);
    const f = factorOfDay.get(day) ?? 1;
    c.push({ t: s.t[k], o: s.o[k] / f, h: s.h[k] / f, l: s.l[k] / f, c: s.c[k] / f, v: s.v[k] * f });
    if (f !== 1) {
      // непрерывный кусок — подряд идущие свечи с тем же множителем
      if (prev === f) fixed[fixed.length - 1].to = s.t[k];
      else fixed.push({ from: s.t[k], to: s.t[k], factor: f });
    }
    prev = f;
  }
  return { series: seriesFromCandles(s.symbol, s.interval, c), fixed };
}

/**
 * Проверка истории акции на куски без поправки на сплит (см. fixSplitBlocks). Эталон — дневные свечи Yahoo;
 * если запрос не прошёл — дневные свечи Yahoo из самой загрузки (fallbackRef). Если не получен список сплитов,
 * сверяем по типичным коэффициентам: расхождение с эталоном больше чем в 1.35 раза у верной истории не бывает.
 */
async function repairSplitBlocks(s: SeriesData, o: LoadOptions, errors: string[], fallbackRef?: SeriesData): Promise<SeriesData> {
  if (!s.length) return s;
  const abort = (e: any) => {
    if (e?.name === 'AbortError') throw e;
    return null;
  };
  let splits = await allSplits(o.symbol, o.signal).catch(abort);
  if (splits) {
    splits = splits.filter((x) => x.t > s.t[0]);
    if (!splits.length) return s;
  }
  let ref: { t: number; c: number }[] | null = await yahooDaily(o.symbol, s.t[0] - 7 * DAY, Date.now(), o.signal).catch(abort);
  if (!ref?.length && fallbackRef?.length) ref = Array.from(fallbackRef.t, (t, i) => ({ t, c: fallbackRef.c[i] }));
  if (!ref?.length) return s;
  const { series, fixed } = fixSplitBlocks(s, splits, ref);
  if (fixed.length > 3)
    errors.push(`${o.symbol}: ${fixed.length} кусков истории между ${fmtDay(fixed[0].from)} и ${fmtDay(fixed[fixed.length - 1].to)} пришли без поправки на сплит — исправлено по дневным ценам Yahoo`);
  else for (const f of fixed) errors.push(`${o.symbol}: свечи ${fmtDay(f.from)} — ${fmtDay(f.to)} пришли без поправки на сплит (цены ×${+f.factor.toFixed(4)}) — исправлено`);
  return series;
}

/**
 * Акции/индексы/сырьё на внутридневном интервале: Yahoo отдаёт 1ч только за 2 года, 5–30 мин — за 60 дней,
 * а раньше — лишь дневные свечи (на графике это выглядит как «не скачалось»). Если у актива есть архив
 * Dukascopy, берём из него весь доступный период (один источник — без ступенек на стыке), приводим цены
 * к сплитам и объёмы к масштабу Yahoo; до начала архива и в последние часы — свечи основного источника.
 */
async function withIntradayHistory(o: LoadOptions, best: { series: SeriesData; provider: ProviderId; cov: number }, errors: string[]): Promise<SeriesData | null> {
  const dt = intervalMs(o.interval);
  const inst = dukaInstrument(o.symbol);
  if (!inst || dt >= DAY || blocked.has('dukascopy')) return null;
  const coarseUntil = best.provider === 'yahoo' ? yahooIntradayFrom(o.interval) : best.cov < 0.97 ? o.end : -Infinity;
  const from = Math.max(o.start, inst.start);
  // основной источник уже детальный или грубых свечей всего несколько дней (обычно часть истории до старта) —
  // архив не нужен: дневные свечи там не мешают, а запросы к Dukascopy медленные
  if (o.provider !== 'dukascopy' && Math.min(o.end, coarseUntil) - from < 7 * DAY) return null;
  if (o.archive === false) {
    errors.push(`Dukascopy отключён в настройках сессии — для ${o.symbol} до ${fmtDay(Math.min(o.end, coarseUntil))} используются дневные свечи ${PROVIDERS[best.provider].label}`);
    return null;
  }
  if (dukascopyDown()) {
    errors.push(`Dukascopy сейчас не отвечает или пропущен — для ${o.symbol} до ${fmtDay(Math.min(o.end, coarseUntil))} используются дневные свечи ${PROVIDERS[best.provider].label}`);
    return null;
  }
  // акции: архив — только там, где основной источник грубый (цены те же, стык незаметен);
  // индексы/сырьё — весь период из архива: CFD отличается от фьючерса Yahoo на базис
  const to = inst.cfd || o.provider === 'dukascopy' ? o.end : Math.min(o.end, coarseUntil);
  if (from >= to) return null;
  let d: SeriesData;
  const stats = { partial: 0 };
  try {
    // один поток файлов на весь период (файлы кэшируются по одному — куски свечей кэшировать не нужно)
    const k = await PROVIDERS.dukascopy.fetchKlines(o.symbol, o.interval, from, to, {
      signal: o.signal,
      onProgress: (done, total, m) => o.onProgress?.(done, total, m ?? `Dukascopy: ${o.symbol}`),
    });
    stats.partial = k.partial ?? 0;
    d = seriesFromCandles(o.symbol, o.interval, dedupe(k));
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    errors.push(`Dukascopy: ${String(e?.message || e).slice(0, 160)} — для старых периодов остаются дневные свечи Yahoo`);
    return null;
  }
  if (!d.length) {
    if (stats.partial) errors.push(`Dukascopy: сервер не ответил (ограничение частоты запросов) — для ${o.symbol} до ${fmtDay(to)} остаются дневные свечи. Повторите загрузку позже`);
    return null;
  }
  const y = best.series;
  const candles: Candle[] = [];
  for (let i = 0; i < d.length; i++) candles.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i] });
  // сплиты: в архиве Dukascopy цены до сплита не скорректированы (AAPL 31.08.2020: 500 → 125)
  try {
    const splits = await fetchSplits(o.symbol, candles[0].t, Date.now(), o.signal);
    for (const sp of splits) {
      // проверяем по Yahoo (там уже скорректировано), не учтён ли сплит в архиве
      const k = candles.findIndex((c) => c.t >= sp.t) - 1;
      const yi = lowerBound(y.t, y.length, sp.t) - 1;
      if (k >= 0 && yi >= 0 && y.c[yi] > 0) {
        const r = candles[k].c / y.c[yi];
        if (Math.abs(Math.log(r)) < Math.abs(Math.log(r / sp.factor))) continue; // уже скорректировано
      }
      for (const c of candles) {
        if (c.t >= sp.t) break;
        c.o /= sp.factor;
        c.h /= sp.factor;
        c.l /= sp.factor;
        c.c /= sp.factor;
        c.v *= sp.factor;
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    errors.push(`Yahoo: не удалось получить сплиты ${o.symbol} — цены Dukascopy до сплитов могут отличаться`);
  }
  // объёмы Dukascopy — в своих единицах: приводим к масштабу Yahoo по общему периоду
  const lo = candles[0].t;
  const hi = candles[candles.length - 1].t + dt;
  let vy = 0;
  let vd = 0;
  for (let i = lowerBound(y.t, y.length, lo); i < y.length && y.t[i] < hi; i++) vy += y.v[i];
  for (const c of candles) vd += c.v;
  if (vy > 0 && vd > 0) for (const c of candles) c.v *= vy / vd;
  // склейка: основной источник до начала архива, после его последней свечи и в днях,
  // файлы которых не загрузились (сервер ограничивает частоту)
  const days = new Set(candles.map((c) => Math.floor(c.t / DAY)));
  const out: Candle[] = [...candles];
  let filled = 0;
  for (let i = 0; i < y.length; i++) {
    const t = y.t[i];
    const inside = t >= lo && t < hi;
    if (inside && days.has(Math.floor(t / DAY))) continue;
    if (inside) filled++;
    out.push({ t, o: y.o[i], h: y.h[i], l: y.l[i], c: y.c[i], v: y.v[i] });
  }
  const minuteFrom = Math.floor(Date.now() / DAY) * DAY - DUKA_MINUTE_DAYS * DAY;
  errors.push(
    `${o.symbol}: внутридневная история ${fmtDay(lo)} — ${fmtDay(hi)} загружена с Dukascopy` +
      (dt < HOUR && lo < minuteFrom ? ` (до ${fmtDay(minuteFrom)} — часовые свечи: минутные файлы архива идут по одному на день и грузились бы часами)` : '') +
      (o.start < lo ? `; раньше ${fmtDay(lo)} — ${PROVIDERS[best.provider].label} (${coarseUntil > o.start && best.provider === 'yahoo' ? 'дневные свечи' : 'как есть'})` : ''),
  );
  if (stats.partial)
    errors.push(
      `Dukascopy: ${stats.partial} файл(ов) истории ${o.symbol} не загрузились (сервер ограничивает частоту запросов)` +
        (filled ? ` — пропуски заполнены свечами ${PROVIDERS[best.provider].label}` : '') +
        '. Скачанные файлы сохранены в кэше — при следующей загрузке докачаются только недостающие',
    );
  return seriesFromCandles(o.symbol, o.interval, dedupe(out));
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
