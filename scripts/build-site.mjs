import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../dist/", import.meta.url));
const files = [
  "index.html",
  "methodology.html",
  "styles.css",
  "app.js",
  "theme-init.js",
  "logo.svg",
  "robots.txt",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of files) {
  await cp(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}

await cp(new URL("../data/", import.meta.url), new URL("../dist/data/", import.meta.url), {
  recursive: true,
});
await cp(new URL("../geo/", import.meta.url), new URL("../dist/geo/", import.meta.url), {
  recursive: true,
});
await cp(new URL("../config/", import.meta.url), new URL("../dist/config/", import.meta.url), {
  recursive: true,
});

console.log(`Built production site at ${output}`);
