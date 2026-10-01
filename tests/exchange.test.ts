import { describe, expect, it } from 'vitest';
import { flat, mkExchange } from './helpers';
import { Exchange, MAIN } from '../src/engine/exchange';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('USDT-перпетуалы: исполнение и PnL', () => {
  it('маркет-лонг и закрытие: комиссии тейкера и реализованный PnL', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 100, 100, 110], ...flat(110, 5)] });
    ex.setLeverage(MAIN, 'BTCUSDT', 10);
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1 });
    expect(o.status).toBe('Filled');
    const fee1 = 100 * 0.00055;
    close(ex.main.walletBalance, 10_000 - fee1);
    ex.step(); // цена → 110
    const pos = ex.main.positions.BTCUSDT;
    close(ex.unrealisedPnl(pos), 10);
    ex.closePosition(MAIN, 'BTCUSDT');
    const fee2 = 110 * 0.00055;
    close(ex.main.walletBalance, 10_000 + 10 - fee1 - fee2);
    const rec = ex.state.closedPnl.at(-1)!;
    close(rec.closedPnl, 10 - fee1 - fee2);
    expect(ex.main.positions.BTCUSDT).toBeUndefined();
  });

  it('лимитный ордер исполняется внутри бара как мейкер', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 101, 95, 99], ...flat(99, 3)] });
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', price: 96, qty: 2 });
    expect(o.status).toBe('New');
    ex.step();
    const pos = ex.main.positions.BTCUSDT;
    expect(pos.size).toBe(2);
    expect(pos.avgPrice).toBe(96);
    const exec = ex.state.executions.at(-1)!;
    expect(exec.isMaker).toBe(true);
    close(exec.fee, 2 * 96 * 0.0002);
  });

  it('отклоняет ордер при нехватке маржи', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 3) }, { initialBalance: 100 });
    ex.setLeverage(MAIN, 'BTCUSDT', 5);
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 10 });
    expect(o.status).toBe('Rejected');
    const ok = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 4 });
    expect(ok.status).toBe('Filled');
  });

  it('сокращающий ордер проходит даже при отрицательном доступном балансе', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 100, 97, 97], ...flat(97, 2)] }, { initialBalance: 100 });
    ex.setLeverage(MAIN, 'BTCUSDT', 10);
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 9.5 });
    ex.step(); // цена 97: убыток, доступный баланс < 0, но до ликвидации далеко
    expect(ex.main.positions.BTCUSDT.size).toBe(9.5);
    expect(ex.available(ex.main)).toBeLessThan(0);
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: 3 });
    expect(o.status).toBe('Filled');
    expect(ex.main.positions.BTCUSDT.size).toBeCloseTo(6.5, 9);
  });

  it('разворот позиции одним ордером', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 3) });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1 });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: 3 });
    expect(ex.main.positions.BTCUSDT.size).toBe(-2);
    expect(ex.main.positions.BTCUSDT.avgPrice).toBe(100);
  });

  it('Post-Only отклоняется, если исполнился бы как тейкер', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 3) });
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', price: 101, qty: 1, tif: 'PostOnly' });
    expect(o.status).toBe('Rejected');
  });
});

describe('TP/SL и условные ордера', () => {
  it('в медвежьей свече SL срабатывает раньше TP (путь O→H→L→C)', () => {
    // бар: open 100, high 106, low 94, close 97 → сначала 106 (TP), потом 94
    const ex = mkExchange({ BTCUSDT: [[100, 106, 94, 97], ...flat(97, 2)] });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1, takeProfit: 105, stopLoss: 95 });
    const pos = ex.main.positions.BTCUSDT;
    expect(pos.takeProfit).toBe(105);
    expect(pos.stopLoss).toBe(95);
    ex.step();
    expect(ex.main.positions.BTCUSDT).toBeUndefined();
    const rec = ex.state.closedPnl.at(-1)!;
    expect(rec.type).toBe('TP');
    expect(rec.exitPrice).toBe(105);
  });

  it('в бычьей свече сначала low → срабатывает SL', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 106, 94, 103], ...flat(103, 2)] });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1, takeProfit: 105, stopLoss: 95 });
    ex.step();
    const rec = ex.state.closedPnl.at(-1)!;
    expect(rec.type).toBe('SL');
    expect(rec.exitPrice).toBe(95);
  });

  it('стоп-маркет на пробой открывает позицию', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 104, 99, 103], ...flat(103, 2)] });
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1, triggerPrice: 102 });
    expect(o.status).toBe('Untriggered');
    ex.step();
    expect(ex.main.positions.BTCUSDT.size).toBe(1);
    expect(ex.main.positions.BTCUSDT.avgPrice).toBe(102);
  });

  it('трейлинг-стоп следует за ценой', () => {
    const ex = mkExchange({
      BTCUSDT: [
        [100, 110, 100, 110],
        [110, 120, 110, 120],
        [120, 120, 100, 101],
        ...flat(101, 2),
      ],
    });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1 });
    ex.setTradingStop(MAIN, 'BTCUSDT', { trailingStop: 5 });
    ex.step();
    ex.step();
    expect(ex.main.positions.BTCUSDT.size).toBe(1);
    ex.step();
    expect(ex.main.positions.BTCUSDT).toBeUndefined();
    expect(ex.state.closedPnl.at(-1)!.exitPrice).toBe(115);
  });
});

