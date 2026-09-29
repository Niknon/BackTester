import { useState } from 'react';
import { getAsset, maintenanceMarginRate } from '../../data/assets';
import { useSession } from '../../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtUsd, pnlClass } from '../../lib/format';
import { Modal, NumInput, Row, Segmented } from '../ui';

/** Калькулятор как у Bybit: PnL, цена цели по ROI, цена ликвидации (изолированная). */
export function Calculator({ symbol, open, onClose }: { symbol: string; open: boolean; onClose: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const spec = getAsset(symbol);
  const [tab, setTab] = useState<'pnl' | 'target' | 'liq'>('pnl');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [lev, setLev] = useState<number | ''>(10);
  const [entry, setEntry] = useState<number | ''>(() => ex.price(symbol));
  const [exit, setExit] = useState<number | ''>('');
  const [qty, setQty] = useState<number | ''>(spec.minQty * 10);
  const [roi, setRoi] = useState<number | ''>(50);
  const [extra, setExtra] = useState<number | ''>(0);
  const dir = side === 'long' ? 1 : -1;
  const L = Number(lev) || 1;
  const E = Number(entry) || 0;
  const Q = Number(qty) || 0;
  const im = (Q * E) / L;
  const taker = ex.config.fees.linearTaker;
  const mmr = maintenanceMarginRate(symbol) + taker;
  let body: React.ReactNode = null;
  if (tab === 'pnl') {
    const X = Number(exit) || 0;
    const pnl = Q * (X - E) * dir;
    const fees = Q * (E + X) * taker;
    body = (
      <>
        <NumInput label="Цена выхода" value={exit} onChange={setExit} suffix="USDT" />
        <div className="bg-panel2 rounded-md px-3 py-2">
          <Row label="Начальная маржа" value={`${fmtUsd(im)} USDT`} />
          <Row label="PnL (без комиссий)" value={<span className={pnlClass(pnl)}>{fmtUsd(pnl, 2, true)} USDT</span>} />
          <Row label="Комиссии (тейкер ×2)" value={`${fmtUsd(fees)} USDT`} />
          <Row label="PnL после комиссий" value={<span className={pnlClass(pnl - fees)}>{fmtUsd(pnl - fees, 2, true)} USDT</span>} />
          <Row label="ROI" value={<span className={pnlClass(pnl)}>{im > 0 ? fmtPct(pnl / im) : '—'}</span>} />
        </div>
      </>
    );
  } else if (tab === 'target') {
    const R = (Number(roi) || 0) / 100;
    const target = E * (1 + (dir * R) / L);
    body = (
      <>
        <NumInput label="Желаемый ROI" value={roi} onChange={setRoi} suffix="%" />
        <div className="bg-panel2 rounded-md px-3 py-2">
          <Row label="Цена цели" value={<b>{fmtPrice(target, symbol)}</b>} />
          <Row label="Изменение цены" value={fmtPct((target - E) / (E || 1))} />
        </div>
      </>
    );
  } else {
    const margin = im + (Number(extra) || 0);
    const liq = side === 'long' ? (Q * E - margin) / (Q * (1 - mmr)) : (Q * E + margin) / (Q * (1 + mmr));
    body = (
      <>
        <NumInput label="Доп. маржа" value={extra} onChange={setExtra} suffix="USDT" />
        <div className="bg-panel2 rounded-md px-3 py-2">
          <Row label="Маржа позиции" value={`${fmtUsd(margin)} USDT`} />
          <Row label="MMR (1-й тир) + комиссия" value={fmtPct(mmr, 3, false)} />
          <Row label="Цена ликвидации" value={<b className="text-brand">{liq > 0 ? fmtPrice(liq, symbol) : '—'}</b>} />
          <Row label="Расстояние" value={liq > 0 ? fmtPct((liq - E) / (E || 1)) : '—'} />
        </div>
        <div className="text-[11px] text-dim">Для изолированной маржи. В кросс-режиме цена ликвидации зависит от всего капитала аккаунта.</div>
      </>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={`Калькулятор · ${symbol}`} width={440}>
      <div className="flex flex-col gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pnl', label: 'PnL' },
            { value: 'target', label: 'Цена цели' },
            { value: 'liq', label: 'Ликвидация' },
          ]}
        />
        <Segmented
          size="sm"
          value={side}
          onChange={setSide}
          options={[
            { value: 'long', label: 'Лонг', className: '!text-up' },
            { value: 'short', label: 'Шорт', className: '!text-down' },
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumInput label="Плечо" value={lev} onChange={setLev} suffix="x" />
          <NumInput label="Вход" value={entry} onChange={setEntry} />
        </div>
        {tab !== 'target' && <NumInput label="Кол-во" value={qty} onChange={setQty} suffix={spec.base} step={spec.qtyStep} />}
        {body}
        <div className="text-[10px] text-dim">Стоимость позиции: {fmtNum(Q * E, 2)} USDT</div>
      </div>
    </Modal>
  );
}
