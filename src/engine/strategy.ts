import { getAsset, roundToStep } from '../data/assets';
import { intervalMs } from '../data/intervals';
import type { IntervalKey } from '../data/types';
import * as ind from '../indicators';
import { aggregate, type Ohlcv } from './aggregate';
import { Exchange, MAIN } from './exchange';
import type { MarketData } from './market';
import { computeReport, type EquitySample, type PerformanceReport } from './metrics';
import type { ClosedPnlRecord, Execution, SessionConfig } from './types';

/* ───────────────────────── Компиляция ───────────────────────── */

export type ParamValue = number | string | boolean;

export interface CompiledStrategy {
  PARAMS: Record<string, ParamValue>;
  init: ((ctx: any, params: any) => void) | null;
  onBar: ((ctx: any, params: any) => void) | null;
}

export function compileStrategy(code: string): CompiledStrategy {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `"use strict";\n${code}\n;return {` +
      `PARAMS: typeof PARAMS !== "undefined" ? PARAMS : {},` +
      `init: typeof init === "function" ? init : null,` +
      `onBar: typeof onBar === "function" ? onBar : null };`,
  );
  const res = factory() as CompiledStrategy;
  if (!res.onBar) throw new Error('В стратегии должна быть функция onBar(ctx, params)');
  return res;
}

/* ───────────────────────── Результат ───────────────────────── */

export interface PlotSeries {
  color?: string;
  pane: 'price' | 'sub';
  points: { t: number; v: number }[];
}

export interface StrategyResult {
  ok: boolean;
  error?: string;
  report: PerformanceReport;
  equity: EquitySample[];
  bench: EquitySample[];
  closed: ClosedPnlRecord[];
  executions: Execution[];
  logs: { t: number; msg: string }[];
  plots: Record<string, PlotSeries>;
  params: Record<string, ParamValue>;
  durationMs: number;
  bars: number;
}

export interface StrategyConfig {
  code: string;
  symbol: string;
  timeframe: IntervalKey;
  params?: Record<string, ParamValue>;
  initialBalance?: number;
}

