# Temporary editor references

The signed-in image editor uses `POST /api/media/temporary-references`: same-origin authenticated upload, bounded JPEG/PNG/WebP body, streaming signature/length/SHA-256 validation and a conditional private write. Files up to and including 10 MiB use one PUT; larger files use bounded 5 MiB multipart writes within the existing plan limits. No staging promotion or storage readback is needed. The browser receives an owner-bound signed receipt, never a storage write URL.

Selecting a file reserves storage capacity. After immutable upload commit, the current image path creates its temporary asset and may begin review before Generate; submission still validates the same owner, object, expiry and moderation evidence. Existing authentication, rate limiting and plan lookups apply. Frontend checks give immediate feedback; server checks protect against forged requests and concurrent uploads. During the automatic-deletion pause, expired ACTIVE and COMMITTED temporary reservations continue consuming quota, including unknown PUT/commit outcomes. Receipt expiry is not proof that bytes were deleted.

## Generation and recovery

The quote validates the receipt and binds its descriptor to the text moderation fingerprint. Job creation atomically adopts the immutable input, binds it to the job and reserves credits with durable execution intent. Matching pending input review retains its original task and event. Image verification must be APPROVED before provider dispatch. Retries query the same SeeAPI task; verification errors never bypass temporary-reference approval. Pending jobs fail and release their hold if the reference expires. An already uncertain provider submission retains its original reconciliation and credit rules.

Waffo is the configured text checker and SeeAPI the image checker. Keep both Sightengine flags false/unset. Both website and jobs must share `MEDIA_IMAGE_AUTO_DELETE_ENABLED=false` (unset also pauses deletion). The pause needs no database migration. Access deadlines, moderation and executor concurrency retain their existing rules.

## R2 lifecycle

Production bucket: `ezimageai-media-production`.

- Rule: `Temporary references - 24 hours`.
- Prefix: `users/temporary-references/v1/`.
- Automatic object expiration was removed on 2026-10-24; incomplete multipart uploads still abort at age 86,400 seconds.
- Preserve the existing bucket-wide seven-day multipart abort rule.

The original deletion rule was installed on 2026-09-22. Its deletion transition was removed and read back on 2026-10-24; the evidence is in [the retention operations note](image-retention-pause-2026-10-24.md). Application rollout is a separate action. Never apply temporary-reference expiration to the whole bucket or existing permanent asset prefixes.

Application access still expires at 24 hours even while physical retention is paused. Submission and dispatch compare the existing expiration timestamp with the current time, without an early-expiry window or a separate storage lookup. The frozen checksum and object key identify the same bytes for image moderation and generation. Results remain independent when an input expires; before/after comparison is unavailable once its input expires. Retained originals remain private and may be inspected through authenticated administrator review.

## Verification and rollout

Run API receipt/admission tests, immutable-reference storage tests and the MinIO integration suite. Run the jobs database integration suite including `temporary-reference.database.integration.test.ts`, and media Playwright scenarios for immediate preview, stale uploads and the full temporary-reference generation path. Local mock-provider results are not a real-provider latency measurement.

Deploy compatible website and jobs changes together; the jobs runtime must understand temporary input verification before the website starts accepting these uploads. Verify both service versions and moderation settings after rollout. No cleanup executor or page-initialization request is added.
