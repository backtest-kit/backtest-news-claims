# TODO: полная JSON Schema в agent-runtime

План доработки [agent-runtime](https://github.com/tripolskypetr/agent-runtime)
и его SDK, чтобы схемы ответов агентов из [docs/AGENT.md](docs/AGENT.md)
передавались в `format` без переписывания, проверялись сервером целиком и
давали правильные типы TypeScript в стратегии. Текущее состояние поддержки
описано в [docs/RUNTIME.md](docs/RUNTIME.md), разделы 4 и 5.

Пути без префикса относятся к репозиторию agent-runtime.

## Статус

Мейнтейнер ответил в `agent-runtime/ANSWER.md`: части 1 и 2 сделаны в рабочем
дереве, кроме публикации образа и пакета. Пункт 2.3 (явный тип ответа через
брендированную схему) отклонён: контракт это одна схема в одном
`defineFormat()`, без второго типа, написанного руками. Осталась часть 3 на
стороне этого проекта и публикация.

| Что | Состояние |
|---|---|
| Сервер | собран в рабочем дереве, все проверки на нём |
| `agent-runtime-sdk` | 0.2.0 собрана (`build/`, `types.d.ts`), в npm не опубликована, там 0.1.0 |
| Образ `tripolskypetr/agent-runtime` на Docker Hub | старый, от 2026-10-29, без изменений |
| Модель в проверках | `gemma4:31b-cloud`, `OLLAMA_THINK=false` |

## Критерий готовности

- [x] Схемы агентов 1, 2, 3 и предиката из AGENT.md принимаются как `format`
      без правок, кроме склейки `$defs` (часть 3). Схемы агентов 2 и 3
      приняты дословно, у агента 1 внешняя ссылка на предикат заменена на
      локальную.
- [x] Нарушение `const`, `oneOf`, `if`/`then`, `pattern`, `additionalProperties`,
      `minLength`/`maxLength`, `type: [..., "null"]` отклоняется с путём до поля,
      и это сообщение уходит модели в повторе. Пример: `signal.direction: must
      be exactly "long"; signal: must be null; signal: must match exactly one of
      the allowed shapes`.
- [x] Невалидная схема даёт 400 `invalid_format` до инференса, запись в базе не
      создаётся.
- [x] TypeScript выводит `signal: null | { direction: "long"; ... }`,
      `verdict` как union, `published_at: string | null`.
- [x] Рекурсивный предикат: вывод типа на глубину 6 (`InferFormat<F, Depth>`),
      глубже `unknown`; для предиката AGENT.md это пять уровней с точными
      типами листьев. Без `typedFormat`, см. статус.
- [x] Smoke на `gemma4:31b-cloud`: 8/8 при `MODEL_SCHEMA_REF_DEPTH=3` и 8/8 при `0`.
- [x] Фикстуры A и B проходят схему агента 1 на уровне валидатора
      (`npm run test:schema`, 36/36). На модели не прогонялись: обзоров
      22.10.2026 и 23.10.2026 в датасете нет. Вместо них синтетическая
      фикстура C с непустым `signal`: схема, пост-валидация и модель, 1/1.
- [ ] Образ и `agent-runtime-sdk` 0.2.0 опубликованы.

## Часть 1. Сервер

- [x] 1.1 ajv-валидатор: `ajv` ^8.20 и `ajv-formats` явные зависимости;
      `src/helpers/schema.ts` с `Ajv2020`, `strict: false`,
      `strictSchema: "log"` (предупреждения в `debug.log`, scope `schema`),
      `allErrors`, `allowUnionTypes`; `compileFormat` с кэшем по sha256;
      `$id` и `$schema` отбрасываются перед компиляцией; только локальные
      `#/$defs/...`.
- [x] 1.1 `formatErrors`: путь `/signal/direction` → `signal.direction`, корень →
      `answer`; `allowedValues`, `allowedValue`, `additionalProperty`,
      `pattern` в тексте; не более 5 строк плюс «…and N more»; сортировка от
      самого глубокого пути, потому что при провале `oneOf` ajv перечисляет
      претензии всех веток у корня, а реальная ошибка обычно глубже.
- [x] 1.1 `validateToolArguments` делегирует компилированному валидатору,
      сигнатура сохранена.
- [x] 1.1 400 `invalid_format` в `src/routes/inference.route.ts`, код в Swagger.
- [x] 1.1 `type: "object"` на верхнем уровне оставлен.
- [x] 1.2 `toModelSchema`: убирает `$schema`, `$id`, `title`, `examples`,
      `$comment`, `default`; раскрывает `$ref` на `MODEL_SCHEMA_REF_DEPTH`
      (по умолчанию 3), на срезе `description` цели или «nested "predicate" of
      the same shape as above»; `$defs` не передаёт. Применяется к параметрам
      инструмента и к `{{{schema}}}` в промпте; валидация по исходной схеме.
- [x] 1.2 Эксперимент «как есть»: при `MODEL_SCHEMA_REF_DEPTH=0` модель прошла
      все 8 случаев; параметры инструмента для схемы агента 1 4,5 КБ против
      6,1 КБ при `3`. По умолчанию оставлено `3` ради локальных моделей.
- [x] 1.2 Правило 5 в `assets/system.mustache`: `null` это JSON null; при
      `oneOf`/`anyOf` ровно одна ветка; `const` дословно; `enum`
      исчерпывающий; лишние свойства запрещены.
- [x] 1.3 Повторы: текст ajv уходит модели как результат инструмента. Лог
      `run start` печатает `required`, `properties`, `defs`, флаги `hasOneOf`,
      `hasAnyOf`, `hasAllOf`, `hasRef`, `hasIf`, `hasConst`, размер схемы.
- [x] 1.4 README (раздел API), описание `FormatModel` в Swagger,
      `MODEL_SCHEMA_REF_DEPTH` в `config/.env.example`.
- [x] 1.5 Smoke: `demo/smoke-schema.ts`, `npm run smoke:schema`; валидатор без
      модели: `demo/schema.test.ts`, `npm run test:schema`.

Находка, которой в плане не было. pi-agent-core сам проверяет аргументы
любого инструмента против `tool.parameters` (TypeBox) до `execute`, и его
сообщения скупые: `signal.direction: must be equal to constant` без значения,
`root: must match "then" schema`. Пока параметрами инструмента была схема для
модели, модель получала именно их, а ajv до дела не доходил. Поэтому
`provide_answer` объявлен для pi с разрешающей схемой
`{ type: "object", additionalProperties: true }`, а схема для модели
подставляется в запрос к Ollama потоковой функцией (`toolParameters` в
`src/agent/ollama.ts`). Валидатор один, ajv.

## Часть 2. SDK (`packages/sdk`)

- [x] 2.1 `JsonSchema` с `readonly`-полями: `type` строкой или массивом, `enum`,
      `const`, `oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`, `$ref`,
      `$defs`, `properties`, `required`, `additionalProperties`, `items`,
      `prefixItems`, `min`/`max` для строк, чисел, массивов и объектов,
      `pattern`, `format`, `description`, `title`, `$schema`, `$id`, `default`,
      `examples`. `description` необязателен. `FormatItems`/`FormatProperty`
      оставлены алиасами.
- [x] 2.2 `InferProperty<T, Root, Depth>`: `$ref` → `const` → `enum` →
      `oneOf`/`anyOf` → `allOf` → массив типов → скаляры → массив → объект;
      `if`/`then`/`else` тип не меняют; глубина по умолчанию 6, предел
      поднимается вторым параметром `InferFormat<typeof F, 10>`.
      Схема агента 1 целиком: 34 тысячи инстанциаций, 0,14 с, без
      «excessively deep».
- [ ] ~~2.3 `typedFormat<T>()`~~ отклонено решением мейнтейнера: одна схема в
      одном `defineFormat`, без типа, написанного руками.
- [x] 2.4 Тесты: `test/typecheck.ts` по случаю на каждый ключ, `@ts-expect-error`
      на неверный `const` и неверную ветку `oneOf`, схема агента 1 целиком
      (`test/agent1.format.ts`, 282 строки), рекурсия на глубине 3;
      `test/test.mjs`: round trip nullable и `oneOf`, 400 `invalid_format` как
      `AgentRuntimeError`. `rollup-plugin-dts` выносит рекурсивные типы корректно.
- [x] 2.5 README SDK переписан, версия 0.2.0.
- [ ] 2.5 Публикация в npm. За владельцем: `npm publish` в `packages/sdk`.

Старые схемы json-inference (`satisfies FormatModel`, без `defineFormat`)
работают как раньше: `enum` расширяется до `string`, все поля обязательные.

## Часть 3. Этот проект

- [ ] Дождаться публикации, затем `npm i agent-runtime-sdk@^0.2 undici`.
- [ ] Схемы как литералы `.ts`, не JSON. Импорт из `.json` расширяет `enum`,
      `const` и `required` до `string` и `string[]`, и `signal` теряет
      `| null`. Поэтому `schemas/agent1.format.ts`, `agent2.format.ts`,
      `agent3.format.ts` с `defineFormat`, сгенерированные из склеенных схем.
      Готовые склеенные схемы лежат в agent-runtime: `demo/fixtures/*.schema.json`,
      литерал агента 1 в `packages/sdk/test/agent1.format.ts`. Скрипт склейки:
      вклеить `$defs` предиката в схему агента 1, ссылки
      `predicate.schema.json#/$defs/predicate` переписать на
      `#/$defs/predicate`. AGENT.md остаётся источником истины для текста.
- [ ] Системный промпт агента 1 из AGENT.md вынести в файл, передавать как
      `instructions` (референс `demo/fixtures/agent1.prompt.txt`).
- [ ] Пост-валидация харнессом из AGENT.md разделов 3 и 5 в стратегии:
      цитаты дословно, `based_on_claim_ids` только на `forward_directional`/
      `up`/`falsifiable`/`expressible` claims, числовые литералы предикатов из
      текста, глубина ≤ 3 и листьев ≤ 8. Референс: `demo/agent1.check.ts`.
- [ ] Решить про `MODEL_SCHEMA_REF_DEPTH`: `3` по умолчанию или `0` для облачной
      модели (экономия токенов на каждом ходу, модель с `$ref` справляется).
- [ ] Решить про `OLLAMA_THINK` в `docker/agent/.env`: проверки шли с `false`.
- [ ] После публикации обновить [docs/RUNTIME.md](docs/RUNTIME.md), раздел 4:
      убрать оговорку, что 0.2.0 не опубликована.

## Риски после проверки

- Доля `schema_mismatch` на сложной схеме: по замерам 0/6 на статьях датасета
  и 8/8 в smoke, ни одного отклонённого вызова `provide_answer` на реальных
  статьях. Риск не подтвердился на `gemma4:31b-cloud`; на других моделях не
  мерился. Запасной план прежний: разбить ответ агента 1 на два вызова с
  плоскими схемами.
- Пределы рекурсии типов: не подтвердился, 0,14 с на схему агента 1.
- Размер параметров инструмента: 6,1 КБ при `3` против 4,5 КБ при `0` на
  каждый ход, см. решение в части 3.
- `strict: false` в ajv скрывает опечатки в ключах: закрыто
  `strictSchema: "log"`, предупреждения смотреть в `debug.log`.
- Паритет с json-inference не делался: agent-runtime надмножество, старые
  схемы работают.
- Golden-фикстуры A и B на модели не проверялись, их тексты недоступны:
  в датасете нет этих дат, на сайте полный текст за подпиской. Golden-проверка
  агента 1 на реальных статьях пока только синтетическая (фикстура C).

## Как запускать проверки (в agent-runtime)

```bash
npm run build && npm run test:schema                                  # валидатор и схема для модели, без модели
node --env-file=.env build/index.js                                   # сервер
npm run smoke:schema                                                  # 8 случаев на модели
SMOKE_ARTICLE=../backtest-news-claims/assets/wwwroot.jsonl SMOKE_ARTICLE_COUNT=4 npm run smoke:schema   # плюс агент 1 на статьях
cd packages/sdk && npm test                                           # сборка, типы, round trip против BASE_URL
```
