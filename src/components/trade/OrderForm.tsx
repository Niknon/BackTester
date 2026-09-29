import { useEffect, useState } from 'react';
import { getAsset, maintenanceMarginRate, roundToStep } from '../../data/assets';
import { MAIN } from '../../engine/exchange';
import type { MarginMode, Side, TimeInForce } from '../../engine/types';
import { useSession, useTick, toast } from '../../store/session';
import { bump } from '../../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtQty, fmtUsd, pnlClass } from '../../lib/format';
import { Check, cx, Modal, NumInput, PercentSlider, Row, Segmented, Select } from '../ui';

type Tab = 'Limit' | 'Market' | 'Conditional';

export function LeverageModal({ symbol, open, onClose, accountId = MAIN }: { symbol: string; open: boolean; onClose: () => void; accountId?: string }) {
  const ex = useSession((s) => s.ex)!;
  const acc = ex.account(accountId);
  const max = getAsset(symbol).maxLeverage;
  const [lev, setLev] = useState<number>(ex.leverageOf(acc, symbol));
  useEffect(() => {
    if (open) setLev(ex.leverageOf(acc, symbol));
  }, [open, symbol]);
  const marks = [1, ...[0.1, 0.25, 0.5, 0.75, 1].map((f) => Math.max(1, Math.round(max * f)))].filter((x, i, a) => a.indexOf(x) === i);
  return (
    <Modal open={open} onClose={onClose} title={`Плечо ${symbol}`}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <button className="btn w-9" onClick={() => setLev((l) => Math.max(1, Math.round(l) - 1))}>
            −
          </button>
          <NumInput value={lev} onChange={(v) => setLev(v === '' ? 1 : Math.max(1, Math.min(max, v)))} suffix="x" className="flex-1 !h-10 text-[16px]" />
          <button className="btn w-9" onClick={() => setLev((l) => Math.min(max, Math.round(l) + 1))}>
            +
          </button>
        </div>
        <input type="range" className="range" min={1} max={max} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
        <div className="flex justify-between text-[11px] text-muted">
          {marks.map((m) => (
            <button key={m} onClick={() => setLev(m)} className="hover:text-text">
              {m}x
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted bg-panel2 rounded-md p-3">
          Макс. плечо для {symbol}: <b className="text-text">{max}x</b>. Поддерживающая маржа (1-й тир): {fmtPct(maintenanceMarginRate(symbol), 2, false)}. Высокое плечо
          увеличивает риск ликвидации.
          {lev >= 20 && <div className="text-down mt-1">⚠ Плечо ≥ 20x: цена ликвидации очень близко к цене входа.</div>}
        </div>
        <button
          className="btn btn-brand h-9"
          onClick={() => {
            const err = ex.setLeverage(accountId, symbol, lev);
            if (err) toast('error', 'Плечо не изменено', err);
            else {
              toast('success', `Плечо ${symbol}: ${lev}x`);
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

function MarginModeModal({ symbol, open, onClose }: { symbol: string; open: boolean; onClose: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const cur = ex.marginModeOf(ex.main, symbol);
  const [mode, setMode] = useState<MarginMode>(cur);
  useEffect(() => {
    if (open) setMode(cur);
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={`Режим маржи ${symbol}`}>
      <div className="flex flex-col gap-3">
        {(
          [
            ['cross', 'Кросс-маржа', 'Весь доступный баланс аккаунта используется как маржа для позиций. Убыток одной позиции может привести к ликвидации всех кросс-позиций.'],
            ['isolated', 'Изолированная маржа', 'Для позиции выделяется фиксированная маржа. При ликвидации теряется только она. Маржу можно добавить вручную.'],
          ] as const
        ).map(([m, title, text]) => (
          <button key={m} onClick={() => setMode(m)} className={cx('text-left rounded-md border p-3', mode === m ? 'border-brand bg-brand/5' : 'border-line2')}>
            <div className="font-semibold">{title}</div>
            <div className="text-muted text-[11px] mt-1">{text}</div>
          </button>
        ))}
        <button
          className="btn btn-brand h-9"
          onClick={() => {
            const err = ex.setMarginMode(MAIN, symbol, mode);
            if (err) toast('error', 'Режим не изменён', err);
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

export function OrderForm({ symbol, price: externalPrice }: { symbol: string; price?: { p: number; n: number } }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const acc = ex.main;
  const spec = getAsset(symbol);
  const last = ex.price(symbol);
  const [tab, setTab] = useState<Tab>('Limit');
  const [price, setPrice] = useState<number | ''>('');
  const [trigger, setTrigger] = useState<number | ''>('');
  const [condType, setCondType] = useState<'Market' | 'Limit'>('Market');
  const [qty, setQty] = useState<number | ''>('');
  const [unit, setUnit] = useState<'coin' | 'usdt'>('coin');
  const [pct, setPct] = useState(0);
  const [tpsl, setTpsl] = useState(false);
  const [tp, setTp] = useState<number | ''>('');
  const [sl, setSl] = useState<number | ''>('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [levOpen, setLevOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);

  useEffect(() => {
    setPrice(roundToStep(last, spec.tickSize));
    setQty('');
    setPct(0);
    setTp('');
    setSl('');
    setTrigger('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  useEffect(() => {
    if (externalPrice) {
      setPrice(externalPrice.p);
      if (tab === 'Market') setTab('Limit');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrice?.n]);

  const lev = ex.leverageOf(acc, symbol);
  const mode = ex.marginModeOf(acc, symbol);
  const summary = ex.summary(acc);
  const avail = Math.max(0, summary.available);
  const refPx = tab === 'Limit' ? Number(price) || last : tab === 'Conditional' ? (condType === 'Limit' ? Number(price) : Number(trigger)) || last : last;
  const taker = ex.config.fees.linearTaker;
  const perUnitCost = refPx * (1 / lev + 2 * taker);
  const maxOpen = perUnitCost > 0 ? roundToStep(avail / perUnitCost, spec.qtyStep, 'floor') : 0;
  const pos = acc.positions[symbol];
  const qtyCoin = unit === 'coin' ? Number(qty) || 0 : roundToStep((Number(qty) || 0) / refPx, spec.qtyStep, 'floor');

  const setFromPct = (p: number) => {
    setPct(p);
    const q = roundToStep((maxOpen * p) / 100, spec.qtyStep, 'floor');
    setQty(unit === 'coin' ? q : Number((q * refPx).toFixed(2)));
  };

  const costFor = (side: Side) => {
    if (!qtyCoin) return 0;
    let open = qtyCoin;
    if (pos && pos.size !== 0 && Math.sign(pos.size) !== (side === 'Buy' ? 1 : -1)) open = Math.max(0, qtyCoin - Math.abs(pos.size));
    return reduceOnly ? 0 : open * perUnitCost;
  };

  const submit = (side: Side) => {
    if (!qtyCoin) return toast('warn', 'Укажите количество');
    const base = {
      category: 'linear' as const,
      symbol,
      side,
      qty: qtyCoin,
      reduceOnly,
      takeProfit: tpsl && tp ? Number(tp) : undefined,
      stopLoss: tpsl && sl ? Number(sl) : undefined,
    };
    let o;
    if (tab === 'Market') o = ex.placeOrder({ ...base, orderType: 'Market' });
    else if (tab === 'Limit') {
      if (!price) return toast('warn', 'Укажите цену');
      o = ex.placeOrder({ ...base, orderType: 'Limit', price: Number(price), tif });
    } else {
      if (!trigger) return toast('warn', 'Укажите цену срабатывания');
      o = ex.placeOrder({
        ...base,
        orderType: condType,
        price: condType === 'Limit' ? Number(price) : undefined,
        triggerPrice: Number(trigger),
        stopOrderType: 'Stop',
      });
    }
    if (o.status === 'New' || o.status === 'Untriggered') toast('info', `Ордер размещён: ${side === 'Buy' ? 'Лонг' : 'Шорт'} ${fmtQty(o.qty, symbol)} ${symbol}`, tab === 'Conditional' ? `Срабатывание ${fmtPrice(o.triggerPrice, symbol)}` : `Цена ${fmtPrice(o.price, symbol)}`);
    bump(true);
  };

  const roi = (target: number | '', side: 1 | -1) => (target && refPx ? ((Number(target) - refPx) / refPx) * lev * side : NaN);

  return (
    <div className="h-full flex flex-col bg-panel rounded-lg overflow-auto">
      <div className="p-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <button className="btn h-8" onClick={() => setModeOpen(true)}>
            {mode === 'cross' ? 'Кросс' : 'Изолир.'}
          </button>
          <button className="btn h-8 text-brand font-semibold" onClick={() => setLevOpen(true)}>
            {fmtNum(lev, lev % 1 ? 2 : 0)}x
          </button>
        </div>
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
          <span className="num">{fmtUsd(avail)} USDT</span>
        </div>
        {tab === 'Conditional' && (
          <>
            <NumInput label="Срабатывание" value={trigger} onChange={setTrigger} step={spec.tickSize} suffix="Last" />
            <Segmented
              size="sm"
              value={condType}
              onChange={setCondType}
              options={[
                { value: 'Market', label: 'По рынку' },
                { value: 'Limit', label: 'Лимит' },
              ]}
            />
          </>
        )}
        {(tab === 'Limit' || (tab === 'Conditional' && condType === 'Limit')) && (
          <div className="flex gap-1">
            <NumInput label="Цена" value={price} onChange={setPrice} step={spec.tickSize} suffix="USDT" className="flex-1" />
            <button className="btn h-8 px-2 text-[11px]" onClick={() => setPrice(roundToStep(last, spec.tickSize))} title="Последняя цена">
              Last
            </button>
          </div>
        )}
        {tab === 'Market' && <div className="field text-muted justify-between"><span>Цена</span><span>Лучшая рыночная</span></div>}
        <div className="flex gap-1">
          <NumInput
            label="Кол-во"
            value={qty}
            onChange={(v) => {
              setQty(v);
              setPct(0);
            }}
            step={unit === 'coin' ? spec.qtyStep : 10}
            className="flex-1"
          />
          <button className="btn h-8 px-2 w-16 text-[11px]" onClick={() => {
            setUnit(unit === 'coin' ? 'usdt' : 'coin');
            setQty('');
            setPct(0);
          }} title="Единицы количества">
            {unit === 'coin' ? spec.base : 'USDT'} ⇄
          </button>
        </div>
        <PercentSlider value={pct} onChange={setFromPct} />
        <div className="text-[11px] text-muted flex justify-between">
          <span>≈ {fmtQty(qtyCoin, symbol)} {spec.base}</span>
          <span>Стоимость ≈ {fmtUsd(qtyCoin * refPx)} USDT</span>
        </div>
        <div className="flex flex-col gap-2">
          <Check checked={tpsl} onChange={setTpsl}>
            TP/SL
          </Check>
          {tpsl && (
            <div className="flex flex-col gap-1.5">
              <NumInput label="Take Profit" value={tp} onChange={setTp} step={spec.tickSize} suffix={Number.isFinite(roi(tp, 1)) ? <span className={pnlClass(roi(tp, 1))}>{fmtPct(roi(tp, 1), 1)} (лонг)</span> : 'USDT'} />
              <NumInput label="Stop Loss" value={sl} onChange={setSl} step={spec.tickSize} suffix={Number.isFinite(roi(sl, 1)) ? <span className={pnlClass(roi(sl, 1))}>{fmtPct(roi(sl, 1), 1)} (лонг)</span> : 'USDT'} />
              <div className="text-[10px] text-dim">TP/SL по последней цене, закрывают всю позицию рыночным ордером. Для шорта TP ниже цены, SL выше.</div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Check checked={reduceOnly} onChange={setReduceOnly}>
              Только сокращение
            </Check>
            {tab === 'Limit' && (
              <Select
                className="!h-7 ml-auto w-28"
                value={tif}
                onChange={setTif}
                options={[
                  { value: 'GTC', label: 'GTC' },
                  { value: 'PostOnly', label: 'Post-Only' },
                  { value: 'IOC', label: 'IOC' },
                  { value: 'FOK', label: 'FOK' },
                ]}
              />
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-up h-10 flex-col !gap-0 leading-tight" onClick={() => submit('Buy')}>
            <span>{reduceOnly ? 'Закрыть шорт' : 'Купить / Лонг'}</span>
          </button>
          <button className="btn btn-down h-10 flex-col !gap-0 leading-tight" onClick={() => submit('Sell')}>
            <span>{reduceOnly ? 'Закрыть лонг' : 'Продать / Шорт'}</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px] text-muted num -mt-1">
          <div>
            <div>Стоимость {fmtUsd(costFor('Buy'))}</div>
            <div>Макс. {fmtQty(maxOpen + (pos && pos.size < 0 ? Math.abs(pos.size) : 0), symbol)}</div>
          </div>
          <div className="text-right">
            <div>Стоимость {fmtUsd(costFor('Sell'))}</div>
            <div>Макс. {fmtQty(maxOpen + (pos && pos.size > 0 ? pos.size : 0), symbol)}</div>
          </div>
        </div>
      </div>
      <AccountBox />
      <LeverageModal symbol={symbol} open={levOpen} onClose={() => setLevOpen(false)} />
      <MarginModeModal symbol={symbol} open={modeOpen} onClose={() => setModeOpen(false)} />
    </div>
  );
}

export function AccountBox() {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const s = ex.summary(ex.main);
  const mmr = s.mmRatio;
  return (
    <div className="border-t border-line p-3 mt-auto flex flex-col gap-0.5 text-[11px]">
      <div className="font-semibold text-[12px] mb-1">Единый торговый аккаунт</div>
      <Row label="Капитал" value={`${fmtUsd(s.equity)} USDT`} />
      <Row label="Баланс кошелька" value={fmtUsd(s.walletBalance)} />
      <Row label="Нереализованный PnL" value={fmtUsd(s.unrealisedPnl, 2, true)} className={pnlClass(s.unrealisedPnl)} />
      <Row label="Начальная маржа" value={fmtUsd(s.initialMargin + s.orderMargin + s.isolatedMargin)} />
      <Row label="Поддерживающая маржа" value={fmtUsd(s.maintenanceMargin)} />
      <Row label="Доступно" value={fmtUsd(Math.max(0, s.available))} />
      <div className="flex items-center gap-2 mt-1">
        <span className="text-muted">MMR</span>
        <div className="flex-1 h-1.5 bg-panel3 rounded overflow-hidden">
          <div className={cx('h-full', mmr > 0.8 ? 'bg-down' : mmr > 0.5 ? 'bg-brand' : 'bg-up')} style={{ width: `${Math.min(100, mmr * 100)}%` }} />
        </div>
        <span className={cx('num', mmr > 0.8 ? 'text-down' : 'text-muted')}>{(mmr * 100).toFixed(2)}%</span>
      </div>
    </div>
  );
}
