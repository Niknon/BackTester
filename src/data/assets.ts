/**
 * Каталог инструментов. Обязательно включает ВСЕ базовые активы опционов Bybit
 * (по состоянию на сентябрь 2026):
 *  - крипто-опционы: BTC, ETH, SOL, XRP, DOGE, MNT, HYPE;
 *  - Perp Options (опционы на TradFi-перпетуалы): SPCX, NVDA, TSLA, QQQ, SOXL, MU, SKHY, SNDK.
 * Плюс TradFi-раздел спота Bybit: токенизированные акции/ETF xStocks (AAPLX, TSLAX, NVDAX…)
 * и токены золота (XAUT, PAXG) — торгуются только на споте.
 * Спецификации (тик, шаг лота, макс. плечо) — ориентировочные; при доступности API Bybit
 * они уточняются в рантайме (см. syncInstrumentsFromBybit в providers/bybit.ts).
 */

/**
 * crypto — крипто-перпетуалы (и спот);
 * tradfi — TradFi USDT-перпетуалы Bybit на акции/ETF;
 * xstock — токенизированные акции xStocks (только спот, 24/7);
 * commodity — токены золота (только спот).
 */
export type AssetGroup = 'crypto' | 'tradfi' | 'xstock' | 'commodity';

export const GROUP_LABEL: Record<AssetGroup, string> = {
  crypto: 'Крипто',
  tradfi: 'TradFi-перпетуалы',
  xstock: 'xStocks',
  commodity: 'Золото',
};

export interface AssetSpec {
  symbol: string; // тикер USDT-перпетуала Bybit, напр. BTCUSDT
  base: string; // базовая монета, напр. BTC
  name: string;
  group: AssetGroup;
  /** есть ли опционы на Bybit с этим базовым активом */
  hasOptions: boolean;
  tickSize: number;
  qtyStep: number;
  minQty: number;
  maxLeverage: number;
  /** стартовая цена для синтетических данных */
  refPrice: number;
  /** годовая волатильность для синтетических данных */
  refVol: number;
  okx?: string | null; // instId на OKX (фолбэк-источник)
  /** множитель цены OKX → Bybit (напр. PEPE → 1000PEPE) */
  okxMult?: number;
  binance?: string | null;
  /** дата листинга на Bybit (приблизительно), мс */
  listed?: number;
  /** торгуется только на споте (нет USDT-перпетуала) */
  spotOnly?: boolean;
  /** категория Bybit API для свечей (по умолчанию linear) */
  bybitCategory?: 'linear' | 'spot';
  /** тикер базового актива на фондовом рынке (для xStocks) */
  underlying?: string;
  /** подраздел TradFi: акции, ETF, индексы, сырьё */
  sector?: 'stock' | 'etf' | 'index' | 'commodity';
  /** синтетика: в выходные рынок закрыт (цена почти не двигается) */
  calmWeekends?: boolean;
}

export const SECTOR_LABEL: Record<NonNullable<AssetSpec['sector']>, string> = {
  stock: 'Акции',
  etf: 'ETF',
  index: 'Индексы',
  commodity: 'Сырьё: металлы, нефть, газ',
};

const C = (
  base: string,
  name: string,
  hasOptions: boolean,
  tickSize: number,
  qtyStep: number,
  maxLeverage: number,
  refPrice: number,
  refVol: number,
  extra: Partial<AssetSpec> = {},
): AssetSpec => ({
  symbol: `${base}USDT`,
  base,
  name,
  group: 'crypto',
  hasOptions,
  tickSize,
  qtyStep,
  minQty: qtyStep,
  maxLeverage,
  refPrice,
  refVol,
  okx: `${base}-USDT-SWAP`,
  binance: `${base}USDT`,
  ...extra,
});

const T = (
  base: string,
  name: string,
  tickSize: number,
  maxLeverage: number,
  refPrice: number,
  refVol: number,
): AssetSpec => ({
  symbol: `${base}USDT`,
  base,
  name,
  group: 'tradfi',
  hasOptions: true,
  tickSize,
  qtyStep: 0.01,
  minQty: 0.01,
  maxLeverage,
  refPrice,
  refVol,
  okx: `${base}-USDT-SWAP`,
  binance: null,
});

