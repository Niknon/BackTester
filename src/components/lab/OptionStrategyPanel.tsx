import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DAY } from '../../data/intervals';
import { getAsset } from '../../data/assets';
import {
  DEFAULT_OS,
  OS_BY_KEY,
  OS_PRESETS,
  OS_REASON_LABEL,
  OS_STRUCTURES,
  OS_SWEEP_PARAMS,
  hasPerpLeg,
  optionUnderlyings,
  previewEntry,
  runOptionStrategy,
  runOptionSweep,
  sweepValues,
  unlimitedRisk,
  usesDelta,
  usesWing,
  validateSettings,
  type OsExitReason,
  type OsResult,
  type OsSettings,
  type OsStructure,
  type OsSweepParam,
  type OsSweepRow,
  type OsTrade,
} from '../../engine/optionRunner';
import { strategyEconomics } from '../options/strategyMath';
import { PayoffChart } from '../options/PayoffChart';
import { downloadText, fmtNum, fmtPct, fmtPrice, fmtTime, fmtUsd, pnlClass, toCsv } from '../../lib/format';
import { toast, useSession } from '../../store/session';
import { Badge, Check, cx, Empty, Help, NumInput, ProgressBar, Segmented, Select, Tabs, usePersistent } from '../ui';
import { EquityChart } from '../EquityChart';
import { ReportGrid } from '../ReportGrid';
import { OptionTradesChart } from './OptionTradesChart';

const SETTINGS_KEY = 'bt-os-settings';
const USER_PRESETS_KEY = 'bt-os-user-presets';
const SECTIONS_KEY = 'bt-os-sections';

type Tab = 'overview' | 'preview' | 'chart' | 'trades' | 'metrics' | 'sweep' | 'log';
const TABS: Tab[] = ['overview', 'preview', 'chart', 'trades', 'metrics', 'sweep', 'log'];

const VIEW_LABEL: Record<OsStructure['view'], string> = { neutral: 'Боковик', bull: 'Рост', bear: 'Падение', vol: 'Волатильность' };
const VIEW_COLOR: Record<OsStructure['view'], string> = { neutral: 'text-brand', bull: 'text-up', bear: 'text-down', vol: 'text-[#a78bfa]' };
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* приватный режим */
  }
}

/** Настройки из localStorage, приведённые к текущей сессии (актив, депозит). */
function loadSettings(unders: string[], fallbackSymbol: string, balance: number): OsSettings {
  const stored = readJson<Partial<OsSettings>>(SETTINGS_KEY, {});
  const clean: Partial<OsSettings> = {};
  for (const [k, v] of Object.entries(stored)) if (k in DEFAULT_OS && typeof v === typeof (DEFAULT_OS as any)[k]) (clean as any)[k] = v;
  if (clean.structure && !OS_BY_KEY[clean.structure]) delete clean.structure;
  const underlying = stored.underlying && unders.includes(stored.underlying) ? stored.underlying : (unders[0] ?? fallbackSymbol);
  return { ...DEFAULT_OS, ...clean, underlying, initialBalance: balance };
}

/* ───────────────────────── мелкие элементы ───────────────────────── */

