import { Exchange } from './exchange';
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
  const config: SessionConfig = { ...base, initialBalance: investment };
  const ex = Exchange.create(config, market);
  ex.quiet = true;
  const syms =
    type === 'futuresCombo' ? (params as BotParamsMap['futuresCombo']).legs.map((l) => l.symbol) : [(params as any).symbol as string];
  ex.activeSymbols = syms;
  ex.state.config = { ...config, symbols: syms };
  if (opts.fromCursor) {
    ex.state.cursor = opts.fromCursor;
    ex.state.now = market.timeAt(opts.fromCursor);
    ex.state.equity = [];
    ex.syncPrices();
  }
  const fail = (error: string): BotBacktestResult => ({
    ok: false,
    error,
    report: computeReport([], []),
    equity: [],
    bench: [],
    benchLabel: '',
    closed: [],
    durationMs: performance.now() - t0,
  });
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
        fromCursor: opts.fromCursor,
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
    bot: b,
    closed,
    durationMs: performance.now() - t0,
  };
}