/** TradFi USDT-перпетуал Bybit (фьючерс с плечом на акцию, ETF, индекс или сырьё); фолбэк — тот же перпетуал OKX. */
const TF = (
  base: string,
  name: string,
  sector: NonNullable<AssetSpec['sector']>,
  maxLeverage: number,
  refPrice: number,
  refVol: number,
  extra: Partial<AssetSpec> = {},
): AssetSpec => ({
  symbol: `${base}USDT`,
  base,
  name,
  group: 'tradfi',
  hasOptions: false,
  tickSize: refPrice >= 1000 ? 0.1 : refPrice >= 10 ? 0.01 : 0.0001,
  qtyStep: refPrice >= 1000 ? 0.001 : refPrice >= 10 ? 0.01 : 1,
  minQty: refPrice >= 1000 ? 0.001 : refPrice >= 10 ? 0.01 : 1,
  maxLeverage,
  refPrice,
  refVol,
  okx: `${base}-USDT-SWAP`,
  binance: null,
  sector,
  calmWeekends: true,
  ...extra,
});

/**
 * xStock: токенизированная акция/ETF (Backed Finance) на споте Bybit, пара `${TICKER}XUSDT`.
 * Фолбэк-источник цены — USDT-перпетуал на ту же акцию на OKX (листинг с ~марта 2026).
 */
const X = (ticker: string, name: string, refPrice: number, refVol: number, okx: string | null = `${ticker}-USDT-SWAP`): AssetSpec => ({
  symbol: `${ticker}XUSDT`,
  base: `${ticker}X`,
  name,
  group: 'xstock',
  hasOptions: false,
  tickSize: 0.01,
  qtyStep: 0.001,
  minQty: 0.001,
  maxLeverage: 1,
  refPrice,
  refVol,
  okx,
  binance: null,
  spotOnly: true,
  bybitCategory: 'spot',
  underlying: ticker,
});

/** Токен золота на споте (1 токен ≈ 1 тройская унция). */
const G = (base: string, name: string, okx: string): AssetSpec => ({
  symbol: `${base}USDT`,
  base,
  name,
  group: 'commodity',
  hasOptions: false,
  tickSize: 0.1,
  qtyStep: 0.0001,
  minQty: 0.0001,
  maxLeverage: 1,
  refPrice: 4180,
  refVol: 0.18,
  okx,
  binance: null,
  spotOnly: true,
  bybitCategory: 'spot',
});

