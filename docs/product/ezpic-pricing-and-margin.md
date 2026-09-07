# EzPic pricing and margin record

## Decision snapshot

Image pricing version `2026-09-07.2` uses one `EzPic Credit` balance and 20 legal image-edit SKU
cells across nine products. The plan and Credit Pack amounts below are product decisions and local
application contracts. Kie public prices are planning inputs only; no paid Kie execution,
reconciled bill, or production margin has been certified.

| Evidence or decision                                       | Status            |
| ---------------------------------------------------------- | ----------------- |
| Kie public SKU price/parameter research dated 2026-09-07   | **COMPLETED**     |
| Local SKU, quote, plan, Credit Pack, and grant contract    | **COMPLETED**     |
| Real paid Kie execution across all 20 SKU cells            | **NOT_COMPLETED** |
| Reconciled Kie billing and measured success rate           | **NOT_COMPLETED** |
| Kie output-host and private transfer certification         | **NOT_COMPLETED** |
| Production payment-provider checkout/Webhook certification | **NOT_COMPLETED** |
| Matching production `BillingPlan` snapshots                | **NOT_COMPLETED** |
| Legal seller identity, refund, tax, and dispute policy     | **NOT_COMPLETED** |
| Deployment and live verification                           | **NOT_COMPLETED** |

No secret, Provider credential, production payment ID, private media reference, or customer
information is recorded here.

## Subscription package contract

`packages/config/plans.ts` is the source of truth. Credits are issued once per internal monthly
billing period, expire at that period boundary, and do not roll over. Annual billing still creates
twelve monthly grant periods.

| Public plan (internal key) | Credits/month | Concurrent edits | Products                    | Max input | Monthly | Annual | Approximate images/month |
| -------------------------- | ------------: | ---------------: | --------------------------- | --------: | ------: | -----: | -----------------------: |
| Free (`free`, internal)    |            25 |                1 | Nano Banana 2 Lite          |     10 MB |      $0 |     $0 |           5 at 5 Credits |
| Pro (`creator`)            |           700 |                3 | All 9 public image products |     20 MB |     $19 |   $190 |                   28–140 |
| Ultimate (`ultimate`)      |         1,800 |                6 | All 9 public image products |     20 MB |     $49 |   $490 |                   72–360 |
| Max (`studio`)             |         3,000 |               10 | All 9 public image products |     20 MB |     $79 |   $790 |                  120–600 |

The paid-plan ranges divide the allowance by the current maximum twenty-five-credit and minimum
five-credit SKU and count only whole outputs. Mixed usage draws from the same EzPic Credit balance.
The UI displays the exact SKU charge before confirmation; it does not advertise one universal
per-image charge. Annual prices equal ten monthly payments, so the public rounded discount is
`-17%`.

All plans retain owner-scoped private assets, metering, moderation, durable jobs, and the immutable
credit ledger. The browser submits stable product/SKU keys and supported parameters only. Provider
identity, raw model ID, routing weights, credentials, raw payloads, and dollar costs remain
server-only.

## Legal image SKU table

Each model owns an independent rectangular parameter matrix. A resolution or quality choice from
one model is never reused to construct another model's request.

