# Temporary editor references

The signed-in image editor uses `POST /api/media/temporary-references`: same-origin authenticated upload, bounded JPEG/PNG/WebP body, streaming signature/length/SHA-256 validation and a conditional private write. Files up to and including 10 MiB use one PUT; larger files use bounded 5 MiB multipart writes within the existing plan limits. No staging promotion or storage readback is needed. The browser receives an owner-bound signed receipt, never a storage write URL.

Selecting a file creates only a storage quota reservation. Existing authentication, rate limiting and plan lookups still apply. No `MediaAsset`, upload session or moderation event is created until the customer submits generation. Frontend checks give immediate feedback; server checks protect against forged requests and concurrent uploads. Expired temporary reservations stop consuming logical quota without a cleanup job.

## Generation and recovery

The quote validates the receipt and binds its descriptor to the text moderation fingerprint. Job creation atomically adopts the immutable input, creates its input binding and image-verification Outbox event, and reserves credits with the existing job Outbox event. Image verification must be APPROVED before provider dispatch. Retries reuse the same SeeAPI task; verification errors never bypass temporary-reference approval. Pending jobs fail and release their hold if the reference expires. An already uncertain provider submission retains its original reconciliation and credit rules.

Waffo is the configured text checker and SeeAPI the image checker. Keep both Sightengine flags false/unset. Both website and jobs use the existing settings; no new secret, environment variable, database schema or migration is required. The legacy library/guest/output lifecycle and executor concurrency are unchanged.

## R2 lifecycle

Production bucket: `ezimageai-media-production`.

- Rule: `Temporary references - 24 hours`.
- Prefix: `users/temporary-references/v1/`.
- Delete objects and abort incomplete multipart uploads at age 86,400 seconds.
- Preserve the existing bucket-wide seven-day multipart abort rule.

This prefix was empty when the rule was installed and read back on 2026-09-22. The rule is active; application rollout is a separate action. Never apply this deletion policy to the whole bucket or existing permanent asset prefixes.

R2 lifecycle deletion is asynchronous, not an exact 24-hour timer. Application access expires at 24 hours. Submission and dispatch compare the existing expiration timestamp with the current time, without an early-expiry window or a separate storage lookup. The frozen checksum and object key identify the same bytes for image moderation and generation. Results remain independent when an input expires; before/after comparison is unavailable once its input expires.

## Verification and rollout

Run API receipt/admission tests, immutable-reference storage tests and the MinIO integration suite. Run the jobs database integration suite including `temporary-reference.database.integration.test.ts`, and media Playwright scenarios for immediate preview, stale uploads and the full temporary-reference generation path. Local mock-provider results are not a real-provider latency measurement.

Deploy compatible website and jobs changes together; the jobs runtime must understand temporary input verification before the website starts accepting these uploads. Verify both service versions and moderation settings after rollout. No cleanup executor or page-initialization request is added.
