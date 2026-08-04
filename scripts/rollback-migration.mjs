import { CALLER_WORKFLOW_PATH, argValue, gh, hasFlag, readJson, writeJson } from "./lib.mjs";

function getFile(repo, path, branch) {
  try {
    const res = gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`], { json: true });
    return {
      content: Buffer.from(res.content.replace(/\n/g, ""), "base64").toString("utf8"),
      sha: res.sha,
    };
  } catch {
    return null;
  }
}

function deleteFile(repo, path, branch, sha, message) {
  gh([
    "api",
    "--method",
    "DELETE",
    `repos/${repo}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `sha=${sha}`,
    "-f",
    `branch=${branch}`,
  ]);
}

function putFile(repo, path, content, branch, message, sha) {
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
  gh(args);
}

function defaultBranch(repo) {
  return gh(["api", `repos/${repo}`, "--jq", ".default_branch"]);
}

async function main() {
  const repo = argValue("--repo");
  if (!repo) throw new Error("--repo ORG/NAME required");
  const viaPr = hasFlag("--via-pr");
  const restoreGit = hasFlag("--restore-git-deploy");
  const branch = defaultBranch(repo);
  const snapshot = (readJson("snapshots.json") || {})[repo] || null;
  const actions = [];
  const branchName = viaPr ? "chore/rollback-vercel-actions-deploy" : branch;

  if (viaPr) {
    try {
      gh(["api", "--method", "DELETE", `repos/${repo}/git/refs/heads/${branchName}`]);
    } catch {
      /* ok */
    }
    const sha = gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]);
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${branchName}`,
      "-f",
      `sha=${sha}`,
    ]);
  }

  const wf = getFile(repo, CALLER_WORKFLOW_PATH, branchName);
  if (wf) {
    deleteFile(repo, CALLER_WORKFLOW_PATH, branchName, wf.sha, "chore: rollback Vercel Actions production deployment workflow");
    actions.push("removed deploy-production.yml");
  } else {
    actions.push("caller workflow already absent");
  }

  if (restoreGit && snapshot && "vercelJson" in snapshot) {
    const current = getFile(repo, "vercel.json", branchName);
    if (snapshot.vercelJson === null && current) {
      deleteFile(repo, "vercel.json", branchName, current.sha, "chore: restore pre-migration vercel.json");
      actions.push("deleted vercel.json added by migration");
    } else if (snapshot.vercelJson) {
      putFile(repo, "vercel.json", snapshot.vercelJson, branchName, "chore: restore pre-migration vercel.json", current?.sha);
      actions.push("restored vercel.json from snapshot");
    }
  }

  try {
    gh(["api", "--method", "DELETE", `repos/${repo}/actions/variables/VERCEL_DEPLOY_TARGETS`]);
    actions.push("deleted VERCEL_DEPLOY_TARGETS");
  } catch (e) {
    actions.push(`VERCEL_DEPLOY_TARGETS delete: ${e.message}`);
  }

  actions.push(`manual: remove ${repo} from org secret VERCEL_TOKEN selected repositories if needed`);

  if (viaPr) {
    const url = gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      branch,
      "--head",
      branchName,
      "--title",
      "chore: rollback Vercel Actions production deployment",
      "--body",
      "Rolls back the GitHub Actions Vercel production deployment caller workflow.\n\nDoes not delete production deployments or rewrite history.",
    ]);
    actions.push(`pr: ${url}`);
  }

  const log = readJson("rollback-log.json") || [];
  log.push({ repository: repo, at: new Date().toISOString(), actions });
  writeJson("rollback-log.json", log);
  console.log(JSON.stringify({ repository: repo, actions }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});