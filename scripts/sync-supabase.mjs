import { fileURLToPath } from "node:url";
import {
  readJson,
  validateConflictDocument,
  validateNewsDocument,
} from "./lib/data-contract.mjs";

const conflictsPath = fileURLToPath(new URL("../data/conflicts.json", import.meta.url));
const newsPath = fileURLToPath(new URL("../data/news.json", import.meta.url));
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl && !serviceRoleKey) {
  console.log("Supabase sync skipped because no Supabase credentials were provided.");
  process.exit(0);
}

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided together.");
}

const conflicts = validateConflictDocument(await readJson(conflictsPath));
const news = validateNewsDocument(
  await readJson(newsPath),
  conflicts.items.map((conflict) => conflict.id),
);

const newsItems = Object.entries(news.items).flatMap(([conflictId, articles]) =>
  articles.map((article) => ({
    conflict_id: conflictId,
    title: article.title,
    url: article.url,
    source: article.source,
    published_at: article.published_at ?? null,
    provider: news.provider,
    sample: article.sample ?? news.sample ?? false,
  })),
);

const endpoint = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/replace_conflict_snapshot`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    p_conflicts: conflicts.items,
    p_news: newsItems,
    p_metadata: {
      conflict_snapshot_generated_at: conflicts.generated_at,
      news_snapshot_generated_at: news.generated_at,
      news_provider: news.provider,
    },
  }),
  signal: AbortSignal.timeout(30000),
});

if (!response.ok) {
  throw new Error(`Supabase snapshot sync failed with HTTP ${response.status}: ${await response.text()}`);
}

console.log(`Synced ${conflicts.items.length} conflicts and ${newsItems.length} news items to Supabase.`);
