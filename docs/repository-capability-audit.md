# EzPic repository capability audit

Date: 2026-08-23
Audit branch: `codex/ezpic-pr1`
Audited commit: `8938c213cae8c078bf05433b9acdc89aa96fa0be`
Audit worktree: `D:\\AIProject\\Gefei\\SaaSTool\\ez-image-ai\\.worktrees\\ezpic-pr1`
Baseline Git state: the audited commit matched `main` and `origin/main`; only this audit and the
product specification were untracked before PR-F0, with no application or staged changes.
Product specification: `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`
Specification SHA-256: `4677B0FC33D7DD8773C206DEA1CEA4389354D0CCD8BD0A1BBBAF2B138C670B24`

## Decision

**Gate result: BLOCKED. Do not implement the PR 1 brand, homepage, legal, SEO, or product-surface changes yet.**

The repository contains substantial AI media foundation code, but several core invariants in the
EzPic specification are absent or materially inconsistent with the implementation. The blocking
groups are:

1. positive refund Debt does not block later generation, and a refunded active reservation can
   later settle successfully without creating Debt;
2. catalog routing can select a Provider that the validated production configuration did not
   register, and a malformed HTTP 2xx Provider response is treated as a definite rejection rather
   than an uncertain submission;
3. a single-part signed upload targets the final object key and can be replayed before expiry to
   replace an already approved object;
4. a failed Stripe payment worker run is marked `FAILED` and returned as a successful Trigger.dev
   task invocation, so automatic task retry does not recover it; scheduled subscription
   reconciliation does not query Stripe;
5. moderation recovery is bounded only by Trigger retries for input assets, and a failed generation
   retry reuses prior approval evidence instead of running the current moderation step.

Any one of these differences triggers the stop rule in the product specification. This audit does
not silently repair the financial, Provider, storage, moderation, or payment architecture.

## Audit method and evidence boundary

- Read the repository `AGENTS.md`, `README.md`, foundation design, operator
  runbook, CI workflow, load-test documentation, and root scripts.
- Inspected the current implementation at the audited commit and ran focused, non-paid tests and
  read-only probes where possible.
- Did not call a paid AI Provider or mutate Stripe, Trigger Cloud, Sightengine, S3/R2, or Sentry.
- Did not run PostgreSQL integration tests or Playwright because this machine has no configured
  `TEST_DATABASE_URL` and the Docker daemon is unavailable.
- Local mocks, fixtures, MinIO-oriented code, dry-run smoke output, and static inspection are not
  external production certification.

Status meanings:

- **Confirmed**: the core path is present and evidence supports the stated behavior.
- **Confirmed with gaps**: substantial capability exists, but one or more important recovery,
  security, or operational properties remain incomplete.
- **Blocking gap**: a specification gate or repository invariant is materially violated.
- **Configuration / PR 1 work**: an expected productization change, not a missing foundation.

## Blocking finding baseline

