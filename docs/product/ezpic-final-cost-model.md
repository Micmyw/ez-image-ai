# EzPic final cost model

## Decision status

Subscription pricing version `2026-09-05.1` and Credit Pack catalog/pricing/eligibility version
`2026-09-06.1` use a conservative planning model based on official public prices observed on
2026-09-05. They are not a Provider bill, a real execution benchmark, or production margin
certification.

| Decision input                                                              | Status          |
| --------------------------------------------------------------------------- | --------------- |
| Current Provider/model public price research                                | `COMPLETED`     |
| Local cost ceilings, plan/Credit Pack values, and credit weights            | `COMPLETED`     |
| OpenRouter top-up minimum-fee allocation                                    | `NOT_COMPLETED` |
| Standard Edit real billed all-in successful cost                            | `NOT_COMPLETED` |
| Quality Edit real billed all-in successful cost                             | `NOT_COMPLETED` |
| Failure/retry/uncertain-attempt cost distribution                           | `NOT_COMPLETED` |
| Moderation, private storage/transfer, worker, and observability measurement | `NOT_COMPLETED` |
| Payment-provider test/live fees and lifecycle certification                 | `NOT_COMPLETED` |
| Final route certification and production gross-margin approval              | `NOT_COMPLETED` |

No Provider credential, payment Price ID, customer information, or production invoice belongs in
this file. Use redacted evidence references and aggregate measurements.

## Product and route inputs

The public products are Standard Edit and Quality Edit. Their stable browser-facing keys remain
`image-fast` and `image-quality`; Provider, model, cost, credential, and routing data stay server-only.
The executable catalog contains only these two routes:

| Product       | Server-only Provider/model                   | Public maximum used | Planning ceiling | Credits/edit |
| ------------- | -------------------------------------------- | ------------------: | ---------------: | -----------: |
| Standard Edit | OpenRouter / `sourceful/riverflow-v2.5-fast` |        $0.021 at 2K |           $0.023 |            5 |
| Quality Edit  | OpenRouter / `sourceful/riverflow-v2.5-pro`  |        $0.170 at 4K |           $0.180 |           40 |

The exact observed public tiers were Fast 1K/2K at $0.019/$0.021 and Pro 1K/2K/4K at
$0.13/$0.15/$0.17. OpenRouter's public FAQ says the credit-purchase fee is 5.5% and the minimum fee is
$0.80 per top-up. Operations must top up at least $14.55 for the percentage fee to dominate; the
recommended minimum top-up is $20. Under that rule, applying 5.5% gives $0.022155 and $0.17935. The
rounded $0.023/$0.180 values are catalog usage/quote ceilings, not unconditional all-cash cost caps.
They exclude arbitrary allocation of the per-top-up minimum. Until real top-ups and settled-edit
volumes are reconciled, minimum-fee allocation remains **NOT_COMPLETED**.

The server-only `providerCostMicros` field carries these per-request planning ceilings into quote and
budget enforcement; it is not a replacement for reconciling the separate credit-purchase fee.

Both routes remain non-executable in production until the exact tuples pass the existing
`MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED` gate. Public price research alone is not certification.

## Subscription package inputs

Credits are granted per internal month and do not roll over. Annual purchases receive the same
monthly grant through twelve billing periods.

| Public plan (internal key) | Credits/month | Standard credits/edit | Quality credits/edit | Monthly price | Annual price | Whole-edit monthly ceiling |
| -------------------------- | ------------: | --------------------: | -------------------: | ------------: | -----------: | -------------------------- |
| Free (`free`, internal)    |            25 |                     5 |         Not entitled |            $0 |           $0 | 5 Standard                 |
| Pro (`creator`)            |           700 |                     5 |                   40 |           $19 |         $190 | 140 Standard or 17 Quality |
| Ultimate (`ultimate`)      |         1,800 |                     5 |                   40 |           $49 |         $490 | 360 Standard or 45 Quality |
| Max (`studio`)             |         3,000 |                     5 |                   40 |           $79 |         $790 | 600 Standard or 75 Quality |

Public pricing opens on annual billing and hides Free. Annual prices equal ten monthly payments, so
the exact saving against twelve monthly payments is 16.67%; the UI truthfully displays the rounded
`-17%` value.

## Credit Pack inputs

Credit Packs are one-time purchases separate from subscriptions. Each grant expires six UTC calendar
months after its verified purchase timestamp. Paid-subscriber eligibility and the 20% bonus are
frozen on the first checkout intent and cannot change on replay.

|  Pack | Price | Base credits | Paid-subscriber credits | Subscriber bonus | Validity |
| ----: | ----: | -----------: | ----------------------: | ---------------: | -------: |
| 1,500 |   $59 |        1,500 |                   1,800 |             +20% | 6 months |
| 3,000 |  $109 |        3,000 |                   3,600 |             +20% | 6 months |
| 5,000 |  $169 |        5,000 |                   6,000 |             +20% | 6 months |
| 8,000 |  $259 |        8,000 |                   9,600 |             +20% | 6 months |

