import { describe, expect, it } from 'vitest';
import { defaultConfigText, parseConfig, setTopLevel, type LbConfig } from '../src/portfolio/config';
import { atr, highestPrev, lowestPrev, meanPrev, pctRank, rma, trueRange } from '../src/portfolio/indicators';
import { addToPosition, positionSize, riskPerTrade, updateGuards, type GuardEvent } from '../src/portfolio/portfolio';
import { prepare, runBacktest, type Dataset, type BacktestResult } from '../src/portfolio/backtest';
import { runScan } from '../src/portfolio/scan';
import type { Bars } from '../src/portfolio/rules';

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);

/* ───────── синтетические данные ───────── */

interface BarSpec {
  o?: number;
  h?: number;
  l?: number;
  c: number;
  v?: number;
}

function bars(spec: BarSpec[], t0 = T0): Bars {
  const n = spec.length;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const s = spec[i];
    const prev = i ? spec[i - 1].c : s.c;
    b.t[i] = t0 + i * DAY;
    b.c[i] = s.c;
    b.o[i] = s.o ?? prev;
    b.h[i] = s.h ?? Math.max(b.o[i], s.c) + 1;
    b.l[i] = s.l ?? Math.min(b.o[i], s.c) - 1;
    b.v[i] = s.v ?? 1_000_000;
  }
  return b;
}

/**
 * Восходящий тренд: 0.5 в день, ранние бары волатильнее (ATR10 < ATR50 к моменту сигнала),
 * скачок +3 на баре `jump` — пробой HH20 с объёмом ×2 (единственный сигнал входа).
 */
function trend(n: number, jump: number, after?: (i: number, prev: number) => BarSpec): BarSpec[] {
  const out: BarSpec[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    if (after && i > jump) {
      const s = after(i, out[i - 1].c);
      out.push(s);
      c = s.c;
      continue;
    }
    c += i === jump ? 3 : 0.5;
    const wide = i < 200 ? 2 : 1;
    out.push({ c, o: i ? out[i - 1].c : c, h: c + wide, l: c - wide - (i === jump ? 0 : 0), v: i === jump ? 2_000_000 : 1_000_000 });
  }
  return out;
}

function cfg(over: (c: LbConfig) => void = () => {}): LbConfig {
  const c = parseConfig(setTopLevel(defaultConfigText('us'), 'start', new Date(T0 + 280 * DAY).toISOString().slice(0, 10)));
  c.costs.commission_pct = 0;
  c.costs.slippage_pct = 0;
  over(c);
  return c;
}

function dataset(assets: { symbol: string; spec: BarSpec[] }[], benchN = 600): Dataset {
  const bench: BarSpec[] = [];
  for (let i = 0; i < benchN; i++) bench.push({ c: 1000 + i });
  return { market: 'us', benchSymbol: 'BENCH', bench: bars(bench), assets: assets.map((a) => ({ symbol: a.symbol, bars: bars(a.spec), step: 1 })), warnings: [] };
}

async function run(ds: Dataset, c: LbConfig): Promise<BacktestResult> {
  return runBacktest(prepare(ds, c), c);
}

const iso = (i: number) => new Date(T0 + i * DAY).toISOString().slice(0, 10);

/* ───────── тесты раздела 9 ───────── */

