import { useSession } from '../store/session';
import { fmtTime } from '../lib/format';
import { cx, Dropdown } from './ui';
import { COLOR, ICON } from './Toasts';

/** История уведомлений сессии: всплывающие окна исчезают, а здесь остаётся всё (до 300 записей). */
export function NoticeCenter() {
  const notices = useSession((s) => s.notices);
  const unread = useSession((s) => s.unread);
  return (
    <Dropdown
      align="right"
      width={420}
      button={
        <button
          className="btn btn-ghost btn-sm relative"
          title="История уведомлений: сделки, экспирации, ликвидации, боты"
          // открытая история заменяет всплывающие окна — убираем их, чтобы не перекрывали список
          onClick={() => useSession.setState({ unread: 0, toasts: [] })}
        >
          🔔
          {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-brand text-black text-[10px] font-bold leading-4 text-center">{unread > 99 ? '99+' : unread}</span>}
        </button>
      }
    >
      <div className="flex flex-col">
        <div className="flex items-center px-2 py-1.5 border-b border-line">
          <span className="font-semibold">Уведомления</span>
          <span className="text-[10px] text-muted ml-2">{notices.length}</span>
          {notices.length > 0 && (
            <button className="btn btn-sm btn-ghost ml-auto" onClick={() => useSession.setState({ notices: [], unread: 0 })}>
              Очистить
            </button>
          )}
        </div>
        <div className="max-h-[65vh] overflow-auto">
          {!notices.length && <div className="text-dim text-center py-8">Пока пусто</div>}
          {notices
            .slice()
            .reverse()
            .map((n) => (
              <div key={n.id} className={cx('flex gap-2 px-2 py-1.5 border-b border-line/50 border-l-2', COLOR[n.kind])}>
                <div className="w-4 text-center shrink-0 font-bold">{ICON[n.kind]}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex gap-2 items-baseline">
                    <span className="text-text font-semibold text-[12px] min-w-0">{n.title}</span>
                    <span className="ml-auto text-[10px] text-dim shrink-0 num">{n.simTime ? fmtTime(n.simTime) : ''}</span>
                  </div>
                  {n.text && <div className="text-muted text-[11px] whitespace-pre-line break-words">{n.text}</div>}
                </div>
              </div>
            ))}
        </div>
      </div>
    </Dropdown>
  );
}
