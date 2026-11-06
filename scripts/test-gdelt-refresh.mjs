import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJson,
  validateConflictDocument,
  validateNewsDocument,
} from "./lib/data-contract.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "conflict-gdelt-refresh-"));
const outputPath = join(temporaryDirectory, "news.json");
const conflicts = validateConflictDocument(await readJson(new URL("../data/conflicts.json", import.meta.url)));
const config = await readJson(new URL("../config/news-queries.json", import.meta.url));
const emptyItems = Object.fromEntries(conflicts.items.map((conflict) => [conflict.id, []]));
const sentinel = `${JSON.stringify({
  generated_at: "2026-11-05T00:00:00Z",
  provider: "newsapi.org",
  sample: false,
  items: emptyItems,
})}\n`;

process.env.NEWS_OUTPUT_PATH = outputPath;
process.env.GDELT_REQUEST_DELAY_MS = "0";

try {
  await writeFile(
    outputPath,
    `${JSON.stringify({ generated_at: "2026-11-05T00:00:00Z", provider: "newsapi.org", sample: false, items: emptyItems })}\n`,
  );

  let requestCount = 0;
  globalThis.fetch = async (requestUrl) => {
    const conflict = conflicts.items[requestCount];
    const headlineTerm = config.matches[conflict.id].headline_any[0];
    requestCount += 1;
    const url = new URL(requestUrl);
    assert.equal(url.hostname, "api.gdeltproject.org");
    assert.equal(url.searchParams.get("mode"), "artlist");
    return new Response(
      JSON.stringify({
        articles: [
          {
            title: `${headlineTerm} verified conflict update`,
            url: `https://example.net/gdelt/${conflict.id}?utm_source=test`,
            domain: "example.net",
            seendate: "20261105T120000Z",
            language: "English",
            sourcecountry: "United States",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await import(`./refresh-gdelt.mjs?success=${Date.now()}`);
  const published = validateNewsDocument(await readJson(outputPath), conflicts.items.map((item) => item.id));
  assert.equal(requestCount, conflicts.items.length);
  assert.match(published.provider, /GDELT/);
  assert.equal(Object.values(published.items).flat().length, conflicts.items.length);
  assert.ok(Object.values(published.items).flat().every((article) => article.provider === "GDELT"));

  await writeFile(outputPath, sentinel, "utf8");
  globalThis.fetch = async () => {
    throw new Error("simulated GDELT outage");
  };
  await assert.rejects(
    import(`./refresh-gdelt.mjs?failure=${Date.now()}`),
    /failed for every configured conflict/,
  );
  assert.equal(await readFile(outputPath, "utf8"), sentinel);

  console.log("GDELT refresh integration tests passed.");
} finally {
  delete process.env.NEWS_OUTPUT_PATH;
  delete process.env.GDELT_REQUEST_DELAY_MS;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
