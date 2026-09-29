import { describe, expect, it } from 'vitest';
import { flat, mkExchange, wave } from './helpers';
import { gridLevels } from '../src/engine/bots/grid';
import { runBotBacktest } from '../src/engine/headless';
import { mkConfig, mkMarket } from './helpers';

describe('Грид-боты', () => {
  it('уровни арифметической и геометрической сетки', () => {
    expect(gridLevels(100, 200, 4, 'arithmetic', 0.01)).toEqual([100, 125, 150, 175, 200]);
    const g = gridLevels(100, 400, 2, 'geometric', 0.01);
    expect(g).toEqual([100, 200, 400]);
  });

  it('спотовый грид зарабатывает на колебаниях', () => {
    const ex = mkExchange({ BTCUSDT: wave(100, 8, 240) });
    const { bot, error } = ex.createBot('spotGrid', 'grid', 1000, {
      symbol: 'BTCUSDT',
      lower: 90,
      upper: 110,
      grids: 10,
      mode: 'arithmetic',
      sellOnStop: true,
    });
    expect(error).toBeUndefined();
    expect(bot!.status).toBe('running');
    const ordersBefore = ex.activeOrders(bot!.accountId).length;
    expect(ordersBefore).toBe(10);
    for (let i = 0; i < 239; i++) ex.step();
    const b = ex.state.bots[bot!.id];
    expect(b.stats.arbitrages).toBeGreaterThan(20);
    expect(b.stats.gridProfit).toBeGreaterThan(0);
    // число ордеров сетки сохраняется
    expect(ex.activeOrders(bot!.accountId).length).toBe(10);
    ex.stopBot(bot!.id);
    expect(ex.state.bots[bot!.id].status).toBe('stopped');
    expect(ex.state.bots[bot!.id].finalPnl!).toBeGreaterThan(0);
    // средства вернулись на основной аккаунт
    expect(ex.main.walletBalance).toBeGreaterThan(10_000);
  });

  it('фьючерсный нейтральный грид с плечом', () => {
    const ex = mkExchange({ ETHUSDT: wave(2000, 100, 200) });
    const { bot, error } = ex.createBot('futuresGrid', 'fgrid', 1000, {
      symbol: 'ETHUSDT',
      direction: 'neutral',
      lower: 1880,
      upper: 2120,
      grids: 12,
      mode: 'geometric',
      leverage: 5,
      closeOnStop: true,
    });
    expect(error).toBeUndefined();
    for (let i = 0; i < 199; i++) ex.step();
    const b = ex.state.bots[bot!.id];
    expect(b.stats.arbitrages).toBeGreaterThan(10);
    expect(ex.botSummary(b).gridProfit).toBeGreaterThan(0);
  });

  it('лонг-грид открывает начальную позицию', () => {
    const ex = mkExchange({ ETHUSDT: flat(2000, 5) });
    const { bot } = ex.createBot('futuresGrid', 'long', 1000, {
      symbol: 'ETHUSDT',
      direction: 'long',
      lower: 1800,
      upper: 2200,
      grids: 8,
      mode: 'arithmetic',
      leverage: 3,
      closeOnStop: true,
    });
    const pos = ex.botAccount(bot!).positions.ETHUSDT;
    expect(pos.size).toBeGreaterThan(0);
  });

  it('ошибка, если шаг сетки не покрывает комиссии', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 5) });
    const { error } = ex.createBot('spotGrid', 'bad', 1000, {
      symbol: 'BTCUSDT',
      lower: 99,
      upper: 101,
      grids: 100,
      mode: 'arithmetic',
      sellOnStop: true,
    });
    expect(error).toMatch(/комисси/);
  });
});

