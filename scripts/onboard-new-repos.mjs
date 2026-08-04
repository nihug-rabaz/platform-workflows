/**
 * Auto-onboard organization repositories for Actions-based Vercel production deploys.
 *
 * For each eligible repo (not archived/fork/empty):
 *  - ensure caller workflow (.github/workflows/deploy-production.yml)
 *  - ensure/find/create Vercel project linked to GitHub
 *  - set repo variable VERCEL_DEPLOY_TARGETS
 *  - disable Vercel git author-gated builds (ignore build step)
 *
 * VERCEL_TOKEN is expected at organization level (visibility: all|private).
 *
 * Usage:
 *   node scripts/onboard-new-repos.mjs [--dry-run] [--max N] [--repo ORG/NAME]
 */
import {
  CALLER_WORKFLOW_PATH,
  ORG,
  REUSABLE_WORKFLOW,
  argValue,
  gh,
  hasFlag,
  loadVercelAuthFromCli,
  vercelApi,
  writeJson,
} from "./lib.mjs";

const SKIP_REPOS = new Set([
  `${ORG}/platform-workflows`,
  `${ORG}/.github`,
]);

const DEFAULT_MAX = Number(process.env.ONBOARD_MAX || 20);

function renderCallerWorkflow(defaultBranch) {
  return `name: Deploy Production

on:
  push:
    branches:
      - ${defaultBranch}
  workflow_dispatch:
    inputs:
      deploy_ref:
        description: Branch, tag or commit SHA to deploy
        required: false
        type: string
        default: ""

permissions:
  contents: read

jobs:
  deploy:
    name: Deploy \${{ matrix.name }}
    strategy:
      fail-fast: false
      max-parallel: 3
      matrix: \${{ fromJSON(vars.VERCEL_DEPLOY_TARGETS) }}
    uses: ${REUSABLE_WORKFLOW}
    with:
      project-name: \${{ matrix.name }}
      vercel-project-id: \${{ matrix.project_id }}
      vercel-org-id: \${{ matrix.org_id }}
      working-directory: \${{ matrix.root_directory }}
      node-version: \${{ matrix.node_version }}
      deploy-ref: \${{ github.event.inputs.deploy_ref || github.sha }}
    secrets:
      VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
`;
}

