# agent-runtime: исполнение агентов

Документ описывает, что такое agent-runtime, как он поднимается в этом проекте
(`docker/agent/`) и как стратегия backtest-kit отдаёт ему данные и получает
ответ. Логика самих агентов описана в [AGENT.md](AGENT.md), источник данных в
[DATASET.md](DATASET.md).

## 1. Что это

[agent-runtime](https://github.com/tripolskypetr/agent-runtime) это REST-харнесс
для AI-агента на базе [pi](https://github.com/earendil-works/pi) поверх Ollama.
Один HTTP-запрос содержит переписку (текст и картинки), набор файлов и
JSON-схему ответа. Сервис запускает агента с тремя инструментами в изолированной
рабочей папке, добивается от модели ответа строго по схеме и возвращает объект.
Это серверный аналог пары `generateObject` / `generateText` из json-inference,
которой пользуется референсная стратегия `crypto_yoda_channel`.

| Инструмент агента | Назначение |
|---|---|
| `provide_answer` | Единственный способ закончить. Параметры инструмента это схема `format` из запроса, аргументы валидируются |
| `bash` | Shell в рабочей папке: `python3`, `jq`, ImageMagick, таймаут 120 с, обрезка вывода |
| `view_image` | Показать картинку из рабочей папки vision-модели |

Зачем он в этом проекте. По AGENT.md конвейер состоит из трёх агентов, каждый
обязан вернуть JSON по схеме и имеет право на расчёты. Агент получает полный
текст обзора и его графики, то есть ровно запись `wwwroot.jsonl`. Формат
`messages` в запросе agent-runtime совпадает с форматом записи датасета
(`role`, `content`, `images` в base64), поэтому результат `Dataset.getArticle(when)`
передаётся в запрос без преобразований.

Разделение ролей:

```
backtest-kit                         agent-runtime                   Ollama
──────────────                       ─────────────                   ──────
getSignal(symbol, when)
  │ Dataset.getArticle(when)
  │   → { messages }
  ▼
agent-runtime-sdk
generateObject({ messages,  ──────►  POST /api/v1/inference
                 format,              воркспейс ← файлы, картинки
                 instructions })      системный промпт + схема
                                      цикл агента ─────────────────► gemma4:31b-cloud
                                        bash / view_image ◄─────────── tool calls
                                        provide_answer → валидация
                                      SQLite: транскрипт, вложения
  ◄──────────────────────────────── 200 { data } | 500 { error }
решение стратегии
```

backtest-kit отвечает за время (`when`), свечи, отсутствие look ahead и
кэширование. agent-runtime отвечает за инференс: модель, повторы, валидацию,
историю. Стратегия не знает ни про Ollama, ни про tool calling.

## 2. Как устроен один инференс

Последовательность из `src/agent/runInference.ts`:

1. **Рабочая папка** (`DATA_DIR`, в контейнере `/app/data`) очищается. В неё
   пишутся `files` из запроса и картинки из сообщений как
   `images/message_<i>_<j>.<ext>`.
2. **Сообщения.** `user` идут модели как есть; при `OLLAMA_VISION=1` картинки
   прикладываются к сообщению, иначе остаются только файлами в папке.
   `system` сообщения сворачиваются в дополнительные инструкции системного
   промпта. `assistant` вставляется как синтетический ответ модели. Если
   последнее сообщение не от `user`, добавляется «Proceed with the task.».
3. **Системный промпт** рендерится из `assets/system.mustache`: путь к папке,
   список файлов и картинок, схема ответа, правила, поле `instructions` из
   запроса как раздел «Additional instructions».
4. **Цикл агента.** Модель вызывает инструменты, пока не вызовет
   `provide_answer` с валидными аргументами. Инструментальные вызовы после
   принятого ответа блокируются.
5. **Повторы.** Если попытка закончилась без принятого ответа, в ту же
   переписку добавляется требование вызвать `provide_answer` и модель
   спрашивается снова, до `MAX_ATTEMPTS` раз. При отказе валидатора в деталях
   остаётся причина (например `sentiment: expected one of [...]`).
6. **Сохранение.** Файлы, созданные агентом, транскрипт, картинки, запрос и
   результат пишутся в SQLite. Папка очищается.

Коды ошибок (HTTP 500, тело `{ status: "error", error: { code, message, details } }`):

| Код | Когда | Что делать |
|---|---|---|
| `schema_mismatch` | за `MAX_ATTEMPTS` попыток не было валидного `provide_answer` | уточнить `description` полей, проверить `enum`, упростить схему, посмотреть транскрипт |
| `max_turns` | модель сделала `MAX_TURNS` вызовов без ответа | модель зациклилась на `bash`; сократить задачу или запретить расчёты в инструкциях |
| `timeout` | превышен `INFERENCE_TIMEOUT_MS` | медленная модель или длинная задача |
| `provider_error` | Ollama вернула ошибку | ключ, имя модели, хост |
| `empty_answer` | только `/text`: модель закончила без текста | |
| `internal_error` | исключение харнесса | смотреть `logs/debug.log` |

Лимиты по умолчанию: три попытки, сорок ходов модели, 15 минут на инференс,
120 секунд на одну bash-команду, 256 МБ на тело запроса.

**Очередь.** Рабочая папка одна, поэтому инференсы исполняются строго по
одному. Параллельные запросы ждут своей очереди, ответ приходит после
завершения. `GET /api/v1/health` показывает `running` и `queued`.

**Длинные ответы.** Ответ отправляется только по завершении агента, это может
занять минуты. Встроенный `fetch` в Node обрывает запрос без заголовков ответа
через 300 секунд, поэтому клиенту нужен `undici` dispatcher без таймаутов
(см. раздел 4). Сам сервер таймаута на запрос не имеет.

## 3. Запуск в этом проекте

Конфигурация лежит в [docker/agent](../docker/agent/):

| Файл | Назначение |
|---|---|
| `docker-compose.yaml` | образ `tripolskypetr/agent-runtime:latest`, порт 10050, тома `./storage` и `./logs`, healthcheck |
| `.env.example` | шаблон переменных: `OLLAMA_HOST`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_VISION` |
| `.env` | рабочие значения с ключом, в git не попадает |

```bash
cd docker/agent
cp .env.example .env          # вписать OLLAMA_API_KEY с https://ollama.com/settings/keys
docker compose up -d
curl -s http://localhost:10050/api/v1/health | jq
```

После старта доступны Swagger `http://localhost:10050/docs`, админка с историей
инференсов `http://localhost:10050/admin` (без пароля) и health. Рядом с compose
появятся `storage/agent-runtime.sqlite` (все запросы, транскрипты, вложения) и
`logs/debug.log` (JSON lines, одна строка на событие, ротация на 100 МБ).

Образ собран только под `linux/amd64`, на Apple Silicon работает через
эмуляцию, это заложено в compose строкой `platform`. Обновление:
`docker compose pull && docker compose up -d`.

Локальная Ollama вместо облака: в `.env` задать
`OLLAMA_HOST=http://host.docker.internal:11434` с пустым ключом и раскомментировать
`extra_hosts` в compose (см. эталонный
[config/docker-compose.yaml](https://github.com/tripolskypetr/agent-runtime/blob/master/config/docker-compose.yaml)).

Отличие нашего `.env.example` от эталонного в репозитории agent-runtime: там
дополнительно задано `OLLAMA_THINK=false`, у нас переменная не задана, значит
режим размышления остаётся на усмотрение модели. Остальные настройки
(`MAX_ATTEMPTS`, `MAX_TURNS`, `INFERENCE_TIMEOUT_MS`, `OLLAMA_NUM_CTX`,
`OLLAMA_TEMPERATURE`, логирование) берутся по умолчанию и при необходимости
дописываются в `.env`. Полный список в README agent-runtime, раздел Configuration.

Проверка на реальной записи датасета одним запросом:

```bash
head -n 1 assets/wwwroot.jsonl | jq '{
  messages: .messages,
  format: {
    type: "object",
    required: ["summary", "sentiment"],
    properties: {
      summary:   { type: "string", description: "Краткое содержание обзора, 2-3 предложения" },
      sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Общее настроение" }
    }
  }
}' > /tmp/request.json
curl -s -X POST http://localhost:10050/api/v1/inference \
  -H 'content-type: application/json' -d @/tmp/request.json | jq
```

Тело запроса с картинками обзора весит до 3,4 МБ, это в пределах лимита.
Ответ придёт через десятки секунд или минуты, `curl` таймаута не имеет.

## 4. Вызов из стратегии

Клиент: пакет [agent-runtime-sdk](https://www.npmjs.com/package/agent-runtime-sdk)
(в npm версия 0.1.0), типизированный `generateObject` / `generateText` поверх
`fetch`. Тип ответа выводится из схемы: `enum` становится union, `required`
определяет обязательные ключи. В проект пока не установлен:

```bash
npm i agent-runtime-sdk undici
```

`undici` нужен для dispatcher без таймаутов, у SDK он опциональная peer-зависимость.

Минимальный агент 1 из AGENT.md в терминах backtest-kit:

```ts
import { addStrategySchema, Cache } from "backtest-kit";
import { generateObject, defineFormat, type InferFormat } from "agent-runtime-sdk";
import { Agent } from "undici";
import { Dataset } from "../classes/Dataset"; // путь зависит от расположения стратегии

// Один dispatcher на процесс: инференс идёт минутами, встроенный fetch обрывает его через 300 с
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const ClaimFormat = defineFormat({
  type: "object",
  required: ["has_claim", "direction", "evidence_quote", "reasoning"],
  properties: {
    has_claim: { type: "boolean", description: "В обзоре есть фальсифицируемое утверждение о последующем движении цены" },
    direction: { type: "string", enum: ["up", "down", "none"], description: "Направление ожидаемого движения, none если утверждения нет" },
    evidence_quote: { type: "string", description: "Дословная цитата из обзора, на которой основано утверждение. Пустая строка, если утверждения нет" },
    reasoning: { type: "string", description: "Почему принято такое решение, для отладки" },
  },
});

type Claim = InferFormat<typeof ClaimFormat>; // direction: "up" | "down" | "none"

const getClaim = Cache.file(
  async (symbol: string, when: Date) => {
    const article = await Dataset.getArticle(when);
    if (!article) {
      return { claim: null };
    }
    const claim: Claim = await generateObject(
      {
        messages: article.messages,             // запись датасета как есть, с картинками
        instructions: `Инструмент: ${symbol}. Отвечай на русском языке.`,
        format: ClaimFormat,
      },
      { dispatcher },                           // baseUrl по умолчанию AGENT_RUNTIME_URL или http://localhost:10050
    );
    return { claim, articleId: article.id, publishedAt: article.publishedAt };
  },
  { interval: "1d", name: "news_claim_v1" },
);

addStrategySchema({
  strategyName: "news_claims",
  getSignal: async (symbol, when, currentPrice) => {
    const { claim, articleId, publishedAt } = await getClaim(symbol, when);
    if (!claim || !claim.has_claim || claim.direction === "none") {
      return null;
    }
    // дальше по AGENT.md: предикат входа, агент 2, агент 3
    return null;
  },
});
```

Куда что класть:

| Что | Куда | Почему |
|---|---|---|
| Роль и правила агента (системный промпт из AGENT.md) | `instructions` | попадает в системный промпт разделом «Additional instructions» |
| Текст и картинки обзора | `messages` | это и есть запись датасета |
| Схема ответа | `format` через `defineFormat` | литералы `enum` сохраняются в типе, каст `<Position> entry.position` из референса не нужен |
| Модель | не передавать | задаётся на сервере в `.env`; поле `model` только для разовых экспериментов |

Ошибки. `generateObject` бросает `AgentRuntimeError` с полями `code`, `details`
(по строке на попытку) и `inferenceId`, по которому транскрипт открывается в
админке. Если исключение в стратегии нежелательно, `inference()` возвращает
тот же ответ объектом со `status: "success" | "error"` без throw.

Миграция с json-inference, как в референсной стратегии:

```ts
// было: json-inference, модель и провайдер в коде стратегии
const entry = await generateObject(InferenceName.OllamaInference, { format, messages }, "gemma4:31b-cloud");

// стало: agent-runtime-sdk, модель и ключ на сервере, схема та же
const entry = await generateObject({ format, messages }, { dispatcher });
```

Схемы совместимы: `FormatModel` json-inference принимается без изменений.
Разница в типе ответа: у json-inference со `satisfies FormatModel` enum
расширяется до `string`, у SDK с `defineFormat` остаётся union.

**Подмножество JSON Schema.** `format` это не произвольная JSON Schema, а
`FormatModel` из json-inference. Валидатор на сервере (`validateToolArguments`)
и типы SDK (`FormatProperty`) понимают только это:

| Ключ | Где допустим |
|---|---|
| `type` | одно из `string`, `number`, `integer`, `boolean`, `array`, `object`; строка, не массив |
| `description` | обязателен у каждого свойства (тип SDK), у `items` необязателен |
| `enum` | только для `type: "string"` |
| `items`, `minItems`, `maxItems` | для `array` |
| `required`, `properties` | для `object`, вложенность без ограничений |

Нет `oneOf`, `anyOf`, `allOf`, `if`/`then`, `const`, `$ref`, `$defs`,
`additionalProperties`, `minLength`, `maxLength`, `pattern`, типа `null` и
записи `type: ["string", "null"]`. Поведение при их появлении:

- запрос проходит: Fastify-схема `format` разрешает лишние ключи;
- валидатор молча пропускает свойство, у которого нет строкового `type`, и не
  знает остальных ключей, то есть ограничение не проверяется вовсе;
- TypeScript отвергает такую схему в `defineFormat` как лишние свойства
  литерала, а при касте выводит `unknown` для поля.

Модель видит схему целиком в системном промпте и может следовать ей, но
гарантий это не даёт. Всё, что не входит в подмножество, переносится в
пост-валидацию харнесса.

## 5. На что обратить внимание при переносе стратегии

Выводы из вычитки `backtest-ollama-casual/content/crypto_yoda_channel/main.strategy.ts`,
где вызов LLM уже встроен в `getSignal` backtest-kit.

**Кэш инференсов обязателен.** Референс оборачивает вызов модели в
`Cache.file` с `interval` и `name`. Результат пишется на диск в
`./dump/data/measure/<name>_<interval>_<index>/`, ключ по умолчанию
`${symbol}_${alignMs}`, где `alignMs` это `when`, выровненный по интервалу.
Повторный прогон бэктеста читает ответы с диска и не ходит в agent-runtime.
Следствия:

- `interval` должен совпадать с `entryInterval` фрейма. В `aug_2026_frame`
  это `1d`: `getSignal` вызывается раз в сутки в 00:00Z, обзор за этот день
  опубликован в 21:00Z накануне и уже доступен через `Dataset.getArticle`.
- Смена схемы, промпта или инструкций требует нового `name`
  (`news_claim_v1` → `news_claim_v2`), иначе подмешаются кэшированные ответы
  старой формы. README референса говорит об этом прямо.
- На весь датасет приходится 698 обзоров, инференс занимает от десятков секунд
  до минут и исполняется по одному. Первый прогон это часы, остальные читают кэш.

**Look ahead закрывается до вызова модели.** Референс отдаёт модели только
посты, опубликованные не позже `when` (`scrapeLookback`), а после ответа ещё
раз проверяет свежесть по `message.date`. У нас первое делает
`Dataset.getArticle(when)`: обзор следующего дня не виден до своего
`publishedAt`. Второе остаётся за стратегией: `publishedAt` возвращается вместе
с ответом, горизонты по AGENT.md отсчитываются от него.

**Ответ модели сверяется с известными фактами.** Референс просит модель вернуть
`id` поста и проверяет, что такой пост был в окне (`messages.find`), иначе
сигнал отбрасывается: модель может придумать id. В `main.strategy.ts` при этом
нет проверки `entry.symbol === symbol`, которая есть в шаблонной версии, хотя
в окно попадают посты про несколько монет. У нас `article.id` известен заранее
и модели не нужен, зато обязательна проверка `evidence_quote`: цитата должна
дословно встречаться в тексте обзора, это «сверка эха» из AGENT.md раздел 11.
Правило общее: всё, что харнесс знает сам, он проверяет, а не доверяет модели.

**Схемы AGENT.md в подмножество не укладываются.** Схемы ответов агентов 1, 2
и 3 и схема предиката написаны на полном JSON Schema 2020-12: `signal` как
`oneOf: [null, object]`, `type: ["string", "null"]`, `enum` без `type`,
`const`, `allOf` с `if`/`then`, `additionalProperties: false`, `minLength`,
`maxLength`, `pattern`, рекурсивный предикат через `$defs` и `$ref`. Ни один
из этих ключей валидатор не проверяет, а SDK не типизирует (см. раздел 4).
Перед реализацией схемы переписываются:

- «нет сигнала» выражается маркерами, как в референсе (`id: -1`,
  `position: "wait"`, `targets: []`): либо `verdict` в `enum` плюс объект
  `signal` вне `required`, согласованность которых проверяет харнесс, либо
  флаг `has_claim` с пустыми значениями, как в примере раздела 4;
- `type: ["string", "null"]` становится `type: "string"` с пустой строкой как
  маркером, `const` становится `enum` из одного значения, `enum` получает
  `type: "string"`;
- `additionalProperties`, `minLength`, `maxLength`, `pattern`, `if`/`then`
  уходят в пост-валидацию харнесса, которая в AGENT.md и так предусмотрена;
- рекурсивное дерево предиката (`all`/`any`/`not` через `$ref`) в подмножестве
  не выражается. Варианты: фиксированная глубина (объект с полями
  `all: leaf[]`, `any: leaf[]`), плоский список листьев с `op` в `enum`, либо
  строковый DSL, который разбирает и проверяет харнесс. Выбор за автором
  конвейера.

**Поле `reasoning` и отладка.** Референс требует от модели `reasoning` и кладёт
его в `note` сигнала. С agent-runtime полный транскрипт каждого инференса
хранится в SQLite и виден в админке по id, поэтому для отладки достаточно
сохранять `inferenceId` в `payload` сигнала. `reasoning` можно оставить: он
дисциплинирует модель.

**Картинки.** Референс картинки постов модели не отдаёт (`omit(message, "photo")`).
В нашем датасете графики это 98 % объёма записи. При `OLLAMA_VISION=1` они
уходят модели и увеличивают время ответа и расход токенов. Если агенту 1
нужен только текст, передавать `messages` без `images`; решение принимается по
результатам на golden-фикстурах из AGENT.md раздел 9.

**Таймауты и параллельность.** Один инференс за раз на сервере, минуты на
ответ. Бэктест по нескольким символам отправит запросы параллельно, они
выстроятся в очередь, и `getSignal` будет ждать. Клиент обязан быть без
таймаута (dispatcher), сервер ограничен `INFERENCE_TIMEOUT_MS`.

## 6. Диагностика

| Где | Что |
|---|---|
| `http://localhost:10050/admin` | список инференсов, транскрипт, запрос, вложения, ошибка с деталями по попыткам |
| `GET /api/v1/inferences/:id` | то же через API; `?status=error` в списке отбирает неудачные |
| `docker/agent/logs/debug.log` | JSON lines: запрос, каждый ход модели, вызовы инструментов, ошибки провайдера |
| `docker compose logs -f agent-runtime` | та же лента в stdout |

Один инференс целиком:

```bash
grep '<inference id>' docker/agent/logs/debug.log | jq -c '.args'
```

Секреты в логе маскируются, строки длиннее 2000 символов (base64, промпты)
обрезаются.

## 7. Ссылки

- [agent-runtime](https://github.com/tripolskypetr/agent-runtime): README с API, конфигурацией и логированием
- [agent-runtime-sdk](https://github.com/tripolskypetr/agent-runtime/tree/master/packages/sdk): README клиента, вывод типов, обработка ошибок
- [json-inference](https://github.com/tripolskypetr/json-inference): формат схем `FormatModel`
- [AGENT.md](AGENT.md): конвейер из трёх агентов, схемы ответов, фикстуры
- [DATASET.md](DATASET.md): откуда берутся `messages`
