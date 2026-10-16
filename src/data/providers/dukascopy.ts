import { apiGetBinary, pool, sleep } from '../http';
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

/** Подряд не загрузившиеся файлы и пауза, на которую прекращаем запросы к перегруженному серверу. */
let failStreak = 0;
let downUntil = 0;
let skipCtl = new AbortController();

/** Dukascopy сейчас недоступен (ограничение частоты) или загрузку с него пропустили. */
export function dukascopyDown() {
  return Date.now() < downUntil;
}

/** Пропустить загрузку с Dukascopy (кнопка на экране загрузки): дальше — свечи основного источника. */
export function skipDukascopy() {
  downUntil = Date.now() + 30 * 60_000;
  skipCtl.abort();
  skipCtl = new AbortController();
}

interface FileJob {
  path: string;
  base: number;
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
        jobs.push({ path: `/datafeed/${inst.file}/${x.getUTCFullYear()}/${pad(x.getUTCMonth())}/${pad(x.getUTCDate())}/BID_candles_min_1.bi5`, base: d });
      }
    };
    if (dt >= HOUR) {
      // часовые свечи: файл на месяц; текущий (незавершённый) месяц — из минутных файлов по дням
      const s = new Date(from);
      for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); Date.UTC(y, m, 1) < to; m === 11 ? (y++, (m = 0)) : m++) {
        const ms = Date.UTC(y, m, 1);
        const me = Date.UTC(y, m + 1, 1);
        if (me > today) dayJobs(Math.max(ms, from), to);
        else jobs.push({ path: `/datafeed/${inst.file}/${y}/${pad(m)}/BID_candles_hour_1.bi5`, base: ms });
      }
    } else dayJobs(from, to);
    let done = 0;
    let failed = 0;
    if (jobs.length) opts.onProgress?.(0, jobs.length); // сразу показываем, что идёт загрузка с Dukascopy
    const parts = await pool(
      jobs,
      2,
      async (j) => {
        let rows: Candle[] = [];
        if (dukascopyDown()) failed++; // сервер не отвечает или загрузку пропустили — дальше не ждём
        else {
          // отдельная отмена: «Пропустить Dukascopy» прерывает только эти запросы, а не всю загрузку
          const skip = skipCtl.signal;
          const signal = opts.signal ? AbortSignal.any([opts.signal, skip]) : skip;
          try {
            const buf = await apiGetBinary(PROXY, DIRECT, j.path, signal);
            rows = buf ? parseBi5(buf, j.base, inst.scale) : [];
            failStreak = 0;
          } catch (e: any) {
            if (opts.signal?.aborted) throw e;
            if (e?.status === 403) throw e;
            failed++; // сервер ограничивает частоту — пропуск заполнится из основного источника
            // несколько файлов подряд не загрузились — сервер перегружен, на время прекращаем попытки
            if (++failStreak >= 3) downUntil = Date.now() + 10 * 60_000;
          }
          await sleep(250); // Dukascopy ограничивает частоту запросов
        }
        opts.onProgress?.(++done, jobs.length);
        return rows;
      },
      opts.signal,
    );
    // даже если не загрузилось ничего, не прерываем загрузку остальных кусков: пропуски заполнит основной источник
    const out: Klines = bucket(parts.flat(), dt, start, end);
    if (failed) out.partial = failed;
    return out;
  },
};