describe('Ликвидации', () => {
  it('изолированная позиция 50x ликвидируется с потерей всей маржи', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 100, 97, 98], ...flat(98, 2)] });
    ex.setMarginMode(MAIN, 'BTCUSDT', 'isolated');
    ex.setLeverage(MAIN, 'BTCUSDT', 50);
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 10 });
    const pos = ex.main.positions.BTCUSDT;
    close(pos.isolatedMargin, 20);
    const liq = ex.liqPrice(ex.main, pos)!;
    expect(liq).toBeGreaterThan(97);
    expect(liq).toBeLessThan(99);
    const walletBefore = ex.main.walletBalance;
    ex.step();
    expect(ex.main.positions.BTCUSDT).toBeUndefined();
    close(ex.main.walletBalance, walletBefore - 20, 1e-6);
    expect(ex.main.stats.liquidations).toBe(1);
    expect(ex.state.closedPnl.at(-1)!.type).toBe('Liquidation');
  });

  it('кросс-ликвидация обнуляет кросс-капитал', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 100, 80, 85], ...flat(85, 2)] }, { initialBalance: 100 });
    ex.setLeverage(MAIN, 'BTCUSDT', 20);
    const o = ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 15 });
    expect(o.status).toBe('Filled');
    ex.step();
    expect(ex.main.positions.BTCUSDT).toBeUndefined();
    expect(ex.main.walletBalance).toBeGreaterThanOrEqual(0);
    expect(ex.main.walletBalance).toBeLessThan(5);
    expect(ex.main.stats.liquidations).toBe(1);
  });
});

describe('Funding', () => {
  it('лонг платит положительный funding каждые 8 часов', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 17) }, { fundingEnabled: true, defaultFundingRate: 0.001 });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 10 });
    const w0 = ex.main.walletBalance;
    for (let i = 0; i < 17; i++) ex.step(); // 00:00 .. 16:00 → 3 выплаты (00, 08, 16)
    close(ex.main.walletBalance, w0 - 3 * 10 * 100 * 0.001);
    close(ex.main.stats.funding, -3);
  });
});

describe('Спот', () => {
  it('покупка и продажа монеты', () => {
    const ex = mkExchange({ ETHUSDT: [[100, 100, 100, 120], ...flat(120, 2)] });
    const b = ex.placeOrder({ category: 'spot', symbol: 'ETHUSDT', side: 'Buy', orderType: 'Market', qty: 2 });
    expect(b.status).toBe('Filled');
    expect(ex.main.spot.ETH).toBe(2);
    ex.step();
    const s = ex.placeOrder({ category: 'spot', symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market', qty: 2 });
    expect(s.status).toBe('Filled');
    close(ex.main.walletBalance, 10_000 - 200 * 1.001 + 240 * 0.999);
    const bad = ex.placeOrder({ category: 'spot', symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market', qty: 1 });
    expect(bad.status).toBe('Rejected');
  });
});

describe('Сериализация', () => {
  it('состояние восстанавливается из JSON', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 101, 99, 100], ...flat(100, 5)] });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', price: 90, qty: 1 });
    ex.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 1 });
    ex.step();
    const json = ex.serialize();
    const ex2 = Exchange.restore(json, ex.market);
    expect(ex2.state.cursor).toBe(1);
    expect(Object.keys(ex2.state.orders).length).toBe(1);
    expect(ex2.main.positions.BTCUSDT.size).toBe(1);
    expect(ex2.equity(ex2.main)).toBeCloseTo(ex.equity(ex.main), 8);
  });
});

