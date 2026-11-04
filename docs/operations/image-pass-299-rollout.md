# USD 2.99 three-image offer rollout

The owner approved USD 2.99 for any three successful images using all currently available image
models and resolutions, including Pro and 4K, without an additional subscription. Offer
`2026-11-04.2` freezes the current 29 SKU keys and `subscriptionPolicy=not-required`.
Future catalog additions require a new reviewed offer version. Standard content, readiness,
storage, ownership, debt and provider-cost safeguards still apply. One successful output consumes
one unit. Unknown provider acceptance retains the original unit reservation.

## Historical contracts

| Offer          | Price    | Coverage                                 | Premium model access               |
| -------------- | -------- | ---------------------------------------- | ---------------------------------- |
| `2026-10-19.1` | USD 1.00 | Original frozen 29 SKUs                  | Existing subscription rules        |
| `2026-11-04.1` | USD 1.00 | Frozen 15 standard 1K/2K SKUs            | Existing subscription rules        |
| `2026-11-04.2` | USD 2.99 | Frozen current 29 SKUs, including Pro/4K | Included only when using this pack |

Do not rewrite historical intent snapshots, grants, prices or plan metadata. The two USD 1 offers
legitimately share their original BillingPlan. New sales use the distinct local merchant SKU
`EZIMAGE-IMAGE-PASS-3-USD-299-20261104` and BillingPlan `image-pass-3-paypal-299-20261104`.
Old checkout replay/capture and signed webhook fulfillment retain their original price cohort.
Pending old purchases must not be silently repriced or replaced with another provider order.
The owner-scoped return page displays its frozen order amount, never the current advertised price.

The API checks availability and model access; admission rechecks current subscription and funding.
Reservation selects the qualifying grant itself under the owner lock using database time. In a mixed
wallet, a subscription-free premium request cannot consume an older USD 1 unit. An exhausted,
frozen or in-flight new grant cannot unlock another request. Credits never inherit these permissions.

## PayPal

The existing integration uses PayPal Orders v2 with inline amounts and merchant line-item SKUs.
No PayPal dashboard product, subscription plan, webhook URL, API credential or billing agreement
needs to change. The server sends USD 2.99 for new orders and validates the captured amount against
the locked original intent, plan and offer. Refunds/disputes remain bounded by the actual original
grant payment; the new price must not raise the USD 1 refund ceiling.

## Release and rollback

1. Verify the exact target and migration history/checksums. Apply only the pending reviewed migration
   `20261104140000_image_pass_all_models_299` using official Prisma. It changes CHECK constraints
   and adds a grant-relative adjustment guard; it does not rewrite business data or enable sales.
2. Complete focused regressions and official disposable PostgreSQL/browser/Worker CI. Deploy the
   compatible jobs consumer before the website producer. Keep old snapshot readers throughout.
3. After both exact production versions are verified, run
   [`image-pass-299-paypal-provision.sql`](image-pass-299-paypal-provision.sql) against the verified
   target. It creates only the immutable exact new BillingPlan and refuses conflicting existing data.
   Existing plans and grants remain untouched. Availability may be false until this final activation.
4. Verify public offer availability, USD 2.99 copy in four locales, login/session routes, deployment
   version/traffic, and migration status. Do not claim real payment or generation acceptance from
   mocked tests or read-only live checks.

To stop new sales, deactivate only the new BillingPlan, retaining compatible consumers, all grants,
reservations and historical payment facts. Do not roll back to code that cannot honor accepted
`2026-11-04.2` purchases. Never drop the widened constraints while any such purchase exists.

This document describes the release procedure; actual deployment and verification evidence must be
recorded separately. Local tests do not establish that the production migration or activation ran.
