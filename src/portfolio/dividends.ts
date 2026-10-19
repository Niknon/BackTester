/**
 * Дивиденды акций Мосбиржи для корректировки цен (раздел 3 спецификации: цены с поправкой на сплиты и дивиденды).
 *
 * MOEX ISS перестал бесплатно отдавать историю дивидендов (в ответе /securities/{secid}/dividends нет таблицы),
 * поэтому источники идут цепочкой:
 *   1. MOEX ISS — если снова начнёт отдавать (или у пользователя есть доступ);
 *   2. dohod.ru — история с 2000-х, суммы уже пересчитаны на сплиты/консолидации (в тех же единицах, что и свечи ISS);
 *   3. smart-lab.ru — суммы у него в своих единицах (не всегда пересчитаны на консолидации), поэтому берём
 *      только долю дивиденда от цены того же дня.
 * День отсечки считается по правилам расчётов Мосбиржи (см. exDividendIndex). Проверка на свечах ISS 50 бумаг
 * за 2014–2026 гг.: гэп цены приходится на рассчитанный день в 96% выплат больше 2% цены (остальное — шум,
 * ценовые ограничения на открытии и ошибки источников). Колонка «дата T-1» со smart-lab давала худший результат
 * (до перехода на T+1 это не последний день покупки) и не используется.
 * Ответ (в том числе «дивидендов не было») кешируется в браузере на 7 дней.
 */
import { apiGet, apiGetText } from '../data/http';
import { idbGet, idbSet } from '../data/cache';

export interface MoexDividend {
  /** дата закрытия реестра, 00:00 UTC */
  t: number;
  /** сумма на акцию в единицах цен свечей (после сплитов) */
  value?: number;
  /** доля дивиденда от цены (если сумма — в других единицах) */
  yield?: number;
}

export type DivSource = 'iss' | 'dohod' | 'smartlab';

export const DIV_SOURCE_LABEL: Record<DivSource, string> = { iss: 'MOEX ISS', dohod: 'dohod.ru', smartlab: 'smart-lab.ru' };

export interface DivResult {
  source: DivSource;
  divs: MoexDividend[];
}

/* ───────────────────────── разбор HTML ───────────────────────── */

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', minus: '−' };

function decode(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const cellText = (html: string) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Строки таблицы: массив текстов ячеек (th и td). */
function tableRows(table: string): string[][] {
  const rows: string[][] = [];
  for (const m of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) rows.push([...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1])));
  return rows;
}

const tables = (html: string) => [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);

/** «20.07.2026» → 00:00 UTC; NaN, если даты нет. */
export function ruDate(s: string): number {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : NaN;
}

