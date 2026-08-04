import {
  ORG,
  ensureOut,
  gh,
  loadVercelAuthFromCli,
  normalizeNodeVersion,
  normalizeRootDirectory,
  vercelApi,
  writeJson,
} from "./lib.mjs";

async function fetchAllVercelProjects() {
  const projects = [];
  let until;
  for (;;) {
    const data = await vercelApi(
      `/v9/projects?limit=100${until ? `&until=${until}` : ""}`
    );
    const batch = data.projects || [];
    projects.push(...batch);
    if (!data.pagination?.next || batch.length === 0) break;
    until = data.pagination.next;
  }
  return projects;
}

async function fetchGitHubRepos() {
  const raw = gh(
    [
      "repo",
      "list",
      ORG,
      "--limit",
      "200",
      "--json",
      "name,nameWithOwner,id,isArchived,isFork,defaultBranchRef,visibility,url,diskUsage,primaryLanguage,isEmpty",
    ],
    { json: true }
  );

  const detailed = [];
  for (const repo of raw) {
    const fullName = repo.nameWithOwner;
    let hasExistingWorkflows = false;
    let hasVercelConfig = false;
    let hasPackageJson = false;
    let actionsEnabled = true;
    const branch = repo.defaultBranchRef?.name || "main";

    try {
      const tree = gh(
        ["api", `repos/${fullName}/git/trees/${branch}?recursive=1`],
        { json: true }
      );
      const paths = (tree.tree || []).map((t) => t.path);
      hasExistingWorkflows = paths.some((p) => p.startsWith(".github/workflows/"));
      hasVercelConfig =
        paths.includes("vercel.json") ||
        paths.includes("vercel.ts") ||
        paths.some((p) => p.endsWith("/vercel.json") || p.endsWith("/vercel.ts"));
      hasPackageJson =
        paths.includes("package.json") ||
        paths.includes("next.config.js") ||
        paths.includes("next.config.mjs") ||
        paths.includes("next.config.ts") ||
        paths.includes("nuxt.config.ts") ||
        paths.includes("astro.config.mjs") ||
        paths.some((p) => /^(apps|packages)\//.test(p) && p.endsWith("package.json"));
    } catch {
      // empty or tree missing
    }

    try {
      const actions = gh(["api", `repos/${fullName}/actions/permissions`], { json: true });
      if (actions && actions.enabled === false) actionsEnabled = false;
    } catch {
      // assume enabled
    }

    detailed.push({
      name: repo.name,
      fullName,
      id: repo.id,
      defaultBranch: branch,
      visibility: repo.visibility,
      archived: !!repo.isArchived,
      fork: !!repo.isFork,
      empty: !!repo.isEmpty,
      actionsEnabled,
      hasExistingWorkflows,
      hasVercelConfig,
      hasPackageJson,
      url: repo.url,
      primaryLanguage: repo.primaryLanguage?.name || null,
    });
    process.stdout.write(`  scanned ${fullName}\n`);
  }
  return detailed;
}

function projectRecord(p) {
  const link = p.link || {};
  const gitRepository =
    link.org && link.repo
      ? `${link.org}/${link.repo}`
      : link.repo
        ? String(link.repo)
        : "";
  const prod = p.targets?.production;
  const domains = [];
  if (Array.isArray(p.alias)) {
    for (const a of p.alias) {
      if (typeof a === "string") domains.push(a);
      else if (a?.domain) domains.push(a.domain);
    }
  }
  return {
    projectId: p.id,
    projectName: p.name,
    ownerId: p.accountId,
    gitRepository,
    gitType: link.type || null,
    gitRepoRaw: link.repo || null,
    gitOrg: link.org || null,
    rootDirectory: normalizeRootDirectory(p.rootDirectory),
    framework: p.framework || null,
    productionBranch: link.productionBranch || "main",
    nodeVersion: normalizeNodeVersion(p.nodeVersion),
    domains,
    productionUrl: prod?.url || null,
  };
}

function matchProjectsToRepos(repos, projects) {
  const byFull = new Map();
  const byName = new Map();
  for (const r of repos) {
    byFull.set(r.fullName.toLowerCase(), r);
    byName.set(r.name.toLowerCase(), (byName.get(r.name.toLowerCase()) || []).concat(r));
  }

  const mapping = new Map();
  const ambiguous = [];
  const usedProjectIds = new Set();

  for (const p of projects) {
    let repo = null;
    if (p.gitOrg && p.gitRepoRaw) {
      repo = byFull.get(`${p.gitOrg}/${p.gitRepoRaw}`.toLowerCase());
    }
    if (!repo && p.gitRepository && p.gitRepository.includes("/")) {
      repo = byFull.get(p.gitRepository.toLowerCase());
    }
    if (!repo && p.gitRepoRaw) {
      const candidates = byName.get(String(p.gitRepoRaw).toLowerCase()) || [];
      if (candidates.length === 1) repo = candidates[0];
      else if (candidates.length > 1) {
        ambiguous.push({
          project: p.projectName,
          projectId: p.projectId,
          reason: "multiple repos match git repo name",
          candidates: candidates.map((c) => c.fullName),
        });
        continue;
      }
    }
    if (!repo) continue;
    usedProjectIds.add(p.projectId);
    if (!mapping.has(repo.fullName)) {
      mapping.set(repo.fullName, {
        repository: repo.fullName,
        defaultBranch: repo.defaultBranch,
        targets: [],
      });
    }
    mapping.get(repo.fullName).targets.push({
      name: p.projectName,
      projectId: p.projectId,
      orgId: p.ownerId,
      rootDirectory: p.rootDirectory,
      nodeVersion: p.nodeVersion,
      framework: p.framework,
      productionBranch: p.productionBranch,
      domains: p.domains,
      matchMethod: "git-metadata",
    });
  }

  for (const p of projects) {
    if (usedProjectIds.has(p.projectId)) continue;
    const candidates = byName.get(p.projectName.toLowerCase()) || [];
    if (candidates.length === 1) {
      const repo = candidates[0];
      usedProjectIds.add(p.projectId);
      if (!mapping.has(repo.fullName)) {
        mapping.set(repo.fullName, {
          repository: repo.fullName,
          defaultBranch: repo.defaultBranch,
          targets: [],
        });
      }
      mapping.get(repo.fullName).targets.push({
        name: p.projectName,
        projectId: p.projectId,
        orgId: p.ownerId,
        rootDirectory: p.rootDirectory,
        nodeVersion: p.nodeVersion,
        framework: p.framework,
        productionBranch: p.productionBranch,
        domains: p.domains,
        matchMethod: "exact-name",
      });
    } else if (candidates.length > 1) {
      ambiguous.push({
        project: p.projectName,
        projectId: p.projectId,
        reason: "exact name matches multiple repos",
        candidates: candidates.map((c) => c.fullName),
      });
    }
  }

  return { mapping, ambiguous, usedProjectIds };
}

async function main() {
  loadVercelAuthFromCli();
  ensureOut();
  if (!process.env.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN missing");
  if (!process.env.VERCEL_ORG_ID) throw new Error("VERCEL_ORG_ID missing");

  console.log(`Discovering GitHub repos in org ${ORG}...`);
  const repos = await fetchGitHubRepos();
  writeJson("github-repositories.json", repos);
  console.log(`  found ${repos.length} repositories`);

  console.log("Discovering Vercel projects...");
  const rawProjects = await fetchAllVercelProjects();
  const projects = rawProjects.map(projectRecord);
  writeJson("vercel-projects.json", projects);
  console.log(`  found ${projects.length} projects (org ${process.env.VERCEL_ORG_ID})`);

  const eligible = repos.filter((r) => !r.archived && !r.fork && !r.empty);
  const filtered = repos.filter((r) => r.archived || r.fork || r.empty);

  const { mapping, ambiguous, usedProjectIds } = matchProjectsToRepos(eligible, projects);

  const matchedRepos = new Set(mapping.keys());
  const unmatchedRepos = eligible
    .filter((r) => !matchedRepos.has(r.fullName))
    .map((r) => ({
      repository: r.fullName,
      reason: "no confident Vercel project match",
      hasPackageJson: r.hasPackageJson,
      hasVercelConfig: r.hasVercelConfig,
    }));

  const unmatchedProjects = projects
    .filter((p) => !usedProjectIds.has(p.projectId))
    .map((p) => ({
      projectName: p.projectName,
      projectId: p.projectId,
      gitRepository: p.gitRepository,
      reason: "no confident GitHub repository match",
    }));

  const mappings = [...mapping.values()].sort((a, b) =>
    a.repository.localeCompare(b.repository)
  );

  writeJson("repository-project-mapping.json", mappings);
  writeJson("unmatched-repositories.json", {
    repositories: unmatchedRepos,
    projects: unmatchedProjects,
  });
  writeJson("ambiguous-matches.json", ambiguous);
  writeJson("discovery-summary.json", {
    org: ORG,
    vercelOrgId: process.env.VERCEL_ORG_ID,
    totalRepos: repos.length,
    filteredOut: filtered.length,
    eligible: eligible.length,
    confidentMatches: mappings.length,
    ambiguous: ambiguous.length,
    unmatchedRepos: unmatchedRepos.length,
    unmatchedProjects: unmatchedProjects.length,
    multiTargetRepos: mappings.filter((m) => m.targets.length > 1).length,
    generatedAt: new Date().toISOString(),
  });

  console.log("\nDiscovery summary:");
  console.log(`  eligible repos: ${eligible.length}`);
  console.log(`  confident mappings: ${mappings.length}`);
  console.log(`  multi-target: ${mappings.filter((m) => m.targets.length > 1).length}`);
  console.log(`  ambiguous: ${ambiguous.length}`);
  console.log(`  unmatched repos: ${unmatchedRepos.length}`);
  console.log(`  unmatched projects: ${unmatchedProjects.length}`);

  const pilotCandidates = mappings
    .filter((m) => m.targets.length === 1)
    .map((m) => {
      const repo = repos.find((r) => r.fullName === m.repository);
      return {
        ...m,
        hasPackageJson: repo?.hasPackageJson,
        hasVercelConfig: repo?.hasVercelConfig,
      };
    })
    .filter((m) => m.hasPackageJson)
    .slice(0, 15);
  writeJson("pilot-candidates.json", pilotCandidates);
  console.log(`  pilot candidates: ${pilotCandidates.length}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});