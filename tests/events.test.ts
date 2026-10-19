import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/data/intervals';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { computeRealizedVol, pendingEvents, reactionSpan, realizedVolAt, usOpenUtc } from '../src/data/volatility';
import { Exchange } from '../src/engine/exchange';
import { MarketData } from '../src/engine/market';
import { makeSettings, pickLegs, runOptionStrategy, sizeFor, unitEconomics } from '../src/engine/optionRunner';
import { optionSymbol, quoteOption } from '../src/engine/options';
import { DEFAULT_OPTION_MODEL } from '../src/engine/types';
import { mkConfig } from './helpers';

const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Свечи по будням в заданные часы (UTC) с ценой из f(t). */
function bars(from: number, days: number, hours: number[], f: (t: number) => number, dt = HOUR): Candle[] {
  const out: Candle[] = [];
  let prev = f(from);
  for (let d = 0; d < days; d++) {
    const day = from + d * DAY;
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const h of hours) {
      const t = day + h * HOUR;
      const c = f(t);
      out.push({ t, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: 1 });
      prev = c;
    }
  }
  void dt;
  return out;
}

/**
 * Акция: часовые свечи основной сессии 13:00–19:00 UTC, волатильность sigma (годовая, по рабочему времени),
 * отчёт после закрытия во вторую среду каждого месяца, скачок ±jump на первой свече следующего дня.
 */
function stockWithReports(months: number, sigma: number, jump: number, seed = 7) {
  const rnd = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const start = Date.UTC(2023, 0, 2);
  const reports: number[] = [];
  for (let m = 0; m < months; m++) {
    const first = Date.UTC(2023, m, 1);
    const wd = new Date(first).getUTCDay();
    const firstWed = first + ((3 - wd + 7) % 7) * DAY;
    reports.push(firstWed + 7 * DAY + 20 * HOUR);
  }
  const hours = [13, 14, 15, 16, 17, 18, 19];
  const sBar = sigma / Math.sqrt((365 / 7) * 5 * hours.length);
  const candles: Candle[] = [];
  let p = 100;
  let k = 0;
  const days = Math.round(months * 30.6);
  for (let d = 0; d < days; d++) {
    const day = start + d * DAY;
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const h of hours) {
      const t = day + h * HOUR;
      const o = p;
      let r = sBar * gauss();
      // первая свеча после отчёта — скачок
      if (k < reports.length && t > reports[k]) {
        r += (rnd() < 0.5 ? -1 : 1) * jump;
        k++;
      }
      p = p * Math.exp(r);
      candles.push({ t, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 });
    }
  }
  return { start, candles, reports };
}

describe('Отчёты компаний: окна реакции', () => {
  it('открытие сессии в США — с учётом летнего времени', () => {
    expect(iso(usOpenUtc(Date.UTC(2024, 6, 10)))).toBe('2024-07-10T13:30');
    expect(iso(usOpenUtc(Date.UTC(2024, 0, 10)))).toBe('2024-01-10T14:30');
    expect(iso(usOpenUtc(Date.UTC(2024, 2, 8)))).toBe('2024-03-08T14:30'); // до 2-го воскресенья марта
    expect(iso(usOpenUtc(Date.UTC(2024, 2, 11)))).toBe('2024-03-11T13:30');
    expect(iso(usOpenUtc(Date.UTC(2024, 10, 1)))).toBe('2024-11-01T13:30');
    expect(iso(usOpenUtc(Date.UTC(2024, 10, 4)))).toBe('2024-11-04T14:30'); // после 1-го воскресенья ноября
  });

  const wed = Date.UTC(2024, 6, 10); // среда, лето
  const flat = () => 100;
  const span = (c: Candle[], interval: '1h' | '1d', report: number) => {
    const s = seriesFromCandles('NVDAUSDT', interval, c);
    const sp = reactionSpan(s, report);
    return sp && [iso(s.t[sp[0]]), iso(s.t[sp[1]])];
  };

  it('дневные свечи: отчёт после закрытия — свеча следующего дня, до открытия — того же', () => {
    const c = bars(wed - 7 * DAY, 20, [0], flat);
    expect(span(c, '1d', wed + 20 * HOUR)).toEqual(['2024-07-11T00:00', '2024-07-11T00:00']);
    expect(span(c, '1d', wed + 13.5 * HOUR)).toEqual(['2024-07-10T00:00', '2024-07-10T00:00']);
    // пятница после закрытия → понедельник
    expect(span(c, '1d', wed + 2 * DAY + 20 * HOUR)).toEqual(['2024-07-15T00:00', '2024-07-15T00:00']);
  });

  it('часовые свечи: только сессия — первая свеча следующего дня; с пре/постмаркетом — весь вечер, ночь и открытие', () => {
    const regular = bars(wed - 7 * DAY, 20, [13, 14, 15, 16, 17, 18, 19], flat);
    expect(span(regular, '1h', wed + 20 * HOUR)).toEqual(['2024-07-11T13:00', '2024-07-11T13:00']);
    const ext = bars(wed - 7 * DAY, 20, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], flat);
    expect(span(ext, '1h', wed + 20 * HOUR)).toEqual(['2024-07-10T20:00', '2024-07-11T13:00']);
    // до открытия: премаркет того же дня и свеча открытия
    expect(span(ext, '1h', wed + 13.5 * HOUR)).toEqual(['2024-07-10T08:00', '2024-07-10T13:00']);
    // зимой сессия открывается в 14:30 — свеча открытия 14:00
    const jan = Date.UTC(2024, 0, 10);
    const extW = bars(jan - 7 * DAY, 20, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], flat);
    expect(span(extW, '1h', jan + 20 * HOUR)).toEqual(['2024-01-10T20:00', '2024-01-11T14:00']);
  });
});

