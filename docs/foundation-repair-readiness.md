# EzPic foundation repair readiness

- Date: 2026-08-24
- Branch: `codex/ezpic-foundation-repair`
- Baseline audit revision: `8938c213cae8c078bf05433b9acdc89aa96fa0be`
- Integrated implementation revision: `ce25d78fcdaeff2a43f30c507850fe50a145038f`
- Dependency security revision: `bc8381cc8f0b319baec4c00ee4a2e4a321231df2`
- Audit: `docs/repository-capability-audit.md`

## Readiness decision

| Gate   | Status                               | Permitted action                                                                                            | What remains prohibited                                                                   |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Gate A | **OPEN — local/code-level evidence** | Start a separately reviewed EzPic product PR 1 that only delivers the no-model-cost marketing/editor shell. | Model calls, public sales, deployment, or product PR 2-7.                                 |
| Gate B | **CLOSED**                           | None.                                                                                                       | Real image generation or claims based on unverified Provider/storage/moderation behavior. |
| Gate C | **CLOSED**                           | None.                                                                                                       | Public paid plans, Checkout launch, or billing claims.                                    |

Gate A is a development-scope decision, not merge, deployment, or production approval. Human review
and hosted CI are still required before integrating this branch.

## Gate A acceptance record

| Requirement from PR-F7             | Evidence                                                                                                                         | Result                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| FND-001 through FND-007 are closed | Finding closure matrix in `docs/repository-capability-audit.md`, integrated at `ce25d78`.                                        | Passed                          |
| Code-level integration passes      | PostgreSQL Database 113/113, Jobs 51/51, API 253/253.                                                                            | Passed                          |
| No unresolved Critical             | Final focused reviews found no Critical or Important correctness finding after fixes.                                            | Passed                          |
| Immutable upload regression        | MinIO 4/4 plus upload-finalization 11/11, repeated successfully.                                                                 | Passed locally                  |
| Migrations and drift               | 34 migrations apply to a fresh test database; existing and fresh test databases report no drift.                                 | Passed locally                  |
| Unit/contracts                     | 590/590.                                                                                                                         | Passed                          |
| Format, lint, type-check           | Format 846 files; lint zero warnings; type-check 21/21 tasks.                                                                    | Passed                          |
| Browser flows                      | Production-build Playwright: SaaS 9/9 and Marketing 2/2.                                                                         | Passed locally                  |
| Invariants and smoke               | Nine invariant checks with zero violations; route smoke passed; Provider smoke remained dry-run.                                 | Passed within stated boundary   |
| Supply-chain High gate             | `pnpm audit --prod --audit-level high` exits zero after the exact `deepmerge-ts@7.1.5` to `8.0.2` override.                      | Passed; lower severities remain |
| External boundary is explicit      | Trigger Cloud, real Providers, S3/R2, moderation, Stripe, Sentry, hosted CI, and staging load are listed as not certified below. | Passed                          |

## Gate B closure requirements

Gate B remains closed until one reviewed staging revision has all of the following:

1. Trigger.dev staging executes dispatch, poll/Webhook, cancellation, recovery, finalization,
   settlement, and cleanup tasks with durable PostgreSQL evidence.
2. At least the selected primary Provider is certified against the exact account, model ID, input
   mapping, status/result contract, cancellation semantics, rate limits, and measured cost. A backup
   Provider requires the same evidence before failover is enabled.
3. S3 or R2 staging proves private bucket policy, IAM, CORS, staging upload, immutable promotion,
   version/checksum binding, signed read, multipart abort, and physical deletion.
4. The production moderation adapter is certified for prompt, input, and output policy behavior,
   timeout/error handling, current Provider identity, evidence TTL, and recovery.
5. The Standard/Quality model dataset, content rights, pass thresholds, latency target, and per-job
   budget are approved.
6. Staging load and recovery drills cover queue backlog, uncertain submission, Provider outage,
   moderation outage, and storage cleanup.

Until then, `MEDIA_GENERATION_ENABLED` must not be treated as production-ready and no local mock or
dry run may be presented as real generation evidence.

## Gate C closure requirements

Gate C remains closed until Gate A is satisfied on the integration target and all of the following
are proven in Stripe test mode:

1. Checkout, initial paid invoice, renewal, scheduled plan change, cancellation, paid-through access,
   and customer portal ownership;
2. annual-plan internal monthly grants, continuation, expiry, and late invoice recovery;
3. partial and full refunds, cumulative rounding, refund failure/cancellation, event duplication,
   event reordering, and active Reservation success/release paths;
4. scheduled reconciliation actually reads Stripe test API pages and resumes from a durable cursor;
5. Webhook signature verification, replay, worker retry, lease recovery, dead-letter diagnostics,
   and human repair authority;
6. pricing, included credits, per-edit cost envelope, refund policy, and gross-margin thresholds are
   frozen and truthful;
7. historical Purchase ownership is backfilled and `purchase_exactly_one_owner` is validated.

## Verification record

### Static and repository gates

