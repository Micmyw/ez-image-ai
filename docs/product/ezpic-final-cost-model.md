# EzPic final cost model

## Decision status

Image catalog and pricing version `2026-09-07.2` replaces the retired OpenRouter Standard/Quality
offer with one `EzPic Credit` balance and 20 Kie-backed image-edit SKU cells across nine products.
The SKU prices below are the Kie public prices used by the current server-only catalog; they are
planning inputs, not a Kie invoice, a paid execution benchmark, or production margin certification.

| Decision input                                                              | Status          |
| --------------------------------------------------------------------------- | --------------- |
| Kie public SKU price and parameter review dated 2026-09-07                  | `COMPLETED`     |
| Local product/SKU matrix, quote, entitlement, and credit contract           | `COMPLETED`     |
| Real paid Kie execution for all 20 SKU cells                                | `NOT_COMPLETED` |
| Kie output-host allowlist and private transfer confirmation                 | `NOT_COMPLETED` |
| Failure/retry/uncertain-attempt cost distribution                           | `NOT_COMPLETED` |
| Moderation, private storage/transfer, worker, and observability measurement | `NOT_COMPLETED` |
| Payment-provider test/live fees and lifecycle certification                 | `NOT_COMPLETED` |
| Final SKU certification and production gross-margin approval                | `NOT_COMPLETED` |

No Provider credential, payment product ID, customer information, private media reference, or
production invoice belongs in this file. Use redacted evidence references and aggregate
measurements.

## One-credit-wallet SKU contract

Users hold only `EzPic Credit`; there is no separate balance per model or resolution. Each new image
quote selects one legal product/SKU cell, freezes its EzPic Credit amount and server-only Provider
cost, and carries that immutable snapshot through reservation and settlement. The browser may submit
only the public product key, SKU key, aspect ratio, prompt, and owned source asset ID. It never
receives Kie identity, raw Kie model IDs, credentials, routing weights, or dollar costs.

| Public product key         | Legal SKU                  | Public parameters | Kie public cost | EzPic Credits |
| -------------------------- | -------------------------- | ----------------- | --------------: | ------------: |
| `image-nano-banana-2-lite` | `nano-banana-2-lite-1k`    | 1K                |         $0.0200 |             5 |
| `image-nano-banana`        | `nano-banana-default`      | Default           |         $0.0200 |             5 |
| `image-nano-banana-2`      | `nano-banana-2-1k`         | 1K                |         $0.0400 |             9 |
| `image-nano-banana-2`      | `nano-banana-2-2k`         | 2K                |         $0.0600 |            13 |
| `image-nano-banana-2`      | `nano-banana-2-4k`         | 4K                |         $0.0900 |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-1k`       | 1K                |         $0.0900 |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-2k`       | 2K                |         $0.0900 |            19 |
| `image-nano-banana-pro`    | `nano-banana-pro-4k`       | 4K                |         $0.1200 |            25 |
| `image-gpt-image-1-5`      | `gpt-image-1-5-medium`     | Medium            |         $0.0200 |             5 |
| `image-gpt-image-1-5`      | `gpt-image-1-5-high`       | High              |         $0.1100 |            23 |
| `image-gpt-image-2`        | `gpt-image-2-1k`           | 1K                |         $0.0300 |             7 |
| `image-gpt-image-2`        | `gpt-image-2-2k`           | 2K                |         $0.0500 |            11 |
| `image-gpt-image-2`        | `gpt-image-2-4k`           | 4K                |         $0.0800 |            17 |
| `image-seedream-4-5`       | `seedream-4-5-basic-2k`    | Basic, 2K         |         $0.0325 |             8 |
| `image-seedream-4-5`       | `seedream-4-5-high-4k`     | High, 4K          |         $0.0325 |             8 |
| `image-seedream-5-lite`    | `seedream-5-lite-basic-2k` | Basic, 2K         |         $0.0275 |             7 |
| `image-seedream-5-lite`    | `seedream-5-lite-high-3k`  | High, 3K          |         $0.0275 |             7 |
| `image-seedream-5-lite`    | `seedream-5-lite-ultra-4k` | Ultra, 4K         |         $0.0275 |             7 |
| `image-seedream-5-pro`     | `seedream-5-pro-basic-1k`  | Basic, 1K         |         $0.0350 |             8 |
| `image-seedream-5-pro`     | `seedream-5-pro-high-2k`   | High, 2K          |         $0.0700 |            15 |

