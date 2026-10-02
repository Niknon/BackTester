import { getAsset, roundToStep } from '../data/assets';
import type { Exchange } from './exchange';
import { optionSymbol, quoteOption, parseOptionSymbol } from './options';
import type { Side } from './types';

/**
 * Опционные стратегии: шаблоны ног относительно центрального страйка.
 * k — смещение в «ширинах» (ширина = N шагов страйка), ratio — кратность объёма,
 * far — нога на дальней экспирации (календари/диагонали), F — перпетуал базового актива.
 */
export interface StrategyLegDef {
  side: Side;
  type: 'C' | 'P' | 'F';
  k?: number;
  ratio?: number;
  far?: boolean;
}

export type StrategyView = 'bull' | 'bear' | 'neutral' | 'vol';

export interface StrategyDef {
  key: string;
  name: string;
  group: 'main' | 'more';
  view: StrategyView;
  desc: string;
  /** риск/прибыль кратко */
  risk: string;
  legs: StrategyLegDef[];
  /** нужна дальняя экспирация */
  calendar?: boolean;
  /** ширина по умолчанию (в шагах страйка) */
  width?: number;
}

const B = (type: 'C' | 'P' | 'F', k = 0, ratio = 1, far = false): StrategyLegDef => ({ side: 'Buy', type, k, ratio, far });
const S = (type: 'C' | 'P' | 'F', k = 0, ratio = 1, far = false): StrategyLegDef => ({ side: 'Sell', type, k, ratio, far });

export const VIEW_LABEL: Record<StrategyView, string> = {
  bull: 'Рост',
  bear: 'Падение',
  neutral: 'Боковик',
  vol: 'Сильное движение',
};