| Command                                      | Result                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | Passed.                                                               |
| `pnpm format` / `pnpm format:check`          | Passed; 847 files checked.                                            |
| `pnpm lint --deny-warnings`                  | Passed.                                                               |
| `pnpm type-check`                            | Passed after supplying the isolated test `DATABASE_URL`; 21/21 tasks. |
| `pnpm test`                                  | Passed with the isolated `DATABASE_URL`; 12/12 Turbo tasks.           |
| `pnpm test:unit:contracts`                   | Passed; 590/590.                                                      |
| `pnpm audit --prod --audit-level high`       | Exit 0; 6 low and 21 moderate remain.                                 |
| `git diff --check`                           | Passed.                                                               |
| `pnpm verify:ci-workflow`                    | Passed static workflow-contract validation.                           |
| Trigger package type-check                   | Passed.                                                               |
| Load TypeScript and JavaScript syntax checks | Passed.                                                               |
| Docs type-check and production build         | Passed.                                                               |

The first final type-check without `DATABASE_URL` failed at Prisma config loading. That is recorded as
an environment prerequisite failure, not hidden as a code failure; the correctly configured rerun
passed.

### Database and application gates

| Scope                             | Result                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL integration            | Database 113/113; Jobs 51/51; API 253/253.                                                                                                                                           |
| Fresh database                    | All 34 migrations applied successfully.                                                                                                                                              |
| Existing and fresh database drift | No difference.                                                                                                                                                                       |
| Catalog checks                    | Twelve required constraints, two expected indexes, three immutable triggers, and three critical `ON DELETE RESTRICT` foreign keys were present; obsolete unique indexes were absent. |
| Historical ownership constraint   | `purchase_exactly_one_owner` exists as `NOT VALID` by design.                                                                                                                        |
| Invariants                        | Nine checks returned zero violations; final observed local queue p95 was 50.75 ms.                                                                                                   |
| Route smoke                       | Passed.                                                                                                                                                                              |
| Provider smoke                    | Dry run only: one executable route, 3000-micro budget, no external call.                                                                                                             |

### Storage and browser gates

| Scope                                  | Result                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| MinIO immutable upload                 | 4/4.                                                                                                                                   |
| Upload finalization                    | 11/11 twice; fixtures cleaned between runs.                                                                                            |
| SaaS Playwright, production build      | 9/9.                                                                                                                                   |
| Marketing Playwright, production build | 2/2.                                                                                                                                   |
| Dev-mode Playwright                    | Not complete: Next.js repeatedly failed to load `app/layout` with `ChunkLoadError`. The task-owned server tree and ports were stopped. |

The final review also separated the standard unit, PostgreSQL integration, and production-build E2E
package scripts. The ordinary `pnpm test` entry no longer starts Playwright or loads integration
files; the explicit `pnpm test:integration` and `pnpm e2e:media:ci` entries were rerun successfully.

Production-build Playwright proves only the local application and test-adapter path. It did not
contact a model, Provider, Stripe, Sightengine, Trigger Cloud, S3/R2, or Sentry.

## Not completed or not certified

- GitHub Actions has not run for this branch.
- The branch has not been pushed, merged, or deployed.
- Trigger.dev Cloud login/build/deploy was not completed. A CLI authentication wait was stopped and
  its task process exited.
- No real Provider or paid model call was made.
- No real S3/R2 staging or production bucket was touched.
- No production moderation account was called.
- No Stripe test-mode or live-mode action was performed.
- No Sentry event delivery was verified.
- No target-duration staging or production load test was run.
- No production database backup, restore, backfill, or constraint validation was performed.

## Known residual risks

1. `pnpm audit` reports 6 low and 21 moderate advisories after the High fix.
2. Prisma 7.9.1's PostgreSQL adapter emits a `pg@8.22.0` overlapping-query deprecation warning from
   the internal query-plan interpreter. Current tests pass; pg 9 adoption requires a fresh review.
3. Dev-mode Next.js browser verification is blocked by the reproducible `app/layout` chunk load
   failure, although production-build browser suites pass.
4. The ownership check constraint is not validated against production historical data.
5. Local Docker and fake-service evidence can drift from real external services.

## Human decisions before EzPic PR 1

Before product-shell implementation or review is accepted, humans must supply or approve:

1. production Marketing/SaaS origins and support email through configuration;
2. operator legal identity, jurisdiction, retention, privacy, content, refund, and acceptable-use
   policies;
3. whether Pricing may show pre-launch offers while Gate C is closed, plus truthful plan/credit copy;
4. English-only launch versus maintained translations;
5. licensed Before/After examples and attribution evidence;
6. the hosted-CI and merge strategy for this repair branch;
7. the production backfill/validation plan for Purchase ownership before public billing.

## Next allowed action

After human review, start one independent EzPic product PR 1 branch/worktree. That PR may implement
the original upload + prompt + example + mode shell, anonymous draft/login recovery, brand metadata,
legal routes, canonical/robots/sitemap/noindex behavior, removal of demo surfaces, accessibility, and
mobile support.

It must not submit a generation job, call a model, expose video/audio/text-generation entry points,
enable public sales, or start product PR 2-7.
