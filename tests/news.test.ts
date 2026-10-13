import { describe, expect, it } from 'vitest';
import { cryptoEvents, earningsTime, translateIndicator, visibleAt, type NewsEvent } from '../src/data/news';
import { eventsFor } from '../src/store/news';
import { DEFAULT_NEWS } from '../src/store/session';

const DAY = 86400000;
const ev = (p: Partial<NewsEvent>): NewsEvent => ({ id: 'x', t: 0, kind: 'macro', title: '', importance: 2, announceMs: 60 * DAY, ...p });

describe('Новости на графике', () => {
  it('названия показателей переводятся, с пометкой предварительных/окончательных', () => {
    expect(translateIndicator('Inflation Rate YoY')).toBe('Инфляция CPI, г/г');
    expect(translateIndicator('Fed Interest Rate Decision')).toBe('Решение ФРС по ставке');
    expect(translateIndicator('Michigan Consumer Sentiment Prel')).toBe('Настроения потребителей (Мичиган) (предв.)');
    expect(translateIndicator('Some New Indicator')).toBe('Some New Indicator');
  });

  it('без заглядывания в будущее: плановые события видны заранее, внезапные — только после', () => {
    const now = Date.UTC(2024, 0, 1);
    expect(visibleAt(ev({ t: now - DAY }), now)).toBe(true);
    expect(visibleAt(ev({ t: now + 10 * DAY }), now)).toBe(true); // календарь — за 60 дней
    expect(visibleAt(ev({ t: now + 90 * DAY }), now)).toBe(false);
    const ftx = cryptoEvents(Date.UTC(2022, 10, 1), Date.UTC(2022, 10, 30)).find((e) => /банкротство/.test(e.title))!;
    expect(visibleAt(ftx, ftx.t - 3600_000)).toBe(false); // крах FTX заранее не известен
    expect(visibleAt(ftx, ftx.t)).toBe(true);
    const halving = cryptoEvents(Date.UTC(2024, 3, 1), Date.UTC(2024, 3, 30)).find((e) => /Халвинг/.test(e.title))!;
    expect(visibleAt(halving, halving.t - 20 * DAY)).toBe(true); // халвинг известен заранее
  });

  it('события по символам: макро — всем, крипто — криптоактивам, отчёты — своей акции', () => {
    const list = [ev({ id: 'm', kind: 'macro' }), ev({ id: 'c', kind: 'crypto' }), ev({ id: 'e', kind: 'earnings', symbol: 'AAPLUSDT' })];
    expect(eventsFor(list, 'BTCUSDT', DEFAULT_NEWS).map((e) => e.id)).toEqual(['m', 'c']);
    expect(eventsFor(list, 'AAPLUSDT', DEFAULT_NEWS).map((e) => e.id)).toEqual(['m', 'e']);
    expect(eventsFor(list, 'AAPLUSDT', { ...DEFAULT_NEWS, macro: false }).map((e) => e.id)).toEqual(['e']);
  });

  it('время отчёта: после закрытия — вечером того же дня, до открытия — утром', () => {
    // AAPL: 8-K принят 01.08.2025 00:30 UTC (вечер 31.07 по Нью-Йорку) — отчёт после закрытия 31.07
    expect(new Date(earningsTime(Date.parse('2025-08-01T00:30:25Z'))).toISOString()).toBe('2025-07-31T20:00:00.000Z');
    // банк публикует отчёт утром до открытия
    expect(new Date(earningsTime(Date.parse('2025-07-15T10:45:00Z'))).toISOString()).toBe('2025-07-15T13:30:00.000Z');
  });
});
