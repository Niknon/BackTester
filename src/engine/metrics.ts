import { DAY } from '../data/intervals';
import type { ClosedPnlRecord } from './types';

export interface EquitySample {
  t: number;
  v: number;
}

export interface PerformanceReport {
  startEquity: number;
  endEquity: number;
  pnl: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  maxDrawdownAbs: number;
  maxDrawdownDays: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  largestWin: number;
  largestLoss: number;
  avgHoldHours: number;
  maxConsecLosses: number;
  fees: number;
  funding: number;
  days: number;
  benchReturn: number | null;
}

/** Дневные доходности (последнее значение капитала за сутки UTC). */
export function dailyReturns(points: EquitySample[]): number[] {
  const daily: number[] = [];
  let lastDay = -1;
  for (const p of points) {
    const d = Math.floor(p.t / DAY);
    if (d !== lastDay) {
      daily.push(p.v);
      lastDay = d;
    } else daily[daily.length - 1] = p.v;
  }
  const r: number[] = [];
  for (let i = 1; i < daily.length; i++) if (daily[i - 1] > 0) r.push(daily[i] / daily[i - 1] - 1);
  return r;
}

export function drawdownSeries(points: EquitySample[]): EquitySample[] {
  let peak = -Infinity;
  return points.map((p) => {
    peak = Math.max(peak, p.v);
    return { t: p.t, v: peak > 0 ? p.v / peak - 1 : 0 };
  });
}

export function computeReport(
  points: EquitySample[],
  closed: ClosedPnlRecord[],
  extra: { fees?: number; funding?: number; bench?: EquitySample[] } = {},
): PerformanceReport {
  const start = points[0]?.v ?? 0;
  const end = points[points.length - 1]?.v ?? start;
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0;
  const days = Math.max(1 / 24, (t1 - t0) / DAY);
  const totalReturn = start > 0 ? end / start - 1 : 0;
  const cagr = start > 0 && end > 0 ? (end / start) ** (365 / days) - 1 : -1;
  // просадка
  let peak = -Infinity;
  let peakT = t0;
  let maxDd = 0;
  let maxDdAbs = 0;
  let maxDdDur = 0;
  for (const p of points) {
    if (p.v >= peak) {
      peak = p.v;
      peakT = p.t;
    }
    if (peak > 0) {
      const dd = (peak - p.v) / peak;
      if (dd > maxDd) maxDd = dd;
      maxDdAbs = Math.max(maxDdAbs, peak - p.v);
      if (p.v < peak) maxDdDur = Math.max(maxDdDur, p.t - peakT);
    }
  }
  const r = dailyReturns(points);
  const mean = r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0;
  const sd = r.length > 1 ? Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) : 0;
  const downs = r.filter((x) => x < 0);
  const dsd = downs.length > 1 ? Math.sqrt(downs.reduce((a, b) => a + b * b, 0) / downs.length) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(365) : 0;
  // сделки
  const pnls = closed.map((c) => c.closedPnl);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = -losses.reduce((a, b) => a + b, 0);
  let consec = 0;
  let maxConsec = 0;
  for (const x of pnls) {
    if (x <= 0) maxConsec = Math.max(maxConsec, ++consec);
    else consec = 0;
  }
  const holds = closed.filter((c) => c.category !== 'spot' && c.closeTime > c.openTime).map((c) => c.closeTime - c.openTime);
  let benchReturn: number | null = null;
  if (extra.bench && extra.bench.length > 1) {
    const b0 = extra.bench[0].v;
    const b1 = extra.bench[extra.bench.length - 1].v;
    if (b0 > 0) benchReturn = b1 / b0 - 1;
  }
  return {
    startEquity: start,
    endEquity: end,
    pnl: end - start,
    totalReturn,
    cagr,
    maxDrawdown: maxDd,
    maxDrawdownAbs: maxDdAbs,
    maxDrawdownDays: maxDdDur / DAY,
    volatility: sd * Math.sqrt(365),
    sharpe,
    sortino,
    calmar: maxDd > 0 ? cagr / maxDd : 0,
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgWin: wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? -gl / losses.length : 0,
    expectancy: closed.length ? (gp - gl) / closed.length : 0,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
    avgHoldHours: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length / 3_600_000 : 0,
    maxConsecLosses: maxConsec,
    fees: extra.fees ?? closed.reduce((a, c) => a + c.openFee + c.closeFee, 0),
    funding: extra.funding ?? closed.reduce((a, c) => a + c.funding, 0),
    days,
    benchReturn,
  };
}