| Finding | Subsystem                                                            | Entry point and exact evidence                                                                                                                                                                                                                                                                                                                                 | Broken invariant and reproducible path                                                                                                                                                                                                                                                                                                                              | Why existing tests missed it                                                                                                                                                                                           | Repair owner                                         |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| FND-001 | Credits, refunds, Debt, expiry                                       | `authorizeGeneration` in `packages/api/modules/media/lib/generation-authorization.ts:44-93,114-128`; `reserveCredits`, `settleCredits`, and refund/grant paths in `packages/database/prisma/queries/media/credits.ts:40-58,148-224,269-445,490-708`; balance API in `packages/api/modules/media/procedures/get-credit-account.ts:9-16`                         | A positive Debt is not checked in the serializable task write transaction; a refunded active allocation can settle through `revokedSettledAmount` without increasing Debt; expired lots can remain in the public spendable projection. Static reproduction follows authorize → reserve and refund → settle.                                                         | The invariant verifier checks aggregate conservation, but not Debt authorization, refund-then-settle, or expiry projection semantics; PostgreSQL concurrency cases were not run in this audit.                         | PR-F1, with Stripe finalization integration in PR-F6 |
| FND-002 | Provider catalog, configuration, registry, submission classification | `validateServerEnvironment` in `packages/config/env.ts:81-97,145-170`; registry construction and route lookup in `packages/jobs/src/runtime.ts:55-72,91-107`; routes in `packages/ai/media/catalog/catalog.ts:19-40`; dispatch in `packages/jobs/src/handlers/dispatch-generation.ts:14-49`; HTTP normalization in `packages/ai/media/providers/http.ts:38-65` | Catalog selection can choose an adapter that validated production configuration did not register. A malformed HTTP 2xx becomes `REJECTED`, although the Provider may have accepted or billed it, permitting unsafe release/failover. The audit probe selected unregistered Fal while Replicate was configured and classified a malformed Replicate 200 as rejected. | Provider fixtures exercised adapters independently and did not validate one executable route graph across config/catalog/registry/worker; malformed-shape fixtures did not assert end-to-end uncertain dispatch state. | PR-F2                                                |
| FND-003 | Private upload and asset integrity                                   | `createSignedUpload` in `packages/storage/provider/s3/index.ts:65-74`; upload expiry in `packages/storage/config.ts:9`; completion in `packages/api/modules/media/procedures/complete-upload-session.ts:75-94`; verification worker in `packages/jobs/src/runtime.ts:446-479,1201-1241`                                                                        | The client receives a replayable PUT for the final object key. After completion and moderation, the same URL can replace those bytes before expiry while database checksum/evidence stays attached to the earlier object.                                                                                                                                           | Storage unit tests cover policy and multipart behavior, not a real MinIO attack sequence that overwrites the single-part key after approval; MinIO integration was not run.                                            | PR-F3                                                |
| FND-004 | Stripe event worker recovery                                         | `processStripePaymentEvent` failure path in `packages/payments/provider/stripe/processor.ts:92-100`; Trigger wrapper in `packages/jobs/trigger/process-payment-event.ts:5-10`; persisted event/Outbox in `packages/database/prisma/queries/media/billing.ts:14-57`                                                                                             | A transient processing failure is persisted as `FAILED` and returned normally, so Trigger treats the invocation as successful and does not use its configured attempts. The original delivery Outbox is already complete.                                                                                                                                           | Payment fixtures asserted the returned failure outcome but did not assert Trigger task rejection/retry behavior or exhausted-attempt visibility.                                                                       | PR-F5                                                |
| FND-005 | Stripe reconciliation and refund finality                            | local-only scheduled handler in `packages/jobs/src/handlers/reconcile-subscriptions-core.ts:8-29`; refund event dispatch in `packages/payments/provider/stripe/processor.ts:103-121`                                                                                                                                                                           | Scheduled reconciliation never queries Stripe. Pending `refund.created`/`charge.refund.updated` can perform irreversible credit reversal, while `refund.updated` and failed/canceled final states are not handled, so replay dedupe can strand the wrong result.                                                                                                    | The reconciliation test proves only local expiry/period closing; Stripe tests use event fixtures without external-state reconciliation or the pending → final refund state machine.                                    | PR-F6                                                |
| FND-006 | Input moderation recovery                                            | upload verification Trigger task in `packages/jobs/trigger/verify-upload.ts:6-11`; asset moderation transitions in `packages/jobs/src/runtime.ts:446-479,1201-1241`                                                                                                                                                                                            | A moderation service error throws through eight Trigger attempts; after exhaustion the asset can remain `VERIFYING` without a durable scanner, expired-lease recovery, or audited requeue action.                                                                                                                                                                   | Moderation contracts cover decisions and fail-closed behavior, but not exhaustion after the Trigger wrapper or durable recovery of a stale asset.                                                                      | PR-F4 after PR-F3                                    |
| FND-007 | Generation retry moderation evidence                                 | retry entry point in `packages/api/modules/media/procedures/retry-generation.ts:45-62`; evidence reuse in `packages/api/modules/media/lib/retry-moderation.ts:14-34`                                                                                                                                                                                           | A user-created retry can reuse an earlier `ALLOW` when the rule version matches instead of creating a new attempt under the current Provider/policy/content fingerprint, contrary to the current-review contract.                                                                                                                                                   | Existing tests validate matching evidence reuse as an optimization; they do not distinguish internal idempotent replay from a new user business retry or bind evidence to immutable asset-version bytes.               | PR-F4 after PR-F3                                    |

