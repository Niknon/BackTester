/**
 * Опционная стратегия «на автопилоте»: по расписанию открывает выбранную конструкцию
 * (кондор, стрэнгл, спреды, покрытый колл…) со страйками по дельте по одному или нескольким
 * базовым активам на общем счёте, держит до экспирации или закрывает по правилам
 * (дни до экспирации, дельта, пробой страйка; по желанию — тейк/стоп от премии).
 * Опционально — дельта-хедж перпетуалом.
 *
 * Прогон идёт в отдельном экземпляре биржи на данных сессии: цены, IV-модель, комиссии,
 * маржа, экспирация и ликвидации — те же, что при ручной торговле. Решения принимаются
 * только по закрытым свечам (без заглядывания вперёд).
 */
import { DAY, HOUR } from '../data/intervals';
import { getAsset, optionsAvailable, roundToStep } from '../data/assets';
import { Exchange, MAIN } from './exchange';
import type { MarketData } from './market';
import { computeReport, type EquitySample, type PerformanceReport } from './metrics';
import { atmIv, eventVariance, optionFee, optionQtyStep, optionSymbol, portfolioOptionMargin, shortOptionMargin, withEvents, type OptionQuote, type PmLeg } from './options';
import type { ResolvedLeg } from './optionStrategies';
import type { ClosedPnlRecord, SessionConfig, Side } from './types';

/* ───────────────────────── Конструкции ───────────────────────── */

export type OsStructureKey =
  | 'iron_condor'
  | 'short_strangle'
  | 'short_put'
  | 'short_call'
  | 'put_credit'
  | 'call_credit'
  | 'iron_fly'
  | 'short_straddle'
  | 'covered_call'
  | 'long_straddle'
  | 'long_strangle'
  | 'long_call'
  | 'long_put'
  | 'bull_call'
  | 'bear_put'
  | 'protective_put';

/** delta — страйк по целевой дельте; atm — ближайший к цене; wing — крыло на расстоянии от основной ноги того же типа. */
export type OsAnchor = 'delta' | 'atm' | 'wing';

export interface OsLegTpl {
  side: Side;
  type: 'C' | 'P' | 'F';
  anchor: OsAnchor;
}

export interface OsStructure {
  key: OsStructureKey;
  name: string;
  /** короткая метка для графика */
  short: string;
  view: 'neutral' | 'bull' | 'bear' | 'vol';
  desc: string;
  legs: OsLegTpl[];
}

const L = (side: Side, type: 'C' | 'P' | 'F', anchor: OsAnchor = 'delta'): OsLegTpl => ({ side, type, anchor });

export const OS_STRUCTURES: OsStructure[] = [
  { key: 'iron_condor', name: 'Железный кондор', short: 'IC', view: 'neutral', desc: 'Продажа OTM-пута и OTM-колла с купленными крыльями. Премия ваша, пока цена в коридоре; риск ограничен.', legs: [L('Buy', 'P', 'wing'), L('Sell', 'P'), L('Sell', 'C'), L('Buy', 'C', 'wing')] },
  { key: 'short_strangle', name: 'Шорт стрэнгл', short: 'SS', view: 'neutral', desc: 'Продажа OTM-пута и OTM-колла без страховки. Больше премии, но риск не ограничен.', legs: [L('Sell', 'P'), L('Sell', 'C')] },
  { key: 'short_put', name: 'Продажа пута', short: 'SP', view: 'bull', desc: 'Продажа OTM-пута (аналог cash-secured put): доход от премии, риск — падение ниже страйка.', legs: [L('Sell', 'P')] },
  { key: 'short_call', name: 'Продажа колла', short: 'SC', view: 'bear', desc: 'Продажа OTM-колла: доход от премии, риск роста не ограничен.', legs: [L('Sell', 'C')] },
  { key: 'put_credit', name: 'Бычий пут-спред (кредит)', short: 'PCS', view: 'bull', desc: 'Продать пут по дельте, купить пут ниже (крыло). Кредит, риск = ширина − премия.', legs: [L('Sell', 'P'), L('Buy', 'P', 'wing')] },
  { key: 'call_credit', name: 'Медвежий колл-спред (кредит)', short: 'CCS', view: 'bear', desc: 'Продать колл по дельте, купить колл выше (крыло). Кредит, риск ограничен.', legs: [L('Sell', 'C'), L('Buy', 'C', 'wing')] },
  { key: 'iron_fly', name: 'Железная бабочка', short: 'IF', view: 'neutral', desc: 'Продажа ATM-стрэддла с купленными крыльями. Высокая премия, максимум — точно на страйке.', legs: [L('Buy', 'P', 'wing'), L('Sell', 'P', 'atm'), L('Sell', 'C', 'atm'), L('Buy', 'C', 'wing')] },
  { key: 'short_straddle', name: 'Шорт стрэддл', short: 'SSD', view: 'neutral', desc: 'Продажа ATM-колла и ATM-пута. Максимальный временной распад, риск не ограничен.', legs: [L('Sell', 'P', 'atm'), L('Sell', 'C', 'atm')] },
  { key: 'covered_call', name: 'Покрытый колл', short: 'CC', view: 'neutral', desc: 'Лонг перпетуала + продажа OTM-колла: доход от премии, рост ограничен страйком.', legs: [L('Buy', 'F', 'atm'), L('Sell', 'C')] },
  { key: 'long_straddle', name: 'Лонг стрэддл', short: 'LSD', view: 'vol', desc: 'Покупка ATM-колла и ATM-пута: заработок на сильном движении. С дельта-хеджем — ставка на то, что реализованная волатильность выше подразумеваемой.', legs: [L('Buy', 'C', 'atm'), L('Buy', 'P', 'atm')] },
  { key: 'long_strangle', name: 'Лонг стрэнгл', short: 'LSG', view: 'vol', desc: 'Покупка OTM-колла и OTM-пута: дешевле стрэддла, нужно более сильное движение.', legs: [L('Buy', 'P'), L('Buy', 'C')] },
  { key: 'long_call', name: 'Покупка колла', short: 'LC', view: 'bull', desc: 'Покупка колла по дельте: риск = премия, прибыль при росте не ограничена.', legs: [L('Buy', 'C')] },
  { key: 'long_put', name: 'Покупка пута', short: 'LP', view: 'bear', desc: 'Покупка пута по дельте: риск = премия, заработок на падении.', legs: [L('Buy', 'P')] },
  { key: 'bull_call', name: 'Бычий колл-спред (дебет)', short: 'BCS', view: 'bull', desc: 'Купить колл по дельте, продать колл выше (крыло). Дешевле колла, прибыль ограничена.', legs: [L('Buy', 'C'), L('Sell', 'C', 'wing')] },
  { key: 'bear_put', name: 'Медвежий пут-спред (дебет)', short: 'BPS', view: 'bear', desc: 'Купить пут по дельте, продать пут ниже (крыло).', legs: [L('Buy', 'P'), L('Sell', 'P', 'wing')] },
  { key: 'protective_put', name: 'Защитный пут', short: 'PP', view: 'bull', desc: 'Лонг перпетуала + покупка пута по дельте: страховка от падения.', legs: [L('Buy', 'F', 'atm'), L('Buy', 'P')] },
];

export const OS_BY_KEY = Object.fromEntries(OS_STRUCTURES.map((s) => [s.key, s])) as Record<OsStructureKey, OsStructure>;

export const usesDelta = (st: OsStructure) => st.legs.some((l) => l.anchor === 'delta' && l.type !== 'F');
export const usesWing = (st: OsStructure) => st.legs.some((l) => l.anchor === 'wing');
export const hasPerpLeg = (st: OsStructure) => st.legs.some((l) => l.type === 'F');
/** Убыток не ограничен (проданных коллов больше, чем купленных коллов и лонгов перпетуала). */
export function unlimitedRisk(st: OsStructure) {
  let slope = 0;
  for (const l of st.legs) if (l.type !== 'P') slope += l.side === 'Buy' ? 1 : -1;
  return slope < 0;
}

/* ───────────────────────── Настройки ───────────────────────── */

export type OsSchedule = 'daily' | 'weekdays' | 'weekly';
export type OsSizeMode = 'risk' | 'notional' | 'margin' | 'qty';
export type OsTrend = 'off' | 'above' | 'below';
/** within — самая дальняя экспирация не позже N дней (позиция не переживает следующий вход); nearest — ближайшая к N дням */
export type OsExpiryMode = 'within' | 'nearest';

