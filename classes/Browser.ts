import { CANCELED_PROMISE_SYMBOL, queued, singleshot, sleep } from "functools-kit";
import { chromium, type BrowserContext, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
import { randomUUID } from "crypto";
import { join, resolve as resolvePath } from "path";
import { get } from "lodash-es";

/** Профиль Chromium с сессией сайта: создаётся signIn, переиспользуется getArticle */
const PROFILE_ASSETS_PATH = "./.era-profile";
const ROOT_PATH_SYMBOL = Symbol.for("root_path");

const getProfilePath = singleshot(() => {
  if (ROOT_PATH_SYMBOL in globalThis) {
    const rootPath = get(globalThis, ROOT_PATH_SYMBOL);
    return join(rootPath, PROFILE_ASSETS_PATH);
  }
  return PROFILE_ASSETS_PATH;
});

const BASE_URL = "https://eraperemen.info/";
const FEED_URL = "https://eraperemen.info/crypto-markets";
const LOGIN_URL = "https://eraperemen.info/login";
const ACCOUNT_URL = "https://eraperemen.info/account";

const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1440, height: 900 };

const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;
const SIGN_IN_POLL_MS = 3_000;
const PAGE_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 20_000;

const ROLE = "user";
const DATE_FORMAT = "dd.mm.yyyy";
/** На странице нет времени публикации, только дата; полночь в часовом поясе сайта, как в wwwroot.jsonl */
const SITE_TZ_OFFSET = "+03:00";
/**
 * Любая картинка тяжелее порога отсекается, обложка тоже. Обложка обычно это фото
 * на ~2 МБ без аналитической ценности, графики в wwwroot.jsonl от 6 до 978 КБ.
 */
const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_CACHE_SIZE = 200;

type Message = Article["messages"][number];
type LoadImage = (url: string) => Promise<Buffer>;

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

/* ------------------------------------------------------------------ утилиты */

const launchContext = (headless: boolean) => {
    const PROFILE_PATH = getProfilePath();
    return chromium.launchPersistentContext(resolvePath(PROFILE_PATH), {
        headless,
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
    });
}

/** Признак активной сессии: личный кабинет отдаёт свой заголовок, аноним получает страницу входа */
const isSignedIn = async (context: BrowserContext): Promise<boolean> => {
    const response = await context.request.get(ACCOUNT_URL, { timeout: PAGE_TIMEOUT_MS, failOnStatusCode: false });
    return /<title>[^<]*Мой кабинет/.test(await response.text());
};

/** Загружает страницу и отдаёт HTML после того, как дорисовался клиентский код */
const fetchHtml = async (page: Page, url: string): Promise<string> => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    const status = response?.status() ?? 0;
    if (status >= 400) {
        throw new Error(`Browser: HTTP ${status} for ${url}`);
    }
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
    return await page.content();
};

/** Картинка слишком большая: вызывающий пропускает её, а не роняет статью */
class ImageTooLarge extends Error {}

/**
 * Картинка байтами через запросы контекста: идут с куками сессии и тем же User-Agent.
 * Размер сначала спрашивается HEAD-запросом, чтобы обложку не качать вовсе.
 */
