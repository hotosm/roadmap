/* ── DOM refs ─────────────────────────────────────────────── */
const timelineScroll = document.getElementById("timeline-scroll");
const timelineCanvas = document.getElementById("timeline-canvas");
const timelineAxis = document.getElementById("timeline-axis");
const timelineRows = document.getElementById("timeline-rows");
const timelineMeta = document.getElementById("timeline-meta");
const legendContainer = document.getElementById("legend");
const requestFab = document.getElementById("request-fab");
const requestModal = document.getElementById("request-modal");
const requestForm = document.getElementById("request-form");
const requestClose = document.getElementById("request-close");
const requestCancel = document.getElementById("request-cancel");

/* ── Config ───────────────────────────────────────────────── */
const DATA_URL = "./data/data.json";
const GITHUB_REQUESTS_REPO = "hotosm/requests";
const DAY_WIDTH = 18;
const ROW_HEIGHT = 48;
const BAR_HEIGHT = 34;

const CATEGORIES = {
  imagery: {
    label: "Imagery",
    description: "OpenAerialMap & DroneTM",
    color: "#4BB1B9",
    bg: "#E3F8F8",
    border: "#8FE1E3",
    order: 0,
  },
  digitization: {
    label: "Digitization",
    description: "Tasking Manager & fAIr",
    color: "#D73F3F",
    bg: "#FEECEF",
    border: "#EC9EA1",
    order: 1,
  },
  field: {
    label: "Field",
    description: "FieldTM & ChatMap",
    color: "#E8750C",
    bg: "#FFEBCF",
    border: "#FAA71E",
    order: 2,
  },
  "data-access": {
    label: "Data Access",
    description: "Export Tools & APIs",
    color: "#53688B",
    bg: "#E6E9EE",
    border: "#BFC8D6",
    order: 3,
  },
  "cross-project": {
    label: "Cross-Project",
    description: "Portal, Infrastructure & Shared Services",
    color: "#7C2E26",
    bg: "#FFE6DE",
    border: "#CFA59E",
    order: 4,
  },
};

const CATEGORY_ORDER = Object.keys(CATEGORIES).sort(
  (a, b) => CATEGORIES[a].order - CATEGORIES[b].order
);

let scheduledRangeStart = null;
let activeDetailPanel = null;
let roadmapItems = [];
let activeCategoryFilter = null;

function syncBodyModalState() {
  document.body.classList.toggle("modal-open", Boolean(activeDetailPanel) || !requestModal.hidden);
}

function getVisibleItems() {
  if (!activeCategoryFilter) return roadmapItems;
  return roadmapItems.filter((item) => item.category === activeCategoryFilter);
}

function normalizeIssues(issues) {
  if (Array.isArray(issues)) return issues;
  if (Array.isArray(issues?.nodes)) return issues.nodes;
  return [];
}

function normalizeRoadmapItem(item) {
  return {
    ...item,
    category: item.category || classifyCategory(item.title, item.group),
    issues: normalizeIssues(item.issues),
  };
}

function getRoadmapItemById(id) {
  return roadmapItems.find((item) => item.id === id) || null;
}

function updateTimelineMeta() {
  if (!activeCategoryFilter) {
    timelineMeta.textContent = "Click a project for details. Click a legend category to filter.";
    return;
  }

  const cat = CATEGORIES[activeCategoryFilter];
  timelineMeta.textContent = `Showing ${cat.label} items only. Click the category again to clear the filter.`;
}

/* ── Category classification ─────────────────────────────── */
function classifyCategory(title, group) {
  const t = title.toLowerCase();
  const g = group.toLowerCase();

  // Check initiative/group prefix first (text before the colon)
  if (/^imagery\b/.test(g)) return "imagery";
  if (/^digitisation\b|^digitization\b/.test(g)) return "digitization";
  if (/^field\b/.test(g)) return "field";
  if (/^data access\b|^data quality\b/.test(g)) return "data-access";
  if (/^experience\b/.test(g)) return "cross-project";

  // Fall back to title keywords
  if (/drone.?tm|openaerialmap|\boam\b/i.test(t) || /^imagery\b/i.test(t)) return "imagery";
  if (/\bfair\b|tasking.?manager|^osm sandbox\b/i.test(t)) return "digitization";
  if (/field.?tm|chatmap/i.test(t)) return "field";
  if (/data.?access|data.?quality|export.?tool|raw.?data|qgis/i.test(t)) return "data-access";
  return "cross-project";
}

