import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adjustForDividends, exDividendIndex, isSettlementDay, parseDohod, parseSmartLab, ruDate, ruNum, type DivAdjustStats } from '../src/portfolio/dividends';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

type B = { t: number; o: number; h: number; l: number; c: number; v: number };
/** Торговые дни (00:00 UTC): [год, месяц, день, open, close]. */
function bars(list: [number, number, number, number, number][]): B[] {
  return list.map(([y, m, d, o, c]) => ({ t: D(y, m, d), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 }));
}

describe('Дивиденды Мосбиржи: разбор источников', () => {
  it('числа и даты в русском формате', () => {
    expect(ruDate('20.07.2026 (прогноз)')).toBe(D(2026, 7, 20));
    expect(ruNum('37,64₽')).toBe(37.64);
    expect(ruNum('1 234,5')).toBe(1234.5);
    expect(ruNum('n/a')).toBeNaN();
  });

  it('dohod.ru: дата реестра и сумма, без прогнозов, по возрастанию', () => {
    const d = parseDohod(fx('dohod-sber.html'))!;
    expect(d).not.toBeNull();
    expect(d.length).toBeGreaterThan(20);
    expect(d.every((x, i) => i === 0 || x.t > d[i - 1].t)).toBe(true);
    expect(d.find((x) => x.t === D(2026, 7, 20))?.value).toBe(37.64);
    expect(d.find((x) => x.t === D(2025, 7, 18))?.value).toBe(34.84);
    expect(d.find((x) => x.t === D(2000, 6, 12))?.value).toBe(0.0328);
    // прогноз на 2027 не попадает
    expect(d.some((x) => x.t >= D(2027, 1, 1))).toBe(false);
    expect(parseDohod('<html><body>Page not found</body></html>')).toBeNull();
  });

  it('smart-lab: только строки своего тикера, доля дивиденда от цены', () => {
    const d = parseSmartLab(fx('smartlab-sber.html'), 'SBER')!;
    expect(d.length).toBeGreaterThan(5);
    const x = d.find((r) => r.t === D(2026, 7, 20))!;
    expect(x.yield).toBeCloseTo(37.64 / 277.43, 10);
    expect(x.value).toBeUndefined();
    const p = parseSmartLab(fx('smartlab-sber.html'), 'SBERP')!;
    expect(p.find((r) => r.t === D(2026, 7, 20))!.yield).toBeCloseTo(37.64 / 279.81, 10);
    // страница без выплат — пустой список (это не «источник недоступен»)
    expect(parseSmartLab(fx('smartlab-vkco.html'), 'VKCO')).toEqual([]);
    expect(parseSmartLab('<html>что-то другое</html>', 'SBER')).toBeNull();
  });
});

