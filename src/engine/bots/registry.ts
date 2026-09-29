import type { BotLogic, BotType } from './types';
import { futuresGridLogic, spotGridLogic } from './grid';
import { comboLogic } from './combo';
import { dcaLogic } from './dca';
import { martingaleLogic } from './martingale';

export const BOT_LOGIC: { [K in BotType]: BotLogic<K> } = {
  spotGrid: spotGridLogic,
  futuresGrid: futuresGridLogic,
  futuresCombo: comboLogic,
  dca: dcaLogic,
  martingale: martingaleLogic,
};
