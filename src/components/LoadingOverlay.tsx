import { useSession } from '../store/session';
import { cancelLoading } from '../store/actions';
import { ProgressBar, Spinner } from './ui';

export function LoadingOverlay() {
  const p = useSession((s) => s.progress);
  if (!p) return null;
  const failed = /Ошибка/.test(p.title);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
      <div className="panel border border-line2 w-[480px] p-6 flex flex-col gap-4 shadow-2xl">
        <div className="flex items-center gap-3">
          {!failed && <Spinner size={20} />}
          <div className={failed ? 'text-down font-semibold text-[15px]' : 'font-semibold text-[15px]'}>{p.title}</div>
        </div>
        {!failed && <ProgressBar value={p.total ? p.done / p.total : 0} />}
        <div className="text-muted text-[12px] break-words whitespace-pre-wrap max-h-40 overflow-auto">{p.message}</div>
        {p.errors.length > 0 && (
          <div className="text-[11px] text-brand/90 max-h-32 overflow-auto whitespace-pre-wrap border-t border-line pt-2">
            {p.errors.slice(-6).join('\n')}
          </div>
        )}
        <div className="flex justify-end">
          <button className="btn btn-ghost" onClick={cancelLoading}>
            {failed ? 'Закрыть' : 'Отмена'}
          </button>
        </div>
      </div>
    </div>
  );
}
