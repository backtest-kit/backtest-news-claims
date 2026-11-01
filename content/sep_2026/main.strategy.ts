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
    name: "agent1_v2",
    key: ([symbol, , article]) => `${symbol}_${article.id}`,
  },
);

const getEntry = Cache.file(
  async (symbol: string, article: Article, criteria: Criterion[], when: Date) =>
    Agent.getEntry(symbol, article, criteria, when),
  {
    interval: "4h",
    name: "agent2_v2",
  },
);

const getExit = Cache.file(
  async (
    symbol: string,
    signal: IPublicSignalRow,
    article: Article | null,
    criteria: Criterion[],
    when: Date,
  ) => Agent.getExit(symbol, signal, article, criteria, when),
  {
    interval: "4h",
    name: "agent3_v2",
    key: ([symbol, alignMs, signal]) => `${symbol}_${alignMs}_${signal.id}`,
  },
);

// Кэш по статье и сигналу: одна сверка статьи с позицией
const getReview = Cache.file(
  async (
    symbol: string,
    signal: IPublicSignalRow,
    article: Article,
    criteria: Criterion[],
    when: Date,
  ) => Agent.getReview(symbol, signal, article, criteria, when),
  {
    interval: "1d",
    name: "agent4_v1",
    key: ([symbol, , signal, article]) => `${symbol}_${article.id}_${signal.id}`,
  },
);

addStrategySchema({
  strategyName: "main_strategy",
});

listenIdlePing(async ({ symbol, when, currentPrice }) => {
  const article = await Dataset.getArticle(when);
  if (!article) {
    return;
  }
  const { criteria, reasoning } = await getCriteria(symbol, article);
  Log.info("agent1", `${article.when}: ${criteria.length} критериев, не хватило: ${reasoning}`);
  if (!criteria.length) {
    return;
  }
  const answer = await getEntry(symbol, article, criteria, when);
  Log.info("agent2", `${when.toISOString()}: ${answer.action}, не хватило: ${answer.reasoning}`);
  if (answer.action === "wait") {
    return;
  }
  await commitCreateSignal(symbol, {
    ...Position.moonbag({
      position: answer.action,
      currentPrice,
      percentStopLoss: HARD_STOP_PERCENT,
    }),
    payload: { articleId: article.id, criteria, answer },
    note: answer.description,
  });
});

// Подписчики вызываются в порядке подписки, сбой одного не останавливает следующих

// Критерии новой статьи: нужны агенту 3
listenActivePingFilter(
  async ({ when }) => {
    const article = await Dataset.getArticle(when);
    return !!article && !(await Agent.getPosition()).articleIds.includes(article.id);
  },
  async ({ symbol, when }) => {
    const article = await Dataset.getArticle(when);
    const answer = await getCriteria(symbol, article!);
    Log.info("agent1", `${article!.when}: ${answer.criteria.length} критериев, не хватило: ${answer.reasoning}`);
    await Agent.addCriteria(article!.id, answer.criteria);
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
    const { criteria } = await getCriteria(symbol, article!);
    const answer = await getReview(symbol, data, article!, criteria, when);
    Log.info("agent4", `${article!.when}: ${answer.forecast}, ${answer.action}, не хватило: ${answer.reasoning}`);
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
    const article = await Dataset.getArticle(when);
    const answer = await getExit(symbol, data, article, criteria, when);
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
