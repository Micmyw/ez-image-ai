# Moderation outages and review

Open `/admin/media#moderation` using an administrator account. The panel tracks service incidents
separately from affected content: service recovery does not resolve the pending review queue.

## Retry and admission policy

- Text scans retry allowlisted transient errors three times after the initial attempt, with
  250, 500 and 1,000 ms backoff. Exhaustion records an immutable `BYPASS` quote and a pending review
  in the same transaction. Generation admission and dispatch check that the review is still allowed.
- Image verification keeps private object inspection and checksum checks. Detector errors use the
  existing Outbox/worker recovery path with at most four transient failures. Exhaustion records
  separate immutable `BYPASSED` evidence and a pending review before making an inspected asset ready.
- A detector task still processing is polled every 15 seconds. After the two-minute image deadline
  and at least three incomplete attempts, recovery records a fourth timeout observation and permits
  the inspected image pending review. Scheduler delays do not prematurely cut off technical retries.
- A SeeAPI submission with uncertain acceptance is never blindly resubmitted. Recovery retains its
  original task ID, or records bounded uncertainty observations when no ID is available. Such a case
  permits manual review; automatic administrator recheck needs a known detector task.
- Explicit `REJECT`/content `REVIEW`, invalid input/configuration, corrupted files, missing checksum,
  storage failures and database failures do not grant an outage permission. Video rules are unchanged.
- Bypass evidence is not an approved classifier verdict. Original owner checks, immutable quote
  fingerprints, private storage, reservations, settlement and ordinary generation charges still apply.

## Alerts and recovery

Incidents aggregate by provider and text/image stage under a transaction lock. Replayed observations
do not increment counts twice. The affected count describes checks, with links to original targets
and related job IDs in the review queue; it is not a count of unique customers.

An exhausted check, blocking configuration error, or four aggregated technical failures enqueues one
in-app notification per incident and current administrator. Delivery uses a stable deduplication ID,
honors notification preferences, and sends no email. Administrators can enable these alerts under
notification settings. The persistent panel remains visible even when personal alerts are disabled.

Acknowledgement records who took responsibility; it does not mark the detector healthy. A completed
later detector check can close the incident and enqueue one recovery notification. An older request's
success cannot hide a more recent failure. The next ordinary check or administrator recheck supplies
recovery evidence; there is no paid synthetic health probe. New failures after recovery open a new
incident. Previously permitted content remains pending until individually reviewed.

## Review actions

The queue supports status filters and pagination. Open a record to inspect its original instruction
or a 60-second private image preview; the access is audited. Supply an audit reason of 10–500 characters.

- **Recheck** inspects the same content. It reuses a known detector task and never creates another
  generation or reservation. Another outage retains the historical permission marker and review task.
- **Approve** records the administrator decision. Only unfinished work can resume; settled jobs and
  ledger entries stay unchanged.
- **Block** revokes future media access and edit reuse. Prompt rejection also quarantines existing
  outputs and fences late verification/dispatch. Already issued signed links may work until expiry;
  a copy previously downloaded by a customer cannot be recalled.

Version checks prevent concurrent administrators from overwriting each other. Stable operation keys
make retries idempotent. Every decision records actor, reason and prior/new state. Review exceptions
remain actionable rather than silently releasing content. No automatic action rewrites a settled
ledger, refunds an already delivered image, or consumes the one-time output-block waiver.

## Release and rollback

Apply `20260916111855_moderation_outage_reviews` through the production migration gate before
deploying the site and jobs worker. It adds private incident/review tables, notification/status enum
values and the database evidence guard. Browser roles receive no access; `ezpic_app` receives explicit
application policies. Retain these additive tables and audit/evidence records during rollback.

An older worker does not understand `BYPASSED` evidence. Do not leave older jobs workers active while
the new site admits bypassed quotes. If a rollback is required, pause new generation, drain existing
work and deploy a compatible worker before reopening admission; do not delete or relabel evidence.