function Section({ id, title, open, onToggle, children, note }: { id: string; title: string; open: boolean; onToggle: (id: string) => void; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="border-b border-line">
      <button type="button" className="w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-panel2" onClick={() => onToggle(id)}>
        <span className={cx('text-dim text-[10px] transition-transform', open && 'rotate-90')}>▶</span>
        <span className="font-semibold">{title}</span>
        {note && <span className="ml-auto text-[11px] text-muted truncate max-w-[55%]">{note}</span>}
      </button>
      {open && <div className="px-3 pb-3 flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}

/** Ползунок + поле ввода. Введённое значение может выходить за диапазон ползунка. */
function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  hint,
  off,
  disabled,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  hint?: string;
  /** подпись для значения 0 («выкл.») */
  off?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cx('flex flex-col gap-1', disabled && 'opacity-40 pointer-events-none')}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted flex items-center">
          {label}
          {hint && <Help text={hint} />}
        </span>
        <div className="flex items-center gap-1.5">
          {off && value === 0 && <span className="text-dim">{off}</span>}
          <NumInput value={value} onChange={(v) => onChange(v === '' ? 0 : Math.max(0, v))} className="!h-6 w-[88px] !px-1.5" suffix={suffix} />
        </div>
      </div>
      <input type="range" className="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Kpi({ label, value, cls, sub, className }: { label: ReactNode; value: ReactNode; cls?: string; sub?: ReactNode; className?: string }) {
  return (
    <div className={cx('bg-panel2 rounded-md px-3 py-2 min-w-0', className)} title={typeof value === 'string' ? value : undefined}>
      <div className="text-[11px] text-muted truncate">{label}</div>
      <div className={cx('text-[15px] font-semibold num truncate', cls)}>{value}</div>
      {sub && <div className="text-[10px] text-dim truncate">{sub}</div>}
    </div>
  );
}

const legLabel = (st: OsStructure) =>
  st.legs
    .map((l) => {
      if (l.type === 'F') return `${l.side === 'Buy' ? '+' : '−'}перп`;
      const what = l.anchor === 'atm' ? 'ATM' : l.anchor === 'wing' ? 'крыло' : 'Δ';
      return `${l.side === 'Buy' ? '+' : '−'}${l.type === 'C' ? 'колл' : 'пут'} ${what}`;
    })
    .join(' · ');

const strikesText = (g: OsTrade) =>
  g.legs
    .filter((l) => l.type !== 'F')
    .map((l) => `${l.side === 'Buy' ? '+' : '−'}${l.type}${fmtNum(l.strike, l.strike < 100 ? 2 : 0)}`)
    .join(' ');

/* ───────────────────────── панель ───────────────────────── */

export function OptionStrategyPanel() {
  const ex = useSession((st) => st.ex)!;
  const v = useSession((st) => st.v);
  const unders = useMemo(() => optionUnderlyings(ex.market), [ex.market]);
  const [s, setS] = useState<OsSettings>(() => loadSettings(unders, ex.config.symbols[0], ex.config.initialBalance));
  const set = <K extends keyof OsSettings>(k: K, val: OsSettings[K]) => setS((cur) => ({ ...cur, [k]: val }));
  const [sections, setSections] = useState<Record<string, boolean>>(() => readJson(SECTIONS_KEY, { struct: true, strikes: true, schedule: true, size: true, exits: true, filters: false, hedge: false }));
  const toggleSection = (id: string) => {
    const next = { ...sections, [id]: !sections[id] };
    setSections(next);
    writeJson(SECTIONS_KEY, next);
  };
  const [userPresets, setUserPresets] = useState<Record<string, Partial<OsSettings>>>(() => readJson(USER_PRESETS_KEY, {}));
  const [auto, setAuto] = usePersistent('bt-os-auto', true);
  const [tab, setTab] = usePersistent<Tab>('bt-os-tab', 'overview', TABS);
  const [result, setResult] = useState<OsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stale, setStale] = useState(false);
  const [focus, setFocus] = useState<{ from: number; to: number } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const abortRef = useRef({ aborted: false });
  const runId = useRef(0);

  const st = OS_BY_KEY[s.structure];
  const err = validateSettings(s);
  const noOptions = unders.length === 0;

  useEffect(() => {
    const { initialBalance: _b, ...rest } = s;
    writeJson(SETTINGS_KEY, rest);
  }, [s]);

  const run = async (settings: OsSettings = s) => {
    if (validateSettings(settings)) return;
    abortRef.current.aborted = true;
    const ctl = { aborted: false };
    abortRef.current = ctl;
    const id = ++runId.current;
    setRunning(true);
    setProgress(0);
    const res = await runOptionStrategy(ex.market, ex.config, settings, { onProgress: (f) => id === runId.current && setProgress(f), signal: ctl });
    if (id !== runId.current) return; // запущен более новый прогон
    setRunning(false);
    if (res.error === 'Прервано') return;
    setResult(res);
    setStale(false);
    if (!res.ok) toast('error', 'Опционная стратегия', res.error);
  };
  const stop = () => {
    abortRef.current.aborted = true;
    runId.current++;
    setRunning(false);
  };

  // авто-пересчёт после изменения настроек (с задержкой — пока двигают ползунок)
  const first = useRef(true);
  useEffect(() => {
    if (noOptions) return;
    if (!first.current) setStale(true);
    const delay = first.current ? 150 : 650;
    first.current = false;
    if (!auto || validateSettings(s)) return;
    const h = setTimeout(() => run(s), delay);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, auto]);
  useEffect(() => () => void (abortRef.current.aborted = true), []);

  const applyPreset = (p: Partial<OsSettings>) => setS((cur) => ({ ...cur, ...DEFAULT_OS, ...p, underlying: cur.underlying, initialBalance: cur.initialBalance }));

  /* ── предпросмотр входа на текущий момент сессии ── */
  const preview = useMemo(() => {
    if (noOptions || err) return null;
    try {
      const pv = previewEntry(ex, s);
      if (pv.error || !pv.legs) return { error: pv.error ?? 'Нет данных' };
      const econ = strategyEconomics(ex, pv.legs, pv.pick.expiry, pv.pick.S);
      return { ...pv, econ };
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
    // v — перерисовка при движении сессии
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, s, v, err, noOptions]);

  /* ── перебор параметра ── */
  const [sweepParam, setSweepParam] = usePersistent<OsSweepParam>('bt-os-sweep', 'delta', OS_SWEEP_PARAMS.map((p) => p.key));
  const sweepDef = OS_SWEEP_PARAMS.find((p) => p.key === sweepParam)!;
  const [sweepRange, setSweepRange] = useState({ from: sweepDef.from, to: sweepDef.to, step: sweepDef.step });
  const [sweepRows, setSweepRows] = useState<OsSweepRow[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState(0);
  const sweepAbort = useRef({ aborted: false });
  const startSweep = async () => {
    const vals = sweepValues(sweepRange.from, sweepRange.to, sweepRange.step);
    setSweeping(true);
    setSweepRows([]);
    setSweepProgress(0);
    sweepAbort.current = { aborted: false };
    try {
      await runOptionSweep(ex.market, ex.config, s, sweepParam, vals, {
        signal: sweepAbort.current,
        onRow: (row, d, t) => {
          setSweepRows((r) => [...r, row]);
          setSweepProgress(d / t);
        },
      });
    } finally {
      setSweeping(false);
    }
  };

  if (noOptions)
    return (
      <div className="flex-1 bg-panel rounded-lg flex items-center justify-center p-6">
        <div className="max-w-md text-center text-muted">
          В этой сессии нет активов с опционами. Опционы доступны на BTC, ETH, SOL и других крупных монетах Bybit, а также модельные опционы на акции США — создайте сессию с таким активом.
        </div>
      </div>
    );

  const spec = getAsset(s.underlying);
  const r = result?.ok ? result : null;
  const views: OsStructure['view'][] = ['neutral', 'bull', 'bear', 'vol'];

  return (
    <div className="flex-1 min-h-0 flex gap-1">
      {/* ─────────────── настройки ─────────────── */}
      <aside
        className="w-[380px] shrink-0 bg-panel rounded-lg flex flex-col overflow-hidden"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            run();
          }
        }}
      >
        <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
          <span className="font-semibold">Настройки</span>
          <select
            className="ml-auto bg-panel2 border border-line rounded h-7 px-2 max-w-[200px]"
            value=""
            data-testid="os-presets"
            onChange={(e) => {
              const name = e.target.value;
              const p = OS_PRESETS.find((x) => x.name === name);
              if (p) applyPreset(p.s);
              else if (userPresets[name]) applyPreset(userPresets[name]);
            }}
          >
            <option value="">Готовые настройки…</option>
            <optgroup label="Пресеты">
              {OS_PRESETS.map((p) => (
                <option key={p.name} value={p.name} title={p.desc}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {Object.keys(userPresets).length > 0 && (
              <optgroup label="Мои">
                {Object.keys(userPresets).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className="btn btn-sm btn-ghost px-2"
            title="Сохранить текущие настройки"
            onClick={() => {
              const name = prompt('Название набора настроек:');
              if (!name) return;
              const { underlying: _u, initialBalance: _b, ...rest } = s;
              const next = { ...userPresets, [name]: rest };
              setUserPresets(next);
              writeJson(USER_PRESETS_KEY, next);
              toast('success', `Настройки «${name}» сохранены`);
            }}
          >
            💾
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <Section id="struct" title="Актив и конструкция" open={!!sections.struct} onToggle={toggleSection} note={st.name}>
            <div className="grid grid-cols-2 gap-2">
              <Select label="Базовый актив" value={s.underlying} onChange={(x) => set('underlying', x)} options={unders.map((u) => ({ value: u, label: u.replace(/USDT$/, '') }))} />
              <NumInput label="Депозит" value={s.initialBalance} onChange={(x) => set('initialBalance', x === '' ? 0 : x)} suffix="USDT" />
            </div>
            {views.map((view) => (
              <div key={view} className="flex flex-col gap-1">
                <div className={cx('text-[10px] uppercase tracking-wide', VIEW_COLOR[view])}>{VIEW_LABEL[view]}</div>
                <div className="flex flex-wrap gap-1">
                  {OS_STRUCTURES.filter((x) => x.view === view).map((x) => (
                    <button key={x.key} type="button" title={x.desc} className={cx('chip border border-line2 !h-6 !text-[11px]', s.structure === x.key && 'active')} onClick={() => set('structure', x.key)}>
                      {x.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="text-[11px] text-muted bg-panel2 rounded p-2 leading-snug">
              <div className="text-text mb-0.5">{legLabel(st)}</div>
              {st.desc}
              {unlimitedRisk(st) && <div className="text-down mt-1">⚠ Убыток не ограничен — следите за размером позиции.</div>}
            </div>
          </Section>

          <Section id="strikes" title="Страйки и срок" open={!!sections.strikes} onToggle={toggleSection} note={`${usesDelta(st) ? `Δ ${s.delta} · ` : ''}${s.dte} дн.`}>
            <SliderField
              label="Дельта основных ног"
              hint="Страйк выбирается так, чтобы |дельта| опциона была ближе всего к этому значению. 0.5 — около денег, 0.1–0.2 — далеко вне денег (меньше премия, выше шанс экспирировать без выплаты)."
              value={s.delta}
              onChange={(x) => set('delta', x)}
              min={0.03}
              max={0.5}
              step={0.01}
              disabled={!usesDelta(st)}
            />
            {usesWing(st) && (
              <>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted">Крыло (страховочная нога)</span>
                  <Segmented
                    size="sm"
                    value={s.wingMode}
                    onChange={(x) => set('wingMode', x)}
                    options={[
                      { value: 'pct', label: '% от цены' },
                      { value: 'delta', label: 'по дельте' },
                    ]}
                  />
                </div>
                {s.wingMode === 'pct' ? (
                  <SliderField label="Ширина крыла" hint="Расстояние от основной ноги до купленного крыла, в % от цены актива. Шире крыло — больше премия и больше максимальный убыток." value={s.wingPct} onChange={(x) => set('wingPct', x)} min={0.5} max={20} step={0.5} suffix="%" />
                ) : (
                  <SliderField label="Дельта крыла" value={s.wingDelta} onChange={(x) => set('wingDelta', x)} min={0.01} max={0.3} step={0.01} />
                )}
              </>
            )}
            <SliderField label="Дней до экспирации" hint="Берётся ближайшая доступная экспирация: дневные, недельные (пятница), месячные и квартальные." value={s.dte} onChange={(x) => set('dte', x)} min={1} max={90} step={1} suffix="дн." />
          </Section>

          <Section
            id="schedule"
            title="Когда входить"
            open={!!sections.schedule}
            onToggle={toggleSection}
            note={`${s.schedule === 'daily' ? 'каждый день' : s.schedule === 'weekdays' ? 'по будням' : `по ${WEEKDAYS[s.weekday].toLowerCase()}`} · ${String(s.entryHour).padStart(2, '0')}:00 UTC`}
          >
            <Segmented
              value={s.schedule}
              onChange={(x) => set('schedule', x)}
              options={[
                { value: 'daily', label: 'Каждый день' },
                { value: 'weekdays', label: 'По будням' },
                { value: 'weekly', label: 'Раз в неделю' },
              ]}
            />
            {s.schedule === 'weekly' && (
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <button key={d} type="button" className={cx('chip border border-line2 flex-1 !h-6 !text-[11px] justify-center', s.weekday === d && 'active')} onClick={() => set('weekday', d)}>
                    {WEEKDAYS[d]}
                  </button>
                ))}
              </div>
            )}
            <SliderField
              label="Час входа (UTC)"
              hint="Вход — на первой закрытой свече после этого часа. Экспирация опционов — в 08:00 UTC. На дневных свечах час не учитывается."
              value={s.entryHour}
              onChange={(x) => set('entryHour', Math.min(23, Math.round(x)))}
              min={0}
              max={23}
              step={1}
              suffix="ч"
            />
            <SliderField label="Макс. открытых конструкций" hint="Если лимит занят, вход переносится на ближайшую свечу того же дня, когда место освободится." value={s.maxOpen} onChange={(x) => set('maxOpen', Math.max(1, Math.round(x)))} min={1} max={10} step={1} />
          </Section>

          <Section
            id="size"
            title="Размер позиции"
            open={!!sections.size}
            onToggle={toggleSection}
            note={s.sizeMode === 'risk' ? `риск ${s.riskPct}%` : s.sizeMode === 'notional' ? `номинал ${s.notionalPct}%` : s.sizeMode === 'margin' ? `маржа ${s.marginPct}%` : `${s.qty} ${spec.base}`}
          >
            <Segmented
              size="sm"
              value={s.sizeMode}
              onChange={(x) => set('sizeMode', x)}
              options={[
                { value: 'risk', label: 'По риску', disabled: unlimitedRisk(st) },
                { value: 'notional', label: 'Номинал' },
                { value: 'margin', label: 'Маржа' },
                { value: 'qty', label: 'Кол-во' },
              ]}
            />
            {s.sizeMode === 'risk' && (
              <SliderField label="Макс. убыток на конструкцию" hint="Объём подбирается так, чтобы убыток на экспирации в худшем случае (с комиссиями) не превышал этот % капитала." value={s.riskPct} onChange={(x) => set('riskPct', x)} min={0.5} max={50} step={0.5} suffix="%" />
            )}
            {s.sizeMode === 'notional' && (
              <SliderField label="Номинал на ногу" hint="Количество контрактов = капитал × % / цена актива. 100% — одна нога на весь капитал (без плеча)." value={s.notionalPct} onChange={(x) => set('notionalPct', x)} min={5} max={300} step={5} suffix="%" />
            )}
            {s.sizeMode === 'margin' && (
              <SliderField label="Доля доступных средств" hint="Сколько свободных средств задействовать под премию покупок и маржу продаж." value={s.marginPct} onChange={(x) => set('marginPct', x)} min={5} max={100} step={5} suffix="%" />
            )}
            {s.sizeMode === 'qty' && <NumInput label="Контрактов на ногу" value={s.qty} onChange={(x) => set('qty', x === '' ? 0 : x)} suffix={spec.base} />}
            {unlimitedRisk(st) && s.sizeMode === 'risk' && <div className="text-[11px] text-down">Риск конструкции не ограничен — выберите другой способ.</div>}
          </Section>

          <Section
            id="exits"
            title="Выход из позиции"
            open={!!sections.exits}
            onToggle={toggleSection}
            note={[s.tpPct ? `TP ${s.tpPct}%` : '', s.slPct ? `SL ${s.slPct}%` : '', s.closeDte ? `за ${s.closeDte} дн.` : '', !s.tpPct && !s.slPct && !s.closeDte ? 'до экспирации' : ''].filter(Boolean).join(' · ')}
          >
            <SliderField
              label="Тейк-профит, % от премии"
              hint="Закрыть, когда прибыль достигла этой доли от полученной (для дебетовых — уплаченной) премии. Для продажи опционов часто берут 50%. Считается по маркировочной цене на закрытии свечи."
              value={s.tpPct}
              onChange={(x) => set('tpPct', x)}
              min={0}
              max={300}
              step={5}
              suffix="%"
              off="выкл."
            />
            <SliderField label="Стоп-лосс, % от премии" hint="Закрыть, когда убыток достиг этой доли от премии. Для кредитных конструкций — например, 200% (убыток = 2× полученной премии)." value={s.slPct} onChange={(x) => set('slPct', x)} min={0} max={500} step={10} suffix="%" off="выкл." />
            <SliderField label="Закрыть за N дней до экспирации" hint="0 — держать до экспирации (расчёт по цене в 08:00 UTC)." value={s.closeDte} onChange={(x) => set('closeDte', x)} min={0} max={30} step={0.5} suffix="дн." off="до эксп." />
            <SliderField label="Выход по дельте проданной ноги" hint="Закрыть, если |дельта| любого проданного опциона выросла до этого значения (цена подошла к страйку)." value={s.deltaExit} onChange={(x) => set('deltaExit', x)} min={0} max={0.9} step={0.05} off="выкл." />
            <Check checked={s.breachExit} onChange={(x) => set('breachExit', x)}>
              <span className="text-[12px]">Закрыть при пробое проданного страйка</span>
            </Check>
          </Section>

          <Section
            id="filters"
            title="Фильтры входа"
            open={!!sections.filters}
            onToggle={toggleSection}
            note={[s.ivMin || s.ivMax ? 'IV' : '', s.ivRankMin > 0 || s.ivRankMax < 100 ? 'IV-ранг' : '', s.trend !== 'off' ? 'тренд' : ''].filter(Boolean).join(' · ') || 'нет'}
          >
            <div className="grid grid-cols-2 gap-2">
              <NumInput label="ATM IV от, %" value={s.ivMin || ''} placeholder="—" onChange={(x) => set('ivMin', x === '' ? 0 : x)} />
              <NumInput label="ATM IV до, %" value={s.ivMax || ''} placeholder="—" onChange={(x) => set('ivMax', x === '' ? 0 : x)} />
            </div>
            <SliderField label="IV-ранг не ниже" hint="Где текущая IV находится в диапазоне за период: 0% — минимум, 100% — максимум. Продавать опционы выгоднее при высоком ранге." value={s.ivRankMin} onChange={(x) => set('ivRankMin', Math.min(100, x))} min={0} max={100} step={5} suffix="%" off="выкл." />
            <SliderField label="IV-ранг не выше" value={s.ivRankMax} onChange={(x) => set('ivRankMax', Math.min(100, x))} min={0} max={100} step={5} suffix="%" />
            <SliderField label="Период IV-ранга" value={s.ivRankDays} onChange={(x) => set('ivRankDays', Math.max(5, Math.round(x)))} min={10} max={365} step={5} suffix="дн." disabled={!(s.ivRankMin > 0 || s.ivRankMax < 100)} />
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">Тренд-фильтр</span>
              <Segmented
                size="sm"
                value={s.trend}
                onChange={(x) => set('trend', x)}
                options={[
                  { value: 'off', label: 'Выкл.' },
                  { value: 'above', label: 'Цена > SMA' },
                  { value: 'below', label: 'Цена < SMA' },
                ]}
              />
            </div>
            <SliderField label="SMA, дней" value={s.trendSma} onChange={(x) => set('trendSma', Math.max(2, Math.round(x)))} min={5} max={200} step={5} disabled={s.trend === 'off'} />
          </Section>

          <Section id="hedge" title="Дельта-хедж" open={!!sections.hedge} onToggle={toggleSection} note={s.hedge ? `допуск ${s.hedgeBand}` : 'выкл.'}>
            <Check checked={s.hedge} onChange={(x) => set('hedge', x)}>
              <span className="text-[12px]">Хеджировать дельту перпетуалом {hasPerpLeg(st) && <span className="text-dim">(недоступно для конструкций с перпетуалом)</span>}</span>
            </Check>
            <SliderField
              label="Допуск дельты на 1 контракт"
              hint="Хедж ставится, когда суммарная дельта опционов и перпетуала по модулю больше допуск × число контрактов. Меньше допуск — чаще сделки и больше комиссий."
              value={s.hedgeBand}
              onChange={(x) => set('hedgeBand', x)}
              min={0.01}
              max={0.5}
              step={0.01}
              disabled={!s.hedge}
            />
            <SliderField label="Проверять не чаще, чем раз в" value={s.hedgeHours} onChange={(x) => set('hedgeHours', x)} min={0} max={24} step={1} suffix="ч" off="каждую свечу" disabled={!s.hedge} />
          </Section>
        </div>

        <div className="p-3 border-t border-line shrink-0 flex flex-col gap-2">
          {err && <div className="text-[11px] text-down">{err}</div>}
          <div className="flex gap-2 items-center">
            <button className="btn btn-brand flex-1 h-9" disabled={!!err} onClick={() => run()} title="Ctrl+Enter">
              {running ? 'Пересчитать' : '▶ Запустить бэктест'}
            </button>
            {running && (
              <button className="btn btn-ghost h-9" onClick={stop}>
                Стоп
              </button>
            )}
          </div>
          <Check checked={auto} onChange={setAuto}>
            <span className="text-[11px] text-muted">Пересчитывать автоматически при изменении настроек</span>
          </Check>
          {running && <ProgressBar value={progress} />}
          <div className="text-[10px] text-dim leading-snug">
            Период сессии {fmtTime(ex.market.start)} → {fmtTime(ex.market.end)}, свечи {ex.config.baseInterval}. Цены опционов — модель сессии (IV из реализованной волатильности/DVOL, улыбка, спред), комиссии и маржа как на Bybit.
          </div>
        </div>
      </aside>

      {/* ─────────────── результаты ─────────────── */}
      <section className="flex-1 min-w-0 bg-panel rounded-lg flex flex-col overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Обзор' },
            { value: 'preview', label: 'Вход сейчас' },
            { value: 'chart', label: 'График' },
            { value: 'trades', label: `Сделки${r ? ` (${r.trades.length})` : ''}` },
            { value: 'metrics', label: 'Метрики' },
            { value: 'sweep', label: `Перебор${sweepRows.length ? ` (${sweepRows.length})` : ''}` },
            { value: 'log', label: 'Журнал' },
          ]}
          right={
            <span className="text-[11px] text-muted flex items-center gap-2">
              {running && <span className="text-brand">считаю… {Math.round(progress * 100)}%</span>}
              {!running && stale && result && <span className="text-dim">настройки изменены</span>}
              {r && !running && (
                <span>
                  {fmtNum(r.bars, 0)} свечей за {fmtNum(r.durationMs / 1000, 2)} с
                </span>
              )}
            </span>
          }
        />
        <div className={cx('flex-1 min-h-0 overflow-auto transition-opacity', running && tab !== 'preview' && tab !== 'sweep' && 'opacity-60')}>
          {tab === 'preview' && <PreviewTab preview={preview} s={s} exNow={ex.now} />}
          {tab === 'sweep' && (
            <SweepTab
              param={sweepParam}
              setParam={(p) => {
                setSweepParam(p);
                const d = OS_SWEEP_PARAMS.find((x) => x.key === p)!;
                setSweepRange({ from: d.from, to: d.to, step: d.step });
              }}
              range={sweepRange}
              setRange={setSweepRange}
              rows={sweepRows}
              running={sweeping}
              progress={sweepProgress}
              onStart={startSweep}
              onStop={() => (sweepAbort.current.aborted = true)}
              onApply={(val) => set(sweepParam, val)}
              current={s[sweepParam] as number}
              disabled={!!err}
            />
          )}
          {tab !== 'preview' && tab !== 'sweep' && !result && <Empty>{err ? err : running ? 'Идёт бэктест…' : 'Настройте стратегию слева и нажмите «Запустить бэктест»'}</Empty>}
          {tab !== 'preview' && tab !== 'sweep' && result && !result.ok && <div className="p-3 text-down">{result.error}</div>}
          {r && tab === 'overview' && <OverviewTab r={r} />}
          {r && tab === 'chart' && (
            <div className="h-full p-1">
              <OptionTradesChart market={ex.market} result={r} focus={focus} />
            </div>
          )}
          {r && tab === 'trades' && (
            <TradesTab
              r={r}
              expanded={expanded}
              setExpanded={setExpanded}
              onShow={(g) => {
                setFocus({ from: g.openTime, to: g.closeTime ?? g.expiry });
                setTab('chart');
              }}
            />
          )}
          {r && tab === 'metrics' && (
            <div className="p-2">
              <ReportGrid r={r.report} cols={6} />
            </div>
          )}
          {result && tab === 'log' && (
            <div className="p-2 font-mono text-[11px] flex flex-col">
              {result.error && <div className="text-down mb-2">{result.error}</div>}
              {result.log.map((l, i) => (
                <div key={i} className={cx(l.msg.startsWith('Пропуск') || l.msg.startsWith('Вход отклонён') ? 'text-dim' : l.msg.startsWith('Закрыт') ? 'text-text' : 'text-muted')}>
                  <span className="text-dim">{fmtTime(l.t)}</span> {l.msg}
                </div>
              ))}
              {result.log.length >= 5000 && <div className="text-dim mt-1">… журнал обрезан до 5000 строк</div>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ───────────────────────── вкладки ───────────────────────── */

function OverviewTab({ r }: { r: OsResult }) {
  const rep = r.report;
  const stt = r.stats;
  const st = OS_BY_KEY[r.settings.structure];
  const reasons = (Object.entries(stt.byReason) as [OsExitReason, { n: number; pnl: number }][]).sort((a, b) => b[1].n - a[1].n);
  const skips: [string, number][] = (
    [
      ['Лимит открытых конструкций', stt.skips.maxOpen],
      ['Фильтр IV', stt.skips.iv],
      ['Фильтр IV-ранга', stt.skips.ivRank],
      ['Тренд-фильтр', stt.skips.trend],
      ['Нет подходящей экспирации/страйка', stt.skips.chain],
      ['Объём меньше минимального', stt.skips.size],
      ['Отклонено биржей (маржа)', stt.skips.rejected],
    ] as [string, number][]
  ).filter(([, n]) => n > 0);
  return (
    <div className="p-2 flex flex-col gap-2">
      {r.halted && <div className="bg-down/10 text-down rounded px-3 py-2 text-[12px]">⚠ {r.halted}</div>}
      {r.trades.length === 0 && <div className="bg-panel2 text-muted rounded px-3 py-2 text-[12px]">Ни одной сделки — проверьте расписание, фильтры и размер позиции (причины пропусков ниже и в журнале).</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-1.5">
        <Kpi label="Доходность" value={fmtPct(rep.totalReturn)} cls={pnlClass(rep.totalReturn)} sub={rep.benchReturn !== null ? `актив: ${fmtPct(rep.benchReturn)}` : undefined} />
        <Kpi label="PnL" value={`${fmtUsd(rep.pnl, 0, true)}`} cls={pnlClass(rep.pnl)} sub={`CAGR ${fmtPct(rep.cagr, 1)}`} />
        <Kpi label="Макс. просадка" value={fmtPct(-rep.maxDrawdown)} cls="text-down" sub={`${fmtUsd(rep.maxDrawdownAbs, 0)} USDT`} />
        <Kpi label="Шарп / Сортино" value={`${fmtNum(rep.sharpe, 2)} / ${fmtNum(rep.sortino, 2)}`} />
        <Kpi label="Конструкций" value={stt.trades} sub={`в среднем ${fmtNum(stt.avgDays, 1)} дн.`} />
        <Kpi label="Прибыльных" value={fmtPct(stt.winRate, 1, false)} sub={`${stt.wins} из ${stt.trades}`} />
        <Kpi label="Средний результат" value={fmtUsd(stt.avgPnl, 2, true)} cls={pnlClass(stt.avgPnl)} sub={`лучшая ${fmtUsd(stt.bestTrade, 0, true)} · худшая ${fmtUsd(stt.worstTrade, 0, true)}`} />
        <Kpi label="Премия получена" value={fmtUsd(stt.premiumIn, 0)} sub={stt.premiumOut ? `уплачена ${fmtUsd(stt.premiumOut, 0)}` : undefined} />
        <Kpi label="Комиссии" value={fmtUsd(rep.fees, 0)} sub={`ср. IV при входе ${fmtPct(stt.avgIv, 1, false)}`} />
        {r.settings.hedge && <Kpi label="Хедж перпетуалом" value={fmtUsd(stt.hedge.pnl, 0, true)} cls={pnlClass(stt.hedge.pnl)} sub={`${stt.hedge.trades} сделок, funding ${fmtUsd(stt.hedge.funding, 0, true)}`} />}
        {stt.expiredItm > 0 && <Kpi label="Экспирации в деньгах" value={stt.expiredItm} sub="проданный опцион с выплатой" />}
      </div>
      <div className="h-[300px] shrink-0">
        <EquityChart equity={r.equity} bench={r.bench} benchLabel={`${r.settings.underlying.replace(/USDT$/, '')} buy&hold`} height={300} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        <div className="bg-panel2 rounded-md overflow-hidden">
          <div className="px-3 py-1.5 text-[12px] font-semibold border-b border-line">Почему закрывались позиции</div>
          {reasons.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Причина</th>
                  <th className="text-right">Кол-во</th>
                  <th className="text-right">Сумма PnL</th>
                  <th className="text-right">Средний PnL</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map(([k, b]) => (
                  <tr key={k}>
                    <td>{OS_REASON_LABEL[k]}</td>
                    <td className="text-right">{b.n}</td>
                    <td className={cx('text-right', pnlClass(b.pnl))}>{fmtUsd(b.pnl, 0, true)}</td>
                    <td className={cx('text-right', pnlClass(b.pnl))}>{fmtUsd(b.pnl / b.n, 2, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-3 text-muted text-[12px]">Нет закрытых позиций</div>
          )}
        </div>
        <div className="bg-panel2 rounded-md overflow-hidden">
          <div className="px-3 py-1.5 text-[12px] font-semibold border-b border-line">Пропущенные входы</div>
          {skips.length ? (
            <table className="tbl">
              <tbody>
                {skips.map(([k, n]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="text-right">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-3 text-muted text-[12px]">Все входы по расписанию выполнены</div>
          )}
          <div className="px-3 py-2 text-[10px] text-dim border-t border-line leading-snug">
            {st.name}: {legLabel(st)}. Решения — на закрытии свечей базового интервала, тейк/стоп — по маркировочной цене, исполнение — по bid/ask модели с комиссиями.
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewTab({ preview, s, exNow }: { preview: any; s: OsSettings; exNow: number }) {
  if (!preview) return <Empty>Исправьте настройки, чтобы увидеть предпросмотр</Empty>;
  if (preview.error) return <Empty>Сейчас войти нельзя: {preview.error}</Empty>;
  const { pick, eco, size, legs, econ } = preview;
  const qty = size.qty;
  const k = qty > 0 ? qty : 1;
  const dte = (pick.expiry - exNow) / DAY;
  return (
    <div className="p-2 grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
      <div className="flex flex-col gap-2 min-w-0">
        <div className="text-[12px] text-muted">
          Так стратегия открыла бы позицию <b className="text-text">в текущий момент сессии</b> ({fmtTime(exNow)}) — без учёта расписания и фильтров. Меняйте настройки слева — предпросмотр обновляется сразу.
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5">
          <Kpi label="Цена актива" value={fmtPrice(pick.S, s.underlying)} />
          <Kpi label="Экспирация" value={fmtTime(pick.expiry).slice(0, 10)} sub={`через ${fmtNum(dte, 1)} дн.`} />
          <Kpi label="ATM IV" value={fmtPct(pick.atmIv, 1, false)} />
          <Kpi label="Объём" value={qty > 0 ? `${qty}` : '—'} sub={qty > 0 ? 'контрактов на ногу' : size.error} cls={qty > 0 ? '' : 'text-down'} />
          <Kpi label={eco.premium >= 0 ? 'Кредит' : 'Дебет'} value={fmtUsd(Math.abs(eco.premium) * k, 2)} cls={eco.premium >= 0 ? 'text-up' : ''} />
          <Kpi label="Макс. прибыль" value={Number.isFinite(eco.maxProfit) ? fmtUsd(eco.maxProfit * k, 2) : '∞'} cls="text-up" />
          <Kpi label="Макс. убыток" value={Number.isFinite(eco.maxLoss) ? fmtUsd(eco.maxLoss * k, 2) : '∞'} cls="text-down" />
          <Kpi label="Нужно средств" value={fmtUsd(eco.margin * k, 0)} sub="премия + маржа" />
          <Kpi className="col-span-2" label="Безубыточность на экспирации" value={eco.breakevens.length ? eco.breakevens.map((x: number) => fmtNum(x, x < 100 ? 2 : 0)).join(' / ') : '—'} />
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Нога</th>
              <th>Инструмент</th>
              <th className="text-right">Страйк</th>
              <th className="text-right">Дельта позиции</th>
              <th className="text-right">Цена</th>
              <th className="text-right">Кол-во</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((l: any, i: number) => (
              <tr key={i}>
                <td className={l.side === 'Buy' ? 'text-up' : 'text-down'}>
                  {l.side === 'Buy' ? 'Покупка' : 'Продажа'} {l.type === 'F' ? 'перп.' : l.type === 'C' ? 'колл' : 'пут'}
                </td>
                <td className="text-muted">{l.symbol}</td>
                <td className="text-right">{l.type === 'F' ? '—' : fmtNum(l.strike, l.strike < 100 ? 2 : 0)}</td>
                <td className="text-right">{fmtNum(l.qty > 0 ? l.delta / l.qty : 0, 3)}</td>
                <td className="text-right">{fmtPrice(l.price, s.underlying)}</td>
                <td className="text-right">{l.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="h-[340px] bg-panel2 rounded-md overflow-hidden">
        <PayoffChart legs={econ.payoff} spot={pick.S} height={340} range={Math.min(0.5, Math.max(0.08, (pick.atmIv || 0.5) * Math.sqrt(Math.max(dte, 1) / 365) * 3))} />
      </div>
    </div>
  );
}

function TradesTab({ r, expanded, setExpanded, onShow }: { r: OsResult; expanded: number | null; setExpanded: (id: number | null) => void; onShow: (g: OsTrade) => void }) {
  if (!r.trades.length) return <Empty>Стратегия не открыла ни одной позиции</Empty>;
  const sym = r.settings.underlying;
  const csv = () =>
    downloadText(
      'option-strategy-trades.csv',
      toCsv(
        r.trades.map((g) => ({
          id: g.id,
          open: new Date(g.openTime).toISOString(),
          close: g.closeTime ? new Date(g.closeTime).toISOString() : '',
          expiry: new Date(g.expiry).toISOString(),
          strikes: strikesText(g),
          qty: g.qty,
          spot_in: g.S0,
          spot_out: g.S1 ?? '',
          atm_iv: g.atmIv,
          premium: g.premium,
          max_loss: Number.isFinite(g.maxLoss) ? g.maxLoss : '',
          fees: g.fees,
          pnl: g.pnl,
          reason: g.reason ?? '',
        })),
      ),
      'text/csv',
    );
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>#</th>
          <th>Открыта → закрыта</th>
          <th>Страйки · экспирация</th>
          <th className="text-right">Кол-во</th>
          <th className="text-right">Цена актива</th>
          <th className="text-right">IV</th>
          <th className="text-right">Премия</th>
          <th className="text-right">PnL</th>
          <th>Причина</th>
          <th>
            <button className="btn btn-sm btn-ghost" onClick={csv}>
              CSV
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {r.trades
          .slice()
          .reverse()
          .flatMap((g) => {
            const rows = [
              <tr key={g.id} className="cursor-pointer" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                <td className="text-muted">
                  <span className={cx('inline-block text-[9px] text-dim mr-1 transition-transform', expanded === g.id && 'rotate-90')}>▶</span>
                  {g.id}
                </td>
                <td className="text-muted whitespace-nowrap">
                  {fmtTime(g.openTime)}
                  <div className="text-dim text-[10px]">→ {g.closeTime ? fmtTime(g.closeTime) : '—'}</div>
                </td>
                <td>
                  <span className="font-mono text-[11px]">{strikesText(g)}</span>
                  <div className="text-dim text-[10px]">эксп. {fmtTime(g.expiry).slice(0, 10)}</div>
                </td>
                <td className="text-right">{g.qty}</td>
                <td className="text-right whitespace-nowrap">
                  {fmtPrice(g.S0, sym)}
                  <div className="text-dim text-[10px]">→ {g.S1 !== undefined ? fmtPrice(g.S1, sym) : '—'}</div>
                </td>
                <td className="text-right">{fmtPct(g.atmIv, 0, false)}</td>
                <td className={cx('text-right', g.premium >= 0 ? 'text-up' : 'text-muted')}>{fmtUsd(g.premium, 2, true)}</td>
                <td className={cx('text-right font-semibold', pnlClass(g.pnl))}>{fmtUsd(g.pnl, 2, true)}</td>
                <td>
                  <Badge color={g.reason === 'tp' ? 'up' : g.reason === 'sl' || g.reason === 'liquidation' ? 'down' : g.reason === 'expiry' ? 'info' : 'muted'}>{OS_REASON_LABEL[g.reason ?? 'end']}</Badge>
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      onShow(g);
                    }}
                  >
                    На графике
                  </button>
                </td>
              </tr>,
            ];
            if (expanded === g.id)
              rows.push(
                <tr key={`${g.id}-legs`}>
                  <td />
                  <td colSpan={9} className="!py-1.5">
                    <table className="w-full text-[11px]">
                      <thead className="text-dim">
                        <tr>
                          <th className="text-left font-normal">Нога</th>
                          <th className="text-left font-normal">Инструмент</th>
                          <th className="text-right font-normal">Кол-во</th>
                          <th className="text-right font-normal">Вход</th>
                          <th className="text-right font-normal">Выход</th>
                          <th className="text-right font-normal">IV входа</th>
                          <th className="text-right font-normal">Дельта входа</th>
                          <th className="text-right font-normal">Комиссии</th>
                          <th className="text-left font-normal pl-3">Как закрыта</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.legs.map((l, i) => (
                          <tr key={i}>
                            <td className={l.side === 'Buy' ? 'text-up' : 'text-down'}>
                              {l.side === 'Buy' ? 'Покупка' : 'Продажа'} {l.type === 'F' ? 'перп.' : l.type === 'C' ? 'колл' : 'пут'}
                            </td>
                            <td className="text-muted">{l.symbol}</td>
                            <td className="text-right">{l.qty}</td>
                            <td className="text-right">{fmtPrice(l.entry, sym)}</td>
                            <td className="text-right">{l.exit !== undefined ? fmtPrice(l.exit, sym) : '—'}</td>
                            <td className="text-right">{l.type === 'F' ? '—' : fmtPct(l.entryIv, 1, false)}</td>
                            <td className="text-right">{fmtNum(l.entryDelta, 3)}</td>
                            <td className="text-right">{fmtUsd(l.fees, 2)}</td>
                            <td className="pl-3 text-muted">{l.settled ? 'экспирация' : l.exitTime ? 'по рынку' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="text-[10px] text-dim mt-1">
                      Макс. убыток {Number.isFinite(g.maxLoss) ? fmtUsd(g.maxLoss, 2) : '∞'} · безубыточность при входе: {g.breakevens.length ? g.breakevens.map((x) => fmtNum(x, x < 100 ? 2 : 0)).join(' / ') : '—'} · макс. прибыль {Number.isFinite(g.maxProfit) ? fmtUsd(g.maxProfit, 2) : '∞'} · худший момент {fmtUsd(g.mae, 2, true)}
                      {g.ivRank !== null && ` · IV-ранг ${fmtNum(g.ivRank, 0)}%`}
                    </div>
                  </td>
                </tr>,
              );
            return rows;
          })}
      </tbody>
    </table>
  );
}

function SweepTab({
  param,
  setParam,
  range,
  setRange,
  rows,
  running,
  progress,
  onStart,
  onStop,
  onApply,
  current,
  disabled,
}: {
  param: OsSweepParam;
  setParam: (p: OsSweepParam) => void;
  range: { from: number; to: number; step: number };
  setRange: (r: { from: number; to: number; step: number }) => void;
  rows: OsSweepRow[];
  running: boolean;
  progress: number;
  onStart: () => void;
  onStop: () => void;
  onApply: (v: number) => void;
  current: number;
  disabled: boolean;
}) {
  const n = sweepValues(range.from, range.to, range.step).length;
  const best = rows.length ? rows.reduce((b, x) => (x.report.totalReturn > b.report.totalReturn ? x : b), rows[0]) : null;
  const maxAbs = Math.max(1e-9, ...rows.map((x) => Math.abs(x.report.totalReturn)));
  return (
    <div className="p-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Параметр" value={param} onChange={setParam} options={OS_SWEEP_PARAMS.map((p) => ({ value: p.key, label: p.label }))} className="w-[200px]" />
        <NumInput label="От" value={range.from} onChange={(x) => setRange({ ...range, from: Number(x) || 0 })} className="w-24" />
        <NumInput label="До" value={range.to} onChange={(x) => setRange({ ...range, to: Number(x) || 0 })} className="w-24" />
        <NumInput label="Шаг" value={range.step} onChange={(x) => setRange({ ...range, step: Number(x) || 0 })} className="w-24" />
        <button className="btn btn-brand h-8" disabled={running || disabled} onClick={onStart}>
          Перебрать ({n})
        </button>
        {running && (
          <button className="btn btn-ghost h-8" onClick={onStop}>
            Стоп
          </button>
        )}
        <span className="text-[11px] text-muted">остальные настройки — как слева; текущее значение: {String(current)}</span>
      </div>
      {running && <ProgressBar value={progress} />}
      {rows.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Значение</th>
              <th>Доходность</th>
              <th className="text-right">Просадка</th>
              <th className="text-right">Шарп</th>
              <th className="text-right">Конструкций</th>
              <th className="text-right">Прибыльных</th>
              <th className="text-right">Средний PnL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.value} className={cx(best === x && 'bg-brand/5')}>
                <td className="num">
                  {x.value}
                  {x.value === current && <span className="text-dim ml-1">(текущее)</span>}
                </td>
                <td>
                  {x.error ? (
                    <span className="text-down text-[11px]">{x.error}</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className={cx('w-16 text-right', pnlClass(x.report.totalReturn))}>{fmtPct(x.report.totalReturn)}</span>
                      <div className="flex-1 h-2 bg-panel2 rounded relative min-w-[80px]">
                        <div
                          className={cx('absolute top-0 h-2 rounded', x.report.totalReturn >= 0 ? 'bg-up/70 left-1/2' : 'bg-down/70 right-1/2')}
                          style={{ width: `${(Math.abs(x.report.totalReturn) / maxAbs) * 50}%` }}
                        />
                      </div>
                    </div>
                  )}
                </td>
                <td className="text-right text-down">{fmtPct(-x.report.maxDrawdown)}</td>
                <td className="text-right">{fmtNum(x.report.sharpe, 2)}</td>
                <td className="text-right">{x.stats.trades}</td>
                <td className="text-right">{fmtPct(x.stats.winRate, 0, false)}</td>
                <td className={cx('text-right', pnlClass(x.stats.avgPnl))}>{fmtUsd(x.stats.avgPnl, 2, true)}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => onApply(x.value)}>
                    Применить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Выберите параметр и диапазон — каждое значение прогоняется отдельным бэктестом.</Empty>
      )}
      <div className="text-[10px] text-dim">⚠ Лучшее значение на одном периоде — не гарантия на другом. Ищите устойчивые области, а не единичный пик.</div>
    </div>
  );
}