| Product            | SKU                        | Resolution | Quality | Kie public cost | EzPic Credits |
| ------------------ | -------------------------- | ---------- | ------- | --------------: | ------------: |
| Nano Banana 2 Lite | `nano-banana-2-lite-1k`    | 1K         | —       |         $0.0200 |             5 |
| Nano Banana        | `nano-banana-default`      | —          | —       |         $0.0200 |             5 |
| Nano Banana 2      | `nano-banana-2-1k`         | 1K         | —       |         $0.0400 |             9 |
| Nano Banana 2      | `nano-banana-2-2k`         | 2K         | —       |         $0.0600 |            13 |
| Nano Banana 2      | `nano-banana-2-4k`         | 4K         | —       |         $0.0900 |            19 |
| Nano Banana Pro    | `nano-banana-pro-1k`       | 1K         | —       |         $0.0900 |            19 |
| Nano Banana Pro    | `nano-banana-pro-2k`       | 2K         | —       |         $0.0900 |            19 |
| Nano Banana Pro    | `nano-banana-pro-4k`       | 4K         | —       |         $0.1200 |            25 |
| GPT Image 1.5      | `gpt-image-1-5-medium`     | —          | Medium  |         $0.0200 |             5 |
| GPT Image 1.5      | `gpt-image-1-5-high`       | —          | High    |         $0.1100 |            23 |
| GPT Image 2        | `gpt-image-2-1k`           | 1K         | —       |         $0.0300 |             7 |
| GPT Image 2        | `gpt-image-2-2k`           | 2K         | —       |         $0.0500 |            11 |
| GPT Image 2        | `gpt-image-2-4k`           | 4K         | —       |         $0.0800 |            17 |
| Seedream 4.5       | `seedream-4-5-basic-2k`    | 2K         | Basic   |         $0.0325 |             8 |
| Seedream 4.5       | `seedream-4-5-high-4k`     | 4K         | High    |         $0.0325 |             8 |
| Seedream 5 Lite    | `seedream-5-lite-basic-2k` | 2K         | Basic   |         $0.0275 |             7 |
| Seedream 5 Lite    | `seedream-5-lite-high-3k`  | 3K         | High    |         $0.0275 |             7 |
| Seedream 5 Lite    | `seedream-5-lite-ultra-4k` | 4K         | Ultra   |         $0.0275 |             7 |
| Seedream 5 Pro     | `seedream-5-pro-basic-1k`  | 1K         | Basic   |         $0.0350 |             8 |
| Seedream 5 Pro     | `seedream-5-pro-high-2k`   | 2K         | High    |         $0.0700 |            15 |

The first release always requests one output and binds exactly one owned source image. Kie's
Seedream 5 Pro price makes the first input image free and adds $0.0025 for each input after the
first; therefore the current one-source cells keep the base prices above. Any future multi-reference
flow must freeze `referenceCount` and `max(0, referenceCount - 1) * $0.0025` in the quote rather than
silently absorbing that variable cost. The server validates the exact product/SKU/aspect-ratio tuple
and freezes the corresponding credit and cost values in the quote. Output format and background are
product-local request controls, not billing dimensions; choosing them does not create another SKU or
change the EzPic Credit amount.

## Credit Pack contract

`packages/config/credit-packs.ts` and its server-only snapshot are the source of truth for one-time
Credit Packs. Credits expire six UTC calendar months after the verified purchase timestamp. The
first checkout intent freezes paid-subscriber eligibility and the 20% bonus.

|  Pack | Price | Base credits | Paid-subscriber credits | Subscriber bonus | Validity |
| ----: | ----: | -----------: | ----------------------: | ---------------: | -------: |
| 1,500 |   $59 |        1,500 |                   1,800 |             +20% | 6 months |
| 3,000 |  $109 |        3,000 |                   3,600 |             +20% | 6 months |
| 5,000 |  $169 |        5,000 |                   6,000 |             +20% | 6 months |
| 8,000 |  $259 |        8,000 |                   9,600 |             +20% | 6 months |

Credit Packs never create or replace a subscription. Verified payment events are persisted first;
the reducer grants one expiring lot through the same immutable ledger. Duplicate capture/Webhook
delivery cannot grant twice. PayPal cumulative partial/full reversals apply only the idempotent delta
to the frozen grant and turn already-consumed refunded credits into Debt. Waffo refund success or
failure remains fail-closed in manual `REVIEW` and does not automatically mutate credit history.

## Kie price guard and Provider boundary

The server-only catalog freezes the Kie planning ceiling shown by each of the 20 SKU rows above, from
20,000 through 120,000 USD micros. These values match the reviewed public request prices but do not
prove what a real task will bill. All 20 remain non-certified until paid private execution and
billing reconciliation are recorded for catalog version `2026-09-07.2`.

