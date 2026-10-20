import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY } from '../src/data/intervals';
import { DUKA_MINUTE_DAYS, dukascopyProvider } from '../src/data/providers/dukascopy';

/** Подменённая сеть: запоминает запрошенные файлы, отвечает по сценарию. */
function stubFetch(answer: (url: string, n: number) => number) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    const status = answer(url, urls.length);
    return new Response(status === 200 ? new Uint8Array(0) : 'x', { status });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Dukascopy: какие файлы запрашиваются', () => {
  it('часовые свечи — по файлу на месяц', async () => {
    const urls = stubFetch(() => 404);
    await dukascopyProvider.fetchKlines('AAPLUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2023, 0, 1));
    expect(urls.length).toBe(12);
    expect(urls.every((u) => u.endsWith('BID_candles_hour_1.bi5'))).toBe(true);
  });

  it('меньше часа: минутные файлы только за последние дни, раньше — месячные часовые', async () => {
    const urls = stubFetch(() => 404);
    const today = Math.floor(Date.now() / DAY) * DAY;
    // два года 30-минутных свечей: раньше было ~620 дневных файлов
    await dukascopyProvider.fetchKlines('AAPLUSDT', '30m', today - 730 * DAY, today - 60 * DAY);
    const minute = urls.filter((u) => u.endsWith('BID_candles_min_1.bi5'));
    const hour = urls.filter((u) => u.endsWith('BID_candles_hour_1.bi5'));
    expect(minute.length).toBeLessThanOrEqual(DUKA_MINUTE_DAYS - 60);
    expect(minute.length).toBeGreaterThan(30);
    expect(hour.length).toBeGreaterThan(15);
    expect(hour.length).toBeLessThan(25);
  });

  it('отказ сервера (503) — повтор того же файла, а не пропуск', async () => {
    let fails = 2;
    const urls = stubFetch((u) => (u.includes('/2022/00/') && fails-- > 0 ? 503 : 404));
    const res = await dukascopyProvider.fetchKlines('MSFTUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2022, 2, 1));
    expect(urls.filter((u) => u.includes('/2022/00/')).length).toBe(3);
    expect(res.partial ?? 0).toBe(0);
  }, 30_000);
});

describe('Dukascopy: пауза после отказа — общая для всех запросов', () => {
  it('после 503 ни один запрос не уходит, пока пауза не кончилась', async () => {
    const times: number[] = [];
    let refusedAt = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      const now = Date.now();
      times.push(now);
      // первый запрос — отказ, остальные — пусто (404)
      if (times.length === 1) {
        refusedAt = now;
        await new Promise((r) => setTimeout(r, 50));
        return new Response('x', { status: 503 });
      }
      void url;
      return new Response('x', { status: 404 });
    });
    await dukascopyProvider.fetchKlines('AMZNUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2022, 6, 1));
    // запросы, отправленные параллельно с отказавшим (до его ответа), допустимы; после ответа — только по истечении паузы
    const after = times.filter((t) => t > refusedAt + 60);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after) - (refusedAt + 50)).toBeGreaterThanOrEqual(1300); // 2 с × (0.7…1.3)
  }, 30_000);
});

describe('Dukascopy: кэш по файлам', () => {
  it('скачанные файлы не запрашиваются повторно, недостающие — докачиваются', async () => {
    vi.resetModules();
    const store = new Map<string, unknown>();
    vi.doMock('../src/data/cache', () => ({
      idbGet: async (_s: string, k: string) => store.get(k),
      idbSet: async (_s: string, k: string, v: unknown) => void store.set(k, v),
    }));
    const { dukascopyProvider: p } = await import('../src/data/providers/dukascopy');
    // первая загрузка: 6 месячных файлов
    const urls = stubFetch(() => 404);
    await p.fetchKlines('NVDAUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2022, 6, 1));
    expect(urls.length).toBe(6);
    // повторная загрузка того же периода — ни одного запроса
    const again = stubFetch(() => 404);
    await p.fetchKlines('NVDAUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2022, 6, 1));
    expect(again.length).toBe(0);
    // расширили период — запрашиваются только новые месяцы
    const more = stubFetch(() => 404);
    await p.fetchKlines('NVDAUSDT', '1h', Date.UTC(2022, 0, 1), Date.UTC(2022, 8, 1));
    expect(more.length).toBe(2);
    vi.doUnmock('../src/data/cache');
  });
});
