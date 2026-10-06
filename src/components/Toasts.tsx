import { useSession } from '../store/session';
import { cx } from './ui';

const ICON: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  warn: '!',
  error: '✕',
  buy: '▲',
  sell: '▼',
};

const COLOR: Record<string, string> = {
  info: 'border-info/50 text-info',
  success: 'border-up/50 text-up',
  warn: 'border-brand/60 text-brand',
  error: 'border-down/60 text-down',
  buy: 'border-up/50 text-up',
  sell: 'border-down/50 text-down',
};

/**
 * Уведомления: не больше трёх сразу, сверху по центру под панелью времени —
 * не закрывают форму ордера и таблицу позиций. Клик — закрыть.
 */
export function Toasts() {
  const toasts = useSession((s) => s.toasts);
  const shown = toasts.slice(-3);
  const dismiss = (id: number) => useSession.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-[98px] z-[60] flex flex-col gap-1.5 w-[380px] max-w-[92vw] pointer-events-none">
      {shown.map((t) => (
        <div
          key={t.id}
          className={cx('panel border-l-4 border border-line2 shadow-xl px-3 py-1.5 flex gap-2.5 pointer-events-auto cursor-pointer bg-panel2/95', COLOR[t.kind])}
          onClick={() => dismiss(t.id)}
          title="Нажмите, чтобы закрыть"
        >
          <div className="font-bold text-[13px] w-4 text-center shrink-0">{ICON[t.kind]}</div>
          <div className="min-w-0">
            <div className="text-text font-semibold truncate text-[12px]">{t.title}</div>
            {t.text && <div className="text-muted text-[11px] break-words line-clamp-2">{t.text}</div>}
          </div>
        </div>
      ))}
      {toasts.length > 3 && <div className="text-center text-[10px] text-dim">ещё {toasts.length - 3}…</div>}
    </div>
  );
}
