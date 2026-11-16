# Image retention pause and review diagnostics

The user requested that images temporarily stop being deleted automatically. This change applies to ordinary image assets on the legacy image engine, including guest inputs/outputs, expired drafts, temporary references and failed reviews. Video-engine cleanup retains its existing policy.

## Application behavior

`MEDIA_IMAGE_AUTO_DELETE_ENABLED` is server-only. Missing, `false` and unrecognized values pause automatic image deletion; only exact `true` restores it. Keep website, Workers jobs and any hybrid Node receiver aligned. Deployment preparation preserves the setting for each runtime without exposing it publicly. No schema migration is required.

Both expiration producers and the physical cleanup consumer enforce the pause. Already queued events and historical automatic tombstones retain the final object without ACK or failure-budget consumption. Once the consumer confirms retention and successfully finishes ancillary staging/multipart cleanup, it records `MEDIA_IMAGE_AUTOMATIC_DELETION_PAUSED` in the existing Outbox `lastError` field. Cleanup and legacy scans exclude these events before claiming/locking while automatic deletion is paused. The event remains PENDING with its original identity and quota intact. Unmarked events still receive their first consumer check; failed ancillary cleanup retains the existing one-hour retry instead of being parked. No new switch or migration is needed.

A matched owner deletion/abort audit allows explicit deletion; the separately confirmed, exact object-bound administrator plan added on 2026-11-14 is a narrow additional exception, with [its authorization, consumer-first deployment and retry protocol](admin-customer-content-cleanup-2026-11-14.md). These actions create separate, unmarked cleanup intents, so a parked automatic event does not block an authorized deletion. The physical consumer still checks the audit or exact administrator authorization; an event name or tombstone alone does not authorize deletion. New staging cleanup also remains eligible. Staging keys and known incomplete multipart uploads may be cleaned without deleting the final object or releasing its occupied capacity. Missing metadata after an uncertain upload does not prove that the final object is absent.

Temporary ACTIVE and COMMITTED storage reservations remain counted after expiry during the pause: an unknown PUT or commit can leave real bytes. Capacity is released through the existing confirmed cleanup protocol. This can increase storage use and cause users to reach existing quota sooner; do not release reservations based only on elapsed time. Retention is temporary, not unlimited-storage entitlement.

Signed access, temporary reference receipts, guest deadlines, moderation evidence, ownership checks and credit accounting keep their existing expiry/authorization rules. Retaining bytes does not approve content or extend customer access. Administrator inspection remains authenticated and audited. Previously completed physical deletions cannot be undone.

Guest cleanup diagnostics and the scheduled safety monitor use the same automatic-deletion eligibility as guest expiration. Paused legacy images remain in the expired-asset count, but are excluded from overdue-cleanup counts and ages, so intentional retention cannot trigger `CLEANUP_OVERDUE` and close guest admission. Non-image/video-engine cleanup and dead-letter diagnostics retain their existing behavior. This uses the existing retention policy without another switch. A previously persisted guest closure remains in place until an authorized runtime-control update after compatible code is deployed.

The five-minute scheduled safety monitor no longer calls the full administrator report. When environment admission is disabled it does no database work; when the runtime override is missing/disabled it performs only the indexed override read. Open admission performs that read plus one narrow safety query for the existing campaign risk, watermark failure, billed-cost mismatch and eligible overdue-cleanup conditions. Unlimited campaign funding skips risk sums. Warning-only queue/moderation statistics, wait percentiles, sponsor credits and denial history remain in the full administrator diagnostics API. A closure still uses the existing locked, audited, idempotent transaction. Guest/upload expiration and other maintenance continue independently; these query counts describe only the safety monitor, not an entire cleanup sweep.

## R2 action and release boundary

On 2026-10-24, production bucket `ezimageai-media-production` had only the `deleteObjectsTransition` removed from the `Temporary references - 24 hours` rule for `users/temporary-references/v1/`. Both that rule's one-day multipart abort and the bucket-wide seven-day multipart abort remain unchanged. The PUT returned HTTP 200 and GET readback matched the expected rules: [sanitized evidence](evidence/image-retention-r2-2026-10-24.json).

That R2 change is live. Application release must be verified separately against the published commit, both production Worker versions and cleanup behavior; the lifecycle readback alone does not prove application deployment. The previous application can still perform its existing cleanup until compatible runtime code is released. A storage DELETE already authorized by an old running consumer cannot be retracted by a later code change.

For an authorized release, deploy the compatible cleanup consumers and website/jobs producers with the flag false or absent, drain old receivers/active cleanup work, and verify application event deferral and unchanged storage reservations. Existing private-image status and owner access checks still apply. R2 configuration and application deployment are separate evidence stages.

For the 2026-11-16 idle-work optimization, keep all cleanup receivers compatible with the marker before relying on reduced background activity. Old receivers can still claim marked events and fall back to hourly deferral; mixed versions preserve retention safety but do not guarantee the reduction. This change does not reopen guest admission, enable automatic deletion or modify R2 lifecycle rules. No live database savings are inferred from local tests.

## Restoring automatic deletion

Restoration can permanently delete retained images. Obtain a separate user instruction before re-enabling it. Review retained storage and pending events. First restore and verify the narrowly scoped temporary-reference R2 expiration rule, then align exact `true` across compatible website/jobs runtimes; automatic-mode quota expiry relies on that physical lifecycle. Parked events then become claimable under their existing due-time and lease protocol, and the claim clears the pause marker so later failures cannot strand retries. All consumer authorization checks still run; do not mark deferred events processed manually. Never broaden the lifecycle rule to the entire bucket.

## Moderation diagnostics

The admin panel distinguishes historical errors from a fresh result of the persisted SeeAPI task. Valid `MEDIA_INVALID` and `PROVIDER_TIMEOUT` responses are technical failures, not evidence of a content violation. The diagnostic GET never starts another moderation task or changes business state. A flagged result is the detector's automated judgment; without the original, it is not possible to establish whether that judgment was correct.

Deleted/missing originals and preview-load errors have explicit messages in the private Chinese admin display and the four application locales. Manual image approval requires a successfully loaded current original. Deleted records remain visible for audit and original-task diagnosis.

## Local verification

- 2026-11-16 idle-work optimization: 88 PostgreSQL integration tests across Outbox, guest retention/safety and exact administrator cleanup; 198 focused database/jobs unit tests passed. This covers paused-event exclusion/restoration, stale leases, ancillary retry, explicit owner/admin deletion, full-report/scheduled closure equivalence and closed-admission query budgets. Database/Jobs type checks and affected-file lint/format checks passed. The disposable local database applied all 84 existing migrations; no new migration or live cost measurement was required.
- PostgreSQL retention/integrity: 47 tests across guest retention, account input retention, output storage concurrency and draft storage; moderation outage/technical rejection: 17 tests. The isolated fixture applied 76 committed migrations and was stopped with its owned process trees verified exited.
- Retention configuration, database and cleanup unit tests and both deployment-profile tests passed. Admin API authorization, original availability, same-task diagnostics, and UI/translation regressions passed, including the private Chinese display.
- Affected API, SaaS, AI, Config, Database, Jobs and Web-host type checks passed. These are local results; they do not certify deployed cleanup behavior, classifier accuracy or restoration of previously deleted originals.
