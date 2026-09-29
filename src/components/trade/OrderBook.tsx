import { useState } from 'react';
import { getAsset, roundToStep } from '../../data/assets';
import { hashStr, mulberry32 } from '../../data/providers/synthetic';
import { niceNumber } from '../../engine/options';
import { useSession, useTick } from '../../store/session';
import { fmtNum, fmtPrice, fmtQty, fmtTime } from '../../lib/format';
import { cx } from '../ui';

const LEVELS = 13;

/**
 * Стакан. Исторических данных стакана нет, поэтому глубина моделируется
 * детерминированно вокруг цены с объёмами, пропорциональными объёму свечей.
 */
export function OrderBook({ symbol, onPrice }: { symbol: string; onPrice?: (p: number) => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  const [group, setGroup] = useState(1);
  const px = ex.price(symbol);
  const spec = getAsset(symbol);
  const s = ex.market.series.get(symbol);
  const end = ex.market.lastClosedIndex(symbol, ex.now);
  let avgVol = 1;
  if (s && end > 0) {
    let v = 0;
    let n = 0;
    for (let i = Math.max(0, end - 30); i <= end; i++) {
      v += s.v[i];
      n++;
    }
    avgVol = v / Math.max(1, n);
  }
  const step = Math.max(spec.tickSize, niceNumber(px * 0.00008)) * group;
  const rnd = mulberry32(hashStr(`${symbol}:${ex.now}`));
  const baseSize = Math.max(spec.minQty, avgVol / 25);
  const asks: { p: number; q: number }[] = [];
  const bids: { p: number; q: number }[] = [];
  const firstAsk = roundToStep(Math.floor(px / step) * step + step, spec.tickSize);
  const firstBid = roundToStep(Math.ceil(px / step) * step - step, spec.tickSize);
  for (let i = 0; i < LEVELS; i++) {
    asks.push({ p: roundToStep(firstAsk + i * step, spec.tickSize), q: roundToStep(baseSize * (0.2 + rnd() * 1.6) * (1 + i * 0.12), spec.qtyStep) || spec.qtyStep });
    bids.push({ p: roundToStep(firstBid - i * step, spec.tickSize), q: roundToStep(baseSize * (0.2 + rnd() * 1.6) * (1 + i * 0.12), spec.qtyStep) || spec.qtyStep });
  }
  let cum = 0;
  const askCum = asks.map((a) => (cum += a.q));
  cum = 0;
  const bidCum = bids.map((b) => (cum += b.q));
  const maxCum = Math.max(askCum[LEVELS - 1], bidCum[LEVELS - 1]);
  const prevClose = s && end > 0 ? s.c[end - 1] : px;
  const bidTot = bidCum[LEVELS - 1];
  const askTot = askCum[LEVELS - 1];
  return (
    <div className="h-full flex flex-col bg-panel rounded-lg overflow-hidden">
      <div className="flex items-center border-b border-line px-3 shrink-0">
        <div className={cx('tab', tab === 'book' && 'active')} onClick={() => setTab('book')}>
          Стакан
        </div>
        <div className={cx('tab', tab === 'trades' && 'active')} onClick={() => setTab('trades')}>
          Сделки
        </div>
        {tab === 'book' && (
          <select className="ml-auto bg-transparent text-muted outline-none text-[11px]" value={group} onChange={(e) => setGroup(Number(e.target.value))}>
            {[1, 2, 5, 10, 50].map((g) => (
              <option key={g} value={g}>
                ×{g}
              </option>
            ))}
          </select>
        )}
      </div>
      {tab === 'book' ? (
        <div className="flex-1 min-h-0 flex flex-col text-[11px] num">
          <div className="grid grid-cols-3 px-3 py-1 text-muted text-[10px]">
            <span>Цена (USDT)</span>
            <span className="text-right">Кол-во ({spec.base})</span>
            <span className="text-right">Всего</span>
          </div>
          <div className="flex-1 min-h-0 flex flex-col justify-end overflow-hidden">
            {asks
              .map((a, i) => ({ ...a, c: askCum[i] }))
              .reverse()
              .map((a) => (
                <BookRow key={a.p} side="ask" p={a.p} q={a.q} c={a.c} max={maxCum} symbol={symbol} onClick={() => onPrice?.(a.p)} />
              ))}
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 border-y border-line">
            <span className={cx('text-[15px] font-bold', px >= prevClose ? 'text-up' : 'text-down')}>
              {fmtPrice(px, symbol)} {px >= prevClose ? '↑' : '↓'}
            </span>
            <span className="text-muted text-[10px] ml-auto">спред {fmtPrice(firstAsk - firstBid, symbol)}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {bids.map((b, i) => (
              <BookRow key={b.p} side="bid" p={b.p} q={b.q} c={bidCum[i]} max={maxCum} symbol={symbol} onClick={() => onPrice?.(b.p)} />
            ))}
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 text-[10px]">
            <span className="text-up">B {((bidTot / (bidTot + askTot)) * 100).toFixed(0)}%</span>
            <div className="flex-1 h-1 rounded bg-down/60 overflow-hidden">
              <div className="h-full bg-up" style={{ width: `${(bidTot / (bidTot + askTot)) * 100}%` }} />
            </div>
            <span className="text-down">{((askTot / (bidTot + askTot)) * 100).toFixed(0)}% S</span>
          </div>
          <div className="px-3 pb-1 text-[9px] text-dim">Глубина смоделирована (стакан в истории недоступен)</div>
        </div>
      ) : (
        <RecentTrades symbol={symbol} />
      )}
    </div>
  );
}

function BookRow({ side, p, q, c, max, symbol, onClick }: { side: 'ask' | 'bid'; p: number; q: number; c: number; max: number; symbol: string; onClick: () => void }) {
  return (
    <div className="relative grid grid-cols-3 px-3 h-[18px] items-center cursor-pointer hover:bg-panel3" onClick={onClick}>
      <div className={cx('absolute inset-y-0 right-0', side === 'ask' ? 'bg-down/10' : 'bg-up/10')} style={{ width: `${(c / max) * 100}%` }} />
      <span className={cx('relative', side === 'ask' ? 'text-down' : 'text-up')}>{fmtPrice(p, symbol)}</span>
      <span className="relative text-right">{fmtQty(q, symbol)}</span>
      <span className="relative text-right text-muted">{fmtNum(c, 2, { compact: true })}</span>
    </div>
  );
}

function RecentTrades({ symbol }: { symbol: string }) {
  const ex = useSession((s) => s.ex)!;
  const s = ex.market.series.get(symbol);
  const end = ex.market.lastClosedIndex(symbol, ex.now);
  const rows: { t: number; p: number; q: number; up: boolean }[] = [];
  if (s) {
    for (let i = end; i >= Math.max(0, end - 12) && rows.length < 40; i--) {
      const pts = s.c[i] >= s.o[i] ? [s.c[i], s.h[i], s.l[i], s.o[i]] : [s.c[i], s.l[i], s.h[i], s.o[i]];
      const dt = ex.market.dt / 4;
      pts.forEach((p, k) => {
        const prev = pts[k + 1] ?? (i > 0 ? s.c[i - 1] : p);
        rows.push({ t: s.t[i] + ex.market.dt - k * dt, p, q: s.v[i] / 4, up: p >= prev });
      });
    }
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto text-[11px] num">
      <div className="grid grid-cols-3 px-3 py-1 text-muted text-[10px] sticky top-0 bg-panel">
        <span>Цена</span>
        <span className="text-right">Кол-во</span>
        <span className="text-right">Время</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-3 px-3 h-[18px] items-center">
          <span className={r.up ? 'text-up' : 'text-down'}>{fmtPrice(r.p, symbol)}</span>
          <span className="text-right">{fmtNum(r.q, 3, { compact: true })}</span>
          <span className="text-right text-muted">{fmtTime(r.t).slice(11)}</span>
        </div>
      ))}
      <div className="px-3 py-1 text-[9px] text-dim">Лента восстановлена по OHLC базовых свечей</div>
    </div>
  );
}
