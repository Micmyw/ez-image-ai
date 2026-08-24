# AI media operator runbook

This runbook is for the production AI image/video subscription foundation. PostgreSQL is the business source of truth. Trigger.dev, Stripe, providers, S3/R2, Sightengine, and Sentry are external systems whose successful local mock tests do not prove live connectivity.

## 1. Accounts and environment

Prepare separate production and staging accounts/projects for PostgreSQL, Trigger.dev, Stripe, private S3/R2-compatible storage, Sentry, Sightengine, and every enabled provider (Replicate, Fal, Kie, Gemini). Restrict production access with SSO/MFA and least-privilege service identities.

Start from `.env.local.example`. Production must use `NODE_ENV=production`, non-mock `MEDIA_PROVIDER_ADAPTER`, `MEDIA_SAFETY_ADAPTER=sightengine`, strong Better Auth and Webhook secrets, and HTTPS SaaS/marketing origins. `MEDIA_BUCKET_NAME` is authoritative; `S3_BUCKET` is unsupported. Keep server secrets out of `NEXT_PUBLIC_*` values and the repository.

Feature gates:

- `MEDIA_GENERATION_ENABLED`: global generation kill switch.
- `LEGACY_AI_STREAM_ENABLED`: development-only compatibility route; production always rejects the legacy unmetered AI stream.
- `MEDIA_MODERATION_ENABLED`: required before public/user-visible generated output.
- `BILLING_ENABLED`: validated billing configuration only. It is not currently wired as an
  ingress, worker, queue, or schedule kill switch and must not be used to coordinate the F6
  cutover; pause those execution paths with the actual deployment and Trigger controls.
- `ERROR_MONITORING_ENABLED`: Sentry emission.
- `MEDIA_*_QUEUE_LIMIT` and provider/model limits: shed load without changing stored jobs.

Before release, validate environment parsing, verify that the selected Provider credential exists, and confirm public origins exactly match deployed origins. Do not run production with mock/test adapters.

## 2. Database migration and backup

Take a restorable PostgreSQL backup before every production schema change and record its checksum, database version, migration SHA, and restore target. Restore the backup into an isolated environment at least quarterly.

For an empty database:

```bash
DATABASE_URL=<empty-database-url> pnpm db:migrate:deploy
DATABASE_URL=<empty-database-url> pnpm db:migrate:drift
```

For an existing Supastarter deployment, do not blindly apply the initial foundation migration. Follow `packages/database/prisma/migrations/README.md`: diff the real database, review the deployment-specific SQL, test it against a restored staging copy, verify invariants, then baseline only after the schema exists. A clean Prisma diff is not sufficient baseline evidence because Prisma does not fully model the raw SQL invariants in the migration history. Before `migrate resolve --applied`, compare `pg_constraint`, `pg_trigger`, and `pg_indexes` with the committed migration SQL and explicitly prove that the named credit/account/lot/reservation/allocation CHECK constraints and the `credit_ledger_entry_immutable` trigger exist and are enabled. Apply any missing raw invariant through reviewed deployment-specific SQL before baselining; otherwise later migrations can fail or the database can silently lose ledger protections. A drift result or missing raw invariant is a release blocker.

Rollback application code by redeploying the previous immutable image. Prefer forward database repairs; do not reverse a migration that could discard business data. If a schema change is incompatible, disable generation/billing, restore into a new database, validate, and atomically switch the application connection under an approved incident plan.

## 3. Trigger.dev deployment

Create separate Trigger projects/environments and configure `TRIGGER_PROJECT_REF` plus the protected `TRIGGER_SECRET_KEY`. CI's local Trigger build requires its own protected personal access token; it never uses a provider key.

Deploy to staging first:

```bash
pnpm trigger:type-check
pnpm exec trigger deploy --env staging
```

