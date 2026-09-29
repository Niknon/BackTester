import { useCallback, useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';
import { useDrawings, type DPoint, type Drawing } from '../../store/drawings';
import type { Ohlcv } from '../../engine/aggregate';
import { fmtPrice, fmtDuration } from '../../lib/format';

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

interface Props {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  data: Ohlcv;
  tfMs: number;
  symbol: string;
  version: number;
}

export function DrawingLayer({ chart, series, data, tfMs, symbol, version }: Props) {
  const { tool, magnet, color, bySymbol, selected, setTool, select, add, update, remove } = useDrawings();
  const drawings = bySymbol[symbol] || [];
  const [, setRedraw] = useState(0);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const drag = useRef<{ id: string; handle: 'a' | 'b' } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // перерисовка при прокрутке/масштабировании
  useEffect(() => {
    let raf = 0;
    const req = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setRedraw((x) => x + 1);
          const w = chart.timeScale().width();
          const h = chart.panes()[0]?.getHeight() ?? 0;
          setBox((b) => (b.w !== w || b.h !== h ? { w, h } : b));
        });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(req);
    chart.subscribeCrosshairMove(req);
    const ro = new ResizeObserver(req);
    ro.observe(chart.chartElement());
    req();
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(req);
      chart.unsubscribeCrosshairMove(req);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [chart]);

  useEffect(() => {
    setRedraw((x) => x + 1);
  }, [version]);

  // удаление клавишей Delete
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        remove(symbol, selected);
      }
      if (e.key === 'Escape') {
        setTool('cursor');
        setDraft(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, symbol, remove, setTool]);

  const times = data.t;
  const n = times.length;

  const tToLogical = useCallback(
    (t: number): number => {
      if (!n) return 0;
      if (t <= times[0]) return (t - times[0]) / tfMs;
      if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / tfMs;
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (times[m] <= t) lo = m;
        else hi = m;
      }
      return lo + (t - times[lo]) / (times[hi] - times[lo]);
    },
    [times, n, tfMs],
  );

  const xOf = (t: number) => chart.timeScale().logicalToCoordinate(tToLogical(t) as Logical) ?? -9999;
  const yOf = (p: number) => series.priceToCoordinate(p) ?? -9999;

  const pointAt = (x: number, y: number): DPoint | null => {
    const l = chart.timeScale().coordinateToLogical(x);
    const raw = series.coordinateToPrice(y);
    if (l === null || raw === null) return null;
    let p: number = raw;
    let t: number;
    const li = Math.floor(l);
    if (!n) t = 0;
    else if (li < 0) t = times[0] + l * tfMs;
    else if (li >= n - 1) t = times[n - 1] + (l - (n - 1)) * tfMs;
    else t = times[li] + (l - li) * (times[li + 1] - times[li]);
    if (magnet && n) {
      const i = Math.max(0, Math.min(n - 1, Math.round(l)));
      t = times[i];
      const cands = [data.o[i], data.h[i], data.l[i], data.c[i]];
      const target = p;
      p = cands.reduce((best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best), cands[0]);
    }
    return { t, p };
  };

  const local = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    if (tool === 'cursor') {
      select(null);
      return;
    }
    const { x, y } = local(e);
    const pt = pointAt(x, y);
    if (!pt) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const d: Drawing = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: tool, a: pt, b: pt, color };
    if (tool === 'hline' || tool === 'vline' || tool === 'text') {
      if (tool === 'text') {
        const text = prompt('Текст заметки:');
        if (!text) return;
        d.text = text;
      }
      add(symbol, d);
      setTool('cursor');
      return;
    }
    setDraft(d);
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    if (drag.current) {
      const pt = pointAt(x, y);
      if (pt) update(symbol, drag.current.id, { [drag.current.handle]: pt });
      return;
    }
    if (!draft) return;
    const pt = pointAt(x, y);
    if (pt) setDraft({ ...draft, b: pt });
  };

  const onUp = () => {
    if (drag.current) {
      drag.current = null;
      return;
    }
    if (!draft) return;
    const dx = Math.abs(xOf(draft.a.t) - xOf(draft.b.t));
    const dy = Math.abs(yOf(draft.a.p) - yOf(draft.b.p));
    if (dx + dy > 4) add(symbol, draft);
    setDraft(null);
    setTool('cursor');
  };

  const W = box.w;
  const H = box.h;

  const render = (d: Drawing, isDraft = false) => {
    const x1 = xOf(d.a.t);
    const y1 = yOf(d.a.p);
    const x2 = xOf(d.b.t);
    const y2 = yOf(d.b.p);
    const sel = selected === d.id;
    const sw = sel ? 2 : 1.5;
    const pick = (e: React.PointerEvent) => {
      if (tool !== 'cursor') return;
      e.stopPropagation();
      select(d.id);
    };
    const common = { onPointerDown: pick, style: { cursor: tool === 'cursor' ? 'pointer' : undefined } };
    let body: React.ReactNode = null;
    switch (d.type) {
      case 'trend':
      case 'ray': {
        let ex2 = x2;
        let ey2 = y2;
        if (d.type === 'ray' && x2 !== x1) {
          const k = (y2 - y1) / (x2 - x1);
          ex2 = x2 >= x1 ? W : 0;
          ey2 = y1 + k * (ex2 - x1);
        }
        body = (
          <>
            <line x1={x1} y1={y1} x2={ex2} y2={ey2} stroke="transparent" strokeWidth={10} {...common} />
            <line x1={x1} y1={y1} x2={ex2} y2={ey2} stroke={d.color} strokeWidth={sw} pointerEvents="none" />
          </>
        );
        break;
      }
      case 'hline':
        body = (
          <>
            <line x1={0} x2={W} y1={y1} y2={y1} stroke="transparent" strokeWidth={10} {...common} />
            <line x1={0} x2={W} y1={y1} y2={y1} stroke={d.color} strokeWidth={sw} strokeDasharray="6 4" pointerEvents="none" />
            <text x={W - 4} y={y1 - 4} textAnchor="end" fill={d.color} fontSize={11} pointerEvents="none">
              {fmtPrice(d.a.p, symbol)}
            </text>
          </>
        );
        break;
      case 'vline':
        body = (
          <>
            <line x1={x1} x2={x1} y1={0} y2={H} stroke="transparent" strokeWidth={10} {...common} />
            <line x1={x1} x2={x1} y1={0} y2={H} stroke={d.color} strokeWidth={sw} strokeDasharray="6 4" pointerEvents="none" />
          </>
        );
        break;
      case 'rect':
        body = (
          <rect
            x={Math.min(x1, x2)}
            y={Math.min(y1, y2)}
            width={Math.abs(x2 - x1)}
            height={Math.abs(y2 - y1)}
            fill={d.color + '22'}
            stroke={d.color}
            strokeWidth={sw}
            {...common}
          />
        );
        break;
      case 'fib': {
        const left = Math.min(x1, x2);
        body = (
          <g>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={d.color} strokeDasharray="3 3" strokeWidth={1} {...common} />
            {FIB.map((f) => {
              const p = d.b.p + (d.a.p - d.b.p) * f;
              const y = yOf(p);
              return (
                <g key={f} pointerEvents="none">
                  <line x1={left} x2={W} y1={y} y2={y} stroke={d.color} strokeOpacity={f === 0 || f === 1 ? 0.9 : 0.55} strokeWidth={1} />
                  <text x={left + 4} y={y - 3} fill={d.color} fontSize={10}>
                    {f.toFixed(3)} ({fmtPrice(p, symbol)})
                  </text>
                </g>
              );
            })}
          </g>
        );
        break;
      }
      case 'measure': {
        const up = d.b.p >= d.a.p;
        const c = up ? '#20b26c' : '#ef454a';
        const dp = d.b.p - d.a.p;
        const pct = (dp / d.a.p) * 100;
        const bars = Math.round(Math.abs(tToLogical(d.b.t) - tToLogical(d.a.t)));
        body = (
          <g {...common}>
            <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill={c + '26'} stroke={c} strokeWidth={1} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1} strokeDasharray="4 3" />
            <g transform={`translate(${(x1 + x2) / 2}, ${up ? Math.min(y1, y2) - 8 : Math.max(y1, y2) + 18})`}>
              <rect x={-90} y={-14} width={180} height={18} rx={3} fill={c} />
              <text x={0} y={-1} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={600}>
                {dp >= 0 ? '+' : ''}
                {fmtPrice(dp, symbol)} ({pct >= 0 ? '+' : ''}
                {pct.toFixed(2)}%) · {bars} св. · {fmtDuration(Math.abs(d.b.t - d.a.t))}
              </text>
            </g>
          </g>
        );
        break;
      }
      case 'text':
        body = (
          <text x={x1} y={y1} fill={d.color} fontSize={13} fontWeight={600} {...common}>
            {d.text}
          </text>
        );
        break;
    }
    return (
      <g key={d.id} opacity={isDraft ? 0.8 : 1}>
        {body}
        {sel && !isDraft && (
          <>
            {(['a', 'b'] as const)
              .filter((h) => h === 'a' || !['hline', 'vline', 'text'].includes(d.type))
              .map((h) => (
                <circle
                  key={h}
                  cx={h === 'a' ? x1 : x2}
                  cy={h === 'a' ? y1 : y2}
                  r={5}
                  fill="#14151a"
                  stroke={d.color}
                  strokeWidth={2}
                  style={{ cursor: 'grab', pointerEvents: 'all' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    drag.current = { id: d.id, handle: h };
                  }}
                />
              ))}
          </>
        )}
      </g>
    );
  };

  const active = tool !== 'cursor';
  return (
    <svg
      ref={svgRef}
      width={W}
      height={H}
      className="absolute left-0 top-0 z-10"
      style={{ pointerEvents: active || drag.current ? 'all' : 'none', cursor: active ? 'crosshair' : undefined, overflow: 'hidden' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {active && <rect x={0} y={0} width={W} height={H} fill="transparent" />}
      <g style={{ pointerEvents: 'auto' }} onPointerMove={onMove} onPointerUp={onUp}>
        {drawings.map((d) => render(d))}
      </g>
      {draft && render(draft, true)}
    </svg>
  );
}