/** «37,64₽», «1 234,5» → число; NaN, если не число. */
export function ruNum(s: string): number {
  const t = s.replace(/[\s ₽%]/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Сложить выплаты с одной датой реестра (специальный + обычный дивиденд и т. п.). */
function mergeByDate(list: MoexDividend[]): MoexDividend[] {
  const by = new Map<number, MoexDividend>();
  for (const d of list) {
    const cur = by.get(d.t);
    if (!cur) by.set(d.t, { ...d });
    else {
      if (d.value !== undefined) cur.value = (cur.value ?? 0) + d.value;
      if (d.yield !== undefined) cur.yield = (cur.yield ?? 0) + d.yield;
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/**
 * dohod.ru: таблица «Дата объявления | Дата закрытия реестра | Год | Дивиденд».
 * Строки «(прогноз)» и нулевые пропускаются. null — таблицы на странице нет (другая вёрстка).
 */
export function parseDohod(html: string): MoexDividend[] | null {
  const table = tables(html).find((t) => /закрытия\s+реестра/i.test(t));
  if (!table) return null;
  const rows = tableRows(table);
  const head = rows.find((r) => r.some((c) => /закрытия реестра/i.test(c)));
  if (!head) return null;
  const iDate = head.findIndex((c) => /закрытия реестра/i.test(c));
  const iVal = head.findIndex((c) => /^дивиденд/i.test(c));
  if (iDate < 0 || iVal < 0) return null;
  const out: MoexDividend[] = [];
  for (const r of rows) {
    if (r === head || r.length <= Math.max(iDate, iVal)) continue;
    if (/прогноз/i.test(r[iDate])) continue;
    const t = ruDate(r[iDate]);
    const value = ruNum(r[iVal]);
    if (Number.isFinite(t) && value > 0) out.push({ t, value });
  }
  return mergeByDate(out);
}

/**
 * smart-lab.ru: таблица «Тикер | дата T-1 | дата отсечки | Период | дивиденд | Цена акции | Див.доходность».
 * Берутся дата отсечки (реестра) и доля дивиденда от цены.
 * В таблице бывают и обыкновенные, и привилегированные акции — берём строки нужного тикера.
 * [] — страница есть, но выплат нет («дивиденды не выплачивала»); null — непонятная вёрстка.
 */
export function parseSmartLab(html: string, ticker: string): MoexDividend[] | null {
  const table = tables(html).find((t) => /дата\s+отсечки/i.test(t));
  if (!table) return /дивиденд/i.test(html) && /не\s+выплач/i.test(html) ? [] : null;
  const rows = tableRows(table);
  const head = rows.find((r) => r.some((c) => /^тикер$/i.test(c)) && r.some((c) => /дата отсечки/i.test(c)));
  if (!head) return null;
  const ix = (re: RegExp) => head.findIndex((c) => re.test(c));
  const iT = ix(/^тикер$/i);
  const iDate = ix(/дата отсечки/i);
  const iDiv = ix(/^дивиденд$/i);
  const iPx = ix(/цена/i);
  if (iT < 0 || iDate < 0 || iDiv < 0 || iPx < 0) return null;
  const seen = new Set<number>();
  const out: MoexDividend[] = [];
  const want = ticker.toUpperCase();
  for (const r of rows) {
    if (r === head || r.length <= Math.max(iT, iDate, iDiv, iPx) || r[iT].toUpperCase() !== want) continue;
    const t = ruDate(r[iDate]);
    const d = ruNum(r[iDiv]);
    const px = ruNum(r[iPx]);
    // таблица на странице может повторяться (выплаченные / все) — без дублей
    if (!Number.isFinite(t) || !(d > 0) || !(px > 0) || seen.has(t)) continue;
    seen.add(t);
    out.push({ t, yield: d / px });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ───────────────────────── загрузка ───────────────────────── */

const MOEX = ['/proxy/moex', 'https://iss.moex.com'] as const;
/** ISS не дал таблицу дивидендов (нет её в ответе или запрос не прошёл) — до перезагрузки страницы его не спрашиваем. */
let issNoDividends = false;

async function fromIss(secid: string, signal?: AbortSignal): Promise<MoexDividend[] | null> {
  if (issNoDividends) return null;
  const json = await apiGet(MOEX[0], MOEX[1], `/iss/securities/${secid}/dividends.json`, { 'iss.meta': 'off', 'iss.only': 'dividends' }, signal, 0).catch((e) => {
    if (e?.name === 'AbortError') throw e;
    return null;
  });
  const d = json?.dividends;
  if (!d?.columns) {
    issNoDividends = true;
    return null;
  }
  const cols: string[] = d.columns;
  return mergeByDate(
    (d.data as any[][])
      .filter((r) => String(r[cols.indexOf('currencyid')] ?? 'RUB') === 'RUB')
      .map((r) => ({ t: Date.parse(String(r[cols.indexOf('registryclosedate')]) + 'T00:00:00Z'), value: Number(r[cols.indexOf('value')]) }))
      .filter((x) => Number.isFinite(x.t) && x.value > 0),
  );
}

async function fromDohod(secid: string, signal?: AbortSignal): Promise<MoexDividend[] | null> {
  const html = await apiGetText('/proxy/dohod', 'https://www.dohod.ru', `/ik/analytics/dividend/${encodeURIComponent(secid.toLowerCase())}`, signal);
  return html === null ? null : parseDohod(html);
}

async function fromSmartLab(secid: string, signal?: AbortSignal): Promise<MoexDividend[] | null> {
  const html = await apiGetText('/proxy/smartlab', 'https://smart-lab.ru', `/q/${encodeURIComponent(secid.toUpperCase())}/dividend/`, signal);
  return html === null ? null : parseSmartLab(html, secid);
}

interface CachedDivs extends DivResult {
  fetchedAt: number;
  v: number;
}

const TTL = 7 * 24 * 3600_000;
const CACHE_V = 2;

/**
 * Дивиденды бумаги: первый источник, который ответил. null — ни один источник не дал данных
 * (сайт недоступен или бумаги там нет). Ошибки сети не прерывают загрузку — пробуем следующий источник.
 */
export async function moexDividends(secid: string, signal?: AbortSignal, opts: { noCache?: boolean } = {}): Promise<DivResult | null> {
  const key = `lb|div|${secid}`;
  if (!opts.noCache) {
    const cached = await idbGet<CachedDivs>('meta', key);
    if (cached && cached.v === CACHE_V && Date.now() - cached.fetchedAt < TTL) return { source: cached.source, divs: cached.divs };
  }
  const chain: [DivSource, (s: string, sig?: AbortSignal) => Promise<MoexDividend[] | null>][] = [
    ['iss', fromIss],
    ['dohod', fromDohod],
    ['smartlab', fromSmartLab],
  ];
  for (const [source, fn] of chain) {
    let divs: MoexDividend[] | null = null;
    try {
      divs = await fn(secid, signal);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
    }
    if (divs) {
      await idbSet('meta', key, { source, divs, fetchedAt: Date.now(), v: CACHE_V } satisfies CachedDivs);
      return { source, divs };
    }
  }
  return null;
}

/* ───────────────────────── корректировка цен ───────────────────────── */

interface PriceRow {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Режимы расчётов на Мосбирже: T0 до 02.09.2013 (основной рынок), T+2 до 28.07.2023, T+1 с 31.07.2023. */
const T2_FROM = Date.UTC(2013, 8, 2);
const T1_FROM = Date.UTC(2023, 6, 31);

/** С 01.03.2025 Мосбиржа проводит торги в выходные, позже — и в часть праздников; расчёты по ним — в следующий расчётный день. */
const NON_SETTLEMENT_FROM = Date.UTC(2025, 2, 1);
/**
 * Праздники, в которые с 2025 г. идут торги без расчётов (1 мая 2026 г. — отсечка LKOH прошла в праздничную сессию).
 * Январские праздничные сессии на бирже — обычные расчётные дни (отсечка X5 06.01.2026 — точно в дату реестра).
 */
const HOLIDAY_SESSIONS = new Set(['02-23', '03-08', '05-01', '05-09', '06-12', '11-04']);

/** Расчётный день. До марта 2025 г. — любой день со свечами; после — пн–пт, кроме праздничных сессий. */
export function isSettlementDay(t: number): boolean {
  if (t < NON_SETTLEMENT_FROM) return true;
  const dt = new Date(t);
  const wd = dt.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !HOLIDAY_SESSIONS.has(dt.toISOString().slice(5, 10));
}

/**
 * Индекс первого бара без права на дивиденд (гэп отсечки).
 *  1. Последний день покупки по правилам расчётов от даты реестра R: B — последний расчётный день ≤ R;
 *     последний день покупки — за 1 (T+1, с 31.07.2023), 2 (T+2) или 0 (T0, до 02.09.2013) расчётных дня до B
 *     (праздники без торгов — дни без свечей — пропускаются сами).
 *  2. Отсечка — первая торговая сессия после него. Если до следующего расчётного дня есть сессии выходного
 *     или праздничного дня, порядок их расчётов менялся (в июле 2025 г. субботние сделки MTSS ещё шли с дивидендом,
 *     в июле 2026 г. у SBER/VTBR/TRNFP — уже без), поэтому из этих сессий берётся та, где гэп открытия вниз наибольший.
 * −1 — гэп вне данных (в том числе объявленные, но ещё не наступившие выплаты).
 */
export function exDividendIndex(rows: { t: number; o?: number; c?: number }[], d: MoexDividend): number {
  if (!rows.length || rows[rows.length - 1].t < d.t) return -1; // данные не доходят до даты реестра
  let k = -1;
  for (let i = 0; i < rows.length && rows[i].t <= d.t; i++) if (isSettlementDay(rows[i].t)) k = i;
  if (k < 0) return -1;
  for (let n = d.t >= T1_FROM ? 1 : d.t >= T2_FROM ? 2 : 0; n > 0; n--) {
    k--;
    while (k >= 0 && !isSettlementDay(rows[k].t)) k--;
    if (k < 0) return -1;
  }
  const first = k + 1;
  let end = first;
  while (end < rows.length && !isSettlementDay(rows[end].t)) end++;
  if (end >= rows.length) return -1; // следующий расчётный день ещё не наступил
  if (end === first) return first;
  let best = first;
  let bestGap = Infinity;
  for (let i = first; i <= end; i++) {
    const o = rows[i].o;
    const pc = rows[i - 1].c;
    if (o === undefined || pc === undefined || !(pc > 0)) return first;
    const g = o / pc - 1;
    if (g < bestGap - 1e-12) {
      bestGap = g;
      best = i;
    }
  }
  return best;
}

export interface DivAdjustStats {
  applied: number;
  /** выплаты, дающие неправдоподобную доходность (> 50% цены) — скорее всего, другие единицы; пропущены */
  suspicious: number;
}

/**
 * Корректировка на дивиденды (как adjclose у Yahoo): цены всех баров до гэпа отсечки × (1 − D / close накануне гэпа)
 * или × (1 − доходность), если источник дал долю от цены.
 */
export function adjustForDividends<R extends PriceRow>(rows: R[], divs: MoexDividend[], stats?: DivAdjustStats): R[] {
  const out = rows.map((r) => ({ ...r }));
  for (const d of divs) {
    const gap = exDividendIndex(out, d);
    if (gap < 1) continue;
    const y = d.yield ?? (d.value !== undefined && out[gap - 1].c > 0 ? d.value / out[gap - 1].c : NaN);
    if (!(y > 0)) continue;
    if (y > 0.5) {
      if (stats) stats.suspicious++;
      continue;
    }
    const f = 1 - y;
    for (let i = 0; i < gap; i++) {
      out[i].o *= f;
      out[i].h *= f;
      out[i].l *= f;
      out[i].c *= f;
    }
    if (stats) stats.applied++;
  }
  return out;
}