const loadImage = async (context: BrowserContext, url: string): Promise<Buffer> => {
    const head = await context.request.head(url, { failOnStatusCode: false }).catch(() => null);
    const declared = Number(head?.headers()["content-length"] ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
        throw new ImageTooLarge(url);
    }
    const response = await context.request.get(url, { failOnStatusCode: false });
    if (!response.ok()) {
        throw new Error(`Browser: image ${response.status()}: ${url}`);
    }
    const bytes = await response.body();
    if (!bytes.length) {
        throw new Error(`Browser: empty image body: ${url}`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
        throw new ImageTooLarge(url);
    }
    return bytes;
};

/* ------------------------------------------------------------------ текст */

const squash = (s: string): string => s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();

const resolveUrl = (href: string, base: string): string => {
    try {
        return new URL(href, base).toString();
    } catch {
        return href;
    }
};

/** Строчная разметка в markdown: ссылки, жирный, курсив, переносы */
const inline = ($: CheerioAPI, el: Cheerio<AnyNode>, base: string): string => {
    let out = "";
    el.contents().each((_, node) => {
        const type = node.type as string;
        if (type === "text") {
            out += (node as Text).data ?? "";
            return;
        }
        if (type !== "tag") {
            return;
        }
        const $n = $(node);
        const tag = (node as Element).tagName.toLowerCase();
        if (tag === "br") {
            out += "\n";
        } else if (tag === "a") {
            const text = squash(inline($, $n, base)).replace(/^\[(.*)\]$/, "$1"); // "[S07]" -> "S07"
            const href = $n.attr("href");
            out += href && text ? `[${text}](${resolveUrl(href, base)})` : text;
        } else if (tag === "strong" || tag === "b") {
            const t = squash(inline($, $n, base));
            out += t ? `**${t}**` : "";
        } else if (tag === "em" || tag === "i") {
            const t = squash(inline($, $n, base));
            out += t ? `*${t}*` : "";
        } else if (tag === "img" || tag === "script" || tag === "style") {
            /* картинки обрабатываются на уровне блоков */
        } else {
            out += inline($, $n, base);
        }
    });
    return out;
};

const list = ($: CheerioAPI, el: Cheerio<Element>, base: string): string => {
    const ordered = el.is("ol");
    return el
        .children("li")
        .map((i, li) => `${ordered ? `${i + 1}.` : "-"} ${squash(inline($, $(li), base))}`)
        .get()
        .join("\n");
};

const table = ($: CheerioAPI, el: Cheerio<Element>, base: string): string => {
    const rows: string[][] = [];
    el.find("tr").each((_, tr) => {
        rows.push(
            $(tr)
                .children("th,td")
                .map((__, c) => squash(inline($, $(c), base)).replace(/\|/g, "\\|").replace(/\n/g, " "))
                .get(),
        );
    });
    if (!rows.length) {
        return "";
    }
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
};

/* ------------------------------------------------------------------ картинки */

const imageCache = new Map<string, string>();

const imgSrc = ($img: Cheerio<Element>): string | undefined => {
    const srcset = $img.attr("data-srcset") || $img.attr("srcset");
    const biggest = srcset
        ?.split(",")
        .map((s) => s.trim().split(/\s+/))
        .sort((a, b) => parseInt(b[1] || "0") - parseInt(a[1] || "0"))[0]?.[0];
    return $img.attr("data-src") || $img.attr("data-lazy-src") || $img.attr("src") || biggest;
};

/** Картинка в raw base64 без data:-префикса, как в wwwroot.jsonl */
const toBase64 = async (url: string, loadImage: LoadImage): Promise<string> => {
    if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        if (comma < 0) {
            throw new Error(`Browser: malformed data URL: ${url.slice(0, 64)}…`);
        }
        const payload = url.slice(comma + 1);
        const data = /;base64/i.test(url.slice(5, comma))
            ? payload.replace(/\s+/g, "")
            : Buffer.from(decodeURIComponent(payload), "binary").toString("base64");
        if (Buffer.byteLength(data, "base64") > MAX_IMAGE_BYTES) {
            throw new ImageTooLarge(url);
        }
        return data;
    }
    const hit = imageCache.get(url);
    if (hit) {
        return hit;
    }
    const data = (await loadImage(url)).toString("base64");
    if (imageCache.size >= IMAGE_CACHE_SIZE) {
        imageCache.clear();
    }
    imageCache.set(url, data);
    return data;
};

const toBase64OrSkip = async (url: string, loadImage: LoadImage): Promise<string | undefined> => {
    try {
        return await toBase64(url, loadImage);
    } catch (error) {
        if (error instanceof ImageTooLarge) {
            // data:-адрес это сам payload, в лог идёт только его начало
            console.warn(`Browser: картинка больше ${MAX_IMAGE_BYTES / 1024 / 1024} МБ пропущена: ${url.slice(0, 96)}${url.length > 96 ? "…" : ""}`);
            return undefined;
        }
        throw error;
    }
};

/* ------------------------------------------------------------------ накопитель сообщений */

/**
 * Собирает блоки в сообщения. `text` и `images` это сообщение, которое строится;
 * `hasBody` показывает, попало ли в него что-то кроме заголовка: тогда следующая
 * картинка начинает новое сообщение, а не встаёт перед уже набранным текстом.
 */
