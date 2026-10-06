import type { PerformanceReport } from '../engine/metrics';
import { fmtNum, fmtPct, fmtUsd, pnlClass } from '../lib/format';
import { cx } from './ui';

function Tile({ label, value, className, hint }: { label: string; value: React.ReactNode; className?: string; hint?: string }) {
  return (
    <div className="bg-panel2 rounded-md px-3 py-2 min-w-0" title={hint}>
      <div className="text-[10px] text-muted truncate">{label}</div>
      <div className={cx('num font-semibold text-[14px] truncate', className)}>{value}</div>
    </div>
  );
}

export function ReportGrid({ r, cols = 6, compact }: { r: PerformanceReport; cols?: number; compact?: boolean }) {
  const pf = !r.trades ? '—' : Number.isFinite(r.profitFactor) ? fmtNum(r.profitFactor, 2) : '∞';
  const tiles = [
    <Tile key="ret" label="Доходность" value={fmtPct(r.totalReturn)} className={pnlClass(r.totalReturn)} hint="Изменение капитала за период" />,
    <Tile key="pnl" label="PnL, USDT" value={fmtUsd(r.pnl, 2, true)} className={pnlClass(r.pnl)} />,
    <Tile key="dd" label="Макс. просадка" value={fmtPct(-r.maxDrawdown)} className="text-down" hint={`${fmtUsd(r.maxDrawdownAbs)} USDT, дольше всего ${fmtNum(r.maxDrawdownDays, 1)} дн.`} />,
    <Tile key="sh" label="Шарп (год.)" value={r.days < 3 ? '—' : fmtNum(r.sharpe, 2)} className={r.days < 3 ? 'text-dim' : pnlClass(r.sharpe)} hint="По дневным доходностям, безрисковая ставка 0 (от 3 дней истории)" />,
    <Tile key="so" label="Сортино" value={r.days < 3 ? '—' : fmtNum(r.sortino, 2)} className={r.days < 3 ? 'text-dim' : pnlClass(r.sortino)} />,
    <Tile key="bench" label="Buy & Hold" value={r.benchReturn === null ? '—' : fmtPct(r.benchReturn)} className={pnlClass(r.benchReturn)} hint="Доходность удержания базового актива" />,
    <Tile key="tr" label="Сделок" value={fmtNum(r.trades, 0)} hint="Закрытые сделки (открытые позиции не учитываются)" />,
    <Tile key="wr" label="Win rate" value={r.trades ? fmtPct(r.winRate, 1, false) : '—'} hint="Доля прибыльных среди закрытых сделок" />,
    <Tile key="pf" label="Profit factor" value={pf} className={!r.trades ? 'text-dim' : r.profitFactor >= 1 ? 'text-up' : 'text-down'} hint="Сумма прибылей / сумма убытков закрытых сделок" />,
    <Tile key="exp" label="Ожидание / сделку" value={fmtUsd(r.expectancy, 2, true)} className={pnlClass(r.expectancy)} />,
    // годовые показатели на коротком отрезке бессмысленны (−100% за 0.4 дня) — показываем «—»
    <Tile
      key="cagr"
      label="CAGR"
      value={r.days < 30 ? '—' : Math.abs(r.cagr) > 100 ? '>10000%' : fmtPct(r.cagr)}
      className={r.days < 30 ? 'text-dim' : pnlClass(r.cagr)}
      hint={r.days < 30 ? 'Годовая доходность считается от 30 дней истории' : 'Годовая доходность при сохранении темпа'}
    />,
    <Tile key="cal" label="Калмар" value={r.days < 30 ? '—' : fmtNum(r.calmar, 2)} className={r.days < 30 ? 'text-dim' : ''} hint={r.days < 30 ? 'Считается от 30 дней истории' : 'CAGR / макс. просадка'} />,
  ];
  if (!compact)
    tiles.push(
      <Tile key="aw" label="Ср. прибыль" value={fmtUsd(r.avgWin, 2, true)} className="text-up" />,
      <Tile key="al" label="Ср. убыток" value={fmtUsd(r.avgLoss, 2, true)} className="text-down" />,
      <Tile key="lw" label="Лучшая сделка" value={fmtUsd(r.largestWin, 2, true)} className="text-up" />,
      <Tile key="ll" label="Худшая сделка" value={fmtUsd(r.largestLoss, 2, true)} className="text-down" />,
      <Tile key="ah" label="Ср. удержание" value={`${fmtNum(r.avgHoldHours, 1)} ч`} />,
      <Tile key="cl" label="Убытков подряд" value={fmtNum(r.maxConsecLosses, 0)} />,
      <Tile key="fee" label="Комиссии" value={fmtUsd(-r.fees, 2)} className="text-down" />,
      <Tile key="fund" label="Funding" value={fmtUsd(r.funding, 2, true)} className={pnlClass(r.funding)} />,
      <Tile key="vol" label="Волатильность (год.)" value={fmtPct(r.volatility, 1, false)} />,
      <Tile key="days" label="Период" value={`${fmtNum(r.days, 1)} дн.`} />,
      <Tile key="se" label="Капитал: старт" value={fmtUsd(r.startEquity)} />,
      <Tile key="ee" label="Капитал: финиш" value={fmtUsd(r.endEquity)} />,
    );
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {tiles}
    </div>
  );
}
