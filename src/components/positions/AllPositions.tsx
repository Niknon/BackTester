import { useState } from 'react';
import { getAsset, roundToStep, spotQtyStep } from '../../data/assets';
import { MAIN } from '../../engine/exchange';
import { optionQtyStep } from '../../engine/options';
import { BOT_LABELS } from '../../engine/bots/types';
import type { Exchange } from '../../engine/exchange';
import type { Position } from '../../engine/types';
import { bump, toast, useSession, useTick } from '../../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, pnlClass } from '../../lib/format';
import { Badge, cx, Empty, usePersistent } from '../ui';
import { TpSlModal } from '../trade/BottomPanel';
import { dte } from '../options/OptionPositions';

type Kind = 'perp' | 'option' | 'spot' | 'bot';
type Filter = 'all' | Kind;

const KIND_LABEL: Record<Kind, string> = { perp: 'Фьючерс', option: 'Опцион', spot: 'Спот', bot: 'Бот' };
const KIND_COLOR: Record<Kind, 'brand' | 'info' | 'violet' | 'muted'> = { perp: 'brand', option: 'violet', spot: 'info', bot: 'muted' };

interface Row {
  key: string;
  kind: Kind;
  symbol: string;
  title: string;
  sub?: string;
  side: 'long' | 'short' | 'hold' | 'bot';
  qty?: number;
  qtyText: string;
  value: number;
  entry?: string;
  mark?: string;
  upnl: number;
  roi: number;
  risk?: React.ReactNode;
  pos?: Position;
  botId?: string;
}

