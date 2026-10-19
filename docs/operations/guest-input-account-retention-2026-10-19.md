# Guest input account retention

This change has two separate release boundaries. It does not itself authorize a
deployment or a production configuration change.

## 1. Storage cleanup consumer

Deploy the cleanup consumer while `ACCOUNT_INPUT_PROMOTION_ENABLED` remains
unset or `false`. All three physical deletion handlers authorize the complete
set of final, staging and promotion keys through PostgreSQL before storage I/O.
The consumer takes the same asset binding lock as draft ownership transfer and
then re-reads the asset under a row lock, using the current database clock.

A due guest final-object deletion first commits `DELETED` and `deletedAt`, and
queues the existing canonical guest cleanup events in that same transaction.
Those events retain final-object reservation release and staging/multipart
cleanup even though the retention sweeper now skips the tombstoned asset.
That tombstone is permanent: an account handoff cannot revive it even while the
object-store request is pending or being retried. No database transaction stays
open across object-store I/O. Expired/aborted uploads and verification failures
retain their existing terminal cleanup paths, including failed guest inputs
whose retention deadline is still in the future.

A stale deletion whose complete key set touches a live account asset's final key
is skipped as a group. A skip neither deletes or aborts objects, writes a physical
completion receipt, nor releases storage reservations. Normal staging-only
cleanup remains possible without tombstoning the live asset or releasing the
capacity occupied by its final object. A later explicit account deletion keeps
working through its normal tombstone and cleanup path.

New physical-operation receipts use a versioned fingerprint of the complete
cleanup key set and its session/reservation-release semantics. Existing receipts
remain unchanged. A receipt for the initial deadline payload, which has no
reservation reference, cannot suppress a later canonical final-delete event
that must release that reservation after deletion succeeds.

## 2. Account-retention producer

Do not enable `ACCOUNT_INPUT_PROMOTION_ENABLED=true` with the initial consumer
deployment. First establish that every old physical-delete executor, including
old Workflow deliveries, has finished or drained. Cancelling a PENDING Outbox
event does not stop a leased event or an already-dispatched task. Traffic routing
to a new Worker version alone is insufficient evidence of this drain.

Only after that evidence is reviewed may a separately authorized release enable
the site producer flag. Its default is off and no production binding is staged
by this patch. With the flag off, the existing handoff and guest retention remain
unchanged; the permanent-account retention improvement is not active.

Both the ordinary registered ACTIVE-draft claim and the unaccepted guest-link
handoff can upgrade an input. Both hold the asset binding advisory lock and asset
row lock, and update the exclusively claimed draft in the same transaction.
The guest-link path also holds the existing guest-owner promotion fence against
trial admission. The ordinary ACTIVE claim does not acquire that owner fence;
its conditional ACTIVE-to-SUBMITTED draft update excludes a competing claim, and
guest admission requires a SUBMITTED draft still owned by that guest.

With the flag on, the producer rechecks the destination's registered identity,
the claimed draft's expiry and the asset's retention deadline using database time
after acquiring the asset locks. A live, exclusive INPUT with no trial, job
binding or other live draft can move to the registered account with
`retentionClass=ACCOUNT` and `deleteAfter=null` in the same transaction as draft
ownership and storage reservation transfer. Only the exact matching PENDING
guest deadline Outbox event is retired in that transaction. A LEASED or already
dispatched event still needs the new consumer fence; retirement does not prove
that old consumers have drained and does not create a physical-delete receipt.
Anonymous bootstrap claims and accepted guest RESULT links retain their existing
retention and access behavior. Watermarks, shared image/video credits, result
grants, moderation evidence and billing are unchanged.

The upgrade applies to a new successful exclusive claim. Previously completed
registered SUBMITTED-claim replays keep their existing return path; this patch
does not backfill historical assets or migrate production records.

If old executors cannot be proved drained, keep the producer flag off. Supporting
overlap with an unguarded old delete requires a different protocol: verified
copy to a fresh immutable account key, durable copy/commit recovery and orphan
cleanup. Merely cancelling Outbox rows or changing retention fields cannot make
same-key adoption safe in that situation.

## Verification

Focused tests cover complete-key authorization, no-op receipt/storage behavior,
guest deadline checks, permanent tombstones, staging-only compatibility and
producer eligibility. The PostgreSQL integration test is written to exercise an advisory
lock wait between adoption and a dispatched deletion, plus the opposite ordering
where deletion authorization commits before adoption. It requires a real generated
Prisma client and a designated local disposable test database; mock tests alone do
not certify this database race or any deployed object-store behavior. At preparation
time the integration test could not run because the genuine generated Prisma
client is unavailable after the official engine download was blocked. It remains
a required verification before releasing the consumer or enabling the producer.
