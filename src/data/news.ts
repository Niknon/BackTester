import { apiGet, sleep } from './http';
import { DAY } from './intervals';
import { idbGet, idbSet } from './cache';
import { getAsset } from './assets';

/**
 * События на графике (как на Bybit/TradingView): экономический календарь, отчёты компаний,
 * дивиденды и сплиты, ключевые события крипторынка.
 * Без заглядывания в будущее: после текущего момента симуляции показываются только события,
 * известные заранее (календарь — без фактического значения), и только в пределах горизонта анонса.
 */
export type NewsKind = 'macro' | 'earnings' | 'dividend' | 'split' | 'crypto';

export interface NewsEvent {
  id: string;
  t: number;
  kind: NewsKind;
  title: string;
  /** исходное название (для макро — английское из календаря) */
  original?: string;
  country?: string;
  /** 2 — высокая важность, 1 — средняя, 0 — низкая */
  importance: 0 | 1 | 2;
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  unit?: string;
  scale?: string;
  period?: string;
  /** за сколько до события оно известно (анонс): плановые события видны «в будущем» в этих пределах */
  announceMs: number;
  /** для корпоративных событий — символ */
  symbol?: string;
  note?: string;
}

/* ───────────────────────── экономический календарь ───────────────────────── */

const RU: Record<string, string> = {
  'Non Farm Payrolls': 'Занятость вне с/х (NFP)',
  'Unemployment Rate': 'Уровень безработицы',
  'Inflation Rate YoY': 'Инфляция CPI, г/г',
  'Inflation Rate MoM': 'Инфляция CPI, м/м',
  'Core Inflation Rate YoY': 'Базовая инфляция CPI, г/г',
  'Core Inflation Rate MoM': 'Базовая инфляция CPI, м/м',
  'Fed Interest Rate Decision': 'Решение ФРС по ставке',
  'FOMC Minutes': 'Протокол заседания FOMC',
  'FOMC Economic Projections': 'Экономические прогнозы FOMC',
  'Fed Press Conference': 'Пресс-конференция ФРС',
  'Fed Chair Powell Speech': 'Выступление главы ФРС',
  'Fed Chair Powell Testimony': 'Показания главы ФРС в Конгрессе',
  'GDP Growth Rate QoQ': 'ВВП, кв/кв',
  'GDP Growth Rate YoY': 'ВВП, г/г',
  'GDP Growth Rate': 'ВВП',
  'PPI MoM': 'Цены производителей PPI, м/м',
  'PPI YoY': 'Цены производителей PPI, г/г',
  'Core PPI MoM': 'Базовые цены производителей PPI, м/м',
  'Retail Sales MoM': 'Розничные продажи, м/м',
  'Retail Sales YoY': 'Розничные продажи, г/г',
  'ISM Manufacturing PMI': 'ISM: промышленность (PMI)',
  'ISM Services PMI': 'ISM: сфера услуг (PMI)',
  'JOLTs Job Openings': 'Вакансии JOLTS',
  'Initial Jobless Claims': 'Первичные заявки на пособие',
  'ADP Employment Change': 'Занятость от ADP',
  'Core PCE Price Index MoM': 'Базовый индекс PCE, м/м',
  'Core PCE Price Index YoY': 'Базовый индекс PCE, г/г',
  'PCE Price Index MoM': 'Индекс PCE, м/м',
  'PCE Price Index YoY': 'Индекс PCE, г/г',
  'Michigan Consumer Sentiment': 'Настроения потребителей (Мичиган)',
  'CB Consumer Confidence': 'Доверие потребителей (Conference Board)',
  'Durable Goods Orders MoM': 'Заказы товаров длительного пользования, м/м',
  'Building Permits': 'Разрешения на строительство',
  'Housing Starts': 'Закладки новых домов',
  'Existing Home Sales': 'Продажи на вторичном рынке жилья',
  'New Home Sales': 'Продажи новых домов',
  'Personal Income MoM': 'Личные доходы, м/м',
  'Personal Spending MoM': 'Личные расходы, м/м',
  'Balance of Trade': 'Торговый баланс',
  'Average Hourly Earnings MoM': 'Средняя почасовая зарплата, м/м',
  'ECB Interest Rate Decision': 'Решение ЕЦБ по ставке',
  'ECB Press Conference': 'Пресс-конференция ЕЦБ',
  'BoE Interest Rate Decision': 'Решение Банка Англии по ставке',
  'BoJ Interest Rate Decision': 'Решение Банка Японии по ставке',
  'Loan Prime Rate 1Y': 'Базовая ставка LPR, 1 год',
  'Loan Prime Rate 5Y': 'Базовая ставка LPR, 5 лет',
  'NBS Manufacturing PMI': 'PMI промышленности (NBS)',
};

