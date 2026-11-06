import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  validateConflictDocument,
  validateNewsDocument,
} from "./lib/data-contract.mjs";
import { writeJsonAtomic } from "./lib/write-json-atomic.mjs";

const conflictsPath = resolveInputPath(
  process.env.CONFLICTS_DATA_PATH,
  new URL("../data/conflicts.json", import.meta.url),
);
const newsPath = resolveInputPath(
  process.env.NEWS_OUTPUT_PATH,
  new URL("../data/news.json", import.meta.url),
);
const queryConfigPath = resolveInputPath(
  process.env.NEWS_QUERY_CONFIG_PATH,
  new URL("../config/news-queries.json", import.meta.url),
);
const apiKey = process.env.NEWS_API_KEY?.trim();

if (!apiKey) {
  throw new Error("NEWS_API_KEY is required. The existing news snapshot was left unchanged.");
}

const conflicts = validateConflictDocument(await readJson(conflictsPath));
const config = await readJson(queryConfigPath);
validateRefreshConfig(config, conflicts.items);

const from = new Date(Date.now() - config.lookback_days * 24 * 60 * 60 * 1000).toISOString();
const entries = await mapWithConcurrency(
  conflicts.items,
  config.concurrency,
  async (conflict) => {
    const articles = await fetchArticles({
      apiKey,
      from,
      match: config.matches[conflict.id],
      maxArticles: config.max_articles,
      pageSize: config.page_size,
      query: config.queries[conflict.id],
      timeoutMs: config.request_timeout_ms,
    });
    console.log(`${conflict.id}: ${articles.length} article(s)`);
    return [conflict.id, articles];
  },
);

const snapshot = validateNewsDocument(
  {
    generated_at: new Date().toISOString(),
    provider: config.provider,
    sample: false,
    items: Object.fromEntries(entries),
  },
  conflicts.items.map((conflict) => conflict.id),
);

await writeJsonAtomic(newsPath, snapshot);
console.log(`Published ${Object.values(snapshot.items).flat().length} validated article(s) to data/news.json.`);

async function fetchArticles({ apiKey, from, match, maxArticles, pageSize, query, timeoutMs }) {
  const url = new URL("https://newsapi.org/v2/everything");
  url.search = new URLSearchParams({
    q: query,
    from,
    language: "en",
    sortBy: "publishedAt",
    pageSize: String(pageSize),
    page: "1",
  }).toString();

  const response = await fetch(url, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== "ok" || !Array.isArray(payload.articles)) {
    const providerMessage = typeof payload?.message === "string" ? `: ${payload.message}` : "";
    throw new Error(`NewsAPI request failed with HTTP ${response.status}${providerMessage}`);
  }

  const seenUrls = new Set();
  const candidates = [];

  for (const article of payload.articles) {
    const title = cleanText(article?.title);
    const source = cleanText(article?.source?.name);
    const articleUrl = cleanText(article?.url);
    const titleText = title.toLowerCase();
    const searchText = `${title} ${cleanText(article?.description)} ${cleanText(article?.content)}`.toLowerCase();

    if (!title || title === "[Removed]" || !source || !articleUrl || seenUrls.has(articleUrl)) {
      continue;
    }
    if (!isRelevantMatch(titleText, searchText, match)) {
      continue;
    }

    seenUrls.add(articleUrl);
    candidates.push({
      relevance: relevanceScore(titleText, searchText, match),
      publishedAt: typeof article.publishedAt === "string" ? article.publishedAt : "",
      item: {
        title,
        url: articleUrl,
        source,
        ...(typeof article.publishedAt === "string" ? { published_at: article.publishedAt } : {}),
      },
    });
  }

  return candidates
    .sort(
      (first, second) =>
        second.relevance - first.relevance || second.publishedAt.localeCompare(first.publishedAt),
    )
    .slice(0, maxArticles)
    .map((candidate) => candidate.item);
}

function validateRefreshConfig(config, conflicts) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("config/news-queries.json must contain an object");
  }

  const positiveIntegers = [
    "lookback_days",
    "page_size",
    "max_articles",
    "concurrency",
    "request_timeout_ms",
  ];
  for (const key of positiveIntegers) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }

  if (typeof config.provider !== "string" || config.provider.trim() === "") {
    throw new Error("provider must be a non-empty string");
  }

  for (const conflict of conflicts) {
    if (typeof config.queries?.[conflict.id] !== "string" || config.queries[conflict.id].trim() === "") {
      throw new Error(`Missing news query for ${conflict.id}`);
    }
    const match = config.matches?.[conflict.id];
    if (
      !match ||
      (!Array.isArray(match.all) && !Array.isArray(match.any)) ||
      !Array.isArray(match.headline_any) ||
      match.headline_any.length === 0
    ) {
      throw new Error(`Missing relevance match configuration for ${conflict.id}`);
    }
  }
}

function isRelevantMatch(titleText, searchText, match) {
  const allTerms = normalizeTerms(match?.all);
  const anyTerms = normalizeTerms(match?.any);
  const headlineTerms = normalizeTerms(match?.headline_any);
  const includesAll = allTerms.every((term) => searchText.includes(term));
  const includesAny = anyTerms.length === 0 || anyTerms.some((term) => searchText.includes(term));
  const includesHeadline = headlineTerms.some((term) => titleText.includes(term));
  return includesAll && includesAny && includesHeadline;
}

function relevanceScore(titleText, searchText, match) {
  const allTerms = normalizeTerms(match?.all);
  const anyTerms = normalizeTerms(match?.any);
  const headlineTerms = normalizeTerms(match?.headline_any);
  const bodyScore = [...allTerms, ...anyTerms].reduce(
    (score, term) => score + (searchText.includes(term) ? term.length : 0),
    0,
  );
  const headlineScore = headlineTerms.reduce(
    (score, term) => score + (titleText.includes(term) ? term.length * 3 : 0),
    0,
  );
  return bodyScore + headlineScore;
}

function normalizeTerms(terms) {
  return Array.isArray(terms)
    ? terms.filter((term) => typeof term === "string" && term.trim()).map((term) => term.toLowerCase())
    : [];
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function resolveInputPath(environmentPath, fallbackUrl) {
  return environmentPath ? resolve(environmentPath) : fileURLToPath(fallbackUrl);
}
