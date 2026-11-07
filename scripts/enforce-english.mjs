import { readJson, validateNewsDocument, validateBriefingDocument } from "./lib/data-contract.mjs";
import { writeJsonAtomic } from "./lib/write-json-atomic.mjs";
import { fileURLToPath } from "node:url";

const newsUrl = fileURLToPath(new URL("../data/news.json", import.meta.url));
const briefingsUrl = fileURLToPath(new URL("../data/briefings.json", import.meta.url));
const conflicts = await readJson(new URL("../data/conflicts.json", import.meta.url));
const topics = await readJson(new URL("../config/briefing-topics.json", import.meta.url));
const news = await readJson(newsUrl);
const briefings = await readJson(briefingsUrl);

let removed = 0;
for (const [key, articles] of Object.entries(news.items)) {
  const kept = articles.filter(isEnglishArticle);
  removed += articles.length - kept.length;
  news.items[key] = kept;
}
for (const [key, articles] of Object.entries(briefings.items)) {
  const kept = articles.filter(isEnglishArticle);
  removed += articles.length - kept.length;
  briefings.items[key] = kept;
}

validateNewsDocument(news, conflicts.items.map((conflict) => conflict.id));
validateBriefingDocument(briefings, Object.keys(topics.topics));
await writeJsonAtomic(newsUrl, news);
await writeJsonAtomic(briefingsUrl, briefings);
console.log(`Removed ${removed} explicitly non-English article(s).`);

function isEnglishArticle(article) {
  if (article.language === undefined) return true;
  return ["en", "eng", "english"].includes(String(article.language).trim().toLowerCase());
}
