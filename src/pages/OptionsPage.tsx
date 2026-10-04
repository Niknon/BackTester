import { useEffect, useMemo, useRef, useState } from 'react';
import { ASSETS, getAsset, SECTOR_LABEL } from '../data/assets';
import { DAY } from '../data/intervals';
import { realizedVolAt } from '../data/volatility';
import { MAIN } from '../engine/exchange';
import { blackScholes, expiryCode, optionQtyStep, optionSymbol, optionTickSize, shortOptionMargin, optionFee, yearsTo, smileIv, atmIv, type OptionQuote } from '../engine/options';
import type { Side } from '../engine/types';
import { ensureSymbol } from '../store/actions';
import { bump, toast, useSession, useTick } from '../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtShortDate, fmtTime, fmtUsd, pnlClass, autoDecimals, exactDecimals } from '../lib/format';
import { Badge, cx, Dropdown, Empty, NumInput, Row, Segmented, Tabs, usePersistent, useResizable } from '../components/ui';
import { PositionsTable } from '../components/trade/BottomPanel';
import { AllPositions, positionsCount } from '../components/positions/AllPositions';
import { StrategyPanel } from '../components/options/StrategyPanel';
import { LineStyle } from 'lightweight-charts';
import { PayoffChart, breakevens, payoffAtExpiry, type PayoffLeg } from '../components/options/PayoffChart';
import { PriceChart, type ExtraLine } from '../components/chart/PriceChart';
import { XYChart } from '../components/options/VolCharts';
import { OptionPositions, dte } from '../components/options/OptionPositions';

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
  // режим основной области: торговля (цепочка/график + тикет) или опционные стратегии
  const [mode, setMode] = usePersistent<'trade' | 'strategies'>('bt-opt-mode', 'trade', ['trade', 'strategies']);
  const [bottomCollapsed, setBottomCollapsed] = usePersistent<boolean>('bt-opt-bottom-collapsed', false);
  const [bottom, setBottom] = usePersistent<'positions' | 'orders' | 'builder' | 'history' | 'perps' | 'vol' | 'all'>('bt-opt-bottom-tab', 'positions', [
    'positions',
    'orders',
    'builder',
    'history',
    'perps',
    'vol',
    'all',
  ]);
  const [builder, setBuilder] = useState<BuilderLeg[]>([]);
  const [greekCols, setGreekCols] = useState(false);
  const [view, setView] = useState<'chain' | 'split' | 'chart'>(() => (localStorage.getItem('bt-opt-view') as any) || 'split');
  const bottomRes = useResizable(240, 120, 650, 'bt-opt-bottom-h');
  const splitRes = useResizable(240, 120, 700, 'bt-opt-chart-h', true);

  useEffect(() => {
    if (!expiries.includes(expiry) && expiries.length) setExpiry(expiries[Math.min(3, expiries.length - 1)]);
  }, [expiries.join(','), expiry]);

  const chain = useMemo(() => (loaded && expiry ? ex.optionChain(base, expiry) : null), [ex, base, expiry, loaded, ex.now, ex.state.cursor]);
  const S = chain?.S ?? NaN;
  const rv = realizedVolAt(ex.market.rv.get(underlying), ex.now);
  // в тикете всегда выбран опцион: по умолчанию ATM-колл; при смене экспирации/актива — ближайший страйк того же типа
  const chainKey = chain?.rows.map((r) => r.strike).join() ?? '';
  useEffect(() => {
    if (!chain || !chain.rows.length) return;
    const inst = draft ? ex.optionInstrument(draft.symbol) : null;
    if (inst && inst.base === base && inst.expiry === expiry && chain.rows.some((r) => r.strike === inst.strike)) return;
    const target = inst && inst.base === base ? inst.strike : chain.S;
    const row = chain.rows.reduce((b, r) => (Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b));
    const t = inst?.type ?? 'C';
    setDraft({ symbol: t === 'C' ? row.call.inst.symbol : row.put.inst.symbol, side: draft?.side ?? 'Buy' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, base, expiry]);

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

  // линии на графике: страйки позиций, безубыточность портфеля, выбранный в цепочке опцион
  const chartLines: ExtraLine[] = [];
  // страйки позиций рисует сам график (PriceChart)
  if (legs.length && Number.isFinite(S))
    breakevens(legs, S * 0.3, S * 1.7).forEach((b, i) =>
      chartLines.push({ id: 'be' + i, price: b, color: '#f7a600', title: 'Безубыточность', style: LineStyle.Dotted }),
    );
  if (draft) {
    const di = ex.optionInstrument(draft.symbol);
    const dq = ex.optionQuote(draft.symbol);
    if (di && dq) {
      chartLines.push({ id: 'draftK', price: di.strike, color: '#a78bfa', title: `Выбран: ${di.type === 'C' ? 'колл' : 'пут'} ${fmtNum(di.strike, autoDecimals(di.strike))}`, style: LineStyle.Solid });
      const prem = draft.side === 'Buy' ? dq.ask : dq.bid;
      chartLines.push({ id: 'draftBe', price: di.type === 'C' ? di.strike + prem : di.strike - prem, color: '#a78bfa', title: 'Безубыт. ордера', style: LineStyle.Dotted });
    }
  }

  const optOrders = ex.activeOrders(MAIN).filter((o) => o.category === 'option');
  const optHistory = ex.state.closedPnl.filter((c) => c.accountId === MAIN && c.category === 'option').slice(-200).reverse();
  const strikeDec = autoDecimals(S);
  const perpCount = Object.values(ex.main.positions).filter((p) => p.category === 'linear').length;

  return (
    <div className="h-full flex flex-col gap-1 p-1">
      <div className="bg-panel rounded-lg shrink-0">
        <BaseTabs base={base} onBase={(b) => set({ optionBase: b })} />
        <div className="flex items-center gap-5 px-4 py-1.5 overflow-x-auto">
          <div>
            <div className="text-[10px] text-muted">Цена {underlying}</div>
            <div className="num text-[17px] font-bold">{fmtPrice(S, underlying)}</div>
          </div>
          <Info label={`ATM IV (${dte(expiry, ex.now)})`} value={fmtPct(chain?.atm ?? NaN, 1, false)} />
          <Info label="RV 7д / 30д" value={`${fmtPct(rv?.rv7 ?? NaN, 1, false)} / ${fmtPct(rv?.rv30 ?? NaN, 1, false)}`} />
          {!getAsset(underlying).hasOptions && (
            <span className="shrink-0" title="На Bybit опционов на этот актив нет: котировки строятся по той же модели (Black–Scholes, IV из реализованной волатильности), исполнение и экспирация — как у опционов Bybit">
              <Badge color="violet">модельные опционы</Badge>
            </span>
          )}
          <Info label="Модель IV" value={ex.config.options.ivSource === 'realized' ? `RV × ${ex.config.options.ivPremium}` : ex.config.options.ivSource === 'dvol' ? 'DVOL' : 'фикс.'} />
          <Info label="Портфель Δ / Γ" value={`${fmtNum(greeks.delta, 3)} / ${fmtNum(greeks.gamma, 5)}`} />
          <Info label="Вега / Тета (день)" value={<span>{fmtNum(greeks.vega, 2)} / <span className={pnlClass(greeks.theta)}>{fmtNum(greeks.theta, 2)}</span></span>} />
          <span className="ml-auto text-[11px] text-dim text-right leading-tight hidden 2xl:block">
            Клик по строке цепочки — выбрать колл (слева) или пут (справа).
            <br />
            Bid — цена продажи, Ask — цена покупки. Сторону выберите в тикете справа.
          </span>
          <label className="ml-auto 2xl:ml-0 flex items-center gap-2 text-muted text-[11px] shrink-0">
            <input type="checkbox" className="checkbox" checked={greekCols} onChange={(e) => setGreekCols(e.target.checked)} /> Гамма/Вега/Тета в цепочке
          </label>
        </div>
        <div className="flex gap-1 px-3 pb-2 overflow-x-auto items-center">
          <Segmented
            className="shrink-0 mr-2"
            value={mode}
            onChange={(m) => {
              setMode(m);
              // на невысоких экранах стратегиям нужно место: нижняя панель сворачивается (вкладки остаются видны)
              if (m === 'strategies' && window.innerHeight < 950) setBottomCollapsed(true);
            }}
            options={[
              { value: 'trade', label: 'Торговля' },
              { value: 'strategies', label: 'Стратегии' },
            ]}
          />
          {expiries.map((e) => (
            <button key={e} className={cx('chip border border-line2 shrink-0', e === expiry && 'active !border-brand')} onClick={() => setExpiry(e)}>
              {fmtShortDate(e)} <span className="text-dim text-[10px]">{dte(e, ex.now)}</span>
            </button>
          ))}
        </div>
      </div>
      {mode === 'strategies' ? (
        <div className="flex-1 min-h-[260px] bg-panel rounded-lg overflow-hidden">
          <StrategyPanel base={base} strikes={chain?.rows.map((r) => r.strike) ?? []} S={S} expiries={expiries} expiry={expiry} onExpiry={setExpiry} />
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex gap-1">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          {view !== 'chain' && (
            <div className="min-h-0 shrink-0" style={view === 'chart' ? { flex: 1 } : { flex: `0 1 ${splitRes.h}px`, minHeight: 110 }}>
              <PriceChart symbol={underlying} tf={chartTf} onTfChange={(t) => set({ chartTf: t })} category="option" extraLines={chartLines} />
            </div>
          )}
          {view === 'split' && <div className="h-1 cursor-row-resize hover:bg-brand/40 rounded shrink-0" onMouseDown={splitRes.onDown} />}
          {view !== 'chart' && (
            <div className="flex-1 min-h-[150px] bg-panel rounded-lg overflow-auto">
              <ChainTable chain={chain} S={S} base={base} greekCols={greekCols} onPick={setDraft} draft={draft} strikeDec={strikeDec} />
            </div>
          )}
        </div>
        <div className="w-[340px] shrink-0 bg-panel rounded-lg overflow-auto">
          <OptionOrderPanel
            draft={draft}
            setDraft={setDraft}
            chain={chain}
            base={base}
            expiries={expiries}
            expiry={expiry}
            onExpiry={setExpiry}
            portfolio={legs}
            onAddToBuilder={(leg) => {
              setBuilder((b) => [...b, { ...leg, id: Date.now() }]);
              setBottom('builder');
            }}
          />
        </div>
      </div>
      )}
      <div className="h-1 cursor-row-resize hover:bg-brand/40 rounded shrink-0" onMouseDown={bottomRes.onDown} />
      <div
        className="shrink-0 bg-panel rounded-lg flex flex-col overflow-hidden"
        style={{ height: bottomCollapsed ? 37 : `min(${bottomRes.h}px, 28vh)` }}
      >
        <Tabs
          value={bottom}
          onChange={(t) => {
            setBottom(t);
            setBottomCollapsed(false);
          }}
          tabs={[
            { value: 'positions', label: `Позиции и профиль (${optPositions.length})` },
            { value: 'all', label: `Все позиции (${positionsCount(ex)})` },
            { value: 'orders', label: `Ордера (${optOrders.length})` },
            { value: 'builder', label: `Конструктор стратегий${builder.length ? ` (${builder.length})` : ''}` },
            { value: 'perps', label: `Фьючерсы (${perpCount})` },
            { value: 'history', label: 'История' },
            { value: 'vol', label: 'Улыбка и структура IV' },
          ]}
          right={
            <>
            <button
              className="btn btn-sm btn-ghost"
              title={bottomCollapsed ? 'Развернуть нижнюю панель' : 'Свернуть нижнюю панель — больше места для цепочки и стратегий'}
              onClick={() => setBottomCollapsed(!bottomCollapsed)}
            >
              {bottomCollapsed ? '▴ Развернуть' : '▾ Свернуть'}
            </button>
            {mode === 'trade' && <Segmented
              size="sm"
              value={view}
              onChange={(v) => {
                setView(v);
                localStorage.setItem('bt-opt-view', v);
              }}
              options={[
                { value: 'chain', label: 'Цепочка' },
                { value: 'split', label: 'Цепочка + график' },
                { value: 'chart', label: 'График' },
              ]}
            />}
            </>
          }
        />
        <div className="flex-1 min-h-0 overflow-auto">
          {bottom === 'positions' && (
            <div className="grid grid-cols-[1fr_460px] h-full">
              <div className="overflow-auto">
                <OptionPositions base={base} />
              </div>
              <div className="border-l border-line p-2">
                {legs.length ? <PayoffSummary legs={legs} S={S} /> : <Empty>Откройте опционную позицию, чтобы увидеть профиль выплат</Empty>}
              </div>
            </div>
          )}
          {bottom === 'orders' && <OptionOrders />}
          {bottom === 'all' && <AllPositions />}

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
          {bottom === 'vol' && chain && <VolPanel chain={chain} base={base} expiries={expiries} />}
          {bottom === 'perps' && <PositionsTable onSymbol={(sym) => set({ page: 'trade', symbol: sym })} onlyCurrent={false} symbol={underlying} />}
        </div>
      </div>
    </div>
  );
}

