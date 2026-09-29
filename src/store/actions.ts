import { getAsset } from '../data/assets';
import { idbDelete, idbGet, idbKeys, idbSet } from '../data/cache';
import { DAY, bucketStart, chartIntervalsFor, intervalMs } from '../data/intervals';
import { loadFunding, loadSeries, PROVIDERS } from '../data/loader';
import type { ProviderId } from '../data/types';
import { fetchDvol } from '../data/volatility';
import { Exchange, MAIN, type ExchangeState } from '../engine/exchange';
import { MarketData } from '../engine/market';
import type { ExchangeEvent, SessionConfig } from '../engine/types';
import { fmtPrice, fmtQty, fmtUsd } from '../lib/format';
import { bump, toast, useSession } from './session';

let abort: AbortController | null = null;
let unsubscribe: (() => void) | null = null;

function setProgress(p: Partial<NonNullable<ReturnType<typeof useSession.getState>['progress']>> | null) {
  if (p === null) return useSession.setState({ progress: null });
  const cur = useSession.getState().progress ?? { title: '', message: '', done: 0, total: 1, errors: [] };
  useSession.setState({ progress: { ...cur, ...p } });
}

export function warmupStart(cfg: SessionConfig) {
  return cfg.start - cfg.warmupDays * DAY;
}

/** Загрузка одного символа в MarketData (свечи + funding + DVOL). */
async function loadSymbolInto(market: MarketData, cfg: SessionConfig, symbol: string, signal: AbortSignal, preferred?: ProviderId) {
  const res = await loadSeries({
    provider: preferred ?? cfg.provider,
    symbol,
    interval: cfg.baseInterval,
    start: warmupStart(cfg),
    end: cfg.end,
    signal,
    fallback: true,
    onProgress: (d, t, m) => setProgress({ message: m ?? symbol, done: d, total: t }),
  });
  if (res.errors.length) setProgress({ errors: [...(useSession.getState().progress?.errors ?? []), ...res.errors] });
  market.addSeries(symbol, res.series, res.provider);
  if (cfg.fundingEnabled) {
    try {
      setProgress({ message: `${symbol}: история funding` });
      const f = await loadFunding(res.provider, symbol, warmupStart(cfg), cfg.end, signal);
      market.setFunding(symbol, f);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      market.setFunding(symbol, []);
    }
  }
  const base = getAsset(symbol).base;
  if (cfg.options.ivSource === 'dvol' && (base === 'BTC' || base === 'ETH') && cfg.provider !== 'synthetic') {
    try {
      setProgress({ message: `${base}: индекс DVOL (Deribit)` });
      market.dvol.set(base, await fetchDvol(base, warmupStart(cfg) - 31 * DAY, cfg.end, signal));
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
    }
  }
  return res.provider;
}

function attachEvents(ex: Exchange) {
  unsubscribe?.();
  unsubscribe = ex.on((e: ExchangeEvent) => onEvent(ex, e));
}