New image submissions require `kie` in `MEDIA_ENABLED_PROVIDERS`, a worker-side `KIE_API_KEY`, the
relevant per-product flag, and the active catalog version in
`MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`. A configured key or passing adapter test is not
certification.

OpenRouter Standard/Quality routes are retired from new EzPic generation. `image-fast` and
`image-quality` remain only for already-frozen historical job recovery; an operator may retain
OpenRouter in `MEDIA_RECOVERY_PROVIDERS` without placing it in `MEDIA_ENABLED_PROVIDERS`. The legacy
`image-edit-model-benchmark.md` cannot satisfy any Kie certification or pricing gate.

## Raphael public comparison

Raphael's public pricing page was used as a product-pattern comparison, not as evidence of its
internal cost or as a target EzPic subsidy level. Raphael communicates that credit use varies by
model; EzPic applies the same understandable wallet concept to its own explicitly listed SKU
charges. EzPic does not infer Raphael's Provider costs, rollover rule, or apparent zero-credit
routes.

## Conservative full-use economics

These estimates use public Kie list prices plus conservative assumptions, not a Provider invoice:

- payment processing: 4.5% of collected revenue plus $0.30 per charge;
- refund/chargeback risk reserve: 1.5% of collected revenue;
- Provider variation buffer: 15% over each Kie public SKU price;
- EzPic runtime/storage reserve: $0.005 for an explicit 1K cell and $0.010 for 2K/3K/4K or a cell
  without an explicit resolution;
- one payment charge per monthly purchase and one per annual purchase.

| SKU                        | Buffered Kie cost plus EzPic reserve | Planned cost/Credit |
| -------------------------- | -----------------------------------: | ------------------: |
| `nano-banana-2-lite-1k`    |                            $0.028000 |           $0.005600 |
| `nano-banana-default`      |                            $0.033000 |           $0.006600 |
| `nano-banana-2-1k`         |                            $0.051000 |           $0.005667 |
| `nano-banana-2-2k`         |                            $0.079000 |           $0.006077 |
| `nano-banana-2-4k`         |                            $0.113500 |           $0.005974 |
| `nano-banana-pro-1k`       |                            $0.108500 |           $0.005711 |
| `nano-banana-pro-2k`       |                            $0.113500 |           $0.005974 |
| `nano-banana-pro-4k`       |                            $0.148000 |           $0.005920 |
| `gpt-image-1-5-medium`     |                            $0.033000 |           $0.006600 |
| `gpt-image-1-5-high`       |                            $0.136500 |           $0.005935 |
| `gpt-image-2-1k`           |                            $0.039500 |           $0.005643 |
| `gpt-image-2-2k`           |                            $0.067500 |           $0.006136 |
| `gpt-image-2-4k`           |                            $0.102000 |           $0.006000 |
| `seedream-4-5-basic-2k`    |                            $0.047375 |           $0.005922 |
| `seedream-4-5-high-4k`     |                            $0.047375 |           $0.005922 |
| `seedream-5-lite-basic-2k` |                            $0.041625 |           $0.005946 |
| `seedream-5-lite-high-3k`  |                            $0.041625 |           $0.005946 |
| `seedream-5-lite-ultra-4k` |                            $0.041625 |           $0.005946 |
| `seedream-5-pro-basic-1k`  |                            $0.045250 |           $0.005656 |
| `seedream-5-pro-high-2k`   |                            $0.090500 |           $0.006033 |

Nano Banana Default and GPT Image 1.5 Medium tie for the highest conservative planning cost per
EzPic Credit at `$0.006600`. The higher reserve is intentional because neither cell exposes a
resolution parameter; treating either as 1K would understate an unverified workload.

The 15% buffer is a finance-planning reserve only. It is not added to the browser-visible EzPic
Credit amount or silently written into a quote; the quote freezes the catalog cost, and a different
reconciled Kie charge requires operator review.

