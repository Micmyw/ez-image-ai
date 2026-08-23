---
name: writing-e2e-tests
description: Use when adding Playwright coverage for a user-visible SaaS or marketing workflow.
---

# Write E2E tests

## Scope

Use for behavior that must cross routing, rendering, or browser interaction boundaries. Do not use Playwright for pure functions or isolated oRPC handlers; add Vitest coverage instead.

## Procedure

1. Choose the owning app and place `*.spec.ts` in `apps/saas/tests` or `apps/marketing/tests`.
2. Read `apps/<app>/playwright.config.ts`. Both configs use `testDir: "./tests"`, Chromium, one CI worker, one retry, HTML reports, first-retry traces, and failure-retained video. SaaS uses `http://localhost:3000`; marketing uses `http://localhost:3001`. Their `webServer` blocks build and start production mode, reusing an existing local server outside CI.
3. Write tests with `@playwright/test`, navigate with relative URLs, and prefer `getByRole`, `getByLabel`, and stable `data-test` selectors over CSS structure or implementation text.
4. Keep each test independent. Create only the data it needs and avoid depending on test order. For database-backed flows, prepare root `.env.local`, start PostgreSQL, generate the ignored Prisma client, and apply the schema:
   ```bash
   docker compose up -d postgres
   pnpm --filter @repo/database generate
   pnpm --filter @repo/database push
   ```
5. For authenticated SaaS tests, seed a deterministic verified user (the interactive repository helper is `pnpm --filter @repo/scripts create:user`) and authenticate through user-visible UI. The SaaS config declares a `setup` project matching `*.setup.ts`, but currently has no setup file, `storageState`, or project dependency. If shared auth state is needed, add all three deliberately, keep the state file out of Git, and do not claim the existing config already authenticates tests.
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
7. `.github/workflows/validate-prs.yml` generates Prisma, runs SaaS then marketing headlessly, and uploads only `apps/saas/playwright-report/` as artifact `playwright-report` for 30 days. A marketing HTML report is produced locally but is not uploaded by the current workflow.
8. Run `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`apps/saas/tests/login.spec.ts` uses accessible roles to test auth-mode switching without a session. `apps/marketing/tests/home.spec.ts` uses the stable `data-test="color-mode-toggle"` hook. The two app-local `playwright.config.ts` files are authoritative for server and artifact behavior.

## Done

The test fails without the behavior, passes headlessly through the owning app's `e2e:ci`, is isolated from test order, uses explicit auth/data setup when required, and produces actionable report/trace/video output on failure.

## Common mistakes

- Putting tests in an `e2e/` directory; this repository configures `tests/`.
- Starting `pnpm dev` inside a test; Playwright owns the production server lifecycle.
- Assuming the declared `setup` project already creates an authenticated session.
- Running database-backed E2E without generating the clean-checkout Prisma client.
- Using `networkidle` or arbitrary sleeps instead of asserting the user-visible state.
- Running a nonexistent root `pnpm e2e`.