Each repair PR must retain these original references in its design note and add its own RED/GREEN
test evidence. Until PR-F7 revalidates one integration revision, every finding above remains open.

## Capability matrix

| Capability                                            | Status              | Summary                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL as business source of truth                | Confirmed           | Jobs, assets, credits, events, subscriptions, runtime controls, and audits are persisted in PostgreSQL.                                                                            |
| Immutable credit ledger and atomic reservation        | **Blocking gap**    | Ledger immutability and transactional reservation exist, but Debt enforcement and refund-to-settlement accounting do not meet the contract.                                        |
| Trigger.dev, Outbox, Webhook, polling, reconciliation | Confirmed with gaps | The generation path has durable Outbox and uncertain-submission recovery; upload moderation and payment-event recovery remain incomplete.                                          |
| Provider abstraction and server-side routing          | **Blocking gap**    | Stable public keys and adapters exist, but production configuration, registry, and selectable routes can diverge; malformed accepted responses are misclassified.                  |
| Private upload, Provider transfer, signed access      | **Blocking gap**    | Private storage and streaming transfer exist, but replayable single-part uploads can replace approved content at the final key.                                                    |
| Prompt, input, and output moderation                  | Confirmed with gaps | Fail-closed gates and quarantine exist, but exhausted input-review recovery and retry re-moderation are missing.                                                                   |
| Stripe signature, idempotency, subscription periods   | **Blocking gap**    | Raw signature verification and persisted idempotency exist; automatic worker recovery, real Stripe reconciliation, refund lifecycle, and some ownership boundaries are incomplete. |
| Task history, diagnostics, runtime shutdown           | Confirmed with gaps | History, admin APIs, audits, and environment kill switch exist; database runtime shutdown does not stop already queued dispatches and the admin UI is incomplete.                  |
| Anonymous draft and login recovery                    | Confirmed with risk | One-time, origin-bound claim exists and does not create a generation job; the public upload buffers base64 and has inconsistent effective limits.                                  |

## 1. PostgreSQL truth source and transactional generation core

### Confirmed

- The foundation and runbook explicitly designate PostgreSQL as the business source of truth:
  `README.md` and `docs/operations/ai-media-runbook.md`.
- Generation creation uses a serializable transaction. It validates a moderated quote and owned
  `READY` inputs, creates the job, reserves credits, binds inputs, and writes `JOB_CREATED` Outbox in
  one transaction: `packages/database/prisma/queries/media/jobs.ts:59-178`.
- Outbox claiming uses `FOR UPDATE SKIP LOCKED`, lease tokens, compare-and-set completion, bounded
  retries, and dead-lettering:
  `packages/database/prisma/queries/media/outbox.ts:17-107`.
- Browser polling reads PostgreSQL-backed job state; it does not own Provider recovery or financial
  settlement.

### Risk

Passing local workflow tests would prove application orchestration only. This checkout has no live
evidence for PostgreSQL backup/restore, Trigger Cloud delivery, Provider Webhooks, or production
reconciliation.

## 2. Credits, reservations, immutable ledger, refunds, and Debt

### Confirmed

- Account, Lot, Reservation, Allocation, and Ledger models are present:
  `packages/database/prisma/schema.prisma:521-618`.
- Database constraints protect non-negative projections, and the foundation migration rejects
  `UPDATE` or `DELETE` of ledger rows:
  `packages/database/prisma/migrations/20260813000000_ai_media_foundation/migration.sql:930-948,983-992`.
- Reservation locks the account and earliest-expiring lots; settlement/release updates allocations
  and appends an immutable reference-keyed ledger command:
  `packages/database/prisma/queries/media/credits.ts:40-58,148-224,269-445`.
- New grants repay existing Debt before increasing spendable balance, and refunds append reversal
  entries rather than rewriting history:
  `packages/database/prisma/queries/media/credits.ts:490-708`.

