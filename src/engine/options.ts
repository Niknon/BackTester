import { DAY } from '../data/intervals';
import type { OptionInstrument, OptionModelConfig } from './types';

/* ───────────────────────── Блэк–Шоулз ───────────────────────── */

const YEAR_MS = 365 * DAY;

export function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Φ(x) — аппроксимация Вест (двойная точность ~1e-15). */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-(z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let f = z + 0.65;
      f = z + 4 / f;
      f = z + 3 / f;
      f = z + 2 / f;
      f = z + 1 / f;
      c = e / f / 2.506628274631;
    }
  }
  return x <= 0 ? c : 1 - c;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** на 1 п.п. волатильности */
  vega: number;
  /** за 1 день */
  theta: number;
}

/** Цена и греки европейского опциона (r = 0, F ≈ S для перпетуалов). T — в годах. */
export function blackScholes(S: number, K: number, T: number, sigma: number, type: 'C' | 'P'): Greeks {
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
    const itm = type === 'C' ? S > K : S < K;
    return { price: intrinsic, delta: itm ? (type === 'C' ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0 };
  }
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const pdf = normPdf(d1);
  let price: number;
  let delta: number;
  if (type === 'C') {
    price = S * normCdf(d1) - K * normCdf(d2);
    delta = normCdf(d1);
  } else {
    price = K * normCdf(-d2) - S * normCdf(-d1);
    delta = normCdf(d1) - 1;
  }
  const gamma = pdf / (S * sigma * sqT);
  const vega = (S * pdf * sqT) / 100;
  const theta = -(S * pdf * sigma) / (2 * sqT) / 365;
  return { price: Math.max(0, price), delta, gamma, vega, theta };
}

/** Подразумеваемая волатильность по цене (бисекция + Ньютон). */
export function impliedVol(price: number, S: number, K: number, T: number, type: 'C' | 'P'): number {
  const intrinsic = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (T <= 0 || price <= intrinsic + 1e-12) return 0;
  let lo = 1e-4;
  let hi = 10;
  let sigma = 0.8;
  for (let i = 0; i < 100; i++) {
    const g = blackScholes(S, K, T, sigma, type);
    const diff = g.price - price;
    if (Math.abs(diff) < 1e-10 * Math.max(1, price)) break;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    const vegaRaw = g.vega * 100;
    const next = vegaRaw > 1e-12 ? sigma - diff / vegaRaw : NaN;
    sigma = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  return sigma;
}

/* ───────────────────────── Инструменты ───────────────────────── */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatStrike(k: number): string {
  return Number(k.toPrecision(10)).toString();
}

export function expiryCode(expiry: number): string {
  const d = new Date(expiry);
  return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}

export function optionSymbol(base: string, expiry: number, strike: number, type: 'C' | 'P'): string {
  return `${base}-${expiryCode(expiry)}-${formatStrike(strike)}-${type}-USDT`;
}

export function parseOptionSymbol(symbol: string): OptionInstrument | null {
  const m = /^([A-Z0-9]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])(?:-USDT)?$/.exec(symbol);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3]);
  if (month < 0) return null;
  const expiry = Date.UTC(2000 + Number(m[4]), month, Number(m[2]), 8);
  return {
    symbol,
    base: m[1],
    underlying: `${m[1]}USDT`,
    strike: Number(m[5]),
    type: m[6] as 'C' | 'P',
    expiry,
  };
}

export function isOptionSymbol(symbol: string) {
  return /-[CP](-USDT)?$/.test(symbol);
}

/* ───────────────────────── Экспирации (как у Bybit) ───────────────────────── */

const EXPIRY_HOUR = 8;

function at8(y: number, m: number, d: number) {
  return Date.UTC(y, m, d, EXPIRY_HOUR);
}

function lastFridayOfMonth(y: number, m: number) {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const back = (last.getUTCDay() - 5 + 7) % 7;
  return at8(y, m, last.getUTCDate() - back);
}

/**
 * Серии экспираций на момент now: 3 ближайшие дневные, 3 недельные (пятницы),
 * 3 месячные (последняя пятница) и для BTC/ETH — 2 квартальные. Все в 08:00 UTC.
 */
