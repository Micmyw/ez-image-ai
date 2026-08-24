# EzPic repository capability audit

- Date: 2026-08-24
- Baseline audit commit: `8938c213cae8c078bf05433b9acdc89aa96fa0be`
- Integrated implementation commit: `ce25d78fcdaeff2a43f30c507850fe50a145038f`
- Audit branch: `codex/ezpic-foundation-repair`
- Audit worktree: `D:\AIProject\Gefei\SaaSTool\ez-image-ai\.worktrees\ezpic-foundation-repair`
- Product specification: `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`
- Specification SHA-256: `4677B0FC33D7DD8773C206DEA1CEA4389354D0CCD8BD0A1BBBAF2B138C670B24`

## Decision

The original 2026-08-23 audit correctly stopped EzPic product PR 1 and opened FND-001 through
FND-007. The integrated repair revision closes all seven findings at the repository and isolated
integration-test level.

- **Gate A: OPEN with a narrow scope.** The next allowed product change is EzPic PR 1 only. It must
  remain non-generating, incur no model cost, and not enable public paid sales.
- **Gate B: CLOSED.** Real generation remains blocked until Trigger.dev staging, real Provider,
  S3/R2 staging, production moderation, dataset, budget, and threshold certification exist.
- **Gate C: CLOSED.** Public sales remain blocked until full Stripe test-mode certification,
  reconciliation evidence, plan economics, and production data validation are complete.

This decision does not certify any external service or production environment. The detailed gate
record is `docs/foundation-repair-readiness.md`.

## Evidence boundary

Confirmed evidence in this audit comes from source review and isolated local execution with Linux
Docker containers for PostgreSQL 16 and MinIO. It includes fresh and existing database migration
checks, PostgreSQL integration tests, MinIO upload regression tests, production-build Playwright,
unit/contracts, static gates, route smoke, and invariant checks.

The following are explicitly **not** certified:

- GitHub Actions execution;
- Trigger.dev Cloud or staging delivery;
- Replicate, Fal, Kie, or Gemini account/model behavior;
- production S3 or R2 IAM, bucket policy, lifecycle, CORS, and signed URL behavior;
- Sightengine or another production moderation account;
- Stripe test mode or live mode;
- Sentry ingestion and alerting;
- staging target-duration or production load.

Local mocks, dry runs, MinIO, PostgreSQL fixtures, and production builds are not substitutes for
those external certifications.

## Finding closure matrix

