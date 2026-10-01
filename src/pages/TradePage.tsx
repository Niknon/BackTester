import { useEffect, useState } from 'react';
import { useResizable } from '../components/ui';
import type { Category } from '../engine/types';
import { useSession } from '../store/session';
import { TickerBar } from '../components/trade/TickerBar';
import { PriceChart } from '../components/chart/PriceChart';
import { OrderBook } from '../components/trade/OrderBook';
import { OrderForm } from '../components/trade/OrderForm';
import { SpotOrderForm } from '../components/trade/SpotOrderForm';
import { TradeBottomPanel } from '../components/trade/BottomPanel';

export function TradePage({ category }: { category: Category }) {
  const ex = useSession((s) => s.ex)!;
  const symbol = useSession((s) => s.symbol);
  const tf = useSession((s) => s.chartTf);
  const set = useSession((s) => s.set);
  const [clickPrice, setClickPrice] = useState<{ p: number; n: number }>();
  const { h, onDown } = useResizable(290, 140, 700, 'bt-bottom-h');
  const sym = ex.market.has(symbol) ? symbol : ex.market.symbols()[0];
  useEffect(() => {
    if (sym !== symbol) set({ symbol: sym });
  }, [sym, symbol, set]);
  const onSymbol = (s: string) => set({ symbol: s });
  const onPrice = (p: number) => setClickPrice((c) => ({ p, n: (c?.n ?? 0) + 1 }));
  return (
    <div className="h-full flex gap-1 p-1">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <TickerBar symbol={sym} onSymbol={onSymbol} spot={category === 'spot'} />
        <div className="flex-1 min-h-0 flex gap-1">
          <div className="flex-1 min-w-0">
            <PriceChart symbol={sym} tf={tf} onTfChange={(t) => set({ chartTf: t })} category={category} onPriceClick={onPrice} />
          </div>
          <div className="w-[270px] shrink-0">
            <OrderBook symbol={sym} onPrice={onPrice} />
          </div>
        </div>
        <div className="h-1 cursor-row-resize hover:bg-brand/40 rounded shrink-0" onMouseDown={onDown} title="Потяните, чтобы изменить высоту" />
        <div style={{ height: h }} className="shrink-0 min-h-0">
          <TradeBottomPanel category={category} symbol={sym} onSymbol={onSymbol} />
        </div>
      </div>
      <div className="w-[300px] shrink-0">
        {category === 'spot' ? <SpotOrderForm symbol={sym} price={clickPrice} /> : <OrderForm symbol={sym} price={clickPrice} />}
      </div>
    </div>
  );
}
