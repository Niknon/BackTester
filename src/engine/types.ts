import type { IntervalKey, ProviderId } from '../data/types';

export type Category = 'linear' | 'spot' | 'option';
export type Side = 'Buy' | 'Sell';
export type OrderType = 'Market' | 'Limit';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
export type MarginMode = 'cross' | 'isolated';
export type OrderStatus =
  | 'New'
  | 'PartiallyFilled'
  | 'Filled'
  | 'Cancelled'
  | 'Rejected'
  | 'Untriggered'
  | 'Triggered'
  | 'Deactivated';
export type StopOrderType = 'Stop' | 'TakeProfit' | 'StopLoss' | 'TrailingStop';

export interface Order {
  id: string;
  accountId: string;
  category: Category;
  symbol: string;
  side: Side;
  orderType: OrderType;
  qty: number;
  /** лимитная цена (для Market — 0) */
  price: number;
  tif: TimeInForce;
  reduceOnly: boolean;
  /** закрыть позицию при срабатывании (TP/SL позиции) */
  closeOnTrigger: boolean;
  /** условный ордер: цена срабатывания */
  triggerPrice?: number;
  /** 1 — срабатывает при росте до triggerPrice, 2 — при падении */
  triggerDirection?: 1 | 2;
  stopOrderType?: StopOrderType;
  /** трейлинг-стоп: дистанция в цене */
  trailingDistance?: number;
  trailingExtreme?: number;
  /** цена активации трейлинга (опционально) */
  activePrice?: number;
  /** прикреплённые TP/SL к ордеру открытия */
  takeProfit?: number;
  stopLoss?: number;
  status: OrderStatus;
  filledQty: number;
  avgPrice: number;
  cumFee: number;
  createdTime: number;
  updatedTime: number;
  rejectReason?: string;
  /** кто создал: user | tpsl | bot:<id> | strategy | liq */
  tag: string;
  /** спот: покупка на сумму в USDT (Market) */
  quoteQty?: number;
}

export interface Position {
  symbol: string;
  category: 'linear' | 'option';
  /** со знаком: >0 лонг, <0 шорт */
  size: number;
  avgPrice: number;
  leverage: number;
  marginMode: MarginMode;
  /** маржа изолированной позиции */
  isolatedMargin: number;
  /** реализованный PnL с момента открытия (с комиссиями и funding) */
  realisedPnl: number;
  /** комиссия открытия, ещё не распределённая по закрытиям */
  openFee: number;
  /** накопленный funding (со знаком: + получено) */
  funding: number;
  takeProfit?: number;
  stopLoss?: number;
  trailingStop?: number;
  createdTime: number;
  updatedTime: number;
}

export type ExecType = 'Trade' | 'Funding' | 'Liquidation' | 'Delivery' | 'BustTrade';

export interface Execution {
  id: string;
  orderId: string;
  accountId: string;
  category: Category;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  isMaker: boolean;
  time: number;
  execType: ExecType;
  /** реализованный PnL этой сделки (брутто) */
  closedPnl: number;
  tag: string;
}

export interface ClosedPnlRecord {
  id: string;
  accountId: string;
  category: 'linear' | 'option' | 'spot';
  symbol: string;
  /** сторона закрываемой позиции (Buy = лонг) */
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  /** итоговый PnL: брутто − комиссии открытия/закрытия + funding */
  closedPnl: number;
  openFee: number;
  closeFee: number;
  funding: number;
  leverage: number;
  openTime: number;
  closeTime: number;
  type: 'Trade' | 'Liquidation' | 'Delivery' | 'TP' | 'SL';
}

export interface AccountStats {
  realisedPnl: number;
  fees: number;
  funding: number;
  trades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  liquidations: number;
  volume: number;
}

export interface Account {
  id: string;
  name: string;
  kind: 'main' | 'bot' | 'strategy';
  botId?: string;
  /** кошелёк USDT (включает изолированную маржу) */
  walletBalance: number;
  /** спотовые монеты */
  spot: Record<string, number>;
  /** стоимость покупки спотовых монет (для средней цены) */
  spotCost: Record<string, number>;
  positions: Record<string, Position>;
  leverage: Record<string, number>;
  marginMode: Record<string, MarginMode>;
  stats: AccountStats;
  /** суммарные внесённые средства (для расчёта доходности) */
  deposits: number;
}