/** Все открытые позиции: перпетуалы, опционы, спот-монеты и активные боты. */
export function collectPositions(ex: Exchange): Row[] {
  const acc = ex.main;
  const rows: Row[] = [];
  for (const p of Object.values(acc.positions)) {
    if (p.size === 0) continue;
    if (p.category === 'linear') {
      const mark = ex.price(p.symbol);
      const upnl = ex.unrealisedPnl(p);
      const margin = (Math.abs(p.size) * p.avgPrice) / p.leverage;
      const liq = ex.liqPrice(acc, p);
      rows.push({
        key: 'L' + p.symbol,
        kind: 'perp',
        symbol: p.symbol,
        title: p.symbol,
        sub: `${p.marginMode === 'cross' ? 'Кросс' : 'Изолир.'} ${fmtNum(p.leverage, p.leverage % 1 ? 2 : 0)}x`,
        side: p.size > 0 ? 'long' : 'short',
        qty: p.size,
        qtyText: `${fmtQty(p.size, p.symbol)} ${getAsset(p.symbol).base}`,
        value: Math.abs(p.size) * mark,
        entry: fmtPrice(p.avgPrice, p.symbol),
        mark: fmtPrice(mark, p.symbol),
        upnl,
        roi: margin > 0 ? upnl / margin : 0,
        risk: (
          <span>
            Ликв. <span className="text-brand">{liq ? fmtPrice(liq, p.symbol) : '—'}</span>
            {(p.takeProfit || p.stopLoss) && (
              <span className="block text-[10px]">
                <span className="text-up">TP {p.takeProfit ? fmtPrice(p.takeProfit, p.symbol) : '—'}</span> · <span className="text-down">SL {p.stopLoss ? fmtPrice(p.stopLoss, p.symbol) : '—'}</span>
              </span>
            )}
          </span>
        ),
        pos: p,
      });
    } else if (p.category === 'option') {
      const q = ex.optionQuote(p.symbol);
      const inst = ex.optionInstrument(p.symbol);
      const mark = q?.mark ?? 0;
      const upnl = p.size * (mark - p.avgPrice);
      const cost = Math.abs(p.size * p.avgPrice);
      rows.push({
        key: 'O' + p.symbol,
        kind: 'option',
        symbol: p.symbol,
        title: p.symbol.replace(/-USDT$/, ''),
        sub: inst ? `${inst.type === 'C' ? 'Колл' : 'Пут'} · страйк ${fmtNum(inst.strike, 0)}` : undefined,
        side: p.size > 0 ? 'long' : 'short',
        qty: p.size,
        qtyText: fmtNum(p.size, 3),
        value: mark * p.size,
        entry: fmtNum(p.avgPrice, 4),
        mark: fmtNum(mark, 4),
        upnl,
        roi: cost > 0 ? upnl / cost : 0,
        risk: inst ? (
          <span>
            До эксп. {dte(inst.expiry, ex.now)}
            <span className="block text-[10px] text-muted">Δ {fmtNum((q?.greeks.delta ?? 0) * p.size, 3)} · Θ {fmtNum((q?.greeks.theta ?? 0) * p.size, 2)}/д</span>
          </span>
        ) : undefined,
        pos: p,
      });
    }
  }
  for (const [coin, q] of Object.entries(acc.spot)) {
    if (!(q > 0)) continue;
    const sym = `${coin}USDT`;
    const px = ex.price(sym);
    const cost = acc.spotCost[coin] || 0;
    const value = q * (Number.isFinite(px) ? px : 0);
    const spec = getAsset(sym);
    rows.push({
      key: 'S' + coin,
      kind: 'spot',
      symbol: sym,
      title: coin,
      sub: spec.group === 'xstock' ? `xStock · ${spec.name}` : spec.group === 'commodity' ? spec.name : 'Спот',
      side: 'hold',
      qty: q,
      qtyText: `${fmtQty(q, sym, 'spot')} ${coin}`,
      value,
      entry: cost ? fmtPrice(cost / q, sym) : '—',
      mark: fmtPrice(px, sym),
      upnl: cost ? value - cost : 0,
      roi: cost ? (value - cost) / cost : 0,
    });
  }
  for (const b of Object.values(ex.state.bots)) {
    if (b.status !== 'running' && b.status !== 'waiting') continue;
    const s = ex.botSummary(b);
    const bacc = ex.botAccount(b);
    const legs = Object.values(bacc.positions)
      .filter((p) => p.size !== 0)
      .map((p) => `${p.size > 0 ? '▲' : '▼'}${fmtQty(Math.abs(p.size), p.symbol)} ${getAsset(p.symbol).base}`);
    const coins = Object.entries(bacc.spot)
      .filter(([, q]) => q > 0)
      .map(([c, q]) => `${fmtQty(q, `${c}USDT`, 'spot')} ${c}`);
    const held = [...legs, ...coins];
    rows.push({
      key: 'B' + b.id,
      kind: 'bot',
      symbol: b.symbols[0] ?? '',
      title: b.name,
      sub: BOT_LABELS[b.type],
      side: 'bot',
      qtyText: held.length ? held.join(', ') : 'без позиции',
      value: s.equity,
      entry: `${fmtUsd(b.investment)} инв.`,
      upnl: s.pnl,
      roi: s.roi,
      risk: <span className={b.status === 'waiting' ? 'text-brand' : 'text-up'}>{b.status === 'waiting' ? 'ждёт цены запуска' : 'работает'}</span>,
      botId: b.id,
    });
  }
  return rows;
}

export function positionsCount(ex: Exchange) {
  const acc = ex.main;
  let n = 0;
  for (const p of Object.values(acc.positions)) if (p.size !== 0) n++;
  for (const q of Object.values(acc.spot)) if (q > 0) n++;
  for (const b of Object.values(ex.state.bots)) if (b.status === 'running' || b.status === 'waiting') n++;
  return n;
}

/** Частичное (или полное) закрытие позиции по рынку. */
function closePart(ex: Exchange, row: Row, frac: number) {
  if (row.kind === 'bot') return;
  if (row.kind === 'spot') {
    const q = row.qty ?? 0;
    const qty = frac >= 1 ? q : roundToStep(q * frac, spotQtyStep(row.symbol), 'floor');
    if (!(qty > 0)) return toast('warn', 'Слишком маленькое количество');
    const o = ex.placeOrder({ category: 'spot', symbol: row.symbol, side: 'Sell', orderType: 'Market', qty });
    if (o.status === 'Rejected') toast('error', 'Продажа отклонена', o.rejectReason);
    return bump(true);
  }
  const pos = row.pos!;
  if (frac >= 1) {
    ex.closePosition(MAIN, pos.symbol);
    return bump(true);
  }
  const step = row.kind === 'option' ? optionQtyStep(ex.price(ex.optionInstrument(pos.symbol)?.underlying ?? '')) : getAsset(pos.symbol).qtyStep;
  const qty = roundToStep(Math.abs(pos.size) * frac, step, 'floor');
  if (!(qty > 0)) return toast('warn', 'Слишком маленькая позиция для частичного закрытия');
  const o = ex.placeOrder({ category: pos.category, symbol: pos.symbol, side: pos.size > 0 ? 'Sell' : 'Buy', orderType: 'Market', qty, reduceOnly: true });
  if (o.status === 'Rejected') toast('error', 'Закрытие отклонено', o.rejectReason);
  bump(true);
}

