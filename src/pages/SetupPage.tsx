import { useEffect, useMemo, useState } from 'react';
import { ASSETS, getAsset, hasAsset, kindLabel, registerAsset, SECTOR_LABEL } from '../data/assets';
import { DAY, INTERVALS, intervalMs } from '../data/intervals';
import { PROVIDER_LIST } from '../data/loader';
import type { IntervalKey, ProviderId } from '../data/types';
import { idbClear } from '../data/cache';
import { fetchBybitOptionBases, syncInstrumentsFromBybit, syncSpotTradFiFromBybit } from '../data/providers/bybit';
import { DEFAULT_FEES, DEFAULT_OPTION_MODEL, type SessionConfig } from '../engine/types';
import {
  deleteSession,
  exportSessionJson,
  importSessionJson,
  listSessions,
  restoreSession,
  startSession,
  type SavedSession,
} from '../store/actions';
import { toast, useSession } from '../store/session';
import { Badge, Check, cx, NumInput, Segmented, Select, TextInput } from '../components/ui';
import { downloadText, fmtDate, fmtNum, fmtPct, fmtTime, fmtUsd } from '../lib/format';

const PRESETS: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7 дней', days: 7 },
  { key: '30d', label: '30 дней', days: 30 },
  { key: '90d', label: '3 мес', days: 90 },
  { key: '180d', label: '6 мес', days: 180 },
  { key: '365d', label: '1 год', days: 365 },
  { key: '730d', label: '2 года', days: 730 },
];

const BASE_INTERVALS: IntervalKey[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];

/** История до старта: для графика (~1500 свечей) и для оценки волатильности опционов (≥30 дн.). */
function autoWarmup(base: IntervalKey) {
  const minDays = intervalMs(base) >= 5 * 60_000 ? 30 : 14;
  return Math.max(minDays, Math.min(365, Math.ceil((1500 * intervalMs(base)) / DAY)));
}

function dayStart(ms: number) {
  return Math.floor(ms / DAY) * DAY;
}

