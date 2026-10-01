import { LineStyle } from 'lightweight-charts';
import { getAsset } from '../../data/assets';
import { gridLevels } from '../../engine/bots/grid';
import type { AnyBot, GridMode } from '../../engine/bots/types';
import type { Exchange } from '../../engine/exchange';
import { fmtNum, fmtPrice } from '../../lib/format';
import type { ExtraLine } from '../chart/PriceChart';

/** Параметры бота из формы — для предпросмотра на графике до запуска. */
export type BotPreview =
  | {
      kind: 'grid';
      symbol: string;
      lower: number;
      upper: number;
      grids: number;
      mode: GridMode;
      trigger?: number;
      tp?: number;
      sl?: number;
      direction?: 'long' | 'short' | 'neutral';
    }
  | { kind: 'martingale'; symbol: string; side: 'long' | 'short'; stepPct: number; maxAdds: number; multiplier: number; tpPct: number; slPct?: number }
  | { kind: 'dca'; symbol: string; priceBelow?: number; tpPct?: number }
  | { kind: 'combo'; symbol: string };

export interface ChartOverlay {
  lines: ExtraLine[];
  /** цены, которые должны быть видны на шкале */
  fit: number[];
}

export const GRID_COLORS = {
  buy: 'rgba(32,178,108,0.6)',
  sell: 'rgba(239,69,74,0.6)',
  idle: 'rgba(133,138,147,0.5)',
  bound: '#f7a600',
  trigger: '#a78bfa',
  tp: '#20b26c',
  sl: '#ef454a',
};

const MAX_LEVELS = 400;

function gridOverlay(
  symbol: string,
  levels: number[],
  sideOf: (i: number) => 'Buy' | 'Sell' | null,
  extra: { lower: number; upper: number; trigger?: number; tp?: number; sl?: number },
  editable: boolean,
  idPrefix: string,
): ChartOverlay {
  const lines: ExtraLine[] = [];
  const n = levels.length;
  levels.slice(0, MAX_LEVELS).forEach((p, i) => {
    if (i === 0 || i === n - 1) return; // границы рисуем отдельно
    const side = sideOf(i);
    lines.push({
      id: `${idPrefix}lv${i}`,
      price: p,
      color: side === 'Buy' ? GRID_COLORS.buy : side === 'Sell' ? GRID_COLORS.sell : GRID_COLORS.idle,
      style: side ? LineStyle.Solid : LineStyle.Dotted,
      axis: false,
    });
  });
  const drag = editable ? ('custom' as const) : undefined;
  const mark = editable ? ' ⇕' : '';
  const sideFirst = sideOf(0);
  const sideLast = sideOf(n - 1);
  lines.push({ id: `${idPrefix}upper`, price: extra.upper, color: GRID_COLORS.bound, title: `Верх сетки${sideLast ? (sideLast === 'Sell' ? ' · S' : ' · B') : ''}${mark}`, style: LineStyle.Dashed, width: 2, drag });
  lines.push({ id: `${idPrefix}lower`, price: extra.lower, color: GRID_COLORS.bound, title: `Низ сетки${sideFirst ? (sideFirst === 'Buy' ? ' · B' : ' · S') : ''}${mark}`, style: LineStyle.Dashed, width: 2, drag });
  if (extra.trigger) lines.push({ id: `${idPrefix}trigger`, price: extra.trigger, color: GRID_COLORS.trigger, title: `Запуск${mark}`, style: LineStyle.Dashed, drag });
  if (extra.tp) lines.push({ id: `${idPrefix}tp`, price: extra.tp, color: GRID_COLORS.tp, title: `TP бота${mark}`, style: LineStyle.Dotted, drag });
  if (extra.sl) lines.push({ id: `${idPrefix}sl`, price: extra.sl, color: GRID_COLORS.sl, title: `SL бота${mark}`, style: LineStyle.Dotted, drag });
  const fit = [extra.lower, extra.upper, extra.trigger, extra.tp, extra.sl].filter((x): x is number => !!x && Number.isFinite(x));
  void symbol;
  return { lines, fit };
}

