/**
 * «Пробой лидеров» — параметры (config.yaml из спецификации) и разбор YAML.
 * Значения по умолчанию — ровно из спецификации; для крипты — значения из комментариев к config.yaml.
 */

export type Market = 'us' | 'moex' | 'crypto';

export interface LbConfig {
  market: Market;
  universe_file: string;
  benchmark: string;
  start: string;
  end: string | null;
  initial_capital: number;
  regime: { sma_fast: number; sma_slow: number };
  trend_filter: {
    sma_short: number;
    sma_mid: number;
    sma_long: number;
    sma_long_rising_bars: number;
    high_lookback: number;
    max_dist_from_high: number;
    rs_periods: [number, number];
    rs_min_percentile: number;
  };
  entry: {
    breakout_lookback: number;
    volume_avg_lookback: number;
    volume_mult: number;
    atr_fast: number;
    atr_slow: number;
    min_turnover_multiple: number;
  };
  risk: { atr_period: number; atr_stop_mult: number; risk_per_trade: number; max_position_pct: number; max_positions: number };
  pyramid: { enabled: boolean; trigger_r: number; add_fraction: number; stop_r: number; requires_regime: boolean };
  exits: { trail_lookback: number; time_stop_bars: number; time_stop_min_r: number };
  account_guards: { throttle_dd: number; throttle_risk_per_trade: number; max_dd: number; max_dd_action: 'halt' | 'log_only' };
  costs: { commission_pct: number; slippage_pct: number };
  validation: { min_expectancy_r: number; target_expectancy_r: number; max_drawdown: number };
}

const BENCH: Record<Market, string> = { us: '^GSPC', moex: 'IMOEX', crypto: 'BTC/USDT' };

/** Текст config.yaml по умолчанию для рынка (как в спецификации, крипта — по комментариям). */
export function defaultConfigText(market: Market = 'us'): string {
  const c = market === 'crypto';
  return `market: ${market}                    # us | moex | crypto
universe_file: universe.txt
benchmark: "${BENCH[market]}"            # us: ^GSPC | moex: IMOEX | crypto: BTC/USDT
start: 2015-01-01
end: null                     # null = последняя доступная дата
initial_capital: 1000000

regime:                       # фильтр режима рынка по бенчмарку
  sma_fast: 50
  sma_slow: 200

trend_filter:
  sma_short: 50
  sma_mid: 150
  sma_long: 200
  sma_long_rising_bars: ${c ? 30 : 21}    # crypto: 30
  high_lookback: ${c ? 365 : 252}          # crypto: 365
  max_dist_from_high: 0.25
  rs_periods: ${c ? '[90, 180]' : '[63, 126]'}       # crypto: [90, 180]
  rs_min_percentile: 0.80

entry:
  breakout_lookback: 20
  volume_avg_lookback: 50
  volume_mult: 1.5
  atr_fast: 10
  atr_slow: 50
  min_turnover_multiple: 100  # средний оборот за 50 баров >= 100 * сумма позиции

risk:
  atr_period: 14
  atr_stop_mult: 2.0
  risk_per_trade: 0.01
  max_position_pct: 0.20      # проверяется только при первом входе
  max_positions: 5

pyramid:
  enabled: true
  trigger_r: 1.5
  add_fraction: 0.5           # доля от исходного количества q0
  stop_r: 0.5
  requires_regime: true

exits:
  trail_lookback: 10
  time_stop_bars: 10
  time_stop_min_r: 1.0

account_guards:
  throttle_dd: 0.10
  throttle_risk_per_trade: 0.005
  max_dd: 0.20
  max_dd_action: halt         # halt | log_only

costs:
  commission_pct: ${c ? '0.001 ' : '0.0005'}      # crypto: 0.001
  slippage_pct: 0.0005

validation:
  min_expectancy_r: 0.4
  target_expectancy_r: 0.6
  max_drawdown: 0.20
`;
}

/* ───────────────────────── мини-YAML ───────────────────────── */

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x)) : [];
  }
  if (/^(["']).*\1$/.test(s)) return s.slice(1, -1);
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
  return s;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Разбор подмножества YAML, которого достаточно для config.yaml: вложенные словари отступами, скаляры, списки [a, b]. */
export function parseYaml(text: string): { [k: string]: Yaml } {
  const root: { [k: string]: Yaml } = {};
  const stack: { indent: number; obj: { [k: string]: Yaml } }[] = [{ indent: -1, obj: root }];
  text.split(/\r?\n/).forEach((rawLine, n) => {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) throw new Error(`config.yaml, строка ${n + 1}: ожидается «ключ: значение»`);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (m[2] === '') {
      const child: { [k: string]: Yaml } = {};
      parent[m[1]] = child;
      stack.push({ indent, obj: child });
    } else parent[m[1]] = scalar(m[2]);
  });
  return root;
}

/** Конфиг из текста: значения по умолчанию рынка + то, что задано в тексте; с проверкой типов. */
export function parseConfig(text: string): LbConfig {
  const y = parseYaml(text);
  const market = (y.market ?? 'us') as Market;
  if (!['us', 'moex', 'crypto'].includes(market)) throw new Error('market: допустимо us | moex | crypto');
  const def = parseYamlDefaults(market);
  const merged = merge(def, y) as unknown as LbConfig;
  const num = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}: ожидается число`);
  };
  num(merged.initial_capital, 'initial_capital');
  for (const sec of ['regime', 'trend_filter', 'entry', 'risk', 'exits', 'account_guards', 'costs', 'validation'] as const)
    for (const [k, v] of Object.entries(merged[sec])) if (k !== 'rs_periods' && k !== 'max_dd_action') num(v, `${sec}.${k}`);
  const rp = merged.trend_filter.rs_periods;
  if (!Array.isArray(rp) || rp.length !== 2 || !rp.every((x) => typeof x === 'number')) throw new Error('trend_filter.rs_periods: ожидается [n1, n2]');
  if (!['halt', 'log_only'].includes(merged.account_guards.max_dd_action)) throw new Error('account_guards.max_dd_action: halt | log_only');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.start))) throw new Error('start: дата ГГГГ-ММ-ДД');
  if (merged.end !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(merged.end))) throw new Error('end: дата ГГГГ-ММ-ДД или null');
  merged.start = String(merged.start);
  merged.end = merged.end === null ? null : String(merged.end);
  return merged;
}

const defaultsCache: Partial<Record<Market, { [k: string]: Yaml }>> = {};
function parseYamlDefaults(m: Market) {
  return (defaultsCache[m] ??= parseYaml(defaultConfigText(m)));
}

function merge(a: Yaml, b: Yaml): Yaml {
  if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
    const out: { [k: string]: Yaml } = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b === undefined ? a : b;
}

/** Заменить значение верхнеуровневого ключа в тексте config.yaml, сохранив комментарии. */
export function setTopLevel(text: string, key: string, value: string): string {
  const re = new RegExp(`^(${key}:\\s*)([^#\\n]*?)(\\s*(#.*)?)$`, 'm');
  return re.test(text) ? text.replace(re, (_m, a, _b, c) => `${a}${value}${c}`) : `${key}: ${value}\n${text}`;
}

/** Минимум баров истории до первого сигнала (раздел 3, «Прогрев»). */
export function warmupBars(c: LbConfig) {
  return Math.max(c.trend_filter.high_lookback, c.trend_filter.sma_long + c.trend_filter.sma_long_rising_bars);
}