export function AllPositions({ onNavigate }: { onNavigate?: () => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const set = useSession((s) => s.set);
  const [filter, setFilter] = usePersistent<Filter>('bt-allpos-filter', 'all', ['all', 'perp', 'option', 'spot', 'bot']);
  const [tpsl, setTpsl] = useState<Position | null>(null);
  const all = collectPositions(ex);
  const rows = filter === 'all' ? all : all.filter((r) => r.kind === filter);
  const count = (k: Kind) => all.filter((r) => r.kind === k).length;
  const eq = ex.totalEquity();
  const upnl = all.filter((r) => r.kind !== 'bot').reduce((s, r) => s + r.upnl, 0);
  const botsPnl = all.filter((r) => r.kind === 'bot').reduce((s, r) => s + r.upnl, 0);
  const long = all.filter((r) => r.kind === 'perp' || r.kind === 'spot').reduce((s, r) => s + (r.side === 'short' ? 0 : r.value), 0);
  const short = all.filter((r) => r.kind === 'perp' && r.side === 'short').reduce((s, r) => s + r.value, 0);

  const go = (r: Row) => {
    if (r.kind === 'perp') set({ page: 'trade', symbol: r.symbol });
    else if (r.kind === 'spot') set({ page: 'spot', symbol: r.symbol });
    else if (r.kind === 'option') set({ page: 'options', optionBase: ex.optionInstrument(r.symbol)?.base ?? 'BTC' });
    else set({ page: 'bots', focusBot: r.botId ?? null });
    onNavigate?.();
  };

  const chips: [Filter, string][] = [
    ['all', `Все (${all.length})`],
    ['perp', `Фьючерсы (${count('perp')})`],
    ['option', `Опционы (${count('option')})`],
    ['spot', `Спот (${count('spot')})`],
    ['bot', `Боты (${count('bot')})`],
  ];

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line flex-wrap">
        {chips.map(([k, l]) => (
          <button key={k} className={cx('chip', filter === k && 'active')} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-4 text-[11px] num">
          <span>
            <span className="text-muted">Капитал </span>
            {fmtUsd(eq.total)}
          </span>
          <span>
            <span className="text-muted">Нереализ. PnL </span>
            <span className={pnlClass(upnl)}>{fmtUsd(upnl, 2, true)}</span>
          </span>
          {count('bot') > 0 && (
            <span>
              <span className="text-muted">PnL ботов </span>
              <span className={pnlClass(botsPnl)}>{fmtUsd(botsPnl, 2, true)}</span>
            </span>
          )}
          <span title="Суммарная стоимость лонгов (перпетуалы + спот) и шортов">
            <span className="text-muted">Лонг / шорт </span>
            <span className="text-up">{fmtUsd(long, 0)}</span> / <span className="text-down">{fmtUsd(short, 0)}</span>
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!rows.length ? (
          <Empty>{filter === 'all' ? 'Нет открытых позиций, монет и активных ботов' : 'Нет позиций этого типа'}</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Тип</th>
                <th>Инструмент</th>
                <th className="text-right">Кол-во / позиция</th>
                <th className="text-right">Стоимость</th>
                <th className="text-right">Вход</th>
                <th className="text-right">Текущая</th>
                <th className="text-right">Нереализ. PnL (ROI)</th>
                <th>Риск / детали</th>
                <th className="text-right">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <Badge color={KIND_COLOR[r.kind]}>{KIND_LABEL[r.kind]}</Badge>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className={cx('w-1 h-7 rounded shrink-0', r.side === 'long' || r.side === 'hold' ? 'bg-up' : r.side === 'short' ? 'bg-down' : 'bg-info')} />
                      <div className="min-w-0">
                        <button className="font-semibold hover:text-brand text-left" onClick={() => go(r)} title="Открыть">
                          {r.title}
                        </button>
                        <div className="text-[10px] text-muted truncate max-w-[260px]">
                          {r.side === 'long' && <span className="text-up">Лонг · </span>}
                          {r.side === 'short' && <span className="text-down">Шорт · </span>}
                          {r.sub}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className={cx('text-right', r.side === 'long' ? 'text-up' : r.side === 'short' ? 'text-down' : '', r.kind === 'bot' && 'text-[11px] max-w-[220px] truncate')} title={r.qtyText}>
                    {r.qtyText}
                  </td>
                  <td className="text-right">{fmtUsd(r.value)}</td>
                  <td className="text-right text-muted">{r.entry ?? '—'}</td>
                  <td className="text-right">{r.mark ?? '—'}</td>
                  <td className={cx('text-right', pnlClass(r.upnl))}>
                    {fmtUsd(r.upnl, 2, true)}
                    <div className="text-[10px]">{fmtPct(r.roi)}</div>
                  </td>
                  <td className="text-[11px]">{r.risk ?? <span className="text-dim">—</span>}</td>
                  <td>
                    <div className="flex gap-1 justify-end">
                      {r.kind === 'bot' ? (
                        <>
                          <button className="btn btn-sm btn-ghost" onClick={() => go(r)}>
                            Открыть
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              ex.stopBot(r.botId!);
                              bump(true);
                            }}
                          >
                            Остановить
                          </button>
                        </>
                      ) : (
                        <>
                          {r.kind === 'perp' && (
                            <button className="btn btn-sm btn-ghost" onClick={() => setTpsl(r.pos!)} title="Take Profit / Stop Loss">
                              TP/SL
                            </button>
                          )}
                          <button className="btn btn-sm btn-ghost" onClick={() => closePart(ex, r, 0.25)} title="Закрыть 25% по рынку">
                            25%
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => closePart(ex, r, 0.5)} title="Закрыть 50% по рынку">
                            50%
                          </button>
                          <button className="btn btn-sm" onClick={() => closePart(ex, r, 1)}>
                            {r.kind === 'spot' ? 'Продать' : 'Закрыть'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <TpSlModal pos={tpsl} open={!!tpsl} onClose={() => setTpsl(null)} />
    </div>
  );
}

/** Глобальная выезжающая панель «Все позиции» — доступна с любой страницы. */
export function PositionsDrawer() {
  const open = useSession((s) => s.positionsOpen);
  const set = useSession((s) => s.set);
  const hasEx = useSession((s) => !!s.ex);
  if (!open || !hasEx) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" onMouseDown={(e) => e.target === e.currentTarget && set({ positionsOpen: false })}>
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />
      <div className="relative h-full w-[min(1180px,96vw)] bg-panel border-l border-line shadow-2xl flex flex-col">
        <div className="flex items-center px-4 h-11 border-b border-line shrink-0">
          <div className="font-semibold text-[14px]">Все позиции</div>
          <span className="ml-3 text-[11px] text-muted">фьючерсы, опционы, спот (вкл. xStocks) и боты — в одном месте · симуляция продолжает идти</span>
          <button className="ml-auto btn btn-ghost btn-sm" onClick={() => set({ positionsOpen: false })} title="Закрыть (Esc)">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <AllPositions onNavigate={() => set({ positionsOpen: false })} />
        </div>
      </div>
    </div>
  );
}

export function PositionsButton() {
  useTick();
  const ex = useSession((s) => s.ex);
  const open = useSession((s) => s.positionsOpen);
  const set = useSession((s) => s.set);
  if (!ex) return null;
  const n = positionsCount(ex);
  return (
    <button className={cx('btn btn-sm', open ? 'btn-brand' : 'btn-ghost')} onClick={() => set({ positionsOpen: !open })} title="Все позиции (P)">
      Позиции <span className={cx('num rounded px-1 text-[11px]', n ? 'bg-brand/20 text-brand' : 'text-dim')}>{n}</span>
    </button>
  );
}
