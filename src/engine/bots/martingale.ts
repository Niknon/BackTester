import { getAsset, roundToStep } from '../../data/assets';
import type { Exchange } from '../exchange';
import type { BotLogic, BotState, MartingaleParams } from './types';

/**
 * Фьючерсный мартингейл: вход, усреднения с множителем при движении против
 * позиции на stepPct, выход по TP от средней цены; опционально — SL и цикличность.
 */

function openCycle(ex: Exchange, bot: BotState<'martingale'>) {
  const p = bot.params;
  const spec = getAsset(p.symbol);
  const px = ex.price(p.symbol);
  const qty = roundToStep((p.initialMargin * p.leverage) / px, spec.qtyStep, 'floor');
  if (!(qty >= spec.minQty)) return ex.stopBot(bot.id, `Слишком малая маржа первого ордера (< ${spec.minQty})`);
  bot.rt.adds = 0;
  bot.rt.lastQty = qty;
  bot.rt.closing = false;
  const o = ex.placeOrder({
    accountId: bot.accountId,
    category: 'linear',
    symbol: p.symbol,
    side: p.side === 'long' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty,
    tag: `bot:${bot.id}`,
  });
  if (o.status !== 'Filled') return ex.stopBot(bot.id, `Не удалось открыть позицию: ${o.rejectReason ?? o.status}`);
  bot.rt.lastEntry = o.avgPrice;
  armNext(ex, bot);
}

/** Выставить следующий усредняющий стоп-ордер и обновить TP/SL. */
function armNext(ex: Exchange, bot: BotState<'martingale'>) {
  const p = bot.params;
  const acc = ex.botAccount(bot);
  const pos = acc.positions[p.symbol];
  if (!pos || pos.size === 0) return;
  const long = p.side === 'long';
  // отменяем старый усредняющий ордер
  if (bot.rt.addOrderId) ex.cancelOrder(bot.rt.addOrderId, 'Переустановка');
  bot.rt.addOrderId = undefined;
  if (bot.rt.adds < p.maxAdds) {
    const spec = getAsset(p.symbol);
    const trig = bot.rt.lastEntry * (long ? 1 - p.stepPct / 100 : 1 + p.stepPct / 100);
    const qty = roundToStep(bot.rt.lastQty * p.multiplier, spec.qtyStep, 'floor');
    const o = ex.placeOrder({
      accountId: bot.accountId,
      category: 'linear',
      symbol: p.symbol,
      side: long ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty,
      triggerPrice: trig,
      triggerDirection: long ? 2 : 1,
      stopOrderType: 'Stop',
      tag: `bot:${bot.id}`,
    });
    if (o.status === 'Untriggered') {
      bot.rt.addOrderId = o.id;
      bot.rt.pendingQty = qty;
    }
  }
  const tp = pos.avgPrice * (long ? 1 + p.tpPct / 100 : 1 - p.tpPct / 100);
  const allAdded = bot.rt.adds >= p.maxAdds;
  const sl = p.slPct && allAdded ? pos.avgPrice * (long ? 1 - p.slPct / 100 : 1 + p.slPct / 100) : null;
  const last = ex.price(p.symbol);
  const tpOk = long ? tp > last : tp < last;
  if (tpOk) ex.setTradingStop(acc.id, p.symbol, { takeProfit: tp, stopLoss: sl && (long ? sl < last : sl > last) ? sl : null });
}

export const martingaleLogic: BotLogic<'martingale'> = {
  validate(ex, p: MartingaleParams, investment) {
    if (!ex.market.has(p.symbol)) return `Нет данных по ${p.symbol}`;
    if (getAsset(p.symbol).spotOnly) return `${p.symbol} торгуется только на споте — мартингейл работает на перпетуалах`;
    const max = getAsset(p.symbol).maxLeverage;
    if (!(p.leverage >= 1 && p.leverage <= max)) return `Плечо: от 1 до ${max}`;
    if (!(p.stepPct > 0) || !(p.tpPct > 0)) return 'Шаг и TP должны быть > 0';
    if (!(p.multiplier >= 1)) return 'Множитель ≥ 1';
    let total = 0;
    for (let i = 0; i <= p.maxAdds; i++) total += p.initialMargin * p.multiplier ** i;
    if (total > investment * 1.0001) return `Для ${p.maxAdds} усреднений нужно ${total.toFixed(2)} USDT маржи — увеличьте инвестиции`;
    return null;
  },
  start(ex, bot) {
    const p = bot.params;
    bot.symbols = [p.symbol];
    bot.rt = { adds: 0 };
    const err = ex.setLeverage(bot.accountId, p.symbol, p.leverage);
    if (err) return ex.stopBot(bot.id, err);
    bot.status = 'running';
    bot.startedTime = ex.eventTime();
    openCycle(ex, bot);
  },
  onFill(ex, bot, order, exec) {
    const p = bot.params;
    const acc = ex.botAccount(bot);
    const pos = acc.positions[p.symbol];
    if (order.id === bot.rt.addOrderId) {
      bot.rt.addOrderId = undefined;
      bot.rt.adds++;
      bot.rt.lastQty = exec.qty;
      bot.rt.lastEntry = exec.price;
      bot.stats.buys++;
      armNext(ex, bot);
      return;
    }
    if (order.tag === 'tpsl' && (!pos || pos.size === 0)) {
      if (bot.rt.addOrderId) ex.cancelOrder(bot.rt.addOrderId, 'Цикл завершён');
      bot.rt.addOrderId = undefined;
      const isTp = order.stopOrderType === 'TakeProfit';
      bot.stats.cycles++;
      bot.stats.gridProfit += exec.closedPnl - exec.fee;
      if (!isTp) {
        bot.rt.stopAfter = 'Сработал стоп-лосс';
        return;
      }
      ex.botLog(bot, `цикл №${bot.stats.cycles} закрыт по TP`);
      if (p.loop) bot.rt.restart = true;
      else bot.rt.stopAfter = 'Цикл завершён (TP)';
    }
  },
  onBar(ex, bot) {
    if (bot.rt.stopAfter) {
      ex.stopBot(bot.id, bot.rt.stopAfter);
      return;
    }
    if (bot.rt.restart) {
      bot.rt.restart = false;
      openCycle(ex, bot);
      return;
    }
    // позиция закрыта извне (например, ликвидация) — открываем заново/останавливаем
    const pos = ex.botAccount(bot).positions[bot.params.symbol];
    if (!pos && bot.status === 'running') {
      if (bot.params.loop) openCycle(ex, bot);
      else ex.stopBot(bot.id, 'Позиция закрыта');
    }
  },
};
