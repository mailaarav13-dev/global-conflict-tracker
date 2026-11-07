import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  readJson,
  validateBriefingDocument,
  validateConflictDocument,
  validateNewsDocument,
} from "./lib/data-contract.mjs";

const conflictsPath = fileURLToPath(new URL("../data/conflicts.json", import.meta.url));
const newsPath = fileURLToPath(new URL("../data/news.json", import.meta.url));
const briefingsPath = fileURLToPath(new URL("../data/briefings.json", import.meta.url));
const briefingConfigPath = fileURLToPath(new URL("../config/briefing-topics.json", import.meta.url));
const queryConfigPath = fileURLToPath(new URL("../config/news-queries.json", import.meta.url));
const topologyPath = fileURLToPath(new URL("../geo/countries-110m.json", import.meta.url));
const bootstrapPath = fileURLToPath(new URL("../data/bootstrap-data.js", import.meta.url));

const conflicts = validateConflictDocument(await readJson(conflictsPath));
const news = validateNewsDocument(
  await readJson(newsPath),
  conflicts.items.map((conflict) => conflict.id),
);
const briefingConfig = await readJson(briefingConfigPath);
const briefings = validateBriefingDocument(
  await readJson(briefingsPath),
  Object.keys(briefingConfig.topics ?? {}),
);
const queryConfig = await readJson(queryConfigPath);
const topology = await readJson(topologyPath);

const conflictIds = new Set(conflicts.items.map((conflict) => conflict.id));
const queryIds = new Set(Object.keys(queryConfig.queries ?? {}));
const matchIds = new Set(Object.keys(queryConfig.matches ?? {}));
const missingQueries = [...conflictIds].filter((id) => !queryIds.has(id));
const unknownQueries = [...queryIds].filter((id) => !conflictIds.has(id));
const missingMatches = [...conflictIds].filter((id) => !matchIds.has(id));
const unknownMatches = [...matchIds].filter((id) => !conflictIds.has(id));

if (
  missingQueries.length > 0 ||
  unknownQueries.length > 0 ||
  missingMatches.length > 0 ||
  unknownMatches.length > 0
) {
  const details = [
    missingQueries.length > 0 ? `missing queries: ${missingQueries.join(", ")}` : null,
    unknownQueries.length > 0 ? `unknown queries: ${unknownQueries.join(", ")}` : null,
    missingMatches.length > 0 ? `missing matches: ${missingMatches.join(", ")}` : null,
    unknownMatches.length > 0 ? `unknown matches: ${unknownMatches.join(", ")}` : null,
  ].filter(Boolean);
  throw new Error(`News query configuration does not match the conflict dataset (${details.join("; ")})`);
}

const bootstrapPrefix = "window.__CONFLICT_TRACKER_DATA__ = ";
const bootstrapSource = await readFile(bootstrapPath, "utf8");
if (!bootstrapSource.startsWith(bootstrapPrefix) || !bootstrapSource.trimEnd().endsWith(";")) {
  throw new Error("data/bootstrap-data.js has an invalid wrapper");
}

const bootstrap = JSON.parse(
  bootstrapSource.slice(bootstrapPrefix.length).trim().replace(/;$/, ""),
);
for (const [label, packaged, source] of [
  ["conflicts", bootstrap.conflicts, conflicts],
  ["news", bootstrap.news, news],
  ["briefings", bootstrap.briefings, briefings],
  ["briefing topics", bootstrap.briefingTopics, briefingConfig.topics],
  ["topology", bootstrap.topology, topology],
]) {
  if (JSON.stringify(packaged) !== JSON.stringify(source)) {
    throw new Error(`The direct-open bundle contains stale ${label} data. Run npm run build:bootstrap.`);
  }
}

console.log(`Validated ${conflicts.items.length} conflicts, ${Object.values(news.items).flat().length} conflict articles, and ${Object.values(briefings.items).flat().length} briefing articles.`);
