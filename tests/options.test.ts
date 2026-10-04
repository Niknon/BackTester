import { describe, expect, it } from 'vitest';
import {
  blackScholes,
  impliedVol,
  listExpiries,
  listStrikes,
  niceNumber,
  optionSymbol,
  parseOptionSymbol,
} from '../src/engine/options';
import { flat, mkExchange, T0 } from './helpers';
import { HOUR } from '../src/data/intervals';
import { MAIN } from '../src/engine/exchange';

describe('Блэк–Шоулз', () => {
  it('паритет колл-пут (r=0): C − P = S − K', () => {
    for (const [S, K, T, v] of [
      [100, 90, 0.1, 0.6],
      [60000, 65000, 0.5, 0.5],
      [2.5, 2.4, 0.02, 1.1],
    ]) {
      const c = blackScholes(S, K, T, v, 'C').price;
      const p = blackScholes(S, K, T, v, 'P').price;
      expect(c - p).toBeCloseTo(S - K, 6);
    }
  });

  it('греки: дельта колла в (0,1), путa в (−1,0), гамма/вега > 0, тета < 0', () => {
    const c = blackScholes(100, 100, 0.25, 0.5, 'C');
    const p = blackScholes(100, 100, 0.25, 0.5, 'P');
    expect(c.delta).toBeGreaterThan(0.5);
    expect(c.delta).toBeLessThan(0.6);
    expect(c.delta - p.delta).toBeCloseTo(1, 10);
    expect(c.gamma).toBeGreaterThan(0);
    expect(c.vega).toBeGreaterThan(0);
    expect(c.theta).toBeLessThan(0);
  });

  it('IV восстанавливается по цене', () => {
    const price = blackScholes(100, 110, 0.3, 0.73, 'C').price;
    expect(impliedVol(price, 100, 110, 0.3, 'C')).toBeCloseTo(0.73, 5);
  });
});

describe('Инструменты и экспирации', () => {
  it('символ опциона в формате Bybit', () => {
    const e = Date.UTC(2026, 8, 25, 8);
    const s = optionSymbol('BTC', e, 90000, 'C');
    expect(s).toBe('BTC-25SEP26-90000-C-USDT');
    const inst = parseOptionSymbol(s)!;
    expect(inst.strike).toBe(90000);
    expect(inst.expiry).toBe(e);
    expect(parseOptionSymbol('XRP-3OCT26-1.45-P-USDT')!.strike).toBe(1.45);
  });

  it('экспирации: дневные, недельные (пт), месячные; все в 08:00 UTC', () => {
    const now = Date.UTC(2026, 8, 29, 10); // вторник
    const ex = listExpiries(now, 'BTC');
    expect(ex[0]).toBe(Date.UTC(2026, 8, 30, 8));
    for (const e of ex) expect(new Date(e).getUTCHours()).toBe(8);
    expect(ex).toContain(Date.UTC(2026, 9, 2, 8)); // пятница
    expect(ex).toContain(Date.UTC(2026, 9, 30, 8)); // последняя пятница октября
    expect(ex).toContain(Date.UTC(2026, 11, 25, 8)); // квартальная
  });

  it('страйки кратны «красивому» шагу', () => {
    expect(niceNumber(415)).toBe(500);
    const ks = listStrikes(83000, 2 / 365, 0.5);
    const step = ks[1] - ks[0];
    expect(step).toBe(500);
    for (const k of ks) expect(k % 500).toBe(0);
  });
});

