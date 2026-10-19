# Registered INPUT verified-copy validation

Implementation branch: `codex/account-input-verified-copy`, based on integrated
source `4800dfae7905511380d6e0ab96e7e0179a1d85c7`. This change requires no new
schema or migration. It has not been pushed, deployed, or enabled in production.

## Result and boundaries

Eligible pre-generation guest INPUTs are retained under a new account asset ID
and immutable versioned key. The original guest source, reservation, object key,
deadline and cleanup events stay unchanged. A source cleanup already outside the
DB cannot name the new destination. Accepted guest RESULT grants, watermarking,
expiry, prices, credits and free generation counts are unchanged.

A registered claim creates a strict versioned intent, target UPLOADING asset,
separate account byte reservation and delivery event in one DB transaction.
Source approval can still be pending. Workers only receive the promotion ID;
owner, source checksum/size/MIME and the fixed target come from the journal.
They use the existing conditional immutable promotion, mandatory SHA-256 and
full destination readback. Storage I/O never runs inside a DB transaction.

Matching current content REVIEW on the source waits without granting a writer.
After a copied target receives REVIEW, it remains QUARANTINED with deletedAt null
and a VERIFYING copy intent, preserving the normal administrator APPROVE/RECHECK
paths. Those actions still require standard current approval before READY. Genuine
REJECT, exhaustion, deletion and invalid or stale REVIEW remain terminal. The
genuine ORM administrator regression seeds an existing BLOCKED review; this does
not add automatic review-card creation for the first REVIEW result. The existing
administrator requeue path for quarantined assets without a review card remains
available. This independent source correction is commit
`26ef4d3d541ebee4c809a11fb8c853f70d3b4fc8`.

The current business token and fresh DB bindings authorize materialization:
UPLOADING -> VERIFYING, draft source -> new target, reservation -> COMMITTED and
standard MEDIA_ASSET_VERIFY. Only the normal current asset approval permits READY.
No old moderation result is copied and no timeout bypasses moderation. Original
source/draft authorization must remain valid until materialization commits.
A physical source missing after a lost response can only be recovered from an
existing fully verified destination while the DB binding/window still permits it.
A committed source deletion cannot be bypassed with that physical destination.

All registered claim replays, guest-link DRAFT replays and editor recovery expose
preparation while pending; they omit a usable source asset. The owner-scoped API
only returns a public status and reason. The editor waits before recovery parsing
or generator rendering, stops foreground polling after two minutes, and offers
manual recheck. Terminal failures offer an explicit new-image action. Nothing
silently switches to text generation or creates a generation job. The authenticated
HttpOnly claimed-draft recovery cookie lasts 24 hours; this does not extend guest
object, claim, RESULT or moderation authorization.

## Persistence, accounting and recovery

The existing Outbox stores two PROCESSED **domain journal** records: strict
ACCOUNT_INPUT_COPY_INTENT and an indexed target pointer ACCOUNT_INPUT_COPY_TARGET.
PROCESSED here is not a delivery or physical-delete completion receipt. Separate
PENDING events carry copy/orphan work and retain ordinary Outbox ACK semantics.
Journal rows must not be purged as generic completed deliveries. The pointer uses
the existing unique dedupe index, so ordinary INPUT verification does not scan
all historical JSON payloads. A future generic Outbox purge must preserve these
records or first migrate them to a dedicated journal.

Copy operations use draft row -> owner storage lock -> sorted asset binding/rows
-> intent row. Verification obtains target row before intent row. Exact source,
target, current lease and committed lease identity are checked again after waits.
The MPU ID is durable before any part. Explicit NoSuchUpload clears only that ID
under the current lease, then retries the same destination once.

Free aggregate quota, authoritative paid entitlement and product per-file size
reuse existing helpers under the storage owner lock. Both old guest bytes and
new account bytes remain metered. The account-input-copy reservation prefix is
durable: the real unexpiredStorageReservations filter only expires temporary
reference prefixes. A PostgreSQL regression advances an uncertain writer past its
reservation/deadline, confirms it still consumes quota after an orphan pass, fills
the free quota with other bytes, and rejects another copy. No unproven state change
to COMMITTED was needed for that boundary. A normal READY copy with no unresolved
old writer changes its reservation reference to the existing media-draft contract,
so normal owner deletion releases it after physical cleanup.

