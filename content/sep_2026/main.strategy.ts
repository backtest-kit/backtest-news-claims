import {
  addLauncherSchema,
  addStrategySchema,
  Cache,
  commitClosePending,
  commitCreateSignal,
  getPendingSignal,
  listenActivePingFilter,
  listenIdlePing,
  Log,
  Position,
  type IPublicSignalRow,
} from "backtest-kit";
import { Agent, type Criterion } from "../../classes/Agent";
import { Dataset } from "../../classes/Dataset";

const HARD_STOP_PERCENT = 7.5;

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

// Кэш по id статьи: один разбор на статью
const getCriteria = Cache.file(
  async (_symbol: string, article: Article) => Agent.getCriteria(article),
  {
    interval: "1d",
    name: "agent1_v1",
    key: ([symbol, , article]) => `${symbol}_${article.id}`,
  },
);

// На 4 часа, а не на сутки: вход после закрытия позиции не должен получить старый ответ
const getEntry = Cache.file(
  async (symbol: string, criteria: Criterion[], when: Date) =>
    Agent.getEntry(symbol, criteria, when),
  {
    interval: "4h",
    name: "agent2_v1",
  },
);

const getExit = Cache.file(
  async (
    symbol: string,
    signal: IPublicSignalRow,
    criteria: Criterion[],
    when: Date,
  ) => Agent.getExit(symbol, signal, criteria, when),
  {
    interval: "4h",
    name: "agent3_v1",
    key: ([symbol, alignMs, signal]) => `${symbol}_${alignMs}_${signal.id}`,
  },
);

// Кэш по статье и сигналу: одна сверка статьи с позицией
const getReview = Cache.file(
  async (
    symbol: string,
    signal: IPublicSignalRow,
    articleId: string,
    criterion: Criterion,
    description: string,
    when: Date,
  ) => Agent.getReview(symbol, signal, criterion, description, when),
  {
    interval: "1d",
    name: "agent4_v1",
    key: ([symbol, , signal, articleId]) => `${symbol}_${articleId}_${signal.id}`,
  },
);

/** Условие статьи, которое агент 2 увидел на свечах */
const getArgument = async (symbol: string, article: Article, when: Date) => {
  const review = await getCriteria(symbol, article);
  Log.info("agent1", `${article.when}: ${review.criteria.length} условий, не хватило: ${review.reasoning}`);
  if (!review.criteria.length) {
    return null;
  }
  const answer = await getEntry(symbol, review.criteria, when);
  Log.info("agent2", `${when.toISOString()}: ${answer.position} ${answer.id}, не хватило: ${answer.reasoning}`);
  const criterion = review.criteria.find(({ id }) => id === answer.id);
  if (answer.position === "wait" || !criterion) {
    return null;
  }
  return { answer, criterion, position: answer.position };
};

addStrategySchema({
  strategyName: "main_strategy",
});

listenIdlePing(async ({ symbol, when, currentPrice }) => {
  const article = await Dataset.getArticle(when);
  if (!article) {
    return;
  }
  const argument = await getArgument(symbol, article, when);
  if (!argument) {
    return;
  }
  const { answer, criterion, position } = argument;
  await commitCreateSignal(symbol, {
    ...Position.moonbag({
      position,
      currentPrice,
      percentStopLoss: HARD_STOP_PERCENT,
    }),
    payload: { articleId: article.id, criteria: [criterion], answer },
    note: answer.description,
  });
});

// Подписчики вызываются в порядке подписки, сбой одного не останавливает следующих

// Условие новой статьи: нужно агенту 3
listenActivePingFilter(
  async ({ when }) => {
    const article = await Dataset.getArticle(when);
    return !!article && !(await Agent.getPosition()).articleIds.includes(article.id);
  },
  async ({ symbol, when }) => {
    const article = await Dataset.getArticle(when);
    const argument = await getArgument(symbol, article!, when);
    // Условие ещё не видно на свечах: проверка повторится на следующем пинге
    if (argument) {
      await Agent.addCriteria(article!.id, [argument.criterion]);
    }
  },
);

// Агент 4: сверка новой статьи с позицией
listenActivePingFilter(
  async ({ when }) => {
    const article = await Dataset.getArticle(when);
    return !!article && !(await Agent.getPosition()).reviewedArticleIds.includes(article.id);
  },
  async ({ symbol, when, data }) => {
    const article = await Dataset.getArticle(when);
    const argument = await getArgument(symbol, article!, when);
    // Сверять нечего: условие статьи ещё не видно на свечах
    if (!argument) {
      return;
    }
    const answer = await getReview(symbol, data, article!.id, argument.criterion, argument.answer.description, when);
    Log.info("agent4", `${article!.when}: ${answer.action}, не хватило: ${answer.reasoning}`);
    await Agent.addReview(article!.id, answer, when);
    if (answer.action === "close") {
      await commitClosePending(symbol, {
        note: answer.description,
      });
    }
  },
);

// Агент 3: плановая проверка. Если агент 4 закрыл позицию на этом пинге, сигнала уже нет
listenActivePingFilter(
  async ({ symbol }) => !!(await getPendingSignal(symbol)),
  async ({ symbol, when, data }) => {
    const { criteria } = await Agent.getPosition();
    const answer = await getExit(symbol, data, criteria, when);
    Log.info("agent3", `${when.toISOString()}: ${answer.action}, не хватило: ${answer.reasoning}`);
    await Agent.addAnswer(answer, when);
    if (answer.action === "close") {
      await commitClosePending(symbol, {
        note: answer.description,
      });
    }
  },
);

addLauncherSchema({
  launcherName: "main_launcher",
  symbolList: ["BTCUSDT"],
  backtest: true,
});



