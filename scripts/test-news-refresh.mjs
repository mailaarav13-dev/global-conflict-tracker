import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, validateNewsDocument } from "./lib/data-contract.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "conflict-news-refresh-"));
const outputPath = join(temporaryDirectory, "news.json");
const sentinel = "last-known-good\n";

process.env.NEWS_API_KEY = "test-key";
process.env.NEWS_OUTPUT_PATH = outputPath;

try {
  let requestCount = 0;
  globalThis.fetch = async (requestUrl) => {
    requestCount += 1;
    const url = new URL(requestUrl);
    const query = url.searchParams.get("q");
    const articleId = String(requestCount).padStart(2, "0");

    assert.ok(query, "Every provider request must contain a query");
    assert.equal(url.searchParams.get("language"), "en");
    assert.equal(url.searchParams.get("sortBy"), "publishedAt");

    return new Response(
      JSON.stringify({
        status: "ok",
        articles: [
          {
            title: `Test headline ${articleId}: ${query}`,
            description: `Test coverage for ${query}`,
            url: `https://example.com/articles/${articleId}`,
            source: { name: "Test Source" },
            publishedAt: "2026-11-05T00:00:00Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  await import(`./refresh-news.mjs?success=${Date.now()}`);
  const published = validateNewsDocument(await readJson(outputPath));
  assert.equal(requestCount, 24);
  assert.equal(published.sample, false);
  assert.equal(Object.keys(published.items).length, 24);
  assert.equal(Object.values(published.items).flat().length, 24);

  await writeFile(outputPath, sentinel, "utf8");
  globalThis.fetch = async () => {
    throw new Error("simulated provider outage");
  };

  await assert.rejects(
    import(`./refresh-news.mjs?failure=${Date.now()}`),
    /simulated provider outage/,
  );
  assert.equal(await readFile(outputPath, "utf8"), sentinel);

  console.log("News refresh integration tests passed.");
} finally {
  delete process.env.NEWS_API_KEY;
  delete process.env.NEWS_OUTPUT_PATH;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
