import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, HistogramSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import { DAY } from '../data/intervals';
import { MAIN } from '../engine/exchange';
import { computeReport, type EquitySample } from '../engine/metrics';
import { exportSessionJson } from '../store/actions';
import { useSession, useTick } from '../store/session';
import { downloadText, fmtNum, fmtPct, fmtTime, fmtUsd, pnlClass, toCsv } from '../lib/format';
import { cx, Empty, Segmented } from '../components/ui';
import { ReportGrid } from '../components/ReportGrid';
import { EquityChart } from '../components/EquityChart';

function DailyPnlChart({ points }: { points: EquitySample[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const data = useMemo(() => {
    const byDay = new Map<number, number>();
    let prev = points[0]?.v ?? 0;
    for (const p of points) {
      const d = Math.floor((p.t - 1) / DAY);
      byDay.set(d, (byDay.get(d) ?? 0) + (p.v - prev));
      prev = p.v;
    }
    return [...byDay.entries()].map(([d, v]) => ({ time: ((d * DAY) / 1000) as UTCTimestamp, value: v, color: v >= 0 ? '#20b26c' : '#ef454a' }));
  }, [points]);
  useEffect(() => {
    const c = createChart(ref.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14151a' }, textColor: '#858a93', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: '#1b1d23' } },
      rightPriceScale: { borderColor: '#262930' },
      timeScale: { borderColor: '#262930' },
      localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, 2) },
    });
    const s = c.addSeries(HistogramSeries, { priceLineVisible: false, title: 'PnL за день' });
    s.setData(data);
    c.timeScale().fitContent();
    return () => c.remove();
  }, [data]);
  return <div ref={ref} className="h-[200px]" />;
}

const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

