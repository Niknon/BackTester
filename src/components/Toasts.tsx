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

export function Toasts() {
  const toasts = useSession((s) => s.toasts);
  return (
    <div className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2 w-[340px] pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className={cx('panel border-l-4 border border-line2 shadow-xl px-3 py-2 flex gap-3 pointer-events-auto', COLOR[t.kind])}>
          <div className="font-bold text-[14px] w-4 text-center">{ICON[t.kind]}</div>
          <div className="min-w-0">
            <div className="text-text font-semibold truncate">{t.title}</div>
            {t.text && <div className="text-muted text-[11px] break-words">{t.text}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
