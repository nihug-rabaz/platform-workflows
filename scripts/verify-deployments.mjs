import { argValue, gh, hasFlag, loadVercelAuthFromCli, readJson, vercelApi, writeJson } from "./lib.mjs";

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

async function latestProductionDeployment(projectId) {
  const data = await vercelApi(`/v6/deployments?projectId=${projectId}&target=production&limit=5`);
  return (data.deployments || [])[0] || null;
}

async function verifyRepo(entry) {
  const repo = entry.repository;
  const row = { repository: repo, workflow: null, targets: [], status: "unknown", notes: [] };
  try {
    const runs = gh(
      ["api", `repos/${repo}/actions/workflows/deploy-production.yml/runs?per_page=3`],
      { json: true }
    );
    const latest = runs?.workflow_runs?.[0];
    if (!latest) {
      row.notes.push("no workflow runs found");
      row.status = "no-runs";
    } else {
      row.workflow = {
        id: latest.id,
        status: latest.status,
        conclusion: latest.conclusion,
        headSha: latest.head_sha,
        url: latest.html_url,
        event: latest.event,
      };
    }
  } catch (e) {
    row.notes.push(`workflow check failed: ${e.message}`);
  }

  for (const t of entry.targets) {
    const targetRow = { name: t.name, projectId: t.projectId, deployment: null, error: "" };
    try {
      const dep = await latestProductionDeployment(t.projectId);
      if (dep) {
        targetRow.deployment = {
          uid: dep.uid,
          url: dep.url ? `https://${dep.url}` : null,
          state: dep.state || dep.readyState,
          createdAt: dep.createdAt,
          meta: {
            githubCommitSha: dep.meta?.githubCommitSha || null,
            githubCommitAuthorName: dep.meta?.githubCommitAuthorName || null,
          },
          creator: dep.creator?.username || null,
        };
      } else {
        targetRow.error = "no production deployments found";
      }
    } catch (e) {
      targetRow.error = e.message;
    }
    row.targets.push(targetRow);
  }

  const wfOk = row.workflow?.conclusion === "success";
  const depOk = row.targets.every(
    (t) => t.deployment && ["READY", "ready", "COMPLETE"].includes(String(t.deployment.state).toUpperCase())
  );
  if (wfOk && depOk) row.status = "success";
  else if (row.workflow?.conclusion === "failure") row.status = "failed";
  else if (row.workflow?.status === "in_progress" || row.workflow?.status === "queued") row.status = "in_progress";
  else row.status = "needs_attention";
  return row;
}

async function main() {
  loadVercelAuthFromCli();
  const mappings = readJson("repository-project-mapping.json");
  const selected = selectRepos(mappings);
  console.log(`Verifying ${selected.length} repositories...`);
  const results = [];
  for (const entry of selected) {
    const r = await verifyRepo(entry);
    results.push(r);
    console.log(`${r.status.padEnd(16)} ${r.repository} wf=${r.workflow?.conclusion || r.workflow?.status || "-"}`);
  }
  writeJson("verify-result.json", { at: new Date().toISOString(), results });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});