import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/data/intervals';
import { MAIN } from '../src/engine/exchange';
import {
  OS_BY_KEY,
  makeSettings,
  pickExpiry,
  pickLegs,
  previewEntry,
  runOptionStrategy,
  sizeFor,
  unitEconomics,
  unlimitedRisk,
  validateSettings,
} from '../src/engine/optionRunner';
import { T0, mkConfig, mkExchange, mkMarket } from './helpers';

type Bar = [number, number, number, number];

/** Колебания цены: реализованная волатильность ~ 30–40% годовых. */
function choppy(center: number, n: number, amp = 0.02, period = 4, drift = 0): Bar[] {
  const out: Bar[] = [];
  let prev = center;
  for (let i = 0; i < n; i++) {
    const c = center * (1 + amp * Math.sin((i + 1) / period)) * (1 + drift) ** i;
    out.push([prev, Math.max(prev, c) * 1.002, Math.min(prev, c) * 0.998, c]);
    prev = c;
  }
  return out;
}

const warm = () => choppy(100000, 24 * 40, 0.03, 4);

describe('Опционная стратегия: подбор ног', () => {
  it('экспирация — ближайшая к желаемому сроку', () => {
    const now = Date.UTC(2025, 0, 6, 9);
    const exps = [Date.UTC(2025, 0, 7, 8), Date.UTC(2025, 0, 10, 8), Date.UTC(2025, 0, 17, 8), Date.UTC(2025, 0, 31, 8)];
    expect(pickExpiry(exps, now, 1)).toBe(exps[0]);
    expect(pickExpiry(exps, now, 7)).toBe(exps[1]); // 3.96 дня ближе к 7, чем 10.96
    expect(pickExpiry(exps, now, 10)).toBe(exps[2]);
    expect(pickExpiry(exps, now, 30)).toBe(exps[3]);
    // слишком близкая экспирация (меньше 2 часов) пропускается
    expect(pickExpiry([now + HOUR, now + 2 * DAY], now, 0.01)).toBe(now + 2 * DAY);
  });

  it('кондор: проданные ноги по дельте, крылья дальше от цены, кредит', () => {
    const ex = mkExchange({ BTCUSDT: choppy(100000, 48) }, { initialBalance: 100_000 }, warm());
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'iron_condor', delta: 0.15, wingPct: 4, dte: 7 });
    const p = pickLegs(ex, s, 1);
    expect(p.error).toBeUndefined();
    expect(p.legs.map((l) => `${l.side}${l.type}`)).toEqual(['BuyP', 'SellP', 'SellC', 'BuyC']);
    const [bp, sp, sc, bc] = p.legs;
    expect(bp.strike).toBeLessThan(sp.strike);
    expect(sp.strike).toBeLessThanOrEqual(p.S);
    expect(sc.strike).toBeGreaterThanOrEqual(p.S);
    expect(bc.strike).toBeGreaterThan(sc.strike);
    // |дельта| проданного пута — ближайшая к 0.15 среди OTM-путов цепочки
    const chain = ex.optionChain('BTC', p.expiry);
    const best = Math.min(...chain.rows.filter((r) => r.strike <= p.S).map((r) => Math.abs(Math.abs(r.put.greeks.delta) - 0.15)));
    expect(Math.abs(Math.abs(sp.delta) - 0.15)).toBeCloseTo(best, 9);
    const eco = unitEconomics(ex, p.legs, p.S);
    expect(eco.premium).toBeGreaterThan(0);
    const width = Math.max(sp.strike - bp.strike, bc.strike - sc.strike);
    expect(eco.maxLoss).toBeGreaterThan(width - eco.premium - 1e-6);
    expect(eco.maxLoss).toBeLessThan(width - eco.premium + eco.fee + 1e-6);
    expect(eco.maxProfit).toBeCloseTo(eco.premium - eco.fee, 6);
    expect(eco.breakevens.length).toBe(2);
    expect(eco.breakevens[0]).toBeLessThan(sp.strike);
    expect(eco.breakevens[1]).toBeGreaterThan(sc.strike);
  });

  it('размер по риску: макс. убыток ≤ заданного % капитала', () => {
    const ex = mkExchange({ BTCUSDT: choppy(100000, 48) }, { initialBalance: 100_000 }, warm());
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'put_credit', delta: 0.25, wingPct: 3, dte: 7, sizeMode: 'risk', riskPct: 5 });
    const p = pickLegs(ex, s, 1);
    const eco = unitEconomics(ex, p.legs, p.S);
    const size = sizeFor(ex, s, eco, p.S);
    expect(size.error).toBeUndefined();
    expect(size.qty * eco.maxLoss).toBeLessThanOrEqual(5000 + 1e-6);
    expect((size.qty + size.step) * eco.maxLoss).toBeGreaterThan(5000);
  });

  it('неограниченный риск: размер «по риску» запрещён', () => {
    expect(unlimitedRisk(OS_BY_KEY.short_strangle)).toBe(true);
    expect(unlimitedRisk(OS_BY_KEY.short_call)).toBe(true);
    expect(unlimitedRisk(OS_BY_KEY.covered_call)).toBe(false);
    expect(unlimitedRisk(OS_BY_KEY.iron_condor)).toBe(false);
    expect(validateSettings(makeSettings('BTCUSDT', 1000, { structure: 'short_strangle', sizeMode: 'risk' }))).toMatch(/не ограничен/);
    expect(validateSettings(makeSettings('BTCUSDT', 1000, { structure: 'short_strangle', sizeMode: 'notional' }))).toBeNull();
    expect(validateSettings(makeSettings('BTCUSDT', 1000, { structure: 'covered_call', hedge: true }))).toMatch(/хедж/i);
  });

  it('предпросмотр не меняет состояние биржи', () => {
    const ex = mkExchange({ BTCUSDT: choppy(100000, 48) }, { initialBalance: 100_000 }, warm());
    const before = ex.main.walletBalance;
    const pv = previewEntry(ex, makeSettings('BTCUSDT', 100_000, { structure: 'iron_condor' }));
    expect(pv.error).toBeUndefined();
    expect(pv.legs!.length).toBe(4);
    expect(ex.main.walletBalance).toBe(before);
    expect(Object.keys(ex.main.positions).length).toBe(0);
  });
});