export interface OsSettings {
  /** базовые активы: по каждому стратегия ведёт свои конструкции, счёт и маржа — общие */
  underlyings: string[];
  structure: OsStructureKey;
  initialBalance: number;
  /** целевая |дельта| основных ног (0.05…0.5) */
  delta: number;
  wingMode: 'pct' | 'delta';
  /** ширина крыла, % от цены */
  wingPct: number;
  /** |дельта| крыла */
  wingDelta: number;
  /** дни до экспирации */
  dte: number;
  expiryMode: OsExpiryMode;
  schedule: OsSchedule;
  /** день недели для weekly: 0 — вс, 1 — пн … 5 — пт */
  weekday: number;
  /** час входа, UTC */
  entryHour: number;
  /** максимум одновременно открытых конструкций на каждый актив */
  maxOpen: number;
  /** фильтр ATM IV, % (0 — выкл.) */
  ivMin: number;
  ivMax: number;
  /** фильтр IV-ранга, % (0…100; 0/100 — выкл.) */
  ivRankMin: number;
  ivRankMax: number;
  ivRankDays: number;
  trend: OsTrend;
  trendSma: number;
  sizeMode: OsSizeMode;
  /** % капитала: макс. убыток на экспирации (на одну конструкцию) */
  riskPct: number;
  /** % капитала: номинал базового актива на одну ногу */
  notionalPct: number;
  /** % доступных средств под маржу/премию */
  marginPct: number;
  /** фиксированное кол-во контрактов на ногу */
  qty: number;
  /** потолок средств на одну конструкцию включён */
  useCap: boolean;
  /** потолок средств (премия покупок + маржа продаж) на одну конструкцию, USDT: ликвидность реального рынка конечна */
  capUsd: number;
  /** тейк-профит включён */
  useTp: boolean;
  /** тейк-профит, % от премии */
  tpPct: number;
  /** стоп-лосс включён */
  useSl: boolean;
  /** стоп-лосс, % от премии */
  slPct: number;
  /** закрыть, когда до экспирации осталось ≤ N дней (0 — держать до экспирации) */
  closeDte: number;
  /** закрыть, если |дельта| проданной ноги ≥ (0 — выкл.) */
  deltaExit: number;
  /** закрыть, если цена ушла за проданный страйк */
  breachExit: boolean;
  /** дельта-хедж перпетуалом */
  hedge: boolean;
  /** допуск по дельте на 1 контракт конструкции */
  hedgeBand: number;
  /** проверять хедж не чаще, чем раз в N часов (0 — каждую свечу) */
  hedgeHours: number;
  /**
   * Маржа опционов: portfolio — по худшему сценарию всей книги (Portfolio Margin Bybit: купленные крылья
   * уменьшают требование до реального риска); regular — каждая проданная нога отдельно (Regular Margin).
   * Нет в старых сохранённых настройках — portfolio.
   */
  marginMode?: 'portfolio' | 'regular';
}

export const DEFAULT_OS: Omit<OsSettings, 'underlyings' | 'initialBalance'> = {
  structure: 'iron_condor',
  delta: 0.15,
  wingMode: 'pct',
  wingPct: 5,
  wingDelta: 0.05,
  dte: 7,
  expiryMode: 'within',
  schedule: 'weekly',
  weekday: 5,
  entryHour: 8,
  maxOpen: 1,
  ivMin: 0,
  ivMax: 0,
  ivRankMin: 0,
  ivRankMax: 100,
  ivRankDays: 180,
  trend: 'off',
  trendSma: 50,
  sizeMode: 'risk',
  riskPct: 5,
  notionalPct: 50,
  marginPct: 30,
  qty: 0.1,
  // без потолка сложный процент «покупает» больше, чем весь рынок опционов
  useCap: true,
  capUsd: 1_000_000,
  // опционы держим до экспирации; тейк и стоп — по желанию
  useTp: false,
  tpPct: 50,
  useSl: false,
  slPct: 200,
  closeDte: 0,
  deltaExit: 0,
  breachExit: false,
  hedge: false,
  hedgeBand: 0.1,
  hedgeHours: 4,
  marginMode: 'portfolio',
};

export interface OsPreset {
  name: string;
  desc: string;
  s: Partial<OsSettings>;
}

const HOLD = { useTp: false, useSl: false, closeDte: 0, deltaExit: 0, breachExit: false, hedge: false } as const;

export const OS_PRESETS: OsPreset[] = [
  { name: 'Недельный кондор 15Δ', desc: 'Каждую пятницу 08:00 UTC — железный кондор на неделю, держим до экспирации.', s: { ...HOLD, structure: 'iron_condor', delta: 0.15, wingMode: 'pct', wingPct: 5, dte: 7, expiryMode: 'within', schedule: 'weekly', weekday: 5, entryHour: 8, maxOpen: 1, sizeMode: 'risk', riskPct: 5 } },
  { name: 'Стрэнгл 45/21 (16Δ)', desc: 'Классика продажи премии: шорт стрэнгл 16Δ на ~45 дней, выход на 50% прибыли или за 21 день до экспирации.', s: { ...HOLD, structure: 'short_strangle', delta: 0.16, dte: 45, expiryMode: 'nearest', schedule: 'weekly', weekday: 1, entryHour: 8, maxOpen: 3, sizeMode: 'notional', notionalPct: 30, useTp: true, tpPct: 50, closeDte: 21 } },
  { name: 'Продажа пута 25Δ (месяц)', desc: 'Шорт пут 25Δ на ~30 дней с риском «как cash-secured put», держим до экспирации.', s: { ...HOLD, structure: 'short_put', delta: 0.25, dte: 30, expiryMode: 'nearest', schedule: 'weekly', weekday: 5, entryHour: 8, maxOpen: 2, sizeMode: 'risk', riskPct: 40 } },
  { name: 'Ежедневный кондор 10Δ', desc: 'Каждый день в 08:00 UTC — кондор на сутки, держим до экспирации.', s: { ...HOLD, structure: 'iron_condor', delta: 0.1, wingMode: 'pct', wingPct: 3, dte: 1, expiryMode: 'nearest', schedule: 'daily', entryHour: 8, maxOpen: 1, sizeMode: 'risk', riskPct: 2 } },
  { name: 'Покрытый колл 30Δ (неделя)', desc: 'Лонг перпетуала и продажа недельного колла 30Δ каждую пятницу.', s: { ...HOLD, structure: 'covered_call', delta: 0.3, dte: 7, expiryMode: 'within', schedule: 'weekly', weekday: 5, entryHour: 8, maxOpen: 1, sizeMode: 'notional', notionalPct: 80 } },
  { name: 'Лонг стрэддл + дельта-хедж', desc: 'Покупка ATM-стрэддла на месяц с хеджем перпетуалом: ставка на то, что рынок будет двигаться сильнее, чем заложено в IV. Закрытие за 7 дней до экспирации.', s: { ...HOLD, structure: 'long_straddle', dte: 30, expiryMode: 'nearest', schedule: 'weekly', weekday: 1, entryHour: 8, maxOpen: 1, sizeMode: 'risk', riskPct: 5, closeDte: 7, hedge: true, hedgeBand: 0.1, hedgeHours: 4 } },
  { name: 'Пут-спред при высокой IV', desc: 'Бычий пут-спред 25Δ, только если IV-ранг выше 50% и цена выше SMA 50; держим до экспирации.', s: { ...HOLD, structure: 'put_credit', delta: 0.25, wingMode: 'pct', wingPct: 5, dte: 14, expiryMode: 'within', schedule: 'daily', entryHour: 8, maxOpen: 3, ivRankMin: 50, ivRankMax: 100, trend: 'above', trendSma: 50, sizeMode: 'risk', riskPct: 3 } },
];

/** Активы сессии, на которые есть опционы. */
export function optionUnderlyings(market: MarketData): string[] {
  return market.symbols().filter((s) => {
    try {
      return optionsAvailable(getAsset(s));
    } catch {
      return false;
    }
  });
}

export function makeSettings(underlyings: string | string[], initialBalance: number, over: Partial<OsSettings> = {}): OsSettings {
  return { ...DEFAULT_OS, underlyings: Array.isArray(underlyings) ? underlyings : [underlyings], initialBalance, ...over };
}

/* ───────────────────────── Выбор ног ───────────────────────── */

type ChainRow = { strike: number; call: OptionQuote; put: OptionQuote };

const quoteOf = (r: ChainRow, t: 'C' | 'P') => (t === 'C' ? r.call : r.put);

/**
 * Выбор экспирации. Не ближе 2 часов до момента расчёта (settle — момент расчёта экспирации на бирже).
 *  - nearest: ближайшая к N дням (при равенстве — более поздняя);
 *  - within: самая дальняя не позже N дней (+1 ч допуска), а если таких нет — ближайшая.
 */
export function pickExpiry(expiries: number[], now: number, dte: number, mode: OsExpiryMode = 'nearest', settle: (e: number) => number = (e) => e): number | null {
  const ok = expiries.filter((e) => settle(e) - now >= 2 * HOUR).sort((a, b) => a - b);
  if (!ok.length) return null;
  if (mode === 'within') {
    const lim = now + dte * DAY + HOUR;
    const inside = ok.filter((e) => e <= lim);
    return inside.length ? inside[inside.length - 1] : ok[0];
  }
  let best: number | null = null;
  let bestD = Infinity;
  for (const e of ok) {
    const d = Math.abs((e - now) / DAY - dte);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && best !== null && e > best)) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

function nearestBy(rows: ChainRow[], score: (r: ChainRow) => number, ok: (r: ChainRow) => boolean = () => true): ChainRow | null {
  let best: ChainRow | null = null;
  let bs = Infinity;
  for (const r of rows) {
    if (!ok(r)) continue;
    const v = score(r);
    if (v < bs) {
      bs = v;
      best = r;
    }
  }
  return best;
}

