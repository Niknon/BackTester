import { useEffect, useMemo, useState } from 'react';
import { ASSETS, getAsset, roundToStep, spotQtyStep } from '../../data/assets';
import { gridLevels, maxFeasibleGrids } from '../../engine/bots/grid';
import { suggestFuturesGrid, suggestSpotGrid } from '../../engine/bots/suggest';
import { COMBO_UTILIZATION } from '../../engine/bots/combo';
import type { BotParamsMap, BotType, ComboLeg, GridMode } from '../../engine/bots/types';
import { ensureSymbol } from '../../store/actions';
import { useSession, useTick, toast } from '../../store/session';
import { fmtNum, fmtPct, fmtPrice, fmtUsd } from '../../lib/format';
import { Check, cx, Help, NumInput, PercentSlider, Row, Segmented, Select } from '../ui';
import type { BotPreview } from './botChart';

export interface FormResult<T extends BotType = BotType> {
  type: T;
  name: string;
  investment: number;
  params: BotParamsMap[T];
}

interface FormProps {
  onSubmit: (r: FormResult, mode: 'live' | 'backtest') => void;
  busy?: boolean;
  initialSymbol: string;
  /** параметры для предпросмотра на графике */
  onPreview?: (p: BotPreview | null) => void;
  /** линия перетащена на графике: id ('pv:lower', 'pv:upper', …) и новая цена */
  chartDrag?: { id: string; price: number; n: number };
}

