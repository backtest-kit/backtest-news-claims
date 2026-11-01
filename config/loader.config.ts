import {
  Launcher,
  listenError,
  Log,
  setConfig,
} from "backtest-kit";
import { errorData, getErrorMessage } from "functools-kit";

const ROOT_PATH_SYMBOL = Symbol.for("root_path");

setConfig({
  CC_LAUNCHER_CANDLE_CACHE_DEFAULT: false,
  CC_MAX_STOPLOSS_DISTANCE_PERCENT: 100,
});

Launcher.run();

Object.assign(globalThis, {
  [ROOT_PATH_SYMBOL]: process.cwd(),
});

listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});
