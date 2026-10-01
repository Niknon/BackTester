import { useRef } from 'react';
import { DAY } from '../../data/intervals';
import { getAsset } from '../../data/assets';
import { lowerBound } from '../../data/types';
import { useSession, useTick } from '../../store/session';
import { fmtCountdown, fmtNum, fmtPct, fmtPrice } from '../../lib/format';
import { cx } from '../ui';
import { SymbolSelector } from './SymbolSelector';

export function TickerBar({ symbol, onSymbol, spot }: { symbol: string; onSymbol: (s: string) => void; spot?: boolean }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const prevPx = useRef<number>(0);
  const s = ex.market.series.get(symbol);
  const px = ex.price(symbol);
  const now = ex.now;
  let hi = -Infinity;
  let lo = Infinity;
  let vol = 0;
  let turnover = 0;
  if (s) {
    const end = ex.market.lastClosedIndex(symbol, now);
    const from = lowerBound(s.t, s.length, now - DAY);
    for (let i = from; i <= end; i++) {
      hi = Math.max(hi, s.h[i]);
      lo = Math.min(lo, s.l[i]);
      vol += s.v[i];
      turnover += s.v[i] * s.c[i];
    }
  }
  const p24 = ex.market.closeAgo(symbol, now, DAY);
  const ch = p24 ? px - p24 : NaN;
  const dir = px > prevPx.current ? 'up' : px < prevPx.current ? 'down' : '';
  prevPx.current = px;
  const nf = ex.market.nextFunding(symbol, now);
  const lf = ex.market.lastFunding(symbol, now);
  const nextFundingT = nf?.t ?? Math.ceil((now + 1) / (8 * 3600_000)) * 8 * 3600_000;
  const rate = lf?.rate ?? ex.config.defaultFundingRate;
  return (
    <div className="flex items-center gap-6 px-3 h-14 bg-panel rounded-lg shrink-0 overflow-x-auto">
      <SymbolSelector symbol={symbol} onSelect={onSymbol} spot={spot} />
      <div className="flex flex-col leading-tight">
        <span className={cx('num text-[18px] font-bold', ch >= 0 ? 'text-up' : 'text-down')}>{fmtPrice(px, symbol)}</span>
        <span className={cx('text-[10px] num', dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-muted')}>{spot ? 'Спот' : 'Mark ≈ Last'}</span>
      </div>
      <Item label="Изменение 24ч" className={ch >= 0 ? 'text-up' : 'text-down'} value={`${fmtPrice(ch, symbol)} ${p24 ? fmtPct(ch / p24) : ''}`} />
      <Item label="Макс. 24ч" value={fmtPrice(hi, symbol)} />
      <Item label="Мин. 24ч" value={fmtPrice(lo, symbol)} />
      <Item label="Объём 24ч" value={fmtNum(vol, 2, { compact: true })} />
      <Item label="Оборот 24ч (USDT)" value={fmtNum(turnover, 2, { compact: true })} />
      {!spot && !getAsset(symbol).spotOnly && (
        <Item
          label="Funding / до выплаты"
          value={
            <span>
              <span className={rate >= 0 ? 'text-brand' : 'text-info'}>{(rate * 100).toFixed(4)}%</span>
              <span className="text-muted"> / {fmtCountdown(nextFundingT - now)}</span>
            </span>
          }
        />
      )}
      <Item label="Источник данных" value={<span className="text-muted">{ex.market.providers.get(symbol) ?? '—'}</span>} />
    </div>
  );
}

function Item({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col leading-tight shrink-0">
      <span className="text-[10px] text-muted">{label}</span>
      <span className={cx('num text-[12px]', className)}>{value}</span>
    </div>
  );
}
