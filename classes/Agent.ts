import {
  getCandles,
  renderMustache,
  State,
  type CandleInterval,
  type IPublicSignalRow,
} from "backtest-kit";
import {
  defineFormat,
  encodeFile,
  generateObject,
  type InferFormat,
} from "agent-runtime-sdk";
import { get } from "lodash-es";
import { join } from "path";
import { Agent as HttpAgent } from "undici";

const PROMPT_PATH = "./prompt";
const ROOT_PATH_SYMBOL = Symbol.for("root_path");

const CANDLES: { interval: CandleInterval; limit: number }[] = [
  { interval: "1d", limit: 30 },
  { interval: "1h", limit: 168 },
  { interval: "1m", limit: 240 },
];

const Agent1Format = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["criteria", "description", "reasoning"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "direction", "condition", "level", "horizon", "evidence_quote"],
        properties: {
          id: { type: "string", pattern: "^c[0-9]{1,2}$" },
          direction: { enum: ["up", "down"] },
          condition: { type: "string", minLength: 1, description: "Условие своими словами" },
          level: { type: ["number", "null"], description: "Уровень цены из статьи" },
          horizon: { type: ["string", "null"], description: "Срок из статьи" },
          evidence_quote: { type: "string", minLength: 1, description: "Дословная подстрока статьи" },
        },
      },
    },
    description: {
      type: "string",
      minLength: 1,
      description: "Понятное описание решения для человека, показывается в интерфейсе",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      description: "Каких данных не хватило для ответа. Если хватило всех, так и напиши",
    },
  },
});

const Agent2Format = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["criteria", "action", "description", "reasoning"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "met", "level_tests", "evidence"],
        properties: {
          id: { type: "string" },
          met: { type: "boolean" },
          level_tests: { type: ["integer", "null"], description: "Сколько раз цена тестировала уровень" },
          evidence: { type: "string", minLength: 1, description: "Обоснование по данным" },
        },
      },
    },
    action: { enum: ["long", "short", "wait"] },
    description: {
      type: "string",
      minLength: 1,
      description: "Понятное описание решения для человека, показывается в интерфейсе",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      description: "Каких данных не хватило для ответа. Если хватило всех, так и напиши",
    },
  },
});

const Agent3Format = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["criteria", "action", "description", "reasoning"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "relevant", "evidence"],
        properties: {
          id: { type: "string" },
          relevant: { type: "boolean" },
          evidence: { type: "string", minLength: 1, description: "Обоснование по данным" },
        },
      },
    },
    action: { enum: ["hold", "close"] },
    description: {
      type: "string",
      minLength: 1,
      description: "Понятное описание решения для человека, показывается в интерфейсе",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      description: "Каких данных не хватило для ответа. Если хватило всех, так и напиши",
    },
  },
});

const Agent4Format = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["forecast", "evidence_quote", "action", "description", "reasoning"],
  properties: {
    forecast: {
      enum: ["supports", "contradicts", "neutral"],
      description: "Как вывод обзора соотносится с направлением позиции",
    },
    evidence_quote: {
      type: ["string", "null"],
      description: "Дословная подстрока статьи с выводом автора. null только при neutral",
    },
    action: { enum: ["hold", "close"] },
    description: {
      type: "string",
      minLength: 1,
      description: "Понятное описание решения для человека, показывается в интерфейсе",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      description: "Каких данных не хватило для ответа. Если хватило всех, так и напиши",
    },
  },
});

interface Article {
  id: string;
  when: string;
  format: "dd.mm.yyyy";
  publishedAt: string;
  messages: {
    role: "user";
    content: string;
    images?: string[];
  }[];
}

export type CriteriaAnswer = InferFormat<typeof Agent1Format>;
export type Criterion = CriteriaAnswer["criteria"][number];
export type EntryAnswer = InferFormat<typeof Agent2Format>;
export type ExitAnswer = InferFormat<typeof Agent3Format>;
export type ReviewAnswer = InferFormat<typeof Agent4Format>;

interface PositionState {
  /** Статьи, чьи критерии уже учтены */
  articleIds: string[];
  /** Все критерии позиции */
  criteria: Criterion[];
  /** Ответы агента 3 по каждой проверке */
  history: { when: string; answer: ExitAnswer }[];
  /** Статьи, сверенные с позицией. Статья открытия сверена агентом 2 */
  reviewedArticleIds: string[];
  /** Ответы агента 4 по каждой новой статье */
  reviews: { when: string; articleId: string; answer: ReviewAnswer }[];
}

