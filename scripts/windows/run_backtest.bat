@echo off
rem Полный прогон всех месяцев бэктеста хронологически. Запуск из корня репо:
rem   scripts\windows\run_backtest.bat
rem Без остановки при сбое: упавший месяц не прерывает остальные, ответы агентов остаются в кэше месяца.

call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jan_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\feb_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\mar_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\apr_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\may_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jun_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jul_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\aug_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\sep_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\oct_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\nov_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\dec_2025\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jan_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\feb_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\mar_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\apr_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\may_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jun_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\jul_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\aug_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\sep_2026\main.strategy.ts
call node .\node_modules\@backtest-kit\cli\build\index.mjs --backtest --entry .\content\oct_2026\main.strategy.ts

echo === run_backtest: jan_2025..oct_2026 прогнан ===
