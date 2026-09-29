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
  const pf = Number.isFinite(r.profitFactor) ? fmtNum(r.profitFactor, 2) : '∞';
  const tiles = [
    <Tile key="ret" label="Доходность" value={fmtPct(r.totalReturn)} className={pnlClass(r.totalReturn)} hint="Изменение капитала за период" />,
    <Tile key="pnl" label="PnL, USDT" value={fmtUsd(r.pnl, 2, true)} className={pnlClass(r.pnl)} />,
    <Tile key="dd" label="Макс. просадка" value={fmtPct(-r.maxDrawdown)} className="text-down" hint={`${fmtUsd(r.maxDrawdownAbs)} USDT, дольше всего ${fmtNum(r.maxDrawdownDays, 1)} дн.`} />,
    <Tile key="sh" label="Шарп (год.)" value={fmtNum(r.sharpe, 2)} className={pnlClass(r.sharpe)} hint="По дневным доходностям, безрисковая ставка 0" />,
    <Tile key="so" label="Сортино" value={fmtNum(r.sortino, 2)} className={pnlClass(r.sortino)} />,
    <Tile key="bench" label="Buy & Hold" value={r.benchReturn === null ? '—' : fmtPct(r.benchReturn)} className={pnlClass(r.benchReturn)} hint="Доходность удержания базового актива" />,
    <Tile key="tr" label="Сделок" value={fmtNum(r.trades, 0)} />,
    <Tile key="wr" label="Win rate" value={fmtPct(r.winRate, 1, false)} />,
    <Tile key="pf" label="Profit factor" value={pf} className={r.profitFactor >= 1 ? 'text-up' : 'text-down'} />,
    <Tile key="exp" label="Ожидание / сделку" value={fmtUsd(r.expectancy, 2, true)} className={pnlClass(r.expectancy)} />,
    <Tile key="cagr" label="CAGR" value={Math.abs(r.cagr) > 100 ? '>10000%' : fmtPct(r.cagr)} className={pnlClass(r.cagr)} hint="Годовая доходность при сохранении темпа" />,
    <Tile key="cal" label="Калмар" value={fmtNum(r.calmar, 2)} />,
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
