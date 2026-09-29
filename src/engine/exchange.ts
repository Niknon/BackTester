import { getAsset, maintenanceMarginRate, roundToStep } from '../data/assets';
import { HOUR } from '../data/intervals';
import { dvolAt, realizedVolAt } from '../data/volatility';
import type { MarketData } from './market';
import {
  intrinsicValue,
  isOptionSymbol,
  listExpiries,
  listStrikes,
  optionFee,
  optionQtyStep,
  optionSymbol,
  optionTickSize,
  parseOptionSymbol,
  quoteOption,
  shortOptionMargin,
  atmIv,
  yearsTo,
  type OptionQuote,
  type VolInputs,
} from './options';
import type {
  Account,
  AccountStats,
  Category,
  ClosedPnlRecord,
  EquityPoint,
  Execution,
  ExchangeEvent,
  MarginMode,
  OptionInstrument,
  Order,
  PlaceOrderRequest,
  Position,
  SessionConfig,
  Side,
} from './types';
import type { AnyBot, BotParamsMap, BotType } from './bots/types';
import { emptyBotStats } from './bots/types';
import { BOT_LOGIC } from './bots/registry';

export const MAIN = 'main';
const EPS = 1e-9;
const HIST_CAP = { orders: 4000, executions: 15000, closedPnl: 15000 };

export interface ExchangeState {
  v: 1;
  config: SessionConfig;
  /** индекс следующего необработанного бара */
  cursor: number;
  /** текущее время симуляции (= время открытия следующего бара) */
  now: number;
  seq: number;
  accounts: Record<string, Account>;
  orders: Record<string, Order>;
  orderHistory: Order[];
  executions: Execution[];
  closedPnl: ClosedPnlRecord[];
  bots: Record<string, AnyBot>;
  equity: EquityPoint[];
  lastSample: number;
  dd: { peakMain: number; maxDdMain: number; peakTotal: number; maxDdTotal: number };
  prices: Record<string, number>;
  finished: boolean;
}

export interface AccountSummary {
  equity: number;
  walletBalance: number;
  crossEquity: number;
  unrealisedPnl: number;
  optionValue: number;
  spotValue: number;
  initialMargin: number;
  orderMargin: number;
  maintenanceMargin: number;
  available: number;
  /** коэффициент поддерживающей маржи (MM / equity) */
  mmRatio: number;
  isolatedMargin: number;
}

function newStats(): AccountStats {
  return {
    realisedPnl: 0,
    fees: 0,
    funding: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    liquidations: 0,
    volume: 0,
  };
}