export function listExpiries(now: number, base: string): number[] {
  const set = new Set<number>();
  const d0 = new Date(now);
  let day = at8(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  if (day <= now) day += DAY;
  for (let i = 0; i < 3; i++) set.add(day + i * DAY);
  // пятницы
  let fri = day;
  while (new Date(fri).getUTCDay() !== 5) fri += DAY;
  for (let i = 0; i < 3; i++) set.add(fri + i * 7 * DAY);
  // месячные
  let y = d0.getUTCFullYear();
  let m = d0.getUTCMonth();
  let monthly = 0;
  for (let i = 0; i < 6 && monthly < 3; i++) {
    const e = lastFridayOfMonth(y, m);
    if (e > now) {
      set.add(e);
      monthly++;
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  if (base === 'BTC' || base === 'ETH') {
    let quarterly = 0;
    y = d0.getUTCFullYear();
    m = d0.getUTCMonth();
    for (let i = 0; i < 15 && quarterly < 2; i++) {
      if (m % 3 === 2) {
        const e = lastFridayOfMonth(y, m);
        if (e > now + 35 * DAY) {
          set.add(e);
          quarterly++;
        }
      }
      m++;
      if (m > 11) {
        m = 0;
        y++;
      }
    }
  }
  return [...set].filter((e) => e > now + 5 * 60_000).sort((a, b) => a - b);
}

/* ───────────────────────── Страйки ───────────────────────── */

/** Ближайшее «красивое» число из ряда {1, 2, 2.5, 5}×10^k (в лог-шкале). */
export function niceNumber(x: number): number {
  if (!(x > 0)) return 1;
  const k = Math.floor(Math.log10(x));
  const base = 10 ** k;
  const cands = [1, 2, 2.5, 5, 10].map((c) => c * base);
  let best = cands[0];
  for (const c of cands) if (Math.abs(Math.log(c / x)) < Math.abs(Math.log(best / x))) best = c;
  return Number(best.toPrecision(6));
}

export function strikeStep(S: number, T: number): number {
  const days = T * 365;
  const frac = days <= 2.5 ? 0.005 : days <= 10 ? 0.01 : days <= 40 ? 0.025 : 0.05;
  return niceNumber(S * frac);
}

export function listStrikes(S: number, T: number, atmIv: number, maxPerSide = 20): number[] {
  const step = strikeStep(S, T);
  const range = S * Math.max(0.06, Math.min(0.9, 3 * atmIv * Math.sqrt(Math.max(T, 1 / 365))));
  const n = Math.min(maxPerSide, Math.max(4, Math.ceil(range / step)));
  const center = Math.round(S / step) * step;
  const out: number[] = [];
  for (let i = -n; i <= n; i++) {
    const k = Number((center + i * step).toPrecision(10));
    if (k > 0) out.push(k);
  }
  return out;
}

export function optionTickSize(S: number): number {
  return niceNumber(S * 5e-5);
}

export function optionQtyStep(S: number): number {
  const v = 10 ** Math.floor(Math.log10(300 / S));
  return S < 10 ? v / 10 : v;
}

/* ───────────────────────── Поверхность волатильности ───────────────────────── */

export interface VolInputs {
  rv7?: number | null;
  rv30?: number | null;
  dvol?: number | null;
}

/** ATM IV для срока T (лет) — с временной структурой. */
export function atmIv(cfg: OptionModelConfig, inp: VolInputs, T: number): number {
  const days = T * 365;
  if (cfg.ivSource === 'fixed') return cfg.fixedIv;
  let short = inp.rv7 ?? inp.rv30 ?? cfg.fixedIv;
  let long = inp.rv30 ?? inp.rv7 ?? cfg.fixedIv;
  if (cfg.ivSource === 'dvol' && inp.dvol) {
    const ratio = inp.rv7 && inp.rv30 ? Math.sqrt(inp.rv7 / inp.rv30) : 1;
    long = inp.dvol / cfg.ivPremium; // DVOL уже подразумеваемая — премию не добавляем
    short = long * Math.min(1.6, Math.max(0.6, ratio));
  }
  let base: number;
  if (days <= 7) base = short;
  else if (days >= 30) base = long;
  else base = short + ((days - 7) / 23) * (long - short);
  // очень короткие сроки — лёгкая надбавка (эффект гэпов/событий)
  const shortBump = days < 2 ? 1.05 : 1;
  return Math.max(0.05, Math.min(5, base * cfg.ivPremium * shortBump));
}

/** IV для страйка K: улыбка по стандартизованной денежности x = ln(K/F)/(σ√T). */
export function smileIv(cfg: OptionModelConfig, atm: number, F: number, K: number, T: number): number {
  const sd = atm * Math.sqrt(Math.max(T, 1 / (365 * 24)));
  const x = Math.max(-4, Math.min(4, Math.log(K / F) / sd));
  const mult = 1 + cfg.skew * x + cfg.smile * x * x;
  return Math.max(atm * 0.5, Math.min(atm * 3, atm * mult));
}

export function yearsTo(expiry: number, now: number) {
  return Math.max(0, (expiry - now) / YEAR_MS);
}

export interface OptionQuote {
  inst: OptionInstrument;
  underlyingPrice: number;
  T: number;
  iv: number;
  mark: number;
  bid: number;
  ask: number;
  greeks: Greeks;
}

export function roundTick(x: number, tick: number, mode: 'round' | 'floor' | 'ceil' = 'round') {
  const k = x / tick;
  const r = mode === 'floor' ? Math.floor(k + 1e-9) : mode === 'ceil' ? Math.ceil(k - 1e-9) : Math.round(k);
  return Number((r * tick).toPrecision(12));
}

export function quoteOption(cfg: OptionModelConfig, inst: OptionInstrument, S: number, now: number, vol: VolInputs): OptionQuote {
  const T = yearsTo(inst.expiry, now);
  const atm = atmIv(cfg, vol, T);
  const iv = smileIv(cfg, atm, S, inst.strike, T);
  const greeks = blackScholes(S, inst.strike, T, iv, inst.type);
  const tick = optionTickSize(S);
  const mark = greeks.price;
  const half = Math.max(tick, mark * cfg.spreadPct * 0.5);
  const bid = mark - half >= tick ? roundTick(mark - half, tick, 'floor') : 0;
  const ask = Math.max(tick, roundTick(mark + half, tick, 'ceil'));
  return { inst, underlyingPrice: S, T, iv, mark, bid, ask, greeks };
}

/** Комиссия опционов Bybit: ставка × цена базового актива, не более cap × премии. */
export function optionFee(rate: number, cap: number, S: number, premium: number, qty: number) {
  return Math.min(rate * S * qty, cap * premium * qty);
}

/** Маржа шорта опциона на 1 контракт (приближение правил Bybit). */
export function shortOptionMargin(cfg: OptionModelConfig, inst: OptionInstrument, S: number, mark: number) {
  const otm = inst.type === 'C' ? Math.max(0, inst.strike - S) : Math.max(0, S - inst.strike);
  const im = mark + Math.max(cfg.imRate * S - otm, cfg.imMinRate * S);
  const mm = mark + cfg.mmRate * S;
  return { im, mm };
}

export function intrinsicValue(inst: OptionInstrument, S: number) {
  return inst.type === 'C' ? Math.max(0, S - inst.strike) : Math.max(0, inst.strike - S);
}