describe('Торговля опционами', () => {
  it('покупка колла, экспирация в деньгах, поставка с комиссией', () => {
    // рынок: 30 часовых баров, BTC растёт 100 → 120
    const bars: [number, number, number, number][] = [];
    for (let i = 0; i < 30; i++) {
      const p = 100 + (20 * i) / 29;
      bars.push([p, p, p, p]);
    }
    const ex = mkExchange({ BTCUSDT: bars }, { options: { ...mkExchange({ BTCUSDT: flat(1, 1) }).config.options, ivSource: 'fixed', fixedIv: 0.8 } });
    const expiry = T0 + 8 * HOUR; // 08:00
    const sym = optionSymbol('BTC', expiry, 100, 'C');
    const q = ex.optionQuote(sym)!;
    expect(q.mark).toBeGreaterThan(0);
    const w0 = ex.main.walletBalance;
    const o = ex.placeOrder({ category: 'option', symbol: sym, side: 'Buy', orderType: 'Market', qty: 1 });
    expect(o.status).toBe('Filled');
    expect(ex.main.walletBalance).toBeLessThan(w0 - q.ask + 1e-9);
    for (let i = 0; i < 9; i++) ex.step();
    expect(ex.main.positions[sym]).toBeUndefined();
    const rec = ex.state.closedPnl.at(-1)!;
    expect(rec.type).toBe('Delivery');
    const S = bars[8][0];
    expect(rec.exitPrice).toBeCloseTo(S - 100, 8);
  });

  it('продажа пута: премия зачисляется, маржа резервируется', () => {
    const ex = mkExchange({ ETHUSDT: flat(2000, 40) }, { options: { ...mkExchange({ ETHUSDT: flat(1, 1) }).config.options, ivSource: 'fixed', fixedIv: 0.6 } });
    const expiry = T0 + 32 * HOUR;
    const sym = optionSymbol('ETH', expiry, 1900, 'P');
    const q = ex.optionQuote(sym)!;
    const avail0 = ex.available(ex.main);
    const o = ex.placeOrder({ category: 'option', symbol: sym, side: 'Sell', orderType: 'Market', qty: 1 });
    expect(o.status).toBe('Filled');
    expect(ex.main.positions[sym].size).toBe(-1);
    const s = ex.summary(ex.main);
    expect(s.initialMargin).toBeGreaterThan(0.1 * 2000);
    expect(s.available).toBeLessThan(avail0);
    // экспирация вне денег: премия остаётся
    for (let i = 0; i < 33; i++) ex.step();
    expect(ex.main.positions[sym]).toBeUndefined();
    const rec = ex.state.closedPnl.at(-1)!;
    expect(rec.closedPnl).toBeGreaterThan(0);
    expect(rec.closedPnl).toBeLessThanOrEqual(q.bid);
  });

  it('цепочка опционов содержит коллы и путы для каждого страйка', () => {
    const ex = mkExchange({ SOLUSDT: flat(120, 5) });
    const exp = ex.optionExpiries('SOL');
    expect(exp.length).toBeGreaterThan(5);
    const chain = ex.optionChain('SOL', exp[0]);
    expect(chain.rows.length).toBeGreaterThan(8);
    for (const r of chain.rows) {
      expect(r.call.mark).toBeGreaterThanOrEqual(0);
      expect(r.put.inst.type).toBe('P');
      expect(r.call.ask).toBeGreaterThanOrEqual(r.call.bid);
    }
    expect(ex.account(MAIN)).toBeTruthy();
  });
});

describe('Опционные стратегии', () => {
  it('железный кондор: 4 ноги одним действием, кредит, позиции открыты', async () => {
    const { STRATEGIES, resolveStrategy, openStrategy } = await import('../src/engine/optionStrategies');
    const ex = mkExchange({ BTCUSDT: flat(100000, 48) }, { initialBalance: 100_000 }, flat(100000, 24 * 40));
    const exp = ex.optionExpiries('BTC')[3];
    const chain = ex.optionChain('BTC', exp);
    const strikes = chain.rows.map((r) => r.strike);
    const atm = strikes.reduce((b, k, i) => (Math.abs(k - 100000) < Math.abs(strikes[b] - 100000) ? i : b), 0);
    const def = STRATEGIES.find((d) => d.key === 'iron_condor')!;
    const r = resolveStrategy(ex, def, 'BTC', strikes, atm, 2, exp, exp, 0.1);
    expect(r.error).toBeUndefined();
    expect(r.legs.length).toBe(4);
    const credit = r.legs.reduce((s, l) => s + (l.side === 'Sell' ? 1 : -1) * l.price * l.qty, 0);
    expect(credit).toBeGreaterThan(0);
    const res = openStrategy(ex, r.legs);
    expect(res.ok).toBe(true);
    expect(Object.values(ex.main.positions).filter((p) => p.category === 'option').length).toBe(4);
  });

  it('если нога отклонена — исполненные ноги откатываются', async () => {
    const { STRATEGIES, resolveStrategy, openStrategy } = await import('../src/engine/optionStrategies');
    const ex = mkExchange({ BTCUSDT: flat(100000, 48) }, { initialBalance: 200 }, flat(100000, 24 * 40));
    const exp = ex.optionExpiries('BTC')[3];
    const strikes = ex.optionChain('BTC', exp).rows.map((r) => r.strike);
    const atm = strikes.reduce((b, k, i) => (Math.abs(k - 100000) < Math.abs(strikes[b] - 100000) ? i : b), 0);
    // при депозите 200 USDT маржи под проданные коллы не хватит — продажа будет отклонена
    const def = STRATEGIES.find((d) => d.key === 'call_ratio')!;
    const r = resolveStrategy(ex, def, 'BTC', strikes, atm, 1, exp, exp, 0.01);
    const res = openStrategy(ex, r.legs);
    expect(res.ok).toBe(false);
    expect(Object.values(ex.main.positions).filter((p) => p.category === 'option' && p.size !== 0).length).toBe(0);
  });
});

