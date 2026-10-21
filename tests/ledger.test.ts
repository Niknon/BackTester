import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/data/providers/synthetic';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { DAY, HOUR } from '../src/data/intervals';
import { MarketData } from '../src/engine/market';
import { Exchange, MAIN } from '../src/engine/exchange';
import type { Account } from '../src/engine/types';
import { mkConfig } from './helpers';

/**
 * Рынок «потяжелее» синтетики: часовая волатильность ~1.5%, редкие разрывы ±4–12% (как гэпы акций)
 * и funding каждые 8 часов со случайным знаком — чтобы срабатывали ликвидации, TP/SL «через гэп» и т.п.
 */
function roughMarket(symbols: Record<string, number>, hours: number, seed: number) {
  const start = Date.UTC(2025, 2, 3);
  const m = new MarketData('1h', start, start + hours * HOUR);
  const rnd = mulberry32(seed);
  for (const [sym, p0] of Object.entries(symbols)) {
    const candles: Candle[] = [];
    let px = p0;
    for (let i = -24; i < hours; i++) {
      let o = px;
      if (rnd() < 0.03) o = px * (1 + (rnd() < 0.5 ? -1 : 1) * (0.04 + rnd() * 0.08));
      const c = o * Math.exp((rnd() - 0.5) * 0.05);
      const h = Math.max(o, c) * (1 + rnd() * 0.01);
      const l = Math.min(o, c) * (1 - rnd() * 0.01);
      candles.push({ t: start + i * HOUR, o, h, l, c, v: 1000 });
      px = c;
    }
    m.addSeries(sym, seriesFromCandles(sym, '1h', candles), 'synthetic');
    const f = [];
    for (let t = start - DAY; t < start + hours * HOUR; t += 8 * HOUR) f.push({ t, rate: (rnd() - 0.45) * 0.002 });
    m.setFunding(sym, f);
  }
  return m;
}

/**
 * Бухгалтерия перпетуалов:
 *   капитал − внесено = закрытый PnL (с комиссиями и funding) + Σ по открытым (нереализованный − комиссия открытия + funding).
 * Комиссии и funding берутся из сделок/начислений, а не из статистики аккаунта.
 */
function checkLedger(ex: Exchange, acc: Account, base: number, ctx: string) {
  const c = ex.core(acc);
  let open = 0;
  for (const pos of Object.values(acc.positions)) {
    expect(pos.category, ctx).toBe('linear');
    expect(pos.size, `${ctx}: нулевая позиция не удалена`).not.toBe(0);
    expect(pos.avgPrice, ctx).toBeGreaterThan(0);
    expect(Number.isFinite(pos.openFee) && Number.isFinite(pos.funding), ctx).toBe(true);
    if (pos.marginMode === 'isolated') expect(pos.isolatedMargin, ctx).toBeGreaterThan(0);
    else expect(pos.isolatedMargin, ctx).toBe(0);
    open += ex.unrealisedPnl(pos) - pos.openFee + pos.funding;
  }
  const lhs = c.equity - base;
  const rhs = acc.stats.realisedPnl + open;
  expect(Math.abs(lhs - rhs), `${ctx}: капитал ${lhs.toFixed(6)} ≠ PnL ${rhs.toFixed(6)}`).toBeLessThan(1e-6 * Math.max(1, Math.abs(base)));
  const recs = ex.state.closedPnl.filter((r) => r.accountId === acc.id);
  const sumRec = recs.reduce((x, r) => x + r.closedPnl, 0);
  expect(Math.abs(sumRec - acc.stats.realisedPnl), `${ctx}: записи закрытого PnL`).toBeLessThan(1e-6 * Math.max(1, Math.abs(base)));
  // комиссии и funding — из ленты исполнений
  const execs = ex.state.executions.filter((e) => e.accountId === acc.id);
  const fees = execs.filter((e) => e.execType !== 'Funding').reduce((x, e) => x + e.fee, 0);
  const funding = execs.filter((e) => e.execType === 'Funding').reduce((x, e) => x - e.fee, 0);
  expect(Math.abs(fees - acc.stats.fees), `${ctx}: комиссии`).toBeLessThan(1e-6 * Math.max(1, base));
  expect(Math.abs(funding - acc.stats.funding), `${ctx}: funding`).toBeLessThan(1e-6 * Math.max(1, base));
  // после закрытия свечи нет кросс-счёта за чертой ликвидации и изолированной позиции ниже поддерживающей маржи
  if (c.mm > 0) expect(c.crossEquity, `${ctx}: кросс-счёт не ликвидирован`).toBeGreaterThan(c.mm);
  for (const pos of Object.values(acc.positions))
    if (pos.marginMode === 'isolated')
      expect(pos.isolatedMargin + ex.unrealisedPnl(pos), `${ctx}: изолированная ${pos.symbol} не ликвидирована`).toBeGreaterThanOrEqual(ex.positionMM(pos) * (1 - 1e-9));
  // закрывающие ордера не переживают свою позицию
  for (const o of ex.activeOrders(acc.id)) if (o.reduceOnly || o.closeOnTrigger || o.tag === 'tpsl') expect(acc.positions[o.symbol], `${ctx}: ордер ${o.id} без позиции`).toBeDefined();
}

