import { useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { IChartApi } from 'lightweight-charts';
import { defaultConfigText, parseConfig, parseYaml, setTopLevel, type LbConfig, type Market } from '../../portfolio/config';
import { cryptoTopByVolume, loadDataset, loadFrom } from '../../portfolio/data';
import { prepare, runBacktest, type BacktestResult, type Dataset, type OpenPositionRow, type AccountState } from '../../portfolio/backtest';
import { computeMetrics, equityCsv, EVENT_LABEL, reportWarnings, summaryMarkdown, tradesCsv, type LbMetrics } from '../../portfolio/report';
import { runScan, type ScanResult } from '../../portfolio/scan';
import { runSensitivity, type SensRow } from '../../portfolio/sensitivity';
import { CRYPTO30, MOEXBMI, parseUniverse, SP500 } from '../../portfolio/universes';
import { downloadText } from '../../lib/format';
import { toast } from '../../store/session';
import { Badge, cx, Empty, ProgressBar, Tabs, usePersistent } from '../ui';
import { EquityChart } from '../EquityChart';

const MARKETS: { value: Market; label: string; universe: string; uniLabel: string }[] = [
  { value: 'us', label: 'США', universe: SP500, uniLabel: 'S&P 500' },
  { value: 'moex', label: 'Мосбиржа', universe: MOEXBMI, uniLabel: 'MOEXBMI' },
  { value: 'crypto', label: 'Крипта', universe: CRYPTO30, uniLabel: 'Топ-30 Binance' },
];

const DESCRIPTION = [
  'Режим рынка: бенчмарк выше SMA200 и SMA50 > SMA200 — иначе новых входов и докупок нет.',
  'Фильтр лидеров: close > SMA50 > SMA150 > SMA200, SMA200 растёт, не дальше 25% от максимума года, доходность за 3 и 6 мес. — в верхних 20% вселенной.',
  'Вход: накануне ATR10 < ATR50, пробой максимума 20 дней на объёме ≥ 1.5× среднего; покупка на открытии следующего дня, ранжирование по силе.',
  'Риск 1% на сделку (0.5% при просадке ≥ 10%), стоп 2×ATR14, не больше 5 позиций и 20% капитала в одной.',
  'Сопровождение: выход при закрытии ниже минимума 10 дней или через 10 баров без +1R; одна докупка ½ объёма при +1.5R со стопом в безубыток; остановка при просадке 20%.',
];

const DEFAULT_POS_CSV = 'symbol,entry_date,entry_price,q0,qty,R_ps,stop,pyramided\n';
const defaultAccount = (cap: number) => `equity: ${cap}\npeak: ${cap}\ncash: ${cap}\nthrottle: false\nhalted: false\n`;

/** Загруженные данные держим в памяти страницы: повторные прогоны после правки config.yaml — без перезагрузки. */
const datasets = new Map<string, Dataset>();

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
const money = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('ru-RU') : '—');

interface RunResult {
  bt: BacktestResult;
  m: LbMetrics;
  warnings: string[];
  summary: string;
}

