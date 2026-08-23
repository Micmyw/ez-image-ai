# Task 4 Report: Reliable Media Job Orchestration

## Status

Implemented and review-remediated on `codex/ai-media-foundation`.

## Delivered

- Added `@repo/jobs` with dependency-injected handlers for dispatch, provider events, finalization, settlement, reconciliation, outbox delivery, upload verification, cleanup, and credit invariant checks.
- Added thin Trigger.dev 4.5.10 bindings and `trigger.config.ts` using Prisma 7 `prismaExtension({ mode: "modern" })`. CLI and SDK are pinned to 4.5.10. Trigger payloads contain internal IDs and versions only.
- Added short provider submission with deterministic attempt idempotency, uncertain-acceptance reconciliation (no blind failover), Replicate verified webhook processing, retrieve-only Kie reconciliation, Fal persisted retrieval semantics, and Gemini synchronous attempt normalization.
- Added raw `/api/webhooks/ai/:provider` before the oRPC catch-all. It verifies raw bytes/timestamp/signature, atomically persists the verified envelope plus Outbox, and treats Trigger delivery as best effort. Unsupported providers fail closed.
- Added finalization to private storage with Task 3 remote stream policy, capped image-only inline base64, candidate-level failure isolation, moderation, READY-only output counting, provider cost recording, and idempotent credit settlement. No approved output settles at zero credits.
- Added stale reconciliation with bounded batches, `SKIP LOCKED`, lease tokens, age-aware backoff, repeated-repair audit/page marker, and outbox lease recovery.
- Added public catalog, quote/create/cancel/retry generation, get/list jobs, list assets, credit account, and admin kill-switch procedures. Provider/model IDs and provider parameters remain server-owned. BigInt and cursors are JSON safe.
- Added pure `/api/health` liveness and non-mutating `/api/ready` checks. Readiness details are returned only to admins.
- Added the `SUBMITTING` and `FINALIZING` job states plus reconciliation fields in migration `20260813030000_media_orchestration_states`.

## Review remediation

- **C1 — rejected submissions:** retryable provider rejection atomically fails the current attempt, creates the next catalog-approved attempt, advances the job to `DISPATCH_QUEUED` with compare-and-swap semantics, and writes the dispatch Outbox event. Terminal rejection advances through `FINALIZING`; a zero-output settlement releases the full reservation.
- **C2 — reconciliation metadata:** provider submissions now return typed reconciliation metadata. Fal status/result URLs and submission tokens are stored in dedicated columns. Replicate and Fal uncertain submissions no longer substitute the internal attempt ID for a provider task ID; missing provider task IDs stay pending for manual repair. Failed or canceled reconciliation enters zero-charge settlement. Kie remains retrieve-only and is not a selectable generation route.
- **C3 — finalization retries:** retryable transfer and moderation failures leave the job in `FINALIZING` and persist the stage, retry count, next retry time, stable error code, and retry Outbox event. Moderation `ERROR` retries; `REVIEW` stays quarantined and never becomes `READY`. Deterministic assets are reused when transfer already succeeded before a moderation retry.
- **C4 — Gemini atomic completion:** provider submission, normalized outputs, attempt completion, job transition, and finalization Outbox creation commit in one transaction. A transaction-barrier database test proves the Outbox event is not visible before output persistence commits.
- **C5 — webhook monotonicity:** provider timestamp/sequence metadata and a compare-and-swap processing lease prevent concurrent double processing. Terminal attempt state and the canonical terminal response cannot be overwritten. Provider ordering is preferred, with `receivedAt` only as fallback.
- **I6 — authorization:** quote, create, and retry share one authorization gate covering rate limiting, kill switch, model availability, plan entitlement, budget, credits, `READY` source assets, and version checks. Retry uses the current catalog and pricing rather than copying a stale or zero-cost quote. Added `BUDGET_EXCEEDED` and `ENTITLEMENT_REQUIRED` errors.
- **I7 — queues:** provider/model concurrency is parsed from configuration, deterministic route queue keys are server-owned, and Outbox delivery resolves the route before triggering static route-specific tasks. Trigger payloads still contain only job ID/version. Static tasks cover Replicate image, Fal image/video, and Gemini image routes.
- **I8 — production runtime tests:** production-store factories are injectable and are exercised directly against the isolated PostgreSQL database rather than by duplicating store behavior in test-only implementations.

### Review remediation round 2

- **C1 — real HTTP rejection:** Replicate and Fal now normalize every received non-2xx response as a certain `FAILED` submission with an explicit failure. HTTP 408/409/425/429 and 5xx are retryable; other 4xx are terminal. JSON and non-JSON error bodies are preserved safely. Dispatch consumes this explicit failure directly, while transport timeout/error remains unknown acceptance. Production-store tests drive real adapter responses through dispatch: 429 selects the next catalog route, and 400 reaches terminal zero-charge settlement without leaving the job in `SUBMITTING`.
- **C2 — synchronous Gemini uncertainty:** Gemini no longer stores or retrieves results through a process-local Map. A stable internal attempt ID is persisted only for a completed synchronous response. Transport uncertainty creates a `SUBMISSION_UNCERTAIN` attempt with no provider task ID, never failovers or resubmits, and stays in bounded/manual reconciliation. At the fifth unresolved repair claim, recovery marks the attempt expired and queues zero-charge settlement.
- **C5 — cross-event ordering:** provider-event writes lock the shared GenerationAttempt row with `FOR UPDATE`, so different webhook events serialize. Ordering is provider sequence first, provider occurrence time second, and receipt time only when neither provider ordering signal exists. Terminal state/response remain immutable; stale events are processed with `STALE_EVENT_IGNORED`. A two-event barrier test commits newer success against older failure and verifies one finalization Outbox and no settlement Outbox.
- **I6 — committed daily budget:** abandoned quotes no longer count as spend. Quote authorization performs a prospective check, while create/retry leave authoritative daily admission to the serializable job transaction. That transaction acquires an owner/day advisory lock, sums only quote costs already bound to jobs, checks the candidate once, and preserves idempotent replay. Database tests cover 100 abandoned quotes, quote-to-create/replay, and two concurrent near-cap creates where only one succeeds.