Lease expiry and one DELETE do not prove a writer has stopped. Failed/expired
leased copies become permanent tombstones before orphan cleanup. Uncertain old
writers retain a separate reservation and recurring exact-key abort/delete work;
no single pass writes an everlasting-clean receipt. Even after a successful retry,
a copy with an unresolved old writer remains watched: if the account later deletes
it, orphan checks continue and its separate reservation remains held. This is a
conservative operational hold, not an automatically draining claim. Releasing an
unresolved hold requires separate, attributable evidence; no time-only release or
production backfill is included. Recovery rotates due rows to avoid starving later
copies behind old orphans or pending source reviews.

## Flag and rollout

The retired ACCOUNT_INPUT_PROMOTION_ENABLED is a source-level no-op regardless of
its value. Keep it off; this patch does not permit same-key adoption.

The new producer enables only for the exact private server value
ACCOUNT_INPUT_COPY_ENABLED=true. Missing, false and other values are disabled.
No configuration or binding value has been changed by this implementation.
Existing deploymentEnvironment -> workersRuntimeEnvironment -> createProfileArtifacts
preserves an explicitly supplied private switch in website.secrets and
workflows.secrets; hybrid jobs also receive it in JOBS_RUNTIME_ENV. It is not
NEXT_PUBLIC, not a build-time browser switch and not VIDEO_RUNTIME_CONFIG.
Profiles tests prove absent/default and explicit true/false transport for both
Workers and hybrid. Actual deployed binding and Worker behavior remain a release
check. Consumers, polling and recovery keep working when the producer is off.

The website/jobs pipelines can deploy simultaneously and finish in either order:

1. Keep both old and new producers off while deploying the compatible website,
   task registry/executor, verifier guards and scheduled copy/orphan recovery.
2. Require independent source review, official generated-client CI, actual
   compatible website/jobs version identity, registered task routing/maintenance,
   and isolated storage overlap verification. Do not assume jobs deployed first.
3. Only then enable the new producer through the normal private release input.
   Verify owner-scoped preparation -> copied VERIFYING -> normal READY before
   widening it. No live paid model/storage mutation was performed in this task.
4. To stop new work, turn only the new producer off. Keep compatible consumers,
   status UI and orphan recovery until accepted intents finish. Rolling back to a
   pre-protocol website can lose the preparation contract and is not an automatic
   safe rollback. Turning the producer off does not cancel already accepted work.

This gate never treats new Worker traffic at 100% as proof that old guest DELETE
I/O drained; separate immutable target identities remove that dependency.

## Verification

Observed failures before fixes included missing intent implementation; preparation
rendering the generator; missing task routes; stale token/MPU recovery; READY with
wrong target owner/key; expiry and MPU tombstones releasing uncertain quota;
recovery starvation; and source MIME drift during materialization. All related
focused regressions pass in the final candidate.

| Scope                                                                                                                        | Result         |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| DB unit contracts, claim regression and retired-flag behavior                                                                | 81 tests pass  |
| Real PostgreSQL SQL port: concurrency, locks, quota, leases, evidence, races, rollback, orphan accounting and content REVIEW | 59 tests pass  |
| Jobs handlers/runtime/registry/lanes/executor/Outbox, including normal content REVIEW                                        | 102 tests pass |
| S3-command transport simulation plus existing immutable storage contracts                                                    | 27 tests pass  |
| Real pinned MinIO: handler copy overlap, full SHA verification and response-loss recovery                                    | 5 tests pass   |
| API owner/status/claim/link DTO                                                                                              | 32 tests pass  |
| Editor/polling/continuation/recovery UI                                                                                      | 43 tests pass  |
| Deployment profiles, including private switch transport                                                                      | 64 tests pass  |

Useful commands from their package directories:

