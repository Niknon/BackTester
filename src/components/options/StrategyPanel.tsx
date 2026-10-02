import { useMemo, useState } from 'react';
import { optionFee, optionQtyStep, parseOptionSymbol, shortOptionMargin } from '../../engine/options';
import { legValueAt, openStrategy, resolveStrategy, STRATEGIES, VIEW_LABEL, type StrategyDef, type StrategyView } from '../../engine/optionStrategies';
import { bump, toast, useSession, useTick } from '../../store/session';
import { exactDecimals, fmtNum, fmtShortDate, fmtUsd, pnlClass, autoDecimals } from '../../lib/format';
import { cx, Empty, NumInput, Row, usePersistent } from '../ui';
import { breakevens, PayoffChart, payoffAtExpiry, payoffNow, type PayoffLeg } from './PayoffChart';
import { dte } from './OptionPositions';

const VIEW_COLOR: Record<StrategyView, string> = { bull: 'text-up', bear: 'text-down', neutral: 'text-info', vol: 'text-violet' };

/** Мини-профиль выплат шаблона (для карточки в списке). */
function MiniPayoff({ def }: { def: StrategyDef }) {
  const pts = useMemo(() => {
    const legs: PayoffLeg[] = def.legs.map((l) => {
      const k = 100 + (l.k ?? 0) * 10;
      const prem = l.type === 'F' ? 100 : Math.max(1.5, 5 - Math.abs(l.k ?? 0) * 1.5) + (l.far ? 3 : 0);
      return { type: l.type, strike: k, qty: (l.side === 'Buy' ? 1 : -1) * (l.ratio ?? 1), entry: prem, valueAtExpiry: l.far ? (x: number) => Math.max(0, l.type === 'C' ? x - k : k - x) + 3 : undefined };
    });
    const xs = Array.from({ length: 41 }, (_, i) => 60 + i * 2);
    return xs.map((x) => payoffAtExpiry(legs, x));
  }, [def]);
  const max = Math.max(...pts.map(Math.abs), 1e-9);
  const w = 64;
  const h = 26;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h / 2 - (v / max) * (h / 2 - 2)).toFixed(1)}`).join('');
  return (
    <svg width={w} height={h} className="shrink-0">
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} stroke="#33363f" />
      <path d={path} fill="none" stroke="#f7a600" strokeWidth={1.5} />
    </svg>
  );
}

export function StrategyPanel({
  group,
  base,
  strikes,
  S,
  expiries,
  expiry,
  onExpiry,
}: {
  group: 'main' | 'more';
  base: string;
  strikes: number[];
  S: number;
  expiries: number[];
  expiry: number;
  onExpiry: (e: number) => void;
}) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const list = STRATEGIES.filter((d) => d.group === group);
  const [key, setKey] = usePersistent<string>(`bt-strat-${group}`, list[0].key);
  const [viewF, setViewF] = useState<StrategyView | 'all'>('all');
  const def = list.find((d) => d.key === key) ?? list[0];
  const [widthMap, setWidthMap] = useState<Record<string, number>>({});
  const width = widthMap[def.key] ?? def.width ?? 1;
  const [centerOff, setCenterOff] = useState(0);
  const step = optionQtyStep(S);
  const [qtyMap, setQtyMap] = usePersistent<Record<string, number>>('bt-strat-qty', {});
  const qty = qtyMap[base] ?? Number((step * 10).toPrecision(6));
  const nearIdx = Math.max(0, expiries.indexOf(expiry));
  const [farOff, setFarOff] = useState(2);
  const farExpiry = expiries[Math.min(expiries.length - 1, nearIdx + Math.max(1, farOff))] ?? expiry;
  const atmIdx = strikes.length ? strikes.reduce((b, k, i) => (Math.abs(k - S) < Math.abs(strikes[b] - S) ? i : b), 0) : 0;
  const centerIdx = Math.max(0, Math.min(strikes.length - 1, atmIdx + centerOff));
  const res = strikes.length ? resolveStrategy(ex, def, base, strikes, centerIdx, width, expiry, farExpiry, qty) : { legs: [], error: 'Нет цепочки' };
  const calendarBad = def.calendar && farExpiry <= expiry;

  const fees = res.legs.map((l) => (l.category === 'option' ? optionFee(ex.config.fees.optionTaker, ex.config.fees.optionFeeCap, S, l.price, l.qty) : l.price * l.qty * ex.config.fees.linearTaker));
  const payoff: PayoffLeg[] = res.legs.map((l, i) => {
    const sign = l.side === 'Buy' ? 1 : -1;
    if (l.type === 'F') return { type: 'F', strike: 0, qty: sign * l.qty, entry: l.price + (sign * fees[i]) / l.qty };
    return {
      type: l.type,
      strike: l.strike,
      qty: sign * l.qty,
      entry: l.price + (sign * fees[i]) / l.qty,
      valueNow: (x: number) => ex.optionQuote(l.symbol, x)?.mark ?? 0,
      valueAtExpiry: l.expiry > expiry ? (x: number) => legValueAt(ex, l, x, expiry) : undefined,
    };
  });
  const premium = res.legs.filter((l) => l.category === 'option').reduce((s, l) => s + (l.side === 'Sell' ? 1 : -1) * l.price * l.qty, 0);
  const feeSum = fees.reduce((a, b) => a + b, 0);
  const margin = res.legs.reduce((s, l) => {
    if (l.type === 'F') return s + (l.price * l.qty) / ex.leverageOf(ex.main, l.symbol);
    if (l.side !== 'Sell') return s;
    return s + shortOptionMargin(ex.config.options, parseOptionSymbol(l.symbol)!, S, l.mark).im * l.qty;
  }, 0);
  const delta = res.legs.reduce((s, l) => s + l.delta, 0);
  const valid = !res.error && !calendarBad && res.legs.length === def.legs.length && Number.isFinite(S);

  // статистика профиля
  const stats = useMemo(() => {
    if (!valid) return null;
    const lo = S * 0.02;
    const hi = S * 3;
    const f = (x: number) => payoffAtExpiry(payoff, x);
    let maxP = -Infinity;
    let minP = Infinity;
    for (let i = 0; i <= 600; i++) {
      const v = f(lo + ((hi - lo) * i) / 600);
      maxP = Math.max(maxP, v);
      minP = Math.min(minP, v);
    }
    const slope = f(S * 4) - f(S * 3);
    const leftSlope = f(S * 0.02) - f(S * 0.04);
    return {
      maxP: slope > 1e-9 ? Infinity : maxP,
      minP: slope < -1e-9 ? -Infinity : minP,
      leftOpen: leftSlope,
      bes: breakevens(payoff, lo, hi, 1500),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, def.key, centerIdx, width, expiry, farExpiry, qty, S, ex.now]);

  const run = () => {
    if (!valid) return;
    const r = openStrategy(ex, res.legs);
    if (r.ok) toast('success', `Стратегия «${def.name}» открыта`, `${r.filled} ног по рынку · ${premium >= 0 ? 'кредит' : 'дебет'} ${fmtUsd(Math.abs(premium), 2)} USDT`, 6000);
    else toast('error', 'Стратегия не открыта', `${r.error}. Уже исполненные ноги закрыты обратно.`, 9000);
    bump(true);
  };

  const shown = list.filter((d) => viewF === 'all' || d.view === viewF);
  const kd = (k: number) => exactDecimals(k);
  const bound = (v: number) => (v === Infinity ? 'не ограничена' : v === -Infinity ? 'не ограничен' : fmtUsd(v, 2, true));
  const d = autoDecimals(S);

  return (
    <div className="grid grid-cols-[280px_1fr_430px] h-full min-h-0">
      <div className="border-r border-line flex flex-col min-h-0">
        <div className="flex flex-wrap gap-1 p-2 border-b border-line">
          {(['all', 'bull', 'bear', 'neutral', 'vol'] as const).map((v) => (
            <button key={v} className={cx('chip !px-1.5 text-[10px]', viewF === v && 'active')} onClick={() => setViewF(v)}>
              {v === 'all' ? 'Все' : VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <div className="overflow-auto flex-1 min-h-0">
          {shown.map((s) => (
            <button key={s.key} onClick={() => setKey(s.key)} className={cx('w-full flex items-center gap-2 px-2 py-1.5 text-left border-b border-line/50', s.key === def.key ? 'bg-brand/10' : 'hover:bg-panel2')}>
              <MiniPayoff def={s} />
              <div className="min-w-0">
                <div className={cx('font-semibold truncate', s.key === def.key && 'text-brand')}>{s.name}</div>
                <div className={cx('text-[10px]', VIEW_COLOR[s.view])}>
                  {VIEW_LABEL[s.view]} · <span className="text-muted">{s.risk}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="p-3 flex flex-col gap-2 overflow-auto min-h-0">
        <div>
          <div className="font-semibold text-[14px]">{def.name}</div>
          <div className="text-[11px] text-muted">{def.desc}</div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <label className="field">
            <span className="lbl">{def.calendar ? 'Ближняя' : 'Экспирация'}</span>
            <select value={expiry} onChange={(e) => onExpiry(Number(e.target.value))}>
              {expiries.map((e) => (
                <option key={e} value={e}>
                  {fmtShortDate(e)} · {dte(e, ex.now)}
                </option>
              ))}
            </select>
          </label>
          {def.calendar ? (
            <label className="field">
              <span className="lbl">Дальняя</span>
              <select value={farExpiry} onChange={(e) => setFarOff(expiries.indexOf(Number(e.target.value)) - nearIdx)}>
                {expiries.filter((e) => e > expiry).map((e) => (
                  <option key={e} value={e}>
                    {fmtShortDate(e)} · {dte(e, ex.now)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div />
          )}
          <div className="flex gap-1 col-span-2">
            <button className="btn h-8 w-8 p-0" onClick={() => setCenterOff(centerOff - 1)} title="Сдвинуть страйки ниже">
              ◀
            </button>
            <div className="field flex-1 justify-between">
              <span className="lbl">Центр</span>
              <span className="num">
                {strikes[centerIdx] !== undefined ? fmtNum(strikes[centerIdx], kd(strikes[centerIdx])) : '—'}
                <span className="text-dim text-[10px]"> {centerOff === 0 ? 'ATM' : `${centerOff > 0 ? '+' : ''}${centerOff}`}</span>
              </span>
            </div>
            <button className="btn h-8 w-8 p-0" onClick={() => setCenterOff(centerOff + 1)} title="Сдвинуть страйки выше">
              ▶
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {def.legs.some((l) => (l.k ?? 0) !== 0) ? (
            <div className="field justify-between">
              <span className="lbl">Ширина (шагов страйка)</span>
              <div className="flex items-center gap-1">
                <button className="btn btn-sm !h-6 w-6 p-0" onClick={() => setWidthMap({ ...widthMap, [def.key]: Math.max(1, width - 1) })}>
                  −
                </button>
                <span className="num w-6 text-center">{width}</span>
                <button className="btn btn-sm !h-6 w-6 p-0" onClick={() => setWidthMap({ ...widthMap, [def.key]: width + 1 })}>
                  +
                </button>
              </div>
            </div>
          ) : (
            <div />
          )}
          <NumInput label="Кол-во (×1)" value={qty || ''} onChange={(v) => setQtyMap({ ...qtyMap, [base]: v === '' ? 0 : v })} step={step} suffix={base} />
        </div>
        {res.legs.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Нога</th>
                <th>Инструмент</th>
                <th className="text-right">Кол-во</th>
                <th className="text-right">Цена (рынок)</th>
                <th className="text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {res.legs.map((l, i) => (
                <tr key={i}>
                  <td className={l.side === 'Buy' ? 'text-up' : 'text-down'}>
                    {l.side === 'Buy' ? 'Купить' : 'Продать'} {l.type === 'F' ? 'перп' : l.type === 'C' ? 'колл' : 'пут'}
                  </td>
                  <td className="num">
                    {l.type === 'F' ? l.symbol : `${fmtNum(l.strike, kd(l.strike))} · ${fmtShortDate(l.expiry)}`}
                  </td>
                  <td className="text-right num">{fmtNum(l.qty, 4)}</td>
                  <td className="text-right num">{fmtNum(l.price, l.type === 'F' ? d : 4)}</td>
                  <td className="text-right num">{fmtNum(l.delta, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(res.error || calendarBad) && <div className="text-down text-[12px]">{calendarBad ? 'Выберите дальнюю экспирацию позже ближней' : res.error}</div>}
        <div className="grid grid-cols-2 gap-x-4 text-[11px]">
          <Row label={premium >= 0 ? 'Кредит (получаете)' : 'Дебет (платите)'} value={<span className={pnlClass(premium)}>{fmtUsd(Math.abs(premium), 2)} USDT</span>} />
          <Row label="Комиссии" value={`${fmtUsd(feeSum, 2)} USDT`} />
          <Row label="Маржа (оценка)" value={`${fmtUsd(margin, 2)} USDT`} />
          <Row label="Доступно" value={`${fmtUsd(ex.available(ex.main), 2)} USDT`} />
          <Row label="Дельта стратегии" value={fmtNum(delta, 3)} />
          <Row label="Ног" value={String(res.legs.length)} />
        </div>
        <button className="btn btn-brand h-10" disabled={!valid} onClick={run}>
          Открыть «{def.name}» по рынку
        </button>
        <div className="text-[10px] text-dim">Все ноги исполняются сразу по рыночной цене (покупки по Ask, продажи по Bid). Если одна из ног не проходит — уже исполненные автоматически закрываются.</div>
      </div>
      <div className="border-l border-line p-2 flex flex-col gap-1 min-h-0 overflow-auto">
        {valid && stats ? (
          <>
            <div className="text-[11px] text-muted">Профиль выплат {def.calendar ? `на ближнюю экспирацию (${fmtShortDate(expiry)})` : 'на экспирации'} и сейчас (T+0)</div>
            <PayoffChart legs={payoff} spot={S} height={200} range={0.25} />
            <div className="grid grid-cols-2 gap-x-3 text-[11px]">
              <Row label="Макс. прибыль" value={<span className="text-up">{bound(stats.maxP)}</span>} />
              <Row label="Макс. убыток" value={<span className="text-down">{bound(stats.minP)}</span>} />
            </div>
            <Row label="Безубыточность" value={stats.bes.length ? stats.bes.map((b) => fmtNum(b, d)).join(' / ') : '—'} />
            <table className="w-full text-[10.5px] num">
              <thead>
                <tr className="text-muted">
                  <td>Цена {base}</td>
                  <td className="text-right">Сейчас</td>
                  <td className="text-right">{def.calendar ? 'Ближ. эксп.' : 'Экспирация'}</td>
                </tr>
              </thead>
              <tbody>
                {[-0.15, -0.07, -0.03, 0, 0.03, 0.07, 0.15].map((k) => {
                  const x = S * (1 + k);
                  const a = payoffNow(payoff, x);
                  const b = payoffAtExpiry(payoff, x);
                  return (
                    <tr key={k} className={k === 0 ? 'bg-panel2' : ''}>
                      <td>
                        {k === 0 ? 'текущая' : `${k > 0 ? '+' : ''}${(k * 100).toFixed(0)}%`} <span className="text-dim">{fmtNum(x, d)}</span>
                      </td>
                      <td className={cx('text-right', pnlClass(a))}>{fmtUsd(a, 2, true)}</td>
                      <td className={cx('text-right', pnlClass(b))}>{fmtUsd(b, 2, true)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <Empty>Профиль выплат появится здесь</Empty>
        )}
      </div>
    </div>
  );
}
