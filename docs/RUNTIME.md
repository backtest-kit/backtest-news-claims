# agent-runtime: исполнение агентов

Как агенты из [AGENT.md](AGENT.md) обращаются к модели: что делает agent-runtime, как он запускается в проекте и как его вызывает код.

## 1. Что это

[agent-runtime](https://github.com/tripolskypetr/agent-runtime) это REST-сервис, который запускает AI-агента поверх Ollama. Запрос содержит сообщения, файлы и JSON-схему ответа. Сервис возвращает объект по этой схеме.

У агента четыре инструмента:

| Инструмент | Назначение |
|---|---|
| `provide_answer` | единственный способ закончить, аргументы проверяются по схеме |
| `bash` | команды в рабочей папке, в том числе `python3` и `jq` |
| `read_file` | чтение текстового файла из рабочей папки |
| `view_image` | показ картинки из рабочей папки модели с vision |

```mermaid
flowchart LR
    S["main.strategy.ts<br/>пинги, кэш, сделки"] --> A["classes/Agent.ts<br/>запрос и проверка ответа"]
    A -- "POST /api/v1/inference" --> R["agent-runtime<br/>цикл агента, проверка схемы"]
    R -- "сообщения и инструменты" --> O["Ollama"]
    O -- "вызовы инструментов" --> R
    R -- "объект по схеме или ошибка" --> A
```

За время, свечи и сделки отвечает backtest-kit, за модель, повторы и историю запросов отвечает agent-runtime.

## 2. Как устроен один инференс

1. Сервис очищает рабочую папку и записывает в неё файлы запроса и картинки из сообщений.
2. Агент работает с инструментами, пока не вызовет `provide_answer` с аргументами, подходящими под схему.
3. Если модель ответила текстом или аргументы не прошли проверку, она получает причину и пробует снова, в пределах `MAX_ATTEMPTS`.
4. Запрос, транскрипт и результат сохраняются в SQLite, рабочая папка очищается.

Инференсы выполняются строго по одному, остальные запросы ждут в очереди. Ответ приходит только после завершения агента.

Настройки по умолчанию:

| Переменная | Значение | Смысл |
|---|---|---|
| `MAX_ATTEMPTS` | 3 | повторы при неудачном ответе |
| `MAX_TURNS` | 120 | ходы модели на один инференс |
| `INFERENCE_TIMEOUT_MS` | 900000 | предел на один инференс |
| `BASH_TIMEOUT_SEC` | 120 | таймаут команды `bash` |
| `BODY_LIMIT_MB` | 256 | размер тела запроса |

Ошибки:

| Код | HTTP | Причина |
|---|---|---|
| `invalid_format` | 400 | схема не компилируется, инференс не запускался |
| `schema_mismatch` | 500 | за все попытки нет валидного ответа |
| `max_turns` | 500 | исчерпаны ходы модели |
| `timeout` | 500 | превышен `INFERENCE_TIMEOUT_MS` |
| `provider_error` | 500 | ошибка Ollama: ключ, модель или хост |
| `internal_error` | 500 | внутренняя ошибка сервиса |

## 3. Запуск в этом проекте

Конфигурация лежит в [docker/agent](../docker/agent/):

```bash
cd docker/agent
cp .env.example .env    # вписать OLLAMA_API_KEY
docker compose up -d
curl -s http://localhost:10050/api/v1/health | jq
```

| Переменная `.env` | Значение |
|---|---|
| `OLLAMA_HOST` | `https://ollama.com` |
| `OLLAMA_API_KEY` | ключ с https://ollama.com/settings/keys |
| `OLLAMA_MODEL` | `kimi-k2.7-code`, модель для кодинга с tools и vision |
| `OLLAMA_VISION` | `1`, картинки уходят модели |

Файл `.env` с ключом в git не попадает. Остальные настройки описаны в README agent-runtime, раздел Configuration.

Адреса после запуска:

| Адрес | Что там |
|---|---|
| http://localhost:10050/docs | Swagger |
| http://localhost:10050/admin | история инференсов, без пароля |
| http://localhost:10050/api/v1/health | модель и состояние очереди |

База лежит в `docker/agent/storage/agent-runtime.sqlite`, лог в `docker/agent/logs/debug.log`. Образ собран под `linux/amd64`, на Apple Silicon работает через эмуляцию.

## 4. Вызов из стратегии

Клиент это пакет [agent-runtime-sdk](https://www.npmjs.com/package/agent-runtime-sdk). Встроенный `fetch` обрывает запрос без ответа через 300 секунд, поэтому `classes/Agent.ts` передаёт ему dispatcher из `undici` без таймаутов. `undici` сейчас приходит транзитивно и в `package.json` не указан:

```bash
npm i undici@7.29.1 --save-exact
```

| Файл | Что в нём |
|---|---|
| [classes/Agent.ts](../classes/Agent.ts) | схемы ответов, запросы к модели, проверка ответов, `State` позиции |
| [content/sep_2026/main.strategy.ts](../content/sep_2026/main.strategy.ts) | `Cache.file`, пинги, открытие и закрытие позиции |
| [prompt/](../prompt/) | промпты агентов |

Состав запроса:

| Поле | Содержимое |
|---|---|
| `instructions` | промпт агента из `prompt/*.mustache` |
| `messages` | сообщения статьи с картинками, критерии, данные позиции |
| `files` | `candles_1d.csv`, `candles_1h.csv`, `candles_1m.csv` |
| `format` | схема ответа, литерал в `defineFormat` |

Модель в запросе не указывается, её задаёт `.env`.

`format` это JSON Schema draft 2020-12 с объектом на верхнем уровне. Ссылки `$ref` допустимы только локальные, вида `#/$defs/...`. Схема хранится литералом в `.ts`, чтобы тип ответа выводился из неё с точными значениями `enum`.

`generateObject` при ошибке бросает `AgentRuntimeError` с полями `code`, `details` и `inferenceId`. Исключение бросает и проверка ответа в `Agent.ts`. `Cache.file` сохраняет только успешный результат, поэтому такой вызов повторится на следующей проверке.

## 5. Особенности работы

**Кэш.** Ответы хранятся на диске через `Cache.file`, повторный прогон их не запрашивает.

| Агент | `name` | `interval` | Ключ |
|---|---|---|---|
| 1 | `agent1_v1` | `1d` | символ и id статьи |
| 2 | `agent2_v1` | `4h` | символ и выровненное время |
| 3 | `agent3_v1` | `4h` | символ, выровненное время и id сигнала |
| 4 | `agent4_v1` | `1d` | символ, id статьи и id сигнала |

После смены схемы, промпта агента или модели кэш удаляется вручную, иначе подмешаются старые ответы: папка агента в `dump/data/measure`. Чтобы сохранить кэш, скопируйте его в `./tmp`. `name` при этом не меняется.

**Частота.** Агент 2 вызывается раз в сутки, агент 3 раз в 4 часа: частоту задают `entryInterval` и `watchInterval` во frame. Агент 4 вызывается один раз на каждую новую статью при открытой позиции.

**Картинки.** При `OLLAMA_VISION=1` графики статьи уходят модели и увеличивают время ответа и расход токенов.

**Результаты.** Ответы агентов и сделки прогона лежат в `dump`, см. [DUMP.md](DUMP.md).

## 6. Диагностика

| Где | Что |
|---|---|
| http://localhost:10050/admin | транскрипт, запрос, вложения, ошибка по попыткам |
| `GET /api/v1/inferences/:id` | то же через API |
| `GET /api/v1/inferences?status=error` | неудачные инференсы |
| `docker/agent/logs/debug.log` | все события в JSON lines |
| `docker compose logs -f agent-runtime` | те же события в stdout |

Один инференс целиком:

```bash
grep '<inference id>' docker/agent/logs/debug.log | jq -c '.args'
```

## 7. Ссылки

- [agent-runtime](https://github.com/tripolskypetr/agent-runtime): API, настройки, логирование
- [agent-runtime-sdk](https://github.com/tripolskypetr/agent-runtime/tree/master/packages/sdk): клиент и вывод типов
- [AGENT.md](AGENT.md): агенты и план работ
- [DATASET.md](DATASET.md): источник статей