export interface PickResult {
  legs: ResolvedLeg[];
  expiry: number;
  S: number;
  atmIv: number;
  error?: string;
}

/**
 * Подобрать ноги конструкции на текущий момент биржи (объём — `qty` на ногу) для базового актива.
 * Основные ноги — по дельте (или ATM), крылья — на заданном расстоянии в сторону OTM.
 */
export function pickLegs(ex: Exchange, s: OsSettings, qty: number, underlying = s.underlyings[0]): PickResult {
  const st = OS_BY_KEY[s.structure];
  const spec = getAsset(underlying);
  const base = spec.base;
  const S = ex.price(underlying);
  const fail = (error: string): PickResult => ({ legs: [], expiry: 0, S, atmIv: 0, error });
  if (!Number.isFinite(S)) return fail('Нет цены базового актива');
  // экспирации, до расчёта которых не осталось торгового времени (акция в пятницу вечером → понедельник 08:00 UTC,
  // до открытия), — не опционы, а их внутренняя стоимость: такие не берём
  const live = ex.optionExpiries(base).filter((e) => ex.optionT(underlying, e) * 365 * DAY >= 2 * HOUR);
  const expiry = pickExpiry(live, ex.now, s.dte, s.expiryMode, (e) => ex.settleTime(e));
  if (!expiry) return fail('Нет подходящей экспирации');
  const chain = ex.optionChain(base, expiry);
  const rows = chain.rows;
  if (!rows.length) return fail('Пустая цепочка опционов');
  // основные ноги (не крылья): страйк по типу
  const main: Partial<Record<'C' | 'P', ChainRow>> = {};
  for (const l of st.legs) {
    if (l.type === 'F' || l.anchor === 'wing') continue;
    let r: ChainRow | null;
    if (l.anchor === 'atm') r = nearestBy(rows, (x) => Math.abs(x.strike - S));
    else {
      // по дельте среди OTM-страйков; для продаж — только с ненулевым bid
      const otm = (x: ChainRow) => (l.type === 'C' ? x.strike >= S : x.strike <= S);
      const sellable = (x: ChainRow) => l.side === 'Buy' || quoteOf(x, l.type as 'C' | 'P').bid > 0;
      r = nearestBy(rows, (x) => Math.abs(Math.abs(quoteOf(x, l.type as 'C' | 'P').greeks.delta) - s.delta), (x) => otm(x) && sellable(x));
      r ??= nearestBy(rows, (x) => Math.abs(Math.abs(quoteOf(x, l.type as 'C' | 'P').greeks.delta) - s.delta), sellable);
    }
    if (!r) return fail('Не найден страйк по заданной дельте');
    main[l.type] = r;
  }
  const legs: ResolvedLeg[] = [];
  for (const l of st.legs) {
    if (l.type === 'F') {
      legs.push({ category: 'linear', symbol: underlying, side: l.side, type: 'F', strike: 0, expiry: 0, qty, price: S, mark: S, delta: l.side === 'Buy' ? qty : -qty });
      continue;
    }
    const t = l.type;
    let r: ChainRow | null;
    if (l.anchor === 'wing') {
      const m = main[t];
      if (!m) return fail('Крыло без основной ноги');
      const beyond = (x: ChainRow) => (t === 'C' ? x.strike > m.strike : x.strike < m.strike);
      if (s.wingMode === 'delta') r = nearestBy(rows, (x) => Math.abs(Math.abs(quoteOf(x, t).greeks.delta) - s.wingDelta), beyond);
      else {
        const target = t === 'C' ? m.strike + (S * s.wingPct) / 100 : m.strike - (S * s.wingPct) / 100;
        r = nearestBy(rows, (x) => Math.abs(x.strike - target), beyond);
      }
      if (!r) return fail('Нет страйка для крыла (цепочка слишком узкая) — уменьшите ширину крыла');
    } else r = main[t]!;
    const q = quoteOf(r, t);
    const price = l.side === 'Buy' ? q.ask : q.bid;
    const symbol = optionSymbol(base, expiry, r.strike, t);
    if (!(price > 0)) return fail(`${symbol}: нет покупателей (bid = 0)`);
    legs.push({ category: 'option', symbol, side: l.side, type: t, strike: r.strike, expiry, qty, price, mark: q.mark, delta: q.greeks.delta * qty * (l.side === 'Buy' ? 1 : -1) });
  }
  return { legs, expiry, S, atmIv: chain.atm };
}

/** Изменить объём ног (с пересчётом дельты). */
export function scaleLegs(legs: ResolvedLeg[], qty: number): ResolvedLeg[] {
  return legs.map((l) => ({ ...l, delta: l.qty > 0 ? (l.delta / l.qty) * qty : 0, qty }));
}

/* ───────────────────────── Экономика конструкции ───────────────────────── */

export interface UnitEconomics {
  /** чистая премия опционов на 1 контракт: + кредит, − дебет */
  premium: number;
  /** макс. убыток на экспирации на 1 контракт (Infinity — не ограничен) */
  maxLoss: number;
  /** макс. прибыль на экспирации на 1 контракт (Infinity — не ограничена) */
  maxProfit: number;
  /** комиссия входа на 1 контракт */
  fee: number;
  /** требуемые средства (премия покупок + маржа продаж) на 1 контракт */
  margin: number;
  /** точки безубыточности на экспирации */
  breakevens: number[];
}

/** Выплата конструкции на экспирации (на 1 контракт, с учётом премии, без комиссий). */
export function payoffAt(legs: ResolvedLeg[], S0: number, ST: number) {
  let v = 0;
  for (const l of legs) {
    const sg = l.side === 'Buy' ? 1 : -1;
    if (l.type === 'F') v += sg * (ST - S0);
    else v += sg * ((l.type === 'C' ? Math.max(0, ST - l.strike) : Math.max(0, l.strike - ST)) - l.price);
  }
  return v;
}

export function unitEconomics(ex: Exchange, legs: ResolvedLeg[], S: number, marginMode = ex.optionMarginMode): UnitEconomics {
  const fees = ex.config.fees;
  let premium = 0;
  let fee = 0;
  let margin = 0;
  let regIm = 0;
  const pmLegs: PmLeg[] = [];
  let slope = 0;
  const pts = new Set<number>([0]);
  for (const l of legs) {
    const sg = l.side === 'Buy' ? 1 : -1;
    if (l.type === 'F') {
      slope += sg;
      fee += S * fees.linearTaker;
      margin += S / ex.leverageOf(ex.main, l.symbol) + S * fees.linearTaker;
      continue;
    }
    if (l.type === 'C') slope += sg;
    pts.add(l.strike);
    premium -= sg * l.price;
    const f = optionFee(fees.optionTaker, fees.optionFeeCap, S, l.price, 1);
    fee += f;
    if (l.side === 'Buy') margin += l.price + f;
    else {
      const inst = ex.optionInstrument(l.symbol)!;
      const m = shortOptionMargin(ex.config.options, inst, S, l.mark);
      regIm += m.im;
      margin += Math.max(0, l.mark - l.price) + f;
    }
    const q = ex.optionQuote(l.symbol, S);
    if (q) pmLegs.push({ type: l.type, strike: l.strike, size: sg, mark: q.mark, iv: q.iv, T: q.T });
  }
  // маржа продаж: стандартная — по каждой проданной ноге; портфельная — по худшему сценарию всей конструкции
  margin += marginMode === 'portfolio' && regIm > 0 ? Math.min(regIm, portfolioOptionMargin(pmLegs, S).im) : regIm;
  const xs = [...pts].sort((a, b) => a - b);
  const hi = Math.max(S, xs[xs.length - 1]) * 3;
  xs.push(hi);
  let minV = Infinity;
  let maxV = -Infinity;
  for (const x of xs) {
    const v = payoffAt(legs, S, x);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  // безубыточность: смена знака между соседними точками излома
  const be: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = payoffAt(legs, S, xs[i - 1]);
    const b = payoffAt(legs, S, xs[i]);
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) be.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * (0 - a)) / (b - a));
  }
  return {
    premium,
    maxLoss: slope < -1e-9 ? Infinity : Math.max(0, -minV) + fee,
    maxProfit: slope > 1e-9 ? Infinity : Math.max(0, maxV) - fee,
    fee,
    margin,
    breakevens: be.filter((x) => x > 0 && x < hi * 0.999),
  };
}

