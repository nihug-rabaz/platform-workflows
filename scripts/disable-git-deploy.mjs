/**
 * Disable Vercel Git auto-deployments for mapped projects after Actions pilot success.
 * Preference order:
 * 1) API: set commandForIgnoringBuildStep to exit 0 (safe, reversible, no file change)
 * 2) Optional vercel.json merge only with --via-repo-files
 *
 * Usage: node scripts/disable-git-deploy.mjs --pilot | --repos a,b | --all-mapped
 */
import { argValue, hasFlag, loadVercelAuthFromCli, readJson, vercelApi, writeJson } from "./lib.mjs";

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

async function disableProject(projectId, name) {
  // Capture previous ignore command
  const before = await vercelApi(`/v9/projects/${projectId}`);
  const previous = before.commandForIgnoringBuildStep ?? null;
  // exit 0 => always ignore git-triggered builds
  await vercelApi(`/v9/projects/${projectId}`, {
    method: "PATCH",
    body: { commandForIgnoringBuildStep: "exit 0" },
  });
  return { previous, setTo: "exit 0", projectId, name };
}

async function main() {
  loadVercelAuthFromCli();
  const mappings = readJson("repository-project-mapping.json");
  const selected = selectRepos(mappings);
  const results = [];
  const snap = readJson("git-deploy-snapshots.json") || {};

  for (const entry of selected) {
    for (const t of entry.targets) {
      try {
        const r = await disableProject(t.projectId, t.name);
        snap[t.projectId] = {
          repository: entry.repository,
          projectName: t.name,
          previousIgnoreCommand: r.previous,
          at: new Date().toISOString(),
        };
        results.push({
          repository: entry.repository,
          project: t.name,
          projectId: t.projectId,
          status: "disabled",
          previous: r.previous,
        });
        console.log(`disabled git builds: ${entry.repository} / ${t.name}`);
      } catch (e) {
        results.push({
          repository: entry.repository,
          project: t.name,
          projectId: t.projectId,
          status: "error",
          error: e.message,
        });
        console.error(`FAIL ${t.name}: ${e.message}`);
      }
    }
  }

  writeJson("git-deploy-snapshots.json", snap);
  writeJson("git-deploy-disable-result.json", { at: new Date().toISOString(), results });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});