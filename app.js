const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 520;

const NUMERIC_TO_ISO3 = {
  "004": "AFG",
  "031": "AZE",
  "051": "ARM",
  "096": "BRN",
  "104": "MMR",
  "112": "BLR",
  "120": "CMR",
  "156": "CHN",
  "158": "TWN",
  "170": "COL",
  "180": "COD",
  "218": "ECU",
  "231": "ETH",
  "275": "PSE",
  "328": "GUY",
  "332": "HTI",
  "356": "IND",
  "364": "IRN",
  "376": "ISR",
  "408": "PRK",
  "410": "KOR",
  "422": "LBN",
  "434": "LBY",
  "458": "MYS",
  "466": "MLI",
  "484": "MEX",
  "508": "MOZ",
  "562": "NER",
  "566": "NGA",
  "586": "PAK",
  "608": "PHL",
  "643": "RUS",
  "646": "RWA",
  "682": "SAU",
  "704": "VNM",
  "706": "SOM",
  "728": "SSD",
  "729": "SDN",
  "760": "SYR",
  "804": "UKR",
  "818": "EGY",
  "840": "USA",
  "854": "BFA",
  "862": "VEN",
  "887": "YEM",
};

const STATUS_RANK = {
  Deteriorating: 3,
  Constant: 2,
  Improving: 1,
};

const IMPACT_RANK = {
  High: 3,
  Medium: 2,
  Low: 1,
};

const state = {
  conflicts: [],
  news: null,
  topology: null,
  conflictsByIso: new Map(),
  countryPaths: new Map(),
  selectedIso: null,
  activeConflictId: null,
  zoom: 1,
  zoomCenter: { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 },
  drag: null,
  suppressMapClick: false,
  messageTimer: null,
};

const elements = {
  closePanel: document.querySelector("#close-panel"),
  countryLayer: document.querySelector("#country-layer"),
  dataStatus: document.querySelector("#data-status"),
  map: document.querySelector("#world-map"),
  mapLoading: document.querySelector("#map-loading"),
  mapMessage: document.querySelector("#map-message"),
  panel: document.querySelector("#country-panel"),
  panelBackdrop: document.querySelector("#panel-backdrop"),
  panelContent: document.querySelector("#panel-content"),
  resetMap: document.querySelector("#reset-map"),
  themeLabel: document.querySelector("#theme-label"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeToggles: [...document.querySelectorAll("#theme-toggle, #panel-theme-toggle")],
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
};

initialize().catch((error) => {
  console.error("Tracker initialization failed", error);
  elements.mapLoading.innerHTML = `
    <strong>The map could not be loaded</strong>
    <span>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</span>
  `;
  elements.dataStatus.textContent = "Data unavailable";
});

elements.closePanel.addEventListener("click", closeCountryPanel);
elements.zoomIn.addEventListener("click", () => changeZoom(0.35));
elements.zoomOut.addEventListener("click", () => changeZoom(-0.35));
elements.resetMap.addEventListener("click", resetMapView);
for (const themeToggle of elements.themeToggles) {
  themeToggle.addEventListener("click", toggleTheme);
}
elements.map.addEventListener("pointerdown", beginMapPan);
elements.map.addEventListener("pointermove", continueMapPan);
elements.map.addEventListener("pointerup", endMapPan);
elements.map.addEventListener("pointercancel", endMapPan);
elements.map.addEventListener("wheel", panMapWithWheel, { passive: false });
elements.map.addEventListener(
  "click",
  (event) => {
    if (state.suppressMapClick) {
      event.preventDefault();
      event.stopPropagation();
      state.suppressMapClick = false;
    }
  },
  true,
);
updateThemeControl();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.panel.hidden) {
    closeCountryPanel();
  }
});
window.addEventListener("resize", centerMapForViewport);

async function initialize() {
  const [conflictDocument, newsDocument, topology] = await loadDataDocuments();

  state.conflicts = Array.isArray(conflictDocument.items) ? conflictDocument.items : [];
  state.news = newsDocument;
  state.topology = topology;
  state.conflictsByIso = groupConflictsByCountry(state.conflicts);

  drawMap(topology);
  updateDataStatus(conflictDocument, newsDocument);
  elements.mapLoading.hidden = true;
  window.requestAnimationFrame(centerMapForViewport);
}

