/**
 * Индикаторы «Пробоя лидеров» (раздел 4 спецификации). Все массивы — по барам самого актива;
 * NaN — значение ещё не определено. Окна вида [t-n .. t-1] не включают текущий бар.
 */

type Arr = ArrayLike<number>;

/** SMA_n[t] = mean(x[t-n+1 .. t]). */
export function sma(x: Arr, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** TR[t] = max(high − low, |high − close[t−1]|, |low − close[t−1]|); на первом баре — high − low. */
export function trueRange(h: Arr, l: Arr, c: Arr): Float64Array {
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  return out;
}

/** Сглаживание Уайлдера (RMA), как ta.rma в TradingView: старт — SMA первых n значений, далее (prev·(n−1) + x) / n. */
export function rma(x: Arr, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < n) {
      s += x[i];
      if (i === n - 1) out[i] = s / n;
    } else out[i] = (out[i - 1] * (n - 1) + x[i]) / n;
  }
  return out;
}

/** ATR_n — RMA от TR (как ta.atr в TradingView). */
export function atr(h: Arr, l: Arr, c: Arr, n: number): Float64Array {
  return rma(trueRange(h, l, c), n);
}

/** Скользящий максимум/минимум окна длины n, заканчивающегося на баре i − shift (shift = 1 — без текущего бара). */
function rollingExtreme(x: Arr, n: number, shift: 0 | 1, isMax: boolean): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const dq: number[] = []; // индексы, значения монотонны
  let head = 0;
  for (let j = 0; j < x.length; j++) {
    while (dq.length > head && (isMax ? x[dq[dq.length - 1]] <= x[j] : x[dq[dq.length - 1]] >= x[j])) dq.pop();
    dq.push(j);
    while (dq[head] <= j - n) head++;
    const i = j + shift; // окно [j-n+1 .. j] — значение для бара i
    if (j >= n - 1 && i < x.length) out[i] = x[dq[head]];
  }
  return out;
}

/** max(x[t-n .. t-1]) — например, HH20 по high. */
export const highestPrev = (x: Arr, n: number) => rollingExtreme(x, n, 1, true);
/** min(x[t-n .. t-1]) — например, LL10 по low. */
export const lowestPrev = (x: Arr, n: number) => rollingExtreme(x, n, 1, false);
/** max(x[t-n+1 .. t]) — например, High252 (включая текущий бар). */
export const highestIncl = (x: Arr, n: number) => rollingExtreme(x, n, 0, true);

/** mean(x[t-n .. t-1]) — например, VolAvg50. */
export function meanPrev(x: Arr, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i >= n) out[i] = s / n;
    s += x[i];
    if (i >= n) s -= x[i - n];
  }
  return out;
}

/** Ret_n[t] = close[t] / close[t−n] − 1. */
export function ret(c: Arr, n: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) out[i] = c[i] / c[i - n] - 1;
  return out;
}

/**
 * Процентильный ранг значений среди активов вселенной (0..1).
 * Реализация как pandas `rank(pct=True)` (ничьи — средний ранг): ранг / число активов с данными.
 * NaN во входе — актив без данных, в ранжировании не участвует (результат NaN).
 */
export function pctRank(values: ArrayLike<number>): Float64Array {
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) idx.push(i);
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Float64Array(values.length).fill(NaN);
  const n = idx.length;
  for (let k = 0; k < n; ) {
    let e = k;
    while (e + 1 < n && values[idx[e + 1]] === values[idx[k]]) e++;
    const avgRank = (k + 1 + e + 1) / 2;
    for (let j = k; j <= e; j++) out[idx[j]] = avgRank / n;
    k = e + 1;
  }
  return out;
}
