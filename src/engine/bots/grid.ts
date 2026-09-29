import { getAsset, roundToStep, spotQtyStep } from '../../data/assets';
import type { Exchange } from '../exchange';
import type { Execution, Order } from '../types';
import type { BotLogic, BotState, FuturesGridParams, GridMode, SpotGridParams } from './types';

/** Уровни сетки: grids интервалов → grids + 1 цен. */
export function gridLevels(lower: number, upper: number, grids: number, mode: GridMode, tick: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= grids; i++) {
    const p = mode === 'geometric' ? lower * (upper / lower) ** (i / grids) : lower + ((upper - lower) * i) / grids;
    out.push(roundToStep(p, tick));
  }
  return out;
}

/** Уровень, ближайший к цене (на нём ордер не выставляется). */
function emptyIndex(levels: number[], price: number) {
  let best = 0;
  for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i] - price) < Math.abs(levels[best] - price)) best = i;
  return best;
}

function validateGrid(
  ex: Exchange,
  p: { symbol: string; lower: number; upper: number; grids: number },
  feeRate: number,
  investment: number,
  leverage: number,
  minQty: number,
): string | null {
  if (!ex.market.has(p.symbol)) return `Нет данных по ${p.symbol}`;
  if (!(p.lower > 0) || !(p.upper > p.lower)) return 'Верхняя граница должна быть больше нижней';
  if (!(p.grids >= 2 && p.grids <= 300)) return 'Число сеток: от 2 до 300';
  const stepPct = (p.upper / p.lower) ** (1 / p.grids) - 1;
  if (stepPct <= 2 * feeRate) return `Шаг сетки ${(stepPct * 100).toFixed(3)}% не покрывает комиссии (${(2 * feeRate * 100).toFixed(2)}%) — уменьшите число сеток`;
  const mid = Math.sqrt(p.lower * p.upper);
  const q = (investment * leverage * 0.9) / (p.grids * mid);
  if (q < minQty) {
    const need = Math.ceil((minQty * p.grids * mid) / (leverage * 0.9));
    return `Слишком мало инвестиций на ${p.grids} сеток: объём уровня ${q.toPrecision(3)} < мин. ${minQty}. Нужно ≈${need} USDT или меньше сеток`;
  }
  return null;
}

/* ───────────────────────── Общая логика «встречных» ордеров ───────────────────────── */

interface GridRt {
  levels: number[];
  q: number;
  /** orderId → индекс уровня */
  lv: Record<string, number>;
  /** orderId → является ли ордер закрывающим (арбитраж) */
  counter: Record<string, boolean>;
  triggerFrom?: number;
  launched?: boolean;
  pend?: [number, boolean];
}

function placeGridOrder(
  ex: Exchange,
  bot: BotState,
  category: 'spot' | 'linear',
  side: 'Buy' | 'Sell',
  levelIdx: number,
  isCounter: boolean,
) {
  const rt = bot.rt as GridRt;
  const price = rt.levels[levelIdx];
  // если ордер исполнится сразу, onFill узнает уровень через rt.pend
  rt.pend = [levelIdx, isCounter];
  const o = ex.placeOrder({
    accountId: bot.accountId,
    category,
    symbol: bot.symbols[0],
    side,
    orderType: 'Limit',
    price,
    qty: rt.q,
    tif: 'GTC',
    tag: `bot:${bot.id}`,
  });
  rt.pend = undefined;
  if (o.status === 'Rejected') {
    ex.botLog(bot, `ордер ${side} @ ${price} отклонён: ${o.rejectReason}`, 'warn');
    return;
  }
  if (o.status === 'Filled') {
    // исполнился сразу (цена «перепрыгнула» уровень) — обработка уже прошла в onFill
    return;
  }
  rt.lv[o.id] = levelIdx;
  if (isCounter) rt.counter[o.id] = true;
}

function onGridFill(ex: Exchange, bot: BotState, order: Order, exec: Execution, category: 'spot' | 'linear', makerFee: number) {
  const rt = bot.rt as GridRt;
  let idx: number | undefined = rt.lv[order.id];
  let wasCounter = !!rt.counter[order.id];
  if (idx === undefined && rt.pend && order.orderType === 'Limit') {
    [idx, wasCounter] = rt.pend;
    rt.pend = undefined;
  }
  if (idx === undefined) return;
  delete rt.lv[order.id];
  delete rt.counter[order.id];
  if (order.side === 'Buy') bot.stats.buys++;
  else bot.stats.sells++;
  if (wasCounter) {
    const adj = order.side === 'Sell' ? rt.levels[idx - 1] : rt.levels[idx + 1];
    if (adj !== undefined) {
      const gross = exec.qty * Math.abs(exec.price - adj);
      bot.stats.gridProfit += gross - exec.fee - exec.qty * adj * makerFee;
      bot.stats.arbitrages++;
    }
  }
  // встречный ордер на соседнем уровне
  if (order.side === 'Buy' && idx + 1 < rt.levels.length) placeGridOrder(ex, bot, category, 'Sell', idx + 1, true);
  if (order.side === 'Sell' && idx - 1 >= 0) placeGridOrder(ex, bot, category, 'Buy', idx - 1, true);
}

