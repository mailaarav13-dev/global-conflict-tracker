import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, validateBriefingDocument } from "./lib/data-contract.mjs";
import { writeJsonAtomic } from "./lib/write-json-atomic.mjs";

const outputPath = resolveInputPath(
  process.env.BRIEFING_OUTPUT_PATH,
  new URL("../data/briefings.json", import.meta.url),
);
const configPath = resolveInputPath(
  process.env.BRIEFING_CONFIG_PATH,
  new URL("../config/briefing-topics.json", import.meta.url),
);

const config = await readJson(configPath);
validateConfig(config);
const topicIds = Object.keys(config.topics);
const current = validateBriefingDocument(await readJson(outputPath), topicIds);
const delayMs = Number(process.env.BRIEFING_REQUEST_DELAY_MS ?? config.request_delay_ms);
let successfulQueries = 0;
const entries = [];

for (const [index, topicId] of topicIds.entries()) {
  if (index > 0 && delayMs > 0) await delay(delayMs);
  const topic = config.topics[topicId];
  let discovered = [];
  try {
    discovered = await fetchGdeltArticles(topic, config);
    if (discovered.length === 0) {
      discovered = await fetchGoogleNewsArticles(topic, config);
    }
    successfulQueries += 1;
  } catch (error) {
    try {
      discovered = await fetchGoogleNewsArticles(topic, config);
      successfulQueries += 1;
    } catch (fallbackError) {
      console.warn(`${topicId}: briefing sources unavailable; retaining existing articles (${error.message}; ${fallbackError.message})`);
    }
  }
  const merged = mergeArticles(current.items[topicId] ?? [], discovered, config.max_articles);
  entries.push([topicId, merged]);
  console.log(`${topicId}: ${discovered.length} discovered, ${merged.length} published`);
}

if (successfulQueries === 0) {
  throw new Error("Briefing refresh failed for every topic; existing snapshot retained");
}

const snapshot = validateBriefingDocument(
  {
    generated_at: new Date().toISOString(),
    provider: "GDELT + Google News",
    items: Object.fromEntries(entries),
  },
  topicIds,
);

await writeJsonAtomic(outputPath, snapshot);
console.log(`Published ${Object.values(snapshot.items).flat().length} world briefing article(s).`);

async function fetchGdeltArticles(topic, config) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.search = new URLSearchParams({
    query: `(${topic.query}) sourcelang:english`,
    mode: "artlist",
    format: "json",
    sort: "datedesc",
    maxrecords: String(config.max_records),
    timespan: config.timespan,
  }).toString();

  let response;
  let payload;
  for (let attempt = 1; attempt <= config.max_attempts; attempt += 1) {
    response = await fetch(url, { signal: AbortSignal.timeout(config.request_timeout_ms) });
    payload = await response.json().catch(() => null);
    if (response.ok && Array.isArray(payload?.articles)) break;
    if (attempt === config.max_attempts || (response.status !== 429 && response.status < 500)) {
      throw new Error(`GDELT request failed with HTTP ${response.status}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 5000);
  }

  const terms = topic.headline_any.map((term) => term.trim().toLowerCase()).filter(Boolean);
  return payload.articles
    .map((article) => normalizeArticle(article))
    .filter(Boolean)
    .filter((article) => terms.some((term) => article.title.toLowerCase().includes(term)))
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")))
    .filter(uniqueArticle())
    .slice(0, config.max_articles);
}

async function fetchGoogleNewsArticles(topic, config) {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: `${topic.query} when:${config.timespan.replace(/h$/i, "h")}`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  }).toString();

  const response = await fetch(url, {
    headers: { "user-agent": "GlobalAffairsTracker/1.0" },
    signal: AbortSignal.timeout(config.request_timeout_ms),
  });
  if (!response.ok) throw new Error(`Google News RSS request failed with HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((match) => normalizeGoogleNewsItem(match[1]))
    .filter(Boolean)
    .filter(uniqueArticle())
    .slice(0, config.max_articles);
}

function normalizeGoogleNewsItem(xml) {
  const title = decodeXml(extractXmlText(xml, "title"));
  const url = decodeXml(extractXmlText(xml, "link"));
  const source = decodeXml(extractXmlText(xml, "source")) || "Google News";
  const published = new Date(decodeXml(extractXmlText(xml, "pubDate")));
  if (!title || !normalizeUrl(url)) return null;
  return {
    title,
    url,
    source,
    provider: "Google News",
    ...(Number.isNaN(published.getTime()) ? {} : { published_at: published.toISOString() }),
    language: "English",
  };
}

function extractXmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function decodeXml(value) {
  return cleanText(value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))));
}

function normalizeArticle(article) {
  const language = cleanText(article?.language);
  const title = cleanText(article?.title);
  const url = cleanText(article?.url);
  const source = cleanText(article?.domain) || hostname(url);
  if (!isEnglishLanguage(language) || !title || !normalizeUrl(url) || !source) return null;
  const publishedAt = parseGdeltDate(article?.seendate);
  return {
    title,
    url,
    source,
    provider: "GDELT",
    ...(publishedAt ? { published_at: publishedAt } : {}),
    language: "English",
    ...(cleanText(article?.sourcecountry) ? { source_country: cleanText(article.sourcecountry) } : {}),
  };
}

function mergeArticles(existing, discovered, maximum) {
  return [...discovered, ...existing]
    .filter((article) => isEnglishLanguage(article.language, true))
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")))
    .filter(uniqueArticle())
    .slice(0, maximum);
}

function isEnglishLanguage(value, allowMissing = false) {
  const language = cleanText(value).toLowerCase();
  return language ? ["en", "eng", "english"].includes(language) : allowMissing;
}

function uniqueArticle() {
  const urls = new Set();
  const titles = new Set();
  return (article) => {
    const url = normalizeUrl(article.url);
    const title = cleanText(article.title).toLowerCase();
    if (!url || !title || urls.has(url) || titles.has(title)) return false;
    urls.add(url);
    titles.add(title);
    return true;
  };
}

function validateConfig(config) {
  for (const key of ["max_records", "max_articles", "request_delay_ms", "request_timeout_ms", "max_attempts"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (typeof config.timespan !== "string" || !/^\d+(?:min|[hdwmy])$/i.test(config.timespan)) {
    throw new Error("timespan must look like 24h, 7d, or 30min");
  }
  if (!config.topics || Object.keys(config.topics).length === 0) throw new Error("topics must not be empty");
  for (const [id, topic] of Object.entries(config.topics)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid topic id ${id}`);
    if (!cleanText(topic.label) || !cleanText(topic.description) || !cleanText(topic.query)) {
      throw new Error(`Topic ${id} is missing required text`);
    }
    if (!Array.isArray(topic.headline_any) || topic.headline_any.length === 0) {
      throw new Error(`Topic ${id} requires headline_any terms`);
    }
  }
}

function parseGdeltDate(value) {
  const match = String(value ?? "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function resolveInputPath(environmentPath, fallbackUrl) {
  return environmentPath ? resolve(environmentPath) : fileURLToPath(fallbackUrl);
}
