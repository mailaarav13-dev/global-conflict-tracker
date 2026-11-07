import { readFile } from "node:fs/promises";

const REGIONS = new Set([
  "North America",
  "South America",
  "Europe",
  "Middle East & North Africa",
  "Sub-Saharan Africa",
  "Asia-Pacific",
]);

const CONFLICT_TYPES = new Set([
  "Interstate War",
  "Civil War",
  "Transnational Terrorism",
  "Political Instability",
]);

const STATUSES = new Set(["Deteriorating", "Constant", "Improving"]);
const IMPACT_LEVELS = new Set(["High", "Medium", "Low"]);
const SCOPES = new Set(["International", "Internal", "Transnational"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO3_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class DataValidationError extends Error {
  constructor(documentName, issues) {
    super(`${documentName} validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "DataValidationError";
    this.issues = issues;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function validateConflictDocument(document) {
  const issues = [];

  if (!isRecord(document)) {
    throw new DataValidationError("Conflict document", ["root must be an object"]);
  }

  validateTimestamp(document.generated_at, "generated_at", issues);
  requireString(document.source, "source", issues);

  if (!Array.isArray(document.items)) {
    issues.push("items must be an array");
  } else {
    const ids = new Set();

    document.items.forEach((conflict, index) => {
      const path = `items[${index}]`;

      if (!isRecord(conflict)) {
        issues.push(`${path} must be an object`);
        return;
      }

      requireString(conflict.id, `${path}.id`, issues);
      if (typeof conflict.id === "string" && !ID_PATTERN.test(conflict.id)) {
        issues.push(`${path}.id must be a lowercase kebab-case identifier`);
      }
      if (ids.has(conflict.id)) {
        issues.push(`${path}.id duplicates ${conflict.id}`);
      }
      ids.add(conflict.id);

      requireString(conflict.title, `${path}.title`, issues);
      requireEnum(conflict.region, REGIONS, `${path}.region`, issues);
      requireEnum(conflict.type, CONFLICT_TYPES, `${path}.type`, issues);
      requireEnum(conflict.status, STATUSES, `${path}.status`, issues);
      requireEnum(conflict.impact_level, IMPACT_LEVELS, `${path}.impact_level`, issues);
      requireEnum(conflict.scope, SCOPES, `${path}.scope`, issues);
      requireString(conflict.summary, `${path}.summary`, issues);
      requireString(conflict.historical_context, `${path}.historical_context`, issues);
      requireString(conflict.strategic_impact, `${path}.strategic_impact`, issues);

      if (!Array.isArray(conflict.iso_countries) || conflict.iso_countries.length === 0) {
        issues.push(`${path}.iso_countries must be a non-empty array`);
      } else {
        conflict.iso_countries.forEach((code, countryIndex) => {
          if (typeof code !== "string" || !ISO3_PATTERN.test(code)) {
            issues.push(`${path}.iso_countries[${countryIndex}] must be an ISO 3166-1 alpha-3 code`);
          }
        });
      }

      validateCoordinates(conflict.center_coordinates, `${path}.center_coordinates`, issues);

      if (conflict.source_links !== undefined) {
        if (!Array.isArray(conflict.source_links)) {
          issues.push(`${path}.source_links must be an array when present`);
        } else {
          conflict.source_links.forEach((url, sourceIndex) => {
            if (!isHttpUrl(url)) {
              issues.push(`${path}.source_links[${sourceIndex}] must be an absolute HTTP or HTTPS URL`);
            }
          });
        }
      }

      if (conflict.updated_at !== undefined) {
        if (typeof conflict.updated_at !== "string" || !DATE_PATTERN.test(conflict.updated_at)) {
          issues.push(`${path}.updated_at must use YYYY-MM-DD`);
        } else if (!isValidDate(conflict.updated_at)) {
          issues.push(`${path}.updated_at is not a valid calendar date`);
        }
      }
    });
  }

  if (issues.length > 0) {
    throw new DataValidationError("Conflict document", issues);
  }

  return document;
}

export function validateNewsDocument(document, conflictIds = null) {
  const issues = [];

  if (!isRecord(document)) {
    throw new DataValidationError("News document", ["root must be an object"]);
  }

  validateTimestamp(document.generated_at, "generated_at", issues);
  requireString(document.provider, "provider", issues);

  if (document.sample !== undefined && typeof document.sample !== "boolean") {
    issues.push("sample must be a boolean when present");
  }

  if (!isRecord(document.items)) {
    issues.push("items must be an object keyed by conflict id");
  } else {
    for (const [conflictId, articles] of Object.entries(document.items)) {
      if (!ID_PATTERN.test(conflictId)) {
        issues.push(`items.${conflictId} is not a valid conflict id`);
      }
      if (!Array.isArray(articles)) {
        issues.push(`items.${conflictId} must be an array`);
        continue;
      }

      const urls = new Set();
      articles.forEach((article, index) => {
        const path = `items.${conflictId}[${index}]`;
        if (!isRecord(article)) {
          issues.push(`${path} must be an object`);
          return;
        }

        requireString(article.title, `${path}.title`, issues);
        requireString(article.source, `${path}.source`, issues);

        if (!isHttpUrl(article.url)) {
          issues.push(`${path}.url must be an absolute HTTP or HTTPS URL`);
        }
        const sampleArticle = article.sample === true || document.sample === true;
        if (urls.has(article.url) && !sampleArticle) {
          issues.push(`${path}.url duplicates another article for ${conflictId}`);
        }
        urls.add(article.url);

        if (article.published_at !== undefined) {
          validateTimestamp(article.published_at, `${path}.published_at`, issues);
        }
        if (article.provider !== undefined) {
          requireString(article.provider, `${path}.provider`, issues);
        }
        if (article.language !== undefined) {
          requireString(article.language, `${path}.language`, issues);
        }
        if (article.source_country !== undefined) {
          requireString(article.source_country, `${path}.source_country`, issues);
        }
        if (article.sample !== undefined && typeof article.sample !== "boolean") {
          issues.push(`${path}.sample must be a boolean when present`);
        }
      });
    }
  }

  if (conflictIds && isRecord(document.items)) {
    const expected = new Set(conflictIds);
    const actual = new Set(Object.keys(document.items));

    for (const id of expected) {
      if (!actual.has(id)) {
        issues.push(`items is missing conflict id ${id}`);
      }
    }
    for (const id of actual) {
      if (!expected.has(id)) {
        issues.push(`items contains unknown conflict id ${id}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new DataValidationError("News document", issues);
  }

  return document;
}

export function validateBriefingDocument(document, topicIds = null) {
  const issues = [];

  if (!isRecord(document)) {
    throw new DataValidationError("Briefing document", ["root must be an object"]);
  }

  validateTimestamp(document.generated_at, "generated_at", issues);
  requireString(document.provider, "provider", issues);

  if (!isRecord(document.items)) {
    issues.push("items must be an object keyed by topic id");
  } else {
    for (const [topicId, articles] of Object.entries(document.items)) {
      if (!ID_PATTERN.test(topicId)) issues.push(`items.${topicId} is not a valid topic id`);
      if (!Array.isArray(articles)) {
        issues.push(`items.${topicId} must be an array`);
        continue;
      }

      const urls = new Set();
      articles.forEach((article, index) => {
        const path = `items.${topicId}[${index}]`;
        if (!isRecord(article)) {
          issues.push(`${path} must be an object`);
          return;
        }
        requireString(article.title, `${path}.title`, issues);
        requireString(article.source, `${path}.source`, issues);
        if (!isHttpUrl(article.url)) issues.push(`${path}.url must be an absolute HTTP or HTTPS URL`);
        if (urls.has(article.url)) issues.push(`${path}.url duplicates another article for ${topicId}`);
        urls.add(article.url);
        if (article.published_at !== undefined) validateTimestamp(article.published_at, `${path}.published_at`, issues);
        if (article.provider !== undefined) requireString(article.provider, `${path}.provider`, issues);
        if (article.language !== undefined) requireString(article.language, `${path}.language`, issues);
        if (article.source_country !== undefined) requireString(article.source_country, `${path}.source_country`, issues);
      });
    }
  }

  if (topicIds && isRecord(document.items)) {
    const expected = new Set(topicIds);
    const actual = new Set(Object.keys(document.items));
    for (const id of expected) if (!actual.has(id)) issues.push(`items is missing topic id ${id}`);
    for (const id of actual) if (!expected.has(id)) issues.push(`items contains unknown topic id ${id}`);
  }

  if (issues.length > 0) throw new DataValidationError("Briefing document", issues);
  return document;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, path, issues) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
  }
}

function requireEnum(value, allowed, path, issues) {
  if (!allowed.has(value)) {
    issues.push(`${path} must be one of ${[...allowed].join(", ")}`);
  }
}

function validateCoordinates(value, path, issues) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }

  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) {
    issues.push(`${path}.latitude must be between -90 and 90`);
  }
  if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    issues.push(`${path}.longitude must be between -180 and 180`);
  }
}

function validateTimestamp(value, path, issues) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(`${path} must be an ISO 8601 timestamp`);
  }
}

function isValidDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
