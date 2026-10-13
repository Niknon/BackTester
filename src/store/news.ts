import { create } from 'zustand';
import { getAsset } from '../data/assets';
import { DAY } from '../data/intervals';
import { cryptoEvents, fetchCorporate, fetchMacro, type NewsEvent } from '../data/news';
import type { NewsPrefs } from './session';

interface NewsState {
  events: NewsEvent[];
  /** ключ загруженного набора (символы, период, настройки) */
  key: string;
  loading: boolean;
  error: string | null;
}

export const useNews = create<NewsState>(() => ({ events: [], key: '', loading: false, error: null }));

const isCrypto = (symbol: string) => {
  try {
    return !getAsset(symbol).yahoo;
  } catch {
    return false;
  }
};

/** События, относящиеся к символу: макро — ко всем, корпоративные — к своей акции, крипто — к криптоактивам. */
export function eventsFor(events: NewsEvent[], symbol: string, p: NewsPrefs): NewsEvent[] {
  const crypto = isCrypto(symbol);
  return events.filter((e) =>
    e.kind === 'macro' ? p.macro : e.kind === 'crypto' ? p.crypto && crypto : p.corporate && e.symbol === symbol,
  );
}

let ctl: AbortController | null = null;

/** Загрузить события для сессии по настройкам (повторно не грузит тот же набор). */
export async function ensureNews(symbols: string[], from: number, to: number, p: NewsPrefs) {
  const stocks = symbols.filter((s) => !isCrypto(s)).sort();
  const key = JSON.stringify([stocks, Math.floor(from / DAY), Math.floor(to / DAY), p.macro && p.countries.slice().sort(), p.minImportance, p.corporate, p.crypto]);
  if (useNews.getState().key === key) return;
  ctl?.abort();
  const my = (ctl = new AbortController());
  useNews.setState({ key, loading: true, error: null });
  const errors: string[] = [];
  const tasks: Promise<NewsEvent[]>[] = [];
  if (p.macro && p.countries.length)
    tasks.push(
      fetchMacro(from, to, p.countries, p.minImportance, my.signal).catch((e) => {
        if (e?.name !== 'AbortError') errors.push(`экономический календарь: ${String(e?.message || e).slice(0, 80)}`);
        return [];
      }),
    );
  if (p.corporate)
    for (const s of stocks)
      tasks.push(
        fetchCorporate(s, from, to, my.signal).catch((e) => {
          if (e?.name !== 'AbortError') errors.push(`${s}: ${String(e?.message || e).slice(0, 60)}`);
          return [];
        }),
      );
  if (p.crypto) tasks.push(Promise.resolve(cryptoEvents(from, to)));
  const all = (await Promise.all(tasks)).flat();
  if (my.signal.aborted) return;
  const seen = new Set<string>();
  const events = all.filter((e) => Number.isFinite(e.t) && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.t - b.t);
  useNews.setState({ events, loading: false, error: errors.length ? `Не загрузились: ${errors.join('; ')}` : null });
}