function onEvent(ex: Exchange, e: ExchangeEvent) {
  const st = useSession.getState();
  switch (e.type) {
    case 'fill': {
      if (e.exec.accountId !== MAIN || e.exec.execType !== 'Trade') return;
      const x = e.exec;
      const cat = x.category === 'option' ? 'Опцион' : x.category === 'spot' ? 'Спот' : 'Перп';
      toast(
        x.side === 'Buy' ? 'buy' : 'sell',
        `${cat}: ${x.side === 'Buy' ? 'покупка' : 'продажа'} ${fmtQty(x.qty, x.category === 'option' ? undefined : x.symbol, x.category)} ${x.symbol}`,
        `по ${fmtPrice(x.price, x.category === 'option' ? undefined : x.symbol)} · комиссия ${fmtUsd(x.fee, 4)}${x.closedPnl ? ` · PnL ${fmtUsd(x.closedPnl, 2, true)}` : ''}`,
        3500,
      );
      if (st.prefs.pauseOnFill && (e.order?.tag === 'user' || e.order?.tag === 'tpsl')) pause();
      return;
    }
    case 'reject':
      if (e.order.accountId === MAIN && e.order.tag !== 'strategy') toast('error', 'Ордер отклонён', e.reason);
      return;
    case 'liquidation':
      if (e.accountId === MAIN) {
        toast('error', `Ликвидация ${e.symbol}`, `Потеряно ~${fmtUsd(e.loss)} USDT`, 9000);
        if (st.prefs.pauseOnLiquidation) pause();
      }
      return;
    case 'expiry':
      if (e.accountId === MAIN) toast(e.pnl >= 0 ? 'success' : 'warn', `Экспирация ${e.symbol}`, `Результат ${fmtUsd(e.pnl, 2, true)} USDT`, 7000);
      return;
    case 'bot':
      if (e.level !== 'info' || /остановлен/.test(e.message)) toast(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info', 'Бот', e.message, 6000);
      return;
    case 'info':
      toast('info', e.message);
      return;
  }
}

/** Новая сессия: загрузка данных и создание биржи. */
export async function startSession(cfg: SessionConfig) {
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  pause();
  useSession.setState({ status: 'loading', progress: { title: 'Загрузка исторических данных', message: '', done: 0, total: 1, errors: [] } });
  const market = new MarketData(cfg.baseInterval, cfg.start, cfg.end);
  try {
    for (const sym of cfg.symbols) {
      setProgress({ title: `Загрузка ${sym} (${cfg.symbols.indexOf(sym) + 1}/${cfg.symbols.length})`, done: 0, total: 1 });
      try {
        await loadSymbolInto(market, cfg, sym, signal);
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        setProgress({ errors: [...(useSession.getState().progress?.errors ?? []), String(e?.message || e)] });
      }
    }
    if (!market.symbols().length) throw new Error('Не удалось загрузить ни одного символа');
    cfg.symbols = market.symbols();
    const ex = Exchange.create(cfg, market);
    attachEvents(ex);
    startAutosave();
    const errs = useSession.getState().progress?.errors ?? [];
    const first = cfg.symbols[0];
    useSession.setState({
      ex,
      status: 'ready',
      progress: null,
      page: 'trade',
      symbol: first,
      chartTf: defaultChartTf(cfg),
      savedAt: null,
      optionBase: getAsset(first).hasOptions ? getAsset(first).base : 'BTC',
    });
    const used = [...new Set(market.symbols().map((s) => market.providers.get(s)))];
    toast('success', 'Сессия готова', `Источник: ${used.map((p) => PROVIDERS[p!].label).join(', ')}. Нажмите ▶ или пробел для воспроизведения.`);
    for (const e of [...new Set(errs)].slice(0, 2)) toast('warn', 'Источник данных', e, 8000);
    bump(true);
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      useSession.setState({ status: useSession.getState().ex ? 'ready' : 'setup', progress: null });
      return;
    }
    setProgress({ title: 'Ошибка загрузки', message: String(e?.message || e) });
  }
}

export function cancelLoading() {
  abort?.abort();
  const st = useSession.getState();
  useSession.setState({ status: st.ex ? 'ready' : 'setup', progress: null, page: st.ex ? st.page : 'setup' });
}

export function defaultChartTf(cfg: SessionConfig) {
  const opts = chartIntervalsFor(cfg.baseInterval);
  const pref = ['15m', '1h', '4h', '1d'];
  const span = cfg.end - cfg.start;
  const want = span <= 3 * DAY ? '5m' : span <= 20 * DAY ? '15m' : span <= 120 * DAY ? '1h' : span <= 400 * DAY ? '4h' : '1d';
  return (opts.find((o) => o.key === want)?.key ?? opts.find((o) => pref.includes(o.key))?.key ?? opts[0].key) as SessionConfig['baseInterval'];
}

