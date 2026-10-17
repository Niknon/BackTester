/**
 * Бэктест «Пробоя лидеров» — цикл по барам из раздела 5.7 спецификации.
 * Решения — по закрытию бара t, исполнение — на открытии t+1; внутри дня — только защитные стопы.
 */
import type { LbConfig, Market } from './config';
import { pctRank } from './indicators';
import { addToPosition, buyFill, commission, floorStep, positionSize, riskPerTrade, sellFill, updateGuards, type GuardEvent, type GuardState } from './portfolio';
import { assetFilter, assetIndicators, benchIndicators, entrySignal, manage, rankCandidates, regimeOk, rsScore, type AssetInd, type Bars, type BenchInd } from './rules';

export const DAY = 86_400_000;
export const dayKey = (t: number) => Math.floor(t / DAY);
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface AssetData {
  symbol: string;
  bars: Bars;
  /** шаг количества: 1 акция, лот MOEX, шаг лота биржи */
  step: number;
}

export interface Dataset {
  market: Market;
  benchSymbol: string;
  bench: Bars;
  assets: AssetData[];
  /** предупреждения загрузки (нет данных, не скорректировано и т. п.) */
  warnings: string[];
}

export type ExitReason = 'trail' | 'time' | 'stop_gap' | 'stop' | 'end_of_test';

export interface Trade {
  symbol: string;
  signal_date: string;
  entry_date: string;
  entry_price: number;
  q0: number;
  R_ps: number;
  initial_stop: number;
  add_date: string | null;
  add_price: number | null;
  add_qty: number | null;
  exit_date: string;
  exit_price: number;
  exit_reason: ExitReason;
  pnl: number;
  pnl_R: number;
  bars_held: number;
  /** стоимость счёта на закрытии дня входа (для оценки g в проверке цели) */
  equity_at_entry: number;
}

export interface EquityRow {
  date: string;
  t: number;
  equity: number;
  cash: number;
  exposure: number;
  dd: number;
  throttle: boolean;
  halted: boolean;
}

export interface Decision {
  date: string;
  kind: 'entry' | 'exit' | 'add';
  symbol: string;
  info: string;
}

/** Открытая позиция в формате positions.csv сканера. */
export interface OpenPositionRow {
  symbol: string;
  entry_date: string;
  entry_price: number;
  q0: number;
  qty: number;
  R_ps: number;
  stop: number;
  pyramided: boolean;
}

export interface AccountState {
  equity: number;
  peak: number;
  cash: number;
  throttle: boolean;
  halted: boolean;
}

export interface BacktestResult {
  config: LbConfig;
  market: Market;
  benchSymbol: string;
  trades: Trade[];
  equity: EquityRow[];
  bench: { t: number; v: number }[];
  events: GuardEvent[];
  decisions: Decision[];
  skips: Record<'no_bar' | 'slots' | 'cash' | 'turnover' | 'size', number>;
  warnings: string[];
  universeSize: number;
  /** позиции и счёт перед закрытием в конце теста — для передачи в сканер */
  openAtEnd: OpenPositionRow[];
  accountAtEnd: AccountState;
}

interface Pos {
  a: number; // индекс актива
  symbol: string;
  signalDate: number;
  entryDate: number;
  E: number;
  q0: number;
  qty: number;
  R_ps: number;
  stop: number;
  initialStop: number;
  barsHeld: number;
  reachedMinR: boolean;
  pyramided: boolean;
  addDate: number | null;
  addPrice: number | null;
  addQty: number | null;
  pendingExit: 'trail' | 'time' | null;
  pendingAdd: boolean;
  /** средняя цена позиции (по ценам исполнения) */
  avgCost: number;
  spent: number; // покупки с комиссией
  received: number; // продажи за вычетом комиссии
  equityAtEntry: number;
}

interface PendingEntry {
  a: number;
  signalDate: number;
  R_ps: number;
  equity: number;
  risk: number;
  turnover: number;
}

export interface Prepared {
  dataset: Dataset;
  bench: BenchInd;
  ind: AssetInd[];
}