Confirm task registration for dispatch, provider event processing, generation reconciliation/finalization/settlement, payment event processing, billing grants, subscription reconciliation, upload verification, object cleanup, and outbox delivery. Trigger delivery IDs are operational hints, not domain state; PostgreSQL jobs, attempts, events, reservations, and Outbox rows remain authoritative. Submit one mock staging job, watch it settle, then promote/deploy the same commit to production. If tasks stop consuming, disable new generation, inspect Outbox lag/dead letters and Trigger run errors, then replay only persisted events.

## 4. Private S3/R2 storage

The media bucket must be private with public listing and anonymous object reads disabled. Grant the application only the required bucket/object actions: multipart create/upload/list/complete/abort, put/get/head/delete, and signed URL operations for the one media bucket/prefix. Deny other buckets and administrative operations.

Configure CORS for exact SaaS and marketing origins, permitted `GET`, `HEAD`, and `PUT` methods, required request headers, and exposed `ETag`; do not use wildcard origins with credentials. Set deployment-wide `MEDIA_MAX_ACTIVE_UPLOAD_SESSIONS` and `MEDIA_MAX_STORAGE_BYTES` to the desired per-owner limits. Upload sessions reserve expected bytes before signing; every multipart part number and content length must match that reservation, and validation failure must enqueue abort/delete cleanup. Validate multipart upload, abort, signed preview/download expiry, streaming Provider transfer, soft delete followed by physical cleanup, quota release, and lifecycle cleanup of abandoned multipart uploads. Alerts must cover cleanup dead letters and unexpected storage growth.

## 5. Stripe and credit lifecycle

Create monthly/yearly Creator and Studio prices and set all four price IDs. Configure the Webhook endpoint with only required events and store its signing secret. Validate signatures against the raw body. The Webhook request only persists the PaymentEvent and Outbox record; workers perform mutation.

Test in Stripe test mode: checkout return, monthly renew, annual purchase split into 12 internal periods, plan A to B to A, payment failure/recovery, cancellation, partial refund, full refund, future period voiding, and refund debt after consumed credits. Reconcile Stripe subscriptions on schedule. Never directly edit credit balances; use immutable ledger commands and reference keys.

The F6 Stripe refund/reconciliation migration is a coordinated stop-the-world cutover for the old billing code. Use this order:

1. Stop the old Stripe Webhook endpoint/ingress and return a retryable non-success response so Stripe retains deliveries. Pause the old payment-event Trigger queue plus the billing-grant and subscription-reconciliation schedules using the deployed ingress and Trigger environment controls, then wait for every in-flight old worker invocation and processing lease to drain. Do not rely on `BILLING_ENABLED`; it does not stop those paths.
2. Take and verify the database backup, then apply the reviewed migrations through `20260823018000_stripe_refund_repair_authority` (including the 160 reconciliation schema and 170 continuation sequence). Do not allow the old code to run after the transaction-level uniqueness change is applied.
3. Deploy the new application and Trigger task code, verify the schema/raw invariants, the authority/receipt immutability triggers, and task registration, and keep external Stripe delivery paused until those checks pass. Before the first new reconciliation sweep, capture the complete read-only historical-refund diagnostic and open incident records for every reported refund ID. Reconciliation should replace `MISSING_LIFECYCLE` with the current lifecycle classification; non-succeeded or inconsistent legacy refunds must remain visible until reviewed.
4. Resume the new workers and Webhook ingress, drain persisted/retried PaymentEvents, and immediately run a bounded Stripe reconciliation sweep. Confirm the checkpoint completes, inspect open needs-review issues, follow the captured historical-refund cases through the forward-repair workflow below, and monitor at least one full reconciliation interval.

If the old Webhook/worker processes cannot be proven stopped, abort the migration. Letting old `refund.created` handling overlap the new schema can revoke credits for a non-terminal refund.

Refund debt means previously consumed credits were refunded externally. Keep the account debt visible to operations and allow future grants to repay it. Investigate any account/lot/reservation mismatch before granting manual credits.

## 6. Moderation, Sentry, and model certification

Set Sightengine credentials and enable moderation. Validate allow, reject/quarantine, review/error, and timeout behavior using non-sensitive fixtures. Outputs without an approved moderation result must not become usable assets.

