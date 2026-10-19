import { useMemo, useState } from 'react';
import { getAsset, optionsAvailable, roundToStep, qtyStepFor, strikeStyle } from '../../data/assets';
import { MAIN } from '../../engine/exchange';
import { optionQtyStep, strikeStep } from '../../engine/options';
import { resolveStrategy, STRATEGIES } from '../../engine/optionStrategies';
import type { Side } from '../../engine/types';
import { autoDecimals, exactDecimals, fmtNum, fmtPct, fmtPrice, fmtQty, fmtShortDate, fmtUsd, pnlClass } from '../../lib/format';
import { openStrategyAction } from '../../store/actions';
import { bump, toast, useSession, useTick, type PreviewLine } from '../../store/session';
import { cx, NumInput, usePersistent } from '../ui';
import { dte } from '../options/OptionPositions';
import { payoffStats, strategyEconomics } from '../options/strategyMath';
import { ChartOptionMenu, ChartPreviewLines } from './ChartOptionMenu';

type CtxTab = 'fut' | 'opt' | 'strat' | 'misc';

/**
 * Контекстное меню графика (правая кнопка): вкладки «Фьючерс/Спот», «Опцион», «Стратегия», «Прочее».
 * Все действия — относительно уровня цены, по которому кликнули.
 */
