---
name: writing-e2e-tests
description: Use when adding Playwright coverage for a user-visible SaaS or marketing workflow.
---

# Write E2E tests

## Scope

Use for behavior that must cross routing, rendering, or browser interaction boundaries. Do not use Playwright for pure functions or isolated oRPC handlers; add Vitest coverage instead.

## Procedure

1. Choose the owning app and place `*.spec.ts` in `apps/saas/tests` or `apps/marketing/tests`.
2. Read `apps/<app>/playwright.config.ts`. Both configs use `testDir: "./tests"`, Chromium, one CI worker, one retry, HTML reports, first-retry traces, and failure-retained video. Base URLs come from `NEXT_PUBLIC_SAAS_URL` and `NEXT_PUBLIC_MARKETING_URL`, defaulting to `http://localhost:3000` and `http://localhost:3001`. Their `webServer` starts isolated webpack development servers by default, or builds and starts production servers when `E2E_USE_PRODUCTION_BUILD=true`; it never reuses an existing server.
3. Write tests with `@playwright/test`, navigate with relative URLs, and prefer `getByRole`, `getByLabel`, and stable `data-test` selectors over CSS structure or implementation text.
4. Keep each test independent. Create only the data it needs and avoid depending on test order. For database-backed flows, prepare root `.env.local`, start PostgreSQL, generate the ignored Prisma client, and apply committed migrations to an isolated test database:
   ```bash
   docker compose up -d postgres
   pnpm --filter @repo/database generate
   pnpm db:migrate:deploy
   ```
5. For ordinary authenticated SaaS tests, seed a deterministic verified user (the interactive repository helper is `pnpm --filter @repo/scripts create:user`) and authenticate through user-visible UI. The media E2E harness instead seeds funded and empty users, and `apps/saas/tests/auth.setup.ts` writes their storage states under the ignored `apps/saas/playwright/.auth/` directory for the dependent `funded` and `empty` projects.
6. Use the app scripts as intended:
   - Interactive Playwright UI:
     ```bash
     pnpm --filter saas e2e
     pnpm --filter marketing e2e
     ```
   - Headless CI path (also installs Playwright browsers):
   ```bash
   pnpm --filter saas e2e:ci
   pnpm --filter marketing e2e:ci
   ```
   - Full local media harness with isolated seed, Outbox pump, SaaS scenarios, and marketing handoff:
   ```bash
   pnpm e2e:media:ci
   ```
   Set `E2E_USE_PRODUCTION_BUILD=true` when the production bundle itself is part of the evidence. The harness requires an isolated `TEST_DATABASE_URL`, private MinIO/S3 bucket configuration, and explicit test-adapter opt-ins; it must never receive real Provider credentials.
7. `.github/workflows/validate-prs.yml` provisions PostgreSQL and pinned MinIO, runs the immutable-upload regression plus `pnpm e2e:media:ci`, and uploads both SaaS and marketing Playwright reports and test results as separate artifacts.
8. Run `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`apps/saas/tests/login.spec.ts` uses accessible roles to test auth-mode switching without a session. `apps/marketing/tests/home.spec.ts` uses the stable `data-test="color-mode-toggle"` hook. The two app-local `playwright.config.ts` files are authoritative for server and artifact behavior.

## Done

The test fails without the behavior, passes headlessly through the owning app's `e2e:ci`, is isolated from test order, uses explicit auth/data setup when required, and produces actionable report/trace/video output on failure.

## Common mistakes

- Putting tests in an `e2e/` directory; this repository configures `tests/`.
- Starting `pnpm dev` inside a test; Playwright owns the configured development or production server lifecycle.
- Committing generated storage-state files under `apps/saas/playwright/.auth/`.
- Running database-backed E2E without generating the clean-checkout Prisma client.
- Using `networkidle` or arbitrary sleeps instead of asserting the user-visible state.
- Running a nonexistent root `pnpm e2e`; the foundation harness is `pnpm e2e:media:ci`.
