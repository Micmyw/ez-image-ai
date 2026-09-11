# Workers runtime adapters implementation plan

> Execute the approved design in this task. Group work by functional boundary; use focused RED → GREEN tests and one final integration review. Existing uncommitted Cloudflare hosting work belongs to the baseline and must be preserved.

**Goal:** Run the website and background jobs without Containers using Workers, Workflows and Cloudflare Images, while retaining the existing Node/Sharp executor as an optional hybrid deployment.

**Approved design:** `EZPIC_DEPLOYMENT_PROFILE=workers` selects a Workers website, Workers job executor and Cloudflare Images. `hybrid` keeps the website on Workers and executes jobs with Containers/Sharp. PostgreSQL remains the only business source of truth; R2 remains private storage. A profile change is a build/deployment operation, not automatic failover for an in-flight task.

**Architecture:** Keep the existing task registry, handlers, transactional credits, immutable ledger, Outbox, recovery and authorization. Inject image processing and request-scoped database clients at the runtime boundary. Preserve existing standalone website/container artifacts as rollback tooling; only the two new profiles are the normal forward deployment choices.

**Tech stack:** Next.js with a compatible stable Workers adapter, Cloudflare Workers/Workflows/Durable Objects/Images, Prisma with PostgreSQL driver adapters, private S3/R2, TypeScript, Vitest and Playwright.

## Constraints

- No live deployment, account-plan upgrade, migration, push, PR or merge is included in this local implementation.
- Keep `minimumReleaseAge: 1440` and existing catalog policies. Change framework dependencies only when required by the supported Workers adapter.
- Worker artifacts must exclude native Sharp and Container execution dependencies.
- Keep all runtime choices, provider details, credentials and unrestricted object references server-only.
- Preserve bounded streaming, owner authorization, checksums, conditional multipart writes and deletion of clean guest staging images only after successful watermark storage.
- Preserve concurrency/admission limits and uncertain-provider submission recovery across both executors. Never retry a failed execution on a different runtime automatically.
- Document Cloudflare Images input/format limits explicitly; do not return an unwatermarked original when processing fails.
- Do not weaken TLS or reuse live databases for destructive tests.

## 1. Image processing boundary

- [x] Add contract tests for Images transformations, private streams, malformed/oversize inputs, failure propagation and concurrent processing contexts; record initial failing results.
- [x] Replace Sharp types in `packages/storage/lib/image-watermark.ts` with runtime-neutral image processing inputs and outputs. Add `packages/storage/image-processing/` adapters and a request-scoped injection helper.
- [x] Preserve Node/Sharp defaults using conditional module entry points; inject Cloudflare Images in Workers. Keep S3 multipart, checksum and cleanup ownership in the existing storage layer.
- [x] Run image-processing, watermark, storage and finalization regression tests.

## 2. Database context and Workers job executor

- [x] Add failing tests for concurrent database-context isolation and executor authentication, admission/concurrency, polling and sanitized failures.
- [x] Add a contextual database client and explicit request lifetime management in `packages/database`. Retain the existing Node singleton fallback outside Workers.
- [x] Add a Workers execution entry that invokes the existing `@repo/jobs` handlers and uses a single admission boundary. Reuse `InvokeTask`, Workflows durable waits and signed dispatch.
- [x] Preserve the Container executor under the hybrid profile; profile selection must be strict and must not change active attempt identity or database business state.
- [x] Verify both executor contracts, workerd runtime loading and relevant real PostgreSQL transactions/recovery tests.

## 3. Website Workers build and deployment profiles

- [x] Verify the exact supported Next.js/Workers adapter pair before adding dependencies. Preserve Next.js application behavior and existing standalone output.
- [x] Add Workers build configuration and a website wrapper providing per-request database/image contexts, while preserving security headers, auth redirects, Docs, static assets and the same canonical origin.
- [x] Add validated `workers`/`hybrid` profile preparation, separate entry points and binding/secret shapes. The Workers profile has no Container binding or image build.
- [x] Test generated deployment artifacts and secret filtering; produce a Workers dry build and a hybrid dry build.

## 4. Integration, documentation and handoff

- [x] Run formatting, lint, full type checks and unit contracts because this changes production architecture across workspaces.
- [x] Run applicable disposable PostgreSQL/MinIO integration tests and browser regression checks; record external prerequisites separately.
- [x] Review the combined behavior once, fix material findings, and rerun only affected verification after fixes.
- [x] Update deployment runbooks, environment examples, AGENTS.md and CHANGELOG.md. Document drain/rollback and required Hyperdrive/Images configuration.
- [x] Stop and verify every task-owned process tree. Report local builds/tests independently from live Cloudflare behavior, which remains unverified until a separately authorized deployment.

## Verification record

This section is updated as each functional boundary moves from RED to GREEN. No claim of live Cloudflare Images processing, production database connectivity, cost or deployment is implied by local adapter doubles or dry builds.

Completed evidence is recorded in
[local verification](../../operations/evidence/cloudflare-workers-local-verification-2026-09-11.md):
941 database/jobs/API integration tests, 33 browser tests, 22 workspace type tasks, final website
and jobs artifacts running real Prisma queries in workerd, and the hybrid image's visible
watermark lettering. Focused tests first failed before the relevant implementations/fixes.
The original platform source/build checks were extended to final-artifact startup after they
missed a Prisma packaging failure. No database tables or production migrations changed.

All recorded task process trees exited. The temporary Linux build directory, disposable
PostgreSQL/MinIO containers and the task's initial local test database were removed. Existing
development services, pre-existing changes and concurrent analytics work were preserved.
