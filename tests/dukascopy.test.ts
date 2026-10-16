import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { lzmaDecompress } from '../src/lib/lzma';
import { dukaInstrument, parseBi5 } from '../src/data/providers/dukascopy';

describe('Dukascopy', () => {
  const file = new Uint8Array(readFileSync(new URL('./fixtures/AAPL-2024-01-hour.bi5', import.meta.url)));

  it('LZMA: распаковка файла истории', () => {
    const raw = lzmaDecompress(file);
    expect(raw.length).toBe(744 * 24); // часовые свечи за январь: 31 × 24
  });

  it('свечи: только торговые часы, цены в долларах', () => {
    const rows = parseBi5(file, Date.UTC(2024, 0, 1), 1000);
    expect(rows.length).toBe(147); // 21 торговый день × 7 часовых свечей
    expect(rows[0].t).toBe(Date.UTC(2024, 0, 2, 14));
    expect(rows[0].o).toBeCloseTo(187.137, 3);
    expect(rows[0].c).toBeCloseTo(186.506, 3);
    for (const r of rows) {
      expect(r.h).toBeGreaterThanOrEqual(Math.max(r.o, r.c));
      expect(r.l).toBeLessThanOrEqual(Math.min(r.o, r.c));
    }
  });

  it('сопоставление тикеров: акции, переименования, индексы и сырьё', () => {
    expect(dukaInstrument('AAPLUSDT')?.file).toBe('AAPLUSUSD');
    expect(dukaInstrument('METAUSDT')?.file).toBe('FBUSUSD');
    expect(dukaInstrument('US500USDT')).toMatchObject({ file: 'USA500IDXUSD', cfd: true });
    expect(dukaInstrument('XAUUSDT')?.file).toBe('XAUUSD');
    expect(dukaInstrument('BTCUSDT')).toBeNull(); // крипта — не отсюда
  });
});

describe('Yahoo: чистка пре/постмаркета', () => {
  it('ошибочные принты в свечах без объёма не создают шпилек', async () => {
    const { cleanExtendedHours } = await import('../src/data/providers/yahoo');
    // NVDA 09.07.2025, часовые свечи Yahoo (UTC)
    const bars = cleanExtendedHours([
      { t: 1, o: 162.845, h: 163.02, l: 162.57, c: 162.83, v: 16787843 },
      { t: 2, o: 162.88, h: 181.9799, l: 100.1947, c: 115.7909, v: 0 },
      { t: 3, o: 162.855, h: 172.6928, l: 109.3739, c: 163.0499, v: 0 },
      { t: 4, o: 163.0403, h: 163.38, l: 163.01, c: 163.3353, v: 0 },
    ]);
    for (const b of bars) {
      expect(b.h / Math.max(b.o, b.c)).toBeLessThanOrEqual(1.01 + 1e-9);
      expect(b.l / Math.min(b.o, b.c)).toBeGreaterThanOrEqual(0.99 - 1e-9);
    }
    expect(bars[1].c).toBeCloseTo(162.855, 3);
    expect(bars[3]).toMatchObject({ h: 163.38, l: 163.01 }); // нормальные свечи не трогаем
    expect(bars[0].h).toBe(163.02); // основная сессия — как есть
  });

  it('выброс открытия в постмаркете (NVDA 07.05.2025 21:00 UTC)', async () => {
    const { cleanExtendedHours } = await import('../src/data/providers/yahoo');
    const bars = cleanExtendedHours([
      { t: 1, o: 113.23, h: 117.68, l: 113.19, c: 117.02, v: 63856483 },
      { t: 2, o: 117.015, h: 145.2702, l: 71.9844, c: 116.38, v: 0 },
      { t: 3, o: 135.7993, h: 145.1633, l: 72.7231, c: 116.3003, v: 0 },
      { t: 4, o: 116.31, h: 116.54, l: 116.12, c: 116.36, v: 0 },
    ]);
    expect(bars[2].o).toBeCloseTo(116.38, 2);
    for (const b of bars.slice(1)) {
      expect(b.h).toBeLessThan(118.2);
      expect(b.l).toBeGreaterThan(115);
    }
  });
});

