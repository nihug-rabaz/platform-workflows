/**
 * Ensure a valid long-lived VERCEL_TOKEN is stored for a repo (and optionally org).
 *
 * - Validates token against Vercel API before writing.
 * - Default: write only if secret is missing.
 * - --force: overwrite existing (rotation).
 *
 * Usage:
 *   # Uses VERCEL_TOKEN env or local `vercel login` auth.json
 *   node scripts/ensure-deploy-token.mjs --repo nihug-rabaz/myidf
 *   node scripts/ensure-deploy-token.mjs --repo nihug-rabaz/myidf --also-org
 *   node scripts/ensure-deploy-token.mjs --repo nihug-rabaz/myidf --force
 */
import {
  ORG,
  argValue,
  assertVercelTokenValid,
  gh,
  hasFlag,
  loadVercelAuthFromCli,
  orgSecretExists,
  repoSecretExists,
} from "./lib.mjs";

async function main() {
  loadVercelAuthFromCli();
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error(
      "VERCEL_TOKEN required. Create a no-expiry token at https://vercel.com/account/tokens then export VERCEL_TOKEN=…"
    );
  }

  const repo = argValue("--repo");
  if (!repo) throw new Error("Required: --repo ORG/NAME");
  const force = hasFlag("--force");
  const alsoOrg = hasFlag("--also-org");

  const id = await assertVercelTokenValid(token);
  console.log(`Token valid (vercel user=${id.username})`);

  if (alsoOrg) {
    if (orgSecretExists("VERCEL_TOKEN") && !force) {
      console.log("Org VERCEL_TOKEN already set (skip; --force to rotate)");
    } else {
      // visibility all so new private/public repos inherit when plan allows
      try {
        gh(["secret", "set", "VERCEL_TOKEN", "--org", ORG, "--visibility", "all"], { input: token });
      } catch {
        gh(
          ["secret", "set", "VERCEL_TOKEN", "--org", ORG, "--visibility", "selected", "--repos", repo.split("/")[1]],
          { input: token }
        );
      }
      console.log("Org VERCEL_TOKEN written");
    }
  }

  if (repoSecretExists(repo, "VERCEL_TOKEN") && !force) {
    console.log(`Repo ${repo} VERCEL_TOKEN already set (skip; --force to rotate)`);
    console.log(
      "Note: a repo secret always overrides a working org secret. Keep one good permanent value."
    );
    return;
  }

  gh(["secret", "set", "VERCEL_TOKEN", "--repo", repo], { input: token });
  console.log(`${force ? "Rotated" : "Set"} repo secret VERCEL_TOKEN for ${repo}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
