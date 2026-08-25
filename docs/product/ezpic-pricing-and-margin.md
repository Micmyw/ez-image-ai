# EzPic pricing and margin record

## Status and evidence boundary

PR 6 implements the local plan, checkout, entitlement, and credit contracts. It does not certify a
production sale or gross margin. PR 2 committed a safe dry-run benchmark plan and inherited catalog
estimates, but it recorded no authorized Provider execution, billed Provider cost, success rate, or
final Standard/Quality route. Catalog estimates and local fixtures are not production cost evidence.

| Evidence or decision                                     | Status            |
| -------------------------------------------------------- | ----------------- |
| Local plan and entitlement contract                      | **COMPLETED**     |
| Local Stripe lifecycle fixtures and idempotency checks   | **COMPLETED**     |
| Authorized image-edit benchmark inputs and human scoring | **NOT_COMPLETED** |
| Measured/billed Standard Edit variable cost              | **NOT_COMPLETED** |
| Measured/billed Quality Edit variable cost               | **NOT_COMPLETED** |
| Full-use Creator and Studio gross-margin approval        | **NOT_COMPLETED** |
| Stripe test-mode Product/Price/Webhook certification     | **NOT_COMPLETED** |
| Stripe live Product/Price/Webhook certification          | **NOT_COMPLETED** |
| Matching production BillingPlan snapshot provisioning    | **NOT_COMPLETED** |
| Legal seller identity and approved refund policy         | **NOT_COMPLETED** |
| Real Provider and Trigger.dev execution                  | **NOT_COMPLETED** |
| Cloud private storage and production moderation          | **NOT_COMPLETED** |
| Deployment and live verification                         | **NOT_COMPLETED** |

No secret, Provider credential, or production Price ID is recorded here.

## Frozen package contract

`packages/config/plans.ts` is the single source for credits, concurrency, products, input size, and
major-unit USD prices. Both pricing UIs and runtime authorization consume that contract.

| Plan    | Monthly credits | Concurrent edits | Products                       | Max input | Monthly price | Annual price |
| ------- | --------------: | ---------------: | ------------------------------ | --------: | ------------: | -----------: |
| Free    |              25 |                1 | Standard Edit                  |     10 MB |            $0 |           $0 |
| Creator |           1,000 |                3 | Standard Edit and Quality Edit |     20 MB |           $19 |         $190 |
| Studio  |           5,000 |               10 | Standard Edit and Quality Edit |     20 MB |           $79 |         $790 |

Standard Edit currently quotes 4 credits and Quality Edit quotes 10 credits from the existing media
catalog. Annual purchases grant the same monthly credits through twelve existing internal monthly
periods; they do not grant the full annual amount from the browser or checkout-return page.

All plans receive private assets and private edit sessions/history. Paid plans sell only their
additional monthly credits, Quality access, concurrency, and input-size allowance. No plan promises
priority queueing, unbounded history, bulk editing, an API, or use without metering and moderation.

## Full-use margin method

The production decision must use measured all-in variable cost per successfully settled edit, not
the PR 2 placeholder manifest or an unverified catalog estimate. For each route, measure at least:

- Provider charges, including failed/retried calls that remain billable;
- output moderation and any input re-verification cost;
- private object storage, transfer, and request cost attributable to the edit;
- task/worker and other usage-priced infrastructure;
- payment processing, refunds, disputes, taxes, and currency effects where applicable.

Let `C_standard` and `C_quality` be those measured all-in costs, in one currency, and let `S` and `Q`
be the counts of settled Standard and Quality edits. For monthly credit allowance `K`, calculate the
worst permitted full-use mix:

```text
full_use_variable_cost(K) = max(S * C_standard + Q * C_quality)
subject to 4 * S + 10 * Q <= K, with S and Q non-negative integers

For Free, the product entitlement adds Q = 0.

allocated_monthly_revenue = monthly price, or annual price / 12
gross_margin = (allocated_monthly_revenue - full_use_variable_cost - other monthly variable cost)
               / allocated_monthly_revenue
```

