---
name: deploy-and-env-vars
description: Use when configuring deployment targets, domains, or environment variables for this monorepo.
---

# Deploy and manage environment variables

## Scope

Use only on explicit user request because deployment and remote env changes mutate external state. Do not deploy, link projects, add domains, or write remote secrets during ordinary implementation or verification.

## Procedure

1. Confirm the SaaS deployment target, Vercel project, environment (`development`, `preview`, or
   `production`), branch, and requested mutation before running a write command.
2. Inventory required variables from `.env.local.example` and actual `process.env` usage. Server secrets stay unprefixed; only browser-readable values use `NEXT_PUBLIC_`.
3. Configure `NEXT_PUBLIC_SAAS_URL` as the single canonical public origin. Auth callbacks, CORS,
   payment redirect validation, public content, Docs, and notification links all depend on it.
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
   Root build targets the SaaS workspace and its dependencies. There is no tracked `vercel.json`;
   verify the SaaS project root/build settings.
7. Check `/api/health` (it returns `OK`), `/`, `/docs`, auth origin/callback behavior, CORS, and the
   enabled webhook endpoint `POST /api/webhooks/payments`. Record deployment URLs without exposing
   secrets.

## Canonical reference

`.env.local.example` is the tracked env inventory. `packages/api/index.ts` derives CORS and webhook paths, while `packages/utils/lib/base-url.ts` handles explicit URLs and `NEXT_PUBLIC_VERCEL_URL`.

## Done

The intended SaaS environment/root directory is linked, its required env names and canonical origin
are correct, `pnpm build` succeeds, smoke checks and enabled integrations pass, and no secret value
appears in source or logs.

## Common mistakes

- Linking the Vercel project to the wrong monorepo root.
- Marking provider secrets `NEXT_PUBLIC_`.
- Reintroducing separate public-content or Docs origins.
- Assuming `.env.local` is uploaded automatically.