/** Догрузить символ в текущую сессию. */
export async function ensureSymbol(symbol: string): Promise<boolean> {
  const st = useSession.getState();
  const ex = st.ex;
  if (!ex) return false;
  if (ex.market.has(symbol)) return true;
  if (st.loadingSymbols.includes(symbol)) return false;
  useSession.setState({
    loadingSymbols: [...st.loadingSymbols, symbol],
    progress: { title: `Загрузка ${symbol} за весь период сессии`, message: '', done: 0, total: 1, errors: [] },
  });
  abort = new AbortController();
  const ctrl = abort;
  try {
    const provider = await loadSymbolInto(ex.market, ex.config, symbol, ctrl.signal);
    ex.syncPrices();
    if (!ex.config.symbols.includes(symbol)) ex.config.symbols.push(symbol);
    toast('success', `${symbol} загружен`, `Источник: ${PROVIDERS[provider].label}`);
    useSession.setState({ progress: null });
    bump(true);
    return true;
  } catch (e: any) {
    if (e?.name !== 'AbortError') toast('error', `Не удалось загрузить ${symbol}`, String(e?.message || e), 9000);
    useSession.setState({ progress: null });
    return false;
  } finally {
    useSession.setState((s) => ({ loadingSymbols: s.loadingSymbols.filter((x) => x !== symbol) }));
  }
}

/* ───────────────────────── Воспроизведение ───────────────────────── */

let raf = 0;
let lastTs = 0;
let acc = 0;
let stopRequested = false;

function frame(ts: number) {
  const st = useSession.getState();
  const ex = st.ex;
  if (!st.playing || !ex) {
    raf = 0;
    return;
  }
  const dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  acc += dt * st.speed;
  let n = Math.floor(acc);
  acc -= n;
  const t0 = performance.now();
  stopRequested = false;
  while (n-- > 0) {
    if (!ex.step()) {
      pause();
      toast('info', 'Конец периода', 'Сессия дошла до конца выбранного диапазона. Смотрите итоги во вкладке «Аналитика».', 8000);
      break;
    }
    if (stopRequested) break;
    if (performance.now() - t0 > 22) {
      acc = 0;
      break;
    }
  }
  bump();
  if (useSession.getState().playing) raf = requestAnimationFrame(frame);
  else raf = 0;
}

export function play() {
  const st = useSession.getState();
  if (!st.ex || st.ex.state.finished) return;
  useSession.setState({ playing: true });
  lastTs = 0;
  acc = 0;
  if (!raf) raf = requestAnimationFrame(frame);
}

export function pause() {
  stopRequested = true;
  if (useSession.getState().playing) useSession.setState({ playing: false });
  bump(true);
}

export function togglePlay() {
  if (useSession.getState().playing) pause();
  else play();
}

export function setSpeed(speed: number) {
  useSession.setState({ speed });
  useSession.getState().setPrefs({ speed });
}

/** Шаг на n базовых баров. */
export function stepBars(n = 1) {
  const ex = useSession.getState().ex;
  if (!ex) return;
  for (let i = 0; i < n; i++) if (!ex.step()) break;
  bump(true);
}

/** Шаг до закрытия следующей свечи текущего таймфрейма графика. */
export function stepCandle() {
  const st = useSession.getState();
  const ex = st.ex;
  if (!ex) return;
  const tf = intervalMs(st.chartTf);
  const target = bucketStart(ex.now, tf) + tf;
  const cursor = Math.min(ex.market.totalBars, Math.ceil((target - ex.market.start) / ex.market.dt));
  ex.runTo(Math.max(cursor, ex.state.cursor + 1));
  bump(true);
}

/** Перемотка до времени с полной обработкой событий (без отрисовки). */
export async function fastForward(time: number) {
  const st = useSession.getState();
  const ex = st.ex;
  if (!ex) return;
  pause();
  const target = Math.min(ex.market.totalBars, Math.ceil((time - ex.market.start) / ex.market.dt));
  if (target <= ex.state.cursor) {
    toast('warn', 'Перемотка назад невозможна', 'Симуляция необратима — начните сессию заново или загрузите сохранение.');
    return;
  }
  const from = ex.state.cursor;
  useSession.setState({ progress: { title: 'Перемотка', message: 'Обработка баров…', done: 0, total: 1, errors: [] } });
  const quiet = ex.quiet;
  ex.quiet = true;
  try {
    while (ex.state.cursor < target && !ex.state.finished) {
      ex.runTo(target, 40);
      setProgress({ done: ex.state.cursor - from, total: target - from, message: new Date(ex.now).toISOString().slice(0, 16).replace('T', ' ') });
      await new Promise((r) => setTimeout(r, 0));
      if (!useSession.getState().progress) break; // отменено
    }
  } finally {
    ex.quiet = quiet;
    useSession.setState({ progress: null });
    bump(true);
  }
}

