import {
  CALLER_WORKFLOW_PATH,
  REUSABLE_WORKFLOW,
  argValue,
  gh,
  hasFlag,
  readJson,
  writeJson,
} from "./lib.mjs";

function selectRepos(mappings) {
  const only = argValue("--repos");
  if (only) {
    const set = new Set(only.split(",").map((s) => s.trim()).filter(Boolean));
    return mappings.filter((m) => set.has(m.repository) || set.has(m.repository.split("/")[1]));
  }
  if (hasFlag("--pilot")) {
    const pilot = readJson("pilot-selection.json");
    if (!pilot?.repositories?.length) throw new Error("pilot-selection.json missing");
    const set = new Set(pilot.repositories);
    return mappings.filter((m) => set.has(m.repository));
  }
  if (hasFlag("--all-mapped")) return mappings;
  throw new Error("Specify --repos, --pilot, or --all-mapped");
}

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
    return Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf8");
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
  if (sha) args.push("-f", `sha=${sha}`);
  return gh(args, { json: true });
}

function ensureBranch(repo, base, branch) {
  try {
    gh(["api", `repos/${repo}/git/ref/heads/${branch}`]);
    return;
  } catch {
    /* create */
  }
  const sha = gh(["api", `repos/${repo}/git/ref/heads/${base}`, "--jq", ".object.sha"]);
  try {
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
    ]);
  } catch (e) {
    if (!String(e.message).includes("Reference already exists")) throw e;
  }
}

function mergeVercelJsonDisableGit(existing) {
  let obj = {};
  if (existing && existing.trim()) {
    try {
      obj = JSON.parse(existing);
    } catch {
      throw new Error("existing vercel.json is not valid JSON; refusing to merge");
    }
  }
  const git = obj.git && typeof obj.git === "object" ? { ...obj.git } : {};
  if (git.deploymentEnabled === false) {
    return { content: JSON.stringify(obj, null, 2) + "\n", changed: false };
  }
  git.deploymentEnabled = false;
  obj.git = git;
  return { content: JSON.stringify(obj, null, 2) + "\n", changed: true };
}

function buildPrBody(entry) {
  const t = entry.targets
    .map(
      (x) =>
        `| \`${x.name}\` | \`${x.projectId}\` | \`${x.rootDirectory}\` | \`${x.productionBranch || "main"}\` |`
    )
    .join("\n");
  return `## chore: configure Vercel deployment targets

Adds GitHub Actions-based **production** deployment that does not depend on the commit author's Vercel account linkage.

### What was added
- \`.github/workflows/deploy-production.yml\` — caller workflow (push to default branch + manual dispatch)
- Repository variable \`VERCEL_DEPLOY_TARGETS\` (configured separately)
- Uses reusable workflow: \`${REUSABLE_WORKFLOW}\`

### Vercel targets

| Project | Project ID | Root Directory | Production Branch |
|--------|------------|----------------|-------------------|
${t}

### Behavior
- Push / merge to **\`${entry.defaultBranch}\`** deploys production via Actions + \`VERCEL_TOKEN\`
- Other branches do **not** trigger production
- Manual: \`gh workflow run deploy-production.yml --ref ${entry.defaultBranch}\`

### Rollback
\`\`\`bash
node scripts/rollback-migration.mjs --repo ${entry.repository}
\`\`\`

### Safety
- No fictitious commits for deploys
- No history rewrite
- Secrets are not stored in the repository
`;
}

