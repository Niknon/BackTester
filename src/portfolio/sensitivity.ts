/**
 * Чувствительность (раздел 10, п. 8): сетка breakout_lookback × atr_stop_mult × trail_lookback.
 * Это проверка устойчивости, а не подбор: значения в config.yaml на «лучшие» не меняются.
 */
import { prepare, runBacktest, type Dataset } from './backtest';
import type { LbConfig } from './config';
import { computeMetrics } from './report';

export interface SensRow {
  breakout_lookback: number;
  atr_stop_mult: number;
  trail_lookback: number;
  cagr: number;
  maxDD: number;
  expectancyR: number;
  trades: number;
  isBase: boolean;
}

export const SENS_GRID = { breakout_lookback: [15, 20, 30], atr_stop_mult: [1.5, 2.0, 2.5], trail_lookback: [10, 20] };

export async function runSensitivity(ds: Dataset, base: LbConfig, onRow?: (row: SensRow, done: number, total: number) => void, signal?: { aborted: boolean }): Promise<SensRow[]> {
  const rows: SensRow[] = [];
  const total = SENS_GRID.breakout_lookback.length * SENS_GRID.atr_stop_mult.length * SENS_GRID.trail_lookback.length;
  for (const bl of SENS_GRID.breakout_lookback)
    for (const tl of SENS_GRID.trail_lookback) {
      // индикаторы зависят от окон пробоя и трейлинга; множитель стопа — только от ATR, пересчёт не нужен
      const c0: LbConfig = structuredClone(base);
      c0.entry.breakout_lookback = bl;
      c0.exits.trail_lookback = tl;
      const prepared = prepare(ds, c0);
      for (const m of SENS_GRID.atr_stop_mult) {
        if (signal?.aborted) return rows;
        const c = structuredClone(c0);
        c.risk.atr_stop_mult = m;
        const r = await runBacktest(prepared, c);
        const met = computeMetrics(r);
        const row: SensRow = {
          breakout_lookback: bl,
          atr_stop_mult: m,
          trail_lookback: tl,
          cagr: met.cagr,
          maxDD: met.maxDD,
          expectancyR: met.expectancyR,
          trades: met.trades,
          isBase: bl === base.entry.breakout_lookback && m === base.risk.atr_stop_mult && tl === base.exits.trail_lookback,
        };
        rows.push(row);
        onRow?.(row, rows.length, total);
      }
    }
  return rows;
}
