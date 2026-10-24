# Image retention pause and review diagnostics

The user requested that images temporarily stop being deleted automatically. This change applies to ordinary image assets on the legacy image engine, including guest inputs/outputs, expired drafts, temporary references and failed reviews. Video-engine cleanup retains its existing policy.

## Application behavior

`MEDIA_IMAGE_AUTO_DELETE_ENABLED` is server-only. Missing, `false` and unrecognized values pause automatic image deletion; only exact `true` restores it. Keep website, Workers jobs and any hybrid Node receiver aligned. Deployment preparation preserves the setting for each runtime without exposing it publicly. No schema migration is required.

Both expiration producers and the physical cleanup consumer enforce the pause. Already queued events and historical automatic tombstones retain the final object and defer for one hour without ACK or failure-budget consumption. A matched owner deletion/abort audit allows explicit deletion; a tombstone alone does not. Staging keys and known incomplete multipart uploads may be cleaned without deleting the final object or releasing its occupied capacity. Missing metadata after an uncertain upload does not prove that the final object is absent.

Temporary ACTIVE and COMMITTED storage reservations remain counted after expiry during the pause: an unknown PUT or commit can leave real bytes. Capacity is released through the existing confirmed cleanup protocol. This can increase storage use and cause users to reach existing quota sooner; do not release reservations based only on elapsed time. Retention is temporary, not unlimited-storage entitlement.

Signed access, temporary reference receipts, guest deadlines, moderation evidence, ownership checks and credit accounting keep their existing expiry/authorization rules. Retaining bytes does not approve content or extend customer access. Administrator inspection remains authenticated and audited. Previously completed physical deletions cannot be undone.

## R2 action and release boundary

On 2026-10-24, production bucket `ezimageai-media-production` had only the `deleteObjectsTransition` removed from the `Temporary references - 24 hours` rule for `users/temporary-references/v1/`. Both that rule's one-day multipart abort and the bucket-wide seven-day multipart abort remain unchanged. The PUT returned HTTP 200 and GET readback matched the expected rules: [sanitized evidence](evidence/image-retention-r2-2026-10-24.json).

That R2 change is live. Application release must be verified separately against the published commit, both production Worker versions and cleanup behavior; the lifecycle readback alone does not prove application deployment. The previous application can still perform its existing cleanup until compatible runtime code is released. A storage DELETE already authorized by an old running consumer cannot be retracted by a later code change.

For an authorized release, deploy the compatible cleanup consumers and website/jobs producers with the flag false or absent, drain old receivers/active cleanup work, and verify application event deferral and unchanged storage reservations. Existing private-image status and owner access checks still apply. R2 configuration and application deployment are separate evidence stages.

## Restoring automatic deletion

Restoration can permanently delete retained images. Obtain a separate user instruction before re-enabling it. Review retained storage and pending events. First restore and verify the narrowly scoped temporary-reference R2 expiration rule, then align exact `true` across compatible website/jobs runtimes; automatic-mode quota expiry relies on that physical lifecycle. Deferred events retain their original due-time and lease protocol; do not mark them processed manually. Never broaden the lifecycle rule to the entire bucket.

## Moderation diagnostics

The admin panel distinguishes historical errors from a fresh result of the persisted SeeAPI task. Valid `MEDIA_INVALID` and `PROVIDER_TIMEOUT` responses are technical failures, not evidence of a content violation. The diagnostic GET never starts another moderation task or changes business state. A flagged result is the detector's automated judgment; without the original, it is not possible to establish whether that judgment was correct.

Deleted/missing originals and preview-load errors have explicit messages in the private Chinese admin display and the four application locales. Manual image approval requires a successfully loaded current original. Deleted records remain visible for audit and original-task diagnosis.

## Local verification

- PostgreSQL retention/integrity: 47 tests across guest retention, account input retention, output storage concurrency and draft storage; moderation outage/technical rejection: 17 tests. The isolated fixture applied 76 committed migrations and was stopped with its owned process trees verified exited.
- Retention configuration, database and cleanup unit tests and both deployment-profile tests passed. Admin API authorization, original availability, same-task diagnostics, and UI/translation regressions passed, including the private Chinese display.
- Affected API, SaaS, AI, Config, Database, Jobs and Web-host type checks passed. These are local results; they do not certify deployed cleanup behavior, classifier accuracy or restoration of previously deleted originals.