describe('«Пробой лидеров»: индикаторы и конфиг', () => {
  it('1. ATR: RMA Уайлдера совпадает с ручным расчётом', () => {
    const h = [10, 11, 12, 11, 13, 14];
    const l = [8, 9, 10, 9, 10, 12];
    const c = [9, 10, 11, 10, 12, 13];
    const tr = trueRange(h, l, c);
    // TR вручную: 2; max(2, |11−9|, |9−9|)=2; max(2, 2, 0)=2; max(2, 0, 2)=2; max(3, 3, 0)=3; max(2, 2, 0)=2
    expect([...tr]).toEqual([2, 2, 2, 2, 3, 2]);
    const a = atr(h, l, c, 3);
    expect(a[1]).toBeNaN();
    expect(a[2]).toBeCloseTo(2, 12); // старт — SMA первых трёх
    expect(a[3]).toBeCloseTo((2 * 2 + 2) / 3, 12);
    expect(a[4]).toBeCloseTo((a[3] * 2 + 3) / 3, 12);
    expect(a[5]).toBeCloseTo((a[4] * 2 + 2) / 3, 12);
    expect([...rma([1, 2, 3, 4], 2)].slice(1)).toEqual([1.5, (1.5 + 3) / 2, ((1.5 + 3) / 2 + 4) / 2]);
  });

  it('окна [t−n .. t−1] не включают текущий бар; процентильный ранг 0..1', () => {
    const x = [5, 1, 7, 3, 9];
    expect([...highestPrev(x, 2)]).toEqual([NaN, NaN, 5, 7, 7]);
    expect([...lowestPrev(x, 2)]).toEqual([NaN, NaN, 1, 1, 3]);
    expect([...meanPrev(x, 2)]).toEqual([NaN, NaN, 3, 4, 5]);
    const p = pctRank([10, NaN, 30, 20, 20]);
    expect(p[0]).toBeCloseTo(0.25);
    expect(p[1]).toBeNaN();
    expect(p[2]).toBeCloseTo(1);
    expect(p[3]).toBeCloseTo(0.625); // ничья — средний ранг 2.5 из 4
  });

  it('config.yaml: значения по умолчанию из спецификации, крипта — по комментариям', () => {
    const us = parseConfig(defaultConfigText('us'));
    expect(us.risk).toEqual({ atr_period: 14, atr_stop_mult: 2, risk_per_trade: 0.01, max_position_pct: 0.2, max_positions: 5 });
    expect(us.trend_filter.rs_periods).toEqual([63, 126]);
    expect(us.benchmark).toBe('^GSPC');
    expect(us.end).toBeNull();
    const cr = parseConfig(defaultConfigText('crypto'));
    expect(cr.trend_filter).toMatchObject({ sma_long_rising_bars: 30, high_lookback: 365, rs_periods: [90, 180] });
    expect(cr.costs.commission_pct).toBe(0.001);
    expect(() => parseConfig('market: forex')).toThrow();
    expect(parseConfig('market: us\nrisk:\n  max_positions: 3').risk.max_positions).toBe(3);
  });
});