```
# packages/database (use an authorized disposable localhost TEST_DATABASE_URL)
pnpm exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/account-input-copy.sql.integration.test.ts
pnpm exec vitest run prisma/queries/media/account-input-copy.test.ts prisma/queries/media/draft-account-promotion.test.ts prisma/queries/media/drafts.test.ts --configLoader runner
# packages/jobs
pnpm exec vitest run src/handlers/account-input-copy.test.ts src/handlers/account-input-copy-runtime.test.ts src/orchestration/registry.test.ts src/orchestration/worker-executors.test.ts src/orchestration/executor.test.ts src/handlers/deliver-outbox-event.test.ts --config vitest.config.ts
# packages/storage
pnpm exec vitest run provider/s3/account-input-copy.test.ts provider/s3/immutable-upload.test.ts lib/immutable-reference.test.ts
# Supply disposable localhost MinIO test credentials/buckets before this command.
pnpm run test:minio
# packages/api
pnpm exec vitest run modules/media/procedures/get-account-input-copy-status.test.ts modules/media/procedures/complete-guest-link-intent.test.ts modules/media/procedures/claim-draft-product-availability.test.ts
# apps/saas
pnpm exec vitest run modules/media/components/editor/AccountInputPreparation.test.tsx modules/media/components/editor/RegisteredEditor.test.tsx app/draft/continue/route.test.ts modules/media/lib/editor-recovery.test.ts
# apps/web-host
pnpm exec vitest run src/profiles.test.ts
```

The PG suite uses a random disposable schema, real SQL/advisory locks and the real
copy, entitlement, quota and evidence helpers. Its bounded delegate-to-pg transport
is not a generated Prisma client and does not certify original migrations/triggers
or the full claim/link orchestration. The package integration glob includes it;
the new parser test is registered in the explicit default DB test list.

The genuine `account-input-retention.integration.test.ts` also contains a new
registered-claim -> fresh UPLOADING target -> fenced VERIFYING materialization
case against the original schema/ORM, retaining the guest source and blocking
editor recovery until moderation, plus direct APPROVE and RECHECK gates for an
existing BLOCKED review. That suite fails to import the absent official client
locally (zero assertions executed); official CI must certify it. Its physical copy
boundary is supplied by the test and is not a real object-store invocation. The
59-case PG port and 102-case jobs results include the independent content REVIEW
followup; they do not replace that generated-client certification.

Full storage passes 163 tests, and its TypeScript check passes. Earlier full jobs
and DB runs on the original implementation candidate were limited as follows:
jobs executes 579 passing assertions but 13 suites cannot import the missing
official generated Prisma client; full package success is not claimed. DB has 305
passing, 18 failing and 3 skipped assertions plus four missing-client import
suites. The 18 failures are in unchanged
baseline admission-capacity/admission-isolation mocks missing the current paid
subscription port and the baseline storage-output-consumer paid upload-cap
expectation. None is hidden or treated as passing. Whole DB/API/UI/jobs typechecks
are also blocked by the missing official client and inherited diagnostics.

## Actual local MinIO overlap followup

The local test uses the existing pinned MinIO binary
RELEASE.2025-04-22T22-12-26Z, verified SHA-256
`53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c`.
It runs on a separate loopback service and dummy bucket/credentials, without
reading an existing server environment or downloading another binary.

`account-input-copy.minio.integration.test.ts` invokes the actual copy handler and
`promoteStagedObject`. A transparent local HTTP proxy pauses the actual multipart
Complete request after the journal records its upload ID and MinIO stores all
parts. The test deletes the old guest object before allowing completion. Both a
small PNG and a PNG larger than 8 MiB retain the exact destination bytes and full
SHA-256, using actual one-part and two-part uploads. A repeated old-source DELETE
does not affect the distinct target. ETags are only part-count evidence, never
content identity.

Two response-loss cases leave physical data before the modeled DB commit, delete
the source, then recover the same verified target. Actual HTTP traces show only
one multipart creation and no second source read. A further case models a commit
whose response is lost: replay skips storage and preserves the single target and
materialization. These journal/lease/commit boundaries are injected test ports,
not genuine ORM transactions. The target stops at VERIFYING; none of these tests
claims moderation approval or production R2 behavior.

The new five cases are included by the explicit storage `test:minio` script, which
the existing official workflow already invokes; no workflow file changed. The
full registered MinIO suite passes 17 cases across three files. Scoped formatting,
lint and storage type checking also pass. Existing S3 command simulations cover
additional late-completion/orphan branches; those remain simulated transport.

No engine download workaround, fabricated generated client, production migration,
paid model call, production write, flag change or deploy was attempted. Independent
review and official CI remain required before enabling the producer.
