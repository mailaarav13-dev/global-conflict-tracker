import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, validateBriefingDocument } from "./lib/data-contract.mjs";

const directory = await mkdtemp(join(tmpdir(), "world-briefing-refresh-"));
const outputPath = join(directory, "briefings.json");
const config = await readJson(new URL("../config/briefing-topics.json", import.meta.url));
const topicIds = Object.keys(config.topics);
const emptyItems = Object.fromEntries(topicIds.map((id) => [id, []]));
const sentinel = `${JSON.stringify({ generated_at: "2026-11-07T00:00:00Z", provider: "GDELT", items: emptyItems })}\n`;

process.env.BRIEFING_OUTPUT_PATH = outputPath;
process.env.BRIEFING_REQUEST_DELAY_MS = "0";

try {
  await writeFile(outputPath, sentinel);
  let requestCount = 0;
  globalThis.fetch = async () => {
    const topicId = topicIds[requestCount++];
    const term = config.topics[topicId].headline_any[0].trim();
    return new Response(JSON.stringify({ articles: [{
      title: `${term} global briefing update`,
      url: `https://example.org/${topicId}?utm_source=test`,
      domain: "example.org",
      seendate: "20261107T010000Z",
      language: "English",
      sourcecountry: "United States"
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await import(`./refresh-briefings.mjs?success=${Date.now()}`);
  const published = validateBriefingDocument(await readJson(outputPath), topicIds);
  assert.equal(requestCount, topicIds.length);
  assert.equal(Object.values(published.items).flat().length, topicIds.length);

  await writeFile(outputPath, sentinel);
  globalThis.fetch = async () => { throw new Error("simulated briefing outage"); };
  await assert.rejects(
    import(`./refresh-briefings.mjs?failure=${Date.now()}`),
    /failed for every topic/,
  );
  assert.equal(await readFile(outputPath, "utf8"), sentinel);
  console.log("World briefing refresh integration tests passed.");
} finally {
  delete process.env.BRIEFING_OUTPUT_PATH;
  delete process.env.BRIEFING_REQUEST_DELAY_MS;
  await rm(directory, { recursive: true, force: true });
}