describe('Дата отсечки', () => {
  // июль 2025: пн 14 … пт 18, пн 21
  const jul = bars([
    [2025, 7, 14, 100, 100],
    [2025, 7, 15, 100, 100],
    [2025, 7, 16, 100, 100],
    [2025, 7, 17, 100, 100],
    [2025, 7, 18, 95, 95],
    [2025, 7, 21, 95, 95],
  ]);

  it('расчётные дни: до марта 2025 — любой день со свечами; после — без выходных и праздничных сессий', () => {
    expect(isSettlementDay(D(2024, 5, 1))).toBe(true);
    expect(isSettlementDay(D(2026, 5, 1))).toBe(false);
    expect(isSettlementDay(D(2026, 7, 18))).toBe(false); // суббота
    expect(isSettlementDay(D(2026, 1, 5))).toBe(true); // январские сессии — с расчётами
  });

  it('T+1 (с 31.07.2023): отсечка в дату реестра', () => {
    expect(exDividendIndex(jul, { t: D(2025, 7, 18), value: 5 })).toBe(4);
  });

  it('T+1: реестр в воскресенье — отсечка в пятницу перед ним', () => {
    expect(exDividendIndex(jul, { t: D(2025, 7, 20), value: 5 })).toBe(4);
  });

  it('T+2: на торговый день раньше даты реестра, праздники без торгов пропускаются', () => {
    // 2017: пт 9 июня, 12 июня — праздник, вт 13, ср 14 (реестр SBER) → отсечка 13 июня
    const r = bars([
      [2017, 6, 8, 150, 150],
      [2017, 6, 9, 150, 150],
      [2017, 6, 13, 144, 144],
      [2017, 6, 14, 144, 144],
    ]);
    expect(exDividendIndex(r, { t: D(2017, 6, 14), value: 6 })).toBe(2);
  });

  it('T0 (до сентября 2013): отсечка на следующий торговый день', () => {
    const r = bars([
      [2012, 5, 24, 10, 10],
      [2012, 5, 25, 10, 10],
      [2012, 5, 28, 9, 9],
    ]);
    expect(exDividendIndex(r, { t: D(2012, 5, 25), value: 1 })).toBe(2);
  });

  it('торги выходного дня: отсечка — на сессии с наибольшим гэпом (правила их расчётов менялись)', () => {
    // SBER, июль 2026: реестр пн 20.07, гэп уже в субботу 18.07
    const sber = bars([
      [2026, 7, 16, 288.28, 277.02],
      [2026, 7, 17, 277.5, 279.92],
      [2026, 7, 18, 247.3, 249.34],
      [2026, 7, 19, 249.34, 249.34],
      [2026, 7, 20, 251.05, 260.99],
    ]);
    expect(exDividendIndex(sber, { t: D(2026, 7, 20), value: 37.64 })).toBe(2);
    // MTSS, июль 2025: реестр пн 07.07, суббота ещё с дивидендом — гэп в понедельник
    const mtss = bars([
      [2025, 7, 3, 234.5, 228.5],
      [2025, 7, 4, 228, 225.5],
      [2025, 7, 5, 218.25, 218.25],
      [2025, 7, 7, 192.3, 193.8],
      [2025, 7, 8, 193.7, 195.95],
    ]);
    expect(exDividendIndex(mtss, { t: D(2025, 7, 7), value: 35 })).toBe(3);
  });

  it('праздничные сессии: 1 мая без расчётов, январские — с расчётами', () => {
    // LKOH, май 2026: реестр пн 04.05; последний день покупки — чт 30.04, гэп 1 мая
    const lkoh = bars([
      [2026, 4, 30, 5478, 5518],
      [2026, 5, 1, 5248.5, 5235.5],
      [2026, 5, 2, 5240, 5244],
      [2026, 5, 3, 5244, 5255],
      [2026, 5, 4, 5265, 5217],
    ]);
    expect(exDividendIndex(lkoh, { t: D(2026, 5, 4), value: 278 })).toBe(1);
    // X5, январь 2026: реестр вт 06.01, торги 5 января — обычный расчётный день → отсечка 6 января
    const x5 = bars([
      [2025, 12, 29, 3000, 3005.5],
      [2025, 12, 30, 3010.5, 3010],
      [2026, 1, 5, 3017, 3027.5],
      [2026, 1, 6, 2714.5, 2725.5],
      [2026, 1, 8, 2722, 2682.5],
    ]);
    expect(exDividendIndex(x5, { t: D(2026, 1, 6), value: 368 })).toBe(3);
  });

  it('объявленная, но ещё не наступившая выплата не применяется', () => {
    expect(exDividendIndex(jul, { t: D(2025, 12, 9), value: 5 })).toBe(-1);
    // реестр в последний день данных (T+1) — отсечка в нём, применяется
    expect(exDividendIndex(jul, { t: D(2025, 7, 21), value: 5 })).toBe(5);
  });

  it('корректировка: по сумме, по доле от цены; неправдоподобные выплаты пропускаются', () => {
    const st: DivAdjustStats = { applied: 0, suspicious: 0 };
    const a = adjustForDividends(jul, [{ t: D(2025, 7, 18), value: 5 }], st);
    expect(a.map((r) => r.c)).toEqual([95, 95, 95, 95, 95, 95]);
    const b = adjustForDividends(jul, [{ t: D(2025, 7, 18), yield: 0.05 }], st);
    expect(b.map((r) => r.c)).toEqual([95, 95, 95, 95, 95, 95]);
    // сумма в других единицах (больше половины цены) — не применяем
    const c = adjustForDividends(jul, [{ t: D(2025, 7, 18), value: 500 }], st);
    expect(c.map((r) => r.c)).toEqual(jul.map((r) => r.c));
    expect(st).toEqual({ applied: 2, suspicious: 1 });
    // исходные бары не меняются
    expect(jul[0].c).toBe(100);
  });
});

describe('Цепочка источников', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ISS без таблицы → dohod.ru 404 → smart-lab; ISS больше не спрашивается', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('iss.moex.com')) return new Response(JSON.stringify({ description: { columns: [], data: [] } }), { status: 200 });
      if (url.includes('dohod.ru')) return new Response('Page not found', { status: 404 });
      if (url.includes('smart-lab.ru')) return new Response(fx('smartlab-sber.html'), { status: 200 });
      return new Response('', { status: 500 });
    });
    const { moexDividends } = await import('../src/portfolio/dividends');
    const r = await moexDividends('SBER', undefined, { noCache: true });
    expect(r?.source).toBe('smartlab');
    expect(r!.divs.length).toBeGreaterThan(5);
    expect(calls.some((u) => u.includes('/ik/analytics/dividend/sber'))).toBe(true);
    expect(calls.some((u) => u.includes('/q/SBER/dividend/'))).toBe(true);
    calls.length = 0;
    await moexDividends('SBERP', undefined, { noCache: true });
    expect(calls.some((u) => u.includes('iss.moex.com'))).toBe(false);
  });

  it('dohod.ru ответил — smart-lab не запрашивается; ни один источник не ответил — null', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('dohod.ru/ik/analytics/dividend/sber')) return new Response(fx('dohod-sber.html'), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const { moexDividends } = await import('../src/portfolio/dividends');
    const r = await moexDividends('SBER', undefined, { noCache: true });
    expect(r?.source).toBe('dohod');
    expect(r!.divs.find((x) => x.t === D(2024, 7, 11))?.value).toBe(33.3);
    expect(calls.some((u) => u.includes('smart-lab'))).toBe(false);
    expect(await moexDividends('XXZZ', undefined, { noCache: true })).toBeNull();
  });
});
