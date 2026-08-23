---
name: deploy-and-env-vars
description: Use when configuring deployment targets, domains, or environment variables for this monorepo.
triggers: ["user"]
---

# Deploy and manage environment variables

## Scope

Use only on explicit user request because deployment and remote env changes mutate external state. Do not deploy, link projects, add domains, or write remote secrets during ordinary implementation or verification.

## Procedure

1. Confirm the target app (`saas`, `marketing`, or `docs`), Vercel project, environment (`development`, `preview`, or `production`), branch, and requested mutation before running a write command.
2. Inventory required variables from `.env.local.example` and actual `process.env` usage. Server secrets stay unprefixed; only browser-readable values use `NEXT_PUBLIC_`.
3. At minimum, configure app URLs consistently:
   - `NEXT_PUBLIC_SAAS_URL`
   - `NEXT_PUBLIC_MARKETING_URL`
   - `NEXT_PUBLIC_DOCS_URL`
     Auth callbacks, CORS, payment redirect validation, and notification links depend on the SaaS URL.
     Local app ports are SaaS `3000`, marketing `3001`, and docs `3002`. `.env.local.example` currently lists the docs URL on `3001`; do not propagate that stale local value into a deployment.
4. Configure only enabled integrations: `DATABASE_URL`, `BETTER_AUTH_SECRET`, mail provider values, active payment provider values and price IDs, storage values, and AI keys. `DIRECT_URL` appears in `.env.local.example` but current runtime/Prisma config does not read it; do not treat it as required without adding a real consumer.
5. Use authenticated Vercel CLI commands only after confirming scope:
   ```bash
   vercel link
   vercel env add <NAME> <environment>
   vercel deploy
   vercel deploy --prod
   ```
   Never place secret values in command history, logs, source, or the final report; prefer interactive/stdin secret entry.
6. Build before deployment:
   ```bash
   pnpm build
   ```
   This is a multi-app Turborepo with no tracked `vercel.json`; verify project root/build settings rather than assuming one deployment serves every app.
7. For the SaaS deployment, check `/api/health` (it returns `OK`), auth origin/callback behavior, CORS, and the enabled webhook endpoint `POST /api/webhooks/payments`. Marketing/docs have no equivalent health route; smoke-test their real pages instead. Record deployment URLs without exposing secrets.

## Canonical reference

`.env.local.example` is the tracked env inventory. `packages/api/index.ts` derives CORS and webhook paths, while `packages/utils/lib/base-url.ts` handles explicit URLs and `NEXT_PUBLIC_VERCEL_URL`.

## Done

The intended app/environment/root directory is linked, its required env names and cross-app URLs are correct, `pnpm build` succeeds, app-appropriate smoke checks and enabled integrations pass, and no secret value appears in source or logs.

## Common mistakes

- Deploying all apps as one project without checking monorepo roots.
- Marking provider secrets `NEXT_PUBLIC_`.
- Setting only one app URL and breaking auth/CORS/redirects.
- Copying the stale local docs port from `.env.local.example` instead of using port `3002`.
- Assuming `.env.local` is uploaded automatically.
