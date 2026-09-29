import { intervalMs } from '../data/intervals';
import type { FundingPoint, IntervalKey, ProviderId, SeriesData } from '../data/types';
import { lowerBound } from '../data/types';
import { computeRealizedVol, type DvolSeries, type RealizedVol } from '../data/volatility';

/**
 * Рыночные данные сессии: свечи базового интервала по символам, funding,
 * реализованная волатильность, DVOL. Хранятся отдельно от состояния биржи
 * (большие массивы не сериализуются вместе с сессией).
 */
export class MarketData {
  readonly dt: number;
  readonly series = new Map<string, SeriesData>();
  readonly funding = new Map<string, FundingPoint[]>();
  readonly rv = new Map<string, RealizedVol>();
  readonly dvol = new Map<string, DvolSeries>();
  readonly providers = new Map<string, ProviderId>();
  private ptr = new Map<string, number>();

  constructor(
    readonly interval: IntervalKey,
    readonly start: number,
    readonly end: number,
  ) {
    this.dt = intervalMs(interval);
  }

  get totalBars(): number {
    return Math.max(0, Math.floor((this.end - this.start) / this.dt));
  }

  timeAt(k: number): number {
    return this.start + k * this.dt;
  }

  symbols(): string[] {
    return [...this.series.keys()];
  }

  has(symbol: string): boolean {
    return this.series.has(symbol);
  }

  addSeries(symbol: string, s: SeriesData, provider: ProviderId) {
    this.series.set(symbol, s);
    this.providers.set(symbol, provider);
    this.rv.set(symbol, computeRealizedVol(s));
    this.ptr.delete(symbol);
  }

  setFunding(symbol: string, pts: FundingPoint[]) {
    this.funding.set(symbol, pts);
  }

  /** Индекс свечи с временем открытия ровно `time` или -1. Оптимизировано для движения вперёд. */
  indexAt(symbol: string, time: number): number {
    const s = this.series.get(symbol);
    if (!s) return -1;
    let p = this.ptr.get(symbol);
    if (p === undefined || p > s.length || (p > 0 && s.t[p - 1] >= time)) {
      p = lowerBound(s.t, s.length, time);
    } else {
      while (p < s.length && s.t[p] < time) p++;
    }
    this.ptr.set(symbol, p);
    return p < s.length && s.t[p] === time ? p : -1;
  }

  /** Индекс последней ЗАКРЫТОЙ к моменту `now` свечи. */
  lastClosedIndex(symbol: string, now: number): number {
    const s = this.series.get(symbol);
    if (!s) return -1;
    return lowerBound(s.t, s.length, now - this.dt + 1) - 1;
  }

  /** Цена закрытия последней закрытой свечи к моменту now. */
  closeAt(symbol: string, now: number): number | undefined {
    const s = this.series.get(symbol);
    if (!s) return undefined;
    const i = this.lastClosedIndex(symbol, now);
    return i >= 0 ? s.c[i] : undefined;
  }

  /** Цена n мс назад относительно now (для 24ч изменения). */
  closeAgo(symbol: string, now: number, ago: number): number | undefined {
    return this.closeAt(symbol, now - ago);
  }

  /** Ставки финансирования, попадающие в [from, to). */
  fundingIn(symbol: string, from: number, to: number): FundingPoint[] {
    const f = this.funding.get(symbol);
    if (!f || !f.length) return [];
    let lo = 0;
    let hi = f.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (f[m].t < from) lo = m + 1;
      else hi = m;
    }
    const out: FundingPoint[] = [];
    for (let i = lo; i < f.length && f[i].t < to; i++) out.push(f[i]);
    return out;
  }

  /** Ближайшая следующая выплата funding после now (для таймера в тикере). */
  nextFunding(symbol: string, now: number): FundingPoint | undefined {
    const f = this.funding.get(symbol);
    if (!f) return undefined;
    let lo = 0;
    let hi = f.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (f[m].t <= now) lo = m + 1;
      else hi = m;
    }
    return f[lo];
  }

  /** Последняя известная ставка funding (уже опубликованная к now). */
  lastFunding(symbol: string, now: number): FundingPoint | undefined {
    const f = this.funding.get(symbol);
    if (!f || !f.length) return undefined;
    let lo = 0;
    let hi = f.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (f[m].t <= now) lo = m + 1;
      else hi = m;
    }
    return lo > 0 ? f[lo - 1] : undefined;
  }
}
