import { describe, expect, it, vi } from 'vitest';
import { DAY, HOUR } from '../src/data/intervals';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { MarketData } from '../src/engine/market';
import { Exchange } from '../src/engine/exchange';
import { runBotBacktest } from '../src/engine/headless';
import { spotCoin } from '../src/data/providers/spotHistory';
import { mkConfig, T0 } from './helpers';

/** Часовые свечи с плавным ростом цены, начиная с from. */
function hours(from: number, n: number, p0: number, g = 0.002): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = p0 * (1 + g) ** i;
    const o = p0 * (1 + g) ** Math.max(0, i - 1);
    return { t: from + i * HOUR, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
  });
}

/** BTC — с начала сессии, ETH — только через 30 часов (как перпетуал, запущенный позже). */
function lateMarket() {
  const m = new MarketData('1h', T0, T0 + 100 * HOUR);
  m.addSeries('BTCUSDT', seriesFromCandles('BTCUSDT', '1h', hours(T0 - HOUR, 101, 100)), 'synthetic');
  m.addSeries('ETHUSDT', seriesFromCandles('ETHUSDT', '1h', hours(T0 + 30 * HOUR, 70, 50)), 'synthetic');
  return m;
}
const legs = [
  { symbol: 'BTCUSDT', side: 'long' as const, weight: 50 },
  { symbol: 'ETHUSDT', side: 'long' as const, weight: 50 },
];

describe('Монета без истории на старте', () => {
  it('комбо без ребалансировок ждёт первой цены и открывает весь портфель, а не стоит пустым', () => {
    const m = lateMarket();
    const ex = Exchange.create(mkConfig({ end: m.end, symbols: ['BTCUSDT', 'ETHUSDT'] }), m);
    const { bot, error } = ex.createBot('futuresCombo', 'c', 5000, { legs, leverage: 1, rebalanceMode: 'none', intervalHours: 24, thresholdPct: 5 });
    expect(error).toBeUndefined();
    expect(bot!.status).toBe('waiting');
    for (let i = 0; i < 20; i++) ex.step();
    expect(Object.keys(ex.botAccount(bot!).positions)).toEqual([]);
    for (let i = 0; i < 20; i++) ex.step();
    const acc = ex.botAccount(bot!);
    expect(ex.state.bots[bot!.id].status).toBe('running');
    expect(acc.positions.BTCUSDT.size).toBeGreaterThan(0);
    expect(acc.positions.ETHUSDT.size).toBeGreaterThan(0);
    expect(ex.state.bots[bot!.id].startedTime).toBeGreaterThanOrEqual(T0 + 30 * HOUR);
  });

  it('грид на монете без истории не останавливается с ошибкой, а запускается с первой свечой', () => {
    const m = lateMarket();
    const ex = Exchange.create(mkConfig({ end: m.end, symbols: ['BTCUSDT', 'ETHUSDT'] }), m);
    const { bot } = ex.createBot('futuresGrid', 'g', 3000, { symbol: 'ETHUSDT', direction: 'long', lower: 45, upper: 60, grids: 10, mode: 'arithmetic', leverage: 2, closeOnStop: true });
    for (let i = 0; i < 40; i++) ex.step();
    expect(ex.state.bots[bot!.id].status).toBe('running');
    expect(ex.botAccount(bot!).positions.ETHUSDT?.size).toBeGreaterThan(0);
  });

  it('бэктест бота начинается, когда есть цены всех монет, и сообщает об этом', async () => {
    const m = lateMarket();
    const r = await runBotBacktest(m, mkConfig({ end: m.end, symbols: ['BTCUSDT', 'ETHUSDT'] }), 'futuresCombo', { legs, leverage: 1, rebalanceMode: 'threshold', intervalHours: 24, thresholdPct: 5 }, 5000);
    expect(r.ok).toBe(true);
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toContain('ETH');
    expect(r.equity[0].t).toBe(T0 + 31 * HOUR);
    expect(r.equity[0].v).toBe(5000);
    // обе монеты росли ~0.2% в час — портфель тоже растёт (раньше: 0%, позиции не открывались)
    expect(r.report.totalReturn).toBeGreaterThan(0.08);
    expect(r.report.benchReturn).toBeGreaterThan(0.08);
  });
});

