import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/data/intervals';
import { fixSplitBlocks } from '../src/data/loader';
import { seriesFromCandles, type Candle } from '../src/data/types';
import { MarketData } from '../src/engine/market';
import { priceJumpWarnings } from '../src/engine/optionRunner';

/** Часовые свечи по будням 14:00–19:00 UTC с ценой px(day). */
function hourly(from: number, days: number, px: (d: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let d = 0; d < days; d++) {
    const day = from + d * DAY;
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let h = 14; h < 20; h++) {
      const p = px(d) * (1 + 0.001 * (h - 16));
      out.push({ t: day + h * HOUR, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 100 });
    }
  }
  return out;
}

describe('История акций: куски без поправки на сплит', () => {
  const from = Date.UTC(2024, 9, 1);
  const split = Date.UTC(2025, 10, 17); // NFLX 10:1
  const days = 500;
  const adj = (d: number) => 80 + d * 0.1; // скорректированная цена
  // дневной эталон Yahoo (на все сплиты), свеча дня — 13:30 UTC
  const ref = Array.from({ length: days }, (_, d) => ({ t: from + d * DAY + 13.5 * HOUR, c: adj(d) * (1 + 0.003) }));
  // кусок 2024-10-20 … 2025-05-01 пришёл «сырым» (×10), остальное — с поправкой
  const blockA = Date.UTC(2024, 9, 20);
  const blockB = Date.UTC(2025, 4, 1);
  const raw = hourly(from, days, (d) => {
    const t = from + d * DAY;
    return t >= blockA && t < blockB ? adj(d) * 10 : adj(d);
  });
  const s = seriesFromCandles('NFLXUSDT', '1h', raw);

  it('кусок ×10 до сплита делится, остальное не трогается', () => {
    const { series, fixed } = fixSplitBlocks(s, [{ t: split, factor: 10 }], ref);
    expect(fixed.length).toBe(1);
    expect(fixed[0].factor).toBe(10);
    expect(new Date(fixed[0].from).toISOString().slice(0, 10)).toBe('2024-10-21'); // 20.10 — воскресенье
    expect(new Date(fixed[0].to).toISOString().slice(0, 10)).toBe('2025-04-30');
    let maxJump = 0;
    for (let i = 1; i < series.length; i++) maxJump = Math.max(maxJump, Math.abs(Math.log(series.c[i] / series.c[i - 1])));
    expect(maxJump).toBeLessThan(0.02);
    // объём пересчитан обратно сплиту
    const k = series.t.indexOf(raw.find((c) => c.t >= blockA)!.t);
    expect(series.v[k]).toBeCloseTo(1000, 6);
  });

  it('после сплита и без сплитов впереди ничего не меняется', () => {
    const after = seriesFromCandles('NFLXUSDT', '1h', hourly(split + DAY, 60, (d) => 110 + d * 0.1));
    const refAfter = Array.from({ length: 60 }, (_, d) => ({ t: split + (d + 1) * DAY + 13.5 * HOUR, c: 110 + d * 0.1 }));
    expect(fixSplitBlocks(after, [{ t: split, factor: 10 }], refAfter).fixed.length).toBe(0);
    // настоящий обвал на 40% — не сплит: не трогаем
    const crash = seriesFromCandles('NFLXUSDT', '1h', hourly(from, 100, (d) => (d < 50 ? 100 : 60)));
    const refCrash = Array.from({ length: 100 }, (_, d) => ({ t: from + d * DAY + 13.5 * HOUR, c: d < 50 ? 100 : 60 }));
    expect(fixSplitBlocks(crash, [{ t: split, factor: 10 }], refCrash).fixed.length).toBe(0);
  });

  it('два сплита впереди: кусок, не учитывающий только последний, делится лишь на него', () => {
    // NVDA: 4:1 (2021-07-20) и 10:1 (2024-06-10); кусок 2021-08 скорректирован на первый, но не на второй
    const f2 = Date.UTC(2021, 7, 2);
    const s2 = seriesFromCandles('NVDAUSDT', '1h', hourly(f2, 30, () => 200 * 10));
    const ref2 = Array.from({ length: 30 }, (_, d) => ({ t: f2 + d * DAY + 13.5 * HOUR, c: 200 }));
    const { fixed } = fixSplitBlocks(s2, [{ t: Date.UTC(2021, 6, 20), factor: 4 }, { t: Date.UTC(2024, 5, 10), factor: 10 }], ref2);
    expect(fixed.map((f) => f.factor)).toEqual([10]);
  });

  it('скачок цены в 10 раз виден в предупреждениях стратегии', () => {
    const m = new MarketData('1h', from + 40 * DAY, from + 400 * DAY);
    m.addSeries('NFLXUSDT', s, 'yahoo');
    const w = priceJumpWarnings(m, ['NFLXUSDT']);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('NFLX');
    expect(w[0]).toContain('2 раз');
    const ok = new MarketData('1h', from + 40 * DAY, from + 400 * DAY);
    ok.addSeries('NFLXUSDT', fixSplitBlocks(s, [{ t: split, factor: 10 }], ref).series, 'yahoo');
    expect(priceJumpWarnings(ok, ['NFLXUSDT'])).toEqual([]);
  });
});
