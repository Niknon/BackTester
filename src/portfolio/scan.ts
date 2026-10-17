/**
 * Сканер «Пробоя лидеров» (раздел 7): после закрытия рынка — действия на следующий день.
 * Использует те же функции правил, что и бэктест (rules.ts, portfolio.ts) — логика не дублируется.
 */
import { dayKey, isoDay, type AccountState, type OpenPositionRow, type Prepared } from './backtest';
import type { LbConfig } from './config';
import { pctRank } from './indicators';
import { floorStep, positionSize, riskPerTrade, updateGuards, buyFill, type GuardEvent } from './portfolio';
import { assetFilter, entrySignal, manage, rankCandidates, regimeOk, rsScore } from './rules';

export interface ScanPositionAction {
  symbol: string;
  action: 'hold' | 'exit' | 'add' | 'no_data';
  reason?: string;
  addQty?: number;
  stop: number;
  /** уровень трейлинга на завтра: min(low) за последние trail_lookback баров, включая сегодняшний */
  trailNext: number;
  close: number;
  barsHeld: number;
}

export interface ScanEntry {
  symbol: string;
  price: number;
  stop: number;
  R_ps: number;
  qty: number;
  amount: number;
  share: number;
  rs: number;
  skip?: string;
}

export interface ScanResult {
  date: string;
  regime: boolean;
  account: AccountState;
  risk: number;
  events: GuardEvent[];
  positions: ScanPositionAction[];
  entries: ScanEntry[];
  warnings: string[];
  markdown: string;
}

export function runScan(p: Prepared, c: LbConfig, positions: OpenPositionRow[], account: AccountState): ScanResult {
  const { dataset, bench, ind } = p;
  const bi = bench.bars.t.length - 1;
  const D = bench.bars.t[bi];
  const dk = dayKey(D);
  const warnings: string[] = [];
  const index = new Map(dataset.assets.map((a, i) => [a.symbol, i]));
  const todayIdx = (a: number) => {
    const t = dataset.assets[a].bars.t;
    let i = t.length - 1;
    while (i >= 0 && dayKey(t[i]) > dk) i--;
    return i;
  };
  const lastBar = dataset.assets.map((_, a) => todayIdx(a));
  const hasToday = (a: number) => lastBar[a] >= 0 && dayKey(dataset.assets[a].bars.t[lastBar[a]]) === dk;

  // счёт по close[t]: обновляем peak и throttle; halted снимает только пользователь
  let mv = 0;
  for (const pos of positions) {
    const a = index.get(pos.symbol);
    if (a === undefined || lastBar[a] < 0) {
      warnings.push(`${pos.symbol}: нет данных — позиция оценена по цене входа`);
      mv += pos.qty * pos.entry_price;
    } else mv += pos.qty * dataset.assets[a].bars.c[lastBar[a]];
  }
  const equity = account.cash + mv;
  const guard = { peak: Math.max(account.peak, 0), throttle: account.throttle, halted: account.halted };
  const events: GuardEvent[] = [];
  updateGuards(guard, equity, D, c, events);
  const acc: AccountState = { equity, peak: guard.peak, cash: account.cash, throttle: guard.throttle, halted: guard.halted };
  const regime = regimeOk(bench, bi, c);
  const risk = riskPerTrade(acc.throttle, c);

  // открытые позиции → действие на завтра
  let cashLeft = acc.cash;
  const acts: ScanPositionAction[] = [];
  for (const pos of positions) {
    const a = index.get(pos.symbol);
    if (a === undefined || lastBar[a] < 0) {
      acts.push({ symbol: pos.symbol, action: 'no_data', stop: pos.stop, trailNext: NaN, close: NaN, barsHeld: 0 });
      continue;
    }
    const i = lastBar[a];
    const b = dataset.assets[a].bars;
    const entryK = dayKey(Date.parse(pos.entry_date + 'T00:00:00Z'));
    let barsHeld = 0;
    let reached = false;
    for (let j = i; j >= 0 && dayKey(b.t[j]) >= entryK; j--) {
      barsHeld++;
      if (b.c[j] >= pos.entry_price + c.exits.time_stop_min_r * pos.R_ps) reached = true;
    }
    let lo = Infinity;
    for (let j = Math.max(0, i - c.exits.trail_lookback + 1); j <= i; j++) lo = Math.min(lo, b.l[j]);
    const base = { symbol: pos.symbol, stop: pos.stop, trailNext: lo, close: b.c[i], barsHeld };
    if (!hasToday(a)) {
      acts.push({ ...base, action: 'hold', reason: 'нет бара сегодня — решение переносится' });
      continue;
    }
    const act = manage({ E: pos.entry_price, R_ps: pos.R_ps, stop: pos.stop, barsHeld, reachedMinR: reached, pyramided: pos.pyramided }, ind[a], i, { regime, halted: acc.halted }, c);
    if (act.action === 'exit') acts.push({ ...base, action: 'exit', reason: act.reason === 'trail' ? `трейлинг: close ${b.c[i]} < LL${c.exits.trail_lookback} ${ind[a].ll[i]}` : `тайм-стоп: ${barsHeld} баров без закрытия ≥ E + ${c.exits.time_stop_min_r}R` });
    else if (act.action === 'add') {
      const fill = buyFill(b.c[i], c);
      const step = dataset.assets[a].step;
      const q = Math.min(floorStep(c.pyramid.add_fraction * pos.q0, step), floorStep(cashLeft / (fill * (1 + c.costs.commission_pct)), step));
      cashLeft -= q * fill * (1 + c.costs.commission_pct); // докупки — приоритет по деньгам
      acts.push({ ...base, action: 'add', addQty: q, stop: act.newStop, reason: q > 0 ? undefined : 'нет свободных денег' });
    } else acts.push({ ...base, action: 'hold' });
  }

  // новые входы по рангу (тот же порядок, что в бэктесте: 5.2 → 5.3 → 5.4)
  const entries: ScanEntry[] = [];
  if (regime && !acc.halted) {
    const n = dataset.assets.length;
    const vA = new Float64Array(n);
    const vB = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      vA[a] = hasToday(a) ? ind[a].retA[lastBar[a]] : NaN;
      vB[a] = hasToday(a) ? ind[a].retB[lastBar[a]] : NaN;
    }
    const pA = pctRank(vA);
    const pB = pctRank(vB);
    const heldSyms = new Set(positions.map((x) => x.symbol));
    const cands: { symbol: string; rs: number; volRatio: number; a: number; i: number }[] = [];
    for (let a = 0; a < n; a++) {
      if (!hasToday(a) || heldSyms.has(dataset.assets[a].symbol)) continue;
      const i = lastBar[a];
      if (!assetFilter(ind[a], i, pA[a], pB[a], c) || !entrySignal(ind[a], i, c)) continue;
      cands.push({ symbol: dataset.assets[a].symbol, rs: rsScore(pA[a], pB[a]), volRatio: dataset.assets[a].bars.v[i] / ind[a].volAvg[i], a, i });
    }
    const slots = c.risk.max_positions - acts.filter((x) => x.action !== 'exit').length;
    for (const cd of rankCandidates(cands).slice(0, Math.max(0, slots))) {
      const close = dataset.assets[cd.a].bars.c[cd.i];
      const R_ps = c.risk.atr_stop_mult * ind[cd.a].atrRisk[cd.i];
      const fill = buyFill(close, c); // 5.5 с close[t] вместо open[t+1]
      const size = positionSize({ equity: acc.equity, risk, R_ps, fill, cash: cashLeft, turnover: ind[cd.a].turnover[cd.i], step: dataset.assets[cd.a].step }, c);
      const amount = size.q * fill;
      if (size.q > 0) cashLeft -= amount * (1 + c.costs.commission_pct);
      entries.push({ symbol: cd.symbol, price: close, stop: close - R_ps, R_ps, qty: size.q, amount, share: amount / acc.equity, rs: cd.rs, skip: size.q > 0 ? undefined : SKIP[size.skip ?? 'size'] });
    }
  }
  const res: ScanResult = { date: isoDay(D), regime, account: acc, risk, events, positions: acts, entries, warnings, markdown: '' };
  res.markdown = scanMarkdown(res, c);
  return res;
}