| Plan / cadence                      | Net monthly revenue after assumptions | Worst full-use variable cost | Planning gross margin |
| ----------------------------------- | ------------------------------------: | ---------------------------: | --------------------: |
| Pro monthly                         |                               $17.560 |                       $4.620 |                 73.7% |
| Pro annual, monthly allocation      |                               $14.858 |                       $4.620 |                 68.9% |
| Ultimate monthly                    |                               $45.760 |                      $11.880 |                 74.0% |
| Ultimate annual, monthly allocation |                               $38.358 |                      $11.880 |                 69.0% |
| Max monthly                         |                               $73.960 |                      $19.800 |                 73.2% |
| Max annual, monthly allocation      |                               $61.858 |                      $19.800 |                 68.0% |

|         Pack | Net revenue | Base-credit cost / margin | Subscriber-credit cost / margin |
| -----------: | ----------: | ------------------------: | ------------------------------: |
|  1,500 / $59 |     $55.160 |            $9.900 / 82.1% |                 $11.880 / 78.5% |
| 3,000 / $109 |    $102.160 |           $19.800 / 80.6% |                 $23.760 / 76.7% |
| 5,000 / $169 |    $158.560 |           $33.000 / 79.2% |                 $39.600 / 75.0% |
| 8,000 / $259 |    $243.160 |           $52.800 / 78.3% |                 $63.360 / 73.9% |

These are planning margins, not live Kie, PayPal, or Waffo evidence. Taxes, currency conversion,
regional pricing, disputes, retries, storage/transfer outliers, and real success rate remain
unmeasured.

## Billing, credits, and synchronization gate

New subscription and Credit Pack checkout supports only PayPal and Waffo. Each offered plan/cadence
and Pack needs a matching immutable server-side product identifier and `BillingPlan` or Pack
snapshot. Missing, malformed, cross-environment, or economically mismatched configuration fails
closed. Checkout return grants no credits; verified events and Outbox workers own every grant,
renewal, cancellation, refund, Debt, release, and replay.

Subscription pricing uses image pricing version `2026-09-07.2`; Credit Pack catalog/pricing/
eligibility remains `2026-09-06.1`. Update public copy, catalog, server snapshots, Webhook projection,
and tests together. Stripe remains optional only for historical lifecycle maintenance and is not
available for new checkout.

## Production completion gate

Before public paid generation is enabled, record without copying secrets:

1. paid runs for all 20 Kie SKU cells through quote, reservation, Outbox, private transfer, output
   moderation, and settlement;
2. exact output count/MIME/dimensions, valid output host, human quality scores, success/failure/
   uncertain counts, p50/p95 latency, and same-attempt recovery;
3. reconciled Kie task consumption and billing against each frozen SKU cost ceiling;
4. test and live checkout/Webhook evidence for PayPal and Waffo, including the documented refund
   boundaries, and legacy Stripe evidence only if that lifecycle remains configured;
5. synchronized production snapshots, legal seller/refund/tax decisions, alerting, moderation,
   storage, deployment, rollback, and live verification.

Real paid Kie verification is currently **NOT_COMPLETED**. No OpenRouter benchmark, local mock, unit
test, or dry-run smoke may be substituted for those 20 cell-specific artifacts.

## Sources

- Kie pricing: <https://kie.ai/zh-CN/pricing>
- Nano Banana 2 Lite: <https://docs.kie.ai/market/google/nano-banana-2-lite.md>
- GPT Image 2 image-to-image: <https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image.md>
- Seedream 5 Pro image-to-image: <https://docs.kie.ai/market/seedream/5-pro-image-to-image.md>
- Kie task detail: <https://docs.kie.ai/market/common/get-task-detail.md>
- Raphael pricing reference: <https://raphael.app/pricing>

## Rollback

Disable new checkout when economics or entitlement is affected and disable the affected Kie product
before global generation when the incident is isolated. Preserve immutable Quote, attempt,
reservation, Ledger, Checkout Intent, Fulfillment, Purchase, Subscription, and billing history.
Restore product/SKU matrices, cost and credit values, catalog/pricing versions, plan/Pack
configuration, localized copy, database snapshots, and tests as one compatible set. Keep any
required OpenRouter historical recovery path available until its already-accepted backlog is
durably drained.
