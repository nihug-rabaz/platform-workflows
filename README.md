# platform-workflows

Centralized reusable GitHub Actions workflows for Vercel production deployments across the `nihug-rabaz` organization.

## Why

Vercel Git integration can block production deploys when the commit author is not linked to a Vercel account.

This repository provides a reusable workflow that deploys with a single account `VERCEL_TOKEN`.

## Reusable workflow

`.github/workflows/vercel-production.yml` — `workflow_call`, stable tag **v1**.

Caller workflows must pass `VERCEL_TOKEN` explicitly. Do not use `secrets: inherit`.

## Scripts

```bash
npm run discover
npm run configure-github -- --pilot
npm run distribute -- --pilot --merge
npm run trigger -- --pilot --wait
npm run verify -- --pilot
npm run disable-git-deploy -- --pilot
npm run report
```

## Rollback

```bash
node scripts/rollback-migration.mjs --repo nihug-rabaz/REPOSITORY --via-pr
```

## Safety

- No fictitious commits to force deploys
- No history rewrite
- No secrets in git, logs, or reports
- Idempotent scripts
- Staged rollouts (pilot then batches)