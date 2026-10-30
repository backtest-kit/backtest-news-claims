import { singleshot } from "functools-kit";
import { createReadStream } from "fs";
import { open } from "fs/promises";
import { get } from "lodash";
import { join } from "path";

const DATASET_ASSETS_PATH = "./assets/wwwroot.jsonl";
const ROOT_PATH_SYMBOL = Symbol.for("root_path");

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

/** Положение строки в файле: по нему строка читается заново при обращении */
interface LineRef {
  offset: number;
  length: number;
}

type DateKey = `${"dd"}.${"mm"}.${"yyyy"}`;

const getDatasetPath = singleshot(() => {
  if (ROOT_PATH_SYMBOL in globalThis) {
    const rootPath = get(globalThis, ROOT_PATH_SYMBOL);
    return join(rootPath, DATASET_ASSETS_PATH);
  }
  return DATASET_ASSETS_PATH;
});

const toDateKey = (date: Date): DateKey => {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  return `${dd}.${mm}.${yyyy}` as DateKey;
};

/** Идет по файлу строка за строкой, отдавая байты строки и ее смещение. В памяти одна строка */
async function* iterateLines(
  path: string,
): AsyncGenerator<{ offset: number; buffer: Buffer }> {
  let offset = 0;
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    let start = 0;
    let index: number;
    while ((index = chunk.indexOf(0x0a, start)) !== -1) {
      pending.push(chunk.subarray(start, index));
      const buffer = Buffer.concat(pending);
      yield { offset, buffer };
      offset += buffer.length + 1;
      pending = [];
      start = index + 1;
    }
    pending.push(chunk.subarray(start));
  }
  const buffer = Buffer.concat(pending);
  if (buffer.length) {
    yield { offset, buffer };
  }
}

export class DatasetUtils {
  /** Индекс строк: день публикации -> где лежат строки. Сами строки в памяти не держим */
  private _indexMap = new Map<DateKey, LineRef[]>();

  /** Прочитанные дни: только текущий и предыдущий, см. getArticle */
  private _cacheMap = new Map<DateKey, Article[]>();

  private waitForInit = singleshot(async () => {
    const DATASET_PATH = getDatasetPath();
    for await (const { offset, buffer } of iterateLines(DATASET_PATH)) {
      const line = buffer.toString("utf8");
      if (!line.trim()) {
        continue;
      }
      const article: Article = JSON.parse(line);
      const key = toDateKey(new Date(article.publishedAt));
      const ref: LineRef = { offset, length: buffer.length };
      const refs = this._indexMap.get(key);
      if (refs) {
        refs.push(ref);
      } else {
        this._indexMap.set(key, [ref]);
      }
    }
  });

  private readLine = async ({ offset, length }: LineRef): Promise<Article> => {
    const DATASET_PATH = getDatasetPath();
    const handle = await open(DATASET_PATH, "r");
    try {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          length - total,
          offset + total,
        );
        if (!bytesRead) {
          throw new Error(
            `Dataset: unexpected EOF at offset ${offset + total}`,
          );
        }
        total += bytesRead;
      }
      return JSON.parse(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  };

  private readDay = async (key: DateKey): Promise<Article[]> => {
    const cached = this._cacheMap.get(key);
    if (cached) {
      return cached;
    }
    const articles: Article[] = [];
    for (const ref of this._indexMap.get(key) ?? []) {
      articles.push(await this.readLine(ref));
    }
    this._cacheMap.set(key, articles);
    return articles;
  };

  public getArticle = async (when: Date): Promise<Article | null> => {
    await this.waitForInit();
    // Корзины текущего и предыдущего дня: окно свежести переживает полночь,
    // предыдущий день целиком в прошлом - look ahead не появляется
    const dayBefore = new Date(when.getTime() - 24 * 60 * 60 * 1000);
    const keys = [toDateKey(dayBefore), toDateKey(when)];
    const articles = [
      ...(await this.readDay(keys[0])),
      ...(await this.readDay(keys[1])),
    ];
    // В памяти остаются только эти два дня: при переходе через полночь
    // вчерашний уже прочитан, позавчерашний выгружается
    for (const key of this._cacheMap.keys()) {
      if (!keys.includes(key)) {
        this._cacheMap.delete(key);
      }
    }
    if (!articles.length) {
      return null;
    }
    // Без look ahead bias: берем только обзоры, опубликованные не позже when
    const published = articles.filter(
      (article) => new Date(article.publishedAt).getTime() <= when.getTime(),
    );
    if (!published.length) {
      return null;
    }
    // Последний по времени публикации
    return published.reduce((a, b) =>
      new Date(a.publishedAt).getTime() >= new Date(b.publishedAt).getTime()
        ? a
        : b,
    );
  };
}

export const Dataset = new DatasetUtils();