/** Индикаторы считаются один раз на конфиг (повторные прогоны с тем же конфигом — без пересчёта). */
export function prepare(dataset: Dataset, c: LbConfig): Prepared {
  return { dataset, bench: benchIndicators(dataset.bench, c), ind: dataset.assets.map((x) => assetIndicators(x.bars, c)) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function runBacktest(p: Prepared, c: LbConfig, opts: { onProgress?: (f: number) => void } = {}): Promise<BacktestResult> {
  const { dataset, bench, ind } = p;
  const assets = dataset.assets;
  const n = assets.length;
  const startT = Date.parse(c.start + 'T00:00:00Z');
  const endT = c.end ? Date.parse(c.end + 'T00:00:00Z') + DAY - 1 : Infinity;
  // календарь — дни торгов бенчмарка в периоде теста
  const cal: number[] = [];
  for (let i = 0; i < bench.bars.t.length; i++) if (bench.bars.t[i] >= startT && bench.bars.t[i] <= endT) cal.push(i);
  const res: BacktestResult = {
    config: c,
    market: dataset.market,
    benchSymbol: dataset.benchSymbol,
    trades: [],
    equity: [],
    bench: [],
    events: [],
    decisions: [],
    skips: { no_bar: 0, slots: 0, cash: 0, turnover: 0, size: 0 },
    warnings: [...dataset.warnings],
    universeSize: n,
    openAtEnd: [],
    accountAtEnd: { equity: c.initial_capital, peak: c.initial_capital, cash: c.initial_capital, throttle: false, halted: false },
  };
  if (!cal.length) {
    res.warnings.push('Нет данных бенчмарка за период теста');
    return res;
  }

  let cash = c.initial_capital;
  const guard: GuardState = { peak: c.initial_capital, throttle: false, halted: false };
  const positions: Pos[] = [];
  let pending: PendingEntry[] = [];
  const ptr = new Int32Array(n);
  const today = new Int32Array(n).fill(-1);
  const lastClose = new Float64Array(n).fill(NaN);
  const held = new Uint8Array(n); // есть позиция или отложенный ордер
  const benchStart = bench.bars.c[cal[0]];
  const valA = new Float64Array(n);
  const valB = new Float64Array(n);

  const sell = (pos: Pos, price: number, date: number, reason: ExitReason) => {
    const fill = sellFill(price, c);
    const amount = fill * pos.qty;
    const fee = commission(amount, c);
    cash += amount - fee;
    pos.received += amount - fee;
    const pnl = pos.received - pos.spent;
    res.trades.push({
      symbol: pos.symbol,
      signal_date: isoDay(pos.signalDate),
      entry_date: isoDay(pos.entryDate),
      entry_price: pos.E,
      q0: pos.q0,
      R_ps: pos.R_ps,
      initial_stop: pos.initialStop,
      add_date: pos.addDate === null ? null : isoDay(pos.addDate),
      add_price: pos.addPrice,
      add_qty: pos.addQty,
      exit_date: isoDay(date),
      exit_price: fill,
      exit_reason: reason,
      pnl,
      pnl_R: pnl / (pos.q0 * pos.R_ps),
      // стоп внутри дня — бар выхода тоже удерживался (бар входа = 1); выход на открытии — бар ещё не прожит
      bars_held: reason === 'stop' ? pos.barsHeld + 1 : pos.barsHeld,
      equity_at_entry: pos.equityAtEntry,
    });
    positions.splice(positions.indexOf(pos), 1);
    held[pos.a] = 0;
  };

  for (let k = 0; k < cal.length; k++) {
    const bi = cal[k];
    const D = bench.bars.t[bi];
    const dk = dayKey(D);
    // бары активов на этот день
    for (let a = 0; a < n; a++) {
      const t = assets[a].bars.t;
      while (ptr[a] < t.length && dayKey(t[ptr[a]]) < dk) ptr[a]++;
      today[a] = ptr[a] < t.length && dayKey(t[ptr[a]]) === dk ? ptr[a] : -1;
    }

    /* ── ОТКРЫТИЕ t ── */
    // 1. отложенные выходы (трейлинг, тайм-стоп)
    for (const pos of [...positions]) {
      const i = today[pos.a];
      if (i >= 0 && pos.pendingExit) sell(pos, assets[pos.a].bars.o[i], D, pos.pendingExit);
    }
    // 2. гэп через стоп
    for (const pos of [...positions]) {
      const i = today[pos.a];
      if (i >= 0 && assets[pos.a].bars.o[i] <= pos.stop) sell(pos, assets[pos.a].bars.o[i], D, 'stop_gap');
    }
    // 3. отложенные докупки (приоритет по деньгам перед новыми входами)
    for (const pos of positions) {
      const i = today[pos.a];
      if (i < 0 || !pos.pendingAdd) continue;
      pos.pendingAdd = false;
      const fill = buyFill(assets[pos.a].bars.o[i], c);
      const step = assets[pos.a].step;
      const want = floorStep(c.pyramid.add_fraction * pos.q0, step);
      const byCash = floorStep(cash / (fill * (1 + c.costs.commission_pct)), step);
      const q = Math.min(want, byCash);
      if (!(q > 0)) {
        res.decisions.push({ date: isoDay(D), kind: 'add', symbol: pos.symbol, info: 'докупка не исполнена: нет свободных денег' });
        continue;
      }
      const amount = fill * q;
      const fee = commission(amount, c);
      cash -= amount + fee;
      pos.spent += amount + fee;
      Object.assign(pos, addToPosition(pos, q, fill));
      pos.pyramided = true;
      pos.addDate = D;
      pos.addPrice = fill;
      pos.addQty = q;
    }
    // 4. новые входы в порядке ранга
    for (const e of pending) {
      const i = today[e.a];
      if (i < 0) {
        res.skips.no_bar++;
        held[e.a] = 0;
        continue;
      }
      if (positions.length >= c.risk.max_positions) {
        res.skips.slots++;
        held[e.a] = 0;
        continue;
      }
      const fill = buyFill(assets[e.a].bars.o[i], c);
      const size = positionSize({ equity: e.equity, risk: e.risk, R_ps: e.R_ps, fill, cash, turnover: e.turnover, step: assets[e.a].step }, c);
      if (!(size.q > 0)) {
        res.skips[size.skip ?? 'size']++;
        held[e.a] = 0;
        continue;
      }
      const amount = fill * size.q;
      const fee = commission(amount, c);
      cash -= amount + fee;
      positions.push({
        a: e.a,
        symbol: assets[e.a].symbol,
        signalDate: e.signalDate,
        entryDate: D,
        E: fill,
        q0: size.q,
        qty: size.q,
        R_ps: e.R_ps,
        stop: fill - e.R_ps,
        initialStop: fill - e.R_ps,
        barsHeld: 0,
        reachedMinR: false,
        pyramided: false,
        addDate: null,
        addPrice: null,
        addQty: null,
        pendingExit: null,
        pendingAdd: false,
        avgCost: fill,
        spent: amount + fee,
        received: 0,
        equityAtEntry: NaN,
      });
    }
    pending = [];

    /* ── ВНУТРИ ДНЯ t ── */
    // 5. low <= stop → продать по стопу (в том числе позиции, открытые сегодня)
    for (const pos of [...positions]) {
      const i = today[pos.a];
      if (i >= 0 && assets[pos.a].bars.l[i] <= pos.stop) sell(pos, pos.stop, D, 'stop');
    }

    /* ── ЗАКРЫТИЕ t ── */
    // 6. стоимость счёта, пик, просадка, предохранители
    for (let a = 0; a < n; a++) if (today[a] >= 0) lastClose[a] = assets[a].bars.c[today[a]];
    let mv = 0;
    for (const pos of positions) mv += pos.qty * lastClose[pos.a];
    const equity = cash + mv;
    const { dd } = updateGuards(guard, equity, D, c, res.events);
    for (const pos of positions) if (pos.entryDate === D) pos.equityAtEntry = equity;
    res.equity.push({ date: isoDay(D), t: D, equity, cash, exposure: equity > 0 ? mv / equity : 0, dd, throttle: guard.throttle, halted: guard.halted });
    res.bench.push({ t: D, v: (c.initial_capital * bench.bars.c[bi]) / benchStart });
    const regime = regimeOk(bench, bi, c);

    // 7. сопровождение позиций → отложенные выходы и докупки на t+1
    for (const pos of positions) {
      const i = today[pos.a];
      if (i < 0) continue; // нет бара — по активу ничего не делаем
      pos.barsHeld++;
      if (assets[pos.a].bars.c[i] >= pos.E + c.exits.time_stop_min_r * pos.R_ps) pos.reachedMinR = true;
      const act = manage(pos, ind[pos.a], i, { regime, halted: guard.halted }, c);
      if (act.action === 'exit') {
        pos.pendingExit = act.reason;
        res.decisions.push({ date: isoDay(D), kind: 'exit', symbol: pos.symbol, info: act.reason === 'trail' ? 'трейлинг: close < LL' : 'тайм-стоп' });
      } else if (act.action === 'add') {
        pos.stop = act.newStop;
        pos.pendingAdd = true;
        res.decisions.push({ date: isoDay(D), kind: 'add', symbol: pos.symbol, info: `докупка, стоп ${act.newStop.toFixed(4)}` });
      }
    }

    // 8. новые входы: режим → фильтры → сигнал → ранжирование
    if (regime && !guard.halted && k < cal.length - 1) {
      for (let a = 0; a < n; a++) {
        const i = today[a];
        valA[a] = i >= 0 ? ind[a].retA[i] : NaN;
        valB[a] = i >= 0 ? ind[a].retB[i] : NaN;
      }
      const pA = pctRank(valA);
      const pB = pctRank(valB);
      const cands: { symbol: string; rs: number; volRatio: number; a: number; i: number }[] = [];
      for (let a = 0; a < n; a++) {
        const i = today[a];
        if (i < 0 || held[a]) continue; // 5. нет позиции и отложенного ордера
        if (!assetFilter(ind[a], i, pA[a], pB[a], c) || !entrySignal(ind[a], i, c)) continue;
        cands.push({ symbol: assets[a].symbol, rs: rsScore(pA[a], pB[a]), volRatio: assets[a].bars.v[i] / ind[a].volAvg[i], a, i });
      }
      const slots = c.risk.max_positions - positions.filter((x) => !x.pendingExit).length;
      const risk = riskPerTrade(guard.throttle, c);
      for (const cd of rankCandidates(cands).slice(0, Math.max(0, slots))) {
        const R_ps = c.risk.atr_stop_mult * ind[cd.a].atrRisk[cd.i];
        if (!Number.isFinite(R_ps)) continue;
        pending.push({ a: cd.a, signalDate: D, R_ps, equity, risk, turnover: ind[cd.a].turnover[cd.i] });
        held[cd.a] = 1;
        res.decisions.push({ date: isoDay(D), kind: 'entry', symbol: cd.symbol, info: `rs ${cd.rs.toFixed(3)}, R_ps ${R_ps.toFixed(4)}` });
      }
    }
    for (const pos of positions) held[pos.a] = 1;
    if (k % 250 === 249) {
      opts.onProgress?.(k / cal.length);
      await tick();
    }
  }

  // конец теста: снимок для сканера и закрытие всех позиций по последнему close
  const last = res.equity[res.equity.length - 1];
  res.openAtEnd = positions.map((p) => ({ symbol: p.symbol, entry_date: isoDay(p.entryDate), entry_price: p.E, q0: p.q0, qty: p.qty, R_ps: p.R_ps, stop: p.stop, pyramided: p.pyramided }));
  res.accountAtEnd = { equity: last.equity, peak: guard.peak, cash, throttle: guard.throttle, halted: guard.halted };
  const lastD = last.t;
  for (const pos of [...positions]) sell(pos, lastClose[pos.a], lastD, 'end_of_test');
  last.equity = cash;
  last.cash = cash;
  last.exposure = 0;
  last.dd = cash / Math.max(guard.peak, cash) - 1;
  opts.onProgress?.(1);
  return res;
}
