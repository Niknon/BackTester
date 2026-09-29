import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, LineStyle, createOptionsChart } from 'lightweight-charts';
import { fmtNum } from '../../lib/format';

interface Line {
  name: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

/** Небольшой график с числовой осью X (страйк / дни до экспирации). */
export function XYChart({ lines, height = 260, xDecimals = 0, yFormat }: { lines: Line[]; height?: number; xDecimals?: number; yFormat?: (v: number) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = createOptionsChart(ref.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14151a' }, textColor: '#858a93', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930' },
      localization: { locale: 'ru-RU', priceFormatter: yFormat ?? ((p: number) => fmtNum(p, 1)) },
    });
    for (const l of lines) {
      const s = c.addSeries(LineSeries, {
        color: l.color,
        lineWidth: 2,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        title: l.name,
      });
      const pts = [...l.points].filter((p) => Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
      const uniq: { time: number; value: number }[] = [];
      for (const p of pts) {
        const x = Number(p.x.toFixed(xDecimals));
        if (uniq.length && uniq[uniq.length - 1].time >= x) continue;
        uniq.push({ time: x, value: p.y });
      }
      s.setData(uniq);
    }
    c.timeScale().fitContent();
    return () => c.remove();
  }, [lines, xDecimals, yFormat]);
  return <div ref={ref} style={{ height }} className="w-full" />;
}