Configure Sentry release/environment metadata, server and browser DSNs where applicable, a conservative trace sample rate, and alert routing. Confirm redaction excludes prompts, provider envelopes, authorization/cookie headers, secrets, raw signed URLs, and private object keys. Alerts should cover provider failures, queue latency, transfer failures, moderation errors, credit invariant failures, Outbox backlog/dead letters, reconciliation repairs, and elevated API errors.

Certify each catalog route in staging before enabling it: schema/input support, idempotency behavior, provider acceptance certainty, status mapping, output MIME/size, Webhook authenticity/order, polling recovery, cancellation/cleanup, moderation, measured cost, latency, and error redaction. Record Provider/model ID, catalog/pricing version, test time, evidence, maximum cost, and rollback owner. Disable an uncertified route with runtime config rather than silently rerouting uncertain submissions.

## 7. Smoke, load, and invariants

PR CI never calls paid providers. Run `.github/workflows/provider-smoke.yml` in the protected `provider-smoke` environment. Its route allowlist, invocation cap, and expected-cost cap are mandatory and checked before network calls. Scheduled smoke is disabled in practice until all three protected schedule variables are set. The workflow attempts cancellation cleanup; synchronous successful outputs may still require provider-console retention cleanup according to provider policy.

Load tests require a dedicated staging-equivalent environment, mock Provider modes, disposable accounts, and an isolated PostgreSQL database. Supported modes are fast success, long-running, duplicate Webhook, dropped Webhook, uncertain submission, slow transfer, moderation rejection, and Provider failure.

```bash
LOAD_PROFILE=smoke pnpm load:media
LOAD_PROFILE=steady pnpm load:media
LOAD_PROFILE=peak pnpm load:media
LOAD_PROFILE=active-1000 LOAD_DURATION=5m pnpm load:media
REQUIRE_LOAD_SAMPLE=true pnpm verify:invariants
```

The verifier scopes job/outbox/latency checks to `INVARIANT_JOB_PREFIX` (`k6:` by default) so unrelated fixtures do not become load evidence. Use a unique prefix when retaining multiple load campaigns.

Acceptance thresholds are create API P95 below 800 ms and internal queue P95 below five seconds. After load, invariant verification must show one job per idempotency key, one terminal credit mutation per reservation, conserved account/lot/reservation balances, and no missing initial/Webhook Outbox record. A zero-traffic load run is not passing evidence; set `REQUIRE_LOAD_SAMPLE=true` for acceptance.

Remote load is blocked unless `ALLOW_REMOTE_LOAD_TARGET=true` and `LOAD_TARGET_CONFIRMATION` exactly equals the target origin. Never point load scripts or `TEST_DATABASE_URL` at production.

## 8. Replay, reconciliation, cleanup, and diagnostics

Use admin diagnostics and stored audit identifiers, not raw database edits. Safe actions are replaying a persisted event, retrying an idempotent stage, running reconciliation, disabling a model, reducing concurrency, or turning off generation. Each action needs an operator, reason, timestamp, aggregate ID, prior state, result, and correlation ID.

- Outbox: release an expired lease or replay a pending/dead-letter event only after the cause is fixed. Dedupe keys prevent duplicate side effects.
- Provider Webhook: replay the persisted verified event. Never fabricate or weaken signature verification.
- Uncertain submission: keep its reservation frozen, block user cancellation, and reconcile the same attempt; do not fail over while the Provider may have accepted it. After bounded automated recovery, an administrator must record evidence and decide `ACCEPTED` or `REJECTED`. `ACCEPTED` requires Provider-specific recovery identifiers/endpoints; `REJECTED` releases the full reservation and charges zero. Both actions are locked, idempotent, and audited.
- Finalization/transfer/moderation: retry the failed stage; do not create another paid submission.
- PaymentEvent: replay the verified persisted Stripe event after lease expiry/cause repair.
- Object cleanup: replay `MEDIA_OBJECT_DELETE` or `MEDIA_MULTIPART_ABORT`. Object-not-found and `NoSuchUpload` are idempotent success conditions.