const SKIP: Record<string, string> = { cash: 'не хватает свободных денег', turnover: 'мал оборот (Turnover50 < 100 × сумма позиции)', size: 'размер позиции 0' };

const f = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)).toLocaleString('ru-RU', { maximumFractionDigits: d }) : '—');

export function scanMarkdown(r: ScanResult, c: LbConfig): string {
  const L: string[] = [];
  L.push(`# Сигналы «Пробоя лидеров» на следующий торговый день после ${r.date}`, '');
  L.push('## Счёт и режим рынка', '');
  L.push(`- Режим рынка: ${r.regime ? '✅ разрешены входы и докупки' : '⛔ новых входов и докупок нет'}`);
  L.push(`- Капитал: ${f(r.account.equity, 0)}, пик: ${f(r.account.peak, 0)}, свободно: ${f(r.account.cash, 0)}`);
  L.push(`- Троттлинг: ${r.account.throttle ? 'включён' : 'выключен'}; остановка: ${r.account.halted ? 'ДА (снимает только пользователь)' : 'нет'}`);
  L.push(`- Риск на сделку: ${(r.risk * 100).toFixed(2)}%`);
  for (const e of r.events) L.push(`- Событие: ${e.kind}`);
  L.push('', '## Открытые позиции', '');
  if (!r.positions.length) L.push('Нет открытых позиций.');
  else {
    L.push('| Тикер | Действие | Стоп | LL на завтра | Close | Баров |', '|---|---|---|---|---|---|');
    for (const p of r.positions) {
      const act =
        p.action === 'exit' ? `выйти на открытии (${p.reason})` : p.action === 'add' ? (p.addQty ? `докупить ${f(p.addQty, 6)} на открытии` : `докупка невозможна: ${p.reason}`) : p.action === 'no_data' ? 'нет данных' : `держать${p.reason ? ` (${p.reason})` : ''}`;
      L.push(`| ${p.symbol} | ${act} | ${f(p.stop, 4)} | ${f(p.trailNext, 4)} | ${f(p.close, 4)} | ${p.barsHeld} |`);
    }
  }
  L.push('', '## Новые входы по рангу', '');
  if (!r.regime || r.account.halted) L.push('Новых входов нет (режим рынка или остановка).');
  else if (!r.entries.length) L.push('Сигналов нет.');
  else {
    L.push('| # | Тикер | Цена (close) | Стоп | Кол-во | Сумма | Доля капитала | rs_score |', '|---|---|---|---|---|---|---|---|');
    r.entries.forEach((e, k) =>
      L.push(`| ${k + 1} | ${e.symbol} | ${f(e.price, 4)} | ${f(e.stop, 4)} | ${e.qty ? f(e.qty, 6) : `— (${e.skip})`} | ${f(e.amount, 0)} | ${(e.share * 100).toFixed(1)}% | ${e.rs.toFixed(3)} |`),
    );
  }
  L.push('', `Покупка — по рынку на открытии; стоп ставится сразу после исполнения: цена исполнения − R_ps (R_ps = ${c.risk.atr_stop_mult} × ATR${c.risk.atr_period}).`);
  for (const w of r.warnings) L.push(`- ⚠ ${w}`);
  return L.join('\n') + '\n';
}
