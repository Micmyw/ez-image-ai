# Multi-model pending video quotes

The original `20261004010000_video_quote_pending_evidence` migration limited
`PENDING_VIDEO_WORKFLOW` to `video-kling-2-6-v1`. API/catalog checks could accept another
implemented model while PostgreSQL rejected its quote before any job or reservation existed.
The reported case was Seedance 1.5 Pro, text-to-video, 4 seconds, 480p, 16:9, sound disabled.

`20261005000000_video_multimodel_quote_pending_evidence` replaces only
`generation_quote_moderation_decision_check` using one atomic `ALTER TABLE` statement. Its
explicit 12-key allowlist matches catalog version `video-models-2026-10-04.1`.
Blocked models, unknown video keys and image products cannot use pending video evidence. The
Workflow provider, pending reason and 64-character hexadecimal fingerprint remain required.
Existing `ALLOW`, `BYPASS`, `LEGACY_UNREVIEWED`, their independent fingerprint checks, and the
quote immutability trigger are unchanged.

This is PostgreSQL CHECK-only DDL, which Prisma's schema DSL does not represent; there are no
column/type/query changes, generated-client edits or business-row updates. Keep the historical
migrations unchanged and apply this new migration through the existing controlled migration
process before continuing multi-model acceptance. Normal constraint validation checks existing
rows when the replacement is installed; use the release's lock/statement timeout policy.
The migration explicitly wraps that statement in a transaction with 3-second lock,
30-second statement and 45-second idle-in-transaction timeouts.

`20261005010000_video_veo_fast_quote_pending_evidence` is the next forward-only migration for
catalog version `video-models-2026-10-04.2`. It adds only `video-veo-3-1-fast`, bringing the allowlist
to 13 keys. It preserves all 12 prior keys, evidence guards, atomic replacement and timeout rules.
The already-applied 12-key migration is unchanged. The dedicated regression covers Veo 3.1 Fast
text-to-video at 4 seconds, 720p, 16:9 with provider-native audio, including a single credit
reservation across an idempotent replay. This database permission does not enable the model in
the private runtime allowlist or validate its external supplier integration.

Regression coverage in `video-v1.integration.test.ts` uses real PostgreSQL for every implemented
model/mode representative, the exact failing Seedance tuple, admission/reservation/replay, and
negative product/evidence cases. Future implemented catalog entries require a new forward
migration if these database tests reveal a missing key. The full option combinations remain
covered by their existing model/price unit tests.

For application rollback, retain this compatible expanded constraint and close new model admission
through the private allowlist. Do not restore the historical Kling-only CHECK over rows created
for other implemented models, and do not delete or rewrite quote rows to make a rollback pass.
This migration neither starts generation nor opens production video access.