### Stripe reconciliation diagnostics

The admin diagnostics response exposes a bounded, redacted `stripeReconciliation` summary:

- `checkpoint` reports Provider, status, stage, processed page and failure counts, cutoff, last attempt/completion, the stable last error code, and the derived `hasCursor` and `leaseActive` flags.
- `issues.openCount` reports the complete number of open needs-review records. `issues.items` contains at most 25 recent records and only code, entity type, Provider object ID, stage, occurrence count, and first/last seen timestamps.
- `historicalRefunds.needsReviewCount` counts legacy `stripe-refund:<refund-id>:<period-id>` refund-ledger groups whose lifecycle is missing, non-succeeded, not finalized, or accounts for fewer credits than the immutable refund ledger. A lifecycle can legitimately finalize more credits than it writes to the ledger when future ungranted annual periods are reduced in place before they become grants. `missingLifecycleCount` is the missing-lifecycle subset. `items` contains at most 25 recent groups and only a stable reason, refund ID/status, ledger-entry/credit totals, lifecycle finalized-credit evidence, and first/last ledger timestamps. Projection-only contamination has no immutable refund-ledger group, so it appears through the open reconciliation issue after the affected refund is observed rather than in this historical-ledger list.

The response never exposes a reconciliation cursor, lease token, issue details, raw Provider error, Stripe envelope, or credit-ledger metadata. Treat `hasCursor` and `leaseActive` as operational hints; PostgreSQL checkpoint and lifecycle rows remain authoritative.

### Legacy Stripe refund forward repair

The historical refund diagnostic is a detector, not permission for an automatic repair. It exists because an older processor could apply a refund ledger mutation or mark future ungranted annual periods as refunded before a refund reached final `SUCCEEDED` state. Never infer the current refund state from the legacy ledger reference, and never update/delete an immutable ledger row. Before accepting any refund fact—including `PENDING`, `REQUIRES_ACTION`, `FAILED`, or `CANCELED`—the reducer compares the whole charge's actual `refundedCredits` projection with the sum finalized by authenticated `SUCCEEDED` refund lifecycles and also checks unsupported legacy refund-ledger evidence. Any excess fails closed with `STRIPE_LEGACY_REFUND_REPAIR_REQUIRED` instead of being reported as processed. Webhook processing dead-letters that event with the stable code; reconciliation persists the observed lifecycle, records a needs-review issue, and continues its bounded sweep. Do not replay the event until the whole charge has completed the forward-repair workflow below, because polluted cumulative period totals can otherwise hide an invalid early reversal or under-revoke a later legitimate refund.

Use a read-only database role (preferably against a current replica or restored incident snapshot) when the bounded admin list is insufficient:

```sql
WITH legacy_refund AS (
  SELECT split_part(entry."referenceKey", ':', 2) AS "providerRefundId",
         COUNT(*)::bigint AS "ledgerEntryCount",
         SUM(entry."amount")::bigint AS "ledgerCredits",
         MIN(entry."createdAt") AS "firstLedgerAt",
         MAX(entry."createdAt") AS "lastLedgerAt"
  FROM "credit_ledger_entry" entry
  WHERE entry."type" = 'REFUND'
    AND entry."referenceKey" LIKE 'stripe-refund:%'
    AND entry."referenceKey" ~ '^stripe-refund:re_[A-Za-z0-9_-]+:[^:]+$'
  GROUP BY split_part(entry."referenceKey", ':', 2)
)
SELECT legacy."providerRefundId",
       refund."status"::text AS "lifecycleStatus",
       legacy."ledgerEntryCount",
       legacy."ledgerCredits",
       refund."finalizedCredits",
       refund."creditsFinalizedAt",
       legacy."firstLedgerAt",
       legacy."lastLedgerAt"
FROM legacy_refund legacy
LEFT JOIN "stripe_refund" refund
  ON refund."provider" = 'stripe'
 AND refund."providerRefundId" = legacy."providerRefundId"
WHERE refund."id" IS NULL
   OR refund."status" <> 'SUCCEEDED'
   OR refund."creditsFinalizedAt" IS NULL
   OR refund."finalizedCredits" < legacy."ledgerCredits"
ORDER BY legacy."lastLedgerAt" DESC,
         legacy."providerRefundId" DESC;
```