export const ASSETS: AssetSpec[] = [
  // ── Базовые активы опционов Bybit (крипто) ──
  C('BTC', 'Bitcoin', true, 0.1, 0.001, 100, 83000, 0.5),
  C('ETH', 'Ethereum', true, 0.01, 0.01, 100, 2700, 0.65),
  C('SOL', 'Solana', true, 0.01, 0.1, 100, 120, 0.8),
  C('XRP', 'XRP', true, 0.0001, 1, 75, 1.5, 0.8),
  C('DOGE', 'Dogecoin', true, 0.00001, 1, 75, 0.094, 0.9),
  C('MNT', 'Mantle', true, 0.0001, 1, 50, 1.1, 0.9, { okx: null, binance: null }),
  C('HYPE', 'Hyperliquid', true, 0.001, 0.01, 50, 86, 0.95),
  // ── Базовые активы Perp Options Bybit (TradFi-перпетуалы на акции/ETF) ──
  T('NVDA', 'NVIDIA', 0.01, 50, 228, 0.45),
  T('TSLA', 'Tesla', 0.01, 25, 355, 0.6),
  T('QQQ', 'Invesco QQQ (Nasdaq-100)', 0.01, 50, 740, 0.2),
  T('SPCX', 'SpaceX', 0.01, 50, 150, 0.6),
  T('SOXL', 'Direxion Semi Bull 3X', 0.01, 20, 148, 0.9),
  T('MU', 'Micron Technology', 0.01, 50, 1070, 0.55),
  T('SKHY', 'SK Hynix', 0.01, 50, 187, 0.55),
  T('SNDK', 'SanDisk', 0.1, 50, 1730, 0.65),
  // ── TradFi-перпетуалы Bybit: акции ──
  TF('AAPL', 'Apple', 'stock', 25, 330, 0.3),
  TF('MSFT', 'Microsoft', 'stock', 20, 516, 0.28),
  TF('GOOGL', 'Alphabet', 'stock', 50, 339, 0.32),
  TF('AMZN', 'Amazon', 'stock', 20, 249, 0.35),
  TF('META', 'Meta Platforms', 'stock', 20, 727, 0.38),
  TF('NFLX', 'Netflix', 'stock', 20, 68, 0.4),
  TF('AMD', 'AMD', 'stock', 25, 618, 0.55),
  TF('AVGO', 'Broadcom', 'stock', 20, 346, 0.45),
  TF('TSM', 'TSMC', 'stock', 20, 459, 0.4),
  TF('ASML', 'ASML', 'stock', 20, 1813, 0.4),
  TF('ARM', 'Arm Holdings', 'stock', 20, 294, 0.6),
  TF('MRVL', 'Marvell', 'stock', 50, 268, 0.6),
  TF('SMCI', 'Super Micro Computer', 'stock', 20, 42, 0.8),
  TF('INTC', 'Intel', 'stock', 25, 120, 0.5),
  TF('ORCL', 'Oracle', 'stock', 20, 138, 0.45),
  TF('PLTR', 'Palantir', 'stock', 20, 191, 0.65),
  TF('CRM', 'Salesforce', 'stock', 10, 237, 0.35),
  TF('ADBE', 'Adobe', 'stock', 20, 242, 0.35),
  TF('CSCO', 'Cisco', 'stock', 20, 109, 0.25),
  TF('IBM', 'IBM', 'stock', 20, 226, 0.28),
  TF('SHOP', 'Shopify', 'stock', 10, 149, 0.55),
  TF('COIN', 'Coinbase', 'stock', 20, 190, 0.7),
  TF('HOOD', 'Robinhood', 'stock', 20, 112, 0.75),
  TF('MSTR', 'Strategy (MicroStrategy)', 'stock', 50, 161, 0.8),
  TF('CRCL', 'Circle', 'stock', 50, 83, 0.9),
  TF('MARA', 'MARA Holdings', 'stock', 10, 11.2, 0.9),
  TF('RIVN', 'Rivian', 'stock', 20, 14.8, 0.7),
  TF('BRKB', 'Berkshire Hathaway B', 'stock', 20, 502, 0.2),
  TF('LLY', 'Eli Lilly', 'stock', 20, 1156, 0.35),
  TF('UNH', 'UnitedHealth', 'stock', 20, 366, 0.35),
  TF('JNJ', 'Johnson & Johnson', 'stock', 10, 258, 0.18),
  TF('MRK', 'Merck', 'stock', 10, 144, 0.25),
  TF('KO', 'Coca-Cola', 'stock', 20, 86, 0.15),
  TF('WMT', 'Walmart', 'stock', 10, 105, 0.2),
  TF('XOM', 'Exxon Mobil', 'stock', 10, 164, 0.25),
  TF('GME', 'GameStop', 'stock', 20, 24, 0.8),
  // ── TradFi-перпетуалы: ETF и индексы ──
  TF('SPY', 'SPDR S&P 500 ETF', 'etf', 50, 765, 0.16),
  TF('IWM', 'iShares Russell 2000', 'etf', 20, 279, 0.22),
  TF('TQQQ', 'ProShares UltraPro QQQ (3x)', 'etf', 10, 79, 0.6),
  TF('SQQQ', 'ProShares UltraPro Short QQQ (−3x)', 'etf', 20, 34, 0.6),
  TF('XLE', 'Energy Select Sector SPDR', 'etf', 20, 63, 0.25),
  TF('XBI', 'SPDR S&P Biotech', 'etf', 20, 155, 0.35),
  TF('USO', 'United States Oil Fund', 'etf', 20, 150, 0.35),
  TF('US500', 'Индекс S&P 500', 'index', 20, 7673, 0.16),
  TF('US100', 'Индекс Nasdaq-100', 'index', 20, 30557, 0.2),
  // ── TradFi-перпетуалы: сырьё ──
  TF('XAU', 'Золото (унция)', 'commodity', 100, 4179, 0.18),
  TF('XAG', 'Серебро (унция)', 'commodity', 50, 61, 0.3),
  TF('XPT', 'Платина (унция)', 'commodity', 50, 1721, 0.3),
  TF('XPD', 'Палладий (унция)', 'commodity', 50, 1187, 0.35),
  TF('XCU', 'Медь (фунт)', 'commodity', 50, 6.59, 0.25, { tickSize: 0.0001, qtyStep: 0.1, minQty: 0.1 }),
  TF('CL', 'Нефть WTI (баррель)', 'commodity', 50, 92.8, 0.35),
  TF('NG', 'Природный газ (MMBtu)', 'commodity', 50, 2.95, 0.6, { tickSize: 0.001, qtyStep: 1, minQty: 1 }),
  // ── Популярные USDT-перпетуалы ──
  C('BNB', 'BNB', false, 0.1, 0.01, 75, 760, 0.45),
  C('ADA', 'Cardano', false, 0.0001, 1, 75, 0.245, 0.8),
  C('AVAX', 'Avalanche', false, 0.001, 0.1, 50, 11.5, 0.85),
  C('LINK', 'Chainlink', false, 0.001, 0.1, 50, 14.7, 0.8),
  C('TON', 'Toncoin', false, 0.0001, 0.1, 50, 3.0, 0.75, { okx: null }),
  C('SUI', 'Sui', false, 0.0001, 1, 50, 1.15, 0.95),
  C('LTC', 'Litecoin', false, 0.01, 0.1, 50, 67, 0.7),
  C('DOT', 'Polkadot', false, 0.0001, 0.1, 50, 1.2, 0.8),
  C('TRX', 'TRON', false, 0.00001, 1, 50, 0.335, 0.5),
  C('NEAR', 'NEAR', false, 0.001, 0.1, 50, 4.95, 0.9),
  C('APT', 'Aptos', false, 0.0001, 0.1, 50, 0.8, 0.95),
  C('ARB', 'Arbitrum', false, 0.00001, 1, 50, 0.207, 0.95),
  C('OP', 'Optimism', false, 0.00001, 1, 50, 0.13, 0.95),
  C('BCH', 'Bitcoin Cash', false, 0.1, 0.01, 50, 309, 0.7),
  C('UNI', 'Uniswap', false, 0.001, 0.1, 50, 8.95, 0.85),
  C('AAVE', 'Aave', false, 0.01, 0.01, 50, 166, 0.85),
  C('ENA', 'Ethena', false, 0.00001, 1, 50, 0.25, 1.0),
  C('WIF', 'dogwifhat', false, 0.0001, 1, 50, 0.243, 1.2),
  C('ONDO', 'Ondo', false, 0.0001, 1, 50, 0.506, 1.0),
  C('TAO', 'Bittensor', false, 0.1, 0.01, 50, 302, 1.0),
  C('1000PEPE', 'Pepe (×1000)', false, 0.0000001, 100, 50, 0.004273, 1.2, {
    okx: 'PEPE-USDT-SWAP',
    okxMult: 1000,
    binance: '1000PEPEUSDT',
  }),
  // ── TradFi на споте: токенизированные акции и ETF (xStocks) ──
  X('AAPL', 'Apple', 330, 0.3),
  X('MSFT', 'Microsoft', 516, 0.28),
  X('NVDA', 'NVIDIA', 232, 0.45),
  X('GOOGL', 'Alphabet', 339, 0.32),
  X('AMZN', 'Amazon', 249, 0.35),
  X('META', 'Meta Platforms', 727, 0.38),
  X('TSLA', 'Tesla', 358, 0.6),
  X('NFLX', 'Netflix', 68, 0.4),
  X('AMD', 'AMD', 618, 0.55),
  X('AVGO', 'Broadcom', 346, 0.45),
  X('ORCL', 'Oracle', 138, 0.45),
  X('PLTR', 'Palantir', 191, 0.65),
  X('COIN', 'Coinbase', 190, 0.7),
  X('HOOD', 'Robinhood', 112, 0.75),
  X('MSTR', 'Strategy (MicroStrategy)', 161, 0.8),
  X('CRCL', 'Circle', 83, 0.9),
  X('INTC', 'Intel', 120, 0.5),
  X('MRVL', 'Marvell', 268, 0.6),
  X('CRM', 'Salesforce', 237, 0.35),
  X('ADBE', 'Adobe', 242, 0.35),
  X('CSCO', 'Cisco', 109, 0.25),
  X('IBM', 'IBM', 226, 0.28),
  X('LLY', 'Eli Lilly', 1156, 0.35),
  X('UNH', 'UnitedHealth', 366, 0.35),
  X('JNJ', 'Johnson & Johnson', 258, 0.18),
  X('MRK', 'Merck', 144, 0.25),
  X('KO', 'Coca-Cola', 86, 0.15),
  X('WMT', 'Walmart', 105, 0.2),
  X('XOM', 'Exxon Mobil', 164, 0.25),
  X('GME', 'GameStop', 24, 0.8),
  X('MCD', "McDonald's", 300, 0.18, null),
  X('JPM', 'JPMorgan Chase', 300, 0.22, null),
  X('SPY', 'SPDR S&P 500 ETF', 765, 0.16),
  X('QQQ', 'Invesco QQQ (Nasdaq-100)', 744, 0.2),
  X('IWM', 'iShares Russell 2000 ETF', 279, 0.22),
  X('TQQQ', 'ProShares UltraPro QQQ (3x)', 79, 0.6),
  X('GLD', 'SPDR Gold Shares', 385, 0.18, null),
  // ── Токены золота (спот) ──
  G('XAUT', 'Tether Gold', 'XAUT-USDT'),
  G('PAXG', 'PAX Gold', 'PAXG-USDT'),
];