describe('Опционная стратегия: прогон', () => {
  const days = 12;
  const market = () => mkMarket({ BTCUSDT: choppy(100000, 24 * days, 0.01, 6) }, warm());
  const cfg = () => mkConfig({ end: T0 + 24 * days * HOUR, initialBalance: 100_000 });

  it('ежедневный кондор до экспирации: сделка в день, учёт сходится с капиталом биржи', async () => {
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'iron_condor', delta: 0.1, wingPct: 3, dte: 1, schedule: 'daily', entryHour: 8, maxOpen: 1, tpPct: 0, slPct: 0, sizeMode: 'risk', riskPct: 2 });
    const r = await runOptionStrategy(market(), cfg(), s);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.trades.length).toBeGreaterThanOrEqual(days - 2);
    expect(r.trades.length).toBeLessThanOrEqual(days);
    for (const g of r.trades.slice(0, -1)) {
      expect(g.reason).toBe('expiry');
      expect(g.legs.length).toBe(4);
      expect(g.premium).toBeGreaterThan(0);
      // одна конструкция за раз: следующая открывается после закрытия предыдущей
    }
    for (let i = 1; i < r.trades.length; i++) expect(r.trades[i].openTime).toBeGreaterThanOrEqual(r.trades[i - 1].closeTime!);
    // итог по сделкам = изменение капитала (без хеджа и funding)
    const sum = r.trades.reduce((a, g) => a + g.pnl, 0);
    expect(r.report.endEquity - r.report.startEquity).toBeCloseTo(sum, 4);
    expect(r.stats.trades).toBe(r.trades.length);
    expect(r.report.trades).toBe(r.trades.length);
  });

  it('тейк-профит на 50% премии срабатывает раньше экспирации', async () => {
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'short_strangle', delta: 0.15, dte: 7, schedule: 'daily', entryHour: 8, maxOpen: 1, tpPct: 50, slPct: 0, sizeMode: 'notional', notionalPct: 20 });
    const r = await runOptionStrategy(market(), cfg(), s);
    expect(r.ok).toBe(true);
    const tp = r.trades.filter((g) => g.reason === 'tp');
    expect(tp.length).toBeGreaterThan(0);
    for (const g of tp) {
      expect(g.closeTime!).toBeLessThan(g.expiry);
      expect(g.pnl).toBeGreaterThan(0);
    }
    const sum = r.trades.reduce((a, g) => a + g.pnl, 0);
    expect(r.report.endEquity - r.report.startEquity).toBeCloseTo(sum, 4);
  });

  it('пробой проданного страйка закрывает позицию при сильном росте', async () => {
    const up = mkMarket({ BTCUSDT: choppy(100000, 24 * days, 0.003, 6, 0.0015) }, warm());
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'call_credit', delta: 0.3, wingPct: 5, dte: 7, schedule: 'daily', entryHour: 8, maxOpen: 1, tpPct: 0, slPct: 0, breachExit: true, sizeMode: 'risk', riskPct: 2 });
    const r = await runOptionStrategy(up, cfg(), s);
    expect(r.ok).toBe(true);
    const br = r.trades.filter((g) => g.reason === 'breach');
    expect(br.length).toBeGreaterThan(0);
    for (const g of br) {
      const sc = g.legs.find((l) => l.side === 'Sell')!;
      expect(g.S1!).toBeGreaterThan(sc.strike);
    }
  });

  it('фильтр IV блокирует входы', async () => {
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'iron_condor', dte: 1, schedule: 'daily', ivMin: 500 });
    const r = await runOptionStrategy(market(), cfg(), s);
    expect(r.ok).toBe(true);
    expect(r.trades.length).toBe(0);
    expect(r.stats.skips.iv).toBeGreaterThan(5);
  });

  it('дельта-хедж: перпетуал держит дельту в допуске и закрывается вместе с опционами', async () => {
    const trend = mkMarket({ BTCUSDT: choppy(100000, 24 * days, 0.004, 6, 0.0008) }, warm());
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'long_straddle', dte: 30, closeDte: 25, schedule: 'weekly', weekday: 1, entryHour: 8, maxOpen: 1, tpPct: 0, slPct: 0, sizeMode: 'qty', qty: 1, hedge: true, hedgeBand: 0.05, hedgeHours: 1 });
    const r = await runOptionStrategy(trend, cfg(), s);
    expect(r.ok).toBe(true);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.stats.hedge.trades).toBeGreaterThan(1);
    // цена растёт → дельта стрэддла положительна → хедж продаёт перпетуал
    expect(r.hedgeFills[0].side).toBe('Sell');
    // итог = сделки + хедж (funding выключен)
    const sum = r.trades.reduce((a, g) => a + g.pnl, 0) + r.stats.hedge.pnl;
    expect(r.report.endEquity - r.report.startEquity).toBeCloseTo(sum, 3);
  });

  it('покрытый колл: перпетуал закрывается после экспирации колла', async () => {
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'covered_call', delta: 0.3, dte: 1, schedule: 'daily', entryHour: 8, maxOpen: 1, tpPct: 0, slPct: 0, sizeMode: 'qty', qty: 0.5 });
    const r = await runOptionStrategy(market(), cfg(), s);
    expect(r.ok).toBe(true);
    expect(r.trades.length).toBeGreaterThan(3);
    for (const g of r.trades) {
      expect(g.legs.every((l) => !l.open)).toBe(true);
      expect(g.legs.find((l) => l.type === 'F')!.exit).toBeGreaterThan(0);
    }
    const sum = r.trades.reduce((a, g) => a + g.pnl, 0);
    expect(r.report.endEquity - r.report.startEquity).toBeCloseTo(sum, 3);
  });

  it('несколько конструкций одновременно (лимит maxOpen)', async () => {
    const s = makeSettings('BTCUSDT', 100_000, { structure: 'put_credit', delta: 0.2, wingPct: 3, dte: 7, schedule: 'daily', entryHour: 8, maxOpen: 3, tpPct: 0, slPct: 0, sizeMode: 'risk', riskPct: 2 });
    const r = await runOptionStrategy(market(), cfg(), s);
    expect(r.ok).toBe(true);
    // в любой момент открыто не больше 3
    const events = r.trades.flatMap((g) => [
      { t: g.openTime, d: 1 },
      { t: g.closeTime!, d: -1 },
    ]);
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    let cur = 0;
    let peak = 0;
    for (const e of events) {
      cur += e.d;
      peak = Math.max(peak, cur);
    }
    expect(peak).toBe(3);
    expect(Object.values(r.trades).length).toBeGreaterThan(3);
    const sum = r.trades.reduce((a, g) => a + g.pnl, 0);
    expect(r.report.endEquity - r.report.startEquity).toBeCloseTo(sum, 3);
  });

  it('прогон не трогает биржу сессии', async () => {
    const m = market();
    const ex = mkExchange({ BTCUSDT: choppy(100000, 10) });
    const r = await runOptionStrategy(m, cfg(), makeSettings('BTCUSDT', 100_000, { dte: 1, schedule: 'daily' }));
    expect(r.ok).toBe(true);
    expect(Object.keys(ex.main.positions).length).toBe(0);
    expect(ex.account(MAIN).walletBalance).toBe(10_000);
  });
});
