import { useEffect, useState } from 'react';
import { getAsset, roundToStep, spotQtyStep } from '../../data/assets';
import type { Side } from '../../engine/types';
import { bump, toast, useSession, useTick } from '../../store/session';
import { fmtNum, fmtPrice, fmtQty, fmtUsd } from '../../lib/format';
import { cx, NumInput, PercentSlider, Row, Segmented, usePersistent } from '../ui';

type Tab = 'Limit' | 'Market' | 'Conditional';

export function SpotOrderForm({ symbol, price: externalPrice }: { symbol: string; price?: { p: number; n: number } }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const acc = ex.main;
  const spec = getAsset(symbol);
  const qtyStep = spotQtyStep(symbol);
  const last = ex.price(symbol);
  const [side, setSide] = useState<Side>('Buy');
  // тип ордера запоминается между сессиями
  const [tab, setTab, setTabTemp] = usePersistent<Tab>('bt-form-spot-tab', 'Limit', ['Limit', 'Market', 'Conditional']);
  const [price, setPrice] = useState<number | ''>('');
  const [trigger, setTrigger] = useState<number | ''>('');
  const [qty, setQty] = useState<number | ''>('');
  const [pct, setPct] = useState(0);
  // единицы ввода: монеты или сумма в USDT (запоминается)
  const [unit, setUnit] = usePersistent<'coin' | 'usdt'>('bt-form-spot-unit', 'coin', ['coin', 'usdt']);

  useEffect(() => {
    setPrice(roundToStep(last, spec.tickSize));
    setQty('');
    setPct(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  useEffect(() => {
    if (externalPrice) {
      setPrice(externalPrice.p);
      if (tab === 'Market') setTabTemp('Limit');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrice?.n]);

  const avail = Math.max(0, ex.available(acc));
  const coin = acc.spot[spec.base] || 0;
  const reservedSell = ex.activeOrders(acc.id, symbol).filter((o) => o.category === 'spot' && o.side === 'Sell').reduce((s, o) => s + o.qty - o.filledQty, 0);
  const freeCoin = Math.max(0, coin - reservedSell);
  const refPx = tab === 'Market' ? last : tab === 'Conditional' ? Number(price) || Number(trigger) || last : Number(price) || last;
  const fee = ex.config.fees.spotTaker;
  const maxQty = side === 'Buy' ? roundToStep(avail / (refPx * (1 + fee)), qtyStep, 'floor') : roundToStep(freeCoin, qtyStep, 'floor');
  const qtyCoin = unit === 'coin' ? Number(qty) || 0 : roundToStep((Number(qty) || 0) / refPx, qtyStep, 'floor');

  const submit = () => {
    const q = qtyCoin;
    if (!q) return toast('warn', unit === 'usdt' ? 'Укажите сумму' : 'Укажите количество');
    const base = { category: 'spot' as const, symbol, side, qty: q };
    let o;
    if (tab === 'Market' && side === 'Buy' && unit === 'usdt') o = ex.placeOrder({ ...base, qty: 0, quoteQty: Number(qty), orderType: 'Market' });
    else if (tab === 'Market') o = ex.placeOrder({ ...base, orderType: 'Market' });
    else if (tab === 'Limit') o = ex.placeOrder({ ...base, orderType: 'Limit', price: Number(price) });
    else o = ex.placeOrder({ ...base, orderType: price ? 'Limit' : 'Market', price: price ? Number(price) : undefined, triggerPrice: Number(trigger) });
    if (o.status === 'New' || o.status === 'Untriggered') toast('info', `Спот-ордер размещён: ${side === 'Buy' ? 'покупка' : 'продажа'} ${fmtQty(o.qty, symbol, 'spot')} ${spec.base}`);
    setQty('');
    setPct(0);
    bump(true);
  };

  return (
    <div className="h-full flex flex-col bg-panel rounded-lg overflow-auto">
      <div className="p-3 flex flex-col gap-3">
        <Segmented
          value={side}
          onChange={(s) => {
            setSide(s);
            setQty('');
            setPct(0);
          }}
          options={[
            { value: 'Buy', label: 'Купить', className: '!bg-up !text-white' },
            { value: 'Sell', label: 'Продать', className: '!bg-down !text-white' },
          ]}
        />
        <div className="flex border-b border-line">
          {(
            [
              ['Limit', 'Лимит'],
              ['Market', 'Рыночный'],
              ['Conditional', 'Условный'],
            ] as const
          ).map(([k, l]) => (
            <div key={k} className={cx('tab', tab === k && 'active')} onClick={() => setTab(k)}>
              {l}
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-muted">Доступно</span>
          <span className="num">{side === 'Buy' ? `${fmtUsd(avail)} USDT` : `${fmtQty(freeCoin, symbol, 'spot')} ${spec.base}`}</span>
        </div>
        {tab === 'Conditional' && <NumInput label="Срабатывание" value={trigger} onChange={setTrigger} step={spec.tickSize} suffix="USDT" />}
        {tab !== 'Market' ? (
          <NumInput label={tab === 'Conditional' ? 'Цена (пусто = рынок)' : 'Цена'} value={price} onChange={setPrice} step={spec.tickSize} suffix="USDT" />
        ) : (
          <div className="field text-muted justify-between">
            <span>Цена</span>
            <span>Лучшая рыночная</span>
          </div>
        )}
        <div className="flex gap-1">
          <NumInput
            label={unit === 'usdt' ? 'Сумма' : 'Кол-во'}
            value={qty}
            onChange={(v) => {
              setQty(v);
              setPct(0);
            }}
            step={unit === 'usdt' ? 10 : qtyStep}
            className="flex-1"
          />
          <button
            className="btn h-8 px-2 w-20 text-[11px]"
            title="Вводить количество в монетах или сумму в USDT"
            onClick={() => {
              setUnit(unit === 'coin' ? 'usdt' : 'coin');
              setQty('');
              setPct(0);
            }}
          >
            {unit === 'coin' ? spec.base : 'USDT'} ⇄
          </button>
        </div>
        <PercentSlider
          value={pct}
          onChange={(p) => {
            setPct(p);
            const q = roundToStep((maxQty * p) / 100, qtyStep, 'floor');
            setQty(unit === 'coin' ? q : Number((q * refPx).toFixed(2)));
          }}
        />
        {unit === 'usdt' ? <Row label="Количество ≈" value={`${fmtQty(qtyCoin, symbol, 'spot')} ${spec.base}`} /> : <Row label="Сумма" value={`${fmtUsd(qtyCoin * refPx)} USDT`} />}
        <Row label="Комиссия (тейкер)" value={`${fmtNum(qtyCoin * refPx * fee, 4)} USDT`} />
        <button className={cx('btn h-10', side === 'Buy' ? 'btn-up' : 'btn-down')} onClick={submit}>
          {side === 'Buy' ? 'Купить' : 'Продать'} {spec.base}
        </button>
      </div>
      <div className="border-t border-line p-3 mt-auto flex flex-col gap-0.5 text-[11px]">
        <div className="font-semibold text-[12px] mb-1">Балансы</div>
        <Row label="USDT (доступно)" value={fmtUsd(avail)} />
        <Row label={spec.base} value={`${fmtQty(coin, symbol, 'spot')} ≈ ${fmtUsd(coin * last)} USDT`} />
        {coin > 0 && <Row label="Средняя цена покупки" value={fmtPrice((acc.spotCost[spec.base] || 0) / coin, symbol)} />}
      </div>
    </div>
  );
}
