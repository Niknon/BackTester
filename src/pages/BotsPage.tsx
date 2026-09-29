import { useState } from 'react';
import { BOT_LABELS, type AnyBot, type BotType } from '../engine/bots/types';
import { comboWeights } from '../engine/bots/combo';
import { runBotBacktest, type BotBacktestResult } from '../engine/headless';
import { bump, toast, useSession, useTick } from '../store/session';
import { fmtDuration, fmtNum, fmtPct, fmtPrice, fmtTime, fmtUsd, pnlClass } from '../lib/format';
import { Badge, cx, Empty, ProgressBar, Segmented, Sparkline } from '../components/ui';
import { ComboForm, DcaForm, FuturesGridForm, MartingaleForm, SpotGridForm, type FormResult } from '../components/bots/BotForms';
import { ReportGrid } from '../components/ReportGrid';
import { EquityChart } from '../components/EquityChart';
import { PriceChart } from '../components/chart/PriceChart';

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
  const [view, setView] = useState<'create' | 'running' | 'history'>('create');
  const [type, setType] = useState<BotType>('spotGrid');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bt, setBt] = useState<(BotBacktestResult & { name: string; from: string }) | null>(null);
  const [btFrom, setBtFrom] = useState<'now' | 'start'>('now');
  const bots = Object.values(ex.state.bots);
  const running = bots.filter((b) => b.status === 'running' || b.status === 'waiting');
  const stopped = bots.filter((b) => !(b.status === 'running' || b.status === 'waiting'));

  const onSubmit = async (r: FormResult, mode: 'live' | 'backtest') => {
    if (mode === 'live') {
      const res = ex.createBot(r.type, r.name, r.investment, r.params as any);
      if (res.error) return toast('error', 'Бот не создан', res.error);
      toast('success', `Бот «${r.name}» запущен`, `Инвестиции ${fmtUsd(r.investment)} USDT переведены в суб-аккаунт бота`);
      bump(true);
      setView('running');
      return;
    }
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

  const botSymbol = (b: AnyBot) => b.symbols[0] ?? symbol;
  const formSymbol = ex.market.has(symbol) ? symbol : ex.market.symbols()[0];

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
            {type === 'spotGrid' && <SpotGridForm key={type} onSubmit={onSubmit} busy={busy} initialSymbol={formSymbol} />}
            {type === 'futuresGrid' && <FuturesGridForm key={type} onSubmit={onSubmit} busy={busy} initialSymbol={formSymbol} />}
            {type === 'futuresCombo' && <ComboForm key={type} onSubmit={onSubmit} busy={busy} initialSymbol={formSymbol} />}
            {type === 'dca' && <DcaForm key={type} onSubmit={onSubmit} busy={busy} initialSymbol={formSymbol} />}
            {type === 'martingale' && <MartingaleForm key={type} onSubmit={onSubmit} busy={busy} initialSymbol={formSymbol} />}
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
          <div className="bg-panel rounded-lg overflow-auto flex flex-col">
            {bt ? (
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
                  </>
                ) : (
                  <div className="text-down">{bt.error}</div>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-[300px] p-1 flex flex-col">
                <div className="text-[11px] text-muted px-2 py-1">
                  График {formSymbol}. Быстрый бэктест прогоняет бота в отдельной копии биржи и не влияет на текущую сессию.
                </div>
                <div className="flex-1 min-h-0">
                  <PriceChart symbol={formSymbol} tf={chartTf} onTfChange={(t) => set({ chartTf: t })} compact />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {view === 'running' && (
        <div className="flex-1 min-h-0 overflow-auto p-2">
          {running.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-2">
              {running.map((b) => (
                <BotCard key={b.id} bot={b} onChart={() => set({ page: b.type === 'spotGrid' || b.type === 'dca' ? 'spot' : 'trade', symbol: botSymbol(b) })} />
              ))}
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
                    <tr key={b.id}>
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
    </div>
  );
}

function BotCard({ bot, onChart }: { bot: AnyBot; onChart: () => void }) {
  const ex = useSession((s) => s.ex)!;
  const [open, setOpen] = useState(false);
  const s = ex.botSummary(bot);
  const acc = ex.botAccount(bot);
  const p = bot.params as any;
  const orders = ex.activeOrders(acc.id);
  const positions = Object.values(acc.positions);
  const coins = Object.entries(acc.spot).filter(([, q]) => q > 0);
  const runtime = ex.now - (bot.startedTime ?? bot.createdTime);
  return (
    <div className="bg-panel rounded-lg p-3 flex flex-col gap-2 border border-line">
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
        <span>Капитал: {fmtUsd(s.equity)}</span>
        {(bot.type === 'spotGrid' || bot.type === 'futuresGrid') && (
          <span>
            Диапазон: {fmtPrice(p.lower, p.symbol)} – {fmtPrice(p.upper, p.symbol)} · {p.grids} сеток
            {bot.type === 'futuresGrid' ? ` · ${p.direction} ${p.leverage}x` : ''}
          </span>
        )}
        <span>Ордеров: {orders.length}</span>
      </div>
      {open && (
        <div className="text-[11px] flex flex-col gap-1 border-t border-line pt-2">
          {bot.type === 'futuresCombo' && (
            <ComboDetails bot={bot} />
          )}
          {positions.map((pos) => (
            <div key={pos.symbol} className="flex justify-between">
              <span>
                {pos.symbol} <span className={pos.size > 0 ? 'text-up' : 'text-down'}>{fmtNum(pos.size, 4)}</span> @ {fmtPrice(pos.avgPrice, pos.symbol)}
              </span>
              <span className={pnlClass(ex.unrealisedPnl(pos))}>{fmtUsd(ex.unrealisedPnl(pos), 2, true)}</span>
            </div>
          ))}
          {coins.map(([c, q]) => (
            <div key={c} className="flex justify-between">
              <span>
                {c}: {fmtNum(q, 6)}
              </span>
              <span>{fmtUsd(q * ex.price(`${c}USDT`))} USDT</span>
            </div>
          ))}
          <div className="flex justify-between">
            <span>USDT кошелька бота</span>
            <span>{fmtUsd(acc.walletBalance)}</span>
          </div>
          <div className="flex justify-between">
            <span>Комиссии / funding</span>
            <span>
              {fmtUsd(-acc.stats.fees)} / {fmtUsd(acc.stats.funding, 2, true)}
            </span>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Скрыть' : 'Подробнее'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onChart}>
          На графике
        </button>
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

function ComboDetails({ bot }: { bot: AnyBot }) {
  const ex = useSession((s) => s.ex)!;
  const w = comboWeights(ex, bot as any);
  const legs = (bot.params as any).legs as { symbol: string; side: string; weight: number }[];
  return (
    <div className="flex flex-col gap-1 mb-1">
      {legs.map((l, i) => (
        <div key={l.symbol} className="flex items-center gap-2">
          <span className="w-24">{l.symbol}</span>
          <span className={l.side === 'long' ? 'text-up' : 'text-down'}>{l.side === 'long' ? 'Лонг' : 'Шорт'}</span>
          <div className="flex-1 h-1.5 bg-panel3 rounded relative">
            <div className="absolute inset-y-0 left-0 bg-brand/70 rounded" style={{ width: `${w.weights[i] * 100}%` }} />
            <div className="absolute -top-0.5 w-0.5 h-2.5 bg-text" style={{ left: `${l.weight}%` }} />
          </div>
          <span className="num w-24 text-right">
            {fmtNum(w.weights[i] * 100, 1)}% / {l.weight}%
          </span>
        </div>
      ))}
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
