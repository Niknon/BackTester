/** HTTP-помощники: сначала локальный прокси (обход CORS), затем прямой запрос. */

export class HttpError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function qs(params: Record<string, string | number | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  return u.toString();
}

const proxyAvailable: Record<string, boolean | undefined> = {};

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Некорректный ответ: ${text.slice(0, 120)}`, res.status);
  }
}

/**
 * GET JSON с повторами. proxyPrefix — путь локального прокси (Vite / server.mjs),
 * directBase — прямой URL API (работает, если биржа отдаёт CORS-заголовки).
 */
export async function apiGet(
  proxyPrefix: string,
  directBase: string,
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
  retries = 4,
): Promise<any> {
  const query = qs(params);
  const isBrowser = typeof window !== 'undefined' && typeof location !== 'undefined';
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const useProxy = isBrowser && proxyAvailable[proxyPrefix] !== false;
    const url = useProxy ? `${proxyPrefix}${path}?${query}` : `${directBase}${path}?${query}`;
    try {
      const json = await fetchJson(url, signal);
      if (useProxy) proxyAvailable[proxyPrefix] = true;
      return json;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      lastErr = e;
      // прокси отсутствует (статический хостинг) — переключаемся на прямые запросы
      if (useProxy && proxyAvailable[proxyPrefix] === undefined && (e.status === 404 || e.status === 405 || e.status === 0)) {
        proxyAvailable[proxyPrefix] = false;
        continue;
      }
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 403) throw e;
      if (e instanceof HttpError && e.status === 403) throw e; // гео-блок и т.п. — повтор бесполезен
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Параллельное выполнение задач с ограничением конкуренции. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed = e;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export { sleep };
