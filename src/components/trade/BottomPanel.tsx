import { useState } from 'react';
import { getAsset } from '../../data/assets';
import { OptionPositions } from '../options/OptionPositions';
import { MAIN } from '../../engine/exchange';
import type { Category, Order, Position } from '../../engine/types';
import { bump, toast, useSession, useTick } from '../../store/session';
import { downloadText, fmtNum, fmtPct, fmtPrice, fmtQty, fmtTime, fmtUsd, pnlClass, toCsv } from '../../lib/format';
import { Badge, Check, cx, Empty, Modal, NumInput, Row, Tabs } from '../ui';

type TabKey = 'positions' | 'options' | 'orders' | 'conditional' | 'history' | 'trades' | 'closed' | 'balances';

const ORDER_STATUS: Record<string, string> = {
  New: 'Новый',
  PartiallyFilled: 'Частично',
  Filled: 'Исполнен',
  Cancelled: 'Отменён',
  Rejected: 'Отклонён',
  Untriggered: 'Ожидает',
  Triggered: 'Сработал',
  Deactivated: 'Деактивирован',
};

export function TpSlModal({ pos, open, onClose }: { pos: Position | null; open: boolean; onClose: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const [tp, setTp] = useState<number | ''>('');
  const [sl, setSl] = useState<number | ''>('');
  const [trail, setTrail] = useState<number | ''>('');
  const [init, setInit] = useState('');
  if (pos && open && init !== pos.symbol + pos.createdTime) {
    setInit(pos.symbol + pos.createdTime);
    setTp(pos.takeProfit ?? '');
    setSl(pos.stopLoss ?? '');
    setTrail(pos.trailingStop ?? '');
  }
  if (!pos) return null;
  const last = ex.price(pos.symbol);
  const est = (p: number | '') => (p ? pos.size * (Number(p) - pos.avgPrice) : NaN);
  const spec = getAsset(pos.symbol);
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setInit('');
      }}
      title={`TP/SL позиции ${pos.symbol}`}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Row label="Вход" value={fmtPrice(pos.avgPrice, pos.symbol)} />
          <Row label="Последняя" value={fmtPrice(last, pos.symbol)} />
          <Row label="Размер" value={<span className={pos.size > 0 ? 'text-up' : 'text-down'}>{fmtQty(pos.size, pos.symbol)}</span>} />
        </div>
        <NumInput label="Take Profit" value={tp} onChange={setTp} step={spec.tickSize} suffix={tp ? <span className={pnlClass(est(tp))}>{fmtUsd(est(tp), 2, true)}</span> : 'USDT'} />
        <NumInput label="Stop Loss" value={sl} onChange={setSl} step={spec.tickSize} suffix={sl ? <span className={pnlClass(est(sl))}>{fmtUsd(est(sl), 2, true)}</span> : 'USDT'} />
        <NumInput label="Трейлинг-стоп (дистанция)" value={trail} onChange={setTrail} step={spec.tickSize} suffix="USDT" />
        <div className="text-[11px] text-dim">Пустое поле — снять соответствующий ордер. Срабатывание по последней цене, исполнение рыночным ордером на весь объём позиции.</div>
        <button
          className="btn btn-brand h-9"
          onClick={() => {
            const err = ex.setTradingStop(MAIN, pos.symbol, {
              takeProfit: tp === '' ? null : Number(tp),
              stopLoss: sl === '' ? null : Number(sl),
              trailingStop: trail === '' ? null : Number(trail),
            });
            if (err) toast('error', 'TP/SL не установлены', err);
            else {
              toast('success', 'TP/SL обновлены');
              onClose();
              setInit('');
            }
            bump(true);
          }}
        >
          Подтвердить
        </button>
      </div>
    </Modal>
  );
}