function MonthlyTable({ points }: { points: EquitySample[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { first: number; last: number }>();
    let prevLast: number | null = null;
    for (const p of points) {
      const d = new Date(p.t - 1);
      const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      const cur = m.get(k);
      if (!cur) m.set(k, { first: prevLast ?? p.v, last: p.v });
      else cur.last = p.v;
      prevLast = p.v;
    }
    const years = new Map<number, (number | null)[]>();
    for (const [k, v] of m) {
      const [y, mo] = k.split('-').map(Number);
      if (!years.has(y)) years.set(y, new Array(12).fill(null));
      years.get(y)![mo] = v.first > 0 ? v.last / v.first - 1 : null;
    }
    return [...years.entries()].sort((a, b) => a[0] - b[0]);
  }, [points]);
  if (!rows.length) return null;
  return (
    <table className="tbl text-[11px]">
      <thead>
        <tr>
          <th>Год</th>
          {MONTHS.map((m) => (
            <th key={m} className="text-right">
              {m}
            </th>
          ))}
          <th className="text-right">Год</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([y, ms]) => {
          const yr = ms.reduce<number>((acc, r) => (r === null ? acc : acc * (1 + r)), 1) - 1;
          return (
            <tr key={y}>
              <td className="font-semibold">{y}</td>
              {ms.map((r, i) => (
                <td key={i} className={cx('text-right', r === null ? 'text-dim' : pnlClass(r))} style={r !== null ? { background: r >= 0 ? `rgba(32,178,108,${Math.min(0.35, Math.abs(r) * 3)})` : `rgba(239,69,74,${Math.min(0.35, Math.abs(r) * 3)})` } : undefined}>
                  {r === null ? '' : fmtPct(r, 1)}
                </td>
              ))}
              <td className={cx('text-right font-semibold', pnlClass(yr))}>{fmtPct(yr, 1)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AnalyticsPage() {
  const v = useTick();
  const ex = useSession((s) => s.ex)!;
  const [scope, setScope] = useState<'total' | 'main'>('total');
  const slow = Math.floor(v / 20);
  const data = useMemo(() => {
    const equity = ex.state.equity.map((p) => ({ t: p.t, v: scope === 'main' ? p.main : p.main + p.bots }));
    const cur = ex.totalEquity();
    equity.push({ t: ex.now, v: scope === 'main' ? cur.main : cur.total });
    const bench = ex.state.equity.map((p) => ({ t: p.t, v: p.bench }));
    const closed = ex.state.closedPnl.filter((c) => (scope === 'main' ? c.accountId === MAIN : true) && c.category !== 'spot');
    const spotClosed = ex.state.closedPnl.filter((c) => (scope === 'main' ? c.accountId === MAIN : true) && c.category === 'spot');
    const accs = Object.values(ex.state.accounts).filter((a) => scope === 'total' || a.id === MAIN);
    const fees = accs.reduce((s, a) => s + a.stats.fees, 0);
    const funding = accs.reduce((s, a) => s + a.stats.funding, 0);
    const report = computeReport(equity, [...closed, ...spotClosed], { fees, funding, bench });
    // по символам
    const bySym = new Map<string, { n: number; w: number; pnl: number; fees: number; funding: number; cat: string }>();
    for (const c of [...closed, ...spotClosed]) {
      const key = c.category === 'option' ? c.symbol.split('-')[0] + ' опционы' : c.symbol + (c.category === 'spot' ? ' спот' : '');
      const r = bySym.get(key) ?? { n: 0, w: 0, pnl: 0, fees: 0, funding: 0, cat: c.category };
      r.n++;
      if (c.closedPnl > 0) r.w++;
      r.pnl += c.closedPnl;
      r.fees += c.openFee + c.closeFee;
      r.funding += c.funding;
      bySym.set(key, r);
    }
    // по источникам
    const src = { linear: 0, option: 0, spot: 0, bots: 0 };
    for (const c of ex.state.closedPnl) {
      if (c.accountId !== MAIN) continue;
      src[c.category] += c.closedPnl;
    }
    for (const b of Object.values(ex.state.bots)) src.bots += ex.botSummary(b).pnl;
    return { equity, bench, report, bySym: [...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl), closed: [...closed, ...spotClosed], src };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, scope, slow]);

  const dist = useMemo(() => {
    const vals = data.closed.map((c) => c.closedPnl);
    if (vals.length < 2) return null;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const bins = 24;
    const w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const x of vals) counts[Math.min(bins - 1, Math.floor((x - lo) / w))]++;
    const max = Math.max(...counts);
    return { lo, w, counts, max };
  }, [data.closed]);

  const r = data.report;
  return (
    <div className="h-full overflow-auto p-2 flex flex-col gap-2">
      <div className="bg-panel rounded-lg p-3 flex items-center gap-3">
        <div className="font-semibold text-[14px]">Аналитика производительности</div>
        <Segmented
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'total', label: 'Всё (с ботами)' },
            { value: 'main', label: 'Только ручная торговля' },
          ]}
        />
        <span className="text-[11px] text-muted">
          {fmtTime(ex.market.start)} → {fmtTime(ex.now)} · {fmtNum((ex.now - ex.market.start) / DAY, 1)} дн.
        </span>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-sm btn-ghost" onClick={() => downloadText('equity.csv', toCsv(ex.state.equity.map((p) => ({ time: new Date(p.t).toISOString(), main: p.main, bots: p.bots, benchmark: p.bench }))), 'text/csv')}>
            ⬇ Капитал CSV
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => downloadText('closed-pnl.csv', toCsv(ex.state.closedPnl.map((c) => ({ ...c, openTime: new Date(c.openTime).toISOString(), closeTime: new Date(c.closeTime).toISOString() }))), 'text/csv')}
          >
            ⬇ Сделки CSV
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              const j = exportSessionJson();
              if (j) downloadText(`session-${ex.config.id}.json`, j, 'application/json');
            }}
          >
            ⬇ Сессия JSON
          </button>
        </div>
      </div>
      <div className="bg-panel rounded-lg p-3">
        <ReportGrid r={r} cols={8} />
      </div>
      <div className="grid grid-cols-[1fr_380px] gap-2">
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">Капитал и просадка</div>
          <EquityChart equity={data.equity} bench={data.bench} benchLabel={`${ex.config.symbols[0]} buy&hold`} height={340} />
        </div>
        <div className="bg-panel rounded-lg p-3 flex flex-col gap-3">
          <div className="font-semibold">Результат по источникам</div>
          {(
            [
              ['Перпетуалы (ручные)', data.src.linear],
              ['Опционы', data.src.option],
              ['Спот (реализ.)', data.src.spot],
              ['Боты', data.src.bots],
            ] as const
          ).map(([l, val]) => (
            <div key={l} className="flex items-center justify-between">
              <span className="text-muted">{l}</span>
              <span className={cx('num font-semibold', pnlClass(val))}>{fmtUsd(val, 2, true)}</span>
            </div>
          ))}
          <div className="font-semibold pt-2 border-t border-line">Распределение PnL сделок</div>
          {dist ? (
            <div className="flex items-end gap-px h-28">
              {dist.counts.map((c, i) => {
                const x = dist.lo + (i + 0.5) * dist.w;
                return (
                  <div
                    key={i}
                    className={x >= 0 ? 'bg-up/70' : 'bg-down/70'}
                    style={{ height: `${(c / dist.max) * 100}%`, flex: 1 }}
                    title={`${fmtUsd(dist.lo + i * dist.w)} … ${fmtUsd(dist.lo + (i + 1) * dist.w)}: ${c} сделок`}
                  />
                );
              })}
            </div>
          ) : (
            <div className="text-dim text-[11px]">Недостаточно сделок</div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">PnL по дням</div>
          {data.equity.length > 2 ? <DailyPnlChart points={data.equity} /> : <Empty>Нет данных</Empty>}
        </div>
        <div className="bg-panel rounded-lg p-3 overflow-auto">
          <div className="font-semibold mb-2">Доходность по месяцам</div>
          <MonthlyTable points={data.equity} />
        </div>
      </div>
      <div className="bg-panel rounded-lg p-3">
        <div className="font-semibold mb-2">По инструментам</div>
        {data.bySym.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Инструмент</th>
                <th className="text-right">Сделок</th>
                <th className="text-right">Win rate</th>
                <th className="text-right">PnL</th>
                <th className="text-right">Комиссии</th>
                <th className="text-right">Funding</th>
              </tr>
            </thead>
            <tbody>
              {data.bySym.map(([k, s]) => (
                <tr key={k}>
                  <td className="font-semibold">{k}</td>
                  <td className="text-right">{s.n}</td>
                  <td className="text-right">{fmtPct(s.w / s.n, 1, false)}</td>
                  <td className={cx('text-right font-semibold', pnlClass(s.pnl))}>{fmtUsd(s.pnl, 2, true)}</td>
                  <td className="text-right text-muted">{fmtUsd(s.fees)}</td>
                  <td className={cx('text-right', pnlClass(s.funding))}>{fmtUsd(s.funding, 2, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Закрытых сделок пока нет</Empty>
        )}
      </div>
    </div>
  );
}
