/**
 * Каталог инструментов. Обязательно включает ВСЕ базовые активы опционов Bybit
 * (по состоянию на сентябрь 2026):
 *  - крипто-опционы: BTC, ETH, SOL, XRP, DOGE, MNT, HYPE;
 *  - Perp Options (опционы на TradFi-перпетуалы): SPCX, NVDA, TSLA, QQQ, SOXL, MU, SKHY, SNDK.
 * Спецификации (тик, шаг лота, макс. плечо) — ориентировочные; при доступности API Bybit
 * они уточняются в рантайме (см. syncInstrumentsFromBybit в providers/bybit.ts).
 */

export type AssetGroup = 'crypto' | 'tradfi';

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
}

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
