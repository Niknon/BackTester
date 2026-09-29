/**
 * Технические индикаторы. Все функции принимают массивы и возвращают массивы
 * той же длины (NaN — недостаточно данных). Значение i зависит только от 0..i.
 */

type Arr = ArrayLike<number>;

export function sma(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    if (i < period) {
      sum += src[i];
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Сглаживание Уайлдера (RMA). */
export function rma(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  let prev = NaN;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    if (count < period) {
      sum += v;
      count++;
      if (count === period) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

export function wma(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += src[i - j] * (period - j);
    out[i] = s / denom;
  }
  return out;
}

export function rsi(src: Arr, period = 14): number[] {
  const gains = new Array(src.length).fill(NaN);
  const losses = new Array(src.length).fill(NaN);
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    gains[i] = Math.max(0, d);
    losses[i] = Math.max(0, -d);
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return ag.map((g, i) => {
    const l = al[i];
    if (!Number.isFinite(g) || !Number.isFinite(l)) return NaN;
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

export function macd(src: Arr, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((x, i) => x - s[i]);
  const firstValid = line.findIndex((x) => Number.isFinite(x));
  const sig = new Array(src.length).fill(NaN);
  if (firstValid >= 0) {
    const e = ema(line.slice(firstValid), signal);
    for (let i = 0; i < e.length; i++) sig[firstValid + i] = e[i];
  }
  const hist = line.map((x, i) => x - sig[i]);
  return { macd: line, signal: sig, hist };
}

export function stdev(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  for (let i = period - 1; i < src.length; i++) {
    let m = 0;
    for (let j = 0; j < period; j++) m += src[i - j];
    m /= period;
    let v = 0;
    for (let j = 0; j < period; j++) v += (src[i - j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export function bollinger(src: Arr, period = 20, mult = 2) {
  const mid = sma(src, period);
  const sd = stdev(src, period);
  return {
    middle: mid,
    upper: mid.map((m, i) => m + mult * sd[i]),
    lower: mid.map((m, i) => m - mult * sd[i]),
  };
}

export function trueRange(h: Arr, l: Arr, c: Arr): number[] {
  const out = new Array(h.length).fill(NaN);
  for (let i = 0; i < h.length; i++) {
    if (i === 0) out[i] = h[i] - l[i];
    else out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return out;
}

export function atr(h: Arr, l: Arr, c: Arr, period = 14): number[] {
  return rma(trueRange(h, l, c), period);
}

export function highest(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  for (let i = period - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let j = 0; j < period; j++) m = Math.max(m, src[i - j]);
    out[i] = m;
  }
  return out;
}

export function lowest(src: Arr, period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  for (let i = period - 1; i < src.length; i++) {
    let m = Infinity;
    for (let j = 0; j < period; j++) m = Math.min(m, src[i - j]);
    out[i] = m;
  }
  return out;
}

export function stoch(h: Arr, l: Arr, c: Arr, kPeriod = 14, dPeriod = 3, smooth = 3) {
  const hh = highest(h, kPeriod);
  const ll = lowest(l, kPeriod);
  const raw = Array.from(c, (x, i) => (hh[i] - ll[i] > 0 ? ((x - ll[i]) / (hh[i] - ll[i])) * 100 : NaN));
  const k = smaNaN(raw, smooth);
  const d = smaNaN(k, dPeriod);
  return { k, d };
}

function smaNaN(src: number[], period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  for (let i = period - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = src[i - j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      s += v;
    }
    if (ok) out[i] = s / period;
  }
  return out;
}

export function cci(h: Arr, l: Arr, c: Arr, period = 20): number[] {
  const tp = Array.from(c, (x, i) => (h[i] + l[i] + x) / 3);
  const m = sma(tp, period);
  const out = new Array(c.length).fill(NaN);
  for (let i = period - 1; i < c.length; i++) {
    let md = 0;
    for (let j = 0; j < period; j++) md += Math.abs(tp[i - j] - m[i]);
    md /= period;
    out[i] = md > 0 ? (tp[i] - m[i]) / (0.015 * md) : 0;
  }
  return out;
}

export function obv(c: Arr, v: Arr): number[] {
  const out = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) out[i] = out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
  return out;
}

/** VWAP с дневным сбросом (UTC). */
export function vwap(t: Arr, h: Arr, l: Arr, c: Arr, v: Arr): number[] {
  const out = new Array(c.length).fill(NaN);
  let day = -1;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(t[i] / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vv = 0;
    }
    const tp = (h[i] + l[i] + c[i]) / 3;
    pv += tp * v[i];
    vv += v[i];
    out[i] = vv > 0 ? pv / vv : tp;
  }
  return out;
}

export function supertrend(h: Arr, l: Arr, c: Arr, period = 10, mult = 3) {
  const a = atr(h, l, c, period);
  const value = new Array(c.length).fill(NaN);
  const dir = new Array(c.length).fill(0);
  let upper = NaN;
  let lower = NaN;
  let d = 1;
  for (let i = 0; i < c.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (h[i] + l[i]) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    upper = Number.isFinite(upper) && (bu < upper || c[i - 1] > upper) ? bu : Number.isFinite(upper) ? upper : bu;
    lower = Number.isFinite(lower) && (bl > lower || c[i - 1] < lower) ? bl : Number.isFinite(lower) ? lower : bl;
    if (d === 1 && c[i] < lower) d = -1;
    else if (d === -1 && c[i] > upper) d = 1;
    value[i] = d === 1 ? lower : upper;
    dir[i] = d;
  }
  return { value, dir };
}

export function adx(h: Arr, l: Arr, c: Arr, period = 14) {
  const plusDM = new Array(h.length).fill(0);
  const minusDM = new Array(h.length).fill(0);
  for (let i = 1; i < h.length; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(h, l, c), period);
  const p = rma(plusDM, period);
  const m = rma(minusDM, period);
  const plusDI = p.map((x, i) => (tr[i] > 0 ? (100 * x) / tr[i] : NaN));
  const minusDI = m.map((x, i) => (tr[i] > 0 ? (100 * x) / tr[i] : NaN));
  const dx = plusDI.map((x, i) => {
    const s = x + minusDI[i];
    return s > 0 ? (100 * Math.abs(x - minusDI[i])) / s : NaN;
  });
  return { adx: rma(dx, period), plusDI, minusDI };
}

export function donchian(h: Arr, l: Arr, period = 20) {
  const upper = highest(h, period);
  const lower = lowest(l, period);
  return { upper, lower, middle: upper.map((u, i) => (u + lower[i]) / 2) };
}

export function ichimoku(h: Arr, l: Arr, conv = 9, base = 26, spanB = 52) {
  const mid = (p: number) => {
    const hh = highest(h, p);
    const ll = lowest(l, p);
    return hh.map((x, i) => (x + ll[i]) / 2);
  };
  const tenkan = mid(conv);
  const kijun = mid(base);
  const spanA = tenkan.map((x, i) => (x + kijun[i]) / 2);
  return { tenkan, kijun, spanA, spanB: mid(spanB) };
}