async function loadDataDocuments() {
  const embedded = window.__CONFLICT_TRACKER_DATA__;

  if (window.location.protocol === "file:" && embedded) {
    document.documentElement.dataset.dataSource = "packaged";
    return [embedded.conflicts, embedded.news, embedded.topology];
  }

  if (window.location.protocol === "file:") {
    throw new Error("The local data bundle is missing. Extract the complete download before opening index.html.");
  }

  try {
    const [conflictResponse, newsResponse, topologyResponse] = await Promise.all([
      fetch("data/conflicts.json"),
      fetch("data/news.json"),
      fetch("geo/countries-110m.json"),
    ]);

    for (const response of [conflictResponse, newsResponse, topologyResponse]) {
      if (!response.ok) {
        throw new Error(`A required data file returned HTTP ${response.status}`);
      }
    }

    document.documentElement.dataset.dataSource = "json";
    return await Promise.all([
      conflictResponse.json(),
      newsResponse.json(),
      topologyResponse.json(),
    ]);
  } catch (error) {
    if (embedded) {
      document.documentElement.dataset.dataSource = "packaged-fallback";
      console.warn("Using the packaged data snapshot after the JSON files failed to load.", error);
      return [embedded.conflicts, embedded.news, embedded.topology];
    }
    throw error;
  }
}

function groupConflictsByCountry(conflicts) {
  const grouped = new Map();

  for (const conflict of conflicts) {
    for (const iso3 of conflict.iso_countries ?? []) {
      if (!grouped.has(iso3)) {
        grouped.set(iso3, []);
      }
      grouped.get(iso3).push(conflict);
    }
  }

  for (const issues of grouped.values()) {
    issues.sort(compareConflicts);
  }

  return grouped;
}

function compareConflicts(first, second) {
  return (
    (STATUS_RANK[second.status] ?? 0) - (STATUS_RANK[first.status] ?? 0) ||
    (IMPACT_RANK[second.impact_level] ?? 0) - (IMPACT_RANK[first.impact_level] ?? 0) ||
    first.title.localeCompare(second.title)
  );
}

function drawMap(topology) {
  const geometryCollection = topology?.objects?.countries;
  if (!geometryCollection || !Array.isArray(geometryCollection.geometries)) {
    throw new Error("The geographic dataset is missing its country geometries");
  }

  const fragment = document.createDocumentFragment();

  for (const geometry of geometryCollection.geometries) {
    const numericId = String(geometry.id ?? "").padStart(3, "0");
    const iso3 = NUMERIC_TO_ISO3[numericId] ?? null;
    const countryName = geometry.properties?.name ?? iso3 ?? "Unknown country";
    const issues = iso3 ? state.conflictsByIso.get(iso3) ?? [] : [];
    const path = document.createElementNS(SVG_NS, "path");

    path.setAttribute("d", geometryToPath(topology, geometry));
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("class", countryClassName(issues));
    path.dataset.countryName = countryName;
    path.dataset.tracked = String(issues.length > 0);

    if (iso3) {
      path.dataset.iso3 = iso3;
      state.countryPaths.set(iso3, path);
    }

    if (issues.length > 0) {
      path.setAttribute("role", "button");
      path.setAttribute("tabindex", "0");
      path.setAttribute(
        "aria-label",
        `${countryName}. ${issues.length} tracked ${issues.length === 1 ? "situation" : "situations"}.`,
      );
      path.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCountryPanel(iso3, countryName, issues);
        }
      });
    } else {
      path.setAttribute("aria-hidden", "true");
    }

    path.addEventListener("click", () => {
      if (issues.length === 0) {
        showMapMessage(`${countryName} has no tracked situation in the current dataset.`);
        return;
      }
      openCountryPanel(iso3, countryName, issues);
    });

    fragment.append(path);
  }

  elements.countryLayer.replaceChildren(fragment);
}

function countryClassName(issues) {
  if (issues.length === 0) {
    return "country";
  }

  const leadingStatus = issues[0].status.toLowerCase();
  return `country tracked status-${leadingStatus}`;
}