function MarginModal({ pos, open, onClose }: { pos: Position | null; open: boolean; onClose: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const [amt, setAmt] = useState<number | ''>('');
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  if (!pos) return null;
  return (
    <Modal open={open} onClose={onClose} title={`Маржа позиции ${pos.symbol}`}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <button className={cx('btn flex-1', mode === 'add' && 'btn-brand')} onClick={() => setMode('add')}>
            Добавить
          </button>
          <button className={cx('btn flex-1', mode === 'remove' && 'btn-brand')} onClick={() => setMode('remove')}>
            Вывести
          </button>
        </div>
        <Row label="Текущая маржа" value={`${fmtUsd(pos.isolatedMargin)} USDT`} />
        <Row label="Доступно" value={`${fmtUsd(ex.available(ex.main))} USDT`} />
        <NumInput label="Сумма" value={amt} onChange={setAmt} suffix="USDT" />
        <button
          className="btn btn-brand h-9"
          onClick={() => {
            const err = ex.addMargin(MAIN, pos.symbol, (mode === 'add' ? 1 : -1) * Number(amt));
            if (err) toast('error', err);
            else {
              onClose();
              bump(true);
            }
          }}
        >
          Подтвердить
        </button>
      </div>
    </Modal>
  );
}

export function PositionsTable({ onSymbol, onlyCurrent, symbol }: { onSymbol: (s: string) => void; onlyCurrent: boolean; symbol: string }) {
  const ex = useSession((s) => s.ex)!;
  const acc = ex.main;
  const [tpslPos, setTpslPos] = useState<Position | null>(null);
  const [marginPos, setMarginPos] = useState<Position | null>(null);
  const [limitPx, setLimitPx] = useState<Record<string, number | ''>>({});
  const positions = Object.values(acc.positions).filter((p) => p.category === 'linear' && (!onlyCurrent || p.symbol === symbol));
  if (!positions.length) return <Empty>Нет открытых позиций</Empty>;
  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th>Контракт</th>
            <th className="text-right">Кол-во</th>
            <th className="text-right">Стоимость</th>
            <th className="text-right">Цена входа</th>
            <th className="text-right">Mark</th>
            <th className="text-right">Цена ликв.</th>
            <th className="text-right">IM</th>
            <th className="text-right">MM</th>
            <th className="text-right">Нереализ. PnL (ROI)</th>
            <th className="text-right">Реализ. PnL</th>
            <th>TP/SL</th>
            <th>Закрыть</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const mark = ex.price(p.symbol);
            const upnl = ex.unrealisedPnl(p);
            const im = p.marginMode === 'isolated' ? p.isolatedMargin : (Math.abs(p.size) * mark) / p.leverage;
            const roi = im > 0 ? upnl / ((Math.abs(p.size) * p.avgPrice) / p.leverage) : 0;
            const liq = ex.liqPrice(acc, p);
            return (
              <tr key={p.symbol}>
                <td>
                  <div className="flex items-center gap-2">
                    <span className={cx('w-1 h-7 rounded', p.size > 0 ? 'bg-up' : 'bg-down')} />
                    <div>
                      <button className="font-semibold hover:text-brand" onClick={() => onSymbol(p.symbol)}>
                        {p.symbol}
                      </button>
                      <div className="text-[10px] text-muted">
                        {p.marginMode === 'cross' ? 'Кросс' : 'Изолир.'} {fmtNum(p.leverage, p.leverage % 1 ? 2 : 0)}x ·{' '}
                        <span className={p.size > 0 ? 'text-up' : 'text-down'}>{p.size > 0 ? 'Лонг' : 'Шорт'}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className={cx('text-right', p.size > 0 ? 'text-up' : 'text-down')}>{fmtQty(p.size, p.symbol)}</td>
                <td className="text-right">{fmtUsd(Math.abs(p.size) * mark)}</td>
                <td className="text-right">{fmtPrice(p.avgPrice, p.symbol)}</td>
                <td className="text-right">{fmtPrice(mark, p.symbol)}</td>
                <td className="text-right text-brand">{liq ? fmtPrice(liq, p.symbol) : '—'}</td>
                <td className="text-right">
                  {fmtUsd(im)}
                  {p.marginMode === 'isolated' && (
                    <button className="ml-1 text-brand" title="Изменить маржу" onClick={() => setMarginPos(p)}>
                      ±
                    </button>
                  )}
                </td>
                <td className="text-right">{fmtUsd(ex.positionMM(p))}</td>
                <td className={cx('text-right', pnlClass(upnl))}>
                  {fmtUsd(upnl, 2, true)}
                  <div className="text-[10px]">{fmtPct(roi)}</div>
                </td>
                <td className={cx('text-right', pnlClass(p.realisedPnl))}>{fmtUsd(p.realisedPnl, 2, true)}</td>
                <td>
                  <button className="text-left hover:text-brand" onClick={() => setTpslPos(p)}>
                    <div className="text-up text-[11px]">{p.takeProfit ? fmtPrice(p.takeProfit, p.symbol) : '—'}</div>
                    <div className="text-down text-[11px]">
                      {p.stopLoss ? fmtPrice(p.stopLoss, p.symbol) : '—'}
                      {p.trailingStop ? <span className="text-violet"> · трейл {fmtPrice(p.trailingStop, p.symbol)}</span> : ''}
                    </div>
                  </button>
                </td>
                <td>
                  <div className="flex items-center gap-1">
                    <button className="btn btn-sm" onClick={() => (ex.closePosition(MAIN, p.symbol), bump(true))}>
                      Рынок
                    </button>
                    <NumInput
                      value={limitPx[p.symbol] ?? ''}
                      placeholder="цена"
                      onChange={(v) => setLimitPx({ ...limitPx, [p.symbol]: v })}
                      className="!h-6 w-24 !px-1"
                    />
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const px = Number(limitPx[p.symbol]);
                        if (!px) return toast('warn', 'Укажите цену лимитного закрытия');
                        ex.closePosition(MAIN, p.symbol, px);
                        bump(true);
                      }}
                    >
                      Лимит
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TpSlModal pos={tpslPos} open={!!tpslPos} onClose={() => setTpslPos(null)} />
      <MarginModal pos={marginPos} open={!!marginPos} onClose={() => setMarginPos(null)} />
    </>
  );
}