### Blocking gaps

1. **Debt does not block generation.** Authorization loads only `spendableCredits`, and both the API
   gate and reservation compare only that projection:
   `packages/api/modules/media/lib/generation-authorization.ts:44-93,114-128` and
   `packages/database/prisma/queries/media/credits.ts:175-177`. A user can have positive Debt and
   still spend credits from another lot. This contradicts the foundation design and EzPic refund
   matrix.
2. **Refund followed by successful settlement can avoid Debt.** A refund against an active
   allocation increments `revokedAmount`; later settlement records `revokedSettledAmount` but does
   not increment account Debt:
   `packages/database/prisma/queries/media/credits.ts:344-408,628-657`. The user can receive a paid
   result after the corresponding external payment was refunded without creating an amount for
   future grants to repay.
3. **Expired lots and the public balance projection diverge.** Spend selection excludes expired lots,
   but `CreditAccount.spendableCredits` and the balance API are not reduced by an expiry command.
   Authorization can show/approve an amount that reservation later cannot allocate:
   `packages/database/prisma/queries/media/credits.ts:40-58`,
   `packages/api/modules/media/procedures/get-credit-account.ts:9-16`.

The current invariant verifier does not detect these semantic cases; it checks aggregate conservation
rather than Debt authorization, refund-then-settle, or expiry projection behavior.

## 3. Trigger.dev, Outbox, task recovery, and runtime controls

### Confirmed

- `trigger.config.ts` registers the jobs task directory and Prisma build extension.
- Separate Trigger tasks exist for dispatch, Provider events, finalization, settlement, generation
  reconciliation, upload verification, storage cleanup, payment processing, billing grants,
  subscription reconciliation, and Outbox delivery.
- The generation path persists verified Provider events with a processing Outbox, handles stale and
  duplicate events, and polls stale attempts:
  `packages/database/prisma/queries/media/webhooks.ts:16-41` and
  `packages/jobs/src/handlers/reconcile-generations.ts:3-47`.
- A transport-uncertain submission becomes `SUBMISSION_UNCERTAIN`; its Reservation stays active,
  cancellation is blocked, repeated recovery ends in `NEEDS_RECONCILIATION`, and an audited admin
  decision can accept or reject the same attempt:
  `packages/jobs/src/handlers/dispatch-generation.ts:34-49`,
  `packages/jobs/src/runtime.ts:1089-1141`, and
  `packages/database/prisma/queries/media/admin-operations.ts:342-493`.
- The environment generation kill switch is checked before Provider dispatch:
  `packages/jobs/src/handlers/dispatch-generation.ts:9-16`.

### Gaps and risks

- The database runtime override is checked by API authorization, while dispatch checks only the
  environment switch. A job already in Outbox can still contact a Provider after an administrator
  disables the database-level global switch.
- The admin backend supports uncertain-submission resolution, but the current UI lacks the matching
  decision form and a complete task timeline.
- No Trigger Cloud deployment, Cron consumption, lost-Webhook recovery, or kill-switch drill was
  performed during this audit.

## 4. Provider abstraction and server-only routing

### Confirmed

- Clients submit stable product keys and validated media input. The public projection omits Provider,
  model ID, cost, and route weight:
  `packages/ai/media/catalog/public.ts:22-41` and
  `packages/ai/media/catalog/catalog.test.ts:36-69`.
- Replicate, Fal, Kie, and Gemini implement the shared adapter contract. Fixture tests cover request,
  status, result, and error normalization without paid calls.
- Explicit transport uncertainty enters reconciliation and does not automatically fail over.

### Blocking gaps

1. **Validated configuration and executable routes can disagree.** Production validation requires
   credentials for the selected `MEDIA_PROVIDER_ADAPTER`, but the worker registry ignores that
   selector and registers whichever keys happen to exist. Route selection still uses the full
   catalog, for example `image-fast` includes Replicate and Fal:
   `packages/config/env.ts:81-97,145-170`,
   `packages/jobs/src/runtime.ts:55-72,91-107`, and
   `packages/ai/media/catalog/catalog.ts:19-40`. A read-only probe produced:

   ```json
   { "validatedProvider": "replicate", "chosenProvider": "fal", "registered": false }
   ```

   The missing adapter is requested before the dispatch `try` block, while route tasks use one
   attempt, so the job can remain in a state that normal reconciliation does not repair:
   `packages/jobs/src/handlers/dispatch-generation.ts:14-17` and
   `packages/jobs/trigger/dispatch-generation.ts:34-92`.