export function LeadersBreakoutPanel() {
  const [market, setMarket] = usePersistent<Market>('lb-market', 'us', ['us', 'moex', 'crypto']);
  const [configs, setConfigs] = usePersistent<Partial<Record<Market, string>>>('lb-config', {});
  const [universes, setUniverses] = usePersistent<Partial<Record<Market, string>>>('lb-universe', {});
  const [editor, setEditor] = usePersistent<'config' | 'universe' | 'about'>('lb-editor', 'about', ['config', 'universe', 'about']);
  const [tab, setTab] = usePersistent<'report' | 'equity' | 'trades' | 'scan' | 'sens' | 'log'>('lb-tab', 'report', ['report', 'equity', 'trades', 'scan', 'sens', 'log']);
  const mk = MARKETS.find((x) => x.value === market)!;
  const configText = configs[market] ?? defaultConfigText(market);
  const universeText = universes[market] ?? mk.universe.trim();
  const setConfigText = (t: string) => setConfigs({ ...configs, [market]: t });
  const setUniverseText = (t: string) => setUniverses({ ...universes, [market]: t });
  const parsed = useMemo(() => {
    try {
      const c = parseConfig(configText);
      if (c.market !== market) return { ok: false as const, error: `market: ${c.market} в config.yaml не совпадает с выбранным рынком (${market})` };
      return { ok: true as const, c };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message || e) };
    }
  }, [configText, market]);
  const universe = useMemo(() => parseUniverse(universeText), [universeText]);
  const universeIsDefault = useMemo(() => parseUniverse(mk.universe).join() === universe.join(), [mk.universe, universe]);

  const [busy, setBusy] = useState<null | { title: string; done: number; total: number; msg: string }>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [sens, setSens] = useState<SensRow[]>([]);
  const [posMap, setPosMap] = usePersistent<Partial<Record<Market, string>>>('lb-positions', {});
  const [accMap, setAccMap] = usePersistent<Partial<Record<Market, string>>>('lb-account', {});
  const posCsv = posMap[market] ?? DEFAULT_POS_CSV;
  const accText = accMap[market] ?? '';
  const setPosCsv = (t: string) => setPosMap({ ...posMap, [market]: t });
  const setAccText = (t: string) => setAccMap({ ...accMap, [market]: t });
  const abort = useRef<AbortController | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const getDataset = async (c: LbConfig, title: string): Promise<Dataset> => {
    const key = `${market}|${universe.join(',')}|${Math.floor(loadFrom(c) / 864e5)}|${c.end ?? 'now'}|${c.benchmark}`;
    const hit = datasets.get(key);
    if (hit && (c.end || Date.now() - (hit as any).loadedAt < 6 * 3600_000)) return hit;
    abort.current = new AbortController();
    setBusy({ title, done: 0, total: universe.length + 1, msg: '' });
    const ds = await loadDataset(market, universe, c, {
      signal: abort.current.signal,
      onProgress: (done, total, msg) => setBusy({ title, done, total, msg }),
    });
    (ds as any).loadedAt = Date.now();
    datasets.set(key, ds);
    return ds;
  };

  const runBt = async () => {
    if (!parsed.ok) return toast('error', 'Ошибка в config.yaml', parsed.error);
    if (!universe.length) return toast('warn', 'Вселенная пуста', 'Добавьте тикеры в universe.txt');
    const c = parsed.c;
    try {
      const ds = await getDataset(c, 'Загрузка дневных свечей вселенной');
      setBusy({ title: 'Бэктест', done: 0, total: 1, msg: `${ds.assets.length} активов` });
      const bt = await runBacktest(prepare(ds, c), c, { onProgress: (f) => setBusy({ title: 'Бэктест', done: f, total: 1, msg: `${ds.assets.length} активов` }) });
      const m = computeMetrics(bt);
      const warnings = reportWarnings(bt, universeIsDefault);
      setResult({ bt, m, warnings, summary: summaryMarkdown(bt, m, warnings) });
      setTab('report');
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('error', 'Бэктест не выполнен', String(e?.message || e), 9000);
    } finally {
      setBusy(null);
    }
  };

  const runScanner = async () => {
    if (!parsed.ok) return toast('error', 'Ошибка в config.yaml', parsed.error);
    const c: LbConfig = { ...parsed.c, end: null }; // сканер — по последним данным
    let positions: OpenPositionRow[];
    let account: AccountState;
    try {
      positions = parsePositions(posCsv);
      account = parseAccount(accText || defaultAccount(c.initial_capital));
    } catch (e: any) {
      return toast('error', 'Не удалось прочитать позиции или счёт', String(e?.message || e));
    }
    try {
      const ds = await getDataset(c, 'Загрузка свежих данных для сканера');
      setScan(runScan(prepare(ds, c), c, positions, account));
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('error', 'Сканер не выполнен', String(e?.message || e), 9000);
    } finally {
      setBusy(null);
    }
  };

  const runSens = async () => {
    if (!parsed.ok) return toast('error', 'Ошибка в config.yaml', parsed.error);
    const c = parsed.c;
    try {
      const ds = await getDataset(c, 'Загрузка дневных свечей вселенной');
      setSens([]);
      const sig = { aborted: false };
      abort.current = { abort: () => (sig.aborted = true) } as any;
      setBusy({ title: 'Чувствительность', done: 0, total: 18, msg: '' });
      await runSensitivity(ds, c, (row, done, total) => {
        setSens((cur) => [...cur, row]);
        setBusy({ title: 'Чувствительность', done, total, msg: `breakout ${row.breakout_lookback} · стоп ${row.atr_stop_mult}×ATR · трейлинг ${row.trail_lookback}` });
      }, sig);
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('error', 'Не выполнено', String(e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const switchMarket = (m: Market) => {
    setMarket(m);
    setResult(null);
    setScan(null);
    setSens([]);
  };

  const quickField = (key: 'start' | 'end' | 'initial_capital', value: string) => setConfigText(setTopLevel(configText, key, value));

  return (
    <div className="flex-1 min-h-0 flex gap-1">
      {/* ── левая колонка: стратегия, рынок, config.yaml, universe.txt ── */}
      <div className="w-[430px] shrink-0 bg-panel rounded-lg flex flex-col overflow-hidden">
        <div className="px-3 pt-2.5 pb-2 border-b border-line">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Пробой лидеров</span>
            <span className="text-[11px] text-muted">Leaders Breakout · дневные свечи · портфель</span>
          </div>
          <div className="flex gap-1 mt-2">
            {MARKETS.map((x) => (
              <button key={x.value} className={cx('chip border border-line2 flex-1', market === x.value && 'active')} onClick={() => switchMarket(x.value)}>
                {x.label}
              </button>
            ))}
          </div>
          {parsed.ok && (
            <div className="grid grid-cols-3 gap-1 mt-2">
              <label className="field !h-7">
                <span className="lbl">С</span>
                <input type="date" value={parsed.c.start} onChange={(e) => e.target.value && quickField('start', e.target.value)} />
              </label>
              <label className="field !h-7">
                <span className="lbl">По</span>
                <input type="date" value={parsed.c.end ?? ''} onChange={(e) => quickField('end', e.target.value || 'null')} title="Пусто — до последней доступной даты" />
              </label>
              <label className="field !h-7">
                <span className="lbl">Капитал</span>
                <input inputMode="numeric" value={parsed.c.initial_capital} onChange={(e) => Number(e.target.value) > 0 && quickField('initial_capital', String(Number(e.target.value)))} />
              </label>
            </div>
          )}
          <div className="flex gap-1 mt-2">
            <button className="btn btn-brand flex-1 h-8" disabled={!!busy || !parsed.ok} onClick={runBt}>
              ▶ Бэктест
            </button>
            <button className="btn h-8" disabled={!!busy || !parsed.ok} onClick={() => (setTab('scan'), runScanner())} title="Действия на следующий день по последним данным">
              Сканер
            </button>
          </div>
          {busy && (
            <div className="mt-2 flex flex-col gap-1">
              <div className="flex items-center text-[11px] text-muted">
                <span>{busy.title}</span>
                <span className="ml-auto num">{busy.total > 1 ? `${Math.floor(busy.done)}/${busy.total}` : `${Math.round(busy.done * 100)}%`}</span>
                <button className="ml-2 text-muted hover:text-down" onClick={() => abort.current?.abort()}>
                  отмена
                </button>
              </div>
              <ProgressBar value={busy.total ? busy.done / busy.total : 0} />
              <div className="text-[10px] text-dim truncate">{busy.msg}</div>
            </div>
          )}
        </div>
        <Tabs
          value={editor}
          onChange={setEditor}
          tabs={[
            { value: 'about', label: 'Правила' },
            { value: 'config', label: 'config.yaml' },
            { value: 'universe', label: `universe.txt (${universe.length})` },
          ]}
        />
        {editor === 'about' && (
          <div className="flex-1 min-h-0 overflow-auto p-3 text-[12px] leading-relaxed flex flex-col gap-2">
            {DESCRIPTION.map((d, i) => (
              <p key={i} className="text-muted">
                <span className="text-text">{i + 1}.</span> {d}
              </p>
            ))}
            <p className="text-[11px] text-dim">
              Решения — по закрытию дня, исполнение — на открытии следующего; внутри дня — только защитные стопы. Правила реализованы буквально по спецификации; параметры — в
              config.yaml.
            </p>
          </div>
        )}
        {editor === 'config' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-hidden">
              <CodeMirror value={configText} height="100%" theme={oneDark} onChange={setConfigText} className="h-full text-[12px]" basicSetup={{ foldGutter: false }} />
            </div>
            <div className="flex items-center gap-2 px-2 py-1.5 border-t border-line text-[11px]">
              {parsed.ok ? <span className="text-up">✓ config.yaml разобран</span> : <span className="text-down truncate">{parsed.error}</span>}
              <button className="btn btn-sm btn-ghost ml-auto" onClick={() => confirm('Вернуть config.yaml к значениям по умолчанию из спецификации?') && setConfigText(defaultConfigText(market))}>
                По умолчанию
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => downloadText('config.yaml', configText, 'text/yaml')}>
                ⬇
              </button>
            </div>
          </div>
        )}
        {editor === 'universe' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-hidden">
              <CodeMirror value={universeText} height="100%" theme={oneDark} onChange={setUniverseText} className="h-full text-[12px]" basicSetup={{ foldGutter: false }} />
            </div>
            <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-t border-line text-[11px]">
              <span className="text-muted">{universe.length} тикеров</span>
              <button className="btn btn-sm btn-ghost ml-auto" onClick={() => setUniverseText(mk.universe.trim())}>
                {mk.uniLabel}
              </button>
              {market === 'crypto' && (
                <button
                  className="btn btn-sm btn-ghost"
                  title="Топ-30 пар к USDT по объёму за 24 часа на Binance (без стейблкоинов)"
                  onClick={async () => {
                    try {
                      setUniverseText((await cryptoTopByVolume(30)).join('\n'));
                    } catch (e: any) {
                      toast('warn', 'Не обновлено', String(e?.message || e));
                    }
                  }}
                >
                  ⟳ по объёму
                </button>
              )}
              <label className="btn btn-sm btn-ghost cursor-pointer">
                Файл…
                <input
                  type="file"
                  accept=".txt,.csv"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setUniverseText(await f.text());
                    e.target.value = '';
                  }}
                />
              </label>
              <button className="btn btn-sm btn-ghost" onClick={() => downloadText('universe.txt', universe.join('\n') + '\n')}>
                ⬇
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── правая часть: результаты ── */}
      <div className="flex-1 min-w-0 bg-panel rounded-lg flex flex-col overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'report', label: 'Отчёт' },
            { value: 'equity', label: 'Капитал' },
            { value: 'trades', label: `Сделки${result ? ` (${result.bt.trades.length})` : ''}` },
            { value: 'scan', label: 'Сканер' },
            { value: 'sens', label: 'Чувствительность' },
            { value: 'log', label: 'Журнал' },
          ]}
          right={
            result && (
              <div className="flex gap-1">
                <button className="btn btn-sm btn-ghost" onClick={() => downloadText('summary.md', result.summary, 'text/markdown')}>
                  ⬇ summary.md
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => downloadText('trades.csv', tradesCsv(result.bt.trades), 'text/csv')}>
                  ⬇ trades.csv
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => downloadText('equity.csv', equityCsv(result.bt), 'text/csv')}>
                  ⬇ equity.csv
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!chartRef.current) return toast('info', 'Откройте вкладку «Капитал», чтобы сохранить график');
                    const a = document.createElement('a');
                    a.href = chartRef.current.takeScreenshot().toDataURL('image/png');
                    a.download = 'equity.png';
                    a.click();
                  }}
                >
                  ⬇ equity.png
                </button>
              </div>
            )
          }
        />
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'report' && (result ? <Report r={result} /> : <Empty>Нажмите «▶ Бэктест». Первая загрузка S&P 500 (~500 тикеров) занимает пару минут, дальше данные берутся из кэша.</Empty>)}
          {tab === 'equity' &&
            (result ? (
              <div className="h-full p-2 flex flex-col gap-1">
                <div className="text-[11px] text-muted">
                  Капитал стратегии против {result.bt.benchSymbol} (buy & hold, к стартовому капиталу) и просадка
                </div>
                <div className="flex-1 min-h-[300px]">
                  <EquityChart
                    equity={result.bt.equity.map((e) => ({ t: e.t, v: e.equity }))}
                    bench={result.bt.bench}
                    benchLabel={`${result.bt.benchSymbol} (buy & hold)`}
                    height="100%"
                    onChart={(c) => (chartRef.current = c)}
                  />
                </div>
              </div>
            ) : (
              <Empty>Сначала запустите бэктест</Empty>
            ))}
          {tab === 'trades' && (result ? <TradesTable r={result.bt} /> : <Empty>Сначала запустите бэктест</Empty>)}
          {tab === 'scan' && (
            <ScanTab
              scan={scan}
              posCsv={posCsv}
              setPosCsv={setPosCsv}
              accText={accText || defaultAccount(parsed.ok ? parsed.c.initial_capital : 1_000_000)}
              setAccText={setAccText}
              onRun={runScanner}
              busy={!!busy}
              fromBacktest={
                result && !result.bt.config.end
                  ? () => {
                      setPosCsv(positionsCsv(result.bt.openAtEnd));
                      setAccText(accountYaml(result.bt.accountAtEnd));
                      toast('info', 'Позиции и счёт перенесены из бэктеста', `${result.bt.openAtEnd.length} позиций на ${result.m.end}`);
                    }
                  : null
              }
            />
          )}
          {tab === 'sens' && <SensTab rows={sens} onRun={runSens} busy={!!busy} />}
          {tab === 'log' && (result ? <LogTab r={result.bt} /> : <Empty>Сначала запустите бэктест</Empty>)}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── отчёт ───────────────────────── */

