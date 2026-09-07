---
name: local-environment-setup
description: Use when bootstrapping or repairing the local Next.js monorepo development environment.
---

# Set up the local environment

## Scope

Use for installation, local PostgreSQL, optional MinIO, generated Prisma artifacts, and app startup. Do not add real credentials to tracked files or provision remote infrastructure.

## Procedure

1. Verify Node.js 22 or newer and the repository-pinned pnpm:
   ```bash
   node --version
   pnpm --version
   ```
2. Create the untracked local environment from `.env.local.example`:
   ```bash
   cp .env.local.example .env.local
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/supastarter"
   ```
   Put the same `DATABASE_URL` in `.env.local`, along with a strong local `BETTER_AUTH_SECRET` and
   `NEXT_PUBLIC_SAAS_URL=http://localhost:3000`. Keep `DATABASE_URL` exported while running direct
   database package scripts: their explicit `.env` flag does not read `.env.local` by itself.
3. Start PostgreSQL 16 and verify its health:
   ```bash
   docker compose up -d postgres
   docker compose ps postgres
   ```
4. Install workspaces and generate the Prisma client/Zod output. The custom client directory is Git-ignored, so a clean checkout needs generation before direct database consumers:
   ```bash
   pnpm install
   pnpm --filter @repo/database generate
   pnpm --filter @repo/database push
   ```
5. Start development tasks:
   ```bash
   pnpm dev
   ```
   The root command starts only SaaS and its task dependencies. Public content and Docs are served
   by SaaS below the same origin. Start Mail Preview explicitly only when email-template work needs it.
6. If storage is needed, start `minio` and `minio-setup`, then use the MinIO values documented in `.env.local.example`:
   ```bash
   docker compose up -d minio minio-setup
   ```
7. Smoke-check `http://localhost:3000/api/health` and run `pnpm type-check`.

## Canonical reference

`docker-compose.yml` defines PostgreSQL `5432`, MinIO API `9000`, console `9001`, and the public `avatars` bucket. `packages/database/package.json` defines `generate`/`push` and explicitly points dotenv at root `.env`, so direct package commands need an inherited `DATABASE_URL` when local settings live only in `.env.local`.

## Done

From a clean checkout, dependencies install, Prisma generation/push succeeds, required containers
are healthy, and SaaS `/api/health`, `/`, and `/docs` resolve on the configured origin.

## Common mistakes

- Editing or committing `.env.local`.
- Expecting direct database scripts to discover `.env.local` without exporting `DATABASE_URL`.
- Starting MinIO for work that only needs PostgreSQL.
- Skipping Prisma generation after install or schema changes.
- Adding separate public-content or Docs origins instead of using `NEXT_PUBLIC_SAAS_URL`.