/** Ближайший к цене уровень — на нём ордер не ставится (как у Bybit). */
function nearest(levels: number[], px: number) {
  let best = 0;
  for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i] - px) < Math.abs(levels[best] - px)) best = i;
  return best;
}

/** Предпросмотр настроек бота (до запуска). Линии с drag: 'custom' можно двигать мышью. */
export function previewOverlay(p: BotPreview | null, price: number): ChartOverlay {
  if (!p || !Number.isFinite(price)) return { lines: [], fit: [] };
  if (p.kind === 'grid') {
    if (!(p.lower > 0) || !(p.upper > p.lower) || !(p.grids >= 2) || p.grids > 300) {
      const lines: ExtraLine[] = [];
      if (p.lower > 0) lines.push({ id: 'pv:lower', price: p.lower, color: GRID_COLORS.bound, title: 'Низ сетки ⇕', style: LineStyle.Dashed, width: 2, drag: 'custom' });
      if (p.upper > 0) lines.push({ id: 'pv:upper', price: p.upper, color: GRID_COLORS.bound, title: 'Верх сетки ⇕', style: LineStyle.Dashed, width: 2, drag: 'custom' });
      return { lines, fit: lines.map((l) => l.price) };
    }
    const levels = gridLevels(p.lower, p.upper, p.grids, p.mode, getAsset(p.symbol).tickSize);
    // ордера расставляются относительно цены на момент запуска
    const ref = p.trigger || price;
    const empty = nearest(levels, ref);
    return gridOverlay(p.symbol, levels, (i) => (i === empty ? null : levels[i] < ref ? 'Buy' : 'Sell'), p, true, 'pv:');
  }
  if (p.kind === 'martingale') {
    const long = p.side === 'long';
    const lines: ExtraLine[] = [];
    let q = 1;
    let sumQ = 1;
    let sumPQ = price;
    let lvl = price;
    for (let k = 1; k <= Math.min(p.maxAdds, 30); k++) {
      lvl = lvl * (long ? 1 - p.stepPct / 100 : 1 + p.stepPct / 100);
      q *= p.multiplier;
      sumQ += q;
      sumPQ += q * lvl;
      lines.push({ id: `pv:add${k}`, price: lvl, color: long ? GRID_COLORS.buy : GRID_COLORS.sell, title: `Усреднение ${k} · ×${fmtNum(q, q < 10 ? 2 : 0)}`, style: LineStyle.Dashed, axis: k === p.maxAdds });
    }
    const avg = sumPQ / sumQ;
    const tp1 = price * (long ? 1 + p.tpPct / 100 : 1 - p.tpPct / 100);
    lines.push({ id: 'pv:entry', price, color: '#eaecef', title: 'Вход', style: LineStyle.Solid });
    lines.push({ id: 'pv:tp1', price: tp1, color: GRID_COLORS.tp, title: `TP ${p.tpPct}%`, style: LineStyle.Dotted });
    if (p.maxAdds > 0) {
      lines.push({ id: 'pv:avg', price: avg, color: '#22d3ee', title: 'Средняя после всех усреднений', style: LineStyle.Dotted });
      lines.push({ id: 'pv:tpAll', price: avg * (long ? 1 + p.tpPct / 100 : 1 - p.tpPct / 100), color: GRID_COLORS.tp, title: 'TP после всех', style: LineStyle.Dotted, axis: false });
    }
    if (p.slPct) {
      const sl = avg * (long ? 1 - p.slPct / 100 : 1 + p.slPct / 100);
      lines.push({ id: 'pv:sl', price: sl, color: GRID_COLORS.sl, title: `SL ${p.slPct}% (после всех)`, style: LineStyle.Dotted });
    }
    return { lines, fit: lines.map((l) => l.price) };
  }
  if (p.kind === 'dca') {
    const lines: ExtraLine[] = [];
    if (p.priceBelow) lines.push({ id: 'pv:below', price: p.priceBelow, color: GRID_COLORS.trigger, title: 'Покупать ниже ⇕', style: LineStyle.Dashed, drag: 'custom' });
    if (p.tpPct) lines.push({ id: 'pv:tp', price: price * (1 + p.tpPct / 100), color: GRID_COLORS.tp, title: `TP +${p.tpPct}% (от текущей)`, style: LineStyle.Dotted });
    return { lines, fit: lines.map((l) => l.price) };
  }
  return { lines: [], fit: [] };
}

