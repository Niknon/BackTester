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
  bench: EquitySample[];
  bot?: AnyBot;
  closed: ClosedPnlRecord[];
  durationMs: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

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
  if (b.status === 'running' || b.status === 'waiting') ex.stopBot(bot.id, 'Конец периода');
  // финальная точка
  const eq = ex.totalEquity();
  ex.state.equity.push({ t: ex.state.now, main: eq.main, bots: eq.bots, bench: ex.price(syms[0]) });
  const equity = ex.state.equity.map((p) => ({ t: p.t, v: p.main + p.bots }));
  const bench = ex.state.equity.map((p) => ({ t: p.t, v: p.bench }));
  const acc = ex.state.accounts[b.accountId];
  const closed = ex.state.closedPnl.filter((c) => c.accountId === b.accountId);
  opts.onProgress?.(1);
  return {
    ok: true,
    report: computeReport(equity, closed, { fees: acc.stats.fees, funding: acc.stats.funding, bench }),
    equity,
    bench,
    bot: b,
    closed,
    durationMs: performance.now() - t0,
  };
}