/* ── Date helpers ─────────────────────────────────────────── */
function startOfDay(v) {
  const d = new Date(v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfQuarter(v) {
  const d = startOfDay(v);
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

function addMonths(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function addDays(d, n) {
  return new Date(startOfDay(d).getTime() + n * 864e5);
}

function diffDays(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / 864e5);
}

function monthWidth(d) {
  return diffDays(addMonths(d, 1), d) * DAY_WIDTH;
}

function fmtDate(v, opts = { month: "short", day: "numeric", year: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(v));
}

/* ── Utilities ────────────────────────────────────────────── */
function escapeHtml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function loadRoadmap() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load roadmap data (${response.status}). Run the generator first.`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.items;

  if (!Array.isArray(items)) {
    throw new Error("Roadmap data is invalid. Expected an items array.");
  }

  // Ensure every item has a category
  return items.map(normalizeRoadmapItem);
}

/* ── Render: legend ──────────────────────────────────────── */
function renderLegend() {
  legendContainer.innerHTML = "";
  CATEGORY_ORDER.forEach((key) => {
    const cat = CATEGORIES[key];
    const el = document.createElement("button");
    const isActive = activeCategoryFilter === key;
    el.className = "legend__item";
    el.type = "button";
    el.setAttribute("aria-pressed", String(isActive));
    if (isActive) el.classList.add("legend__item--active");
    el.innerHTML = `
      <span class="legend__dot" style="background:${cat.color}"></span>
      <span>${cat.label}</span>
    `;
    el.addEventListener("click", () => {
      activeCategoryFilter = isActive ? null : key;
      closeDetailPanel();
      updateTimelineMeta();
      renderLegend();
      renderScheduled(getVisibleItems());
    });
    legendContainer.appendChild(el);
  });
}

/* ── Render: axis ─────────────────────────────────────────── */
function renderAxis(start, end) {
  timelineAxis.innerHTML = "";
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const el = document.createElement("div");
    el.className = "axis-month";
    el.style.width = `${monthWidth(cursor)}px`;
    el.innerHTML = `
      <span class="axis-month__label">${fmtDate(cursor, { month: "short" })}</span>
      <span class="axis-month__year">${fmtDate(cursor, { year: "numeric" })}</span>
    `;
    timelineAxis.appendChild(el);
    cursor = addMonths(cursor, 1);
  }
}

/* ── Render: today line ───────────────────────────────────── */
function positionTodayLine() {
  const todayLine = document.querySelector(".today-line");
  if (!todayLine || !scheduledRangeStart) return;
  const todayX = diffDays(new Date(), scheduledRangeStart) * DAY_WIDTH;
  todayLine.style.left = `${todayX}px`;
  todayLine.style.display = "block";
}

/* ── Render: category section header ─────────────────────── */
function createCategoryHeader(categoryKey) {
  const cat = CATEGORIES[categoryKey];
  const row = document.createElement("div");
  row.className = "category-header";
  row.innerHTML = `
    <div class="category-header__inner">
      <span class="category-header__dot" style="background:${cat.color}"></span>
      <span class="category-header__name">${escapeHtml(cat.label)}</span>
      <span class="category-header__desc">${escapeHtml(cat.description)}</span>
    </div>
  `;
  return row;
}

/* ── Render: scheduled projects as bars ───────────────────── */
function renderScheduled(items) {
  timelineRows.innerHTML = "";
  const today = startOfDay(new Date());
  const scheduled = items.filter((i) => i.targetDate);

  if (!scheduled.length) {
    const emptyMessage = activeCategoryFilter
      ? `No scheduled ${CATEGORIES[activeCategoryFilter].label.toLowerCase()} items.`
      : "No scheduled roadmap items.";
    timelineRows.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    timelineAxis.innerHTML = "";
    scheduledRangeStart = null;
    return;
  }

  // Sort by category order, then by startDate
  scheduled.sort((a, b) => {
    const catA = CATEGORY_ORDER.indexOf(a.category);
    const catB = CATEGORY_ORDER.indexOf(b.category);
    if (catA !== catB) return catA - catB;
    if (!a.startDate && !b.startDate) return 0;
    if (!a.startDate) return 1;
    if (!b.startDate) return -1;
    return new Date(a.startDate) - new Date(b.startDate);
  });

  // Compute range
  const minimumRangeStart = addMonths(startOfQuarter(today), -3);
  const maximumRangeEnd = addDays(addMonths(startOfQuarter(today), 12), -1);
  const rangeStart = minimumRangeStart;
  const rangeEnd = maximumRangeEnd;
  const totalWidth = Math.max(diffDays(rangeEnd, rangeStart) * DAY_WIDTH, timelineScroll.clientWidth);

  scheduledRangeStart = rangeStart;
  timelineCanvas.style.width = `${totalWidth}px`;
  renderAxis(rangeStart, rangeEnd);

  let currentCategory = null;

  scheduled.forEach((item) => {
    // Insert category header when category changes
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      timelineRows.appendChild(createCategoryHeader(currentCategory));
    }

    const cat = CATEGORIES[item.category] || CATEGORIES["cross-project"];
    const statusSlug = slugify(item.status);

    const row = document.createElement("article");
    row.className = "timeline-row";
    row.style.height = `${ROW_HEIGHT}px`;

    const itemStart = item.startDate ? new Date(item.startDate) : today;
    const itemEnd = new Date(item.targetDate);
    if (itemEnd < rangeStart || itemStart > rangeEnd) return;

    const visibleStart = itemStart < rangeStart ? rangeStart : itemStart;
    const visibleEnd = itemEnd > rangeEnd ? rangeEnd : itemEnd;
    const leftPx = diffDays(visibleStart, rangeStart) * DAY_WIDTH;
    const widthPx = Math.max(diffDays(visibleEnd, visibleStart) * DAY_WIDTH, 80);

    const bar = document.createElement("div");
    bar.className = `roadmap-bar roadmap-bar--${statusSlug}`;
    bar.style.left = `${Math.max(0, leftPx)}px`;
    bar.style.width = `${widthPx}px`;
    bar.style.height = `${BAR_HEIGHT}px`;
    bar.title = `${item.title} - ${item.status}`;
    bar.dataset.leftPx = String(Math.max(0, leftPx));

    // Set category colors via custom properties
    bar.style.setProperty("--bar-color", cat.color);
    bar.style.setProperty("--bar-bg", cat.bg);
    bar.style.setProperty("--bar-border", cat.border);

    const content = document.createElement("div");
    content.className = "roadmap-bar__content";

    const statusDot = document.createElement("span");
    statusDot.className = `roadmap-bar__status roadmap-bar__status--${statusSlug}`;

    const label = document.createElement("span");
    label.className = "roadmap-bar__label";
    label.textContent = item.title;

    const dateBadge = document.createElement("span");
    dateBadge.className = "roadmap-bar__date";
    dateBadge.textContent = fmtDate(item.targetDate, { month: "short", day: "numeric" });

    content.append(statusDot, label, dateBadge);
    bar.append(content);

    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDetailPanel(item, bar);
    });

    row.appendChild(bar);
    timelineRows.appendChild(row);
  });

  positionTodayLine();
  requestAnimationFrame(() => {
    scrollTodayIntoView();
    updateBarLabelPositions();
  });
}

/* ── Detail modal ─────────────────────────────────────────── */
function closeDetailPanel() {
  if (activeDetailPanel) {
    activeDetailPanel.panel.remove();
    if (activeDetailPanel.bar) activeDetailPanel.bar.classList.remove("roadmap-bar--active");
    activeDetailPanel = null;
    syncBodyModalState();
  }
}

function toggleDetailPanel(item, bar) {
  const resolvedItem = getRoadmapItemById(item.id) || normalizeRoadmapItem(item);

  if (activeDetailPanel?.id === resolvedItem.id) {
    closeDetailPanel();
    return;
  }
  closeDetailPanel();

  bar.classList.add("roadmap-bar--active");
  const cat = CATEGORIES[resolvedItem.category] || CATEGORIES["cross-project"];
  const statusSlug = slugify(resolvedItem.status);

  const overlay = document.createElement("div");
  overlay.className = "detail-modal";
  overlay.innerHTML = `
    <div class="detail-modal__backdrop" data-close-modal="true"></div>
    <section class="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title-${resolvedItem.id}">
      <div class="detail-panel__header">
        <div class="detail-panel__title-row">
          <p class="detail-panel__category">
            <span class="detail-panel__category-dot" style="background:${cat.color}"></span>
            ${escapeHtml(cat.label)}
          </p>
          <h2 class="detail-panel__title" id="detail-title-${resolvedItem.id}">${escapeHtml(resolvedItem.title)}</h2>
        </div>
        <button class="detail-panel__close" aria-label="Close">&times;</button>
      </div>
      <div class="detail-panel__meta">
        <span class="status-pill status-pill--${statusSlug}">${escapeHtml(resolvedItem.status)}</span>
        <span>${resolvedItem.owner ? escapeHtml(resolvedItem.owner) : "Unassigned"}</span>
        <span>${resolvedItem.startDate ? fmtDate(resolvedItem.startDate) : "No start"} &rarr; ${fmtDate(resolvedItem.targetDate)}</span>
      </div>
      ${resolvedItem.summary ? `<p class="detail-panel__summary">${escapeHtml(resolvedItem.summary)}</p>` : ""}
      <div class="detail-panel__issues"></div>
    </section>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.dataset.closeModal === "true") {
      closeDetailPanel();
    }
  });

  overlay.querySelector(".detail-panel__close").addEventListener("click", closeDetailPanel);
  document.body.appendChild(overlay);
  activeDetailPanel = { id: resolvedItem.id, panel: overlay, bar };
  syncBodyModalState();

  renderIssuesInPanel(overlay.querySelector(".detail-panel__issues"), normalizeIssues(resolvedItem.issues));
}