export const STRATEGIES: StrategyDef[] = [
  // ── основные (как в разделе стратегий Bybit) ──
  { key: 'bull_call', name: 'Бычий колл-спред', group: 'main', view: 'bull', desc: 'Купить колл, продать колл выше. Дешевле простого колла, прибыль ограничена верхним страйком.', risk: 'Риск и прибыль ограничены, дебет', legs: [B('C', 0), S('C', 1)] },
  { key: 'bear_put', name: 'Медвежий пут-спред', group: 'main', view: 'bear', desc: 'Купить пут, продать пут ниже. Дешёвая ставка на снижение до нижнего страйка.', risk: 'Риск и прибыль ограничены, дебет', legs: [B('P', 0), S('P', -1)] },
  { key: 'bull_put', name: 'Бычий пут-спред', group: 'main', view: 'bull', desc: 'Продать пут, купить пут ниже. Получаете премию, если цена не упадёт ниже проданного страйка.', risk: 'Кредит, риск ограничен', legs: [S('P', 0), B('P', -1)] },
  { key: 'bear_call', name: 'Медвежий колл-спред', group: 'main', view: 'bear', desc: 'Продать колл, купить колл выше. Премия ваша, если цена не вырастет выше проданного страйка.', risk: 'Кредит, риск ограничен', legs: [S('C', 0), B('C', 1)] },
  { key: 'long_straddle', name: 'Лонг стрэддл', group: 'main', view: 'vol', desc: 'Купить колл и пут на одном страйке. Заработок на сильном движении в любую сторону.', risk: 'Риск = премия, прибыль не ограничена', legs: [B('C', 0), B('P', 0)] },
  { key: 'short_straddle', name: 'Шорт стрэддл', group: 'main', view: 'neutral', desc: 'Продать колл и пут на одном страйке. Заработок на временном распаде, если цена стоит.', risk: 'Кредит, риск не ограничен', legs: [S('C', 0), S('P', 0)] },
  { key: 'long_strangle', name: 'Лонг стрэнгл', group: 'main', view: 'vol', desc: 'Купить OTM-колл и OTM-пут. Дешевле стрэддла, нужно более сильное движение.', risk: 'Риск = премия, прибыль не ограничена', legs: [B('C', 1), B('P', -1)] },
  { key: 'short_strangle', name: 'Шорт стрэнгл', group: 'main', view: 'neutral', desc: 'Продать OTM-колл и OTM-пут. Премия ваша, пока цена внутри диапазона.', risk: 'Кредит, риск не ограничен', legs: [S('C', 1), S('P', -1)] },
  { key: 'call_calendar', name: 'Календарный колл-спред', group: 'main', view: 'neutral', calendar: true, desc: 'Продать ближний колл, купить дальний на том же страйке. Заработок на более быстром распаде ближнего опциона.', risk: 'Дебет, риск ограничен', legs: [S('C', 0), B('C', 0, 1, true)] },
  { key: 'put_calendar', name: 'Календарный пут-спред', group: 'main', view: 'neutral', calendar: true, desc: 'Продать ближний пут, купить дальний на том же страйке.', risk: 'Дебет, риск ограничен', legs: [S('P', 0), B('P', 0, 1, true)] },
  { key: 'call_fly', name: 'Бабочка (коллы)', group: 'main', view: 'neutral', desc: 'Купить 1 колл ниже, продать 2 колла в центре, купить 1 колл выше. Максимум — если цена у центрального страйка.', risk: 'Дебет, риск ограничен', legs: [B('C', -1), S('C', 0, 2), B('C', 1)] },
  { key: 'iron_condor', name: 'Железный кондор', group: 'main', view: 'neutral', width: 2, desc: 'Шорт стрэнгл, застрахованный купленными крыльями. Премия ваша, пока цена в коридоре.', risk: 'Кредит, риск ограничен', legs: [B('P', -2), S('P', -1), S('C', 1), B('C', 2)] },

  // ── другие стратегии ──
  { key: 'reverse_condor', name: 'Обратный железный кондор', group: 'more', view: 'vol', width: 2, desc: 'Зеркало кондора: прибыль при выходе цены из коридора.', risk: 'Дебет, риск ограничен', legs: [S('P', -2), B('P', -1), B('C', 1), S('C', 2)] },
  { key: 'iron_fly', name: 'Железная бабочка (шорт)', group: 'more', view: 'neutral', desc: 'Шорт стрэддл + купленные крылья. Высокая премия, максимум — точно на страйке.', risk: 'Кредит, риск ограничен', legs: [S('C', 0), S('P', 0), B('C', 1), B('P', -1)] },
  { key: 'long_iron_fly', name: 'Железная бабочка (лонг)', group: 'more', view: 'vol', desc: 'Лонг стрэддл с проданными крыльями — дешевле стрэддла, прибыль ограничена.', risk: 'Дебет, риск ограничен', legs: [B('C', 0), B('P', 0), S('C', 1), S('P', -1)] },
  { key: 'put_fly', name: 'Бабочка (путы)', group: 'more', view: 'neutral', desc: 'То же, что бабочка на коллах, но на путах.', risk: 'Дебет, риск ограничен', legs: [B('P', 1), S('P', 0, 2), B('P', -1)] },
  { key: 'short_call_fly', name: 'Шорт бабочка (коллы)', group: 'more', view: 'vol', desc: 'Продать крылья, купить 2 центральных колла: прибыль при уходе цены от центра.', risk: 'Кредит, риск ограничен', legs: [S('C', -1), B('C', 0, 2), S('C', 1)] },
  { key: 'bwb', name: 'Бабочка с ломаным крылом', group: 'more', view: 'bull', desc: 'Бабочка с дальним верхним крылом: можно войти за кредит, риск смещён вверх.', risk: 'Риск ограничен', legs: [B('C', -1), S('C', 0, 2), B('C', 2)] },
  { key: 'call_condor', name: 'Кондор (коллы)', group: 'more', view: 'neutral', desc: 'Широкая бабочка: 4 колла на разных страйках, прибыль в коридоре.', risk: 'Дебет, риск ограничен', legs: [B('C', -2), S('C', -1), S('C', 1), B('C', 2)] },
  { key: 'call_ratio', name: 'Колл рейшио-спред 1×2', group: 'more', view: 'neutral', desc: 'Купить 1 колл, продать 2 колла выше. Дёшево/за кредит, но риск при сильном росте.', risk: 'Риск вверх не ограничен', legs: [B('C', 0), S('C', 1, 2)] },
  { key: 'put_ratio', name: 'Пут рейшио-спред 1×2', group: 'more', view: 'neutral', desc: 'Купить 1 пут, продать 2 пута ниже.', risk: 'Риск вниз большой', legs: [B('P', 0), S('P', -1, 2)] },
  { key: 'call_backspread', name: 'Колл бэкспред 1×2', group: 'more', view: 'bull', desc: 'Продать 1 колл, купить 2 колла выше. Ставка на резкий рост.', risk: 'Риск ограничен, прибыль вверх не ограничена', legs: [S('C', 0), B('C', 1, 2)] },
  { key: 'put_backspread', name: 'Пут бэкспред 1×2', group: 'more', view: 'bear', desc: 'Продать 1 пут, купить 2 пута ниже. Ставка на обвал.', risk: 'Риск ограничен', legs: [S('P', 0), B('P', -1, 2)] },
  { key: 'risk_reversal', name: 'Риск-реверсал (бычий)', group: 'more', view: 'bull', desc: 'Продать OTM-пут, купить OTM-колл — почти бесплатная ставка на рост.', risk: 'Риск вниз не ограничен', legs: [S('P', -1), B('C', 1)] },
  { key: 'risk_reversal_bear', name: 'Риск-реверсал (медвежий)', group: 'more', view: 'bear', desc: 'Продать OTM-колл, купить OTM-пут.', risk: 'Риск вверх не ограничен', legs: [B('P', -1), S('C', 1)] },
  { key: 'synth_long', name: 'Синтетический лонг', group: 'more', view: 'bull', desc: 'Купить колл и продать пут на одном страйке — ведёт себя как фьючерс.', risk: 'Как у лонга базового актива', legs: [B('C', 0), S('P', 0)] },
  { key: 'synth_short', name: 'Синтетический шорт', group: 'more', view: 'bear', desc: 'Продать колл и купить пут на одном страйке.', risk: 'Как у шорта базового актива', legs: [S('C', 0), B('P', 0)] },
  { key: 'jade_lizard', name: 'Нефритовая ящерица', group: 'more', view: 'bull', desc: 'Шорт пут + медвежий колл-спред. При достаточной премии нет риска вверх.', risk: 'Кредит, риск вниз', legs: [S('P', -1), S('C', 1), B('C', 2)] },
  { key: 'seagull', name: 'Чайка (бычья)', group: 'more', view: 'bull', desc: 'Колл-спред, оплаченный продажей пута.', risk: 'Риск вниз', legs: [S('P', -1), B('C', 0), S('C', 1)] },
  { key: 'strap', name: 'Стрэп (2 колла + пут)', group: 'more', view: 'vol', desc: 'Стрэддл с уклоном в рост.', risk: 'Риск = премия', legs: [B('C', 0, 2), B('P', 0)] },
  { key: 'strip', name: 'Стрип (колл + 2 пута)', group: 'more', view: 'vol', desc: 'Стрэддл с уклоном в падение.', risk: 'Риск = премия', legs: [B('C', 0), B('P', 0, 2)] },
  { key: 'guts', name: 'Лонг гатс', group: 'more', view: 'vol', desc: 'Купить ITM-колл и ITM-пут.', risk: 'Дебет, риск ограничен', legs: [B('C', -1), B('P', 1)] },
  { key: 'xmas_tree', name: 'Ёлка (коллы)', group: 'more', view: 'bull', desc: 'Купить колл, продать коллы на двух страйках выше — умеренный рост.', risk: 'Риск вверх не ограничен', legs: [B('C', 0), S('C', 1), S('C', 2)] },
  { key: 'diag_call', name: 'Диагональный колл-спред', group: 'more', view: 'bull', calendar: true, desc: 'Купить дальний колл, продать ближний колл выше.', risk: 'Дебет, риск ограничен', legs: [B('C', 0, 1, true), S('C', 1)] },
  { key: 'diag_put', name: 'Диагональный пут-спред', group: 'more', view: 'bear', calendar: true, desc: 'Купить дальний пут, продать ближний пут ниже.', risk: 'Дебет, риск ограничен', legs: [B('P', 0, 1, true), S('P', -1)] },
  { key: 'box', name: 'Бокс-спред', group: 'more', view: 'neutral', desc: 'Бычий колл-спред + медвежий пут-спред: фиксированная выплата (арбитраж).', risk: 'Почти без риска', legs: [B('C', -1), S('C', 1), B('P', 1), S('P', -1)] },
  { key: 'covered_call', name: 'Покрытый колл', group: 'more', view: 'neutral', desc: 'Лонг перпетуала + продажа OTM-колла: доход от премии, рост ограничен.', risk: 'Риск вниз как у лонга', legs: [B('F'), S('C', 1)] },
  { key: 'protective_put', name: 'Защитный пут', group: 'more', view: 'bull', desc: 'Лонг перпетуала + покупка пута: страховка от падения.', risk: 'Риск ограничен', legs: [B('F'), B('P', -1)] },
  { key: 'collar', name: 'Коллар', group: 'more', view: 'neutral', desc: 'Лонг перпетуала + купленный пут + проданный колл: коридор результата.', risk: 'Риск и прибыль ограничены', legs: [B('F'), B('P', -1), S('C', 1)] },
];

