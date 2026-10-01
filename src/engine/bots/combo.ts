import { getAsset, roundToStep } from '../../data/assets';
import { HOUR } from '../../data/intervals';
import type { Exchange } from '../exchange';
import type { BotLogic, BotState, ComboParams } from './types';

/**
 * Фьючерсный комбо-бот (ребалансировка портфеля перпетуалов):
 * держит лонг/шорт позиции по нескольким монетам с целевыми весами и
 * периодически (по времени или при отклонении весов) возвращает их к цели.
 */

function currentWeights(ex: Exchange, bot: BotState<'futuresCombo'>) {
  const acc = ex.botAccount(bot);
  const notionals = bot.params.legs.map((leg) => {
    const pos = acc.positions[leg.symbol];
    return pos ? Math.abs(pos.size) * ex.price(leg.symbol) : 0;
  });
  const total = notionals.reduce((a, b) => a + b, 0);
  return { notionals, total, weights: notionals.map((n) => (total > 0 ? n / total : 0)) };
}

export interface RebalanceTrade {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  price: number;
  notional: number;
  fee: number;
  /** реализованный PnL (брутто) от сокращения позиции */
  realized: number;
  /** размер позиции до / после (со знаком) */
  sizeBefore: number;
  sizeAfter: number;
}

export interface RebalanceLogEntry {
  t: number;
  reason: 'start' | 'time' | 'threshold';
  equity: number;
  /** макс. отклонение веса от цели перед ребалансировкой, доли */
  maxDev: number;
  weightsBefore: number[];
  weightsAfter: number[];
  trades: RebalanceTrade[];
  fees: number;
  realized: number;
}

const LOG_CAP = 300;
/** Доля капитала, используемая под позиции; остальное — запас под колебания маржи и комиссии. */
export const COMBO_UTILIZATION = 0.9;

function maxDeviation(bot: BotState<'futuresCombo'>, weights: number[]) {
  return Math.max(0, ...bot.params.legs.map((l, i) => Math.abs((weights[i] ?? 0) - l.weight / 100)));
}

function rebalance(ex: Exchange, bot: BotState<'futuresCombo'>, reason: RebalanceLogEntry['reason']) {
  const initial = reason === 'start';
  const p = bot.params;
  const acc = ex.botAccount(bot);
  const equity = ex.equity(acc);
  bot.rt.lastRebalance = ex.now;
  if (equity <= 0) return;
  const before = currentWeights(ex, bot);
  const plans: { symbol: string; diff: number; px: number }[] = [];
  for (const leg of p.legs) {
    const px = ex.price(leg.symbol);
    if (!Number.isFinite(px)) continue;
    const spec = getAsset(leg.symbol);
    const sign = leg.side === 'long' ? 1 : -1;
    const target = roundToStep((sign * equity * COMBO_UTILIZATION * p.leverage * (leg.weight / 100)) / px, spec.qtyStep, 'floor');
    const cur = acc.positions[leg.symbol]?.size ?? 0;
    const diff = target - cur;
    if (Math.abs(diff) < spec.minQty) continue;
    // игнорируем микро-корректировки (< 0.2% капитала)
    if (!initial && Math.abs(diff) * px < equity * 0.002) continue;
    plans.push({ symbol: leg.symbol, diff, px });
  }
  if (!plans.length) return;
  // сначала сокращения (освобождают маржу), затем наращивания
  const reducing = (x: { symbol: string; diff: number }) => {
    const cur = acc.positions[x.symbol]?.size ?? 0;
    return cur !== 0 && Math.sign(cur) !== Math.sign(x.diff);
  };
  plans.sort((a, b) => Number(reducing(b)) - Number(reducing(a)));
  const trades: RebalanceTrade[] = [];
  for (const pl of plans) {
    const sizeBefore = acc.positions[pl.symbol]?.size ?? 0;
    let qty = Math.abs(pl.diff);
    // наращивание позиции ограничиваем доступной маржой (после сокращений других ног)
    if (sizeBefore === 0 || Math.sign(sizeBefore) === Math.sign(pl.diff)) {
      const spec = getAsset(pl.symbol);
      const perUnit = pl.px * (1 / p.leverage + 2 * ex.config.fees.linearTaker);
      const affordable = roundToStep((Math.max(0, ex.available(acc)) * 0.995) / perUnit, spec.qtyStep, 'floor');
      qty = Math.min(qty, affordable);
      if (qty < spec.minQty) continue;
    }
    const execCount = ex.state.executions.length;
    const o = ex.placeOrder({
      accountId: bot.accountId,
      category: 'linear',
      symbol: pl.symbol,
      side: pl.diff > 0 ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty,
      tag: `bot:${bot.id}`,
    });
    if (o.status === 'Rejected') {
      ex.botLog(bot, `${pl.symbol}: ${o.rejectReason}`, 'warn');
      continue;
    }
    const execs = ex.state.executions.slice(execCount).filter((e) => e.orderId === o.id);
    trades.push({
      symbol: pl.symbol,
      side: o.side,
      qty: o.filledQty,
      price: o.avgPrice,
      notional: o.filledQty * o.avgPrice,
      fee: o.cumFee,
      realized: execs.reduce((x, e) => x + e.closedPnl, 0),
      sizeBefore,
      sizeAfter: acc.positions[pl.symbol]?.size ?? 0,
    });
  }
  if (!trades.length) return;
  if (!initial) bot.stats.rebalances++;
  const after = currentWeights(ex, bot);
  const entry: RebalanceLogEntry = {
    t: ex.eventTime(),
    reason,
    equity,
    maxDev: maxDeviation(bot, before.weights),
    weightsBefore: before.weights,
    weightsAfter: after.weights,
    trades,
    fees: trades.reduce((x, t) => x + t.fee, 0),
    realized: trades.reduce((x, t) => x + t.realized, 0),
  };
  const log: RebalanceLogEntry[] = bot.rt.log ?? (bot.rt.log = []);
  log.push(entry);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  if (!initial) {
    const desc = trades.map((t) => `${t.side === 'Buy' ? '+' : '−'}${t.qty} ${getAsset(t.symbol).base}`).join(', ');
    ex.botLog(bot, `ребалансировка №${bot.stats.rebalances}${reason === 'threshold' ? ` (отклонение ${(entry.maxDev * 100).toFixed(1)}%)` : ''}: ${desc}`);
  }
}