2. **Malformed HTTP 2xx is treated as definite rejection.** Adapter response-shape failures use
   `MALFORMED_PROVIDER_RESPONSE`, but dispatch records every non-`HTTP_ERROR`
   `MediaProviderError` as rejected:
   `packages/ai/media/providers/http.ts:38-65` and
   `packages/jobs/src/handlers/dispatch-generation.ts:39-49`. A request may already have been
   accepted or billed; the safe state is uncertain reconciliation, not release/failure. A fixture
   probe produced `REJECTED` with `uncertain: 0` for a malformed Replicate HTTP 200.

### Additional risks

- Quote budgeting uses the first route cost while weighted selection or failover can choose a more
  expensive route: `packages/api/modules/media/lib/quote.ts:7-20`.
- No enabled route has been certified against a real Provider account, quota, current model ID,
  output contract, measured cost, or cancellation behavior.

## 5. Private media storage and access

### Confirmed

- Media uses the separate `MEDIA_BUCKET_NAME` configuration, defaults to `media-private`, and accepts
  only server-generated `users/` object keys:
  `packages/storage/config.ts:3-10` and
  `packages/storage/provider/s3/index.ts:52-63`.
- Upload sessions reserve capacity, select single-part or multipart upload, and validate length,
  MIME, and leading file signature at completion.
- Provider output is streamed into private storage with incremental hashing, size bounds, multipart
  abort, HTTPS/host/DNS/IP policy, and redirect revalidation:
  `packages/storage/provider/s3/index.ts:245-283` and
  `packages/storage/lib/stream-copy.ts:23-88,157-179`.
- Only an owned, non-deleted `READY` asset can receive a five-minute signed read URL:
  `packages/api/modules/media/procedures/get-asset-access-url.ts:21-33`.
- Rejected or review-required media is quarantined; soft deletion enqueues durable object cleanup.

### Blocking gap: approved single-part content can be replaced

`createSignedUpload` signs a PUT to the final asset key for 600 seconds without a checksum,
write-once condition, object version binding, or staging-to-immutable copy:
`packages/storage/config.ts:9` and `packages/storage/provider/s3/index.ts:65-74`.
A read-only signing probe showed only `content-length;host` in the signed headers. Completion and the
worker inspect the object at that moment, then set the database asset to `READY`:
`packages/api/modules/media/procedures/complete-upload-session.ts:75-94` and
`packages/jobs/src/runtime.ts:446-479,1201-1241`.

Before the original PUT URL expires, a client can PUT a different file of the same length and a
compatible leading signature to the same key. Later signed reads and Provider inputs use the
replacement even though only the earlier bytes were moderated. This breaks the link between stored
checksum, moderation evidence, and delivered content. Multipart completion does invalidate its
upload ID; the demonstrated gap is the single-part path used by images.

### Additional risks

- Direct upload checksum falls back to ETag or `pending-sha256` rather than a trusted SHA-256:
  `packages/api/modules/media/procedures/complete-upload-session.ts:85-90`.
- Current validation does not prove dimensions, pixel count, decode validity, decompression-bomb
  resistance, duration, or EXIF/GPS removal promised by the foundation design.
- Production bucket policy, IAM, CORS, anonymous access, lifecycle cleanup, and signed URL behavior
  were not tested against real S3/R2.

## 6. Prompt, input, and output moderation

### Confirmed

- Prompt moderation occurs before quote persistence. Non-`ALLOW` outcomes do not create a quote,
  job, Reservation, or Provider request.
- An uploaded input remains `VERIFYING`; only `ALLOW` changes it to `READY`. `REJECT` and `REVIEW`
  become `QUARANTINED`:
  `packages/jobs/src/runtime.ts:446-479,1201-1241`.
