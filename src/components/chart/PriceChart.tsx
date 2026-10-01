import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { getAsset, roundToStep } from '../../data/assets';
import { bucketStart, chartIntervalsFor, intervalMs } from '../../data/intervals';
import type { IntervalKey } from '../../data/types';
import { lowerBound } from '../../data/types';
import { aggregate, appendAggregate, type Ohlcv } from '../../engine/aggregate';
import { MAIN } from '../../engine/exchange';
import type { Category } from '../../engine/types';
import { fmtNum, fmtPrice, priceDecimals } from '../../lib/format';
import { bump, toast, useSession, useTick, type IndicatorConfig } from '../../store/session';
import { useDrawings, type DrawTool } from '../../store/drawings';
import { computeIndicator, heikinAshi, IND_META, indicatorLabel, type IndSeries } from './indicatorSeries';
import { DrawingLayer } from './DrawingLayer';
import { cx, Dropdown, Check, NumInput } from '../ui';

const MAX_CANDLES = 6000;
const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

interface ChartData {
  key: string;
  agg: Ohlcv;
  baseEnd: number;
}

interface IndHandle {
  cfgKey: string;
  series: Map<string, ISeriesApi<SeriesType>>;
  specs: IndSeries[];
}

export interface ExtraLine {
  id: string;
  price: number;
  color: string;
  title?: string;
  style?: LineStyle;
  width?: 1 | 2;
  axis?: boolean;
  /** линию можно перетаскивать: изменить цену ордера / TP / SL; custom — вызывает onLineDrag */
  drag?: 'price' | 'trigger' | 'custom';
}

type DragKind = 'price' | 'trigger' | 'custom';

interface Props {
  symbol: string;
  tf: IntervalKey;
  onTfChange?: (tf: IntervalKey) => void;
  category?: Category;
  /** аккаунт, чьи ордера/позиции показывать */
  accountId?: string;
  extraLines?: ExtraLine[];
  onPriceClick?: (price: number) => void;
  compact?: boolean;
  /** перетаскивание линий с drag: 'custom' (например, границ сетки при настройке бота) */
  onLineDrag?: (id: string, price: number) => void;
  /** только просмотр: ордера аккаунта нельзя двигать мышью */
  readOnly?: boolean;
  /** рисовать линии активных ордеров аккаунта (по умолчанию да) */
  orderLines?: boolean;
  /** рисовать сетки других ботов (по умолчанию — по настройке «Слои») */
  otherBots?: boolean;
  /** цены, которые должны помещаться в видимую шкалу (границы сетки и т.п.) */
  fitPrices?: number[];
}

const TOOLS: { tool: DrawTool; icon: string; title: string }[] = [
  { tool: 'cursor', icon: '↖', title: 'Курсор (Esc)' },
  { tool: 'trend', icon: '╱', title: 'Трендовая линия' },
  { tool: 'ray', icon: '⟋', title: 'Луч' },
  { tool: 'hline', icon: '─', title: 'Горизонтальная линия' },
  { tool: 'vline', icon: '│', title: 'Вертикальная линия' },
  { tool: 'rect', icon: '▭', title: 'Прямоугольник' },
  { tool: 'fib', icon: 'ƒ', title: 'Коррекция Фибоначчи' },
  { tool: 'measure', icon: '⇕', title: 'Линейка (изменение цены/время)' },
  { tool: 'text', icon: 'T', title: 'Текст' },
];

const COLORS = ['#f7a600', '#4d8dff', '#20b26c', '#ef454a', '#a78bfa', '#eaecef', '#22d3ee'];