/** Линии работающего бота: все уровни сетки (активные покупки/продажи и пустые), границы, запуск, TP/SL. */
export function liveOverlay(ex: Exchange, bot: AnyBot, symbol: string): ChartOverlay {
  const acc = ex.botAccount(bot);
  const p = bot.params as any;
  if (bot.type === 'spotGrid' || bot.type === 'futuresGrid') {
    if (symbol !== p.symbol) return { lines: [], fit: [] };
    const tick = getAsset(p.symbol).tickSize;
    const levels: number[] = bot.rt.levels ?? gridLevels(p.lower, p.upper, p.grids, p.mode, tick);
    const bySide = new Map<number, 'Buy' | 'Sell'>();
    const lv: Record<string, number> = bot.rt.lv ?? {};
    for (const o of ex.activeOrders(acc.id, p.symbol)) {
      const i = lv[o.id];
      if (i !== undefined) bySide.set(i, o.side);
    }
    const waiting = bot.status === 'waiting';
    const ref = p.triggerPrice || ex.price(p.symbol);
    const empty = waiting ? nearest(levels, ref) : -1;
    const ov = gridOverlay(
      p.symbol,
      levels,
      (i) => (waiting ? (i === empty ? null : levels[i] < ref ? 'Buy' : 'Sell') : (bySide.get(i) ?? null)),
      { lower: p.lower, upper: p.upper, trigger: waiting ? p.triggerPrice : undefined, tp: p.tpPrice, sl: p.slPrice },
      false,
      `bot:${bot.id}:`,
    );
    return ov;
  }
  if (bot.type === 'martingale') {
    const lines: ExtraLine[] = [];
    const long = p.side === 'long';
    const left = p.maxAdds - (bot.rt.adds ?? 0);
    let lvl = bot.rt.lastEntry;
    // первый уровень — уже выставленный условный ордер (рисует график), остальные — будущие
    for (let k = 1; k <= Math.min(left, 30) && lvl; k++) {
      lvl = lvl * (long ? 1 - p.stepPct / 100 : 1 + p.stepPct / 100);
      if (k === 1) continue;
      lines.push({ id: `bot:${bot.id}:add${k}`, price: lvl, color: GRID_COLORS.idle, title: `усреднение +${(bot.rt.adds ?? 0) + k}`, style: LineStyle.Dotted, axis: false });
    }
    return { lines, fit: lines.map((l) => l.price) };
  }
  if (bot.type === 'dca') {
    const lines: ExtraLine[] = [];
    const base = getAsset(p.symbol).base;
    const held = acc.spot[base] || 0;
    if (held > 0) {
      const avg = (acc.spotCost[base] || 0) / held;
      lines.push({ id: `bot:${bot.id}:avg`, price: avg, color: '#22d3ee', title: `Средняя ${fmtPrice(avg, p.symbol)} · ${fmtNum(held, 6)} ${base}`, style: LineStyle.Solid });
      if (p.tpPct) lines.push({ id: `bot:${bot.id}:tp`, price: avg * (1 + p.tpPct / 100), color: GRID_COLORS.tp, title: `TP +${p.tpPct}%`, style: LineStyle.Dotted });
    }
    if (p.priceBelow) lines.push({ id: `bot:${bot.id}:below`, price: p.priceBelow, color: GRID_COLORS.trigger, title: 'Покупать ниже', style: LineStyle.Dashed });
    return { lines, fit: lines.map((l) => l.price) };
  }
  return { lines: [], fit: [] };
}

/** Категория рынка, на котором торгует бот. */
export function botCategory(bot: AnyBot): 'spot' | 'linear' {
  return bot.type === 'spotGrid' || bot.type === 'dca' ? 'spot' : 'linear';
}