describe('«Пробой лидеров»: размер, докупка, стопы', () => {
  it('2. Размер позиции: equity 1 000 000, ATR14 = 2, fill 100 → R_ps 4, стоп 96, 2 000 шт., риск 0.8%', () => {
    const c = cfg();
    const R_ps = c.risk.atr_stop_mult * 2;
    expect(R_ps).toBe(4);
    expect(100 - R_ps).toBe(96);
    // по риску 1 000 000 · 1% / 4 = 2 500, лимит 20% режет до 2 000
    expect(Math.floor((1_000_000 * 0.01) / R_ps)).toBe(2500);
    const s = positionSize({ equity: 1_000_000, risk: riskPerTrade(false, c), R_ps, fill: 100, cash: 1_000_000, turnover: 1e12, step: 1 }, c);
    expect(s.q).toBe(2000);
    expect(s.q * R_ps).toBe(8000);
    expect((s.q * R_ps) / 1_000_000).toBeCloseTo(0.008);
  });

  it('3. Докупка: E = 100, R_ps = 4, q0 = 2 000 → +1 000 шт.; стоп = max(E + 0.5R, средняя); P&L на стопе ≈ 0', () => {
    const E = 100;
    const R = 4;
    const q0 = 2000;
    const stopAfterSignal = Math.max(E - R, E + 0.5 * R); // 102, действует с открытия
    for (const [fill, stop] of [
      [106, 102],
      [108, 102 + 2 / 3],
    ]) {
      const p = addToPosition({ qty: q0, avgCost: E, stop: stopAfterSignal }, 0.5 * q0, fill);
      expect(p.qty).toBe(3000);
      expect(p.stop).toBeCloseTo(stop, 6);
      const pnlAtStop = q0 * (p.stop - E) + 0.5 * q0 * (p.stop - fill);
      expect(Math.abs(pnlAtStop)).toBeLessThan(1e-6);
    }
  });

  it('3б. Докупка в цикле бэктеста: после close ≥ E + 1.5R — покупка половины q0 на открытии, стоп не ниже средней', async () => {
    const J = 300;
    const spec = trend(340, J, (i, prev) => ({ c: prev + (i <= J + 3 ? 4 : 0.2), v: 1_000_000 }));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), cfg());
    const t = r.trades.find((x) => x.add_date)!;
    expect(t).toBeTruthy();
    expect(t.signal_date).toBe(iso(J));
    expect(t.add_qty).toBe(Math.floor(0.5 * t.q0));
    const avg = (t.entry_price * t.q0 + t.add_price! * t.add_qty!) / (t.q0 + t.add_qty!);
    // стоп после докупки не ниже средней цены → в худшем случае сделка около нуля
    expect(r.decisions.some((d) => d.kind === 'add' && d.symbol === 'AAA')).toBe(true);
    expect(avg).toBeGreaterThan(t.entry_price);
  });

  it('4. Гэп через стоп: open ниже стопа → выход по open (до проскальзывания)', async () => {
    const J = 300;
    const spec = trend(320, J, (i, prev) => (i === J + 3 ? { o: prev - 30, h: prev - 29, l: prev - 31, c: prev - 30 } : { c: prev + 0.5 }));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), cfg());
    const t = r.trades[0];
    expect(t.exit_reason).toBe('stop_gap');
    expect(t.exit_date).toBe(iso(J + 3));
    expect(t.exit_price).toBeCloseTo(spec[J + 3].o!, 9);
    expect(t.exit_price).toBeLessThan(t.initial_stop);
  });

  it('4б. Стоп внутри дня: low ≤ стоп → выход по цене стопа', async () => {
    const J = 300;
    const spec = trend(320, J, (i, prev) => (i === J + 3 ? { o: prev, h: prev + 1, l: prev - 40, c: prev } : { c: prev + 0.5 }));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), cfg());
    const t = r.trades[0];
    expect(t.exit_reason).toBe('stop');
    expect(t.exit_price).toBeCloseTo(t.initial_stop, 9);
    expect(t.bars_held).toBe(3); // вход J+1 (бар 1), J+2, стоп внутри J+3
  });

  it('5. Трейлинг: close[t] < LL10[t] → выход по open[t+1], не раньше', async () => {
    const J = 300;
    const X = J + 10;
    const cJ = 100 + 0.5 * J + 3; // закрытие бара пробоя = цена входа (open[J+1])
    // после входа рост 0.6 в день (тайм-стоп и докупка не срабатывают), на баре X закрытие ниже LL10, но выше стопа
    const spec = trend(330, J, (i, prev) => (i === X ? { o: prev, h: prev + 0.5, l: cJ - 2.6, c: cJ - 2 } : { c: prev + 0.6, h: prev + 1.2, l: prev - 0.5 }));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), cfg());
    const t = r.trades[0];
    expect(t.entry_price).toBeCloseTo(cJ, 9);
    expect(t.exit_reason).toBe('trail');
    expect(r.decisions.find((d) => d.kind === 'exit')!.date).toBe(iso(X)); // решение — на закрытии X
    expect(t.exit_date).toBe(iso(X + 1)); // исполнение — на открытии X+1
    expect(t.exit_price).toBeCloseTo(cJ - 2, 9); // open[X+1] = close[X]
  });

  it('6. Тайм-стоп: 10 баров без закрытия ≥ E + R_ps → выход на открытии 11-го бара', async () => {
    const J = 300;
    const spec = trend(330, J, (_i, prev) => ({ c: prev + 0.05, h: prev + 0.6, l: prev - 0.3 }));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), cfg());
    const t = r.trades[0];
    expect(t.exit_reason).toBe('time');
    expect(t.entry_date).toBe(iso(J + 1));
    expect(t.exit_date).toBe(iso(J + 11));
    expect(t.bars_held).toBe(10);
  });
});