/** Размер конструкции (контрактов на ногу) по правилам; 0 — меньше минимального шага. */
export function sizeFor(
  ex: Exchange,
  s: OsSettings,
  eco: UnitEconomics,
  S: number,
  /** капитал вместо счёта биржи (предпросмотр на бирже сессии с другим депозитом) */
  capital?: { equity: number; available: number },
  underlying = s.underlyings[0],
): { qty: number; step: number; error?: string; capped?: boolean } {
  const st = OS_BY_KEY[s.structure];
  let step = optionQtyStep(S);
  if (hasPerpLeg(st)) step = Math.max(step, getAsset(underlying).qtyStep);
  const equity = capital?.equity ?? ex.equity(ex.main);
  const available = capital?.available ?? ex.available(ex.main);
  let raw: number;
  switch (s.sizeMode) {
    case 'qty':
      raw = s.qty;
      break;
    case 'notional':
      raw = (equity * s.notionalPct) / 100 / S;
      break;
    case 'margin':
      raw = eco.margin > 0 ? (Math.max(0, available) * s.marginPct) / 100 / eco.margin : 0;
      break;
    default:
      if (!Number.isFinite(eco.maxLoss)) return { qty: 0, step, error: 'Риск конструкции не ограничен — выберите размер по номиналу, марже или количеству' };
      raw = eco.maxLoss > 0 ? (equity * s.riskPct) / 100 / eco.maxLoss : 0;
  }
  let capped = false;
  if (s.useCap && s.capUsd > 0 && eco.margin > 0 && raw * eco.margin > s.capUsd) {
    raw = s.capUsd / eco.margin;
    capped = true;
  }
  const qty = roundToStep(raw, step, 'floor');
  if (!(qty >= step - 1e-12)) return { qty: 0, step, error: `Объём меньше минимального шага ${step}` };
  return { qty, step, capped };
}

/* ───────────────────────── Результат ───────────────────────── */

export type OsExitReason = 'tp' | 'sl' | 'dte' | 'delta' | 'breach' | 'expiry' | 'end' | 'liquidation' | 'rejected';

export const OS_REASON_LABEL: Record<OsExitReason, string> = {
  tp: 'Тейк-профит',
  sl: 'Стоп-лосс',
  dte: 'По дням до экспирации',
  delta: 'По дельте',
  breach: 'Пробой страйка',
  expiry: 'Экспирация',
  end: 'Конец периода',
  liquidation: 'Ликвидация',
  rejected: 'Остаток отклонённого входа',
};

export interface OsLeg {
  symbol: string;
  side: Side;
  type: 'C' | 'P' | 'F';
  strike: number;
  expiry: number;
  qty: number;
  entry: number;
  entryIv: number;
  entryDelta: number;
  exit?: number;
  exitTime?: number;
  /** закрыта экспирацией (поставкой) */
  settled?: boolean;
  fees: number;
  open: boolean;
}

export interface OsTrade {
  id: number;
  underlying: string;
  structure: OsStructureKey;
  openTime: number;
  closeTime?: number;
  expiry: number;
  S0: number;
  S1?: number;
  qty: number;
  legs: OsLeg[];
  /** чистая премия опционов (USDT): + кредит, − дебет */
  premium: number;
  maxLoss: number;
  maxProfit: number;
  breakevens: number[];
  atmIv: number;
  ivRank: number | null;
  fees: number;
  pnl: number;
  reason?: OsExitReason;
  /** макс. нереализованный убыток за время жизни */
  mae: number;
  /** проданный опцион экспирировался в деньгах */
  itm?: boolean;
  /** доля списания при ликвидации (страховой фонд и т. п.), уже включена в pnl */
  liqAdj?: number;
}

export interface OsSkipStats {
  maxOpen: number;
  iv: number;
  ivRank: number;
  trend: number;
  chain: number;
  size: number;
  /** не хватает средств на премию и маржу (вход не делался) */
  funds: number;
  /** биржа отклонила ногу — вход откатан */
  rejected: number;
}

export interface OsAssetStats {
  trades: number;
  wins: number;
  pnl: number;
  premiumIn: number;
  premiumOut: number;
}

export interface OsStats {
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  avgPnl: number;
  premiumIn: number;
  premiumOut: number;
  fees: number;
  avgDays: number;
  avgIv: number;
  expiredItm: number;
  byReason: Partial<Record<OsExitReason, { n: number; pnl: number }>>;
  byAsset: Record<string, OsAssetStats>;
  hedge: { trades: number; pnl: number; fees: number; funding: number };
  /** потери на откатах отклонённых входов (спред и комиссии) */
  failedEntries: { n: number; cost: number };
  /** прочее изменение капитала, не привязанное к сделкам (funding перпетуальных ног и т. п.) */
  other: number;
  /** входов, урезанных потолком средств на конструкцию */
  capped: number;
  /** конструкции, которые застали отчёт компании (скачок цены на отчёте пришёлся на время жизни) */
  reports: { trades: number; wins: number; pnl: number };
  bestTrade: number;
  worstTrade: number;
  skips: OsSkipStats;
}

export interface OsResult {
  ok: boolean;
  error?: string;
  settings: OsSettings;
  report: PerformanceReport;
  equity: EquitySample[];
  bench: EquitySample[];
  benchLabel: string;
  trades: OsTrade[];
  stats: OsStats;
  log: { t: number; msg: string }[];
  hedgeFills: { t: number; underlying: string; side: Side; qty: number; price: number }[];
  durationMs: number;
  bars: number;
  halted?: string;
  /** подозрительные скачки цены базовых активов (вероятная ошибка данных) */
  dataWarnings?: string[];
}

export interface OsRunOptions {
  onProgress?: (frac: number) => void;
  signal?: { aborted: boolean };
  sliceMs?: number;
  /** не вести журнал (быстрый перебор) */
  noLog?: boolean;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const emptyStats = (): OsStats => ({
  trades: 0,
  wins: 0,
  winRate: 0,
  pnl: 0,
  avgPnl: 0,
  premiumIn: 0,
  premiumOut: 0,
  fees: 0,
  avgDays: 0,
  avgIv: 0,
  expiredItm: 0,
  byReason: {},
  byAsset: {},
  hedge: { trades: 0, pnl: 0, fees: 0, funding: 0 },
  failedEntries: { n: 0, cost: 0 },
  other: 0,
  capped: 0,
  reports: { trades: 0, wins: 0, pnl: 0 },
  bestTrade: 0,
  worstTrade: 0,
  skips: { maxOpen: 0, iv: 0, ivRank: 0, trend: 0, chain: 0, size: 0, funds: 0, rejected: 0 },
});

/** Проверка настроек до прогона. */
export function validateSettings(s: OsSettings): string | null {
  const st = OS_BY_KEY[s.structure];
  if (!st) return 'Неизвестная конструкция';
  if (!s.underlyings?.length) return 'Выберите хотя бы один базовый актив';
  if (!(s.initialBalance > 0)) return 'Укажите депозит';
  if (usesDelta(st) && !(s.delta > 0 && s.delta < 1)) return 'Дельта основных ног должна быть между 0 и 1';
  if (usesWing(st) && s.wingMode === 'pct' && !(s.wingPct > 0)) return 'Ширина крыла должна быть больше 0';
  if (usesWing(st) && s.wingMode === 'delta' && !(s.wingDelta > 0 && s.wingDelta < s.delta)) return 'Дельта крыла должна быть больше 0 и меньше дельты основных ног';
  if (!(s.dte > 0)) return 'Дней до экспирации должно быть больше 0';
  if (s.closeDte > 0 && s.closeDte >= s.dte) return '«Закрыть за N дней» должно быть меньше срока опциона';
  if (!(s.maxOpen >= 1)) return 'Максимум открытых конструкций — не меньше 1';
  if (s.useTp && !(s.tpPct > 0)) return 'Тейк-профит включён — укажите его размер';
  if (s.useSl && !(s.slPct > 0)) return 'Стоп-лосс включён — укажите его размер';
  if (s.useCap && !(s.capUsd > 0)) return 'Потолок на конструкцию включён — укажите сумму';
  if (s.sizeMode === 'risk' && unlimitedRisk(st)) return 'У этой конструкции риск не ограничен — выберите размер по номиналу, марже или количеству';
  if (s.hedge && hasPerpLeg(st)) return 'Дельта-хедж недоступен для конструкций с перпетуалом';
  return null;
}

/* ───────────────────────── Прогон ───────────────────────── */

interface AssetState {
  u: string;
  base: string;
  qtyStep: number;
  minQty: number;
  lastEntryDay: number;
  lastMaxOpenDay: number;
  lastHedge: number;
}

export async function runOptionStrategy(market: MarketData, sessionCfg: SessionConfig, s: OsSettings, opts: OsRunOptions = {}): Promise<OsResult> {
  const t0 = performance.now();
  const log: OsResult['log'] = [];
  const stats = emptyStats();
  const trades: OsTrade[] = [];
  const hedgeFills: OsResult['hedgeFills'] = [];
  const unders = [...new Set(s.underlyings)];
  const benchLabel = unders.length === 1 ? `${unders[0].replace(/USDT$/, '')} buy&hold` : `Корзина ${unders.map((u) => u.replace(/USDT$/, '')).join('+')} (поровну)`;
  const fail = (error: string): OsResult => ({
    ok: false,
    error,
    settings: s,
    report: computeReport([], []),
    equity: [],
    bench: [],
    benchLabel,
    trades,
    stats,
    log,
    hedgeFills,
    durationMs: performance.now() - t0,
    bars: 0,
  });
  const verr = validateSettings(s);
  if (verr) return fail(verr);
  const assets: AssetState[] = [];
  for (const u of unders) {
    if (!market.has(u)) return fail(`Нет данных по ${u}`);
    let spec;
    try {
      spec = getAsset(u);
    } catch {
      return fail(`Неизвестный актив ${u}`);
    }
    if (!optionsAvailable(spec)) return fail(`На ${u} нет опционов`);
    assets.push({ u, base: spec.base, qtyStep: spec.qtyStep, minQty: spec.minQty, lastEntryDay: -1, lastMaxOpenDay: -1, lastHedge: -Infinity });
  }
  const st = OS_BY_KEY[s.structure];
  const config: SessionConfig = {
    ...sessionCfg,
    initialBalance: s.initialBalance,
    symbols: unders,
    options: { ...sessionCfg.options, marginMode: s.marginMode ?? 'portfolio' },
  };
  const ex = Exchange.create(config, market);
  ex.quiet = true;
  ex.activeSymbols = unders;
  const multi = unders.length > 1;
  const say = (msg: string, u?: string) => {
    if (!opts.noLog && log.length < 5000) log.push({ t: ex.now, msg: multi && u ? `[${u.replace(/USDT$/, '')}] ${msg}` : msg });
  };
  const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
  const open: OsTrade[] = [];
  let seq = 0;
  let halted: string | undefined;
  let liquidated = false;
  let liqInfo: { equity?: number; mm?: number } | null = null;

  const deliveryFee = (S: number, payoff: number, qty: number) =>
    payoff > 0 ? Math.min(config.fees.optionDelivery * S * qty, config.fees.optionFeeCap * payoff * qty) : 0;

  const finalize = (g: OsTrade) => {
    let pnl = 0;
    let fees = 0;
    for (const l of g.legs) {
      const sg = l.side === 'Buy' ? 1 : -1;
      pnl += sg * ((l.exit ?? l.entry) - l.entry) * l.qty;
      fees += l.fees;
    }
    g.fees = fees;
    g.pnl = pnl - fees;
    g.closeTime ??= Math.max(g.openTime, ...g.legs.map((l) => l.exitTime ?? g.openTime));
  };

  // цена расчёта по экспирациям (из события биржи); запасной вариант — открытие свечи, в которой наступила экспирация
  const settlePx = new Map<string, number>();
  ex.on((e) => {
    if (e.type === 'liquidation' && e.accountId === MAIN) {
      liquidated = true;
      liqInfo = e;
    }
    if (e.type === 'expiry' && e.accountId === MAIN)
      for (const it of e.items) {
        const inst = ex.optionInstrument(it.symbol);
        if (inst) settlePx.set(`${inst.underlying}|${inst.expiry}`, it.underlyingPrice);
      }
  });
  const settlementPrice = (u: string, expiry: number) => {
    const known = settlePx.get(`${u}|${expiry}`);
    if (known !== undefined) return known;
    const series = market.series.get(u)!;
    let lo = 0;
    let hi = series.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (series.t[m] <= expiry) lo = m + 1;
      else hi = m;
    }
    const i = Math.max(0, lo - 1);
    return series.t[i] + market.dt > expiry ? series.o[i] : series.c[i];
  };

