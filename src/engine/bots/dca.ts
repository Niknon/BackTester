import { HOUR } from '../../data/intervals';
import { getAsset } from '../../data/assets';
import type { BotLogic, DcaParams } from './types';

/** DCA-бот: регулярные покупки на фиксированную сумму + опциональная фиксация прибыли. */
export const dcaLogic: BotLogic<'dca'> = {
  validate(ex, p: DcaParams, investment) {
    if (!ex.market.has(p.symbol)) return `Нет данных по ${p.symbol}`;
    if (!(p.amount >= 5)) return 'Сумма покупки ≥ 5 USDT';
    if (!(p.intervalHours > 0)) return 'Укажите интервал';
    if (!(p.maxOrders >= 1)) return 'Число покупок ≥ 1';
    if (investment + 1e-9 < p.amount * p.maxOrders) return `Инвестиции должны покрывать ${p.maxOrders} × ${p.amount} = ${p.amount * p.maxOrders} USDT`;
    return null;
  },
  start(ex, bot) {
    bot.symbols = [bot.params.symbol];
    bot.rt = { lastBuy: -Infinity, orders: 0 };
    bot.status = 'running';
    bot.startedTime = ex.eventTime();
    this.onBar(ex, bot);
  },
  onFill() {},
  onBar(ex, bot) {
    const p = bot.params;
    const acc = ex.botAccount(bot);
    const base = getAsset(p.symbol).base;
    const px = ex.price(p.symbol);
    const held = acc.spot[base] || 0;
    // фиксация прибыли
    if (p.tpPct && held > 0) {
      const avg = (acc.spotCost[base] || 0) / held;
      if (px >= avg * (1 + p.tpPct / 100)) {
        const o = ex.placeOrder({ accountId: acc.id, category: 'spot', symbol: p.symbol, side: 'Sell', orderType: 'Market', qty: held, tag: `bot:${bot.id}` });
        if (o.status === 'Filled') {
          bot.stats.sells++;
          bot.stats.cycles++;
          bot.stats.gridProfit += held * px - avg * held;
          bot.rt.orders = 0;
          ex.botLog(bot, `TP: продано ${held} ${base} по ${px}`);
        }
        return;
      }
    }
    if (bot.rt.orders >= p.maxOrders) return;
    if (ex.now - bot.rt.lastBuy < p.intervalHours * HOUR) return;
    if (p.priceBelow && px > p.priceBelow) return;
    const o = ex.placeOrder({
      accountId: acc.id,
      category: 'spot',
      symbol: p.symbol,
      side: 'Buy',
      orderType: 'Market',
      qty: 0,
      quoteQty: Math.min(p.amount, Math.max(0, ex.available(acc) * 0.995)),
      tag: `bot:${bot.id}`,
    });
    bot.rt.lastBuy = ex.now;
    if (o.status === 'Filled') {
      bot.rt.orders++;
      bot.stats.buys++;
    }
  },
};