describe('История крипты до запуска перпетуала — со спота', () => {
  it('монета спота для перпетуала: 1000PEPE → PEPE ×1000; акции — не крипта', () => {
    expect(spotCoin('BTCUSDT')).toEqual({ coin: 'BTC', mult: 1 });
    expect(spotCoin('1000PEPEUSDT')).toEqual({ coin: 'PEPE', mult: 1000 });
    expect(spotCoin('NVDAUSDT')).toBeNull();
  });

  it('перпетуал с 2020 + спот Binance с 2017 + Coinbase раньше: одна непрерывная история', async () => {
    const { loadSeries } = await import('../src/data/loader');
    const perpFrom = Date.UTC(2020, 2, 25);
    const binFrom = Date.UTC(2017, 7, 17);
    // «настоящая» цена: экспоненциальный рост; спот Binance на 0.3% ниже перпетуала, Coinbase (USD) — на 1% выше
    const px = (t: number) => 500 * Math.exp((t - Date.UTC(2016, 0, 1)) / (400 * DAY));
    const day = (t: number, k: number) => [t, px(t) * k, px(t) * k * 1.01, px(t) * k * 0.99, px(t + DAY) * k, 10];
    const days = (a: number, b: number, from: number, to: number) => {
      const out: number[] = [];
      for (let t = Math.max(a, from); t < Math.min(b, to); t += DAY) out.push(t);
      return out;
    };
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        const q = u.searchParams;
        if (u.host === 'api.bybit.com' && u.pathname === '/v5/market/kline') {
          const list = days(Number(q.get('start')), Number(q.get('end')) + 1, perpFrom, Date.UTC(2020, 5, 1)).reverse().map((t) => day(t, 1).map(String));
          return new Response(JSON.stringify({ retCode: 0, result: { list } }), { status: 200 });
        }
        if (u.host === 'data-api.binance.vision') {
          const rows = days(Number(q.get('startTime')), Number(q.get('endTime')) + 1, binFrom, Date.UTC(2020, 5, 1)).map((t) => day(t, 0.997).map(String));
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (u.host === 'api.exchange.coinbase.com') {
          const a = Date.parse(q.get('start')!);
          const b = Date.parse(q.get('end')!) + DAY;
          const rows = days(a, b, Date.UTC(2015, 6, 20), Date.UTC(2020, 5, 1))
            .reverse()
            .map((t) => {
              const [, o, h, l, c, v] = day(t, 1.01);
              return [t / 1000, l, h, o, c, v];
            });
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    try {
      const start = Date.UTC(2016, 9, 21);
      const r = await loadSeries({ provider: 'bybit', symbol: 'BTCUSDT', interval: '1d', start, end: Date.UTC(2020, 5, 1), fallback: true });
      expect(r.provider).toBe('bybit');
      const s = r.series;
      expect(s.t[0]).toBe(start);
      // свечи каждый день, без дыр и дублей
      for (let i = 1; i < s.length; i++) expect(s.t[i] - s.t[i - 1]).toBe(DAY);
      // уровень подогнан: на стыках нет скачков, старые цены — в масштабе перпетуала
      let maxJump = 0;
      for (let i = 1; i < s.length; i++) maxJump = Math.max(maxJump, Math.abs(Math.log(s.o[i] / s.c[i - 1])));
      expect(maxJump).toBeLessThan(1e-6);
      for (let i = 0; i < s.length; i += 50) expect(s.c[i] / px(s.t[i] + DAY)).toBeCloseTo(1, 6);
      expect(r.errors.some((e) => /спот \(Binance Spot с 2017-08-17, Coinbase с 2016-10-21\)/.test(e))).toBe(true);
      expect(urls.some((u) => u.includes('PEPE'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