describe('Токенизированные акции (xStocks)', () => {
  it('торгуются только на споте: перпетуал и плечо недоступны', () => {
    const ex = mkExchange({ AAPLXUSDT: [[330, 331, 329, 330], ...flat(330, 3)] });
    const lin = ex.placeOrder({ category: 'linear', symbol: 'AAPLXUSDT', side: 'Buy', orderType: 'Market', qty: 1 });
    expect(lin.status).toBe('Rejected');
    expect(lin.rejectReason).toMatch(/только на споте/);
    expect(ex.setLeverage(MAIN, 'AAPLXUSDT', 5)).toMatch(/только на споте/);
    const b = ex.placeOrder({ category: 'spot', symbol: 'AAPLXUSDT', side: 'Buy', orderType: 'Market', qty: 1.5 });
    expect(b.status).toBe('Filled');
    expect(ex.main.spot.AAPLX).toBe(1.5);
    // дробное количество с шагом 0.001
    const s = ex.placeOrder({ category: 'spot', symbol: 'AAPLXUSDT', side: 'Sell', orderType: 'Market', qty: 0.255 });
    expect(s.status).toBe('Filled');
    close(ex.main.spot.AAPLX, 1.245);
    close(ex.equity(ex.main), 10_000 - 1.5 * 330 * 0.001 - 0.255 * 330 * 0.001, 1e-6);
  });

  it('фьючерсные боты отклоняют спотовые инструменты', async () => {
    const { BOT_LOGIC: botLogic } = await import('../src/engine/bots/registry');
    const ex = mkExchange({ TSLAXUSDT: flat(358, 5) });
    expect(botLogic.futuresGrid.validate(ex, { symbol: 'TSLAXUSDT', direction: 'long', lower: 300, upper: 400, grids: 10, mode: 'arithmetic', leverage: 2, closeOnStop: true }, 1000)).toMatch(/только на споте/);
    expect(botLogic.spotGrid.validate(ex, { symbol: 'TSLAXUSDT', lower: 300, upper: 400, grids: 10, mode: 'arithmetic', sellOnStop: true }, 1000)).toBeNull();
  });
});

describe('Ценовые алерты', () => {
  it('срабатывают по high/low бара и удаляются; runTo останавливается', () => {
    const ex = mkExchange({ BTCUSDT: [[100, 101, 99, 100], [100, 104, 99, 103], [103, 103, 95, 96], ...flat(96, 3)] });
    const hits: number[] = [];
    ex.on((e) => {
      if (e.type === 'alert') hits.push(e.alert.price);
    });
    const up = ex.addAlert('BTCUSDT', 103.5)!;
    const down = ex.addAlert('BTCUSDT', 97)!;
    expect(up.dir).toBe('up');
    expect(down.dir).toBe('down');
    ex.step(); // high 101 — ничего
    expect(hits).toEqual([]);
    const done = ex.runTo(10, Infinity, true); // бар 2: high 104 → алерт вверх, остановка
    expect(done).toBe(false);
    expect(hits).toEqual([103.5]);
    expect(ex.state.cursor).toBe(2);
    ex.step(); // low 95 → алерт вниз
    expect(hits).toEqual([103.5, 97]);
    expect(ex.alerts().length).toBe(0);
  });
});

describe('TradFi-перпетуалы', () => {
  it('фьючерс на акцию/золото торгуется с плечом, а xStock той же акции — только спот', () => {
    const ex = mkExchange({ AAPLUSDT: flat(330, 3), XAUUSDT: flat(4179, 3) });
    expect(ex.setLeverage(MAIN, 'AAPLUSDT', 20)).toBeNull();
    const o = ex.placeOrder({ category: 'linear', symbol: 'AAPLUSDT', side: 'Sell', orderType: 'Market', qty: 10 });
    expect(o.status).toBe('Filled');
    expect(ex.main.positions.AAPLUSDT.size).toBe(-10);
    expect(ex.setLeverage(MAIN, 'XAUUSDT', 100)).toBeNull();
    expect(ex.placeOrder({ category: 'linear', symbol: 'XAUUSDT', side: 'Buy', orderType: 'Market', qty: 0.5 }).status).toBe('Filled');
  });
});
