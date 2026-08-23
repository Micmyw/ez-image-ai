# Task 3 Report: Private Media Asset Pipeline

## Outcome

Implemented a private media asset pipeline covering server-generated user-scoped object keys, signed PUT and multipart browser uploads, authenticated short-lived reads, atomic upload/reservation/audit/outbox state changes, and provider-output streaming directly into multipart object storage.

The browser receives opaque `MediaAsset` and upload-session IDs. It does not select buckets or object keys, and it does not persist signed URLs or multipart upload IDs. Upload completion transitions an asset only to `VERIFYING`; the verification Outbox event is responsible for metadata and moderation work before any later transition to `READY`.

## RED / GREEN evidence

- Storage RED: `storage.test.ts` initially failed because object-key, magic-byte, SSRF, and streaming modules did not exist.
- Storage GREEN: 27 tests cover JPEG/PNG/WebP/MP4/WebM/MOV signatures, image/video caps, user key isolation, HTTPS/host allowlists, all-address A/AAAA rejection, redirect revalidation, pinned DNS lookup, incremental hashing, byte caps, inline-image-only base64, and multipart abort on request/stream/upload failures.
- Database RED: four transaction tests failed because upload transaction services did not exist.
- Database GREEN: atomic create/complete/abort/delete tests pass, including storage reservation, Audit, and Outbox writes.
- API RED: upload validation tests failed because validation/DTO helpers did not exist.
- API GREEN: supported type/size validation, HEAD/signature agreement, and JSON-safe BigInt DTO tests pass. All six media procedures use `protectedProcedure` and owner-scoped USER lookups.
- SaaS RED: resumable-state tests failed because the state module did not exist.
- SaaS GREEN: state persists only opaque session/asset IDs, file fingerprint, part count, and completed ETags; corrupt or secret-bearing state is rejected and part URLs are re-signed after refresh.

## Implementation notes

- Added `VERIFYING` to `MediaAssetStatus` and `multipartUploadId` to the server-side upload-session model, with a migration and regenerated Prisma/Zod artifacts.
- Added atomic `createMediaUploadSessionTransaction`, `completeMediaUploadSessionTransaction`, `abortMediaUploadSessionTransaction`, and `markMediaAssetDeletedTransaction` services because route-level non-atomic writes would violate the Task 2 invariants.
- Remote provider objects use HTTPS only, explicit host allowlists, DNS validation before every redirect, rejection if any resolved A/AAAA address is non-public, and a pinned Node lookup used by the actual HTTPS connection. Video is streamed into bounded multipart parts with incremental SHA-256 and byte enforcement; no provider video path uses `arrayBuffer()`.
- Inline base64 support accepts capped image signatures only and is never written to the database.
- The uploader supports drop, paste, multiple image previews, progress, pause/resume/retry/remove, multipart video, local session recovery, and blob URL cleanup. Its form value is an array of asset IDs.
- The broad `image-proxy` route was intentionally retained: `UserAvatar` and `OrganizationLogo` still consume it. Removing it without migrating and testing every avatar/logo consumer would break compatibility. Follow-up: migrate those consumers to scoped signed access before deleting the route.

## Verification boundary

- Unit tests and TypeScript checks are automated and recorded in the task handoff.
- No real external S3/R2 multipart transfer was performed. Provider-host redirects, DNS pinning, and multipart abort behavior were verified with controlled unit doubles, not a live provider/CDN.
- No browser hardware/network acceptance test was performed. The SaaS component and state machine are type-checked and unit-tested, but pause/resume should receive a browser E2E test against a test bucket before production rollout.

## Fix round 1 (2026-08-13)

- Upload completion now rejects `expiresAt <= now` before S3 multipart completion or HEAD. The early-expiry path atomically marks the session `EXPIRED`, releases the storage reservation, records audit/outbox cleanup, and best-effort aborts multipart or deletes a single-PUT object.
- `completeMediaUploadSessionTransaction` rechecks expiration using database time by default and uses a pending/non-expired CAS before moving the asset to `VERIFYING`. This closes the API-to-database TOCTOU window; a lost concurrent race fails closed. If S3 was already finalized before the transaction detects expiry, cleanup is explicitly queued as object deletion.
- Streaming multipart assembly now uses a chunk queue with a byte counter. It concatenates at most once per assembled part (plus the bounded header), avoiding quadratic repeated copies for tiny provider chunks. A 4,097 one-byte chunk regression verifies five exact parts, byte-for-byte content, SHA-256, and O(parts) concatenation calls.