describe('Склейка Yahoo + Dukascopy', () => {
  it('часовая история старше лимита Yahoo: свечи из архива, цены приведены к сплиту, без ступеньки', async () => {
    const { vi } = await import('vitest');
    const { parseBi5 } = await import('../src/data/providers/dukascopy');
    const { loadSeries } = await import('../src/data/loader');
    const aug = new Uint8Array(readFileSync(new URL('./fixtures/AAPL-2020-08-hour.bi5', import.meta.url)));
    const split = Date.UTC(2020, 7, 31);
    // «Yahoo»: дневные свечи, уже скорректированные на сплит 4:1 от 31.08.2020
    const hourly = parseBi5(aug, Date.UTC(2020, 7, 1), 1000);
    const days = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
    for (const r of hourly) {
      const f = r.t < split ? 4 : 1;
      const d = Math.floor(r.t / 86400000) * 86400000 + 13.5 * 3600_000;
      const cur = days.get(d);
      if (!cur) days.set(d, { o: r.o / f, h: r.h / f, l: r.l / f, c: r.c / f, v: 1e6 });
      else Object.assign(cur, { h: Math.max(cur.h, r.h / f), l: Math.min(cur.l, r.l / f), c: r.c / f, v: cur.v + 1e6 });
    }
    const ts = [...days.keys()].sort((a, b) => a - b);
    const yahoo = (events = false) => ({
      chart: {
        result: [
          {
            timestamp: ts.map((t) => t / 1000),
            indicators: { quote: [{ open: ts.map((t) => days.get(t)!.o), high: ts.map((t) => days.get(t)!.h), low: ts.map((t) => days.get(t)!.l), close: ts.map((t) => days.get(t)!.c), volume: ts.map((t) => days.get(t)!.v) }] },
            ...(events ? { events: { splits: { [split / 1000]: { date: split / 1000 + 13.5 * 3600, numerator: 4, denominator: 1 } } } } : {}),
          },
        ],
      },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('datafeed.dukascopy.com')) {
        if (url.includes('/AAPLUSUSD/2020/07/BID_candles_hour_1.bi5')) return new Response(aug, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        return new Response('', { status: 404 });
      }
      if (url.includes('finance.yahoo.com')) return new Response(JSON.stringify(yahoo(url.includes('interval=1mo'))), { status: 200 });
      return new Response('{}', { status: 404 }); // остальные источники недоступны
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await loadSeries({ provider: 'yahoo', symbol: 'AAPLUSDT', interval: '1h', start: Date.UTC(2020, 7, 3), end: Date.UTC(2020, 8, 1), fallback: true });
      expect(r.provider).toBe('dukascopy');
      const s = r.series;
      expect(s.length).toBeGreaterThan(100); // часовые свечи, а не ~20 дневных
      // до сплита цены поделены на 4: 28.08 ~125, а не ~500
      const before = [...s.t].findIndex((t) => t >= Date.UTC(2020, 7, 28, 19)) ;
      expect(s.c[before]).toBeGreaterThan(110);
      expect(s.c[before]).toBeLessThan(140);
      // без ступеньки на стыке сплита (обычный гэп выходных, не ×4)
      const after = [...s.t].findIndex((t) => t >= split);
      expect(Math.abs(Math.log(s.o[after] / s.c[after - 1]))).toBeLessThan(0.1);
      // объёмы приведены к масштабу Yahoo
      const vol = [...s.v].reduce((a, b) => a + b, 0);
      expect(vol).toBeGreaterThan(1e6);
      expect(r.errors.some((e) => /Dukascopy/.test(e))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Загрузка акций без лишних запросов к архиву', () => {
  it('сессия 5м на 30 дней + история до старта: только Yahoo, без Dukascopy (разница в 1 день)', async () => {
    const { vi } = await import('vitest');
    const { loadSeries } = await import('../src/data/loader');
    const DAY = 86400000;
    const step: Record<string, number> = { '1d': DAY, '5m': 300_000 };
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const q = new URL(url).searchParams;
        const dt = step[q.get('interval') ?? '1d'] ?? DAY;
        const ts: number[] = [];
        for (let t = Number(q.get('period1')) * 1000; t < Number(q.get('period2')) * 1000; t += dt) ts.push(t / 1000);
        const px = ts.map(() => 100);
        return new Response(JSON.stringify({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: px, high: px, low: px, close: px, volume: px }] } }] } }), { status: 200 });
      }),
    );
    try {
      const end = Math.floor(Date.now() / DAY) * DAY;
      const r = await loadSeries({ provider: 'yahoo', symbol: 'AAPLUSDT', interval: '5m', start: end - 60 * DAY, end, fallback: true });
      expect(r.provider).toBe('yahoo');
      expect(r.series.length).toBeGreaterThan(1000);
      expect(urls.some((u) => u.includes('dukascopy'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
