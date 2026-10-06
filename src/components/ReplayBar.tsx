import { useState } from 'react';
import { bump, useSession, useTick } from '../store/session';
import { fastForward, getCheckpoints, pause, play, rewindTo, setSpeed, stepBars, stepCandle } from '../store/actions';
import { cx, Dropdown, Check } from './ui';
import { fmtNum, fmtTime, toDateInput, fromDateInput } from '../lib/format';
import { intervalDef } from '../data/intervals';
import { DAY, HOUR } from '../data/intervals';

const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 3000, 10000];

export function ReplayBar() {
  useTick();
  const ex = useSession((s) => s.ex)!;
  const playing = useSession((s) => s.playing);
  const speed = useSession((s) => s.speed);
  const chartTf = useSession((s) => s.chartTf);
  const prefs = useSession((s) => s.prefs);
  const setPrefs = useSession((s) => s.setPrefs);
  const [jump, setJump] = useState('');
  const total = ex.market.totalBars;
  const cur = ex.state.cursor;
  const frac = total ? cur / total : 0;
  const base = intervalDef(ex.config.baseInterval);
  const barsPerSecLabel = (s: number) => {
    const simMs = s * base.ms;
    if (simMs >= DAY) return `${(simMs / DAY).toFixed(simMs >= 10 * DAY ? 0 : 1)} дн/с`;
    if (simMs >= HOUR) return `${(simMs / HOUR).toFixed(simMs >= 10 * HOUR ? 0 : 1)} ч/с`;
    return `${Math.round(simMs / 60000)} мин/с`;
  };
  const onSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const target = ex.market.timeAt(Math.round(f * total));
    if (target > ex.now) fastForward(target);
  };
  return (
    <div className="h-11 flex items-center gap-3 px-4 border-b border-line bg-[#101116] shrink-0">
      <div className="flex items-center gap-1">
        <button
          className={cx('btn w-9 h-8 p-0 text-[15px]', playing ? 'btn-ghost' : 'btn-brand')}
          onClick={() => (playing ? pause() : play())}
          disabled={ex.state.finished}
          title="Старт / пауза (пробел)"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="btn btn-ghost h-8 px-2" onClick={() => stepBars(1)} disabled={ex.state.finished} title={`Шаг на 1 бар (${base.label}) — →`}>
          +1 бар
        </button>
        <button className="btn btn-ghost h-8 px-2" onClick={() => stepCandle()} disabled={ex.state.finished} title="До закрытия свечи графика — Shift+→">
          +1 свеча {intervalDef(chartTf).label}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">Скорость</span>
        <select
          className="bg-panel2 border border-line rounded-md h-8 px-2 outline-none num"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} бар/с · {barsPerSecLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col leading-tight min-w-[150px]">
        <span className="text-[10px] text-muted">Время симуляции (UTC)</span>
        <span className="num font-semibold text-[13px] text-brand">{fmtTime(ex.now)}</span>
      </div>
      <div className="flex-1 flex flex-col gap-1 min-w-[160px]">
        <div className="relative h-2 bg-panel3 rounded cursor-pointer group" onClick={onSeek} title="Клик — перемотка вперёд до выбранной точки">
          <div className="absolute inset-y-0 left-0 bg-brand/70 rounded" style={{ width: `${frac * 100}%` }} />
          <div className="absolute -top-0.5 w-3 h-3 rounded-full bg-brand border-2 border-bg" style={{ left: `calc(${frac * 100}% - 6px)` }} />
        </div>
        <div className="flex justify-between text-[10px] text-dim num">
          <span>{fmtTime(ex.market.start)}</span>
          <span>
            {fmtNum(cur, 0)} / {fmtNum(total, 0)} баров ({(frac * 100).toFixed(1)}%)
          </span>
          <span>{fmtTime(ex.market.end)}</span>
        </div>
      </div>
      <Dropdown align="right" width={300} button={<button className="btn btn-ghost h-8" title="Вернуться к контрольной точке">⏪ Назад</button>}>
        {(close: () => void) => (
          <div className="p-2 flex flex-col gap-1 max-h-[60vh] overflow-auto">
            <div className="text-muted text-[11px] px-1 pb-1">Контрольные точки создаются автоматически (каждые сутки/неделю, при ваших сделках, перед перемоткой).</div>
            {getCheckpoints()
              .slice()
              .reverse()
              .map((cp) => (
                <button
                  key={cp.cursor + cp.label}
                  className="text-left px-2 py-1.5 rounded hover:bg-panel3 flex justify-between gap-2"
                  onClick={() => {
                    close();
                    rewindTo(cp);
                  }}
                >
                  <span>
                    <span className="num">{fmtTime(cp.now)}</span> <span className="text-muted text-[11px]">{cp.label}</span>
                  </span>
                  <span className="num text-muted">{fmtNum(cp.equity, 0)}</span>
                </button>
              ))}
          </div>
        )}
      </Dropdown>
      <Dropdown
        align="right"
        width={280}
        button={<button className="btn btn-ghost h-8">⏩ Перейти к дате</button>}
      >
        <div className="p-3 flex flex-col gap-2">
          <div className="text-muted text-[11px]">Перемотка вперёд с обработкой всех ордеров и ботов</div>
          <input
            type="datetime-local"
            className="field w-full"
            value={jump || toDateInput(ex.now)}
            min={toDateInput(ex.now)}
            max={toDateInput(ex.market.end)}
            onChange={(e) => setJump(e.target.value)}
          />
          <div className="grid grid-cols-3 gap-1">
            {[
              ['+1ч', HOUR],
              ['+4ч', 4 * HOUR],
              ['+1д', DAY],
              ['+3д', 3 * DAY],
              ['+1нед', 7 * DAY],
              ['+1мес', 30 * DAY],
            ].map(([l, ms]) => (
              <button key={l as string} className="btn btn-sm" onClick={() => fastForward(ex.now + (ms as number))}>
                {l}
              </button>
            ))}
          </div>
          <button className="btn btn-brand" onClick={() => jump && fastForward(fromDateInput(jump))}>
            Перемотать
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => fastForward(ex.market.end)}>
            До конца периода
          </button>
        </div>
      </Dropdown>
      <Dropdown align="right" width={250} button={<button className="btn btn-ghost h-8 w-8 p-0" title="Настройки воспроизведения">⚙</button>}>
        <div className="p-3 flex flex-col gap-2">
          <Check checked={prefs.pauseOnFill} onChange={(v) => setPrefs({ pauseOnFill: v })}>
            Пауза при исполнении моего ордера
          </Check>
          <Check checked={prefs.pauseOnLiquidation} onChange={(v) => setPrefs({ pauseOnLiquidation: v })}>
            Пауза при ликвидации
          </Check>
          <Check
            checked={ex.config.fundingEnabled}
            onChange={(v) => {
              ex.config.fundingEnabled = v;
              bump(true);
            }}
          >
            <span title="Действует с текущего момента. Если funding был выключен при загрузке, используется ставка по умолчанию.">Учитывать funding (для этой сессии)</span>
          </Check>
          <Check checked={prefs.pauseOnAlert} onChange={(v) => setPrefs({ pauseOnAlert: v })}>
            Пауза (и стоп перемотки) при срабатывании алерта
          </Check>
          <Check checked={prefs.notifyRebalance} onChange={(v) => setPrefs({ notifyRebalance: v })}>
            Уведомления о ребалансировках ботов
          </Check>
          <Check checked={prefs.autosave} onChange={(v) => setPrefs({ autosave: v })}>
            Автосохранение раз в минуту
          </Check>
          <div className="text-[11px] text-dim pt-1 border-t border-line">
            Горячие клавиши: <span className="kbd">Пробел</span> — старт/пауза, <span className="kbd">→</span> — бар, <span className="kbd">Shift+→</span> — свеча, <span className="kbd">P</span> — все позиции. Правый клик по графику — алерт / цена в форму.
          </div>
        </div>
      </Dropdown>
    </div>
  );
}