describe('Бухгалтерия перпетуалов на случайных действиях', () => {
  const syms = { BTCUSDT: 60_000, ETHUSDT: 3_000, SOLUSDT: 9.971 };
  const names = Object.keys(syms);

  for (const seed of [1, 7, 42, 2024]) {
    it(`сид ${seed}: капитал = закрытый PnL + открытый, после каждой свечи`, () => {
      const hours = 600;
      const m = roughMarket(syms, hours, seed);
      const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, symbols: names, fundingEnabled: true, initialBalance: 100_000, slippageBps: 3 }), m);
      const rnd = mulberry32(seed * 7919);
      const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
      let steps = 0;
      while (!ex.state.finished) {
        const n = Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const sym = pick(names);
          const px = ex.price(sym);
          const pos = ex.main.positions[sym];
          const r = rnd();
          const qty = (rnd() * 40_000) / px;
          const side = rnd() < 0.5 ? 'Buy' : 'Sell';
          if (r < 0.06) ex.setLeverage(MAIN, sym, 1 + Math.floor(rnd() * 60));
          else if (r < 0.1) ex.setMarginMode(MAIN, sym, rnd() < 0.5 ? 'isolated' : 'cross');
          else if (r < 0.28) ex.placeOrder({ category: 'linear', symbol: sym, side, orderType: 'Market', qty });
          else if (r < 0.42)
            ex.placeOrder({
              category: 'linear',
              symbol: sym,
              side,
              orderType: 'Limit',
              price: px * (1 + (rnd() - 0.5) * 0.06),
              qty,
              tif: pick(['GTC', 'GTC', 'IOC', 'PostOnly'] as const),
              reduceOnly: rnd() < 0.15,
              takeProfit: rnd() < 0.3 ? px * (side === 'Buy' ? 1.04 : 0.96) : undefined,
              stopLoss: rnd() < 0.3 ? px * (side === 'Buy' ? 0.96 : 1.04) : undefined,
            });
          else if (r < 0.5) {
            // условный (стоп) рыночный ордер
            const up = rnd() < 0.5;
            ex.placeOrder({ category: 'linear', symbol: sym, side, orderType: 'Market', qty, triggerPrice: px * (up ? 1.02 : 0.98), triggerDirection: up ? 1 : 2, reduceOnly: rnd() < 0.3 });
          } else if (r < 0.58 && pos) {
            const long = pos.size > 0;
            ex.setTradingStop(MAIN, sym, {
              takeProfit: rnd() < 0.5 ? px * (long ? 1.03 : 0.97) : undefined,
              stopLoss: rnd() < 0.5 ? px * (long ? 0.97 : 1.03) : undefined,
              trailingStop: rnd() < 0.4 ? px * 0.015 : undefined,
            });
          } else if (r < 0.64 && pos) ex.addMargin(MAIN, sym, (rnd() - 0.3) * 2000);
          else if (r < 0.7 && pos) ex.placeOrder({ category: 'linear', symbol: sym, side: pos.size > 0 ? 'Sell' : 'Buy', orderType: 'Market', qty: Math.abs(pos.size) * rnd(), reduceOnly: true });
          else if (r < 0.74) ex.closePosition(MAIN, sym);
          else if (r < 0.8) {
            const o = pick(ex.activeOrders(MAIN));
            if (o) ex.cancelOrder(o.id);
          }
          checkLedger(ex, ex.main, 100_000, `сид ${seed}, свеча ${steps}, после действия r=${r.toFixed(3)}`);
        }
        ex.step();
        steps++;
        checkLedger(ex, ex.main, 100_000, `сид ${seed}, свеча ${steps}`);
      }
      // что-то действительно происходило
      expect(ex.main.stats.trades).toBeGreaterThan(50);
      expect(Math.abs(ex.main.stats.funding)).toBeGreaterThan(0);
    });
  }

  it('ликвидации (изолированные и кросс) и разрывы цены тоже сходятся', () => {
    let liq = 0;
    for (const seed of [3, 5, 11, 13, 17]) {
      const m = roughMarket(syms, 300, seed);
      const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, symbols: names, fundingEnabled: true, initialBalance: 20_000, slippageBps: 2 }), m);
      const rnd = mulberry32(seed);
      let steps = 0;
      while (!ex.state.finished) {
        const sym = names[Math.floor(rnd() * names.length)];
        if (!ex.main.positions[sym] && !ex.activeOrders(MAIN, sym).length) {
          ex.setMarginMode(MAIN, sym, rnd() < 0.5 ? 'isolated' : 'cross');
          ex.setLeverage(MAIN, sym, 20 + Math.floor(rnd() * 30));
          const avail = ex.available(ex.main);
          if (avail > 100) ex.placeOrder({ category: 'linear', symbol: sym, side: rnd() < 0.5 ? 'Buy' : 'Sell', orderType: 'Market', qty: (avail * 0.3 * 20) / ex.price(sym) });
        }
        ex.step();
        steps++;
        checkLedger(ex, ex.main, 20_000, `ликвидации, сид ${seed}, свеча ${steps}`);
      }
      liq += ex.main.stats.liquidations;
    }
    expect(liq).toBeGreaterThan(10);
  });
});

