import { DAY } from '../../data/intervals';
import { MAIN } from '../../engine/exchange';
import { bump, useSession } from '../../store/session';
import { fmtNum, fmtUsd, pnlClass } from '../../lib/format';
import { cx, Empty } from '../ui';

export function dte(expiry: number, now: number) {
  const d = (expiry - now) / DAY;
  return d >= 1 ? `${d.toFixed(d >= 10 ? 0 : 1)}д` : `${((expiry - now) / 3_600_000).toFixed(1)}ч`;
}

export function OptionPositions({ base }: { base?: string } = {}) {
  const ex = useSession((s) => s.ex)!;
  const ps = Object.values(ex.main.positions).filter((p) => p.category === 'option' && (!base || p.symbol.startsWith(base + '-')));
  if (!ps.length) return <Empty>Нет опционных позиций</Empty>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Инструмент</th>
          <th className="text-right">Кол-во</th>
          <th className="text-right">Цена входа</th>
          <th className="text-right">Mark</th>
          <th className="text-right">IV</th>
          <th className="text-right">Стоимость</th>
          <th className="text-right">Нереализ. PnL</th>
          <th className="text-right">Δ</th>
          <th className="text-right">Θ/день</th>
          <th className="text-right">До эксп.</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {ps.map((p) => {
          const q = ex.optionQuote(p.symbol);
          const inst = ex.optionInstrument(p.symbol)!;
          const upnl = q ? p.size * (q.mark - p.avgPrice) : 0;
          return (
            <tr key={p.symbol}>
              <td>
                <span className="font-semibold">{p.symbol}</span>
                <div className="text-[10px] text-muted">{p.size > 0 ? 'Лонг' : 'Шорт'}</div>
              </td>
              <td className={cx('text-right', p.size > 0 ? 'text-up' : 'text-down')}>{fmtNum(p.size, 3)}</td>
              <td className="text-right">{fmtNum(p.avgPrice, 4)}</td>
              <td className="text-right">{fmtNum(q?.mark, 4)}</td>
              <td className="text-right">{q ? (q.iv * 100).toFixed(1) + '%' : '—'}</td>
              <td className="text-right">{fmtUsd((q?.mark ?? 0) * p.size)}</td>
              <td className={cx('text-right', pnlClass(upnl))}>{fmtUsd(upnl, 2, true)}</td>
              <td className="text-right">{fmtNum((q?.greeks.delta ?? 0) * p.size, 3)}</td>
              <td className={cx('text-right', pnlClass((q?.greeks.theta ?? 0) * p.size))}>{fmtNum((q?.greeks.theta ?? 0) * p.size, 2)}</td>
              <td className="text-right text-muted">{dte(inst.expiry, ex.now)}</td>
              <td>
                <button className="btn btn-sm" onClick={() => (ex.closePosition(MAIN, p.symbol), bump(true))}>
                  Закрыть
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
