// Запуск: CRAWLER_UA="my-research/1.0 (+mailto:you@example.com)" node scripts/fetch_investinglive.mjs
// Перед запуском проверьте условия использования investinglive.com.
import * as cheerio from "cheerio";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, readFileSync } from "fs";

const ORIGIN = "https://investinglive.com";
const TAGS = ["bitcoin-technical-analysis", "crypto-technical-analysis"];
const OUT_PATH = "./assets/investinglive.jsonl";
const DELAY_MS = 5000;

const USER_AGENT = "my-research/1.0 (+mailto:backtest@you.com)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getText = async (url) => {
  await sleep(DELAY_MS);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (response.status === 429 || response.status === 403) {
    throw new Error(`${url}: HTTP ${response.status}, сборщик остановлен`);
  }
  return response.ok ? response.text() : null;
};

/** Правила для `*`: сборщик представляется своим именем, а не именем чужого бота */
const getDisallowed = async () => {
  const text = (await getText(`${ORIGIN}/robots.txt`)) ?? "";
  const rules = [];
  let isGlobal = false;
  for (const line of text.split("\n")) {
    const [key, ...rest] = line.split("#")[0].split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key.trim())) {
      isGlobal = value === "*";
    } else if (isGlobal && /^disallow$/i.test(key.trim()) && value) {
      rules.push(value);
    }
  }
  return rules;
};

const isAllowed = (url, rules) => {
  const path = new URL(url).pathname.toLowerCase();
  return !rules.some((rule) => {
    const source = rule.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${source}`).test(path);
  });
};

const getLinks = (html) => {
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href]").each((_, element) => {
    const url = new URL($(element).attr("href"), ORIGIN);
    if (/^\/cryptocurrency\/[^/]+\/?$/i.test(url.pathname)) {
      links.add(`${ORIGIN}${url.pathname}`);
    }
  });
  return [...links];
};

const getJsonLd = ($) => {
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(element).text());
      const items = Array.isArray(data) ? data : (data["@graph"] ?? [data]);
      const article = items.find((item) => /Article/.test(String(item["@type"])));
      if (article) {
        return article;
      }
    } catch {
      continue;
    }
  }
  return {};
};

const parseArticle = (html, url) => {
  const $ = cheerio.load(html);
  const jsonLd = getJsonLd($);
  const published = jsonLd.datePublished ?? $('meta[property="article:published_time"]').attr("content");
  const title = jsonLd.headline ?? $("h1").first().text().trim();
  const body = jsonLd.articleBody ?? $("article p").toArray().map((element) => $(element).text().trim()).join("\n\n");
  if (!published || !body) {
    console.warn(`${url}: нет даты или текста, статья пропущена`);
    return null;
  }
  const date = new Date(published);
  const when = [date.getUTCDate(), date.getUTCMonth() + 1]
    .map((value) => String(value).padStart(2, "0"))
    .concat(date.getUTCFullYear())
    .join(".");
  return {
    id: randomUUID(),
    when,
    format: "dd.mm.yyyy",
    publishedAt: date.toISOString(),
    url,
    author: jsonLd.author?.name ?? null,
    messages: [{ role: "user", content: `# ${title}\n\nИсточник: ${url}\n\n${body}` }],
  };
};

const seen = new Set(
  existsSync(OUT_PATH)
    ? readFileSync(OUT_PATH, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).url)
    : [],
);
const rules = await getDisallowed();

for (const tag of TAGS) {
  for (let page = 1; ; page++) {
    const pageUrl = `${ORIGIN}/Tag/${tag}/${page > 1 ? `page/${page}/` : ""}`;
    if (!isAllowed(pageUrl, rules)) {
      throw new Error(`${pageUrl}: запрещено robots.txt`);
    }
    const html = await getText(pageUrl);
    const links = html ? getLinks(html) : [];
    if (!links.length) {
      break;
    }
    for (const url of links) {
      if (seen.has(url) || !isAllowed(url, rules)) {
        continue;
      }
      seen.add(url);
      const article = await getText(url);
      const record = article && parseArticle(article, url);
      if (record) {
        appendFileSync(OUT_PATH, `${JSON.stringify(record)}\n`);
        console.log(record.publishedAt, url);
      }
    }
  }
}
