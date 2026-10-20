import { apiGetBinary, pool, sleep } from '../http';
import { idbGet, idbSet } from '../cache';
import { DAY, HOUR, intervalMs } from '../intervals';
import type { Candle, IntervalKey } from '../types';
import { getAsset } from '../assets';
import { lzmaDecompress } from '../../lib/lzma';
import { DUKA_US_LIST } from '../dukascopyList';
import type { DataProvider, FetchOpts, Klines } from './provider';

const PROXY = '/proxy/dukascopy';
const DIRECT = 'https://datafeed.dukascopy.com';

/**
 * Dukascopy — бесплатная внутридневная история CFD: ~680 акций и ETF США (с 2017),
 * индексы S&P 500 / Nasdaq-100 (с 2012), золото (с 2003), серебро, нефть, газ, медь.
 * Файлы: часовые свечи — по месяцам, минутные — по дням (LZMA, 24 байта на свечу).
 * Цены акций в архиве НЕ скорректированы на сплиты — это делает загрузчик по данным Yahoo.
 */
export interface DukaInstrument {
  file: string;
  /** начало истории (мс) */
  start: number;
  /** делитель цены: 10 / размер пункта */
  scale: number;
  /** CFD на индекс/сырьё: цена отличается от фьючерса Yahoo (базис) — склеивать источники нельзя */
  cfd?: boolean;
}

const ymd = (s: string) => Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)));

let usMap: Map<string, number> | null = null;
function usStocks() {
  if (!usMap) {
    usMap = new Map();
    for (const it of DUKA_US_LIST.split(',')) {
      const [t, d] = it.split(':');
      usMap.set(t, ymd(d));
    }
  }
  return usMap;
}

/** Индексы и сырьё: базовый актив каталога → инструмент Dukascopy. */
const SPECIAL: Record<string, DukaInstrument> = {
  US500: { file: 'USA500IDXUSD', start: Date.UTC(2012, 0, 17), scale: 1000, cfd: true },
  US100: { file: 'USATECHIDXUSD', start: Date.UTC(2012, 0, 20), scale: 1000, cfd: true },
  XAU: { file: 'XAUUSD', start: Date.UTC(2003, 4, 5), scale: 1000, cfd: true },
  XAG: { file: 'XAGUSD', start: Date.UTC(2014, 6, 25), scale: 1000, cfd: true },
  XPT: { file: 'XPTCMDUSD', start: Date.UTC(2021, 10, 1), scale: 1000, cfd: true },
  XPD: { file: 'XPDCMDUSD', start: Date.UTC(2021, 6, 5), scale: 1000, cfd: true },
  XCU: { file: 'COPPERCMDUSD', start: Date.UTC(2012, 2, 1), scale: 10000, cfd: true },
  CL: { file: 'LIGHTCMDUSD', start: Date.UTC(2011, 10, 10), scale: 1000, cfd: true },
  NG: { file: 'GASCMDUSD', start: Date.UTC(2012, 5, 25), scale: 10000, cfd: true },
};

/** Переименованные компании: тикер сейчас → тикер в архиве Dukascopy. */
const ALIAS: Record<string, string> = { META: 'FB', BRKB: 'BRK.B' };

export function dukaInstrument(symbol: string): DukaInstrument | null {
  let spec;
  try {
    spec = getAsset(symbol);
  } catch {
    return null;
  }
  if (!spec.yahoo) return null; // только акции, ETF, индексы и сырьё
  const base = spec.base;
  if (SPECIAL[base]) return SPECIAL[base];
  const t = ALIAS[base] ?? base;
  const start = usStocks().get(t);
  if (start === undefined) return null;
  return { file: `${t.replace(/[.-]/g, '')}USUSD`, start, scale: 1000 };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Свечи из файла: время — смещение в секундах от начала периода; пустые (без сделок) пропускаем. */
export function parseBi5(buf: Uint8Array, base: number, scale: number): Candle[] {
  if (!buf.length) return [];
  const raw = lzmaDecompress(buf);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: Candle[] = [];
  for (let off = 0; off + 24 <= raw.length; off += 24) {
    const v = dv.getFloat32(off + 20);
    if (!(v > 0)) continue;
    const o = dv.getInt32(off + 4) / scale;
    const c = dv.getInt32(off + 8) / scale;
    const l = dv.getInt32(off + 12) / scale;
    const h = dv.getInt32(off + 16) / scale;
    if (!(o > 0 && c > 0 && l > 0 && h > 0)) continue;
    out.push({ t: base + dv.getInt32(off) * 1000, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v });
  }
  return out;
}

/** Сведение в свечи нужного интервала (UTC-сетка). */
function bucket(rows: Candle[], dt: number, start: number, end: number): Candle[] {
  rows.sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const r of rows) {
    const t = Math.floor(r.t / dt) * dt;
    if (t < start || t >= end) continue;
    const cur = out[out.length - 1];
    if (!cur || cur.t !== t) out.push({ ...r, t });
    else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
      cur.v += r.v;
    }
  }
  return out;
}

