import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { chartIntervalsFor } from '../data/intervals';
import type { IntervalKey } from '../data/types';
import { STRATEGY_TEMPLATES, compileStrategy, expandGrid, optimizeStrategy, runStrategy, type OptimizeRange, type OptimizeRow, type StrategyResult } from '../engine/strategy';
import { toast, useSession } from '../store/session';
import { downloadText, fmtNum, fmtPct, fmtPrice, fmtQty, fmtTime, fmtUsd, pnlClass, toCsv } from '../lib/format';
import { Badge, cx, Empty, NumInput, ProgressBar, Select, Tabs } from '../components/ui';
import { ReportGrid } from '../components/ReportGrid';
import { EquityChart } from '../components/EquityChart';
import { StrategyChart } from '../components/lab/StrategyChart';

const CODE_KEY = 'bt-strategy-code';
const SAVED_KEY = 'bt-strategies';

const API_DOC = `// ── Структура ──
const PARAMS = { fast: 9 };            // параметры (числа доступны для оптимизации)
function init(ctx, params) {}          // один раз перед стартом
function onBar(ctx, params) {}         // на закрытии каждой свечи таймфрейма стратегии

// ── Данные текущей (закрытой) свечи ──
ctx.time  ctx.open  ctx.high  ctx.low  ctx.close  ctx.volume  ctx.index
ctx.bar(offset)                 // { time, open, high, low, close, volume }, offset=1 — предыдущая
ctx.value('close', offset)      // источник: open|high|low|close|volume|hl2|hlc3
ctx.price                       // текущая цена

// ── Индикаторы (последний аргумент offset — сдвиг назад) ──
ctx.ta.sma(period, offset, src)   ctx.ta.ema(...)   ctx.ta.wma(...)
ctx.ta.rsi(14, offset)            ctx.ta.atr(14, offset)   ctx.ta.cci(20)   ctx.ta.obv()   ctx.ta.vwap()
ctx.ta.bb(20, 2, offset)          → { upper, middle, lower }
ctx.ta.macd(12, 26, 9, offset)    → { macd, signal, hist }
ctx.ta.stoch(14, 3, 3, offset)    → { k, d }
ctx.ta.supertrend(10, 3, offset)  → { value, dir }   // dir: 1 — вверх, −1 — вниз
ctx.ta.adx(14, offset)            → { adx, plusDI, minusDI }
ctx.ta.donchian(20, offset)       → { upper, middle, lower }
ctx.ta.highest(n, offset, 'high') ctx.ta.lowest(n, offset, 'low')
ctx.ta.crossover(a0, a1, b0, b1)  ctx.ta.crossunder(a0, a1, b0, b1)

// ── Торговля (USDT-перпетуал, единый аккаунт) ──
ctx.buy(qty | { qty, usdt, percent, price, stop, tp, sl, reduceOnly })
ctx.sell(...)                   // percent — % доступного × плечо (по умолчанию 100)
ctx.long(opts)  ctx.short(opts) // закрыть противоположную позицию и открыть новую
ctx.exit(percent = 100)         // закрыть позицию
ctx.setTpSl({ tp, sl, trailing })   ctx.cancelAll()
ctx.setLeverage(n)   ctx.setMarginMode('cross' | 'isolated')
ctx.position  → { size, side, avgPrice, pnl, liqPrice }
ctx.equity  ctx.available  ctx.balance  ctx.leverage

// ── Прочее ──
ctx.state        // объект для своих переменных между свечами
ctx.log(...)     // лог
ctx.plot(name, value, { color, pane: 'price' | 'sub' })`;

function loadSaved(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}');
  } catch {
    return {};
  }
}