- Provider output is transferred into private storage before moderation, and unapproved output is not
  exposed through the signed-access procedure.
- Production environment validation rejects the test safety adapter; user errors and structured logs
  use stable, redacted fields.

### Gaps

- Input moderation error throws and relies on eight Trigger attempts:
  `packages/jobs/trigger/verify-upload.ts:6-11`. After exhaustion, the asset can remain `VERIFYING`;
  no PostgreSQL scanner, durable requeue, or operator action specifically recovers that asset.
- Failed-generation retry uses previous `ALLOW` evidence when the moderation rule version matches,
  instead of calling the current moderation adapter again:
  `packages/api/modules/media/procedures/retry-generation.ts:45-62` and
  `packages/api/modules/media/lib/retry-moderation.ts:14-34`.
- No current Prompt analytics emission was found, but the generic analytics interface lacks a strict
  field allowlist contract proving future events cannot include Prompt or private media data.

## 7. Stripe Webhook, subscription periods, refunds, and ownership

### Confirmed

- The Stripe endpoint verifies the signature against the raw body before normalizing or persisting:
  `packages/payments/provider/stripe/webhook.ts:27-58`.
- `PaymentEvent` and its Outbox are persisted atomically with unique Provider event and normalized
  transaction constraints:
  `packages/database/prisma/queries/media/billing.ts:14-57` and
  `packages/database/prisma/schema.prisma:737-754`.
- Subscription lifecycle events synchronize state but do not grant credits. `invoice.paid` creates
  monthly grants; annual plans create internal monthly periods:
  `packages/payments/provider/stripe/processor.ts:103-217,506-545`.
- The Checkout return path is read-only and does not grant entitlements:
  `packages/api/modules/payments/procedures/get-checkout-return-state.ts:15-31`.
- Organization checkout writes are owner-only at the API boundary:
  `packages/api/modules/payments/procedures/create-checkout-link.ts:120-139`.

### Blocking gaps

1. **Payment task failures are not automatically retried.** The processor catches a processing
   exception, marks the event `FAILED`, and returns `{ outcome: "FAILED" }` normally:
   `packages/payments/provider/stripe/processor.ts:92-100`. Trigger therefore considers the run
   successful despite its configured five attempts:
   `packages/jobs/trigger/process-payment-event.ts:5-10`. The original delivery Outbox has already
   completed; recovery requires an audited manual replay. Out-of-order `invoice.paid` before the
   subscription exists can therefore strand a credit grant.
2. **Scheduled subscription reconciliation does not query Stripe.** It only expires local
   subscriptions and closes local billing periods:
   `packages/jobs/src/handlers/reconcile-subscriptions-core.ts:8-29`. This does not implement the
   runbook instruction to reconcile Stripe subscription facts on schedule.
3. **Refund lifecycle is incomplete.** The processor handles `refund.created` and
   `charge.refund.updated` without checking a final refund status, and does not handle
   `refund.updated` or `refund.failed`:
   `packages/payments/provider/stripe/processor.ts:118-121`. A pending refund can revoke credits,
   while a later failed/final state can be ignored by normalized refund-ID dedupe.
4. Debt produced by a refund does not block generation; see section 2.

### Ownership gaps

- `Purchase.organizationId` and `Purchase.userId` are both nullable and have no exactly-one-owner
  constraint. The Portal procedure checks each only when present, so a row with neither owner can
  reach Stripe Portal creation:
  `packages/database/prisma/schema.prisma:193-204` and
  `packages/api/modules/payments/procedures/create-customer-portal-link.ts:32-58`.
- Organization billing UI is visible to admin-level members while write APIs require owner. The API
  still rejects unauthorized changes, but visibility and tests do not match the owner-only contract.
- Organization Checkout return includes `organizationId`, while the return API rejects every
  organization scope. Current billing is configured for users, so this is dormant rather than the
  active individual path.

## 8. Task history, diagnostics, and operational shutdown

### Confirmed