const getPromptPath = (name: string) => {
  const fileName = `${name}.mustache`;
  if (ROOT_PATH_SYMBOL in globalThis) {
    return join(get(globalThis, ROOT_PATH_SYMBOL), PROMPT_PATH, fileName);
  }
  return join(PROMPT_PATH, fileName);
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const getArticleText = (article: Article) =>
  squash(article.messages.map(({ content }) => content).join("\n"));

const toCriteriaMessage = (criteria: Criterion[]) => ({
  role: "user" as const,
  content: `Критерии:\n${JSON.stringify(criteria, null, 2)}`,
});

const assertSameIds = (criteria: Criterion[], answer: { criteria: { id: string }[] }) => {
  const expected = criteria.map(({ id }) => id).sort().join();
  const actual = answer.criteria.map(({ id }) => id).sort().join();
  if (expected !== actual) {
    throw new Error(`Agent: answer ids [${actual}] do not match criteria [${expected}]`);
  }
};

/** Закрытые свечи на момент проверки: время берётся из контекста backtest-kit */
const getCandleFiles = (symbol: string) =>
  Promise.all(
    CANDLES.map(async ({ interval, limit }) => {
      const candles = await getCandles(symbol, interval, limit);
      const rows = candles.map(({ timestamp, open, high, low, close, volume }) =>
        [new Date(timestamp).toISOString(), open, high, low, close, volume].join(","),
      );
      return encodeFile(
        `candles_${interval}.csv`,
        ["timestamp,open,high,low,close,volume", ...rows].join("\n"),
      );
    }),
  );

export class AgentUtils {
  /** Встроенный fetch обрывает запрос без ответа через 300 с */
  private _dispatcher = new HttpAgent({ headersTimeout: 0, bodyTimeout: 0 });

  /** Критерии открытой позиции. Сигнал и время State берёт из контекста backtest-kit */
  private _positionState = new State<PositionState>({
    name: "agent_position",
    initialData: ({ signal }) => ({
      articleIds: [signal.payload?.articleId],
      criteria: signal.payload?.criteria ?? [],
      history: [],
      reviewedArticleIds: [signal.payload?.articleId],
      reviews: [],
    }),
  });

  /** Агент 1. Id критерия уникален между статьями */
  public getCriteria = async (article: Article): Promise<CriteriaAnswer> => {
    const answer = await generateObject(
      {
        messages: article.messages,
        instructions: await renderMustache(getPromptPath("agent1")),
        format: Agent1Format,
      },
      { dispatcher: this._dispatcher },
    );
    const text = getArticleText(article);
    return {
      ...answer,
      criteria: answer.criteria
        .filter(({ evidence_quote }) => text.includes(squash(evidence_quote)))
        .map((criterion) => ({ ...criterion, id: `${article.when}-${criterion.id}` })),
    };
  };

  /** Агент 2 */
  public getEntry = async (
    symbol: string,
    article: Article,
    criteria: Criterion[],
    when: Date,
  ): Promise<EntryAnswer> => {
    const answer = await generateObject(
      {
        messages: [...article.messages, toCriteriaMessage(criteria)],
        files: await getCandleFiles(symbol),
        instructions: await renderMustache(getPromptPath("agent2"), {
          symbol,
          when: when.toISOString(),
        }),
        format: Agent2Format,
      },
      { dispatcher: this._dispatcher },
    );
    assertSameIds(criteria, answer);
    return answer;
  };

  /** Агент 3 */
  public getExit = async (
    symbol: string,
    signal: IPublicSignalRow,
    article: Article | null,
    criteria: Criterion[],
    when: Date,
  ): Promise<ExitAnswer> => {
    const position = {
      role: "user" as const,
      content: `Позиция:\n${JSON.stringify({
        position: signal.position,
        priceOpen: signal.priceOpen,
        priceStopLoss: signal.priceStopLoss,
        pendingAt: new Date(signal.pendingAt).toISOString(),
      }, null, 2)}`,
    };
    const answer = await generateObject(
      {
        messages: [...(article?.messages ?? []), toCriteriaMessage(criteria), position],
        files: await getCandleFiles(symbol),
        instructions: await renderMustache(getPromptPath("agent3"), {
          symbol,
          when: when.toISOString(),
        }),
        format: Agent3Format,
      },
      { dispatcher: this._dispatcher },
    );
    assertSameIds(criteria, answer);
    return answer;
  };

  /** Агент 4. Сверяет вывод новой статьи с открытой позицией */
  public getReview = async (
    symbol: string,
    signal: IPublicSignalRow,
    article: Article,
    criteria: Criterion[],
    when: Date,
  ): Promise<ReviewAnswer> => {
    const position = {
      role: "user" as const,
      content: `Позиция:\n${JSON.stringify({
        position: signal.position,
        priceOpen: signal.priceOpen,
        priceStopLoss: signal.priceStopLoss,
        pendingAt: new Date(signal.pendingAt).toISOString(),
        openingReason: signal.note,
        openingCriteria: signal.payload?.criteria ?? [],
      }, null, 2)}`,
    };
    const answer = await generateObject(
      {
        messages: [...article.messages, toCriteriaMessage(criteria), position],
        files: await getCandleFiles(symbol),
        instructions: await renderMustache(getPromptPath("agent4"), {
          symbol,
          when: when.toISOString(),
        }),
        format: Agent4Format,
      },
      { dispatcher: this._dispatcher },
    );
    if (answer.forecast !== "neutral") {
      if (!answer.evidence_quote || !getArticleText(article).includes(squash(answer.evidence_quote))) {
        throw new Error(`Agent: forecast ${answer.forecast} has no verbatim quote`);
      }
    }
    return answer;
  };

  /** Состояние открытой позиции */
  public getPosition = () => this._positionState.getState();

  /** Добавляет к позиции критерии новой статьи */
  public addCriteria = (articleId: string, criteria: Criterion[]) =>
    this._positionState.setState((state) => ({
      ...state,
      articleIds: [...state.articleIds, articleId],
      criteria: [...state.criteria, ...criteria],
    }));

  /** Записывает ответ агента 3 в историю позиции */
  public addAnswer = (answer: ExitAnswer, when: Date) =>
    this._positionState.setState((state) => ({
      ...state,
      history: [...state.history, { when: when.toISOString(), answer }],
    }));

  /** Записывает ответ агента 4 в историю позиции */
  public addReview = (articleId: string, answer: ReviewAnswer, when: Date) =>
    this._positionState.setState((state) => ({
      ...state,
      reviewedArticleIds: [...state.reviewedArticleIds, articleId],
      reviews: [...state.reviews, { when: when.toISOString(), articleId, answer }],
    }));
}

export const Agent = new AgentUtils();
