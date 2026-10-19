/**
 * Отчёт бэктеста «Пробоя лидеров» (раздел 6): метрики, проверки, summary.md, trades.csv, equity.csv.
 */
import type { BacktestResult, Trade } from './backtest';
import type { GuardEvent } from './portfolio';

export interface LbMetrics {
  start: string;
  end: string;
  years: number;
  finalEquity: number;
  totalReturn: number;
  cagr: number;
  maxDD: number;
  /** самая длинная просадка (от пика до восстановления или конца теста), дней */
  maxDDDays: number;
  sharpe: number;
  mar: number;
  trades: number;
  tradesPerYear: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  profitFactor: number;
  avgBarsHeld: number;
  avgExposure: number;
  longestLosingStreak: number;
  benchReturn: number;
  benchCagr: number;
  yearly: { year: number; ret: number; bench: number }[];
  monthly: { month: string; ret: number }[];
  /** проверка цели +100% в год */
  g: number;
  nNeed: number | null;
  nFact: number;
  checks: { name: string; pass: boolean; value: string }[];
  exitReasons: Record<string, number>;
}

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

export function computeMetrics(r: BacktestResult): LbMetrics {
  const eq = r.equity;
  const c = r.config;
  const first = eq[0];
  const last = eq[eq.length - 1];
  const years = eq.length > 1 ? (last.t - first.t) / (365.25 * 86_400_000) : 0;
  const finalEquity = last ? last.equity : c.initial_capital;
  const totalReturn = finalEquity / c.initial_capital - 1;
  const cagr = years > 0 ? Math.pow(finalEquity / c.initial_capital, 1 / years) - 1 : NaN;
  // просадка и её длительность
  let peak = c.initial_capital;
  let peakT = first?.t ?? 0;
  let maxDD = 0;
  let maxDDDays = 0;
  for (const e of eq) {
    if (e.equity >= peak) {
      peak = e.equity;
      peakT = e.t;
    } else {
      maxDD = Math.min(maxDD, e.equity / peak - 1);
      maxDDDays = Math.max(maxDDDays, Math.round((e.t - peakT) / 86_400_000));
    }
  }
  // Sharpe по дневным доходностям, безрисковая ставка 0
  const rets: number[] = [];
  let prev = c.initial_capital;
  for (const e of eq) {
    rets.push(e.equity / prev - 1);
    prev = e.equity;
  }
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const periods = r.market === 'crypto' ? 365 : 252;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periods) : NaN;
  // сделки
  const t = r.trades;
  const wins = t.filter((x) => x.pnl > 0);
  const losses = t.filter((x) => x.pnl <= 0);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const grossWin = wins.reduce((s, x) => s + x.pnl, 0);
  const grossLoss = -losses.reduce((s, x) => s + x.pnl, 0);
  let streak = 0;
  let longest = 0;
  for (const x of [...t].sort((a, b) => (a.exit_date < b.exit_date ? -1 : a.exit_date > b.exit_date ? 1 : 0))) {
    streak = x.pnl <= 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  // по годам и месяцам
  const yearly: LbMetrics['yearly'] = [];
  const monthly: LbMetrics['monthly'] = [];
  const bAt = new Map(r.bench.map((b) => [b.t, b.v]));
  let yStart = c.initial_capital;
  let yBench = r.bench[0]?.v ?? c.initial_capital;
  let mStart = c.initial_capital;
  for (let i = 0; i < eq.length; i++) {
    const e = eq[i];
    const next = eq[i + 1];
    const y = e.date.slice(0, 4);
    const m = e.date.slice(0, 7);
    if (!next || next.date.slice(0, 7) !== m) {
      monthly.push({ month: m, ret: e.equity / mStart - 1 });
      mStart = e.equity;
    }
    if (!next || next.date.slice(0, 4) !== y) {
      const bv = bAt.get(e.t) ?? yBench;
      yearly.push({ year: Number(y), ret: e.equity / yStart - 1, bench: bv / yBench - 1 });
      yStart = e.equity;
      yBench = bv;
    }
  }
  const benchLast = r.bench[r.bench.length - 1]?.v ?? c.initial_capital;
  const benchReturn = benchLast / c.initial_capital - 1;
  const benchCagr = years > 0 ? Math.pow(benchLast / c.initial_capital, 1 / years) - 1 : NaN;
  // проверка цели +100% в год: g — средний результат сделки в долях капитала на дату входа
  const gs = t.map((x) => x.pnl / x.equity_at_entry).filter(Number.isFinite);
  const g = avg(gs);
  const nNeed = g > 0 ? Math.log(2) / Math.log(1 + g) : null;
  const nFact = years > 0 ? t.length / years : NaN;
  const expectancyR = avg(t.map((x) => x.pnl_R));
  const v = c.validation;
  const checks = [
    { name: `Матожидание E_R ≥ ${v.min_expectancy_r}`, pass: expectancyR >= v.min_expectancy_r, value: num(expectancyR) },
    { name: `Матожидание E_R ≥ ${v.target_expectancy_r} (уровень для +100%)`, pass: expectancyR >= v.target_expectancy_r, value: num(expectancyR) },
    { name: `Макс. просадка ≤ ${pct(v.max_drawdown, 0)}`, pass: -maxDD <= v.max_drawdown, value: pct(maxDD) },
  ];
  const exitReasons: Record<string, number> = {};
  for (const x of t) exitReasons[x.exit_reason] = (exitReasons[x.exit_reason] ?? 0) + 1;
  return {
    start: first?.date ?? '',
    end: last?.date ?? '',
    years,
    finalEquity,
    totalReturn,
    cagr,
    maxDD,
    maxDDDays,
    sharpe,
    mar: maxDD < 0 ? cagr / -maxDD : NaN,
    trades: t.length,
    tradesPerYear: nFact,
    winRate: t.length ? wins.length / t.length : NaN,
    avgWinR: avg(wins.map((x) => x.pnl_R)),
    avgLossR: avg(losses.map((x) => x.pnl_R)),
    expectancyR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : NaN,
    avgBarsHeld: avg(t.map((x) => x.bars_held)),
    avgExposure: avg(eq.map((e) => e.exposure)),
    longestLosingStreak: longest,
    benchReturn,
    benchCagr,
    yearly,
    monthly,
    g,
    nNeed,
    nFact,
    checks,
    exitReasons,
  };
}

