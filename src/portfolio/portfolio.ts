/**
 * Портфель «Пробоя лидеров»: размер позиции (5.5), исполнение с издержками, предохранители счёта (5.8).
 */
import type { LbConfig } from './config';

/** Округление количества вниз до шага (1 акция, лот MOEX, шаг лота биржи). */
export function floorStep(q: number, step: number): number {
  if (!(q > 0) || !(step > 0)) return 0;
  return Math.floor(q / step + 1e-9) * step;
}

/** Риск на сделку: 0.005 при включённом троттлинге, иначе 0.01. */
export const riskPerTrade = (throttle: boolean, c: LbConfig) => (throttle ? c.account_guards.throttle_risk_per_trade : c.risk.risk_per_trade);

export interface SizeInput {
  /** стоимость счёта на close[t] */
  equity: number;
  risk: number;
  R_ps: number;
  /** цена исполнения с проскальзыванием */
  fill: number;
  cash: number;
  /** Turnover50[t] */
  turnover: number;
  step: number;
}

/**
 * 5.5: количество q (0 — вход пропускается) и причина пропуска.
 * floor — до целых единиц, затем вниз до шага количества (1 акция, лот MOEX). Для крипты с дробным шагом лота
 * floor до целого сделал бы BTC неторгуемым — там округляем сразу до шага лота биржи (раздел 3).
 */
export function positionSize(s: SizeInput, c: LbConfig): { q: number; skip?: 'size' | 'cash' | 'turnover' } {
  if (!(s.R_ps > 0) || !(s.fill > 0)) return { q: 0, skip: 'size' };
  const fl = (x: number) => (s.step >= 1 ? Math.floor(x) : x);
  let q = fl((s.equity * s.risk) / s.R_ps);
  q = Math.min(q, fl((c.risk.max_position_pct * s.equity) / s.fill));
  const byCash = fl(s.cash / (s.fill * (1 + c.costs.commission_pct)));
  const limitedByCash = byCash < q;
  q = floorStep(Math.min(q, byCash), s.step);
  if (!(q > 0)) return { q: 0, skip: limitedByCash ? 'cash' : 'size' };
  if (!(s.turnover >= c.entry.min_turnover_multiple * q * s.fill)) return { q: 0, skip: 'turnover' };
  return { q };
}

/**
 * Докупка (5.6): средняя цена всей позиции и стоп = max(стоп, средняя цена).
 * При исполнении ровно по E + 1.5R средняя = E + 0.5R — худший исход сделки ≈ 0.
 */
export function addToPosition(p: { qty: number; avgCost: number; stop: number }, q: number, fill: number) {
  const avgCost = (p.avgCost * p.qty + fill * q) / (p.qty + q);
  return { qty: p.qty + q, avgCost, stop: Math.max(p.stop, avgCost) };
}

/** Цены исполнения: покупка — price·(1 + slippage), продажа — price·(1 − slippage). */
export const buyFill = (price: number, c: LbConfig) => price * (1 + c.costs.slippage_pct);
export const sellFill = (price: number, c: LbConfig) => price * (1 - c.costs.slippage_pct);
export const commission = (amount: number, c: LbConfig) => amount * c.costs.commission_pct;

/* ───────── 5.8 Предохранители ───────── */

export interface GuardState {
  peak: number;
  throttle: boolean;
  halted: boolean;
}

export interface GuardEvent {
  date: number;
  kind: 'throttle_on' | 'throttle_off' | 'halt' | 'max_dd_logged';
  equity: number;
  dd: number;
}

/**
 * peak[t] = max(peak[t−1], equity[t]); dd = equity/peak − 1.
 * dd ≤ −10% → троттлинг; equity ≥ peak[t−1] → троттлинг выключен; dd ≤ −20% → остановка (или запись при log_only).
 */
export function updateGuards(g: GuardState, equity: number, date: number, c: LbConfig, events?: GuardEvent[]): { dd: number } {
  const prevPeak = g.peak;
  g.peak = Math.max(g.peak, equity);
  const dd = equity / g.peak - 1;
  const ag = c.account_guards;
  if (equity >= prevPeak) {
    if (g.throttle) events?.push({ date, kind: 'throttle_off', equity, dd });
    g.throttle = false;
  } else if (dd <= -ag.throttle_dd && !g.throttle) {
    g.throttle = true;
    events?.push({ date, kind: 'throttle_on', equity, dd });
  }
  if (dd <= -ag.max_dd) {
    if (ag.max_dd_action === 'halt') {
      if (!g.halted) events?.push({ date, kind: 'halt', equity, dd });
      g.halted = true;
    } else events?.push({ date, kind: 'max_dd_logged', equity, dd });
  }
  return { dd };
}