async function processRepo(entry, opts) {
  const repo = entry.repository;
  const branch = entry.defaultBranch;
  const content = renderCallerWorkflow(branch);
  const result = {
    repository: repo,
    defaultBranch: branch,
    status: "pending",
    prUrl: null,
    notes: [],
  };

  const existing = getFileOnBranch(repo, CALLER_WORKFLOW_PATH, branch);
  if (existing && existing.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n")) {
    result.status = "skipped-identical";
    result.notes.push("caller workflow already identical on default branch");
    return result;
  }

  const snapshot = {
    repository: repo,
    at: new Date().toISOString(),
    defaultBranch: branch,
    callerWorkflow: existing,
    vercelJson: getFileOnBranch(repo, "vercel.json", branch),
    vercelTs: getFileOnBranch(repo, "vercel.ts", branch),
  };

  let vercelJsonUpdate = null;
  if (opts.disableGitDeploy) {
    if (snapshot.vercelTs) {
      result.notes.push("vercel.ts present — skipping vercel.json git.deploymentEnabled write");
    } else {
      const merged = mergeVercelJsonDisableGit(snapshot.vercelJson);
      if (merged.changed) {
        vercelJsonUpdate = merged.content;
        result.notes.push("will set git.deploymentEnabled=false in vercel.json");
      } else {
        result.notes.push("git.deploymentEnabled already false");
      }
    }
  }

  if (opts.direct) {
    putFile(repo, CALLER_WORKFLOW_PATH, content, branch, "chore: configure Vercel deployment targets");
    if (vercelJsonUpdate) {
      putFile(repo, "vercel.json", vercelJsonUpdate, branch, "chore: disable legacy Vercel Git deployments");
    }
    result.status = "direct-committed";
    const snaps = readJson("snapshots.json") || {};
    snaps[repo] = snapshot;
    writeJson("snapshots.json", snaps);
    return result;
  }

  const migBranch = "chore/vercel-actions-deploy";
  try {
    gh(["api", "--method", "DELETE", `repos/${repo}/git/refs/heads/${migBranch}`]);
  } catch {
    /* ok */
  }
  ensureBranch(repo, branch, migBranch);
  putFile(repo, CALLER_WORKFLOW_PATH, content, migBranch, "chore: configure Vercel deployment targets");
  if (vercelJsonUpdate) {
    putFile(repo, "vercel.json", vercelJsonUpdate, migBranch, "chore: disable legacy Vercel Git deployments");
  }

  let pr = null;
  try {
    const open = gh(
      ["pr", "list", "--repo", repo, "--head", migBranch, "--state", "open", "--json", "url,number"],
      { json: true }
    );
    if (open?.length) {
      pr = open[0];
      result.notes.push("reused open PR");
    }
  } catch {
    /* ok */
  }
  if (!pr) {
    const url = gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      branch,
      "--head",
      migBranch,
      "--title",
      "chore: configure Vercel deployment targets",
      "--body",
      buildPrBody(entry),
    ]);
    pr = { url };
  }
  result.prUrl = pr.url || pr;
  result.status = "pr-opened";

  if (opts.merge) {
    try {
      const list = gh(
        ["pr", "list", "--repo", repo, "--head", migBranch, "--state", "open", "--json", "number,url"],
        { json: true }
      );
      const num = list?.[0]?.number;
      try {
        gh(["pr", "merge", String(num), "--repo", repo, "--squash", "--delete-branch", "--admin"]);
        result.status = "merged";
      } catch {
        gh(["pr", "merge", String(num), "--repo", repo, "--squash", "--delete-branch"]);
        result.status = "merged";
      }
    } catch (e2) {
      result.status = "pr-opened-merge-failed";
      result.notes.push(`merge failed: ${e2.message}`);
    }
  }

  const snaps = readJson("snapshots.json") || {};
  snaps[repo] = snapshot;
  writeJson("snapshots.json", snaps);
  return result;
}

async function main() {
  const mappings = readJson("repository-project-mapping.json");
  if (!mappings?.length) throw new Error("Run discover first");
  const selected = selectRepos(mappings);
  const opts = {
    merge: hasFlag("--merge"),
    direct: hasFlag("--direct"),
    disableGitDeploy: hasFlag("--disable-git-deploy") || hasFlag("--disable-git-deploy-after"),
  };
  console.log(`Distributing caller workflow to ${selected.length} repos...`);
  const results = [];
  for (const entry of selected) {
    try {
      const r = await processRepo(entry, opts);
      results.push(r);
      console.log(`${String(r.status).padEnd(28)} ${r.repository} ${r.prUrl || ""}`);
    } catch (e) {
      results.push({ repository: entry.repository, status: "error", error: e.message });
      console.error(`ERROR ${entry.repository}: ${e.message}`);
    }
  }
  writeJson("distribute-result.json", { at: new Date().toISOString(), results });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});