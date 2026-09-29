import { create } from 'zustand';
import type { IntervalKey } from '../data/types';
import type { Exchange } from '../engine/exchange';

export type Page = 'setup' | 'markets' | 'trade' | 'spot' | 'options' | 'bots' | 'lab' | 'assets' | 'analytics';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error' | 'buy' | 'sell';
  title: string;
  text?: string;
}

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  params: number[];
  color?: string;
  enabled: boolean;
}

export type IndicatorType =
  | 'MA'
  | 'EMA'
  | 'BOLL'
  | 'VWAP'
  | 'SUPERTREND'
  | 'DONCHIAN'
  | 'VOL'
  | 'RSI'
  | 'MACD'
  | 'STOCH'
  | 'ATR'
  | 'CCI'
  | 'OBV'
  | 'ADX';

export interface Prefs {
  pauseOnFill: boolean;
  pauseOnLiquidation: boolean;
  showExecutions: boolean;
  showOrders: boolean;
  showBotGrids: boolean;
  showBotTrades: boolean;
  chartType: 'candles' | 'bars' | 'line' | 'heikin';
  indicators: IndicatorConfig[];
  speed: number;
  autosave: boolean;
}

export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'vol', type: 'VOL', params: [], enabled: true },
  { id: 'ma1', type: 'MA', params: [7], color: '#f7a600', enabled: true },
  { id: 'ma2', type: 'MA', params: [25], color: '#e056fd', enabled: true },
  { id: 'ma3', type: 'MA', params: [99], color: '#4d8dff', enabled: true },
  { id: 'ema', type: 'EMA', params: [21], color: '#22d3ee', enabled: false },
  { id: 'boll', type: 'BOLL', params: [20, 2], color: '#a78bfa', enabled: false },
  { id: 'vwap', type: 'VWAP', params: [], color: '#fbbf24', enabled: false },
  { id: 'st', type: 'SUPERTREND', params: [10, 3], enabled: false },
  { id: 'dc', type: 'DONCHIAN', params: [20], color: '#38bdf8', enabled: false },
  { id: 'rsi', type: 'RSI', params: [14], color: '#a78bfa', enabled: false },
  { id: 'macd', type: 'MACD', params: [12, 26, 9], enabled: false },
  { id: 'stoch', type: 'STOCH', params: [14, 3, 3], enabled: false },
  { id: 'atr', type: 'ATR', params: [14], color: '#f472b6', enabled: false },
  { id: 'cci', type: 'CCI', params: [20], color: '#34d399', enabled: false },
  { id: 'obv', type: 'OBV', params: [], color: '#60a5fa', enabled: false },
  { id: 'adx', type: 'ADX', params: [14], color: '#fb923c', enabled: false },
];

const PREFS_KEY = 'bt-prefs-v1';

function loadPrefs(): Prefs {
  const def: Prefs = {
    pauseOnFill: false,
    pauseOnLiquidation: true,
    showExecutions: true,
    showOrders: true,
    showBotGrids: true,
    showBotTrades: false,
    chartType: 'candles',
    indicators: DEFAULT_INDICATORS,
    speed: 20,
    autosave: true,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw);
    // новые индикаторы из дефолтов добавляем к сохранённым
    const ids = new Set((p.indicators || []).map((i: IndicatorConfig) => i.id));
    const indicators = [...(p.indicators || []), ...DEFAULT_INDICATORS.filter((i) => !ids.has(i.id))];
    return { ...def, ...p, indicators };
  } catch {
    return def;
  }
}

export interface LoadProgressState {
  title: string;
  message: string;
  done: number;
  total: number;
  errors: string[];
}

interface SessionState {
  status: 'setup' | 'loading' | 'ready';
  progress: LoadProgressState | null;
  ex: Exchange | null;
  /** счётчик версий состояния симуляции (перерисовка UI) */
  v: number;
  playing: boolean;
  speed: number;
  page: Page;
  symbol: string;
  chartTf: IntervalKey;
  optionBase: string;
  toasts: Toast[];
  prefs: Prefs;
  savedAt: number | null;
  /** символы, которые догружаются прямо сейчас */
  loadingSymbols: string[];
  set: (p: Partial<SessionState>) => void;
  setPrefs: (p: Partial<Prefs>) => void;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'setup',
  progress: null,
  ex: null,
  v: 0,
  playing: false,
  speed: loadPrefs().speed,
  page: 'setup',
  symbol: 'BTCUSDT',
  chartTf: '1h',
  optionBase: 'BTC',
  toasts: [],
  prefs: loadPrefs(),
  savedAt: null,
  loadingSymbols: [],
  set: (p) => set(p),
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
    set({ prefs });
  },
}));

let lastBump = 0;
/** Сообщить UI об изменении состояния симуляции. force — без троттлинга. */
export function bump(force = false) {
  const now = performance.now();
  if (!force && now - lastBump < 45) return;
  lastBump = now;
  useSession.setState((s) => ({ v: s.v + 1 }));
}

let toastId = 0;
export function toast(kind: Toast['kind'], title: string, text?: string, ttl = 4500) {
  const id = ++toastId;
  useSession.setState((s) => ({ toasts: [...s.toasts.slice(-5), { id, kind, title, text }] }));
  setTimeout(() => useSession.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttl);
}

export function useEx(): Exchange {
  const ex = useSession((s) => s.ex);
  if (!ex) throw new Error('Сессия не запущена');
  return ex;
}

/** Подписка на версию симуляции (компонент перерисуется при изменениях). */
export function useTick() {
  return useSession((s) => s.v);
}