For every reported refund ID:

1. Open an incident/change record with environment, refund ID, charge/invoice, account owner, two distinct administrators, and database snapshot reference. If exposure is ongoing, disable billing mutations before investigation.
2. Run a bounded Stripe reconciliation sweep to persist Stripe's current refund lifecycle. Confirm the sweep checkpoint completed and that the exact open issue key is `stripe:REFUND:<refund-id>:STRIPE_LEGACY_REFUND_REPAIR_REQUIRED`; do not create a `StripeRefund` or issue row by hand. This code is an intentional freeze, not a retryable Provider outage.
3. Verify the current Stripe refund status and cumulative successful refund amount for the whole charge, then compare the normalized lifecycle, every charge-bound billing period, the total `refundedCredits` projection, the sum of finalized successful refund credits, immutable refund ledger entries, credit lots, active reservations, and account debt. Include future ungranted annual periods; they may carry a refund projection without a Grant or refund-ledger row. A dashboard screenshot alone is not sufficient evidence. Record the exact `lastProviderChangeId`, legacy ledger credit total, complete period projection, and database snapshot used for approval.
4. If the refund is `PENDING` or `REQUIRES_ACTION`, the repair service rejects approval. Keep the issue open and re-evaluate after Stripe reaches a terminal result. If ownership, charge binding, amount, account, or Provider state is ambiguous, leave the issue open and escalate.
5. Choose only the action supported by the verified terminal state:
   - `CONFIRM_SUCCEEDED` is allowed only when Stripe is `SUCCEEDED` and the existing full-charge projection is the correct final credit result. It records the complete projected credit total—including future ungranted annual periods—as finalization evidence without appending another refund mutation.
   - `COMPENSATE_FAILED_OR_CANCELED` is allowed only when Stripe is `FAILED` or `CANCELED`. It appends idempotent grant/debt-repayment compensation only for credits represented by immutable legacy refund entries, restores every affected billing-period projection in the same transaction, and immediately expires any restored lot whose original period has ended. Future ungranted periods are restored without fabricating a Grant.
   - A succeeded but incorrectly sized legacy reversal is not repaired by either action. Keep it open and require a separately designed, reviewed forward repair.
   - Multiple refund IDs, multiple invoice/owner/account bindings, or any projection that cannot be attributed to one exact charge snapshot fails closed and requires a separately reviewed repair design.
6. Administrator A calls `POST /api/admin/payments/stripe-refund-repairs/approve` with `providerRefundId`, the exact `issueKey`, `action`, `expectedLastProviderChangeId`, decimal-string `expectedCredits`, a stable `approvalKey`, and a 10-500 character reason. `expectedCredits` is the immutable legacy refund-ledger total, not necessarily the larger full annual projection; both values must be recorded in the incident. The server derives the administrator from the authenticated session and stores an immutable authority containing the lifecycle status/time, the legacy ledger total, a fingerprint over the complete charge/owner/account/invoice/period projection, the issue, reason, and actor. An active unresolved revocation reservation blocks failed/canceled compensation approval. If that exact charge snapshot changes before execution, application rejects the stale authority; re-investigate and create a new approval against the new fingerprint. The prior immutable authority remains evidence and cannot be reused or edited.
7. Administrator B, using a different user ID, calls `POST /api/admin/payments/stripe-refund-repairs/apply` with the approved `approvalKey`, a stable `idempotencyKey`, and a 10-500 character execution reason. The transaction re-locks the refund/charge, revalidates the complete lifecycle and ledger snapshot, applies the authorized action, resolves only the bound open issue, and inserts an immutable receipt and audit log. Reusing an operation key with another approval, actor, or reason is an idempotency conflict.
8. Retain the authority and receipt IDs in the incident. PostgreSQL rejects update/delete of either record and restricts their refund/issue foreign keys. Never bypass the endpoints with direct account, lot, billing-period, issue, authority, receipt, or ledger SQL.
9. Re-run reconciliation and admin diagnostics, replay any now-unblocked persisted event, and verify ledger/account/lot/reservation invariants. Confirm the operation replay returns the same receipt and that later legitimate refunds on the charge no longer inherit the legacy pollution. This local mechanism is not production evidence until exercised under the approved staging/Stripe test-mode runbook.

