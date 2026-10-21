import { describe, expect, it } from 'vitest';
import { DAY, HOUR, businessMs } from '../src/data/intervals';
import { isResultsFiling } from '../src/data/news';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { detectHolidays } from '../src/data/volatility';
import { Exchange } from '../src/engine/exchange';
import { MarketData } from '../src/engine/market';
import { makeSettings, pickLegs, runOptionStrategy } from '../src/engine/optionRunner';
import { atmIv, listExpiries, optionSymbol } from '../src/engine/options';
import { DEFAULT_OPTION_MODEL } from '../src/engine/types';
import { mkConfig } from './helpers';

const wd = (t: number) => new Date(t).getUTCDay();

/**
 * Дневные свечи акции (только будни, кроме праздников): цена открытия каждого понедельника (и дня после праздника)
 * отличается от пятничного закрытия на gap, а к закрытию возвращается. Закрытия почти не меняются.
 */
function gappyDaily(from: number, days: number, gap: number, holidays: number[] = []): Candle[] {
  const out: Candle[] = [];
  const px = 100;
  let sign = 1;
  for (let d = 0; d < days; d++) {
    const t = from + d * DAY;
    if (wd(t) === 0 || wd(t) === 6 || holidays.includes(t)) continue;
    const after = out.length && t - out[out.length - 1].t > DAY;
    const o = after ? px * (1 + sign * gap) : px;
    if (after) sign = -sign;
    // небольшое движение закрытий, чтобы волатильность не была нулевой
    const c = px * (1 + 0.01 * Math.sin(d));
    out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
  }
  return out;
}

describe('Опционы на акции: дневные свечи', () => {
  const start = Date.UTC(2025, 0, 6); // понедельник

  it('экспирация рассчитывается по цене на момент расчёта (последнее закрытие), а не по открытию с гэпом выходных', () => {
    const m = new MarketData('1d', start + 60 * DAY, start + 90 * DAY);
    m.addSeries('NVDAUSDT', seriesFromCandles('NVDAUSDT', '1d', gappyDaily(start, 120, 0.2)), 'synthetic');
    const cfg = mkConfig({ start: m.start, end: m.end, baseInterval: '1d', symbols: ['NVDAUSDT'], initialBalance: 100_000 });
    const ex = Exchange.create(cfg, m);
    // дойти до закрытия пятницы
    while (wd(ex.now) !== 6) ex.step();
    const S = ex.price('NVDAUSDT');
    const mon = ex.now + 2 * DAY + 8 * HOUR;
    const sym = optionSymbol('NVDA', mon, Math.round(S * 1.1), 'C');
    // понедельник откроется на +20% (гэп), а цена на момент расчёта (пн 00:00) — пятничное закрытие
    expect(m.series.get('NVDAUSDT')!.o[m.indexAt('NVDAUSDT', ex.now + 2 * DAY)]).toBeGreaterThan(S * 1.15);
    // до расчёта в понедельник 00:00 торгового времени нет: опцион стоит лишь внутреннюю стоимость
    expect(ex.optionT('NVDAUSDT', mon)).toBe(0);
    ex.placeOrder({ category: 'option', symbol: sym, side: 'Buy', orderType: 'Market', qty: 1 });
    for (let i = 0; i < 3; i++) ex.step();
    const rec = ex.state.closedPnl.find((c) => c.symbol === sym && c.type === 'Delivery')!;
    // расчёт — по пятничному закрытию: колл +10% ничего не платит
    expect(rec.exitPrice).toBe(0);
  });

  it('у акций «однодневные» экспирации — по рабочим дням', () => {
    const thuEvening = Date.UTC(2025, 0, 10); // пт 00:00 — после закрытия четверга
    const e = listExpiries(thuEvening, 'NVDA', true).slice(0, 3).map((x) => wd(x));
    expect(e).toEqual([5, 1, 2]); // пт, пн, вт — без субботы и воскресенья
  });

  it('стратегия не берёт экспирацию без торгового времени и не зарабатывает на гэпах', async () => {
    const m = new MarketData('1d', start + 60 * DAY, start + 400 * DAY);
    m.addSeries('NVDAUSDT', seriesFromCandles('NVDAUSDT', '1d', gappyDaily(start, 420, 0.15)), 'synthetic');
    const cfg = mkConfig({ start: m.start, end: m.end, baseInterval: '1d', symbols: ['NVDAUSDT'], initialBalance: 100_000 });
    const s = makeSettings('NVDAUSDT', 100_000, { structure: 'long_strangle', delta: 0.15, dte: 1, schedule: 'weekly', weekday: 5 });
    const ex = Exchange.create(cfg, m);
    while (wd(ex.now) !== 6) ex.step();
    const p = pickLegs(ex, s, 1);
    expect(p.error).toBeUndefined();
    expect(wd(p.expiry)).toBe(2); // вторник: торговое время — понедельник
    const r = await runOptionStrategy(m, cfg, s, { sliceMs: 1e9, noLog: true });
    // раньше: опционы за тик, выплата с гэпа понедельника → капитал ×10^n
    expect(r.report.endEquity).toBeLessThan(cfg.initialBalance * 3);
  });
});

