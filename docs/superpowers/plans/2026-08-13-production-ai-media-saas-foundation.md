# Production AI Media SaaS Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The primary agent may delegate isolated file groups to subagents, but owns integration, tests, and final verification. Steps use checkbox (`- [ ]`) syntax for tracking; completing a task does not create a user approval gate.

**Goal:** Build the approved production-ready, reusable AI image/video subscription SaaS foundation on Supastarter.

**Architecture:** PostgreSQL is the business source of truth. oRPC creates quotes, reservations, jobs, upload sessions, and persisted webhook envelopes; Trigger.dev runs short, idempotent background steps that submit providers, finalize assets, settle credits, and reconcile stalled work. Provider, storage, moderation, billing, and observability behavior sit behind focused server-side interfaces, while the marketing generator and authenticated workspace consume a safe public product catalog.

**Tech Stack:** TypeScript 6, Node.js 22+, Next.js 16 App Router, React 19, oRPC, Zod 4, Prisma 7/PostgreSQL, Better Auth, TanStack Query, Trigger.dev, AWS SDK S3-compatible storage, Stripe, Sentry, Vitest, Playwright, GitHub Actions.

## Implementation ledger (updated 2026-08-14)

This is the current status summary; the detailed checkboxes below preserve the original execution plan and are not release evidence by themselves.

- **Tasks 1-5 - implemented:** configuration/catalog and Provider contracts; PostgreSQL media, credit and Outbox domain; private upload/streaming storage; Trigger.dev orchestration and recovery; Stripe subscription, billing-period, cancellation and refund lifecycle.
- **Task 6 - implemented and locally verified:** creator, history, job detail, asset library, and one-time marketing draft claim. Production-build Playwright covers nine authenticated SaaS workflows and two marketing handoff workflows, 11/11 passing with no skips against isolated PostgreSQL, MinIO, and deterministic test adapters.
- **Task 7 - implemented and locally verified:** structured redaction/log context, Sentry hooks, security headers and request limits, prompt moderation with immutable approval evidence, protected diagnostics/audit/replay/stage retry/model controls, uncertain-submission manual reconciliation, CI gates, Provider smoke budgets, load/invariant tools, and this runbook are present. A fresh isolated database applies all 16 migrations with zero drift and passes unit/contracts, database/jobs/API/auth integrations, and all nine invariants. Workspace type checks, webpack production builds, the high-severity production dependency audit, and the guarded local route smoke pass. k6 was not available on this workstation, so real k6 and target-duration load remain external staging acceptance activities.
- **External activation still required per deployment:** Trigger.dev cloud deploy/run, Stripe test/live Webhook delivery, real Replicate/Fal/Kie/Gemini routes, Sightengine, private S3/R2 multipart and streamed transfer, Sentry ingestion/alerts, and the five-minute peak/30-minute steady load profiles in a staging-equivalent environment. Local mocks, dry runs, contracts, builds, browser tests, and a short local load smoke must not be reported as those live checks.

## Global Constraints

- Use Supastarter as the main codebase; selectively port only reviewed request mapping, status mapping, result parsing, and upload UX from ShipAny.
- First release supports individual ownership only; every owned row still stores `ownerType`, `ownerId`, and `submittedByUserId` for later team support.
- First-release media providers are Replicate and Fal for images/video, Kie for images/video, and Gemini for images.
- Expose only 2–3 server-authenticated models per provider; clients never submit provider names, real model IDs, prices, provider parameters, or arbitrary remote URLs.
- PostgreSQL is the only business source of truth. Trigger.dev, browsers, Stripe, and AI providers are external execution/event sources.
- Creating a generation job, reserving credits, binding input assets, and writing an Outbox event is one PostgreSQL transaction.
- Every credit mutation is an immutable ledger entry with an idempotent `referenceKey`; credit lots are consumed by earliest expiry using PostgreSQL row locks.
- Every input and output is a `MediaAsset`; production objects are private, and video bytes never pass through Vercel or accumulate fully in process memory.
- Provider submissions exit Trigger.dev immediately; provider execution does not occupy a Trigger.dev execution slot.
- Stripe is the only first-release payment implementation certified by this plan. Annual subscriptions grant credits monthly.
- A job with no usable, moderation-approved output charges zero user credits, even if the provider charged the platform.
- Target 1,000 simultaneously active generating users, 200 jobs/minute for 30 minutes, a 400 jobs/minute five-minute burst, internal queue P95 below five seconds, and create-job API P95 below 800 ms when provider quotas allow.
- Do not add team billing, public sharing, arbitrary URL import, BYOK, an image editor, a video timeline, a community gallery, or one-time credit packs.
- Keep implementation work continuous. Internal test/commit boundaries below are not user review gates; request user input only for scope changes, missing external authority, or irreversible actions.

---

## File and Package Map

### New shared packages

- `packages/config/`: strong product/site configuration, plan entitlements, environment validation, public projection, and configuration fingerprint.
- `packages/jobs/`: testable job handlers under `src/handlers`, thin Trigger.dev bindings under `trigger`, queue definitions, reconciliation, and task payload schemas. It imports domain services from `@repo/database`, providers from `@repo/ai`, and storage from `@repo/storage`; UI and API code import task types only, not Trigger task implementations.

### Extended packages

- `packages/ai/media/catalog/`: stable product keys, catalog versions, schemas, pricing policies, and server-only routes.
- `packages/ai/media/providers/`: Replicate, Fal, Kie, Gemini adapters plus test fixtures.
- `packages/ai/media/moderation/`: `MediaSafetyAdapter`, Sightengine production adapter, and explicit test/development adapter.
- `packages/database/prisma/schema.prisma`: domain entities and database constraints.
- `packages/database/prisma/queries/media/`: quote, job, attempt, asset, credit, billing, webhook, outbox, and operations transactions.
- `packages/storage/`: signed upload/read, multipart lifecycle, metadata, streaming remote copy, deletion, and URL safety.
- `packages/payments/provider/stripe/`: verified event ingestion only; domain processing moves to persisted `PaymentEvent` handlers.
- `packages/api/modules/media/`: quote, generation, job history, assets, uploads, credits, and admin operations procedures.
- `packages/logs/`: structured contextual logging and Sentry-safe error reporting.

### Application surfaces

- `apps/saas/app/(authenticated)/(main)/(account)/create/`: full creator workspace.
- `apps/saas/app/(authenticated)/(main)/(account)/history/`: cursor-paginated jobs and job detail.
- `apps/saas/app/(authenticated)/(main)/(account)/assets/`: private asset library.
- `apps/saas/modules/media/`: shared forms, upload UI, result cards, job polling, filters, and draft claiming.
- `apps/marketing/modules/generator/`: lightweight generator and anonymous draft handoff.
- `apps/marketing/app/[locale]/(home)/page.tsx`: generator section insertion.
- `packages/i18n/translations/*/{saas,marketing}.json`: all user-visible copy.