export interface ResolvedLeg {
  category: 'option' | 'linear';
  symbol: string;
  side: Side;
  type: 'C' | 'P' | 'F';
  strike: number;
  expiry: number;
  qty: number;
  /** цена исполнения по рынку (ask для покупки, bid для продажи) */
  price: number;
  mark: number;
  delta: number;
}

/** Подставить реальные страйки/экспирации и котировки. */
export function resolveStrategy(
  ex: Exchange,
  def: StrategyDef,
  base: string,
  strikes: number[],
  centerIdx: number,
  width: number,
  expiry: number,
  farExpiry: number,
  qty: number,
): { legs: ResolvedLeg[]; error?: string } {
  const underlying = `${base}USDT`;
  const S0 = ex.price(underlying);
  const legs: ResolvedLeg[] = [];
  for (const l of def.legs) {
    const q = qty * (l.ratio ?? 1);
    if (l.type === 'F') {
      const spec = getAsset(underlying);
      const fq = roundToStep(q, spec.qtyStep, 'floor');
      if (fq < spec.minQty) return { legs, error: `Объём перпетуала меньше минимального (${spec.minQty} ${base})` };
      legs.push({ category: 'linear', symbol: underlying, side: l.side, type: 'F', strike: 0, expiry: 0, qty: fq, price: S0, mark: S0, delta: l.side === 'Buy' ? fq : -fq });
      continue;
    }
    const i = centerIdx + (l.k ?? 0) * width;
    if (i < 0 || i >= strikes.length) return { legs, error: 'Страйк вне диапазона цепочки — уменьшите ширину или сдвиньте центр' };
    const strike = strikes[i];
    const exp = l.far ? farExpiry : expiry;
    const symbol = optionSymbol(base, exp, strike, l.type);
    const quote = ex.optionQuote(symbol);
    if (!quote) return { legs, error: 'Нет котировки' };
    const price = l.side === 'Buy' ? quote.ask : quote.bid;
    if (!(price > 0)) return { legs, error: `${symbol}: ${l.side === 'Buy' ? 'нет продавцов' : 'нет покупателей (bid = 0)'}` };
    legs.push({ category: 'option', symbol, side: l.side, type: l.type, strike, expiry: exp, qty: q, price, mark: quote.mark, delta: quote.greeks.delta * q * (l.side === 'Buy' ? 1 : -1) });
  }
  return { legs };
}

