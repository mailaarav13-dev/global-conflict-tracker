import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib/data-contract.mjs";
import { writeJsonAtomic } from "./lib/write-json-atomic.mjs";

const token = process.env.UCDP_API_TOKEN?.trim();
if (!token) throw new Error("UCDP_API_TOKEN is not configured");

const configPath = resolveInputPath(process.env.UCDP_CONFIG_PATH, new URL("../config/ucdp.json", import.meta.url));
const outputPath = resolveInputPath(process.env.UCDP_OUTPUT_PATH, new URL("../data/ucdp.json", import.meta.url));
const config = await readJson(configPath);
validateConfig(config);

const requestBudget = Math.min(config.max_requests_per_run, 5);
const events = [];
let requestCount = 0;
let totalPages = 1;
let totalEvents = 0;

for (let page = 1; page <= totalPages && requestCount < requestBudget; page += 1) {
  const endpoint = new URL(`https://ucdpapi.pcr.uu.se/api/${config.dataset}/${config.version}`);
  endpoint.search = new URLSearchParams({
    pagesize: String(config.page_size),
    page: String(page),
    StartDate: config.start_date,
    EndDate: config.end_date,
  }).toString();

  requestCount += 1;
  const response = await fetch(endpoint, {
    headers: { "x-ucdp-access-token": token },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`UCDP refresh failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.Result) || !Number.isInteger(payload.TotalPages) || !Number.isInteger(payload.TotalCount)) {
    throw new Error("UCDP returned an unexpected response shape");
  }
  totalPages = payload.TotalPages;
  totalEvents = payload.TotalCount;
  events.push(...payload.Result);
}

if (totalPages > requestBudget) {
  throw new Error(`UCDP result requires ${totalPages} requests, exceeding the ${requestBudget}-request safety budget; existing snapshot retained`);
}

const normalized = events.map(normalizeEvent).filter(Boolean);
const countries = aggregateCountries(normalized);
const snapshot = {
  generated_at: new Date().toISOString(),
  provider: "UCDP",
  dataset: config.dataset_label,
  version: config.version,
  period: { start: config.start_date, end: config.end_date },
  request_count: requestCount,
  total_events: totalEvents,
  events: normalized
    .sort((first, second) => second.date.localeCompare(first.date) || second.id - first.id)
    .slice(0, config.max_published_events),
  countries,
};

await writeJsonAtomic(outputPath, snapshot);
console.log(`Saved ${totalEvents.toLocaleString("en-US")} UCDP events across ${Object.keys(countries).length} countries using ${requestCount} request(s).`);

function normalizeEvent(event) {
  if (!Number.isInteger(event?.id) || typeof event?.country !== "string" || typeof event?.date_start !== "string") return null;
  return {
    id: event.id,
    date: event.date_start,
    country: event.country,
    region: String(event.region ?? ""),
    location: String(event.where_coordinates ?? event.where_description ?? ""),
    latitude: Number.isFinite(event.latitude) ? event.latitude : null,
    longitude: Number.isFinite(event.longitude) ? event.longitude : null,
    type_of_violence: event.type_of_violence,
    conflict: String(event.conflict_name ?? ""),
    parties: String(event.dyad_name ?? ""),
    deaths_best: nonnegative(event.best),
    deaths_civilians: nonnegative(event.deaths_civilians),
  };
}

function aggregateCountries(events) {
  const countries = {};
  for (const event of events) {
    const current = countries[event.country] ?? { events: 0, deaths_best: 0, deaths_civilians: 0, latest_event: event.date };
    current.events += 1;
    current.deaths_best += event.deaths_best;
    current.deaths_civilians += event.deaths_civilians;
    if (event.date > current.latest_event) current.latest_event = event.date;
    countries[event.country] = current;
  }
  return Object.fromEntries(Object.entries(countries).sort(([first], [second]) => first.localeCompare(second)));
}

function nonnegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function validateConfig(value) {
  if (!value || typeof value !== "object") throw new Error("UCDP config must be an object");
  for (const key of ["dataset", "dataset_label", "version"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`UCDP config ${key} is required`);
  }
  for (const key of ["start_date", "end_date"]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value[key])) throw new Error(`UCDP config ${key} must use YYYY-MM-DD`);
  }
  for (const key of ["page_size", "max_requests_per_run", "max_published_events"]) {
    if (!Number.isInteger(value[key]) || value[key] < 1) throw new Error(`UCDP config ${key} must be a positive integer`);
  }
  if (value.max_requests_per_run > 5) throw new Error("UCDP max_requests_per_run may not exceed 5");
}

function resolveInputPath(environmentPath, fallbackUrl) {
  return environmentPath ? resolve(environmentPath) : fileURLToPath(fallbackUrl);
}
