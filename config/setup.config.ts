import { setup } from "@backtest-kit/mongo";

import {
  Markdown,
  StorageLive,
  StorageBacktest,
  NotificationLive,
  NotificationBacktest,
  RecentLive,
  RecentBacktest,
  Dump,
  MemoryLive,
  MemoryBacktest,
  StateLive,
  StateBacktest,
  SessionLive,
  SessionBacktest,
  Log,
} from "backtest-kit";

import {
  PersistCandleAdapter,
  PersistSignalAdapter,
  PersistRiskAdapter,
  PersistScheduleAdapter,
  PersistStrategyAdapter,
  PersistPartialAdapter,
  PersistBreakevenAdapter,
  PersistStorageAdapter,
  PersistNotificationAdapter,
  PersistLogAdapter,
  PersistMeasureAdapter,
  PersistIntervalAdapter,
  PersistMemoryAdapter,
  PersistRecentAdapter,
  PersistStateAdapter,
  PersistBudgetAdapter,
  PersistDictionaryAdapter,
  PersistSessionAdapter,
} from "backtest-kit";


{
  Dump.useMarkdown();
}

{
  SessionLive.usePersist();
  SessionBacktest.useLocal();
}

{
  StorageLive.usePersist();
  StorageBacktest.useMemory();
}

{
  RecentLive.usePersist();
  RecentBacktest.useMemory();
}

{
  NotificationLive.usePersist();
  NotificationBacktest.useMemory();
}

{
  RecentLive.usePersist();
  RecentBacktest.useMemory();
}

{
  MemoryLive.usePersist();
  MemoryBacktest.useLocal();
}

{
  StateLive.usePersist();
  StateBacktest.useLocal();
}

{
  Markdown.useDummy();
  Log.useJsonl();
}

{
  PersistCandleAdapter.useJson();
  PersistSignalAdapter.useJson();
  PersistRiskAdapter.useJson();
  PersistScheduleAdapter.useJson();
  PersistStrategyAdapter.useJson();
  PersistPartialAdapter.useJson();
  PersistBreakevenAdapter.useJson();
  PersistStorageAdapter.useJson();
  PersistNotificationAdapter.useJson();
  PersistLogAdapter.useJson();
  PersistMeasureAdapter.useJson();
  PersistIntervalAdapter.useJson();
  PersistMemoryAdapter.useJson();
  PersistRecentAdapter.useJson();
  PersistStateAdapter.useJson();
  PersistBudgetAdapter.useJson();
  PersistDictionaryAdapter.useJson();
  PersistSessionAdapter.useJson();
}
