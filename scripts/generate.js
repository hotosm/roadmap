#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const OUTPUT_PATH = path.resolve(__dirname, "../data/data.json");
const ENV_PATH = path.resolve(__dirname, "../.env");
const PAGE_SIZE = 50;
const ISSUE_PAGE_SIZE = 50;
const DETAIL_BATCH_SIZE = 5;

const PROJECTS_QUERY = `
  query RoadmapProjects($after: String) {
    projects(first: ${PAGE_SIZE}, after: $after, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        startDate
        targetDate
        state
        lead {
          name
        }
        initiatives(first: 5) {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

const PROJECT_ISSUES_QUERY = `
  query ProjectIssues($projectId: ID!, $after: String) {
    issues(
      first: ${ISSUE_PAGE_SIZE}
      after: $after
      filter: {
        project: { id: { eq: $projectId } }
        state: { type: { neq: "completed" } }
      }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        priority
        state {
          name
        }
        assignee {
          name
        }
        labels(first: 10) {
          nodes {
            name
          }
        }
        attachments(first: 5) {
          nodes {
            url
            title
            sourceType
          }
        }
      }
    }
  }
`;

const CATEGORY_ORDER = ['imagery', 'digitization', 'field', 'data-access', 'cross-project'];

function classifyCategory(name, group) {
  const t = name.toLowerCase();
  const g = group.toLowerCase();

  // Check initiative/group prefix first (text before the colon)
  if (/^imagery\b/.test(g)) return 'imagery';
  if (/^digitisation\b|^digitization\b/.test(g)) return 'digitization';
  if (/^field\b/.test(g)) return 'field';
  if (/^data access\b|^data quality\b/.test(g)) return 'data-access';
  if (/^experience\b/.test(g)) return 'cross-project';

  // Fall back to title keywords
  if (/drone.?tm|openaerialmap|\boam\b/i.test(t) || /^imagery\b/i.test(t)) return 'imagery';
  if (/\bfair\b|tasking.?manager|^osm sandbox\b/i.test(t)) return 'digitization';
  if (/field.?tm|chatmap/i.test(t)) return 'field';
  if (/data.?access|data.?quality|export.?tool|raw.?data|qgis/i.test(t)) return 'data-access';
  return 'cross-project';
}

function startOfDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function normalizeStatus(value) {
  const status = (value || "").toLowerCase();
  if (status.includes("done") || status.includes("complete")) return "Done";
  if (status.includes("progress") || status.includes("started")) return "In progress";
  if (status.includes("risk") || status.includes("blocked") || status.includes("paused")) return "At risk";
  return "Planned";
}

function summarize(value) {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function loadEnvFile() {
  try {
    const raw = await fs.readFile(ENV_PATH, "utf8");
    const entries = {};

    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) return;

      const key = trimmed.slice(0, equalsIndex).trim();
      const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) entries[key] = value;
    });

    return entries;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function linearRequest(apiKey, query, variables) {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (!response.ok || json.errors?.length) {
    const message = json.errors?.map((error) => error.message).join(", ") || `Linear ${response.status}`;
    throw new Error(message);
  }

  return json.data;
}

async function fetchAllProjects(apiKey) {
  const projects = [];
  let after = null;

  while (true) {
    const data = await linearRequest(apiKey, PROJECTS_QUERY, { after });
    const connection = data.projects;
    projects.push(...(connection.nodes || []));

    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return projects;
}

async function fetchIssuesForProject(apiKey, projectId) {
  const issues = [];
  let after = null;

  while (true) {
    const data = await linearRequest(apiKey, PROJECT_ISSUES_QUERY, { projectId, after });
    const connection = data.issues;
    issues.push(...(connection.nodes || []));

    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return issues;
}

async function enrichProjectsWithIssues(apiKey, projects) {
  const enriched = [];

  for (let index = 0; index < projects.length; index += DETAIL_BATCH_SIZE) {
    const batch = projects.slice(index, index + DETAIL_BATCH_SIZE);
    console.log(
      `Fetching open issues for projects ${index + 1}-${index + batch.length} of ${projects.length}`
    );
    const withIssues = await Promise.all(
      batch.map(async (project) => ({
        ...project,
        issues: await fetchIssuesForProject(apiKey, project.id),
      }))
    );
    enriched.push(...withIssues);
  }

  return enriched;
}

function transformProject(project) {
  const status = normalizeStatus(project.state);
  const target = project.targetDate ? startOfDay(project.targetDate) : null;
  let start = project.startDate ? startOfDay(project.startDate) : null;

  if (!start && target) {
    start = startOfDay(new Date(target.getTime() - 90 * 864e5));
  }

  const group = project.initiatives?.nodes?.[0]?.name || "Roadmap item";
  const category = classifyCategory(project.name, group);

  return {
    id: project.id,
    title: project.name,
    category,
    group,
    summary: summarize(project.description),
    status,
    owner: project.lead?.name || "",
    startDate: start ? start.toISOString() : null,
    targetDate: target ? target.toISOString() : null,
    issues: (project.issues || []).map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      state: issue.state ? { name: issue.state.name } : null,
      assignee: issue.assignee ? { name: issue.assignee.name } : null,
      labels: { nodes: issue.labels?.nodes || [] },
      attachments: { nodes: issue.attachments?.nodes || [] },
    })),
  };
}

async function main() {
  const env = await loadEnvFile();
  const apiKey = process.env.LINEAR_API_KEY || env.LINEAR_API_KEY || "";

  if (!apiKey) {
    throw new Error("Missing LINEAR_API_KEY in .env or environment.");
  }

  const projects = await fetchAllProjects(apiKey);
  console.log(`Fetched ${projects.length} projects from Linear`);
  const detailedProjects = await enrichProjectsWithIssues(apiKey, projects);
  const items = detailedProjects
    .map(transformProject)
    .sort((a, b) => {
      const catA = CATEGORY_ORDER.indexOf(a.category);
      const catB = CATEGORY_ORDER.indexOf(b.category);
      if (catA !== catB) return catA - catB;
      if (!a.startDate && !b.startDate) return 0;
      if (!a.startDate) return 1;
      if (!b.startDate) return -1;
      return new Date(a.startDate) - new Date(b.startDate);
    });

  const payload = {
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${items.length} roadmap items to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