function checkTrigger(ex: Exchange, bot: BotState, triggerPrice: number | undefined): boolean {
  const rt = bot.rt as GridRt;
  if (rt.launched) return true;
  if (!triggerPrice) return true;
  const px = ex.price(bot.symbols[0]);
  if (rt.triggerFrom === undefined) rt.triggerFrom = px;
  const hit = rt.triggerFrom <= triggerPrice ? px >= triggerPrice : px <= triggerPrice;
  return hit;
}

/* ───────────────────────── Спотовый грид ───────────────────────── */

function launchSpot(ex: Exchange, bot: BotState<'spotGrid'>) {
  const p = bot.params;
  const spec = getAsset(p.symbol);
  const px = ex.price(p.symbol);
  const rt = bot.rt as GridRt;
  const levels = gridLevels(p.lower, p.upper, p.grids, p.mode, spec.tickSize);
  const empty = emptyIndex(levels, px);
  const buys: number[] = [];
  const sells: number[] = [];
  levels.forEach((_, i) => {
    if (i === empty) return;
    if (levels[i] < px) buys.push(i);
    else sells.push(i);
  });
  const fee = ex.config.fees.spotTaker;
  const cost = buys.reduce((s, i) => s + levels[i], 0) + sells.length * px;
  const step = spotQtyStep(p.symbol);
  const q = roundToStep((bot.investment / (cost * (1 + 2 * fee))) * 0.995, step, 'floor');
  if (!(q >= step)) {
    ex.stopBot(bot.id, `Недостаточно инвестиций: объём на сетку < ${step}`);
    return;
  }
  rt.levels = levels;
  rt.q = q;
  rt.lv = {};
  rt.counter = {};
  rt.launched = true;
  bot.status = 'running';
  bot.startedTime = ex.eventTime();
  if (sells.length) {
    const o = ex.placeOrder({
      accountId: bot.accountId,
      category: 'spot',
      symbol: p.symbol,
      side: 'Buy',
      orderType: 'Market',
      qty: q * sells.length,
      tag: `bot:${bot.id}`,
    });
    if (o.status === 'Rejected') {
      ex.stopBot(bot.id, `Не удалось купить базовый актив: ${o.rejectReason}`);
      return;
    }
  }
  for (const i of buys) placeGridOrder(ex, bot, 'spot', 'Buy', i, false);
  for (const i of sells) placeGridOrder(ex, bot, 'spot', 'Sell', i, true);
  ex.botLog(bot, `запущен: ${p.grids} сеток ${levels[0]}–${levels[levels.length - 1]}, объём ${q} на уровень`);
}

export const spotGridLogic: BotLogic<'spotGrid'> = {
  validate(ex, p: SpotGridParams, investment) {
    const err = validateGrid(ex, p, ex.config.fees.spotMaker, investment, 1, spotQtyStep(p.symbol));
    if (err) return err;
    if (investment < 10) return 'Минимальные инвестиции 10 USDT';
    return null;
  },
  start(ex, bot) {
    bot.symbols = [bot.params.symbol];
    bot.rt = { lv: {}, counter: {} };
    if (checkTrigger(ex, bot, bot.params.triggerPrice)) launchSpot(ex, bot);
  },
  onFill(ex, bot, order, exec) {
    onGridFill(ex, bot, order, exec, 'spot', ex.config.fees.spotMaker);
  },
  onBar(ex, bot) {
    const p = bot.params;
    if (bot.status === 'waiting') {
      if (checkTrigger(ex, bot, p.triggerPrice)) launchSpot(ex, bot);
      return;
    }
    const px = ex.price(p.symbol);
    if (p.tpPrice && px >= p.tpPrice) ex.stopBot(bot.id, `Достигнут TP ${p.tpPrice}`);
    else if (p.slPrice && px <= p.slPrice) ex.stopBot(bot.id, `Достигнут SL ${p.slPrice}`);
  },
};