/** Базовые активы опционов Bybit — обязательный список. */
export const BYBIT_OPTION_BASES = ASSETS.filter((a) => a.hasOptions).map((a) => a.base);

const BY_SYMBOL = new Map<string, AssetSpec>(ASSETS.map((a) => [a.symbol, a]));

/** Пользовательские/уточнённые спецификации (добавляются в рантайме). */
export function registerAsset(spec: AssetSpec) {
  const i = ASSETS.findIndex((a) => a.symbol === spec.symbol);
  if (i >= 0) ASSETS[i] = { ...ASSETS[i], ...spec };
  else ASSETS.push(spec);
  BY_SYMBOL.set(spec.symbol, i >= 0 ? ASSETS[i] : spec);
}

/** Спецификация вне курируемого списка (синхронизирована с биржей) — не показывается в пикере. */
export function registerExtra(spec: AssetSpec) {
  if (!BY_SYMBOL.has(spec.symbol)) BY_SYMBOL.set(spec.symbol, spec);
  else Object.assign(BY_SYMBOL.get(spec.symbol)!, spec);
}

export function updateAssetSpec(symbol: string, patch: Partial<AssetSpec>) {
  const a = BY_SYMBOL.get(symbol);
  if (a) Object.assign(a, patch);
}

export function getAsset(symbol: string): AssetSpec {
  const a = BY_SYMBOL.get(symbol);
  if (a) return a;
  // неизвестный символ: делаем разумные дефолты
  const base = symbol.replace(/USDT$/, '');
  const spec: AssetSpec = {
    symbol,
    base,
    name: base,
    group: 'crypto',
    hasOptions: false,
    tickSize: 0.0001,
    qtyStep: 0.001,
    minQty: 0.001,
    maxLeverage: 50,
    refPrice: 1,
    refVol: 0.8,
    okx: `${base}-USDT-SWAP`,
    binance: symbol,
  };
  BY_SYMBOL.set(symbol, spec);
  return spec;
}

