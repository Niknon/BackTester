import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { bucketStart, intervalMs } from '../../data/intervals';
import type { IntervalKey } from '../../data/types';
import { lowerBound } from '../../data/types';
import { aggregate } from '../../engine/aggregate';
import type { MarketData } from '../../engine/market';
import type { StrategyResult } from '../../engine/strategy';
import { fmtNum, priceDecimals } from '../../lib/format';

const toT = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const PALETTE = ['#f7a600', '#4d8dff', '#a78bfa', '#22d3ee', '#f472b6', '#34d399', '#fb923c'];

/** График результата стратегии: свечи периода, плоты и сделки. */
export function StrategyChart({ market, symbol, tf, result }: { market: MarketData; symbol: string; tf: IntervalKey; result: StrategyResult }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = market.series.get(symbol);
    if (!s) return;
    const dec = priceDecimals(symbol);
    const c = createChart(ref.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#14151a' },
        textColor: '#858a93',
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: '#262930', enableResize: true },
      },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930', timeVisible: true },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, dec) },
    });
    const tfMs = intervalMs(tf);
    const from = lowerBound(s.t, s.length, market.start - 50 * tfMs);
    const to = lowerBound(s.t, s.length, market.end);
    const agg = aggregate(s, tfMs, from, to);
    const cs = c.addSeries(CandlestickSeries, {
      upColor: '#20b26c',
      downColor: '#ef454a',
      borderUpColor: '#20b26c',
      borderDownColor: '#ef454a',
      wickUpColor: '#20b26c',
      wickDownColor: '#ef454a',
    });
    cs.setData(agg.t.map((t, i) => ({ time: toT(t), open: agg.o[i], high: agg.h[i], low: agg.l[i], close: agg.c[i] })));
    let k = 0;
    let sub = 0;
    for (const [name, p] of Object.entries(result.plots)) {
      const pane = p.pane === 'sub' ? ++sub : 0;
      const ls = c.addSeries(LineSeries, { color: p.color ?? PALETTE[k++ % PALETTE.length], lineWidth: 1, priceLineVisible: false, lastValueVisible: pane > 0, title: name }, pane);
      const pts: { time: UTCTimestamp; value: number }[] = [];
      for (const q of p.points) {
        const t = toT(q.t);
        if (pts.length && pts[pts.length - 1].time >= t) pts[pts.length - 1] = { time: pts[pts.length - 1].time, value: q.v };
        else pts.push({ time: t, value: q.v });
      }
      ls.setData(pts);
    }
    const markers: SeriesMarker<Time>[] = [];
    const seen = new Map<string, SeriesMarker<Time>>();
    for (const e of result.executions) {
      if (e.execType !== 'Trade' && e.execType !== 'Liquidation') continue;
      const bt = bucketStart(e.time, tfMs);
      const key = `${bt}${e.side}`;
      if (seen.has(key)) continue;
      const m: SeriesMarker<Time> = {
        time: toT(bt),
        position: e.side === 'Buy' ? 'belowBar' : 'aboveBar',
        shape: e.side === 'Buy' ? 'arrowUp' : 'arrowDown',
        color: e.execType === 'Liquidation' ? '#f7a600' : e.side === 'Buy' ? '#20b26c' : '#ef454a',
        text: e.execType === 'Liquidation' ? 'LIQ' : e.side === 'Buy' ? 'B' : 'S',
      };
      seen.set(key, m);
      markers.push(m);
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(cs, markers);
    c.timeScale().fitContent();
    return () => c.remove();
  }, [market, symbol, tf, result]);
  return <div ref={ref} className="w-full h-full" />;
}
