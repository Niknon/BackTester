import { COUNTRY_LABEL } from '../../data/news';
import { useNews } from '../../store/news';
import { useSession, type NewsPrefs } from '../../store/session';
import { Check, cx, Dropdown } from '../ui';

/** Кнопка «Новости» на панели графика: включение слоя событий и его настройки. */
export function NewsMenu() {
  const prefs = useSession((s) => s.prefs.news);
  const setPrefs = useSession((s) => s.setPrefs);
  const loading = useNews((s) => s.loading);
  const error = useNews((s) => s.error);
  const count = useNews((s) => s.events.length);
  const set = (p: Partial<NewsPrefs>) => setPrefs({ news: { ...prefs, ...p } });
  const toggleCountry = (c: string) => set({ countries: prefs.countries.includes(c) ? prefs.countries.filter((x) => x !== c) : [...prefs.countries, c] });
  return (
    <div className="flex items-center">
      <button
        className={cx('chip !rounded-r-none', prefs.enabled && 'active')}
        title={prefs.enabled ? 'Скрыть новости и события на графике' : 'Показать новости и события на графике'}
        onClick={() => set({ enabled: !prefs.enabled })}
      >
        📰<span className="hidden 2xl:inline ml-1">Новости</span>
        {prefs.enabled && loading ? '…' : ''}
      </button>
      <Dropdown width={290} align="right" button={<button className="chip !rounded-l-none !px-1.5 border-l border-line" title="Настройки новостей">▾</button>}>
        <div className="p-2 flex flex-col gap-2 text-[12px]">
          <Check checked={prefs.enabled} onChange={(x) => set({ enabled: x })}>
            Показывать события на графике
          </Check>
          <div className="text-[10px] text-dim -mt-1 leading-snug">
            Прошедшие — со значениями «факт / прогноз», будущие — только известные заранее (без подсказок из будущего).
          </div>
          <div className="h-px bg-line" />
          <Check checked={prefs.macro} onChange={(x) => set({ macro: x })}>
            Экономический календарь
          </Check>
          {prefs.macro && (
            <div className="pl-5 flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-1">
                {Object.entries(COUNTRY_LABEL).map(([c, l]) => (
                  <button key={c} className={cx('chip border border-line2 !px-1.5 text-[11px]', prefs.countries.includes(c) && 'active')} onClick={() => toggleCountry(c)} title={l}>
                    {c}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <button className={cx('chip border border-line2 flex-1 text-[11px]', prefs.minImportance === 1 && 'active')} onClick={() => set({ minImportance: 1 })}>
                  Только важные
                </button>
                <button className={cx('chip border border-line2 flex-1 text-[11px]', prefs.minImportance === 0 && 'active')} onClick={() => set({ minImportance: 0 })}>
                  + средние
                </button>
              </div>
            </div>
          )}
          <Check checked={prefs.corporate} onChange={(x) => set({ corporate: x })}>
            Отчёты, дивиденды, сплиты (акции)
          </Check>
          <Check checked={prefs.crypto} onChange={(x) => set({ crypto: x })}>
            Ключевые события крипторынка
          </Check>
          <div className="h-px bg-line" />
          <Check checked={prefs.notify} onChange={(x) => set({ notify: x })}>
            Уведомлять о выходе важных новостей
          </Check>
          <Check checked={prefs.pauseBefore} onChange={(x) => set({ pauseBefore: x })}>
            Пауза за бар до важной новости
          </Check>
          <div className="text-[10px] text-dim">
            {loading ? 'Загрузка событий…' : `Загружено событий: ${count}`}
            {error && <div className="text-down mt-0.5">{error}</div>}
          </div>
          <div className="text-[10px] text-dim leading-snug">Источники: экономический календарь TradingView, SEC EDGAR (даты отчётов), Yahoo Finance (дивиденды, сплиты).</div>
        </div>
      </Dropdown>
    </div>
  );
}
