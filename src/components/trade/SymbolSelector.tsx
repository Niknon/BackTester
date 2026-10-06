import { getAsset, kindLabel } from '../../data/assets';
import { useTick } from '../../store/session';
import { Dropdown } from '../ui';
import { SymbolList } from '../SymbolList';

export function SymbolSelector({
  symbol,
  onSelect,
  optionsOnly,
  spot,
}: {
  symbol: string;
  onSelect: (s: string) => void;
  optionsOnly?: boolean;
  /** спотовый рынок: доступны xStocks и токены золота; иначе — только перпетуалы */
  spot?: boolean;
}) {
  useTick();
  const spec = getAsset(symbol);
  return (
    <Dropdown
      width={420}
      button={
        <button className="flex items-center gap-2 hover:bg-panel3 rounded-md px-2 py-1">
          <span className="w-6 h-6 rounded-full bg-brand/20 text-brand text-[10px] font-bold flex items-center justify-center">{spec.base.slice(0, 3)}</span>
          <div className="text-left leading-tight">
            <div className="font-bold text-[15px]">{symbol}</div>
            <div className="text-[10px] text-muted">{spot && !spec.spotOnly ? 'Спот' : kindLabel(spec)} · {spec.name}</div>
          </div>
          <span className="text-muted">▾</span>
        </button>
      }
    >
      {(close: () => void) => <SymbolList value={symbol} onPick={onSelect} close={close} spot={spot} optionsOnly={optionsOnly} storeKey={spot ? 'spot' : 'perp'} />}
    </Dropdown>
  );
}
