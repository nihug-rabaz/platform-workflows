import { argValue, gh, hasFlag, readJson, sleep, writeJson } from "./lib.mjs";

function selectRepos(mappings) {
  const only = argValue("--repos");
  if (only) {
    const set = new Set(only.split(",").map((s) => s.trim()).filter(Boolean));
    return mappings.filter((m) => set.has(m.repository) || set.has(m.repository.split("/")[1]));
  }
  if (hasFlag("--pilot")) {
    const pilot = readJson("pilot-selection.json");
    const set = new Set(pilot.repositories);
    return mappings.filter((m) => set.has(m.repository));
  }
  if (hasFlag("--all-mapped")) return mappings;
  throw new Error("Specify --repos, --pilot, or --all-mapped");
}

function headSha(repo, branch) {
  return gh(["api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]);
}

function findWorkflowId(repo) {
  try {
    return gh(["api", `repos/${repo}/actions/workflows/deploy-production.yml`, "--jq", ".id"]);
  } catch {
    return null;
  }
}

function dispatch(repo, branch, deployRef) {
  const args = ["workflow", "run", "deploy-production.yml", "--repo", repo, "--ref", branch];
  if (deployRef) args.push("-f", `deploy_ref=${deployRef}`);
  gh(args);
}

function latestRun(repo, workflowId) {
  const runs = gh(["api", `repos/${repo}/actions/workflows/${workflowId}/runs?per_page=1`], { json: true });
  return runs?.workflow_runs?.[0] || null;
}

async function waitForRun(repo, runId, timeoutMs = 45 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = gh(["api", `repos/${repo}/actions/runs/${runId}`], { json: true });
    if (run.status === "completed") return run;
    await sleep(15000);
  }
  throw new Error(`timeout waiting for run ${runId} on ${repo}`);
}

async function main() {
  const mappings = readJson("repository-project-mapping.json");
  const selected = selectRepos(mappings);
  const maxParallel = Number(argValue("--max-parallel", "3"));
  const wait = hasFlag("--wait");
  const results = [];
  console.log(`Triggering ${selected.length} retroactive deployments (parallel=${maxParallel}, wait=${wait})`);

  let i = 0;
  const queue = [...selected];
  const workers = Array.from({ length: maxParallel }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      const repo = entry.repository;
      const branch = entry.defaultBranch;
      const row = {
        repository: repo,
        workflowRunId: 0,
        commitSha: "",
        vercelProject: entry.targets.map((t) => t.name).join(","),
        deploymentUrl: "",
        productionDomains: entry.targets.flatMap((t) => t.domains || []),
        status: "pending",
        error: "",
      };
      try {
        const wf = findWorkflowId(repo);
        if (!wf) {
          row.status = "skipped";
          row.error = "deploy-production.yml workflow not found on default branch";
        } else {
          const sha = headSha(repo, branch);
          row.commitSha = sha;
          dispatch(repo, branch, sha);
          await sleep(4000);
          const run = latestRun(repo, wf);
          if (run) {
            row.workflowRunId = run.id;
            row.workflowUrl = run.html_url;
            if (wait) {
              const done = await waitForRun(repo, run.id);
              row.status = done.conclusion === "success" ? "success" : done.conclusion || "failed";
              if (row.status !== "success") row.error = `workflow conclusion: ${done.conclusion}`;
            } else {
              row.status = "triggered";
            }
          } else {
            row.status = "triggered";
            row.error = "run not yet visible";
          }
        }
      } catch (e) {
        row.status = "failed";
        row.error = e.message;
      }
      results.push(row);
      console.log(`${String(++i).padStart(3)} ${row.status.padEnd(12)} ${row.repository} run=${row.workflowRunId || "-"}`);
    }
  });
  await Promise.all(workers);

  writeJson("retroactive-deployments.json", { at: new Date().toISOString(), results });
  writeJson("failed-deployments.json", results.filter((r) => r.status === "failed"));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});