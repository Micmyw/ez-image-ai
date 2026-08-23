---
name: reviewing-a-pr
description: Use when performing an evidence-based code review of a pull request against repository contracts.
---

# Review a pull request

## Scope

Use to identify correctness, security, data, compatibility, and test gaps. Do not rewrite the change, post review comments, or approve/merge unless explicitly requested.

## Procedure

1. Read the PR intent and checks, then inspect the exact base diff:
   ```bash
   gh pr view <pr-number> --json title,body,baseRefName,headRefName,files,statusCheckRollup
   gh pr diff <pr-number>
   ```
2. Map touched files to runtime boundaries: Next.js route/layout, client component, oRPC procedure, Better Auth, database, provider package, i18n, or generated output.
3. Trace each changed call path end to end. Check authentication, organization ownership, Zod input/output contracts, redirect origins, provider webhook verification, and server/client env exposure.
4. Compare with nearby canonical implementations. Examples include `packages/api/modules/organizations/procedures/`, `apps/saas/modules/auth/components/LoginForm.tsx`, and `apps/marketing/modules/home/components/ContactForm.tsx`.
5. Check schema edits against `packages/database/prisma/schema.prisma`, PostgreSQL/MySQL/SQLite Drizzle schemas, both query layers, and a Prisma migration when persistence changes. Reject manual edits under `packages/database/prisma/generated` or `packages/database/prisma/zod`.
6. Check tests against `.github/workflows/validate-prs.yml`: unit filters are `@repo/api`, `saas`, and `marketing`; E2E suites are app-local.
7. If the PR changes commands, paths, ports, environment names, routing, package ownership, schema/query strategy, or another documented convention, require matching updates to `AGENTS.md` and the relevant files under `.agents/skills`; do not leave the skills pointing at the old structure.
8. Run focused read-only verification when useful. Report findings by severity with a concrete failure scenario and exact file/symbol; separate blockers from optional suggestions.

## Canonical reference

`packages/api/modules/payments/procedures/create-checkout-link.ts` is a strong review reference: it validates input, verifies organization billing access, resolves configured prices, constrains redirects, and normalizes provider errors.

## Done

The review states the base/head and areas inspected, lists actionable evidence-backed findings, calls out missing tests and stale skills/docs, and explicitly says when no blocking findings remain.

## Common mistakes

- Reporting style preferences as correctness defects.
- Reviewing only changed lines without checking callers and exports.
- Trusting client-supplied `organizationId`, redirect URLs, or price IDs.
- Assuming a green CI run proves authorization and tenant isolation.
- Approving a structural rename while canonical references in `.agents/skills` still target removed paths or commands.