function openRequestModal() {
  requestModal.hidden = false;
  syncBodyModalState();
  requestForm.elements.name.focus();
}

function closeRequestModal() {
  requestModal.hidden = true;
  syncBodyModalState();
}

function buildGitHubIssueUrl(formData) {
  const tool = String(formData.get("tool") || "").trim();
  const type = String(formData.get("type") || "").trim();
  const priority = String(formData.get("priority") || "Normal").trim();
  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const hub = String(formData.get("hub") || "").trim();

  const issueTitle = `[${tool}] ${title}`;
  const issueBody = [
    "### Request Details",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| **Requester** | ${name} (${email}) |`,
    `| **Regional Hub** | ${hub} |`,
    `| **Related Tool** | ${tool} |`,
    `| **Request Type** | ${type} |`,
    `| **Priority** | ${priority} |`,
    "",
    "### Description",
    "",
    description,
    "",
    "---",
    `*Submitted via [HOT Tech Roadmap](${window.location.href})*`,
  ].join("\n");

  const labels = [type.toLowerCase().replace(/ \/ /g, "-").replace(/ /g, "-")];

  const params = new URLSearchParams({
    title: issueTitle,
    body: issueBody,
    labels: labels.join(","),
  });

  return `https://github.com/${GITHUB_REQUESTS_REPO}/issues/new?${params.toString()}`;
}

/* ── Bar label sticky positioning ─────────────────────────── */
function updateBarLabelPositions() {
  const viewportPadding = 10;

  timelineRows.querySelectorAll(".roadmap-bar").forEach((bar) => {
    const content = bar.querySelector(".roadmap-bar__content");
    if (!content) return;

    const barLeft = Number(bar.dataset.leftPx || 0);
    const barWidth = bar.offsetWidth;
    const contentWidth = content.scrollWidth;
    const minLeft = viewportPadding;
    const maxLeft = Math.max(minLeft, barWidth - contentWidth - viewportPadding);
    const desiredLeft = timelineScroll.scrollLeft - barLeft + viewportPadding;
    const resolvedLeft = clamp(desiredLeft, minLeft, maxLeft);

    content.style.left = `${resolvedLeft}px`;
    content.dataset.align = resolvedLeft >= maxLeft - 1 && maxLeft > minLeft ? "right" : "left";
  });
}

/* ── GitHub link resolution ───────────────────────────────── */
function getGitHubUrl(issue) {
  const ghAttachment = issue.attachments?.nodes?.find(
    (a) => a.url && (a.url.includes("github.com") || a.sourceType === "github")
  );
  if (ghAttachment) return ghAttachment.url;

  const repoLabel = issue.labels?.nodes?.find((l) => l.name.startsWith("repo:"));
  if (repoLabel) {
    const repo = repoLabel.name.replace("repo:", "").trim();
    return `https://github.com/${repo}/issues?q=${encodeURIComponent(issue.title)}`;
  }

  return null;
}

function priorityIcon(p) {
  const icons = { 1: "\u{1F534}", 2: "\u{1F7E0}", 3: "\u{1F7E1}", 4: "\u{1F535}" };
  return icons[p] || "\u26AA";
}

function renderIssuesInPanel(container, issues) {
  if (!issues.length) {
    container.innerHTML = '<p class="detail-panel__empty">No issues linked to this project yet.</p>';
    return;
  }

  container.innerHTML = `<p class="detail-panel__count">${issues.length} issue${issues.length !== 1 ? "s" : ""}</p>`;
  const list = document.createElement("ul");
  list.className = "issue-list";

  issues.forEach((issue) => {
    const li = document.createElement("li");
    li.className = "issue-item";

    const ghUrl = getGitHubUrl(issue);
    const stateSlug = slugify(issue.state?.name || "unknown");
    const identifier = escapeHtml(issue.identifier);
    const title = escapeHtml(issue.title);
    const assignee = issue.assignee?.name ? escapeHtml(issue.assignee.name) : "";
    const priority = priorityIcon(issue.priority);

    li.innerHTML = `
      <span class="issue-item__priority">${priority}</span>
      <span class="issue-item__id">${identifier}</span>
      <span class="issue-item__title">${title}</span>
      <span class="issue-item__state issue-state--${stateSlug}">${escapeHtml(issue.state?.name || "")}</span>
      ${assignee ? `<span class="issue-item__assignee">${assignee}</span>` : ""}
      ${ghUrl ? `<a class="issue-item__link" href="${escapeHtml(ghUrl)}" target="_blank" rel="noopener noreferrer" title="Create on GitHub">&nearr;</a>` : ""}
    `;

    if (ghUrl) {
      li.classList.add("issue-item--linked");
      li.addEventListener("click", (e) => {
        if (e.target.tagName !== "A") window.open(ghUrl, "_blank", "noopener");
      });
    }

    list.appendChild(li);
  });

  container.appendChild(list);
}

/* ── Scroll ───────────────────────────────────────────────── */
function scrollTodayIntoView() {
  if (!scheduledRangeStart) return;
  const todayX = diffDays(new Date(), scheduledRangeStart) * DAY_WIDTH;
  timelineScroll.scrollLeft = Math.max(0, todayX - timelineScroll.clientWidth * 0.25);
}

/* ── Error ────────────────────────────────────────────────── */
function renderError(msg) {
  timelineAxis.innerHTML = "";
  timelineRows.innerHTML = `<div class="empty-state">${escapeHtml(msg)}</div>`;
}

/* ── Init ─────────────────────────────────────────────────── */
async function init() {
  updateTimelineMeta();
  renderLegend();

  try {
    roadmapItems = await loadRoadmap();
    renderLegend();
    renderScheduled(getVisibleItems());
  } catch (err) {
    renderError(err.message);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (activeDetailPanel) closeDetailPanel();
    if (!requestModal.hidden) closeRequestModal();
  }
});

timelineScroll.addEventListener("scroll", () => {
  updateBarLabelPositions();
}, { passive: true });

window.addEventListener("resize", () => {
  positionTodayLine();
  updateBarLabelPositions();
});

requestFab.addEventListener("click", openRequestModal);
requestClose.addEventListener("click", closeRequestModal);
requestCancel.addEventListener("click", closeRequestModal);
requestModal.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.dataset.closeRequest === "true") {
    closeRequestModal();
  }
});
requestForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const formData = new FormData(requestForm);
  const url = buildGitHubIssueUrl(formData);
  window.open(url, "_blank", "noopener");
  closeRequestModal();
  requestForm.reset();
});

init();
