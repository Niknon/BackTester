import { apiGet } from './http';
import { DAY, HOUR, businessMs, intervalMs, type HourProfile } from './intervals';
import { lowerBound, type SeriesData } from './types';

/**
 * Реализованная волатильность (годовая) по часовым лог-доходностям.
 * rv7 / rv30 — скользящие окна 7 и 30 дней. Значение в момент t использует
 * только данные ДО t (без заглядывания в будущее).
 */
export interface RealizedVol {
  t: Float64Array; // часовые метки
  rv7: Float64Array;
  rv30: Float64Array;
  length: number;
}

const ANNUAL_HOURS = 24 * 365;
/** Рабочих часов в году (пн–пт круглосуточно): годовая волатильность по будням сопоставима с календарной. */
const ANNUAL_BUSINESS_HOURS = 24 * (365 / 7) * 5;

/**
 * Профиль активности по часам суток (будни, UTC) по истории актива: какая доля дневной дисперсии цены
 * приходится на каждый час. Доходность относится к часу свечи, которая её показала: гэп через ночь
 * или выходные — к первой свече после перерыва (пока свечей нет, цена «стоит» и время почти не идёт).
 * Это форма распределения, а не уровень волатильности: у акций почти вся дисперсия — в часы
 * торговой сессии. null — свечи не внутридневные или истории мало.
 */
export function computeHourProfile(s: SeriesData): HourProfile | null {
  const dt = intervalMs(s.interval);
  if (dt >= DAY || s.length < 200) return null;
  const acc = new Float64Array(24);
  for (let i = 1; i < s.length; i++) {
    const r = Math.log(s.c[i] / s.c[i - 1]);
    if (!Number.isFinite(r)) continue;
    const d = new Date(s.t[i]);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    acc[d.getUTCHours()] += r * r;
  }
  const tot = acc.reduce((x, y) => x + y, 0);
  if (!(tot > 0)) return null;
  // время не должно останавливаться совсем: минимум — 2% среднего часа
  const w = Array.from(acc, (x) => Math.max((x / tot) * 24, 0.02));
  const k = 24 / w.reduce((x, y) => x + y, 0);
  const c = new Float64Array(25);
  for (let h = 0; h < 24; h++) c[h + 1] = c[h] + w[h] * k;
  c[24] = 24;
  return c;
}

/**
 * Реализованная волатильность (7 и 30 дней), годовая.
 * clock = 'business' — для акций/сырья: дисперсия делится на рабочее время (выходные не считаются, а с профилем
 * часов — час сессии «длиннее» ночного). Так она согласована с ценой опционов, у которых время идёт так же.
 */
export function computeRealizedVol(s: SeriesData, clock: 'calendar' | 'business' = 'calendar', profile: HourProfile | null = null): RealizedVol {
  // выборка цен закрытия на часовой сетке (или по барам, если бар > 1ч)
  const times: number[] = [];
  const closes: number[] = [];
  let lastHour = -Infinity;
  const dt = intervalMs(s.interval);
  for (let i = 0; i < s.length; i++) {
    const closeTime = s.t[i] + dt;
    const hr = Math.floor(closeTime / HOUR);
    if (hr !== lastHour) {
      times.push(closeTime);
      closes.push(s.c[i]);
      lastHour = hr;
    } else {
      closes[closes.length - 1] = s.c[i];
      times[times.length - 1] = closeTime;
    }
  }
  const n = times.length;
  const rv7 = new Float64Array(n);
  const rv30 = new Float64Array(n);
  const t = new Float64Array(times);
  const r2 = new Float64Array(n);
  const hoursPer = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    r2[i] = Number.isFinite(r) ? r * r : 0;
    const span = clock === 'business' ? businessMs(t[i - 1], t[i], profile) : t[i] - t[i - 1];
    hoursPer[i] = Math.max(clock === 'business' ? 0.01 : 1, span / HOUR);
  }
  const roll = (windowHours: number, out: Float64Array) => {
    let sum = 0;
    let hrs = 0;
    let j = 1;
    for (let i = 1; i < n; i++) {
      sum += r2[i];
      hrs += hoursPer[i];
      while (j < i && t[i] - t[j] > windowHours * HOUR) {
        sum -= r2[j];
        hrs -= hoursPer[j];
        j++;
      }
      out[i] = hrs >= 24 ? Math.sqrt((sum / hrs) * (clock === 'business' ? ANNUAL_BUSINESS_HOURS : ANNUAL_HOURS)) : NaN;
    }
    out[0] = NaN;
  };
  roll(24 * 7, rv7);
  roll(24 * 30, rv30);
  return { t, rv7, rv30, length: n };
}

export function realizedVolAt(rv: RealizedVol | undefined, time: number): { rv7: number; rv30: number } | null {
  if (!rv || !rv.length) return null;
  let i = lowerBound(rv.t, rv.length, time + 1) - 1;
  if (i < 0) return null;
  // ищем ближайшее валидное значение
  while (i > 0 && !Number.isFinite(rv.rv30[i]) && !Number.isFinite(rv.rv7[i])) i--;
  const a = rv.rv7[i];
  const b = rv.rv30[i];
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  return { rv7: Number.isFinite(a) ? a : b, rv30: Number.isFinite(b) ? b : a };
}

/** Индекс DVOL Deribit (подразумеваемая 30-дн. волатильность) — только BTC и ETH. */
export interface DvolSeries {
  t: Float64Array;
  v: Float64Array; // в долях (0.55 = 55%)
  length: number;
}

export async function fetchDvol(currency: 'BTC' | 'ETH', start: number, end: number, signal?: AbortSignal): Promise<DvolSeries> {
  const rows: [number, number][] = [];
  let to = end;
  for (let guard = 0; guard < 400; guard++) {
    const json = await apiGet(
      '/proxy/deribit',
      'https://www.deribit.com',
      '/api/v2/public/get_volatility_index_data',
      { currency, start_timestamp: start, end_timestamp: to, resolution: 3600 },
      signal,
    );
    const data: number[][] = json?.result?.data || [];
    if (!data.length) break;
    for (const d of data) rows.push([d[0], d[4] / 100]);
    const cont = json?.result?.continuation;
    if (!cont || cont <= start) break;
    to = cont;
  }
  rows.sort((a, b) => a[0] - b[0]);
  const uniq = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
  return {
    t: new Float64Array(uniq.map((r) => r[0])),
    v: new Float64Array(uniq.map((r) => r[1])),
    length: uniq.length,
  };
}

export function dvolAt(d: DvolSeries | undefined, time: number): number | null {
  if (!d || !d.length) return null;
  const i = lowerBound(d.t, d.length, time + 1) - 1;
  return i >= 0 ? d.v[i] : null;
}
