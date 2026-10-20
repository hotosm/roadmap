#!/usr/bin/env node

// Apply a reviewed roadmap plan (plans/*.yaml) to Linear.
//
//   node scripts/apply.js plans/2026-10-13.yaml           # dry run (default)
//   node scripts/apply.js plans/2026-10-13.yaml --apply   # write to Linear
//
// Each change is checked against current Linear state first: if any `from:` value no
// longer matches, the whole change is skipped and reported.

const fs = require("fs/promises");
const path = require("path");
const YAML = require("yaml");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const ENV_PATH = path.resolve(__dirname, "../.env");

const STATE_QUERY = `
  query State {
    projectStatuses { nodes { id name } }
    teams { nodes { id key } }
    users(first: 250, includeDisabled: true) { nodes { id name displayName email active } }
  }
`;

const PROJECTS_QUERY = `
  query Projects($after: String) {
    projects(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        description
        startDate
        targetDate
        status { name }
        lead { id name displayName email }
        members { nodes { id } }
        projectMilestones(first: 50) { nodes { id name targetDate } }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) { id identifier title project { id name } projectMilestone { id name } }
  }
`;

const MUTATIONS = {
  projectCreate: `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }`,
  projectUpdate: `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success } }`,
  milestoneCreate: `mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success projectMilestone { id } } }`,
  milestoneUpdate: `mutation($id: String!, $input: ProjectMilestoneUpdateInput!) { projectMilestoneUpdate(id: $id, input: $input) { success } }`,
  milestoneDelete: `mutation($id: String!) { projectMilestoneDelete(id: $id) { success } }`,
  issueUpdate: `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
};

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

// "2026-Q4" <-> dates

function parseQuarter(value) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(value));
  if (!match) throw new Error(`Invalid quarter "${value}" (expected e.g. 2026-Q4)`);
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function quarterStart(value) {
  const { year, quarter } = parseQuarter(value);
  return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
}

function quarterEnd(value) {
  const { year, quarter } = parseQuarter(value);
  const lastDay = new Date(Date.UTC(year, quarter * 3, 0)).getUTCDate();
  return `${year}-${String(quarter * 3).padStart(2, "0")}-${lastDay}`;
}

function dateToQuarter(date) {
  if (!date) return null;
  const [year, month] = date.split("-").map(Number);
  return `${year}-Q${Math.ceil(month / 3)}`;
}

function sameName(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

class Plan {
  constructor(apiKey, apply) {
    this.apiKey = apiKey;
    this.apply = apply;
    this.log = [];
    this.warnings = 0; // per change: things that didn't happen (rejected assignments, skipped moves)
    this.fakeIds = 0;
    this.aliases = {}; // old project name -> new name, from renames in the plan (so re-runs still find them)
    this.issueProjects = new Map(); // issue id -> { projectId, milestoneId } as changed by this run (so dry runs stay accurate)
  }

  async fetchIssue(identifier) {
    const { issue } = await linearRequest(this.apiKey, ISSUE_QUERY, { id: identifier });
    if (!issue) throw new Error(`Issue ${identifier} not found`);
    if (this.issueProjects.has(issue.id)) {
      const { projectId, milestoneId } = this.issueProjects.get(issue.id);
      issue.project = projectId ? this.projects.find((p) => p.id === projectId) : null;
      issue.projectMilestone = milestoneId ? { id: milestoneId } : null;
    }
    return issue;
  }

  async load(teamKey) {
    const state = await linearRequest(this.apiKey, STATE_QUERY, {});
    this.statuses = state.projectStatuses.nodes;
    this.users = state.users.nodes;
    this.team = state.teams.nodes.find((team) => team.key === teamKey);
    if (!this.team) throw new Error(`Team "${teamKey}" not found`);

    this.projects = [];
    let after = null;
    while (true) {
      const data = await linearRequest(this.apiKey, PROJECTS_QUERY, { after });
      this.projects.push(...data.projects.nodes);
      if (!data.projects.pageInfo.hasNextPage) break;
      after = data.projects.pageInfo.endCursor;
    }
  }

  findProject(name) {
    const find = (n) => this.projects.find((p) => sameName(p.name, n));
    const project = find(name) || find(this.aliases[name.toLowerCase()]);
    if (!project) throw new Error(`Project not found: "${name}"`);
    return project;
  }

  warn(message) {
    this.warnings += 1;
    console.log(`    ! ${message}`);
  }

  fakeId() {
    this.fakeIds += 1;
    return `(dry-run ${this.fakeIds})`;
  }

  statusId(name) {
    const status = this.statuses.find((s) => sameName(s.name, name));
    if (!status) throw new Error(`Unknown status "${name}" (have: ${this.statuses.map((s) => s.name).join(", ")})`);
    return status.id;
  }

  // Unknown users only warn, so the rest of the change still applies. Inactive users
  // (e.g. invite not yet accepted) are matched, preferring an active account if both exist.
  userId(ref) {
    const matches = this.users.filter((u) => [u.name, u.displayName, u.email].some((v) => sameName(v, ref)));
    const user = matches.find((u) => u.active) || matches[0];
    if (!user) this.warn(`"${ref}" is not a Linear user, leaving unset`);
    else if (!user.active) console.log(`    ! "${ref}" is not active in Linear yet (pending invite?)`);
    return user?.id;
  }

  // Members are added to any existing ones, never removed
  memberIds(refs, project) {
    const existing = project?.members?.nodes.map((m) => m.id) || [];
    const added = refs.map((ref) => this.userId(ref)).filter(Boolean);
    return [...new Set([...existing, ...added])];
  }

  // Lead and members go in their own mutation so that, if Linear rejects a user (e.g. a
  // pending invite), the rest of the change is still applied
  async assignPeople(project, lead, members) {
    const input = {};
    if (lead !== undefined) {
      const leadId = lead ? this.userId(lead) : null;
      if (leadId !== undefined && leadId !== (project.lead?.id ?? null)) input.leadId = leadId;
    }
    if (members) {
      const memberIds = this.memberIds(members, project);
      if (memberIds.length !== (project.members?.nodes.length ?? 0)) input.memberIds = memberIds;
    }
    if (!Object.keys(input).length) return; // already assigned

    const who = [lead !== undefined && `lead=${lead}`, members && `members=${members.join(", ")}`].filter(Boolean).join(", ");
    try {
      await this.mutate(`assign "${project.name}": ${who}`, MUTATIONS.projectUpdate, { id: project.id, input });
    } catch (error) {
      this.warn(`could not assign ${who}: ${error.message}`);
    }
  }

  // Run (or just print) a mutation. Only logged once Linear confirms it.
  async mutate(description, query, variables) {
    let result = null;
    if (this.apply) {
      result = await linearRequest(this.apiKey, query, variables);
      if (Object.values(result)[0]?.success === false) throw new Error(`Linear rejected: ${description}`);
      this.log.push(description);
    }
    console.log(`    ${this.apply ? "✓" : "·"} ${description}`);
    return result;
  }

  // Current value of a plan field on a project, in plan terms
  currentValue(project, field) {
    switch (field) {
      case "status": return project.status?.name ?? null;
      case "startQuarter": return dateToQuarter(project.startDate);
      case "targetQuarter": return dateToQuarter(project.targetDate);
      case "name": return project.name;
      case "description": return project.description || null;
      case "lead": return project.lead?.name ?? null; // not checked: re-runs retry assignments
      default: throw new Error(`Unsupported field "${field}"`);
    }
  }

  projectInput(fields) {
    const input = {};
    if (fields.name !== undefined) input.name = fields.name;
    if (fields.description !== undefined) input.description = fields.description || "";
    if (fields.status !== undefined) input.statusId = this.statusId(fields.status);
    if (fields.startQuarter !== undefined) {
      input.startDate = fields.startQuarter ? quarterStart(fields.startQuarter) : null;
      input.startDateResolution = fields.startQuarter ? "quarter" : null;
    }
    if (fields.targetQuarter !== undefined) {
      input.targetDate = fields.targetQuarter ? quarterEnd(fields.targetQuarter) : null;
      input.targetDateResolution = fields.targetQuarter ? "quarter" : null;
    }
    return input;
  }

  async updateProject(change) {
    const project = this.findProject(change.project);
    const fields = {};

    for (const [field, value] of Object.entries(change.set || {})) {
      const to = value && typeof value === "object" ? value.to : value;
      const current = field === "lead" ? null : this.currentValue(project, field);
      if (field !== "lead" && String(current) === String(to ?? null)) continue; // already applied
      if (value && typeof value === "object" && "from" in value && field !== "lead") {
        const expected = value.from ?? null;
        if (String(current) !== String(expected)) {
          throw new Error(`${field} is now "${current}", plan expected "${expected}"`);
        }
      }
      fields[field] = to;
    }

    const { lead, ...rest } = fields;
    const input = this.projectInput(rest);
    if (Object.keys(input).length) {
      const summary = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(", ");
      await this.mutate(`update "${project.name}": ${summary}`, MUTATIONS.projectUpdate, { id: project.id, input });
      if (rest.name !== undefined) project.name = rest.name;
      if (rest.description !== undefined) project.description = rest.description;
      if (rest.status !== undefined) project.status = { name: rest.status };
      if (rest.startQuarter !== undefined) project.startDate = rest.startQuarter && quarterStart(rest.startQuarter);
      if (rest.targetQuarter !== undefined) project.targetDate = rest.targetQuarter && quarterEnd(rest.targetQuarter);
    } else {
      console.log(`    – "${project.name}" already up to date`);
    }
    await this.assignPeople(project, lead, change.members);
  }

  async createProject(change) {
    const existing = this.projects.find((p) => sameName(p.name, change.name)) ||
      this.projects.find((p) => sameName(p.name, this.aliases[change.name.toLowerCase()]));
    if (existing) {
      // Re-run after a partial apply: finish the remaining steps
      console.log(`    – "${change.name}" already exists, checking the rest`);
      await this.assignPeople(existing, change.lead, change.members);
      if (change.milestones) await this.addMilestones({ project: change.name, milestones: change.milestones });
      if (change.issues) await this.linkIssues({ project: change.name, issues: change.issues, move: change.move });
      return;
    }

    const input = {
      ...this.projectInput({
        name: change.name,
        description: change.description,
        status: change.status,
        startQuarter: change.startQuarter,
        targetQuarter: change.targetQuarter,
      }),
      teamIds: [this.team.id],
    };

    const result = await this.mutate(
      `create "${change.name}" [${change.status}, ${change.startQuarter ?? "?"} → ${change.targetQuarter ?? "?"}]`,
      MUTATIONS.projectCreate,
      { input },
    );

    const project = {
      id: result?.projectCreate.project.id ?? this.fakeId(),
      name: change.name,
      projectMilestones: { nodes: [] },
    };
    this.projects.push(project);

    await this.assignPeople(project, change.lead, change.members);

    if (change.milestones) await this.addMilestones({ project: change.name, milestones: change.milestones });
    if (change.issues) await this.linkIssues({ project: change.name, issues: change.issues, move: change.move });
  }

  async addMilestones(change) {
    const project = this.findProject(change.project);
    for (const milestone of change.milestones) {
      if (project.projectMilestones.nodes.some((m) => sameName(m.name, milestone.name))) {
        console.log(`    – milestone already exists: "${milestone.name}"`);
        continue;
      }
      const input = { projectId: project.id, name: milestone.name };
      if (milestone.targetQuarter) input.targetDate = quarterEnd(milestone.targetQuarter);
      const result = await this.mutate(
        `add milestone to "${project.name}": "${milestone.name}"${milestone.targetQuarter ? ` (${milestone.targetQuarter})` : ""}`,
        MUTATIONS.milestoneCreate,
        { input },
      );
      project.projectMilestones.nodes.push({
        id: result?.projectMilestoneCreate.projectMilestone.id ?? this.fakeId(),
        name: milestone.name,
      });
    }
  }

  async moveMilestone(change) {
    const project = this.findProject(change.project);
    const target = this.findProject(change.to);
    if (target.projectMilestones.nodes.some((m) => sameName(m.name, change.milestone))) {
      console.log(`    – milestone already in "${target.name}"`);
      return;
    }
    const milestone = this.findMilestone(project, change.milestone);
    await this.mutate(
      `move milestone "${milestone.name}" from "${project.name}" → "${target.name}"`,
      MUTATIONS.milestoneUpdate,
      { id: milestone.id, input: { projectId: target.id } },
    );
    project.projectMilestones.nodes = project.projectMilestones.nodes.filter((m) => m !== milestone);
    target.projectMilestones.nodes.push(milestone);
  }

  findMilestone(project, name) {
    const milestone = project.projectMilestones.nodes.find((m) => sameName(m.name, name));
    if (!milestone) throw new Error(`Milestone "${name}" not found in "${project.name}"`);
    return milestone;
  }

  async updateMilestone(change) {
    const project = this.findProject(change.project);
    const set = change.set || {};
    const newName = set.name?.to ?? set.name;
    const renamed = newName && project.projectMilestones.nodes.find((m) => sameName(m.name, newName));
    const milestone = renamed || this.findMilestone(project, change.milestone);
    const input = {};
    if (newName && !renamed) input.name = newName;
    if (set.targetQuarter) {
      const quarter = set.targetQuarter.to ?? set.targetQuarter;
      const date = quarter ? quarterEnd(quarter) : null;
      if (milestone.targetDate !== date) input.targetDate = date;
    }
    if (!Object.keys(input).length) {
      console.log(`    – milestone "${milestone.name}" already up to date`);
      return;
    }
    await this.mutate(
      `update milestone "${milestone.name}" in "${project.name}": ${JSON.stringify(input)}`,
      MUTATIONS.milestoneUpdate,
      { id: milestone.id, input },
    );
    if (input.name) milestone.name = input.name;
    if (input.targetDate !== undefined) milestone.targetDate = input.targetDate;
  }

  async deleteMilestone(change) {
    const project = this.findProject(change.project);
    const milestone = project.projectMilestones.nodes.find((m) => sameName(m.name, change.milestone));
    if (!milestone) {
      console.log(`    – milestone already gone`);
      return;
    }
    await this.mutate(`delete milestone "${milestone.name}" from "${project.name}"`, MUTATIONS.milestoneDelete, {
      id: milestone.id,
    });
    project.projectMilestones.nodes = project.projectMilestones.nodes.filter((m) => m !== milestone);
  }

  // Link issues to a project (and optionally one of its milestones). Issues already in a
  // different project are only moved when the change has `move: true`.
  async linkIssues(change) {
    const project = this.findProject(change.project);
    const milestone = change.milestone ? this.findMilestone(project, change.milestone) : null;
    const target = milestone ? `"${project.name}" / "${milestone.name}"` : `"${project.name}"`;

    for (const identifier of change.issues) {
      const issue = await this.fetchIssue(identifier);
      const sameProject = issue.project?.id === project.id;
      if (sameProject && (!milestone || issue.projectMilestone?.id === milestone.id)) {
        console.log(`    – ${identifier} already linked`);
        continue;
      }
      if (issue.project && !sameProject && !change.move) {
        this.warn(`${identifier} is in "${issue.project.name}", skipping (set move: true to move it)`);
        continue;
      }

      const input = { projectId: project.id };
      if (milestone) input.projectMilestoneId = milestone.id;
      const verb = issue.project && !sameProject ? `move ${identifier} from "${issue.project.name}"` : `link ${identifier}`;
      await this.mutate(`${verb} "${issue.title}" → ${target}`, MUTATIONS.issueUpdate, { id: issue.id, input });
      this.issueProjects.set(issue.id, { projectId: project.id, milestoneId: milestone?.id ?? null });
    }
  }

  async run(change) {
    switch (change.op) {
      case "update_project": return this.updateProject(change);
      case "create_project": return this.createProject(change);
      case "add_milestones": return this.addMilestones(change);
      case "update_milestone": return this.updateMilestone(change);
      case "delete_milestone": return this.deleteMilestone(change);
      case "move_milestone": return this.moveMilestone(change);
      case "link_issues": return this.linkIssues(change);
      default: throw new Error(`Unknown op "${change.op}"`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const planPath = args.find((arg) => !arg.startsWith("--"));
  if (!planPath) {
    console.error("Usage: node scripts/apply.js plans/<plan>.yaml [--apply]");
    process.exit(1);
  }

  const env = { ...(await loadEnvFile()), ...process.env };
  if (!env.LINEAR_API_KEY) throw new Error("LINEAR_API_KEY is not set");

  const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
  if (apply && plan.approved !== true) {
    console.error("Plan is not approved: set `approved: true` in the plan file first.");
    process.exit(1);
  }

  const problems = validatePlan(plan);
  if (problems.length) {
    console.error(`Plan has errors, nothing was changed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }

  const runner = new Plan(env.LINEAR_API_KEY, apply);
  await runner.load(plan.team || "TECH");
  for (const change of plan.changes) {
    if (change.op === "update_project" && change.set?.name) {
      runner.aliases[change.project.toLowerCase()] = change.set.name.to ?? change.set.name;
    }
  }

  console.log(apply ? "Applying plan to Linear\n" : "Dry run (no changes made; pass --apply to write)\n");

  const results = { applied: [], partial: [], failed: [] };
  for (const change of plan.changes) {
    console.log(`[${change.id}] ${change.op} ${change.project || change.name}`);
    runner.warnings = 0;
    try {
      await runner.run(change);
      (runner.warnings ? results.partial : results.applied).push(change.id);
    } catch (error) {
      console.log(`    ✗ failed: ${error.message}`);
      results.failed.push({ id: change.id, reason: error.message });
    }
  }

  console.log(
    `\n${results.applied.length} changes ${apply ? "applied" : "ok"}, ` +
      `${results.partial.length} partial (see ! above), ${results.failed.length} failed`,
  );
  for (const failure of results.failed) console.log(`  - ${failure.id}: ${failure.reason}`);
  if (results.failed.length && apply) console.log("Fix the cause and re-run: finished changes are skipped.");

  if (apply) {
    const logPath = planPath.replace(/\.ya?ml$/, ".applied.json");
    await fs.writeFile(
      logPath,
      JSON.stringify({ appliedAt: new Date().toISOString(), ...results, mutations: runner.log }, null, 2) + "\n",
      "utf8",
    );
    console.log(`\nLog written to ${logPath}`);
  }

  if (results.failed.length || results.partial.length) process.exitCode = 1;
}