At the frozen credits, the single-mode usage ceilings are:

| Plan    | Standard-only ceiling | Quality-only ceiling |
| ------- | --------------------: | -------------------: |
| Free    |               6 edits |         Not entitled |
| Creator |             250 edits |            100 edits |
| Studio  |           1,250 edits |            500 edits |

Unused remainder credits are not a cost assumption. Mixed usage must be evaluated with the integer
constraint above, and the higher measured cost-per-credit route determines the worst case. Creator
annual revenue allocates to `$190 / 12` per internal month and Studio annual revenue to `$790 / 12`;
these expressions are calculation inputs, not approved margin results.

Because both measured route costs are `NOT_COMPLETED`, no numeric gross-margin percentage or safe
production threshold is claimed. If real evidence requires a package adjustment, update the plan
catalog, per-edit credits, pricing version, pricing copy, this record, and their tests together before
enabling public sales.

## Billing, credits, and configuration

Stripe Product/Price IDs come only from these server environment variables:

- `PRICE_ID_CREATOR_MONTHLY`
- `PRICE_ID_CREATOR_YEARLY`
- `PRICE_ID_STUDIO_MONTHLY`
- `PRICE_ID_STUDIO_YEARLY`

They must be genuine Stripe IDs for the target test or live account. Missing or malformed values fail
closed before database or Stripe checkout work and show paid checkout as temporarily unavailable.
Do not use a fabricated production ID and do not expose any of these values as `NEXT_PUBLIC_*`.
Each ID also needs an active `BillingPlan` row whose plan identity, monthly credits,
interval price, and currency exactly match `PLAN_ENTITLEMENTS`; checkout fails closed on any drift
instead of mutating that historical snapshot.

Checkout return polls the server-owned Webhook projection and grants no credits. Payment-event replay,
monthly renewal, annual monthly grants, cancellation, partial/full refunds, refund Debt, and failed-job
release continue through the existing Purchase, Subscription, Billing Period, Credit Lot, Reservation,
Ledger, Outbox, and reconciliation paths.

Free credits use the existing `createCreditGrant` command inside a serializable transaction. The
stable UTC-month reference key is `free-plan:user:<userId>:<YYYY-MM>`, the lot expires at the next UTC
month boundary, and ACTIVE or still-valid PAST_DUE paid subscriptions suppress the grant. The same
reference and ledger uniqueness make concurrent requests and replay idempotent.

## Production completion gate

Before public paid checkout is enabled, record all of the following without copying secrets into the
repository:

1. authorized PR 2 live benchmark evidence and final Standard/Quality route selection;
2. billed all-in variable cost and the full-use calculation for monthly and annual Creator/Studio;
3. an approved margin threshold and sign-off on the frozen package values;
4. real Stripe test Product/Price IDs, matching `BillingPlan` snapshots, plus checkout,
   renewal, annual monthly grant, cancellation, payment failure/recovery, replay, partial/full
   refund, and Portal evidence;
5. separately approved live Stripe IDs, legal seller identity, refund policy, and tax handling;
6. real Provider, Trigger.dev, private cloud storage, production moderation, alerting, deployment, and
   live verification evidence.

Until then, local PostgreSQL/MinIO, mock Provider/moderation, synthetic Stripe fixtures, and
production-build Playwright remain local application evidence only.

## Rollback

PR 6 adds no ledger table, billing-cycle table, or other database schema. Roll back the application
commit and remove the four Price ID variables from the affected deployment. Disable paid checkout
and new generation before application rollback if the deployment has processed real events; allow
existing payment/outbox workers to drain under the operations runbook rather than deleting Purchase,
Subscription, Billing Period, Lot, Ledger, Reservation, or Debt records. Existing subscriptions and
immutable financial history remain authoritative and require the normal reconciliation/refund paths.