const SUFFIX: [RegExp, string][] = [
  [/ Prel$/, ' (предв.)'],
  [/ Final$/, ' (оконч.)'],
  [/ Adv$/, ' (предв.)'],
  [/ 2nd Est$/, ' (2-я оценка)'],
  [/ 3rd Est$/, ' (3-я оценка)'],
];

export function translateIndicator(title: string): string {
  let base = title;
  let suffix = '';
  for (const [re, s] of SUFFIX)
    if (re.test(base)) {
      base = base.replace(re, '');
      suffix = s;
      break;
    }
  const ru = RU[base];
  return ru ? ru + suffix : title;
}

export const COUNTRY_LABEL: Record<string, string> = { US: 'США', EU: 'Еврозона', GB: 'Великобритания', JP: 'Япония', CN: 'Китай' };

interface TvEvent {
  id: string;
  title: string;
  country: string;
  importance: number;
  date: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unit?: string;
  scale?: string;
  period?: string;
  comment?: string;
}

const tvToEvent = (e: TvEvent): NewsEvent => ({
  id: `m${e.id}`,
  t: Date.parse(e.date),
  kind: 'macro',
  title: translateIndicator(e.title),
  original: e.title,
  country: e.country,
  importance: e.importance >= 1 ? 2 : e.importance === 0 ? 1 : 0,
  actual: e.actual,
  forecast: e.forecast,
  previous: e.previous,
  unit: e.unit ?? undefined,
  scale: e.scale ?? undefined,
  period: e.period || undefined,
  // календарь публикуется заранее: дата релиза известна за недели
  announceMs: 60 * DAY,
});

/**
 * Экономический календарь за период — поквартально (до 2000 событий за запрос), с паузой между
 * запросами (источник ограничивает частоту) и кэшем завершённых кварталов. Если какой-то квартал
 * не загрузился, остальные всё равно показываются (failed — число пропущенных кварталов).
 */
export async function fetchMacro(from: number, to: number, countries: string[], minImportance: 0 | 1, signal?: AbortSignal): Promise<NewsEvent[] & { failed?: number }> {
  const out: NewsEvent[] & { failed?: number } = [];
  if (!countries.length) return out;
  const cs = [...countries].sort().join(',');
  const d0 = new Date(from);
  let failed = 0;
  let lastErr: unknown = null;
  let requested = false;
  for (let y = d0.getUTCFullYear(), m = Math.floor(d0.getUTCMonth() / 3) * 3; Date.UTC(y, m, 1) < to; m === 9 ? (y++, (m = 0)) : (m += 3)) {
    const a = Date.UTC(y, m, 1);
    const b = Date.UTC(y, m + 3, 1);
    const key = `news|macroq|${cs}|${minImportance}|${a}`;
    let rows = await idbGet<NewsEvent[]>('meta', key);
    if (!rows) {
      if (requested) await sleep(400);
      requested = true;
      try {
        const json = await apiGet(
          '/proxy/tvcal',
          'https://economic-calendar.tradingview.com',
          '/events',
          { from: new Date(a).toISOString(), to: new Date(b).toISOString(), countries: cs, minImportance: minImportance === 1 ? 1 : 0 },
          signal,
          2,
        );
        rows = ((json?.result ?? []) as TvEvent[]).filter((e) => Number.isFinite(Date.parse(e.date))).map(tvToEvent);
        // прошедший квартал не изменится — кэшируем (у будущих событий ещё появятся факты)
        if (b < Date.now() - 2 * DAY) await idbSet('meta', key, rows);
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        failed++;
        lastErr = e;
        continue;
      }
    }
    out.push(...rows);
  }
  if (failed && !out.length) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  if (failed) out.failed = failed;
  return out;
}

/* ───────────────────────── отчёты, дивиденды, сплиты ───────────────────────── */

