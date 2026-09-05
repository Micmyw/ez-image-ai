# EzPic final cost model

## Decision status

Pricing version `2026-09-05.1` is a conservative planning model based on official public prices
observed on 2026-09-05. It is not a Provider bill, a real execution benchmark, or production margin
certification.

| Decision input                                                              | Status          |
| --------------------------------------------------------------------------- | --------------- |
| Current Provider/model public price research                                | `COMPLETED`     |
| Local cost ceilings, plan values, and credit weights                        | `COMPLETED`     |
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

## Package inputs

Credits are granted per internal month and do not roll over. Annual purchases receive the same
monthly grant through twelve billing periods.

| Plan    | Credits/month | Standard credits/edit | Quality credits/edit | Monthly price | Annual price | Whole-edit monthly ceiling |
| ------- | ------------: | --------------------: | -------------------: | ------------: | -----------: | -------------------------- |
| Free    |            25 |                     5 |         Not entitled |            $0 |           $0 | 5 Standard                 |
| Creator |           700 |                     5 |                   40 |           $19 |         $190 | 140 Standard or 17 Quality |
| Studio  |         3,000 |                     5 |                   40 |           $79 |         $790 | 600 Standard or 75 Quality |

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

| Plan / cadence                     | Net monthly revenue | Full-use cost | Planning gross margin |
| ---------------------------------- | ------------------: | ------------: | --------------------: |
| Creator monthly                    |             $17.560 |        $4.267 |                 75.7% |
| Creator annual, monthly allocation |             $14.858 |        $4.267 |                 71.3% |
| Studio monthly                     |             $73.960 |       $18.287 |                 75.3% |
| Studio annual, monthly allocation  |             $61.858 |       $18.287 |                 70.4% |

These percentages are the worst full-use result within this worksheet, not production-approved gross
margin. Real billed attempts, failures, refunds, tax, and infrastructure allocations may change them.

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

Every plan/cadence offered by an enabled payment provider needs a matching production `BillingPlan`
snapshot. Plan identity, monthly credits, interval amount, currency, payment-provider mapping, and
pricing version must agree before checkout; drift fails closed. Change plan config, localized pricing
copy, cost/credit catalog, database snapshots, webhook projections, and tests together.

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

Route and pricing changes use a new version; historical Quote, job, credit, purchase, subscription,
and billing snapshots remain immutable. Disable Quality first, then Standard or global generation as
required by `../operations/ezpic-rollback.md`. Continue reconciliation through existing paths and
never replace domain state with a spreadsheet or Provider dashboard.

Recalculate after any route, Provider price, payment fee, moderation policy, storage region, plan,
credit price, tax/refund policy, or material success-rate change, and at least weekly during the
initial launch monitoring period.