describe('Маржа и ликвидация проданных опционов', () => {
  const warm: [number, number, number, number][] = Array.from({ length: 24 * 40 }, (_, i) => {
    const p = 70000 * (1 + 0.02 * Math.sin(i / 5));
    return [p, p * 1.004, p * 0.996, p];
  });

  it('премия не засчитывается в маржу: глубоко ITM-шорт сверх депозита отклоняется', () => {
    const ex = mkExchange({ BTCUSDT: flat(90000, 5) }, { initialBalance: 10000 }, warm.map((b) => b.map((x) => (x * 9) / 7) as [number, number, number, number]));
    const exp = ex.optionExpiries('BTC')[3];
    const sym = optionSymbol('BTC', exp, 70000, 'C');
    const o = ex.placeOrder({ category: 'option', symbol: sym, side: 'Sell', orderType: 'Market', qty: 0.5 });
    expect(o.status).toBe('Rejected');
    expect(o.rejectReason).toMatch(/Недостаточно средств/);
  });

  it('шорт колла: рост на 2000 даёт убыток ≈ 0.5 × рост mark, без ликвидации', () => {
    const ex = mkExchange({ BTCUSDT: [...flat(70000, 3), [70000, 72000, 70000, 72000], ...flat(72000, 3)] }, { initialBalance: 10000 }, warm);
    const sym = optionSymbol('BTC', ex.optionExpiries('BTC')[3], 70000, 'C');
    expect(ex.placeOrder({ category: 'option', symbol: sym, side: 'Sell', orderType: 'Market', qty: 0.5 }).status).toBe('Filled');
    const eq0 = ex.equity(ex.main);
    const m0 = ex.optionMark(sym);
    for (let i = 0; i < 5; i++) ex.step();
    expect(ex.main.positions[sym]?.size).toBe(-0.5);
    expect(ex.main.stats.liquidations).toBe(0);
    const loss = eq0 - ex.equity(ex.main);
    expect(Math.abs(loss - 0.5 * (ex.optionMark(sym) - m0))).toBeLessThan(1);
    expect(loss).toBeGreaterThan(500);
    expect(loss).toBeLessThan(1200);
  });

  it('ликвидация опционов не списывает весь капитал — только рыночный убыток', () => {
    // депозит впритык: после сильного роста капитал падает ниже поддерживающей маржи
    const ex = mkExchange({ BTCUSDT: [...flat(70000, 3), [70000, 82000, 70000, 82000], ...flat(82000, 3)] }, { initialBalance: 6000 }, warm);
    const sym = optionSymbol('BTC', ex.optionExpiries('BTC')[3], 70000, 'C');
    expect(ex.placeOrder({ category: 'option', symbol: sym, side: 'Sell', orderType: 'Market', qty: 0.5 }).status).toBe('Filled');
    const w0 = ex.main.walletBalance;
    for (let i = 0; i < 5; i++) ex.step();
    expect(ex.main.stats.liquidations).toBe(1);
    expect(ex.main.positions[sym]).toBeUndefined();
    const rec = ex.state.closedPnl.at(-1)!;
    // закрыто по mark: убыток = 0.5 × (mark − премия) ≈ 0.5 × 12000, а не весь депозит
    expect(-rec.closedPnl).toBeLessThan(0.5 * 12500);
    expect(ex.main.walletBalance).toBeGreaterThan(0);
    // с кошелька ушла только стоимость выкупа опциона по mark (+ комиссия), без списания в страховой фонд
    expect(Math.abs(w0 - ex.main.walletBalance - 0.5 * rec.exitPrice)).toBeLessThan(30);
  });
});

describe('Модельные опционы на акции США', () => {
  it('цепочка и сделка по опциону на AAPL (базовый актив — AAPLUSDT)', () => {
    const warmA: [number, number, number, number][] = Array.from({ length: 24 * 40 }, (_, i) => {
      const p = 330 * (1 + 0.015 * Math.sin(i / 6));
      return [p, p * 1.002, p * 0.998, p];
    });
    const ex = mkExchange({ AAPLUSDT: flat(330, 30) }, { initialBalance: 10000 }, warmA);
    const exp = ex.optionExpiries('AAPL')[3];
    const chain = ex.optionChain('AAPL', exp);
    expect(chain.rows.length).toBeGreaterThan(5);
    const row = chain.rows.reduce((b, r) => (Math.abs(r.strike - 330) < Math.abs(b.strike - 330) ? r : b));
    expect(row.call.mark).toBeGreaterThan(0);
    const o = ex.placeOrder({ category: 'option', symbol: row.call.inst.symbol, side: 'Buy', orderType: 'Market', qty: 5 });
    expect(o.status).toBe('Filled');
    expect(ex.main.positions[row.call.inst.symbol].size).toBe(5);
  });
});
