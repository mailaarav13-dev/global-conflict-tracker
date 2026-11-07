# Data pipeline

The public site remains a static export. Its data layer now has three independent snapshots.

- `data/conflicts.json` contains the editorial catalog of international, internal, and transnational conflicts.
- `data/news.json` contains the news snapshot already consumed by the public site.
- `data/briefings.json` contains general world-news headlines grouped into politics, security, economy, climate, health, technology, and society.
- `data/bootstrap-data.js` packages all snapshots, topic metadata, and map geometry for browsers that open `index.html` directly from disk.

The browser interface loads both snapshots at runtime. Country details stay out of the initial view and are rendered only after a tracked country is selected on the map.

## Local commands

The pipeline requires Node.js 20 or newer and has no third-party package dependencies.

### Run the site in VS Code

Open the extracted project folder in VS Code, then run these commands in its integrated terminal.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:4173` in a browser. Stop the server with `Ctrl+C`. To choose another port or expose the server to devices on the same network, use `npm run dev -- --port 3000 --host 0.0.0.0`.

If port 4173 is already occupied, the development server automatically tries 4174 and subsequent ports. Always open the exact address printed in the terminal. A port supplied with `--port` is treated as an explicit choice and produces a concise error if unavailable.

```sh
npm run check
npm run validate:data
npm run build:bootstrap
npm run refresh:news
npm run refresh:gdelt
npm run refresh:briefings
npm run refresh:ucdp
npm run verify:ucdp
npm run sync:supabase
npm run refresh
```

`refresh:news` requires `NEWS_API_KEY`. It requests the configured searches, validates the complete candidate snapshot, and atomically replaces `data/news.json`. Any provider, network, or validation failure leaves the published snapshot untouched.

`refresh:gdelt` then adds multilingual GDELT discoveries to the existing snapshot, deduplicates URLs and headlines, applies the same headline relevance rules, and keeps up to eight recent items per conflict. It requires no additional credential. Requests are spaced and retried to respect the public endpoint; an individual query failure retains that conflict's existing articles, while a total provider outage leaves the entire snapshot untouched.

Search terms and ingestion limits live in `config/news-queries.json`.

`refresh:briefings` builds the separate World News panel. It uses GDELT first and Google News RSS as a resilient fallback, requires no credential, validates every article, and retains the last valid topic snapshot when providers fail. Topic definitions live in `config/briefing-topics.json`.

All public headline feeds are English-only. NewsAPI and Google News are queried in English; GDELT queries include an English source-language constraint and results with non-English language metadata are discarded. Snapshot validation rejects any explicitly non-English article, and `npm run clean:english` removes legacy records before rebuilding the packaged bundle.

`verify:ucdp` makes one authenticated, read-only request for a single UCDP GED record and validates the response without logging the token. Set `UCDP_API_TOKEN` locally or run the manual **Verify UCDP access** GitHub Actions workflow, which reads the repository secret.

`refresh:ucdp` retrieves the configured UCDP GED Candidate release, strips source text and other unnecessary fields, calculates country aggregates, and atomically saves `data/ucdp.json`. It has a code-enforced maximum of five API requests per run and refuses to replace the saved snapshot if the result would exceed that budget or any request fails.

## Scheduled refresh

`.github/workflows/refresh-data.yml` deploys code pushes immediately and performs a data refresh at 17 minutes past every sixth hour. Conflict-specific GDELT discovery and the broader world briefing run on every scheduled refresh. NewsAPI runs only at 00:17 and 12:17 UTC, keeping its 24-query refresh below the Developer plan's rolling request limits. Manual runs skip NewsAPI unless the `refresh_newsapi` option is explicitly enabled.

Provider failures are nonfatal in the hosted workflow: validation and deployment continue using the last valid snapshot. The individual refresh scripts still fail locally on total provider outages so problems remain visible during development.

A separate UCDP workflow runs at 03:41 and 15:41 UTC (twice daily). At its maximum of five requests per run, it can consume no more than 10 authenticated requests per day. It commits the sanitized snapshot, and that commit triggers the normal static deployment. Website visitors only download the saved JSON file and never call UCDP or receive the token.

To activate it in a GitHub repository, add this Actions secret.

- `NEWS_API_KEY`

The workflow rebuilds the direct-open bundle, validates the result, optionally syncs Supabase, and commits changed data files. A static host connected to the repository can deploy that commit through its normal deployment hook.

## Opening the download directly

Extract the complete archive, then open `index.html`. The generated bootstrap bundle avoids browser restrictions on reading neighboring JSON files from a `file://` page. The scheduled workflow rebuilds this browser bundle whenever the standalone news snapshot changes.

## Optional Supabase mirror

The migration in `supabase/migrations/20261105000000_create_conflict_data.sql` creates read-only public conflict and news tables, refresh audit records, row-level security policies, and a service-role-only transactional snapshot function.

Apply the migration to a Supabase project, then provide both values locally or as GitHub Actions secrets.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`npm run sync:supabase` validates the local snapshots before calling the transactional database function. It safely skips synchronization when neither Supabase value is configured and fails when only one is present.

The service-role key must stay in server-side secrets. It must never be placed in browser JavaScript or committed to the repository.

## Data contracts

Runtime validation is implemented in `scripts/lib/data-contract.mjs`. Portable JSON Schema descriptions are available under `schemas/` for editor tooling and future services.

The conflict identifiers form the relationship between all layers. Every configured query and news collection must match one conflict identifier exactly.

See `DATA_SOURCES.md` for the recommended expansion from headlines into conflict events, displacement, humanitarian needs, and funding indicators.

## Activation work

Scheduled refresh requires a Git repository with Actions enabled and the `NEWS_API_KEY` secret configured. Supabase synchronization additionally requires a Supabase project and the migration to be applied.