export interface RunOptions {
  onProgress?: (frac: number) => void;
  signal?: { aborted: boolean };
  /** бюджет времени на синхронный кусок, мс */
  sliceMs?: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* ───────────────────────── Контекст стратегии ───────────────────────── */

function buildContext(ex: Exchange, symbol: string, agg: Ohlcv, tfMs: number, sink: { logs: StrategyResult['logs']; plots: StrategyResult['plots'] }) {
  const cache = new Map<string, any>();
  const acc = ex.main;
  const spec = getAsset(symbol);
  let idx = -1;
  const src = (name: string): number[] => {
    switch (name) {
      case 'open':
        return agg.o;
      case 'high':
        return agg.h;
      case 'low':
        return agg.l;
      case 'volume':
        return agg.v;
      case 'hl2':
        return memo('hl2', () => agg.h.map((h, i) => (h + agg.l[i]) / 2));
      case 'hlc3':
        return memo('hlc3', () => agg.h.map((h, i) => (h + agg.l[i] + agg.c[i]) / 3));
      default:
        return agg.c;
    }
  };
  function memo<T>(key: string, fn: () => T): T {
    let v = cache.get(key);
    if (v === undefined) {
      v = fn();
      cache.set(key, v);
    }
    return v;
  }
  const at = (arr: number[], offset = 0) => {
    const i = idx - offset;
    return i >= 0 && i < arr.length ? arr[i] : NaN;
  };
  const ta = {
    sma: (p: number, off = 0, s = 'close') => at(memo(`sma${p}${s}`, () => ind.sma(src(s), p)), off),
    ema: (p: number, off = 0, s = 'close') => at(memo(`ema${p}${s}`, () => ind.ema(src(s), p)), off),
    wma: (p: number, off = 0, s = 'close') => at(memo(`wma${p}${s}`, () => ind.wma(src(s), p)), off),
    rsi: (p = 14, off = 0, s = 'close') => at(memo(`rsi${p}${s}`, () => ind.rsi(src(s), p)), off),
    atr: (p = 14, off = 0) => at(memo(`atr${p}`, () => ind.atr(agg.h, agg.l, agg.c, p)), off),
    highest: (p: number, off = 0, s = 'high') => at(memo(`hh${p}${s}`, () => ind.highest(src(s), p)), off),
    lowest: (p: number, off = 0, s = 'low') => at(memo(`ll${p}${s}`, () => ind.lowest(src(s), p)), off),
    cci: (p = 20, off = 0) => at(memo(`cci${p}`, () => ind.cci(agg.h, agg.l, agg.c, p)), off),
    obv: (off = 0) => at(memo('obv', () => ind.obv(agg.c, agg.v)), off),
    vwap: (off = 0) => at(memo('vwap', () => ind.vwap(agg.t, agg.h, agg.l, agg.c, agg.v)), off),
    bb: (p = 20, mult = 2, off = 0) => {
      const b = memo(`bb${p}_${mult}`, () => ind.bollinger(agg.c, p, mult));
      return { upper: at(b.upper, off), middle: at(b.middle, off), lower: at(b.lower, off) };
    },
    macd: (f = 12, sl = 26, sig = 9, off = 0) => {
      const m = memo(`macd${f}_${sl}_${sig}`, () => ind.macd(agg.c, f, sl, sig));
      return { macd: at(m.macd, off), signal: at(m.signal, off), hist: at(m.hist, off) };
    },
    stoch: (k = 14, d = 3, smooth = 3, off = 0) => {
      const st = memo(`stoch${k}_${d}_${smooth}`, () => ind.stoch(agg.h, agg.l, agg.c, k, d, smooth));
      return { k: at(st.k, off), d: at(st.d, off) };
    },
    supertrend: (p = 10, mult = 3, off = 0) => {
      const st = memo(`st${p}_${mult}`, () => ind.supertrend(agg.h, agg.l, agg.c, p, mult));
      return { value: at(st.value, off), dir: at(st.dir, off) };
    },
    adx: (p = 14, off = 0) => {
      const a = memo(`adx${p}`, () => ind.adx(agg.h, agg.l, agg.c, p));
      return { adx: at(a.adx, off), plusDI: at(a.plusDI, off), minusDI: at(a.minusDI, off) };
    },
    donchian: (p = 20, off = 0) => {
      const d = memo(`dc${p}`, () => ind.donchian(agg.h, agg.l, p));
      return { upper: at(d.upper, off), middle: at(d.middle, off), lower: at(d.lower, off) };
    },
    crossover: (a0: number, a1: number, b0: number, b1: number) => a1 <= b1 && a0 > b0,
    crossunder: (a0: number, a1: number, b0: number, b1: number) => a1 >= b1 && a0 < b0,
  };

  const lev = () => ex.leverageOf(acc, symbol);
  const resolveQty = (q: any, side: 'Buy' | 'Sell'): { qty: number; opts: any } => {
    let opts: any = {};
    let qty: number | undefined;
    if (typeof q === 'number') qty = q;
    else if (q && typeof q === 'object') opts = q;
    if (opts.qty !== undefined) qty = opts.qty;
    const px = opts.price ?? ex.price(symbol);
    if (qty === undefined) {
      if (opts.usdt !== undefined) qty = opts.usdt / px;
      else {
        const pct = (opts.percent ?? 100) / 100;
        const pos = acc.positions[symbol];
        // при развороте учитываем закрываемую позицию
        const closing = pos && Math.sign(pos.size) === (side === 'Buy' ? -1 : 1) ? Math.abs(pos.size) : 0;
        const avail = Math.max(0, ex.available(acc));
        // та же формула стоимости, что и при проверке маржи биржей: IM + комиссии открытия/закрытия
        const perUnit = px * (1 / lev() + 2 * ex.config.fees.linearTaker);
        qty = (avail * pct * 0.995) / perUnit + closing;
      }
    }
    return { qty: roundToStep(qty, spec.qtyStep, 'floor'), opts };
  };
  const order = (side: 'Buy' | 'Sell', q: any) => {
    const { qty, opts } = resolveQty(q, side);
    if (!(qty >= spec.minQty)) return null;
    const o = ex.placeOrder({
      category: 'linear',
      symbol,
      side,
      orderType: opts.type === 'limit' || opts.price ? 'Limit' : 'Market',
      price: opts.price,
      qty,
      reduceOnly: !!opts.reduceOnly,
      triggerPrice: opts.stop,
      takeProfit: opts.tp,
      stopLoss: opts.sl,
      tag: 'strategy',
    });
    if (o.status === 'Rejected') sink.logs.push({ t: agg.t[idx], msg: `Ордер отклонён: ${o.rejectReason}` });
    return o.id;
  };
  const ctx = {
    symbol,
    state: {} as Record<string, any>,
    ta,
    get index() {
      return idx;
    },
    get time() {
      return agg.t[idx];
    },
    get open() {
      return agg.o[idx];
    },
    get high() {
      return agg.h[idx];
    },
    get low() {
      return agg.l[idx];
    },
    get close() {
      return agg.c[idx];
    },
    get volume() {
      return agg.v[idx];
    },
    get price() {
      return ex.price(symbol);
    },
    bar(offset = 0) {
      const i = idx - offset;
      if (i < 0) return null;
      return { time: agg.t[i], open: agg.o[i], high: agg.h[i], low: agg.l[i], close: agg.c[i], volume: agg.v[i] };
    },
    value(name = 'close', offset = 0) {
      return at(src(name), offset);
    },
    get position() {
      const p = acc.positions[symbol];
      if (!p || p.size === 0) return { size: 0, side: null, avgPrice: 0, pnl: 0, liqPrice: null };
      return {
        size: p.size,
        side: p.size > 0 ? 'long' : 'short',
        avgPrice: p.avgPrice,
        pnl: ex.unrealisedPnl(p),
        liqPrice: ex.liqPrice(acc, p),
      };
    },
    get equity() {
      return ex.equity(acc);
    },
    get available() {
      return ex.available(acc);
    },
    get balance() {
      return acc.walletBalance;
    },
    get leverage() {
      return lev();
    },
    buy: (q?: any) => order('Buy', q),
    sell: (q?: any) => order('Sell', q),
    long(q?: any) {
      const p = acc.positions[symbol];
      if (p && p.size > 0) return null;
      if (p && p.size < 0) ex.closePosition(MAIN, symbol);
      return order('Buy', q);
    },
    short(q?: any) {
      const p = acc.positions[symbol];
      if (p && p.size < 0) return null;
      if (p && p.size > 0) ex.closePosition(MAIN, symbol);
      return order('Sell', q);
    },
    /** закрыть позицию (частично — percent) */
    exit(percent = 100) {
      const p = acc.positions[symbol];
      if (!p || p.size === 0) return null;
      const qty = roundToStep((Math.abs(p.size) * percent) / 100, spec.qtyStep, 'floor');
      if (qty < spec.minQty) return null;
      return ex.placeOrder({ category: 'linear', symbol, side: p.size > 0 ? 'Sell' : 'Buy', orderType: 'Market', qty, reduceOnly: true, tag: 'strategy' }).id;
    },
    cancelAll() {
      ex.cancelAll(MAIN, symbol);
    },
    setLeverage(n: number) {
      const err = ex.setLeverage(MAIN, symbol, n);
      if (err) sink.logs.push({ t: agg.t[Math.max(0, idx)] ?? 0, msg: err });
    },
    setMarginMode(mode: 'cross' | 'isolated') {
      ex.setMarginMode(MAIN, symbol, mode);
    },
    setTpSl(p: { tp?: number | null; sl?: number | null; trailing?: number | null }) {
      const err = ex.setTradingStop(MAIN, symbol, { takeProfit: p.tp, stopLoss: p.sl, trailingStop: p.trailing });
      if (err) sink.logs.push({ t: agg.t[idx], msg: `TP/SL: ${err}` });
    },
    log(...args: any[]) {
      if (sink.logs.length < 5000)
        sink.logs.push({ t: agg.t[Math.max(0, idx)] ?? 0, msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
    },
    plot(name: string, value: number, opts: { color?: string; pane?: 'price' | 'sub' } = {}) {
      if (!Number.isFinite(value)) return;
      let p = sink.plots[name];
      if (!p) p = sink.plots[name] = { color: opts.color, pane: opts.pane ?? 'price', points: [] };
      p.points.push({ t: agg.t[idx], v: value });
    },
  };
  return {
    ctx,
    setIndex(i: number) {
      idx = i;
    },
  };
}

/* ───────────────────────── Прогон ───────────────────────── */

export async function runStrategy(market: MarketData, base: SessionConfig, cfg: StrategyConfig, opts: RunOptions = {}): Promise<StrategyResult> {
  const t0 = performance.now();
  const sink = { logs: [] as StrategyResult['logs'], plots: {} as StrategyResult['plots'] };
  const empty = (error: string): StrategyResult => ({
    ok: false,
    error,
    report: computeReport([], []),
    equity: [],
    bench: [],
    closed: [],
    executions: [],
    logs: sink.logs,
    plots: sink.plots,
    params: cfg.params ?? {},
    durationMs: performance.now() - t0,
    bars: 0,
  });
  let compiled: CompiledStrategy;
  try {
    compiled = compileStrategy(cfg.code);
  } catch (e: any) {
    return empty(`Ошибка компиляции: ${e?.message || e}`);
  }
  const series = market.series.get(cfg.symbol);
  if (!series) return empty(`Нет данных по ${cfg.symbol}`);
  const tfMs = intervalMs(cfg.timeframe);
  if (tfMs < market.dt || tfMs % market.dt !== 0) return empty('Таймфрейм стратегии должен быть кратен базовому интервалу');
  const params = { ...compiled.PARAMS, ...(cfg.params ?? {}) };
  const config: SessionConfig = {
    ...base,
    initialBalance: cfg.initialBalance ?? base.initialBalance,
    symbols: [cfg.symbol],
  };
  const ex = Exchange.create(config, market);
  ex.quiet = true;
  ex.activeSymbols = [cfg.symbol];
  const agg = aggregate(series, tfMs);
  const { ctx, setIndex } = buildContext(ex, cfg.symbol, agg, tfMs, sink);
  let closed = 0;
  while (closed < agg.t.length && agg.t[closed] + tfMs <= ex.now) closed++;
  setIndex(closed - 1);
  const bench: EquitySample[] = [];
  try {
    compiled.init?.(ctx, params);
    const total = market.totalBars;
    const slice = opts.sliceMs ?? 30;
    let sliceStart = performance.now();
    while (!ex.state.finished) {
      ex.step();
      while (closed < agg.t.length && agg.t[closed] + tfMs <= ex.now) {
        closed++;
        setIndex(closed - 1);
        compiled.onBar!(ctx, params);
      }
      if (performance.now() - sliceStart > slice) {
        opts.onProgress?.(ex.state.cursor / total);
        await tick();
        if (opts.signal?.aborted) return empty('Прервано');
        sliceStart = performance.now();
      }
    }
  } catch (e: any) {
    const r = empty(`Ошибка выполнения на свече ${new Date(agg.t[Math.max(0, closed - 1)] ?? 0).toISOString()}: ${e?.message || e}`);
    return r;
  }
  // закрываем позицию по последней цене для честной статистики
  const pos = ex.main.positions[cfg.symbol];
  if (pos && pos.size !== 0) ex.closePosition(MAIN, cfg.symbol);
  const equity = ex.state.equity.map((p) => ({ t: p.t, v: p.main }));
  for (const p of ex.state.equity) bench.push({ t: p.t, v: p.bench });
  const closedRecs = ex.state.closedPnl.filter((c) => c.accountId === MAIN);
  const report = computeReport(equity, closedRecs, { fees: ex.main.stats.fees, funding: ex.main.stats.funding, bench });
  opts.onProgress?.(1);
  return {
    ok: true,
    report,
    equity,
    bench,
    closed: closedRecs,
    executions: ex.state.executions.filter((e) => e.accountId === MAIN),
    logs: sink.logs,
    plots: sink.plots,
    params,
    durationMs: performance.now() - t0,
    bars: market.totalBars,
  };
}

/* ───────────────────────── Оптимизация параметров ───────────────────────── */

export interface OptimizeRange {
  from: number;
  to: number;
  step: number;
}

export interface OptimizeRow {
  params: Record<string, ParamValue>;
  report: PerformanceReport;
  error?: string;
}

export function expandGrid(ranges: Record<string, OptimizeRange>, limit = 500): Record<string, number>[] {
  let combos: Record<string, number>[] = [{}];
  for (const [name, r] of Object.entries(ranges)) {
    const vals: number[] = [];
    if (!(r.step > 0) || r.to < r.from) vals.push(r.from);
    else for (let v = r.from; v <= r.to + 1e-9 && vals.length < 200; v += r.step) vals.push(Number(v.toPrecision(10)));
    const next: Record<string, number>[] = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [name]: v });
    combos = next;
    if (combos.length > limit) return combos.slice(0, limit);
  }
  return combos;
}

export async function optimizeStrategy(
  market: MarketData,
  base: SessionConfig,
  cfg: StrategyConfig,
  ranges: Record<string, OptimizeRange>,
  opts: { onProgress?: (done: number, total: number, row?: OptimizeRow) => void; signal?: { aborted: boolean } } = {},
): Promise<OptimizeRow[]> {
  const combos = expandGrid(ranges);
  const rows: OptimizeRow[] = [];
  for (let i = 0; i < combos.length; i++) {
    if (opts.signal?.aborted) break;
    const res = await runStrategy(market, base, { ...cfg, params: { ...(cfg.params ?? {}), ...combos[i] } }, { sliceMs: 40, signal: opts.signal });
    const row: OptimizeRow = { params: res.params, report: res.report, error: res.ok ? undefined : res.error };
    rows.push(row);
    opts.onProgress?.(i + 1, combos.length, row);
  }
  return rows;
}

/* ───────────────────────── Примеры стратегий ───────────────────────── */

export const STRATEGY_TEMPLATES: { name: string; code: string }[] = [
  {
    name: 'Пересечение EMA',
    code: `// Пересечение быстрой и медленной EMA. Разворот позиции по сигналу.
const PARAMS = { fast: 12, slow: 26, leverage: 3, risk: 50 };

function init(ctx, p) {
  ctx.setLeverage(p.leverage);
}

function onBar(ctx, p) {
  const f0 = ctx.ta.ema(p.fast), f1 = ctx.ta.ema(p.fast, 1);
  const s0 = ctx.ta.ema(p.slow), s1 = ctx.ta.ema(p.slow, 1);
  ctx.plot('EMA fast', f0, { color: '#f7a600' });
  ctx.plot('EMA slow', s0, { color: '#4d8dff' });
  if (ctx.ta.crossover(f0, f1, s0, s1)) ctx.long({ percent: p.risk });
  if (ctx.ta.crossunder(f0, f1, s0, s1)) ctx.short({ percent: p.risk });
}
`,
  },
  {
    name: 'RSI возврат к среднему',
    code: `// Покупка при перепроданности RSI, выход по TP/SL (в % от входа).
const PARAMS = { period: 14, oversold: 30, overbought: 70, tp: 3, sl: 2, leverage: 2 };

function init(ctx, p) { ctx.setLeverage(p.leverage); }

function onBar(ctx, p) {
  const r = ctx.ta.rsi(p.period);
  ctx.plot('RSI', r, { pane: 'sub', color: '#a78bfa' });
  const pos = ctx.position;
  if (pos.size === 0 && r < p.oversold) {
    const px = ctx.close;
    ctx.buy({ percent: 90, tp: px * (1 + p.tp / 100), sl: px * (1 - p.sl / 100) });
  } else if (pos.size > 0 && r > p.overbought) {
    ctx.exit();
  }
}
`,
  },
  {
    name: 'Пробой Дончиана + ATR-стоп',
    code: `// Пробой канала Дончиана, трейлинг-стоп на расстоянии k×ATR.
const PARAMS = { channel: 20, atr: 14, k: 2.5, leverage: 3, risk: 60 };

function init(ctx, p) { ctx.setLeverage(p.leverage); }

function onBar(ctx, p) {
  const dc = ctx.ta.donchian(p.channel, 1); // канал предыдущей свечи
  const a = ctx.ta.atr(p.atr);
  ctx.plot('DC upper', dc.upper, { color: '#20b26c' });
  ctx.plot('DC lower', dc.lower, { color: '#ef454a' });
  const pos = ctx.position;
  if (pos.size === 0) {
    if (ctx.close > dc.upper) { ctx.buy({ percent: p.risk }); ctx.setTpSl({ trailing: p.k * a }); }
    else if (ctx.close < dc.lower) { ctx.sell({ percent: p.risk }); ctx.setTpSl({ trailing: p.k * a }); }
  }
}
`,
  },
  {
    name: 'Supertrend',
    code: `// Следование тренду по индикатору Supertrend.
const PARAMS = { period: 10, mult: 3, leverage: 2 };

function init(ctx, p) { ctx.setLeverage(p.leverage); }

function onBar(ctx, p) {
  const st = ctx.ta.supertrend(p.period, p.mult);
  const prev = ctx.ta.supertrend(p.period, p.mult, 1);
  ctx.plot('Supertrend', st.value, { color: st.dir > 0 ? '#20b26c' : '#ef454a' });
  if (st.dir > 0 && prev.dir < 0) ctx.long({ percent: 90 });
  if (st.dir < 0 && prev.dir > 0) ctx.short({ percent: 90 });
}
`,
  },
  {
    name: 'Bollinger + MACD фильтр',
    code: `// Лонг от нижней полосы Боллинджера, если гистограмма MACD растёт.
const PARAMS = { period: 20, mult: 2, leverage: 3 };

function init(ctx, p) { ctx.setLeverage(p.leverage); }

function onBar(ctx, p) {
  const bb = ctx.ta.bb(p.period, p.mult);
  const m0 = ctx.ta.macd().hist, m1 = ctx.ta.macd(12, 26, 9, 1).hist;
  ctx.plot('BB up', bb.upper, { color: '#6b7280' });
  ctx.plot('BB low', bb.lower, { color: '#6b7280' });
  const pos = ctx.position;
  if (pos.size === 0 && ctx.close < bb.lower && m0 > m1) ctx.buy({ percent: 80, sl: ctx.close * 0.97 });
  if (pos.size > 0 && ctx.close > bb.middle) ctx.exit();
}
`,
  },
];