### Historical Purchase ownership validation

The `purchase_exactly_one_owner` CHECK is deliberately installed `NOT VALID`: it protects new writes without guessing how to repair older zero-owner or dual-owner rows. A Prisma schema diff cannot prove that historical rows satisfy it. Use a read-only role to list only safe diagnostic fields:

```sql
SELECT purchase."id" AS "purchaseId",
       (purchase."userId" IS NOT NULL) AS "hasUser",
       (purchase."organizationId" IS NOT NULL) AS "hasOrganization",
       purchase."type"::text AS "type",
       purchase."status"
FROM "purchase" purchase
WHERE num_nonnulls(purchase."organizationId", purchase."userId") <> 1
ORDER BY purchase."updatedAt" DESC, purchase."id" DESC;
```

Do not include `customerId`, actual owner IDs, Stripe payloads, or secrets in the diagnostic output. For every row, verify internal membership/audit evidence and the current Stripe customer/subscription with a second approver. Do not infer ownership from whichever nullable field happens to be populated. Apply an approved ownership repair as a separate audited, backed-up change; then prove the query returns zero rows in staging and production before running:

```sql
ALTER TABLE "purchase"
  VALIDATE CONSTRAINT "purchase_exactly_one_owner";
```

An unresolved row blocks constraint validation and remains an explicit data-quality incident; it is not permission to drop or weaken the constraint.

If invariants fail, disable generation and billing mutations, preserve the database and logs, capture verifier output, and escalate. Do not compensate with ad-hoc balance updates.

## 9. Secret rotation

Rotate one integration at a time in staging, then production. Use overlap where the provider supports multiple keys. Update the secret manager and worker/app deployments, verify health/smoke, revoke the old secret, and record completion. Webhook secret rotation must account for in-flight deliveries; keep old verification material only for the documented overlap window. Rotate database/storage credentials by creating a new least-privilege identity before revoking the old one.

Immediately rotate any secret suspected of exposure. Search logs/artifacts and Provider consoles for use, revoke sessions/tokens, and preserve evidence. Never paste secret values into tickets or Sentry.

## 10. Incident triage

1. Declare severity, incident lead, affected environment, first bad deployment, and correlation IDs.
2. Protect money/data first: disable billing or generation as needed; reduce queue limits for overload.
3. Check API error rate and latency, PostgreSQL health/locks, Trigger queues/runs, Outbox backlog/dead letters, provider status/cost, transfer throughput, moderation, and storage.
4. Distinguish delayed work from lost work using PostgreSQL job/event/outbox records. Do not infer success from Provider dashboards alone.
5. Prefer bounded replay/reconciliation and runtime kill switches. Roll back app code only to a schema-compatible release.
6. Verify recovery with fresh requests, worker drain, invariants, and external dashboards. Monitor at least one full reconciliation interval.
7. Document impact, cost/refund exposure, timeline, root cause, remediation, and tests/alerts added.

The deterministic production-build browser suite currently covers nine authenticated SaaS media workflows and two marketing draft-handoff workflows with no skips. Live readiness remains blocked until credentials/accounts exist and recorded checks pass for Trigger deploy, Stripe Webhook delivery, each enabled Provider, Sightengine, private S3/R2 streaming/multipart, Sentry ingestion/alerts, and staging load. Local browser tests, mocks, contracts, PostgreSQL integration tests, production builds, and a dry-run Provider smoke must be reported separately from those live checks.
