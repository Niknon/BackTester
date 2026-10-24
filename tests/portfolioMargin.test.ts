import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/data/providers/synthetic';
import { MAIN } from '../src/engine/exchange';
import { makeSettings, runOptionStrategy } from '../src/engine/optionRunner';
import { blackScholes, optionSymbol, portfolioOptionMargin, PORTFOLIO_MARGIN } from '../src/engine/options';
import { DEFAULT_OPTION_MODEL } from '../src/engine/types';
import { mkConfig, mkExchange, mkMarket } from './helpers';

type Bar = [number, number, number, number];
/** Спокойная история для оценки волатильности (~35% годовых). */
const warm: Bar[] = Array.from({ length: 24 * 40 }, (_, i) => {
  const p = 100000 * (1 + 0.02 * Math.sin(i / 5));
  return [p, p * 1.003, p * 0.997, p];
});
const flat = (p: number, n: number): Bar[] => Array.from({ length: n }, () => [p, p, p, p]);
/** Плавный рост от a до b за n часовых свечей. */
const ramp = (a: number, b: number, n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const o = a + ((b - a) * i) / n;
    const c = a + ((b - a) * (i + 1)) / n;
    return [o, Math.max(o, c), Math.min(o, c), c];
  });

describe('Портфельная маржа опционов', () => {
  it('кондор: маржа ≈ риску конструкции, а не сумме проданных ног', () => {
    const T = 7 / 365;
    const leg = (type: 'C' | 'P', strike: number, size: number) => ({ type, strike, size, mark: 0, iv: 0.5, T });
    const legs = [leg('P', 90000, 1), leg('P', 95000, -1), leg('C', 105000, -1), leg('C', 110000, 1)];
    // mark — по той же модели (BS), чтобы сценарий «без движения» давал ноль
    for (const l of legs) l.mark = blackScholes(100000, l.strike, l.T, l.iv, l.type).price;
    const credit = -legs.reduce((x, l) => x + l.size * l.mark, 0);
    const pm = portfolioOptionMargin(legs, 100000);
    // худший случай — убыток до ширины крыла (5000) минус кредит; непокрытых проданных нет
    expect(pm.mm).toBeLessThanOrEqual(5000 - credit + 1);
    expect(pm.mm).toBeGreaterThan(5000 - credit - 1500);
    // стандартная поддерживающая: 2 × (mark + 7.5% × S) ≈ 15 000+
    const regular = legs.filter((l) => l.size < 0).reduce((x, l) => x + l.mark + DEFAULT_OPTION_MODEL.mmRate * 100000, 0);
    expect(regular).toBeGreaterThan(3 * pm.mm);
    expect(pm.im).toBeCloseTo(pm.mm * PORTFOLIO_MARGIN.imMult, 9);
  });

  it('портфельная маржа никогда не выше стандартной (случайные книги)', () => {
    const ex = mkExchange({ BTCUSDT: flat(100000, 5) }, { initialBalance: 1e9 }, warm);
    const exps = ex.optionExpiries('BTC');
    const rnd = mulberry32(7);
    for (let n = 0; n < 40; n++) {
      for (const p of Object.values(ex.main.positions)) ex.closePosition(MAIN, p.symbol);
      const legs = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < legs; k++) {
        const exp = exps[Math.floor(rnd() * Math.min(6, exps.length))];
        const strike = Math.round((80000 + rnd() * 40000) / 1000) * 1000;
        const sym = optionSymbol('BTC', exp, strike, rnd() < 0.5 ? 'C' : 'P');
        ex.placeOrder({ category: 'option', symbol: sym, side: rnd() < 0.55 ? 'Sell' : 'Buy', orderType: 'Market', qty: Math.round(rnd() * 20) / 10 + 0.1 });
      }
      const g = ex.optionGroupMargin(ex.main, 'BTCUSDT');
      expect(g.mm).toBeLessThanOrEqual(g.regMm + 1e-6);
      expect(g.im).toBeLessThanOrEqual(g.regIm + 1e-6);
      expect(g.mm).toBeGreaterThanOrEqual(0);
      // маржа по позициям в таблице складывается в маржу книги
      const rows = Object.values(ex.main.positions).reduce((x, p) => x + ex.positionMM(p), 0);
      expect(rows).toBeCloseTo(g.mm, 6);
    }
  });

  /** Кондор 90/95/105/110 на BTC 100 000, 1 контракт; дальше цена уходит выше дальнего колла. */
  function condorThrough(marginAfterEntry: 'portfolio' | 'regular') {
    const ex = mkExchange({ BTCUSDT: [...flat(100000, 2), ...ramp(100000, 113000, 24), ...flat(113000, 30)] }, { initialBalance: 8000 }, warm);
    const exp = ex.optionExpiries('BTC').find((e) => e - ex.now > 5 * 86400000)!;
    const sym = (k: number, t: 'C' | 'P') => optionSymbol('BTC', exp, k, t);
    // как раннер: сначала покупки (крылья), потом продажи
    for (const [k, t, side] of [[90000, 'P', 'Buy'], [110000, 'C', 'Buy'], [95000, 'P', 'Sell'], [105000, 'C', 'Sell']] as const) {
      const o = ex.placeOrder({ category: 'option', symbol: sym(k, t), side, orderType: 'Market', qty: 1 });
      expect(o.status, `${side} ${k}${t}: ${o.rejectReason}`).toBe('Filled');
    }
    ex.config.options.marginMode = marginAfterEntry;
    const eq0 = ex.equity(ex.main);
    for (let i = 0; i < 30; i++) ex.step();
    return { ex, eq0 };
  }

  it('цена прошла через крыло: убыток ограничен, ликвидации нет', () => {
    const { ex, eq0 } = condorThrough('portfolio');
    expect(ex.main.stats.liquidations).toBe(0);
    expect(Object.keys(ex.main.positions).length).toBe(4);
    const loss = eq0 - ex.equity(ex.main);
    expect(loss).toBeGreaterThan(2000);
    expect(loss).toBeLessThan(5000); // не больше ширины крыла
    expect(ex.equity(ex.main)).toBeGreaterThan(ex.core(ex.main).mm);
  });

  it('тот же кондор при стандартной марже ликвидируется, хотя счёт покрывает весь риск', () => {
    const { ex } = condorThrough('regular');
    expect(ex.main.stats.liquidations).toBe(1);
    expect(ex.equity(ex.main)).toBeGreaterThan(3000);
  });

  it('проданная нога после купленного крыла требует маржу под риск спреда (вход в кондор на 8 000 USDT проходит)', () => {
    const ex = mkExchange({ BTCUSDT: flat(100000, 5) }, { initialBalance: 8000, options: { ...DEFAULT_OPTION_MODEL, marginMode: 'regular' } }, warm);
    const exp = ex.optionExpiries('BTC').find((e) => e - ex.now > 5 * 86400000)!;
    ex.placeOrder({ category: 'option', symbol: optionSymbol('BTC', exp, 110000, 'C'), side: 'Buy', orderType: 'Market', qty: 1 });
    // стандартная: проданный колл маржируется целиком (> 10 000) — отказ
    const r = ex.placeOrder({ category: 'option', symbol: optionSymbol('BTC', exp, 105000, 'C'), side: 'Sell', orderType: 'Market', qty: 1 });
    expect(r.status).toBe('Rejected');
    ex.config.options.marginMode = 'portfolio';
    const p = ex.placeOrder({ category: 'option', symbol: optionSymbol('BTC', exp, 105000, 'C'), side: 'Sell', orderType: 'Market', qty: 1 });
    expect(p.status).toBe('Filled');
  });
});

