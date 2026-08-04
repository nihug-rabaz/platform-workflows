/**
 * Configure GitHub Actions secrets/variables for Vercel production deploys.
 *
 * Token policy (hardened after accidental overwrites broke deploys):
 * - NEVER overwrite an existing VERCEL_TOKEN (org or repo) unless --force-token.
 * - Prefer org-level secret; only create repo secrets when org path fails AND
 *   the repo does not already have VERCEL_TOKEN.
 * - Always validate the token against the Vercel API before writing.
 *
 * Prefer a long-lived token from https://vercel.com/account/tokens
 * (no expiry). Avoid relying solely on `vercel login` session tokens.
 *
 * Usage:
 *   node scripts/configure-github.mjs --pilot
 *   node scripts/configure-github.mjs --all-mapped
 *   node scripts/configure-github.mjs --repos nihug-rabaz/myidf --force-token
 */
import {
  ORG,
  argValue,
  assertVercelTokenValid,
  gh,
  hasFlag,
  loadVercelAuthFromCli,
  orgSecretExists,
  readJson,
  repoSecretExists,
  writeJson,
} from "./lib.mjs";

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

function ensureOrgToken(token, { force, reposCsv, result }) {
  if (orgSecretExists("VERCEL_TOKEN") && !force) {
    console.log("Skip org VERCEL_TOKEN (already set; use --force-token to rotate)");
    result.orgSecret = "kept";
    return;
  }
  gh(
    ["secret", "set", "VERCEL_TOKEN", "--org", ORG, "--visibility", "selected", "--repos", reposCsv],
    { input: token }
  );
  result.orgSecret = force ? "rotated" : "created";
  result.selectedRepos = reposCsv.split(",");
  console.log(
    `${force ? "Rotated" : "Set"} org secret VERCEL_TOKEN for ${result.selectedRepos.length} repos`
  );
}

function ensureRepoToken(repo, token, { force, row }) {
  if (repoSecretExists(repo, "VERCEL_TOKEN") && !force) {
    console.log(`Skip repo VERCEL_TOKEN ${repo} (already set; use --force-token to rotate)`);
    row.secrets.push("VERCEL_TOKEN:kept");
    return;
  }
  gh(["secret", "set", "VERCEL_TOKEN", "--repo", repo], { input: token });
  row.secrets.push(force ? "VERCEL_TOKEN:rotated" : "VERCEL_TOKEN:created");
}

async function main() {
  loadVercelAuthFromCli();
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN not available");

  const forceToken = hasFlag("--force-token");
  const id = await assertVercelTokenValid(token);
  console.log(`VERCEL_TOKEN valid (user=${id.username}, force=${forceToken})`);

  const mappings = readJson("repository-project-mapping.json");
  if (!mappings?.length) throw new Error("Run discover first");
  const selected = selectRepos(mappings);
  if (!selected.length) throw new Error("No repositories selected");

  let useRepoSecrets = hasFlag("--use-repo-secrets");
  const result = {
    mode: useRepoSecrets ? "repository" : "organization",
    forceToken,
    repos: [],
    errors: [],
  };

  if (!useRepoSecrets) {
    try {
      const withPlatform = [
        ...new Set([...selected.map((r) => r.repository.split("/")[1]), "platform-workflows"]),
      ].join(",");
      ensureOrgToken(token, { force: forceToken, reposCsv: withPlatform, result });
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

  // Repo secrets only when forced to repo mode. Never blanket-overwrite.
  for (const entry of selected) {
    const row = { repository: entry.repository, secrets: [], variables: [] };
    try {
      if (useRepoSecrets || result.mode === "repository") {
        ensureRepoToken(entry.repository, token, { force: forceToken, row });
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