describe('Отчёты компаний: волатильность и цена опционов', () => {
  const sigma = 0.3;
  const jump = 0.07;
  const { start, candles, reports } = stockWithReports(24, sigma, jump);
  const series = seriesFromCandles('NVDAUSDT', '1h', candles);

  it('скачок на отчёте не раздувает реализованную волатильность после него', () => {
    const m0 = new MarketData('1h', start + 40 * DAY, start + 700 * DAY);
    m0.addSeries('NVDAUSDT', series, 'synthetic');
    const m1 = new MarketData('1h', start + 40 * DAY, start + 700 * DAY);
    m1.addSeries('NVDAUSDT', series, 'synthetic', reports);
    const after = reports.slice(3, 20).map((r) => r + DAY); // следующий день после реакции
    const avg = (m: MarketData) => after.reduce((a, t) => a + realizedVolAt(m.rv.get('NVDAUSDT'), t)!.rv7, 0) / after.length;
    expect(avg(m0)).toBeGreaterThan(0.5); // без дат отчётов скачок попадает в RV — IV растёт после отчёта
    expect(Math.abs(avg(m1) - sigma)).toBeLessThan(0.06);
    // размер скачка: (7%)² в дневных дисперсиях при 30% годовых ≈ 14
    const ev = m1.events.get('NVDAUSDT')!;
    expect(ev.length).toBe(reports.length);
    const ratios = Array.from(ev.ratio).filter(Number.isFinite);
    const mean = ratios.reduce((a, x) => a + x, 0) / ratios.length;
    expect(mean).toBeGreaterThan(10);
    expect(mean).toBeLessThan(19);
    // профиль без скачков, RV без дат — для сравнения
    expect(computeRealizedVol(series, 'business').length).toBeGreaterThan(0);
  });

  it('оценка скачка — только по уже прошедшим отчётам', () => {
    const m = new MarketData('1h', start + 40 * DAY, start + 700 * DAY);
    m.addSeries('NVDAUSDT', series, 'synthetic', reports);
    const ev = m.events.get('NVDAUSDT')!;
    // до первого отчёта — априорная оценка
    expect(pendingEvents(ev, ev.t[0] - DAY)![0].ratio).toBe(6);
    // перед 10-м — среднее последних 8 прошедших со сглаживанием к априорной
    const k = 9;
    const past = Array.from(ev.ratio.slice(1, k));
    const expected = (past.reduce((a, x) => a + x, 0) + 6 * 2) / (past.length + 2);
    expect(pendingEvents(ev, ev.t[k] - DAY)![0].ratio).toBeCloseTo(expected, 6);
    // будущий скачок на оценку не влияет: подменим его и сравним
    const ev2 = { ...ev, ratio: Float64Array.from(ev.ratio, (x, i) => (i >= k ? 999 : x)) };
    expect(pendingEvents(ev2, ev.t[k] - DAY)![0].ratio).toBeCloseTo(expected, 6);
  });

  it('стрэддл через отчёт стоит примерно столько, сколько в среднем платит', () => {
    const run = (withReports: boolean) => {
      const m = new MarketData('1h', start + 40 * DAY, start + 720 * DAY);
      m.addSeries('NVDAUSDT', series, 'synthetic', withReports ? reports : undefined);
      const cfg = mkConfig({ start: m.start, end: m.end, symbols: ['NVDAUSDT'], options: { ...DEFAULT_OPTION_MODEL, ivPremium: 1, spreadPct: 0, skew: 0, smile: 0 } });
      const ex = Exchange.create(cfg, m);
      let pay = 0;
      let prem = 0;
      for (const r of reports.slice(4)) {
        const mon = Math.floor(r / DAY) * DAY - 2 * DAY; // понедельник недели отчёта
        const t = mon + 15 * HOUR;
        const fri = mon + 4 * DAY + 8 * HOUR;
        if (t < m.start || fri > m.end) continue;
        const S = m.closeAt('NVDAUSDT', t)!;
        const K = Math.round(S * 10) / 10;
        const vol = ex.volInputs('NVDAUSDT', t);
        const c = quoteOption(cfg.options, ex.optionInstrument(optionSymbol('NVDA', fri, K, 'C'))!, S, t, vol);
        const p = quoteOption(cfg.options, ex.optionInstrument(optionSymbol('NVDA', fri, K, 'P'))!, S, t, vol);
        const ST = m.closeAt('NVDAUSDT', ex.settleTime(fri))!;
        prem += c.mark + p.mark;
        pay += Math.abs(ST - K);
      }
      return pay / prem;
    };
    const fair = run(true);
    // скачок фиксированного размера ±7% чуть «толще» нормального — небольшой перекос в пользу покупателя допустим
    expect(fair).toBeGreaterThan(0.85);
    expect(fair).toBeLessThan(1.35);
    // без дат отчётов опционы через отчёт дешевле в разы
    expect(run(false)).toBeGreaterThan(1.8);
  });

  it('стратегия считает конструкции, заставшие отчёт', async () => {
    const m = new MarketData('1h', start + 40 * DAY, start + 400 * DAY);
    m.addSeries('NVDAUSDT', series, 'synthetic', reports);
    const cfg = mkConfig({ start: m.start, end: m.end, symbols: ['NVDAUSDT'], initialBalance: 100_000 });
    const s = makeSettings('NVDAUSDT', 100_000, { structure: 'long_straddle', schedule: 'weekly', weekday: 1, entryHour: 15, dte: 7, sizeMode: 'qty', qty: 10 });
    const r = await runOptionStrategy(m, cfg, s, { sliceMs: 1e9 });
    expect(r.trades.length).toBeGreaterThan(40);
    // в каждом месяце один отчёт, его застаёт конструкция, открытая в понедельник той же недели
    expect(r.stats.reports.trades).toBeGreaterThanOrEqual(10);
    expect(r.stats.reports.trades).toBeLessThan(r.trades.length / 3);
  });
});