function VolPanel({ chain, base, expiries }: { chain: NonNullable<ReturnType<import('../engine/exchange').Exchange['optionChain']>>; base: string; expiries: number[] }) {
  const ex = useSession((s) => s.ex)!;
  const smile = useMemo(
    () => [
      { name: 'IV коллов', color: '#20b26c', points: chain.rows.map((r) => ({ x: r.strike, y: r.call.iv * 100 })) },
      { name: 'IV путов', color: '#ef454a', points: chain.rows.map((r) => ({ x: r.strike, y: r.put.iv * 100 })), dashed: true },
    ],
    [chain],
  );
  const term = useMemo(() => {
    const vol = ex.volInputs(`${base}USDT`);
    return [
      {
        name: 'ATM IV',
        color: '#f7a600',
        points: expiries.map((e) => ({ x: (e - ex.now) / DAY, y: atmIv(ex.config.options, vol, yearsTo(e, ex.now)) * 100 })),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, expiries.join(), ex.now]);
  const dec = chain.S >= 100 ? 0 : chain.S >= 1 ? 2 : 4;
  return (
    <div className="grid grid-cols-2 gap-2 p-2">
      <div>
        <div className="text-[11px] text-muted mb-1">Улыбка волатильности (IV по страйкам), %</div>
        <XYChart lines={smile} height={250} xDecimals={dec} />
      </div>
      <div>
        <div className="text-[11px] text-muted mb-1">Временная структура ATM IV (ось X — дней до экспирации), %</div>
        <XYChart lines={term} height={250} xDecimals={2} />
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

const SIM_BASES = () => ASSETS.filter((a) => a.simOptions && !a.hasOptions);

function BaseTabs({ base, onBase }: { base: string; onBase: (b: string) => void }) {
  const ex = useSession((s) => s.ex)!;
  const [q, setQ] = useState('');
  const sims = SIM_BASES();
  const cur = sims.find((a) => a.base === base);
  const list = sims.filter((a) => !q || a.base.includes(q.toUpperCase()) || a.name.toUpperCase().includes(q.toUpperCase()));
  return (
    <div className="flex items-center gap-2 px-3 pt-2 border-b border-line">
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
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
        {cur && (
          <div className="flex items-center shrink-0">
            <div className="w-px h-5 bg-line2 mx-2" />
            <div className="tab active !mr-3 flex items-center gap-1" title="Модельные опционы: на Bybit их нет, цены — по той же модели IV">
              {cur.base} <span className="text-violet text-[9px]">sim</span>
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 pb-1.5">
        <Dropdown
          align="right"
          width={330}
          button={
            <button className="btn btn-sm" title="Опционы на акции, ETF, индексы и сырьё США — в симуляции (на Bybit таких опционов нет)">
              Акции США и др. (симуляция) ▾
            </button>
          }
        >
          {(close: () => void) => (
            <div className="flex flex-col">
              <div className="p-1.5">
                <input autoFocus className="field w-full" placeholder="Тикер или название: AAPL, золото…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="text-[10px] text-dim px-2 pb-1">
                Модельные опционы (Black–Scholes, IV из реализованной волатильности). Базовый актив — USDT-перпетуал, история загружается с Bybit/OKX или Yahoo Finance.
              </div>
              {(['stock', 'etf', 'index', 'commodity'] as const).map((sec) => {
                const items = list.filter((a) => a.sector === sec);
                if (!items.length) return null;
                return (
                  <div key={sec}>
                    <div className="text-[10px] text-muted px-2 pt-1.5">{SECTOR_LABEL[sec]}</div>
                    <div className="grid grid-cols-3 gap-0.5 p-1">
                      {items.map((a) => (
                        <button
                          key={a.base}
                          className={cx('text-left px-1.5 py-1 rounded hover:bg-panel3 text-[12px]', a.base === base && 'bg-brand/15 text-brand')}
                          title={a.name}
                          onClick={() => {
                            onBase(a.base);
                            close();
                          }}
                        >
                          {a.base}
                          {!ex.market.has(a.symbol) && <span className="text-dim text-[9px]"> ↓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Dropdown>
      </div>
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
  const [hover, setHover] = useState<string | null>(null);
  const expiryKey = chain?.rows[0]?.call.inst.expiry ?? 0;
  useEffect(() => {
    const el = atmRef.current;
    const sc = el?.closest('.overflow-auto') as HTMLElement | null;
    if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 2;
  }, [base, expiryKey]);
  if (!chain || !chain.rows.length) return <Empty>Нет котировок</Empty>;
  const pos = ex.main.positions;
  const tick = optionTickSize(S);
  const pd = Math.max(0, -Math.floor(Math.log10(tick)));
  const f = (x: number) => (x > 0 ? fmtNum(x, pd) : '—');
  let atmInserted = false;
  const rows: React.ReactNode[] = [];
  const sel = draft?.symbol;
  /** ячейка цены: клик выбирает опцион и сторону (Bid → продать, Ask → купить) */
  const cellBtn = (q: OptionQuote, side: Side, val: number) => (
    <button
      className={cx(
        'num px-1.5 py-0.5 rounded hover:bg-panel3 hover:underline',
        side === 'Buy' ? 'text-down' : 'text-up',
        sel === q.inst.symbol && draft!.side === side && 'ring-1 ring-brand font-semibold',
      )}
      disabled={val <= 0}
      title={side === 'Buy' ? 'Ask — цена, по которой можно КУПИТЬ' : 'Bid — цена, по которой можно ПРОДАТЬ'}
      onClick={(e) => {
        e.stopPropagation();
        onPick({ symbol: q.inst.symbol, side });
      }}
    >
      {f(val)}
    </button>
  );
  /** половина строки (колл или пут): клик в любом месте выбирает опцион, сторона сохраняется */
  const half = (q: OptionQuote, itm: boolean) => {
    const isSel = sel === q.inst.symbol;
    const isHover = hover === q.inst.symbol;
    return {
      onClick: () => onPick({ symbol: q.inst.symbol, side: draft?.side ?? 'Buy' }),
      onMouseEnter: () => setHover(q.inst.symbol),
      className: cx('cursor-pointer', isSel ? 'bg-brand/15' : isHover ? 'bg-panel3/70' : itm && 'bg-brand/[0.04]'),
    };
  };
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
    const c = half(r.call, callItm);
    const pt = half(r.put, putItm);
    const rowSel = sel === r.call.inst.symbol || sel === r.put.inst.symbol;
    const pe = { onClick: pt.onClick, onMouseEnter: pt.onMouseEnter };
    const ce = { onClick: c.onClick, onMouseEnter: c.onMouseEnter };
    rows.push(
      <tr key={r.strike} onMouseLeave={() => setHover(null)}>
        <td {...ce} className={cx('text-right', c.className)}>{cp ? <span className={cp > 0 ? 'text-up' : 'text-down'}>{fmtNum(cp, 2)}</span> : ''}</td>
        {greekCols && <td {...ce} className={cx('text-right text-muted', c.className)}>{fmtNum(r.call.greeks.theta, 2)}</td>}
        {greekCols && <td {...ce} className={cx('text-right text-muted', c.className)}>{fmtNum(r.call.greeks.vega, 2)}</td>}
        {greekCols && <td {...ce} className={cx('text-right text-muted', c.className)}>{fmtNum(r.call.greeks.gamma, 5)}</td>}
        <td {...ce} className={cx('text-right', c.className)}>{fmtNum(r.call.greeks.delta, 3)}</td>
        <td {...ce} className={cx('text-right text-muted', c.className)}>{(r.call.iv * 100).toFixed(1)}%</td>
        <td {...ce} className={cx('text-right', c.className)}>{cellBtn(r.call, 'Sell', r.call.bid)}</td>
        <td {...ce} className={cx('text-right text-muted', c.className)}>{f(r.call.mark)}</td>
        <td {...ce} className={cx('text-right', c.className)}>{cellBtn(r.call, 'Buy', r.call.ask)}</td>
        <td className={cx('text-center font-bold num', rowSel ? 'bg-brand/25 text-brand' : 'bg-panel2')}>{fmtNum(r.strike, exactDecimals(r.strike))}</td>
        <td {...pe} className={pt.className}>{cellBtn(r.put, 'Sell', r.put.bid)}</td>
        <td {...pe} className={cx('text-muted', pt.className)}>{f(r.put.mark)}</td>
        <td {...pe} className={pt.className}>{cellBtn(r.put, 'Buy', r.put.ask)}</td>
        <td {...pe} className={cx('text-muted', pt.className)}>{(r.put.iv * 100).toFixed(1)}%</td>
        <td {...pe} className={pt.className}>{fmtNum(r.put.greeks.delta, 3)}</td>
        {greekCols && <td {...pe} className={cx('text-muted', pt.className)}>{fmtNum(r.put.greeks.gamma, 5)}</td>}
        {greekCols && <td {...pe} className={cx('text-muted', pt.className)}>{fmtNum(r.put.greeks.vega, 2)}</td>}
        {greekCols && <td {...pe} className={cx('text-muted', pt.className)}>{fmtNum(r.put.greeks.theta, 2)}</td>}
        <td {...pe} className={pt.className}>{pp ? <span className={pp > 0 ? 'text-up' : 'text-down'}>{fmtNum(pp, 2)}</span> : ''}</td>
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

function OptionOrderPanel({
  draft,
  setDraft,
  chain,
  base,
  expiries,
  expiry,
  onExpiry,
  portfolio,
  onAddToBuilder,
}: {
  draft: Draft | null;
  setDraft: (d: Draft) => void;
  chain: ReturnType<import('../engine/exchange').Exchange['optionChain']> | null;
  base: string;
  expiries: number[];
  expiry: number;
  onExpiry: (e: number) => void;
  portfolio: PayoffLeg[];
  onAddToBuilder: (l: Omit<BuilderLeg, 'id'>) => void;
}) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  // тип ордера запоминается между сессиями
  const [type, setType] = usePersistent<'Limit' | 'Market'>('bt-form-opt-type', 'Limit', ['Limit', 'Market']);
  const [price, setPrice] = useState<number | ''>('');
  const [qty, setQty] = useState<number | ''>('');
  const [withPortfolio, setWithPortfolio] = useState(false);
  const q = draft ? ex.optionQuote(draft.symbol) : null;
  useEffect(() => {
    if (q && draft) setPrice(draft.side === 'Buy' ? q.ask : q.bid);
    if (q && draft) setQty((prev) => (prev ? prev : Number((optionQtyStep(q.underlyingPrice) * 10).toPrecision(6))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.symbol, draft?.side]);
  if (!draft || !q || !chain) return <Empty>Выберите опцион в цепочке</Empty>;
  const inst = q.inst;
  const S = q.underlyingPrice;
  const step = optionQtyStep(S);
  const tick = optionTickSize(S);
  const side = draft.side;
  const buy = side === 'Buy';
  const px = type === 'Market' ? (buy ? q.ask : q.bid) : Number(price) || 0;
  const n = Number(qty) || 0;
  const fee = optionFee(ex.config.fees.optionTaker, ex.config.fees.optionFeeCap, S, px, n);
  const margin = !buy ? shortOptionMargin(ex.config.options, inst, S, q.mark) : null;
  const avail = ex.available(ex.main);
  const kd = exactDecimals(inst.strike);
  const strikes = chain.rows.map((r) => r.strike);
  const si = strikes.indexOf(inst.strike);
  const pick = (patch: { type?: 'C' | 'P'; strike?: number; side?: Side }) =>
    setDraft({ symbol: optionSymbol(base, inst.expiry, patch.strike ?? inst.strike, patch.type ?? inst.type), side: patch.side ?? side });
  const moneyness = (k: number, t: 'C' | 'P') => {
    const rel = k / S - 1;
    if (Math.abs(rel) < 0.005) return 'ATM';
    const itm = t === 'C' ? k < S : k > S;
    return `${itm ? 'ITM' : 'OTM'} ${rel > 0 ? '+' : ''}${(rel * 100).toFixed(1)}%`;
  };
  const submit = (s2: Side) => {
    if (!n) return toast('warn', 'Укажите количество');
    if (type === 'Limit' && !price) return toast('warn', 'Укажите цену');
    const o = ex.placeOrder({
      category: 'option',
      symbol: draft.symbol,
      side: s2,
      orderType: type,
      price: type === 'Limit' ? Number(price) : undefined,
      qty: n,
    });
    if (o.status === 'New') toast('info', `Лимит-ордер: ${s2 === 'Buy' ? 'покупка' : 'продажа'} ${draft.symbol}`, `${n} по ${price}. Исполнится, когда рыночная цена дойдёт до лимита.`);
    else if (o.status === 'Rejected') toast('error', 'Ордер отклонён', o.rejectReason);
    bump(true);
  };
  const g = q.greeks;
  const be = inst.type === 'C' ? inst.strike + px : inst.strike - px;
  const premium = px * n;
  // оценка цены базового актива, при которой новый шорт приведёт к ликвидации (прочие позиции — без изменений)
  const liqS = (() => {
    if (buy || !n) return NaN;
    const sum = ex.summary(ex.main);
    const eq0 = sum.equity - n * (q.mark - px) - fee;
    const mmOther = sum.maintenanceMargin;
    const dir = inst.type === 'C' ? 1 : -1;
    for (let k = 1; k <= 300; k++) {
      const x = S * (1 + dir * k * 0.002);
      if (x <= 0) break;
      const m = ex.optionQuote(draft.symbol, x)?.mark ?? 0;
      const eq = eq0 - n * (m - q.mark);
      const mm = mmOther + n * (m + ex.config.options.mmRate * x);
      if (eq <= mm) return x;
    }
    return Infinity;
  })();
  const right = inst.type === 'C' ? 'купить' : 'продать';
  const date = fmtShortDate(inst.expiry);
  const beTxt = fmtNum(be, autoDecimals(be));
  const explain = buy
    ? `Вы покупаете право ${right} ${fmtNum(n, 4)} ${base} по ${fmtNum(inst.strike, kd)} на экспирации ${date}. Платите премию ${fmtUsd(premium + fee)} USDT (с комиссией) — это максимальный возможный убыток. Прибыль, если ${base} на экспирации будет ${inst.type === 'C' ? 'выше' : 'ниже'} ${beTxt}.`
    : `Вы продаёте ${inst.type === 'C' ? 'колл' : 'пут'} и сразу получаете премию ${fmtUsd(Math.max(0, premium - fee))} USDT — это максимальная прибыль, если ${base} на экспирации будет ${inst.type === 'C' ? 'ниже' : 'выше'} ${fmtNum(inst.strike, kd)}. Убыток, если цена уйдёт ${inst.type === 'C' ? 'выше' : 'ниже'} ${beTxt}${inst.type === 'C' ? ' — он не ограничен' : ''}. Под позицию блокируется маржа.`;
  const sideBtn = (s2: Side) => {
    const p2 = s2 === 'Buy' ? q.ask : q.bid;
    const active = side === s2;
    return (
      <button
        type="button"
        onClick={() => pick({ side: s2 })}
        disabled={p2 <= 0}
        className={cx(
          'rounded-md border px-2 py-1.5 text-left transition-colors disabled:opacity-40',
          active ? (s2 === 'Buy' ? 'border-up bg-up/15' : 'border-down bg-down/15') : 'border-line2 hover:border-dim',
        )}
      >
        <div className={cx('font-semibold', s2 === 'Buy' ? 'text-up' : 'text-down')}>{s2 === 'Buy' ? 'Купить' : 'Продать'}</div>
        <div className="num text-[12px]">
          {fmtNum(p2, 4)} <span className="text-[10px] text-muted">{s2 === 'Buy' ? 'по Ask' : 'по Bid'}</span>
        </div>
      </button>
    );
  };
  return (
    <div className="p-3 flex flex-col gap-2.5">
      <div>
        <div className="font-bold text-[14px] truncate" title={draft.symbol}>
          {draft.symbol}
        </div>
        <div className="text-[11px] text-muted">
          {inst.type === 'C' ? 'Колл' : 'Пут'} · страйк {fmtNum(inst.strike, kd)} · {moneyness(inst.strike, inst.type)} · до экспирации {dte(inst.expiry, ex.now)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {(['C', 'P'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pick({ type: t })}
            className={cx('rounded-md border px-2 py-1.5 text-left', inst.type === t ? 'border-brand bg-brand/10' : 'border-line2 hover:border-dim')}
          >
            <div className="font-semibold">{t === 'C' ? 'Колл ▲' : 'Пут ▼'}</div>
            <div className="text-[10px] text-muted">{t === 'C' ? 'покупка — ставка на рост' : 'покупка — ставка на падение'}</div>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="lbl">Экспирация</span>
        <select value={expiry} onChange={(e) => onExpiry(Number(e.target.value))}>
          {expiries.map((e) => (
            <option key={e} value={e}>
              {fmtShortDate(e)} · {dte(e, ex.now)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-1">
        <button className="btn h-8 w-8 p-0" disabled={si <= 0} onClick={() => pick({ strike: strikes[si - 1] })} title="Страйк ниже">
          ◀
        </button>
        <label className="field flex-1">
          <span className="lbl">Страйк</span>
          <select value={inst.strike} onChange={(e) => pick({ strike: Number(e.target.value) })}>
            {strikes.map((k) => (
              <option key={k} value={k}>
                {fmtNum(k, exactDecimals(k))} · {moneyness(k, inst.type)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn h-8 w-8 p-0" disabled={si < 0 || si >= strikes.length - 1} onClick={() => pick({ strike: strikes[si + 1] })} title="Страйк выше">
          ▶
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {sideBtn('Buy')}
        {sideBtn('Sell')}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted -mt-1">
        <span>Mark {fmtNum(q.mark, 4)}</span>
        <span>IV {(q.iv * 100).toFixed(1)}%</span>
        <span>Δ {fmtNum(g.delta, 3)}</span>
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
      {type === 'Limit' && (
        <div className="flex flex-col gap-1">
          <NumInput label="Цена" value={price} onChange={setPrice} step={tick} suffix="USDT" />
          <div className="flex gap-1 text-[10px]">
            <button className="chip flex-1 border border-line2" onClick={() => setPrice(buy ? q.ask : q.bid)} title="Исполнится сразу">
              {buy ? 'Ask' : 'Bid'} {fmtNum(buy ? q.ask : q.bid, 4)}
            </button>
            <button className="chip flex-1 border border-line2" onClick={() => setPrice(Number(roundStep(q.mark, tick)))} title="Ждать исполнения по справедливой цене">
              Mark {fmtNum(q.mark, 4)}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <NumInput label="Кол-во" value={qty} onChange={setQty} step={step} suffix={inst.base} />
        <div className="flex gap-1">
          {[1, 5, 10, 50, 100].map((k) => {
            const v = Number((step * k).toPrecision(6));
            return (
              <button key={k} className={cx('chip flex-1 border border-line2 !px-0', n === v && 'active')} onClick={() => setQty(v)}>
                {v}
              </button>
            );
          })}
        </div>
      </div>
      <div className={cx('rounded-md p-2 text-[11px] leading-relaxed border', buy ? 'border-up/30 bg-up/5' : 'border-down/30 bg-down/5')}>{explain}</div>
      <div className="text-[11px] flex flex-col">
        <Row label={buy ? 'Премия к оплате' : 'Премия к получению'} value={`${fmtUsd(premium, 4)} USDT`} />
        <Row label="Комиссия" value={`${fmtNum(fee, 4)} USDT`} />
        {margin && <Row label="Маржа шорта (IM)" value={`${fmtUsd(margin.im * n)} USDT`} />}
        {!buy && n > 0 && (
          <Row
            label="Ликвидация (оценка)"
            value={
              <span className="text-brand" title="Цена базового актива, при которой капитал опустится до поддерживающей маржи (при текущей IV, остальные позиции без изменений)">
                {Number.isFinite(liqS) ? `${base} ${inst.type === 'C' ? '≥' : '≤'} ${fmtNum(liqS, autoDecimals(liqS))}` : `дальше ±60%`}
              </span>
            }
          />
        )}
        <Row label="Безубыточность" value={beTxt} />
        <Row label="Доступно" value={`${fmtUsd(avail)} USDT`} />
      </div>
      <button className={cx('btn h-10', buy ? 'btn-up' : 'btn-down')} onClick={() => submit(side)}>
        {buy ? 'Купить' : 'Продать'} {fmtNum(n, 4)} {inst.type === 'C' ? 'колл' : 'пут'} {fmtNum(inst.strike, kd)}
        {type === 'Market' ? ` за ~${fmtUsd(premium)} USDT` : ` по ${price}`}
      </button>
      <OrderPreview
        leg={{
          type: inst.type,
          strike: inst.strike,
          qty: (buy ? 1 : -1) * n,
          // премия + комиссия на контракт: для лонга дороже, для шорта меньше получаем
          entry: n > 0 ? px + ((buy ? 1 : -1) * fee) / n : px,
          valueNow: (x: number) => ex.optionQuote(draft.symbol, x)?.mark ?? 0,
        }}
        portfolio={withPortfolio ? portfolio : []}
        S={S}
      />
      {portfolio.length > 0 && (
        <label className="flex items-center gap-2 text-[11px] text-muted -mt-1">
          <input type="checkbox" className="checkbox" checked={withPortfolio} onChange={(e) => setWithPortfolio(e.target.checked)} />
          Учитывать открытые позиции по {inst.base}
        </label>
      )}
      <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
        {[
          ['Δ', g.delta, 3],
          ['Γ', g.gamma, 5],
          ['Vega', g.vega, 3],
          ['Θ/день', g.theta, 3],
        ].map(([l, v, d]) => (
          <div key={l as string} className="bg-panel2 rounded p-1">
            <div className="text-muted">{l}</div>
            <div className="num">{fmtNum((v as number) * n * (buy ? 1 : -1), d as number)}</div>
          </div>
        ))}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => onAddToBuilder({ side, type: inst.type, strike: inst.strike, qty: n || step })}>
        + Добавить ногу в конструктор стратегий
      </button>
    </div>
  );
}

function roundStep(v: number, step: number) {
  return (Math.round(v / step) * step).toFixed(Math.max(0, -Math.floor(Math.log10(step))));
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

/** Расчёт PnL ордера ДО открытия: профиль выплат, макс. прибыль/убыток, сценарии. */
function OrderPreview({ leg, portfolio, S }: { leg: PayoffLeg; portfolio: PayoffLeg[]; S: number }) {
  const legs = useMemo(() => [...portfolio, leg], [portfolio, leg.type, leg.strike, leg.qty, leg.entry, S]);
  if (!leg.qty || !Number.isFinite(S)) return null;
  const f = (x: number) => payoffAtExpiry(legs, x);
  // неограниченность: наклон далеко справа; слева цена ограничена нулём
  const slopeUp = f(S * 4) - f(S * 3);
  const vals: number[] = [];
  for (let i = 0; i <= 400; i++) vals.push(f(S * 0.001 + ((S * 3 - S * 0.001) * i) / 400));
  const maxP = slopeUp > 1e-9 ? Infinity : Math.max(...vals);
  const maxL = slopeUp < -1e-9 ? -Infinity : Math.min(...vals);
  const bes = breakevens(legs, S * 0.01, S * 3, 1200);
  const d = autoDecimals(S);
  const scen = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2];
  const nowPnl = (x: number) => {
    let v = 0;
    for (const l of legs) v += l.type === 'F' ? l.qty * (x - l.entry) : l.qty * ((l.valueNow ? l.valueNow(x) : 0) - l.entry);
    return v;
  };
  const fmtBound = (v: number) => (v === Infinity ? 'не ограничена' : v === -Infinity ? 'не ограничен' : fmtUsd(v, 2, true));
  return (
    <div className="flex flex-col gap-2 border border-line rounded-md p-2">
      <div className="text-[11px] font-semibold">PnL до открытия {portfolio.length ? '(с портфелем)' : ''}</div>
      <PayoffChart legs={legs} spot={S} height={170} range={0.25} />
      <div className="grid grid-cols-2 gap-x-3 text-[11px]">
        <Row label="Макс. прибыль" value={<span className="text-up">{fmtBound(maxP)}</span>} />
        <Row label="Макс. убыток" value={<span className="text-down">{fmtBound(maxL)}</span>} />
      </div>
      <Row label="Безубыточность" value={bes.length ? bes.map((b) => fmtNum(b, d)).join(' / ') : '—'} />
      <table className="w-full text-[10.5px] num">
        <thead>
          <tr className="text-muted">
            <td>Цена базы</td>
            <td className="text-right">Сейчас (T+0)</td>
            <td className="text-right">На экспирации</td>
          </tr>
        </thead>
        <tbody>
          {scen.map((k) => {
            const x = S * (1 + k);
            const a = nowPnl(x);
            const b = f(x);
            return (
              <tr key={k} className={k === 0 ? 'bg-panel2' : ''}>
                <td className="py-0.5">
                  {k === 0 ? 'текущая' : `${k > 0 ? '+' : ''}${(k * 100).toFixed(0)}%`} <span className="text-dim">{fmtNum(x, d)}</span>
                </td>
                <td className={cx('text-right', pnlClass(a))}>{fmtUsd(a, 2, true)}</td>
                <td className={cx('text-right', pnlClass(b))}>{fmtUsd(b, 2, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[10px] text-dim">С учётом комиссии. «Сейчас» — мгновенное изменение цены при текущей IV.</div>
    </div>
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