GPT Image 2 1K is explicitly sold at seven EzPic Credits. This release fixes output quantity at one
image and binds exactly one owned source image. Kie makes the first Seedream 5 Pro input free and
charges $0.0025 for each additional input; any future multi-reference flow must freeze
`referenceCount` and `max(0, referenceCount - 1) * $0.0025` in the quote before it can be enabled.
Output format and background are non-billable product-local controls; they do not create additional
SKU cells or change the EzPic Credit charge.

Each model owns its own rectangular parameter matrix. Resolution, quality, SKU, and aspect-ratio
choices are validated as one product-specific cell and are never assembled from a shared global
quality or resolution table:

| Model              | Legal matrix cell(s)              |
| ------------------ | --------------------------------- |
| Nano Banana 2 Lite | 1K                                |
| Nano Banana        | Default                           |
| Nano Banana 2      | 1K; 2K; 4K                        |
| Nano Banana Pro    | 1K; 2K; 4K                        |
| GPT Image 1.5      | Medium; High                      |
| GPT Image 2        | 1K; 2K; 4K                        |
| Seedream 4.5       | Basic + 2K; High + 4K             |
| Seedream 5 Lite    | Basic + 2K; High + 3K; Ultra + 4K |
| Seedream 5 Pro     | Basic + 1K; High + 2K             |

The server rejects a SKU that belongs to another product, a nonexistent resolution/quality
combination, or an aspect ratio outside that exact cell. The canonical matrix owns the exact
per-cell aspect-ratio list and `providerCostMicros` ceiling; shared global resolution or quality
tables are not authoritative.

## New-generation and historical-recovery boundary

All new EzPic image quotes route only to Kie. The legacy `image-fast` and `image-quality` product
keys and OpenRouter adapter remain server-side solely to retrieve or reconcile already-frozen
historical attempts. OpenRouter must not appear in `MEDIA_ENABLED_PROVIDERS` for new submissions.
If historical work still needs it, put OpenRouter only in `MEDIA_RECOVERY_PROVIDERS`, retain its
worker credential and current recovery certification gate, and remove it after the backlog is
durably drained.

The retired OpenRouter benchmark in `image-edit-model-benchmark.md` is historical evidence only. It
cannot certify a Kie SKU, justify a Kie cost ceiling, or satisfy
`MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`.

## Subscription package inputs

Credits are granted per internal month and do not roll over. Annual purchases receive the same
monthly grant through twelve billing periods.

| Public plan (internal key) | Credits/month | Allowed image products      | Monthly | Annual | Whole-image range/month |
| -------------------------- | ------------: | --------------------------- | ------: | -----: | ----------------------: |
| Free (`free`, internal)    |            25 | Nano Banana 2 Lite          |      $0 |     $0 |             5 (Nano 1K) |
| Pro (`creator`)            |           700 | All 9 public image products |     $19 |   $190 |                  28–140 |
| Ultimate (`ultimate`)      |         1,800 | All 9 public image products |     $49 |   $490 |                  72–360 |
| Max (`studio`)             |         3,000 | All 9 public image products |     $79 |   $790 |                 120–600 |

The paid-plan ranges use the current minimum five-credit and maximum twenty-five-credit SKU. They are
not a promise that every mix consumes the same number of credits. Public pricing opens on annual
billing and displays the rounded `-17%` saving produced by annual prices equal to ten monthly
payments.

## Credit Pack inputs

Credit Packs are one-time purchases separate from subscriptions. Each grant expires six UTC
calendar months after its verified purchase timestamp. Paid-subscriber eligibility and the 20%
bonus are frozen on the first checkout intent and cannot change on replay.