/**
 * Стоимость ноги на момент `at` (для календарей — дальняя нога на ближней экспирации).
 */
export function legValueAt(ex: Exchange, leg: ResolvedLeg, S: number, at: number) {
  if (leg.type === 'F') return S;
  if (leg.expiry <= at) return leg.type === 'C' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
  const inst = parseOptionSymbol(leg.symbol)!;
  return quoteOption(ex.config.options, inst, S, at, ex.volInputs(inst.underlying)).mark;
}

/**
 * Открыть стратегию одним действием: все ноги по рынку.
 * Если какая-то нога отклонена — уже исполненные ноги закрываются (откат), чтобы не остаться с «половиной» стратегии.
 */
export function openStrategy(ex: Exchange, legs: ResolvedLeg[], tag = 'user'): { ok: boolean; error?: string; filled: number } {
  // сначала покупки (оплата премии), затем продажи (маржа под шорт)
  const order = [...legs].sort((a, b) => Number(a.side === 'Sell') - Number(b.side === 'Sell'));
  const done: ResolvedLeg[] = [];
  for (const l of order) {
    const o = ex.placeOrder({ category: l.category, symbol: l.symbol, side: l.side, orderType: 'Market', qty: l.qty, tag });
    if (o.status !== 'Filled') {
      for (const d of done.reverse())
        ex.placeOrder({ category: d.category, symbol: d.symbol, side: d.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: d.qty, reduceOnly: true, tag });
      return { ok: false, error: `${l.symbol}: ${o.rejectReason ?? o.status}`, filled: 0 };
    }
    done.push(l);
  }
  return { ok: true, filled: done.length };
}