describe('Фьючерсный комбо-бот (ребалансировка)', () => {
  it('держит целевые веса и ребалансирует по времени', () => {
    const n = 100;
    const up: [number, number, number, number][] = [];
    const down: [number, number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = 100 * (1 + i * 0.004);
      const b = 50 * (1 - i * 0.003);
      up.push([a, a, a, a]);
      down.push([b, b, b, b]);
    }
    const ex = mkExchange({ BTCUSDT: up, ETHUSDT: down });
    const { bot, error } = ex.createBot('futuresCombo', 'combo', 2000, {
      legs: [
        { symbol: 'BTCUSDT', side: 'long', weight: 60 },
        { symbol: 'ETHUSDT', side: 'short', weight: 40 },
      ],
      leverage: 2,
      rebalanceMode: 'time',
      intervalHours: 12,
      thresholdPct: 5,
    });
    expect(error).toBeUndefined();
    const acc = ex.botAccount(bot!);
    expect(acc.positions.BTCUSDT.size).toBeGreaterThan(0);
    expect(acc.positions.ETHUSDT.size).toBeLessThan(0);
    for (let i = 0; i < n - 1; i++) ex.step();
    const b = ex.state.bots[bot!.id];
    expect(b.stats.rebalances).toBeGreaterThanOrEqual(7);
    // лонг растущего и шорт падающего — прибыль
    expect(ex.botSummary(b).pnl).toBeGreaterThan(0);
    // веса близки к целевым после ребалансировки
    const btcN = Math.abs(acc.positions.BTCUSDT.size) * ex.price('BTCUSDT');
    const ethN = Math.abs(acc.positions.ETHUSDT.size) * ex.price('ETHUSDT');
    expect(btcN / (btcN + ethN)).toBeGreaterThan(0.55);
    expect(btcN / (btcN + ethN)).toBeLessThan(0.66);
  });

  it('проверяет сумму весов', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 3), ETHUSDT: flat(50, 3) });
    const { error } = ex.createBot('futuresCombo', 'bad', 1000, {
      legs: [
        { symbol: 'BTCUSDT', side: 'long', weight: 60 },
        { symbol: 'ETHUSDT', side: 'short', weight: 30 },
      ],
      leverage: 2,
      rebalanceMode: 'none',
      intervalHours: 1,
      thresholdPct: 1,
    });
    expect(error).toMatch(/100%/);
  });
});

describe('DCA и мартингейл', () => {
  it('DCA покупает по расписанию', () => {
    const ex = mkExchange({ BTCUSDT: flat(100, 30) });
    const { bot } = ex.createBot('dca', 'dca', 500, { symbol: 'BTCUSDT', amount: 100, intervalHours: 6, maxOrders: 5 });
    for (let i = 0; i < 29; i++) ex.step();
    expect(ex.state.bots[bot!.id].stats.buys).toBe(5);
    expect(ex.botAccount(bot!).spot.BTC).toBeGreaterThan(4.9);
  });

  it('мартингейл усредняется и закрывает цикл по TP', () => {
    const bars: [number, number, number, number][] = [
      [100, 100, 97, 97],
      [97, 97, 95, 95],
      [95, 99, 95, 99],
      ...flat(99, 5),
    ];
    const ex = mkExchange({ BTCUSDT: bars });
    const { bot, error } = ex.createBot('martingale', 'mg', 1000, {
      symbol: 'BTCUSDT',
      side: 'long',
      leverage: 5,
      initialMargin: 50,
      stepPct: 2,
      multiplier: 2,
      maxAdds: 3,
      tpPct: 1.5,
      loop: false,
    });
    expect(error).toBeUndefined();
    ex.step();
    ex.step();
    const b = ex.state.bots[bot!.id];
    expect(b.rt.adds).toBe(2);
    ex.step();
    ex.step();
    expect(b.stats.cycles).toBe(1);
    expect(b.status).toBe('stopped');
    expect(b.finalPnl!).toBeGreaterThan(0);
  });
});

describe('Бэктест бота в отдельном экземпляре', () => {
  it('runBotBacktest считает отчёт', async () => {
    const m = mkMarket({ BTCUSDT: wave(100, 6, 300) });
    const cfg = mkConfig({ end: m.end });
    const res = await runBotBacktest(m, cfg, 'spotGrid', { symbol: 'BTCUSDT', lower: 92, upper: 108, grids: 8, mode: 'geometric', sellOnStop: true }, 1000);
    expect(res.ok).toBe(true);
    expect(res.report.totalReturn).toBeGreaterThan(0);
    expect(res.equity.length).toBeGreaterThan(10);
  });
});