|  Pack | Price | Base credits | Paid-subscriber credits | Subscriber bonus | Validity |
| ----: | ----: | -----------: | ----------------------: | ---------------: | -------: |
| 1,500 |   $59 |        1,500 |                   1,800 |             +20% | 6 months |
| 3,000 |  $109 |        3,000 |                   3,600 |             +20% | 6 months |
| 5,000 |  $169 |        5,000 |                   6,000 |             +20% | 6 months |
| 8,000 |  $259 |        8,000 |                   9,600 |             +20% | 6 months |

Raphael's public presentation was used only as a product-pattern reference for model-dependent
credit consumption. EzPic does not infer Raphael's Provider costs, rollover policy, or apparent
subsidies.

## Conservative planning calculation

Until reconciled production data exists, use these explicit assumptions:

- Provider variation buffer: 15% over the published Kie request price;
- EzPic runtime/storage reserve: $0.005 for an explicit 1K cell and $0.010 for 2K/3K/4K or a cell
  without an explicit resolution;
- payment processing: 4.5% of collected revenue plus $0.30 per charge;
- refund/chargeback risk reserve: 1.5% of collected revenue;
- one payment charge per monthly purchase and one payment charge per annual purchase.

```text
planned_sku_cost = Kie public price * 1.15 + EzPic runtime/storage reserve
payment_and_refund_net(monthly purchase) = price * (1 - 0.045 - 0.015) - $0.30
payment_and_refund_net(annual allocation) =
  (annual_price * (1 - 0.045 - 0.015) - $0.30) / 12
```

| SKU                        | Planned cost | Planned cost/EzPic Credit |
| -------------------------- | -----------: | ------------------------: |
| `nano-banana-2-lite-1k`    |    $0.028000 |                 $0.005600 |
| `nano-banana-default`      |    $0.033000 |                 $0.006600 |
| `nano-banana-2-1k`         |    $0.051000 |                 $0.005667 |
| `nano-banana-2-2k`         |    $0.079000 |                 $0.006077 |
| `nano-banana-2-4k`         |    $0.113500 |                 $0.005974 |
| `nano-banana-pro-1k`       |    $0.108500 |                 $0.005711 |
| `nano-banana-pro-2k`       |    $0.113500 |                 $0.005974 |
| `nano-banana-pro-4k`       |    $0.148000 |                 $0.005920 |
| `gpt-image-1-5-medium`     |    $0.033000 |                 $0.006600 |
| `gpt-image-1-5-high`       |    $0.136500 |                 $0.005935 |
| `gpt-image-2-1k`           |    $0.039500 |                 $0.005643 |
| `gpt-image-2-2k`           |    $0.067500 |                 $0.006136 |
| `gpt-image-2-4k`           |    $0.102000 |                 $0.006000 |
| `seedream-4-5-basic-2k`    |    $0.047375 |                 $0.005922 |
| `seedream-4-5-high-4k`     |    $0.047375 |                 $0.005922 |
| `seedream-5-lite-basic-2k` |    $0.041625 |                 $0.005946 |
| `seedream-5-lite-high-3k`  |    $0.041625 |                 $0.005946 |
| `seedream-5-lite-ultra-4k` |    $0.041625 |                 $0.005946 |
| `seedream-5-pro-basic-1k`  |    $0.045250 |                 $0.005656 |
| `seedream-5-pro-high-2k`   |    $0.090500 |                 $0.006033 |

Nano Banana Default and GPT Image 1.5 Medium tie for the highest conservative planned cost per
credit at `$0.006600`. The full-use tables use that value across any legal mix. It is not a public
credit-to-cash exchange rate.

The 15% variation buffer exists only in this finance worksheet. It does not silently change the
catalog or browser-visible credit charge: the quote freezes the catalog `providerCostMicros`, and
operations must investigate any reconciled Kie charge that disagrees with that snapshot.

| Plan / cadence                      | Net monthly revenue | Worst full-use variable cost | Planning gross margin |
| ----------------------------------- | ------------------: | ---------------------------: | --------------------: |
| Pro monthly                         |             $17.560 |                       $4.620 |                 73.7% |
| Pro annual, monthly allocation      |             $14.858 |                       $4.620 |                 68.9% |
| Ultimate monthly                    |             $45.760 |                      $11.880 |                 74.0% |
| Ultimate annual, monthly allocation |             $38.358 |                      $11.880 |                 69.0% |
| Max monthly                         |             $73.960 |                      $19.800 |                 73.2% |
| Max annual, monthly allocation      |             $61.858 |                      $19.800 |                 68.0% |