function AssetPicker({ selected, onToggle }: { selected: string[]; onToggle: (s: string) => void }) {
  const [custom, setCustom] = useState('');
  const groups = [
    { title: 'Базовые активы опционов Bybit — крипто', items: ASSETS.filter((a) => a.hasOptions && a.group === 'crypto') },
    { title: 'Perp Options Bybit — TradFi (акции/ETF)', items: ASSETS.filter((a) => a.hasOptions && a.group === 'tradfi') },
    ...(['stock', 'etf', 'index', 'commodity'] as const).map((sec) => ({
      title: `TradFi Bybit — фьючерсы с плечом: ${SECTOR_LABEL[sec]}`,
      items: ASSETS.filter((a) => a.group === 'tradfi' && !a.hasOptions && a.sector === sec),
    })),
    { title: 'Другие USDT-перпетуалы (крипто)', items: ASSETS.filter((a) => !a.hasOptions && !a.spotOnly && a.group === 'crypto') },
    {
      title: 'TradFi на споте — токенизированные акции и ETF (xStocks), золото. Только спот, 24/7',
      note: 'История xStocks на Bybit — с июля 2025. Резервный источник (OKX, перпетуалы на те же акции) — примерно с марта 2026; для более ранних дат без доступа к Bybit используйте «Синтетику».',
      items: ASSETS.filter((a) => a.group === 'xstock' || a.group === 'commodity'),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="text-[11px] text-muted mb-1.5">
            {g.title}
            {'note' in g && g.note && <div className="text-[10px] text-dim mt-0.5">{g.note}</div>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {g.items.map((a) => {
              const on = selected.includes(a.symbol);
              return (
                <button
                  key={a.symbol}
                  onClick={() => onToggle(a.symbol)}
                  title={a.spotOnly ? `${a.name} · ${kindLabel(a)}` : `${a.name} · макс. плечо ${a.maxLeverage}x${a.hasOptions ? ' · есть опционы' : ''}`}
                  className={cx(
                    'px-2.5 h-7 rounded-md border text-[12px] transition-colors',
                    on ? 'border-brand bg-brand/10 text-brand font-semibold' : 'border-line2 text-muted hover:text-text hover:border-dim',
                  )}
                >
                  {a.base}
                  {a.hasOptions && <span className="ml-1 text-[9px] opacity-70">OPT</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex gap-2 items-center">
        <TextInput value={custom} onChange={(v) => setCustom(v.toUpperCase())} placeholder="Любой символ Bybit, напр. PEPEUSDT" className="flex-1" />
        <button
          className="btn"
          onClick={() => {
            let s = custom.trim().toUpperCase();
            if (!s) return;
            if (!s.endsWith('USDT')) s += 'USDT';
            if (!hasAsset(s)) getAsset(s);
            if (!selected.includes(s)) onToggle(s);
            setCustom('');
          }}
        >
          Добавить
        </button>
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="panel p-4 flex flex-col gap-3">
      <div className="flex items-center">
        <div className="font-semibold text-[14px]">{title}</div>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </div>
  );
}

function SavedList() {
  const [list, setList] = useState<SavedSession[]>([]);
  const refresh = () => listSessions().then(setList);
  useEffect(() => {
    refresh();
  }, []);
  const hasEx = useSession((s) => !!s.ex);
  return (
    <Section
      title="Сохранённые сессии"
      right={
        <label className="btn btn-sm btn-ghost cursor-pointer">
          Импорт JSON
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                await importSessionJson(await f.text());
                toast('success', 'Сессия импортирована');
                refresh();
              } catch (err: any) {
                toast('error', 'Ошибка импорта', String(err?.message || err));
              }
            }}
          />
        </label>
      }
    >
      {hasEx && (
        <button
          className="btn btn-ghost btn-sm self-start"
          onClick={() => {
            const j = exportSessionJson();
            if (j) downloadText(`session-${Date.now()}.json`, j, 'application/json');
          }}
        >
          ⬇ Экспорт текущей сессии в JSON
        </button>
      )}
      {!list.length && <div className="text-dim">Нет сохранённых сессий. Кнопка «💾 Сохранить» в шапке сохраняет прогресс в браузере.</div>}
      <div className="flex flex-col gap-2">
        {list.map((s) => (
          <div key={s.id} className="flex items-center gap-3 bg-panel2 rounded-md px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{s.name}</div>
              <div className="text-[11px] text-muted">
                {fmtDate(s.config.start)} → {fmtDate(s.config.end)} · {s.config.baseInterval} · {s.config.symbols.join(', ')}
              </div>
              <div className="text-[11px] text-dim">
                Сохранено {new Date(s.savedAt).toLocaleString('ru-RU')} · прогресс {s.summary.total ? ((s.summary.cursor / s.summary.total) * 100).toFixed(0) : '?'}% · капитал{' '}
                {fmtUsd(s.summary.equity)}
              </div>
            </div>
            <button className="btn btn-sm btn-brand" onClick={() => restoreSession(s)}>
              Открыть
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (!confirm(`Удалить «${s.name}»?`)) return;
                await deleteSession(s.id);
                refresh();
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

let bybitSynced = false;

export function SetupPage() {
  const hasEx = useSession((s) => !!s.ex);
  // тихая синхронизация спецификаций с Bybit (если API доступен)
  useEffect(() => {
    if (bybitSynced) return;
    bybitSynced = true;
    syncInstrumentsFromBybit().catch(() => {});
    syncSpotTradFiFromBybit().catch(() => {});
  }, []);
  const setS = useSession((s) => s.set);
  const today = dayStart(Date.now());
  const [name, setName] = useState(`Сессия ${new Date().toLocaleDateString('ru-RU')}`);
  const [provider, setProvider] = useState<ProviderId>('bybit');
  const [preset, setPreset] = useState('30d');
  const [start, setStart] = useState(today - 30 * DAY);
  const [end, setEnd] = useState(today);
  const [base, setBase] = useState<IntervalKey>('5m');
  const [warmup, setWarmup] = useState<number | ''>('');
  const [balance, setBalance] = useState<number | ''>(10_000);
  const [symbols, setSymbols] = useState<string[]>(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const [fees, setFees] = useState({ ...DEFAULT_FEES });
  const [slip, setSlip] = useState<number | ''>(2);
  const [funding, setFunding] = useState(true);
  const [defFunding, setDefFunding] = useState<number | ''>(0.01);
  const [intrabar, setIntrabar] = useState<'auto' | 'pessimistic'>('auto');
  const [opt, setOpt] = useState({ ...DEFAULT_OPTION_MODEL });
  const [adv, setAdv] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [liveBases, setLiveBases] = useState<string[] | null>(null);

  const bars = Math.floor((end - start) / intervalMs(base));
  const totalBars = bars * symbols.length;
  const warm = warmup === '' ? autoWarmup(base) : warmup;
  const heavy = totalBars > 3_000_000;
  const requests = Math.ceil(((end - start + warm * DAY) / intervalMs(base) / 1000) * symbols.length);

  const applyPreset = (k: string) => {
    setPreset(k);
    const p = PRESETS.find((x) => x.key === k);
    if (p) {
      setEnd(today);
      setStart(today - p.days * DAY);
    }
  };

  const toggle = (s: string) => setSymbols((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const feeField = (key: keyof typeof fees, label: string) => (
    <NumInput label={label} suffix="%" value={Number((fees[key] * 100).toPrecision(6))} step={0.005} onChange={(v) => setFees({ ...fees, [key]: v === '' ? 0 : v / 100 })} />
  );

  const valid = symbols.length > 0 && end > start && Number(balance) > 0;

  const launch = () => {
    const cfg: SessionConfig = {
      id: `s${Date.now().toString(36)}`,
      name,
      provider,
      start,
      end,
      baseInterval: base,
      warmupDays: warm,
      initialBalance: Number(balance),
      symbols: [...symbols],
      fees,
      slippageBps: Number(slip) || 0,
      fundingEnabled: funding,
      defaultFundingRate: (Number(defFunding) || 0) / 100,
      options: opt,
      intrabar,
      createdAt: Date.now(),
    };
    startSession(cfg);
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const n = await syncInstrumentsFromBybit();
      const nx = await syncSpotTradFiFromBybit().catch(() => 0);
      const bases = await fetchBybitOptionBases();
      setLiveBases(bases);
      for (const b of bases) {
        const sym = `${b}USDT`;
        const a = getAsset(sym);
        if (!a.hasOptions) registerAsset({ ...a, hasOptions: true });
      }
      toast('success', 'Инструменты синхронизированы с Bybit', `${n} перпетуалов, ${nx} xStocks/золото; опционы: ${bases.join(', ') || '—'}`);
    } catch (e: any) {
      toast('error', 'Bybit недоступен', `${e?.message || e}. Используются встроенные спецификации.`, 8000);
    } finally {
      setSyncing(false);
    }
  };

  const baseOpts = useMemo(() => BASE_INTERVALS.map((k) => INTERVALS.find((i) => i.key === k)!), []);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-[1240px] mx-auto p-6 grid grid-cols-[1fr_400px] gap-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <div>
              <div className="text-[22px] font-bold">Новая сессия бэктеста</div>
              <div className="text-muted">
                Копия интерфейса биржи: торгуйте фьючерсами, спотом и опционами на исторических данных, запускайте боты и стратегии.
              </div>
            </div>
            {hasEx && (
              <button className="btn btn-ghost ml-auto" onClick={() => setS({ page: 'trade' })}>
                ← Вернуться к текущей сессии
              </button>
            )}
          </div>

          <Section title="1. Период и данные">
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="Название" value={name} onChange={setName} />
              <Select label="Источник" value={provider} onChange={setProvider} options={PROVIDER_LIST.map((p) => ({ value: p.id, label: p.label }))} />
            </div>
            <div className="text-[11px] text-dim -mt-1">{PROVIDER_LIST.find((p) => p.id === provider)?.note}. Если источник недоступен, автоматически используется следующий.</div>
            <div className="flex gap-1.5 flex-wrap">
              {PRESETS.map((p) => (
                <button key={p.key} className={cx('chip border border-line2', preset === p.key && 'active')} onClick={() => applyPreset(p.key)}>
                  {p.label}
                </button>
              ))}
              <button className={cx('chip border border-line2', preset === 'custom' && 'active')} onClick={() => setPreset('custom')}>
                Свои даты
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="field">
                <span className="lbl">Начало (UTC)</span>
                <input
                  type="date"
                  value={fmtDate(start)}
                  onChange={(e) => {
                    setPreset('custom');
                    setStart(Date.parse(e.target.value + 'T00:00:00Z'));
                  }}
                />
              </label>
              <label className="field">
                <span className="lbl">Конец (UTC)</span>
                <input
                  type="date"
                  value={fmtDate(end)}
                  onChange={(e) => {
                    setPreset('custom');
                    setEnd(Date.parse(e.target.value + 'T00:00:00Z'));
                  }}
                />
              </label>
            </div>
            <div>
              <div className="text-[11px] text-muted mb-1.5">Базовый интервал симуляции (точность исполнения ордеров)</div>
              <Segmented value={base} onChange={setBase} options={baseOpts.map((d) => ({ value: d.key, label: d.label }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumInput label="История до старта" suffix="дн." value={warmup === '' ? '' : warmup} placeholder={`авто: ${autoWarmup(base)}`} onChange={setWarmup} />
              <NumInput label="Стартовый депозит" suffix="USDT" value={balance} onChange={setBalance} step={1000} />
            </div>
            <div className={cx('text-[11px] rounded-md px-3 py-2', heavy ? 'bg-down/10 text-down' : 'bg-panel2 text-muted')}>
              {fmtNum(bars, 0)} баров × {symbols.length} симв. = {fmtNum(totalBars, 0)} баров · ≈{fmtNum(requests, 0)} запросов к API (кешируются в браузере)
              {heavy && ' — очень большой объём: выберите интервал крупнее или период короче.'}
            </div>
          </Section>

          <Section
            title="2. Инструменты"
            right={
              <button className="btn btn-sm btn-ghost" onClick={sync} disabled={syncing}>
                {syncing ? 'Синхронизация…' : '↻ Синхронизировать с Bybit'}
              </button>
            }
          >
            <div className="text-muted text-[12px]">
              Выбранные символы загружаются при старте; остальные можно догрузить позже прямо из терминала. Все базовые активы опционов Bybit (BTC, ETH, SOL, XRP,
              DOGE, MNT, HYPE и Perp Options на акции) доступны.
              {liveBases && <span className="text-up"> Сейчас на Bybit опционы есть на: {liveBases.join(', ')}.</span>}
            </div>
            <AssetPicker selected={symbols} onToggle={toggle} />
            <div className="flex flex-wrap gap-1.5">
              {symbols.map((s) => (
                <Badge key={s} color="brand">
                  {s}
                  <button className="ml-1" onClick={() => toggle(s)}>
                    ✕
                  </button>
                </Badge>
              ))}
            </div>
          </Section>

          <Section title="3. Параметры биржи" right={<Check checked={adv} onChange={setAdv}>Показать всё</Check>}>
            <div className="grid grid-cols-3 gap-3">
              {feeField('linearTaker', 'Тейкер перп.')}
              {feeField('linearMaker', 'Мейкер перп.')}
              <NumInput label="Проскальзывание" suffix="б.п." value={slip} onChange={setSlip} step={1} />
            </div>
            {adv && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  {feeField('spotTaker', 'Тейкер спот')}
                  {feeField('spotMaker', 'Мейкер спот')}
                  {feeField('optionTaker', 'Опционы (от базы)')}
                  {feeField('optionMaker', 'Опц. мейкер')}
                  {feeField('optionDelivery', 'Поставка опц.')}
                  <NumInput label="Лимит комиссии опц." suffix="% премии" value={fees.optionFeeCap * 100} onChange={(v) => setFees({ ...fees, optionFeeCap: (Number(v) || 0) / 100 })} />
                </div>
                <div className="grid grid-cols-3 gap-3 items-center">
                  <Check checked={funding} onChange={setFunding}>
                    Учитывать funding
                  </Check>
                  <NumInput label="Funding по умолч." suffix="%/8ч" value={defFunding} onChange={setDefFunding} step={0.005} />
                  <Select
                    label="Путь цены в баре"
                    value={intrabar}
                    onChange={setIntrabar}
                    options={[
                      { value: 'auto', label: 'O→L→H→C / O→H→L→C' },
                      { value: 'pessimistic', label: 'Пессимистичный' },
                    ]}
                  />
                </div>
                <div className="text-[12px] font-semibold mt-1">Модель опционов</div>
                <div className="grid grid-cols-3 gap-3">
                  <Select
                    label="IV"
                    value={opt.ivSource}
                    onChange={(v) => setOpt({ ...opt, ivSource: v })}
                    options={[
                      { value: 'realized', label: 'Реализованная × премия' },
                      { value: 'dvol', label: 'DVOL Deribit (BTC/ETH)' },
                      { value: 'fixed', label: 'Фиксированная' },
                    ]}
                  />
                  <NumInput label="Премия к RV" suffix="×" value={opt.ivPremium} step={0.05} onChange={(v) => setOpt({ ...opt, ivPremium: Number(v) || 1 })} />
                  <NumInput label="Фикс. IV" suffix="%" value={opt.fixedIv * 100} step={5} onChange={(v) => setOpt({ ...opt, fixedIv: (Number(v) || 0) / 100 })} />
                  <NumInput label="Скос (skew)" value={opt.skew} step={0.01} onChange={(v) => setOpt({ ...opt, skew: Number(v) || 0 })} />
                  <NumInput label="Улыбка (smile)" value={opt.smile} step={0.01} onChange={(v) => setOpt({ ...opt, smile: Number(v) || 0 })} />
                  <NumInput label="Спред bid/ask" suffix="%" value={opt.spreadPct * 100} step={0.5} onChange={(v) => setOpt({ ...opt, spreadPct: (Number(v) || 0) / 100 })} />
                </div>
              </>
            )}
          </Section>

          <div className="flex items-center gap-3">
            <button className="btn btn-brand h-10 px-8 text-[14px]" disabled={!valid} onClick={launch}>
              Начать сессию →
            </button>
            <div className="text-muted text-[12px]">
              {fmtDate(start)} — {fmtDate(end)} · {symbols.length} симв. · депозит {fmtUsd(Number(balance) || 0, 0)} USDT · taker {fmtPct(fees.linearTaker, 3, false)}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <SavedList />
          <Section title="Как это работает">
            <ul className="text-muted text-[12px] list-disc pl-4 flex flex-col gap-1.5">
              <li>
                Время симуляции идёт по базовым свечам. На графике видны только закрытые свечи — <b className="text-text">будущее скрыто</b>.
              </li>
              <li>Внутри свечи цена проходит путь Open→High/Low→Close; ордера, TP/SL, трейлинги и ликвидации срабатывают строго по порядку.</li>
              <li>Фьючерсы: плечо до максимума Bybit, кросс/изолированная маржа, funding по реальной истории, ликвидации.</li>
              <li>Опционы: цепочка страйков и экспирации как у Bybit (08:00 UTC), цены по Блэку–Шоулзу с IV из истории волатильности.</li>
              <li>Боты: спотовый и фьючерсный грид, комбо-бот ребалансировки, DCA и мартингейл — в изолированных суб-аккаунтах.</li>
            </ul>
          </Section>
          <Section title="Данные">
            <div className="text-muted text-[12px]">Загруженные свечи кешируются в IndexedDB браузера — повторный запуск мгновенный.</div>
            <button
              className="btn btn-ghost btn-sm self-start"
              onClick={async () => {
                await idbClear('klines');
                await idbClear('funding');
                toast('success', 'Кеш данных очищен');
              }}
            >
              Очистить кеш свечей
            </button>
            <div className="text-[11px] text-dim">Сегодня: {fmtTime(Date.now())} UTC</div>
          </Section>
        </div>
      </div>
    </div>
  );
}