/** Пауза, на которую прекращаем запросы к недоступному серверу (или загрузку с него пропустили). */
const DOWN_KEY = 'duka.downUntil';
let downUntil = (() => {
  try {
    return Number(globalThis.localStorage?.getItem(DOWN_KEY)) || 0;
  } catch {
    return 0;
  }
})();
function setDown(ms: number) {
  downUntil = Date.now() + ms;
  try {
    globalThis.localStorage?.setItem(DOWN_KEY, String(downUntil));
  } catch {
    /* без localStorage — только на время работы страницы */
  }
}
let skipCtl = new AbortController();
/** Когда последний раз пришёл файл: если долго ни одного — сервер считаем недоступным. */
let lastOk = 0;

/** Dukascopy сейчас недоступен или загрузку с него пропустили. */
export function dukascopyDown() {
  return Date.now() < downUntil;
}

/** Пропустить загрузку с Dukascopy (кнопка на экране загрузки): дальше — свечи основного источника. */
export function skipDukascopy() {
  setDown(30 * 60_000);
  skipCtl.abort();
  skipCtl = new AbortController();
}

/**
 * Сервер архива (2026 г.) отвечает медленно — первый байт файла через 10–25 с, — а при нескольких запросах
 * сразу начинает отвечать 503 «No server is available» на всё подряд, и так минутами. Поэтому одновременных
 * запросов — от 1 до 3: после отказа (503/429/обрыв/таймаут) — один и пауза, после серии удачных — на один больше.
 * Таймаут попытки — с запасом (прокси ждёт 60 с). От архива отказываемся, только если ни одного файла
 * не пришло за GIVE_UP_MS, и тогда не трогаем его 10 минут (и после перезагрузки страницы тоже).
 */
const WORKERS = 3;
const FILE_TIMEOUT = 55_000;
const GIVE_UP_MS = 4 * 60_000;
const MAX_ATTEMPTS = 6;
let limit = 2;
let active = 0;
let okStreak = 0;
/** Последний отказ сервера: с какой паузой повторяем (для сообщения на экране загрузки). */
let lastTrouble = { at: 0, wait: 0, status: '' };

async function acquire(signal?: AbortSignal) {
  while (active >= limit) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await sleep(250);
  }
  active++;
}

/**
 * Минутные файлы — по одному на день (5 лет — ~1250 запросов, при таком сервере — часы), поэтому для интервалов
 * меньше часа они берутся только за последние DUKA_MINUTE_DAYS дней, а более старая история — часовыми
 * свечами из месячных файлов (60 запросов на 5 лет).
 */
export const DUKA_MINUTE_DAYS = 120;

interface FileJob {
  path: string;
  /** начало периода файла (время свечей — смещение от него) */
  base: number;
  /** свечи файла, которые берём: [from, to) */
  from: number;
  to: number;
}

const FAILED = Symbol('failed');

/** Файл архива: из кэша браузера или с сервера. Каждый файл — за завершённый период, кэшируется навсегда. */
async function getFile(j: FileJob, t0: number, signal?: AbortSignal): Promise<Uint8Array | null | typeof FAILED> {
  const key = `duka|${j.path}`;
  const cached = await idbGet<{ b: Uint8Array | null }>('klines', key);
  if (cached) return cached.b;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (dukascopyDown()) return FAILED;
    const skip = skipCtl.signal;
    const sig = signal ? AbortSignal.any([signal, skip]) : skip;
    let waitMs = 0;
    await acquire(sig).catch(() => null);
    if (sig.aborted) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return FAILED;
    }
    try {
      const b = await apiGetBinary(PROXY, DIRECT, j.path, sig, 0, FILE_TIMEOUT);
      lastOk = Date.now();
      if (++okStreak >= 4 && limit < WORKERS) {
        limit++;
        okStreak = 0;
      }
      await idbSet('klines', key, { b });
      return b;
    } catch (e: any) {
      if (signal?.aborted) throw e;
      if (e?.status === 403) throw e;
      if (skip.aborted) return FAILED;
      // сервер перегружен: дальше по одному запросу
      limit = 1;
      okStreak = 0;
      // давно ни одного файла — сервер недоступен: дальше берём свечи основного источника
      if (Date.now() - Math.max(lastOk, t0) > GIVE_UP_MS) {
        setDown(10 * 60_000);
        return FAILED;
      }
      waitMs = Math.min(30_000, 3000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
      lastTrouble = { at: Date.now(), wait: waitMs, status: e?.status ? String(e.status) : String(e?.message || 'обрыв') };
    } finally {
      active--;
    }
    await sleep(waitMs);
  }
  return FAILED;
}