## RED/GREEN evidence

- C1 RED: the production-store test factories needed to exercise rejection recovery did not exist. GREEN: the added production database runtime coverage passed in the current 9-test Jobs database integration run.
- C2 RED: the provider contract and database lacked typed reconciliation metadata/columns. GREEN: all 26 AI tests and the current Jobs database integration run passed with the persisted metadata behavior.
- C3–C5 RED: finalization retry state, Gemini transaction visibility, and monotonic concurrent webhook processing were absent from the production-store coverage. GREEN: all corresponding production database cases passed in the current 9-test Jobs database integration run.
- I6 RED: there was no shared generation authorization module. GREEN: the authorization suite contributes 8 tests to the current API result of 8 files/31 tests passing.
- I7 RED: route selection was absent and concurrency maps were empty. GREEN: the queue suite's 2 tests passed as part of the Jobs verification and the Trigger task/config standalone compile passed.
- Prisma drift RED: the isolated database exposed two migration-created indexes that were not declared in the Prisma schema. GREEN: `@@index([status, nextFinalizeAt])` and `@@index([processingLeasedUntil])` were added, the generated clients refreshed, and Prisma 7 now reports `No difference detected.`
- Round 2 C1 RED: four JSON non-2xx adapter cases returned `UNKNOWN`, real 429/400 dispatches entered reconciliation, and a non-JSON 429 was treated as malformed. GREEN: all cases now follow explicit certain rejection, with production database recovery/settlement assertions.
- Round 2 C2 RED: same-worker Gemini retrieve returned a process-local success and transport timeout entered rejected/failover handling. GREEN: replacement workers always retrieve `UNKNOWN`; transport uncertainty persists as `SUBMISSION_UNCERTAIN`, never creates a second attempt, and bounded recovery zero-settles.
- Round 2 C5 RED: the different-event barrier timed out because no shared Attempt lock boundary existed. GREEN: `FOR UPDATE` serializes writes and the barrier test preserves newer terminal success while marking the older event ignored.
- Round 2 I6 RED: committed-cost accounting did not exist and both concurrent 60/100 candidates succeeded. GREEN: abandoned quote cost is 0, replay cost remains 60 once, and one of two concurrent 60-cost creates is rejected at a 100 cap.

## Verification

- Both `DATABASE_URL` and `TEST_DATABASE_URL` were set only to `postgresql://ai_media_test:***@127.0.0.1:55432/ai_media_foundation_test` for every database command and test.
- `prisma migrate deploy`: passed; all 10 repository migrations are applied with no pending migration.
- `prisma migrate status`: passed against the same isolated database.
- Prisma 7 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`: passed with `No difference detected.`
- Round 2 migrations: `20260813070000_media_submission_uncertain` and `20260813071000_media_attempt_event_ordering`, in addition to the eight migrations listed above.
- `pnpm --filter @repo/database test:integration`: 1 file, 23 database integration tests passed.
- `pnpm --filter @repo/database type-check`: passed.
- `pnpm --filter @repo/ai test`: 3 files, 31 tests passed.
- `pnpm --filter @repo/ai type-check`: passed.
- `pnpm --filter @repo/jobs test`: 1 test passed.
- `pnpm --filter @repo/jobs test:integration`: 2 files, 13 database integration tests passed.
- `pnpm --filter @repo/jobs type-check`: passed.
- `pnpm --filter @repo/api test`: 8 files, 32 tests passed.
- `pnpm --filter @repo/api type-check`: passed.
- Trigger config and all Trigger task files compiled standalone with TypeScript 6.0.3 using `--ignoreConfig`: passed.
- `pnpm exec trigger -v`: `4.5.10`.
- Focused Oxlint on 20 changed/new TypeScript files with warnings denied: passed.
- Focused Oxfmt check across 23 changed/new source, schema, SQL, and report files: passed.
- `git diff --check`: passed.

## Scope and limitations

- No live Trigger.dev deployment was attempted because no authenticated project/token was supplied. This report claims only local task/config type validation, not deployment.
- No live Replicate, Fal, Gemini, Kie, moderation-vendor, Trigger.dev, or S3 call was made. Provider/storage behavior was tested only with adapters and the isolated PostgreSQL test database.
- No production database was accessed or modified.
- Focused pnpm commands emit an existing workspace warning that the root `tsconfig.json` base alias is unavailable from the isolated worktree resolution context; the package type checks themselves exit successfully.