/* ───────────────────────── Сохранение сессий ───────────────────────── */

export interface SavedSession {
  id: string;
  name: string;
  savedAt: number;
  config: SessionConfig;
  providers: Record<string, ProviderId>;
  state: string;
  summary: { equity: number; cursor: number; total: number; now: number };
}

export async function saveSession(name?: string, silent = false) {
  const ex = useSession.getState().ex;
  if (!ex) return;
  const eq = ex.totalEquity();
  const rec: SavedSession = {
    id: ex.config.id,
    name: name || ex.config.name,
    savedAt: Date.now(),
    config: ex.config,
    providers: Object.fromEntries(ex.market.providers),
    state: ex.serialize(),
    summary: { equity: eq.total, cursor: ex.state.cursor, total: ex.market.totalBars, now: ex.now },
  };
  await idbSet('sessions', rec.id, rec);
  lastSavedCursor = ex.state.cursor;
  useSession.setState({ savedAt: rec.savedAt });
  if (!silent) toast('success', 'Сессия сохранена', rec.name);
}

/* автосохранение раз в минуту, если симуляция продвинулась */
let lastSavedCursor = -1;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
function startAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  lastSavedCursor = -1;
  autosaveTimer = setInterval(() => {
    const ex = useSession.getState().ex;
    if (!ex || !useSession.getState().prefs.autosave) return;
    if (ex.state.cursor === lastSavedCursor || ex.state.cursor === 0) return;
    saveSession(undefined, true).catch(() => {});
  }, 60_000);
}

export async function listSessions(): Promise<SavedSession[]> {
  const keys = await idbKeys('sessions');
  const out: SavedSession[] = [];
  for (const k of keys) {
    const s = await idbGet<SavedSession>('sessions', k);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteSession(id: string) {
  await idbDelete('sessions', id);
}

export async function restoreSession(saved: SavedSession) {
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  pause();
  const cfg = saved.config;
  const state: ExchangeState = JSON.parse(saved.state);
  // все символы, используемые в состоянии
  const syms = new Set(cfg.symbols);
  for (const acc of Object.values(state.accounts)) for (const p of Object.values(acc.positions)) if (p.category === 'linear') syms.add(p.symbol);
  useSession.setState({ status: 'loading', progress: { title: `Восстановление «${saved.name}»`, message: '', done: 0, total: 1, errors: [] } });
  const market = new MarketData(cfg.baseInterval, cfg.start, cfg.end);
  try {
    for (const sym of syms) {
      setProgress({ title: `Загрузка ${sym}`, done: 0, total: 1 });
      await loadSymbolInto(market, cfg, sym, signal, saved.providers[sym]);
    }
    const ex = Exchange.restore(state, market);
    attachEvents(ex);
    startAutosave();
    useSession.setState({
      ex,
      status: 'ready',
      progress: null,
      page: 'trade',
      symbol: cfg.symbols[0],
      chartTf: defaultChartTf(cfg),
      savedAt: saved.savedAt,
    });
    toast('success', 'Сессия восстановлена', saved.name);
    bump(true);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    setProgress({ title: 'Ошибка восстановления', message: String(e?.message || e) });
  }
}

export function exportSessionJson(): string | null {
  const ex = useSession.getState().ex;
  if (!ex) return null;
  return JSON.stringify({
    format: 'backtester-session',
    version: 1,
    config: ex.config,
    providers: Object.fromEntries(ex.market.providers),
    state: ex.state,
  });
}

export async function importSessionJson(text: string) {
  const j = JSON.parse(text);
  if (j.format !== 'backtester-session') throw new Error('Неизвестный формат файла');
  const saved: SavedSession = {
    id: j.config.id,
    name: j.config.name,
    savedAt: Date.now(),
    config: j.config,
    providers: j.providers ?? {},
    state: JSON.stringify(j.state),
    summary: { equity: 0, cursor: j.state.cursor, total: 0, now: j.state.now },
  };
  await idbSet('sessions', saved.id, saved);
  return saved;
}
