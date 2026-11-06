# Data source expansion plan

The tracker now combines NewsAPI with GDELT for filtered, deduplicated headline discovery. The next expansion should separate fast-moving media coverage from verified conflict events and humanitarian indicators.

## Recommended source stack

| Layer | Source | Best use | Access | Suggested refresh |
| --- | --- | --- | --- | --- |
| Global news discovery | GDELT DOC 2.0 | Multilingual article discovery, coverage volume, tone, and geographic mentions | Public API | 15–60 minutes |
| Conflict events | ACLED | Geocoded violence, demonstrations, actors, event types, and reported fatalities | myACLED account and OAuth | Daily |
| Academic event baseline | UCDP GED Candidate | Georeferenced organized-violence events and longer-term conflict comparisons | API token | Monthly candidate release |
| Humanitarian reporting | ReliefWeb | Curated situation reports, assessments, appeals, and disaster updates | Approved app name | 1–6 hours |
| Humanitarian indicators | HDX HAPI | Standardized displacement, needs, funding, food-security, population, and operational-presence indicators | App identifier | Daily or weekly by endpoint |
| Displacement | UNHCR Refugee Statistics API | Refugees, asylum seekers, origin and asylum countries, and nowcasting | Public API | Monthly or quarterly |

## Information to add to each country profile

- Events in the last 7 and 30 days
- Reported fatalities with source and methodology labels
- Civilian-targeting events
- Internal displacement and refugee totals
- People in need and humanitarian funding coverage
- Latest ReliefWeb situation reports
- News-volume trend and local-language coverage
- Ceasefire, negotiation, sanctions, and election milestones
- Data freshness, source, confidence, and last successful refresh for every metric

## Recommended next implementation

1. Completed: add GDELT as a second headline provider and deduplicate its results against NewsAPI.
2. Add ACLED country-level 7-day and 30-day event aggregates using server-side credentials.
3. Add ReliefWeb reports and HDX HAPI humanitarian indicators.
4. Use UCDP as the slower-moving validation and historical baseline.
5. Keep all credentials in GitHub Actions or server-side secrets. Publish only sanitized snapshots to the static site.

## Official documentation

- GDELT DOC 2.0: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
- ACLED API: https://acleddata.com/api-documentation/getting-started
- UCDP API: https://ucdp.uu.se/apidocs/index.html
- ReliefWeb API: https://apidoc.reliefweb.int/
- HDX HAPI: https://hdx-hapi.readthedocs.io/en/latest/
- UNHCR Refugee Statistics API: https://api.unhcr.org/docs/refugee-statistics.html
