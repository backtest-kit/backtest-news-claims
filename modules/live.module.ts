import { addExchangeSchema, getCandlesFilled, getCandlesSampled, roundTicks } from "backtest-kit";
import { singleshot } from "functools-kit";
import ccxt from "ccxt";

const getExchange = singleshot(async () => {
  const exchange = new ccxt.binance({
    options: {
      defaultType: "spot",
      adjustForTimeDifference: true,
      recvWindow: 60000,
    },
    enableRateLimit: true,
  });
  await exchange.loadMarkets();
  return exchange;
});

addExchangeSchema({
  exchangeName: "ccxt-exchange",
  getCandles: async (symbol, interval, since, limit) => {
    const exchange = await getExchange();
    return await getCandlesSampled(
      (symbol, interval, since, limit) =>
        exchange.fetchOHLCV(symbol, interval, since, limit),
      { symbol, interval, since, limit },
    );
  },
});