export const dukascopyProvider: DataProvider = {
  id: 'dukascopy',
  label: 'Dukascopy',
  async fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts: FetchOpts = {}) {
    const inst = dukaInstrument(symbol);
    if (!inst) throw new Error(`${symbol}: нет в архиве Dukascopy`);
    const dt = intervalMs(interval);
    const from = Math.max(start, inst.start);
    const today = Math.floor(Date.now() / DAY) * DAY;
    const to = Math.min(end, today); // файл текущего дня появляется только после его окончания
    if (from >= to) return [];
    const jobs: FileJob[] = [];
    const dayJobs = (a: number, b: number) => {
      for (let d = Math.floor(a / DAY) * DAY; d < b; d += DAY) {
        if (new Date(d).getUTCDay() === 6) continue; // суббота — торгов нет
        const x = new Date(d);
        jobs.push({ path: `/datafeed/${inst.file}/${x.getUTCFullYear()}/${pad(x.getUTCMonth())}/${pad(x.getUTCDate())}/BID_candles_min_1.bi5`, base: d, from: Math.max(a, d), to: Math.min(b, d + DAY) });
      }
    };
    // часовые свечи: файл на месяц; текущий (незавершённый) месяц — из минутных файлов по дням
    const monthJobs = (a: number, b: number) => {
      const s = new Date(a);
      for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); Date.UTC(y, m, 1) < b; m === 11 ? (y++, (m = 0)) : m++) {
        const ms = Date.UTC(y, m, 1);
        const me = Date.UTC(y, m + 1, 1);
        if (me > today) dayJobs(Math.max(ms, a), b);
        else jobs.push({ path: `/datafeed/${inst.file}/${y}/${pad(m)}/BID_candles_hour_1.bi5`, base: ms, from: Math.max(a, ms), to: Math.min(b, me) });
      }
    };
    if (dt >= HOUR) monthJobs(from, to);
    else {
      const minuteFrom = Math.max(from, today - DUKA_MINUTE_DAYS * DAY);
      if (from < minuteFrom) monthJobs(from, minuteFrom);
      if (minuteFrom < to) dayJobs(minuteFrom, to);
    }
    const t0 = Date.now();
    let done = 0;
    let failed = 0;
    let fetched = 0;
    const progress = () => {
      const left = jobs.length - done;
      const rate = fetched > 0 ? (Date.now() - t0) / fetched : 0;
      const eta = rate && left > WORKERS ? ` · осталось ~${Math.max(1, Math.round((left * rate) / 60_000))} мин` : '';
      const quiet = Math.round((Date.now() - Math.max(lastOk, t0)) / 1000);
      const trouble =
        Date.now() - lastTrouble.at < 60_000
          ? `\nСервер архива перегружен (${lastTrouble.status}) — повторяем по одному запросу; без ответа ${quiet} с, после ${GIVE_UP_MS / 60_000} мин без ответа загрузка продолжится без архива.`
          : '';
      opts.onProgress?.(done, jobs.length, `Dukascopy: ${symbol} — файлы архива ${done} из ${jobs.length}${eta}. Сервер отвечает медленно (10–25 с на файл), скачанное сохраняется.${trouble}`);
    };
    // пока ждём ответа, сообщение о перегрузке и времени без ответа должно обновляться
    const ticker = setInterval(() => jobs.length && progress(), 5000);
    if (jobs.length) progress(); // сразу показываем, что идёт загрузка с Dukascopy
    let parts: Candle[][];
    try {
      parts = await pool(
        jobs,
        WORKERS,
        async (j) => {
          const b = await getFile(j, t0, opts.signal);
          done++;
          if (b === FAILED) {
            failed++; // пропуск заполнится из основного источника
            progress();
            return [] as Candle[];
          }
          fetched++;
          progress();
          return b ? parseBi5(b, j.base, inst.scale).filter((c) => c.t >= j.from && c.t < j.to) : [];
        },
        opts.signal,
      );
    } finally {
      clearInterval(ticker);
    }
    // даже если не загрузилось ничего, не прерываем загрузку остальных кусков: пропуски заполнит основной источник
    const out: Klines = bucket(parts.flat(), dt, start, end);
    if (failed) out.partial = failed;
    return out;
  },
};