export function newAccount(id: string, name: string, kind: Account['kind'], balance: number, botId?: string): Account {
  return {
    id,
    name,
    kind,
    botId,
    walletBalance: balance,
    spot: {},
    spotCost: {},
    positions: {},
    leverage: {},
    marginMode: {},
    stats: newStats(),
    deposits: balance,
  };
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

interface PathEvent {
  price: number;
  kind: 'order' | 'liqIso' | 'liqCross';
  order?: Order;
  account?: Account;
  position?: Position;
}

/**
 * Симулятор биржи в стиле Bybit (единый торговый аккаунт):
 *  - USDT-перпетуалы: плечо, кросс/изолированная маржа, лимит/маркет/условные ордера,
 *    TP/SL, трейлинг-стоп, reduce-only, post-only/IOC/FOK, funding, ликвидация;
 *  - спот: покупка/продажа монет;
 *  - опционы (европейские, расчёт в USDT): цепочка страйков, модель IV, греки,
 *    маржа шорта, экспирация и поставка;
 *  - боты в изолированных суб-аккаунтах.
 * Цена внутри бара движется по пути O→(H/L)→(L/H)→C, все события обрабатываются
 * строго по порядку достижения цены.
 */
export class Exchange {
  state: ExchangeState;
  readonly market: MarketData;
  private listeners = new Set<(e: ExchangeEvent) => void>();
  private bySymbol = new Map<string, Set<Order>>();
  private inStep = false;
  private barTime = 0;
  /** подавлять событийные уведомления (быстрый прогон) */
  quiet = false;
  /** обрабатывать только эти символы (ускорение изолированных прогонов) */
  activeSymbols: string[] | null = null;

  constructor(market: MarketData, state: ExchangeState) {
    this.market = market;
    this.state = state;
    for (const o of Object.values(state.orders)) this.indexOrder(o);
  }

  static create(config: SessionConfig, market: MarketData): Exchange {
    const state: ExchangeState = {
      v: 1,
      config,
      cursor: 0,
      now: market.start,
      seq: 0,
      accounts: { [MAIN]: newAccount(MAIN, 'Единый торговый аккаунт', 'main', config.initialBalance) },
      orders: {},
      orderHistory: [],
      executions: [],
      closedPnl: [],
      bots: {},
      equity: [],
      lastSample: -Infinity,
      dd: { peakMain: config.initialBalance, maxDdMain: 0, peakTotal: config.initialBalance, maxDdTotal: 0 },
      prices: {},
      finished: false,
    };
    const ex = new Exchange(market, state);
    ex.syncPrices();
    ex.sampleEquity(true);
    return ex;
  }

  /* ───────────────────────── события ───────────────────────── */

  on(fn: (e: ExchangeEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ExchangeEvent) {
    if (this.quiet && e.type !== 'liquidation') return;
    for (const fn of this.listeners) fn(e);
  }

  private nextId(prefix: string) {
    return `${prefix}${++this.state.seq}`;
  }

  /** Время для записей: внутри бара — время бара, вне — последняя видимая свеча. */
  eventTime() {
    return this.inStep ? this.barTime : this.state.now - 1;
  }

  get now() {
    return this.state.now;
  }

  get config() {
    return this.state.config;
  }

  get main(): Account {
    return this.state.accounts[MAIN];
  }

  account(id = MAIN): Account {
    const a = this.state.accounts[id];
    if (!a) throw new Error(`Нет аккаунта ${id}`);
    return a;
  }

  /* ───────────────────────── цены ───────────────────────── */

  /** Обновить цены по последним закрытым свечам (после загрузки/перемотки). */
  syncPrices() {
    for (const s of this.market.symbols()) {
      const c = this.market.closeAt(s, this.state.now);
      if (c !== undefined) this.state.prices[s] = c;
    }
  }

  price(symbol: string): number {
    const p = this.state.prices[symbol];
    if (p !== undefined) return p;
    const c = this.market.closeAt(symbol, this.state.now);
    if (c !== undefined) {
      this.state.prices[symbol] = c;
      return c;
    }
    return NaN;
  }

  /** Символ ценового ряда для инструмента (для опциона — базовый перпетуал). */
  dataSymbol(category: Category, symbol: string) {
    if (category === 'option') return this.optionInstrument(symbol)?.underlying ?? '';
    return symbol;
  }

  /* ───────────────────────── опционы ───────────────────────── */

  private instCache = new Map<string, OptionInstrument>();

  optionInstrument(symbol: string): OptionInstrument | null {
    let inst = this.instCache.get(symbol);
    if (!inst) {
      const parsed = parseOptionSymbol(symbol);
      if (!parsed) return null;
      inst = parsed;
      this.instCache.set(symbol, inst);
    }
    return inst;
  }

  volInputs(underlying: string, now = this.state.now): VolInputs {
    const rv = realizedVolAt(this.market.rv.get(underlying), now);
    const base = underlying.replace(/USDT$/, '');
    const dvol = dvolAt(this.market.dvol.get(base), now);
    return { rv7: rv?.rv7 ?? null, rv30: rv?.rv30 ?? null, dvol };
  }

  optionQuote(symbol: string, S?: number): OptionQuote | null {
    const inst = this.optionInstrument(symbol);
    if (!inst) return null;
    const px = S ?? this.price(inst.underlying);
    if (!Number.isFinite(px)) return null;
    return quoteOption(this.config.options, inst, px, this.state.now, this.volInputs(inst.underlying));
  }

  optionMark(symbol: string, S?: number): number {
    return this.optionQuote(symbol, S)?.mark ?? 0;
  }

  /** Список экспираций для базового актива в текущий момент. */
  optionExpiries(base: string): number[] {
    return listExpiries(this.state.now, base);
  }

  /** Цепочка опционов для экспирации: страйки + котировки коллов и путов. */
  optionChain(base: string, expiry: number) {
    const underlying = `${base}USDT`;
    const S = this.price(underlying);
    if (!Number.isFinite(S)) return { S, rows: [] as { strike: number; call: OptionQuote; put: OptionQuote }[], atm: 0 };
    const T = yearsTo(expiry, this.state.now);
    const vol = this.volInputs(underlying);
    const atm = atmIv(this.config.options, vol, T);
    const strikes = listStrikes(S, T, atm);
    // страйки открытых позиций и ордеров тоже показываем
    const used = [
      ...Object.values(this.state.accounts).flatMap((a) => Object.keys(a.positions)),
      ...Object.values(this.state.orders).map((o) => o.symbol),
    ];
    for (const sym of used) {
      const inst = this.optionInstrument(sym);
      if (inst && inst.base === base && inst.expiry === expiry && !strikes.includes(inst.strike)) strikes.push(inst.strike);
    }
    strikes.sort((a, b) => a - b);
    const rows = strikes.map((k) => {
      const c = this.optionInstrument(optionSymbol(base, expiry, k, 'C'))!;
      const p = this.optionInstrument(optionSymbol(base, expiry, k, 'P'))!;
      return {
        strike: k,
        call: quoteOption(this.config.options, c, S, this.state.now, vol),
        put: quoteOption(this.config.options, p, S, this.state.now, vol),
      };
    });
    return { S, rows, atm };
  }

  /* ───────────────────────── маржа и капитал ───────────────────────── */

  leverageOf(acc: Account, symbol: string) {
    return acc.leverage[symbol] ?? Math.min(10, getAsset(symbol).maxLeverage);
  }

  marginModeOf(acc: Account, symbol: string): MarginMode {
    return acc.marginMode[symbol] ?? 'cross';
  }

  unrealisedPnl(pos: Position): number {
    if (pos.category === 'option') return pos.size * (this.optionMark(pos.symbol) - pos.avgPrice);
    return pos.size * (this.price(pos.symbol) - pos.avgPrice);
  }

  positionIM(pos: Position): number {
    if (pos.category === 'option') {
      if (pos.size >= 0) return 0;
      const inst = this.optionInstrument(pos.symbol)!;
      const S = this.price(inst.underlying);
      return shortOptionMargin(this.config.options, inst, S, this.optionMark(pos.symbol, S)).im * -pos.size;
    }
    if (pos.marginMode === 'isolated') return pos.isolatedMargin;
    return (Math.abs(pos.size) * this.price(pos.symbol)) / pos.leverage;
  }

  positionMM(pos: Position): number {
    if (pos.category === 'option') {
      if (pos.size >= 0) return 0;
      const inst = this.optionInstrument(pos.symbol)!;
      const S = this.price(inst.underlying);
      return shortOptionMargin(this.config.options, inst, S, this.optionMark(pos.symbol, S)).mm * -pos.size;
    }
    const px = this.price(pos.symbol);
    return Math.abs(pos.size) * px * (maintenanceMarginRate(pos.symbol) + this.config.fees.linearTaker);
  }

  /** Маржа, зарезервированная под активные ордера (открывающая часть). */
  orderMargin(acc: Account): number {
    let total = 0;
    for (const o of Object.values(this.state.orders)) {
      if (o.accountId !== acc.id || o.reduceOnly || o.closeOnTrigger) continue;
      total += this.orderCost(acc, o);
    }
    return total;
  }

  private orderCost(acc: Account, o: Order): number {
    const remaining = o.qty - o.filledQty;
    if (remaining <= 0) return 0;
    if (o.category === 'spot') {
      if (o.side === 'Sell') return 0;
      const px = o.price || o.triggerPrice || this.price(o.symbol);
      return remaining * px * (1 + this.config.fees.spotTaker);
    }
    if (o.category === 'option') {
      const pos = acc.positions[o.symbol];
      const openQty = this.openingQty(pos, o.side, remaining);
      if (openQty <= 0) return 0;
      if (o.side === 'Buy') return openQty * o.price * (1 + 0.1);
      const inst = this.optionInstrument(o.symbol)!;
      const S = this.price(inst.underlying);
      const m = shortOptionMargin(this.config.options, inst, S, this.optionMark(o.symbol, S));
      return openQty * Math.max(0, m.im - o.price);
    }
    const pos = acc.positions[o.symbol];
    const openQty = this.openingQty(pos, o.side, remaining);
    if (openQty <= 0) return 0;
    const px = o.orderType === 'Limit' && o.price ? o.price : o.triggerPrice || this.price(o.symbol);
    const lev = this.leverageOf(acc, o.symbol);
    return openQty * px * (1 / lev + 2 * this.config.fees.linearTaker);
  }

  private openingQty(pos: Position | undefined, side: Side, qty: number) {
    if (!pos || pos.size === 0) return qty;
    const dir = side === 'Buy' ? 1 : -1;
    if (sgn(pos.size) === dir) return qty;
    return Math.max(0, qty - Math.abs(pos.size));
  }

  /** Капитал и маржа без учёта ордеров (быстро; используется в симуляции). */
  core(acc: Account) {
    let upnlCross = 0;
    let upnlAll = 0;
    let optionValue = 0;
    let isoMargin = 0;
    let isoEquity = 0;
    let im = 0;
    let mm = 0;
    for (const sym in acc.positions) {
      const pos = acc.positions[sym];
      if (pos.category === 'option') {
        const mark = this.optionMark(pos.symbol);
        optionValue += pos.size * mark;
        upnlAll += pos.size * (mark - pos.avgPrice);
        if (pos.size < 0) {
          im += this.positionIM(pos);
          mm += this.positionMM(pos);
        }
        continue;
      }
      const u = this.unrealisedPnl(pos);
      upnlAll += u;
      if (pos.marginMode === 'isolated') {
        isoMargin += pos.isolatedMargin;
        isoEquity += pos.isolatedMargin + u;
      } else {
        upnlCross += u;
        im += this.positionIM(pos);
        mm += this.positionMM(pos);
      }
    }
    let spotValue = 0;
    for (const coin in acc.spot) {
      const qty = acc.spot[coin];
      if (qty <= 0) continue;
      const px = this.price(`${coin}USDT`);
      if (Number.isFinite(px)) spotValue += qty * px;
    }
    const crossEquity = acc.walletBalance - isoMargin + upnlCross + optionValue;
    return {
      crossEquity,
      equity: crossEquity + isoEquity + spotValue,
      upnlAll,
      optionValue,
      spotValue,
      isoMargin,
      im,
      mm,
    };
  }

  summary(acc: Account): AccountSummary {
    const c = this.core(acc);
    const orderMargin = this.orderMargin(acc);
    return {
      equity: c.equity,
      walletBalance: acc.walletBalance,
      crossEquity: c.crossEquity,
      unrealisedPnl: c.upnlAll,
      optionValue: c.optionValue,
      spotValue: c.spotValue,
      initialMargin: c.im,
      orderMargin,
      maintenanceMargin: c.mm,
      available: c.crossEquity - c.im - orderMargin,
      mmRatio: c.crossEquity > 0 ? c.mm / c.crossEquity : c.mm > 0 ? 1 : 0,
      isolatedMargin: c.isoMargin,
    };
  }

  equity(acc: Account) {
    return this.core(acc).equity;
  }

  available(acc: Account) {
    const c = this.core(acc);
    return c.crossEquity - c.im - this.orderMargin(acc);
  }

  /** Цена ликвидации позиции (оценка при неизменных прочих позициях). */
  liqPrice(acc: Account, pos: Position): number | null {
    if (pos.category !== 'linear' || pos.size === 0) return null;
    const m = maintenanceMarginRate(pos.symbol) + this.config.fees.linearTaker;
    const q = Math.abs(pos.size);
    if (pos.marginMode === 'isolated') {
      if (pos.size > 0) {
        const L = (q * pos.avgPrice - pos.isolatedMargin) / (q * (1 - m));
        return L > 0 ? L : 0;
      }
      return (q * pos.avgPrice + pos.isolatedMargin) / (q * (1 + m));
    }
    const c = this.core(acc);
    const p0 = this.price(pos.symbol);
    const mmThis = q * p0 * m;
    const mmOther = c.mm - mmThis;
    const E0 = c.crossEquity;
    const denom = pos.size - m * q;
    if (Math.abs(denom) < EPS) return null;
    const L = (mmOther - E0 + pos.size * p0) / denom;
    return L > 0 ? L : pos.size > 0 ? 0 : null;
  }

  /* ───────────────────────── ордера ───────────────────────── */

  private indexOrder(o: Order) {
    const key = o.category === 'option' ? '__options' : o.symbol;
    let set = this.bySymbol.get(key);
    if (!set) this.bySymbol.set(key, (set = new Set()));
    set.add(o);
  }

  private unindexOrder(o: Order) {
    const key = o.category === 'option' ? '__options' : o.symbol;
    this.bySymbol.get(key)?.delete(o);
  }

  activeOrders(accountId?: string, symbol?: string): Order[] {
    return Object.values(this.state.orders).filter(
      (o) => (!accountId || o.accountId === accountId) && (!symbol || o.symbol === symbol),
    );
  }

  private archive(o: Order) {
    delete this.state.orders[o.id];
    this.unindexOrder(o);
    this.state.orderHistory.push(o);
    if (this.state.orderHistory.length > HIST_CAP.orders * 1.25)
      this.state.orderHistory = this.state.orderHistory.slice(-HIST_CAP.orders);
  }

  private reject(o: Order, reason: string): Order {
    o.status = 'Rejected';
    o.rejectReason = reason;
    this.state.orderHistory.push(o);
    this.emit({ type: 'reject', order: o, reason });
    return o;
  }

  private slip(side: Side, px: number, symbol: string) {
    const s = this.config.slippageBps / 10000;
    const raw = side === 'Buy' ? px * (1 + s) : px * (1 - s);
    return roundToStep(raw, getAsset(symbol).tickSize, side === 'Buy' ? 'ceil' : 'floor');
  }

  placeOrder(req: PlaceOrderRequest): Order {
    const acc = this.state.accounts[req.accountId || MAIN];
    const t = this.eventTime();
    const o: Order = {
      id: this.nextId('o'),
      accountId: acc?.id || req.accountId || MAIN,
      category: req.category,
      symbol: req.symbol,
      side: req.side,
      orderType: req.orderType,
      qty: req.qty,
      price: req.price ?? 0,
      tif: req.tif ?? (req.orderType === 'Market' ? 'IOC' : 'GTC'),
      reduceOnly: !!req.reduceOnly,
      closeOnTrigger: !!req.closeOnTrigger,
      triggerPrice: req.triggerPrice,
      triggerDirection: req.triggerDirection,
      stopOrderType: req.stopOrderType,
      trailingDistance: req.trailingDistance,
      activePrice: req.activePrice,
      takeProfit: req.takeProfit,
      stopLoss: req.stopLoss,
      status: 'New',
      filledQty: 0,
      avgPrice: 0,
      cumFee: 0,
      createdTime: t,
      updatedTime: t,
      tag: req.tag ?? 'user',
      quoteQty: req.quoteQty,
    };
    if (!acc) return this.reject(o, 'Аккаунт не найден');
    if (this.state.finished) return this.reject(o, 'Сессия завершена');
    if (o.category === 'option') return this.placeOptionOrder(acc, o);

    if (!this.market.has(o.symbol)) return this.reject(o, `Нет данных по ${o.symbol}`);
    const spec = getAsset(o.symbol);
    const last = this.price(o.symbol);
    if (!Number.isFinite(last)) return this.reject(o, 'Нет цены');

    // спот: покупка на сумму
    if (o.category === 'spot' && o.side === 'Buy' && o.orderType === 'Market' && o.quoteQty && !o.qty) {
      o.qty = roundToStep(o.quoteQty / this.slip('Buy', last, o.symbol), spec.qtyStep, 'floor');
    }
    o.qty = roundToStep(o.qty, spec.qtyStep, 'floor');
    if (o.orderType === 'Limit') o.price = roundToStep(o.price, spec.tickSize);
    if (o.triggerPrice !== undefined) o.triggerPrice = roundToStep(o.triggerPrice, spec.tickSize);
    if (!(o.qty > 0) || o.qty < spec.minQty - EPS) return this.reject(o, `Мин. количество ${spec.minQty}`);
    if (o.orderType === 'Limit' && !(o.price > 0)) return this.reject(o, 'Некорректная цена');
    if (o.category === 'spot' && (o.reduceOnly || o.closeOnTrigger)) {
      o.reduceOnly = false;
      o.closeOnTrigger = false;
    }

    // проверки позиции/средств
    if (o.category === 'linear') {
      const pos = acc.positions[o.symbol];
      if (o.reduceOnly || o.closeOnTrigger) {
        if (!o.closeOnTrigger && (!pos || pos.size === 0 || sgn(pos.size) === (o.side === 'Buy' ? 1 : -1)))
          return this.reject(o, 'Reduce-only: нет позиции для сокращения');
        if (pos && pos.size !== 0 && !o.closeOnTrigger) o.qty = Math.min(o.qty, Math.abs(pos.size));
      } else {
        const cost = this.orderCost(acc, { ...o, filledQty: 0, price: o.orderType === 'Limit' ? o.price : 0, triggerPrice: o.triggerPrice ?? (o.orderType === 'Market' ? last : undefined) });
        const avail = this.available(acc);
        if (cost > avail + 1e-6) return this.reject(o, `Недостаточно средств: нужно ${cost.toFixed(2)}, доступно ${Math.max(0, avail).toFixed(2)} USDT`);
      }
    } else {
      const base = spec.base;
      if (o.side === 'Buy') {
        const px = o.orderType === 'Limit' ? o.price : last;
        const cost = o.qty * px * (1 + this.config.fees.spotTaker);
        const avail = this.available(acc);
        if (cost > avail + 1e-6) return this.reject(o, `Недостаточно USDT: нужно ${cost.toFixed(2)}, доступно ${Math.max(0, avail).toFixed(2)}`);
      } else {
        const reserved = this.activeOrders(acc.id, o.symbol)
          .filter((x) => x.category === 'spot' && x.side === 'Sell')
          .reduce((s, x) => s + x.qty - x.filledQty, 0);
        const free = (acc.spot[base] || 0) - reserved;
        if (o.qty > free + EPS) return this.reject(o, `Недостаточно ${base}: доступно ${free}`);
      }
    }

    // условный ордер
    if (o.triggerPrice !== undefined || o.stopOrderType === 'TrailingStop') {
      if (o.stopOrderType === 'TrailingStop') {
        if (!(o.trailingDistance! > 0)) return this.reject(o, 'Нужна дистанция трейлинга');
        o.trailingExtreme = last;
        o.triggerDirection = o.side === 'Sell' ? 2 : 1;
        o.triggerPrice = o.side === 'Sell' ? last - o.trailingDistance! : last + o.trailingDistance!;
      }
      if (!o.triggerDirection) o.triggerDirection = o.triggerPrice! >= last ? 1 : 2;
      o.status = 'Untriggered';
      this.state.orders[o.id] = o;
      this.indexOrder(o);
      this.emit({ type: 'order', order: o });
      // уже выполнено условие — срабатывает сразу
      if ((o.triggerDirection === 1 && last >= o.triggerPrice!) || (o.triggerDirection === 2 && last <= o.triggerPrice!)) {
        if (o.stopOrderType !== 'TrailingStop') this.trigger(o, last);
      }
      return o;
    }

    return this.submitActive(o, last);
  }

  /** Активный (не условный) ордер: исполнить сразу или поставить в книгу. */
  private submitActive(o: Order, last: number): Order {
    const acc = this.state.accounts[o.accountId];
    if (o.orderType === 'Market') {
      this.state.orders[o.id] = o;
      this.indexOrder(o);
      this.executeOrder(acc, o, this.slip(o.side, last, o.symbol), false);
      return o;
    }
    const marketable = o.side === 'Buy' ? o.price > last + EPS : o.price < last - EPS;
    if (marketable) {
      if (o.tif === 'PostOnly') return this.reject(o, 'Post-Only: ордер исполнился бы как тейкер');
      this.state.orders[o.id] = o;
      this.indexOrder(o);
      const px = this.slip(o.side, last, o.symbol);
      this.executeOrder(acc, o, o.side === 'Buy' ? Math.min(o.price, px) : Math.max(o.price, px), false);
      return o;
    }
    if (o.tif === 'IOC' || o.tif === 'FOK') {
      o.status = 'Cancelled';
      o.rejectReason = `${o.tif}: нет встречной ликвидности`;
      this.state.orderHistory.push(o);
      return o;
    }
    o.status = 'New';
    this.state.orders[o.id] = o;
    this.indexOrder(o);
    this.emit({ type: 'order', order: o });
    return o;
  }

  cancelOrder(id: string, reason = 'Отменён пользователем'): boolean {
    const o = this.state.orders[id];
    if (!o) return false;
    o.status = o.status === 'Untriggered' ? 'Deactivated' : 'Cancelled';
    o.rejectReason = reason;
    o.updatedTime = this.eventTime();
    this.archive(o);
    if (o.tag === 'tpsl') {
      const pos = this.state.accounts[o.accountId]?.positions[o.symbol];
      if (pos) {
        if (o.stopOrderType === 'TakeProfit') pos.takeProfit = undefined;
        if (o.stopOrderType === 'StopLoss') pos.stopLoss = undefined;
        if (o.stopOrderType === 'TrailingStop') pos.trailingStop = undefined;
      }
    }
    this.emit({ type: 'order', order: o });
    return true;
  }

  cancelAll(accountId = MAIN, symbol?: string, filter?: (o: Order) => boolean) {
    for (const o of this.activeOrders(accountId, symbol)) if (!filter || filter(o)) this.cancelOrder(o.id);
  }

  amendOrder(id: string, patch: { price?: number; qty?: number; triggerPrice?: number }): string | null {
    const o = this.state.orders[id];
    if (!o) return 'Ордер не найден';
    const spec = o.category === 'option' ? null : getAsset(o.symbol);
    if (patch.qty !== undefined) {
      const q = spec ? roundToStep(patch.qty, spec.qtyStep, 'floor') : patch.qty;
      if (q <= o.filledQty) return 'Количество меньше исполненного';
      o.qty = q;
    }
    if (patch.price !== undefined && o.orderType === 'Limit') o.price = spec ? roundToStep(patch.price, spec.tickSize) : patch.price;
    if (patch.triggerPrice !== undefined && o.status === 'Untriggered') {
      o.triggerPrice = spec ? roundToStep(patch.triggerPrice, spec.tickSize) : patch.triggerPrice;
      const last = this.price(this.dataSymbol(o.category, o.symbol));
      if (o.stopOrderType !== 'TakeProfit' && o.stopOrderType !== 'StopLoss')
        o.triggerDirection = o.triggerPrice >= last ? 1 : 2;
    }
    o.updatedTime = this.eventTime();
    // лимитный ордер стал исполнимым — исполняем
    if (o.status === 'New' && o.orderType === 'Limit' && o.category !== 'option') {
      const last = this.price(o.symbol);
      if (o.side === 'Buy' ? o.price > last + EPS : o.price < last - EPS)
        this.executeOrder(this.state.accounts[o.accountId], o, last, false);
    }
    if (o.tag === 'tpsl') {
      const pos = this.state.accounts[o.accountId]?.positions[o.symbol];
      if (pos && o.stopOrderType === 'TakeProfit') pos.takeProfit = o.triggerPrice;
      if (pos && o.stopOrderType === 'StopLoss') pos.stopLoss = o.triggerPrice;
    }
    this.emit({ type: 'order', order: o });
    return null;
  }

  /** Срабатывание условного ордера. */
  private trigger(o: Order, px: number) {
    const acc = this.state.accounts[o.accountId];
    o.status = 'Triggered';
    o.updatedTime = this.eventTime();
    if (o.closeOnTrigger && o.category === 'linear') {
      const pos = acc.positions[o.symbol];
      const closing = pos && pos.size !== 0 && sgn(pos.size) !== (o.side === 'Buy' ? 1 : -1);
      if (!closing) {
        o.status = 'Deactivated';
        o.rejectReason = 'Нет позиции';
        this.archive(o);
        return;
      }
      if (o.tag === 'tpsl') o.qty = Math.abs(pos.size);
      else o.qty = Math.min(o.qty, Math.abs(pos.size));
    } else if (!o.reduceOnly) {
      // условный ордер открытия: проверяем средства на момент срабатывания
      delete this.state.orders[o.id];
      const need = this.orderCost(acc, { ...o, triggerPrice: px });
      const avail = this.available(acc);
      this.state.orders[o.id] = o;
      if (need > avail + 1e-6) {
        o.status = 'Deactivated';
        o.rejectReason = 'Недостаточно средств при срабатывании';
        this.archive(o);
        this.emit({ type: 'reject', order: o, reason: o.rejectReason });
        return;
      }
    }
    if (o.orderType === 'Market') {
      this.executeOrder(acc, o, this.slip(o.side, px, o.symbol), false);
    } else {
      o.status = 'New';
      o.triggerPrice = undefined;
      const marketable = o.side === 'Buy' ? o.price > px + EPS : o.price < px - EPS;
      if (marketable) this.executeOrder(acc, o, px, false);
    }
  }

  /** Полное исполнение ордера по цене price. */
  private executeOrder(acc: Account, o: Order, price: number, isMaker: boolean) {
    let qty = o.qty - o.filledQty;
    if (o.category === 'linear' && (o.reduceOnly || o.closeOnTrigger)) {
      const pos = acc.positions[o.symbol];
      const closing = pos && pos.size !== 0 && sgn(pos.size) !== (o.side === 'Buy' ? 1 : -1);
      if (!closing) {
        o.status = 'Cancelled';
        o.rejectReason = 'Reduce-only: позиция уже закрыта';
        this.archive(o);
        return;
      }
      qty = Math.min(qty, Math.abs(pos.size));
    }
    if (o.category === 'spot' && o.side === 'Sell') {
      const have = acc.spot[getAsset(o.symbol).base] || 0;
      qty = Math.min(qty, have);
    }
    if (qty <= EPS) {
      o.status = 'Cancelled';
      this.archive(o);
      return;
    }
    let exec: Execution;
    if (o.category === 'spot') exec = this.fillSpot(acc, o, qty, price, isMaker);
    else exec = this.fillLinear(acc, o.symbol, o.side, qty, price, isMaker, 'Trade', o);
    o.avgPrice = (o.avgPrice * o.filledQty + price * qty) / (o.filledQty + qty);
    o.filledQty += qty;
    o.cumFee += exec.fee;
    o.status = 'Filled';
    o.updatedTime = this.eventTime();
    this.archive(o);
    // прикреплённые TP/SL
    if (o.category === 'linear' && (o.takeProfit || o.stopLoss) && !o.reduceOnly) {
      const pos = acc.positions[o.symbol];
      if (pos && pos.size !== 0) {
        const err = this.setTradingStop(acc.id, o.symbol, {
          takeProfit: o.takeProfit ?? undefined,
          stopLoss: o.stopLoss ?? undefined,
        });
        if (err) this.emit({ type: 'info', message: `TP/SL не установлены: ${err}` });
      }
    }
    this.emit({ type: 'fill', exec, order: o });
    this.notifyBot(acc, o, exec);
  }

  private notifyBot(acc: Account, o: Order, exec: Execution) {
    if (!acc.botId) return;
    const bot = this.state.bots[acc.botId];
    if (!bot || (bot.status !== 'running' && bot.status !== 'waiting')) return;
    BOT_LOGIC[bot.type].onFill(this, bot as any, o, exec);
  }

  /* ───────────────────────── исполнение: перпетуалы ───────────────────────── */

  private pushExec(e: Execution) {
    this.state.executions.push(e);
    if (this.state.executions.length > HIST_CAP.executions * 1.25)
      this.state.executions = this.state.executions.slice(-HIST_CAP.executions);
  }

  private pushClosed(acc: Account, r: ClosedPnlRecord) {
    this.state.closedPnl.push(r);
    if (this.state.closedPnl.length > HIST_CAP.closedPnl * 1.25) this.state.closedPnl = this.state.closedPnl.slice(-HIST_CAP.closedPnl);
    const st = acc.stats;
    st.trades++;
    st.realisedPnl += r.closedPnl;
    if (r.closedPnl >= 0) {
      st.wins++;
      st.grossProfit += r.closedPnl;
    } else {
      st.losses++;
      st.grossLoss += -r.closedPnl;
    }
  }

  private getOrCreatePosition(acc: Account, symbol: string, category: 'linear' | 'option'): Position {
    let pos = acc.positions[symbol];
    if (!pos) {
      const t = this.eventTime();
      pos = {
        symbol,
        category,
        size: 0,
        avgPrice: 0,
        leverage: category === 'linear' ? this.leverageOf(acc, symbol) : 1,
        marginMode: category === 'linear' ? this.marginModeOf(acc, symbol) : 'cross',
        isolatedMargin: 0,
        realisedPnl: 0,
        openFee: 0,
        funding: 0,
        createdTime: t,
        updatedTime: t,
      };
      acc.positions[symbol] = pos;
    }
    return pos;
  }

  fillLinear(
    acc: Account,
    symbol: string,
    side: Side,
    qty: number,
    price: number,
    isMaker: boolean,
    execType: Execution['execType'],
    order?: Order,
  ): Execution {
    const fees = this.config.fees;
    const feeRate = execType === 'Liquidation' ? 0 : isMaker ? fees.linearMaker : fees.linearTaker;
    const fee = qty * price * feeRate;
    const pos = this.getOrCreatePosition(acc, symbol, 'linear');
    const dir = side === 'Buy' ? 1 : -1;
    let gross = 0;
    const t = this.eventTime();
    let remaining = qty;
    if (pos.size !== 0 && sgn(pos.size) !== dir) {
      const absSize = Math.abs(pos.size);
      const closeQty = Math.min(qty, absSize);
      gross = closeQty * (price - pos.avgPrice) * sgn(pos.size);
      const portion = closeQty / absSize;
      const openFeePart = pos.openFee * portion;
      const fundingPart = pos.funding * portion;
      const closeFee = fee * (closeQty / qty);
      const marginRelease = pos.isolatedMargin * portion;
      acc.walletBalance += gross;
      pos.openFee -= openFeePart;
      pos.funding -= fundingPart;
      pos.isolatedMargin -= marginRelease;
      pos.realisedPnl += gross - closeFee;
      const newAbs = absSize - closeQty;
      pos.size = newAbs < EPS ? 0 : sgn(pos.size) * newAbs;
      const stopType = order?.stopOrderType;
      this.pushClosed(acc, {
        id: this.nextId('c'),
        accountId: acc.id,
        category: 'linear',
        symbol,
        side: dir === 1 ? 'Sell' : 'Buy',
        qty: closeQty,
        entryPrice: pos.avgPrice,
        exitPrice: price,
        closedPnl: gross - openFeePart - closeFee + fundingPart,
        openFee: openFeePart,
        closeFee,
        funding: fundingPart,
        leverage: pos.leverage,
        openTime: pos.createdTime,
        closeTime: t,
        type:
          execType === 'Liquidation'
            ? 'Liquidation'
            : stopType === 'TakeProfit'
              ? 'TP'
              : stopType === 'StopLoss' || stopType === 'TrailingStop'
                ? 'SL'
                : 'Trade',
      });
      remaining = qty - closeQty;
      if (pos.size === 0) {
        pos.avgPrice = 0;
        pos.isolatedMargin = 0;
        pos.openFee = 0;
        pos.funding = 0;
      }
    }
    if (remaining > EPS) {
      const absSize = Math.abs(pos.size);
      if (absSize === 0) {
        pos.createdTime = t;
        pos.leverage = this.leverageOf(acc, symbol);
        pos.marginMode = this.marginModeOf(acc, symbol);
        pos.realisedPnl = 0;
      }
      pos.avgPrice = (absSize * pos.avgPrice + remaining * price) / (absSize + remaining);
      pos.size = dir * (absSize + remaining);
      pos.openFee += fee * (remaining / qty);
      if (pos.marginMode === 'isolated') pos.isolatedMargin += (remaining * price) / pos.leverage;
    }
    acc.walletBalance -= fee;
    acc.stats.fees += fee;
    acc.stats.volume += qty * price;
    pos.updatedTime = t;
    const exec: Execution = {
      id: this.nextId('e'),
      orderId: order?.id ?? '',
      accountId: acc.id,
      category: 'linear',
      symbol,
      side,
      qty,
      price,
      fee,
      isMaker,
      time: t,
      execType,
      closedPnl: gross,
      tag: order?.tag ?? (execType === 'Liquidation' ? 'liq' : ''),
    };
    this.pushExec(exec);
    if (pos.size === 0) this.onPositionClosed(acc, symbol);
    return exec;
  }

  private onPositionClosed(acc: Account, symbol: string) {
    delete acc.positions[symbol];
    for (const o of this.activeOrders(acc.id, symbol))
      if (o.category !== 'spot' && (o.tag === 'tpsl' || o.reduceOnly || o.closeOnTrigger)) this.cancelOrder(o.id, 'Позиция закрыта');
  }

  /* ───────────────────────── исполнение: спот ───────────────────────── */

  private fillSpot(acc: Account, o: Order, qty: number, price: number, isMaker: boolean): Execution {
    const fees = this.config.fees;
    const rate = isMaker ? fees.spotMaker : fees.spotTaker;
    const base = getAsset(o.symbol).base;
    const notional = qty * price;
    const fee = notional * rate;
    const t = this.eventTime();
    let realized = 0;
    if (o.side === 'Buy') {
      acc.walletBalance -= notional + fee;
      acc.spot[base] = (acc.spot[base] || 0) + qty;
      acc.spotCost[base] = (acc.spotCost[base] || 0) + notional + fee;
    } else {
      const have = acc.spot[base] || 0;
      const costPart = have > 0 ? (acc.spotCost[base] || 0) * (qty / have) : 0;
      acc.walletBalance += notional - fee;
      acc.spot[base] = have - qty;
      acc.spotCost[base] = (acc.spotCost[base] || 0) - costPart;
      if (acc.spot[base] < EPS) {
        delete acc.spot[base];
        delete acc.spotCost[base];
      }
      realized = notional - fee - costPart;
      this.pushClosed(acc, {
        id: this.nextId('c'),
        accountId: acc.id,
        category: 'spot',
        symbol: o.symbol,
        side: 'Buy',
        qty,
        entryPrice: qty > 0 ? costPart / qty : 0,
        exitPrice: price,
        closedPnl: realized,
        openFee: 0,
        closeFee: fee,
        funding: 0,
        leverage: 1,
        openTime: t,
        closeTime: t,
        type: 'Trade',
      });
    }
    acc.stats.fees += fee;
    acc.stats.volume += notional;
    const exec: Execution = {
      id: this.nextId('e'),
      orderId: o.id,
      accountId: acc.id,
      category: 'spot',
      symbol: o.symbol,
      side: o.side,
      qty,
      price,
      fee,
      isMaker,
      time: t,
      execType: 'Trade',
      closedPnl: realized,
      tag: o.tag,
    };
    this.pushExec(exec);
    return exec;
  }

  /* ───────────────────────── исполнение: опционы ───────────────────────── */

  private placeOptionOrder(acc: Account, o: Order): Order {
    const inst = this.optionInstrument(o.symbol);
    if (!inst) return this.reject(o, 'Некорректный символ опциона');
    if (!this.market.has(inst.underlying)) return this.reject(o, `Нет данных базового актива ${inst.underlying}`);
    if (inst.expiry <= this.state.now) return this.reject(o, 'Опцион уже экспирирован');
    if (o.triggerPrice !== undefined) return this.reject(o, 'Условные ордера для опционов не поддерживаются');
    const q = this.optionQuote(o.symbol);
    if (!q) return this.reject(o, 'Нет котировки');
    const step = optionQtyStep(q.underlyingPrice);
    o.qty = roundToStep(o.qty, step, 'floor');
    if (!(o.qty >= step - EPS)) return this.reject(o, `Мин. количество ${step}`);
    const tick = optionTickSize(q.underlyingPrice);
    if (o.orderType === 'Limit') {
      o.price = roundToStep(o.price, tick);
      if (!(o.price > 0)) return this.reject(o, 'Некорректная цена');
    }
    const pos = acc.positions[o.symbol];
    if (o.reduceOnly) {
      if (!pos || pos.size === 0 || sgn(pos.size) === (o.side === 'Buy' ? 1 : -1)) return this.reject(o, 'Reduce-only: нет позиции');
      o.qty = Math.min(o.qty, Math.abs(pos.size));
    }
    const refPrice = o.orderType === 'Market' ? (o.side === 'Buy' ? q.ask : q.bid) : o.price;
    if (o.side === 'Sell' && o.orderType === 'Market' && q.bid <= 0) return this.reject(o, 'Нет покупателей (bid = 0)');
    // проверка маржи
    const openQty = this.openingQty(pos, o.side, o.qty);
    if (openQty > 0 && !o.reduceOnly) {
      const fee = optionFee(this.config.fees.optionTaker, this.config.fees.optionFeeCap, q.underlyingPrice, refPrice, openQty);
      let need: number;
      if (o.side === 'Buy') need = openQty * refPrice + fee;
      else {
        const m = shortOptionMargin(this.config.options, inst, q.underlyingPrice, q.mark);
        need = openQty * Math.max(0, m.im - refPrice) + fee;
      }
      const avail = this.available(acc);
      if (need > avail + 1e-6) return this.reject(o, `Недостаточно средств: нужно ${need.toFixed(2)}, доступно ${Math.max(0, avail).toFixed(2)} USDT`);
    }
    this.state.orders[o.id] = o;
    this.indexOrder(o);
    if (o.orderType === 'Market') {
      this.executeOption(acc, o, refPrice, false);
      return o;
    }
    // лимит: исполнимый сразу?
    if ((o.side === 'Buy' && o.price >= q.ask) || (o.side === 'Sell' && q.bid > 0 && o.price <= q.bid)) {
      if (o.tif === 'PostOnly') {
        delete this.state.orders[o.id];
        this.unindexOrder(o);
        return this.reject(o, 'Post-Only: ордер исполнился бы как тейкер');
      }
      this.executeOption(acc, o, o.side === 'Buy' ? q.ask : q.bid, false);
      return o;
    }
    if (o.tif === 'IOC' || o.tif === 'FOK') {
      delete this.state.orders[o.id];
      this.unindexOrder(o);
      o.status = 'Cancelled';
      this.state.orderHistory.push(o);
      return o;
    }
    this.emit({ type: 'order', order: o });
    return o;
  }

  private executeOption(acc: Account, o: Order, price: number, isMaker: boolean) {
    let qty = o.qty - o.filledQty;
    if (o.reduceOnly) {
      const pos = acc.positions[o.symbol];
      if (!pos || pos.size === 0) {
        o.status = 'Cancelled';
        this.archive(o);
        return;
      }
      qty = Math.min(qty, Math.abs(pos.size));
    }
    const exec = this.fillOption(acc, o.symbol, o.side, qty, price, isMaker, 'Trade', o);
    o.avgPrice = price;
    o.filledQty += qty;
    o.cumFee += exec.fee;
    o.status = 'Filled';
    o.updatedTime = this.eventTime();
    this.archive(o);
    this.emit({ type: 'fill', exec, order: o });
    this.notifyBot(acc, o, exec);
  }

  fillOption(
    acc: Account,
    symbol: string,
    side: Side,
    qty: number,
    price: number,
    isMaker: boolean,
    execType: Execution['execType'],
    order?: Order,
  ): Execution {
    const inst = this.optionInstrument(symbol)!;
    const S = this.price(inst.underlying);
    const fees = this.config.fees;
    const fee =
      execType === 'Liquidation'
        ? 0
        : optionFee(isMaker ? fees.optionMaker : fees.optionTaker, fees.optionFeeCap, S, price, qty);
    const dir = side === 'Buy' ? 1 : -1;
    const t = this.eventTime();
    // денежный поток премии
    acc.walletBalance += -dir * qty * price - fee;
    acc.stats.fees += fee;
    acc.stats.volume += qty * S;
    const pos = this.getOrCreatePosition(acc, symbol, 'option');
    let gross = 0;
    let remaining = qty;
    if (pos.size !== 0 && sgn(pos.size) !== dir) {
      const absSize = Math.abs(pos.size);
      const closeQty = Math.min(qty, absSize);
      gross = closeQty * (price - pos.avgPrice) * sgn(pos.size);
      const portion = closeQty / absSize;
      const openFeePart = pos.openFee * portion;
      const closeFee = fee * (closeQty / qty);
      pos.openFee -= openFeePart;
      pos.realisedPnl += gross - closeFee;
      this.pushClosed(acc, {
        id: this.nextId('c'),
        accountId: acc.id,
        category: 'option',
        symbol,
        side: dir === 1 ? 'Sell' : 'Buy',
        qty: closeQty,
        entryPrice: pos.avgPrice,
        exitPrice: price,
        closedPnl: gross - openFeePart - closeFee,
        openFee: openFeePart,
        closeFee,
        funding: 0,
        leverage: 1,
        openTime: pos.createdTime,
        closeTime: t,
        type: execType === 'Liquidation' ? 'Liquidation' : 'Trade',
      });
      const newAbs = absSize - closeQty;
      pos.size = newAbs < EPS ? 0 : sgn(pos.size) * newAbs;
      remaining = qty - closeQty;
      if (pos.size === 0) {
        pos.avgPrice = 0;
        pos.openFee = 0;
      }
    }
    if (remaining > EPS) {
      const absSize = Math.abs(pos.size);
      if (absSize === 0) pos.createdTime = t;
      pos.avgPrice = (absSize * pos.avgPrice + remaining * price) / (absSize + remaining);
      pos.size = dir * (absSize + remaining);
      pos.openFee += fee * (remaining / qty);
    }
    pos.updatedTime = t;
    const exec: Execution = {
      id: this.nextId('e'),
      orderId: order?.id ?? '',
      accountId: acc.id,
      category: 'option',
      symbol,
      side,
      qty,
      price,
      fee,
      isMaker,
      time: t,
      execType,
      closedPnl: gross,
      tag: order?.tag ?? '',
    };
    this.pushExec(exec);
    if (pos.size === 0) this.onPositionClosed(acc, symbol);
    return exec;
  }

  /** Проверка лимитных ордеров опционов (раз в бар). */
  private matchOptionOrders() {
    const set = this.bySymbol.get('__options');
    if (!set || !set.size) return;
    for (const o of [...set]) {
      if (!this.state.orders[o.id]) continue;
      const q = this.optionQuote(o.symbol);
      if (!q) continue;
      const acc = this.state.accounts[o.accountId];
      if (o.side === 'Buy' && q.ask <= o.price) this.executeOption(acc, o, o.price, true);
      else if (o.side === 'Sell' && q.bid > 0 && q.bid >= o.price) this.executeOption(acc, o, o.price, true);
    }
  }

  /** Экспирация опционов: расчёт по цене базового актива. */
  private settleOptions(until: number) {
    for (const acc of Object.values(this.state.accounts)) {
      for (const pos of Object.values(acc.positions)) {
        if (pos.category !== 'option') continue;
        const inst = this.optionInstrument(pos.symbol)!;
        if (inst.expiry >= until) continue;
        const S = this.price(inst.underlying);
        const payoff = intrinsicValue(inst, S);
        const fees = this.config.fees;
        const fee = payoff > 0 ? Math.min(fees.optionDelivery * S * Math.abs(pos.size), fees.optionFeeCap * payoff * Math.abs(pos.size)) : 0;
        const cash = pos.size * payoff;
        acc.walletBalance += cash - fee;
        acc.stats.fees += fee;
        const gross = pos.size * (payoff - pos.avgPrice);
        const t = Math.min(this.eventTime(), inst.expiry);
        this.pushClosed(acc, {
          id: this.nextId('c'),
          accountId: acc.id,
          category: 'option',
          symbol: pos.symbol,
          side: pos.size > 0 ? 'Buy' : 'Sell',
          qty: Math.abs(pos.size),
          entryPrice: pos.avgPrice,
          exitPrice: payoff,
          closedPnl: gross - pos.openFee - fee,
          openFee: pos.openFee,
          closeFee: fee,
          funding: 0,
          leverage: 1,
          openTime: pos.createdTime,
          closeTime: t,
          type: 'Delivery',
        });
        this.pushExec({
          id: this.nextId('e'),
          orderId: '',
          accountId: acc.id,
          category: 'option',
          symbol: pos.symbol,
          side: pos.size > 0 ? 'Sell' : 'Buy',
          qty: Math.abs(pos.size),
          price: payoff,
          fee,
          isMaker: false,
          time: t,
          execType: 'Delivery',
          closedPnl: gross,
          tag: 'delivery',
        });
        this.emit({ type: 'expiry', accountId: acc.id, symbol: pos.symbol, pnl: gross - pos.openFee - fee });
        delete acc.positions[pos.symbol];
      }
    }
    for (const o of this.activeOrders()) {
      if (o.category !== 'option') continue;
      const inst = this.optionInstrument(o.symbol);
      if (inst && inst.expiry < until) this.cancelOrder(o.id, 'Экспирация');
    }
  }

  /* ───────────────────────── управление позициями ───────────────────────── */

  setLeverage(accountId: string, symbol: string, lev: number): string | null {
    const acc = this.account(accountId);
    const spec = getAsset(symbol);
    lev = Math.round(lev * 100) / 100;
    if (!(lev >= 1 && lev <= spec.maxLeverage)) return `Плечо должно быть от 1 до ${spec.maxLeverage}`;
    const pos = acc.positions[symbol];
    const prev = acc.leverage[symbol];
    acc.leverage[symbol] = lev;
    if (pos && pos.category === 'linear' && pos.size !== 0) {
      const oldLev = pos.leverage;
      const oldMargin = pos.isolatedMargin;
      pos.leverage = lev;
      if (pos.marginMode === 'isolated') pos.isolatedMargin = (Math.abs(pos.size) * pos.avgPrice) / lev;
      if (this.available(acc) < -1e-6) {
        pos.leverage = oldLev;
        pos.isolatedMargin = oldMargin;
        if (prev === undefined) delete acc.leverage[symbol];
        else acc.leverage[symbol] = prev;
        return 'Недостаточно доступной маржи для такого плеча';
      }
    }
    return null;
  }

  setMarginMode(accountId: string, symbol: string, mode: MarginMode): string | null {
    const acc = this.account(accountId);
    const pos = acc.positions[symbol];
    if (pos && pos.size !== 0) return 'Нельзя сменить режим маржи при открытой позиции';
    if (this.activeOrders(accountId, symbol).some((o) => o.category === 'linear'))
      return 'Сначала отмените активные ордера по символу';
    acc.marginMode[symbol] = mode;
    return null;
  }

  addMargin(accountId: string, symbol: string, amount: number): string | null {
    const acc = this.account(accountId);
    const pos = acc.positions[symbol];
    if (!pos || pos.marginMode !== 'isolated') return 'Только для изолированной позиции';
    if (amount > 0 && amount > this.available(acc)) return 'Недостаточно средств';
    if (amount < 0) {
      const minMargin = (Math.abs(pos.size) * pos.avgPrice) / pos.leverage;
      if (pos.isolatedMargin + amount < minMargin - 1e-9) return 'Нельзя вывести маржу ниже начальной';
    }
    pos.isolatedMargin += amount;
    return null;
  }

  setTradingStop(
    accountId: string,
    symbol: string,
    p: { takeProfit?: number | null; stopLoss?: number | null; trailingStop?: number | null },
  ): string | null {
    const acc = this.account(accountId);
    const pos = acc.positions[symbol];
    if (!pos || pos.size === 0 || pos.category !== 'linear') return 'Нет позиции';
    const last = this.price(symbol);
    const long = pos.size > 0;
    const closeSide: Side = long ? 'Sell' : 'Buy';
    const existing = (type: string) =>
      this.activeOrders(accountId, symbol).find((o) => o.tag === 'tpsl' && o.stopOrderType === type);
    if (p.takeProfit !== undefined) {
      const old = existing('TakeProfit');
      if (old) this.cancelOrder(old.id, 'Заменён');
      if (p.takeProfit !== null) {
        if (long ? p.takeProfit <= last : p.takeProfit >= last) return `TP должен быть ${long ? 'выше' : 'ниже'} текущей цены`;
        this.placeOrder({
          accountId,
          category: 'linear',
          symbol,
          side: closeSide,
          orderType: 'Market',
          qty: Math.abs(pos.size),
          triggerPrice: p.takeProfit,
          triggerDirection: long ? 1 : 2,
          stopOrderType: 'TakeProfit',
          closeOnTrigger: true,
          reduceOnly: true,
          tag: 'tpsl',
        });
        pos.takeProfit = roundToStep(p.takeProfit, getAsset(symbol).tickSize);
      }
    }
    if (p.stopLoss !== undefined) {
      const old = existing('StopLoss');
      if (old) this.cancelOrder(old.id, 'Заменён');
      if (p.stopLoss !== null) {
        if (long ? p.stopLoss >= last : p.stopLoss <= last) return `SL должен быть ${long ? 'ниже' : 'выше'} текущей цены`;
        this.placeOrder({
          accountId,
          category: 'linear',
          symbol,
          side: closeSide,
          orderType: 'Market',
          qty: Math.abs(pos.size),
          triggerPrice: p.stopLoss,
          triggerDirection: long ? 2 : 1,
          stopOrderType: 'StopLoss',
          closeOnTrigger: true,
          reduceOnly: true,
          tag: 'tpsl',
        });
        pos.stopLoss = roundToStep(p.stopLoss, getAsset(symbol).tickSize);
      }
    }
    if (p.trailingStop !== undefined) {
      const old = existing('TrailingStop');
      if (old) this.cancelOrder(old.id, 'Заменён');
      if (p.trailingStop !== null && p.trailingStop > 0) {
        this.placeOrder({
          accountId,
          category: 'linear',
          symbol,
          side: closeSide,
          orderType: 'Market',
          qty: Math.abs(pos.size),
          stopOrderType: 'TrailingStop',
          trailingDistance: p.trailingStop,
          closeOnTrigger: true,
          reduceOnly: true,
          tag: 'tpsl',
        });
        pos.trailingStop = p.trailingStop;
      }
    }
    return null;
  }

  /** Закрыть позицию по рынку (или лимитом). */
  closePosition(accountId: string, symbol: string, price?: number): Order | null {
    const acc = this.account(accountId);
    const pos = acc.positions[symbol];
    if (!pos || pos.size === 0) return null;
    return this.placeOrder({
      accountId,
      category: pos.category,
      symbol,
      side: pos.size > 0 ? 'Sell' : 'Buy',
      orderType: price ? 'Limit' : 'Market',
      price,
      qty: Math.abs(pos.size),
      reduceOnly: true,
      tag: acc.botId ? `bot:${acc.botId}` : 'user',
    });
  }

  closeAllPositions(accountId = MAIN) {
    const acc = this.account(accountId);
    for (const sym of Object.keys(acc.positions)) this.closePosition(accountId, sym);
  }

  /** Внутренний перевод USDT между аккаунтами. */
  transfer(from: string, to: string, amount: number): string | null {
    const a = this.account(from);
    const b = this.account(to);
    if (amount <= 0) return 'Сумма должна быть > 0';
    if (amount > this.available(a) + 1e-6) return 'Недостаточно доступных средств';
    a.walletBalance -= amount;
    b.walletBalance += amount;
    return null;
  }

  /* ───────────────────────── funding и ликвидации ───────────────────────── */

  private applyFunding(symbol: string, rate: number, px: number) {
    for (const acc of Object.values(this.state.accounts)) {
      const pos = acc.positions[symbol];
      if (!pos || pos.category !== 'linear' || pos.size === 0) continue;
      const amount = -pos.size * px * rate;
      acc.walletBalance += amount;
      pos.funding += amount;
      pos.realisedPnl += amount;
      acc.stats.funding += amount;
      this.pushExec({
        id: this.nextId('e'),
        orderId: '',
        accountId: acc.id,
        category: 'linear',
        symbol,
        side: pos.size > 0 ? 'Buy' : 'Sell',
        qty: Math.abs(pos.size),
        price: px,
        fee: -amount,
        isMaker: false,
        time: this.eventTime(),
        execType: 'Funding',
        closedPnl: 0,
        tag: 'funding',
      });
      if (acc.id === MAIN) this.emit({ type: 'funding', accountId: acc.id, symbol, amount });
    }
  }

  private liquidateIsolated(acc: Account, pos: Position, px: number) {
    const lossMargin = pos.isolatedMargin;
    const symbol = pos.symbol;
    const side: Side = pos.size > 0 ? 'Sell' : 'Buy';
    const qty = Math.abs(pos.size);
    const walletBefore = acc.walletBalance;
    const openFee = pos.openFee;
    const funding = pos.funding;
    // закрываем по цене ликвидации, затем списываем остаток маржи в страховой фонд
    this.fillLinear(acc, symbol, side, qty, px, false, 'Liquidation');
    const delta = acc.walletBalance - walletBefore; // брутто PnL
    const extra = -lossMargin - delta;
    acc.walletBalance += extra;
    const rec = this.state.closedPnl[this.state.closedPnl.length - 1];
    if (rec && rec.symbol === symbol && rec.type === 'Liquidation') {
      acc.stats.realisedPnl -= rec.closedPnl;
      if (rec.closedPnl >= 0) {
        acc.stats.wins--;
        acc.stats.grossProfit -= rec.closedPnl;
      } else {
        acc.stats.losses--;
        acc.stats.grossLoss += rec.closedPnl;
      }
      rec.closedPnl = -lossMargin - openFee + funding;
      acc.stats.realisedPnl += rec.closedPnl;
      acc.stats.losses++;
      acc.stats.grossLoss += -rec.closedPnl;
    }
    acc.stats.liquidations++;
    this.emit({ type: 'liquidation', accountId: acc.id, symbol, loss: lossMargin });
    this.onLiquidated(acc);
  }

  /** Кросс-ликвидация: закрываются все кросс-позиции и опционы аккаунта. */
  liquidateCross(acc: Account, reason = 'кросс-маржа') {
    const s = this.core(acc);
    const mm = s.mm;
    for (const pos of Object.values(acc.positions)) {
      if (pos.category === 'linear' && pos.marginMode === 'isolated') continue;
      const side: Side = pos.size > 0 ? 'Sell' : 'Buy';
      const qty = Math.abs(pos.size);
      if (pos.category === 'linear') this.fillLinear(acc, pos.symbol, side, qty, this.price(pos.symbol), false, 'Liquidation');
      else this.fillOption(acc, pos.symbol, side, qty, this.optionMark(pos.symbol), false, 'Liquidation');
    }
    // остаток поддерживающей маржи уходит в страховой фонд
    const isoMargin = Object.values(acc.positions).reduce((x, p) => x + (p.category === 'linear' ? p.isolatedMargin : 0), 0);
    const crossLeft = acc.walletBalance - isoMargin;
    const fee = Math.max(0, Math.min(crossLeft, mm));
    acc.walletBalance -= fee;
    if (acc.walletBalance - isoMargin < 0) acc.walletBalance = isoMargin; // страховой фонд покрывает дефицит
    acc.stats.liquidations++;
    for (const o of this.activeOrders(acc.id)) if (o.category !== 'spot') this.cancelOrder(o.id, 'Ликвидация');
    this.emit({ type: 'liquidation', accountId: acc.id, symbol: reason, loss: Math.max(0, s.crossEquity) });
    this.onLiquidated(acc);
  }

  private onLiquidated(acc: Account) {
    if (!acc.botId) return;
    const bot = this.state.bots[acc.botId];
    if (bot && bot.status === 'running') {
      const hasPos = Object.keys(acc.positions).length > 0;
      if (!hasPos) this.stopBot(bot.id, 'Ликвидация', { liquidated: true });
    }
  }

  private crossLiqPrice(acc: Account, symbol: string): { price: number; dir: 1 | -1 } | null {
    const pos = acc.positions[symbol];
    if (!pos || pos.category !== 'linear' || pos.marginMode !== 'cross' || pos.size === 0) return null;
    const L = this.liqPrice(acc, pos);
    if (L === null) return null;
    return { price: L, dir: pos.size > 0 ? -1 : 1 };
  }

  /* ───────────────────────── движение цены внутри бара ───────────────────────── */

  private nextEvent(symbol: string, cur: number, target: number, dir: 1 | -1): PathEvent | null {
    let best: PathEvent | null = null;
    let bestDist = Infinity;
    const tol = Math.abs(cur) * 1e-12 + 1e-12;
    const consider = (price: number, ev: Omit<PathEvent, 'price'>) => {
      if (!Number.isFinite(price)) return;
      const ok = dir > 0 ? price >= cur - tol && price <= target + tol : price <= cur + tol && price >= target - tol;
      if (!ok) return;
      const d = Math.abs(price - cur);
      if (d < bestDist) {
        bestDist = d;
        best = { price, ...ev } as PathEvent;
      }
    };
    const set = this.bySymbol.get(symbol);
    if (set)
      for (const o of set) {
        if (o.status === 'Untriggered') {
          if (o.stopOrderType === 'TrailingStop') {
            if (o.triggerDirection === 2 && dir < 0) consider(o.trailingExtreme! - o.trailingDistance!, { kind: 'order', order: o });
            if (o.triggerDirection === 1 && dir > 0) consider(o.trailingExtreme! + o.trailingDistance!, { kind: 'order', order: o });
          } else if ((o.triggerDirection === 1 && dir > 0) || (o.triggerDirection === 2 && dir < 0)) {
            consider(o.triggerPrice!, { kind: 'order', order: o });
          }
        } else if (o.orderType === 'Limit') {
          if (o.side === 'Buy' && dir < 0) consider(o.price, { kind: 'order', order: o });
          if (o.side === 'Sell' && dir > 0) consider(o.price, { kind: 'order', order: o });
        }
      }
    for (const acc of Object.values(this.state.accounts)) {
      const pos = acc.positions[symbol];
      if (!pos || pos.category !== 'linear' || pos.size === 0) continue;
      if (pos.marginMode === 'isolated') {
        const L = this.liqPrice(acc, pos);
        if (L !== null && ((pos.size > 0 && dir < 0) || (pos.size < 0 && dir > 0)))
          consider(pos.size > 0 ? Math.min(L, cur) : Math.max(L, cur), { kind: 'liqIso', account: acc, position: pos });
      } else {
        const c = this.crossLiqPrice(acc, symbol);
        if (c && c.dir === dir) consider(dir < 0 ? Math.min(c.price, cur) : Math.max(c.price, cur), { kind: 'liqCross', account: acc });
      }
    }
    return best;
  }

  private updateTrailing(symbol: string, px: number) {
    const set = this.bySymbol.get(symbol);
    if (!set) return;
    for (const o of set) {
      if (o.status !== 'Untriggered' || o.stopOrderType !== 'TrailingStop') continue;
      if (o.triggerDirection === 2) o.trailingExtreme = Math.max(o.trailingExtreme!, px);
      else o.trailingExtreme = Math.min(o.trailingExtreme!, px);
      o.triggerPrice = o.triggerDirection === 2 ? o.trailingExtreme! - o.trailingDistance! : o.trailingExtreme! + o.trailingDistance!;
    }
  }

  private processSegment(symbol: string, from: number, to: number) {
    const dir: 1 | -1 = to >= from ? 1 : -1;
    let cur = from;
    for (let guard = 0; guard < 20000; guard++) {
      this.updateTrailing(symbol, cur);
      const ev = this.nextEvent(symbol, cur, to, dir);
      if (!ev) break;
      cur = ev.price;
      this.state.prices[symbol] = cur;
      this.handleEvent(symbol, ev);
    }
    this.state.prices[symbol] = to;
    this.updateTrailing(symbol, to);
  }

  private handleEvent(symbol: string, ev: PathEvent) {
    if (ev.kind === 'order') {
      const o = ev.order!;
      if (!this.state.orders[o.id]) return;
      if (o.status === 'Untriggered') {
        this.trigger(o, ev.price);
        // сработавший ордер мог не исполниться (лимит) — он останется в книге
        return;
      }
      this.executeOrder(this.state.accounts[o.accountId], o, o.price, true);
      return;
    }
    if (ev.kind === 'liqIso') {
      const pos = ev.position!;
      if (ev.account!.positions[pos.symbol] === pos && pos.size !== 0) this.liquidateIsolated(ev.account!, pos, ev.price);
      return;
    }
    if (ev.kind === 'liqCross') {
      const acc = ev.account!;
      const c = this.core(acc);
      if (c.crossEquity <= c.mm + 1e-9) this.liquidateCross(acc);
      else {
        // численная погрешность — сдвигаем цену на тик дальше
        const tick = getAsset(symbol).tickSize;
        const pos = acc.positions[symbol];
        if (pos) {
          const saved = this.state.prices[symbol];
          this.state.prices[symbol] = saved + (pos.size > 0 ? -tick : tick);
          const c2 = this.core(acc);
          if (c2.crossEquity <= c2.mm) this.liquidateCross(acc);
          else this.state.prices[symbol] = saved;
        }
      }
    }
  }

  private hasActivity(symbol: string): boolean {
    const set = this.bySymbol.get(symbol);
    if (set && set.size) return true;
    for (const acc of Object.values(this.state.accounts)) {
      const p = acc.positions[symbol];
      if (p && p.size !== 0) return true;
    }
    return false;
  }

  private processBar(symbol: string, i: number) {
    const s = this.market.series.get(symbol)!;
    const o = s.o[i];
    const h = s.h[i];
    const l = s.l[i];
    const c = s.c[i];
    const prev = this.state.prices[symbol] ?? o;
    if (!this.hasActivity(symbol)) {
      this.state.prices[symbol] = c;
      return;
    }
    let path: number[];
    if (this.config.intrabar === 'pessimistic') {
      // худший порядок для текущих позиций: сначала против позиции
      const net = Object.values(this.state.accounts).reduce((x, a) => x + (a.positions[symbol]?.size || 0), 0);
      path = net >= 0 ? [prev, o, l, h, c] : [prev, o, h, l, c];
    } else {
      path = c >= o ? [prev, o, l, h, c] : [prev, o, h, l, c];
    }
    for (let k = 1; k < path.length; k++) {
      if (path[k] === path[k - 1]) {
        this.state.prices[symbol] = path[k];
        continue;
      }
      this.processSegment(symbol, path[k - 1], path[k]);
    }
  }

  /* ───────────────────────── шаг симуляции ───────────────────────── */

  get totalBars() {
    return this.market.totalBars;
  }

  /** Обработать один базовый бар. Возвращает false, если сессия закончилась. */
  step(): boolean {
    const st = this.state;
    if (st.finished) return false;
    if (st.cursor >= this.market.totalBars) {
      st.finished = true;
      return false;
    }
    const t = this.market.timeAt(st.cursor);
    const tEnd = t + this.market.dt;
    this.inStep = true;
    this.barTime = t;
    try {
      const bars: [string, number][] = [];
      for (const sym of this.activeSymbols ?? this.market.symbols()) {
        const i = this.market.indexAt(sym, t);
        if (i >= 0) bars.push([sym, i]);
      }
      // funding
      if (this.config.fundingEnabled) {
        for (const [sym, i] of bars) {
          const open = this.market.series.get(sym)!.o[i];
          const pts = this.market.fundingIn(sym, t, tEnd);
          if (pts.length) for (const f of pts) this.applyFunding(sym, f.rate, open);
          else if (!this.market.funding.get(sym)?.length) {
            const step8 = 8 * HOUR;
            for (let ft = Math.ceil(t / step8) * step8; ft < tEnd; ft += step8) this.applyFunding(sym, this.config.defaultFundingRate, open);
          }
        }
      }
      // экспирация опционов по цене открытия бара
      if (this.hasOptionsExpiring(tEnd)) {
        for (const [sym, i] of bars) this.state.prices[sym] = this.market.series.get(sym)!.o[i];
        this.settleOptions(tEnd);
      }
      // движение цены
      for (const [sym, i] of bars) this.processBar(sym, i);
      // опционы: лимитные ордера и контроль маржи на закрытии
      this.matchOptionOrders();
      this.checkCrossAtClose();
      // боты
      for (const bot of Object.values(st.bots)) {
        if (bot.status === 'running' || bot.status === 'waiting') BOT_LOGIC[bot.type].onBar(this, bot as any);
      }
    } finally {
      this.inStep = false;
    }
    st.cursor++;
    st.now = tEnd;
    this.sampleEquity(false);
    if (st.cursor >= this.market.totalBars) st.finished = true;
    return !st.finished;
  }

  private hasOptionsExpiring(until: number) {
    for (const acc of Object.values(this.state.accounts))
      for (const p of Object.values(acc.positions)) if (p.category === 'option' && this.optionInstrument(p.symbol)!.expiry < until) return true;
    for (const o of Object.values(this.state.orders))
      if (o.category === 'option' && (this.optionInstrument(o.symbol)?.expiry ?? Infinity) < until) return true;
    return false;
  }

  private checkCrossAtClose() {
    for (const acc of Object.values(this.state.accounts)) {
      let any = false;
      for (const p of Object.values(acc.positions))
        if (p.category === 'option' ? p.size < 0 : p.marginMode === 'cross') {
          any = true;
          break;
        }
      if (!any) continue;
      const c = this.core(acc);
      if (c.mm > 0 && c.crossEquity <= c.mm) this.liquidateCross(acc);
    }
  }

  /** Перемотка вперёд до индекса бара (с полной обработкой событий). */
  runTo(cursor: number, budgetMs = Infinity): boolean {
    const t0 = performance.now();
    while (this.state.cursor < cursor && !this.state.finished) {
      this.step();
      if (performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  /* ───────────────────────── капитал и просадка ───────────────────────── */

  totalEquity() {
    let bots = 0;
    for (const b of Object.values(this.state.bots)) {
      if (b.status === 'stopped' || b.status === 'liquidated' || b.status === 'completed') continue;
      bots += this.equity(this.state.accounts[b.accountId]);
    }
    const main = this.equity(this.main);
    return { main, bots, total: main + bots };
  }

  private sampleEquity(force: boolean) {
    const st = this.state;
    const eq = this.totalEquity();
    const dd = st.dd;
    dd.peakMain = Math.max(dd.peakMain, eq.main);
    dd.peakTotal = Math.max(dd.peakTotal, eq.total);
    if (dd.peakMain > 0) dd.maxDdMain = Math.max(dd.maxDdMain, (dd.peakMain - eq.main) / dd.peakMain);
    if (dd.peakTotal > 0) dd.maxDdTotal = Math.max(dd.maxDdTotal, (dd.peakTotal - eq.total) / dd.peakTotal);
    const span = this.market.end - this.market.start;
    const every = Math.max(this.market.dt, Math.ceil(span / 20000 / this.market.dt) * this.market.dt);
    if (force || st.now - st.lastSample >= every) {
      const bench = this.config.symbols[0] ? this.price(this.config.symbols[0]) : 0;
      st.equity.push({ t: st.now, main: eq.main, bots: eq.bots, bench });
      st.lastSample = st.now;
      // мини-история для ботов
      for (const b of Object.values(st.bots)) {
        if (b.status !== 'running' && b.status !== 'waiting') continue;
        b.hist.push({ t: st.now, v: this.equity(st.accounts[b.accountId]) });
        if (b.hist.length > 600) b.hist = b.hist.filter((_, i) => i % 2 === 0);
      }
    }
  }

  /* ───────────────────────── боты ───────────────────────── */

  createBot<T extends BotType>(type: T, name: string, investment: number, params: BotParamsMap[T]): { bot?: AnyBot; error?: string } {
    const logic = BOT_LOGIC[type];
    if (!(investment > 0)) return { error: 'Укажите сумму инвестиций' };
    if (investment > this.available(this.main) + 1e-6) return { error: 'Недостаточно доступных средств на едином аккаунте' };
    const err = logic.validate(this, params as any, investment);
    if (err) return { error: err };
    const id = this.nextId('bot');
    const accId = `acc_${id}`;
    const acc = newAccount(accId, name, 'bot', 0, id);
    this.state.accounts[accId] = acc;
    this.main.walletBalance -= investment;
    acc.walletBalance = investment;
    acc.deposits = investment;
    const bot: AnyBot = {
      id,
      type,
      name,
      accountId: accId,
      status: 'waiting',
      symbols: [],
      investment,
      params: params as any,
      rt: {},
      stats: emptyBotStats(),
      createdTime: this.eventTime(),
      hist: [{ t: this.state.now, v: investment }],
    };
    this.state.bots[id] = bot;
    logic.start(this, bot as any);
    this.emit({ type: 'bot', botId: id, message: `Бот «${name}» создан`, level: 'info' });
    return { bot };
  }

  botAccount(bot: AnyBot) {
    return this.state.accounts[bot.accountId];
  }

  botSummary(bot: AnyBot) {
    const acc = this.botAccount(bot);
    const active = bot.status === 'running' || bot.status === 'waiting';
    const equity = active ? this.equity(acc) : bot.investment + (bot.finalPnl ?? 0);
    const pnl = equity - bot.investment;
    const days = Math.max(1 / 24, ((bot.stoppedTime ?? this.state.now) - (bot.startedTime ?? bot.createdTime)) / 86_400_000);
    return {
      equity,
      pnl,
      roi: pnl / bot.investment,
      apr: (pnl / bot.investment / days) * 365,
      gridProfit: bot.stats.gridProfit,
      floating: pnl - bot.stats.gridProfit,
      days,
    };
  }

  /** Остановить бота: отмена ордеров, закрытие позиций, возврат средств. */
  stopBot(id: string, reason = 'Остановлен пользователем', opts: { keepPositions?: boolean; liquidated?: boolean } = {}) {
    const bot = this.state.bots[id];
    if (!bot || bot.status === 'stopped' || bot.status === 'liquidated' || bot.status === 'completed') return;
    const acc = this.botAccount(bot);
    // статус меняем сразу, чтобы логика бота не реагировала на закрывающие сделки
    bot.status = opts.liquidated ? 'liquidated' : 'stopped';
    for (const o of this.activeOrders(acc.id)) this.cancelOrder(o.id, 'Бот остановлен');
    const sellSpot = bot.type === 'spotGrid' ? (bot.params as any).sellOnStop : bot.type === 'dca' ? false : true;
    if (!opts.keepPositions) {
      for (const pos of Object.values(acc.positions)) this.closePosition(acc.id, pos.symbol);
      if (sellSpot)
        for (const [coin, qty] of Object.entries(acc.spot)) {
          if (qty <= 0) continue;
          const sym = `${coin}USDT`;
          this.placeOrder({ accountId: acc.id, category: 'spot', symbol: sym, side: 'Sell', orderType: 'Market', qty, tag: `bot:${id}` });
        }
    }
    const equity = this.equity(acc);
    bot.finalPnl = equity - bot.investment;
    // возврат средств на основной аккаунт
    const main = this.main;
    main.walletBalance += acc.walletBalance;
    acc.walletBalance = 0;
    for (const [coin, qty] of Object.entries(acc.spot)) {
      main.spot[coin] = (main.spot[coin] || 0) + qty;
      main.spotCost[coin] = (main.spotCost[coin] || 0) + (acc.spotCost[coin] || 0);
    }
    acc.spot = {};
    acc.spotCost = {};
    // оставшиеся (keepPositions) позиции переносим на основной аккаунт
    for (const pos of Object.values(acc.positions)) {
      const existing = main.positions[pos.symbol];
      if (!existing) main.positions[pos.symbol] = { ...pos };
      else {
        this.emit({ type: 'info', message: `Позиция ${pos.symbol} бота закрыта: на основном аккаунте уже есть позиция` });
        this.closePosition(acc.id, pos.symbol);
        main.walletBalance += acc.walletBalance;
        acc.walletBalance = 0;
      }
    }
    acc.positions = {};
    bot.stopReason = reason;
    bot.stoppedTime = this.eventTime();
    this.emit({
      type: 'bot',
      botId: id,
      message: `Бот «${bot.name}» остановлен: ${reason}. PnL ${bot.finalPnl >= 0 ? '+' : ''}${bot.finalPnl.toFixed(2)} USDT`,
      level: opts.liquidated ? 'error' : 'info',
    });
  }

  botLog(bot: AnyBot, message: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.emit({ type: 'bot', botId: bot.id, message: `${bot.name}: ${message}`, level });
  }

  /* ───────────────────────── сериализация ───────────────────────── */

  serialize(): string {
    return JSON.stringify(this.state);
  }

  static restore(json: string | ExchangeState, market: MarketData): Exchange {
    const state: ExchangeState = typeof json === 'string' ? JSON.parse(json) : json;
    const ex = new Exchange(market, state);
    ex.syncPrices();
    return ex;
  }

  isOption(symbol: string) {
    return isOptionSymbol(symbol);
  }
}