export function ChartContextMenu({
  symbol,
  price,
  category,
  onClose,
  onPriceToForm,
}: {
  symbol: string;
  price: number;
  category: 'linear' | 'spot' | 'option';
  onClose: () => void;
  onPriceToForm?: (p: number) => void;
}) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const spec = getAsset(symbol);
  const opts = optionsAvailable(spec);
  const spot = category === 'spot';
  const tabs: [CtxTab, string][] = [
    ['fut', spot ? 'Спот' : 'Фьючерс'],
    ...(opts && !spot ? ([['opt', 'Опцион'], ['strat', 'Стратегия']] as [CtxTab, string][]) : []),
    ['misc', 'Прочее'],
  ];
  const [saved, setTab] = usePersistent<CtxTab>('bt-ctx-tab', 'fut', ['fut', 'opt', 'strat', 'misc']);
  const tab = tabs.some((t) => t[0] === saved) ? saved : 'fut';
  const last = ex.price(symbol);
  const dist = Number.isFinite(last) ? price / last - 1 : NaN;
  return (
    <div className="flex flex-col max-h-full">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <div className="leading-tight">
          <div className="num font-semibold">{fmtPrice(price, symbol)}</div>
          <div className="text-[10px] text-muted">
            {symbol} · {Number.isFinite(dist) ? `${fmtPct(dist, 2)} от текущей` : ''}
          </div>
        </div>
        <button className="ml-auto text-muted hover:text-text px-1" onClick={onClose} title="Закрыть (Esc)">
          ✕
        </button>
      </div>
      <div className="flex gap-0.5 px-2 border-b border-line">
        {tabs.map(([k, l]) => (
          <button key={k} className={cx('tab !mr-0 !px-2 !py-1.5 text-[12px]', tab === k && 'active')} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="overflow-auto min-h-0 py-1">
        {tab === 'fut' && <FuturesTab symbol={symbol} price={price} spot={spot} onDone={onClose} />}
        {tab === 'opt' && <ChartOptionMenu symbol={symbol} price={price} onDone={onClose} />}
        {tab === 'strat' && <StrategyTab symbol={symbol} price={price} onDone={onClose} />}
        {tab === 'misc' && <MiscTab symbol={symbol} price={price} onDone={onClose} onPriceToForm={onPriceToForm} />}
      </div>
    </div>
  );
}

/* ───────── Фьючерс / Спот ───────── */

function FuturesTab({ symbol, price, spot, onDone }: { symbol: string; price: number; spot: boolean; onDone: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const spec = getAsset(symbol);
  const acc = ex.main;
  const last = ex.price(symbol);
  const cat = spot ? 'spot' : 'linear';
  const step = qtyStepFor(symbol, cat);
  // количество: монеты или USDT, своё для каждого актива (запоминается)
  const [qmap, setQmap] = usePersistent<Record<string, { v: number; unit: 'coin' | 'usdt' }>>(`bt-ctx-qty-${cat}`, {});
  const q = qmap[symbol] ?? { v: 0, unit: 'usdt' as const };
  const setQ = (p: Partial<{ v: number; unit: 'coin' | 'usdt' }>) => setQmap({ ...qmap, [symbol]: { ...q, ...p } });
  const lev = spot ? 1 : ex.leverageOf(acc, symbol);
  const mode = spot ? '' : ex.marginModeOf(acc, symbol) === 'cross' ? 'Кросс' : 'Изолир.';
  const avail = Math.max(0, ex.available(acc));
  const qtyAt = (px: number) => roundToStep(q.unit === 'coin' ? q.v : q.v / px, step, 'floor');
  const pos = acc.positions[symbol];
  const above = price > last;
  if (!spot && spec.spotOnly) return <div className="px-3 py-3 text-muted text-[12px]">{spec.base} торгуется только на споте.</div>;

  const place = (side: Side, kind: 'limit' | 'stop' | 'market', extra: { reduceOnly?: boolean } = {}) => {
    const px = kind === 'market' ? last : price;
    const qty = qtyAt(px);
    if (!(qty >= step)) return toast('warn', 'Укажите количество', `Минимум ${step} ${spec.base}`);
    const o = ex.placeOrder({
      category: cat,
      symbol,
      side,
      qty,
      orderType: kind === 'limit' ? 'Limit' : 'Market',
      price: kind === 'limit' ? price : undefined,
      triggerPrice: kind === 'stop' ? price : undefined,
      stopOrderType: kind === 'stop' ? 'Stop' : undefined,
      reduceOnly: extra.reduceOnly,
    });
    if (o.status === 'Rejected') return toast('error', 'Ордер отклонён', o.rejectReason);
    if (kind !== 'market') toast('info', `${kind === 'limit' ? 'Лимит' : 'Стоп'}: ${side === 'Buy' ? (spot ? 'покупка' : 'лонг') : spot ? 'продажа' : 'шорт'} ${fmtQty(qty, symbol, cat)} ${spec.base} @ ${fmtPrice(price, symbol)}`);
    bump(true);
    onDone();
  };
  const setStop = (kind: 'sl' | 'tp') => {
    const err = ex.setTradingStop(MAIN, symbol, kind === 'sl' ? { stopLoss: price } : { takeProfit: price });
    if (err) return toast('error', `${kind === 'sl' ? 'SL' : 'TP'} не установлен`, err);
    toast('success', `${kind === 'sl' ? 'Stop Loss' : 'Take Profit'} позиции: ${fmtPrice(price, symbol)}`);
    bump(true);
    onDone();
  };
  const maxCoin = (px: number) => (spot ? avail / px : (avail * lev) / px);
  const btn = (label: string, sub: string, cls: string, onClick: () => void, title?: string) => (
    <button className={cx('rounded border border-line2 px-2 py-1.5 text-left hover:bg-panel3', cls)} onClick={onClick} title={title}>
      <div className="font-semibold text-[12px]">{label}</div>
      <div className="text-[10px] text-muted num">{sub}</div>
    </button>
  );
  const est = (px: number) => {
    const qty = qtyAt(px);
    return qty > 0 ? `${fmtQty(qty, symbol, cat)} ${spec.base} ≈ ${fmtUsd(qty * px, 0)} USDT` : 'укажите количество';
  };
  const posLong = pos && pos.size > 0;
  return (
    <div className="px-2 flex flex-col gap-1.5">
      <div className="flex gap-1 items-end">
        <NumInput
          label={q.unit === 'usdt' ? 'Сумма' : 'Кол-во'}
          value={q.v || ''}
          onChange={(v) => setQ({ v: v === '' ? 0 : v })}
          step={q.unit === 'usdt' ? 10 : step}
          className="flex-1 !h-7"
        />
        <button className="btn !h-7 px-2 text-[10px] w-16" onClick={() => setQ({ unit: q.unit === 'coin' ? 'usdt' : 'coin', v: 0 })} title="Монеты или сумма в USDT">
          {q.unit === 'coin' ? spec.base : 'USDT'} ⇄
        </button>
      </div>
      <div className="flex gap-1">
        {[10, 25, 50, 100].map((p) => (
          <button
            key={p}
            className="chip flex-1 border border-line2 !px-0 text-[10px]"
            onClick={() => {
              const c = roundToStep((maxCoin(price) * p) / 100 * 0.98, step, 'floor');
              setQ(q.unit === 'coin' ? { v: c } : { v: Math.floor(c * price) });
            }}
          >
            {p}%
          </button>
        ))}
      </div>
      {!spot && (
        <div className="text-[10px] text-muted">
          {mode} {fmtNum(lev, lev % 1 ? 2 : 0)}x · доступно {fmtUsd(avail, 0)} USDT
        </div>
      )}
      <div className="text-[10px] text-dim pt-0.5">На уровне {fmtPrice(price, symbol)}</div>
      <div className="grid grid-cols-2 gap-1">
        {above ? (
          <>
            {btn(spot ? 'Лимит продажа' : 'Лимит шорт', est(price), 'text-down', () => place('Sell', 'limit'), 'Продажа, когда цена поднимется до уровня')}
            {btn(spot ? 'Стоп покупка' : 'Стоп лонг', est(price), 'text-up', () => place('Buy', 'stop'), 'Покупка по рынку при пробое уровня вверх')}
          </>
        ) : (
          <>
            {btn(spot ? 'Лимит покупка' : 'Лимит лонг', est(price), 'text-up', () => place('Buy', 'limit'), 'Покупка, когда цена опустится до уровня')}
            {btn(spot ? 'Стоп продажа' : 'Стоп шорт', est(price), 'text-down', () => place('Sell', 'stop'), 'Продажа по рынку при пробое уровня вниз')}
          </>
        )}
      </div>
      <div className="text-[10px] text-dim">По рынку ({fmtPrice(last, symbol)})</div>
      <div className="grid grid-cols-2 gap-1">
        {btn(spot ? 'Купить' : 'Купить / Лонг', est(last), 'text-up', () => place('Buy', 'market'))}
        {btn(spot ? 'Продать' : 'Продать / Шорт', est(last), 'text-down', () => place('Sell', 'market'))}
      </div>
      {!spot && pos && pos.size !== 0 && (
        <>
          <div className="text-[10px] text-dim">
            Позиция: <span className={posLong ? 'text-up' : 'text-down'}>{posLong ? 'лонг' : 'шорт'} {fmtQty(Math.abs(pos.size), symbol)}</span> @ {fmtPrice(pos.avgPrice, symbol)}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {(posLong ? !above : above)
              ? btn('Stop Loss здесь', 'вся позиция, по рынку', 'text-down', () => setStop('sl'))
              : btn('Take Profit здесь', 'вся позиция, по рынку', 'text-up', () => setStop('tp'))}
            {btn(
              'Закрыть лимитом',
              `${fmtQty(Math.abs(pos.size), symbol)} @ ${fmtPrice(price, symbol)}`,
              '',
              () => {
                const o = ex.closePosition(MAIN, symbol, price);
                if (o?.status === 'Rejected') toast('error', 'Ордер отклонён', o.rejectReason);
                else toast('info', `Лимит на закрытие @ ${fmtPrice(price, symbol)}`);
                bump(true);
                onDone();
              },
              'Reduce-only лимит на весь объём позиции',
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ───────── Опционная стратегия ───────── */

function StrategyTab({ symbol, price, onDone }: { symbol: string; price: number; onDone: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const set = useSession((s) => s.set);
  const spec = getAsset(symbol);
  const base = spec.base;
  const [key, setKey] = usePersistent<string>('bt-ctx-strat', 'bull_call');
  const [expIdx, setExpIdx] = usePersistent<number>('bt-ctx-opt-exp', 3);
  const [qtyMap, setQtyMap] = usePersistent<Record<string, number>>('bt-ctx-opt-qty', {});
  const [width, setWidth] = useState<number | null>(null);
  const def = STRATEGIES.find((d) => d.key === key) ?? STRATEGIES[0];
  const w = width ?? def.width ?? 1;
  const expiries = ex.optionExpiries(base);
  const idx = Math.max(0, Math.min(expIdx, expiries.length - 1));
  const expiry = expiries[idx];
  const farExpiry = expiries[Math.min(expiries.length - 1, idx + 2)] ?? expiry;
  const S = ex.price(symbol);
  const step = optionQtyStep(S);
  const qty = qtyMap[base] ?? Number((step * 10).toPrecision(6));
  // страйки — сетка с шагом экспирации вокруг уровня клика
  const kStep = expiry ? strikeStep(S, ex.optionT(symbol, expiry), strikeStyle(getAsset(symbol))) : 0;
  const [shift, setShift] = useState(0);
  const center = kStep ? Math.max(kStep, Number(((Math.round(price / kStep) + shift) * kStep).toPrecision(10))) : price;
  const N = 40;
  const strikes = useMemo(() => Array.from({ length: 2 * N + 1 }, (_, i) => Number((center + (i - N) * kStep).toPrecision(10))).filter((k) => k > 0), [center, kStep]);
  const centerIdx = strikes.indexOf(center);
  const res = expiry && centerIdx >= 0 ? resolveStrategy(ex, def, base, strikes, centerIdx, w, expiry, farExpiry, qty) : { legs: [], error: 'Нет экспираций' };
  const valid = !res.error && res.legs.length === def.legs.length && !(def.calendar && farExpiry <= expiry);
  const eco = valid ? strategyEconomics(ex, res.legs, expiry, S) : null;
  const stats = eco ? payoffStats(eco.payoff, S) : null;
  const bound = (v: number) => (v === Infinity ? '∞' : v === -Infinity ? '−∞' : fmtUsd(v, 2, true));
  const d = autoDecimals(S);
  // предпросмотр на графике: страйки ног и точки безубыточности, пока открыта вкладка
  const kd = (k: number) => fmtNum(k, exactDecimals(k));
  const preview: PreviewLine[] = [];
  const byStrike = new Map<number, string[]>();
  for (const l of res.legs) {
    if (l.type === 'F') continue;
    const name = `${l.side === 'Buy' ? 'Купить' : 'Продать'} ${l.type === 'C' ? 'колл' : 'пут'}${l.qty !== qty ? ` ×${fmtNum(l.qty / qty, 0)}` : ''}${l.expiry !== expiry ? ' (дальн.)' : ''}`;
    byStrike.set(l.strike, [...(byStrike.get(l.strike) ?? []), name]);
  }
  for (const [k, names] of byStrike) {
    const buys = names.filter((n) => n.startsWith('Купить')).length;
    const color = buys === names.length ? '#20b26c' : buys === 0 ? '#ef454a' : '#a78bfa';
    preview.push({ id: `leg${k}`, price: k, color, title: `◇ ${names.join(' + ')} ${kd(k)}`, kind: 'leg' });
  }
  for (const [i, b] of (stats?.bes ?? []).entries()) preview.push({ id: `be${i}`, price: b, color: '#f7a600', title: '◇ Безубыточность', kind: 'be' });
  if (!expiries.length) return <div className="px-3 py-3 text-muted">Нет экспираций</div>;
  return (
    <div className="px-2 flex flex-col gap-1.5">
      <label className="field !h-7">
        <span className="lbl">Стратегия</span>
        <select value={def.key} onChange={(e) => (setKey(e.target.value), setWidth(null))}>
          <optgroup label="Основные">
            {STRATEGIES.filter((s) => s.group === 'main').map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Другие">
            {STRATEGIES.filter((s) => s.group === 'more').map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="text-[10px] text-muted leading-snug">{def.desc}</div>
      <div className="flex gap-1">
        <label className="field !h-7 flex-1 min-w-0">
          <span className="lbl">{def.calendar ? 'Ближняя' : 'Эксп.'}</span>
          <select className="min-w-0" value={idx} onChange={(e) => setExpIdx(Number(e.target.value))}>
            {expiries.map((e, i) => (
              <option key={e} value={i}>
                {fmtShortDate(e)} · {dte(e, ex.now)}
              </option>
            ))}
          </select>
        </label>
        {def.legs.some((l) => (l.k ?? 0) !== 0) && (
          <div className="field !h-7 !px-1.5 gap-1 shrink-0" title="Расстояние между страйками ног (в шагах страйка)">
            <span className="lbl">Ширина</span>
            <button className="text-muted hover:text-text px-1" onClick={() => setWidth(Math.max(1, w - 1))}>
              −
            </button>
            <span className="num w-4 text-center">{w}</span>
            <button className="text-muted hover:text-text px-1" onClick={() => setWidth(w + 1)}>
              +
            </button>
          </div>
        )}
      </div>
      <NumInput label="Кол-во (×1)" value={qty || ''} onChange={(v) => setQtyMap({ ...qtyMap, [base]: v === '' ? 0 : v })} step={step} suffix={base} className="!h-7" />
      <div className="flex items-center gap-1 text-[11px]">
        <span className="text-muted">Центр</span>
        <button className="btn btn-ghost !h-6 !px-1.5" onClick={() => setShift(shift - 1)} title={`Сдвинуть все страйки вниз на ${kd(kStep)}`}>
          −
        </button>
        <span className="num font-semibold min-w-[56px] text-center">{kd(center)}</span>
        <button className="btn btn-ghost !h-6 !px-1.5" onClick={() => setShift(shift + 1)} title={`Сдвинуть все страйки вверх на ${kd(kStep)}`}>
          +
        </button>
        <span className="text-[10px] text-dim ml-auto">
          шаг {kd(kStep)}
          {def.calendar && farExpiry > expiry ? ` · дальняя ${fmtShortDate(farExpiry)}` : ''}
        </span>
      </div>
      <ChartPreviewLines symbol={symbol} lines={preview} />
      {preview.length > 0 && <div className="text-[10px] text-dim">◇ Страйки и безубыточность показаны на графике</div>}
      {res.legs.length > 0 && (
        <div className="flex flex-col text-[11px] bg-panel3/40 rounded px-1.5 py-1">
          {res.legs.map((l, i) => (
            <div key={i} className="flex justify-between gap-2">
              <span className={l.side === 'Buy' ? 'text-up' : 'text-down'}>
                {l.side === 'Buy' ? 'Купить' : 'Продать'} {l.type === 'F' ? 'перп' : l.type === 'C' ? 'колл' : 'пут'} {l.type !== 'F' ? fmtNum(l.strike, exactDecimals(l.strike)) : ''}
                {l.type !== 'F' && l.expiry !== expiry ? ` (${fmtShortDate(l.expiry)})` : ''} ×{fmtNum(l.qty, 4)}
              </span>
              <span className="num text-muted">{fmtNum(l.price, l.type === 'F' ? d : 2)}</span>
            </div>
          ))}
        </div>
      )}
      {!valid && <div className="text-down text-[11px]">{res.error ?? 'Выберите дальнюю экспирацию позже ближней'}</div>}
      {eco && stats && (
        <div className="grid grid-cols-2 gap-x-2 text-[11px]">
          <span className="text-muted">{eco.premium >= 0 ? 'Кредит' : 'Дебет'}</span>
          <span className={cx('text-right num', pnlClass(eco.premium))}>{fmtUsd(Math.abs(eco.premium), 2)}</span>
          <span className="text-muted">Макс. прибыль / убыток</span>
          <span className="text-right num">
            <span className="text-up">{bound(stats.maxP)}</span> / <span className="text-down">{bound(stats.minP)}</span>
          </span>
          <span className="text-muted">Безубыточность</span>
          <span className="text-right num">{stats.bes.length ? stats.bes.map((b) => fmtNum(b, d)).join(' / ') : '—'}</span>
          <span className="text-muted">Маржа (оценка)</span>
          <span className="text-right num">{fmtUsd(eco.margin, 0)}</span>
        </div>
      )}
      <button
        className="btn btn-brand h-8"
        disabled={!valid}
        onClick={() => {
          openStrategyAction(def.name, res.legs);
          onDone();
        }}
      >
        Открыть «{def.name}» по рынку
      </button>
      <button
        className="text-[10px] text-muted hover:text-brand text-left"
        onClick={() => {
          localStorage.setItem('bt-opt-mode', JSON.stringify('strategies'));
          set({ page: 'options', optionBase: base });
          onDone();
        }}
      >
        Подробный разбор (график выплат, сценарии) — на странице «Опционы» →
      </button>
    </div>
  );
}

/* ───────── Прочее ───────── */

function MiscTab({ symbol, price, onDone, onPriceToForm }: { symbol: string; price: number; onDone: () => void; onPriceToForm?: (p: number) => void }) {
  const ex = useSession((s) => s.ex)!;
  const alerts = ex.alerts(symbol);
  const item = (label: string, onClick: () => void, cls = '') => (
    <button className={cx('w-full text-left px-3 py-1.5 hover:bg-panel3 rounded', cls)} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div className="flex flex-col px-1">
      {onPriceToForm &&
        item('✎ Подставить цену в форму ордера', () => {
          onPriceToForm(price);
          toast('info', `Цена ${fmtPrice(price, symbol)} подставлена в форму ордера`, undefined, 1800);
          onDone();
        })}
      {item('🔔 Алерт на этой цене (пауза при касании)', () => {
        const a = ex.addAlert(symbol, price);
        if (a) toast('info', `🔔 Алерт ${symbol} ${a.dir === 'up' ? '≥' : '≤'} ${fmtPrice(a.price, symbol)}`, 'Симуляция встанет на паузу при касании цены', 3000);
        bump(true);
        onDone();
      })}
      {item('⧉ Скопировать цену', () => {
        navigator.clipboard?.writeText(String(price)).catch(() => {});
        onDone();
      })}
      {alerts.length > 0 &&
        item(
          `✕ Удалить все алерты ${symbol} (${alerts.length})`,
          () => {
            for (const a of alerts) ex.removeAlert(a.id);
            bump(true);
            onDone();
          },
          'text-muted',
        )}
    </div>
  );
}