| Finding | Original broken invariant                                                                                                                    | Repair code and revision                                                                                                                                                                                                                                                     | RED/GREEN coverage                                                                                                                                                                                                                                                              | Conclusion                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| FND-001 | Positive Debt did not block new generation; refund then settlement could avoid Debt; expired credits could remain spendable.                 | `packages/database/prisma/queries/media/credits.ts`, `packages/api/modules/media/lib/generation-authorization.ts`, migrations `20260823010000_credit_expiry_invariants` and `20260823011000_expired_unrefunded_credits`; commits `274fd8e`, `14a4558`, `460e1a3`, `be75d24`. | `generation-authorization.test.ts`; `media.integration.test.ts` covers the transactional Debt gate, refund/settle overlap, FIFO identity, expiry, release, and idempotent replay.                                                                                               | **CLOSED**                                                                              |
| FND-002 | Config, catalog, registry, and worker routes could diverge; malformed or incomplete HTTP 2xx could be treated as a safe rejection.           | `packages/ai/media/catalog/routing.ts`, `packages/api/modules/media/lib/executable-route-graph.ts`, `packages/jobs/src/handlers/dispatch-generation.ts`, `packages/jobs/src/runtime.ts`; commits `0344846`, `e458b5f`, `f1e0b1e`.                                            | `catalog.test.ts`, `executable-route-graph.test.ts`, `providers.contract.test.ts`, `dispatch-generation.security.test.ts`, `dispatch-generation.recovery.test.ts`, and Provider cancellation contracts.                                                                         | **CLOSED**                                                                              |
| FND-003 | A replayable client PUT wrote the final object key and could replace approved bytes.                                                         | `packages/storage/provider/s3/index.ts`, `packages/api/modules/media/procedures/complete-upload-session.ts`, `packages/database/prisma/queries/media/assets.ts`, upload lease and terminalization migrations; commits `83623b3`, `cf01dcf`, `26018e2`, `58c51b3`, `754a672`. | `immutable-upload.minio.integration.test.ts` (4/4), `immutable-upload.test.ts`, `complete-upload-session.test.ts`, and `upload-finalization.integration.test.ts` (11/11 twice).                                                                                                 | **CLOSED**                                                                              |
| FND-004 | A transient Stripe worker failure returned normally, so Trigger.dev treated the attempt as successful and could strand the event.            | `packages/jobs/src/handlers/process-payment-event.ts`, `packages/jobs/trigger/process-payment-event.ts`, `packages/jobs/trigger/recover-payment-events.ts`, `packages/database/prisma/queries/media/billing.ts`; commits `f7c7485`, `6f32aab`.                               | `process-payment-event.test.ts`, `recover-payment-events.test.ts`, and `payments.integration.test.ts` cover retry context, leased attempts, fencing, bounded dead-lettering, and durable recovery.                                                                              | **CLOSED**                                                                              |
| FND-005 | Scheduled reconciliation did not query Stripe; refund state handling could apply irreversible credit changes before a final succeeded state. | `packages/payments/provider/stripe/billing-source.ts`, `reconciliation.ts`, `reducer.ts`, `packages/jobs/src/handlers/reconcile-subscriptions.ts`, immutable repair authority in `stripe-refund-repairs.ts`; commit `48692fb` plus the FND-001/FND-004 payment foundations.  | `stripe-reconciliation.integration.test.ts` covers fixed-cutoff paging, cursor/lease fencing, budgets, missing facts, and conflicts; `payments.integration.test.ts` covers succeeded/failed/canceled/partial refunds, replay, active reservations, and two-actor legacy repair. | **CLOSED at code level**; Gate C remains closed pending Stripe test-mode certification. |
| FND-006 | Exhausted input moderation could leave an asset permanently `VERIFYING` without durable recovery or an audited requeue.                      | `packages/jobs/src/handlers/recover-media-verifications.ts`, `packages/jobs/trigger/recover-media-verifications.ts`, `packages/database/prisma/queries/media/admin-operations.ts`, checksum/provider/TTL-bound evidence in media queries; commits `e77bfaf`, `4ed5cd9`.      | `recover-media-verifications.test.ts`, `verify-upload.database.integration.test.ts`, `moderation-recovery.database.integration.test.ts`, and `moderation-admin-requeue.integration.test.ts`.                                                                                    | **CLOSED**                                                                              |
| FND-007 | A user retry could reuse an earlier approval instead of creating a current, content-bound moderation attempt.                                | `packages/api/modules/media/procedures/retry-generation.ts`, `packages/database/prisma/queries/media/retry-requests.ts`, retry checksum and quote checkpoints; commit `e77bfaf` with final evidence hardening in `4ed5cd9`.                                                  | `retry-generation.test.ts`, `retry-requests.integration.test.ts`, and `retry-input-checksum.database.integration.test.ts` cover current moderation, exact idempotent replay, crash recovery, and changed-byte rejection.                                                        | **CLOSED**                                                                              |

## Current capability matrix