/** Дивиденды и сплиты — из Yahoo (событийный ряд графика). */
async function fetchDivSplits(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<NewsEvent[]> {
  const spec = getAsset(symbol);
  if (!spec.yahoo) return [];
  const json = await apiGet(
    '/proxy/yahoo',
    'https://query1.finance.yahoo.com',
    `/v8/finance/chart/${encodeURIComponent(spec.yahoo)}`,
    { period1: Math.floor(from / 1000), period2: Math.ceil(to / 1000), interval: '1mo', events: 'div,split' },
    signal,
  );
  const ev = json?.chart?.result?.[0]?.events ?? {};
  const out: NewsEvent[] = [];
  for (const d of Object.values(ev.dividends ?? {}) as { amount: number; date: number }[])
    out.push({ id: `d${symbol}${d.date}`, t: d.date * 1000, kind: 'dividend', title: `Дивиденд ${d.amount} $ (экс-дата)`, importance: 1, announceMs: 30 * DAY, symbol, note: 'Цена акции в день экс-дивиденда обычно снижается примерно на размер дивиденда' });
  for (const s of Object.values(ev.splits ?? {}) as { date: number; numerator: number; denominator: number }[])
    out.push({ id: `s${symbol}${s.date}`, t: s.date * 1000, kind: 'split', title: `Сплит ${s.numerator}:${s.denominator}`, importance: 2, announceMs: 30 * DAY, symbol, note: 'Цены истории скорректированы на сплит' });
  return out;
}

/** CIK компании в SEC EDGAR по тикеру. */
async function secCik(ticker: string, signal?: AbortSignal): Promise<string | null> {
  const key = `news|cik|${ticker}`;
  const cached = await idbGet<string>('meta', key);
  if (cached !== undefined) return cached || null;
  const json = await apiGet('/proxy/edgar-search', 'https://efts.sec.gov', '/LATEST/search-index', { keysTyped: ticker }, signal);
  const hit = (json?.hits?.hits ?? []).find((h: any) => String(h?._source?.tickers ?? '').split(/[,\s]+/).includes(ticker));
  const cik = hit ? String(hit._id).padStart(10, '0') : '';
  await idbSet('meta', key, cik);
  return cik || null;
}

interface SecFilings {
  acceptanceDateTime: string[];
  form: string[];
  items: string[];
  primaryDocument?: string[];
}

/**
 * Иностранные эмитенты (Shopify и др.) публикуют квартальные результаты формой 6-K без номеров пунктов.
 * Узнаём такие по имени основного документа: «q42015pressrelease.htm», «q320166kwrapper.htm», «…-results…».
 */
const RESULTS_6K = /(^|[^a-z0-9])q[1-4]|quarter|results|earnings/i;
/** …но не итоги голосования и материалы собрания акционеров */
const NOT_RESULTS_6K = /vot|agm|meeting|circular|proxy/i;

/** Подача в SEC с квартальными результатами: 8-K п. 2.02 или 6-K иностранного эмитента с отчётом о результатах. */
export function isResultsFiling(form: string, items: string, doc: string): boolean {
  if (form === '8-K') return /(^|,)2\.02(,|$)/.test(items);
  if (form === '6-K') return RESULTS_6K.test(doc) && !NOT_RESULTS_6K.test(doc);
  return false;
}

/** Отчёты о прибыли: 8-K с пунктом 2.02 «Results of Operations» — публикуется в день релиза. */
async function fetchEarnings(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<NewsEvent[]> {
  const spec = getAsset(symbol);
  if (!spec.yahoo || spec.sector === 'etf' || spec.sector === 'index' || spec.sector === 'commodity') return [];
  const ticker = spec.yahoo.replace(/=F$|^\^/, '');
  const cik = await secCik(ticker, signal);
  if (!cik) return [];
  const key = `news|sec2|${cik}`;
  let cached = await idbGet<{ fetchedAt: number; rows: { t: number; at: number }[] }>('meta', key);
  // список подач обновляем раз в сутки (появляются новые отчёты)
  if (!cached || Date.now() - cached.fetchedAt > DAY) {
    const json = await apiGet('/proxy/sec', 'https://data.sec.gov', `/submissions/CIK${cik}.json`, {}, signal);
    const lists: SecFilings[] = [json?.filings?.recent].filter(Boolean);
    // старые подачи — в дополнительных файлах (нужны только для давних периодов)
    for (const f of (json?.filings?.files ?? []) as { name: string; filingTo: string }[]) {
      if (Date.parse(f.filingTo) < from) continue;
      const extra = await apiGet('/proxy/sec', 'https://data.sec.gov', `/submissions/${f.name}`, {}, signal).catch(() => null);
      if (extra) lists.push(extra);
    }
    const rows: { t: number; at: number }[] = [];
    for (const l of lists)
      for (let i = 0; i < (l.form?.length ?? 0); i++) {
        if (!isResultsFiling(l.form[i], l.items[i] ?? '', l.primaryDocument?.[i] ?? '')) continue;
        const at = Date.parse(l.acceptanceDateTime[i]);
        if (Number.isFinite(at)) rows.push({ t: earningsTime(at), at });
      }
    cached = { fetchedAt: Date.now(), rows };
    await idbSet('meta', key, cached);
  }
  const rows = cached.rows;
  const seen = new Set<number>();
  return rows
    .filter((r) => r.t >= from && r.t < to && !seen.has(Math.floor(r.t / DAY)) && seen.add(Math.floor(r.t / DAY)))
    .map((r) => {
      const amc = new Date(r.t).getUTCHours() >= 17;
      return {
        id: `e${symbol}${r.t}`,
        t: r.t,
        kind: 'earnings' as const,
        title: `Отчёт ${spec.base} ${amc ? 'после закрытия' : 'до открытия'}`,
        importance: 2 as const,
        // даты отчётов компании объявляют за 2–4 недели
        announceMs: 21 * DAY,
        symbol,
        note: 'Квартальные результаты (8-K, п. 2.02 в SEC EDGAR). Реакция цены — на пре/постмаркете и на открытии.',
      };
    });
}

/** Время выхода отчётов о прибыли (UTC) в [from, to) — для модели опционов. Пусто — не акция или нет в SEC. */
export async function fetchReportTimes(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<number[]> {
  return (await fetchEarnings(symbol, from, to, signal)).map((e) => e.t);
}

/**
 * Время отчёта по времени подачи 8-K: до полудня по Нью-Йорку — «до открытия» (13:30 UTC),
 * позже — «после закрытия» (20:00 UTC) того же нью-йоркского дня.
 */
export function earningsTime(accepted: number): number {
  const ny = accepted - 4 * 3600_000; // летнее время; зимой сдвиг на час не меняет дату
  const day = Math.floor(ny / DAY) * DAY;
  const hour = new Date(ny).getUTCHours();
  return hour < 12 ? day + 13.5 * 3600_000 : day + 20 * 3600_000;
}

export async function fetchCorporate(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<NewsEvent[]> {
  const [a, b] = await Promise.all([
    fetchDivSplits(symbol, from, to, signal).catch(() => [] as NewsEvent[]),
    fetchEarnings(symbol, from, to, signal).catch(() => [] as NewsEvent[]),
  ]);
  return [...a, ...b];
}

/* ───────────────────────── крипторынок ───────────────────────── */

const H = 3600_000;
const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d) + h * H;

/**
 * Ключевые события крипторынка. scheduled — дата была известна заранее (халвинг, обновление сети,
 * старт торгов ETF, выборы): такие видны и «в будущем»; внезапные — только после того, как случились.
 */
const CRYPTO: { t: number; title: string; scheduled?: boolean; imp?: 1 | 2; note?: string }[] = [
  { t: at(2020, 3, 12, 12), title: '«Чёрный четверг»: обвал рынков из-за COVID-19', note: 'BTC −40% за сутки' },
  { t: at(2020, 5, 11, 19), title: 'Халвинг Bitcoin №3', scheduled: true, note: 'Награда за блок 12.5 → 6.25 BTC' },
  { t: at(2020, 8, 11, 12), title: 'MicroStrategy покупает BTC в резерв', imp: 1 },
  { t: at(2020, 10, 21, 12), title: 'PayPal запускает поддержку криптовалют', imp: 1 },
  { t: at(2020, 12, 22, 21), title: 'SEC подаёт иск против Ripple (XRP)' },
  { t: at(2021, 2, 8, 13), title: 'Tesla купила BTC на $1,5 млрд' },
  { t: at(2021, 4, 14, 13), title: 'Листинг Coinbase на Nasdaq', scheduled: true, imp: 1 },
  { t: at(2021, 5, 12, 22), title: 'Tesla прекращает приём BTC' },
  { t: at(2021, 5, 19, 12), title: 'Обвал крипторынка после запретов Китая' },
  { t: at(2021, 9, 7, 0), title: 'Сальвадор: BTC — законное платёжное средство', scheduled: true, imp: 1 },
  { t: at(2021, 10, 19, 13), title: 'Старт первого фьючерсного BTC-ETF в США (BITO)', scheduled: true },
  { t: at(2022, 5, 9, 12), title: 'Крах Terra: отвязка UST, обвал LUNA' },
  { t: at(2022, 6, 13, 0), title: 'Celsius замораживает вывод средств' },
  { t: at(2022, 9, 15, 6), title: 'The Merge: Ethereum переходит на PoS', scheduled: true },
  { t: at(2022, 11, 8, 16), title: 'Кризис FTX: Binance объявляет о сделке, вывод средств остановлен' },
  { t: at(2022, 11, 11, 15), title: 'FTX подаёт на банкротство' },
  { t: at(2023, 3, 10, 14), title: 'Крах Silicon Valley Bank' },
  { t: at(2023, 3, 11, 3), title: 'USDC теряет привязку к доллару' },
  { t: at(2023, 4, 12, 22), title: 'Обновление Ethereum Shapella (вывод стейкинга)', scheduled: true, imp: 1 },
  { t: at(2023, 6, 5, 17), title: 'SEC подаёт иск против Binance' },
  { t: at(2023, 6, 6, 14), title: 'SEC подаёт иск против Coinbase' },
  { t: at(2023, 6, 15, 20), title: 'BlackRock подаёт заявку на спотовый BTC-ETF' },
  { t: at(2023, 7, 13, 16), title: 'Ripple частично выигрывает суд у SEC' },
  { t: at(2023, 8, 29, 14), title: 'Grayscale выигрывает суд у SEC по BTC-ETF' },
  { t: at(2023, 11, 21, 18), title: 'Binance и CZ урегулируют дело с Минюстом США', imp: 1 },
  { t: at(2024, 1, 10, 21), title: 'SEC одобряет спотовые BTC-ETF', scheduled: true, note: 'Крайний срок решения по заявке ARK/21Shares был известен заранее' },
  { t: at(2024, 1, 11, 14), title: 'Старт торгов спотовыми BTC-ETF', scheduled: true },
  { t: at(2024, 3, 13, 13), title: 'Обновление Ethereum Dencun', scheduled: true, imp: 1 },
  { t: at(2024, 4, 20, 0), title: 'Халвинг Bitcoin №4', scheduled: true, note: 'Награда за блок 6.25 → 3.125 BTC' },
  { t: at(2024, 5, 23, 20), title: 'SEC одобряет заявки на спотовые ETH-ETF', scheduled: true },
  { t: at(2024, 7, 23, 13), title: 'Старт торгов спотовыми ETH-ETF', scheduled: true },
  { t: at(2024, 8, 5, 0), title: 'Обвал рынков: разворот керри-трейда в иене' },
  { t: at(2024, 11, 6, 4), title: 'Выборы президента США: победа Трампа', scheduled: true },
  { t: at(2024, 12, 5, 3), title: 'BTC впервые выше $100 000', imp: 1 },
  { t: at(2025, 1, 20, 17), title: 'Инаугурация президента США', scheduled: true, imp: 1 },
  { t: at(2025, 2, 21, 14), title: 'Взлом Bybit: украдено ~$1,5 млрд в ETH' },
  { t: at(2025, 3, 6, 23), title: 'Указ о создании Стратегического резерва BTC США' },
  { t: at(2025, 4, 2, 20), title: '«День освобождения»: США объявляют пошлины' },
  { t: at(2025, 4, 9, 17), title: 'США откладывают пошлины на 90 дней' },
  { t: at(2025, 5, 7, 10), title: 'Обновление Ethereum Pectra', scheduled: true, imp: 1 },
  { t: at(2025, 7, 18, 19), title: 'Подписан закон GENIUS о стейблкоинах', imp: 1 },
  { t: at(2025, 10, 10, 21), title: 'Обвал крипторынка: рекордные ликвидации (~$19 млрд)' },
];

export function cryptoEvents(from: number, to: number): NewsEvent[] {
  return CRYPTO.filter((e) => e.t >= from && e.t < to).map((e) => ({
    id: `c${e.t}`,
    t: e.t,
    kind: 'crypto' as const,
    title: e.title,
    importance: e.imp ?? 2,
    announceMs: e.scheduled ? 60 * DAY : 0,
    note: e.note,
  }));
}

/** Видно ли событие в момент симуляции now (без заглядывания вперёд). */
export function visibleAt(e: NewsEvent, now: number): boolean {
  return e.t <= now || e.t - e.announceMs <= now;
}

/** Значения показателя: факт только после выхода (до этого — прогноз и предыдущее). */
export function fmtValue(v: number | null | undefined, e: NewsEvent): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Number(v.toPrecision(6))}${e.scale ?? ''}${e.unit ?? ''}`;
}
