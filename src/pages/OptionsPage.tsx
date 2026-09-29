import { useEffect, useMemo, useRef, useState } from 'react';
import { ASSETS } from '../data/assets';
import { DAY } from '../data/intervals';
import { realizedVolAt } from '../data/volatility';
import { MAIN } from '../engine/exchange';
import { blackScholes, expiryCode, optionQtyStep, optionSymbol, optionTickSize, shortOptionMargin, optionFee, yearsTo, smileIv, atmIv, type OptionQuote } from '../engine/options';
import type { Side } from '../engine/types';
import { ensureSymbol } from '../store/actions';
import { bump, toast, useSession, useTick } from '../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtShortDate, fmtTime, fmtUsd, pnlClass, autoDecimals } from '../lib/format';
import { Badge, cx, Empty, NumInput, Row, Segmented, Tabs } from '../components/ui';
import { PayoffChart, breakevens, payoffAtExpiry, type PayoffLeg } from '../components/options/PayoffChart';
import { PriceChart } from '../components/chart/PriceChart';

const BASES = ASSETS.filter((a) => a.hasOptions);

interface Draft {
  symbol: string;
  side: Side;
}

interface BuilderLeg {
  id: number;
  side: Side;
  type: 'C' | 'P';
  strike: number;
  qty: number;
}

const PRESETS: { key: string; label: string; legs: (atm: number, step: number) => Omit<BuilderLeg, 'id' | 'qty'>[] }[] = [
  { key: 'lc', label: 'Лонг колл', legs: (k) => [{ side: 'Buy', type: 'C', strike: k }] },
  { key: 'lp', label: 'Лонг пут', legs: (k) => [{ side: 'Buy', type: 'P', strike: k }] },
  { key: 'sc', label: 'Шорт колл', legs: (k, s) => [{ side: 'Sell', type: 'C', strike: k + 2 * s }] },
  { key: 'sp', label: 'Шорт пут', legs: (k, s) => [{ side: 'Sell', type: 'P', strike: k - 2 * s }] },
  { key: 'straddle', label: 'Лонг стрэддл', legs: (k) => [{ side: 'Buy', type: 'C', strike: k }, { side: 'Buy', type: 'P', strike: k }] },
  { key: 'sstraddle', label: 'Шорт стрэддл', legs: (k) => [{ side: 'Sell', type: 'C', strike: k }, { side: 'Sell', type: 'P', strike: k }] },
  { key: 'strangle', label: 'Лонг стрэнгл', legs: (k, s) => [{ side: 'Buy', type: 'C', strike: k + 2 * s }, { side: 'Buy', type: 'P', strike: k - 2 * s }] },
  { key: 'bcs', label: 'Бычий колл-спред', legs: (k, s) => [{ side: 'Buy', type: 'C', strike: k }, { side: 'Sell', type: 'C', strike: k + 3 * s }] },
  { key: 'bps', label: 'Медвежий пут-спред', legs: (k, s) => [{ side: 'Buy', type: 'P', strike: k }, { side: 'Sell', type: 'P', strike: k - 3 * s }] },
  {
    key: 'condor',
    label: 'Железный кондор',
    legs: (k, s) => [
      { side: 'Buy', type: 'P', strike: k - 4 * s },
      { side: 'Sell', type: 'P', strike: k - 2 * s },
      { side: 'Sell', type: 'C', strike: k + 2 * s },
      { side: 'Buy', type: 'C', strike: k + 4 * s },
    ],
  },
  {
    key: 'fly',
    label: 'Бабочка (коллы)',
    legs: (k, s) => [
      { side: 'Buy', type: 'C', strike: k - 2 * s },
      { side: 'Sell', type: 'C', strike: k },
      { side: 'Sell', type: 'C', strike: k },
      { side: 'Buy', type: 'C', strike: k + 2 * s },
    ],
  },
  { key: 'rr', label: 'Риск-реверсал', legs: (k, s) => [{ side: 'Buy', type: 'C', strike: k + 2 * s }, { side: 'Sell', type: 'P', strike: k - 2 * s }] },
];

function dte(expiry: number, now: number) {
  const d = (expiry - now) / DAY;
  return d >= 1 ? `${d.toFixed(d >= 10 ? 0 : 1)}д` : `${((expiry - now) / 3_600_000).toFixed(1)}ч`;
}