| Required foundation capability                                | Current repository result                                                                                                                                                        | Evidence boundary                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PostgreSQL business source of truth                           | Confirmed. Job, attempt, asset, evidence, credit, billing, payment-event, retry, cleanup, and recovery state is persisted and fenced in PostgreSQL.                              | Local PostgreSQL only; backup/restore and production operations are not certified. |
| Immutable credit ledger and atomic reservation                | Confirmed. Debt gates generation in the write transaction; refunds, expiry, settlement, release, grants, and Debt repayment remain immutable and idempotent.                     | Concurrency/invariant tests passed; production historical data is not exercised.   |
| Trigger.dev tasks, Outbox, Webhook, polling, and recovery     | Confirmed at code level. Durable leases, attempt tokens, compare-and-set completion, recovery scanners, and dead-letter paths exist.                                             | Trigger type-check passed; Trigger Cloud execution is not certified.               |
| Provider abstraction and server-side routing                  | Confirmed. Public keys are separated from private route/model/provider data; API visibility and worker execution share the same route-graph contract.                            | Fake-server and dry-run evidence only; no Provider account was called.             |
| Private storage and immutable asset versions                  | Confirmed locally. Clients write staging keys; server promotion binds final bytes and checksum/version evidence; cleanup is durable and fenced.                                  | MinIO passed; S3/R2 staging and production policies are not certified.             |
| Prompt, input, and output moderation                          | Confirmed at code level. Fail-closed decisions, append-only evidence, TTL/provider/checksum binding, quarantine, recovery, and admin requeue exist.                              | Test adapter/contracts only; production moderation is not certified.               |
| Stripe verification, idempotency, reconciliation, and refunds | Confirmed at code level. Raw events persist first, workers own mutations, reconciliation reads a bounded source abstraction, and refund state reduction is terminal/idempotent.  | Stripe fixtures/source fakes only; Stripe test-mode Gate C is closed.              |
| Task restoration and operator diagnostics                     | Confirmed. Expired leases, uncertain submissions, finalization, output transfer, cancellation, moderation, payment events, and cleanup have bounded recovery and audit evidence. | No production alert or recovery drill was performed.                               |

## Additional comprehensive review findings

The repair review did not stop at the seven original rows. GPT-proposed changes were compared with
the integrated implementation and additional gaps were repaired before this revalidation:

- generated output storage quota is reserved before transfer and released only after confirmed
  physical deletion;
- remote output URL failures have deterministic versus uncertain classifications;
- output transfer/finalization uses lease and token fencing, preserves output positions, and settles
  partial output cost only after every transfer reaches a terminal state;
- Provider cancellation has a dedicated idempotent path and cannot alias ordinary success;
- READY media authorization requires the latest exact approved evidence with the configured
  Provider and unexpired TTL;
- invalid uploads enter a deterministic terminal state and schedule delayed physical cleanup;
- expired upload-finalization leases are selected ahead of ordinary expired-upload backlog, so the
  bounded sweeper cannot starve active recovery;
- reusable PostgreSQL and browser fixtures remove their own task data;
- anonymous draft handoff redirects through the configured public SaaS origin instead of an
  internal request Host, and abandoned E2E drafts are expired only through explicit marker-bound
  candidate IDs;
- Playwright retries use unique scenario prompts and cancellation waits for a definite submitted
  Provider task, without weakening the production reconciliation guard;
- root unit, database integration, and production-build E2E commands have separate script
  boundaries, so `pnpm test` no longer starts browsers or loads PostgreSQL integration suites.

Independent review of output transfer and moderation/retry changes found no remaining Critical or
Important correctness issue after the final fix pass.

## Verification summary