function getFileOnBranch(repo, path, branch) {
  try {
    const b64 = gh([
      "api",
      `repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`,
      "--jq",
      ".content",
    ]);
    if (!b64) return null;
    return Buffer.from(String(b64).replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function putFile(repo, path, content, branch, message) {
  let sha = null;
  try {
    sha = gh([
      "api",
      `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      "--jq",
      ".sha",
    ]);
  } catch {
    sha = null;
  }
  const args = [
    "api",
    "--method",
    "PUT",
    `repos/${repo}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `content=${Buffer.from(content, "utf8").toString("base64")}`,
    "-f",
    `branch=${branch}`,
  ];
  if (sha) {
    args.push("-f", `sha=${sha}`);
  }
  return gh(args, { json: true });
}

function listOrgRepos() {
  return gh(
    [
      "repo",
      "list",
      ORG,
      "--limit",
      "500",
      "--json",
      "name,nameWithOwner,isArchived,isFork,isEmpty,isTemplate,defaultBranchRef,visibility",
    ],
    { json: true },
  );
}

async function listVercelProjects() {
  const projects = [];
  let until;
  for (;;) {
    const data = await vercelApi(`/v9/projects?limit=100${until ? `&until=${until}` : ""}`);
    const batch = data.projects || [];
    projects.push(...batch);
    if (!data.pagination?.next || batch.length === 0) break;
    until = data.pagination.next;
  }
  return projects;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findProjectForRepo(projects, repoName) {
  const exact = projects.find((p) => p.name === repoName);
  if (exact) return exact;
  const lower = projects.find((p) => p.name?.toLowerCase() === repoName.toLowerCase());
  if (lower) return lower;
  const n = normalize(repoName);
  return projects.find((p) => normalize(p.name) === n) || null;
}

function targetsBody(projectName, projectId, orgId) {
  return JSON.stringify({
    include: [
      {
        name: projectName,
        project_id: projectId,
        org_id: orgId,
        root_directory: ".",
        node_version: "22",
      },
    ],
  });
}

function setRepoVariable(repo, name, value) {
  // Prefer CLI (handles encryption correctly)
  try {
    gh(["variable", "set", name, "--repo", repo, "--body", value]);
    return;
  } catch {
    // fall through
  }
  try {
    gh(["api", "--method", "PATCH", `repos/${repo}/actions/variables/${name}`, "-f", `value=${value}`]);
  } catch {
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/actions/variables`,
      "-f",
      `name=${name}`,
      "-f",
      `value=${value}`,
    ]);
  }
}

function hasUsableCaller(content) {
  if (!content) return false;
  return (
    content.includes("platform-workflows/.github/workflows/vercel-production.yml") ||
    content.includes("Deploy Production")
  );
}

async function ensureVercelProject(repoFull, repoName, existing, orgId) {
  if (existing) return existing;
  const created = await vercelApi("/v10/projects", {
    method: "POST",
    body: {
      name: repoName.toLowerCase().replace(/[^a-z0-9._-]/gi, "-").slice(0, 100),
      framework: null,
      gitRepository: {
        type: "github",
        repo: repoFull,
      },
    },
  });
  return created;
}

async function disableGitBuilds(projectId) {
  await vercelApi(`/v9/projects/${projectId}`, {
    method: "PATCH",
    body: { commandForIgnoringBuildStep: "exit 0" },
  });
}

async function onboardOne(repoNode, projects, opts) {
  const full = repoNode.nameWithOwner;
  const name = repoNode.name;
  const branch = repoNode.defaultBranchRef?.name;
  const result = {
    repository: full,
    status: "skipped",
    actions: [],
    notes: [],
  };

  if (SKIP_REPOS.has(full) || repoNode.isTemplate) {
    result.notes.push("skip list / template");
    return result;
  }
  if (repoNode.isArchived || repoNode.isFork || repoNode.isEmpty || !branch) {
    result.notes.push("archived/fork/empty/no default branch");
    return result;
  }

  let project = findProjectForRepo(projects, name);
  const wantCreate = !hasFlag("--no-create-vercel");

  const existingCaller = getFileOnBranch(full, CALLER_WORKFLOW_PATH, branch);
  const callerOk = hasUsableCaller(existingCaller);

  let varOk = false;
  try {
    const v = gh(["api", `repos/${full}/actions/variables/VERCEL_DEPLOY_TARGETS`, "--jq", ".value"]);
    if (v && String(v).includes("project_id")) varOk = true;
  } catch {
    varOk = false;
  }

  // Actions path is ready once caller + targets exist (token path; no Vercel seat needed).
  if (callerOk && varOk) {
    result.status = "already-onboarded";
    result.notes.push("caller + targets present");
    if (!opts.dryRun && project) {
      try {
        await disableGitBuilds(project.id);
        result.actions.push("disabled-vercel-git-builds");
      } catch (e) {
        result.notes.push(`git-disable: ${e.message}`);
      }
    }
    return result;
  }

  if (!project && !wantCreate && !varOk) {
    result.status = "needs-vercel-project";
    result.notes.push("no matching Vercel project; pass without --no-create-vercel to auto-create");
    return result;
  }

  if (opts.dryRun) {
    result.status = "would-onboard";
    result.actions.push(callerOk ? "keep-caller" : "write-caller");
    result.actions.push(project ? "use-existing-vercel" : varOk ? "targets-without-named-project" : "create-vercel");
    result.actions.push(varOk ? "keep-targets" : "set-targets");
    result.actions.push("disable-git-builds");
    return result;
  }

  try {
    if (!project) {
      project = await ensureVercelProject(full, name, null, opts.orgId);
      projects.push(project);
      result.actions.push("created-vercel-project");
    } else {
      result.actions.push("matched-vercel-project");
    }

    const orgId = opts.orgId || process.env.VERCEL_ORG_ID;
    const body = targetsBody(project.name, project.id, orgId);
    if (!varOk) {
      setRepoVariable(full, "VERCEL_DEPLOY_TARGETS", body);
      result.actions.push("set-VERCEL_DEPLOY_TARGETS");
    }

    if (!callerOk) {
      putFile(
        full,
        CALLER_WORKFLOW_PATH,
        renderCallerWorkflow(branch),
        branch,
        "chore: enable production deploys via GitHub Actions + VERCEL_TOKEN",
      );
      result.actions.push("wrote-caller-workflow");
    }

    try {
      await disableGitBuilds(project.id);
      result.actions.push("disabled-vercel-git-builds");
    } catch (e) {
      result.notes.push(`git-disable: ${e.message}`);
    }

    result.status = "onboarded";
    result.projectId = project.id;
    result.projectName = project.name;
  } catch (e) {
    result.status = "error";
    result.error = e.message;
  }
  return result;
}

async function main() {
  loadVercelAuthFromCli();
  if (!process.env.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN required");
  if (!process.env.VERCEL_ORG_ID) throw new Error("VERCEL_ORG_ID required");

  const dryRun = hasFlag("--dry-run");
  const max = Number(argValue("--max", DEFAULT_MAX));
  const only = argValue("--repo");
  const orgId = process.env.VERCEL_ORG_ID;

  console.log(`Onboarding org=${ORG} dryRun=${dryRun} max=${max}`);

  let repos = listOrgRepos();
  if (only) {
    const key = only.includes("/") ? only : `${ORG}/${only}`;
    repos = repos.filter((r) => r.nameWithOwner === key || r.name === only);
  }

  const projects = await listVercelProjects();
  console.log(`repos=${repos.length} vercelProjects=${projects.length}`);

  const results = [];
  let changed = 0;
  for (const r of repos) {
    if (changed >= max && !only) {
      results.push({
        repository: r.nameWithOwner,
        status: "deferred-max",
        notes: [`max ${max} reached this run`],
      });
      continue;
    }
    const out = await onboardOne(r, projects, { dryRun, orgId });
    results.push(out);
    if (out.status === "onboarded" || out.status === "would-onboard") changed += 1;
    const mark = String(out.status).padEnd(18);
    console.log(`${mark} ${out.repository} ${out.actions?.join(",") || out.notes?.join(";") || ""}`);
  }

  writeJson("onboard-result.json", {
    at: new Date().toISOString(),
    dryRun,
    org: ORG,
    results,
  });

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log("summary", summary);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
