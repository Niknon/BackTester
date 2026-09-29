import { useEffect, useRef } from 'react';
import { BaselineSeries, ColorType, LineSeries, LineStyle, createOptionsChart, createSeriesMarkers, type IChartApiBase, type ISeriesApi, type ISeriesMarkersPluginApi } from 'lightweight-charts';
import { fmtNum } from '../../lib/format';

export interface PayoffLeg {
  /** опцион: тип/страйк; перп: type='F' */
  type: 'C' | 'P' | 'F';
  strike: number;
  /** количество со знаком (+ лонг, − шорт) */
  qty: number;
  /** цена входа (премия для опциона / цена для фьючерса) */
  entry: number;
  /** текущая теоретическая стоимость как функция цены базового актива (T+0) */
  valueNow?: (S: number) => number;
}

export function payoffAtExpiry(legs: PayoffLeg[], S: number) {
  let v = 0;
  for (const l of legs) {
    if (l.type === 'F') v += l.qty * (S - l.entry);
    else {
      const intr = l.type === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
      v += l.qty * (intr - l.entry);
    }
  }
  return v;
}

export function payoffNow(legs: PayoffLeg[], S: number) {
  let v = 0;
  for (const l of legs) {
    if (l.type === 'F') v += l.qty * (S - l.entry);
    else v += l.qty * ((l.valueNow ? l.valueNow(S) : Math.max(0, l.type === 'C' ? S - l.strike : l.strike - S)) - l.entry);
  }
  return v;
}

/** Точки безубыточности (смена знака PnL на экспирации). */
export function breakevens(legs: PayoffLeg[], lo: number, hi: number, n = 800) {
  const out: number[] = [];
  let prev = payoffAtExpiry(legs, lo);
  for (let i = 1; i <= n; i++) {
    const S = lo + ((hi - lo) * i) / n;
    const v = payoffAtExpiry(legs, S);
    if ((prev < 0 && v >= 0) || (prev > 0 && v <= 0)) out.push(S);
    prev = v;
  }
  return out;
}

export function PayoffChart({ legs, spot, height = 260, range = 0.3 }: { legs: PayoffLeg[]; spot: number; height?: number; range?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApiBase<number> | null>(null);
  const expRef = useRef<ISeriesApi<'Baseline', number> | null>(null);
  const nowRef = useRef<ISeriesApi<'Line', number> | null>(null);
  const spotLine = useRef<any>(null);
  const markers = useRef<ISeriesMarkersPluginApi<number> | null>(null);

  useEffect(() => {
    const c = createOptionsChart(ref.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14151a' }, textColor: '#858a93', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930' },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, 2) },
    });
    expRef.current = c.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: '#20b26c',
      topFillColor1: 'rgba(32,178,108,0.28)',
      topFillColor2: 'rgba(32,178,108,0.02)',
      bottomLineColor: '#ef454a',
      bottomFillColor1: 'rgba(239,69,74,0.02)',
      bottomFillColor2: 'rgba(239,69,74,0.28)',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'На экспирации',
    });
    nowRef.current = c.addSeries(LineSeries, { color: '#4d8dff', lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: 'Сейчас (T+0)' });
    chartRef.current = c;
    return () => {
      c.remove();
      chartRef.current = null;
      markers.current = null;
      spotLine.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || !expRef.current || !nowRef.current || !Number.isFinite(spot) || spot <= 0) return;
    const strikes = legs.filter((l) => l.type !== 'F').map((l) => l.strike);
    const lo = Math.max(1e-9, Math.min(spot * (1 - range), ...strikes.map((k) => k * 0.9)));
    const hi = Math.max(spot * (1 + range), ...strikes.map((k) => k * 1.1));
    const N = 240;
    const pts: number[] = [];
    for (let i = 0; i <= N; i++) pts.push(lo + ((hi - lo) * i) / N);
    const dec = spot >= 1000 ? 0 : spot >= 10 ? 2 : 5;
    pts.push(spot);
    const uniq = [...new Set(pts.map((x) => Number(x.toFixed(dec))))].sort((a, b) => a - b);
    expRef.current.setData(uniq.map((S) => ({ time: S, value: payoffAtExpiry(legs, S) })));
    nowRef.current.setData(uniq.map((S) => ({ time: S, value: payoffNow(legs, S) })));
    if (spotLine.current) expRef.current.removePriceLine(spotLine.current);
    spotLine.current = expRef.current.createPriceLine({ price: 0, color: '#5a5f69', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
    if (!markers.current) markers.current = createSeriesMarkers(expRef.current, []);
    const sp = Number(spot.toFixed(dec));
    markers.current.setMarkers([{ time: sp, position: 'inBar', shape: 'circle', color: '#f7a600', text: `Спот ${fmtNum(spot, dec)}`, size: 1 }]);
    c.timeScale().fitContent();
  }, [legs, spot, range]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={ref} className="absolute inset-0" />
      <div className="absolute left-2 top-1 text-[10px] text-muted pointer-events-none flex gap-3 z-10">
        <span className="text-up">━ PnL на экспирации</span>
        <span className="text-info">┅ PnL сейчас (T+0)</span>
        <span>Ось X — цена базового актива</span>
      </div>
    </div>
  );
}
