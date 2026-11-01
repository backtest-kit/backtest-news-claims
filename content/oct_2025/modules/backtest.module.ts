import { addExchangeSchema, addFrameSchema, getCandlesFilled } from "backtest-kit";
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
    return await getCandlesFilled(
      (symbol, interval, since, limit) =>
        exchange.fetchOHLCV(symbol, interval, since, limit),
      { symbol, interval, since, limit },
    );
  },
});

addFrameSchema({
  frameName: "oct_2025_frame",
  entryInterval: "1d",
  watchInterval: "4h",
  startDate: new Date("2025-10-01T00:00:00Z"),
  endDate: new Date("2025-11-01T23:59:59Z"),
  note: "OCT 2025 (+1 день на добор 24h-траекторий)",
});
