import type { IntervalKey } from './types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

const MONDAY0 = 4 * DAY; // 1970-01-05 — понедельник

/**
 * Профиль активности по часам суток (UTC): накопленный «вес» часов c[0..24], c[0] = 0, c[24] = 24.
 * Вес часа h = c[h+1] − c[h]; у равномерного профиля каждый час весит 1.
 */
export type HourProfile = Float64Array;

/** Время с начала суток, взвешенное профилем, мс. */
function dayMs(within: number, p?: HourProfile | null) {
  if (!p) return within;
  const h = Math.min(23, Math.floor(within / HOUR));
  const frac = (within - h * HOUR) / HOUR;
  return (p[h] + (p[h + 1] - p[h]) * frac) * HOUR;
}

/** Миллисекунды будней (пн–пт, UTC) от понедельника 05.01.1970 до t (внутри дня — по профилю, если он задан). */
function weekdayMs(t: number, p?: HourProfile | null) {
  const x = t - MONDAY0;
  const w = Math.floor(x / WEEK);
  const r = x - w * WEEK;
  const d = Math.floor(r / DAY);
  return w * 5 * DAY + (d < 5 ? d * DAY + dayMs(r - d * DAY, p) : 5 * DAY);
}

/** Праздники биржи: начала суток (UTC) будних дней без торгов, по возрастанию. */
export type Holidays = Float64Array;

/**
 * Рабочее (будничное, пн–пт UTC) время между a и b, мс. С профилем час торговой сессии «длиннее»
 * ночного: время идёт так, как реально меняется цена (сутки по-прежнему весят 24 часа).
 * Праздники биржи (holidays) — как выходные: в эти дни цена стоит, и опцион за них не дешевеет.
 */
export function businessMs(a: number, b: number, profile?: HourProfile | null, holidays?: Holidays | null) {
  let ms = weekdayMs(b, profile) - weekdayMs(a, profile);
  if (holidays?.length && b > a) {
    // первый праздник, который может пересекаться с [a, b)
    let lo = 0;
    let hi = holidays.length;
    const from = Math.floor(a / DAY) * DAY;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (holidays[m] < from) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < holidays.length && holidays[i] < b; i++) {
      const x = Math.max(a, holidays[i]);
      const y = Math.min(b, holidays[i] + DAY);
      if (y > x) ms -= weekdayMs(y, profile) - weekdayMs(x, profile);
    }
  }
  return ms;
}

export interface IntervalDef {
  key: IntervalKey;
  ms: number;
  label: string;
  bybit: string;
  okx: string;
  binance: string;
}

export const INTERVALS: IntervalDef[] = [
  { key: '1m', ms: MINUTE, label: '1м', bybit: '1', okx: '1m', binance: '1m' },
  { key: '3m', ms: 3 * MINUTE, label: '3м', bybit: '3', okx: '3m', binance: '3m' },
  { key: '5m', ms: 5 * MINUTE, label: '5м', bybit: '5', okx: '5m', binance: '5m' },
  { key: '15m', ms: 15 * MINUTE, label: '15м', bybit: '15', okx: '15m', binance: '15m' },
  { key: '30m', ms: 30 * MINUTE, label: '30м', bybit: '30', okx: '30m', binance: '30m' },
  { key: '1h', ms: HOUR, label: '1ч', bybit: '60', okx: '1H', binance: '1h' },
  { key: '2h', ms: 2 * HOUR, label: '2ч', bybit: '120', okx: '2H', binance: '2h' },
  { key: '4h', ms: 4 * HOUR, label: '4ч', bybit: '240', okx: '4H', binance: '4h' },
  { key: '6h', ms: 6 * HOUR, label: '6ч', bybit: '360', okx: '6Hutc', binance: '6h' },
  { key: '12h', ms: 12 * HOUR, label: '12ч', bybit: '720', okx: '12Hutc', binance: '12h' },
  { key: '1d', ms: DAY, label: '1Д', bybit: 'D', okx: '1Dutc', binance: '1d' },
  { key: '1w', ms: WEEK, label: '1Н', bybit: 'W', okx: '1Wutc', binance: '1w' },
];

const BY_KEY = new Map(INTERVALS.map((d) => [d.key, d]));

export function intervalDef(key: IntervalKey): IntervalDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`Unknown interval ${key}`);
  return d;
}

export function intervalMs(key: IntervalKey): number {
  return intervalDef(key).ms;
}

/**
 * Начало «корзины» таймфрейма для времени t. Недельные свечи Bybit
 * начинаются в понедельник 00:00 UTC (эпоха 1970-01-01 — четверг).
 */
export function bucketStart(t: number, tfMs: number): number {
  if (tfMs === WEEK) {
    const MONDAY_OFFSET = 4 * DAY; // 1970-01-05 — понедельник
    return Math.floor((t - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
  }
  return Math.floor(t / tfMs) * tfMs;
}

/** Таймфреймы графика, доступные при заданном базовом интервале. */
export function chartIntervalsFor(base: IntervalKey): IntervalDef[] {
  const b = intervalMs(base);
  return INTERVALS.filter((d) => d.ms >= b && d.ms % b === 0);
}