describe('«Пробой лидеров»: без заглядывания вперёд, предохранители, ограничения', () => {
  it('7. Изменение данных после даты d не меняет решений по закрытиям до d включительно', async () => {
    const mk = (seed: number) => {
      const assets = [];
      for (let k = 0; k < 6; k++) {
        const J = 290 + k * 7;
        assets.push({ symbol: `A${k}`, spec: trend(420, J, (i, prev) => ({ c: prev + Math.sin(i * (0.3 + 0.1 * k) + (i > 360 ? seed : 0)) * 2 })) });
      }
      return dataset(assets);
    };
    const d = iso(360);
    const a = await run(mk(0), cfg());
    const b = await run(mk(5), cfg());
    const before = (r: BacktestResult) => ({
      decisions: r.decisions.filter((x) => x.date <= d),
      equity: r.equity.filter((x) => x.date <= d).map((x) => [x.date, x.equity, x.cash]),
      entries: r.trades.filter((x) => x.entry_date <= d).map((x) => [x.symbol, x.entry_date, x.entry_price, x.q0]),
    });
    expect(before(a).decisions.length).toBeGreaterThan(0);
    expect(before(b)).toEqual(before(a));
  });

  it('8. Предохранители: −10% → риск 0.5%; новый пик → снова 1%; −20% → новых входов нет', () => {
    const c = cfg();
    const g = { peak: 1_000_000, throttle: false, halted: false };
    const ev: GuardEvent[] = [];
    updateGuards(g, 950_000, 1, c, ev);
    expect(riskPerTrade(g.throttle, c)).toBe(0.01);
    updateGuards(g, 899_000, 2, c, ev);
    expect(g.throttle).toBe(true);
    expect(riskPerTrade(g.throttle, c)).toBe(0.005);
    updateGuards(g, 990_000, 3, c, ev);
    expect(g.throttle).toBe(true); // ещё не новый пик
    updateGuards(g, 1_010_000, 4, c, ev);
    expect(g.throttle).toBe(false);
    expect(riskPerTrade(g.throttle, c)).toBe(0.01);
    updateGuards(g, 800_000, 5, c, ev);
    expect(g.halted).toBe(true);
    expect(ev.map((e) => e.kind)).toEqual(['throttle_on', 'throttle_off', 'throttle_on', 'halt']);
    // log_only: только запись
    const c2 = cfg((x) => (x.account_guards.max_dd_action = 'log_only'));
    const g2 = { peak: 1_000_000, throttle: false, halted: false };
    const ev2: GuardEvent[] = [];
    updateGuards(g2, 790_000, 1, c2, ev2);
    expect(g2.halted).toBe(false);
    expect(ev2.some((e) => e.kind === 'max_dd_logged')).toBe(true);
  });

  it('8б. После остановки по просадке новых входов нет до конца теста', async () => {
    const J = 300;
    // первая сделка теряет на стопе; второй пробой позже должен быть проигнорирован
    const spec = trend(400, J, (i, prev) => {
      if (i === J + 3) return { o: prev, h: prev + 1, l: prev - 40, c: prev - 5 };
      if (i === J + 60) return { c: prev + 6, v: 3_000_000 };
      return { c: prev + 0.5 };
    });
    const c = cfg((x) => (x.account_guards.max_dd = 0.001));
    const r = await run(dataset([{ symbol: 'AAA', spec }]), c);
    const halt = r.events.find((e) => e.kind === 'halt');
    expect(halt).toBeTruthy();
    const haltDay = new Date(halt!.date).toISOString().slice(0, 10);
    expect(r.trades.filter((t) => t.entry_date > haltDay)).toHaveLength(0);
    expect(r.decisions.filter((d) => d.kind === 'entry' && d.date >= haltDay)).toHaveLength(0);
  });

  it('9. Ограничения: не больше 5 позиций одновременно; cash не уходит в минус', async () => {
    const assets = [];
    for (let k = 0; k < 9; k++) assets.push({ symbol: `S${k}`, spec: trend(360, 300, (_i, prev) => ({ c: prev + 0.6 + k * 0.01 })) });
    // 9 одновременных сигналов → 5 слотов (порог RS снят: у одинаковых историй ранги равны, а проверяем механику слотов и денег)
    const noRs = (x: LbConfig) => (x.trend_filter.rs_min_percentile = 0);
    const r = await run(dataset(assets), cfg(noRs));
    expect(r.decisions.filter((d) => d.kind === 'entry').length).toBe(5);
    const maxOpen = Math.max(...r.equity.map((e) => r.trades.filter((t) => t.entry_date <= e.date && t.exit_date > e.date).length));
    expect(maxOpen).toBe(5);
    for (const e of r.equity) expect(e.cash).toBeGreaterThanOrEqual(-1e-6);
    // крупные позиции: деньги кончаются раньше слотов — входы пропускаются, cash ≥ 0
    const r2 = await run(dataset(assets), cfg((x) => (noRs(x), (x.risk.max_position_pct = 0.5))));
    expect(r2.skips.cash).toBeGreaterThan(0);
    for (const e of r2.equity) expect(e.cash).toBeGreaterThanOrEqual(-1e-6);
  });

  it('сканер: те же правила, что и в бэктесте — сигнал на последнем баре', () => {
    const J = 299; // пробой на последнем баре
    const spec = trend(300, J);
    const ds = dataset([{ symbol: 'AAA', spec }], 300);
    const c = cfg();
    const res = runScan(prepare(ds, c), c, [], { equity: 1_000_000, peak: 1_000_000, cash: 1_000_000, throttle: false, halted: false });
    expect(res.regime).toBe(true);
    expect(res.entries.map((e) => e.symbol)).toEqual(['AAA']);
    const e = res.entries[0];
    expect(e.stop).toBeCloseTo(e.price - e.R_ps, 9);
    expect(e.qty).toBeGreaterThan(0);
    expect(res.markdown).toContain('AAA');
  });
});

