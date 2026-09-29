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