/** Сообщает странице параметры для предпросмотра (без лишних вызовов при каждом рендере). */
function usePreview(onPreview: FormProps['onPreview'], p: BotPreview | null) {
  const key = JSON.stringify(p);
  useEffect(() => {
    onPreview?.(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Применить перетаскивание линии на графике к полям формы. */
function useChartDrag(drag: FormProps['chartDrag'], map: Record<string, (v: number) => void>) {
  useEffect(() => {
    if (drag) map[drag.id]?.(drag.price);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.n]);
}

/* ───────── общие элементы ───────── */

/** Для фьючерсных ботов спотовые инструменты (xStocks, золото) недоступны. */
export function perpOr(symbol: string, ex: { market: { symbols(): string[] } }) {
  if (!getAsset(symbol).spotOnly) return symbol;
  return ex.market.symbols().find((s) => !getAsset(s).spotOnly) ?? 'BTCUSDT';
}

function SymbolPick({ value, onChange, label = 'Пара', spot = false }: { value: string; onChange: (s: string) => void; label?: string; spot?: boolean }) {
  const ex = useSession((s) => s.ex)!;
  const loading = useSession((s) => s.loadingSymbols);
  const ok = (s: string) => spot || !getAsset(s).spotOnly;
  const loaded = ex.market.symbols().filter(ok);
  const opts = [...loaded, ...ASSETS.map((a) => a.symbol).filter((s) => ok(s) && !loaded.includes(s))];
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      <select
        value={value}
        onChange={async (e) => {
          const s = e.target.value;
          if (!ex.market.has(s)) {
            const ok = await ensureSymbol(s);
            if (!ok) return;
          }
          onChange(s);
        }}
      >
        {opts.map((s) => (
          <option key={s} value={s}>
            {s}
            {ex.market.has(s) ? '' : loading.includes(s) ? ' (загрузка…)' : ' — загрузить'}
          </option>
        ))}
      </select>
    </label>
  );
}

function Investment({ value, onChange, min }: { value: number | ''; onChange: (v: number | '') => void; min?: number }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const avail = Math.max(0, ex.available(ex.main));
  const [pct, setPct] = useState(0);
  return (
    <div className="flex flex-col gap-1">
      <NumInput label="Инвестиции" value={value} onChange={(v) => (onChange(v), setPct(0))} suffix="USDT" step={100} />
      <PercentSlider
        value={pct}
        onChange={(p) => {
          setPct(p);
          onChange(Math.floor(avail * p) / 100);
        }}
      />
      <div className="flex justify-between text-[11px] text-muted">
        <span>Доступно: {fmtUsd(avail)} USDT</span>
        {min !== undefined && <span>Мин.: {fmtUsd(min)}</span>}
      </div>
    </div>
  );
}

function SubmitButtons({ onLive, onBacktest, busy, disabled }: { onLive: () => void; onBacktest: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <button className="btn btn-brand h-10" onClick={onLive} disabled={disabled}>
        Создать бота (в текущей сессии)
      </button>
      <button className="btn btn-ghost h-9" onClick={onBacktest} disabled={busy || disabled}>
        {busy ? 'Бэктест…' : '⚡ Быстрый бэктест с этими параметрами'}
      </button>
    </div>
  );
}

function GridStats({
  symbol,
  lower,
  upper,
  grids,
  mode,
  investment,
  leverage = 1,
  fee,
  spot,
  onGrids,
}: {
  symbol: string;
  lower: number;
  upper: number;
  grids: number;
  mode: GridMode;
  investment: number;
  leverage?: number;
  fee: number;
  spot?: boolean;
  /** предложить допустимое число сеток */
  onGrids?: (n: number) => void;
}) {
  if (!(upper > lower) || !(grids >= 2)) return null;
  const minQty = spot ? spotQtyStep(symbol) : getAsset(symbol).minQty;
  const tick = getAsset(symbol).tickSize;
  const levels = gridLevels(lower, upper, grids, mode, tick);
  const maxGrids = maxFeasibleGrids(symbol, lower, upper, mode, investment, leverage, minQty);
  const needInv = Math.ceil((minQty * (levels.reduce((a, b) => a + b, 0) - levels[0])) / (leverage * 0.9));
  let minP = Infinity;
  let maxP = -Infinity;
  for (let i = 1; i < levels.length; i++) {
    const p = levels[i] / levels[i - 1] - 1 - 2 * fee;
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);
  }
  const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
  const qty = (investment * leverage) / (grids * avg);
  return (
    <div className="bg-panel2 rounded-md px-3 py-2 text-[11px]">
      <Row label="Прибыль на сетку (после комиссий)" value={<span className={minP > 0 ? 'text-up' : 'text-down'}>{fmtPct(minP, 3, false)} – {fmtPct(maxP, 3, false)}</span>} />
      <Row label="Шаг сетки" value={fmtPrice(levels[1] - levels[0], symbol)} />
      <Row label="Объём на уровень ≈" value={`${fmtNum(roundToStep(qty, spot ? spotQtyStep(symbol) : getAsset(symbol).qtyStep, 'floor'), 6)} ${getAsset(symbol).base}`} />
      {grids > maxGrids && (
        <div className="mt-1.5 text-down leading-snug">
          ⚠ Объём уровня меньше минимального лота ({minQty} {getAsset(symbol).base}). Увеличьте инвестиции до ≈{fmtUsd(needInv, 0)} USDT
          {!spot && ' или плечо'}, либо уменьшите число сеток до {Math.max(2, maxGrids)}.
          {onGrids && maxGrids >= 2 && (
            <button className="btn btn-sm ml-1 !h-5 !text-[10px]" onClick={() => onGrids(maxGrids)}>
              Сеток: {maxGrids}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


/** Явный выбор плеча: поле + быстрые кнопки + ползунок. */
function LeverageControl({ value, onChange, max, hint }: { value: number; onChange: (v: number) => void; max: number; hint?: string }) {
  const presets = [1, 2, 3, 5, 10, 20, 50, 100].filter((x) => x <= max);
  return (
    <div className="flex flex-col gap-1.5 bg-panel2 rounded-md p-2.5 border border-line2">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Плечо</span>
        {hint && <span className="text-[10px] text-muted">{hint}</span>}
        <NumInput value={value} onChange={(v) => v !== '' && onChange(Math.max(1, Math.min(max, Math.round(v))))} suffix="x" className="!h-7 w-24 ml-auto" />
      </div>
      <div className="flex gap-1 flex-wrap">
        {presets.map((p) => (
          <button key={p} type="button" className={cx('chip border border-line2 !py-0.5', value === p && 'active !border-brand !text-brand')} onClick={() => onChange(p)}>
            {p}x
          </button>
        ))}
      </div>
      <input type="range" className="range" min={1} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="text-[10px] text-dim">Максимум для выбранных монет: {max}x</div>
    </div>
  );
}

/* ───────── Спотовый грид ───────── */

export function SpotGridForm({ onSubmit, busy, initialSymbol, onPreview, chartDrag }: FormProps) {
  const ex = useSession((s) => s.ex)!;
  const [symbol, setSymbol] = useState(initialSymbol);
  const [lower, setLower] = useState<number | ''>('');
  const [upper, setUpper] = useState<number | ''>('');
  const [grids, setGrids] = useState<number | ''>(30);
  const [mode, setMode] = useState<GridMode>('geometric');
  const [inv, setInv] = useState<number | ''>(1000);
  const [trigger, setTrigger] = useState<number | ''>('');
  const [tp, setTp] = useState<number | ''>('');
  const [sl, setSl] = useState<number | ''>('');
  const [sellOnStop, setSellOnStop] = useState(true);
  const [days, setDays] = useState(7);
  usePreview(onPreview, { kind: 'grid', symbol, lower: Number(lower), upper: Number(upper), grids: Number(grids), mode, trigger: Number(trigger) || undefined, tp: Number(tp) || undefined, sl: Number(sl) || undefined });
  useChartDrag(chartDrag, { 'pv:lower': setLower, 'pv:upper': setUpper, 'pv:trigger': setTrigger, 'pv:tp': setTp, 'pv:sl': setSl });
  const auto = () => {
    const s = suggestSpotGrid(ex, symbol, days, Number(inv) || undefined);
    if (!s) return toast('warn', 'Недостаточно истории для авто-параметров');
    setLower(s.lower);
    setUpper(s.upper);
    setGrids(s.grids);
    setMode(s.mode);
  };
  useEffect(auto, [symbol]);
  const result = (): FormResult<'spotGrid'> => ({
    type: 'spotGrid',
    name: `Спот-грид ${symbol}`,
    investment: Number(inv),
    params: {
      symbol,
      lower: Number(lower),
      upper: Number(upper),
      grids: Number(grids),
      mode,
      triggerPrice: trigger ? Number(trigger) : undefined,
      tpPrice: tp ? Number(tp) : undefined,
      slPrice: sl ? Number(sl) : undefined,
      sellOnStop,
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <SymbolPick value={symbol} onChange={setSymbol} spot />
      <div className="flex items-center gap-2">
        <button className="btn btn-sm !bg-brand/15 !text-brand" onClick={auto}>
          ✨ AI-параметры
        </button>
        <span className="text-muted text-[11px]">по истории за</span>
        <Segmented size="sm" value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: '3', label: '3д' }, { value: '7', label: '7д' }, { value: '30', label: '30д' }]} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumInput label="Нижняя" value={lower} onChange={setLower} suffix="USDT" />
        <NumInput label="Верхняя" value={upper} onChange={setUpper} suffix="USDT" />
        <NumInput label="Сеток" value={grids} onChange={setGrids} step={1} />
        <Select value={mode} onChange={setMode} options={[{ value: 'geometric', label: 'Геометрическая' }, { value: 'arithmetic', label: 'Арифметическая' }]} />
      </div>
      <GridStats symbol={symbol} lower={Number(lower)} upper={Number(upper)} grids={Number(grids)} mode={mode} investment={Number(inv)} fee={ex.config.fees.spotMaker} spot onGrids={setGrids} />
      <Investment value={inv} onChange={setInv} min={10} />
      <details className="text-[12px]">
        <summary className="cursor-pointer text-muted">Дополнительно: условие запуска, TP/SL</summary>
        <div className="grid grid-cols-1 gap-2 mt-2">
          <NumInput label="Цена запуска" value={trigger} onChange={setTrigger} placeholder="сразу" suffix="USDT" />
          <NumInput label="Take Profit (цена)" value={tp} onChange={setTp} placeholder="—" suffix="USDT" />
          <NumInput label="Stop Loss (цена)" value={sl} onChange={setSl} placeholder="—" suffix="USDT" />
          <Check checked={sellOnStop} onChange={setSellOnStop}>
            Продать монеты при остановке
          </Check>
        </div>
      </details>
      <SubmitButtons onLive={() => onSubmit(result(), 'live')} onBacktest={() => onSubmit(result(), 'backtest')} busy={busy} disabled={!lower || !upper || !grids || !inv} />
    </div>
  );
}

/* ───────── Фьючерсный грид ───────── */

export function FuturesGridForm({ onSubmit, busy, initialSymbol, onPreview, chartDrag }: FormProps) {
  const ex = useSession((s) => s.ex)!;
  const [symbol, setSymbol] = useState(() => perpOr(initialSymbol, useSession.getState().ex!));
  const [dir, setDir] = useState<'long' | 'short' | 'neutral'>('neutral');
  const [lower, setLower] = useState<number | ''>('');
  const [upper, setUpper] = useState<number | ''>('');
  const [grids, setGrids] = useState<number | ''>(40);
  const [mode, setMode] = useState<GridMode>('geometric');
  const [lev, setLev] = useState<number>(5);
  const [inv, setInv] = useState<number | ''>(1000);
  const [trigger, setTrigger] = useState<number | ''>('');
  const [tp, setTp] = useState<number | ''>('');
  const [sl, setSl] = useState<number | ''>('');
  const [tpRoi, setTpRoi] = useState<number | ''>('');
  const [slRoi, setSlRoi] = useState<number | ''>('');
  const [days, setDays] = useState(7);
  const max = getAsset(symbol).maxLeverage;
  usePreview(onPreview, { kind: 'grid', symbol, lower: Number(lower), upper: Number(upper), grids: Number(grids), mode, direction: dir, trigger: Number(trigger) || undefined, tp: Number(tp) || undefined, sl: Number(sl) || undefined });
  useChartDrag(chartDrag, { 'pv:lower': setLower, 'pv:upper': setUpper, 'pv:trigger': setTrigger, 'pv:tp': setTp, 'pv:sl': setSl });
  const auto = () => {
    const s = suggestFuturesGrid(ex, symbol, days, Number(inv) || undefined);
    if (!s) return toast('warn', 'Недостаточно истории для авто-параметров');
    setLower(s.lower);
    setUpper(s.upper);
    setGrids(s.grids);
    setMode(s.mode);
    setDir(s.direction);
    setLev(Math.min(max, s.leverage));
  };
  useEffect(auto, [symbol]);
  const result = (): FormResult<'futuresGrid'> => ({
    type: 'futuresGrid',
    name: `Фьюч-грид ${symbol} ${dir === 'long' ? 'Лонг' : dir === 'short' ? 'Шорт' : 'Нейтр.'}`,
    investment: Number(inv),
    params: {
      symbol,
      direction: dir,
      lower: Number(lower),
      upper: Number(upper),
      grids: Number(grids),
      mode,
      leverage: lev,
      triggerPrice: trigger ? Number(trigger) : undefined,
      tpPrice: tp ? Number(tp) : undefined,
      slPrice: sl ? Number(sl) : undefined,
      tpRoi: tpRoi ? Number(tpRoi) : undefined,
      slRoi: slRoi ? Number(slRoi) : undefined,
      closeOnStop: true,
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <SymbolPick value={symbol} onChange={setSymbol} />
      <Segmented
        value={dir}
        onChange={setDir}
        options={[
          { value: 'long', label: 'Лонг', className: '!text-up' },
          { value: 'short', label: 'Шорт', className: '!text-down' },
          { value: 'neutral', label: 'Нейтральный' },
        ]}
      />
      <div className="flex items-center gap-2">
        <button className="btn btn-sm !bg-brand/15 !text-brand" onClick={auto}>
          ✨ AI-параметры
        </button>
        <span className="text-muted text-[11px]">по истории за</span>
        <Segmented size="sm" value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: '3', label: '3д' }, { value: '7', label: '7д' }, { value: '30', label: '30д' }]} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumInput label="Нижняя" value={lower} onChange={setLower} suffix="USDT" />
        <NumInput label="Верхняя" value={upper} onChange={setUpper} suffix="USDT" />
        <NumInput label="Сеток" value={grids} onChange={setGrids} step={1} />
        <Select value={mode} onChange={setMode} options={[{ value: 'geometric', label: 'Геометрическая' }, { value: 'arithmetic', label: 'Арифметическая' }]} />
      </div>
      <LeverageControl value={lev} onChange={setLev} max={max} />
      <GridStats symbol={symbol} lower={Number(lower)} upper={Number(upper)} grids={Number(grids)} mode={mode} investment={Number(inv)} leverage={lev} fee={ex.config.fees.linearMaker} onGrids={setGrids} />
      <Investment value={inv} onChange={setInv} min={10} />
      <details className="text-[12px]">
        <summary className="cursor-pointer text-muted">Дополнительно: запуск, TP/SL</summary>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <NumInput label="Цена запуска" value={trigger} onChange={setTrigger} placeholder="сразу" className="col-span-2" />
          <NumInput label="TP цена" value={tp} onChange={setTp} placeholder="—" />
          <NumInput label="SL цена" value={sl} onChange={setSl} placeholder="—" />
          <NumInput label="TP ROI" value={tpRoi} onChange={setTpRoi} placeholder="—" suffix="%" />
          <NumInput label="SL ROI" value={slRoi} onChange={setSlRoi} placeholder="—" suffix="%" />
        </div>
      </details>
      <SubmitButtons onLive={() => onSubmit(result(), 'live')} onBacktest={() => onSubmit(result(), 'backtest')} busy={busy} disabled={!lower || !upper || !grids || !inv} />
    </div>
  );
}

/* ───────── Комбо (ребалансировка) ───────── */

export function ComboForm({ onSubmit, busy, onPreview }: FormProps) {
  const ex = useSession((s) => s.ex)!;
  const loaded = ex.market.symbols().filter((x) => !getAsset(x).spotOnly);
  const [legs, setLegs] = useState<ComboLeg[]>(() => {
    const syms = loaded.length ? loaded.slice(0, 3) : ['BTCUSDT'];
    const w = Math.floor((100 / Math.max(1, syms.length)) * 100) / 100;
    return syms.map((s, i) => ({ symbol: s, side: i === 0 ? 'long' : i === 1 ? 'short' : 'long', weight: i === syms.length - 1 ? Number((100 - w * (syms.length - 1)).toFixed(2)) : w }));
  });
  const [lev, setLev] = useState(3);
  const [modeR, setModeR] = useState<'time' | 'threshold' | 'none'>('threshold');
  const [interval, setIntervalH] = useState<number | ''>(24);
  const [threshold, setThreshold] = useState<number | ''>(5);
  const [inv, setInv] = useState<number | ''>(2000);
  const [tpRoi, setTpRoi] = useState<number | ''>('');
  const [slRoi, setSlRoi] = useState<number | ''>('');
  const sum = legs.reduce((s, l) => s + (Number(l.weight) || 0), 0);
  usePreview(onPreview, legs[0] ? { kind: 'combo', symbol: legs[0].symbol } : null);
  const maxLev = Math.min(...legs.map((l) => getAsset(l.symbol).maxLeverage), 100);
  const equalize = () => {
    const n = legs.length;
    const w = Math.floor((100 / n) * 100) / 100;
    setLegs(legs.map((l, i) => ({ ...l, weight: i === n - 1 ? Number((100 - w * (n - 1)).toFixed(2)) : w })));
  };
  const result = (): FormResult<'futuresCombo'> => ({
    type: 'futuresCombo',
    name: `Комбо ${legs.map((l) => (l.side === 'long' ? '▲' : '▼') + getAsset(l.symbol).base).join(' ')}`,
    investment: Number(inv),
    params: {
      legs: legs.map((l) => ({ ...l, weight: Number(l.weight) })),
      leverage: lev,
      rebalanceMode: modeR,
      intervalHours: Number(interval) || 24,
      thresholdPct: Number(threshold) || 5,
      tpRoi: tpRoi ? Number(tpRoi) : undefined,
      slRoi: slRoi ? Number(slRoi) : undefined,
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] text-muted">
        Портфель из USDT-перпетуалов с целевыми весами. Бот открывает лонг/шорт позиции и возвращает веса к цели по расписанию или при отклонении.
      </div>
      <div className="flex flex-col gap-1.5">
        {legs.map((l, i) => (
          <div key={i} className="flex gap-1.5 items-center">
            <div className="flex-1 min-w-0">
              <SymbolPick label="" value={l.symbol} onChange={(s) => setLegs(legs.map((x, k) => (k === i ? { ...x, symbol: s } : x)))} />
            </div>
            <button
              className={cx('btn h-8 w-16', l.side === 'long' ? '!text-up' : '!text-down')}
              onClick={() => setLegs(legs.map((x, k) => (k === i ? { ...x, side: x.side === 'long' ? 'short' : 'long' } : x)))}
            >
              {l.side === 'long' ? 'Лонг' : 'Шорт'}
            </button>
            <NumInput value={l.weight} onChange={(v) => setLegs(legs.map((x, k) => (k === i ? { ...x, weight: Number(v) || 0 } : x)))} suffix="%" className="w-24" />
            <button className="text-muted hover:text-down px-1" onClick={() => setLegs(legs.filter((_, k) => k !== i))}>
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-2 items-center">
          <button className="btn btn-sm" onClick={() => setLegs([...legs, { symbol: loaded.find((s) => !legs.some((l) => l.symbol === s)) ?? loaded[0] ?? 'BTCUSDT', side: 'long', weight: 0 }])}>
            + Монета
          </button>
          <button className="btn btn-sm btn-ghost" onClick={equalize}>
            Равные веса
          </button>
          <span className={cx('ml-auto text-[11px] num', Math.abs(sum - 100) > 0.5 ? 'text-down' : 'text-up')}>Σ {fmtNum(sum, 2)}%</span>
        </div>
      </div>
      <LeverageControl value={lev} onChange={setLev} max={maxLev} hint="одно для всех монет портфеля" />
      {Number(inv) > 0 && (
        <div className="bg-panel2 rounded-md px-3 py-2 text-[11px]">
          <div className="text-muted mb-1">Бот откроет позиции (≈, при текущих ценах):</div>
          {legs.map((l, i) => (
            <Row
              key={i}
              label={<span className={l.side === 'long' ? 'text-up' : 'text-down'}>{l.side === 'long' ? 'Лонг' : 'Шорт'} {getAsset(l.symbol).base}</span>}
              value={`${fmtUsd(Number(inv) * COMBO_UTILIZATION * lev * (Number(l.weight) || 0) / 100)} USDT`}
            />
          ))}
          <Row label="Общий объём позиций" value={<b>{fmtUsd(Number(inv) * COMBO_UTILIZATION * lev)} USDT</b>} />
          <Row label="Маржа (инвестиции)" value={`${fmtUsd(Number(inv))} USDT`} />
          <div className="text-[10px] text-dim mt-1">{Math.round((1 - COMBO_UTILIZATION) * 100)}% инвестиций остаётся в запасе под колебания маржи и комиссии.</div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="text-[11px] text-muted">
          Ребалансировка
          <Help text="По времени — каждые N часов. По отклонению — когда вес любой монеты отклонится от цели больше чем на порог (п.п.)." />
        </div>
        <Segmented
          size="sm"
          value={modeR}
          onChange={setModeR}
          options={[
            { value: 'threshold', label: 'По отклонению' },
            { value: 'time', label: 'По времени' },
            { value: 'none', label: 'Нет' },
          ]}
        />
        {modeR === 'time' && <NumInput label="Каждые" value={interval} onChange={setIntervalH} suffix="часов" step={1} />}
        {modeR === 'threshold' && <NumInput label="Порог отклонения" value={threshold} onChange={setThreshold} suffix="п.п." step={0.5} />}
      </div>
      <Investment value={inv} onChange={setInv} min={20} />
      <div className="grid grid-cols-2 gap-2">
        <NumInput label="TP ROI" value={tpRoi} onChange={setTpRoi} placeholder="—" suffix="%" />
        <NumInput label="SL ROI" value={slRoi} onChange={setSlRoi} placeholder="—" suffix="%" />
      </div>
      <SubmitButtons onLive={() => onSubmit(result(), 'live')} onBacktest={() => onSubmit(result(), 'backtest')} busy={busy} disabled={!legs.length || !inv} />
    </div>
  );
}

/* ───────── DCA ───────── */

export function DcaForm({ onSubmit, busy, initialSymbol, onPreview, chartDrag }: FormProps) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [amount, setAmount] = useState<number | ''>(100);
  const [interval, setIntervalH] = useState<number | ''>(24);
  const [maxOrders, setMaxOrders] = useState<number | ''>(10);
  const [below, setBelow] = useState<number | ''>('');
  const [tp, setTp] = useState<number | ''>('');
  usePreview(onPreview, { kind: 'dca', symbol, priceBelow: Number(below) || undefined, tpPct: Number(tp) || undefined });
  useChartDrag(chartDrag, { 'pv:below': setBelow });
  const inv = (Number(amount) || 0) * (Number(maxOrders) || 0);
  const result = (): FormResult<'dca'> => ({
    type: 'dca',
    name: `DCA ${symbol}`,
    investment: inv,
    params: {
      symbol,
      amount: Number(amount),
      intervalHours: Number(interval),
      maxOrders: Number(maxOrders),
      priceBelow: below ? Number(below) : undefined,
      tpPct: tp ? Number(tp) : undefined,
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] text-muted">Регулярные спотовые покупки на фиксированную сумму (усреднение цены входа). Опционально — продажа всего объёма при достижении прибыли.</div>
      <SymbolPick value={symbol} onChange={setSymbol} spot />
      <NumInput label="Сумма покупки" value={amount} onChange={setAmount} suffix="USDT" step={10} />
      <NumInput label="Каждые" value={interval} onChange={setIntervalH} suffix="часов" step={1} />
      <NumInput label="Число покупок" value={maxOrders} onChange={setMaxOrders} step={1} />
      <NumInput label="Покупать, если цена ниже" value={below} onChange={setBelow} placeholder="всегда" suffix="USDT" />
      <NumInput label="Take Profit от средней" value={tp} onChange={setTp} placeholder="—" suffix="%" />
      <Row label="Требуемые инвестиции" value={`${fmtUsd(inv)} USDT`} />
      <SubmitButtons onLive={() => onSubmit(result(), 'live')} onBacktest={() => onSubmit(result(), 'backtest')} busy={busy} disabled={!inv} />
    </div>
  );
}

/* ───────── Мартингейл ───────── */

export function MartingaleForm({ onSubmit, busy, initialSymbol, onPreview }: FormProps) {
  const [symbol, setSymbol] = useState(() => perpOr(initialSymbol, useSession.getState().ex!));
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [lev, setLev] = useState(5);
  const [init, setInit] = useState<number | ''>(20);
  const [step, setStep] = useState<number | ''>(1.5);
  const [mult, setMult] = useState<number | ''>(1.6);
  const [adds, setAdds] = useState<number | ''>(6);
  const [tp, setTp] = useState<number | ''>(1.2);
  const [sl, setSl] = useState<number | ''>('');
  const [loop, setLoop] = useState(true);
  const max = getAsset(symbol).maxLeverage;
  usePreview(onPreview, { kind: 'martingale', symbol, side, stepPct: Number(step) || 0, maxAdds: Number(adds) || 0, multiplier: Number(mult) || 1, tpPct: Number(tp) || 0, slPct: Number(sl) || undefined });
  const need = useMemo(() => {
    let t = 0;
    for (let i = 0; i <= (Number(adds) || 0); i++) t += (Number(init) || 0) * (Number(mult) || 1) ** i;
    return t;
  }, [init, mult, adds]);
  const [inv, setInv] = useState<number | ''>('');
  const investment = Number(inv) || Math.ceil(need * 1.1);
  const maxDrop = (1 - (1 - (Number(step) || 0) / 100) ** (Number(adds) || 0)) * 100;
  const result = (): FormResult<'martingale'> => ({
    type: 'martingale',
    name: `Мартингейл ${symbol} ${side === 'long' ? 'Лонг' : 'Шорт'}`,
    investment,
    params: {
      symbol,
      side,
      leverage: lev,
      initialMargin: Number(init),
      stepPct: Number(step),
      multiplier: Number(mult),
      maxAdds: Number(adds),
      tpPct: Number(tp),
      slPct: sl ? Number(sl) : undefined,
      loop,
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <SymbolPick value={symbol} onChange={setSymbol} />
      <Segmented
        value={side}
        onChange={setSide}
        options={[
          { value: 'long', label: 'Лонг', className: '!text-up' },
          { value: 'short', label: 'Шорт', className: '!text-down' },
        ]}
      />
      <LeverageControl value={lev} onChange={setLev} max={max} />
      <div className="grid grid-cols-2 gap-2">
        <NumInput label="1-й ордер" value={init} onChange={setInit} suffix="USDT" />
        <NumInput label="Шаг" value={step} onChange={setStep} suffix="%" step={0.1} />
        <NumInput label="Множитель" value={mult} onChange={setMult} suffix="×" step={0.1} />
        <NumInput label="Усреднений" value={adds} onChange={setAdds} step={1} />
        <NumInput label="Take Profit" value={tp} onChange={setTp} suffix="%" step={0.1} />
        <NumInput label="Stop Loss" value={sl} onChange={setSl} placeholder="—" suffix="%" />
      </div>
      <Check checked={loop} onChange={setLoop}>
        Перезапускать цикл после TP
      </Check>
      <div className="bg-panel2 rounded-md px-3 py-2 text-[11px]">
        <Row label="Нужная маржа на все усреднения" value={`${fmtUsd(need)} USDT`} />
        <Row label="Покрывает падение до" value={`${fmtNum(maxDrop, 1)}%`} />
      </div>
      <NumInput label="Инвестиции" value={inv} onChange={setInv} placeholder={`${Math.ceil(need * 1.1)}`} suffix="USDT" />
      <SubmitButtons onLive={() => onSubmit(result(), 'live')} onBacktest={() => onSubmit(result(), 'backtest')} busy={busy} disabled={!init || !step || !tp} />
    </div>
  );
}