export interface OptionInstrument {
  symbol: string; // BTC-26SEP26-60000-C-USDT
  base: string; // BTC
  underlying: string; // BTCUSDT
  strike: number;
  type: 'C' | 'P';
  expiry: number; // мс UTC (08:00)
}

export interface EquityPoint {
  t: number;
  /** капитал основного счёта */
  main: number;
  /** капитал всех ботов */
  bots: number;
  /** цена «бенчмарка» (первый символ сессии) */
  bench: number;
}

export interface FeeConfig {
  linearTaker: number;
  linearMaker: number;
  spotTaker: number;
  spotMaker: number;
  optionTaker: number;
  optionMaker: number;
  optionDelivery: number;
  /** ограничение комиссии опционов как доля премии */
  optionFeeCap: number;
}

export interface OptionModelConfig {
  /** источник IV: реализованная волатильность, DVOL (BTC/ETH), фиксированная */
  ivSource: 'realized' | 'dvol' | 'fixed';
  /** надбавка к реализованной волатильности (IV = RV × premium) */
  ivPremium: number;
  fixedIv: number;
  /** наклон улыбки (отриц. — дорогие путы) */
  skew: number;
  /** кривизна улыбки */
  smile: number;
  /** спред bid/ask как доля от mark */
  spreadPct: number;
  /** ставки маржи шорта */
  imRate: number;
  imMinRate: number;
  mmRate: number;
}

export interface SessionConfig {
  id: string;
  name: string;
  provider: ProviderId;
  start: number;
  end: number;
  baseInterval: IntervalKey;
  warmupDays: number;
  initialBalance: number;
  symbols: string[];
  fees: FeeConfig;
  /** проскальзывание рыночных ордеров, б.п. */
  slippageBps: number;
  fundingEnabled: boolean;
  /** ставка funding по умолчанию (если нет истории), за 8ч */
  defaultFundingRate: number;
  options: OptionModelConfig;
  /** порядок движения цены внутри бара */
  intrabar: 'auto' | 'pessimistic';
  createdAt: number;
}

export const DEFAULT_FEES: FeeConfig = {
  linearTaker: 0.00055,
  linearMaker: 0.0002,
  spotTaker: 0.001,
  spotMaker: 0.001,
  optionTaker: 0.0003,
  optionMaker: 0.0003,
  optionDelivery: 0.00015,
  optionFeeCap: 0.07,
};

export const DEFAULT_OPTION_MODEL: OptionModelConfig = {
  ivSource: 'realized',
  ivPremium: 1.1,
  fixedIv: 0.6,
  skew: -0.08,
  smile: 0.12,
  spreadPct: 0.03,
  imRate: 0.15,
  imMinRate: 0.1,
  mmRate: 0.075,
};

export interface PlaceOrderRequest {
  accountId?: string;
  category: Category;
  symbol: string;
  side: Side;
  orderType: OrderType;
  qty: number;
  price?: number;
  tif?: TimeInForce;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  triggerPrice?: number;
  triggerDirection?: 1 | 2;
  stopOrderType?: StopOrderType;
  trailingDistance?: number;
  activePrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  tag?: string;
  quoteQty?: number;
}

/** Ценовой алерт: при касании цены симуляция ставится на паузу. */
export interface PriceAlert {
  id: string;
  symbol: string;
  price: number;
  /** up — сработает при росте до цены, down — при падении */
  dir: 'up' | 'down';
  note?: string;
  createdTime: number;
}

export type ExchangeEvent =
  | { type: 'alert'; alert: PriceAlert; time: number }
  | { type: 'fill'; exec: Execution; order?: Order }
  | { type: 'order'; order: Order }
  | { type: 'reject'; order: Order; reason: string }
  | { type: 'liquidation'; accountId: string; symbol: string; loss: number }
  | { type: 'funding'; accountId: string; symbol: string; amount: number }
  | { type: 'expiry'; accountId: string; symbol: string; pnl: number }
  | { type: 'bot'; botId: string; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'info'; message: string };