/** Открытый результат аккаунта: перпетуалы (нереализованный − комиссия открытия + funding) и спот (стоимость − цена покупки с комиссией). */
function openPart(ex: Exchange, acc: Account) {
  let open = 0;
  for (const pos of Object.values(acc.positions)) open += ex.unrealisedPnl(pos) - pos.openFee + pos.funding;
  for (const [coin, qty] of Object.entries(acc.spot)) open += qty * ex.price(`${coin}USDT`) - (acc.spotCost[coin] || 0);
  return open;
}

describe('Бухгалтерия ботов на случайных параметрах', () => {
  const syms = { BTCUSDT: 60_000, ETHUSDT: 3_000, SOLUSDT: 9.971 };
  const names = Object.keys(syms);

  for (const seed of [2, 9, 31, 77, 123, 555]) {
    it(`сид ${seed}: капитал каждого бота и всей сессии = закрытый + открытый PnL`, () => {
      const hours = 500;
      const m = roughMarket(syms, hours, seed);
      const initial = 200_000;
      const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, symbols: names, fundingEnabled: true, initialBalance: initial, slippageBps: 3 }), m);
      const rnd = mulberry32(seed * 31337);
      const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
      const mkBots = () => {
        const sym = pick(names);
        const px = ex.price(sym);
        const lo = px * (0.7 + rnd() * 0.25);
        const hi = px * (1.05 + rnd() * 0.3);
        const inv = 2000 + rnd() * 8000;
        const tries: [string, any][] = [
          ['spotGrid', { symbol: sym, lower: lo, upper: hi, grids: 5 + Math.floor(rnd() * 30), mode: pick(['arithmetic', 'geometric']), sellOnStop: rnd() < 0.5, tpPrice: rnd() < 0.3 ? hi * 1.02 : undefined, slPrice: rnd() < 0.3 ? lo * 0.98 : undefined }],
          ['futuresGrid', { symbol: sym, direction: pick(['long', 'short', 'neutral']), lower: lo, upper: hi, grids: 5 + Math.floor(rnd() * 30), mode: pick(['arithmetic', 'geometric']), leverage: 1 + Math.floor(rnd() * 10), closeOnStop: true, tpRoi: rnd() < 0.3 ? 20 : undefined, slRoi: rnd() < 0.3 ? 30 : undefined }],
          ['futuresCombo', { legs: [{ symbol: 'BTCUSDT', side: pick(['long', 'short']), weight: 40 }, { symbol: 'ETHUSDT', side: pick(['long', 'short']), weight: 35 }, { symbol: 'SOLUSDT', side: pick(['long', 'short']), weight: 25 }], leverage: 1 + Math.floor(rnd() * 5), rebalanceMode: pick(['time', 'threshold', 'none']), intervalHours: pick([4, 24, 72]), thresholdPct: pick([1, 3, 5]), tpRoi: rnd() < 0.2 ? 30 : undefined, slRoi: rnd() < 0.2 ? 40 : undefined }],
          ['dca', { symbol: sym, amount: 100 + Math.floor(rnd() * 400), intervalHours: pick([1, 6, 24]), maxOrders: 5 + Math.floor(rnd() * 10), tpPct: rnd() < 0.5 ? 3 + rnd() * 5 : undefined }],
          ['martingale', { symbol: sym, side: pick(['long', 'short']), leverage: 1 + Math.floor(rnd() * 10), initialMargin: 100, stepPct: 1 + rnd() * 3, multiplier: 1 + rnd(), maxAdds: 3, tpPct: 0.5 + rnd() * 2, slPct: rnd() < 0.4 ? 5 : undefined, loop: rnd() < 0.7 }],
        ];
        const [type, params] = pick(tries);
        ex.createBot(type as any, `${type}-${seed}`, type === 'dca' ? Math.max(inv, params.amount * params.maxOrders) : inv, params);
      };
      let steps = 0;
      while (!ex.state.finished) {
        if (rnd() < 0.06) mkBots();
        if (rnd() < 0.01) {
          const b = pick(Object.values(ex.state.bots).filter((x) => x.status === 'running'));
          if (b) ex.stopBot(b.id, 'тест', { keepPositions: rnd() < 0.3 });
        }
        ex.step();
        steps++;
        const ctx = `сид ${seed}, свеча ${steps}`;
        let total = 0;
        let pnl = 0;
        for (const acc of Object.values(ex.state.accounts)) {
          total += ex.equity(acc);
          pnl += acc.stats.realisedPnl + openPart(ex, acc);
          const bot = acc.botId ? ex.state.bots[acc.botId] : undefined;
          if (bot && (bot.status === 'running' || bot.status === 'waiting')) {
            const lhs = ex.equity(acc) - bot.investment;
            const rhs = acc.stats.realisedPnl + openPart(ex, acc);
            expect(Math.abs(lhs - rhs), `${ctx}: бот ${bot.type} ${lhs} ≠ ${rhs}`).toBeLessThan(1e-6 * bot.investment);
            expect(Math.abs(ex.botSummary(bot).pnl - lhs), ctx).toBeLessThan(1e-9 * bot.investment);
          }
        }
        expect(Math.abs(total - initial - pnl), `${ctx}: вся сессия ${total - initial} ≠ ${pnl}`).toBeLessThan(1e-6 * initial);
      }
      // у остановленных ботов итог = закрытый PnL (+ переданные на основной счёт монеты/позиции по их стоимости на момент остановки)
      const types = new Set(Object.values(ex.state.bots).map((b) => b.type));
      expect(types.size).toBeGreaterThanOrEqual(3);
    });
  }
});