  /** Рассчитать наши ноги, у которых наступила экспирация (по своим книгам — позиции на бирже могут быть неттированы). */
  const settleLegs = () => {
    for (const g of open) {
      let settledNow = false;
      for (const l of g.legs) {
        // как и биржа: расчёт на свече, внутри которой наступила экспирация (после неё now > expiry)
        if (!l.open || l.type === 'F' || l.expiry >= ex.now) continue;
        const S = settlementPrice(g.underlying, l.expiry);
        const payoff = l.type === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
        l.exit = payoff;
        l.exitTime = l.expiry;
        l.settled = true;
        l.open = false;
        l.fees += deliveryFee(S, payoff, l.qty);
        settledNow = true;
        if (payoff > 0 && l.side === 'Sell') g.itm = true;
        g.S1 = S;
      }
      if (settledNow && !g.reason) {
        g.reason = 'expiry';
        g.closeTime = g.expiry;
        if (g.itm) stats.expiredItm++;
      }
    }
  };

  /** Стоимость ноги сейчас (по mark; для закрытых — цена выхода/выплата). */
  const legMark = (l: OsLeg, S: number) => {
    if (!l.open) return l.exit ?? 0;
    if (l.type === 'F') return S;
    return ex.optionMark(l.symbol, S);
  };
  const groupPnl = (g: OsTrade, S: number) => {
    let v = 0;
    let fees = 0;
    for (const l of g.legs) {
      v += (l.side === 'Buy' ? 1 : -1) * (legMark(l, S) - l.entry) * l.qty;
      fees += l.fees;
    }
    return v - fees;
  };

  const closeGroup = (g: OsTrade, reason: OsExitReason) => {
    const S = ex.price(g.underlying);
    // сначала выкупаем проданные ноги (освобождаем маржу), затем продаём купленные
    const legs = [...g.legs].sort((a, b) => Number(a.side === 'Buy') - Number(b.side === 'Buy'));
    for (const l of legs) {
      if (!l.open) continue;
      const side: Side = l.side === 'Buy' ? 'Sell' : 'Buy';
      const o = ex.placeOrder({ category: l.type === 'F' ? 'linear' : 'option', symbol: l.symbol, side, orderType: 'Market', qty: l.qty, tag: 'opt-strategy' });
      if (o.status === 'Filled' && o.filledQty > 0) {
        l.exit = o.avgPrice;
        l.exitTime = ex.now;
        l.fees += o.cumFee;
        l.open = false;
      } else if (l.type !== 'F' && l.side === 'Buy') {
        // купленный опцион без покупателей (bid = 0) — остаётся до экспирации и рассчитается по ней
        say(`${l.symbol}: нет покупателей — нога останется до экспирации`, g.underlying);
      } else say(`${l.symbol}: не удалось закрыть (${o.rejectReason ?? o.status})`, g.underlying);
    }
    if (!g.reason || g.reason === 'expiry') g.reason = reason;
    g.S1 = S;
    g.closeTime = ex.now;
  };

  /**
   * Конструкция «уже рассчитывается»: все её открытые опционы экспирируются на ближайшей свече (момент расчёта
   * наступил) — решений по ней больше нет, закрыть по рынку нельзя, и лимит открытых она не занимает.
   */
  const settling = (g: OsTrade) => {
    const opts = g.legs.filter((l) => l.open && l.type !== 'F');
    return opts.length > 0 && opts.every((l) => ex.settleTime(l.expiry) <= ex.now);
  };
  /** Активные конструкции (ещё не получили сигнал на выход и не рассчитываются). */
  const active = (u?: string) => open.filter((g) => !g.reason && !settling(g) && (!u || g.underlying === u));

  /** Перенести полностью закрытые конструкции в список сделок. */
  const sweep = () => {
    for (let i = open.length - 1; i >= 0; i--) {
      const g = open[i];
      // опционы рассчитаны экспирацией, а перпетуальная нога ещё открыта — закрываем её
      if (g.reason === 'expiry' && g.legs.some((l) => l.open && l.type === 'F') && !g.legs.some((l) => l.open && l.type !== 'F')) closeGroup(g, 'expiry');
      // ждём, пока закроются все ноги (включая купленные опционы без покупателей — до их экспирации)
      if (!g.reason || g.legs.some((l) => l.open)) continue;
      finalize(g);
      open.splice(i, 1);
      trades.push(g);
      say(`Закрыт #${g.id} ${st.short}: ${OS_REASON_LABEL[g.reason]}, PnL ${fmt(g.pnl)} USDT`, g.underlying);
    }
  };

  /** ATM IV того же срока на прошлые дни (с отчётами, которые тогда были впереди) — для IV-ранга. */
  const ivHistory = (u: string, T: number, settle: number, days: number): number[] => {
    const out: number[] = [];
    for (let k = 1; k <= days; k++) {
      const at = ex.now - k * DAY;
      const vi = ex.volInputs(u, at);
      if (vi.rv7 == null && vi.rv30 == null && vi.dvol == null) continue; // до начала истории
      const v = withEvents(atmIv(config.options, vi, T), T, eventVariance(config.options, vi, at, settle - k * DAY));
      if (Number.isFinite(v) && v > 0) out.push(v);
    }
    return out;
  };

