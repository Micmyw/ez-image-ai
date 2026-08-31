# EzPic launch checklist

## Status rule

Every row must be `PASS` or `NOT_COMPLETED` and must carry evidence. `PASS` means the named evidence
was collected for the exact deployment revision and environment; local mocks or dry runs cannot be
used for an external row. The committed record is deliberately not a launch approval.

## Local release-contract gates

| Gate                                                                                                                                                    | Status          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production configuration rejects mock/test adapters, placeholder or split public origins, missing external contracts, kill switches, budget, and alerts | `PASS`          | `packages/config/production-launch.test.ts`                                                                                                                                                                                                                                                                                                                                                                              |
| Dev/test/staging/production resource matrix requires distinct database, bucket, Stripe Webhook, Trigger, PostHog, Sentry, and mail identifiers          | `PASS`          | `packages/config/production-launch.test.ts`; committed template remains intentionally incomplete                                                                                                                                                                                                                                                                                                                         |
| Global daily Provider budget is checked prospectively and atomically across owners                                                                      | `PASS`          | authorization tests and `media.integration.test.ts` concurrency test                                                                                                                                                                                                                                                                                                                                                     |
| Standard and Quality environment flags reach API routing and late worker admission                                                                      | `PASS`          | catalog/API/jobs focused tests                                                                                                                                                                                                                                                                                                                                                                                           |
| Remote load requires opt-in, allowlist, single-origin confirmation, staging identity, request/error/P95 budgets, and Provider spend confirmation        | `PASS`          | `packages/config/production-load.test.ts` and `tests/load/ezpic-production.js` syntax contract                                                                                                                                                                                                                                                                                                                           |
| 20 staging scenarios have a strict schema and cannot certify with missing evidence or revision                                                          | `PASS`          | `packages/config/launch-evidence.test.ts`                                                                                                                                                                                                                                                                                                                                                                                |
| Production readiness includes the launch contract and returns a safe 503                                                                                | `PASS`          | `packages/api/request-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| Consent-gated PostHog sender and same-origin public-to-product anonymous hash handoff reject sensitive data and URL leakage                             | `PASS`          | SaaS and utils focused tests                                                                                                                                                                                                                                                                                                                                                                                             |
| Full workspace format, lint, uncached type-check, tests, invariants, build, and production-mode Playwright                                              | `NOT_COMPLETED` | Local final gates: format/check PASS; zero-warning lint PASS; uncached type-check 21/21; unit/contracts 930/930; affected database integration 15/15; invariants 9/9; standalone Docs/Marketing/SaaS production builds PASS; production Playwright SaaS 15/15 and Marketing 21/21. Root `pnpm build` remains NOT_COMPLETED after two Windows Turbopack junction failures (OS error 80), and final-commit CI has not run. |

## External and operational gates

| Gate                                                                                             | Status          | Required non-secret evidence                                                                                 |
| ------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------ |
| Real PostgreSQL migration, backup, isolated restore, and production readiness                    | `NOT_COMPLETED` | Environment/database resource name, version, migration revision, backup/restore artifact                     |
| Trigger.dev Cloud task deployment, queues, delivery, replay, and recovery                        | `NOT_COMPLETED` | Project/environment name, deployed revision, redacted run references                                         |
| Private S3/R2 IAM, CORS, lifecycle, multipart upload, streamed transfer, signed URL, and cleanup | `NOT_COMPLETED` | Endpoint origin, bucket resource name, policy versions, redacted operation references                        |
| Standard Edit real Provider certification                                                        | `NOT_COMPLETED` | Internal route certification, bounded smoke/benchmark, billed cost, p50/p95, failure/recovery evidence       |
| Quality Edit independent real Provider certification                                             | `NOT_COMPLETED` | Separate route certification, bounded spend, quality review, billed cost, p50/p95, rollback evidence         |
| Prompt, input, and output production moderation                                                  | `NOT_COMPLETED` | Service environment, rule/policy versions, allow/reject/error references, alert receipt                      |
| Stripe test-mode complete billing period and lifecycle                                           | `NOT_COMPLETED` | Product/Price scope, Webhook endpoint name, checkout/renewal/annual grant/cancel/replay/refund/Debt evidence |
| Stripe live configuration, seller identity, tax and refund approval                              | `NOT_COMPLETED` | Approved account/scope names and legal/compliance sign-off                                                   |
| Sentry ingestion, release correlation, privacy review, and alert arrival                         | `NOT_COMPLETED` | Project/environment, release, redacted event, rule, destination receipt                                      |
| PostHog actual ingestion and consented anonymous same-origin funnel                              | `NOT_COMPLETED` | Project ID and public/product event references sharing one `sha256:` anonymous identifier                    |
| GSC, canonical, sitemap, robots, domain, DNS, and SSL                                            | `NOT_COMPLETED` | Property and origin, verification/submission/crawl references, DNS/SSL observation                           |
| Mail Provider sender verification, delivery, bounce, and auth mail flows                         | `NOT_COMPLETED` | Provider environment, sender domain, redacted delivery/bounce references                                     |
| Six-surface k6 staging load and post-run invariants                                              | `NOT_COMPLETED` | Run ID, exact origins, profile, request/error/P95 budgets, k6 summary, invariant report                      |
| Real successful-edit cost, full-use Creator/Studio cost, and margin approval                     | `NOT_COMPLETED` | Billed cost dataset, formula output, approved threshold and reviewer                                         |
| Controlled production deployment and Standard-only cohort                                        | `NOT_COMPLETED` | Deployment revision, readiness evidence, cohort size, switches, operator and timestamp                       |
| Quality independent enablement                                                                   | `NOT_COMPLETED` | Quality certification, approval, switch revision, cohort and rollback owner                                  |
| 24–72 hour monitoring record                                                                     | `NOT_COMPLETED` | Daily snapshots for tasks, payments, cost, moderation, storage, errors, latency, analytics and decisions     |
| Recovery and rollback drill                                                                      | `NOT_COMPLETED` | Drill timeline, kill-switch action, queue/Outbox drain, restored revision, invariants and recovery time      |

## 20 staging scenarios

The executable source is `evidence/ezpic-staging-evidence.json`; each row below is currently
`NOT_COMPLETED` and needs evidence for the exact `deploymentRevision`.

|   # | Scenario                                          | Status          | Evidence needed                                                          |
| --: | ------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
|   1 | Registration, verification, login, draft recovery | `NOT_COMPLETED` | Mail reference and redacted production-build Playwright trace            |
|   2 | Standard success                                  | `NOT_COMPLETED` | Provider/Trigger/job/reservation/private output/cost references          |
|   3 | Quality success                                   | `NOT_COMPLETED` | Independent route, quality review, latency and billed-cost references    |
|   4 | Explicit Provider failure and credit release      | `NOT_COMPLETED` | Terminal failure plus immutable release/Ledger/Outbox evidence           |
|   5 | Timeout or uncertain submission recovery          | `NOT_COMPLETED` | Same-attempt recovery, retained reservation, audited decision and replay |
|   6 | Moderation rejection                              | `NOT_COMPLETED` | Prompt/output rejection, quarantine and zero-charge evidence             |
|   7 | Cancelable job cancellation                       | `NOT_COMPLETED` | Provider cancellation, cleanup and one terminal credit mutation          |
|   8 | Before/After and signed download                  | `NOT_COMPLETED` | Owner-scoped UI plus redacted short-lived URL metadata                   |
|   9 | Edit Again for three rounds                       | `NOT_COMPLETED` | Private owned session and parent/version chain                           |
|  10 | Checkout                                          | `NOT_COMPLETED` | Stripe test Checkout, verified raw event, Outbox and Purchase projection |
|  11 | Monthly credits                                   | `NOT_COMPLETED` | Renewal Billing Period, Lot and Ledger references                        |
|  12 | Annual internal monthly credits                   | `NOT_COMPLETED` | Annual purchase and separate monthly grant references                    |
|  13 | Subscription cancellation                         | `NOT_COMPLETED` | Portal/cancel event and effective entitlement projection                 |
|  14 | Partial/full refund and Debt                      | `NOT_COMPLETED` | Refund ledger, Debt, repayment and replay evidence                       |
|  15 | Webhook replay                                    | `NOT_COMPLETED` | Stable raw-event, Outbox, projection and ledger identities               |
|  16 | Reconciliation recovery                           | `NOT_COMPLETED` | Missed event, checkpoint, repair and no-duplicate proof                  |
|  17 | Asset soft delete and physical cleanup            | `NOT_COMPLETED` | Private object metadata, cleanup event and deletion confirmation         |
|  18 | Global/product shutdown                           | `NOT_COMPLETED` | Global, Standard and Quality switch behavior including late worker gate  |
|  19 | Sentry alert                                      | `NOT_COMPLETED` | Redacted event, release, rule and destination receipt                    |
|  20 | Recovery and rollback drill                       | `NOT_COMPLETED` | Timeline, revisions, drain, invariants, smoke and recovery time          |

## Final authorization

- Deployment revision: `NOT_COMPLETED`
- Release approver: `NOT_COMPLETED`
- Privacy approver: `NOT_COMPLETED`
- Billing/margin approver: `NOT_COMPLETED`
- Incident and rollback owner: `NOT_COMPLETED`
- Public launch decision: `NOT_COMPLETED`
