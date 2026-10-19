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
 * торговой сессии. null — свечи не внутридневные или истории мало. skip — свечи реакции на отчёты (не учитываются).
 */
export function computeHourProfile(s: SeriesData, skip: Uint8Array | null = null): HourProfile | null {
  const dt = intervalMs(s.interval);
  if (dt >= DAY || s.length < 200) return null;
  const acc = new Float64Array(24);
  for (let i = 1; i < s.length; i++) {
    // реакция на отчёты — отдельный скачок, а не обычная активность часа
    if (skip?.[i]) continue;
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
export function computeRealizedVol(
  s: SeriesData,
  clock: 'calendar' | 'business' = 'calendar',
  profile: HourProfile | null = null,
  /** свечи реакции на отчёты: их доходность и время в волатильность не входят — скачок оценивается отдельно */
  skip: Uint8Array | null = null,
): RealizedVol {
  // выборка цен закрытия на часовой сетке (или по барам, если бар > 1ч)
  const times: number[] = [];
  const closes: number[] = [];
  const excl: number[] = [];
  let lastHour = -Infinity;
  const dt = intervalMs(s.interval);
  for (let i = 0; i < s.length; i++) {
    const closeTime = s.t[i] + dt;
    const hr = Math.floor(closeTime / HOUR);
    const sk = skip?.[i] ? 1 : 0;
    if (hr !== lastHour) {
      times.push(closeTime);
      closes.push(s.c[i]);
      excl.push(sk);
      lastHour = hr;
    } else {
      closes[closes.length - 1] = s.c[i];
      times[times.length - 1] = closeTime;
      excl[excl.length - 1] |= sk;
    }
  }
  const n = times.length;
  const rv7 = new Float64Array(n);
  const rv30 = new Float64Array(n);
  const t = new Float64Array(times);
  const r2 = new Float64Array(n);
  const hoursPer = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    if (excl[i]) continue; // r2 = 0 и время 0: интервал с отчётом просто выпадает из окна
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

/* ───────────────────────── Отчёты компаний ───────────────────────── */

/** Рабочих дней в году: дневная дисперсия = годовая (по рабочему времени) / BUSINESS_DAYS. */
export const BUSINESS_DAYS = (365 / 7) * 5;

/** Открытие основной сессии NYSE/Nasdaq (UTC) в день `day` (полночь UTC): 13:30 летом, 14:30 зимой. */
export function usOpenUtc(day: number): number {
  const y = new Date(day).getUTCFullYear();
  const sunday = (month: number, n: number) => {
    const first = Date.UTC(y, month, 1);
    return first + (((7 - new Date(first).getUTCDay()) % 7) + (n - 1) * 7) * DAY;
  };
  // летнее время в США: со 2-го воскресенья марта по 1-е воскресенье ноября
  const dst = day >= sunday(2, 2) && day < sunday(10, 1);
  return day + (dst ? 13.5 : 14.5) * HOUR;
}

/**
 * Свечи реакции цены на отчёт [первая, последняя]: от выхода отчёта до свечи, в которой открылась
 * основная сессия. Отчёт после закрытия (время ≥ 17:00 UTC) — реакция на постмаркете и на открытии
 * следующего рабочего дня; до открытия — премаркет и открытие того же дня. На дневных свечах это одна
 * свеча дня реакции. null — дня реакции нет в данных.
 */
export function reactionSpan(s: SeriesData, report: number): [number, number] | null {
  const dt = intervalMs(s.interval);
  const day = Math.floor(report / DAY) * DAY;
  const amc = new Date(report).getUTCHours() >= 17;
  let rDay = day;
  if (amc) {
    do rDay += DAY;
    while (new Date(rDay).getUTCDay() === 0 || new Date(rDay).getUTCDay() === 6);
  }
  const from = amc ? report : day;
  const open = usOpenUtc(rDay);
  const a = lowerBound(s.t, s.length, from);
  if (a < 1 || a >= s.length) return null;
  let b = a;
  while (b < s.length && s.t[b] + dt <= open) b++;
  // разрыв в данных: до свечи с открытием сессии слишком далеко
  if (b >= s.length || s.t[b] - from > 6 * DAY) return null;
  return [a, b];
}

/** Отчёты, которые попали в данные: окна реакции и маска свечей (1 — свеча реакции). */
export function reportSpans(s: SeriesData, reports: number[]): { spans: [number, number][]; at: number[]; mask: Uint8Array | null } {
  const spans: [number, number][] = [];
  const at: number[] = [];
  for (const r of [...reports].sort((x, y) => x - y)) {
    const sp = reactionSpan(s, r);
    // два сообщения об одном событии (предварительные итоги и отчёт) — одно окно
    if (sp && !(spans.length && sp[0] <= spans[spans.length - 1][1])) {
      spans.push(sp);
      at.push(r);
    }
  }
  if (!spans.length) return { spans, at, mask: null };
  const mask = new Uint8Array(s.length);
  for (const [a, b] of spans) mask.fill(1, a, b + 1);
  return { spans, at, mask };
}

/**
 * Скачки на отчётах. Для каждого отчёта — момент, когда реакция начинает отражаться в цене (t: конец первой
 * свечи реакции; до него отчёт «впереди» и опционы, рассчитываемые после него, несут его дисперсию),
 * момент, когда скачок известен целиком (done), и его размер: избыточная дисперсия (move² минус обычная
 * дисперсия за это время) в единицах дневной дисперсии актива (ratio). Так оценка переносится между
 * периодами спокойного и бурного рынка: «отчёт двигает цену как N обычных дней».
 */
export interface EventVol {
  /** время выхода отчёта */
  at: Float64Array;
  t: Float64Array;
  done: Float64Array;
  ratio: Float64Array;
  /** лог-доходность реакции */
  move: Float64Array;
  length: number;
}

export function computeEventVol(s: SeriesData, spans: [number, number][], at: number[], rv: RealizedVol, profile: HourProfile | null, clock: 'calendar' | 'business'): EventVol {
  const dt = intervalMs(s.interval);
  const n = spans.length;
  const out: EventVol = { at: Float64Array.from(at), t: new Float64Array(n), done: new Float64Array(n), ratio: new Float64Array(n), move: new Float64Array(n), length: n };
  spans.forEach(([a, b], k) => {
    out.t[k] = s.t[a] + dt;
    out.done[k] = s.t[b] + dt;
    const move = Math.log(s.c[b] / s.c[a - 1]);
    out.move[k] = move;
    const pre = s.t[a - 1] + dt;
    const vol = realizedVolAt(rv, pre)?.rv30;
    if (!Number.isFinite(move) || !vol) {
      out.ratio[k] = NaN;
      return;
    }
    const dayVar = (vol * vol) / (clock === 'business' ? BUSINESS_DAYS : 365);
    const span = clock === 'business' ? businessMs(pre, out.done[k], profile) : out.done[k] - pre;
    out.ratio[k] = (move * move) / dayVar - span / DAY;
  });
  return out;
}

/** Априорный размер скачка на отчёте — в дневных дисперсиях (≈ движение в 2.5 обычных дня) и его вес в отчётах. */
const EVENT_PRIOR = 6;
const EVENT_PRIOR_WEIGHT = 2;
const EVENT_LOOKBACK = 8;

/**
 * Отчёты, которые в момент now ещё впереди (в пределах horizon), с ожидаемым размером скачка. Оценка —
 * среднее по последним уже прошедшим отчётам этого актива (только до now — без заглядывания в будущее),
 * сглаженное к априорному значению, пока отчётов в истории мало.
 */
export function pendingEvents(ev: EventVol | undefined, now: number, horizon = 400 * DAY): { t: number; at: number; ratio: number }[] | undefined {
  if (!ev?.length) return undefined;
  const k0 = lowerBound(ev.t, ev.length, now + 1);
  if (k0 >= ev.length || ev.t[k0] > now + horizon) return undefined;
  let sum = 0;
  let cnt = 0;
  for (let k = k0 - 1; k >= 0 && cnt < EVENT_LOOKBACK; k--) {
    if (ev.done[k] > now || !Number.isFinite(ev.ratio[k])) continue;
    sum += ev.ratio[k];
    cnt++;
  }
  const ratio = Math.min(40, Math.max(0.5, (sum + EVENT_PRIOR * EVENT_PRIOR_WEIGHT) / (cnt + EVENT_PRIOR_WEIGHT)));
  const out: { t: number; at: number; ratio: number }[] = [];
  for (let k = k0; k < ev.length && ev.t[k] <= now + horizon; k++) out.push({ t: ev.t[k], at: ev.at[k], ratio });
  return out;
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