  const sma = (u: string, n: number): number | null => {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const c = market.closeAt(u, ex.now - k * DAY);
      if (c === undefined) return null;
      sum += c;
    }
    return sum / n;
  };

  const isEntrySlot = (a: AssetState) => {
    const now = ex.now;
    const day = Math.floor((now - 1) / DAY);
    if (day === a.lastEntryDay) return false;
    const dow = new Date(day * DAY).getUTCDay();
    if (s.schedule === 'weekdays' && (dow === 0 || dow === 6)) return false;
    if (s.schedule === 'weekly' && dow !== s.weekday) return false;
    // на дневных свечах час не проверяем
    if (market.dt < DAY) {
      const hour = (now - day * DAY) / HOUR;
      if (hour < s.entryHour) return false;
    }
    return true;
  };

  /** Денежный поток сделки по ноге: покупка — минус, продажа — плюс. */
  const flow = (side: Side, price: number, qty: number) => (side === 'Buy' ? -1 : 1) * price * qty;

  /**
   * Вход: сначала покупки (премия), затем продажи (маржа). Если биржа отклоняет ногу — уже исполненные
   * закрываются по рынку; потери на этом откате учитываются отдельно, а ноги, которые закрыть нельзя
   * (купленный опцион без покупателей), остаются отдельной «конструкцией» до экспирации.
   */
  const enter = (a: AssetState, legs: ResolvedLeg[]): { fills: { leg: ResolvedLeg; avg: number; qty: number; fee: number }[] } | { error: string } => {
    const order = [...legs].sort((x, y) => Number(x.side === 'Sell') - Number(y.side === 'Sell'));
    const done: { leg: ResolvedLeg; avg: number; qty: number; fee: number }[] = [];
    for (const l of order) {
      const o = ex.placeOrder({ category: l.category, symbol: l.symbol, side: l.side, orderType: 'Market', qty: l.qty, tag: 'opt-strategy' });
      if (o.status === 'Filled' && o.filledQty > 0) {
        done.push({ leg: l, avg: o.avgPrice, qty: o.filledQty, fee: o.cumFee });
        continue;
      }
      // откат
      stats.failedEntries.n++;
      const orphans: OsLeg[] = [];
      for (const d of done.reverse()) {
        const back: Side = d.leg.side === 'Buy' ? 'Sell' : 'Buy';
        const c = ex.placeOrder({ category: d.leg.category, symbol: d.leg.symbol, side: back, orderType: 'Market', qty: d.qty, tag: 'opt-strategy' });
        if (c.status === 'Filled' && c.filledQty > 0) {
          stats.failedEntries.cost += flow(d.leg.side, d.avg, d.qty) + flow(back, c.avgPrice, c.filledQty) - d.fee - c.cumFee;
        } else {
          orphans.push({ symbol: d.leg.symbol, side: d.leg.side, type: d.leg.type, strike: d.leg.strike, expiry: d.leg.expiry, qty: d.qty, entry: d.avg, entryIv: 0, entryDelta: 0, fees: d.fee, open: true });
        }
      }
      if (orphans.length) {
        open.push({ id: ++seq, underlying: a.u, structure: s.structure, openTime: ex.now, closeTime: ex.now, expiry: orphans[0].expiry, S0: ex.price(a.u), qty: orphans[0].qty, legs: orphans, premium: orphans.reduce((x, l) => x + flow(l.side, l.entry, l.qty), 0), maxLoss: NaN, maxProfit: NaN, breakevens: [], atmIv: 0, ivRank: null, fees: 0, pnl: 0, reason: 'rejected', mae: 0 });
      }
      return { error: `${l.symbol}: ${o.rejectReason ?? o.status}` };
    }
    done.sort((x, y) => legs.indexOf(x.leg) - legs.indexOf(y.leg));
    return { fills: done };
  };

  const tryEnter = (a: AssetState) => {
    if (!isEntrySlot(a)) return;
    const day = Math.floor((ex.now - 1) / DAY);
    if (active(a.u).length >= s.maxOpen) {
      // лимит занят — пробуем снова на следующих свечах этого дня (например, сразу после экспирации)
      if (a.lastMaxOpenDay !== day) stats.skips.maxOpen++;
      a.lastMaxOpenDay = day;
      return;
    }
    a.lastEntryDay = day;
    const pick = pickLegs(ex, s, 1, a.u);
    if (pick.error) {
      stats.skips.chain++;
      say(`Пропуск входа: ${pick.error}`, a.u);
      return;
    }
    const ivPct = pick.atmIv * 100;
    if ((s.ivMin > 0 && ivPct < s.ivMin) || (s.ivMax > 0 && ivPct > s.ivMax)) {
      stats.skips.iv++;
      say(`Пропуск: IV ${fmt(ivPct, 1)}% вне диапазона`, a.u);
      return;
    }
    let ivRank: number | null = null;
    if (s.ivRankMin > 0 || s.ivRankMax < 100) {
      const T = ex.optionT(a.u, pick.expiry);
      const days = Math.max(5, Math.round(s.ivRankDays));
      const hist = ivHistory(a.u, T, ex.settleTime(pick.expiry), days);
      if (hist.length < Math.min(20, days * 0.5)) {
        stats.skips.ivRank++;
        say(`Пропуск: мало истории для IV-ранга (${hist.length} из ${days} дн.)`, a.u);
        return;
      }
      const lo = Math.min(...hist, pick.atmIv);
      const hi = Math.max(...hist, pick.atmIv);
      ivRank = hi - lo > 1e-9 ? ((pick.atmIv - lo) / (hi - lo)) * 100 : 50;
      if (ivRank < s.ivRankMin || ivRank > s.ivRankMax) {
        stats.skips.ivRank++;
        say(`Пропуск: IV-ранг ${fmt(ivRank, 0)}% вне диапазона`, a.u);
        return;
      }
    }
    if (s.trend !== 'off') {
      const m = sma(a.u, Math.max(2, Math.round(s.trendSma)));
      const S = pick.S;
      if (m === null || (s.trend === 'above' && S <= m) || (s.trend === 'below' && S >= m)) {
        stats.skips.trend++;
        say(m === null ? `Пропуск: мало истории для SMA ${Math.round(s.trendSma)}` : `Пропуск: тренд-фильтр (цена ${fmt(S)}, SMA ${fmt(m)})`, a.u);
        return;
      }
    }
    const eco = unitEconomics(ex, pick.legs, pick.S);
    const size = sizeFor(ex, s, eco, pick.S, undefined, a.u);
    if (size.error) {
      stats.skips.size++;
      say(`Пропуск: ${size.error}`, a.u);
      return;
    }
    if (size.capped) stats.capped++;
    // хватает ли средств на премию покупок и маржу продаж (с запасом) — иначе не трогаем рынок вовсе
    const need = eco.margin * size.qty * 1.02;
    const avail = ex.available(ex.main);
    if (need > avail) {
      stats.skips.funds++;
      say(`Пропуск: не хватает средств — нужно ${fmt(need)} USDT, доступно ${fmt(Math.max(0, avail))}`, a.u);
      return;
    }
    const legs = scaleLegs(pick.legs, size.qty);
    const res = enter(a, legs);
    if ('error' in res) {
      stats.skips.rejected++;
      say(`Вход отклонён: ${res.error}`, a.u);
      return;
    }
    const g: OsTrade = {
      id: ++seq,
      underlying: a.u,
      structure: s.structure,
      openTime: ex.now,
      expiry: pick.expiry,
      S0: pick.S,
      qty: size.qty,
      legs: res.fills.map(({ leg, avg, qty, fee }) => {
        const q = leg.type === 'F' ? null : ex.optionQuote(leg.symbol);
        return {
          symbol: leg.symbol,
          side: leg.side,
          type: leg.type,
          strike: leg.strike,
          expiry: leg.expiry,
          qty,
          entry: avg,
          entryIv: q?.iv ?? 0,
          entryDelta: leg.qty > 0 ? leg.delta / leg.qty : 0,
          fees: fee,
          open: true,
        };
      }),
      premium: 0,
      maxLoss: eco.maxLoss * size.qty,
      maxProfit: eco.maxProfit * size.qty,
      breakevens: eco.breakevens,
      atmIv: pick.atmIv,
      ivRank,
      fees: 0,
      pnl: 0,
      mae: 0,
    };
    g.premium = g.legs.filter((l) => l.type !== 'F').reduce((x, l) => x + flow(l.side, l.entry, l.qty), 0);
    open.push(g);
    const strikes = g.legs
      .filter((l) => l.type !== 'F')
      .map((l) => `${l.side === 'Buy' ? '+' : '−'}${l.type}${l.strike}`)
      .join(' ');
    say(
      `Открыт #${g.id} ${st.name} ×${size.qty}: ${strikes}, эксп. ${new Date(pick.expiry).toISOString().slice(0, 10)}, ` +
        `${g.premium >= 0 ? 'кредит' : 'дебет'} ${fmt(Math.abs(g.premium))} USDT, IV ${fmt(ivPct, 1)}%`,
      a.u,
    );
  };

  const checkExits = () => {
    for (const g of open) {
      if (g.reason || settling(g)) continue;
      const S = ex.price(g.underlying);
      const pnl = groupPnl(g, S);
      g.mae = Math.min(g.mae, pnl);
      const prem = Math.abs(g.premium);
      let reason: OsExitReason | null = null;
      if (s.closeDte > 0 && (ex.settleTime(g.expiry) - ex.now) / DAY <= s.closeDte + 1e-9) reason = 'dte';
      else if (s.useTp && s.tpPct > 0 && prem > 0 && pnl >= (prem * s.tpPct) / 100) reason = 'tp';
      else if (s.useSl && s.slPct > 0 && prem > 0 && pnl <= (-prem * s.slPct) / 100) reason = 'sl';
      else if (s.breachExit && g.legs.some((l) => l.open && l.type !== 'F' && l.side === 'Sell' && (l.type === 'P' ? S < l.strike : S > l.strike))) reason = 'breach';
      else if (
        s.deltaExit > 0 &&
        g.legs.some((l) => l.open && l.type !== 'F' && l.side === 'Sell' && Math.abs(ex.optionQuote(l.symbol, S)?.greeks.delta ?? 0) >= s.deltaExit)
      )
        reason = 'delta';
      if (reason) closeGroup(g, reason);
    }
  };

  const hedgeNow = (a: AssetState, force = false) => {
    if (!s.hedge) return;
    const perp = ex.main.positions[a.u];
    const perpSize = perp?.size ?? 0;
    const optQty = active(a.u).reduce((x, g) => x + g.qty, 0);
    if (optQty <= 0) {
      if (perpSize !== 0) {
        const o = ex.closePosition(MAIN, a.u);
        if (o?.status === 'Filled') {
          stats.hedge.trades++;
          hedgeFills.push({ t: ex.now, underlying: a.u, side: o.side, qty: o.filledQty, price: o.avgPrice });
        }
      }
      return;
    }
    if (!force && ex.now - a.lastHedge < s.hedgeHours * HOUR) return;
    const S = ex.price(a.u);
    let delta = 0;
    for (const p of Object.values(ex.main.positions)) {
      if (p.category !== 'option' || ex.optionInstrument(p.symbol)?.underlying !== a.u) continue;
      delta += (ex.optionQuote(p.symbol, S)?.greeks.delta ?? 0) * p.size;
    }
    const net = delta + perpSize;
    if (Math.abs(net) <= s.hedgeBand * optQty) return;
    const trade = roundToStep(-net, a.qtyStep, 'round');
    if (Math.abs(trade) < a.minQty) return;
    const o = ex.placeOrder({ category: 'linear', symbol: a.u, side: trade > 0 ? 'Buy' : 'Sell', orderType: 'Market', qty: Math.abs(trade), tag: 'opt-hedge' });
    a.lastHedge = ex.now;
    if (o.status === 'Filled') {
      stats.hedge.trades++;
      hedgeFills.push({ t: ex.now, underlying: a.u, side: o.side, qty: o.filledQty, price: o.avgPrice });
    } else say(`Хедж отклонён: ${o.rejectReason ?? o.status}`, a.u);
  };

  const onLiquidation = () => {
    for (const g of open) {
      const S = ex.price(g.underlying);
      for (const l of g.legs) {
        if (!l.open) continue;
        l.exit = legMark(l, S);
        l.exitTime = ex.now;
        l.open = false;
      }
      g.reason = 'liquidation';
      g.closeTime = ex.now;
      g.S1 = S;
    }
    const why =
      liqInfo?.equity !== undefined && liqInfo.mm !== undefined
        ? `: капитал ${fmt(liqInfo.equity)} USDT опустился до поддерживающей маржи ${fmt(liqInfo.mm)} USDT` +
          (config.options.marginMode === 'regular' ? ' (стандартная маржа: каждая проданная нога маржируется отдельно, купленные крылья не учитываются)' : '')
        : '';
    halted = `Ликвидация ${new Date(ex.now).toISOString().slice(0, 16).replace('T', ' ')} UTC${why} — позиции закрыты по рынку, стратегия остановлена`;
    say(halted);
  };

  const total = market.totalBars;
  const slice = opts.sliceMs ?? 30;
  let sliceStart = performance.now();
  try {
    // последний бар оставляем на закрытие позиций по рынку (после конца сессии ордера не принимаются)
    while (!ex.state.finished && ex.state.cursor < total - 1) {
      ex.step();
      settleLegs();
      if (liquidated && !halted) onLiquidation();
      if (!halted) {
        checkExits();
        sweep();
        for (const a of assets) tryEnter(a);
        for (const a of assets) hedgeNow(a);
      } else sweep();
      if (performance.now() - sliceStart > slice) {
        opts.onProgress?.(ex.state.cursor / Math.max(1, total));
        await tick();
        if (opts.signal?.aborted) return fail('Прервано');
        sliceStart = performance.now();
      }
    }
    for (const g of open) if (!g.reason) closeGroup(g, 'end');
    for (const a of assets) {
      hedgeNow(a, true);
      if (ex.main.positions[a.u]?.size) ex.closePosition(MAIN, a.u);
    }
    sweep();
    while (!ex.state.finished) ex.step();
    settleLegs();
    // «брошенные» ноги, которые не успели экспирироваться к концу данных, — по mark
    for (const g of open) {
      const S = ex.price(g.underlying);
      for (const l of g.legs) if (l.open) Object.assign(l, { exit: legMark(l, S), exitTime: ex.now, open: false });
      g.reason ??= 'end';
    }
    sweep();
  } catch (e: any) {
    return fail(`Ошибка на ${new Date(ex.now).toISOString()}: ${e?.message || e}`);
  }

  // хедж и сверка книг: всё, что изменило капитал, должно быть видно в отчёте
  const hedgeRecs = ex.state.closedPnl.filter((c) => c.accountId === MAIN && c.category === 'linear' && unders.includes(c.symbol) && s.hedge);
  stats.hedge.pnl = hedgeRecs.reduce((x, c) => x + c.closedPnl, 0);
  stats.hedge.fees = hedgeRecs.reduce((x, c) => x + c.openFee + c.closeFee, 0);
  stats.hedge.funding = hedgeRecs.reduce((x, c) => x + c.funding, 0);
  const equity = ex.state.equity.map((p) => ({ t: p.t, v: p.main }));
  const ledger = trades.reduce((x, g) => x + g.pnl, 0) + stats.hedge.pnl + stats.failedEntries.cost;
  const actual = (equity[equity.length - 1]?.v ?? s.initialBalance) - s.initialBalance;
  const residual = actual - ledger;
  // ликвидация: списания в страховой фонд и закрытие по mark — относим к ликвидированным конструкциям
  const liq = trades.filter((g) => g.reason === 'liquidation');
  if (liq.length && Math.abs(residual) > 0.01) {
    for (const g of liq) {
      g.liqAdj = residual / liq.length;
      g.pnl += g.liqAdj;
    }
  } else stats.other = residual;

  // статистика
  trades.sort((x, y) => x.openTime - y.openTime);
  /** реакция цены на отчёт (конец первой свечи реакции) пришлась на время жизни конструкции */
  const spansReport = (g: OsTrade) => {
    const ev = market.events.get(g.underlying);
    if (!ev) return false;
    const close = g.closeTime ?? market.end;
    for (let k = 0; k < ev.length; k++) if (ev.t[k] > g.openTime && ev.t[k] <= close) return true;
    return false;
  };
  const n = trades.length;
  stats.trades = n;
  for (const g of trades) {
    stats.pnl += g.pnl;
    stats.fees += g.fees;
    if (g.pnl > 0) stats.wins++;
    if (g.premium >= 0) stats.premiumIn += g.premium;
    else stats.premiumOut -= g.premium;
    stats.avgDays += ((g.closeTime ?? g.openTime) - g.openTime) / DAY;
    stats.avgIv += g.atmIv;
    const r = g.reason ?? 'end';
    const b = (stats.byReason[r] ??= { n: 0, pnl: 0 });
    b.n++;
    b.pnl += g.pnl;
    const as = (stats.byAsset[g.underlying] ??= { trades: 0, wins: 0, pnl: 0, premiumIn: 0, premiumOut: 0 });
    as.trades++;
    if (g.pnl > 0) as.wins++;
    as.pnl += g.pnl;
    if (g.premium >= 0) as.premiumIn += g.premium;
    else as.premiumOut -= g.premium;
    stats.bestTrade = Math.max(stats.bestTrade, g.pnl);
    stats.worstTrade = Math.min(stats.worstTrade, g.pnl);
    if (g.reason !== 'rejected' && spansReport(g)) {
      stats.reports.trades++;
      if (g.pnl > 0) stats.reports.wins++;
      stats.reports.pnl += g.pnl;
    }
  }
  for (const u of unders) stats.byAsset[u] ??= { trades: 0, wins: 0, pnl: 0, premiumIn: 0, premiumOut: 0 };
  if (n) {
    stats.winRate = stats.wins / n;
    stats.avgPnl = stats.pnl / n;
    stats.avgDays /= n;
    stats.avgIv /= n;
  }

  // бенчмарк: один актив — его цена; несколько — равновесная корзина (сумма долей от стартовых цен)
  const p0 = unders.map((u) => market.closeAt(u, market.start) ?? NaN);
  const bench = ex.state.equity.map((p) => {
    if (unders.length === 1) return { t: p.t, v: p.bench };
    let sum = 0;
    let k = 0;
    unders.forEach((u, i) => {
      const c = market.closeAt(u, p.t);
      if (c !== undefined && p0[i] > 0) {
        sum += c / p0[i];
        k++;
      }
    });
    return { t: p.t, v: k ? (sum / k) * 100 : NaN };
  });
  // для отчёта сделка = конструкция целиком
  const recs: ClosedPnlRecord[] = trades.map((g) => ({
    id: `os${g.id}`,
    accountId: MAIN,
    category: 'option',
    symbol: `${st.short} ${g.underlying.replace(/USDT$/, '')}`,
    side: g.premium >= 0 ? 'Sell' : 'Buy',
    qty: g.qty,
    entryPrice: g.S0,
    exitPrice: g.S1 ?? g.S0,
    closedPnl: g.pnl,
    openFee: g.fees,
    closeFee: 0,
    funding: 0,
    leverage: 1,
    openTime: g.openTime,
    closeTime: g.closeTime ?? g.openTime,
    type: 'Trade',
  }));
  const report = computeReport(equity, recs, { fees: ex.main.stats.fees, funding: ex.main.stats.funding, bench });
  opts.onProgress?.(1);
  return {
    ok: true,
    settings: s,
    report,
    equity,
    bench,
    benchLabel,
    trades,
    stats,
    log,
    hedgeFills,
    durationMs: performance.now() - t0,
    bars: total,
    halted,
    dataWarnings: [...implausibleWarnings(report, market), ...priceJumpWarnings(market, unders), ...reportCoverageWarnings(market, unders)],
  };
}