### Operations

- `trigger.config.ts`: Trigger.dev project and task directories.
- `.github/workflows/validate-prs.yml`: PostgreSQL service, migration/integration tests, both production builds, and mock end-to-end tests.
- `.github/workflows/provider-smoke.yml`: budget-limited manual/scheduled real-provider smoke tests.
- `tests/load/`: mock-provider k6 workload and invariant verification.
- `docs/operations/ai-media-runbook.md`: deploy, rollback, incident, reconciliation, and key-rotation procedures.

---

### Task 1: Strong Configuration, Public Catalog, Provider and Moderation Contracts

**Files:**

- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/index.ts`
- Create: `packages/config/product.ts`
- Create: `packages/config/plans.ts`
- Create: `packages/config/env.ts`
- Create: `packages/config/public.ts`
- Create: `packages/config/fingerprint.ts`
- Create: `packages/config/config.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/ai/package.json`
- Modify: `packages/ai/index.ts`
- Create: `packages/ai/vitest.config.ts`
- Create: `packages/ai/media/index.ts`
- Create: `packages/ai/media/types.ts`
- Create: `packages/ai/media/errors.ts`
- Create: `packages/ai/media/registry.ts`
- Create: `packages/ai/media/catalog/schemas.ts`
- Create: `packages/ai/media/catalog/catalog.ts`
- Create: `packages/ai/media/catalog/public.ts`
- Create: `packages/ai/media/catalog/routing.ts`
- Create: `packages/ai/media/catalog/catalog.test.ts`
- Create: `packages/ai/media/providers/provider-adapter.ts`
- Create: `packages/ai/media/providers/http.ts`
- Create: `packages/ai/media/providers/replicate.ts`
- Create: `packages/ai/media/providers/fal.ts`
- Create: `packages/ai/media/providers/kie.ts`
- Create: `packages/ai/media/providers/gemini.ts`
- Create: `packages/ai/media/providers/index.ts`
- Create: `packages/ai/media/providers/providers.contract.test.ts`
- Create: `packages/ai/media/providers/fixtures/*.json`
- Create: `packages/ai/media/moderation/types.ts`
- Create: `packages/ai/media/moderation/sightengine.ts`
- Create: `packages/ai/media/moderation/test-adapter.ts`
- Create: `packages/ai/media/moderation/index.ts`
- Create: `packages/ai/media/moderation/moderation.contract.test.ts`
- Modify: `apps/saas/package.json`
- Modify: `apps/marketing/package.json`

**Interfaces:**

- Produces `ProductModelKey`, `CatalogVersion`, `PricingVersion`, `MediaProviderAdapter`, `MediaSafetyAdapter`, `getCatalogEntry(key)`, `quoteCatalogInput(input)`, `getPublicProductCatalog()`, `validateServerEnvironment()`, and `getConfigurationFingerprint()`.
- No consumer can obtain `provider`, `providerModelId`, `providerCostMicros`, routing weights, or secrets from the public catalog.

- [ ] **Step 1: Create the configuration package and write failing validation tests**

  Tests must assert that production validation fails when PostgreSQL, S3/R2, Trigger.dev, Stripe, Sentry, or Sightengine credentials required by enabled features are absent; test mode accepts explicit mock adapters. Also assert that plan IDs, product keys, pricing versions, feature flags, limits, and public URLs are schema-validated.

  ```text
  expect(() =>
    validateServerEnvironment({ NODE_ENV: "production", MEDIA_GENERATION_ENABLED: "true" }),
  ).toThrow(/DATABASE_URL/);
  expect(getPublicConfig()).not.toHaveProperty("stripeSecretKey");
  expect(getPublicConfig()).not.toHaveProperty("providerRoutes");
  ```

- [ ] **Step 2: Run the configuration test and confirm the missing-package failure**

  Run: `pnpm --filter @repo/config test`

  Expected: FAIL because `@repo/config` and its exports do not exist.

- [ ] **Step 3: Implement strong configuration and public projection**

  Define product features, upload limits, plan entitlements, URLs, enabled locales, retention rules, circuit-breaker thresholds, budgets, and Stripe price mappings as Zod-validated server configuration. Hash only non-secret normalized configuration into a stable SHA-256 fingerprint. Add `@repo/config` workspace dependencies to AI, API, payments, SaaS, and marketing packages as they begin consuming it.

- [ ] **Step 4: Define the normalized provider contract and catalog**

  ```text
  interface MediaProviderAdapter {
    readonly provider: ProviderKey;
    submit(input: ProviderSubmitInput): Promise<ProviderSubmission>;
    retrieve(input: ProviderRetrieveInput): Promise<ProviderTaskSnapshot>;
    cancel?(input: ProviderCancelInput): Promise<ProviderCancelResult>;
    verifyWebhook?(request: Request): Promise<VerifiedProviderEvent>;
    normalizeResult(snapshot: ProviderTaskSnapshot): Promise<NormalizedResult>;
  }
  ```

  `ProviderSubmission` must carry `providerTaskId`, initial normalized status, provider idempotency metadata, and whether acceptance is certain. `NormalizedResult` must carry outputs, progress, `providerCostMicros`, normalized failure, retryability, and provider-charged status. Model inputs are discriminated Zod schemas for text-to-image, image-to-image, text-to-video, and image-to-video.

- [ ] **Step 5: Port only reviewed ShipAny provider mechanics**

  Port endpoint/auth/header construction, provider parameter mapping, status mapping, output extraction, webhook parsing, and error extraction into the four adapters. Replace ShipAny global config access and loose `any` payloads with injected credentials, `fetch` timeouts, Zod-decoded provider responses, redacted errors, and stable catalog routes. Do not port UI-selected providers, arbitrary model IDs, fixed credits, database writes, or polling logic. Replicate gains cancel and verified Webhooks; Fal stores explicit status/result endpoints; Kie uses retrieve-only reconciliation until a documented signature protocol is implemented. Gemini is synchronous, uses the Attempt ID as its stable provider task ID, and returns inline output without storing raw base64 in PostgreSQL.

- [ ] **Step 6: Add provider contract fixtures and verify all adapters**

  Each provider fixture must cover accepted, queued/running, succeeded with multiple outputs, failed retryable, failed terminal, canceled, malformed response, and unknown submission. Assert that `ProviderOutput` is either `{ kind: "remote-url" }` or `{ kind: "inline-base64" }`, and both variants remain untrusted transfer candidates for the storage pipeline.

  Run: `pnpm --filter @repo/ai test`

  Expected: PASS without live network calls.

- [ ] **Step 7: Implement moderation contracts and Sightengine adapter**

  ```text
  interface MediaSafetyAdapter {
    moderateText(input: ModerateTextInput): Promise<ModerationDecision>;
    moderateImage(input: ModerateAssetInput): Promise<ModerationDecision>;
    submitVideo(input: ModerateAssetInput): Promise<ModerationSubmission>;
    retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision>;
  }
  ```

  Decisions are `ALLOW`, `REJECT`, `REVIEW`, or `ERROR`; they include a non-sensitive reason code and rule version. Production selection must reject the test adapter. Use mock HTTP fixtures for contract tests.

- [ ] **Step 8: Run package checks and commit the foundation contracts**

  Run: `pnpm --filter @repo/config test && pnpm --filter @repo/ai test && pnpm --filter @repo/config type-check && pnpm --filter @repo/ai type-check`

  Commit: `feat: add media product catalog and provider contracts`

---

### Task 2: Prisma Domain, Transactional Jobs, Credit Ledger, Outbox and Operations State

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260813000000_ai_media_foundation/migration.sql`
- Modify: `packages/database/prisma/index.ts`
- Modify: `packages/database/prisma/queries/index.ts`
- Create: `packages/database/prisma/queries/media/types.ts`
- Create: `packages/database/prisma/queries/media/quotes.ts`
- Create: `packages/database/prisma/queries/media/jobs.ts`
- Create: `packages/database/prisma/queries/media/attempts.ts`
- Create: `packages/database/prisma/queries/media/assets.ts`
- Create: `packages/database/prisma/queries/media/credits.ts`
- Create: `packages/database/prisma/queries/media/credit-allocations.ts`
- Create: `packages/database/prisma/queries/media/outbox.ts`
- Create: `packages/database/prisma/queries/media/webhooks.ts`
- Create: `packages/database/prisma/queries/media/operations.ts`
- Create: `packages/database/prisma/queries/media/billing.ts`
- Create: `packages/database/prisma/queries/media/index.ts`
- Create: `packages/database/prisma/queries/media/state-machine.ts`
- Create: `packages/database/prisma/queries/media/state-machine.test.ts`
- Create: `packages/database/prisma/queries/media/media.integration.test.ts`
- Create: `packages/database/vitest.integration.config.ts`
- Modify: `packages/database/package.json`

**Interfaces:**

- Consumes catalog/pricing snapshots from Task 1.
- Produces `createGenerationJobTransaction`, `transitionGenerationJob`, `createGenerationAttempt`, `reserveCredits`, `settleCredits`, `releaseCredits`, `ingestProviderEvent`, `claimOutboxBatch`, `upsertRateLimitBucket`, and billing event/period functions.

- [ ] **Step 1: Write state-machine and PostgreSQL concurrency tests first**

  State-machine tests enumerate every allowed edge and assert all other edges fail. Integration tests run two concurrent reservations against one account and assert committed reservations never exceed available lots.

  ```text
  expect(canTransition("RESERVED", "DISPATCH_QUEUED")).toBe(true);
  expect(canTransition("SUCCEEDED", "PROVIDER_RUNNING")).toBe(false);
  expect(successfulReservations.reduce((sum, item) => sum + item.amount, 0)).toBeLessThanOrEqual(
    100,
  );
  ```

- [ ] **Step 2: Run tests against a disposable PostgreSQL database and verify failure**

  Run: `pnpm --filter @repo/database test:integration`

  Expected: FAIL because the media schema and transaction functions do not exist.

- [ ] **Step 3: Add Prisma models and database-enforced invariants**

  Add enums and models for `GenerationQuote`, `GenerationJob`, `GenerationAttempt`, `MediaAsset`, `MediaUploadSession`, `GenerationJobAsset`, `AssetModerationResult`, `StorageUsageReservation`, `CreditAccount`, `CreditLot`, `CreditReservation`, `CreditReservationAllocation`, `CreditLedgerEntry`, `ProviderWebhookEvent`, `OutboxEvent`, `BillingPlan`, `Subscription`, `BillingPeriod`, `PaymentEvent`, `RuntimeConfigOverride`, `AuditLog`, `RateLimitBucket`, and `GenerationDraft`. Keep the existing `Purchase` model and connect `Subscription.purchaseId @unique` as a compatibility bridge for existing Supastarter billing UI and non-certified providers.

  Required unique constraints include quote ID, job idempotency per owner, provider task per provider, reservation per job, reservation allocation per lot, ledger `referenceKey`, provider event ID, payment event ID, non-null normalized transaction ID, subscription-period start, storage object key, upload token hash, and runtime config version. Add partial/compound indexes for non-terminal jobs, unprocessed webhook/outbox rows, user cursor pagination, asset library cursor pagination, expiring lots, and stale upload sessions.

- [ ] **Step 4: Generate and inspect the migration**

  Run: `pnpm --filter @repo/database generate`

  Generate a named migration using the repository's Prisma workflow against an isolated `TEST_DATABASE_URL`. Because the repository currently has no committed migrations, baseline an existing deployment before `migrate deploy`; never apply a full initial migration blindly to an existing database. Inspect SQL to ensure monetary/cost micros and credit values use `BigInt`, timestamps use timezone-aware PostgreSQL storage, JSON snapshots are non-null where required, check constraints prevent negative reserved/remaining amounts, and a database trigger rejects UPDATE/DELETE on ledger rows.

- [ ] **Step 5: Implement the task creation transaction**

  ```text
  async function createGenerationJobTransaction(
    input: CreateGenerationJobInput,
  ): Promise<CreateGenerationJobResult>;
  ```

  In one serializable/retryable transaction: lock the credit account and FIFO lots, validate quote/catalog/pricing expiry, reserve credits, create the Job, bind READY input assets owned by the user, and insert `JOB_CREATED` Outbox. A duplicate owner/idempotency key returns the original Job and reservation.

- [ ] **Step 6: Implement conditional state changes, Attempt uniqueness, webhook ingestion and Outbox claiming**

  `transitionGenerationJob` accepts expected states and version, returns `applied: false` for stale events, and never rewrites terminal states. `ingestProviderEvent` persists the verified envelope and its processing Outbox atomically. `claimOutboxBatch` uses PostgreSQL `FOR UPDATE SKIP LOCKED`, leases rows, and supports release/dead-letter after bounded attempts.

- [ ] **Step 7: Implement immutable ledger behavior**

  Reserve from earliest-expiring lots and persist exact `CreditReservationAllocation` rows, settle against those allocations, return unused reserved units, and release all units for no valid output. All functions lock in the order Account → Lots ordered by expiry/createdAt/id → Reservation/Allocations. Refunds append reverse entries and consume unused matching grants first; shortage increments `creditDebt`. New grants repay debt before increasing spendable balance. Add an invariant query comparing account aggregates, lots, reservations, allocations, and ledger entries.

- [ ] **Step 8: Implement assets, rate limits, runtime overrides, audits and billing persistence helpers**

  Asset helpers enforce `ownerType = USER` for first-release API writes. Rate limiting uses atomic PostgreSQL fixed-window buckets keyed by action plus user/IP hash. Runtime overrides are versioned, audited, reversible, and apply only to future jobs. Billing helpers persist raw event envelopes without mixing payment status updates with credit grants.

- [ ] **Step 9: Run database tests and commit**

  Run: `pnpm --filter @repo/database generate && pnpm --filter @repo/database type-check && pnpm --filter @repo/database test && pnpm --filter @repo/database test:integration`

  Expected: state, concurrency, duplicate-event, duplicate-settlement, FIFO, refund-debt, Outbox recovery, and cursor pagination tests PASS.

  Commit: `feat: add transactional media jobs and credit ledger`

---

### Task 3: Private Asset Upload, Multipart Video, Streaming Provider Transfer and Access Control

**Files:**

- Modify: `packages/storage/types.ts`
- Modify: `packages/storage/package.json`
- Modify: `packages/storage/config.ts`
- Modify: `packages/storage/index.ts`
- Modify: `packages/storage/provider/index.ts`
- Replace/extend: `packages/storage/provider/s3/index.ts`
- Create: `packages/storage/lib/object-key.ts`
- Create: `packages/storage/lib/media-signatures.ts`
- Create: `packages/storage/lib/remote-url-policy.ts`
- Create: `packages/storage/lib/stream-copy.ts`
- Create: `packages/storage/lib/metadata.ts`
- Create: `packages/storage/storage.test.ts`
- Create: `packages/api/modules/media/procedures/create-upload-session.ts`
- Create: `packages/api/modules/media/procedures/complete-upload-session.ts`
- Create: `packages/api/modules/media/procedures/create-multipart-part-url.ts`
- Create: `packages/api/modules/media/procedures/abort-upload-session.ts`
- Create: `packages/api/modules/media/procedures/get-asset-access-url.ts`
- Create: `packages/api/modules/media/procedures/delete-asset.ts`
- Create: `packages/api/modules/media/lib/asset-authorization.ts`
- Create: `packages/api/modules/media/lib/upload-validation.ts`
- Create: `packages/api/modules/media/lib/upload-validation.test.ts`
- Create: `apps/saas/modules/media/components/MediaUploader.tsx`
- Create: `apps/saas/modules/media/hooks/use-media-upload.ts`
- Create: `apps/saas/modules/media/lib/upload-state.ts`
- Create: `apps/saas/modules/media/lib/upload-state.test.ts`
- Remove after consumers migrate: `apps/saas/app/image-proxy/[...path]/route.ts`

**Interfaces:**

- Produces `createSignedUpload`, `createMultipartUpload`, `signMultipartPart`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `streamRemoteObjectToStorage`, `createSignedReadUrl`, `deleteObject`, `inspectMediaHeader`, and `assertAllowedRemoteUrl`.
- API upload completion creates no READY asset until HEAD, signature, metadata, and moderation stages pass.

- [ ] **Step 1: Write storage policy and streaming tests**

  Test allowed formats, JPEG/PNG/WebP/MP4/WebM/MOV magic bytes, 25 MB image limit, 500 MB video limit, object-key isolation, SSRF protection, redirect revalidation, private/reserved IP rejection, DNS rebinding rejection, byte caps, and abort-on-stream-failure behavior.

  ```typescript
  await expect(assertAllowedRemoteUrl("http://127.0.0.1/private")).rejects.toThrow(/private/i);
  expect(detectMediaType(mp4Fixture)).toBe("video/mp4");
  expect(createAssetObjectKey(owner, assetId, "video/mp4")).toMatch(/^users\//);
  ```

- [ ] **Step 2: Run storage tests and verify current avatar-only API fails them**

  Run: `pnpm --filter @repo/storage test`

  Expected: FAIL because multipart, streaming, detection, and URL-policy functions are absent.

- [ ] **Step 3: Replace avatar-specific storage types with a private object adapter**

  Keep avatar compatibility while adding content-type-bound signed PUT, multipart lifecycle, HEAD, streaming GET/PUT, DeleteObject, and signed GET with `ResponseContentDisposition`. Object keys are server-generated and contain owner scope, asset ID, derivative kind, and a normalized extension; clients cannot choose bucket or key.

- [ ] **Step 4: Implement safe streaming transfer**

  Follow at most the configured redirect count. Before every request, resolve and reject loopback, private, link-local, multicast, and metadata-service IP ranges. Enforce HTTPS, Adapter-declared host allowlists, connect/first-byte/total timeouts, maximum bytes, and content signature. Pipe chunks into multipart upload while hashing; abort multipart on any failure. Never call `arrayBuffer()` for provider video output.

- [ ] **Step 5: Implement upload-session API and state transitions**

  `createUploadSession` reserves storage bytes and returns either one signed image PUT or a multipart ID. `completeUploadSession` HEAD-checks size and content type, moves the asset to VERIFYING, and writes an Outbox event for metadata/moderation. Duplicate completion is idempotent. Abort/delete releases reservations and records an audit event.

- [ ] **Step 6: Adapt ShipAny upload UX without its server-buffered route**

  Preserve drag/drop, paste, multiple image previews, replace, remove, retry, local blob cleanup, and progress states. Add multipart video progress, pause/resume after refresh using upload-session state, accessible errors, and asset IDs as values. Never return a public storage URL from the uploader.

- [ ] **Step 7: Implement authenticated asset access and delete**

  Require resource ownership and READY state before creating a short-lived read URL. Range playback goes directly to S3/R2. Delete immediately marks `DELETED`, revokes future URL issuance, and writes an object-deletion Outbox with a 24-hour deadline. Remove the broad image proxy once avatars and media use scoped URL issuance.

- [ ] **Step 8: Run storage/API/UI unit checks and commit**

  Run: `pnpm --filter @repo/storage test && pnpm --filter @repo/storage type-check && pnpm --filter @repo/api test && pnpm --filter saas test && pnpm --filter saas type-check`

  Commit: `feat: add private media asset pipeline`

---

### Task 4: Trigger.dev Execution, Media oRPC, Webhooks, Reconciliation and Recovery

**Files:**

- Create: `packages/jobs/package.json`
- Create: `packages/jobs/tsconfig.json`
- Create: `packages/jobs/vitest.config.ts`
- Create: `packages/jobs/index.ts`
- Create: `packages/jobs/src/contracts.ts`
- Create: `packages/jobs/src/queues.ts`
- Create: `packages/jobs/src/handlers/dispatch-generation.ts`
- Create: `packages/jobs/src/handlers/process-provider-event.ts`
- Create: `packages/jobs/src/handlers/finalize-media.ts`
- Create: `packages/jobs/src/handlers/settle-generation.ts`
- Create: `packages/jobs/src/handlers/verify-upload.ts`
- Create: `packages/jobs/src/handlers/reconcile-generations.ts`
- Create: `packages/jobs/src/handlers/dispatch-outbox.ts`
- Create: `packages/jobs/src/handlers/cleanup-assets.ts`
- Create: `packages/jobs/src/handlers/check-credit-invariants.ts`
- Create: `packages/jobs/src/handlers/jobs.integration.test.ts`
- Create: `packages/jobs/trigger/dispatch-generation.ts`
- Create: `packages/jobs/trigger/process-provider-webhook.ts`
- Create: `packages/jobs/trigger/finalize-generation.ts`
- Create: `packages/jobs/trigger/settle-generation.ts`
- Create: `packages/jobs/trigger/reconcile-generations.ts`
- Create: `packages/jobs/trigger/deliver-outbox.ts`
- Create: `trigger.config.ts`
- Modify: `packages/api/index.ts`
- Modify: `packages/api/orpc/router.ts`
- Modify: `packages/api/package.json`
- Create: `packages/api/modules/media/webhooks/provider-webhook.ts`
- Create: `packages/api/modules/media/webhooks/provider-webhook.test.ts`
- Create: `packages/api/modules/media/router.ts`
- Create: `packages/api/modules/media/types.ts`
- Create: `packages/api/modules/media/procedures/get-public-catalog.ts`
- Create: `packages/api/modules/media/procedures/create-quote.ts`
- Create: `packages/api/modules/media/procedures/create-generation.ts`
- Create: `packages/api/modules/media/procedures/cancel-generation.ts`
- Create: `packages/api/modules/media/procedures/retry-generation.ts`
- Create: `packages/api/modules/media/procedures/get-job.ts`
- Create: `packages/api/modules/media/procedures/list-jobs.ts`
- Create: `packages/api/modules/media/procedures/list-assets.ts`
- Create: `packages/api/modules/media/procedures/get-credit-account.ts`
- Create: `packages/api/modules/media/procedures/admin-operations.ts`
- Create: `packages/api/modules/media/lib/quote.ts`
- Create: `packages/api/modules/media/lib/rate-limit.ts`
- Create: `packages/api/modules/media/lib/errors.ts`
- Create: `packages/api/modules/media/media.integration.test.ts`

**Interfaces:**

- Consumes all domain and adapter interfaces from Tasks 1–3.
- Produces the browser-facing media router and inbound routes `/api/webhooks/ai/:provider`, `/api/webhooks/moderation/:provider`, `/api/health`, and `/api/ready`.

- [ ] **Step 1: Write an end-to-end domain integration test with mock external services**

  The test must register a credit account, create a READY input asset, quote, submit twice with the same idempotency key, dispatch once, ingest duplicate Provider Webhooks, stream a mock output, approve moderation, settle once, and read one succeeded Job plus one output asset.

  ```typescript
  expect(first.job.id).toBe(duplicate.job.id);
  expect(mockProvider.submit).toHaveBeenCalledTimes(1);
  expect(await ledgerCount({ referenceKey: `settle:${first.job.id}` })).toBe(1);
  expect((await getJob(first.job.id)).status).toBe("SUCCEEDED");
  ```

- [ ] **Step 2: Run the integration test and verify failure**

  Run: `pnpm --filter @repo/jobs test:integration && pnpm --filter @repo/api test`

  Expected: FAIL because the jobs package and media router do not exist.

- [ ] **Step 3: Configure Trigger.dev and queues**

  Pin matching Trigger.dev SDK/build/CLI versions in the workspace catalog. Configure `trigger.config.ts` with `dirs: ["./packages/jobs/trigger"]` and Prisma 7's `prismaExtension({ mode: "modern" })`; generation of the Prisma Client remains an explicit build step and Trigger never migrates production. Create separate queues for image submission, video submission, media finalization/moderation, and settlement/recovery. Add per-Provider/per-model queue keys and conservative concurrency limits sourced from runtime configuration. Payloads contain only internal IDs and versions, never full prompts, provider secrets, or signed URLs.

- [ ] **Step 4: Implement dispatch as a short task**

  Claim a `JOB_CREATED` Outbox, conditionally transition to SUBMITTING, create/claim an Attempt, call the Adapter with a deterministic idempotency key, persist the provider task and normalized status, then exit. If acceptance is uncertain, mark the Attempt for reconciliation without failover. If clearly rejected, apply only the catalog-approved retry route.

- [ ] **Step 5: Implement verified webhook ingestion and processing**

  Register the raw `POST /webhooks/ai/:provider` Hono route before the oRPC catch-all. It locates the Adapter, verifies signature/timestamp before parsing, persists ProviderWebhookEvent and Outbox in one transaction, and returns quickly; a Trigger delivery failure cannot discard the persisted event. Processing locks the Attempt, ignores stale events, records true progress, and enters FINALIZING only once. Never call Provider APIs from browser polling.

- [ ] **Step 6: Implement finalization, moderation and settlement stages**

  Stream each provider candidate to private storage, extract metadata, create output assets, moderate them, and count only READY outputs. Settlement applies the catalog pricing policy, records provider cost separately, releases unused reservation, and conditionally changes FINALIZING to SUCCEEDED or FAILED. A retry of any stage observes existing object/asset/ledger references instead of duplicating work.

- [ ] **Step 7: Implement scheduled recovery and cleanup**

  Reconcile only stale non-terminal jobs, with polling frequency reduced by age. Recover Outbox leases, query Provider state, resolve uncertain submission, retry failed transfer/moderation/settlement stages, expire abandoned drafts/uploads, physically delete due objects, and run credit invariants. Persist every repair action and page administrators for repeated repair loops.

- [ ] **Step 8: Implement oRPC Procedures and public/user error mapping**

  Quote and create procedures perform Zod validation, auth, ownership, entitlement, rate-limit, budget, runtime-kill-switch, asset state, and price-version checks. Job/asset list APIs use opaque cursors. User errors expose stable codes such as `INSUFFICIENT_CREDITS`, `ASSET_NOT_READY`, `MODEL_DISABLED`, `RATE_LIMITED`, and `PROVIDER_UNAVAILABLE`, without provider raw messages.

- [ ] **Step 9: Implement health/readiness behavior**

  `/health` returns process liveness only. `/ready` performs non-mutating checks for validated configuration, PostgreSQL, storage metadata access, and Trigger.dev configuration; it never generates, bills, uploads, or sends email. Detailed failure reasons require admin authentication.

- [ ] **Step 10: Run jobs/API integration checks and commit**

  Run: `pnpm --filter @repo/jobs test && pnpm --filter @repo/jobs test:integration && pnpm --filter @repo/jobs type-check && pnpm --filter @repo/api test && pnpm --filter @repo/api type-check`

  Commit: `feat: orchestrate reliable media generation jobs`

---

### Task 5: Stripe Subscription Events, Monthly Credit Periods, Cancellation and Refund Debt

**Files:**

- Modify: `packages/payments/types.ts`
- Modify: `packages/payments/package.json`
- Modify: `packages/payments/config.ts`
- Modify: `packages/payments/index.ts`
- Modify: `packages/payments/lib/helper.ts`
- Modify: `packages/payments/provider/stripe/index.ts`
- Create: `packages/payments/provider/stripe/webhook.ts`
- Create: `packages/payments/provider/stripe/events.ts`
- Create: `packages/payments/provider/stripe/webhook.test.ts`
- Create: `packages/payments/provider/stripe/events.test.ts`
- Create: `packages/jobs/src/handlers/process-payment-event.ts`
- Create: `packages/jobs/src/handlers/grant-billing-periods.ts`
- Create: `packages/jobs/src/handlers/reconcile-subscriptions.ts`
- Create: `packages/jobs/trigger/process-payment-event.ts`
- Create: `packages/jobs/trigger/grant-billing-periods.ts`
- Create: `packages/jobs/trigger/reconcile-subscriptions.ts`
- Modify: `packages/api/modules/payments/procedures/create-checkout-link.ts`
- Modify: `packages/api/modules/payments/procedures/create-customer-portal-link.ts`
- Modify: `packages/api/modules/payments/router.ts`
- Modify: `packages/api/index.ts`
- Create: `packages/api/modules/payments/payments.integration.test.ts`
- Modify: `apps/saas/modules/payments/hooks/plan-data.tsx`
- Modify: `apps/saas/modules/payments/components/PricingTable.tsx`
- Modify: `apps/marketing/modules/home/components/PricingSection.tsx`
- Modify: `apps/saas/modules/payments/components/CheckoutReturnContent.tsx`

**Interfaces:**

- Stripe Webhook produces a verified `PaymentEvent`; jobs consume it and call database billing/ledger functions from Task 2.
- Checkout Return remains read-only and queries `Subscription`/`BillingPeriod` state.

- [ ] **Step 1: Write Stripe event and billing-period integration tests**

  Cover duplicate event IDs, duplicate transaction IDs, monthly invoice grants, annual purchase followed by 12 monthly internal grants, end-of-month anchors, cancel-at-period-end, next-cycle plan changes, partial/full refunds, already-spent refunds creating debt, and out-of-order events.

  ```typescript
  expect(await processTwice(invoicePaidEvent)).toMatchObject({ grantsCreated: 1 });
  expect(await countBillingPeriods(annualSubscriptionId)).toBe(12);
  expect((await getCreditAccount(userId)).creditDebt).toBe(refundedSpentCredits);
  ```

- [ ] **Step 2: Run payment tests and verify current Purchase-only flow fails**

  Run: `pnpm --filter @repo/payments test && pnpm --filter @repo/api test -- payments.integration`

  Expected: FAIL because PaymentEvent, BillingPeriod, and debt-aware refund processing are absent.

- [ ] **Step 3: Refactor Stripe Webhook into verify-and-persist**

  Preserve signature verification using the raw request body. Convert Stripe objects to a minimal normalized envelope, persist full raw JSON in the protected PaymentEvent field together with Outbox, enqueue processing, and return 2xx for already-persisted event IDs. Remove direct credit granting and Purchase mutation from the request path. Preserve `/api/webhooks/payments` and the existing Purchase read shape for compatibility.

- [ ] **Step 4: Process subscription lifecycle into internal state**

  Handle checkout completion, subscription created/updated/deleted, invoice paid/failed, and charge/refund events. Only `invoice.paid` creates a paid BillingPeriod/grant; subscription lifecycle events synchronize state without granting. Map server-only Stripe Price IDs to versioned BillingPlan records, while Checkout metadata carries `billing_plan_id`, `plan_key`, `owner_type`, `owner_id`, and `submitted_by_user_id` so historical processing does not depend on mutable environment mappings. Keep Purchase rows as snapshots; cancellation updates a terminal state rather than deleting them. Update subscription helpers to treat only active/trialing and the configured past-due grace state as entitled. Reject events that cannot be bound to exactly one user subscription, log a protected diagnostic, and leave them replayable.

- [ ] **Step 5: Implement monthly and annual entitlement grants**

  Monthly invoices create one BillingPeriod and one grant reference. Annual invoices create 12 scheduled UTC periods using subscription anchor-day/last-valid-day semantics; the recurring task grants only due, active paid periods. Cancellation keeps already-paid periods through the paid-through date. Plan changes are scheduled for the next Stripe cycle.

- [ ] **Step 6: Implement refund reversal and debt**

  Append reversal ledger rows; reclaim unspent credits from matching lots first and set `creditDebt` for the remainder. Block media creation while debt is positive. Future grants atomically repay debt before increasing spendable credits.

- [ ] **Step 7: Make pricing and return pages consume internal plan/subscription state**

  Remove the lifetime plan from the certified media configuration. Display monthly/yearly price, included monthly credits, concurrency, storage, and product tiers from `@repo/config`. Checkout Return polls internal status only and never grants credits.

- [ ] **Step 8: Run payment/database/UI checks and commit**

  Run: `pnpm --filter @repo/payments test && pnpm --filter @repo/database test:integration && pnpm --filter @repo/api test && pnpm --filter saas test && pnpm --filter marketing test`

  Commit: `feat: close Stripe subscription and credit lifecycle`

---

### Task 6: Authenticated Creator, Job History, Asset Library and Marketing Draft Handoff

**Files:**

- Create: `apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- Create: `apps/saas/app/(authenticated)/(main)/(account)/history/page.tsx`
- Create: `apps/saas/app/(authenticated)/(main)/(account)/history/[jobId]/page.tsx`
- Create: `apps/saas/app/(authenticated)/(main)/(account)/assets/page.tsx`
- Create: `apps/saas/modules/media/components/CreatorWorkspace.tsx`
- Create: `apps/saas/modules/media/components/GenerationForm.tsx`
- Create: `apps/saas/modules/media/components/GenerationFields.tsx`
- Create: `apps/saas/modules/media/components/CurrentGeneration.tsx`
- Create: `apps/saas/modules/media/components/RecentJobQueue.tsx`
- Create: `apps/saas/modules/media/components/JobHistory.tsx`
- Create: `apps/saas/modules/media/components/JobDetail.tsx`
- Create: `apps/saas/modules/media/components/AssetLibrary.tsx`
- Create: `apps/saas/modules/media/components/AssetCard.tsx`
- Create: `apps/saas/modules/media/hooks/use-generation.ts`
- Create: `apps/saas/modules/media/hooks/use-job.ts`
- Create: `apps/saas/modules/media/hooks/use-job-history.ts`
- Create: `apps/saas/modules/media/hooks/use-assets.ts`
- Create: `apps/saas/modules/media/lib/form-schema.ts`
- Create: `apps/saas/modules/media/lib/job-status.ts`
- Create: `apps/saas/modules/media/lib/job-status.test.ts`
- Modify: `apps/saas/modules/shared/components/NavBar.tsx`
- Modify: `packages/i18n/translations/en/saas.json`
- Modify: `packages/i18n/translations/de/saas.json`
- Modify: `packages/i18n/translations/es/saas.json`
- Modify: `packages/i18n/translations/fr/saas.json`
- Create: `apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- Create: `apps/marketing/modules/generator/lib/draft-client.ts`
- Create: `packages/api/modules/media/procedures/create-generation-draft.ts`
- Create: `packages/api/modules/media/procedures/claim-generation-draft.ts`
- Modify: `apps/marketing/app/[locale]/(home)/page.tsx`
- Modify: `packages/i18n/translations/en/marketing.json`
- Modify: `packages/i18n/translations/de/marketing.json`
- Modify: `packages/i18n/translations/es/marketing.json`
- Modify: `packages/i18n/translations/fr/marketing.json`
- Create: `apps/saas/tests/media-generation.spec.ts`
- Create: `apps/saas/tests/auth.setup.ts`
- Modify: `apps/saas/playwright.config.ts`
- Create: `apps/marketing/tests/generator.spec.ts`
- Modify: `apps/saas/app/(authenticated)/(main)/(account)/page.tsx`
- Modify: `packages/auth/config.ts`

**Interfaces:**

- Consumes only safe oRPC catalog/quote/job/asset APIs.
- UI submits stable product keys, public parameters, asset IDs, quote ID, and an idempotency key.

- [ ] **Step 1: Write UI mapping tests and Playwright mock scenarios**

  Unit tests assert the ten internal Job states map to eight user stages and that percentages appear only for real progress. Playwright uses authenticated storage state plus test-only Provider/moderation/Trigger drivers and the real oRPC/database path; browser request interception is not a substitute for the server workflow. Cover duplicate click, insufficient credits, upload rejection, Provider failure, output moderation rejection, refresh recovery, cancellation, and reuse-as-input.

- [ ] **Step 2: Run SaaS/marketing tests and verify routes are missing**

  Run: `pnpm --filter saas test && pnpm --filter marketing test`

  Expected: FAIL because creator/history/assets/generator routes and modules do not exist.

- [ ] **Step 3: Build the finite schema-driven form system**

  Implement only text, select, slider, aspect ratio, count, image asset, and video asset fields. The public catalog controls visibility and ranges; the server remains authoritative. Provider names and model IDs never render in HTML, React props, query keys, or analytics.

- [ ] **Step 4: Build the creator workspace and resilient submission UX**

  Desktop uses controls left and status/results right; mobile is a single column. Quote before submit, display expected/reserved credits, create one idempotency key per user action, disable only the current submit, and let users start another form while recent jobs continue. Adaptive polling stops at terminal state and slows in background tabs.

- [ ] **Step 5: Build history, detail and asset library**

  Use cursor pagination and URL filters. Show stage, thumbnails/posters, product tier, timestamps, output count, reserved/charged/released credits, user-safe failure, and “use same settings.” Assets support signed download, reuse as image/video input, source-job navigation, and soft delete.

- [ ] **Step 6: Implement secure anonymous marketing draft handoff**

  Marketing uses an absolute `fetch` to `NEXT_PUBLIC_SAAS_URL`; it does not import the SaaS oRPC client. The tightly rate-limited public draft endpoint accepts only the configured marketing origin. Text/parameters and optional temporary upload are stored under a random one-time claim token hash, expire within one hour, and are not generation-ready. After Better Auth sign-in, SaaS atomically claims the draft, transfers asset ownership to the user, queues validation/moderation, and invalidates the token. Unclaimed assets are cleaned by Task 4. Redirects are server-generated relative paths; never put Prompt text, file bytes, a raw asset key, or an arbitrary return URL in the redirect.

- [ ] **Step 7: Insert marketing generator and navigation/i18n**

  Add Create, History, and Assets navigation, reserve those slugs against organization route collisions, and redirect the authenticated account index to `/create`. Put the lightweight generator between hero and feature proof on the homepage. Add complete strings to all four existing locale bundles; do not silently fall back to English for new keys.

- [ ] **Step 8: Run application checks and commit**

  Run: `pnpm --filter saas test && pnpm --filter marketing test && pnpm --filter saas type-check && pnpm --filter marketing type-check && pnpm --filter saas e2e:ci && pnpm --filter marketing e2e:ci`

  Commit: `feat: add AI media creator and asset workspace`

---

### Task 7: Structured Observability, Security Gates, CI, Load Verification and Operations Runbook

**Files:**

- Modify: `packages/logs/package.json`
- Modify: `packages/logs/lib/logger.ts`
- Create: `packages/logs/lib/context.ts`
- Create: `packages/logs/lib/redaction.ts`
- Create: `packages/logs/lib/redaction.test.ts`
- Modify: `packages/api/index.ts`
- Modify: `apps/saas/next.config.ts`
- Modify: `apps/marketing/next.config.ts`
- Create: `apps/saas/instrumentation.ts`
- Create: `apps/marketing/instrumentation.ts`
- Create: `apps/saas/sentry.server.config.ts`
- Create: `apps/saas/sentry.edge.config.ts`
- Create: `apps/marketing/sentry.server.config.ts`
- Create: `apps/marketing/sentry.edge.config.ts`
- Create: `packages/jobs/observability.ts`
- Create: `packages/api/modules/media/procedures/admin-diagnostics.ts`
- Create: `packages/api/modules/media/procedures/admin-audit-log.ts`
- Create: `apps/saas/app/(authenticated)/(main)/(account)/admin/media/page.tsx`
- Create: `apps/saas/modules/admin/component/media/MediaOperations.tsx`
- Modify: `apps/saas/modules/admin/lib/links.ts`
- Modify: `apps/saas/app/(authenticated)/(main)/(account)/admin/layout.tsx`
- Modify: `apps/marketing/playwright.config.ts`
- Modify: `.github/workflows/validate-prs.yml`
- Create: `.github/workflows/provider-smoke.yml`
- Create: `tests/load/media-generation.js`
- Create: `tests/load/verify-invariants.ts`
- Create: `tests/load/README.md`
- Create: `docs/operations/ai-media-runbook.md`
- Modify: `README.md`
- Modify: `.env.local.example`

**Interfaces:**

- Produces `withLogContext`, `redactForLog`, business metric emitters, Sentry release correlation, protected diagnostics, CI release gates, and the operator runbook.

- [ ] **Step 1: Write redaction, authorization and readiness tests**

  Assert Prompt, Authorization, cookies, API keys, Stripe signatures, signed URLs, provider raw payload secrets, and media URLs are removed. Assert non-admin diagnostics fail, `/ready` has no side effects, and CORS accepts only configured SaaS/marketing origins.

  ```typescript
  expect(JSON.stringify(redactForLog(secretFixture))).not.toContain("sk_test_");
  expect(JSON.stringify(redactForLog(secretFixture))).not.toContain("X-Amz-Signature");
  await expect(callAdminDiagnostics(asNormalUser)).rejects.toMatchObject({ code: "FORBIDDEN" });
  ```

- [ ] **Step 2: Run tests and verify missing production controls**

  Run: `pnpm --filter @repo/logs test && pnpm --filter @repo/api test`

  Expected: FAIL because contextual logging, redaction, and diagnostics are absent.

- [ ] **Step 3: Implement contextual structured logs and Sentry**

  Propagate `requestId`, `traceId`, `generationJobId`, `attemptId`, `provider`, `productModelKey`, `pricingVersion`, and `deploymentVersion`. Hash or use internal user IDs according to context. Capture exceptions with configuration/release fingerprints and scrub sensitive fields before they reach Console or Sentry.

- [ ] **Step 4: Add security headers and request protections**

  Configure CSP, frame ancestors, nosniff, referrer policy, permissions policy, HSTS in production, strict CORS, body-size limits, raw-body-only Webhooks, origin checks, and existing Better Auth CSRF/session protections. Keep storage and Provider credentials server-only and document least-privilege IAM policies.

- [ ] **Step 5: Implement operational metrics, alerts and admin diagnostics**

  Emit quote/upload/create latency, queues, oldest age, Provider outcomes/cost, Webhook duplicates/signature failures, transfer speed/failures, storage bytes, ledger operations/invariants, revenue/margin, stalled jobs, Outbox backlog, and reconciliation repairs. Configure Sentry alerts for immediate conditions from the spec; route warning thresholds separately. Admin UI can replay safe persisted events, retry a stage, disable a model, roll back runtime config, and inspect audits without exposing prompts/secrets/raw signed URLs.

- [ ] **Step 6: Extend CI with production gates**

  Add a PostgreSQL service using an isolated `TEST_DATABASE_URL`, apply migrations to an empty database, run schema drift checks, unit/integration/contract tests, Trigger.dev type/build checks, both Next.js production builds, Playwright mock E2E, dependency audit, and secret scan. Upload SaaS and marketing Playwright reports as separate artifacts. Fix the marketing Playwright server command to be cross-platform instead of using POSIX inline environment syntax. Real provider tests remain excluded from PR CI.

- [ ] **Step 7: Add budget-limited real-provider smoke workflow**

  Make the workflow manual by default with an optional schedule, protected environment secrets, model allowlist, maximum invocation count, maximum expected cost, and automatic cleanup. It validates one certified route per enabled tier and aborts before calling a provider when budget configuration is absent.

- [ ] **Step 8: Implement and run load/invariant verification**

  Mock Provider modes must cover fast success, long-running, duplicate Webhook, dropped Webhook, uncertain submission, slow transfer, moderation rejection, and Provider failure. Install or containerize k6 in CI and add a `tsx` command for `verify-invariants.ts`. Run 200 jobs/minute for 30 minutes and 400 jobs/minute for five minutes against staging-equivalent services. After load, assert one job per idempotency key, one settlement per job, balanced credit invariants, no missing Outbox, internal queue P95 below five seconds, and create API P95 below 800 ms.

- [ ] **Step 9: Write the operator runbook and environment documentation**

  Document local setup, required external accounts, environment validation, migrations, Trigger deployment, S3/R2 CORS/IAM, Stripe Webhooks, Sightengine, Sentry, model certification, smoke/load commands, runtime kill switches, replay/reconciliation, refund debt, object cleanup, backup/restore, rollback, secret rotation, and incident triage.

- [ ] **Step 10: Run final repository verification and commit**

  Run: `pnpm lint && pnpm format:check && pnpm type-check && pnpm test && pnpm build`

  Then run the PostgreSQL integration suite, mock E2E suite, Trigger.dev build check, and load invariant verifier using the documented commands. Record real-provider smoke tests as blocked until external secrets are configured; do not report them as passed from mocks.

  Commit: `feat: productionize AI media SaaS foundation`

---

## Continuous Execution and Completion Rules

1. Execute Tasks 1–7 in dependency order; independent file investigations or non-overlapping implementation may be delegated in parallel.
2. Do not pause for user approval after individual tasks. Repair failing tests and integration issues in the same execution stream.
3. Do not mark a task complete from type-checking alone; run the task's specified behavioral tests.
4. Do not claim live Provider, Stripe, Trigger.dev, S3/R2, Sentry, or Sightengine verification without the corresponding external credentials and recorded results.
5. Preserve unrelated user changes. Stage only files belonging to this foundation.
6. Final completion requires a clean working tree, committed implementation, passing available local/CI-equivalent checks, and an explicit list of any external verification still blocked by credentials or accounts.