Raphael's public comparison was Pro $20/2,000 credits, Ultimate $40/5,000 credits, and Max
$80/10,000 credits, with a displayed 50% annual discount and model-dependent credit consumption.
Its subscription-credit rollover rule was not confirmed. EzPic does not infer Raphael's internal
costs or copy apparent zero-credit/subsidized routes; the package above is cost-weighted for EzPic's
own current catalog.

## Conservative planning calculation

Use the following explicit assumptions until reconciled production data replaces them:

```text
payment_and_refund_net(monthly purchase) = price * (1 - 0.045 - 0.015) - $0.30
payment_and_refund_net(annual allocation) =
  (annual_price * (1 - 0.045 - 0.015) - $0.30) / 12

planned_standard_cost = $0.021 * 1.055 * 1.15 + $0.005 = $0.030478250
planned_quality_cost  = $0.170 * 1.055 * 1.15 + $0.010 = $0.216252500
top_up_fee(T) = max(0.055 * T, $0.80)
```

The 4.5% plus $0.30 payment assumption and 1.5% refund-risk reserve apply to revenue. The Provider
calculation's `1.055` multiplier is valid only when top-up `T` is at least $14.55; the operating policy
uses $20. It then applies a further 15% variation buffer and task/runtime allocations of $0.005
Standard and $0.010 Quality. If that policy is not followed or evidenced, allocate the actual
`top_up_fee(T)` across the edits funded by the purchase and recalculate the margins. Taxes, currency
changes, dispute fees, and unusual retry/storage behavior remain outside the measured evidence.

For allowance `K`, Standard count `S`, and Quality count `Q`:

```text
full_use_variable_cost(K) = max(S * planned_standard_cost + Q * planned_quality_cost)
subject to 5 * S + 40 * Q <= K
S and Q are non-negative integers

planning_margin = (net_monthly_revenue - full_use_variable_cost)
                  / net_monthly_revenue
```

Standard's planning cost per credit is greater than Quality's, so all-Standard usage is the worst
permitted full-use mix under these assumptions.

| Plan / cadence                      | Net monthly revenue | Full-use cost | Planning gross margin |
| ----------------------------------- | ------------------: | ------------: | --------------------: |
| Pro monthly                         |             $17.560 |        $4.267 |                 75.7% |
| Pro annual, monthly allocation      |             $14.858 |        $4.267 |                 71.3% |
| Ultimate monthly                    |             $45.760 |       $10.972 |                 76.0% |
| Ultimate annual, monthly allocation |             $38.358 |       $10.972 |                 71.4% |
| Max monthly                         |             $73.960 |       $18.287 |                 75.3% |
| Max annual, monthly allocation      |             $61.858 |       $18.287 |                 70.4% |

These percentages are the worst full-use result within this worksheet, not production-approved gross
margin. Real billed attempts, failures, refunds, tax, and infrastructure allocations may change them.

The server-only Credit Pack quote uses the highest planning cost per credit: Standard full-use cost
`$0.030478250 / 5 = $0.006095650`, rounded up to `$0.006096` (6,096 USD micros). The table applies
that cost to every credit, including the full subscriber bonus, and applies the same 4.5% payment,
$0.30 charge, and 1.5% refund-reserve assumptions to revenue.

|         Pack | Net revenue | Base-credit cost / margin | Subscriber-credit cost / margin |
| -----------: | ----------: | ------------------------: | ------------------------------: |
|  1,500 / $59 |     $55.160 |            $9.144 / 83.4% |                 $10.973 / 80.1% |
| 3,000 / $109 |    $102.160 |           $18.288 / 82.1% |                 $21.946 / 78.5% |
| 5,000 / $169 |    $158.560 |           $30.480 / 80.8% |                 $36.576 / 76.9% |
| 8,000 / $259 |    $243.160 |           $48.768 / 79.9% |                 $58.522 / 75.9% |

These are planning margins, not live PayPal/Waffo fee evidence. Taxes, regional pricing, disputes,
abnormal retries, storage/transfer outliers, and real success-rate effects remain unmeasured.

## Production measurement unit

Replace the planning inputs with cost per successfully settled edit for each certified route:

```text
submitted_attempt_cost = Provider billed submission + billed retries/cancellations
successful_edit_cost = sum(all submitted_attempt_cost for the settled edit)
                     + prompt/input/output moderation
                     + private object request, storage, and transfer allocation
                     + worker/Trigger.dev allocation
                     + observability allocation attributable to the edit

C_standard = sum(Standard successful_edit_cost) / settled Standard edits
C_quality  = sum(Quality successful_edit_cost) / settled Quality edits
```