export function OptionsPage() {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const base = useSession((s) => s.optionBase);
  const set = useSession((s) => s.set);
  const loadingSymbols = useSession((s) => s.loadingSymbols);
  const chartTf = useSession((s) => s.chartTf);
  const underlying = `${base}USDT`;
  const loaded = ex.market.has(underlying);
  const expiries = loaded ? ex.optionExpiries(base) : [];
  const [expiry, setExpiry] = useState<number>(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [bottom, setBottom] = useState<'positions' | 'orders' | 'builder' | 'history' | 'chart'>('positions');
  const [builder, setBuilder] = useState<BuilderLeg[]>([]);
  const [greekCols, setGreekCols] = useState(false);

  useEffect(() => {
    if (!expiries.includes(expiry) && expiries.length) setExpiry(expiries[Math.min(3, expiries.length - 1)]);
  }, [expiries.join(','), expiry]);

  const chain = useMemo(() => (loaded && expiry ? ex.optionChain(base, expiry) : null), [ex, base, expiry, loaded, ex.now, ex.state.cursor]);
  const S = chain?.S ?? NaN;
  const rv = realizedVolAt(ex.market.rv.get(underlying), ex.now);

  // позиции по опционам этого базового актива
  const optPositions = Object.values(ex.main.positions).filter((p) => p.category === 'option' && p.symbol.startsWith(base + '-'));
  const perpPos = ex.main.positions[underlying];
  const legs: PayoffLeg[] = useMemo(() => {
    const out: PayoffLeg[] = [];
    for (const p of optPositions) {
      const inst = ex.optionInstrument(p.symbol)!;
      out.push({
        type: inst.type,
        strike: inst.strike,
        qty: p.size,
        entry: p.avgPrice,
        valueNow: (x) => ex.optionQuote(p.symbol, x)?.mark ?? 0,
      });
    }
    if (perpPos) out.push({ type: 'F', strike: 0, qty: perpPos.size, entry: perpPos.avgPrice });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optPositions.map((p) => p.symbol + p.size + p.avgPrice).join(), perpPos?.size, perpPos?.avgPrice, ex.now]);

  const builderLegs: PayoffLeg[] = useMemo(
    () =>
      builder.map((b) => {
        const sym = optionSymbol(base, expiry, b.strike, b.type);
        const q = ex.optionQuote(sym);
        const px = b.side === 'Buy' ? (q?.ask ?? 0) : (q?.bid ?? 0);
        return { type: b.type, strike: b.strike, qty: (b.side === 'Buy' ? 1 : -1) * b.qty, entry: px, valueNow: (x: number) => ex.optionQuote(sym, x)?.mark ?? 0 };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [builder, base, expiry, ex.now],
  );

  if (!loaded) {
    return (
      <div className="h-full flex flex-col">
        <BaseTabs base={base} onBase={(b) => set({ optionBase: b })} />
        <Empty>
          <div className="text-[14px] text-text">Данные {underlying} не загружены</div>
          <div>Опционы оцениваются по цене базового перпетуала и его волатильности.</div>
          <button className="btn btn-brand mt-2" disabled={loadingSymbols.includes(underlying)} onClick={() => ensureSymbol(underlying)}>
            {loadingSymbols.includes(underlying) ? 'Загрузка…' : `Загрузить ${underlying}`}
          </button>
        </Empty>
      </div>
    );
  }

  // суммарные греки
  const greeks = optPositions.reduce(
    (g, p) => {
      const q = ex.optionQuote(p.symbol);
      if (!q) return g;
      g.delta += q.greeks.delta * p.size;
      g.gamma += q.greeks.gamma * p.size;
      g.vega += q.greeks.vega * p.size;
      g.theta += q.greeks.theta * p.size;
      return g;
    },
    { delta: perpPos?.size ?? 0, gamma: 0, vega: 0, theta: 0 },
  );

  const optOrders = ex.activeOrders(MAIN).filter((o) => o.category === 'option');
  const optHistory = ex.state.closedPnl.filter((c) => c.accountId === MAIN && c.category === 'option').slice(-200).reverse();
  const strikeDec = autoDecimals(S);

  return (
    <div className="h-full flex flex-col gap-1 p-1">
      <div className="bg-panel rounded-lg shrink-0">
        <BaseTabs base={base} onBase={(b) => set({ optionBase: b })} />
        <div className="flex items-center gap-6 px-4 py-2">
          <div>
            <div className="text-[10px] text-muted">Цена {underlying}</div>
            <div className="num text-[17px] font-bold">{fmtPrice(S, underlying)}</div>
          </div>
          <Info label={`ATM IV (${dte(expiry, ex.now)})`} value={fmtPct(chain?.atm ?? NaN, 1, false)} />
          <Info label="RV 7д / 30д" value={`${fmtPct(rv?.rv7 ?? NaN, 1, false)} / ${fmtPct(rv?.rv30 ?? NaN, 1, false)}`} />
          <Info label="Модель IV" value={ex.config.options.ivSource === 'realized' ? `RV × ${ex.config.options.ivPremium}` : ex.config.options.ivSource === 'dvol' ? 'DVOL' : 'фикс.'} />
          <Info label="Портфель Δ / Γ" value={`${fmtNum(greeks.delta, 3)} / ${fmtNum(greeks.gamma, 5)}`} />
          <Info label="Вега / Тета (день)" value={<span>{fmtNum(greeks.vega, 2)} / <span className={pnlClass(greeks.theta)}>{fmtNum(greeks.theta, 2)}</span></span>} />
          <label className="ml-auto flex items-center gap-2 text-muted text-[11px]">
            <input type="checkbox" className="checkbox" checked={greekCols} onChange={(e) => setGreekCols(e.target.checked)} /> Гамма/Вега/Тета в цепочке
          </label>
        </div>
        <div className="flex gap-1 px-3 pb-2 overflow-x-auto">
          {expiries.map((e) => (
            <button key={e} className={cx('chip border border-line2 shrink-0', e === expiry && 'active !border-brand')} onClick={() => setExpiry(e)}>
              {fmtShortDate(e)} <span className="text-dim text-[10px]">{dte(e, ex.now)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex gap-1">
        <div className="flex-1 min-w-0 bg-panel rounded-lg overflow-auto">
          <ChainTable chain={chain} S={S} base={base} greekCols={greekCols} onPick={setDraft} draft={draft} strikeDec={strikeDec} />
        </div>
        <div className="w-[320px] shrink-0 bg-panel rounded-lg overflow-auto">
          <OptionOrderPanel draft={draft} onSide={(side) => draft && setDraft({ ...draft, side })} onAddToBuilder={(leg) => {
            setBuilder((b) => [...b, { ...leg, id: Date.now() }]);
            setBottom('builder');
          }} />
        </div>
      </div>
      <div className="h-[330px] shrink-0 bg-panel rounded-lg flex flex-col overflow-hidden">
        <Tabs
          value={bottom}
          onChange={setBottom}
          tabs={[
            { value: 'positions', label: `Позиции и профиль (${optPositions.length})` },
            { value: 'orders', label: `Ордера (${optOrders.length})` },
            { value: 'builder', label: `Конструктор стратегий${builder.length ? ` (${builder.length})` : ''}` },
            { value: 'history', label: 'История' },
            { value: 'chart', label: `График ${underlying}` },
          ]}
        />
        <div className="flex-1 min-h-0 overflow-auto">
          {bottom === 'positions' && (
            <div className="grid grid-cols-[1fr_460px] h-full">
              <div className="overflow-auto">
                <OptionPositions />
              </div>
              <div className="border-l border-line p-2">
                {legs.length ? <PayoffSummary legs={legs} S={S} /> : <Empty>Откройте опционную позицию, чтобы увидеть профиль выплат</Empty>}
              </div>
            </div>
          )}
          {bottom === 'orders' && <OptionOrders />}
          {bottom === 'builder' && (
            <Builder
              legs={builder}
              setLegs={setBuilder}
              payoff={builderLegs}
              S={S}
              strikes={chain?.rows.map((r) => r.strike) ?? []}
              base={base}
              expiry={expiry}
            />
          )}
          {bottom === 'history' &&
            (optHistory.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Инструмент</th>
                    <th>Позиция</th>
                    <th className="text-right">Кол-во</th>
                    <th className="text-right">Вход</th>
                    <th className="text-right">Выход / поставка</th>
                    <th className="text-right">PnL</th>
                    <th>Тип</th>
                    <th>Закрыта</th>
                  </tr>
                </thead>
                <tbody>
                  {optHistory.map((c) => (
                    <tr key={c.id}>
                      <td className="font-semibold">{c.symbol}</td>
                      <td className={c.side === 'Buy' ? 'text-up' : 'text-down'}>{c.side === 'Buy' ? 'Лонг' : 'Шорт'}</td>
                      <td className="text-right">{fmtNum(c.qty, 4)}</td>
                      <td className="text-right">{fmtNum(c.entryPrice, 4)}</td>
                      <td className="text-right">{fmtNum(c.exitPrice, 4)}</td>
                      <td className={cx('text-right font-semibold', pnlClass(c.closedPnl))}>{fmtUsd(c.closedPnl, 2, true)}</td>
                      <td>
                        <Badge color={c.type === 'Delivery' ? 'info' : c.type === 'Liquidation' ? 'down' : 'muted'}>{c.type === 'Delivery' ? 'Экспирация' : c.type}</Badge>
                      </td>
                      <td className="text-muted">{fmtTime(c.closeTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>История пуста</Empty>
            ))}
          {bottom === 'chart' && (
            <div className="h-full p-1">
              <PriceChart symbol={underlying} tf={chartTf} onTfChange={(t) => set({ chartTf: t })} compact />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="shrink-0">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="num font-semibold">{value}</div>
    </div>
  );
}

function BaseTabs({ base, onBase }: { base: string; onBase: (b: string) => void }) {
  const ex = useSession((s) => s.ex)!;
  return (
    <div className="flex items-center gap-1 px-3 pt-2 border-b border-line overflow-x-auto">
      {BASES.map((a, i) => (
        <div key={a.base} className="flex items-center shrink-0">
          {i > 0 && BASES[i - 1].group !== a.group && <div className="w-px h-5 bg-line2 mx-2" />}
          <div className={cx('tab !mr-3 flex items-center gap-1', base === a.base && 'active')} onClick={() => onBase(a.base)}>
            {a.base}
            {!ex.market.has(a.symbol) && <span className="text-dim text-[9px]">↓</span>}
            {a.group === 'tradfi' && <span className="text-info text-[9px]">perp</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChainTable({
  chain,
  S,
  base,
  greekCols,
  onPick,
  draft,
  strikeDec,
}: {
  chain: ReturnType<import('../engine/exchange').Exchange['optionChain']> | null;
  S: number;
  base: string;
  greekCols: boolean;
  onPick: (d: Draft) => void;
  draft: Draft | null;
  strikeDec: number;
}) {
  const ex = useSession((s) => s.ex)!;
  const atmRef = useRef<HTMLTableRowElement>(null);
  const expiryKey = chain?.rows[0]?.call.inst.expiry ?? 0;
  useEffect(() => {
    atmRef.current?.scrollIntoView({ block: 'center' });
  }, [base, expiryKey]);
  if (!chain || !chain.rows.length) return <Empty>Нет котировок</Empty>;
  const pos = ex.main.positions;
  const tick = optionTickSize(S);
  const pd = Math.max(0, -Math.floor(Math.log10(tick)));
  const f = (x: number) => (x > 0 ? fmtNum(x, pd) : '—');
  let atmInserted = false;
  const rows: React.ReactNode[] = [];
  const cellBtn = (q: OptionQuote, side: Side, val: number) => (
    <button
      className={cx(
        'num px-1.5 py-0.5 rounded hover:bg-panel3',
        side === 'Buy' ? 'text-down' : 'text-up',
        draft?.symbol === q.inst.symbol && draft.side === side && 'ring-1 ring-brand',
      )}
      disabled={val <= 0}
      onClick={() => onPick({ symbol: q.inst.symbol, side })}
    >
      {f(val)}
    </button>
  );
  for (const r of chain.rows) {
    if (!atmInserted && r.strike > S) {
      atmInserted = true;
      rows.push(
        <tr key="atm" ref={atmRef}>
          <td colSpan={greekCols ? 19 : 13} className="!p-0">
            <div className="flex items-center gap-2 text-[10px] text-brand">
              <div className="h-px flex-1 bg-brand/50" />
              {base}: {fmtPrice(S, `${base}USDT`)}
              <div className="h-px flex-1 bg-brand/50" />
            </div>
          </td>
        </tr>,
      );
    }
    const callItm = r.strike < S;
    const putItm = r.strike > S;
    const cp = pos[r.call.inst.symbol]?.size;
    const pp = pos[r.put.inst.symbol]?.size;
    rows.push(
      <tr key={r.strike}>
        <td className={cx('text-right', callItm && 'bg-brand/[0.04]')}>{cp ? <span className={cp > 0 ? 'text-up' : 'text-down'}>{fmtNum(cp, 2)}</span> : ''}</td>
        {greekCols && <td className={cx('text-right text-muted', callItm && 'bg-brand/[0.04]')}>{fmtNum(r.call.greeks.theta, 2)}</td>}
        {greekCols && <td className={cx('text-right text-muted', callItm && 'bg-brand/[0.04]')}>{fmtNum(r.call.greeks.vega, 2)}</td>}
        {greekCols && <td className={cx('text-right text-muted', callItm && 'bg-brand/[0.04]')}>{fmtNum(r.call.greeks.gamma, 5)}</td>}
        <td className={cx('text-right', callItm && 'bg-brand/[0.04]')}>{fmtNum(r.call.greeks.delta, 3)}</td>
        <td className={cx('text-right text-muted', callItm && 'bg-brand/[0.04]')}>{(r.call.iv * 100).toFixed(1)}%</td>
        <td className={cx('text-right', callItm && 'bg-brand/[0.04]')}>{cellBtn(r.call, 'Sell', r.call.bid)}</td>
        <td className={cx('text-right text-muted', callItm && 'bg-brand/[0.04]')}>{f(r.call.mark)}</td>
        <td className={cx('text-right', callItm && 'bg-brand/[0.04]')}>{cellBtn(r.call, 'Buy', r.call.ask)}</td>
        <td className="text-center font-bold bg-panel2 num">{fmtNum(r.strike, Math.min(strikeDec, 6))}</td>
        <td className={cx(putItm && 'bg-brand/[0.04]')}>{cellBtn(r.put, 'Sell', r.put.bid)}</td>
        <td className={cx('text-muted', putItm && 'bg-brand/[0.04]')}>{f(r.put.mark)}</td>
        <td className={cx(putItm && 'bg-brand/[0.04]')}>{cellBtn(r.put, 'Buy', r.put.ask)}</td>
        <td className={cx('text-muted', putItm && 'bg-brand/[0.04]')}>{(r.put.iv * 100).toFixed(1)}%</td>
        <td className={cx(putItm && 'bg-brand/[0.04]')}>{fmtNum(r.put.greeks.delta, 3)}</td>
        {greekCols && <td className={cx('text-muted', putItm && 'bg-brand/[0.04]')}>{fmtNum(r.put.greeks.gamma, 5)}</td>}
        {greekCols && <td className={cx('text-muted', putItm && 'bg-brand/[0.04]')}>{fmtNum(r.put.greeks.vega, 2)}</td>}
        {greekCols && <td className={cx('text-muted', putItm && 'bg-brand/[0.04]')}>{fmtNum(r.put.greeks.theta, 2)}</td>}
        <td>{pp ? <span className={pp > 0 ? 'text-up' : 'text-down'}>{fmtNum(pp, 2)}</span> : ''}</td>
      </tr>,
    );
  }
  return (
    <table className="tbl text-[11.5px] [&_td]:!py-[3px]">
      <thead>
        <tr>
          <th colSpan={greekCols ? 9 : 6} className="text-center !text-up !bg-panel2">
            КОЛЛЫ
          </th>
          <th className="text-center !bg-panel2">Страйк</th>
          <th colSpan={greekCols ? 9 : 6} className="text-center !text-down !bg-panel2">
            ПУТЫ
          </th>
        </tr>
        <tr className="[&>th]:!top-[27px]">
          <th className="text-right">Позиция</th>
          {greekCols && <th className="text-right">Тета</th>}
          {greekCols && <th className="text-right">Вега</th>}
          {greekCols && <th className="text-right">Гамма</th>}
          <th className="text-right">Дельта</th>
          <th className="text-right">IV</th>
          <th className="text-right">Bid</th>
          <th className="text-right">Mark</th>
          <th className="text-right">Ask</th>
          <th className="text-center">{expiryCode(chain.rows[0].call.inst.expiry)}</th>
          <th>Bid</th>
          <th>Mark</th>
          <th>Ask</th>
          <th>IV</th>
          <th>Дельта</th>
          {greekCols && <th>Гамма</th>}
          {greekCols && <th>Вега</th>}
          {greekCols && <th>Тета</th>}
          <th>Позиция</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function OptionOrderPanel({ draft, onSide, onAddToBuilder }: { draft: Draft | null; onSide: (s: Side) => void; onAddToBuilder: (l: Omit<BuilderLeg, 'id'>) => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const [type, setType] = useState<'Limit' | 'Market'>('Limit');
  const [price, setPrice] = useState<number | ''>('');
  const [qty, setQty] = useState<number | ''>('');
  const q = draft ? ex.optionQuote(draft.symbol) : null;
  useEffect(() => {
    if (q && draft) setPrice(draft.side === 'Buy' ? q.ask : q.bid);
    if (q && draft) setQty((prev) => (prev ? prev : Number((optionQtyStep(q.underlyingPrice) * 10).toPrecision(6))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.symbol, draft?.side]);
  if (!draft || !q) return <Empty>Нажмите Bid (продать) или Ask (купить) в цепочке, чтобы создать ордер</Empty>;
  const inst = q.inst;
  const S = q.underlyingPrice;
  const step = optionQtyStep(S);
  const tick = optionTickSize(S);
  const px = type === 'Market' ? (draft.side === 'Buy' ? q.ask : q.bid) : Number(price) || 0;
  const n = Number(qty) || 0;
  const fee = optionFee(ex.config.fees.optionTaker, ex.config.fees.optionFeeCap, S, px, n);
  const margin = draft.side === 'Sell' ? shortOptionMargin(ex.config.options, inst, S, q.mark) : null;
  const avail = ex.available(ex.main);
  const submit = () => {
    const o = ex.placeOrder({
      category: 'option',
      symbol: draft.symbol,
      side: draft.side,
      orderType: type,
      price: type === 'Limit' ? Number(price) : undefined,
      qty: n,
    });
    if (o.status === 'New') toast('info', `Лимит-ордер ${draft.side === 'Buy' ? 'покупка' : 'продажа'} ${draft.symbol}`, `${n} по ${price}`);
    bump(true);
  };
  const g = q.greeks;
  const be = inst.type === 'C' ? inst.strike + px : inst.strike - px;
  return (
    <div className="p-3 flex flex-col gap-3">
      <div>
        <div className="font-bold text-[14px]">{draft.symbol}</div>
        <div className="text-[11px] text-muted">
          {inst.type === 'C' ? 'Колл' : 'Пут'} · страйк {fmtNum(inst.strike, autoDecimals(inst.strike))} · экспирация {fmtTime(inst.expiry)} UTC · европейский, расчёт в USDT
        </div>
      </div>
      <Segmented
        value={draft.side}
        onChange={onSide}
        options={[
          { value: 'Buy', label: 'Купить', className: '!bg-up !text-white' },
          { value: 'Sell', label: 'Продать', className: '!bg-down !text-white' },
        ]}
      />
      <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
        <div className="bg-panel2 rounded p-1.5">
          <div className="text-muted">Bid</div>
          <div className="num text-up">{fmtNum(q.bid, 4)}</div>
        </div>
        <div className="bg-panel2 rounded p-1.5">
          <div className="text-muted">Mark</div>
          <div className="num">{fmtNum(q.mark, 4)}</div>
        </div>
        <div className="bg-panel2 rounded p-1.5">
          <div className="text-muted">Ask</div>
          <div className="num text-down">{fmtNum(q.ask, 4)}</div>
        </div>
      </div>
      <Segmented
        size="sm"
        value={type}
        onChange={setType}
        options={[
          { value: 'Limit', label: 'Лимит' },
          { value: 'Market', label: 'Рыночный' },
        ]}
      />
      {type === 'Limit' && <NumInput label="Цена" value={price} onChange={setPrice} step={tick} suffix="USDT" />}
      <NumInput label="Кол-во" value={qty} onChange={setQty} step={step} suffix={inst.base} />
      <div className="text-[11px] flex flex-col">
        <Row label={draft.side === 'Buy' ? 'Премия к оплате' : 'Премия к получению'} value={`${fmtUsd(px * n, 4)} USDT`} />
        <Row label="Комиссия" value={`${fmtNum(fee, 4)} USDT`} />
        {margin && <Row label="Маржа шорта (IM)" value={`${fmtUsd(margin.im * n)} USDT`} />}
        <Row label="Доступно" value={`${fmtUsd(avail)} USDT`} />
        <Row label="Безубыточность" value={fmtNum(be, autoDecimals(be))} />
        <Row label="IV / мин. шаг" value={`${(q.iv * 100).toFixed(1)}% / ${step}`} />
      </div>
      <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
        {[
          ['Δ', g.delta, 3],
          ['Γ', g.gamma, 5],
          ['Vega', g.vega, 3],
          ['Θ/день', g.theta, 3],
        ].map(([l, v, d]) => (
          <div key={l as string} className="bg-panel2 rounded p-1">
            <div className="text-muted">{l}</div>
            <div className="num">{fmtNum((v as number) * n * (draft.side === 'Buy' ? 1 : -1), d as number)}</div>
          </div>
        ))}
      </div>
      <button className={cx('btn h-10', draft.side === 'Buy' ? 'btn-up' : 'btn-down')} onClick={submit}>
        {draft.side === 'Buy' ? 'Купить' : 'Продать'} {inst.type === 'C' ? 'колл' : 'пут'}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => onAddToBuilder({ side: draft.side, type: inst.type, strike: inst.strike, qty: n || step })}>
        + Добавить ногу в конструктор
      </button>
    </div>
  );
}

function OptionPositions() {
  const ex = useSession((s) => s.ex)!;
  const ps = Object.values(ex.main.positions).filter((p) => p.category === 'option');
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

function OptionOrders() {
  const ex = useSession((s) => s.ex)!;
  const os = ex.activeOrders(MAIN).filter((o) => o.category === 'option');
  if (!os.length) return <Empty>Нет активных ордеров по опционам</Empty>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Инструмент</th>
          <th>Сторона</th>
          <th className="text-right">Цена</th>
          <th className="text-right">Кол-во</th>
          <th className="text-right">Mark</th>
          <th>Время</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {os.map((o) => (
          <tr key={o.id}>
            <td className="font-semibold">{o.symbol}</td>
            <td className={o.side === 'Buy' ? 'text-up' : 'text-down'}>{o.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
            <td className="text-right">{fmtNum(o.price, 4)}</td>
            <td className="text-right">{fmtNum(o.qty, 3)}</td>
            <td className="text-right">{fmtNum(ex.optionMark(o.symbol), 4)}</td>
            <td className="text-muted">{fmtTime(o.createdTime)}</td>
            <td>
              <button className="btn btn-sm btn-ghost" onClick={() => (ex.cancelOrder(o.id), bump(true))}>
                Отменить
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PayoffSummary({ legs, S }: { legs: PayoffLeg[]; S: number }) {
  const lo = S * 0.5;
  const hi = S * 1.5;
  const bes = breakevens(legs, lo, hi);
  let maxP = -Infinity;
  let minP = Infinity;
  for (let i = 0; i <= 400; i++) {
    const v = payoffAtExpiry(legs, lo + ((hi - lo) * i) / 400);
    maxP = Math.max(maxP, v);
    minP = Math.min(minP, v);
  }
  const d = autoDecimals(S);
  return (
    <div className="flex flex-col gap-1 h-full">
      <PayoffChart legs={legs} spot={S} height={250} />
      <div className="flex gap-4 text-[11px] flex-wrap">
        <span className="text-muted">
          Безубыточность: <span className="text-text num">{bes.length ? bes.map((b) => fmtNum(b, d)).join(', ') : '—'}</span>
        </span>
        <span className="text-muted">
          Макс. прибыль (±50%): <span className="text-up num">{fmtUsd(maxP)}</span>
        </span>
        <span className="text-muted">
          Макс. убыток: <span className="text-down num">{fmtUsd(minP)}</span>
        </span>
      </div>
    </div>
  );
}

function Builder({
  legs,
  setLegs,
  payoff,
  S,
  strikes,
  base,
  expiry,
}: {
  legs: BuilderLeg[];
  setLegs: (f: BuilderLeg[] | ((l: BuilderLeg[]) => BuilderLeg[])) => void;
  payoff: PayoffLeg[];
  S: number;
  strikes: number[];
  base: string;
  expiry: number;
}) {
  const ex = useSession((s) => s.ex)!;
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : S * 0.01;
  const atm = strikes.reduce((b, k) => (Math.abs(k - S) < Math.abs(b - S) ? k : b), strikes[0] ?? S);
  const qty0 = Number((optionQtyStep(S) * 10).toPrecision(6));
  const nearest = (k: number) => strikes.reduce((b, x) => (Math.abs(x - k) < Math.abs(b - k) ? x : b), strikes[0] ?? k);
  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key)!;
    setLegs(p.legs(atm, step).map((l, i) => ({ ...l, strike: nearest(l.strike), qty: qty0, id: Date.now() + i })));
  };
  const net = payoff.reduce((s, l) => s + -l.qty * l.entry, 0);
  const T = yearsTo(expiry, ex.now);
  const vol = ex.volInputs(`${base}USDT`);
  const atmV = atmIv(ex.config.options, vol, T);
  const execAll = () => {
    let ok = 0;
    for (const l of legs) {
      const o = ex.placeOrder({ category: 'option', symbol: optionSymbol(base, expiry, l.strike, l.type), side: l.side, orderType: 'Market', qty: l.qty });
      if (o.status === 'Filled') ok++;
    }
    toast(ok === legs.length ? 'success' : 'warn', `Стратегия исполнена: ${ok}/${legs.length} ног`);
    bump(true);
  };
  return (
    <div className="grid grid-cols-[1fr_460px] h-full">
      <div className="p-3 flex flex-col gap-2 overflow-auto">
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p.key} className="chip border border-line2" onClick={() => applyPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {!legs.length ? (
          <div className="text-dim py-6 text-center">Выберите шаблон или добавьте ноги из цепочки. Экспирация: {fmtShortDate(expiry)}.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Сторона</th>
                <th>Тип</th>
                <th>Страйк</th>
                <th>Кол-во</th>
                <th className="text-right">Цена</th>
                <th className="text-right">IV</th>
                <th className="text-right">Δ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {legs.map((l, i) => {
                const g = blackScholes(S, l.strike, T, smileIv(ex.config.options, atmV, S, l.strike, T), l.type);
                return (
                  <tr key={l.id}>
                    <td>
                      <button className={cx('btn btn-sm w-20', l.side === 'Buy' ? 'text-up' : 'text-down')} onClick={() => setLegs(legs.map((x) => (x.id === l.id ? { ...x, side: x.side === 'Buy' ? 'Sell' : 'Buy' } : x)))}>
                        {l.side === 'Buy' ? 'Покупка' : 'Продажа'}
                      </button>
                    </td>
                    <td>
                      <button className="btn btn-sm w-14" onClick={() => setLegs(legs.map((x) => (x.id === l.id ? { ...x, type: x.type === 'C' ? 'P' : 'C' } : x)))}>
                        {l.type === 'C' ? 'Колл' : 'Пут'}
                      </button>
                    </td>
                    <td>
                      <select className="bg-panel2 border border-line rounded h-6 px-1 num" value={l.strike} onChange={(e) => setLegs(legs.map((x) => (x.id === l.id ? { ...x, strike: Number(e.target.value) } : x)))}>
                        {strikes.map((k) => (
                          <option key={k} value={k}>
                            {fmtNum(k, autoDecimals(k))}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <NumInput value={l.qty} step={qty0} onChange={(v) => setLegs(legs.map((x) => (x.id === l.id ? { ...x, qty: Number(v) || qty0 } : x)))} className="!h-6 w-20 !px-1" />
                    </td>
                    <td className="text-right num">{fmtNum(payoff[i]?.entry, 4)}</td>
                    <td className="text-right text-muted">{(smileIv(ex.config.options, atmV, S, l.strike, T) * 100).toFixed(1)}%</td>
                    <td className="text-right">{fmtNum(g.delta * l.qty * (l.side === 'Buy' ? 1 : -1), 3)}</td>
                    <td>
                      <button className="text-muted hover:text-down" onClick={() => setLegs(legs.filter((x) => x.id !== l.id))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {legs.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-muted">
              {net >= 0 ? 'Кредит' : 'Дебет'}: <b className={pnlClass(net)}>{fmtUsd(Math.abs(net), 4)} USDT</b>
            </span>
            <button className="btn btn-brand ml-auto" onClick={execAll}>
              Исполнить все ноги по рынку
            </button>
            <button className="btn btn-ghost" onClick={() => setLegs([])}>
              Очистить
            </button>
          </div>
        )}
      </div>
      <div className="border-l border-line p-2">{legs.length ? <PayoffSummary legs={payoff} S={S} /> : <Empty>Профиль выплат стратегии появится здесь</Empty>}</div>
    </div>
  );
}

