import { describe, expect, it } from 'vitest';
import { syntheticProvider, mulberry32 } from '../src/data/providers/synthetic';
import { seriesFromCandles } from '../src/data/types';
import { DAY, HOUR } from '../src/data/intervals';
import { MarketData } from '../src/engine/market';
import { Exchange, MAIN } from '../src/engine/exchange';
import { optionSymbol } from '../src/engine/options';
import { mkConfig } from './helpers';

async function market(symbols: string[], days: number) {
  const start = Date.UTC(2025, 2, 3);
  const end = start + days * DAY;
  const m = new MarketData('1h', start, end);
  for (const s of symbols) {
    const c = await syntheticProvider.fetchKlines(s, '1h', start - 40 * DAY, end);
    m.addSeries(s, seriesFromCandles(s, '1h', c), 'synthetic');
    m.setFunding(s, await syntheticProvider.fetchFunding!(s, start - 40 * DAY, end));
  }
  return m;
}

describe('Случайные действия (fuzz): движок не ломается и сохраняет инварианты', () => {
  it('500 часов случайной торговли перпетуалами, спотом, опционами и ботами', async () => {
    const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const m = await market(syms, 21);
    const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, symbols: syms, fundingEnabled: true, initialBalance: 50_000, slippageBps: 2 }), m);
    const rnd = mulberry32(42);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    let placed = 0;
    // боты
    const px0 = ex.price('ETHUSDT');
    expect(ex.createBot('futuresGrid', 'g', 3000, { symbol: 'ETHUSDT', direction: 'neutral', lower: px0 * 0.85, upper: px0 * 1.15, grids: 20, mode: 'geometric', leverage: 3, closeOnStop: true }).error).toBeUndefined();
    expect(ex.createBot('spotGrid', 's', 3000, { symbol: 'SOLUSDT', lower: ex.price('SOLUSDT') * 0.8, upper: ex.price('SOLUSDT') * 1.2, grids: 15, mode: 'arithmetic', sellOnStop: true }).error).toBeUndefined();
    expect(
      ex.createBot('futuresCombo', 'c', 3000, {
        legs: [
          { symbol: 'BTCUSDT', side: 'long', weight: 50 },
          { symbol: 'ETHUSDT', side: 'short', weight: 50 },
        ],
        leverage: 2,
        rebalanceMode: 'threshold',
        intervalHours: 24,
        thresholdPct: 3,
      }).error,
    ).toBeUndefined();
    while (!ex.state.finished) {
      const sym = pick(syms);
      const px = ex.price(sym);
      const r = rnd();
      if (r < 0.08) {
        ex.setLeverage(MAIN, sym, 1 + Math.floor(rnd() * 30));
      } else if (r < 0.2) {
        ex.placeOrder({ category: 'linear', symbol: sym, side: rnd() < 0.5 ? 'Buy' : 'Sell', orderType: 'Market', qty: (rnd() * 2000) / px });
        placed++;
      } else if (r < 0.3) {
        ex.placeOrder({
          category: 'linear',
          symbol: sym,
          side: rnd() < 0.5 ? 'Buy' : 'Sell',
          orderType: 'Limit',
          price: px * (1 + (rnd() - 0.5) * 0.04),
          qty: (rnd() * 2000) / px,
          tif: pick(['GTC', 'IOC', 'PostOnly'] as const),
          takeProfit: rnd() < 0.3 ? px * 1.05 : undefined,
        });
        placed++;
      } else if (r < 0.35) {
        const pos = ex.main.positions[sym];
        if (pos && pos.category === 'linear') ex.setTradingStop(MAIN, sym, { stopLoss: pos.size > 0 ? px * 0.97 : px * 1.03, trailingStop: rnd() < 0.5 ? px * 0.01 : null });
      } else if (r < 0.4) {
        ex.closePosition(MAIN, sym);
      } else if (r < 0.45) {
        ex.placeOrder({ category: 'spot', symbol: sym, side: rnd() < 0.6 ? 'Buy' : 'Sell', orderType: 'Market', qty: (rnd() * 500) / px });
      } else if (r < 0.5) {
        const base = sym.replace('USDT', '');
        const exps = ex.optionExpiries(base);
        const chain = ex.optionChain(base, pick(exps));
        const row = pick(chain.rows);
        const q = rnd() < 0.5 ? row.call : row.put;
        ex.placeOrder({ category: 'option', symbol: q.inst.symbol, side: rnd() < 0.6 ? 'Buy' : 'Sell', orderType: rnd() < 0.7 ? 'Market' : 'Limit', price: q.mark, qty: 0.1 });
      } else if (r < 0.52) {
        const os = ex.activeOrders(MAIN);
        if (os.length) ex.cancelOrder(pick(os).id);
      } else if (r < 0.53) {
        ex.setMarginMode(MAIN, sym, rnd() < 0.5 ? 'isolated' : 'cross');
      }
      ex.step();
      // инварианты
      for (const acc of Object.values(ex.state.accounts)) {
        expect(Number.isFinite(acc.walletBalance)).toBe(true);
        for (const p of Object.values(acc.positions)) {
          expect(p.size).not.toBe(0);
          expect(Number.isFinite(p.avgPrice)).toBe(true);
          expect(p.isolatedMargin).toBeGreaterThanOrEqual(-1e-6);
        }
      }
      const eq = ex.totalEquity();
      expect(Number.isFinite(eq.total)).toBe(true);
    }
    expect(placed).toBeGreaterThan(50);
    expect(ex.state.executions.length).toBeGreaterThan(100);
    // сериализация полного состояния
    const ex2 = Exchange.restore(ex.serialize(), m);
    expect(ex2.totalEquity().total).toBeCloseTo(ex.totalEquity().total, 6);
  }, 60_000);

  it('экспирация опционов по всем позициям в конце периода', async () => {
    const m = await market(['BTCUSDT'], 10);
    const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, symbols: ['BTCUSDT'] }), m);
    const exps = ex.optionExpiries('BTC').filter((e) => e < m.end);
    expect(exps.length).toBeGreaterThan(1);
    for (const e of exps.slice(0, 3)) {
      const S = ex.price('BTCUSDT');
      const k = Math.round(S / 1000) * 1000;
      ex.placeOrder({ category: 'option', symbol: optionSymbol('BTC', e, k, 'C'), side: 'Buy', orderType: 'Market', qty: 0.1 });
      ex.placeOrder({ category: 'option', symbol: optionSymbol('BTC', e, k, 'P'), side: 'Sell', orderType: 'Market', qty: 0.1 });
    }
    expect(Object.keys(ex.main.positions).length).toBe(6);
    while (ex.step()) {
      /* до конца */
    }
    const left = Object.values(ex.main.positions).filter((p) => ex.optionInstrument(p.symbol)!.expiry < m.end);
    expect(left.length).toBe(0);
    const deliveries = ex.state.closedPnl.filter((c) => c.type === 'Delivery');
    expect(deliveries.length).toBe(6);
    expect(ex.state.now - m.start).toBe(10 * DAY);
    expect(HOUR).toBe(3_600_000);
  }, 60_000);
});
