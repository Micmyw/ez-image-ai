# EzPic pricing and margin record

## Decision snapshot

Pricing version `2026-09-05.1` converts the current public Provider price research into a
conservative launch contract. The plan values below are product decisions and local application
contracts. They are not evidence of a billed Provider run, a production payment, or an approved
production launch.

| Evidence or decision                                       | Status            |
| ---------------------------------------------------------- | ----------------- |
| Public Provider price research dated 2026-09-05            | **COMPLETED**     |
| Local plan, quote, entitlement, and monthly-grant contract | **COMPLETED**     |
| OpenRouter top-up minimum-fee allocation                   | **NOT_COMPLETED** |
| Real Provider execution and route certification            | **NOT_COMPLETED** |
| Reconciled Provider billing and measured success rate      | **NOT_COMPLETED** |
| Production payment-provider checkout/webhook certification | **NOT_COMPLETED** |
| Matching production `BillingPlan` snapshots                | **NOT_COMPLETED** |
| Legal seller identity, refund, tax, and dispute policy     | **NOT_COMPLETED** |
| Deployment and live verification                           | **NOT_COMPLETED** |

No secret, Provider credential, production Price ID, or customer information is recorded here.

## Package contract

`packages/config/plans.ts` remains the source of truth for the plan allowances and prices. Credits
are issued once per internal monthly billing period, expire at that period boundary, and do not roll
over. An annual purchase still creates twelve monthly grant periods; neither checkout nor the browser
grants the full annual allowance at once.

| Plan    | Credits/month | Concurrent edits | Products                       | Max input | Monthly | Annual | Approximate monthly usage  |
| ------- | ------------: | ---------------: | ------------------------------ | --------: | ------: | -----: | -------------------------- |
| Free    |            25 |                1 | Standard Edit                  |     10 MB |      $0 |     $0 | 5 Standard                 |
| Creator |           700 |                3 | Standard Edit and Quality Edit |     20 MB |     $19 |   $190 | 140 Standard or 17 Quality |
| Studio  |         3,000 |               10 | Standard Edit and Quality Edit |     20 MB |     $79 |   $790 | 600 Standard or 75 Quality |

Standard Edit costs 5 credits and Quality Edit costs 40 credits. The Quality-only Creator count
leaves 20 credits; the table intentionally reports whole completed edits rather than a fractional
claim. Mixed usage consumes the same shared monthly balance.

All plans continue to use private assets, owner-scoped access, metering, moderation, durable jobs,
and the existing credit ledger. The browser submits only stable product keys. Provider identity,
model ID, routing weights, credentials, raw payloads, and dollar costs remain server-only.

## Current executable catalog and price guard

Only the following two routes remain in the executable image catalog. Both are still fail-closed
behind `MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED`; public price research does not satisfy that
production certification gate.

| Product       | Server-only route                              | Public price observed        | Internal planning ceiling | Credits |
| ------------- | ---------------------------------------------- | ---------------------------- | ------------------------: | ------: |
| Standard Edit | `sourceful/riverflow-v2.5-fast` via OpenRouter | 1K $0.019; 2K $0.021         |           $0.023 per edit |       5 |
| Quality Edit  | `sourceful/riverflow-v2.5-pro` via OpenRouter  | 1K $0.13; 2K $0.15; 4K $0.17 |           $0.180 per edit |      40 |

OpenRouter's public FAQ says the credit-purchase fee is 5.5% and the minimum fee is $0.80 per top-up.
Operations must top up at least $14.55 for the percentage fee to dominate; the recommended minimum
top-up is $20. Under that rule, `$0.021 * 1.055 = $0.022155` and
`$0.17 * 1.055 = $0.17935`. The rounded $0.023/$0.180 values are catalog usage/quote ceilings, not
unconditional all-cash cost caps. They exclude arbitrary allocation of the per-top-up minimum. Until
real top-ups and settled-edit volumes are reconciled, minimum-fee allocation remains
**NOT_COMPLETED**.

The rejected alternatives and their compatibility findings are recorded in
`image-edit-model-benchmark.md`. In particular, a low public generation price is not sufficient when
the Provider endpoint cannot satisfy EzPic's private image-edit input/output contract.

## Raphael public comparison

Raphael's public pricing page was used as a product-pattern comparison, not as evidence of Raphael's
internal cost or a target EzPic subsidy level.

| Raphael plan | Public monthly price | Public credits | Public annual display |
| ------------ | -------------------: | -------------: | --------------------- |
| Pro          |                  $20 |          2,000 | 50% annual discount   |
| Ultimate     |                  $40 |          5,000 | 50% annual discount   |
| Max          |                  $80 |         10,000 | 50% annual discount   |

Raphael communicates that credit consumption varies by model. Its public page did not establish a
reliable subscription-credit rollover rule during this review, so rollover is **NOT_CONFIRMED**.
EzPic therefore states its own no-rollover rule explicitly. EzPic also does not copy apparent
zero-credit routes or cross-model subsidy assumptions: every executable EzPic job remains metered,
and the 8:1 Quality-to-Standard credit ratio reflects the observed maximum Provider prices.