describe('Тестер опционных стратегий: ликвидация только настоящая', () => {
  it('скачок цены через проданный колл: при портфельной марже кондор доживает до конца, при стандартной — остановка с объяснением', async () => {
    // неделя спокойно у 100 000, в пятницу после входа — скачок на +20%, через 2.5 дня возврат
    const chop = (n: number, c: number): Bar[] =>
      Array.from({ length: n }, (_, i) => {
        const p = c * (1 + 0.004 * Math.sin(i / 3));
        return [p, p * 1.001, p * 0.999, p];
      });
    const m = mkMarket({ BTCUSDT: [...chop(114, 100000), ...chop(60, 120000), ...chop(60, 100000)] }, warm);
    const cfg = mkConfig({ start: m.start, end: m.end, symbols: ['BTCUSDT'], initialBalance: 100_000 });
    const base = { structure: 'iron_condor' as const, delta: 0.2, wingPct: 4, dte: 7, expiryMode: 'within' as const, schedule: 'weekly' as const, weekday: 5, entryHour: 8, sizeMode: 'risk' as const, riskPct: 10, useCap: false };
    const pm = await runOptionStrategy(m, cfg, makeSettings('BTCUSDT', 100_000, { ...base, marginMode: 'portfolio' }), { sliceMs: 1e9 });
    expect(pm.ok).toBe(true);
    expect(pm.halted).toBeUndefined();
    expect(pm.trades.map((g) => g.reason)).toEqual(['end']);
    const reg = await runOptionStrategy(m, cfg, makeSettings('BTCUSDT', 100_000, { ...base, marginMode: 'regular' }), { sliceMs: 1e9 });
    expect(reg.halted).toMatch(/Ликвидация .*: капитал [\d.]+ USDT опустился до поддерживающей маржи [\d.]+ USDT \(стандартная маржа/);
    // ликвидирован счёт с капиталом ~90% депозита: макс. убыток кондора покрыт, но стандартная маржа его не видит
    expect(reg.trades[0].reason).toBe('liquidation');
    expect(reg.report.totalReturn).toBeGreaterThan(-0.15);
    expect(pm.report.totalReturn).toBeGreaterThan(reg.report.totalReturn);
  });
});
