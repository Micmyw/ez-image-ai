---
name: verify-changes
description: Select focused tests or reproduce CI checks for this monorepo when a change spans packages or needs release verification.
---

# Verify changes

Use this command map when check selection is unclear. Small isolated edits need the affected tests and file/workspace checks; cross-workspace, high-risk, release, or requested CI-parity work uses the full relevant gates.

## Select checks

- Inspect scope with `git status --short`, `git diff --stat`, and `git diff --check`.
- Run focused Vitest tests in the owning workspace, for example `pnpm --filter @repo/api test <test-file>` or `pnpm --filter saas test <test-file>`. The current combined unit command is `pnpm --filter @repo/api --filter saas test`; `.github/workflows/validate-prs.yml` is authoritative for CI.
- Use a focused Playwright spec when the changed route, rendering, auth, navigation, or form behavior needs browser coverage. Tests live in `apps/saas/tests`. Use the full owning-app path `pnpm --filter saas e2e:ci` when impact or release scope requires it. Pure docs/server/unit changes do not need an unrelated browser suite.
- Playwright owns an isolated Webpack development server and does not reuse an existing one. Set `E2E_USE_PRODUCTION_BUILD=true` when production-bundle behavior is part of the evidence.
- Foundation media workflow changes use `pnpm e2e:media:ci`: isolated users/assets, local Outbox pump, and unified SaaS media and draft-handoff suites, without real Provider calls. Keep the test database and private MinIO/S3 fixtures isolated from production.
- Full read-only quality gates are `pnpm lint`, `pnpm format:check`, and `pnpm type-check`. For a local change, use affected file/workspace checks first. Fix failures caused by the change, review fix-command diffs, and rerun the failed checks.

## Clean checkout and failures

When clean-checkout evidence is required, install with `pnpm install`. The ignored `packages/database/prisma/generated` client needs `pnpm --filter @repo/database generate` before direct database consumers, after schema changes, and before local E2E. Root `pnpm dev`, `pnpm build`, and `pnpm type-check` already reach generation through Turbo; do not repeat it for each command.

For missing clients, catalog/release-age failures, format mismatches, or wrong package filters, read [references/troubleshooting.md](references/troubleshooting.md). CI also owns PostgreSQL integration, production builds, media E2E with MinIO, supply-chain checks, and uploaded test artifacts; reproduce the failed job rather than assuming every local task needs all jobs.

Report checks run, actual results, and material gaps. Distinguish focused checks, full CI parity, clean-checkout evidence, and external service evidence. Once the relevant checks pass, broaden or repeat only for new changes, failures, or unresolved risk.