- User-scoped job history and job detail survive refresh and expose only owned data:
  `packages/api/modules/media/procedures/list-jobs.ts:6-58` and
  `packages/api/modules/media/procedures/get-job.ts:7-37`.
- Admin diagnostics aggregate queue age, stalled jobs, uncertain submissions, Outbox/dead letters,
  Provider outcomes/cost, storage, credits, and event failures:
  `packages/database/prisma/queries/media/admin-diagnostics.ts:8-166`.
- Protected admin APIs support persisted event replay, safe stage retry, runtime overrides, and
  uncertain-submission decisions with operator, reason, idempotency, and audit records.

### Gaps

- The admin UI does not expose all backend recovery operations or a complete per-job event timeline.
- The database global runtime override does not stop already queued worker dispatch; an immediate
  emergency stop still depends on the environment flag and deployment/worker control.
- No production alert ingestion, Outbox dead-letter drill, or recovery drill was performed.

## 9. Anonymous draft handoff and current PR 1 product surface

### Anonymous draft confirmed

- The public endpoint checks the configured Marketing Origin, applies rate limiting, generates a
  high-entropy one-time token, stores only its SHA-256 hash, and expires drafts after one hour:
  `packages/api/modules/media/procedures/create-generation-draft.ts:23-108` and
  `packages/api/modules/media/lib/draft-security.ts:19-48`.
- Login claim is atomic, transfers any temporary asset once, invalidates the token, and queues asset
  verification. Draft creation/claim does not create `GenerationJob`, reserve credits, or contact a
  Provider.

### Draft risk

The browser sends the entire upload as base64 JSON. The API body is capped around 10 MiB, while the
schema accepts a 35-million-character string and the anonymous-byte default is 25 MiB. The body is
buffered and parsed before the procedure-level Origin/rate-limit checks. This creates inconsistent
user limits and avoidable concurrent memory pressure:
`packages/api/index.ts:180-220` and
`packages/api/modules/media/procedures/create-generation-draft.ts:18-20,32-55`.

### Configuration / PR 1 work found but intentionally not implemented

- Brand remains Supastarter/demo/`acme` in product configuration and shared Logo.
- Homepage remains a generic Hero plus image/video generator; image input is optional, the public
  product keys are generic, and there is no EzPic Before/After placeholder, required Prompt chips, or
  Standard/Quality editor presentation.
- Video, text-to-image, AI Chatbot, and generic model surfaces remain visible.
- Exact EzPic title, H1, description, self-canonical, production-aware indexing, WebSite,
  Organization, and SoftwareApplication data are absent.
- `/pricing`, `/privacy`, `/terms`, and `/content-policy` canonical routes are absent; existing legal
  content, blog posts, changelog, contact, and newsletter include demo or placeholder behavior.
- Current sitemap emits locale and demo-content URLs rather than an EzPic marketing whitelist.
- SaaS authenticated layout is `noindex`, but its robots file still allows `/`.

These are normal PR 1 productization changes, but the stop gate prevents beginning their TDD cycle
until the foundation differences above receive a human decision.

## Focused verification performed during the audit

