import { useEffect, useState } from 'react';
import { BOT_LABELS, type AnyBot, type BotType } from '../engine/bots/types';
import { runBotBacktest, type BotBacktestResult } from '../engine/headless';
import { bump, toast, useSession, useTick } from '../store/session';
import { fmtDuration, fmtNum, fmtPct, fmtPrice, fmtTime, fmtUsd, pnlClass } from '../lib/format';
import { Badge, cx, Empty, ProgressBar, Segmented, Sparkline, usePersistent } from '../components/ui';
import { botCategory, GRID_COLORS, liveOverlay, previewOverlay, type BotPreview } from '../components/bots/botChart';
import { ComboForm, DcaForm, FuturesGridForm, MartingaleForm, SpotGridForm, type FormResult } from '../components/bots/BotForms';
import { ReportGrid } from '../components/ReportGrid';
import { EquityChart } from '../components/EquityChart';
import { PriceChart } from '../components/chart/PriceChart';
import { LegsCompare } from '../components/bots/LegsCompare';
import { BotDetailsModal, ComboRebalanceStatus, ComboWeights, LastRebalance, RebalanceTable } from '../components/bots/BotDetails';

const TYPES: { type: BotType; icon: string; desc: string }[] = [
  { type: 'spotGrid', icon: '▦', desc: 'Покупает дёшево и продаёт дорого в диапазоне. Для бокового рынка.' },
  { type: 'futuresGrid', icon: '▩', desc: 'Грид на перпетуалах: лонг, шорт или нейтральный, с плечом.' },
  { type: 'futuresCombo', icon: '◎', desc: 'Портфель лонг/шорт перпетуалов с автоматической ребалансировкой весов.' },
  { type: 'dca', icon: '⟳', desc: 'Регулярные покупки фиксированной суммой (усреднение).' },
  { type: 'martingale', icon: '⤓', desc: 'Усреднение с множителем против движения, выход по TP.' },
];

