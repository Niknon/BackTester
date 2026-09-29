import type { Candle, FundingPoint, IntervalKey, ProviderId } from '../types';

export interface FetchOpts {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface DataProvider {
  id: ProviderId;
  label: string;
  /** Свечи USDT-перпетуала за [start, end) (мс). Порядок не важен — загрузчик сортирует. */
  fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts?: FetchOpts): Promise<Candle[]>;
  /** История ставок финансирования за [start, end]. */
  fetchFunding?(symbol: string, start: number, end: number, opts?: FetchOpts): Promise<FundingPoint[]>;
}
