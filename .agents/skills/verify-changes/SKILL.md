---
name: verify-changes
description: Use when validating a repository change before handoff, commit, or pull-request review.
---

# Verify changes

## Scope

Use for the final repository gates and for selecting focused tests. Do not use this as a substitute for testing the changed behavior while implementing it.

## Procedure

1. Inspect the change and map each touched area to its package:
   ```bash
   git status --short
   git diff --stat
   git diff --check
   ```
2. When proving clean-checkout behavior, use a fresh checkout/worktree and install exactly as CI does before relying on an existing `node_modules` or Turbo cache:
   ```bash
   pnpm install
   ```
   The ignored custom Prisma client under `packages/database/prisma/generated` is absent in a clean checkout. Run `pnpm --filter @repo/database generate` before direct package tests/scripts that load `@repo/database`, after schema changes, and before local E2E. Root `pnpm dev`, `pnpm build`, and `pnpm type-check` already reach the database `generate` task through `turbo.json`; do not add redundant generation to every command.
3. Run focused Vitest tests first. The exact CI unit command is:
   ```bash
   pnpm --filter @repo/api --filter saas --filter marketing test
   ```
   Narrow to one workspace when appropriate, for example `pnpm --filter @repo/api test`.
4. Run the matching Playwright suite when routes, rendering, auth, navigation, forms, or another browser-visible flow changed. Each config builds and starts its own app:
   ```bash
   pnpm --filter saas e2e:ci
   pnpm --filter marketing e2e:ci
   ```
   Tests are under `apps/saas/tests` and `apps/marketing/tests`.
   E2E may be skipped for docs-only, server-only, unit-only, or non-behavioral changes when no browser contract is affected; state that reason in the handoff. CI still runs both suites for every PR.
5. Run CI-parity read-only gates:
   ```bash
   pnpm lint
   pnpm format:check
   pnpm type-check
   ```
   If they fail, use `pnpm lint:fix` and/or `pnpm format`, review the edits, then rerun the read-only gates.
6. Reinspect `git diff` after any fix command. Confirm no secrets, generated client artifacts, `console.log`, unjustified `any`, or unrelated edits were introduced.
7. Compare failures with `.github/workflows/validate-prs.yml`; its jobs are `lint`, `type-check`, `unit`, and `e2e`. The workflow uploads only `apps/saas/playwright-report/` as the `playwright-report` artifact.

## Canonical reference

`packages/api/modules/organizations/procedures/generate-organization-slug.test.ts` demonstrates focused oRPC testing with Vitest; `apps/saas/tests/login.spec.ts` demonstrates accessible-role Playwright assertions.

## Done

Report every command and exit result, whether clean-checkout installation/generation was exercised, and any justified E2E skip. Verification requires focused tests, `pnpm lint`, `pnpm format:check`, and `pnpm type-check`, plus relevant E2E for changed browser flows.

## Common mistakes and fixes

| Failure                                                   | Cause                                                                                       | Fix                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Missing `packages/database/prisma/generated/client`       | Clean checkout or changed Prisma schema has not generated the ignored client                | Run `pnpm --filter @repo/database generate`; never edit generated client/Zod output  |
| `ERR_PNPM_NO_MATCHING_VERSION` or catalog install refusal | A catalog entry is wrong or the release is younger than `minimumReleaseAge: 1440`           | Correct/reuse `catalog:` or choose an eligible release; do not disable the age guard |
| `pnpm format:check` reports Markdown/TS indentation       | Hand indentation differs from Oxfmt output, including tabs in formatted TypeScript examples | Run `pnpm format`, review the diff, then rerun `pnpm format:check`                   |
| No root `e2e` script or wrong filter                      | E2E is app-local; CI unit uses exact workspace names                                        | Use the commands above, including `@repo/api` and `@repo/database`                   |