export function BotsPage() {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const symbol = useSession((s) => s.symbol);
  const set = useSession((s) => s.set);
  const chartTf = useSession((s) => s.chartTf);
  const [view, setView] = usePersistent<'create' | 'running' | 'history'>('bt-bots-view', 'create', ['create', 'running', 'history']);
  const [type, setType] = usePersistent<BotType>('bt-bots-type', 'spotGrid', ['spotGrid', 'futuresGrid', 'futuresCombo', 'dca', 'martingale']);
  const [preview, setPreview] = useState<BotPreview | null>(null);
  const [chartDrag, setChartDrag] = useState<{ id: string; price: number; n: number }>();
  const [rightTab, setRightTab] = useState<'chart' | 'backtest'>('chart');
  const focusBot = useSession((s) => s.focusBot);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bt, setBt] = useState<(BotBacktestResult & { name: string; from: string }) | null>(null);
  const [btFrom, setBtFrom] = useState<'now' | 'start'>('now');
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const bots = Object.values(ex.state.bots);
  const running = bots.filter((b) => b.status === 'running' || b.status === 'waiting');
  const stopped = bots.filter((b) => !(b.status === 'running' || b.status === 'waiting'));
  // переход к боту из панели «Все позиции»
  useEffect(() => {
    if (focusBot && ex.state.bots[focusBot]) setView(ex.state.bots[focusBot].status === 'running' || ex.state.bots[focusBot].status === 'waiting' ? 'running' : 'history');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBot]);
  const selected = running.find((b) => b.id === focusBot) ?? running[0];

  const onSubmit = async (r: FormResult, mode: 'live' | 'backtest') => {
    if (mode === 'live') {
      const res = ex.createBot(r.type, r.name, r.investment, r.params as any);
      if (res.error) return toast('error', 'Бот не создан', res.error);
      toast('success', `Бот «${r.name}» запущен`, `Инвестиции ${fmtUsd(r.investment)} USDT переведены в суб-аккаунт бота`);
      bump(true);
      set({ focusBot: res.bot?.id ?? null });
      setView('running');
      return;
    }
    setRightTab('backtest');
    setBusy(true);
    setProgress(0);
    try {
      const res = await runBotBacktest(ex.market, ex.config, r.type, r.params as any, r.investment, {
        fromCursor: btFrom === 'now' ? ex.state.cursor : 0,
        onProgress: setProgress,
      });
      if (!res.ok) toast('error', 'Бэктест не выполнен', res.error);
      setBt({ ...res, name: r.name, from: btFrom === 'now' ? fmtTime(ex.now) : fmtTime(ex.market.start) });
    } finally {
      setBusy(false);
    }
  };

  const formSymbol = ex.market.has(symbol) ? symbol : ex.market.symbols()[0];
  const previewSymbol = preview && ex.market.has(preview.symbol) ? preview.symbol : formSymbol;
  const pov = previewOverlay(preview && preview.symbol === previewSymbol ? preview : null, ex.price(previewSymbol));
  const formProps = {
    onSubmit,
    busy,
    initialSymbol: formSymbol,
    onPreview: setPreview,
    chartDrag,
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 px-4 h-11 border-b border-line bg-panel shrink-0">
        <div className="font-semibold text-[14px]">Торговые боты</div>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'create', label: 'Создать бота' },
            { value: 'running', label: `Запущенные (${running.length})` },
            { value: 'history', label: `История (${stopped.length})` },
          ]}
        />
        <div className="ml-auto text-[11px] text-muted">
          Каждый бот работает в изолированном суб-аккаунте; при остановке средства возвращаются на единый аккаунт.
        </div>
      </div>
      {view === 'create' && (
        <div className="flex-1 min-h-0 grid grid-cols-[250px_360px_1fr] gap-1 p-1">
          <div className="bg-panel rounded-lg p-2 flex flex-col gap-1 overflow-auto">
            {TYPES.map((t) => (
              <button
                key={t.type}
                onClick={() => setType(t.type)}
                className={cx('text-left rounded-md p-3 border transition-colors', type === t.type ? 'border-brand bg-brand/5' : 'border-transparent hover:bg-panel2')}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <span className="text-brand text-[16px]">{t.icon}</span>
                  {BOT_LABELS[t.type]}
                </div>
                <div className="text-[11px] text-muted mt-1">{t.desc}</div>
              </button>
            ))}
          </div>
          <div className="bg-panel rounded-lg p-3 overflow-auto">
            <div className="font-semibold text-[14px] mb-3">{BOT_LABELS[type]}</div>
            {type === 'spotGrid' && <SpotGridForm key={type} {...formProps} />}
            {type === 'futuresGrid' && <FuturesGridForm key={type} {...formProps} />}
            {type === 'futuresCombo' && <ComboForm key={type} {...formProps} />}
            {type === 'dca' && <DcaForm key={type} {...formProps} />}
            {type === 'martingale' && <MartingaleForm key={type} {...formProps} />}
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
              Бэктест:
              <Segmented
                size="sm"
                value={btFrom}
                onChange={setBtFrom}
                options={[
                  { value: 'now', label: 'с текущего момента' },
                  { value: 'start', label: 'с начала сессии' },
                ]}
              />
            </div>
            {busy && (
              <div className="mt-2">
                <ProgressBar value={progress} />
              </div>
            )}
          </div>
          <div className="bg-panel rounded-lg overflow-hidden flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-2 h-9 border-b border-line shrink-0">
              <Segmented
                size="sm"
                value={bt ? rightTab : 'chart'}
                onChange={setRightTab}
                options={[
                  { value: 'chart', label: preview?.kind === 'combo' ? 'Сравнение активов' : `График ${previewSymbol}` },
                  { value: 'backtest', label: bt ? 'Результат бэктеста' : 'Бэктест —', disabled: !bt },
                ]}
              />
              {(!bt || rightTab === 'chart') && <GridLegend kind={preview?.kind} editable />}
            </div>
            {bt && rightTab === 'backtest' ? (
              <div className="p-3 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="font-semibold text-[14px]">Бэктест: {bt.name}</div>
                  <Badge color="info">с {bt.from} до конца периода</Badge>
                  <span className="text-[11px] text-dim ml-auto">{fmtNum(bt.durationMs, 0)} мс</span>
                  <button className="btn btn-sm btn-ghost" onClick={() => setBt(null)}>
                    ✕
                  </button>
                </div>
                {bt.ok ? (
                  <>
                    <ReportGrid r={bt.report} cols={6} compact />
                    {bt.bot && (
                      <div className="grid grid-cols-4 gap-1.5 text-[11px]">
                        <div className="bg-panel2 rounded px-3 py-2">
                          <div className="text-muted">Сеточная прибыль</div>
                          <div className={cx('num font-semibold', pnlClass(bt.bot.stats.gridProfit))}>{fmtUsd(bt.bot.stats.gridProfit, 2, true)}</div>
                        </div>
                        <div className="bg-panel2 rounded px-3 py-2">
                          <div className="text-muted">Арбитражей / циклов</div>
                          <div className="num font-semibold">
                            {bt.bot.stats.arbitrages} / {bt.bot.stats.cycles}
                          </div>
                        </div>
                        <div className="bg-panel2 rounded px-3 py-2">
                          <div className="text-muted">Ребалансировок</div>
                          <div className="num font-semibold">{bt.bot.stats.rebalances}</div>
                        </div>
                        <div className="bg-panel2 rounded px-3 py-2">
                          <div className="text-muted">Итог</div>
                          <div className="num font-semibold">{bt.bot.stopReason}</div>
                        </div>
                      </div>
                    )}
                    <EquityChart equity={bt.equity} bench={bt.bench} height={320} />
                    {bt.bot?.type === 'futuresCombo' && (
                      <div>
                        <div className="font-semibold mb-2">Журнал ребалансировок</div>
                        <RebalanceTable bot={bt.bot} />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-down">{bt.error}</div>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-[300px] p-1 flex flex-col">
                <div className="flex-1 min-h-0">
                  {preview?.kind === 'combo' ? (
                    <LegsCompare legs={preview.legs.filter((l) => ex.market.has(l.symbol))} />
                  ) : (
                  <PriceChart
                    symbol={previewSymbol}
                    tf={chartTf}
                    onTfChange={(t) => set({ chartTf: t })}
                    category={type === 'spotGrid' || type === 'dca' ? 'spot' : 'linear'}
                    compact
                    extraLines={pov.lines}
                    fitPrices={pov.fit}
                    onLineDrag={(id, price) => setChartDrag((d) => ({ id, price, n: (d?.n ?? 0) + 1 }))}
                  />
                  )}
                </div>
                <div className="text-[11px] text-dim px-2 pt-1">
                  Предпросмотр обновляется при изменении параметров. Быстрый бэктест прогоняет бота в отдельной копии биржи и не влияет на текущую сессию.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {view === 'running' && (
        <div className="flex-1 min-h-0 p-1">
          {running.length ? (
            <div className="h-full grid grid-cols-[440px_1fr] gap-1 min-h-0">
              <div className="overflow-auto flex flex-col gap-1 min-h-0 pr-0.5">
                {running.map((b) => (
                  <BotCard
                    key={b.id}
                    bot={b}
                    selected={selected?.id === b.id}
                    onSelect={() => set({ focusBot: b.id })}
                    onDetails={() => setDetailsId(b.id)}
                  />
                ))}
              </div>
              {selected && <RunningBotChart key={selected.id} bot={selected} onDetails={() => setDetailsId(selected.id)} />}
            </div>
          ) : (
            <Empty>
              Нет запущенных ботов.
              <button className="btn btn-brand mt-2" onClick={() => setView('create')}>
                Создать бота
              </button>
            </Empty>
          )}
        </div>
      )}
      {view === 'history' && (
        <div className="flex-1 min-h-0 overflow-auto p-2">
          {stopped.length ? (
            <table className="tbl bg-panel rounded-lg">
              <thead>
                <tr>
                  <th>Бот</th>
                  <th>Тип</th>
                  <th className="text-right">Инвестиции</th>
                  <th className="text-right">PnL</th>
                  <th className="text-right">ROI</th>
                  <th className="text-right">Сеточная прибыль</th>
                  <th className="text-right">Арбитражи / циклы</th>
                  <th>Работал</th>
                  <th>Причина остановки</th>
                </tr>
              </thead>
              <tbody>
                {stopped
                  .slice()
                  .reverse()
                  .map((b) => (
                    <tr key={b.id} className="cursor-pointer" onClick={() => setDetailsId(b.id)} title="Открыть подробности">
                      <td className="font-semibold">{b.name}</td>
                      <td>
                        <Badge color={b.status === 'liquidated' ? 'down' : 'muted'}>{BOT_LABELS[b.type]}</Badge>
                      </td>
                      <td className="text-right">{fmtUsd(b.investment)}</td>
                      <td className={cx('text-right font-semibold', pnlClass(b.finalPnl))}>{fmtUsd(b.finalPnl, 2, true)}</td>
                      <td className={cx('text-right', pnlClass(b.finalPnl))}>{fmtPct((b.finalPnl ?? 0) / b.investment)}</td>
                      <td className="text-right">{fmtUsd(b.stats.gridProfit, 2, true)}</td>
                      <td className="text-right">
                        {b.stats.arbitrages} / {b.stats.cycles}
                      </td>
                      <td className="text-muted">
                        {fmtTime(b.startedTime ?? b.createdTime)} → {fmtTime(b.stoppedTime)}
                      </td>
                      <td className="text-muted">{b.stopReason}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty>Остановленных ботов пока нет</Empty>
          )}
        </div>
      )}
      {detailsId && <BotDetailsModal key={detailsId} bot={ex.state.bots[detailsId] ?? null} onClose={() => setDetailsId(null)} />}
    </div>
  );
}

function BotCard({ bot, selected, onSelect, onDetails }: { bot: AnyBot; selected: boolean; onSelect: () => void; onDetails: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const s = ex.botSummary(bot);
  const acc = ex.botAccount(bot);
  const p = bot.params as any;
  const orders = ex.activeOrders(acc.id);
  const runtime = ex.now - (bot.startedTime ?? bot.createdTime);
  return (
    <div
      className={cx('bg-panel rounded-lg p-3 flex flex-col gap-2 border cursor-pointer transition-colors', selected ? 'border-brand' : 'border-line hover:border-line2')}
      onClick={onSelect}
      title="Показать на графике"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{bot.name}</div>
          <div className="text-[11px] text-muted">
            {BOT_LABELS[bot.type]} · {bot.status === 'waiting' ? <span className="text-brand">ожидает цену запуска</span> : `работает ${fmtDuration(runtime)}`}
          </div>
        </div>
        <Sparkline data={bot.hist.map((h) => h.v)} width={110} height={34} />
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Metric label="Общий PnL" value={fmtUsd(s.pnl, 2, true)} className={pnlClass(s.pnl)} sub={fmtPct(s.roi)} />
        {bot.type === 'spotGrid' || bot.type === 'futuresGrid' ? (
          <>
            <Metric label="Сеточная прибыль" value={fmtUsd(s.gridProfit, 2, true)} className={pnlClass(s.gridProfit)} sub={`${bot.stats.arbitrages} арбитражей`} />
            <Metric label="Плавающий PnL" value={fmtUsd(s.floating, 2, true)} className={pnlClass(s.floating)} />
          </>
        ) : bot.type === 'futuresCombo' ? (
          <>
            <Metric label="Ребалансировок" value={String(bot.stats.rebalances)} />
            <Metric label="Плечо" value={`${p.leverage}x`} />
          </>
        ) : bot.type === 'martingale' ? (
          <>
            <Metric label="Циклов (TP)" value={String(bot.stats.cycles)} />
            <Metric label="Усреднений" value={`${bot.rt.adds ?? 0}/${p.maxAdds}`} />
          </>
        ) : (
          <>
            <Metric label="Покупок" value={`${bot.rt.orders ?? 0}/${p.maxOrders}`} />
            <Metric label="Циклов TP" value={String(bot.stats.cycles)} />
          </>
        )}
        <Metric label="APR" value={fmtPct(s.apr, 1)} className={pnlClass(s.apr)} />
      </div>
      <div className="text-[11px] text-muted flex flex-wrap gap-x-3">
        <span>Инвестиции: {fmtUsd(bot.investment)}</span>
        {p.leverage && <span>Плечо: <b className="text-brand">{p.leverage}x</b></span>}
        <span>Капитал: {fmtUsd(s.equity)}</span>
        {(bot.type === 'spotGrid' || bot.type === 'futuresGrid') && (
          <span>
            Диапазон: {fmtPrice(p.lower, p.symbol)} – {fmtPrice(p.upper, p.symbol)} · {p.grids} сеток
            {bot.type === 'futuresGrid' ? ` · ${p.direction} ${p.leverage}x` : ''}
          </span>
        )}
        <span>Ордеров: {orders.length}</span>
      </div>
      {bot.type === 'futuresCombo' && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2">
          <ComboRebalanceStatus bot={bot} />
          <ComboWeights bot={bot} />
          <LastRebalance bot={bot} />
        </div>
      )}
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-sm btn-ghost" onClick={onDetails}>
          {bot.type === 'futuresCombo' ? 'Журнал и подробности' : 'Подробнее'}
        </button>
        {!selected && (
          <button className="btn btn-sm btn-ghost" onClick={onSelect}>
            На графике
          </button>
        )}
        <button
          className="btn btn-sm ml-auto !text-down"
          onClick={() => {
            if (!confirm(`Остановить «${bot.name}»? Ордера будут отменены, позиции закрыты по рынку.`)) return;
            ex.stopBot(bot.id);
            bump(true);
          }}
        >
          Остановить
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, className, sub }: { label: string; value: string; className?: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted truncate">{label}</div>
      <div className={cx('num font-semibold truncate', className)}>{value}</div>
      {sub && <div className={cx('text-[10px] num', className)}>{sub}</div>}
    </div>
  );
}

/** Легенда цветов сетки на графике. */
function GridLegend({ kind, editable }: { kind?: BotPreview['kind'] | 'live'; editable?: boolean }) {
  if (kind && kind !== 'grid' && kind !== 'live') return null;
  const dot = (c: string, l: string, dotted?: boolean) => (
    <span className="flex items-center gap-1">
      <span className="inline-block w-4 h-0 border-t-2" style={{ borderColor: c, borderStyle: dotted ? 'dotted' : 'solid' }} />
      {l}
    </span>
  );
  return (
    <div className="ml-auto flex items-center gap-3 text-[10px] text-muted">
      {dot(GRID_COLORS.buy, 'покупка')}
      {dot(GRID_COLORS.sell, 'продажа')}
      {dot(GRID_COLORS.idle, 'пустой уровень', true)}
      {dot(GRID_COLORS.bound, editable ? 'границы — тяните мышью' : 'границы')}
    </div>
  );
}

/** График выбранного работающего бота: все уровни сетки, ордера, позиция и сделки бота. */
function RunningBotChart({ bot, onDetails }: { bot: AnyBot; onDetails: () => void }) {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const set = useSession((s) => s.set);
  const setPrefs = useSession((s) => s.setPrefs);
  const chartTf = useSession((s) => s.chartTf);
  const [sym, setSym] = useState(bot.symbols[0]);
  const symbol = bot.symbols.includes(sym) ? sym : bot.symbols[0];
  const acc = ex.botAccount(bot);
  const isGrid = bot.type === 'spotGrid' || bot.type === 'futuresGrid';
  const ov = symbol ? liveOverlay(ex, bot, symbol) : { lines: [], fit: [] };
  const orders = ex.activeOrders(acc.id, symbol);
  const buys = orders.filter((o) => o.side === 'Buy' && o.status === 'New').length;
  const sells = orders.filter((o) => o.side === 'Sell' && o.status === 'New').length;
  const fills = ex.state.executions.filter((e) => e.accountId === acc.id && e.execType === 'Trade').slice(-8).reverse();
  const pos = symbol ? acc.positions[symbol] : undefined;
  const p = bot.params as any;
  if (!symbol) return <Empty>Бот ещё не выбрал инструмент</Empty>;
  return (
    <div className="bg-panel rounded-lg flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
        <div className="font-semibold truncate">{bot.name}</div>
        <Badge color={bot.status === 'waiting' ? 'brand' : 'up'}>{bot.status === 'waiting' ? 'ждёт запуска' : 'работает'}</Badge>
        {bot.symbols.length > 1 &&
          bot.symbols.map((s2) => (
            <button key={s2} className={cx('chip', s2 === symbol && 'active')} onClick={() => setSym(s2)}>
              {s2}
            </button>
          ))}
        {isGrid ? <GridLegend kind="live" /> : <span className="ml-auto" />}
        <button className="btn btn-sm btn-ghost" onClick={onDetails}>
          Подробнее
        </button>
        <button
          className="btn btn-sm btn-ghost"
          title="Открыть в торговом терминале (сетки ботов и их сделки будут показаны на основном графике)"
          onClick={() => {
            setPrefs({ showBotTrades: true, showBotGrids: true });
            set({ page: botCategory(bot) === 'spot' ? 'spot' : 'trade', symbol });
          }}
        >
          В терминал ↗
        </button>
      </div>
      <div className="flex-1 min-h-[260px]">
        <PriceChart
          symbol={symbol}
          tf={chartTf}
          onTfChange={(t) => set({ chartTf: t })}
          category={botCategory(bot)}
          accountId={acc.id}
          readOnly
          orderLines={!isGrid}
          otherBots={false}
          extraLines={ov.lines}
          fitPrices={ov.fit}
          compact
        />
      </div>
      <div className="grid grid-cols-[1fr_1.4fr] gap-2 p-2 border-t border-line shrink-0 text-[11px] max-h-[190px] min-h-0">
        <div className="flex flex-col gap-0.5">
          {isGrid ? (
            <>
              <Row2 label="Диапазон" value={`${fmtPrice(p.lower, symbol)} – ${fmtPrice(p.upper, symbol)}`} />
              <Row2 label="Уровней / активных ордеров" value={`${(bot.rt.levels?.length ?? p.grids + 1)} / ${buys + sells}`} />
              <Row2 label="Покупок / продаж в сетке" value={<><span className="text-up">{buys}</span> / <span className="text-down">{sells}</span></>} />
              <Row2 label="Цена внутри диапазона" value={(() => { const px = ex.price(symbol); return px < p.lower ? <span className="text-down">ниже на {fmtPct(px / p.lower - 1, 2, false)}</span> : px > p.upper ? <span className="text-down">выше на {fmtPct(px / p.upper - 1, 2, false)}</span> : <span className="text-up">да</span>; })()} />
            </>
          ) : (
            <>
              <Row2 label="Позиция" value={pos && pos.size ? <span className={pnlClass(pos.size)}>{fmtNum(pos.size, 6)} @ {fmtPrice(pos.avgPrice, symbol)}</span> : '—'} />
              <Row2 label="Активных ордеров" value={String(orders.length)} />
            </>
          )}
          <Row2 label="Сделок бота" value={String(ex.state.executions.filter((e) => e.accountId === acc.id && e.execType === 'Trade').length)} />
        </div>
        <div className="overflow-auto min-h-0">
          {fills.length ? (
            <table className="tbl">
              <tbody>
                {fills.map((e) => (
                  <tr key={e.id}>
                    <td className="text-muted">{fmtTime(e.time)}</td>
                    <td>{e.symbol}</td>
                    <td className={e.side === 'Buy' ? 'text-up' : 'text-down'}>{e.side === 'Buy' ? 'Покупка' : 'Продажа'}</td>
                    <td className="text-right">{fmtPrice(e.price, e.symbol)}</td>
                    <td className="text-right">{fmtNum(e.qty, 6)}</td>
                    <td className={cx('text-right', pnlClass(e.closedPnl))}>{e.closedPnl ? fmtUsd(e.closedPnl, 2, true) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-dim p-2">Сделок пока нет — ждём касания уровней сетки</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row2({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
