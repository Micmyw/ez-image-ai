# EzPic final cost model

## Decision status

This file defines the calculation and evidence required for a production pricing decision. It does
not claim a measured production cost or approved margin.

| Decision input                                                                  | Status          |
| ------------------------------------------------------------------------------- | --------------- |
| Standard Edit billed all-in successful cost                                     | `NOT_COMPLETED` |
| Quality Edit billed all-in successful cost                                      | `NOT_COMPLETED` |
| Provider failure/retry and uncertain-attempt cost distribution                  | `NOT_COMPLETED` |
| Moderation, private storage/transfer, Trigger.dev, and observability allocation | `NOT_COMPLETED` |
| Stripe test/live fees, refunds, disputes, tax, and currency allocation          | `NOT_COMPLETED` |
| Creator monthly and annual full-use margin approval                             | `NOT_COMPLETED` |
| Studio monthly and annual full-use margin approval                              | `NOT_COMPLETED` |
| Final Standard/Quality route certification and pricing-version sign-off         | `NOT_COMPLETED` |

No Provider credential, Price ID, customer information, or production invoice belongs in this file.
Use redacted evidence references and aggregate measurements.

## Frozen product inputs

The public names are Standard Edit and Quality Edit. Their server-only keys remain `image-fast` and
`image-quality`. Video is not part of the EzPic public catalog, packages, navigation, SEO, or UI.

| Plan    | Monthly credits | Standard credits/edit | Quality credits/edit | Monthly price | Annual price | Internal annual allocation |
| ------- | --------------: | --------------------: | -------------------: | ------------: | -----------: | -------------------------: |
| Free    |              25 |                     4 |         Not entitled |            $0 |           $0 |                         $0 |
| Creator |           1,000 |                     4 |                   10 |           $19 |         $190 |        $190 / 12 per month |
| Studio  |           5,000 |                     4 |                   10 |           $79 |         $790 |        $790 / 12 per month |

The current internal catalog has `providerCostMicros` ceilings of 3,000 and 3,500 for Standard route
candidates and 8,000 for the Quality candidate. Quote creation reserves against the maximum current
executable route. These values are server-only risk ceilings and test inputs; they are not real billed
cost, route selection, or margin evidence.

The application also limits each job to 5,000,000 micros and each user to 25,000,000 quoted micros per
UTC day. Production additionally requires a positive global
`MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS`. Job creation takes a global day-scoped PostgreSQL lock and
atomically rejects a Quote that would exceed it. These are safety controls, not price or margin claims.

## Measurement unit

Measure cost per successfully settled edit for each certified route and cohort:

```text
submitted_attempt_cost = Provider billed submission + billed retries/cancellations
successful_edit_cost = sum(all submitted_attempt_cost for the settled edit)
                     + prompt/input/output moderation
                     + private object request, storage, and transfer allocation
                     + Trigger.dev/worker allocation
                     + observability and mail allocation attributable to the edit

C_standard = sum(Standard successful_edit_cost) / settled Standard edits
C_quality  = sum(Quality successful_edit_cost) / settled Quality edits
```

Report sample size, success/failure/uncertain counts, cancellation outcome, billed currency, conversion
method, p50/p95 latency, p50/p95 cost, time window, catalog/pricing version, Provider billing export
reference, and reviewer. Failed, retried, moderated, abandoned, and uncertain attempts must not be
silently removed from the numerator when they incurred cost.

## Package full-use calculation

For monthly allowance `K`, Standard count `S`, Quality count `Q`, and measured all-in costs
`C_standard` and `C_quality`:

```text
full_use_variable_cost(K) = max(S * C_standard + Q * C_quality)
subject to 4 * S + 10 * Q <= K
S and Q are non-negative integers

allocated_monthly_revenue = monthly price, or annual price / 12
gross_margin = (allocated_monthly_revenue
                - full_use_variable_cost
                - payment/refund/tax/dispute allocation
                - other monthly variable cost)
               / allocated_monthly_revenue
```

The single-mode ceilings are six Standard edits for Free; 250 Standard or 100 Quality edits for
Creator; and 1,250 Standard or 500 Quality edits for Studio. Evaluate mixed integer combinations too.
Unused credits are not a cost assumption. The route with the higher measured cost per credit controls
the worst permitted mix.

Do not publish a numeric margin until measured Provider billing, non-Provider allocations, Stripe
fees/refunds, the exact production plan snapshot, and an approved threshold are all available. If the
result fails the approved threshold, change plan price, credits, per-edit credits, catalog/pricing
version, UI copy, database BillingPlan snapshot, and tests together before public sales.

## Evidence table to complete

| Metric                                       | Standard Edit   | Quality Edit    | Required evidence                            |
| -------------------------------------------- | --------------- | --------------- | -------------------------------------------- |
| Certified internal route                     | `NOT_COMPLETED` | `NOT_COMPLETED` | Staging route certification and reviewer     |
| Successful sample size                       | `NOT_COMPLETED` | `NOT_COMPLETED` | Bounded benchmark/run IDs                    |
| Success, failure, uncertain, canceled counts | `NOT_COMPLETED` | `NOT_COMPLETED` | Provider and PostgreSQL aggregate references |
| Billed Provider cost p50/p95                 | `NOT_COMPLETED` | `NOT_COMPLETED` | Redacted billing export reference            |
| End-to-end successful cost p50/p95           | `NOT_COMPLETED` | `NOT_COMPLETED` | Reconciled cost worksheet reference          |
| Latency p50/p95                              | `NOT_COMPLETED` | `NOT_COMPLETED` | Trigger/job timing artifact                  |
| Moderation cost allocation                   | `NOT_COMPLETED` | `NOT_COMPLETED` | Moderation invoice and event aggregates      |
| Storage/transfer/request allocation          | `NOT_COMPLETED` | `NOT_COMPLETED` | Private bucket usage aggregate               |
| Worker/observability/mail allocation         | `NOT_COMPLETED` | `NOT_COMPLETED` | Environment usage aggregate                  |
| Approved production ceiling                  | `NOT_COMPLETED` | `NOT_COMPLETED` | Finance/product/operations sign-off          |

## Rollback and review

The global budget can stop new cost but does not settle uncertain work. Route or pricing changes use a
new catalog/pricing version; historical Quote, job, credit, and billing snapshots remain immutable.
Disable Quality first, then Standard or global generation as required by `../operations/ezpic-rollback.md`.
Continue reconciliation through the existing job, Outbox, payment, storage, moderation, and credit
paths; never replace them with a spreadsheet or Provider dashboard as domain state.

Recalculate this model after any route, Provider price, moderation policy, storage region, plan,
credit price, Stripe fee, tax, refund policy, or material success-rate change, and at least weekly
during the first launch monitoring period.