/**
 * Доходность, которой не бывает у реальных стратегий на длинной истории: почти наверняка артефакт
 * (ошибка данных, модельные цены опционов вместо исторических котировок, нереальный размер позиций).
 */
export function implausibleWarnings(report: PerformanceReport, market: MarketData): string[] {
  const years = (market.end - market.start) / (365 * DAY);
  if (years < 0.5) return [];
  const cagr = report.cagr;
  if (!(years >= 1 && cagr > 1) && !(report.totalReturn > 100)) return [];
  return [
    `Доходность ${Number.isFinite(cagr) ? `${Math.round(cagr * 100).toLocaleString('ru-RU')}% годовых` : 'неправдоподобно высокая'} — выше, чем у любой известной стратегии на длинной истории. Почти наверняка это артефакт: ошибка данных, модельные цены опционов (не исторические котировки) или размер позиций, который рынок не исполнит. Не переносите на реальную торговлю без проверки на исторических котировках опционов.`,
  ];
}

/**
 * Акции без дат отчётов за часть периода: скачок цены на таком отчёте не заложен в опционы, которые его
 * захватывают, — покупка опционов перед ним выглядит выгоднее, чем на реальном рынке.
 */
export function reportCoverageWarnings(market: MarketData, unders: string[]): string[] {
  const out: string[] = [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 7);
  for (const u of unders) {
    const spec = getAsset(u);
    if (!spec.yahoo || spec.sector === 'etf' || spec.sector === 'index' || spec.sector === 'commodity') continue;
    if (market.providers.get(u) === 'synthetic') continue;
    const sr = market.series.get(u);
    if (!sr?.length) continue;
    const from = Math.max(market.start, sr.t[0]);
    const to = Math.min(market.end, sr.t[sr.length - 1]);
    if (to - from < 120 * DAY) continue;
    const reps = market.reports.get(u);
    const base = u.replace(/USDT$/, '');
    if (!reps) {
      out.push(`${base}: даты отчётов компании не загрузились (SEC EDGAR) — скачки цены на отчётах не заложены в цены опционов: опционы через отчёт дешевле, чем на реальном рынке. Перезагрузите историю.`);
      continue;
    }
    // промежутки длиннее квартала с запасом без единого отчёта
    const pts = [from, ...reps.filter((t) => t > from && t < to).sort((a, b) => a - b), to];
    const gaps: string[] = [];
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 135 * DAY) gaps.push(`${iso(pts[i - 1])}…${iso(pts[i])}`);
    if (gaps.length)
      out.push(
        `${base}: в SEC нет дат отчётов за ${gaps.slice(0, 4).join(', ')}${gaps.length > 4 ? ' и др.' : ''} (у иностранных эмитентов квартальные отчёты не всегда распознаются) — скачки на этих отчётах не заложены в цены опционов, сделки через них выглядят выгоднее реальных.`,
      );
  }
  return out;
}

