---
name: debugging-a-failing-ci-run
description: Use when triaging or fixing a failed GitHub Actions validation job for a pull request.
---

# Debug a failing CI run

## Scope

Use for failures in `.github/workflows/validate-prs.yml`. Do not change tests, workflow gates, or production behavior merely to hide an unrelated infrastructure failure.

## Procedure

1. Capture the failing run, job, commit SHA, and first actionable error:
   ```bash
   gh pr checks <pr-number>
   gh run view <run-id>
   gh run view <run-id> --log-failed
   ```
2. Confirm the failure belongs to the current commit and classify it by the actual jobs: `lint`, `type-check`, `unit`, or `e2e`.
3. Reproduce the failed workflow step from a clean install when dependency/cache state is suspect:
   ```bash
   pnpm install
   pnpm lint
   pnpm format:check
   pnpm type-check
   pnpm --filter @repo/api --filter saas --filter marketing test
   pnpm --filter @repo/database generate
   pnpm --filter saas e2e:ci
   pnpm --filter marketing e2e:ci
   ```
   Run only the commands for the failed job after installation. CI's E2E install step uses `pnpm --filter database generate`; the unambiguous local package name is `@repo/database`.
4. Match CI environment requirements: `DATABASE_URL`, a test `BETTER_AUTH_SECRET`, and `RESEND_API_KEY` are workflow env values. Do not print secret values.
5. Reduce the reproduction to the failing file or test, then trace the earliest application error rather than later cascade errors or artifact-upload noise.
6. Fix the root cause and add or update a regression test when the failure exposed missing coverage.
7. Re-run the exact failed command, then `pnpm format`, `pnpm lint`, `pnpm type-check`, and relevant tests.

## Canonical reference

`.github/workflows/validate-prs.yml` is authoritative for Node setup, package filters, command order, the 60-minute E2E timeout, and the sole uploaded report: `apps/saas/playwright-report/` as `playwright-report`.

## Done

Document the failing job and error, root cause, changed files, and successful local reproduction of the workflow command.

## Common mistakes

- Debugging the latest run without checking its SHA.
- Assuming CI runs root `pnpm test`; its unit job uses three explicit filters.
- Fixing a secondary timeout while ignoring an earlier server build error.
- Logging or copying secret values into an issue or test fixture.
- Looking for a marketing report in CI artifacts; the current upload step includes only SaaS.
