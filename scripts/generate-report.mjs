import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, ORG, readJson, writeJson } from "./lib.mjs";

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const summary = readJson("discovery-summary.json") || {};
  const mappings = readJson("repository-project-mapping.json") || [];
  const ambiguous = readJson("ambiguous-matches.json") || [];
  const configure = readJson("configure-github-result.json") || {};
  const distribute = readJson("distribute-result.json") || {};
  const retro = readJson("retroactive-deployments.json") || {};
  const verify = readJson("verify-result.json") || {};
  const gitDisable = readJson("git-deploy-disable-result.json") || {};
  const blockers = readJson("blockers.json") || [];

  const distResults = distribute.results || [];
  const retroResults = retro.results || [];
  const verifyResults = verify.results || [];

  const rows = [];
  for (const m of mappings) {
    for (const t of m.targets) {
      const dist = distResults.find((r) => r.repository === m.repository);
      const ret = retroResults.find((r) => r.repository === m.repository);
      const ver = verifyResults.find((r) => r.repository === m.repository);
      const verT = ver?.targets?.find((x) => x.projectId === t.projectId);
      const conf = (configure.repos || []).find((r) => r.repository === m.repository);
      const gd = (gitDisable.results || []).find((r) => r.projectId === t.projectId);
      rows.push({
        repository: m.repository,
        defaultBranch: m.defaultBranch,
        vercelProject: t.name,
        projectId: t.projectId,
        rootDirectory: t.rootDirectory,
        callerWorkflow: dist?.status || "not-distributed",
        secretConfigured: conf ? "yes" : configure.mode || "unknown",
        gitAutoDeployDisabled: gd?.status || "unknown",
        retroactiveDeployment: ret?.status || "not-run",
        workflowRun: ret?.workflowRunId || ver?.workflow?.id || "",
        productionUrl: verT?.deployment?.url || t.domains?.[0] || "",
        status: ver?.status || ret?.status || dist?.status || "pending",
        notes: [...(dist?.notes || []), ret?.error, ...(ver?.notes || [])].filter(Boolean).join(" | "),
      });
    }
  }

  const report = {
    summary: {
      org: ORG,
      totalRepositoriesFound: summary.totalRepos ?? null,
      filteredOut: summary.filteredOut ?? null,
      confidentMatches: summary.confidentMatches ?? mappings.length,
      ambiguousMatches: Array.isArray(ambiguous) ? ambiguous.length : 0,
      repositoriesConfigured: (configure.repos || []).length,
      retroactiveSuccess: retroResults.filter((r) => r.status === "success").length,
      retroactiveFailed: retroResults.filter((r) => r.status === "failed").length,
      gitDeployDisabled: (gitDisable.results || []).filter((r) => r.status === "disabled").length,
      stillRequireAction: rows.filter((r) =>
        ["failed", "error", "needs_attention", "pr-opened-merge-failed", "skipped"].includes(r.status)
      ).length,
      generatedAt: new Date().toISOString(),
    },
    rows,
    blockers,
    secretMode: configure.mode,
  };
  writeJson("final-report.json", report);

  const headers = [
    "Repository","Default Branch","Vercel Project","Project ID","Root Directory","Caller Workflow",
    "Secret Configured","Git Auto Deploy Disabled","Retroactive Deployment","Workflow Run",
    "Production URL","Status","Notes",
  ];
  const csvLines = [headers.join(",")];
  for (const r of rows) {
    csvLines.push([
      r.repository, r.defaultBranch, r.vercelProject, r.projectId, r.rootDirectory, r.callerWorkflow,
      r.secretConfigured, r.gitAutoDeployDisabled, r.retroactiveDeployment, r.workflowRun,
      r.productionUrl, r.status, r.notes,
    ].map(csvEscape).join(","));
  }
  writeFileSync(join(OUT, "final-report.csv"), csvLines.join("\n") + "\n", "utf8");

  const md = [];
  md.push("# Vercel Production Deployment Migration — Final Report\n");
  md.push("## סיכום\n");
  md.push("| Metric | Value |");
  md.push("|--------|------:|");
  md.push(`| Repositories found | ${report.summary.totalRepositoriesFound} |`);
  md.push(`| Filtered out (archived/fork/empty) | ${report.summary.filteredOut} |`);
  md.push(`| Confident mappings | ${report.summary.confidentMatches} |`);
  md.push(`| Ambiguous matches | ${report.summary.ambiguousMatches} |`);
  md.push(`| Repositories configured | ${report.summary.repositoriesConfigured} |`);
  md.push(`| Retroactive successes | ${report.summary.retroactiveSuccess} |`);
  md.push(`| Failures | ${report.summary.retroactiveFailed} |`);
  md.push(`| Git auto-deploy disabled | ${report.summary.gitDeployDisabled} |`);
  md.push(`| Still require action | ${report.summary.stillRequireAction} |`);
  md.push(`| Secret mode | ${report.secretMode || "n/a"} |\n`);
  md.push("## טבלה מלאה\n");
  md.push("| Repository | Default Branch | Vercel Project | Project ID | Root Directory | Caller Workflow | Secret | Git Auto Deploy Disabled | Retroactive | Workflow Run | Production URL | Status | Notes |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(`| ${r.repository} | ${r.defaultBranch} | ${r.vercelProject} | ${r.projectId} | ${r.rootDirectory} | ${r.callerWorkflow} | ${r.secretConfigured} | ${r.gitAutoDeployDisabled} | ${r.retroactiveDeployment} | ${r.workflowRun} | ${r.productionUrl} | ${r.status} | ${(r.notes || "").replace(/\|/g, "/")} |`);
  }
  md.push("\n## חסמים\n");
  if (!blockers.length) md.push("_No explicit blockers recorded in blockers.json_");
  else {
    for (const b of blockers) {
      md.push(`### ${b.repository || "org"}`);
      md.push(`- Action: ${b.action}`);
      md.push(`- Command/API: \`${b.command || b.endpoint || ""}\``);
      md.push(`- Error: ${b.error}`);
      md.push(`- Required permission/data: ${b.required}`);
      md.push(`- Other steps completed: ${b.otherStepsCompleted ?? "yes"}\n`);
    }
  }
  md.push(`\nGenerated: ${report.summary.generatedAt}`);
  writeFileSync(join(OUT, "final-report.md"), md.join("\n") + "\n", "utf8");

  const manual = ["# Manual actions required\n"];
  for (const r of rows.filter((x) =>
    ["failed", "error", "needs_attention", "pr-opened-merge-failed", "not-distributed", "skipped"].includes(x.status)
  )) {
    manual.push(`- **${r.repository}** / ${r.vercelProject}: status=\`${r.status}\` notes=${r.notes || "n/a"}`);
  }
  for (const b of blockers) {
    manual.push(`- BLOCKER **${b.repository || "org"}**: ${b.action} — ${b.required}`);
  }
  if (manual.length === 1) manual.push("_None identified at report generation time._");
  writeFileSync(join(OUT, "manual-actions-required.md"), manual.join("\n") + "\n", "utf8");
  console.log(`Wrote final-report.md/json/csv (${rows.length} rows)`);
}

main();