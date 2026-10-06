import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { DAY, HOUR } from '../../data/intervals';
import { lowerBound } from '../../data/types';
import { useSession } from '../../store/session';
import { fmtNum, fmtPct, pnlClass } from '../../lib/format';
import { cx } from '../ui';

const COLORS = ['#f7a600', '#4d8dff', '#20b26c', '#ef454a', '#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#eaecef', '#84cc16', '#e879f9', '#fbbf24'];

export interface CompareLeg {
  symbol: string;
  side: 'long' | 'short';
  weight: number;
}

/**
 * Сравнение активов портфеля: цены, приведённые к 100 на начало окна, и линия портфеля
 * (взвешенная сумма с учётом лонг/шорт, без ребалансировки). Только прошлые данные.
 */
export function LegsCompare({ legs }: { legs: CompareLeg[] }) {
  const ex = useSession((s) => s.ex)!;
  const v = useSession((s) => s.v);
  const [days, setDays] = useState(30);
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const slow = Math.floor(v / 10);
  const key = legs.map((l) => `${l.symbol}:${l.side}:${l.weight}`).join('|');

  const data = useMemo(() => {
    const now = ex.now;
    const from = now - days * DAY;
    // общая сетка (часы, а на длинных окнах — дни): последняя известная цена каждого актива
    const step = days > 60 ? DAY : HOUR;
    const grid: number[] = [];
    for (let t = Math.ceil(from / step) * step; t <= now; t += step) grid.push(t);
    const lines = legs.map((l, i) => {
      const s = ex.market.series.get(l.symbol);
      const pts: { t: number; v: number }[] = [];
      if (s) {
        let base = NaN;
        for (const t of grid) {
          const k = lowerBound(s.t, s.length, t - ex.market.dt + 1) - 1; // последняя закрытая к t свеча
          if (k < 0) continue;
          const px = s.c[k];
          if (!Number.isFinite(base)) base = px;
          pts.push({ t, v: (px / base) * 100 });
        }
      }
      return { ...l, color: COLORS[i % COLORS.length], pts };
    });
    // портфель без ребалансировки: Σ w·(±доходность)
    const wsum = legs.reduce((a, l) => a + (l.weight || 0), 0) || 1;
    const maps = lines.map((ln) => new Map(ln.pts.map((p) => [p.t, p.v])));
    const port: { t: number; v: number }[] = [];
    grid.forEach((t) => {
      let val = 0;
      let ok = true;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const pv = maps[i].get(t);
        if (pv === undefined) {
          ok = false;
          break;
        }
        val += ((ln.weight || 0) / wsum) * (ln.side === 'long' ? pv - 100 : 100 - pv);
      }
      if (ok) port.push({ t, v: 100 + val });
    });
    return { lines, port };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, days, slow, ex]);

  useEffect(() => {
    const el = ref.current!;
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14151a' }, textColor: '#858a93', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930', timeVisible: true },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, 1) },
    });
    chartRef.current = c;
    return () => {
      c.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    // пересоздаём серии (их немного)
    const created: ReturnType<IChartApi['addSeries']>[] = [];
    for (const ln of data.lines) {
      const sr = c.addSeries(LineSeries, { color: ln.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: ln.symbol.replace(/USDT$/, '') });
      sr.setData(ln.pts.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.v })));
      created.push(sr);
    }
    if (data.port.length) {
      const sr = c.addSeries(LineSeries, { color: '#ffffff', lineWidth: 3, lineStyle: LineStyle.Solid, priceLineVisible: false, title: 'Портфель' });
      sr.setData(data.port.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.v })));
      created.push(sr);
    }
    c.timeScale().fitContent();
    return () => {
      // график мог быть уже удалён (размонтирование) — тогда серии удалять не нужно
      if (chartRef.current !== c) return;
      for (const sr of created) c.removeSeries(sr);
    };
  }, [data]);

  const portRet = data.port.length ? data.port[data.port.length - 1].v / 100 - 1 : NaN;
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 flex-wrap">
        <span className="text-[11px] text-muted">Динамика активов портфеля (=100 в начале окна) и портфель без ребалансировки за</span>
        {[7, 30, 90, 365].map((d) => (
          <button key={d} className={cx('chip !py-0.5', days === d && 'active')} onClick={() => setDays(d)}>
            {d >= 365 ? '1 год' : `${d}д`}
          </button>
        ))}
        <span className="ml-auto text-[11px]">
          Портфель: <b className={cx('num', pnlClass(portRet))}>{Number.isFinite(portRet) ? fmtPct(portRet) : '—'}</b>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1 text-[10px]">
        {data.lines.map((ln) => {
          const last = ln.pts.at(-1)?.v;
          return (
            <span key={ln.symbol} className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5" style={{ background: ln.color }} />
              <span className={ln.side === 'long' ? 'text-up' : 'text-down'}>{ln.side === 'long' ? '▲' : '▼'}</span>
              {ln.symbol.replace(/USDT$/, '')} {ln.weight}%
              <span className={cx('num', pnlClass(last !== undefined ? last - 100 : 0))}>{last !== undefined ? fmtPct(last / 100 - 1) : 'нет данных'}</span>
            </span>
          );
        })}
      </div>
      <div ref={ref} className="flex-1 min-h-[200px]" />
      <div className="text-[10px] text-dim px-2 pt-1">
        Помогает подобрать веса: активы с разной динамикой (например, крипта и акции/золото) дают больше пользы от ребалансировки. Только прошлые данные — будущее скрыто.
      </div>
    </div>
  );
}