export function PriceChart({
  symbol,
  tf,
  onTfChange,
  category = 'linear',
  accountId = MAIN,
  extraLines,
  onPriceClick,
  compact,
  onLineDrag,
  readOnly,
  orderLines = true,
  otherBots = true,
  fitPrices,
}: Props) {
  const v = useTick();
  const ex = useSession((s) => s.ex)!;
  const prefs = useSession((s) => s.prefs);
  const setPrefs = useSession((s) => s.setPrefs);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const mainTypeRef = useRef<string>('');
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const dataRef = useRef<ChartData | null>(null);
  const indRef = useRef<IndHandle | null>(null);
  const linesRef = useRef(new Map<string, { line: IPriceLine; sig: string; price: number; drag?: DragKind }>());
  const dragRef = useRef<{ id: string; kind: DragKind; price: number } | null>(null);
  const onLineDragRef = useRef(onLineDrag);
  onLineDragRef.current = onLineDrag;
  /** диапазон цен, который автоподстройка шкалы обязана показать */
  const fitRef = useRef<[number, number] | null>(null);
  const fitKey = fitPrices?.filter(Number.isFinite).join(',') ?? '';
  const markerSigRef = useRef('');
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);
  const { tool, setTool, magnet, setMagnet, color, setColor, selected, remove, clear } = useDrawings();
  const hoverRef = useRef(false);
  const onPriceClickRef = useRef(onPriceClick);
  onPriceClickRef.current = onPriceClick;
  const [ctx, setCtx] = useState<{ x: number; y: number; price: number } | null>(null);

  const tfMs = intervalMs(tf);
  const chartType = prefs.chartType;
  const indicators = prefs.indicators.filter((i) => i.enabled);
  const indKey = JSON.stringify(indicators.map((i) => [i.id, i.type, i.params, i.color]));

  /* ── создание графика ── */
  useEffect(() => {
    const el = wrapRef.current!;
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#14151a' },
        textColor: '#858a93',
        fontSize: 11,
        fontFamily: 'Inter, system-ui, sans-serif',
        attributionLogo: false,
        panes: { separatorColor: '#262930', separatorHoverColor: '#33363f', enableResize: true },
      },
      grid: { vertLines: { color: '#1b1d23' }, horzLines: { color: '#1b1d23' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#5a5f69', labelBackgroundColor: '#33363f' },
        horzLine: { color: '#5a5f69', labelBackgroundColor: '#33363f' },
      },
      rightPriceScale: { borderColor: '#262930', scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: '#262930', timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 7 },
      localization: { locale: 'ru-RU' },
    });
    chartRef.current = c;
    setChart(c);
    if (import.meta.env.DEV) (window as any).__chart = { chart: c, main: () => mainRef.current };
    c.subscribeClick(() => {
      useDrawings.getState().select(null);
    });
    return () => {
      c.remove();
      chartRef.current = null;
      mainRef.current = null;
      markersRef.current = null;
      dataRef.current = null;
      indRef.current = null;
      linesRef.current.clear();
      mainTypeRef.current = '';
    };
  }, []);

  /* ── легенда ── */
  useEffect(() => {
    if (!chart) return;
    const h = (p: any) => {
      const d = dataRef.current?.agg;
      if (!d || !d.t.length) return;
      let i = d.t.length - 1;
      hoverRef.current = p?.time !== undefined;
      if (p?.time !== undefined) {
        const ms = (p.time as number) * 1000;
        let lo = 0;
        let hi = d.t.length - 1;
        while (lo < hi) {
          const m = (lo + hi + 1) >> 1;
          if (d.t[m] <= ms) lo = m;
          else hi = m - 1;
        }
        i = lo;
      }
      setLegend({ o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i], t: d.t[i] });
    };
    chart.subscribeCrosshairMove(h);
    return () => chart.unsubscribeCrosshairMove(h);
  }, [chart]);

  /* ── формат цены ── */
  useEffect(() => {
    if (!chart) return;
    const dec = priceDecimals(symbol);
    chart.applyOptions({ localization: { locale: 'ru-RU', priceFormatter: (p: number) => fmtNum(p, dec) } });
  }, [chart, symbol]);

  /* ── данные ── */
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const s = ex.market.series.get(symbol);
    if (!s) return;
    const end = ex.market.lastClosedIndex(symbol, ex.now) + 1;
    const key = `${symbol}|${tf}`;
    let d = dataRef.current;
    let rebuild = false;
    let dataRebuild = false;
    let firstChanged = -1;
    const needMain = mainTypeRef.current !== chartType || !mainRef.current;
    if (needMain) {
      if (mainRef.current) c.removeSeries(mainRef.current);
      markersRef.current = null;
      markerSigRef.current = '';
      linesRef.current.clear();
      const common = { priceLineVisible: true, lastValueVisible: true };
      mainRef.current =
        chartType === 'line'
          ? c.addSeries(LineSeries, { ...common, color: '#f7a600', lineWidth: 2 })
          : chartType === 'bars'
            ? c.addSeries(BarSeries, { ...common, upColor: '#20b26c', downColor: '#ef454a', thinBars: false })
            : c.addSeries(CandlestickSeries, {
                ...common,
                upColor: '#20b26c',
                downColor: '#ef454a',
                borderUpColor: '#20b26c',
                borderDownColor: '#ef454a',
                wickUpColor: '#20b26c',
                wickDownColor: '#ef454a',
              });
      mainRef.current.applyOptions({
        autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
          const r = original();
          const f = fitRef.current;
          if (!f) return r;
          if (!r || !r.priceRange) return { priceRange: { minValue: f[0], maxValue: f[1] } };
          return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, f[0]), maxValue: Math.max(r.priceRange.maxValue, f[1]) } };
        },
      } as any);
      mainTypeRef.current = chartType;
      rebuild = true;
    }
    if (!d || d.key !== key || end < d.baseEnd) {
      const lastT = end > 0 ? s.t[end - 1] : ex.market.start;
      const startT = bucketStart(lastT, tfMs) - MAX_CANDLES * tfMs;
      const startIdx = lowerBound(s.t, s.length, startT);
      d = { key, agg: aggregate(s, tfMs, startIdx, end), baseEnd: end };
      dataRef.current = d;
      rebuild = true;
      dataRebuild = true;
    } else if (end > d.baseEnd) {
      firstChanged = Math.max(0, d.agg.t.length - 1);
      appendAggregate(d.agg, s, tfMs, d.baseEnd, end);
      d.baseEnd = end;
    } else if (!rebuild && indRef.current?.cfgKey === indKey) {
      // данные не изменились
      updateOverlays();
      return;
    }
    const agg = d.agg;
    const shown = chartType === 'heikin' ? heikinAshi(agg) : agg;
    const main = mainRef.current!;
    const toBar = (i: number) =>
      chartType === 'line'
        ? { time: toTime(shown.t[i]), value: shown.c[i] }
        : { time: toTime(shown.t[i]), open: shown.o[i], high: shown.h[i], low: shown.l[i], close: shown.c[i] };
    if (rebuild) {
      main.setData(shown.t.map((_, i) => toBar(i)) as any);
    } else if (firstChanged >= 0) {
      for (let i = firstChanged; i < shown.t.length; i++) main.update(toBar(i) as any);
    }
    // индикаторы
    let ih = indRef.current;
    if (!ih || ih.cfgKey !== indKey) {
      if (ih) for (const ser of ih.series.values()) c.removeSeries(ser);
      ih = { cfgKey: indKey, series: new Map(), specs: [] };
      indRef.current = ih;
      rebuild = true;
      let subPane = 0;
      for (const cfg of indicators) {
        const specs = computeIndicator(cfg, agg);
        const pane = IND_META[cfg.type].pane === 'sub' ? ++subPane : 0;
        for (const sp of specs) {
          const ser =
            sp.kind === 'hist'
              ? c.addSeries(
                  HistogramSeries,
                  {
                    color: sp.color,
                    priceScaleId: sp.priceScaleId ?? (pane ? 'right' : undefined),
                    priceLineVisible: false,
                    lastValueVisible: pane > 0,
                    priceFormat: sp.priceScaleId === 'vol' ? { type: 'volume' } : { type: 'price', precision: 4, minMove: 0.0001 },
                  },
                  pane,
                )
              : c.addSeries(
                  LineSeries,
                  {
                    color: sp.color,
                    lineWidth: sp.lineWidth ?? 1,
                    priceLineVisible: false,
                    lastValueVisible: pane > 0,
                    crosshairMarkerVisible: false,
                    title: pane > 0 ? '' : '',
                  },
                  pane,
                );
          if (sp.priceScaleId === 'vol') c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
          for (const lvl of sp.levels ?? []) ser.createPriceLine({ price: lvl, color: '#5a5f69', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
          ih.series.set(sp.key, ser);
        }
      }
      const panes = c.panes();
      panes[0]?.setStretchFactor(1);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(panes.length > 3 ? 0.22 : 0.3);
    }
    const allSpecs: IndSeries[] = [];
    for (const cfg of indicators) allSpecs.push(...computeIndicator(cfg, agg));
    for (const sp of allSpecs) {
      const ser = ih.series.get(sp.key);
      if (!ser) continue;
      const point = (i: number) => {
        const val = sp.values[i];
        const t = toTime(agg.t[i]);
        if (!Number.isFinite(val)) return { time: t };
        return sp.colors ? { time: t, value: val, color: sp.colors[i] } : { time: t, value: val };
      };
      if (rebuild) ser.setData(agg.t.map((_, i) => point(i)) as any);
      else if (firstChanged >= 0) for (let i = firstChanged; i < agg.t.length; i++) ser.update(point(i) as any);
    }
    ih.specs = allSpecs;
    if (dataRebuild && agg.t.length) {
      const n = agg.t.length;
      c.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (compact ? 90 : 160)), to: n + 10 });
    }
    if (!legend || rebuild || !hoverRef.current) {
      const i = agg.t.length - 1;
      if (i >= 0) setLegend({ o: agg.o[i], h: agg.h[i], l: agg.l[i], c: agg.c[i], v: agg.v[i], t: agg.t[i] });
    }
    updateOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, symbol, tf, chartType, indKey, chart, prefs.showExecutions, prefs.showOrders, prefs.showBotGrids, prefs.showBotTrades, extraLines, accountId, category, fitKey, readOnly, orderLines, otherBots]);

  /* ── маркеры сделок и линии ордеров/позиций ── */
  function updateOverlays() {
    const c = chartRef.current;
    const main = mainRef.current;
    const d = dataRef.current;
    if (!c || !main || !d) return;
    const cats: Category[] = category === 'option' ? ['linear'] : [category];
    // автоподстройка шкалы под заданные цены
    const fp = fitPrices?.filter(Number.isFinite) ?? [];
    const nextFit: [number, number] | null = fp.length ? [Math.min(...fp), Math.max(...fp)] : null;
    const prevFit = fitRef.current;
    if ((nextFit?.join() ?? '') !== (prevFit?.join() ?? '')) {
      fitRef.current = nextFit;
      main.priceScale().applyOptions({ autoScale: true });
    }
    // маркеры
    if (!markersRef.current) markersRef.current = createSeriesMarkers(main, []);
    const botAccs = new Set(Object.values(ex.state.bots).map((b) => b.accountId));
    const execs = prefs.showExecutions
      ? ex.state.executions.filter(
          (e) =>
            e.symbol === symbol &&
            cats.includes(e.category) &&
            (e.execType === 'Trade' || e.execType === 'Liquidation') &&
            (e.accountId === accountId || (prefs.showBotTrades && botAccs.has(e.accountId))) &&
            e.time >= (d.agg.t[0] ?? 0),
        )
      : [];
    const sig = `${execs.length}|${execs.at(-1)?.id ?? ''}|${tf}|${d.key}|${mainTypeRef.current}`;
    if (sig !== markerSigRef.current) {
      markerSigRef.current = sig;
      const byBar = new Map<string, { t: number; side: string; qty: number; n: number; liq: boolean; bot: boolean }>();
      for (const e of execs.slice(-800)) {
        const bt = bucketStart(e.time, tfMs);
        const k = `${bt}|${e.side}|${e.accountId === accountId ? 'm' : 'b'}`;
        const cur = byBar.get(k);
        if (cur) {
          cur.qty += e.qty;
          cur.n++;
          cur.liq ||= e.execType === 'Liquidation';
        } else byBar.set(k, { t: bt, side: e.side, qty: e.qty, n: 1, liq: e.execType === 'Liquidation', bot: e.accountId !== accountId });
      }
      const markers: SeriesMarker<Time>[] = [...byBar.values()]
        .sort((a, b) => a.t - b.t)
        .map((m) => ({
          time: toTime(m.t),
          position: m.side === 'Buy' ? 'belowBar' : 'aboveBar',
          shape: m.side === 'Buy' ? 'arrowUp' : 'arrowDown',
          color: m.liq ? '#f7a600' : m.bot ? (m.side === 'Buy' ? '#1b7f52' : '#a8373b') : m.side === 'Buy' ? '#20b26c' : '#ef454a',
          text: m.liq ? 'LIQ' : m.bot ? '' : `${m.side === 'Buy' ? 'B' : 'S'}${m.n > 1 ? '×' + m.n : ''}`,
          size: m.bot ? 0.6 : 1,
        }));
      markersRef.current.setMarkers(markers);
    }
    // линии
    const want: ExtraLine[] = [];
    const acc = ex.state.accounts[accountId];
    if (acc && category !== 'spot') {
      const pos = acc.positions[symbol];
      if (pos && pos.size !== 0 && pos.category === 'linear') {
        const upnl = ex.unrealisedPnl(pos);
        want.push({
          id: 'entry',
          price: pos.avgPrice,
          color: pos.size > 0 ? '#20b26c' : '#ef454a',
          title: `${pos.size > 0 ? 'Лонг' : 'Шорт'} ${Math.abs(pos.size)} · ${upnl >= 0 ? '+' : ''}${fmtNum(upnl, 2)}`,
          style: LineStyle.Solid,
          width: 1,
        });
        const liq = ex.liqPrice(acc, pos);
        if (liq && liq > 0) want.push({ id: 'liq', price: liq, color: '#f7a600', title: 'Ликвидация', style: LineStyle.Dashed });
      }
    }
    if (prefs.showOrders && orderLines && acc) {
      for (const o of ex.activeOrders(accountId, symbol)) {
        if (!cats.includes(o.category)) continue;
        if (o.tag === 'tpsl') {
          const isTp = o.stopOrderType === 'TakeProfit';
          want.push({
            id: o.id,
            price: o.triggerPrice!,
            color: isTp ? '#20b26c' : '#ef454a',
            title: o.stopOrderType === 'TrailingStop' ? 'Трейлинг' : isTp ? 'TP ⇕' : 'SL ⇕',
            style: LineStyle.Dotted,
            drag: readOnly || o.stopOrderType === 'TrailingStop' ? undefined : 'trigger',
          });
        } else if (o.status === 'Untriggered') {
          want.push({ id: o.id, price: o.triggerPrice!, color: '#a78bfa', title: `Условн. ${o.side === 'Buy' ? 'B' : 'S'} ${o.qty}${readOnly ? '' : ' ⇕'}`, style: LineStyle.Dotted, drag: readOnly ? undefined : 'trigger' });
        } else if (o.orderType === 'Limit') {
          want.push({ id: o.id, price: o.price, color: o.side === 'Buy' ? '#20b26c' : '#ef454a', title: `Лимит ${o.side === 'Buy' ? 'B' : 'S'} ${o.qty}${readOnly ? '' : ' ⇕'}`, style: LineStyle.Dashed, drag: readOnly ? undefined : 'price' });
        }
      }
    }
    if (prefs.showBotGrids && otherBots) {
      for (const b of Object.values(ex.state.bots)) {
        if ((b.status !== 'running' && b.status !== 'waiting') || !b.symbols.includes(symbol)) continue;
        if (b.type !== 'spotGrid' && b.type !== 'futuresGrid') continue;
        for (const o of ex.activeOrders(b.accountId, symbol)) {
          if (o.orderType !== 'Limit' || o.status !== 'New') continue;
          want.push({
            id: `g${o.id}`,
            price: o.price,
            color: o.side === 'Buy' ? 'rgba(32,178,108,0.35)' : 'rgba(239,69,74,0.35)',
            style: LineStyle.Solid,
            axis: false,
          });
        }
        const p = b.params as any;
        want.push({ id: `gu${b.id}`, price: p.upper, color: 'rgba(247,166,0,0.6)', title: `${b.name} ↑`, style: LineStyle.Dashed });
        want.push({ id: `gl${b.id}`, price: p.lower, color: 'rgba(247,166,0,0.6)', title: `${b.name} ↓`, style: LineStyle.Dashed });
      }
    }
    // ценовые алерты (перетаскиваются мышью)
    for (const a of ex.alerts(symbol)) {
      want.push({ id: `alert:${a.id}`, price: a.price, color: '#fbbf24', title: `🔔 ${a.note || 'Алерт'}${readOnly ? '' : ' ⇕'}`, style: LineStyle.LargeDashed, drag: readOnly ? undefined : 'custom' });
    }
    if (extraLines) want.push(...extraLines);
    const seen = new Set<string>();
    for (const w of want) {
      if (!Number.isFinite(w.price)) continue;
      seen.add(w.id);
      if (dragRef.current?.id === w.id) continue;
      const sig2 = `${w.price}|${w.color}|${w.title}|${w.style}`;
      const cur = linesRef.current.get(w.id);
      const opts = {
        price: w.price,
        color: w.color,
        title: w.title ?? '',
        lineStyle: w.style ?? LineStyle.Dashed,
        lineWidth: w.width ?? 1,
        axisLabelVisible: w.axis ?? true,
      };
      if (!cur) linesRef.current.set(w.id, { line: main.createPriceLine(opts), sig: sig2, price: w.price, drag: w.drag });
      else {
        cur.drag = w.drag;
        cur.price = w.price;
        if (cur.sig !== sig2) {
          cur.line.applyOptions(opts);
          cur.sig = sig2;
        }
      }
    }
    for (const [id, l] of linesRef.current) {
      if (!seen.has(id)) {
        main.removePriceLine(l.line);
        linesRef.current.delete(id);
      }
    }
  }

  /* ── перетаскивание линий ордеров / TP / SL ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const hit = (clientY: number) => {
      const main = mainRef.current;
      const c = chartRef.current;
      if (!main || !c) return null;
      const r = el.getBoundingClientRect();
      const y = clientY - r.top;
      if (y > (c.panes()[0]?.getHeight() ?? 0)) return null;
      let best: { id: string; kind: DragKind; d: number; price: number } | null = null;
      for (const [id, l] of linesRef.current) {
        if (!l.drag) continue;
        const ly = main.priceToCoordinate(l.price);
        if (ly === null) continue;
        const d = Math.abs(ly - y);
        if (d <= 5 && (!best || d < best.d)) best = { id, kind: l.drag, d, price: l.price };
      }
      return best;
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || useDrawings.getState().tool !== 'cursor') return;
      const h = hit(e.clientY);
      if (!h) return;
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = { id: h.id, kind: h.kind, price: h.price };
    };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      const main = mainRef.current;
      if (!d) {
        if (e.target instanceof Node && el.contains(e.target)) el.style.cursor = hit(e.clientY) ? 'ns-resize' : '';
        return;
      }
      if (!main) return;
      const r = el.getBoundingClientRect();
      const p = main.coordinateToPrice(e.clientY - r.top);
      if (p === null) return;
      d.price = p as number;
      linesRef.current.get(d.id)?.line.applyOptions({ price: d.price });
      e.stopPropagation();
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const l = linesRef.current.get(d.id);
      if (l) l.sig = '';
      if (d.kind === 'custom' && d.id.startsWith('alert:')) {
        ex.moveAlert(d.id.slice(6), d.price);
        toast('info', 'Алерт перенесён', fmtPrice(d.price, symbol), 1800);
        bump(true);
        return;
      }
      if (d.kind === 'custom') {
        onLineDragRef.current?.(d.id, roundToStep(d.price, getAsset(symbol).tickSize));
        bump(true);
        return;
      }
      const err = ex.amendOrder(d.id, d.kind === 'price' ? { price: d.price } : { triggerPrice: d.price });
      if (err) toast('error', 'Ордер не изменён', err);
      else toast('info', 'Ордер изменён', `Новая цена ${fmtPrice(d.price, symbol)}`, 2000);
      bump(true);
    };
    el.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
  }, [ex, symbol]);

  const tfs = useMemo(() => chartIntervalsFor(ex.config.baseInterval), [ex.config.baseInterval]);
  const chg = legend ? legend.c - legend.o : 0;

  return (
    <div className="h-full flex flex-col bg-panel rounded-lg overflow-hidden">
      <div className="flex items-center gap-1 px-2 h-9 border-b border-line shrink-0 overflow-x-auto">
        {tfs.map((d) => (
          <button key={d.key} className={cx('chip', tf === d.key && 'active')} onClick={() => onTfChange?.(d.key)}>
            {d.label}
          </button>
        ))}
        <div className="w-px h-4 bg-line2 mx-1" />
        <select
          className="bg-transparent text-muted hover:text-text outline-none cursor-pointer"
          value={chartType}
          onChange={(e) => setPrefs({ chartType: e.target.value as any })}
          title="Тип графика"
        >
          <option value="candles">Свечи</option>
          <option value="heikin">Хейкен-Аши</option>
          <option value="bars">Бары</option>
          <option value="line">Линия</option>
        </select>
        <IndicatorsMenu />
        {!compact && (
          <Dropdown width={240} button={<button className="chip">Слои ▾</button>}>
            <div className="p-2 flex flex-col gap-2">
              <Check checked={prefs.showExecutions} onChange={(x) => setPrefs({ showExecutions: x })}>
                Сделки на графике
              </Check>
              <Check checked={prefs.showOrders} onChange={(x) => setPrefs({ showOrders: x })}>
                Ордера и TP/SL
              </Check>
              <Check checked={prefs.showBotGrids} onChange={(x) => setPrefs({ showBotGrids: x })}>
                Сетки ботов
              </Check>
              <Check checked={prefs.showBotTrades} onChange={(x) => setPrefs({ showBotTrades: x })}>
                Сделки ботов
              </Check>
              <button className="btn btn-sm btn-ghost" onClick={() => clear(symbol)}>
                Удалить все рисунки {symbol}
              </button>
            </div>
          </Dropdown>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button className="chip" title="К последней свече" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>
            ⇥
          </button>
          <button
            className="chip"
            title="Скриншот графика"
            onClick={() => {
              const cv = chartRef.current?.takeScreenshot();
              if (!cv) return;
              const a = document.createElement('a');
              a.href = cv.toDataURL('image/png');
              a.download = `${symbol}-${tf}.png`;
              a.click();
            }}
          >
            📷
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        {!compact && (
          <div className="w-9 shrink-0 border-r border-line flex flex-col items-center gap-0.5 py-1 overflow-y-auto">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                title={t.title}
                className={cx('w-7 h-7 rounded text-[13px] shrink-0', tool === t.tool ? 'bg-brand/20 text-brand' : 'text-muted hover:text-text hover:bg-panel3')}
                onClick={() => setTool(t.tool)}
              >
                {t.icon}
              </button>
            ))}
            <div className="w-5 h-px bg-line2 my-1" />
            <button
              title="Магнит: привязка к OHLC"
              className={cx('w-7 h-7 rounded text-[12px] shrink-0', magnet ? 'bg-brand/20 text-brand' : 'text-muted hover:text-text hover:bg-panel3')}
              onClick={() => setMagnet(!magnet)}
            >
              🧲
            </button>
            <Dropdown
              button={
                <button className="w-7 h-7 rounded shrink-0 flex items-center justify-center" title="Цвет рисунков">
                  <span className="w-3.5 h-3.5 rounded-full" style={{ background: color }} />
                </button>
              }
              width={150}
            >
              <div className="flex flex-wrap gap-1 p-2">
                {COLORS.map((c) => (
                  <button key={c} className="w-6 h-6 rounded-full border border-line2" style={{ background: c }} onClick={() => setColor(c)} />
                ))}
              </div>
            </Dropdown>
            {selected && (
              <button className="w-7 h-7 rounded text-down hover:bg-panel3" onClick={() => remove(symbol, selected)} title="Удалить выбранный рисунок (Delete)">
                🗑
              </button>
            )}
          </div>
        )}
      <div className="relative flex-1 min-w-0">
        <div
          ref={wrapRef}
          className="absolute inset-0"
          onMouseDown={(e) => {
            if (e.button === 0 && ctx) setCtx(null);
          }}
          onContextMenu={(e) => {
            const main = mainRef.current;
            if (!main) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const p = main.coordinateToPrice(e.clientY - r.top);
            if (p === null) return;
            setCtx({ x: e.clientX - r.left, y: e.clientY - r.top, price: roundToStep(p as number, getAsset(symbol).tickSize) });
          }}
        />
        {ctx && (
          <div
            className="absolute z-30 bg-panel2 border border-line2 rounded-md shadow-xl py-1 text-[12px] min-w-[220px]"
            style={{ left: Math.min(ctx.x, (wrapRef.current?.clientWidth ?? 400) - 230), top: Math.min(ctx.y, (wrapRef.current?.clientHeight ?? 300) - 130) }}
            onMouseLeave={() => setCtx(null)}
          >
            <div className="px-3 py-1 text-[10px] text-muted num">Цена {fmtPrice(ctx.price, symbol)}</div>
            {onPriceClickRef.current && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-panel3"
                onClick={() => {
                  onPriceClickRef.current?.(ctx.price);
                  toast('info', `Цена ${fmtPrice(ctx.price, symbol)} подставлена в форму ордера`, undefined, 1800);
                  setCtx(null);
                }}
              >
                ✎ Подставить цену в форму ордера
              </button>
            )}
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-panel3"
              onClick={() => {
                const a = ex.addAlert(symbol, ctx.price);
                if (a) toast('info', `🔔 Алерт ${symbol} ${a.dir === 'up' ? '≥' : '≤'} ${fmtPrice(a.price, symbol)}`, 'Симуляция встанет на паузу при касании цены', 3000);
                setCtx(null);
                bump(true);
              }}
            >
              🔔 Алерт на этой цене (пауза при касании)
            </button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-panel3"
              onClick={() => {
                navigator.clipboard?.writeText(String(ctx.price)).catch(() => {});
                setCtx(null);
              }}
            >
              ⧉ Скопировать цену
            </button>
            {ex.alerts(symbol).length > 0 && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-panel3 text-muted"
                onClick={() => {
                  for (const a of ex.alerts(symbol)) ex.removeAlert(a.id);
                  setCtx(null);
                  bump(true);
                }}
              >
                ✕ Удалить все алерты {symbol} ({ex.alerts(symbol).length})
              </button>
            )}
          </div>
        )}
        {legend && (
          <div className="absolute left-2 top-1.5 z-20 pointer-events-none text-[11px] num flex flex-wrap gap-x-2">
            <span className="text-text font-semibold">{symbol}</span>
            <span className="text-muted">
              O <span className={chg >= 0 ? 'text-up' : 'text-down'}>{fmtPrice(legend.o, symbol)}</span>
            </span>
            <span className="text-muted">
              H <span className={chg >= 0 ? 'text-up' : 'text-down'}>{fmtPrice(legend.h, symbol)}</span>
            </span>
            <span className="text-muted">
              L <span className={chg >= 0 ? 'text-up' : 'text-down'}>{fmtPrice(legend.l, symbol)}</span>
            </span>
            <span className="text-muted">
              C <span className={chg >= 0 ? 'text-up' : 'text-down'}>{fmtPrice(legend.c, symbol)}</span>
            </span>
            <span className={chg >= 0 ? 'text-up' : 'text-down'}>
              {chg >= 0 ? '+' : ''}
              {legend.o ? ((chg / legend.o) * 100).toFixed(2) : '0.00'}%
            </span>
            <span className="text-muted">V {fmtNum(legend.v, 2, { compact: true })}</span>
          </div>
        )}
        {indicators.length > 0 && !compact && (
          <div className="absolute left-2 top-6 z-20 pointer-events-none text-[10px] text-dim flex flex-col">
            {indicators
              .filter((i) => IND_META[i.type].pane === 'main' && i.type !== 'VOL')
              .map((i) => (
                <span key={i.id} style={{ color: i.color }}>
                  {indicatorLabel(i)}
                </span>
              ))}
          </div>
        )}
        {chart && mainRef.current && dataRef.current && (
          <DrawingLayer chart={chart} series={mainRef.current} data={dataRef.current.agg} tfMs={tfMs} symbol={symbol} version={v} />
        )}
      </div>
      </div>
    </div>
  );
}

function IndicatorsMenu() {
  const prefs = useSession((s) => s.prefs);
  const setPrefs = useSession((s) => s.setPrefs);
  const upd = (id: string, patch: Partial<IndicatorConfig>) => setPrefs({ indicators: prefs.indicators.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const n = prefs.indicators.filter((i) => i.enabled).length;
  return (
    <Dropdown button={<button className="chip">ƒx Индикаторы{n ? ` (${n})` : ''}</button>} width={300}>
      <div className="p-2 flex flex-col gap-1">
        {prefs.indicators.map((i) => (
          <div key={i.id} className="flex items-center gap-2 py-0.5">
            <Check checked={i.enabled} onChange={(x) => upd(i.id, { enabled: x })}>
              <span className="w-20 inline-block" style={{ color: i.enabled ? i.color ?? undefined : undefined }}>
                {IND_META[i.type].label}
              </span>
            </Check>
            <div className="flex gap-1 ml-auto">
              {i.params.map((p, k) => (
                <NumInput
                  key={k}
                  value={p}
                  className="!h-6 w-[58px] !px-1"
                  onChange={(val) => {
                    if (val === '' || val <= 0) return;
                    const params = [...i.params];
                    params[k] = val;
                    upd(i.id, { params });
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="text-[10px] text-dim pt-1 border-t border-line">Осцилляторы открываются в отдельных панелях под графиком.</div>
      </div>
    </Dropdown>
  );
}
