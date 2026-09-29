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

function rebalance(ex: Exchange, bot: BotState<'futuresCombo'>, initial: boolean) {
  const p = bot.params;
  const acc = ex.botAccount(bot);
  const equity = ex.equity(acc);
  if (equity <= 0) return;
  const plans: { symbol: string; diff: number; px: number }[] = [];
  for (const leg of p.legs) {
    const px = ex.price(leg.symbol);
    if (!Number.isFinite(px)) continue;
    const spec = getAsset(leg.symbol);
    const sign = leg.side === 'long' ? 1 : -1;
    // 97% — запас на комиссии и поддерживающую маржу
    const target = roundToStep((sign * equity * 0.97 * p.leverage * (leg.weight / 100)) / px, spec.qtyStep, 'floor');
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
  for (const pl of plans) {
    const o = ex.placeOrder({
      accountId: bot.accountId,
      category: 'linear',
      symbol: pl.symbol,
      side: pl.diff > 0 ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: Math.abs(pl.diff),
      tag: `bot:${bot.id}`,
    });
    if (o.status === 'Rejected') ex.botLog(bot, `${pl.symbol}: ${o.rejectReason}`, 'warn');
  }
  bot.rt.lastRebalance = ex.now;
  if (!initial) bot.stats.rebalances++;
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
    rebalance(ex, bot, true);
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
      if (ex.now - (bot.rt.lastRebalance ?? 0) >= p.intervalHours * HOUR) rebalance(ex, bot, false);
    } else if (p.rebalanceMode === 'threshold') {
      const { weights, total } = currentWeights(ex, bot);
      if (total <= 0) return;
      const dev = Math.max(...p.legs.map((l, i) => Math.abs(weights[i] - l.weight / 100)));
      if (dev * 100 >= p.thresholdPct) rebalance(ex, bot, false);
    }
  },
};

export { currentWeights as comboWeights };
