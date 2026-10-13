import { useEffect, useMemo, useState } from 'react';
import type { IChartApi, Logical } from 'lightweight-charts';
import { visibleAt, type NewsEvent } from '../../data/news';
import { eventsFor, useNews } from '../../store/news';
import { useSession, useTick } from '../../store/session';
import { cx } from '../ui';
import { fmtDuration, fmtTime } from '../../lib/format';
import { eventLabel, valuesLine } from './NewsWatcher';

const ICON: Record<NewsEvent['kind'], string> = { macro: '', earnings: 'E', dividend: 'D', split: 'S', crypto: '₿' };
const KIND_LABEL: Record<NewsEvent['kind'], string> = { macro: 'Макро', earnings: 'Отчёт', dividend: 'Дивиденд', split: 'Сплит', crypto: 'Крипто' };

/**
 * Значки событий внизу ценовой панели (как на графиках Bybit/TradingView): прошедшие — сплошные,
 * будущие (известные заранее) — с пунктирной рамкой справа от последней свечи. Наведение — подробности.
 */
export function NewsLayer({ chart: c, times, tfMs, symbol }: { chart: IChartApi; times: () => number[] | null; tfMs: number; symbol: string }) {
  useTick();
  const ex = useSession((s) => s.ex);
  const prefs = useSession((s) => s.prefs.news);
  const all = useNews((s) => s.events);
  const [ver, setVer] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  // пересчёт позиций при прокрутке/масштабе графика и изменении размера
  useEffect(() => {
    const bump = () => setVer((v) => v + 1);
    const ts = c.timeScale();
    ts.subscribeVisibleLogicalRangeChange(bump);
    ts.subscribeSizeChange(bump);
    return () => {
      // график мог быть уже уничтожен
      try {
        ts.unsubscribeVisibleLogicalRangeChange(bump);
        ts.unsubscribeSizeChange(bump);
      } catch {
        /* ignore */
      }
    };
  }, [c]);

  const mine = useMemo(() => eventsFor(all, symbol, prefs), [all, symbol, prefs]);
  const now = ex?.now ?? 0;
  const t = times();
  // после смены данных (таймфрейм, новые свечи) шкала обновляется позже — пересчитываем на следующем кадре
  useEffect(() => {
    const id = requestAnimationFrame(() => setVer((v) => v + 1));
    return () => cancelAnimationFrame(id);
  }, [t, t?.length, tfMs]);

  const clusters = useMemo(() => {
    if (!t || !t.length) return [];
    const ts = c.timeScale();
    const width = ts.width();
    const n = t.length;
    const toX = (time: number): number | null => {
      if (time < t[0]) return null;
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= time) lo = mid + 1;
        else hi = mid;
      }
      const i = lo - 1;
      // внутри истории — не дальше следующей свечи (ночи и выходные), после последней — экстраполяция
      const frac = i < n - 1 ? Math.min(1, (time - t[i]) / tfMs) : (time - t[i]) / tfMs;
      // logicalToCoordinate работает только с целыми индексами — дробную часть интерполируем
      const whole = i + Math.floor(frac);
      const x0 = ts.logicalToCoordinate(whole as Logical);
      if (x0 === null) return null;
      const x1 = ts.logicalToCoordinate((whole + 1) as Logical);
      return x0 + (frac - Math.floor(frac)) * ((x1 ?? x0) - x0);
    };
    const out: { x: number; events: NewsEvent[]; edge?: boolean }[] = [];
    const ahead: NewsEvent[] = [];
    for (const e of mine) {
      if (!visibleAt(e, now)) continue;
      const x = toX(e.t);
      if (x !== null && x > width - 22 && e.t > now) {
        ahead.push(e); // будущие за правым краем — собираем в маркер «→» у края
        continue;
      }
      if (x === null || x < 6 || x > width - 22) continue;
      const last = out[out.length - 1];
      if (last && x - last.x < 16) last.events.push(e);
      else out.push({ x, events: [e] });
    }
    if (ahead.length) out.push({ x: width - 12, events: ahead.slice(0, 12), edge: true });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, t, t?.length, mine, now, ver, tfMs]);

  if (import.meta.env.DEV) (window as any).__news = { clusters: clusters.length, mine: mine.length, bars: t?.length ?? 0, now, first: t?.[0], last: t ? t[t.length - 1] : null };
  if (!prefs.enabled) return null;
  const paneH = c.panes()[0]?.getHeight() ?? 0;
  if (paneH < 60) return null;
  const top = paneH - 24;
  const open = pinned ?? hover;
  const sel = open !== null ? clusters[open] : null;

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      {clusters.map((cl, i) => {
        const imp = Math.max(...cl.events.map((e) => e.importance));
        const future = cl.events.every((e) => e.t > now);
        const e0 = cl.events.find((e) => e.importance === imp) ?? cl.events[0];
        const label = cl.edge ? '→' : e0.kind === 'macro' ? (e0.country ?? '•') : ICON[e0.kind];
        return (
          <button
            key={`${cl.events[0].id}-${cl.events.length}`}
            className={cx(
              'absolute pointer-events-auto -translate-x-1/2 h-[18px] min-w-[18px] px-[3px] rounded-full text-[9px] font-bold leading-none flex items-center justify-center border shadow',
              future ? 'bg-panel/80 border-dashed' : imp >= 2 ? 'bg-[#3a2a0b]' : 'bg-panel3',
              imp >= 2 ? 'border-brand text-brand' : 'border-line2 text-muted',
              open === i && 'ring-1 ring-text',
            )}
            style={{ left: cl.x, top }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onClick={() => setPinned((p) => (p === i ? null : i))}
            title=""
          >
            {label}
            {cl.events.length > 1 && <span className="ml-[2px] text-[8px] opacity-80">{cl.events.length}</span>}
          </button>
        );
      })}
      {sel && (
        <>
          {!sel.edge && <div className="absolute w-px border-l border-dashed border-brand/60" style={{ left: sel.x, top: 0, height: top }} />}
          <div
            className="absolute pointer-events-auto panel border border-line2 shadow-xl p-2 w-[300px] overflow-auto text-[11px]"
            style={{ left: Math.max(4, Math.min(sel.x - 150, c.timeScale().width() - 304)), bottom: `calc(100% - ${top - 6}px)`, maxHeight: Math.max(80, Math.min(300, top - 10)) }}
            onMouseEnter={() => setHover(open)}
            onMouseLeave={() => setHover(null)}
          >
            {sel.edge && <div className="text-[10px] text-dim pb-1">Ближайшие события (известны заранее) — прокрутите график вправо</div>}
            {sel.events.slice(0, 12).map((e) => {
              const released = e.t <= now;
              return (
                <div key={e.id} className="py-1 border-b border-line last:border-0">
                  <div className="flex items-center gap-1.5">
                    <span className={cx('text-[9px] px-1 rounded border', e.importance >= 2 ? 'border-brand text-brand' : 'border-line2 text-muted')}>
                      {e.kind === 'macro' ? e.country : KIND_LABEL[e.kind]}
                    </span>
                    <span className="text-muted num">{fmtTime(e.t)}</span>
                    {!released && <span className="ml-auto text-[10px] text-info">через {fmtDuration(e.t - now)}</span>}
                  </div>
                  <div className="text-text font-semibold mt-0.5">{e.kind === 'macro' ? e.title : eventLabel(e)}</div>
                  {e.kind === 'macro' && e.original && e.original !== e.title && <div className="text-[10px] text-dim">{e.original}{e.period ? ` · ${e.period}` : ''}</div>}
                  {valuesLine(e, released) && <div className="text-muted num mt-0.5">{valuesLine(e, released)}</div>}
                  {e.kind === 'macro' && released && e.actual != null && e.forecast != null && e.actual !== e.forecast && (
                    <div className="text-[10px] text-dim">{e.actual > e.forecast ? 'выше' : 'ниже'} прогноза</div>
                  )}
                </div>
              );
            })}
            {sel.events.length > 12 && <div className="text-dim pt-1">и ещё {sel.events.length - 12}</div>}
          </div>
        </>
      )}
    </div>
  );
}
