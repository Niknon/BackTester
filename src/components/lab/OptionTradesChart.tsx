import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { DAY, HOUR, bucketStart } from '../../data/intervals';
import { lowerBound } from '../../data/types';
import { aggregate } from '../../engine/aggregate';
import type { MarketData } from '../../engine/market';
import { OS_BY_KEY, type OsResult } from '../../engine/optionRunner';
import { fmtNum, priceDecimals } from '../../lib/format';

const toT = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

type Pt = { time: UTCTimestamp; value: number; color?: string };

/**
 * Добавить точку линии (время строго возрастает). Линия в lightweight-charts не рвётся на пустых точках,
 * а отрезок от точки i к i+1 рисуется цветом точки i — поэтому у последней точки сделки цвет прозрачный:
 * переход к следующей сделке в этом слоте не виден.
 */
function pushPt(arr: Pt[], time: UTCTimestamp, value: number, color?: string) {
  const last = arr[arr.length - 1];
  if (last && last.time > time) return;
  if (last && last.time === time) arr[arr.length - 1] = { time, value, color };
  else arr.push({ time, value, color });
}

const ROLE_STYLE: Record<string, { color: string; width: 1 | 2; style: LineStyle }> = {
  SellP: { color: '#f7a600', width: 2, style: LineStyle.Solid },
  SellC: { color: '#f7a600', width: 2, style: LineStyle.Solid },
  BuyP: { color: '#4d8dff', width: 1, style: LineStyle.Dashed },
  BuyC: { color: '#4d8dff', width: 1, style: LineStyle.Dashed },
};

/** Свечи базового актива + страйки каждой конструкции на время её жизни + отметки входа и выхода. */
export function OptionTradesChart({ market, result, focus }: { market: MarketData; result: OsResult; focus?: { from: number; to: number } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const symbol = result.settings.underlying;

  useEffect(() => {
    const s = market.series.get(symbol);
    if (!s) return;
    const dec = priceDecimals(symbol);
    const c = createChart(ref.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14151a' }, textColor: '#858a93', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930', timeVisible: true },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, dec) },
    });
    chartRef.current = c;
    // таймфрейм графика — чтобы свечей было не больше ~2500
    const span = market.end - market.start;
    const cands = [market.dt, HOUR, 4 * HOUR, DAY, 7 * DAY].filter((x) => x >= market.dt && x % market.dt === 0);
    const tfMs = cands.find((x) => span / x <= 2500) ?? cands[cands.length - 1];
    const from = lowerBound(s.t, s.length, market.start);
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
    const at = (ms: number) => toT(bucketStart(ms - 1, tfMs));

    // страйки: «слоты» для одновременно открытых конструкций, в каждом — линия на роль ноги
    // слот свободен, если предыдущая сделка в нём закончилась хотя бы на свечу раньше — иначе линии сольются
    const slots: number[] = [];
    const lines = new Map<string, Pt[]>();
    const tfS = tfMs / 1000;
    for (const g of result.trades) {
      const a = at(g.openTime);
      const close = g.closeTime ?? g.openTime;
      const b = at(Math.min(close, market.end));
      let slot = slots.findIndex((end) => end + tfS < a);
      if (slot < 0) {
        slot = slots.length;
        slots.push(0);
      }
      slots[slot] = b;
      for (const l of g.legs) {
        if (l.type === 'F') continue;
        const key = `${slot}|${l.side}${l.type}`;
        let arr = lines.get(key);
        if (!arr) lines.set(key, (arr = []));
        pushPt(arr, a, l.strike);
        pushPt(arr, b, l.strike, 'rgba(0,0,0,0)');
      }
    }
    for (const [key, pts] of lines) {
      const st = ROLE_STYLE[key.split('|')[1]];
      const ls = c.addSeries(LineSeries, {
        color: st.color,
        lineWidth: st.width,
        lineStyle: st.style,
        lineType: LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      ls.setData(pts);
    }

    // отметки
    const many = result.trades.length > 80;
    const short = OS_BY_KEY[result.settings.structure].short;
    const markers: SeriesMarker<Time>[] = [];
    for (const g of result.trades) {
      markers.push({ time: at(g.openTime), position: 'belowBar', shape: 'arrowUp', color: '#a78bfa', text: many ? '' : short });
      if (g.closeTime !== undefined)
        markers.push({
          time: at(Math.min(g.closeTime, market.end)),
          position: 'aboveBar',
          shape: 'circle',
          color: g.pnl > 0 ? '#20b26c' : '#ef454a',
          text: many ? '' : `${g.pnl > 0 ? '+' : ''}${fmtNum(g.pnl, 0)}`,
        });
    }
    markers.sort((x, y) => (x.time as number) - (y.time as number));
    createSeriesMarkers(cs, markers);
    c.timeScale().fitContent();
    return () => {
      chartRef.current = null;
      c.remove();
    };
  }, [market, symbol, result]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || !focus) return;
    const pad = Math.max(DAY, (focus.to - focus.from) * 0.6);
    try {
      c.timeScale().setVisibleRange({ from: toT(focus.from - pad), to: toT(focus.to + pad) });
    } catch {
      /* диапазон вне данных */
    }
  }, [focus]);

  return (
    <div className="relative w-full h-full">
      <div ref={ref} className="w-full h-full" />
      <div className="absolute left-2 top-1.5 z-10 text-[10px] text-muted bg-[#14151a]/80 rounded px-1.5 py-0.5 flex gap-3 pointer-events-none">
        <span>
          <span className="inline-block w-4 h-[2px] bg-brand align-middle mr-1" />
          проданные страйки
        </span>
        <span>
          <span className="inline-block w-4 border-t border-dashed border-[#4d8dff] align-middle mr-1" />
          купленные
        </span>
        <span className="text-[#a78bfa]">▲ вход</span>
        <span>
          <span className="text-up">●</span>/<span className="text-down">●</span> выход (результат)
        </span>
      </div>
    </div>
  );
}
