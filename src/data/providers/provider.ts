import type { Candle, FundingPoint, IntervalKey, ProviderId } from '../types';

export interface FetchOpts {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Свечи; partial — часть файлов не загрузилась (кэшировать как полный кусок нельзя). */
export type Klines = Candle[] & { partial?: number };

export interface DataProvider {
  id: ProviderId;
  label: string;
  /** Свечи USDT-перпетуала за [start, end) (мс). Порядок не важен — загрузчик сортирует. */
  fetchKlines(symbol: string, interval: IntervalKey, start: number, end: number, opts?: FetchOpts): Promise<Klines>;
  /** История ставок финансирования за [start, end]. */
  fetchFunding?(symbol: string, start: number, end: number, opts?: FetchOpts): Promise<FundingPoint[]>;
}