| Command / scope                                    | Result                              | Evidence boundary                                                                                                     |
| -------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit:contracts`                         | 51 files, 349 tests passed          | Full repository unit/contract aggregate; no live services.                                                            |
| `pnpm lint --deny-warnings`                        | Passed                              | Full repository read-only lint gate.                                                                                  |
| `pnpm type-check`                                  | Passed                              | CI-style local placeholder environment used; 21/21 Turbo tasks succeeded.                                             |
| Scoped Oxfmt check for the audit document          | Passed                              | The audit document conforms; the specification remains an exact source copy.                                          |
| `pnpm format:check`                                | **Failed on baseline + exact copy** | Reported 782 files: 781 existing baseline files plus the exact specification copy. No full-tree rewrite was retained. |
| `pnpm --filter @repo/ai test`                      | 4 files, 49 tests passed            | Provider fixtures only; no live Provider.                                                                             |
| `pnpm --filter @repo/config test`                  | 2 files, 21 tests passed            | Static/environment contract.                                                                                          |
| Focused API Provider/authorization tests           | 3 files, 19 tests passed            | Local placeholder import-time env; no external calls.                                                                 |
| Focused Jobs dispatch/security/output-policy tests | 3 files, 4 tests passed             | In-process fakes.                                                                                                     |
| `pnpm provider:smoke`                              | Budget gate passed; dry run only    | No Provider invocation and no model cost.                                                                             |
| `pnpm --filter @repo/storage test`                 | 1 file, 28 tests passed             | Storage unit policy; no real S3/R2.                                                                                   |
| Focused storage API/Jobs/logs/SaaS/database tests  | 14 files, 39 tests passed           | Unit/transaction fakes; no production bucket.                                                                         |
| Focused moderation unit/contract tests             | 62 tests passed                     | No Sightengine call.                                                                                                  |
| `pnpm --filter @repo/payments test`                | 4 files, 15 tests passed            | Stripe fixtures only.                                                                                                 |
| Focused API payment tests                          | 5 files, 18 tests passed            | Local placeholder import-time env.                                                                                    |
| Focused auth organization-deletion tests           | 1 file, 7 tests passed              | Local unit scope.                                                                                                     |
| Focused subscription-reconciliation test           | 1 file, 1 test passed               | Confirms local-only behavior, not Stripe reconciliation.                                                              |

Some direct package test runs emitted `Cannot find base config file
"@repo/tsconfig/base.json"` warnings but completed successfully. Two additional payment test files
could not load before Prisma client generation; zero tests from those files executed.

Not run or not available:

- `pnpm test:integration`, `pnpm load:smoke`, and `pnpm verify:invariants`: no explicit isolated
  `TEST_DATABASE_URL`; `docker info` confirmed that the Docker Desktop Linux daemon pipe does not
  exist on this machine.
- Marketing/SaaS Playwright: no product UI was changed after the gate failed, and the required
  database/browser environment was unavailable.
- Live Trigger.dev, Stripe delivery, Replicate/Fal/Kie/Gemini, Sightengine, S3/R2, Sentry, and staging
  load tests: no authorized external credentials or environment; PR 1 must not incur model cost.

## Required human decisions before PR 1 can resume

1. **Foundation remediation scope:** authorize a separate, reviewed remediation before product-shell
   work, or explicitly revise the stop gate. The recommended decision is to remediate first.
2. **Credit/refund contract:** confirm that any positive Debt blocks new generation, decide how a
   refunded active reservation that later succeeds creates Debt, and define credit-lot expiry
   projection behavior.
3. **Provider enablement contract:** decide whether production enables one Provider or an explicit
   route set. Validation, registry, catalog projection, dispatch, and readiness must share that set;
   malformed 2xx must retain Reservation and enter uncertain reconciliation.
4. **Private upload immutability:** choose a write-once/checksum-bound design, version-pinned reads, or
   staging key followed by server-side immutable promotion before any public upload is exposed.
5. **Stripe recovery semantics:** decide automatic replay/backoff for failed PaymentEvents, real
   Stripe subscription reconciliation, final-status refund handling, and fail-closed Purchase owner
   constraints.
6. **Moderation recovery:** define durable recovery/manual operations for exhausted input moderation
   and require current moderation on generation retry.

After those changes, rerun an isolated PostgreSQL migration/integration/invariant suite, mock media
E2E, and the focused regression tests before restarting EzPic PR 1.

Product/legal decisions will also be needed once the foundation gate passes:

- production marketing/SaaS origins and support email supplied through configuration/environment;
- legal operator identity, jurisdiction, retention, acceptable-use, and refund policy;
- which real Free/Creator/Studio offers may appear in Pricing and SoftwareApplication data;
- English-only launch versus complete maintained translations;
- authorized, traceable Before/After demonstration assets.

## Scope, rollback, and exclusions

Files intentionally added in this stopped PR 1 attempt:

- `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md` — byte-for-byte copy of the supplied
  product specification, verified by matching SHA-256;
- `docs/repository-capability-audit.md` — this audit and stop decision.

No application, package, database, migration, environment example, generated file, or lockfile was
changed. Rollback is deletion of the two documentation files. PR 2 through PR 7 were not started.
