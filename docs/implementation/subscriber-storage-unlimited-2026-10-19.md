# Subscriber aggregate storage — implementation and verification

Base: `35e41b04b6bbbb1ba8c33ab7fad5cfc8977dbfaa`.
Worktree: `/workspace/ez-image-ai-subscriber-storage`.
Branch: `codex/subscriber-storage-unlimited`.

## Scope and authoritative policy

Effective paid subscriptions remove only the aggregate owner byte quota. `effectiveMediaStorageLimit` delegates to the existing `findEffectivePaidSubscription` with the owner and the same transaction client. Its result is explicitly `null` for unlimited, or the existing finite free-account deployment cap (2 GiB by default). No artificial large numeric limit is used. Client plan claims are not accepted.

Free owners retain the exact configured cap. Upload count, single-file sizes and media types, owner checks, credits, prices, moderation, and retention logic remain as before. Every upload, temporary reference and output still creates or updates its existing storage reservation. No cleanup, reservation release or retention deadline is removed.

The API quote/create preflight supports the same nullable policy so it cannot reject a valid subscriber before the authoritative transaction. Every final storage admission resolves the subscription again within its write transaction; preflight does not grant durable capacity. Native video resolves storage eligibility after its account lock using the database admission timestamp.

## Accepted output contract

The parent approved preserving admitted subscriber output after subscription expiry. Successful image and video job admission writes `aggregateStoragePolicy: {schemaVersion: 1, maximumBytes: null | decimalString}` on the job's own `pricingSnapshot`. It does not modify the reviewed quote, quote fingerprint, or existing financial fields.

Legacy image finalization reads that server-owned policy through the asset's owner-scoped OUTPUT job binding. Video recovery reads it through the owner-scoped authoritative job. A current effective paid subscription also removes a finite quota recorded by a formerly free job; the frozen unlimited promise survives later expiry. A finite recorded quota is an audit value, not a promise to bypass the current free-account output cap. Missing historical policy falls back to the current effective subscription. Invalid policies fail closed. Existing native video/scene reservations continue their original guarantee across quota/plan changes.

The only consumer comparing a whole job pricing snapshot is retry reconciliation: it now excludes exactly this server-owned extension from the job-side comparison. Quote fingerprints and complete quote pricing comparisons remain exact; all original financial/routing keys still participate. Other consumers read particular pricing fields and accept the extra job key.

## Covered source boundaries

| Boundary                                                           | Implementation                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Image quote, create and retry preflight                            | `packages/api/modules/media/lib/generation-authorization.ts`                    |
| Registered image/video/template upload sessions                    | `packages/database/prisma/queries/media/assets.ts`                              |
| Temporary reference reservation, pending limit                     | `packages/database/prisma/queries/media/temporary-references.ts`                |
| Guest/marketing draft asset transfer into account                  | `packages/database/prisma/queries/media/drafts.ts`                              |
| Image direct/combined/create/retry database admission              | `packages/database/prisma/queries/media/jobs.ts`                                |
| Image retry receipt reconciliation                                 | `packages/database/prisma/queries/media/retry-requests.ts`                      |
| Legacy generated output reservation                                | `packages/database/prisma/queries/media/assets.ts`                              |
| Native and template video admission, output and scene reservations | `packages/database/prisma/queries/media/video-v1.ts` (shared template delegate) |
| Native/template video output recovery                              | `packages/database/prisma/queries/media/video-v1-fulfillment.ts`                |
| Shared eligibility, immutable policy and output ownership lookup   | `packages/database/prisma/queries/media/storage-quota.ts`                       |

No database schema migration, production write, paid model call, gift-credit change, push, pull request or deployment is part of this branch.

## Verification

Test-first evidence: the new API unlimited case failed with `STORAGE_QUOTA_EXCEEDED` before the nullable check. The new output identity case failed before the explicit single-identity guard. New helper tests initially failed because the policy module did not exist.

New tests cover paid/free current-policy transitions, explicit null, malformed frozen policies, owner-scoped output policy lookup, historical jobs, admitted paid output after expiry, retained upload/temporary-reference pending and owner restrictions, actual reservation byte writes, job admission and unchanged quote fingerprint/pricing values. Existing upload and draft transaction tests now isolate global client construction and explicitly supply their subscription fixture.

Native video and template PostgreSQL regressions additionally assert full 100 MiB output reservation and 20 MiB scene reservation even with a one-byte free cap, plus unchanged credits and reviewed quote fingerprint. A PostgreSQL upload test covers paid-to-expired transition and exact metered byte totals. These database integration tests require the official generated Prisma client and were not runnable in this environment.