/** Текущее состояние для UI: отклонение весов и время до следующей ребалансировки. */
export function comboStatus(ex: Exchange, bot: BotState<'futuresCombo'>) {
  const w = currentWeights(ex, bot);
  const p = bot.params;
  return {
    ...w,
    maxDev: w.total > 0 ? maxDeviation(bot, w.weights) : 0,
    nextAt: p.rebalanceMode === 'time' ? (bot.rt.lastRebalance ?? ex.now) + p.intervalHours * HOUR : null,
    lastAt: (bot.rt.log as RebalanceLogEntry[] | undefined)?.at(-1)?.t ?? null,
  };
}

export const comboLogic: BotLogic<'futuresCombo'> = {
  validate(ex, p: ComboParams, investment) {
    if (!p.legs.length) return 'Добавьте хотя бы одну монету';
    if (p.legs.length > 12) return 'Не более 12 монет';
    const sum = p.legs.reduce((s, l) => s + l.weight, 0);
    if (Math.abs(sum - 100) > 0.5) return `Сумма весов должна быть 100% (сейчас ${sum.toFixed(1)}%)`;
    const seen = new Set<string>();
    for (const leg of p.legs) {
      if (seen.has(leg.symbol)) return `${leg.symbol} указан дважды`;
      seen.add(leg.symbol);
      if (!ex.market.has(leg.symbol)) return `Нет данных по ${leg.symbol} — загрузите символ`;
      if (getAsset(leg.symbol).spotOnly) return `${leg.symbol} торгуется только на споте — в комбо нужны перпетуалы`;
      if (!(leg.weight > 0)) return 'Вес каждой монеты должен быть > 0';
      const max = getAsset(leg.symbol).maxLeverage;
      if (p.leverage > max) return `Плечо ${p.leverage}x превышает максимум ${max}x для ${leg.symbol}`;
    }
    if (!(p.leverage >= 1)) return 'Плечо ≥ 1';
    if (p.rebalanceMode === 'time' && !(p.intervalHours > 0)) return 'Укажите период ребалансировки';
    if (p.rebalanceMode === 'threshold' && !(p.thresholdPct > 0)) return 'Укажите порог отклонения';
    if (investment < 20) return 'Минимальные инвестиции 20 USDT';
    return null;
  },
  start(ex, bot) {
    const p = bot.params;
    bot.symbols = p.legs.map((l) => l.symbol);
    bot.rt = { lastRebalance: ex.now };
    for (const leg of p.legs) {
      const err = ex.setLeverage(bot.accountId, leg.symbol, p.leverage);
      if (err) return ex.stopBot(bot.id, `${leg.symbol}: ${err}`);
    }
    bot.status = 'running';
    bot.startedTime = ex.eventTime();
    rebalance(ex, bot, 'start');
    ex.botLog(bot, `запущен: ${p.legs.map((l) => `${l.side === 'long' ? '▲' : '▼'}${l.symbol} ${l.weight}%`).join(', ')}, ${p.leverage}x`);
  },
  onFill() {},
  onBar(ex, bot) {
    const p = bot.params;
    if (p.tpRoi || p.slRoi) {
      const roi = (ex.equity(ex.botAccount(bot)) / bot.investment - 1) * 100;
      if (p.tpRoi && roi >= p.tpRoi) return ex.stopBot(bot.id, `ROI достиг TP ${p.tpRoi}%`);
      if (p.slRoi && roi <= -Math.abs(p.slRoi)) return ex.stopBot(bot.id, `ROI достиг SL −${Math.abs(p.slRoi)}%`);
    }
    if (p.rebalanceMode === 'time') {
      if (ex.now - (bot.rt.lastRebalance ?? 0) >= p.intervalHours * HOUR) rebalance(ex, bot, 'time');
    } else if (p.rebalanceMode === 'threshold') {
      const { weights, total } = currentWeights(ex, bot);
      if (total <= 0) return;
      if (maxDeviation(bot, weights) * 100 >= p.thresholdPct) rebalance(ex, bot, 'threshold');
    }
  },
};

export { currentWeights as comboWeights };
