import { waitForInit } from "@backtest-kit/mongo";
import {
  Launcher,
  listenError,
  Log,
  setConfig,
} from "backtest-kit";
import { errorData, getErrorMessage } from "functools-kit";

Launcher.run();

setConfig({
  CC_LAUNCHER_CANDLE_CACHE_DEFAULT: false,
});

listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});

export default async () => {
  await waitForInit();
}
