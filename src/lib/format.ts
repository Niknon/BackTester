import { decimalsOf, getAsset, spotQtyStep } from '../data/assets';

export function fmtNum(n: number | null | undefined, d = 2, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (opts.compact && Math.abs(n) >= 1e4) {
    const units: [number, string][] = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [v, s] of units) if (Math.abs(n) >= v) return (opts.sign && n > 0 ? '+' : '') + (n / v).toFixed(2) + s;
  }
  const s = n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return opts.sign && n > 0 ? '+' + s : s;
}

export function priceDecimals(symbol: string): number {
  return decimalsOf(getAsset(symbol).tickSize);
}

export function fmtPrice(p: number | null | undefined, symbol?: string, d?: number): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const dec = d ?? (symbol ? priceDecimals(symbol) : autoDecimals(p));
  return fmtNum(p, dec);
}

/** Минимальное число знаков, достаточное для точного отображения значения (страйки и т.п.). */
export function exactDecimals(v: number, max = 6): number {
  for (let d = 0; d < max; d++) {
    const k = v * 10 ** d;
    if (Math.abs(k - Math.round(k)) < 1e-6 * Math.max(1, Math.abs(k))) return d;
  }
  return max;
}

export function autoDecimals(p: number): number {
  const a = Math.abs(p);
  if (a >= 1000) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  if (a === 0) return 2;
  return Math.min(10, Math.ceil(-Math.log10(a)) + 3);
}

export function fmtQty(q: number | null | undefined, symbol?: string, category?: string): string {
  if (q === null || q === undefined || !Number.isFinite(q)) return '—';
  const d = symbol ? decimalsOf(category === 'spot' ? spotQtyStep(symbol) : getAsset(symbol).qtyStep) : 4;
  return fmtNum(q, d);
}

export function fmtUsd(n: number | null | undefined, d = 2, sign = false): string {
  return fmtNum(n, d, { sign });
}

export function fmtPct(n: number | null | undefined, d = 2, sign = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return fmtNum(n * 100, d, { sign }) + '%';
}

const pad = (x: number) => String(x).padStart(2, '0');

export function fmtTime(ms: number | null | undefined, withSeconds = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getUTCSeconds())}` : base;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function fmtShortDate(ms: number): string {
  const d = new Date(ms);
  const m = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${String(d.getUTCFullYear()).slice(2)}`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${mm}м`;
  return `${mm}м`;
}

export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 1e-12) return 'text-muted';
  return n > 0 ? 'text-up' : 'text-down';
}

export function toDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

export function fromDateInput(s: string): number {
  return Date.parse(s.length === 16 ? s + ':00Z' : s + 'T00:00:00Z');
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