// Catch typos before anything is written
const OPS = {
  update_project: ["project", "set"],
  create_project: ["name", "status"],
  add_milestones: ["project", "milestones"],
  update_milestone: ["project", "milestone", "set"],
  delete_milestone: ["project", "milestone"],
  move_milestone: ["project", "milestone", "to"],
  link_issues: ["project", "issues"],
};
const CHANGE_KEYS = ["id", "op", "why", "project", "name", "description", "status", "lead", "members", "startQuarter",
  "targetQuarter", "milestones", "issues", "set", "milestone", "to", "move"];
const SET_KEYS = { update_project: ["name", "description", "status", "lead", "startQuarter", "targetQuarter"],
  update_milestone: ["name", "targetQuarter"] };

function validatePlan(plan) {
  const problems = [];
  if (plan.version !== 1) problems.push(`unsupported plan version "${plan.version}"`);
  if (!Array.isArray(plan.changes)) return [...problems, "`changes` must be a list"];
  const ids = new Set();
  for (const change of plan.changes) {
    const where = change.id || JSON.stringify(change).slice(0, 60);
    if (!change.id || ids.has(change.id)) problems.push(`${where}: missing or duplicate id`);
    ids.add(change.id);
    if (!OPS[change.op]) { problems.push(`${where}: unknown op "${change.op}"`); continue; }
    for (const key of OPS[change.op]) if (change[key] === undefined) problems.push(`${where}: missing "${key}"`);
    for (const key of Object.keys(change)) if (!CHANGE_KEYS.includes(key)) problems.push(`${where}: unknown key "${key}"`);
    for (const key of Object.keys(change.set || {})) {
      if (!SET_KEYS[change.op]?.includes(key)) problems.push(`${where}: can't set "${key}"`);
    }
    for (const quarter of [change.startQuarter, change.targetQuarter, ...(change.milestones || []).map((m) => m.targetQuarter)]) {
      if (quarter != null && !/^\d{4}-Q[1-4]$/.test(quarter)) problems.push(`${where}: invalid quarter "${quarter}"`);
    }
    if (change.startQuarter && change.targetQuarter && change.startQuarter > change.targetQuarter) {
      problems.push(`${where}: starts (${change.startQuarter}) after its target (${change.targetQuarter})`);
    }
    for (const name of [...(change.milestones || []).map((m) => m.name), change.set?.name?.to]) {
      if (name && name.length > 80) problems.push(`${where}: name over Linear's 80 character limit: "${name}"`);
    }
  }
  return problems;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