export function StrategyLabPage() {
  const ex = useSession((s) => s.ex)!;
  const [code, setCode] = useState(() => localStorage.getItem(CODE_KEY) || STRATEGY_TEMPLATES[0].code);
  const [symbol, setSymbol] = useState(ex.config.symbols[0]);
  const tfs = chartIntervalsFor(ex.config.baseInterval);
  const [tf, setTf] = useState<IntervalKey>(tfs.find((t) => t.key === '1h')?.key ?? tfs[0].key);
  const [balance, setBalance] = useState<number | ''>(ex.config.initialBalance);
  const [params, setParams] = useState<Record<string, any>>({});
  const [result, setResult] = useState<StrategyResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [tab, setTab] = useState<'report' | 'chart' | 'trades' | 'log' | 'opt'>('report');
  const [showApi, setShowApi] = useState(false);
  const [ranges, setRanges] = useState<Record<string, OptimizeRange & { on: boolean }>>({});
  const [optRows, setOptRows] = useState<OptimizeRow[]>([]);
  const [metric, setMetric] = useState<'totalReturn' | 'sharpe' | 'profitFactor' | 'calmar'>('sharpe');
  const [saved, setSaved] = useState(loadSaved);
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    localStorage.setItem(CODE_KEY, code);
  }, [code]);

  // параметры из PARAMS
  const compiled = useMemo(() => {
    try {
      return { ok: true as const, c: compileStrategy(code) };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.message || e) };
    }
  }, [code]);
  useEffect(() => {
    if (!compiled.ok) return;
    const P = compiled.c.PARAMS;
    setParams((cur) => {
      const next: Record<string, any> = {};
      for (const [k, v] of Object.entries(P)) next[k] = k in cur && typeof cur[k] === typeof v ? cur[k] : v;
      return next;
    });
    setRanges((cur) => {
      const next: typeof cur = {};
      for (const [k, v] of Object.entries(P)) {
        if (typeof v !== 'number') continue;
        next[k] = cur[k] ?? { on: false, from: Math.max(0, v / 2), to: v * 2, step: Math.max(v / 4, Number.isInteger(v) ? 1 : 0.1) };
      }
      return next;
    });
  }, [compiled]);

  const run = async (p = params) => {
    setRunning(true);
    setProgress(0);
    abortRef.current = { aborted: false };
    try {
      const res = await runStrategy(ex.market, ex.config, { code, symbol, timeframe: tf, params: p, initialBalance: Number(balance) || ex.config.initialBalance }, { onProgress: setProgress, signal: abortRef.current });
      setResult(res);
      if (!res.ok) {
        toast('error', 'Стратегия завершилась с ошибкой', res.error);
        setTab('log');
      } else if (tab === 'opt' || tab === 'log') setTab('report');
    } finally {
      setRunning(false);
    }
  };

  const optimize = async () => {
    const active = Object.fromEntries(Object.entries(ranges).filter(([, r]) => r.on).map(([k, r]) => [k, { from: r.from, to: r.to, step: r.step }]));
    if (!Object.keys(active).length) return toast('warn', 'Отметьте параметры для оптимизации');
    const n = expandGrid(active).length;
    if (n > 300 && !confirm(`${n} комбинаций — это может занять время. Продолжить? (будут проверены первые 500)`)) return;
    setRunning(true);
    setOptRows([]);
    setTab('opt');
    abortRef.current = { aborted: false };
    try {
      const rows = await optimizeStrategy(
        ex.market,
        ex.config,
        { code, symbol, timeframe: tf, params, initialBalance: Number(balance) || ex.config.initialBalance },
        active,
        {
          signal: abortRef.current,
          onProgress: (d, t, row) => {
            setProgress(d / t);
            if (row) setOptRows((r) => [...r, row]);
          },
        },
      );
      toast('success', `Оптимизация завершена: ${rows.length} прогонов`);
    } finally {
      setRunning(false);
    }
  };

  const sortedOpt = useMemo(() => {
    const val = (r: OptimizeRow) => (metric === 'profitFactor' && !Number.isFinite(r.report.profitFactor) ? 1e9 : (r.report as any)[metric]);
    return [...optRows].sort((a, b) => val(b) - val(a));
  }, [optRows, metric]);

  return (
    <div className="h-full flex flex-col gap-1 p-1">
      <div className="flex-1 min-h-0 flex gap-1">
        <div className="flex-1 min-w-0 bg-panel rounded-lg flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
            <span className="font-semibold">Редактор стратегии (JavaScript)</span>
            <select
              className="bg-panel2 border border-line rounded h-7 px-2 ml-2"
              value=""
              onChange={(e) => {
                const t = STRATEGY_TEMPLATES.find((x) => x.name === e.target.value);
                const sv = saved[e.target.value];
                if (t && confirm(`Загрузить шаблон «${t.name}»? Текущий код будет заменён.`)) setCode(t.code);
                else if (sv && confirm(`Открыть «${e.target.value}»?`)) setCode(sv);
              }}
            >
              <option value="">Шаблоны и сохранённые…</option>
              <optgroup label="Шаблоны">
                {STRATEGY_TEMPLATES.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              {Object.keys(saved).length > 0 && (
                <optgroup label="Мои стратегии">
                  {Object.keys(saved).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                const name = prompt('Название стратегии:');
                if (!name) return;
                const next = { ...saved, [name]: code };
                localStorage.setItem(SAVED_KEY, JSON.stringify(next));
                setSaved(next);
                toast('success', `Стратегия «${name}» сохранена`);
              }}
            >
              Сохранить как…
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => downloadText('strategy.js', code, 'text/javascript')}>
              ⬇ .js
            </button>
            <button className={cx('btn btn-sm ml-auto', showApi ? 'btn-brand' : 'btn-ghost')} onClick={() => setShowApi(!showApi)}>
              Справка API
            </button>
          </div>
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 overflow-hidden">
              <CodeMirror value={code} height="100%" theme={oneDark} extensions={[javascript()]} onChange={setCode} className="h-full" basicSetup={{ foldGutter: false }} />
            </div>
            {showApi && <pre className="w-[470px] shrink-0 overflow-auto text-[11px] leading-[1.5] p-3 bg-[#1b1d23] text-muted font-mono whitespace-pre">{API_DOC}</pre>}
          </div>
          {!compiled.ok && <div className="px-3 py-1.5 text-down text-[11px] border-t border-line shrink-0">{compiled.error}</div>}
        </div>
        <div className="w-[360px] shrink-0 bg-panel rounded-lg p-3 flex flex-col gap-3 overflow-auto">
          <div className="font-semibold">Параметры прогона</div>
          <Select label="Символ" value={symbol} onChange={setSymbol} options={ex.market.symbols().map((s) => ({ value: s, label: s }))} />
          <Select label="Таймфрейм" value={tf} onChange={setTf} options={tfs.map((t) => ({ value: t.key, label: t.label }))} />
          <NumInput label="Депозит" value={balance} onChange={setBalance} suffix="USDT" />
          <div className="text-[11px] text-muted">
            Период: {fmtTime(ex.market.start)} → {fmtTime(ex.market.end)}. Исполнение — на базовом интервале {ex.config.baseInterval} с комиссиями {fmtPct(ex.config.fees.linearTaker, 3, false)}, funding и
            ликвидациями.
          </div>
          {Object.keys(params).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] text-muted">PARAMS</div>
              {Object.entries(params).map(([k, v]) =>
                typeof v === 'number' ? (
                  <NumInput key={k} label={k} value={v} onChange={(x) => setParams({ ...params, [k]: x === '' ? 0 : x })} />
                ) : typeof v === 'boolean' ? (
                  <label key={k} className="flex items-center gap-2">
                    <input type="checkbox" className="checkbox" checked={v} onChange={(e) => setParams({ ...params, [k]: e.target.checked })} /> {k}
                  </label>
                ) : (
                  <label key={k} className="field">
                    <span className="lbl">{k}</span>
                    <input value={String(v)} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                  </label>
                ),
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn btn-brand flex-1 h-9" disabled={running || !compiled.ok} onClick={() => run()}>
              ▶ Запустить бэктест
            </button>
            {running && (
              <button className="btn btn-ghost h-9" onClick={() => (abortRef.current.aborted = true)}>
                Стоп
              </button>
            )}
          </div>
          {running && <ProgressBar value={progress} />}
          {Object.keys(ranges).length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-3">
              <div className="font-semibold">Оптимизация (перебор)</div>
              {Object.entries(ranges).map(([k, r]) => (
                <div key={k} className="grid grid-cols-[auto_1fr_1fr_1fr] gap-1 items-center">
                  <label className="flex items-center gap-1.5 w-20 truncate">
                    <input type="checkbox" className="checkbox" checked={r.on} onChange={(e) => setRanges({ ...ranges, [k]: { ...r, on: e.target.checked } })} />
                    {k}
                  </label>
                  <NumInput value={r.from} onChange={(x) => setRanges({ ...ranges, [k]: { ...r, from: Number(x) || 0 } })} className="!h-7 !px-1" />
                  <NumInput value={r.to} onChange={(x) => setRanges({ ...ranges, [k]: { ...r, to: Number(x) || 0 } })} className="!h-7 !px-1" />
                  <NumInput value={r.step} onChange={(x) => setRanges({ ...ranges, [k]: { ...r, step: Number(x) || 1 } })} className="!h-7 !px-1" />
                </div>
              ))}
              <div className="text-[10px] text-dim">от / до / шаг · комбинаций: {expandGrid(Object.fromEntries(Object.entries(ranges).filter(([, r]) => r.on))).length}</div>
              <Select
                label="Критерий"
                value={metric}
                onChange={setMetric}
                options={[
                  { value: 'sharpe', label: 'Шарп' },
                  { value: 'totalReturn', label: 'Доходность' },
                  { value: 'profitFactor', label: 'Profit factor' },
                  { value: 'calmar', label: 'Калмар' },
                ]}
              />
              <button className="btn h-8" disabled={running || !compiled.ok} onClick={optimize}>
                Запустить оптимизацию
              </button>
              <div className="text-[10px] text-dim">⚠ Подгонка параметров на одном периоде ведёт к переобучению — проверяйте на другом отрезке.</div>
            </div>
          )}
        </div>
      </div>
      <div className="h-[46%] shrink-0 bg-panel rounded-lg flex flex-col overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'report', label: 'Отчёт' },
            { value: 'chart', label: 'График сделок' },
            { value: 'trades', label: `Сделки${result ? ` (${result.closed.length})` : ''}` },
            { value: 'log', label: `Лог${result?.logs.length ? ` (${result.logs.length})` : ''}` },
            { value: 'opt', label: `Оптимизация${optRows.length ? ` (${optRows.length})` : ''}` },
          ]}
          right={
            result?.ok ? (
              <span className="text-[11px] text-muted">
                {fmtNum(result.bars, 0)} баров за {fmtNum(result.durationMs / 1000, 2)} с
              </span>
            ) : null
          }
        />
        <div className="flex-1 min-h-0 overflow-auto">
          {!result && tab !== 'opt' && <Empty>Напишите стратегию и нажмите «Запустить бэктест»</Empty>}
          {result && tab === 'report' &&
            (result.ok ? (
              <div className="grid grid-cols-[1fr_1fr] gap-2 p-2 h-full">
                <div className="overflow-auto">
                  <ReportGrid r={result.report} cols={4} />
                </div>
                <EquityChart equity={result.equity} bench={result.bench} benchLabel={`${symbol} buy&hold`} height="100%" />
              </div>
            ) : (
              <div className="p-3 text-down">{result.error}</div>
            ))}
          {result && tab === 'chart' && (
            <div className="h-full p-1">
              <StrategyChart market={ex.market} symbol={symbol} tf={tf} result={result} />
            </div>
          )}
          {result && tab === 'trades' && (
            <>
              {result.closed.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Направление</th>
                      <th>Открыта</th>
                      <th>Закрыта</th>
                      <th className="text-right">Кол-во</th>
                      <th className="text-right">Вход</th>
                      <th className="text-right">Выход</th>
                      <th className="text-right">PnL</th>
                      <th>Тип</th>
                      <th>
                        <button className="btn btn-sm btn-ghost" onClick={() => downloadText('strategy-trades.csv', toCsv(result.closed as any), 'text/csv')}>
                          CSV
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.closed
                      .slice()
                      .reverse()
                      .map((c, i) => (
                        <tr key={c.id}>
                          <td className="text-muted">{result.closed.length - i}</td>
                          <td className={c.side === 'Buy' ? 'text-up' : 'text-down'}>{c.side === 'Buy' ? 'Лонг' : 'Шорт'}</td>
                          <td className="text-muted">{fmtTime(c.openTime)}</td>
                          <td className="text-muted">{fmtTime(c.closeTime)}</td>
                          <td className="text-right">{fmtQty(c.qty, symbol)}</td>
                          <td className="text-right">{fmtPrice(c.entryPrice, symbol)}</td>
                          <td className="text-right">{fmtPrice(c.exitPrice, symbol)}</td>
                          <td className={cx('text-right font-semibold', pnlClass(c.closedPnl))}>{fmtUsd(c.closedPnl, 2, true)}</td>
                          <td>
                            <Badge color={c.type === 'Liquidation' ? 'down' : c.type === 'TP' ? 'up' : c.type === 'SL' ? 'brand' : 'muted'}>{c.type}</Badge>
                          </td>
                          <td />
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <Empty>Стратегия не совершила сделок</Empty>
              )}
            </>
          )}
          {result && tab === 'log' && (
            <div className="p-2 font-mono text-[11px] flex flex-col">
              {result.error && <div className="text-down mb-2">{result.error}</div>}
              {result.logs.map((l, i) => (
                <div key={i}>
                  <span className="text-dim">{fmtTime(l.t)}</span> {l.msg}
                </div>
              ))}
              {!result.logs.length && !result.error && <span className="text-dim">Лог пуст. Используйте ctx.log(...)</span>}
            </div>
          )}
          {tab === 'opt' &&
            (optRows.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    {Object.keys(sortedOpt[0].params)
                      .filter((k) => ranges[k]?.on)
                      .map((k) => (
                        <th key={k}>{k}</th>
                      ))}
                    <th className="text-right">Доходность</th>
                    <th className="text-right">Шарп</th>
                    <th className="text-right">Просадка</th>
                    <th className="text-right">PF</th>
                    <th className="text-right">Калмар</th>
                    <th className="text-right">Сделок</th>
                    <th className="text-right">Win rate</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedOpt.slice(0, 300).map((r, i) => (
                    <tr key={i}>
                      <td className="text-muted">{i + 1}</td>
                      {Object.entries(r.params)
                        .filter(([k]) => ranges[k]?.on)
                        .map(([k, v]) => (
                          <td key={k} className="num">
                            {String(v)}
                          </td>
                        ))}
                      <td className={cx('text-right', pnlClass(r.report.totalReturn))}>{fmtPct(r.report.totalReturn)}</td>
                      <td className="text-right">{fmtNum(r.report.sharpe, 2)}</td>
                      <td className="text-right text-down">{fmtPct(-r.report.maxDrawdown)}</td>
                      <td className="text-right">{Number.isFinite(r.report.profitFactor) ? fmtNum(r.report.profitFactor, 2) : '∞'}</td>
                      <td className="text-right">{fmtNum(r.report.calmar, 2)}</td>
                      <td className="text-right">{r.report.trades}</td>
                      <td className="text-right">{fmtPct(r.report.winRate, 1, false)}</td>
                      <td>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setParams({ ...params, ...r.params });
                            run({ ...params, ...r.params });
                          }}
                        >
                          Применить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Отметьте параметры справа и запустите оптимизацию</Empty>
            ))}
        </div>
      </div>
    </div>
  );
}
