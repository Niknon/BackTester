// Префиксы локального прокси → публичные API (обход CORS в браузере).
// Строка — адрес API; объект — адрес и заголовки, которые нужны конкретному источнику.
export const PROXY_TARGETS = {
  '/proxy/bybit': 'https://api.bybit.com',
  '/proxy/okx': 'https://www.okx.com',
  '/proxy/binance-fapi': 'https://fapi.binance.com',
  '/proxy/binance-spot': 'https://api.binance.com',
  '/proxy/moex': 'https://iss.moex.com',
  '/proxy/deribit': 'https://www.deribit.com',
  '/proxy/yahoo': 'https://query1.finance.yahoo.com',
  '/proxy/dukascopy': 'https://datafeed.dukascopy.com',
  // экономический календарь (тот же, что на графиках TradingView/Bybit) отвечает только своему сайту
  '/proxy/tvcal': { target: 'https://economic-calendar.tradingview.com', headers: { origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/' } },
  // SEC EDGAR: даты отчётов компаний (8-K, пункт 2.02); браузерный User-Agent SEC отклоняет
  '/proxy/sec': { target: 'https://data.sec.gov', headers: { 'user-agent': 'BackTester/0.1 (open-source backtesting app)' } },
  '/proxy/edgar-search': { target: 'https://efts.sec.gov', headers: { 'user-agent': 'BackTester/0.1 (open-source backtesting app)' } },
};

/** Адрес и дополнительные заголовки цели прокси. */
export function proxyTarget(value) {
  return typeof value === 'string' ? { target: value, headers: {} } : { target: value.target, headers: value.headers ?? {} };
}