interface Draft {
    messages: Message[];
    text: string[];
    images: string[];
    hasBody: boolean;
}

const newDraft = (): Draft => ({ messages: [], text: [], images: [], hasBody: false });

const flush = (d: Draft): void => {
    const content = d.text.join("\n\n").trim();
    if (content || d.images.length) {
        const message: Message = { role: ROLE, content };
        if (d.images.length) {
            message.images = [...d.images];
        }
        d.messages.push(message);
    }
    d.text = [];
    d.images = [];
    d.hasBody = false;
};

const addHeading = (d: Draft, md: string, newMessage: boolean): void => {
    if (newMessage) {
        flush(d);
    }
    d.text.push(md);
};

const addBody = (d: Draft, md: string): void => {
    if (!md.trim()) {
        return;
    }
    d.text.push(md);
    d.hasBody = true;
};

const addImage = (d: Draft, data: string): void => {
    // текст, набранный до картинки, остаётся в предыдущем сообщении
    if (d.hasBody) {
        flush(d);
    }
    d.images.push(data);
};

/* ------------------------------------------------------------------ дата публикации */

const isoToDdMmYyyy = (iso: string): string | undefined => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : undefined;
};

/** "01.10.2026" -> "2026-10-01T00:00:00+03:00" */
const ddMmYyyyToIso = (when: string): string => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(when);
    if (!m) {
        throw new Error(`Browser: дата не в формате ${DATE_FORMAT}: ${when}`);
    }
    return `${m[3]}-${m[2]}-${m[1]}T00:00:00${SITE_TZ_OFFSET}`;
};

/**
 * Дата публикации как dd.mm.yyyy. По порядку: time[datetime] в шапке статьи,
 * любой time[datetime] в статье, видимый текст бейджа, дата из slug адреса.
 */
const publishedAt = ($: CheerioAPI, article: Cheerio<Element>, pageUrl: string): string | undefined => {
    for (const sel of ["header.article-head time[datetime]", "time[datetime]"]) {
        const when = isoToDdMmYyyy(article.find(sel).first().attr("datetime") ?? "");
        if (when) {
            return when;
        }
    }
    const badge = squash(article.find("header.article-head .era-badges, .era-post__date").text());
    const shown = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.exec(badge);
    if (shown) {
        return `${shown[1]}.${shown[2]}.${shown[3]}`;
    }
    const slug = /(\d{2})-(\d{2})-(\d{4})(?:$|[^\d])/.exec(pageUrl);
    if (slug) {
        return `${slug[1]}.${slug[2]}.${slug[3]}`;
    }
    return undefined;
};

/* ------------------------------------------------------------------ парсер */

const walk = async ($: CheerioAPI, container: Cheerio<AnyNode>, d: Draft, pageUrl: string, loadImage: LoadImage): Promise<void> => {
    for (const node of container.children().toArray()) {
        const el = $(node);
        const tag = node.tagName.toLowerCase();

        if (el.hasClass("era-preview")) {
            continue; // скрытый тизер
        }
        if (el.is("script, style, noscript, button, .article-speech, details.disclaimer")) {
            continue;
        }
        if (el.is("section.era-sources")) {
            flush(d);
            await walk($, el, d, pageUrl, loadImage);
            continue;
        }
        if (tag === "h1" || tag === "h2") {
            addHeading(d, `## ${squash(el.text())}`, true);
            continue;
        }
        if (/^h[3-6]$/.test(tag)) {
            addHeading(d, `${"#".repeat(Number(tag[1]))} ${squash(el.text())}`, false);
            continue;
        }
        if (tag === "table") {
            addBody(d, table($, el, pageUrl));
            continue;
        }
        if (tag === "ul" || tag === "ol") {
            addBody(d, list($, el, pageUrl));
            continue;
        }

        // блок с картинками: div > img, figure > img, p > img
        const imgs = el.is("img") ? el : el.find("img");
        if (imgs.length) {
            for (const img of imgs.toArray()) {
                const src = imgSrc($(img));
                if (!src) {
                    continue;
                }
                const data = await toBase64OrSkip(resolveUrl(src, pageUrl), loadImage);
                if (data) {
                    addImage(d, data);
                }
            }
            const caption = squash(el.find("figcaption").text());
            if (caption) {
                addBody(d, `*${caption}*`);
            }
            continue;
        }

        // вложенные обёртки: div с блоками внутри
        if ((tag === "div" || tag === "section") && el.children("p,h2,h3,ul,ol,table,div,figure").length) {
            await walk($, el, d, pageUrl, loadImage);
            continue;
        }

        addBody(d, squash(inline($, el, pageUrl)));
    }
};