/**
 * Скачки цены больше чем в 1.5 раза за одну свечу. У акций так выглядит кусок истории без поправки на сплит
 * (×10 у NFLX/NVDA): купленный колл на таком «скачке» даёт тысячи процентов, и результат стратегии ложный.
 */
export function priceJumpWarnings(market: MarketData, unders: string[], limit = 1.5): string[] {
  const out: string[] = [];
  for (const u of unders) {
    const sr = market.series.get(u);
    if (!sr) continue;
    const jumps: string[] = [];
    let n = 0;
    for (let i = 1; i < sr.length; i++) {
      if (sr.t[i] < market.start - 30 * DAY || sr.t[i] >= market.end) continue;
      const r = sr.c[i] / sr.c[i - 1];
      if (!(r > limit || r < 1 / limit)) continue;
      n++;
      if (jumps.length < 3) jumps.push(`${new Date(sr.t[i]).toISOString().slice(0, 10)}: ${r > 1 ? '×' : '÷'}${(r > 1 ? r : 1 / r).toFixed(1)}`);
    }
    if (n)
      out.push(
        `${u.replace(/USDT$/, '')}: цена за одну свечу менялась больше чем в ${limit} раза — ${n} раз (${jumps.join(', ')}${n > jumps.length ? ', …' : ''}). ` +
          'Если это не реальное событие, в данных ошибка (например, сплит без поправки) и результат стратегии недостоверен — перезагрузите историю.',
      );
  }
  return out;
}

/* ───────────────────────── Перебор одного параметра ───────────────────────── */

export type OsSweepParam = 'delta' | 'dte' | 'tpPct' | 'slPct' | 'wingPct' | 'closeDte' | 'riskPct' | 'entryHour' | 'deltaExit' | 'hedgeBand' | 'weekday';

export const OS_SWEEP_PARAMS: { key: OsSweepParam; label: string; from: number; to: number; step: number }[] = [
  { key: 'delta', label: 'Дельта ног', from: 0.05, to: 0.35, step: 0.05 },
  { key: 'dte', label: 'Дней до экспирации', from: 1, to: 30, step: 7 },
  { key: 'weekday', label: 'День входа (0 — вс … 6 — сб)', from: 0, to: 6, step: 1 },
  { key: 'tpPct', label: 'Тейк-профит, % (включает тейк)', from: 25, to: 100, step: 25 },
  { key: 'slPct', label: 'Стоп-лосс, % (включает стоп)', from: 50, to: 300, step: 50 },
  { key: 'wingPct', label: 'Ширина крыла, %', from: 2, to: 10, step: 2 },
  { key: 'closeDte', label: 'Закрыть за N дней', from: 0, to: 5, step: 1 },
  { key: 'riskPct', label: 'Риск на сделку, %', from: 1, to: 10, step: 1 },
  { key: 'entryHour', label: 'Час входа (UTC)', from: 0, to: 20, step: 4 },
  { key: 'deltaExit', label: 'Выход по дельте', from: 0, to: 0.6, step: 0.1 },
  { key: 'hedgeBand', label: 'Допуск хеджа', from: 0.05, to: 0.3, step: 0.05 },
];

export interface OsSweepRow {
  value: number;
  report: PerformanceReport;
  stats: OsStats;
  error?: string;
}

export function sweepValues(from: number, to: number, step: number, limit = 40): number[] {
  const out: number[] = [];
  if (!(step > 0) || to < from) return [from];
  for (let v = from; v <= to + 1e-9 && out.length < limit; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

/** Настройки с одним изменённым параметром (тейк и стоп при переборе включаются). */
export function withParam(s: OsSettings, param: OsSweepParam, v: number): OsSettings {
  const next: OsSettings = { ...s, [param]: v };
  if (param === 'tpPct') next.useTp = v > 0;
  if (param === 'slPct') next.useSl = v > 0;
  if (param === 'weekday') next.schedule = 'weekly';
  return next;
}

export async function runOptionSweep(
  market: MarketData,
  base: SessionConfig,
  s: OsSettings,
  param: OsSweepParam,
  values: number[],
  opts: { onRow?: (row: OsSweepRow, done: number, total: number) => void; signal?: { aborted: boolean } } = {},
): Promise<OsSweepRow[]> {
  const rows: OsSweepRow[] = [];
  for (const v of values) {
    if (opts.signal?.aborted) break;
    const r = await runOptionStrategy(market, base, withParam(s, param, v), { noLog: true, signal: opts.signal, sliceMs: 40 });
    const row: OsSweepRow = { value: v, report: r.report, stats: r.stats, error: r.ok ? undefined : r.error };
    rows.push(row);
    opts.onRow?.(row, rows.length, values.length);
  }
  return rows;
}

/** Предпросмотр: какие ноги стратегия открыла бы прямо сейчас на бирже сессии по одному из активов. */
export function previewEntry(ex: Exchange, s: OsSettings, underlying = s.underlyings[0]) {
  const pick = pickLegs(ex, s, 1, underlying);
  if (pick.error) return { error: pick.error, pick };
  // маржа — по режиму стратегии, а не ручной сессии
  const eco = unitEconomics(ex, pick.legs, pick.S, s.marginMode ?? 'portfolio');
  // объём — от депозита стратегии, а не от счёта ручной сессии
  const size = sizeFor(ex, s, eco, pick.S, { equity: s.initialBalance, available: s.initialBalance }, underlying);
  const legs = size.qty > 0 ? scaleLegs(pick.legs, size.qty) : pick.legs;
  return { pick, eco, size, legs, error: undefined as string | undefined };
}
