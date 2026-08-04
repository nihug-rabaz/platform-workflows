import { ORG, argValue, hasFlag, gh, loadVercelAuthFromCli, readJson, writeJson } from "./lib.mjs";

function targetsJson(entry) {
  return JSON.stringify({
    include: entry.targets.map((t) => ({
      name: t.name,
      project_id: t.projectId,
      org_id: t.orgId,
      root_directory: t.rootDirectory || ".",
      node_version: String(t.nodeVersion || "22"),
    })),
  });
}

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
  throw new Error("Specify --repos A,B or --pilot or --all-mapped");
}

async function main() {
  loadVercelAuthFromCli();
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN not available");

  const mappings = readJson("repository-project-mapping.json");
  if (!mappings?.length) throw new Error("Run discover first");
  const selected = selectRepos(mappings);
  if (!selected.length) throw new Error("No repositories selected");

  let useRepoSecrets = hasFlag("--use-repo-secrets");
  const result = { mode: useRepoSecrets ? "repository" : "organization", repos: [], errors: [] };

  if (!useRepoSecrets) {
    try {
      const withPlatform = [
        ...new Set([...selected.map((r) => r.repository.split("/")[1]), "platform-workflows"]),
      ].join(",");
      gh(
        ["secret", "set", "VERCEL_TOKEN", "--org", ORG, "--visibility", "selected", "--repos", withPlatform],
        { input: token }
      );
      result.orgSecret = true;
      result.selectedRepos = withPlatform.split(",");
      console.log(`Set org secret VERCEL_TOKEN for ${result.selectedRepos.length} repos`);
    } catch (e) {
      console.warn(`Org secret failed, falling back to repo secrets: ${e.message}`);
      result.orgSecretError = e.message;
      useRepoSecrets = true;
      result.mode = "repository";
    }
  }

  try {
    const orgId = process.env.VERCEL_ORG_ID;
    if (orgId) {
      try {
        gh(["variable", "set", "VERCEL_ORG_ID", "--org", ORG, "--body", orgId]);
      } catch {
        gh(["api", "--method", "PATCH", `orgs/${ORG}/actions/variables/VERCEL_ORG_ID`, "-f", `value=${orgId}`]);
      }
      result.orgVariable = true;
    }
  } catch (e) {
    result.orgVariableError = e.message;
    console.warn(`Org variable failed: ${e.message}`);
  }

  for (const entry of selected) {
    const row = { repository: entry.repository, secrets: [], variables: [] };
    try {
      if (useRepoSecrets || result.mode === "repository") {
        gh(["secret", "set", "VERCEL_TOKEN", "--repo", entry.repository], { input: token });
        row.secrets.push("VERCEL_TOKEN");
      }
      const body = targetsJson(entry);
      gh(["variable", "set", "VERCEL_DEPLOY_TARGETS", "--repo", entry.repository, "--body", body]);
      row.variables.push("VERCEL_DEPLOY_TARGETS");
      row.targetsCount = entry.targets.length;
      console.log(`Configured ${entry.repository} (${entry.targets.length} targets)`);
      result.repos.push(row);
    } catch (e) {
      row.error = e.message;
      result.errors.push(row);
      console.error(`FAIL ${entry.repository}: ${e.message}`);
    }
  }

  writeJson("configure-github-result.json", { ...result, at: new Date().toISOString() });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});