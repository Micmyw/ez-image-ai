# Production payment configuration and same-database cutover

The operator chose to reuse the existing Supabase database. No Supabase project was created,
upgraded, paused or deleted. Production collection remains disabled while Waffo's new EzPic store
requires review and real payment/refund evidence has not been collected.

## Merchant configuration

- PayPal: the `EzPic Production` Live application authenticated against `api-m.paypal.com`.
  Three parent products, six ACTIVE subscription plans and four Credit Pack products were created
  and read back. Prices, USD currency, month/year intervals, unlimited renewal, no trial/setup fee
  and payment preferences matched the server catalog. Credit Pack checkout prices are owned by
  the server's Orders v2 request, not by PayPal Catalog product records.
- Waffo: a dedicated EzPic store and production key were created. All six subscription products and
  four packs were read back with their production versions and correct prices/intervals. Domain
  ownership was verified. The separate approved LinkPatch store and its products were preserved.
  The EzPic store still reported `prodEnabled=false`; key/product creation does not approve collection.
- Both production webhook registrations point to `https://ezimageai.com/api/webhooks/payments`, with
  all 11 events supported by each adapter. The Waffo verification key is the SDK 0.19.1 production
  public key, not its test key.

## Database operation

Applied Prisma migration `20260915153905_generation_billing_archive`, followed by the reviewed
`archive_test_billing_dataset_20260915` operation on the existing database. The operation archived
the original 24 financial/Outbox tables under `billing_test_20260915`, retained all financial rows,
recreated empty active tables and inserted 20 live BillingPlan snapshots.

Post-operation reads confirmed:

| Record                                              | Result                                                |
| --------------------------------------------------- | ----------------------------------------------------- |
| Accounts                                            | 2 users retained                                      |
| Private media                                       | 11 assets retained                                    |
| Generation history                                  | 9 jobs and their original settlement amounts retained |
| Original credit ledger                              | 27 entries retained in the archive                    |
| Original test balance/debt                          | 9,100 spendable / 35 debt retained in the archive     |
| Active credit accounts/subscriptions/payment events | 0 / 0 / 0 immediately after cutover                   |
| Active provider snapshots                           | 20, with explicit Live/Prod provenance                |
| Application access to archive                       | Denied                                                |

All 58 application tables were backed up and restored before execution. The frozen dump SHA-256 is
`41ea7e46451868cf70a822630e52ad2da47795cdbae84d4c3cef7662197dc147`.
Original passwords, sessions, media object keys and provider payloads remain in private backups;
they are not committed here. The archive receipt preserves the exact reviewed table fingerprints.

The operation does not claim the original sandbox recurring contracts are closed. Their observed
states, including the pending Waffo refund termination, remain in the archived dataset. No historical
event was relabeled as a live payment, no refund was repeated and no original debt was overwritten.

## Configuration and checks

The local production environment, `ezimageai-site-production`, `ezpic-workflows-workers-production`
and both Cloudflare Git build configurations received the production credentials, both environment
selectors, all 20 product/plan mappings and webhook settings. Runtime writes updated 32 named settings;
build settings used the existing encrypted multipart environment format. Local development still
uses its separate loopback PostgreSQL database and sandbox credentials.

The previous generation and guest gates and the `* * * * *` scheduler were restored. The payment
gate remains `BILLING_ENABLED=false`. Signed dispatch of each production reconciliation task was
accepted by the deployed Worker; both new environment scopes completed authenticated sweeps.
Read-only billing preflight passed 56/56 checks, including live dataset isolation, exact snapshots,
recent reconciliation, unresolved-state checks and authenticated provider reads.

Validation completed before publication:

- 17 PostgreSQL restore/archive/rollback checks passed. They covered data preservation, empty active
  test balances, RLS/grants, FK/trigger reconstruction, archived ledger and summary immutability,
  repeat-operation rejection and fail-closed behavior for incomplete or changed inputs.
- The new history regression checks failed with zero charges before the fix, then passed after it.
- Database, payment-provider and API unit suites passed: 74 + 202 + 481 = 757 tests.
- Full workspace type checking passed (22 tasks), together with root lint and formatting checks.
- Both production webhook endpoints rejected invalid PayPal/Waffo signatures with HTTP 400.
- Supabase security advisors reported informational RLS-without-policy notices only. That is the
  intended private backend-only access model, with no browser grants; no public access policy was added.

Git publication and code deployment are recorded separately when completed. Configuration writes and
these checks do not prove an actual live charge, cancellation or refund. Waffo approval and controlled
real-money verification remain `NOT_COMPLETED`; the first actual automatic renewal is also pending.
