import { useMemo } from 'react';
import { MAIN } from '../engine/exchange';
import { BOT_LABELS } from '../engine/bots/types';
import { useSession, useTick } from '../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtUsd, pnlClass } from '../lib/format';
import { Badge, cx, Empty } from '../components/ui';
import { EquityChart } from '../components/EquityChart';

function Tile({ label, value, sub, className }: { label: string; value: string; sub?: React.ReactNode; className?: string }) {
  return (
    <div className="bg-panel rounded-lg px-4 py-3 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cx('num text-[18px] font-bold truncate', className)}>{value}</div>
      {sub && <div className="text-[11px] text-dim num">{sub}</div>}
    </div>
  );
}

export function AssetsPage() {
  const v = useTick();
  const ex = useSession((s) => s.ex)!;
  const set = useSession((s) => s.set);
  const main = ex.main;
  const sm = ex.summary(main);
  const tot = ex.totalEquity();
  const base = ex.config.initialBalance;
  const pnl = tot.total - base;
  const equity = useMemo(() => ex.state.equity.map((p) => ({ t: p.t, v: p.main + p.bots })), [ex, Math.floor(v / 10)]);
  const bench = useMemo(() => ex.state.equity.map((p) => ({ t: p.t, v: p.bench })), [ex, Math.floor(v / 10)]);
  const coins = Object.entries(main.spot).filter(([, q]) => q > 0);
  const linear = Object.values(main.positions).filter((p) => p.category === 'linear');
  const options = Object.values(main.positions).filter((p) => p.category === 'option');
  const bots = Object.values(ex.state.bots).filter((b) => b.status === 'running' || b.status === 'waiting');
  const notional = linear.reduce((s, p) => s + Math.abs(p.size) * ex.price(p.symbol), 0);
  const parts = [
    { label: 'USDT (свободно)', v: Math.max(0, sm.available), color: '#4d8dff' },
    { label: 'Маржа позиций/ордеров', v: sm.initialMargin + sm.orderMargin + sm.isolatedMargin, color: '#f7a600' },
    { label: 'Спот-монеты', v: sm.spotValue, color: '#20b26c' },
    { label: 'Опционы', v: Math.max(0, sm.optionValue), color: '#a78bfa' },
    { label: 'Боты', v: tot.bots, color: '#22d3ee' },
  ];
  const partsTotal = parts.reduce((s, x) => s + x.v, 0) || 1;
  return (
    <div className="h-full overflow-auto p-2 flex flex-col gap-2">
      <div className="grid grid-cols-6 gap-2">
        <Tile label="Общий капитал (USDT)" value={fmtUsd(tot.total)} sub={`старт ${fmtUsd(base)}`} />
        <Tile label="PnL сессии" value={fmtUsd(pnl, 2, true)} className={pnlClass(pnl)} sub={fmtPct(pnl / base)} />
        <Tile label="Единый аккаунт" value={fmtUsd(tot.main)} sub={`кошелёк ${fmtUsd(main.walletBalance)}`} />
        <Tile label="Нереализованный PnL" value={fmtUsd(sm.unrealisedPnl, 2, true)} className={pnlClass(sm.unrealisedPnl)} sub={`позиций: ${linear.length + options.length}`} />
        <Tile label="В ботах" value={fmtUsd(tot.bots)} sub={`${bots.length} активных`} />
        <Tile label="Макс. просадка" value={fmtPct(-ex.state.dd.maxDdTotal)} className="text-down" sub={`пик ${fmtUsd(ex.state.dd.peakTotal)}`} />
      </div>
      <div className="bg-panel rounded-lg p-3">
        <div className="flex items-center mb-2">
          <div className="font-semibold">Капитал во времени</div>
          <span className="text-[11px] text-muted ml-3">пунктир — удержание {ex.config.symbols[0]} для сравнения</span>
        </div>
        <EquityChart equity={equity} bench={bench} benchLabel={`${ex.config.symbols[0]} buy&hold`} height={300} />
      </div>
      <div className="bg-panel rounded-lg p-3">
        <div className="font-semibold mb-2">Структура капитала</div>
        <div className="flex h-3 rounded overflow-hidden">
          {parts.map((p) => (
            <div key={p.label} style={{ width: `${(p.v / partsTotal) * 100}%`, background: p.color }} title={`${p.label}: ${fmtUsd(p.v)}`} />
          ))}
        </div>
        <div className="flex flex-wrap gap-4 mt-2 text-[11px]">
          {parts.map((p) => (
            <span key={p.label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
              <span className="text-muted">{p.label}</span>
              <span className="num">{fmtUsd(p.v)}</span>
              <span className="text-dim">({fmtPct(p.v / partsTotal, 1, false)})</span>
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">Спот-балансы</div>
          {coins.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Монета</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Ср. цена</th>
                  <th className="text-right">Цена</th>
                  <th className="text-right">Стоимость</th>
                  <th className="text-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {coins.map(([c, q]) => {
                  const sym = `${c}USDT`;
                  const px = ex.price(sym);
                  const cost = main.spotCost[c] || 0;
                  return (
                    <tr key={c}>
                      <td className="font-semibold">{c}</td>
                      <td className="text-right">{fmtNum(q, 6)}</td>
                      <td className="text-right">{fmtPrice(cost / q, sym)}</td>
                      <td className="text-right">{fmtPrice(px, sym)}</td>
                      <td className="text-right">{fmtUsd(q * px)}</td>
                      <td className={cx('text-right', pnlClass(q * px - cost))}>{fmtUsd(q * px - cost, 2, true)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>Нет спотовых монет</Empty>
          )}
        </div>
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">Боты</div>
          {bots.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Бот</th>
                  <th className="text-right">Инвестиции</th>
                  <th className="text-right">Капитал</th>
                  <th className="text-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {bots.map((b) => {
                  const s = ex.botSummary(b);
                  return (
                    <tr key={b.id} className="cursor-pointer" onClick={() => set({ page: 'bots' })}>
                      <td>
                        <div className="font-semibold">{b.name}</div>
                        <Badge>{BOT_LABELS[b.type]}</Badge>
                      </td>
                      <td className="text-right">{fmtUsd(b.investment)}</td>
                      <td className="text-right">{fmtUsd(s.equity)}</td>
                      <td className={cx('text-right', pnlClass(s.pnl))}>
                        {fmtUsd(s.pnl, 2, true)} ({fmtPct(s.roi)})
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>Нет активных ботов</Empty>
          )}
        </div>
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">Деривативы</div>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <div>
              <div className="text-muted text-[11px]">Позиций</div>
              <div className="num font-semibold">{linear.length}</div>
            </div>
            <div>
              <div className="text-muted text-[11px]">Номинал</div>
              <div className="num font-semibold">{fmtUsd(notional)}</div>
            </div>
            <div>
              <div className="text-muted text-[11px]">Эфф. плечо</div>
              <div className="num font-semibold">{fmtNum(tot.main > 0 ? notional / tot.main : 0, 2)}x</div>
            </div>
            <div>
              <div className="text-muted text-[11px]">Начальная маржа</div>
              <div className="num font-semibold">{fmtUsd(sm.initialMargin + sm.isolatedMargin)}</div>
            </div>
            <div>
              <div className="text-muted text-[11px]">Поддерживающая</div>
              <div className="num font-semibold">{fmtUsd(sm.maintenanceMargin)}</div>
            </div>
            <div>
              <div className="text-muted text-[11px]">Опционы (стоимость)</div>
              <div className="num font-semibold">{fmtUsd(sm.optionValue)}</div>
            </div>
          </div>
        </div>
        <div className="bg-panel rounded-lg p-3">
          <div className="font-semibold mb-2">Итоги по аккаунту</div>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            {[
              ['Реализованный PnL', main.stats.realisedPnl, true],
              ['Комиссии', -main.stats.fees, true],
              ['Funding', main.stats.funding, true],
              ['Оборот', main.stats.volume, false],
              ['Сделок закрыто', main.stats.trades, false],
              ['Ликвидаций', main.stats.liquidations, false],
            ].map(([l, val, signed]) => (
              <div key={l as string}>
                <div className="text-muted text-[11px]">{l as string}</div>
                <div className={cx('num font-semibold', signed ? pnlClass(val as number) : '')}>
                  {l === 'Сделок закрыто' || l === 'Ликвидаций' ? fmtNum(val as number, 0) : fmtUsd(val as number, 2, !!signed)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="text-[11px] text-dim px-1">Аккаунт: {MAIN} · Все значения в USDT по последним ценам симуляции.</div>
    </div>
  );
}
