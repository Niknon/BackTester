import { describe, expect, it } from 'vitest';
import { mkConfig, mkMarket, wave } from './helpers';
import { STRATEGY_TEMPLATES, compileStrategy, expandGrid, runStrategy } from '../src/engine/strategy';
import * as ind from '../src/indicators';
import { computeReport } from '../src/engine/metrics';

describe('Индикаторы', () => {
  it('SMA/EMA/RSI', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(ind.sma(x, 3)[2]).toBe(2);
    expect(ind.sma(x, 3)[9]).toBe(9);
    const e = ind.ema(x, 3);
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
    const r = ind.rsi(x, 5);
    expect(r[9]).toBe(100);
    const bb = ind.bollinger([2, 2, 2, 2], 4, 2);
    expect(bb.upper[3]).toBe(2);
  });

  it('нет заглядывания в будущее: значение i не зависит от i+1..', () => {
    const a = [5, 3, 8, 1, 9, 2, 7, 4, 6, 10, 3, 2];
    const b = [...a.slice(0, 8), 100, 200, 300, 400];
    const f = (arr: number[]) => ind.ema(arr, 3).slice(0, 8);
    expect(f(a)).toEqual(f(b));
    expect(ind.rsi(a, 3).slice(0, 8)).toEqual(ind.rsi(b, 3).slice(0, 8));
  });
});

describe('Лаборатория стратегий', () => {
  it('компилирует PARAMS / init / onBar', () => {
    const c = compileStrategy('const PARAMS = { a: 1 }; function onBar(ctx, p) {}');
    expect(c.PARAMS.a).toBe(1);
    expect(c.onBar).toBeTypeOf('function');
    expect(() => compileStrategy('function foo() {}')).toThrow(/onBar/);
  });

  it('все шаблоны выполняются без ошибок', async () => {
    const m = mkMarket({ BTCUSDT: wave(100, 10, 400, 40) }, wave(100, 10, 60, 40));
    const cfg = mkConfig({ end: m.end });
    for (const t of STRATEGY_TEMPLATES) {
      const res = await runStrategy(m, cfg, { code: t.code, symbol: 'BTCUSDT', timeframe: '1h' });
      expect(res.error, t.name).toBeUndefined();
      expect(res.ok).toBe(true);
    }
  });

  it('EMA-кроссовер совершает сделки и строит отчёт', async () => {
    const m = mkMarket({ BTCUSDT: wave(100, 10, 400, 40) }, wave(100, 10, 60, 40));
    const cfg = mkConfig({ end: m.end });
    const res = await runStrategy(m, cfg, {
      code: STRATEGY_TEMPLATES[0].code,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      params: { fast: 3, slow: 8 },
    });
    expect(res.ok).toBe(true);
    expect(res.report.trades).toBeGreaterThan(5);
    expect(res.plots['EMA fast'].points.length).toBeGreaterThan(100);
    expect(res.params.fast).toBe(3);
  });

  it('сетка оптимизации', () => {
    const g = expandGrid({ a: { from: 1, to: 3, step: 1 }, b: { from: 10, to: 20, step: 10 } });
    expect(g.length).toBe(6);
  });
});

describe('Метрики', () => {
  it('просадка, доходность, win rate', () => {
    const day = 86_400_000;
    const pts = [100, 120, 90, 110, 130].map((v, i) => ({ t: i * day, v }));
    const r = computeReport(pts, [
      { closedPnl: 10 } as any,
      { closedPnl: -5 } as any,
      { closedPnl: 20 } as any,
    ]);
    expect(r.totalReturn).toBeCloseTo(0.3, 10);
    expect(r.maxDrawdown).toBeCloseTo(0.25, 10);
    expect(r.winRate).toBeCloseTo(2 / 3, 10);
    expect(r.profitFactor).toBeCloseTo(6, 10);
  });
});
