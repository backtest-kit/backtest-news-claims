# Dump: результаты прогона

`npm start -- --backtest --entry ./content/sep_2026/main.strategy.ts` работает из папки стратегии, поэтому все результаты пишет в `content/sep_2026/dump`. У каждого месяца своя папка `dump`. Она не попадает в git: в `.gitignore` есть правило `dump`.

## 1. Структура

```
dump/
├── report/                 отчёты о сделке
│   ├── backtest.jsonl      события позиции
│   ├── heat.jsonl          итог закрытых сделок
│   ├── highest_profit.jsonl  новые максимумы прибыли
│   ├── max_drawdown.jsonl  новые максимумы просадки
│   ├── partial.jsonl       пройденные уровни прибыли и убытка
│   └── breakeven.jsonl     достижение безубытка
├── log/
│   └── log.jsonl           ответы агентов из Log.info
└── data/
    ├── measure/            кэш ответов агентов
    │   ├── agent1_v1_1d_0/
    │   ├── agent2_v1_4h_1/
    │   └── agent3_v1_4h_2/
    ├── candle/ccxt-exchange/BTCUSDT/  кэш свечей
    │   ├── 1d/
    │   ├── 1h/
    │   └── 1m/
    └── storage/live/       сделки живого режима, в бэктесте пусто
```

## 2. Отчёты: `report/`

Каждая строка это JSON с общими полями `reportName`, `symbol`, `strategyName`, `exchangeName`, `frameName`, `signalId`, `timestamp` и событием в `data`.

### `backtest.jsonl`

Главный файл: одна строка `opened`, строки `active` на каждый пинг и одна строка `closed` на позицию.

| Поле `data` | Значение |
|---|---|
| `action` | `opened`, `active` или `closed` |
| `timestamp` | время события в мс, UTC |
| `position` | `long` или `short` |
| `priceOpen`, `priceStopLoss`, `priceTakeProfit` | цены позиции |
| `currentPrice` | цена на момент события |
| `note` | `description` агента 2 |
| `payload` | `articleId`, `criteria` и `answer` агента 2 |
| `pnl` | PnL в процентах |
| `pnlCost`, `pnlEntries` | PnL в USD и вложенная сумма |
| `peakProfitPercentage`, `maxDrawdownPercentage` | лучший и худший результат позиции в процентах |
| `closeReason` | только `closed`: `time_expired`, `take_profit`, `stop_loss`, `liquidation` или `closed` |
| `closeTime`, `duration` | только `closed`: время закрытия и длительность в минутах |

`closeReason: "closed"` означает закрытие через `commitClosePending`, то есть решением агента 3.

### Остальные отчёты

| Файл | Когда пишется строка |
|---|---|
| `heat.jsonl` | позиция закрыта |
| `highest_profit.jsonl` | позиция обновила максимум прибыли |
| `max_drawdown.jsonl` | позиция обновила максимум просадки |
| `partial.jsonl` | цена прошла уровень прибыли или убытка, поля `action` и `level` |
| `breakeven.jsonl` | цена дошла до безубытка |

## 3. Лог: `log/log.jsonl`

По одной строке на вызов `Log.info` из стратегии.

| Поле | Значение |
|---|---|
| `topic` | `agent1`, `agent2` или `agent3` |
| `args[0]` | решение агента и его `reasoning` |
| `createdAt` | время бэктеста, а не реальное время записи |
| `methodContext`, `executionContext` | стратегия, frame, символ, момент |

Это самый быстрый способ узнать, каких данных не хватает агентам.

## 4. Ответы агентов: `data/measure/`

Кэш `Cache.file`. Имя папки это `<name>_<interval>_<индекс>`. Один файл это один ответ модели:

```json
{ "id": "<имя файла>", "data": { "criteria": [], "description": "…", "reasoning": "…" }, "removed": false }
```

| Папка | Имя файла | `data` |
|---|---|---|
| `agent1_v1_1d_0` | `BTCUSDT_<id статьи>.json` | `criteria`, `description`, `reasoning` |
| `agent2_v1_4h_1` | `BTCUSDT_<время в мс>.json` | `criteria`, `action`, `description`, `reasoning` |
| `agent3_v1_4h_2` | `BTCUSDT_<время в мс>_<id сигнала>.json` | `criteria`, `action`, `description`, `reasoning` |

При повторном прогоне ответы берутся отсюда, запросов к модели нет. Чтобы получить новые ответы, удалите нужную папку или смените `name` в `Cache.file`.

## 5. Свечи: `data/candle/`

Кэш свечей биржи, чтобы не обращаться к Binance повторно. Один файл это одна свеча, имя файла это время открытия в мс:

```json
{ "timestamp": 1788220500000, "open": 78556.54, "high": 78556.54, "low": 78556.53, "close": 78556.54, "volume": 3.1608 }
```

Эта папка занимает почти весь размер `dump`. За сентябрь это 15 190 файлов и 59 МБ.

## 6. Как читать результат

Итог сделок:

```bash
cd content/sep_2026/dump
jq -c 'select(.data.action == "closed") | .data | {position, closeReason, pnl, openTime, closeTime}' report/backtest.jsonl
```

Что не хватало агентам:

```bash
jq -r '[.createdAt, .topic, .args[0]] | @tsv' log/log.jsonl
```

Найденные критерии:

```bash
jq -c '.data.criteria[]' data/measure/agent1_v1_1d_0/*.json
```