const EXIT_LABEL: Record<string, string> = { trail: 'трейлинг', time: 'тайм-стоп', stop_gap: 'гэп через стоп', stop: 'стоп', end_of_test: 'конец теста' };

function Report({ r }: { r: RunResult }) {
  const { m, bt } = r;
  const card = (label: string, value: string, cls = '') => (
    <div className="bg-panel2 rounded-md px-3 py-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={cx('num text-[15px] font-semibold', cls)}>{value}</div>
    </div>
  );
  const years = [...new Set(m.monthly.map((x) => x.month.slice(0, 4)))];
  const mret = new Map(m.monthly.map((x) => [x.month, x.ret]));
  return (
    <div className="p-3 flex flex-col gap-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">
          {bt.market === 'us' ? 'США' : bt.market === 'moex' ? 'Мосбиржа' : 'Крипта'} · {bt.universeSize} активов · {m.start} — {m.end} ({m.years.toFixed(1)} лет)
        </span>
        {m.checks.map((c) => (
          <Badge key={c.name} color={c.pass ? 'up' : 'down'}>
            {c.pass ? '✓' : '✗'} {c.name}: {c.value}
          </Badge>
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2">
        {card('Итоговый капитал', money(m.finalEquity))}
        {card('Доходность', pct(m.totalReturn), m.totalReturn >= 0 ? 'text-up' : 'text-down')}
        {card('CAGR', pct(m.cagr, 2), m.cagr >= 0 ? 'text-up' : 'text-down')}
        {card('Макс. просадка', `${pct(m.maxDD)} · ${m.maxDDDays} дн.`, 'text-down')}
        {card('Sharpe', num(m.sharpe))}
        {card('MAR', num(m.mar))}
        {card(`Бенчмарк ${bt.benchSymbol}`, `${pct(m.benchReturn)} · CAGR ${pct(m.benchCagr)}`)}
        {card('Сделок (в год)', `${m.trades} (${num(m.tradesPerYear, 1)})`)}
        {card('Win rate', pct(m.winRate))}
        {card('Прибыль / убыток, R', `${num(m.avgWinR)} / ${num(m.avgLossR)}`)}
        {card('Матожидание E_R', num(m.expectancyR), m.expectancyR >= 0 ? 'text-up' : 'text-down')}
        {card('Profit factor', num(m.profitFactor))}
        {card('Удержание, баров', num(m.avgBarsHeld, 1))}
        {card('Загрузка капитала', pct(m.avgExposure))}
        {card('Серия убытков', String(m.longestLosingStreak))}
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        <div className="bg-panel2 rounded-md p-3">
          <div className="font-semibold mb-1">Цель +100% в год</div>
          <div className="text-muted">
            g = <span className="num text-text">{pct(m.g, 3)}</span> — средний результат сделки от капитала
          </div>
          <div className="text-muted">
            Нужно сделок в год: <span className="num text-text">{m.nNeed === null ? 'цель недостижима (g ≤ 0)' : num(m.nNeed, 1)}</span>
          </div>
          <div className="text-muted">
            Фактически: <span className="num text-text">{num(m.nFact, 1)}</span>
          </div>
        </div>
        <div className="bg-panel2 rounded-md p-3">
          <div className="font-semibold mb-1">Выходы</div>
          {Object.entries(m.exitReasons).map(([k, v]) => (
            <div key={k} className="flex text-muted">
              <span>{EXIT_LABEL[k] ?? k}</span>
              <span className="ml-auto num text-text">{v}</span>
            </div>
          ))}
          <div className="text-[11px] text-dim mt-1">
            Пропущено входов: нет бара {bt.skips.no_bar}, нет слота {bt.skips.slots}, нет денег {bt.skips.cash}, мал оборот {bt.skips.turnover}, размер 0 {bt.skips.size}
          </div>
        </div>
        <div className="bg-panel2 rounded-md p-3">
          <div className="font-semibold mb-1">Предохранители счёта</div>
          {!bt.events.length && <div className="text-muted">не срабатывали</div>}
          <div className="max-h-28 overflow-auto">
            {bt.events.map((e, i) => (
              <div key={i} className="text-muted">
                <span className="num text-text">{new Date(e.date).toISOString().slice(0, 10)}</span> {EVENT_LABEL[e.kind]} · {pct(e.dd)}
              </div>
            ))}
          </div>
        </div>
      </div>
      {r.warnings.length > 0 && (
        <div className="bg-brand/10 border border-brand/30 rounded-md p-2.5 text-[11px] flex flex-col gap-0.5">
          {r.warnings.slice(0, 12).map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
          {r.warnings.length > 12 && <div className="text-dim">и ещё {r.warnings.length - 12} — в summary.md</div>}
        </div>
      )}
      <div>
        <div className="font-semibold mb-1">Доходность по годам и месяцам</div>
        <div className="overflow-x-auto">
          <table className="text-[11px] num">
            <thead className="text-muted">
              <tr>
                <th className="text-left pr-3 py-1">Год</th>
                {['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'].map((x) => (
                  <th key={x} className="px-1.5 text-right font-normal">
                    {x}
                  </th>
                ))}
                <th className="px-2 text-right">Год</th>
                <th className="px-2 text-right">{bt.benchSymbol}</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => {
                const yr = m.yearly.find((x) => String(x.year) === y);
                return (
                  <tr key={y} className="border-t border-line">
                    <td className="pr-3 py-0.5 text-muted">{y}</td>
                    {Array.from({ length: 12 }, (_, i) => {
                      const v = mret.get(`${y}-${String(i + 1).padStart(2, '0')}`);
                      return (
                        <td key={i} className={cx('px-1.5 text-right', v === undefined ? 'text-dim' : v >= 0 ? 'text-up' : 'text-down')}>
                          {v === undefined ? '' : (v * 100).toFixed(1)}
                        </td>
                      );
                    })}
                    <td className={cx('px-2 text-right font-semibold', (yr?.ret ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(yr?.ret ?? NaN)}</td>
                    <td className="px-2 text-right text-muted">{pct(yr?.bench ?? NaN)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TradesTable({ r }: { r: BacktestResult }) {
  const [sort, setSort] = useState<{ k: keyof BacktestResult['trades'][number]; dir: 1 | -1 }>({ k: 'entry_date', dir: -1 });
  const rows = useMemo(() => [...r.trades].sort((a, b) => ((a[sort.k] ?? '') > (b[sort.k] ?? '') ? 1 : (a[sort.k] ?? '') < (b[sort.k] ?? '') ? -1 : 0) * sort.dir), [r.trades, sort]);
  const th = (k: keyof BacktestResult['trades'][number], label: string) => (
    <th className="px-2 py-1 text-right font-normal cursor-pointer hover:text-text whitespace-nowrap" onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : -1 })}>
      {label}
      {sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <table className="w-full text-[11px] num">
      <thead className="text-muted sticky top-0 bg-panel">
        <tr>
          {th('symbol', 'Тикер')}
          {th('signal_date', 'Сигнал')}
          {th('entry_date', 'Вход')}
          {th('entry_price', 'Цена')}
          {th('q0', 'q0')}
          {th('R_ps', 'R_ps')}
          {th('add_date', 'Докупка')}
          {th('exit_date', 'Выход')}
          {th('exit_price', 'Цена')}
          {th('exit_reason', 'Причина')}
          {th('pnl', 'P&L')}
          {th('pnl_R', 'R')}
          {th('bars_held', 'Баров')}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 1500).map((t, i) => (
          <tr key={i} className="border-t border-line hover:bg-panel2">
            <td className="px-2 py-0.5 text-right font-semibold">{t.symbol}</td>
            <td className="px-2 text-right text-muted">{t.signal_date}</td>
            <td className="px-2 text-right">{t.entry_date}</td>
            <td className="px-2 text-right">{num(t.entry_price, 2)}</td>
            <td className="px-2 text-right">{num(t.q0, t.q0 % 1 ? 4 : 0)}</td>
            <td className="px-2 text-right">{num(t.R_ps, 2)}</td>
            <td className="px-2 text-right text-muted">{t.add_date ? `${t.add_date} +${num(t.add_qty!, t.add_qty! % 1 ? 4 : 0)}` : ''}</td>
            <td className="px-2 text-right">{t.exit_date}</td>
            <td className="px-2 text-right">{num(t.exit_price, 2)}</td>
            <td className="px-2 text-right text-muted">{EXIT_LABEL[t.exit_reason]}</td>
            <td className={cx('px-2 text-right', t.pnl >= 0 ? 'text-up' : 'text-down')}>{money(t.pnl)}</td>
            <td className={cx('px-2 text-right', t.pnl_R >= 0 ? 'text-up' : 'text-down')}>{num(t.pnl_R, 2)}</td>
            <td className="px-2 text-right">{t.bars_held}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ───────────────────────── сканер ───────────────────────── */

function parsePositions(csv: string): OpenPositionRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(',').map((x) => x.trim());
  const need = ['symbol', 'entry_date', 'entry_price', 'q0', 'qty', 'R_ps', 'stop', 'pyramided'];
  for (const k of need) if (!head.includes(k)) throw new Error(`positions.csv: нет колонки ${k}`);
  return lines.slice(1).map((l, n) => {
    const cells = l.split(',').map((x) => x.trim());
    const g = (k: string) => cells[head.indexOf(k)];
    const row: OpenPositionRow = {
      symbol: g('symbol').toUpperCase(),
      entry_date: g('entry_date'),
      entry_price: Number(g('entry_price')),
      q0: Number(g('q0')),
      qty: Number(g('qty')),
      R_ps: Number(g('R_ps')),
      stop: Number(g('stop')),
      pyramided: /^(true|1|yes|да)$/i.test(g('pyramided') ?? ''),
    };
    if (![row.entry_price, row.q0, row.qty, row.R_ps, row.stop].every(Number.isFinite) || !/^\d{4}-\d{2}-\d{2}$/.test(row.entry_date))
      throw new Error(`positions.csv, строка ${n + 2}: проверьте числа и дату`);
    return row;
  });
}

function parseAccount(text: string): AccountState {
  const y = parseYaml(text) as any;
  const a: AccountState = { equity: Number(y.equity), peak: Number(y.peak), cash: Number(y.cash), throttle: y.throttle === true, halted: y.halted === true };
  if (![a.equity, a.peak, a.cash].every(Number.isFinite)) throw new Error('account.yaml: нужны equity, peak, cash');
  return a;
}

const positionsCsv = (rows: OpenPositionRow[]) =>
  DEFAULT_POS_CSV + rows.map((r) => [r.symbol, r.entry_date, +r.entry_price.toFixed(6), r.q0, r.qty, +r.R_ps.toFixed(6), +r.stop.toFixed(6), r.pyramided].join(',')).join('\n') + (rows.length ? '\n' : '');
const accountYaml = (a: AccountState) => `equity: ${a.equity.toFixed(2)}\npeak: ${a.peak.toFixed(2)}\ncash: ${a.cash.toFixed(2)}\nthrottle: ${a.throttle}\nhalted: ${a.halted}\n`;

function ScanTab(p: {
  scan: ScanResult | null;
  posCsv: string;
  setPosCsv: (s: string) => void;
  accText: string;
  setAccText: (s: string) => void;
  onRun: () => void;
  busy: boolean;
  fromBacktest: (() => void) | null;
}) {
  const s = p.scan;
  return (
    <div className="p-3 grid xl:grid-cols-[minmax(320px,420px)_1fr] gap-3 text-[12px]">
      <div className="flex flex-col gap-2">
        <div className="text-muted text-[11px] leading-snug">
          Сканер запускается после закрытия рынка по последним данным и выдаёт действия на следующий день — теми же функциями правил, что и бэктест. Укажите свои открытые позиции и
          состояние счёта (флаг остановки снимает только пользователь).
        </div>
        <div className="font-semibold">positions.csv</div>
        <textarea className="field !h-40 font-mono text-[11px] p-2 resize-y" value={p.posCsv} onChange={(e) => p.setPosCsv(e.target.value)} spellCheck={false} />
        <div className="font-semibold">account.yaml</div>
        <textarea className="field !h-28 font-mono text-[11px] p-2 resize-y" value={p.accText} onChange={(e) => p.setAccText(e.target.value)} spellCheck={false} />
        <div className="flex gap-1">
          <button className="btn btn-brand flex-1" disabled={p.busy} onClick={p.onRun}>
            Сканировать
          </button>
          {p.fromBacktest && (
            <button className="btn" onClick={p.fromBacktest} title="Открытые позиции и счёт на последнюю дату бэктеста (до закрытия в конце теста)">
              Из бэктеста
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3 min-w-0">
        {!s && <Empty>Нажмите «Сканировать»</Empty>}
        {s && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Сигналы после закрытия {s.date}</span>
              <Badge color={s.regime ? 'up' : 'down'}>{s.regime ? 'режим рынка: входы разрешены' : 'режим рынка: входов нет'}</Badge>
              {s.account.throttle && <Badge color="brand">троттлинг: риск {(s.risk * 100).toFixed(2)}%</Badge>}
              {s.account.halted && <Badge color="down">остановка по просадке</Badge>}
              <span className="text-muted">риск на сделку {(s.risk * 100).toFixed(2)}%</span>
              <div className="ml-auto flex gap-1">
                <button className="btn btn-sm" onClick={() => downloadText(`signals-${s.date}.md`, s.markdown, 'text/markdown')}>
                  ⬇ signals/{s.date}.md
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    p.setAccText(accountYaml(s.account));
                    toast('info', 'account.yaml обновлён', 'peak и throttle — по сегодняшнему закрытию');
                  }}
                >
                  Обновить account.yaml
                </button>
              </div>
            </div>
            <div className="text-muted">
              Капитал {money(s.account.equity)} · пик {money(s.account.peak)} · свободно {money(s.account.cash)}
            </div>
            <div>
              <div className="font-semibold mb-1">Открытые позиции</div>
              {!s.positions.length ? (
                <div className="text-muted">нет</div>
              ) : (
                <table className="w-full num text-[11px]">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left py-1">Тикер</th>
                      <th className="text-left">Действие на завтра</th>
                      <th className="text-right">Стоп</th>
                      <th className="text-right">LL на завтра</th>
                      <th className="text-right">Close</th>
                      <th className="text-right">Баров</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.positions.map((x) => (
                      <tr key={x.symbol} className="border-t border-line">
                        <td className="py-0.5 font-semibold">{x.symbol}</td>
                        <td className={x.action === 'exit' ? 'text-down' : x.action === 'add' ? 'text-up' : 'text-muted'}>
                          {x.action === 'exit' ? `выйти на открытии — ${x.reason}` : x.action === 'add' ? (x.addQty ? `докупить ${num(x.addQty, x.addQty % 1 ? 4 : 0)}` : `докупка: ${x.reason}`) : x.action === 'no_data' ? 'нет данных' : `держать${x.reason ? ` (${x.reason})` : ''}`}
                        </td>
                        <td className="text-right">{num(x.stop, 2)}</td>
                        <td className="text-right">{num(x.trailNext, 2)}</td>
                        <td className="text-right">{num(x.close, 2)}</td>
                        <td className="text-right">{x.barsHeld}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <div className="font-semibold mb-1">Новые входы по рангу</div>
              {!s.entries.length ? (
                <div className="text-muted">{!s.regime || s.account.halted ? 'нет — режим рынка или остановка' : 'сигналов нет'}</div>
              ) : (
                <table className="w-full num text-[11px]">
                  <thead className="text-muted">
                    <tr>
                      <th className="text-left py-1">#</th>
                      <th className="text-left">Тикер</th>
                      <th className="text-right">Цена (close)</th>
                      <th className="text-right">Стоп</th>
                      <th className="text-right">Кол-во</th>
                      <th className="text-right">Сумма</th>
                      <th className="text-right">Доля</th>
                      <th className="text-right">rs_score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.entries.map((e, i) => (
                      <tr key={e.symbol} className="border-t border-line">
                        <td className="py-0.5 text-muted">{i + 1}</td>
                        <td className="font-semibold">{e.symbol}</td>
                        <td className="text-right">{num(e.price, 2)}</td>
                        <td className="text-right">{num(e.stop, 2)}</td>
                        <td className="text-right">{e.qty ? num(e.qty, e.qty % 1 ? 4 : 0) : <span className="text-dim">{e.skip}</span>}</td>
                        <td className="text-right">{money(e.amount)}</td>
                        <td className="text-right">{pct(e.share)}</td>
                        <td className="text-right">{e.rs.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {s.warnings.map((w, i) => (
              <div key={i} className="text-brand text-[11px]">
                ⚠ {w}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── чувствительность и журнал ───────────────────────── */

function SensTab({ rows, onRun, busy }: { rows: SensRow[]; onRun: () => void; busy: boolean }) {
  return (
    <div className="p-3 flex flex-col gap-2 text-[12px]">
      <div className="flex items-center gap-2">
        <button className="btn btn-brand" disabled={busy} onClick={onRun}>
          Запустить сетку (18 прогонов)
        </button>
        <span className="text-[11px] text-muted">
          breakout_lookback {'{15, 20, 30}'} × atr_stop_mult {'{1.5, 2.0, 2.5}'} × trail_lookback {'{10, 20}'}. Это проверка устойчивости, а не подбор: значения в config.yaml не
          меняются.
        </span>
      </div>
      {rows.length > 0 && (
        <table className="num text-[11px] w-auto">
          <thead className="text-muted">
            <tr>
              <th className="text-right px-2 py-1">breakout</th>
              <th className="text-right px-2">стоп ×ATR</th>
              <th className="text-right px-2">трейлинг</th>
              <th className="text-right px-2">CAGR</th>
              <th className="text-right px-2">MaxDD</th>
              <th className="text-right px-2">E_R</th>
              <th className="text-right px-2">Сделок</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={cx('border-t border-line', r.isBase && 'bg-brand/10 font-semibold')}>
                <td className="text-right px-2 py-0.5">{r.breakout_lookback}</td>
                <td className="text-right px-2">{r.atr_stop_mult}</td>
                <td className="text-right px-2">{r.trail_lookback}</td>
                <td className={cx('text-right px-2', r.cagr >= 0 ? 'text-up' : 'text-down')}>{pct(r.cagr, 2)}</td>
                <td className="text-right px-2 text-down">{pct(r.maxDD)}</td>
                <td className={cx('text-right px-2', r.expectancyR >= 0 ? 'text-up' : 'text-down')}>{num(r.expectancyR)}</td>
                <td className="text-right px-2">{r.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.some((r) => r.isBase) && <div className="text-[11px] text-dim">Подсвечена строка с параметрами из config.yaml.</div>}
    </div>
  );
}

function LogTab({ r }: { r: BacktestResult }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toUpperCase();
    return r.decisions.filter((d) => !s || d.symbol.includes(s) || d.date.includes(s)).slice(-2000).reverse();
  }, [r.decisions, q]);
  const kind = { entry: 'вход на открытии', exit: 'выход на открытии', add: 'докупка' } as const;
  return (
    <div className="p-3 flex flex-col gap-2 text-[11px]">
      <div className="flex items-center gap-2">
        <input className="field !h-7 w-56" placeholder="Фильтр: тикер или дата" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-muted">Решения на закрытии дня (исполнение — на следующем открытии). Показаны последние 2000.</span>
      </div>
      <table className="num">
        <tbody>
          {rows.map((d, i) => (
            <tr key={i} className="border-t border-line">
              <td className="pr-3 py-0.5 text-muted">{d.date}</td>
              <td className="pr-3 font-semibold">{d.symbol}</td>
              <td className={cx('pr-3', d.kind === 'entry' ? 'text-up' : d.kind === 'exit' ? 'text-down' : 'text-brand')}>{kind[d.kind]}</td>
              <td className="text-muted">{d.info}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

