import { create } from 'zustand';

export type DrawTool = 'cursor' | 'trend' | 'ray' | 'hline' | 'vline' | 'rect' | 'fib' | 'measure' | 'text';

export interface DPoint {
  t: number;
  p: number;
}

export interface Drawing {
  id: string;
  type: Exclude<DrawTool, 'cursor'>;
  a: DPoint;
  b: DPoint;
  color: string;
  text?: string;
}

const KEY = 'bt-drawings-v1';

function load(): Record<string, Drawing[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

interface DrawState {
  tool: DrawTool;
  magnet: boolean;
  color: string;
  bySymbol: Record<string, Drawing[]>;
  selected: string | null;
  setTool: (t: DrawTool) => void;
  setMagnet: (m: boolean) => void;
  setColor: (c: string) => void;
  select: (id: string | null) => void;
  add: (symbol: string, d: Drawing) => void;
  update: (symbol: string, id: string, patch: Partial<Drawing>) => void;
  remove: (symbol: string, id: string) => void;
  clear: (symbol: string) => void;
}

function persist(bySymbol: Record<string, Drawing[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(bySymbol));
  } catch {
    /* ignore */
  }
}

export const useDrawings = create<DrawState>((set, get) => ({
  tool: 'cursor',
  magnet: false,
  color: '#f7a600',
  bySymbol: load(),
  selected: null,
  setTool: (tool) => set({ tool, selected: null }),
  setMagnet: (magnet) => set({ magnet }),
  setColor: (color) => {
    set({ color });
    const { selected } = get();
    if (selected) {
      const bySymbol = { ...get().bySymbol };
      for (const s of Object.keys(bySymbol)) bySymbol[s] = bySymbol[s].map((d) => (d.id === selected ? { ...d, color } : d));
      persist(bySymbol);
      set({ bySymbol });
    }
  },
  select: (selected) => set({ selected }),
  add: (symbol, d) => {
    const bySymbol = { ...get().bySymbol, [symbol]: [...(get().bySymbol[symbol] || []), d] };
    persist(bySymbol);
    set({ bySymbol });
  },
  update: (symbol, id, patch) => {
    const bySymbol = { ...get().bySymbol, [symbol]: (get().bySymbol[symbol] || []).map((d) => (d.id === id ? { ...d, ...patch } : d)) };
    persist(bySymbol);
    set({ bySymbol });
  },
  remove: (symbol, id) => {
    const bySymbol = { ...get().bySymbol, [symbol]: (get().bySymbol[symbol] || []).filter((d) => d.id !== id) };
    persist(bySymbol);
    set({ bySymbol, selected: null });
  },
  clear: (symbol) => {
    const bySymbol = { ...get().bySymbol, [symbol]: [] };
    persist(bySymbol);
    set({ bySymbol, selected: null });
  },
}));