## Conservative full-use economics

These estimates deliberately use public list prices plus conservative assumptions, not a Provider
invoice. The assumptions are:

- payment processing: 4.5% of collected revenue plus $0.30 per charge;
- refund/chargeback risk reserve: 1.5% of collected revenue;
- Provider variation buffer: 15% on the public output price plus OpenRouter's 5.5% PAYG fee, assuming
  each OpenRouter credit purchase is at least $20 so the $0.80 minimum fee does not raise the rate;
- task/runtime allocation: $0.005 per Standard edit and $0.010 per Quality edit;
- one payment charge per monthly purchase and one payment charge per annual purchase.

This produces planning costs of approximately `$0.030479` per Standard edit and `$0.216253` per
Quality edit:

```text
Standard = $0.021 * 1.055 * 1.15 + $0.005
Quality  = $0.170 * 1.055 * 1.15 + $0.010
top_up_fee(T) = max(0.055 * T, $0.80)
```

The `1.055` multiplier is valid only when top-up `T` is at least $14.55; the operating policy uses
$20. If that policy is not followed or evidenced, the actual `top_up_fee(T)` must be allocated across
the edits funded by the purchase and every margin must be recalculated before approval.

Standard has the higher planning cost per credit, so an all-Standard month is the worst permitted
full-use mix under these assumptions.

| Plan / cadence                     | Net monthly revenue after stated payment/refund assumptions | Worst full-use variable cost | Conservative full-use gross margin |
| ---------------------------------- | ----------------------------------------------------------: | ---------------------------: | ---------------------------------: |
| Creator monthly                    |                                                     $17.560 |                       $4.267 |                              75.7% |
| Creator annual, monthly allocation |                                                     $14.858 |                       $4.267 |                              71.3% |
| Studio monthly                     |                                                     $73.960 |                      $18.287 |                              75.3% |
| Studio annual, monthly allocation  |                                                     $61.858 |                      $18.287 |                              70.4% |

Annual net revenue is calculated after applying the percentage reserves and one $0.30 fee to the
annual charge, then dividing by 12. Taxes, regional price differences, currency conversion, dispute
fees, abnormal retry rates, storage/transfer outliers, and real success-rate effects are not measured
here. The percentages are planning margins, not certified production margins.

## Billing, credits, and synchronization gate

Each enabled payment provider must resolve its own server-only product/price identifiers for the exact
plan and cadence. Do not hard-code or expose them as `NEXT_PUBLIC_*`. Checkout must fail closed when
an identifier is missing, malformed, belongs to the wrong environment, or disagrees with the active
`BillingPlan` snapshot.

Before enabling sales for pricing version `2026-09-05.1`, provision and verify a `BillingPlan` row for
every offered plan/cadence/provider combination as required by the existing payment projection. Its
plan identity, 700/3,000 monthly credit allowance, interval price, currency, and pricing version must
match the application contract. Updating UI copy without synchronizing the application catalog,
database snapshots, webhook projection, and tests is not an acceptable rollout.

Checkout return grants no credits. Payment events, monthly renewal, annual monthly grants,
cancellation, partial/full refunds, debt, failed-job release, and replay remain in the existing
Purchase, Subscription, Billing Period, Credit Lot, Reservation, Ledger, Outbox, and reconciliation
paths. Free grants remain UTC-month scoped and idempotent and also expire at the next UTC month
boundary.

## Production completion gate

Before public paid checkout and the OpenRouter routes are enabled, record all of the following without
copying secrets into the repository:

1. real Standard and Quality runs through the existing private job/finalization path, with the exact
   route tuple and pricing version;
2. human image-edit scoring, success/failure/uncertain counts, latency, retries, and billed cost;
3. evidence of OpenRouter credit purchases of at least $20, plus reconciliation of Provider billing,
   actual top-up fees, minimum-fee allocation, and the non-Provider allocations against this
   worksheet;
4. test and live checkout/webhook lifecycle evidence for every enabled payment provider;
5. synchronized production `BillingPlan` snapshots, legal seller/refund/tax decisions, alerting,
   moderation, storage, deployment, and live verification.

Until those items are complete, production Provider execution and the claimed live margin remain
**NOT_COMPLETED**.

## Sources

Public pages accessed 2026-09-05:

- OpenRouter Riverflow Fast: <https://openrouter.ai/sourceful/riverflow-v2.5-fast>
- OpenRouter Riverflow Pro: <https://openrouter.ai/sourceful/riverflow-v2.5-pro>
- OpenRouter FAQ / credit-purchase fee: <https://openrouter.ai/docs/faq>
- Raphael pricing: <https://raphael.app/pricing>

## Rollback

The pricing change adds no new ledger or billing-cycle table. Disable new checkout and generation
before rolling the application contract back if real events have been processed. Preserve immutable
Purchase, Subscription, Billing Period, Lot, Ledger, Reservation, and Debt history and use the normal
reconciliation/refund paths. A rollback must restore plan configuration, quote credits/cost ceilings,
pricing version, localized copy, `BillingPlan` snapshots, and tests as one compatible set.
