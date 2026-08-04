import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const OUT = join(ROOT, "migration-output");

export function ensureOut() {
  mkdirSync(OUT, { recursive: true });
}

export function writeJson(name, data) {
  ensureOut();
  const path = join(OUT, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  return path;
}

export function readJson(name, fallback = null) {
  const path = join(OUT, name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function gh(args, { input, json = false, repo } = {}) {
  const full = [...args];
  if (repo) full.push("--repo", repo);
  const r = spawnSync("gh", full, {
    encoding: "utf8",
    input,
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  if (r.status !== 0) {
    const err = new Error(
      `gh ${full.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`
    );
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    err.status = r.status;
    throw err;
  }
  const out = (r.stdout || "").trim();
  if (json) {
    if (!out) return null;
    return JSON.parse(out);
  }
  return out;
}

export async function vercelApi(path, { method = "GET", body, teamId } = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set");
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId || process.env.VERCEL_ORG_ID) {
    url.searchParams.set("teamId", teamId || process.env.VERCEL_ORG_ID);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text || res.statusText;
    const err = new Error(`Vercel API ${method} ${path} → ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function loadVercelAuthFromCli() {
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_ORG_ID) return;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    join(home, "AppData/Roaming/xdg.data/com.vercel.cli/auth.json"),
    join(home, "AppData/Roaming/com.vercel.cli/auth.json"),
    join(home, ".local/share/com.vercel.cli/auth.json"),
    join(home, ".config/com.vercel.cli/auth.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const auth = JSON.parse(readFileSync(p, "utf8"));
    if (auth.token && !process.env.VERCEL_TOKEN) process.env.VERCEL_TOKEN = auth.token;
    break;
  }
  const cfgCandidates = [
    join(home, "AppData/Roaming/xdg.data/com.vercel.cli/config.json"),
    join(home, "AppData/Roaming/com.vercel.cli/config.json"),
    join(home, ".local/share/com.vercel.cli/config.json"),
    join(home, ".config/com.vercel.cli/config.json"),
  ];
  for (const p of cfgCandidates) {
    if (!existsSync(p)) continue;
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    if (cfg.currentTeam && !process.env.VERCEL_ORG_ID) process.env.VERCEL_ORG_ID = cfg.currentTeam;
    break;
  }
}

export function normalizeNodeVersion(v) {
  if (!v) return "22";
  const m = String(v).match(/(\d+)/);
  return m ? m[1] : "22";
}

export function normalizeRootDirectory(root) {
  if (!root || root === "" || root === null) return ".";
  return String(root).replace(/^\/+|\/+$/g, "") || ".";
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function argValue(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

export function hasFlag(flag) {
  return process.argv.includes(flag);
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.silent ? "pipe" : "inherit",
    env: process.env,
    ...opts,
  });
}

export const ORG = process.env.GITHUB_ORG || "nihug-rabaz";
export const PLATFORM_REPO = `${ORG}/platform-workflows`;
export const REUSABLE_WORKFLOW = `${PLATFORM_REPO}/.github/workflows/vercel-production.yml@v1`;
export const CALLER_WORKFLOW_PATH = ".github/workflows/deploy-production.yml";
export const VERCEL_CLI_VERSION = "48.1.6";