| Command or scope                       | Result                                                               | Meaning                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`       | Passed                                                               | Clean lockfile install was exercised; the release-age guard remained enabled.                      |
| `pnpm format:check`                    | Passed on 847 files                                                  | Full current formatting baseline is clean.                                                         |
| `pnpm lint --deny-warnings`            | Passed                                                               | Full repository lint gate.                                                                         |
| `pnpm type-check`                      | 21/21 Turbo tasks passed                                             | Includes Prisma Client and Zod generation. Requires an isolated `DATABASE_URL`.                    |
| `pnpm test`                            | 12/12 Turbo tasks passed                                             | Standard unit entry remains separate from database integration and browser E2E.                    |
| `pnpm test:unit:contracts`             | 590/590 passed                                                       | Config, AI, storage, payments, database, jobs, E2E fixture contracts, API, SaaS, and marketing.    |
| `pnpm test:integration`                | Database 113/113; Jobs 51/51; API 253/253                            | Isolated PostgreSQL integration. Expected error-path log fixtures remain visible.                  |
| MinIO immutable upload integration     | 4/4 passed                                                           | Local staging/promotion/replay regression; not S3/R2 certification.                                |
| Production-build Playwright            | SaaS 9/9; Marketing 2/2                                              | Local application path with test adapters; no paid or external model call.                         |
| `pnpm load:smoke`                      | Passed                                                               | Guarded local route smoke, not staging load acceptance.                                            |
| `pnpm verify:invariants`               | 9 checks, zero violations                                            | Local database invariants; final observed queue p95 was 50.75 ms.                                  |
| Provider smoke                         | Dry run passed with one route and 3000-micro budget                  | Zero external calls and zero model cost.                                                           |
| Fresh migration and drift              | 34 migrations applied; no drift on fresh and existing test databases | Local catalog also retained required constraints, indexes, triggers, and `ON DELETE RESTRICT` FKs. |
| `pnpm audit --prod --audit-level high` | Exit 0; 6 low and 21 moderate remain                                 | `deepmerge-ts` High GHSA-ggr8-5vv4-36mx is removed through `8.0.2`.                                |
| Docs type-check and build              | Passed                                                               | Fumadocs/Next route types and production documentation build completed locally.                    |

The first final `pnpm type-check` invocation without `DATABASE_URL` stopped during Prisma generation;
the same command passed after injecting the isolated test database URL. A standard `pnpm test` run
also exposed that the media E2E and API integration scripts crossed the unit boundary; the scripts
were separated and the configured rerun passed 12/12 Turbo tasks. Dev-mode Playwright remains blocked
by a reproducible Next.js `ChunkLoadError` for `app/layout`; production-build Playwright is the
passing browser evidence.

## Remaining risks and external prerequisites

1. GitHub Actions has not run on this branch. Static workflow-contract validation passed, but it is
   not a hosted CI result.
2. Trigger.dev local deploy/build entered an authentication flow and was stopped. No cloud login or
   authorization was completed; only TypeScript and repository contract checks are evidence.
3. Prisma 7.9.1 with `@prisma/adapter-pg` emits a `pg@8.22.0` deprecation warning when Prisma's
   internal query-plan interpreter overlaps operations. Tests pass, but it must be revisited before
   upgrading to pg 9.
4. `pnpm audit` still reports lower-severity advisories: 6 low and 21 moderate. There is no High or
   Critical advisory at the recorded revision.
5. `purchase_exactly_one_owner` intentionally remains `NOT VALID` for historical rows. Backfill,
   conflict review, and constraint validation are required before Gate C or production billing.
6. Production/staging credentials, quotas, webhook delivery, bucket controls, moderation behavior,
   Sentry alerts, backup/restore, and target-duration load remain unverified.

## Human decisions required before product PR 1

The foundation no longer requires a silent architecture rewrite, but product PR 1 still needs
explicit values or policies for:

1. configured production Marketing/SaaS origins and support email; no candidate domain may be
   hard-coded;
2. legal operator identity, jurisdiction, retention, acceptable-use/content policy, refund terms,
   and privacy contact;
3. truthful Free/Creator/Studio offers, credit amounts, and whether pricing is shown before Gate C;
4. English-only launch versus a fully maintained locale set;
5. owned or licensed Before/After examples and attribution records;
6. acceptance of local Gate A evidence and the requirement that the repair branch pass human review
   and hosted CI before merge;
7. a production-data plan for validating `purchase_exactly_one_owner` before any paid launch.

## Scope statement

This foundation-repair branch does not implement the EzPic homepage, brand shell, legal pages, SEO,
real image generation, subscription sales, deployment, or any product PR 2-7 work. It has not been
pushed, merged, or deployed by this task.

The only next allowed implementation is the independently reviewed EzPic product PR 1 within the
narrow Gate A boundary above.
