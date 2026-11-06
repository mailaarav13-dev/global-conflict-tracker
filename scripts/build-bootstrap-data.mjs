import { fileURLToPath } from "node:url";
import {
  readJson,
  validateConflictDocument,
  validateNewsDocument,
} from "./lib/data-contract.mjs";
import { writeTextAtomic } from "./lib/write-json-atomic.mjs";

const conflictsPath = fileURLToPath(new URL("../data/conflicts.json", import.meta.url));
const newsPath = fileURLToPath(new URL("../data/news.json", import.meta.url));
const topologyPath = fileURLToPath(new URL("../geo/countries-110m.json", import.meta.url));
const outputPath = fileURLToPath(new URL("../data/bootstrap-data.js", import.meta.url));

const conflicts = validateConflictDocument(await readJson(conflictsPath));
const news = validateNewsDocument(
  await readJson(newsPath),
  conflicts.items.map((conflict) => conflict.id),
);
const topology = await readJson(topologyPath);

if (!Array.isArray(topology?.objects?.countries?.geometries) || !Array.isArray(topology?.arcs)) {
  throw new Error("The geographic dataset is missing required TopoJSON structures");
}

const payload = { conflicts, news, topology };
const source = `window.__CONFLICT_TRACKER_DATA__ = ${JSON.stringify(payload)};\n`;

await writeTextAtomic(outputPath, source);
console.log(`Built direct-open data bundle at data/bootstrap-data.js (${source.length} bytes).`);
