import * as ind from '../../indicators';
import type { Ohlcv } from '../../engine/aggregate';
import type { IndicatorConfig, IndicatorType } from '../../store/session';

export interface IndSeries {
  key: string;
  kind: 'line' | 'hist';
  pane: 'main' | 'sub';
  color: string;
  values: number[];
  /** цвета точек (гистограмма / supertrend) */
  colors?: string[];
  lineWidth?: 1 | 2 | 3;
  /** своя шкала цены (объём) */
  priceScaleId?: string;
  /** уровни (RSI 30/70 …) */
  levels?: number[];
  title?: string;
}

export const IND_META: Record<IndicatorType, { label: string; pane: 'main' | 'sub'; params: string[] }> = {
  MA: { label: 'MA', pane: 'main', params: ['Период'] },
  EMA: { label: 'EMA', pane: 'main', params: ['Период'] },
  BOLL: { label: 'Bollinger', pane: 'main', params: ['Период', 'Множ.'] },
  VWAP: { label: 'VWAP', pane: 'main', params: [] },
  SUPERTREND: { label: 'SuperTrend', pane: 'main', params: ['ATR', 'Множ.'] },
  DONCHIAN: { label: 'Donchian', pane: 'main', params: ['Период'] },
  VOL: { label: 'Объём', pane: 'main', params: [] },
  RSI: { label: 'RSI', pane: 'sub', params: ['Период'] },
  MACD: { label: 'MACD', pane: 'sub', params: ['Быстрая', 'Медленная', 'Сигнал'] },
  STOCH: { label: 'Stoch', pane: 'sub', params: ['%K', '%D', 'Сглаж.'] },
  ATR: { label: 'ATR', pane: 'sub', params: ['Период'] },
  CCI: { label: 'CCI', pane: 'sub', params: ['Период'] },
  OBV: { label: 'OBV', pane: 'sub', params: [] },
  ADX: { label: 'ADX/DMI', pane: 'sub', params: ['Период'] },
};

const UP = 'rgba(32,178,108,0.45)';
const DOWN = 'rgba(239,69,74,0.45)';

export function indicatorLabel(c: IndicatorConfig) {
  return `${IND_META[c.type].label}${c.params.length ? ` (${c.params.join(', ')})` : ''}`;
}

export function computeIndicator(c: IndicatorConfig, d: Ohlcv): IndSeries[] {
  const p = c.params;
  const col = c.color ?? '#f7a600';
  const k = c.id;
  switch (c.type) {
    case 'MA':
      return [{ key: k, kind: 'line', pane: 'main', color: col, values: ind.sma(d.c, p[0] || 20), title: `MA${p[0]}` }];
    case 'EMA':
      return [{ key: k, kind: 'line', pane: 'main', color: col, values: ind.ema(d.c, p[0] || 20), title: `EMA${p[0]}` }];
    case 'BOLL': {
      const b = ind.bollinger(d.c, p[0] || 20, p[1] || 2);
      return [
        { key: k + 'u', kind: 'line', pane: 'main', color: col, values: b.upper },
        { key: k + 'm', kind: 'line', pane: 'main', color: '#f7a600', values: b.middle },
        { key: k + 'l', kind: 'line', pane: 'main', color: col, values: b.lower },
      ];
    }
    case 'VWAP':
      return [{ key: k, kind: 'line', pane: 'main', color: col, values: ind.vwap(d.t, d.h, d.l, d.c, d.v), title: 'VWAP' }];
    case 'SUPERTREND': {
      const st = ind.supertrend(d.h, d.l, d.c, p[0] || 10, p[1] || 3);
      return [
        {
          key: k,
          kind: 'line',
          pane: 'main',
          color: '#20b26c',
          values: st.value,
          colors: st.dir.map((x) => (x > 0 ? '#20b26c' : '#ef454a')),
          lineWidth: 2,
        },
      ];
    }
    case 'DONCHIAN': {
      const dc = ind.donchian(d.h, d.l, p[0] || 20);
      return [
        { key: k + 'u', kind: 'line', pane: 'main', color: col, values: dc.upper },
        { key: k + 'l', kind: 'line', pane: 'main', color: col, values: dc.lower },
      ];
    }
    case 'VOL':
      return [
        {
          key: k,
          kind: 'hist',
          pane: 'main',
          color: UP,
          values: d.v,
          colors: d.c.map((x, i) => (x >= d.o[i] ? UP : DOWN)),
          priceScaleId: 'vol',
        },
      ];
    case 'RSI':
      return [{ key: k, kind: 'line', pane: 'sub', color: col, values: ind.rsi(d.c, p[0] || 14), levels: [70, 30], title: `RSI${p[0]}` }];
    case 'MACD': {
      const m = ind.macd(d.c, p[0] || 12, p[1] || 26, p[2] || 9);
      return [
        {
          key: k + 'h',
          kind: 'hist',
          pane: 'sub',
          color: UP,
          values: m.hist,
          colors: m.hist.map((x, i) => (x >= 0 ? (x >= (m.hist[i - 1] ?? 0) ? '#20b26c' : 'rgba(32,178,108,0.5)') : x <= (m.hist[i - 1] ?? 0) ? '#ef454a' : 'rgba(239,69,74,0.5)')),
        },
        { key: k + 'm', kind: 'line', pane: 'sub', color: '#4d8dff', values: m.macd },
        { key: k + 's', kind: 'line', pane: 'sub', color: '#f7a600', values: m.signal },
      ];
    }
    case 'STOCH': {
      const s = ind.stoch(d.h, d.l, d.c, p[0] || 14, p[1] || 3, p[2] || 3);
      return [
        { key: k + 'k', kind: 'line', pane: 'sub', color: '#4d8dff', values: s.k, levels: [80, 20] },
        { key: k + 'd', kind: 'line', pane: 'sub', color: '#f7a600', values: s.d },
      ];
    }
    case 'ATR':
      return [{ key: k, kind: 'line', pane: 'sub', color: col, values: ind.atr(d.h, d.l, d.c, p[0] || 14) }];
    case 'CCI':
      return [{ key: k, kind: 'line', pane: 'sub', color: col, values: ind.cci(d.h, d.l, d.c, p[0] || 20), levels: [100, -100] }];
    case 'OBV':
      return [{ key: k, kind: 'line', pane: 'sub', color: col, values: ind.obv(d.c, d.v) }];
    case 'ADX': {
      const a = ind.adx(d.h, d.l, d.c, p[0] || 14);
      return [
        { key: k + 'a', kind: 'line', pane: 'sub', color: col, values: a.adx, lineWidth: 2 },
        { key: k + 'p', kind: 'line', pane: 'sub', color: '#20b26c', values: a.plusDI },
        { key: k + 'm', kind: 'line', pane: 'sub', color: '#ef454a', values: a.minusDI },
      ];
    }
  }
}

/** Свечи Хейкен-Аши. */
export function heikinAshi(d: Ohlcv): Ohlcv {
  const n = d.t.length;
  const out: Ohlcv = { t: d.t, o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n), v: d.v };
  for (let i = 0; i < n; i++) {
    const c = (d.o[i] + d.h[i] + d.l[i] + d.c[i]) / 4;
    const o = i === 0 ? (d.o[i] + d.c[i]) / 2 : (out.o[i - 1] + out.c[i - 1]) / 2;
    out.o[i] = o;
    out.c[i] = c;
    out.h[i] = Math.max(d.h[i], o, c);
    out.l[i] = Math.min(d.l[i], o, c);
  }
  return out;
}
