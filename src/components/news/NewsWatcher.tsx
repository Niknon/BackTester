import { useEffect, useRef } from 'react';
import { COUNTRY_LABEL, fmtValue, visibleAt, type NewsEvent } from '../../data/news';
import { pause, warmupStart } from '../../store/actions';
import { ensureNews, eventsFor, useNews } from '../../store/news';
import { toast, useSession, useTick } from '../../store/session';
import { fmtDuration } from '../../lib/format';
import { DAY } from '../../data/intervals';

/** Подпись значений: до выхода — прогноз и предыдущее, после — факт против прогноза. */
export function valuesLine(e: NewsEvent, released: boolean): string {
  if (e.kind !== 'macro' || (e.actual == null && e.forecast == null && e.previous == null)) return e.note ?? '';
  const parts = [];
  if (released && e.actual != null) parts.push(`факт ${fmtValue(e.actual, e)}`);
  if (e.forecast != null) parts.push(`прогноз ${fmtValue(e.forecast, e)}`);
  if (e.previous != null) parts.push(`пред. ${fmtValue(e.previous, e)}`);
  return parts.join(' · ');
}

export const eventLabel = (e: NewsEvent) => (e.country ? `${COUNTRY_LABEL[e.country] ?? e.country}: ${e.title}` : e.title);

/**
 * Фоновая работа с новостями: загрузка событий для символов сессии, уведомления о выходе важных
 * новостей во время воспроизведения и (по настройке) пауза за бар до них.
 */
export function NewsWatcher() {
  useTick();
  const ex = useSession((s) => s.ex);
  const status = useSession((s) => s.status);
  const prefs = useSession((s) => s.prefs.news);
  const events = useNews((s) => s.events);
  const symbols = ex?.config.symbols.join(',') ?? '';
  const cfgId = ex?.config.id;

  useEffect(() => {
    if (!ex || status !== 'ready' || !prefs.enabled) return;
    // с запасом вперёд: плановые события после конца сессии видны у её края
    ensureNews(ex.config.symbols, warmupStart(ex.config), ex.config.end + 60 * DAY, prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgId, symbols, status, prefs]);

  const prev = useRef<number | null>(null);
  const pausedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!ex) return;
    const now = ex.now;
    const from = prev.current;
    prev.current = now;
    if (!prefs.enabled || from === null || now <= from) return;
    const rel = relevant(events, ex.config.symbols, prefs).filter((e) => e.importance >= 2);
    // перемотка (скачок больше 48 баров) — не уведомляем о каждой пройденной новости
    const jumped = now - from > 48 * ex.market.dt;
    if (prefs.notify && !jumped) {
      const crossed = rel.filter((e) => e.t > from && e.t <= now);
      if (crossed.length && crossed.length <= 4)
        for (const e of crossed) toast('info', `📰 ${eventLabel(e)}`, valuesLine(e, true), 8000);
    }
    if (prefs.pauseBefore && useSession.getState().playing) {
      const bar = ex.market.dt;
      const next = rel.find((e) => e.t > now && e.t <= now + bar && visibleAt(e, now) && !pausedFor.current.has(e.id));
      if (next) {
        pausedFor.current.add(next.id);
        pause();
        toast('warn', `⏸ Через ${fmtDuration(next.t - now)}: ${eventLabel(next)}`, valuesLine(next, false) || 'Пауза перед важной новостью (настройка в меню «Новости» на графике)', 10000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  return null;
}

function relevant(events: NewsEvent[], symbols: string[], prefs: Parameters<typeof eventsFor>[2]) {
  const ids = new Set<string>();
  const out: NewsEvent[] = [];
  for (const s of symbols)
    for (const e of eventsFor(events, s, prefs))
      if (!ids.has(e.id)) {
        ids.add(e.id);
        out.push(e);
      }
  return out.sort((a, b) => a.t - b.t);
}