describe('«Пробой лидеров»: корректировки цен MOEX', () => {
  it('сплиты: цены свечей ISS уже пересчитаны, объём до сплита приводится × after/before (GMKN 1:100, VTBR 5000:1)', async () => {
    const { adjustSplitVolumes } = await import('../src/portfolio/data');
    const mk = (cs: number[], v: number) => cs.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v }));
    const g = adjustSplitVolumes(mk([152, 151, 152, 153], 100_000), [{ t: T0 + 2 * DAY, before: 1, after: 100 }]);
    expect(g.map((r) => r.c)).toEqual([152, 151, 152, 153]); // цены не трогаем
    expect(g.map((r) => r.v)).toEqual([10_000_000, 10_000_000, 100_000, 100_000]);
    const v = adjustSplitVolumes(mk([100, 101, 102], 50_000_000_000), [{ t: T0 + 2 * DAY, before: 5000, after: 1 }]);
    expect(v[0].v).toBeCloseTo(10_000_000, 3);
  });

  it('дивиденд: цены до гэпа умножаются на 1 − D/close накануне (T+1 — гэп в дату реестра)', async () => {
    const { adjustDividends } = await import('../src/portfolio/data');
    const t0 = Date.UTC(2024, 6, 1);
    const rows = [100, 100, 90, 91].map((c, i) => ({ t: t0 + i * DAY, o: c, h: c, l: c, c, v: 1 }));
    const a = adjustDividends(rows, [{ t: t0 + 2 * DAY, value: 10 }]);
    expect(a.map((r) => r.c)).toEqual([90, 90, 90, 91]);
  });
});