export interface ParseOptions {
    /** Адрес страницы для относительных ссылок, если в разметке нет canonical */
    pageUrl?: string;
    /** Картинка байтами по абсолютному адресу; ImageTooLarge пропускает её, остальные ошибки роняют статью */
    loadImage: LoadImage;
}

/** Первая статья ленты: карточки article.pcard идут от самой свежей */
export const firstArticleUrl = (html: string, base: string): string => {
    const $ = cheerio.load(html);
    const href = $(".era-feed article a[href], article.pcard a[href]").first().attr("href");
    if (!href) {
        throw new Error(`Browser: в ленте ${base} не найдено ни одной статьи`);
    }
    return resolveUrl(href, base);
};

/**
 * HTML статьи -> запись в формате wwwroot.jsonl.
 *
 * Стандарт строки, снятый со всех 698 записей датасета:
 *   messages[0].content   "# Обзор рынка криптовалют dd.mm.yyyy" + пустая строка +
 *                         "Дата: dd.mm.yyyy", "Рубрика: <бейдж>" (если есть), "Источник: <canonical>";
 *                         если тело начинается с таблицы метрик, она идёт в это же сообщение
 *   messages[0].images    обложка, если она легче 1 МБ; обычно тяжелее и отсекается,
 *                         поэтому в датасете первое сообщение без картинок у 696 записей из 698
 *   остальные сообщения   каждый h2 открывает новое сообщение ("## ..."), h3 остаётся внутри ("### ...");
 *                         картинка после текста открывает новое сообщение, поэтому images
 *                         всегда стоят перед content, а картинка перед h2 даёт сообщение без текста
 *   section.era-sources   отдельное сообщение "## Источники и время данных" со списком ссылок
 *   images[]              raw base64 без data:-префикса, до 1 МБ каждая
 *   publishedAt           полночь даты обзора в UTC+3
 *
 * Разметка (проверена на «Обзор рынка криптовалют 02.10.2026»):
 *   article
 *     header.article-head      p.era-badges (рубрика + dd.mm.yyyy), h1
 *     p.article-cover > img    обложка                  -> images[] при размере до 1 МБ
 *     div.article-body         содержимое по порядку:
 *        p.era-preview         скрытый тизер            -> пропускается
 *        table                 таблица метрик           -> markdown-таблица
 *        h2 / h3               разделы / новости        -> ## / ###
 *        div > img[alt]        графики                  -> images[]
 *        p / ul                текст, <a>[S07]</a>, <strong>
 *        section.era-sources   источники
 *     div.article-speech, details.disclaimer            -> пропускаются
 *
 * У анонима тело статьи пустое и скрыто (hidden), это признак пейволла.
 */
