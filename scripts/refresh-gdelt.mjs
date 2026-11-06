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

const conflicts = validateConflictDocument(await readJson(conflictsPath));
const conflictIds = conflicts.items.map((conflict) => conflict.id);
const current = validateNewsDocument(await readJson(newsPath), conflictIds);
const config = await readJson(queryConfigPath);
validateGdeltConfig(config, conflicts.items);

let successfulQueries = 0;
let requestNumber = 0;
const requestDelayMs = Number(process.env.GDELT_REQUEST_DELAY_MS ?? config.gdelt_request_delay_ms);
const entries = await mapWithConcurrency(
  conflicts.items,
  config.gdelt_concurrency,
  async (conflict) => {
    if (requestNumber++ > 0 && requestDelayMs > 0) await delay(requestDelayMs);
    let discovered = [];
    try {
      discovered = await fetchGdeltArticles({
        attempts: config.gdelt_max_attempts,
        match: config.matches[conflict.id],
        maxArticles: config.gdelt_max_articles,
        maxRecords: config.gdelt_max_records,
        query: config.queries[conflict.id],
        timespan: config.gdelt_timespan,
        timeoutMs: config.request_timeout_ms,
      });
      successfulQueries += 1;
    } catch (error) {
      console.warn(`${conflict.id}: GDELT unavailable; retaining existing articles (${error.message})`);
    }
    const merged = mergeArticles(current.items[conflict.id] ?? [], discovered, config.max_articles);
    console.log(`${conflict.id}: ${discovered.length} GDELT, ${merged.length} combined article(s)`);
    return [conflict.id, merged];
  },
);

if (successfulQueries === 0) {
  throw new Error("GDELT refresh failed for every configured conflict; existing snapshot retained");
}

const providers = new Set(
  String(current.provider)
    .split("+")
    .map((provider) => provider.trim())
    .filter(Boolean),
);
providers.add("GDELT");

const snapshot = validateNewsDocument(
  {
    generated_at: new Date().toISOString(),
    provider: [...providers].join(" + "),
    sample: false,
    items: Object.fromEntries(entries),
  },
  conflictIds,
);

await writeJsonAtomic(newsPath, snapshot);
console.log(`Published ${Object.values(snapshot.items).flat().length} combined article(s) to data/news.json.`);

async function fetchGdeltArticles({ attempts, match, maxArticles, maxRecords, query, timespan, timeoutMs }) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.search = new URLSearchParams({
    query: toGdeltQuery(query),
    mode: "artlist",
    format: "json",
    sort: "datedesc",
    maxrecords: String(maxRecords),
    timespan,
  }).toString();

  let response;
  let payload;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    payload = await response.json().catch(() => null);
    if (response.ok && Array.isArray(payload?.articles)) break;
    if (attempt === attempts || (response.status !== 429 && response.status < 500)) {
      throw new Error(`GDELT request failed with HTTP ${response.status}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 5000);
  }

  const seen = new Set();
  const candidates = [];

  for (const article of payload.articles) {
    const title = cleanText(article?.title);
    const articleUrl = cleanText(article?.url);
    const normalizedUrl = normalizeUrl(articleUrl);
    const source = cleanText(article?.domain) || hostname(articleUrl);

    if (!title || !normalizedUrl || !source || seen.has(normalizedUrl)) {
      continue;
    }
    if (!headlineMatches(title, match)) {
      continue;
    }

    seen.add(normalizedUrl);
    const publishedAt = parseGdeltDate(article?.seendate);
    candidates.push({
      publishedAt: publishedAt ?? "",
      item: {
        title,
        url: articleUrl,
        source,
        provider: "GDELT",
        ...(publishedAt ? { published_at: publishedAt } : {}),
        ...(cleanText(article?.language) ? { language: cleanText(article.language) } : {}),
        ...(cleanText(article?.sourcecountry)
          ? { source_country: cleanText(article.sourcecountry) }
          : {}),
      },
    });
  }

  return candidates
    .sort((first, second) => second.publishedAt.localeCompare(first.publishedAt))
    .slice(0, maxArticles)
    .map((candidate) => candidate.item);
}

function mergeArticles(existing, discovered, maximum) {
  const seenUrls = new Set();
  const seenTitles = new Set();

  return [...existing, ...discovered]
    .sort((first, second) =>
      String(second.published_at ?? "").localeCompare(String(first.published_at ?? "")),
    )
    .filter((article) => {
      const url = normalizeUrl(article.url);
      const title = cleanText(article.title).toLowerCase();
      if (!url || !title || seenUrls.has(url) || seenTitles.has(title)) {
        return false;
      }
      seenUrls.add(url);
      seenTitles.add(title);
      return true;
    })
    .slice(0, maximum);
}

function headlineMatches(title, match) {
  const normalizedTitle = title.toLowerCase();
  const terms = Array.isArray(match?.headline_any) ? match.headline_any : [];
  return terms.some(
    (term) => typeof term === "string" && normalizedTitle.includes(term.toLowerCase()),
  );
}

function validateGdeltConfig(config, conflictItems) {
  for (const key of ["max_articles", "gdelt_max_records", "gdelt_max_articles", "gdelt_concurrency", "gdelt_request_delay_ms", "gdelt_max_attempts", "request_timeout_ms"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  if (typeof config.gdelt_timespan !== "string" || !/^\d+[hdwmy]$/i.test(config.gdelt_timespan)) {
    throw new Error("gdelt_timespan must look like 24h, 7d, or 1m");
  }
  for (const conflict of conflictItems) {
    if (!config.queries?.[conflict.id] || !config.matches?.[conflict.id]?.headline_any?.length) {
      throw new Error(`Missing GDELT query configuration for ${conflict.id}`);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function toGdeltQuery(query) {
  return String(query).replace(/\s+AND\s+/gi, " ").replace(/\s+/g, " ").trim();
}

function parseGdeltDate(value) {
  const match = String(value ?? "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function resolveInputPath(environmentPath, fallbackUrl) {
  return environmentPath ? resolve(environmentPath) : fileURLToPath(fallbackUrl);
}
