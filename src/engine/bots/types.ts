import type { Execution, Order } from '../types';
import type { Exchange } from '../exchange';

export type BotType = 'spotGrid' | 'futuresGrid' | 'futuresCombo' | 'dca' | 'martingale';
export type BotStatus = 'waiting' | 'running' | 'stopped' | 'liquidated' | 'completed';
export type GridMode = 'arithmetic' | 'geometric';

export interface SpotGridParams {
  symbol: string;
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  /** цена запуска (бот ждёт, пока цена её коснётся) */
  triggerPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  /** продать монеты при остановке */
  sellOnStop: boolean;
}

export interface FuturesGridParams {
  symbol: string;
  direction: 'long' | 'short' | 'neutral';
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  leverage: number;
  triggerPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  /** TP/SL по доходности бота, % */
  tpRoi?: number;
  slRoi?: number;
  closeOnStop: boolean;
}

export interface ComboLeg {
  symbol: string;
  side: 'long' | 'short';
  /** доля в портфеле, % (сумма = 100) */
  weight: number;
}

export interface ComboParams {
  legs: ComboLeg[];
  leverage: number;
  rebalanceMode: 'time' | 'threshold' | 'none';
  /** период ребалансировки, часы */
  intervalHours: number;
  /** порог отклонения веса, п.п. */
  thresholdPct: number;
  tpRoi?: number;
  slRoi?: number;
}

export interface DcaParams {
  symbol: string;
  /** сумма одной покупки, USDT */
  amount: number;
  intervalHours: number;
  maxOrders: number;
  /** покупать только если цена ниже */
  priceBelow?: number;
  /** зафиксировать прибыль (продать всё), % от средней */
  tpPct?: number;
}

export interface MartingaleParams {
  symbol: string;
  side: 'long' | 'short';
  leverage: number;
  /** маржа первого ордера, USDT */
  initialMargin: number;
  /** шаг усреднения, % против позиции */
  stepPct: number;
  /** множитель объёма каждого следующего ордера */
  multiplier: number;
  maxAdds: number;
  /** тейк-профит от средней цены, % */
  tpPct: number;
  /** стоп-лосс от средней цены, % (после всех усреднений) */
  slPct?: number;
  /** перезапускать цикл после TP */
  loop: boolean;
}

export interface BotParamsMap {
  spotGrid: SpotGridParams;
  futuresGrid: FuturesGridParams;
  futuresCombo: ComboParams;
  dca: DcaParams;
  martingale: MartingaleParams;
}

export interface BotStats {
  /** реализованная сеточная прибыль (арбитраж) */
  gridProfit: number;
  /** число завершённых арбитражей сетки */
  arbitrages: number;
  rebalances: number;
  buys: number;
  sells: number;
  cycles: number;
}

export interface BotState<T extends BotType = BotType> {
  id: string;
  type: T;
  name: string;
  accountId: string;
  status: BotStatus;
  symbols: string[];
  investment: number;
  params: BotParamsMap[T];
  /** рантайм-состояние логики бота (сериализуемое) */
  rt: Record<string, any>;
  stats: BotStats;
  createdTime: number;
  startedTime?: number;
  stoppedTime?: number;
  stopReason?: string;
  /** итог после остановки */
  finalPnl?: number;
  /** мини-история капитала для спарклайна */
  hist: { t: number; v: number }[];
}

export type AnyBot = BotState<BotType>;

export interface BotLogic<T extends BotType = BotType> {
  /** Проверка параметров; вернуть текст ошибки или null */
  validate(ex: Exchange, params: BotParamsMap[T], investment: number): string | null;
  /** Запуск (выставление начальных ордеров). Может вызываться отложенно (triggerPrice). */
  start(ex: Exchange, bot: BotState<T>): void;
  onFill(ex: Exchange, bot: BotState<T>, order: Order, exec: Execution): void;
  onBar(ex: Exchange, bot: BotState<T>): void;
}

export function emptyBotStats(): BotStats {
  return { gridProfit: 0, arbitrages: 0, rebalances: 0, buys: 0, sells: 0, cycles: 0 };
}

export const BOT_LABELS: Record<BotType, string> = {
  spotGrid: 'Спотовый грид',
  futuresGrid: 'Фьючерсный грид',
  futuresCombo: 'Фьючерсный комбо (ребалансировка)',
  dca: 'DCA (усреднение)',
  martingale: 'Фьючерсный мартингейл',
};