describe('Праздники биржи', () => {
  const start = Date.UTC(2025, 0, 6);
  const holiday = Date.UTC(2025, 0, 20); // понедельник

  it('будни без свечей — праздники; время опциона в праздник не идёт', () => {
    const s = seriesFromCandles('NVDAUSDT', '1d', gappyDaily(start, 40, 0, [holiday]));
    const h = detectHolidays(s)!;
    expect(Array.from(h)).toEqual([holiday]);
    const fri = Date.UTC(2025, 0, 18); // сб 00:00 — после закрытия пятницы
    expect(businessMs(fri, holiday + DAY + DAY) / DAY).toBe(2); // пн и вт
    expect(businessMs(fri, holiday + DAY + DAY, null, h) / DAY).toBe(1); // только вт
  });

  it('опцион через праздник стоит как за торговые дни', () => {
    const m = new MarketData('1d', start + 7 * DAY, start + 35 * DAY);
    m.addSeries('NVDAUSDT', seriesFromCandles('NVDAUSDT', '1d', gappyDaily(start, 40, 0, [holiday])), 'synthetic');
    const ex = Exchange.create(mkConfig({ start: m.start, end: m.end, baseInterval: '1d', symbols: ['NVDAUSDT'] }), m);
    while (ex.now < Date.UTC(2025, 0, 18)) ex.step();
    // вторник 08:00 — расчёт во вторник 00:00 (закрытие понедельника, а понедельник — праздник): торгового времени нет
    expect(ex.optionT('NVDAUSDT', holiday + DAY + 8 * HOUR)).toBe(0);
    expect(ex.optionT('NVDAUSDT', holiday + 2 * DAY + 8 * HOUR) * (365 / 7) * 5).toBeCloseTo(1, 6);
  });
});

describe('IV по реализованной волатильности', () => {
  const cfg = { ...DEFAULT_OPTION_MODEL, ivSource: 'realized' as const, ivPremium: 1 };
  it('короткие сроки — по текущему уровню, длинные — к долгосрочному; тихая неделя не роняет IV в разы', () => {
    const inp = { fast: 0.2, slow: 0.5, rv7: 0.08, rv30: 0.3 };
    const day = 1 / 252;
    expect(atmIv(cfg, inp, day)).toBeGreaterThan(0.2);
    expect(atmIv(cfg, inp, day)).toBeLessThan(0.25);
    expect(atmIv(cfg, inp, 1)).toBeGreaterThan(0.45);
    // монотонный переход
    const a = atmIv(cfg, inp, 7 * day);
    const b = atmIv(cfg, inp, 30 * day);
    expect(b).toBeGreaterThan(a);
    // 7-дневная RV (8%) на цену не влияет
    expect(atmIv(cfg, { ...inp, rv7: 0.8 }, day)).toBeCloseTo(atmIv(cfg, inp, day), 10);
  });
});

describe('Даты отчётов в SEC', () => {
  it('8-K п. 2.02 и 6-K с квартальными результатами — отчёты; итоги голосования — нет', () => {
    expect(isResultsFiling('8-K', '2.02,9.01', 'nvda-8k.htm')).toBe(true);
    expect(isResultsFiling('8-K', '5.07', 'x.htm')).toBe(false);
    expect(isResultsFiling('6-K', '', 'q42015pressrelease.htm')).toBe(true);
    expect(isResultsFiling('6-K', '', 'q320166kwrapper.htm')).toBe(true);
    expect(isResultsFiling('6-K', '', 'shopify-q3fy15xpressreleas.htm')).toBe(true);
    expect(isResultsFiling('6-K', '', 'a6kwrapper2016votingresults.htm')).toBe(false);
    expect(isResultsFiling('6-K', '', 'form6k-boltmadeacquisition.htm')).toBe(false);
  });
});

describe('Предупреждение о неправдоподобной доходности', () => {
  it('больше 100% годовых на длинной истории или ×100 — предупреждение', async () => {
    const { implausibleWarnings } = await import('../src/engine/optionRunner');
    const m = new MarketData('1d', Date.UTC(2016, 0, 1), Date.UTC(2026, 0, 1));
    expect(implausibleWarnings({ cagr: 0.7, totalReturn: 200 } as any, m).length).toBe(1);
    expect(implausibleWarnings({ cagr: 1.4, totalReturn: 50 } as any, m).length).toBe(1);
    expect(implausibleWarnings({ cagr: 0.4, totalReturn: 28 } as any, m)).toEqual([]);
  });
});
