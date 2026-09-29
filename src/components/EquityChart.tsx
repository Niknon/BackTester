import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { EquitySample } from '../engine/metrics';
import { drawdownSeries } from '../engine/metrics';
import { fmtNum } from '../lib/format';

interface Props {
  equity: EquitySample[];
  /** бенчмарк (цена актива) — нормируется к стартовому капиталу */
  bench?: EquitySample[];
  benchLabel?: string;
  showDrawdown?: boolean;
  height?: number | string;
  /** дополнительные линии (плоты стратегии и т.п.) */
  extra?: { name: string; color: string; points: EquitySample[] }[];
}

const toT = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function dedupe(points: EquitySample[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of points) {
    const t = toT(p.t);
    if (!Number.isFinite(p.v)) continue;
    if (out.length && out[out.length - 1].time >= t) out[out.length - 1] = { time: out[out.length - 1].time, value: p.v };
    else out.push({ time: t, value: p.v });
  }
  return out;
}

export function EquityChart({ equity, bench, benchLabel = 'Бенчмарк (buy&hold)', showDrawdown = true, height = 300, extra }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const eq = useRef<ISeriesApi<'Area'> | null>(null);
  const bm = useRef<ISeriesApi<'Line'> | null>(null);
  const dd = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ex = useRef<ISeriesApi<'Line'>[]>([]);

  useEffect(() => {
    const c = createChart(ref.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#14151a' },
        textColor: '#858a93',
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: '#262930' },
      },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930', timeVisible: true },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, 2) },
    });
    eq.current = c.addSeries(AreaSeries, {
      lineColor: '#f7a600',
      topColor: 'rgba(247,166,0,0.25)',
      bottomColor: 'rgba(247,166,0,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Капитал',
    });
    bm.current = c.addSeries(LineSeries, { color: '#5a5f69', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, title: '' });
    if (showDrawdown) {
      dd.current = c.addSeries(
        HistogramSeries,
        { color: 'rgba(239,69,74,0.55)', priceLineVisible: false, priceFormat: { type: 'percent' } as any, title: 'Просадка %' },
        1,
      );
      c.panes()[0]?.setStretchFactor(1);
      c.panes()[1]?.setStretchFactor(0.3);
    }
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      ex.current = [];
    };
  }, [showDrawdown]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !eq.current) return;
    eq.current.setData(dedupe(equity));
    if (bench && bench.length && equity.length && bm.current) {
      const b0 = bench.find((b) => b.v > 0)?.v ?? 1;
      const e0 = equity[0].v;
      bm.current.setData(dedupe(bench.map((b) => ({ t: b.t, v: (b.v / b0) * e0 }))));
      bm.current.applyOptions({ title: benchLabel });
    } else bm.current?.setData([]);
    if (dd.current) dd.current.setData(dedupe(drawdownSeries(equity).map((p) => ({ t: p.t, v: p.v * 100 }))));
    for (const s of ex.current) c.removeSeries(s);
    ex.current = [];
    for (const e of extra ?? []) {
      const s = c.addSeries(LineSeries, { color: e.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: e.name });
      s.setData(dedupe(e.points));
      ex.current.push(s);
    }
    c.timeScale().fitContent();
  }, [equity, bench, extra, benchLabel]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={ref} className="absolute inset-0" />
    </div>
  );
}