/* ───────────────────────── Фьючерсный грид ───────────────────────── */

function launchFutures(ex: Exchange, bot: BotState<'futuresGrid'>) {
  const p = bot.params;
  const spec = getAsset(p.symbol);
  const px = ex.price(p.symbol);
  const rt = bot.rt as GridRt;
  const levels = gridLevels(p.lower, p.upper, p.grids, p.mode, spec.tickSize);
  const empty = emptyIndex(levels, px);
  const buys: number[] = [];
  const sells: number[] = [];
  levels.forEach((_, i) => {
    if (i === empty) return;
    if (levels[i] < px) buys.push(i);
    else sells.push(i);
  });
  const sumBuy = buys.reduce((s, i) => s + levels[i], 0);
  const sumSell = sells.reduce((s, i) => s + levels[i], 0);
  const notional = bot.investment * p.leverage * 0.9;
  let denom: number;
  if (p.direction === 'neutral') denom = Math.max(sumBuy, sumSell);
  else denom = sumBuy + sumSell;
  const q = roundToStep(notional / denom, spec.qtyStep, 'floor');
  if (!(q >= spec.minQty)) {
    ex.stopBot(bot.id, `Недостаточно инвестиций: объём на сетку < ${spec.minQty}`);
    return;
  }
  const err = ex.setLeverage(bot.accountId, p.symbol, p.leverage);
  if (err) {
    ex.stopBot(bot.id, err);
    return;
  }
  rt.levels = levels;
  rt.q = q;
  rt.lv = {};
  rt.counter = {};
  rt.launched = true;
  bot.status = 'running';
  bot.startedTime = ex.eventTime();
  // начальная позиция
  const initQty = p.direction === 'long' ? q * sells.length : p.direction === 'short' ? q * buys.length : 0;
  if (initQty > 0) {
    const o = ex.placeOrder({
      accountId: bot.accountId,
      category: 'linear',
      symbol: p.symbol,
      side: p.direction === 'long' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: initQty,
      tag: `bot:${bot.id}`,
    });
    if (o.status === 'Rejected') {
      ex.stopBot(bot.id, `Не удалось открыть начальную позицию: ${o.rejectReason}`);
      return;
    }
  }
  for (const i of buys) placeGridOrder(ex, bot, 'linear', 'Buy', i, p.direction === 'short');
  for (const i of sells) placeGridOrder(ex, bot, 'linear', 'Sell', i, p.direction === 'long');
  ex.botLog(bot, `запущен (${p.direction}, ${p.leverage}x): ${p.grids} сеток, объём ${q} на уровень`);
}

export const futuresGridLogic: BotLogic<'futuresGrid'> = {
  validate(ex, p: FuturesGridParams, investment) {
    const err = validateGrid(ex, p, ex.config.fees.linearMaker, investment, p.leverage, getAsset(p.symbol).minQty);
    if (err) return err;
    const max = getAsset(p.symbol).maxLeverage;
    if (!(p.leverage >= 1 && p.leverage <= max)) return `Плечо: от 1 до ${max}`;
    if (investment < 10) return 'Минимальные инвестиции 10 USDT';
    return null;
  },
  start(ex, bot) {
    bot.symbols = [bot.params.symbol];
    bot.rt = { lv: {}, counter: {} };
    if (checkTrigger(ex, bot, bot.params.triggerPrice)) launchFutures(ex, bot);
  },
  onFill(ex, bot, order, exec) {
    onGridFill(ex, bot, order, exec, 'linear', ex.config.fees.linearMaker);
  },
  onBar(ex, bot) {
    const p = bot.params;
    if (bot.status === 'waiting') {
      if (checkTrigger(ex, bot, p.triggerPrice)) launchFutures(ex, bot);
      return;
    }
    const px = ex.price(p.symbol);
    if (p.tpPrice && px >= p.tpPrice) return ex.stopBot(bot.id, `Достигнут TP ${p.tpPrice}`);
    if (p.slPrice && px <= p.slPrice) return ex.stopBot(bot.id, `Достигнут SL ${p.slPrice}`);
    if (p.tpRoi || p.slRoi) {
      const roi = (ex.equity(ex.botAccount(bot)) / bot.investment - 1) * 100;
      if (p.tpRoi && roi >= p.tpRoi) return ex.stopBot(bot.id, `ROI достиг TP ${p.tpRoi}%`);
      if (p.slRoi && roi <= -Math.abs(p.slRoi)) return ex.stopBot(bot.id, `ROI достиг SL −${Math.abs(p.slRoi)}%`);
    }
  },
};