Report sample size; success, failure, uncertain, and cancellation counts; billed currency and
conversion method; p50/p95 latency and cost; time window; route/pricing version; Provider billing
export reference; and reviewer. Do not remove failed, retried, moderated, abandoned, or uncertain
attempts from the numerator when they incurred cost.

## Evidence table to complete

| Metric                                       | Standard Edit   | Quality Edit    | Required evidence                                           |
| -------------------------------------------- | --------------- | --------------- | ----------------------------------------------------------- |
| Exact route public pricing                   | 2026-09-05 list | 2026-09-05 list | Official URLs below                                         |
| OpenRouter credit-purchase fee allocation    | `NOT_COMPLETED` | `NOT_COMPLETED` | At-least-$20 purchase evidence or explicit $0.80 allocation |
| Production route certification               | `NOT_COMPLETED` | `NOT_COMPLETED` | Private staging route evidence and reviewer                 |
| Successful sample size                       | `NOT_COMPLETED` | `NOT_COMPLETED` | Bounded benchmark/run IDs                                   |
| Success, failure, uncertain, canceled counts | `NOT_COMPLETED` | `NOT_COMPLETED` | Provider and PostgreSQL aggregate references                |
| Billed Provider cost p50/p95                 | `NOT_COMPLETED` | `NOT_COMPLETED` | Redacted billing export reference                           |
| End-to-end successful cost p50/p95           | `NOT_COMPLETED` | `NOT_COMPLETED` | Reconciled cost worksheet reference                         |
| Latency p50/p95                              | `NOT_COMPLETED` | `NOT_COMPLETED` | Worker/job timing artifact                                  |
| Moderation cost allocation                   | `NOT_COMPLETED` | `NOT_COMPLETED` | Moderation invoice and event aggregates                     |
| Storage/transfer/request allocation          | `NOT_COMPLETED` | `NOT_COMPLETED` | Private bucket usage aggregate                              |
| Payment/refund/dispute/tax allocation        | `NOT_COMPLETED` | `NOT_COMPLETED` | Provider reports and approved policy                        |
| Approved production margin                   | `NOT_COMPLETED` | `NOT_COMPLETED` | Finance/product/operations sign-off                         |

## Safety and synchronization

The per-job and user/day cost caps and positive global daily Provider budget remain safety controls,
not margin evidence. Job creation must continue to reserve credits and cost atomically through the
existing PostgreSQL, job, Outbox, private storage, moderation, and immutable ledger paths.

New checkout supports only PayPal and Waffo. Every offered plan/cadence needs a matching `PLAN`
`BillingPlan`; every offered Credit Pack needs a distinct `CREDIT_PACK` snapshot. Plan identity,
monthly credits, interval amount, Pack catalog/pricing version, base credits, six-month expiry,
currency, and provider mapping must agree before checkout; drift fails closed. Change plan/Pack
config, localized pricing copy, cost/credit catalog, database snapshots, Webhook projections, and
tests together.

Stripe is excluded from new subscription and Credit Pack checkout. Optional Stripe configuration is
retained only for historical Webhook, portal/cancellation, refund-repair, and reconciliation paths;
when no historical Stripe lifecycle is configured, scheduled reconciliation must skip it safely.

Operations must also preserve evidence that each OpenRouter credit purchase is at least $20. If that
floor is not followed, production margin certification fails closed until finance allocates the $0.80
minimum fee and recalculates these ceilings.

## Sources

Official/public pages accessed 2026-09-05:

- OpenRouter Riverflow Fast: <https://openrouter.ai/sourceful/riverflow-v2.5-fast>
- OpenRouter Riverflow Pro: <https://openrouter.ai/sourceful/riverflow-v2.5-pro>
- OpenRouter FAQ / PAYG credit fee: <https://openrouter.ai/docs/faq>
- Replicate FLUX Schnell: <https://replicate.com/black-forest-labs/flux-schnell>
- fal FLUX Schnell: <https://fal.ai/models/fal-ai/flux/schnell>
- Google Gemini API pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Raphael pricing: <https://raphael.app/pricing>

## Rollback and review

Route, subscription pricing, and Credit Pack changes use explicit versions; historical Quote, Job,
Checkout Intent, Fulfillment, Adjustment, credit, Purchase, Subscription, and billing snapshots
remain immutable. Disable new checkout before rolling back the sales surface. Disable Quality first,
then Standard or global generation as required by `../operations/ezpic-rollback.md`. Continue
reconciliation through existing paths and never replace domain state with a spreadsheet or Provider
dashboard.

Recalculate after any route, Provider price, payment fee, moderation policy, storage region, plan,
credit price, tax/refund policy, or material success-rate change, and at least weekly during the
initial launch monitoring period.