|         Pack | Net revenue | Base-credit cost / margin | Subscriber-credit cost / margin |
| -----------: | ----------: | ------------------------: | ------------------------------: |
|  1,500 / $59 |     $55.160 |            $9.900 / 82.1% |                 $11.880 / 78.5% |
| 3,000 / $109 |    $102.160 |           $19.800 / 80.6% |                 $23.760 / 76.7% |
| 5,000 / $169 |    $158.560 |           $33.000 / 79.2% |                 $39.600 / 75.0% |
| 8,000 / $259 |    $243.160 |           $52.800 / 78.3% |                 $63.360 / 73.9% |

These percentages are planning margins. Taxes, regional pricing, currency conversion, disputes,
abnormal retries, storage/transfer outliers, real success rate, and live PayPal/Waffo fee schedules
remain unmeasured.

## Production measurement unit

Replace every SKU planning input with cost per successfully settled image:

```text
submitted_attempt_cost = Provider billed submission + billed retries/cancellations
successful_image_cost = sum(all submitted_attempt_cost for the settled image)
                      + prompt/input/output moderation
                      + private object request, storage, and transfer allocation
                      + worker/Trigger.dev allocation
                      + observability allocation attributable to the image
```

Report the SKU key; catalog/pricing version; sample size; success, failure, uncertain, and
cancellation counts; billed currency and conversion method; p50/p95 latency and cost; Kie billing
export reference; time window; and reviewer. Do not remove a failed, retried, moderated, abandoned,
or uncertain attempt from the numerator when it incurred cost.

For each of the 20 SKU cells, keep these fields `NOT_COMPLETED` until real external evidence exists:

- paid private image-edit execution through the normal job/finalization path;
- exact output count, MIME, dimensions, private transfer, output-host policy, and moderation result;
- success/failure/uncertain/canceled counts and same-attempt recovery evidence;
- billed Provider cost and end-to-end successful cost p50/p95;
- latency p50/p95 and human quality review;
- approved production margin and rollback owner.

## Safety and synchronization

The per-job, user/day, and positive global daily Provider budgets are safety controls, not margin
evidence. Job creation must reserve the SKU's frozen EzPic Credits and cost atomically through the
existing PostgreSQL, Outbox, private storage, moderation, and immutable ledger paths.

New checkout supports only PayPal and Waffo. Every offered plan/cadence needs a matching `PLAN`
`BillingPlan`; every offered Credit Pack needs a distinct `CREDIT_PACK` snapshot. Change the image
catalog/pricing version, plan and Pack configuration, database snapshots, localized copy, Webhook
projections, and tests as one compatible release.

## Sources

Official/public pages reviewed for the current Kie contract:

- Kie pricing: <https://kie.ai/zh-CN/pricing>
- Nano Banana 2 Lite: <https://docs.kie.ai/market/google/nano-banana-2-lite.md>
- GPT Image 2 image-to-image: <https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image.md>
- Seedream 5 Pro image-to-image: <https://docs.kie.ai/market/seedream/5-pro-image-to-image.md>
- Kie task detail: <https://docs.kie.ai/market/common/get-task-detail.md>
- Raphael pricing reference: <https://raphael.app/pricing>

## Rollback and review

Catalog and pricing changes use explicit versions; historical Quote, Job, attempt, reservation,
Ledger, Checkout Intent, Purchase, Subscription, and billing snapshots remain immutable. Disable
new checkout when economics or entitlement is affected. Disable the affected Kie product first and
then global generation if shared safety is uncertain, as documented in
`../operations/ezpic-rollback.md`. Keep OpenRouter recovery available only for already-accepted
legacy work until it is durably drained.

Recalculate after any SKU, Kie price, payment fee, moderation policy, storage region, plan, tax/
refund policy, or material success-rate change, and at least weekly during initial launch monitoring.