function geometryToPath(topology, geometry) {
  if (geometry.type === "Polygon") {
    return polygonToPath(topology, geometry.arcs);
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.arcs.map((polygon) => polygonToPath(topology, polygon)).join(" ");
  }

  return "";
}

function polygonToPath(topology, rings) {
  return rings.map((ring) => ringToPath(topology, ring)).join(" ");
}

function ringToPath(topology, arcIndexes) {
  const coordinates = [];

  arcIndexes.forEach((arcIndex, index) => {
    const arc = decodeArc(topology, arcIndex);
    coordinates.push(...(index === 0 ? arc : arc.slice(1)));
  });

  if (coordinates.length === 0) {
    return "";
  }

  const unwrapped = unwrapLongitudes(coordinates);
  const paths = [];

  for (const shift of [-360, 0, 360]) {
    const shifted = unwrapped.map(([longitude, latitude]) => [longitude + shift, latitude]);
    const clipped = clipPolygonToLongitude(shifted, -180, 180);

    if (clipped.length < 3) {
      continue;
    }

    const projected = clipped.map(projectCoordinate);
    const commands = projected.map(
      ([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`,
    );
    paths.push(`${commands.join(" ")} Z`);
  }

  return paths.join(" ");
}

function unwrapLongitudes(coordinates) {
  const unwrapped = [];
  let previousLongitude = coordinates[0][0];

  for (const [rawLongitude, latitude] of coordinates) {
    let longitude = rawLongitude;
    while (longitude - previousLongitude > 180) longitude -= 360;
    while (longitude - previousLongitude < -180) longitude += 360;
    unwrapped.push([longitude, latitude]);
    previousLongitude = longitude;
  }

  return unwrapped;
}

function clipPolygonToLongitude(coordinates, minimum, maximum) {
  const clippedMinimum = clipPolygonEdge(
    coordinates,
    ([longitude]) => longitude >= minimum,
    minimum,
  );
  return clipPolygonEdge(
    clippedMinimum,
    ([longitude]) => longitude <= maximum,
    maximum,
  );
}

function clipPolygonEdge(coordinates, isInside, boundaryLongitude) {
  if (coordinates.length === 0) {
    return [];
  }

  const output = [];
  let previous = coordinates.at(-1);
  let previousInside = isInside(previous);

  for (const current of coordinates) {
    const currentInside = isInside(current);

    if (currentInside !== previousInside) {
      output.push(intersectLongitude(previous, current, boundaryLongitude));
    }
    if (currentInside) {
      output.push(current);
    }

    previous = current;
    previousInside = currentInside;
  }

  return output;
}

function intersectLongitude(first, second, boundaryLongitude) {
  const longitudeSpan = second[0] - first[0];
  if (longitudeSpan === 0) {
    return [boundaryLongitude, first[1]];
  }

  const progress = (boundaryLongitude - first[0]) / longitudeSpan;
  const latitude = first[1] + (second[1] - first[1]) * progress;
  return [boundaryLongitude, latitude];
}

function decodeArc(topology, signedIndex) {
  const reversed = signedIndex < 0;
  const index = reversed ? ~signedIndex : signedIndex;
  const sourceArc = topology.arcs[index] ?? [];
  const scale = topology.transform?.scale ?? [1, 1];
  const translate = topology.transform?.translate ?? [0, 0];
  let x = 0;
  let y = 0;

  const coordinates = sourceArc.map(([deltaX, deltaY]) => {
    x += deltaX;
    y += deltaY;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });

  return reversed ? coordinates.reverse() : coordinates;
}

function projectCoordinate([longitude, latitude]) {
  const x = 20 + ((longitude + 180) / 360) * 960;
  const y = 20 + ((90 - latitude) / 180) * 480;
  return [x.toFixed(2), y.toFixed(2)];
}

function openCountryPanel(iso3, countryName, issues) {
  state.drag = null;
  state.suppressMapClick = false;
  elements.map.classList.remove("is-panning");
  state.selectedIso = iso3;
  state.activeConflictId = issues[0].id;

  for (const path of state.countryPaths.values()) {
    path.classList.remove("selected");
  }

  const selectedPath = state.countryPaths.get(iso3);
  selectedPath?.classList.add("selected");

  renderCountryPanel(countryName, issues);
  elements.panel.hidden = false;
  elements.panelBackdrop.hidden = false;
  focusMapOnPath(selectedPath);
  window.setTimeout(() => elements.closePanel.focus(), 0);
}

function renderCountryPanel(countryName, issues) {
  const activeConflict =
    issues.find((conflict) => conflict.id === state.activeConflictId) ?? issues[0];

  elements.panelContent.innerHTML = `
    <header class="country-heading">
      <p class="eyebrow">${escapeHtml(activeConflict.region)}</p>
      <h2 id="country-title">${escapeHtml(countryName)}</h2>
      <p>${issues.length} tracked ${issues.length === 1 ? "situation" : "situations"}</p>
    </header>
    ${issues.length > 1 ? renderIssueTabs(issues) : ""}
    <article id="issue-profile">
      ${renderIssueProfile(activeConflict)}
    </article>
  `;

  for (const button of elements.panelContent.querySelectorAll("[data-conflict-id]")) {
    button.addEventListener("click", () => {
      state.activeConflictId = button.dataset.conflictId;
      renderCountryPanel(countryName, issues);
    });
  }
}

function renderIssueTabs(issues) {
  return `
    <div class="issue-tabs" aria-label="Situations involving this country">
      ${issues
        .map(
          (conflict) => `
            <button
              class="issue-tab scope-${conflict.scope.toLowerCase()} ${
                conflict.id === state.activeConflictId ? "active" : ""
              }"
              type="button"
              data-conflict-id="${escapeAttribute(conflict.id)}"
            >
              <span>
                <strong>${escapeHtml(conflict.title)}</strong>
                <small>${escapeHtml(conflict.scope)} · ${escapeHtml(conflict.type)}</small>
              </span>
              <span class="status-pill ${conflict.status.toLowerCase()}">${escapeHtml(conflict.status)}</span>
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderIssueProfile(conflict) {
  const newsItems = state.news?.items?.[conflict.id] ?? [];
  const history = conflict.historical_context
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  return `
    <div class="profile-meta">
      <span class="scope-pill ${conflict.scope.toLowerCase()}">${escapeHtml(conflict.scope)}</span>
      <span class="status-pill ${conflict.status.toLowerCase()}">${escapeHtml(conflict.status)}</span>
      <span class="impact-pill">${escapeHtml(conflict.impact_level)} impact</span>
    </div>
    <h3 class="profile-title">${escapeHtml(conflict.title)}</h3>
    <p class="summary">${escapeHtml(conflict.summary)}</p>

    <section class="profile-section">
      <h4>Historical context</h4>
      ${history}
    </section>

    <section class="profile-section">
      <h4>Strategic impact</h4>
      ${renderStrategicImpact(conflict.strategic_impact)}
    </section>

    <section class="profile-section">
      <h4>Latest reporting</h4>
      <p class="news-meta">${newsMetaText()}</p>
      ${renderNews(newsItems)}
    </section>

    ${renderSourceLinks(conflict.source_links)}
    ${conflict.updated_at ? `<p class="editorial-date">Editorial review ${formatDate(conflict.updated_at)}</p>` : ""}
  `;
}

function renderStrategicImpact(markdown) {
  const items = String(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-\s*/, ""));

  return `
    <ul>
      ${items
        .map((item) => {
          const match = item.match(/^\*\*(.+?):\*\*\s*(.*)$/);
          return match
            ? `<li><strong>${escapeHtml(match[1])}:</strong> ${escapeHtml(match[2])}</li>`
            : `<li>${escapeHtml(item)}</li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderNews(newsItems) {
  if (newsItems.length === 0) {
    return "<p>No recent headline matched this situation in the current refresh.</p>";
  }

  return `
    <ul class="news-list">
      ${newsItems
        .slice(0, 8)
        .map(
          (article) => `
            <li>
              <a href="${escapeAttribute(article.url)}" target="_blank" rel="noopener noreferrer">
                <strong>${escapeHtml(article.title)}</strong>
                <small>${escapeHtml(
                  [
                    article.source,
                    article.provider && article.provider !== article.source ? article.provider : null,
                    article.published_at ? formatDate(article.published_at) : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                )}</small>
              </a>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderSourceLinks(sourceLinks) {
  if (!Array.isArray(sourceLinks) || sourceLinks.length === 0) {
    return "";
  }

  return `
    <div class="source-links">
      ${sourceLinks
        .map(
          (url, index) =>
            `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">Background source${
              sourceLinks.length > 1 ? ` ${index + 1}` : ""
            }</a>`,
        )
        .join("")}
    </div>
  `;
}

function newsMetaText() {
  if (!state.news) {
    return "News data unavailable";
  }

  const updated = formatDate(state.news.generated_at);
  const generatedAt = Date.parse(state.news.generated_at);
  const isStale = Number.isFinite(generatedAt) && Date.now() - generatedAt > 48 * 60 * 60 * 1000;
  const freshness = isStale ? " · update delayed" : "";
  return state.news.sample
    ? `Preview headlines · snapshot ${updated}${freshness}`
    : `Frequently refreshed from ${state.news.provider} · updated ${updated}${freshness}`;
}

function closeCountryPanel() {
  elements.panel.hidden = true;
  elements.panelBackdrop.hidden = true;

  const selectedPath = state.selectedIso ? state.countryPaths.get(state.selectedIso) : null;
  selectedPath?.classList.remove("selected");
  state.selectedIso = null;
  state.activeConflictId = null;
  resetMapView();
  selectedPath?.focus();
}

function focusMapOnPath(path) {
  if (!path) {
    return;
  }

  const bounds = path.getBBox();
  const longestSide = Math.max(bounds.width, bounds.height, 80);
  state.zoom = Math.min(3.2, Math.max(1.35, 360 / longestSide));
  state.zoomCenter = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  applyMapTransform();
}

function changeZoom(delta) {
  state.zoom = Math.min(4, Math.max(1, state.zoom + delta));
  clampZoomCenter();
  applyMapTransform();
}

function resetMapView() {
  state.zoom = 1;
  state.zoomCenter = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  applyMapTransform();
}

function centerMapForViewport() {
  const mapStage = elements.map.closest(".map-stage");
  if (!mapStage) {
    return;
  }

  mapStage.scrollLeft = window.matchMedia("(max-width: 760px)").matches
    ? (mapStage.scrollWidth - mapStage.clientWidth) / 2
    : 0;
}

function applyMapTransform() {
  const target = visibleMapCenter();
  clampZoomCenter();
  const translateX = target.x - state.zoomCenter.x * state.zoom;
  const translateY = target.y - state.zoomCenter.y * state.zoom;
  elements.countryLayer.setAttribute(
    "transform",
    `translate(${translateX.toFixed(2)} ${translateY.toFixed(2)}) scale(${state.zoom.toFixed(2)})`,
  );
  elements.map.classList.toggle("is-zoomed", state.zoom > 1);
}

function visibleMapCenter() {
  const viewport = visibleMapViewport();
  return {
    x: viewport.left + (viewport.right - viewport.left) / 2,
    y: viewport.top + (viewport.bottom - viewport.top) / 2,
  };
}

function visibleMapViewport() {
  const mapBounds = elements.map.getBoundingClientRect();
  const scale = Math.min(mapBounds.width / MAP_WIDTH, mapBounds.height / MAP_HEIGHT);
  const contentWidth = MAP_WIDTH * scale;
  const contentHeight = MAP_HEIGHT * scale;
  const contentLeft = mapBounds.left + (mapBounds.width - contentWidth) / 2;
  const contentTop = mapBounds.top + (mapBounds.height - contentHeight) / 2;
  let visibleLeft = Math.max(0, contentLeft);
  let visibleTop = Math.max(0, contentTop);
  let visibleRight = Math.min(window.innerWidth, contentLeft + contentWidth);
  let visibleBottom = Math.min(window.innerHeight, contentTop + contentHeight);

  if (!elements.panel.hidden) {
    const panelBounds = elements.panel.getBoundingClientRect();
    const isSidePanel = panelBounds.height >= window.innerHeight * 0.9;

    if (isSidePanel) {
      visibleRight = Math.min(visibleRight, panelBounds.left);
    } else {
      visibleBottom = Math.min(visibleBottom, panelBounds.top);
    }
  }

  return {
    left: Math.min(MAP_WIDTH, Math.max(0, (visibleLeft - contentLeft) / scale)),
    right: Math.min(MAP_WIDTH, Math.max(0, (visibleRight - contentLeft) / scale)),
    top: Math.min(MAP_HEIGHT, Math.max(0, (visibleTop - contentTop) / scale)),
    bottom: Math.min(MAP_HEIGHT, Math.max(0, (visibleBottom - contentTop) / scale)),
  };
}

function clampZoomCenter() {
  const viewport = visibleMapViewport();
  const target = {
    x: viewport.left + (viewport.right - viewport.left) / 2,
    y: viewport.top + (viewport.bottom - viewport.top) / 2,
  };
  const minimumX = (target.x - viewport.left) / state.zoom;
  const maximumX = MAP_WIDTH - (viewport.right - target.x) / state.zoom;
  const minimumY = (target.y - viewport.top) / state.zoom;
  const maximumY = MAP_HEIGHT - (viewport.bottom - target.y) / state.zoom;

  state.zoomCenter.x = Math.min(maximumX, Math.max(minimumX, state.zoomCenter.x));
  state.zoomCenter.y = Math.min(maximumY, Math.max(minimumY, state.zoomCenter.y));
}

function mapRenderScale() {
  const bounds = elements.map.getBoundingClientRect();
  return Math.min(bounds.width / MAP_WIDTH, bounds.height / MAP_HEIGHT);
}

function beginMapPan(event) {
  if (state.zoom <= 1 || event.button !== 0) {
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    captured: false,
  };
}

function continueMapPan(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) {
    return;
  }

  const totalDistance = Math.hypot(
    event.clientX - state.drag.startX,
    event.clientY - state.drag.startY,
  );

  if (!state.drag.captured && totalDistance <= 4) {
    return;
  }

  const deltaX = event.clientX - state.drag.lastX;
  const deltaY = event.clientY - state.drag.lastY;

  if (!state.drag.captured) {
    state.drag.captured = true;
    state.suppressMapClick = true;
    elements.map.classList.add("is-panning");
    elements.map.setPointerCapture?.(event.pointerId);
  }

  state.drag.lastX = event.clientX;
  state.drag.lastY = event.clientY;

  const scale = mapRenderScale();
  state.zoomCenter.x -= deltaX / (scale * state.zoom);
  state.zoomCenter.y -= deltaY / (scale * state.zoom);
  clampZoomCenter();
  applyMapTransform();
}

function endMapPan(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) {
    return;
  }

  if (state.drag.captured) {
    window.setTimeout(() => {
      state.suppressMapClick = false;
    }, 0);
  }

  if (elements.map.hasPointerCapture?.(event.pointerId)) {
    elements.map.releasePointerCapture(event.pointerId);
  }
  elements.map.classList.remove("is-panning");
  state.drag = null;
}

function panMapWithWheel(event) {
  if (state.zoom <= 1) {
    return;
  }

  event.preventDefault();
  const scale = mapRenderScale();
  state.zoomCenter.x += event.deltaX / (scale * state.zoom);
  state.zoomCenter.y += event.deltaY / (scale * state.zoom);
  clampZoomCenter();
  applyMapTransform();
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  try {
    window.localStorage.setItem("conflict-tracker-theme", nextTheme);
  } catch {
    // The active theme still works when local storage is unavailable.
  }
  updateThemeControl();
}

function updateThemeControl() {
  const isDark = document.documentElement.dataset.theme === "dark";
  for (const themeToggle of elements.themeToggles) {
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }
  elements.themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute("content", isDark ? "#1a2631" : "#e8edf2");
  }
}

function showMapMessage(message) {
  window.clearTimeout(state.messageTimer);
  elements.mapMessage.textContent = message;
  elements.mapMessage.hidden = false;
  state.messageTimer = window.setTimeout(() => {
    elements.mapMessage.hidden = true;
  }, 2400);
}

function updateDataStatus(conflictDocument, newsDocument) {
  const internalCount = state.conflicts.filter((conflict) => conflict.scope === "Internal").length;
  const updateDate = newsDocument.generated_at ?? conflictDocument.generated_at;
  elements.dataStatus.textContent = `${state.conflicts.length} situations · ${internalCount} internal · updated ${formatDate(
    updateDate,
  )}`;
}

function formatDate(value) {
  const isCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  const date = new Date(isCalendarDate ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