export const EVENT_LABEL: Record<GuardEvent['kind'], string> = {
  throttle_on: 'троттлинг включён (риск на сделку снижен)',
  throttle_off: 'троттлинг выключен (новый пик)',
  halt: 'остановка: новых входов и докупок нет до конца теста',
  max_dd_logged: 'просадка ниже лимита (только запись, max_dd_action = log_only)',
};

const EXIT_LABEL: Record<string, string> = { trail: 'трейлинг', time: 'тайм-стоп', stop_gap: 'гэп через стоп', stop: 'стоп', end_of_test: 'конец теста' };

/** Предупреждения отчёта: ошибка выжившего и проблемы данных. */
export function reportWarnings(r: BacktestResult, universeIsDefault: boolean): string[] {
  const w = [...r.warnings];
  if (universeIsDefault)
    w.unshift('Вселенная — текущий состав индекса: компании, выбывшие из него за период теста, не учтены, поэтому результат завышен ошибкой выжившего.');
  return w;
}

export function summaryMarkdown(r: BacktestResult, m: LbMetrics, warnings: string[]): string {
  const c = r.config;
  const L: string[] = [];
  L.push(`# «Пробой лидеров» — отчёт бэктеста`, '');
  L.push(`Рынок: **${c.market}**, вселенная: ${r.universeSize} активов, бенчмарк: ${r.benchSymbol}`);
  L.push(`Период: ${m.start} — ${m.end} (${m.years.toFixed(1)} лет), стартовый капитал: ${c.initial_capital.toLocaleString('ru-RU')}`, '');
  L.push('## Проверки', '');
  for (const ch of m.checks) L.push(`- ${ch.pass ? '✅' : '❌'} ${ch.name}: ${ch.value}`);
  L.push('', '## Метрики', '');
  L.push('| Метрика | Значение |', '|---|---|');
  const rows: [string, string][] = [
    ['Итоговый капитал', m.finalEquity.toLocaleString('ru-RU', { maximumFractionDigits: 0 })],
    ['Итоговая доходность', pct(m.totalReturn)],
    ['CAGR', pct(m.cagr, 2)],
    ['Макс. просадка', pct(m.maxDD)],
    ['Длительность макс. просадки', `${m.maxDDDays} дн.`],
    ['Sharpe (безрисковая ставка 0)', num(m.sharpe)],
    ['MAR = CAGR / MaxDD', num(m.mar)],
    ['Бенчмарк (buy & hold): доходность / CAGR', `${pct(m.benchReturn)} / ${pct(m.benchCagr, 2)}`],
    ['Сделок всего / в год', `${m.trades} / ${num(m.tradesPerYear, 1)}`],
    ['Win rate', pct(m.winRate)],
    ['Средняя прибыль / средний убыток, R', `${num(m.avgWinR)} / ${num(m.avgLossR)}`],
    ['Матожидание E_R', num(m.expectancyR)],
    ['Profit factor', num(m.profitFactor)],
    ['Среднее удержание, баров', num(m.avgBarsHeld, 1)],
    ['Средняя загрузка капитала', pct(m.avgExposure)],
    ['Самая длинная серия убытков', String(m.longestLosingStreak)],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push('', '## Проверка цели +100% в год', '');
  L.push(`- g (средний результат сделки в долях капитала на дату входа) = ${pct(m.g, 3)}`);
  L.push(m.nNeed === null ? '- N_need: цель недостижима (g ≤ 0)' : `- N_need = ln(2) / ln(1 + g) = ${num(m.nNeed, 1)} сделок в год`);
  L.push(`- N_fact = ${num(m.nFact, 1)} сделок в год`);
  L.push('', '## Причины выхода', '');
  for (const [k, v] of Object.entries(m.exitReasons)) L.push(`- ${EXIT_LABEL[k] ?? k}: ${v}`);
  const sk = r.skips;
  L.push(`- пропущено входов: нет бара ${sk.no_bar}, нет слота ${sk.slots}, нет денег ${sk.cash}, мал оборот ${sk.turnover}, размер 0 ${sk.size}`);
  L.push('', '## Доходность по годам', '', '| Год | Стратегия | Бенчмарк |', '|---|---|---|');
  for (const y of m.yearly) L.push(`| ${y.year} | ${pct(y.ret)} | ${pct(y.bench)} |`);
  L.push('', '## Доходность по месяцам', '', '| Месяц | Доходность |', '|---|---|');
  for (const x of m.monthly) L.push(`| ${x.month} | ${pct(x.ret)} |`);
  L.push('', '## Предохранители счёта', '');
  if (!r.events.length) L.push('- не срабатывали');
  for (const e of r.events) L.push(`- ${new Date(e.date).toISOString().slice(0, 10)}: ${EVENT_LABEL[e.kind]} (капитал ${e.equity.toFixed(0)}, просадка ${pct(e.dd)})`);
  L.push('', '## Предупреждения', '');
  if (!warnings.length) L.push('- нет');
  for (const w of warnings) L.push(`- ${w}`);
  if (r.notes?.length) {
    L.push('', '## Данные', '');
    for (const n of r.notes) L.push(`- ${n}`);
  }
  return L.join('\n') + '\n';
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(Number(v.toPrecision(12))) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const TRADE_COLUMNS = ['symbol', 'signal_date', 'entry_date', 'entry_price', 'q0', 'R_ps', 'initial_stop', 'add_date', 'add_price', 'add_qty', 'exit_date', 'exit_price', 'exit_reason', 'pnl', 'pnl_R', 'bars_held'] as const;

export function tradesCsv(trades: Trade[]): string {
  return [TRADE_COLUMNS.join(','), ...trades.map((t) => TRADE_COLUMNS.map((k) => csvCell(t[k])).join(','))].join('\n') + '\n';
}

export function equityCsv(r: BacktestResult): string {
  return ['date,equity,cash,exposure,dd,throttle,halted', ...r.equity.map((e) => [e.date, e.equity, e.cash, e.exposure, e.dd, e.throttle, e.halted].map(csvCell).join(','))].join('\n') + '\n';
}
