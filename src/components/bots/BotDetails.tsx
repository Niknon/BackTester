import { Fragment, useMemo, useState } from 'react';
import { getAsset } from '../../data/assets';
import { comboStatus, type RebalanceLogEntry } from '../../engine/bots/combo';
import { BOT_LABELS, type AnyBot } from '../../engine/bots/types';
import { useSession, useTick } from '../../store/session';
import { fmtCountdown, fmtDuration, fmtNum, fmtPct, fmtPrice, fmtQty, fmtTime, fmtUsd, pnlClass } from '../../lib/format';
import { Badge, cx, Empty, Modal, Row, Tabs } from '../ui';
import { EquityChart } from '../EquityChart';

const REASON: Record<RebalanceLogEntry['reason'], string> = {
  start: 'Открытие',
  time: 'По времени',
  threshold: 'По отклонению',
};

/** Веса портфеля комбо-бота: текущий (заливка) против целевого (риска). */
export function ComboWeights({ bot }: { bot: AnyBot }) {
  const ex = useSession((s) => s.ex)!;
  const st = comboStatus(ex, bot as any);
  const legs = (bot.params as any).legs as { symbol: string; side: string; weight: number }[];
  return (
    <div className="flex flex-col gap-1">
      {legs.map((l, i) => {
        const dev = st.weights[i] * 100 - l.weight;
        return (
          <div key={l.symbol} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 font-semibold">{getAsset(l.symbol).base}</span>
            <span className={cx('w-10', l.side === 'long' ? 'text-up' : 'text-down')}>{l.side === 'long' ? 'Лонг' : 'Шорт'}</span>
            <div className="flex-1 h-1.5 bg-panel3 rounded relative">
              <div className="absolute inset-y-0 left-0 bg-brand/70 rounded" style={{ width: `${Math.min(100, st.weights[i] * 100)}%` }} />
              <div className="absolute -top-0.5 w-0.5 h-2.5 bg-text" style={{ left: `${l.weight}%` }} title={`Цель ${l.weight}%`} />
            </div>
            <span className="num w-28 text-right">
              {fmtNum(st.weights[i] * 100, 1)}% <span className="text-dim">/ {l.weight}%</span>{' '}
              <span className={Math.abs(dev) >= 0.05 ? (dev > 0 ? 'text-brand' : 'text-info') : 'text-dim'}>
                ({dev >= 0 ? '+' : ''}
                {fmtNum(dev, 1)})
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Статус до следующей ребалансировки (для карточки). */
export function ComboRebalanceStatus({ bot }: { bot: AnyBot }) {
  const ex = useSession((s) => s.ex)!;
  const p = bot.params as any;
  const st = comboStatus(ex, bot as any);
  if (p.rebalanceMode === 'none') return <div className="text-[11px] text-muted">Ребалансировка отключена</div>;
  if (p.rebalanceMode === 'time')
    return (
      <div className="text-[11px] text-muted">
        Следующая ребалансировка через <b className="text-text num">{fmtCountdown(Math.max(0, (st.nextAt ?? ex.now) - ex.now))}</b> (каждые {p.intervalHours} ч)
      </div>
    );
  const frac = Math.min(1, (st.maxDev * 100) / p.thresholdPct);
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span className="whitespace-nowrap">
        Отклонение весов <b className="text-text num">{fmtNum(st.maxDev * 100, 2)}%</b> из порога {p.thresholdPct}%
      </span>
      <div className="flex-1 h-1.5 bg-panel3 rounded overflow-hidden">
        <div className={cx('h-full', frac > 0.8 ? 'bg-brand' : 'bg-info/70')} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function tradesText(e: RebalanceLogEntry) {
  return e.trades.map((t) => (
    <span key={t.symbol} className={cx('mr-2 whitespace-nowrap', t.side === 'Buy' ? 'text-up' : 'text-down')}>
      {t.side === 'Buy' ? '+' : '−'}
      {fmtQty(t.qty, t.symbol)} {getAsset(t.symbol).base}
    </span>
  ));
}

/** Краткая сводка последней ребалансировки (для карточки). */
export function LastRebalance({ bot }: { bot: AnyBot }) {
  const ex = useSession((s) => s.ex)!;
  const log = (bot.rt.log as RebalanceLogEntry[] | undefined) ?? [];
  const last = log[log.length - 1];
  if (!last || last.reason === 'start') return <div className="text-[11px] text-dim">Ребалансировок ещё не было</div>;
  return (
    <div className="text-[11px] bg-panel2 rounded px-2 py-1.5">
      <div className="flex justify-between text-muted">
        <span>
          Последняя: <b className="text-text">{fmtTime(last.t)}</b> ({fmtDuration(ex.now - last.t)} назад) · {REASON[last.reason]}
        </span>
        <span>
          комиссия <span className="text-text num">{fmtUsd(last.fees, 2)}</span>
        </span>
      </div>
      <div className="num mt-0.5">{tradesText(last)}</div>
    </div>
  );
}

export function RebalanceTable({ bot }: { bot: AnyBot }) {
  const log = ((bot.rt.log as RebalanceLogEntry[] | undefined) ?? []).slice().reverse();
  const legs = (bot.params as any).legs as { symbol: string; weight: number }[];
  const [openRow, setOpenRow] = useState<number | null>(null);
  if (!log.length) return <Empty>Журнал пуст</Empty>;
  const totalFees = log.reduce((s, e) => s + e.fees, 0);
  const totalRealized = log.reduce((s, e) => s + e.realized, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <Row label="Ребалансировок" value={String(log.filter((e) => e.reason !== 'start').length)} />
        <Row label="Комиссии всего" value={fmtUsd(totalFees)} />
        <Row label="Реализовано при сокращениях" value={<span className={pnlClass(totalRealized)}>{fmtUsd(totalRealized, 2, true)}</span>} />
        <Row label="Записей в журнале" value={`${log.length}${log.length >= 300 ? ' (последние)' : ''}`} />
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Время</th>
            <th>Причина</th>
            <th className="text-right">Капитал</th>
            <th className="text-right">Изм. капитала</th>
            <th className="text-right">Откл. весов</th>
            <th>Сделки</th>
            <th className="text-right">Комиссия</th>
            <th className="text-right">Реализ. PnL</th>
          </tr>
        </thead>
        <tbody>
          {log.map((e, i) => {
            const prev = log[i + 1];
            const chg = prev ? e.equity - prev.equity : NaN;
            return (
              <Fragment key={`${e.t}-${i}`}>
                <tr className="cursor-pointer" onClick={() => setOpenRow(openRow === i ? null : i)}>
                  <td className="text-muted">
                    {openRow === i ? '▾' : '▸'} {fmtTime(e.t)}
                  </td>
                  <td>
                    <Badge color={e.reason === 'start' ? 'info' : e.reason === 'threshold' ? 'brand' : 'muted'}>{REASON[e.reason]}</Badge>
                  </td>
                  <td className="text-right">{fmtUsd(e.equity)}</td>
                  <td className={cx('text-right', pnlClass(chg))}>{Number.isFinite(chg) ? fmtUsd(chg, 2, true) : '—'}</td>
                  <td className="text-right">{e.reason === 'start' ? '—' : `${fmtNum(e.maxDev * 100, 2)}%`}</td>
                  <td className="num whitespace-normal">{tradesText(e)}</td>
                  <td className="text-right text-muted">{fmtUsd(e.fees, 2)}</td>
                  <td className={cx('text-right', pnlClass(e.realized))}>{fmtUsd(e.realized, 2, true)}</td>
                </tr>
                {openRow === i && (
                  <tr>
                    <td colSpan={8} className="!bg-panel2">
                      <table className="w-full text-[11px] num">
                        <thead>
                          <tr className="text-muted">
                            <td>Монета</td>
                            <td className="text-right">Вес до</td>
                            <td className="text-right">Вес после</td>
                            <td className="text-right">Цель</td>
                            <td className="text-right">Сделка</td>
                            <td className="text-right">Цена</td>
                            <td className="text-right">Объём, USDT</td>
                            <td className="text-right">Позиция до → после</td>
                          </tr>
                        </thead>
                        <tbody>
                          {legs.map((l, k) => {
                            const t = e.trades.find((x) => x.symbol === l.symbol);
                            return (
                              <tr key={l.symbol}>
                                <td className="py-0.5 font-semibold">{getAsset(l.symbol).base}</td>
                                <td className="text-right">{e.reason === 'start' ? '—' : `${fmtNum((e.weightsBefore[k] ?? 0) * 100, 2)}%`}</td>
                                <td className="text-right">{fmtNum((e.weightsAfter[k] ?? 0) * 100, 2)}%</td>
                                <td className="text-right text-muted">{l.weight}%</td>
                                <td className={cx('text-right', t ? (t.side === 'Buy' ? 'text-up' : 'text-down') : 'text-dim')}>
                                  {t ? `${t.side === 'Buy' ? 'Покупка' : 'Продажа'} ${fmtQty(t.qty, t.symbol)}` : 'без изменений'}
                                </td>
                                <td className="text-right">{t ? fmtPrice(t.price, t.symbol) : ''}</td>
                                <td className="text-right">{t ? fmtUsd(t.notional) : ''}</td>
                                <td className="text-right">{t ? `${fmtQty(t.sizeBefore, t.symbol)} → ${fmtQty(t.sizeAfter, t.symbol)}` : ''}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Tab = 'overview' | 'rebalances' | 'trades' | 'orders';

/** Окно с подробностями бота: капитал, позиции, журнал ребалансировок, сделки, ордера. */
export function BotDetailsModal({ bot, onClose }: { bot: AnyBot | null; onClose: () => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const [tab, setTab] = useState<Tab>(bot?.type === 'futuresCombo' ? 'rebalances' : 'overview');
  const equity = useMemo(() => (bot ? bot.hist.map((h) => ({ t: h.t, v: h.v })) : []), [bot, bot?.hist.length]);
  if (!bot) return null;
  const acc = ex.botAccount(bot);
  const s = ex.botSummary(bot);
  const active = bot.status === 'running' || bot.status === 'waiting';
  const execs = ex.state.executions.filter((e) => e.accountId === acc.id && e.execType !== 'Funding').slice(-500).reverse();
  const orders = ex.activeOrders(acc.id);
  const positions = Object.values(acc.positions);
  const tabs: { value: Tab; label: string }[] = [{ value: 'overview', label: 'Обзор' }];
  if (bot.type === 'futuresCombo') tabs.push({ value: 'rebalances', label: `Ребалансировки (${bot.stats.rebalances})` });
  tabs.push({ value: 'trades', label: `Сделки (${execs.length})` }, { value: 'orders', label: `Ордера (${orders.length})` });
  return (
    <Modal open={!!bot} onClose={onClose} title={`${bot.name} · ${BOT_LABELS[bot.type]}`} width={1040}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-6 gap-2 text-[12px]">
          <div>
            <div className="text-[10px] text-muted">Общий PnL</div>
            <div className={cx('num font-semibold', pnlClass(s.pnl))}>
              {fmtUsd(s.pnl, 2, true)} ({fmtPct(s.roi)})
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Капитал</div>
            <div className="num font-semibold">{fmtUsd(s.equity)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Инвестиции</div>
            <div className="num font-semibold">{fmtUsd(bot.investment)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted">APR</div>
            <div className={cx('num font-semibold', pnlClass(s.apr))}>{fmtPct(s.apr, 1)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Комиссии / funding</div>
            <div className="num font-semibold">
              {fmtUsd(-acc.stats.fees)} / <span className={pnlClass(acc.stats.funding)}>{fmtUsd(acc.stats.funding, 2, true)}</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted">Статус</div>
            <div className="font-semibold">{active ? `работает ${fmtDuration(s.days * 86_400_000)}` : bot.stopReason}</div>
          </div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={tabs} className="!px-0" />
        <div className="max-h-[60vh] overflow-auto">
          {tab === 'overview' && (
            <div className="flex flex-col gap-3">
              <EquityChart equity={equity} height={240} />
              {bot.type === 'futuresCombo' && active && (
                <div className="flex flex-col gap-2">
                  <ComboRebalanceStatus bot={bot} />
                  <ComboWeights bot={bot} />
                </div>
              )}
              {positions.length > 0 && (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Позиция</th>
                      <th className="text-right">Размер</th>
                      <th className="text-right">Стоимость</th>
                      <th className="text-right">Вход</th>
                      <th className="text-right">Цена</th>
                      <th className="text-right">Нереализ. PnL</th>
                      <th className="text-right">Funding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const u = ex.unrealisedPnl(p);
                      return (
                        <tr key={p.symbol}>
                          <td className="font-semibold">{p.symbol}</td>
                          <td className={cx('text-right', p.size > 0 ? 'text-up' : 'text-down')}>{fmtQty(p.size, p.symbol)}</td>
                          <td className="text-right">{fmtUsd(Math.abs(p.size) * ex.price(p.symbol))}</td>
                          <td className="text-right">{fmtPrice(p.avgPrice, p.symbol)}</td>
                          <td className="text-right">{fmtPrice(ex.price(p.symbol), p.symbol)}</td>
                          <td className={cx('text-right', pnlClass(u))}>{fmtUsd(u, 2, true)}</td>
                          <td className={cx('text-right', pnlClass(p.funding))}>{fmtUsd(p.funding, 2, true)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {tab === 'rebalances' && <RebalanceTable bot={bot} />}
          {tab === 'trades' &&
            (execs.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Символ</th>
                    <th>Сторона</th>
                    <th className="text-right">Кол-во</th>
                    <th className="text-right">Цена</th>
                    <th className="text-right">Объём</th>
                    <th className="text-right">Комиссия</th>
                    <th className="text-right">Реализ. PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {execs.map((e) => (
                    <tr key={e.id}>
                      <td className="text-muted">{fmtTime(e.time)}</td>
                      <td className="font-semibold">
                        {e.symbol} {e.category === 'spot' && <span className="text-dim text-[10px]">спот</span>}
                      </td>
                      <td className={e.side === 'Buy' ? 'text-up' : 'text-down'}>{e.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
                      <td className="text-right">{fmtQty(e.qty, e.symbol, e.category)}</td>
                      <td className="text-right">{fmtPrice(e.price, e.symbol)}</td>
                      <td className="text-right">{fmtUsd(e.qty * e.price)}</td>
                      <td className="text-right text-muted">{fmtNum(e.fee, 4)}</td>
                      <td className={cx('text-right', pnlClass(e.closedPnl))}>{e.closedPnl ? fmtUsd(e.closedPnl, 2, true) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Сделок пока нет</Empty>
            ))}
          {tab === 'orders' &&
            (orders.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Символ</th>
                    <th>Сторона</th>
                    <th className="text-right">Цена</th>
                    <th className="text-right">Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {orders
                    .slice()
                    .sort((a, b) => (b.price || b.triggerPrice || 0) - (a.price || a.triggerPrice || 0))
                    .map((o) => (
                      <tr key={o.id}>
                        <td className="font-semibold">{o.symbol}</td>
                        <td className={o.side === 'Buy' ? 'text-up' : 'text-down'}>{o.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
                        <td className="text-right">{fmtPrice(o.price || o.triggerPrice, o.symbol)}</td>
                        <td className="text-right">{fmtQty(o.qty, o.symbol, o.category)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <Empty>Активных ордеров нет</Empty>
            ))}
        </div>
      </div>
    </Modal>
  );
}