Final focused runs pass **111 database tests** and **54 API tests** (including upload sessions, retry generation, plan entitlement, and generation authorization).

Full package commands executed:

- `pnpm --filter @repo/database test`: **178 tests pass**, 4 suites cannot collect because `#prisma-runtime-client` is missing.
- `pnpm --filter @repo/api test`: **593 tests pass**, 27 suites cannot collect because the same official generated runtime is missing.
- Focused upload/video/template PostgreSQL integration command: 3 suites cannot collect because official `generated/client` / `#prisma-runtime-client` is missing; no PostgreSQL assertions executed.
- Database and API type checks: blocked by missing generated Prisma modules and consequent missing delegate types. Full diagnostics are retained at `/tmp/subscriber-storage-database-tsc.log` and `/tmp/subscriber-storage-api-tsc.log`.
- Changed-file oxlint exits 0, with existing missing-Prisma-type warnings. Formatting and whitespace checks are run before committing.

The official Prisma engine download was already returning CONNECT HTTP 403 earlier in the session. Per parent instruction it was not retried, bypassed or replaced with fabricated generated files. Test-only module mocks isolate construction/credit/moderation boundaries; they do not replace the quota logic. Full unit logs are `/tmp/subscriber-storage-database-tests.log` and `/tmp/subscriber-storage-api-tests.log`; integration diagnostics are `/tmp/subscriber-storage-integration-tests.log`.

### Exact blocked suite names

database package:

- `prisma/client.test.ts`
- `prisma/queries/attribution-write-protection.test.ts`
- `prisma/queries/media/guest-admission.test.ts`
- `prisma/queries/media/guest-initial-activation.test.ts`

api package:

- `cors.test.ts`
- `media-flow-http.test.ts`
- `request-security.test.ts`
- `modules/media/temporary-reference-upload.test.ts`
- `modules/testing/media-load.test.ts`
- `modules/media/procedures/admission-context.test.ts`
- `modules/media/procedures/admission-timing.test.ts`
- `modules/media/procedures/create-generation.test.ts`
- `modules/media/procedures/create-quote.test.ts`
- `modules/media/procedures/get-guest-eligibility.test.ts`
- `modules/media/procedures/get-job.simulation.test.ts`
- `modules/payments/checkout-return-state.test.ts`
- `modules/payments/checkout-security.test.ts`
- `modules/payments/provider-availability.test.ts`
- `modules/organizations/procedures/create-logo-upload-url.security.test.ts`
- `modules/media/webhooks/kie-callback.test.ts`
- `modules/media/procedures/get-guest-capability.test.ts`
- `modules/media/procedures/submit-generation.test.ts`
- `modules/ai/procedures/stream-message.security.test.ts`
- `modules/ai/procedures/stream-message.test.ts`
- `modules/media/lib/moderation-retry.test.ts`
- `modules/media/lib/text-moderation.test.ts`
- `modules/media/procedures/admission-simulation.test.ts`
- `modules/media/procedures/get-credit-account.test.ts`
- `modules/media/procedures/submit-generation.http.test.ts`
- `modules/payments/procedures/admin-checkout-review.test.ts`
- `modules/payments/procedures/admin-stripe-refund-repairs.test.ts`

## Remaining review and rollout requirements

Official Prisma generation, full PostgreSQL concurrency/admission/finalization coverage, and clean type checks remain required before treating this as fully verified. In particular, the prepared native/template integration tests have not run. The current branch changes a server-side snapshot contract; deploy a compatible jobs consumer before the website producer, and keep matching code on rollback. A mixed old jobs consumer can still apply the old finite output cap to a newly admitted subscriber job. No release was attempted.

## Independent review correction

A free-admitted job originally retained its finite frozen cap even after the owner upgraded to a valid paid subscription. A new regression reproduced that rejection, then the output policy was corrected to accept either current paid eligibility or a frozen unlimited admission. Focused policy/admission transaction checks passed 28 tests after this correction. No quote or credit logic changed.

The official CI also exposed the existing aggregate-output quota regression: a finite admission record must not replace the current free-owner output quota. A second test reproduced the old larger recorded quota bypassing the current cap; output lookup now preserves only the unlimited admission promise and otherwise resolves the current paid/free policy. The frozen snapshot returns the actual JSON-object type rather than the broader Prisma input type. The exact prior finalization test expectation is retained, not weakened to a moderation error. The corrected focused database set passes 113 tests.