export function hasAsset(symbol: string) {
  return BY_SYMBOL.has(symbol);
}

/** Есть ли у инструмента USDT-перпетуал (деривативы, фьючерсные боты, опционы). */
export function isPerp(symbol: string) {
  return !getAsset(symbol).spotOnly;
}

/** Подпись типа инструмента для UI. */
export function kindLabel(spec: AssetSpec) {
  if (spec.group === 'xstock') return 'Токенизированная акция · спот';
  if (spec.group === 'commodity') return 'Токен золота · спот';
  if (spec.group === 'tradfi') return spec.sector ? `TradFi перпетуал · ${SECTOR_LABEL[spec.sector].split(':')[0]}` : 'TradFi перпетуал';
  return 'USDT-перпетуал';
}

/** Шаг количества для спота (на Bybit он значительно мельче, чем у перпетуалов). */
export function spotQtyStep(symbol: string): number {
  const a = getAsset(symbol);
  const step = 10 ** Math.floor(Math.log10(5 / Math.max(1e-12, a.refPrice)));
  return Math.min(a.qtyStep, Number(step.toPrecision(1)));
}

export function qtyStepFor(symbol: string, category: 'linear' | 'spot'): number {
  return category === 'spot' ? spotQtyStep(symbol) : getAsset(symbol).qtyStep;
}

/** Ставка поддерживающей маржи первого тира риска (как у Bybit: MMR = IMRmin / 2). */
export function maintenanceMarginRate(symbol: string): number {
  return 0.5 / getAsset(symbol).maxLeverage;
}

export function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return (s.split('.')[1] || '').length;
}

export function roundToStep(value: number, step: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
  if (!step) return value;
  const k = value / step;
  const r = mode === 'floor' ? Math.floor(k + 1e-9) : mode === 'ceil' ? Math.ceil(k - 1e-9) : Math.round(k);
  const d = decimalsOf(step);
  return Number((r * step).toFixed(d));
}