export const parseArticle = async (html: string, options: ParseOptions): Promise<Article> => {
    const $ = cheerio.load(html);
    const pageUrl = $('link[rel="canonical"]').attr("href") || options.pageUrl || BASE_URL;

    const article = $("article").first();
    if (!article.length) {
        throw new Error(`Browser: на странице нет <article>: ${pageUrl}`);
    }
    const body = article.find(".article-body").first();
    if (!body.length) {
        throw new Error(`Browser: нет .article-body, разметка изменилась: ${pageUrl}`);
    }
    if (body.attr("hidden") !== undefined || !body.children().length) {
        const signedOut = $("a").filter((_, a) => squash($(a).text()) === "Войти").length > 0;
        throw new Error(
            signedOut
                ? `Browser: тело статьи скрыто, сессия не авторизована, выполните Browser.signIn(): ${pageUrl}`
                : `Browser: тело статьи пустое, у аккаунта нет доступа к материалу: ${pageUrl}`,
        );
    }

    const d = newDraft();

    // шапка: заголовок, обложка, мета-строки. Обложка проходит общий порог размера:
    // фото тяжелее 1 МБ отсекается, лёгкая остаётся картинкой первого сообщения
    addHeading(d, `# ${squash(article.find("header.article-head h1, h1").first().text())}`, true);
    const cover = article.find(".article-cover img").first();
    const coverSrc = cover.length ? imgSrc(cover) : undefined;
    if (coverSrc) {
        const data = await toBase64OrSkip(resolveUrl(coverSrc, pageUrl), options.loadImage);
        if (data) {
            addImage(d, data);
        }
    }

    const when = publishedAt($, article, pageUrl);
    if (!when) {
        throw new Error(`Browser: не найдена дата публикации: ${pageUrl}`);
    }
    const badges = squash(article.find("header.article-head .era-badges").text());
    const category = squash(badges.replace(/\b\d{2}\.\d{2}\.\d{4}\b/, ""));
    addBody(d, [`Дата: ${when}`, category && `Рубрика: ${category}`, `Источник: ${pageUrl}`].filter(Boolean).join("\n"));

    await walk($, body, d, pageUrl, options.loadImage);
    flush(d);

    return {
        id: randomUUID(),
        when,
        format: DATE_FORMAT,
        publishedAt: ddMmYyyyToIso(when),
        messages: d.messages,
    };
};

const readArticle = queued(async (self: BrowserUtils, url?: string): Promise<Article> => {
    const context = await self["getContext"]();
    const page = await context.newPage();
    try {
        const target = url ?? firstArticleUrl(await fetchHtml(page, FEED_URL), FEED_URL);
        const html = await fetchHtml(page, target);
        return await parseArticle(html, {
            pageUrl: page.url(),
            loadImage: (src) => loadImage(context, src),
        });
    } finally {
        await page.close();
    }
});

/* ------------------------------------------------------------------ браузер */

export class BrowserUtils {

    private _context: BrowserContext | null = null;

    /** Headless-контекст для getArticle: один на процесс, профиль общий с signIn */
    private getContext = singleshot(async () => {
        const context = await launchContext(true);
        context.on("close", () => {
            this._context = null;
            this.getContext.clear();
        });
        this._context = context;
        return context;
    });

    /**
     * Открывает Chromium в оконном режиме на странице входа и ждёт, пока сессия
     * не станет активной. Вход выполняется вручную: сайт подтверждает его письмом,
     * ссылку из письма нужно открыть в этом же окне. Сессия остаётся в PROFILE_DIR.
     */
    public signIn = async (): Promise<void> => {
        // Профиль один, два Chromium на нём не живут: закрываем headless, если getArticle его уже открыл
        if (this._context) {
            await this._context.close();
        }
        const context = await launchContext(false);
        try {
            if (await isSignedIn(context)) {
                console.log("Browser: сессия уже активна, вход не требуется");
                return;
            }
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
            console.log("Browser: войдите на eraperemen.info в открывшемся окне. Ссылку из письма откройте в этом же окне.");
            const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
            while (Date.now() < deadline) {
                await sleep(SIGN_IN_POLL_MS);
                if (!context.pages().length) {
                    throw new Error("Browser: окно закрыто до завершения входа");
                }
                if (await isSignedIn(context)) {
                    const PROFILE_PATH = getProfilePath();
                    console.log(`Browser: вход выполнен, сессия сохранена в ${PROFILE_PATH}`);
                    return;
                }
            }
            throw new Error(`Browser: вход не выполнен за ${SIGN_IN_TIMEOUT_MS / 60_000} минут`);
        } finally {
            await context.close();
        }
    };

    /**
     * Статья в формате записи wwwroot.jsonl. Без аргумента берётся первая статья
     * ленты FEED_URL, то есть самая свежая. Вызовы выполняются по одному: профиль
     * один, страница одна за раз.
     */
    public getArticle = async (url?: string): Promise<Article> => {
        const article = await readArticle(this, url);
        if (article === CANCELED_PROMISE_SYMBOL) {
            throw new Error("Browser: getArticle отменён");
        }
        return article;
    };
}

export const Browser = new BrowserUtils();