function OrdersTable({ orders, conditional }: { orders: Order[]; conditional?: boolean }) {
  const ex = useSession((s) => s.ex)!;
  const [edit, setEdit] = useState<{ id: string; price: number | '' } | null>(null);
  if (!orders.length) return <Empty>Нет активных ордеров</Empty>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Контракт</th>
          <th>Тип</th>
          <th>Сторона</th>
          <th className="text-right">{conditional ? 'Срабатывание' : 'Цена'}</th>
          {conditional && <th className="text-right">Цена ордера</th>}
          <th className="text-right">Кол-во</th>
          <th className="text-right">Стоимость</th>
          <th>Опции</th>
          <th>Время</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const px = conditional ? o.triggerPrice! : o.price;
          const sym = o.category === 'option' ? undefined : o.symbol;
          return (
            <tr key={o.id}>
              <td className="font-semibold">{o.symbol}</td>
              <td>
                {o.stopOrderType === 'TakeProfit'
                  ? 'Take Profit'
                  : o.stopOrderType === 'StopLoss'
                    ? 'Stop Loss'
                    : o.stopOrderType === 'TrailingStop'
                      ? 'Трейлинг-стоп'
                      : conditional
                        ? `Условный ${o.orderType === 'Market' ? 'рыночный' : 'лимит'}`
                        : 'Лимит'}
              </td>
              <td className={o.side === 'Buy' ? 'text-up' : 'text-down'}>{o.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
              <td className="text-right">
                {edit?.id === o.id ? (
                  <div className="flex gap-1 justify-end">
                    <NumInput value={edit.price} onChange={(v) => setEdit({ id: o.id, price: v })} className="!h-6 w-24 !px-1" autoFocus />
                    <button
                      className="btn btn-sm btn-brand"
                      onClick={() => {
                        const err = ex.amendOrder(o.id, conditional ? { triggerPrice: Number(edit.price) } : { price: Number(edit.price) });
                        if (err) toast('error', err);
                        setEdit(null);
                        bump(true);
                      }}
                    >
                      ✓
                    </button>
                  </div>
                ) : (
                  <button className="hover:text-brand" title="Изменить" onClick={() => setEdit({ id: o.id, price: px })}>
                    {fmtPrice(px, sym)}
                    {o.stopOrderType === 'TrailingStop' && <span className="text-dim"> (Δ{fmtPrice(o.trailingDistance, sym)})</span>} ✎
                  </button>
                )}
              </td>
              {conditional && <td className="text-right">{o.orderType === 'Market' ? 'Рыночная' : fmtPrice(o.price, sym)}</td>}
              <td className="text-right">{o.closeOnTrigger && o.tag === 'tpsl' ? 'Вся позиция' : fmtQty(o.qty - o.filledQty, sym, o.category)}</td>
              <td className="text-right">{fmtUsd((o.qty - o.filledQty) * (px || ex.price(ex.dataSymbol(o.category, o.symbol))))}</td>
              <td className="text-[10px] text-muted">
                {[o.reduceOnly && 'Reduce', o.tif !== 'GTC' && o.orderType === 'Limit' && o.tif, o.takeProfit && `TP ${o.takeProfit}`, o.stopLoss && `SL ${o.stopLoss}`]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </td>
              <td className="text-muted">{fmtTime(o.createdTime)}</td>
              <td>
                <button className="btn btn-sm btn-ghost" onClick={() => (ex.cancelOrder(o.id), bump(true))}>
                  Отменить
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TradeBottomPanel({ category, symbol, onSymbol }: { category: Category; symbol: string; onSymbol: (s: string) => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const [tab, setTab] = useState<TabKey>(category === 'spot' ? 'balances' : 'positions');
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const acc = ex.main;
  const flt = (o: { symbol: string; category: string }) => o.category === category && (!onlyCurrent || o.symbol === symbol);
  const active = ex.activeOrders(MAIN).filter(flt);
  const orders = active.filter((o) => o.status !== 'Untriggered');
  const cond = active.filter((o) => o.status === 'Untriggered');
  const positions = Object.values(acc.positions).filter((p) => p.category === 'linear');
  const optCount = Object.values(acc.positions).filter((p) => p.category === 'option').length;
  const hist = ex.state.orderHistory.filter((o) => o.accountId === MAIN && flt(o)).slice(-300).reverse();
  const trades = ex.state.executions.filter((e) => e.accountId === MAIN && flt(e)).slice(-300).reverse();
  const closed = ex.state.closedPnl.filter((c) => c.accountId === MAIN && flt(c)).slice(-300).reverse();
  const tabs: { value: TabKey; label: string }[] =
    category === 'spot'
      ? [
          { value: 'balances', label: 'Балансы' },
          { value: 'orders', label: `Открытые ордера (${orders.length})` },
          { value: 'conditional', label: `Условные (${cond.length})` },
          { value: 'history', label: 'История ордеров' },
          { value: 'trades', label: 'История сделок' },
        ]
      : [
          { value: 'positions', label: `Позиции (${positions.length})` },
          { value: 'options', label: `Опционы (${optCount})` },
          { value: 'orders', label: `Текущие ордера (${orders.length})` },
          { value: 'conditional', label: `Условные / TP-SL (${cond.length})` },
          { value: 'history', label: 'История ордеров' },
          { value: 'trades', label: 'История сделок' },
          { value: 'closed', label: 'Закрытый PnL' },
        ];
  return (
    <div className="h-full flex flex-col bg-panel rounded-lg overflow-hidden">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={tabs}
        right={
          <>
            <Check checked={onlyCurrent} onChange={setOnlyCurrent}>
              <span className="text-muted text-[11px]">Только {symbol}</span>
            </Check>
            {tab === 'positions' && positions.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => (ex.closeAllPositions(MAIN), bump(true))}>
                Закрыть все
              </button>
            )}
            {(tab === 'orders' || tab === 'conditional') && active.length > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  for (const o of tab === 'orders' ? orders : cond) ex.cancelOrder(o.id);
                  bump(true);
                }}
              >
                Отменить все
              </button>
            )}
            {tab === 'closed' && closed.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => downloadText('closed-pnl.csv', toCsv(closed as any), 'text/csv')}>
                CSV
              </button>
            )}
            {tab === 'trades' && trades.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => downloadText('trades.csv', toCsv(trades as any), 'text/csv')}>
                CSV
              </button>
            )}
          </>
        }
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'positions' && <PositionsTable onSymbol={onSymbol} onlyCurrent={onlyCurrent} symbol={symbol} />}
        {tab === 'options' && <OptionPositions base={onlyCurrent ? getAsset(symbol).base : undefined} />}
        {tab === 'orders' && <OrdersTable orders={orders} />}
        {tab === 'conditional' && <OrdersTable orders={cond} conditional />}
        {tab === 'balances' && <BalancesTable />}
        {tab === 'history' &&
          (hist.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Символ</th>
                  <th>Тип</th>
                  <th>Сторона</th>
                  <th className="text-right">Цена</th>
                  <th className="text-right">Ср. цена исп.</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Исполнено</th>
                  <th>Статус</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {hist.map((o) => (
                  <tr key={o.id}>
                    <td className="text-muted">{fmtTime(o.updatedTime)}</td>
                    <td className="font-semibold">{o.symbol}</td>
                    <td>
                      {o.orderType === 'Market' ? 'Рыночный' : 'Лимит'}
                      {o.stopOrderType ? ` · ${o.stopOrderType}` : ''}
                    </td>
                    <td className={o.side === 'Buy' ? 'text-up' : 'text-down'}>{o.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
                    <td className="text-right">{o.orderType === 'Market' ? '—' : fmtPrice(o.price, o.category === 'option' ? undefined : o.symbol)}</td>
                    <td className="text-right">{o.filledQty ? fmtPrice(o.avgPrice, o.category === 'option' ? undefined : o.symbol) : '—'}</td>
                    <td className="text-right">{fmtQty(o.qty, o.category === 'option' ? undefined : o.symbol, o.category)}</td>
                    <td className="text-right">{fmtQty(o.filledQty, o.category === 'option' ? undefined : o.symbol, o.category)}</td>
                    <td>
                      <Badge color={o.status === 'Filled' ? 'up' : o.status === 'Rejected' ? 'down' : 'muted'}>{ORDER_STATUS[o.status] ?? o.status}</Badge>
                      {o.rejectReason && <div className="text-[10px] text-dim max-w-[260px] truncate" title={o.rejectReason}>{o.rejectReason}</div>}
                    </td>
                    <td className="text-muted">{o.tag === 'tpsl' ? 'TP/SL' : o.tag === 'user' ? 'Вручную' : o.tag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>История пуста</Empty>
          ))}
        {tab === 'trades' &&
          (trades.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Символ</th>
                  <th>Тип</th>
                  <th>Сторона</th>
                  <th className="text-right">Цена</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Стоимость</th>
                  <th className="text-right">Комиссия</th>
                  <th>Роль</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((e) => (
                  <tr key={e.id}>
                    <td className="text-muted">{fmtTime(e.time)}</td>
                    <td className="font-semibold">{e.symbol}</td>
                    <td>{e.execType === 'Trade' ? 'Сделка' : e.execType === 'Funding' ? 'Funding' : e.execType === 'Liquidation' ? 'Ликвидация' : e.execType === 'Delivery' ? 'Поставка' : e.execType}</td>
                    <td className={e.side === 'Buy' ? 'text-up' : 'text-down'}>{e.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
                    <td className="text-right">{fmtPrice(e.price, e.category === 'option' ? undefined : e.symbol)}</td>
                    <td className="text-right">{fmtQty(e.qty, e.category === 'option' ? undefined : e.symbol, e.category)}</td>
                    <td className="text-right">{fmtUsd(e.qty * e.price)}</td>
                    <td className={cx('text-right', e.execType === 'Funding' ? pnlClass(-e.fee) : '')}>{fmtNum(e.fee, 4)}</td>
                    <td className="text-muted">{e.execType === 'Trade' ? (e.isMaker ? 'Мейкер' : 'Тейкер') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Сделок пока нет</Empty>
          ))}
        {tab === 'closed' &&
          (closed.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Контракт</th>
                  <th>Направление</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Цена входа</th>
                  <th className="text-right">Цена выхода</th>
                  <th className="text-right">Закрытый PnL</th>
                  <th className="text-right">Комиссии</th>
                  <th className="text-right">Funding</th>
                  <th>Тип</th>
                  <th>Открыта</th>
                  <th>Закрыта</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((c) => (
                  <tr key={c.id}>
                    <td className="font-semibold">{c.symbol}</td>
                    <td className={c.side === 'Buy' ? 'text-up' : 'text-down'}>{c.side === 'Buy' ? 'Лонг' : 'Шорт'}</td>
                    <td className="text-right">{fmtQty(c.qty, c.symbol)}</td>
                    <td className="text-right">{fmtPrice(c.entryPrice, c.symbol)}</td>
                    <td className="text-right">{fmtPrice(c.exitPrice, c.symbol)}</td>
                    <td className={cx('text-right font-semibold', pnlClass(c.closedPnl))}>{fmtUsd(c.closedPnl, 2, true)}</td>
                    <td className="text-right text-muted">{fmtNum(c.openFee + c.closeFee, 4)}</td>
                    <td className={cx('text-right', pnlClass(c.funding))}>{fmtNum(c.funding, 4)}</td>
                    <td>
                      <Badge color={c.type === 'Liquidation' ? 'down' : c.type === 'TP' ? 'up' : c.type === 'SL' ? 'brand' : 'muted'}>{c.type}</Badge>
                    </td>
                    <td className="text-muted">{fmtTime(c.openTime)}</td>
                    <td className="text-muted">{fmtTime(c.closeTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Закрытых сделок пока нет</Empty>
          ))}
      </div>
    </div>
  );
}

function BalancesTable() {
  const ex = useSession((s) => s.ex)!;
  const acc = ex.main;
  const coins = Object.entries(acc.spot).filter(([, q]) => q > 0);
  const avail = ex.available(acc);
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Монета</th>
          <th className="text-right">Баланс</th>
          <th className="text-right">Доступно</th>
          <th className="text-right">Стоимость (USDT)</th>
          <th className="text-right">Ср. цена покупки</th>
          <th className="text-right">Нереализ. PnL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="font-semibold">USDT</td>
          <td className="text-right">{fmtUsd(acc.walletBalance)}</td>
          <td className="text-right">{fmtUsd(Math.max(0, avail))}</td>
          <td className="text-right">{fmtUsd(acc.walletBalance)}</td>
          <td className="text-right">—</td>
          <td className="text-right">—</td>
          <td />
        </tr>
        {coins.map(([coin, q]) => {
          const sym = `${coin}USDT`;
          const px = ex.price(sym);
          const cost = acc.spotCost[coin] || 0;
          const pnl = q * px - cost;
          return (
            <tr key={coin}>
              <td className="font-semibold">{coin}</td>
              <td className="text-right">{fmtQty(q, sym, 'spot')}</td>
              <td className="text-right">{fmtQty(q, sym, 'spot')}</td>
              <td className="text-right">{fmtUsd(q * px)}</td>
              <td className="text-right">{fmtPrice(cost / q, sym)}</td>
              <td className={cx('text-right', pnlClass(pnl))}>
                {fmtUsd(pnl, 2, true)} ({fmtPct(cost ? pnl / cost : 0)})
              </td>
              <td>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    ex.placeOrder({ category: 'spot', symbol: sym, side: 'Sell', orderType: 'Market', qty: q });
                    bump(true);
                  }}
                >
                  Продать всё
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
