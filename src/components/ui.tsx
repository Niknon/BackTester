import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ');
}

/* ───────── числовое поле ───────── */

export function NumInput({
  value,
  onChange,
  label,
  suffix,
  placeholder,
  step,
  min,
  max,
  className,
  disabled,
  autoFocus,
}: {
  value: number | '' | null | undefined;
  onChange: (v: number | '') => void;
  label?: ReactNode;
  suffix?: ReactNode;
  placeholder?: string;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value === '' || value === null || value === undefined ? '' : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setText(value === '' || value === null || value === undefined || !Number.isFinite(value) ? '' : String(Number(Number(value).toPrecision(12))));
  }, [value]);
  return (
    <label className={cx('field', disabled && 'opacity-50', className)}>
      {label !== undefined && <span className="lbl">{label}</span>}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (value !== '' && value !== null && value !== undefined && Number.isFinite(value)) setText(String(Number(Number(value).toPrecision(12))));
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(',', '.').replace(/[^0-9.\-e]/g, '');
          setText(raw);
          if (raw === '' || raw === '-' || raw === '.') return onChange('');
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onKeyDown={(e) => {
          if (!step || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          const cur = typeof value === 'number' && Number.isFinite(value) ? value : 0;
          let n = cur + (e.key === 'ArrowUp' ? step : -step);
          if (min !== undefined) n = Math.max(min, n);
          if (max !== undefined) n = Math.min(max, n);
          n = Number(n.toPrecision(12));
          setText(String(n));
          onChange(n);
        }}
        className="text-right"
      />
      {suffix !== undefined && <span className="lbl">{suffix}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: ReactNode;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      {label !== undefined && <span className="lbl">{label}</span>}
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label?: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      {label !== undefined && <span className="lbl">{label}</span>}
      <select
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {typeof o.label === 'string' ? o.label : String(o.value)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check({ checked, onChange, children, className }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; className?: string }) {
  return (
    <label className={cx('inline-flex items-center gap-2 cursor-pointer select-none', className)}>
      <input type="checkbox" className="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; className?: string; disabled?: boolean }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cx('flex bg-panel2 rounded-md p-0.5 gap-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-[5px] transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-default',
            size === 'sm' ? 'h-6 text-[11px] px-2' : 'h-7 px-3',
            value === o.value ? cx('bg-panel3 text-text font-semibold', o.className) : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
  right,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={cx('flex items-center border-b border-line px-3 overflow-x-auto', className)}>
      {tabs.map((t) => (
        <div key={t.value} className={cx('tab', value === t.value && 'active')} onClick={() => onChange(t.value)}>
          {t.label}
        </div>
      ))}
      {right && <div className="ml-auto flex items-center gap-2 pl-4">{right}</div>}
    </div>
  );
}

/* ───────── слайдер процентов ───────── */

export function PercentSlider({ value, onChange, marks = [0, 25, 50, 75, 100] }: { value: number; onChange: (v: number) => void; marks?: number[] }) {
  return (
    <div className="py-1">
      <input type="range" className="range" min={0} max={100} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex justify-between text-[10px] text-dim mt-1">
        {marks.map((m) => (
          <button key={m} type="button" className={cx('hover:text-text', value >= m && 'text-muted')} onClick={() => onChange(m)}>
            {m}%
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────── модальное окно ───────── */

export function Modal({ open, onClose, title, children, width = 420 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="panel border border-line2 shadow-2xl max-h-[90vh] overflow-auto" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="text-[15px] font-semibold">{title}</div>
          <button className="text-muted hover:text-text text-lg leading-none" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

/* ───────── прочее ───────── */

export function Stat({ label, value, className, sub }: { label: ReactNode; value: ReactNode; className?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted text-[11px] whitespace-nowrap">{label}</div>
      <div className={cx('num font-semibold truncate', className)}>{value}</div>
      {sub !== undefined && <div className="text-[11px] text-dim num">{sub}</div>}
    </div>
  );
}

export function Row({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[3px]">
      <span className="text-muted">{label}</span>
      <span className={cx('num text-right', className)}>{value}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center justify-center py-10 text-dim gap-2 text-center">{children}</div>;
}

export function Badge({ children, color = 'muted' }: { children: ReactNode; color?: 'up' | 'down' | 'brand' | 'muted' | 'info' | 'violet' }) {
  const map = {
    up: 'bg-up/15 text-up',
    down: 'bg-down/15 text-down',
    brand: 'bg-brand/15 text-brand',
    muted: 'bg-panel3 text-muted',
    info: 'bg-info/15 text-info',
    violet: 'bg-violet/15 text-violet',
  };
  return <span className={cx('inline-flex items-center px-1.5 h-[18px] rounded text-[10px] font-semibold', map[color])}>{children}</span>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 bg-panel3 rounded overflow-hidden">
      <div className="h-full bg-brand transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Sparkline({ data, width = 120, height = 32, color }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * width).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`);
  const c = color ?? (data[data.length - 1] >= data[0] ? 'var(--color-up)' : 'var(--color-down)');
  return (
    <svg width={width} height={height} className="block">
      <polyline points={pts.join(' ')} fill="none" stroke={c} strokeWidth="1.5" />
    </svg>
  );
}

export function Help({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-dim text-dim text-[9px] cursor-help ml-1" title={text}>
      ?
    </span>
  );
}

/** Уголок-меню (выпадающий список) */
export function Dropdown({
  button,
  children,
  align = 'left',
  width = 220,
}: {
  button: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open]);
  // позиционирование fixed — меню не обрезается контейнерами с прокруткой
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(width, window.innerWidth - 16);
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    if (below < 260 && above > below) setPos({ left, top: -1, maxH: Math.min(above, window.innerHeight * 0.75) });
    else setPos({ left, top: r.bottom + 4, maxH: Math.min(below, window.innerHeight * 0.75) });
  };
  return (
    <div className="relative" ref={ref}>
      <div
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
      >
        {button}
      </div>
      {open && pos && (
        <div
          className="fixed z-50 panel border border-line2 shadow-xl p-1 overflow-auto"
          style={{
            width: Math.min(width, window.innerWidth - 16),
            left: pos.left,
            ...(pos.top < 0 ? { bottom: window.innerHeight - (ref.current?.getBoundingClientRect().top ?? 0) + 4 } : { top: pos.top }),
            maxHeight: pos.maxH,
          }}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

/** Вертикальный разделитель с перетаскиванием (высота нижней панели). */
/** invert: true — панель сверху (тянем вниз — растёт). */
export function useResizable(initial: number, min: number, max: number, key: string, invert = false) {
  const [h, setH] = useState<number>(() => Number(localStorage.getItem(key)) || initial);
  const drag = useRef<{ y: number; h: number } | null>(null);
  useEffect(() => {
    const mv = (e: MouseEvent) => {
      if (!drag.current) return;
      const dy = e.clientY - drag.current.y;
      const nh = Math.max(min, Math.min(max, drag.current.h + (invert ? dy : -dy)));
      setH(nh);
    };
    const up = () => {
      if (drag.current) localStorage.setItem(key, String(h));
      drag.current = null;
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
  }, [h, min, max, key, invert]);
  const onDown = (e: React.MouseEvent) => {
    drag.current = { y: e.clientY, h };
    e.preventDefault();
  };
  return { h, onDown };
}


/**
 * Состояние, запоминаемое между сессиями (localStorage).
 * Возвращает [значение, установить и запомнить, установить без запоминания].
 */
export function usePersistent<T>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw) as T;
      if (allowed && !allowed.includes(parsed)) return initial;
      if (typeof parsed !== typeof initial) return initial;
      return parsed;
    } catch {
      return initial;
    }
  });
  const save = useCallback(
    (x: T) => {
      setV(x);
      try {
        localStorage.setItem(key, JSON.stringify(x));
      } catch {
        /* приватный режим — просто не запоминаем */
      }
    },
    [key],
  );
  return [v, save, setV];
}
