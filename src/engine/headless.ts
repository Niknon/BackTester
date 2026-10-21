import { Exchange, botSymbolsOf } from './exchange';
import type { MarketData } from './market';
import { computeReport, type EquitySample, type PerformanceReport } from './metrics';
import type { AnyBot, BotParamsMap, BotType } from './bots/types';
import type { ClosedPnlRecord, SessionConfig } from './types';

export interface BotBacktestResult {
  ok: boolean;
  error?: string;
  report: PerformanceReport;
  equity: EquitySample[];
  /** с чем сравнивать: у комбо — тот же портфель без ребалансировок (капитал, USDT), у остальных — цена актива */
  bench: EquitySample[];
  benchLabel: string;
  benchHint?: string;
  /** пояснения к расчёту (например, бэктест начат позже из-за начала истории монеты) */
  notes: string[];
  bot?: AnyBot;
  closed: ClosedPnlRecord[];
  durationMs: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Значения ряда src на моменты ряда base (последнее известное к моменту; до начала — первое). */
export function alignTo(base: EquitySample[], src: EquitySample[]): EquitySample[] {
  if (!src.length) return [];
  let j = 0;
  return base.map((p) => {
    while (j + 1 < src.length && src[j + 1].t <= p.t) j++;
    return { t: p.t, v: src[j].v };
  });
}

/**
 * Быстрый бэктест бота на всём периоде сессии (или с указанного бара)
 * в отдельном экземпляре биржи — не влияет на текущую ручную сессию.
 */
export async function runBotBacktest<T extends BotType>(
  market: MarketData,
  base: SessionConfig,
  type: T,
  params: BotParamsMap[T],
  investment: number,
  opts: { fromCursor?: number; onProgress?: (f: number) => void; signal?: { aborted: boolean } } = {},
): Promise<BotBacktestResult> {
  const t0 = performance.now();
  const syms = botSymbolsOf(type, params);
  // монеты бота — сразу в конфиге: по первой из них считается buy&hold (раньше стартовая точка бенчмарка
  // бралась по первому символу сессии: грид на SOL в сессии с BTC показывал «Buy & Hold −99.7%»)
  const config: SessionConfig = { ...base, initialBalance: investment, symbols: syms };
  const ex = Exchange.create(config, market);
  ex.quiet = true;
  ex.activeSymbols = syms;
  const notes: string[] = [];
  const fail = (error: string): BotBacktestResult => ({
    ok: false,
    error,
    report: computeReport([], []),
    equity: [],
    bench: [],
    benchLabel: '',
    notes,
    closed: [],
    durationMs: performance.now() - t0,
  });
  // история какой-то монеты начинается позже: считаем с момента, когда есть цены всех монет бота,
  // иначе годы «пустого» капитала до её листинга искажают CAGR, Шарп и сравнение
  let fromCursor = opts.fromCursor ?? 0;
  const late = syms
    .map((s) => ({ s, t: market.series.get(s)?.length ? market.series.get(s)!.t[0] : Infinity }))
    .filter((x) => x.t + market.dt > market.timeAt(fromCursor))
    .sort((a, b) => b.t - a.t);
  if (late.length) {
    const need = Math.ceil((late[0].t + market.dt - market.start) / market.dt);
    if (need >= market.totalBars) return fail(`Нет истории ${late[0].s} за период сессии`);
    fromCursor = need;
    notes.push(`История ${late.map((x) => `${x.s.replace(/USDT$/, '')} — с ${new Date(x.t).toISOString().slice(0, 10)}`).join(', ')}: бэктест начат с ${new Date(market.timeAt(need)).toISOString().slice(0, 10)}`);
  }
  if (fromCursor) {
    ex.state.cursor = fromCursor;
    ex.state.now = market.timeAt(fromCursor);
    ex.syncPrices();
    // стартовая точка — вложенная сумма до сделок входа (их комиссия входит в результат)
    ex.state.equity = [{ t: ex.state.now, main: investment, bots: 0, bench: ex.price(syms[0]) }];
    ex.state.lastSample = ex.state.now;
  }
  const { bot, error } = ex.createBot(type, 'Бэктест', investment, params);
  if (!bot) return fail(error || 'Ошибка создания бота');
  const total = market.totalBars;
  let slice = performance.now();
  while (!ex.state.finished) {
    ex.step();
    const b = ex.state.bots[bot.id];
    if (b.status !== 'running' && b.status !== 'waiting') {
      // бот остановился (TP/SL/ликвидация) — дальше капитал не меняется
      break;
    }
    if (performance.now() - slice > 30) {
      opts.onProgress?.(ex.state.cursor / total);
      await tick();
      if (opts.signal?.aborted) return fail('Прервано');
      slice = performance.now();
    }
  }
  const b = ex.state.bots[bot.id];
  // конец периода: закрытие по последней цене (с комиссией) и финальная точка капитала
  ex.afterEnd(() => {
    if (b.status === 'running' || b.status === 'waiting') ex.stopBot(bot.id, 'Конец периода');
  });
  const equity = ex.state.equity.map((p) => ({ t: p.t, v: p.main + p.bots }));
  let bench = ex.state.equity.map((p) => ({ t: p.t, v: p.bench }));
  let benchLabel = `${syms[0].replace(/USDT$/, '')} buy&hold`;
  let benchHint: string | undefined;
  // комбо: сравнение с тем же портфелем (монеты, веса, стороны, плечо, TP/SL, комиссии, funding), открытым
  // на старте и без ребалансировок — разница с ним и есть эффект ребалансировки. Цена первой монеты тут ни о чём.
  if (type === 'futuresCombo') {
    const p = params as BotParamsMap['futuresCombo'];
    if (p.rebalanceMode === 'none') bench = equity;
    else {
      const hold = await runBotBacktest(market, base, 'futuresCombo', { ...p, rebalanceMode: 'none' }, investment, {
        fromCursor,
        signal: opts.signal,
      });
      if (!hold.ok) return fail(hold.error || 'Ошибка расчёта портфеля без ребалансировок');
      // тот же отрезок времени, что и у бота: если бот остановился раньше (TP/SL/ликвидация) — сравниваем
      // до момента остановки; если раньше остановился портфель без ребалансировок — дальше он в деньгах
      bench = alignTo(equity, hold.equity);
    }
    benchLabel = 'Без ребалансировок';
    benchHint =
      'Доходность того же портфеля (монеты, веса, стороны, плечо, TP/SL, комиссии, funding), открытого на старте и не ребалансируемого. Разница с ботом — эффект ребалансировки.';
  }
  const acc = ex.state.accounts[b.accountId];
  const closed = ex.state.closedPnl.filter((c) => c.accountId === b.accountId);
  opts.onProgress?.(1);
  return {
    ok: true,
    report: computeReport(equity, closed, { fees: acc.stats.fees, funding: acc.stats.funding, bench }),
    equity,
    bench,
    benchLabel,
    benchHint,
    notes,
    bot: b,
    closed,
    durationMs: performance.now() - t0,
  };
}
