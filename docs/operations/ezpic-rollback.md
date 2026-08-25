# EzPic rollback procedure

## Purpose and authority

This procedure stops unsafe new work while preserving private assets, immutable credits, billing
history, Provider attempts, verified Webhooks, and Outbox recovery. PostgreSQL remains authoritative.
A rollback never deletes or rewrites jobs, Quotes, reservations, Ledger entries, PaymentEvents,
Purchases, Subscriptions, Billing Periods, MediaAssets, moderation evidence, or audit records.

Record the incident ID, operator, approver, current deployment revision, target revision, UTC
timestamps, affected traffic, alert references, and reason. Do not paste secrets, prompts, raw
payloads, signed URLs, cookies, or private identifiers into the incident record.

## Trigger conditions

Begin rollback or traffic shutdown for any unexplained:

- credit, reservation, refund, Debt, or Provider-cost divergence;
- duplicate submission, settlement, Webhook effect, or billing grant;
- private asset access, retention, moderation, or analytics-consent failure;
- sustained error rate, p95 latency, queue delay, Outbox backlog, or moderation anomaly over the
  approved threshold;
- broken payment projection, reconciliation, canonical/SSL/DNS behavior, or alert delivery;
- inability to identify whether a Provider accepted an attempt.

## Immediate containment

1. Activate an audited `media.generation.enabled=false` runtime override. This is the fastest global
   stop for new generation and is rechecked before worker dispatch.
2. For a Quality-only incident, activate `media.model.image-quality.enabled=false`; keep Standard Edit
   only if financial, privacy, moderation, and shared infrastructure remain healthy.
3. For a Standard-only incident, activate `media.model.image-fast.enabled=false`. If Quality depends
   on shared or uncertain infrastructure, disable Quality Edit too.
4. Set deployment flags `MEDIA_GENERATION_ENABLED=false`, `MEDIA_STANDARD_EDIT_ENABLED=false`, and
   `MEDIA_QUALITY_EDIT_ENABLED=false` in the next controlled configuration revision. An environment
   flag set to false cannot be overridden back on by PostgreSQL.
5. Disable new paid checkout if the incident affects prices, Webhooks, credits, refunds, legal terms,
   or entitlement. Do not cancel existing subscriptions or fabricate refunds.
6. Freeze traffic expansion and notify the incident, Provider, billing, privacy, and operations owners.

The global daily Provider budget is an admission ceiling, not a recovery tool. Lowering it blocks new
jobs but must not release a reservation for an uncertain accepted attempt.

## Preserve and drain durable work

Classify every nonterminal job as pre-submission, confirmed Provider work, uncertain acceptance, or
post-Provider finalization. Use the existing admin diagnostics and audit paths.

- Pre-submission work may be safely retried or released only through its normal idempotent command.
- Confirmed Provider work continues through the same attempt, private transfer, moderation, and
  settlement path unless the Provider supports an audited cancellation.
- Uncertain work keeps credits reserved. Reconcile the same attempt; do not fail over or let the user
  cancel until an audited accepted/rejected decision is durable.
- Release expired leases and replay only persisted events after the cause is corrected. Outbox and
  Webhook dedupe keys must remain unchanged.
- Let verified payment events, billing grants, refunds, cleanup, and reconciliation drain. Never fix
  them with direct database edits.

Record queue depth, oldest pending/dead-letter Outbox age, uncertain attempts, Provider callbacks,
PaymentEvents, storage transfers, moderation states, and invariant results before and after the drain.

## Application and task rollback

1. Prefer a forward fix for additive database changes. Confirm the target application revision is
   compatible with every applied migration and every durable payload already written.
2. Deploy the previously certified application revision by exact SHA. Do not rebase or rebuild an
   unrecorded tree.
3. Deploy the matching Trigger.dev task revision. A web rollback with newer incompatible workers, or
   the reverse, is not complete.
4. Keep all generation switches off. Verify `/api/health`, production `/api/ready`, migration state,
   private storage metadata, Trigger task registration, Webhook verification, Sentry release, and mail.
5. Run reconciliation and invariant checks. Confirm no duplicate job, attempt, settlement, refund,
   grant, cleanup, or event projection was introduced.
6. Run bounded smoke against the rollback revision. Local/mock smoke is diagnostic only and cannot
   replace staging evidence.

## Restoration order

Restore service only after the cause and durable state are understood:

1. remove or roll back the specific audited runtime override;
2. enable Standard Edit for a small cohort and retain the daily Provider budget;
3. observe errors, p50/p95, moderation, Outbox, settlement, billed cost, Stripe, storage, and alerts;
4. expand Standard traffic gradually;
5. enable Quality Edit independently only after its own certification and approval;
6. restart the 24–72 hour monitoring window after any material rollback or re-enable action.

## Rollback verification record

| Evidence                                                       | Status          |
| -------------------------------------------------------------- | --------------- |
| Global and product kill switches exercised in isolated staging | `NOT_COMPLETED` |
| Queue, Provider attempt, Webhook, and Outbox drain verified    | `NOT_COMPLETED` |
| Credit/payment/storage/moderation invariants verified          | `NOT_COMPLETED` |
| Previous web and Trigger revisions restored by exact SHA       | `NOT_COMPLETED` |
| Production-like smoke and readiness passed                     | `NOT_COMPLETED` |
| Alert delivery and monitoring restarted                        | `NOT_COMPLETED` |
| Recovery time and operator approval recorded                   | `NOT_COMPLETED` |

Do not declare the rollback complete until every row is `PASS` for the drill or incident environment.
Detailed recovery, refund/Debt, cleanup, backup, and rotation procedures remain in
`ai-media-runbook.md`.
