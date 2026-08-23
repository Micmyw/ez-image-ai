# AI media operator runbook

This runbook is for the production AI image/video subscription foundation. PostgreSQL is the business source of truth. Trigger.dev, Stripe, providers, S3/R2, Sightengine, and Sentry are external systems whose successful local mock tests do not prove live connectivity.

## 1. Accounts and environment

Prepare separate production and staging accounts/projects for PostgreSQL, Trigger.dev, Stripe, private S3/R2-compatible storage, Sentry, Sightengine, and every enabled provider (Replicate, Fal, Kie, Gemini). Restrict production access with SSO/MFA and least-privilege service identities.

Start from `.env.local.example`. Production must use `NODE_ENV=production`, non-mock `MEDIA_PROVIDER_ADAPTER`, `MEDIA_SAFETY_ADAPTER=sightengine`, strong Better Auth and Webhook secrets, and HTTPS SaaS/marketing origins. `MEDIA_BUCKET_NAME` is authoritative; `S3_BUCKET` is unsupported. Keep server secrets out of `NEXT_PUBLIC_*` values and the repository.

Feature gates:

- `MEDIA_GENERATION_ENABLED`: global generation kill switch.
- `LEGACY_AI_STREAM_ENABLED`: development-only compatibility route; production always rejects the legacy unmetered AI stream.
- `MEDIA_MODERATION_ENABLED`: required before public/user-visible generated output.
- `BILLING_ENABLED`: Stripe checkout/Webhook/period processing.
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

For an existing Supastarter deployment, do not blindly apply the initial foundation migration. Follow `packages/database/prisma/migrations/README.md`: diff the real database, review the deployment-specific SQL, test it against a restored staging copy, verify invariants, then baseline only after the schema exists. A drift result is a release blocker.

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