describe('Потолок на конструкцию', () => {
  it('объём урезается до потолка средств, и это видно в статистике', async () => {
    const { start, candles, reports } = stockWithReports(6, 0.3, 0.05);
    const m = new MarketData('1h', start + 40 * DAY, start + 170 * DAY);
    m.addSeries('NVDAUSDT', seriesFromCandles('NVDAUSDT', '1h', candles), 'synthetic', reports);
    const cfg = mkConfig({ start: m.start, end: m.end, symbols: ['NVDAUSDT'], initialBalance: 1_000_000 });
    const ex = Exchange.create(cfg, m);
    const s = makeSettings('NVDAUSDT', 1_000_000, { structure: 'long_call', delta: 0.35, sizeMode: 'margin', marginPct: 50, useCap: true, capUsd: 5_000 });
    const pick = pickLegs(ex, s, 1);
    const eco = unitEconomics(ex, pick.legs, pick.S);
    const sz = sizeFor(ex, s, eco, pick.S);
    expect(sz.capped).toBe(true);
    expect(sz.qty * eco.margin).toBeLessThanOrEqual(5_000);
    expect(sz.qty * eco.margin).toBeGreaterThan(4_000);
    const free = sizeFor(ex, { ...s, useCap: false }, eco, pick.S);
    expect(free.qty * eco.margin).toBeGreaterThan(400_000);
    const r = await runOptionStrategy(m, cfg, { ...s, schedule: 'weekly', weekday: 2 }, { sliceMs: 1e9 });
    expect(r.stats.capped).toBe(r.trades.length);
    expect(Math.max(...r.trades.map((g) => Math.abs(g.premium)))).toBeLessThanOrEqual(5_000);
  });
});
