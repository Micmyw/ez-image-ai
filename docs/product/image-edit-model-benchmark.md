# EzPic image-edit model benchmark

## Status

This report separates public price/schema research from real image-edit certification. Public model
pages and current adapter/worker contracts were reviewed on 2026-09-05. No paid Provider call or
human image review was performed.

| Evidence or decision                                           | Status            |
| -------------------------------------------------------------- | ----------------- |
| Official/public pricing review                                 | **COMPLETED**     |
| Current adapter/worker compatibility review                    | **COMPLETED**     |
| OpenRouter top-up minimum-fee allocation                       | **NOT_COMPLETED** |
| Authorized source images                                       | **NOT_COMPLETED** |
| Real Provider executions                                       | **NOT_COMPLETED** |
| First-result usability and human quality scoring               | **NOT_COMPLETED** |
| Measured success rate, latency, retry rate, and billed cost    | **NOT_COMPLETED** |
| OpenRouter Standard and Quality production route certification | **NOT_COMPLETED** |

Pricing version `2026-09-05.1` retains only two executable catalog routes. They remain fail-closed
behind `MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED`; a compatible request shape and a public price do
not certify real private image-edit behavior.

## Research findings

Provider/model details are server/operator-only and are not exposed in the public catalog or browser.

| Provider/model                               |                                              Public cost observed | Image-edit contract result                                                                                                                                       | Catalog decision                                                          |
| -------------------------------------------- | ----------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| OpenRouter / `sourceful/riverflow-v2.5-fast` |                                              1K $0.019; 2K $0.021 | Current request/response path is locally compatible; real private execution and scoring remain unverified                                                        | Retained as Standard at a $0.023 planning ceiling; 5 credits              |
| OpenRouter / `sourceful/riverflow-v2.5-pro`  |                                      1K $0.13; 2K $0.15; 4K $0.17 | Current request/response path is locally compatible; real private execution and scoring remain unverified                                                        | Retained as Quality at a $0.180 planning ceiling; 40 credits              |
| Replicate / `black-forest-labs/flux-schnell` |                                                  $0.003 per image | Published/current schema is text-to-image and does not satisfy the required image-edit input contract                                                            | Removed from executable catalog                                           |
| fal / `fal-ai/flux/schnell`                  |                                              $0.003 per megapixel | Root endpoint is text-to-image and does not satisfy the required image-edit input contract                                                                       | Removed from executable catalog                                           |
| Gemini / `gemini-2.5-flash-image`            | Standard output about $0.039 plus roughly $0.00008-$0.00031 input | Model can edit images, but the current adapter accepts only a data URI while the worker supplies a private HTTPS URL; current execution contract is incompatible | Removed from executable catalog pending a safe adapter/worker integration |

OpenRouter's public FAQ says the credit-purchase fee is 5.5% and the minimum fee is $0.80 per top-up.
Operations must top up at least $14.55 for the percentage fee to dominate; the recommended minimum
top-up is $20. Under that rule, the highest listed Fast and Pro tiers become $0.022155 and $0.17935.
The rounded $0.023/$0.180 values are catalog usage/quote ceilings, not unconditional all-cash cost
caps. They exclude arbitrary allocation of the per-top-up minimum. Until real top-ups and settled-edit
volumes are reconciled, minimum-fee allocation remains **NOT_COMPLETED**.

For top-up amount `T`, the actual funding fee is `max(0.055 * T, $0.80)`. A benchmark cost report must
either prove the at-least-$14.55 rule (and the recommended $20 operating policy) or allocate the
actual fee across the edits funded by that purchase before any gross-margin approval.

The Replicate and fal findings are endpoint-contract decisions, not claims that those platforms have
no image-edit product. The Gemini finding is an implementation mismatch, not a model capability
rejection. None should be restored merely because its list price is lower: restoration requires an
adapter that preserves private-asset authorization, SSRF/remote URL policy, streaming/size limits,
moderation, durable attempt evidence, and uncertain-submission recovery.

## Reproducible dry-run snapshot

The committed manifest contains no images. It defines ten placeholder input slots, two in each
required category, with three distinct synthetic edit tasks each:

- product on white background;
- portrait;
- indoor scene;
- outdoor scene;
- complex multi-object scene.

With the two retained catalog routes, the dry-run plan is:

| Item                      |    Planned value | Evidence meaning                                                                                    |
| ------------------------- | ---------------: | --------------------------------------------------------------------------------------------------- |
| Placeholder inputs        |               10 | Manifest shape only; no authorization claim                                                         |
| Edit tasks                |               30 | Three tasks per placeholder input                                                                   |
| Executable catalog routes |                2 | Locally compatible, not production-certified                                                        |
| Planned invocations       |               60 | 30 tasks multiplied by two routes                                                                   |
| Maximum catalog estimate  | 6,090,000 micros | 30 x $0.023 plus 30 x $0.180; assumes the $20 minimum credit-purchase policy and is not billed cost |

Run it from the repository root:

```bash
pnpm provider:benchmark:image-edit
```

The command defaults to dry-run and makes zero Provider calls. Its JSON report must keep real metrics
and route certification `NOT_COMPLETED` until authorized evidence exists. An exact retained route can
be planned explicitly without making a call:

```bash
pnpm provider:benchmark:image-edit -- --route=image-fast:openrouter:sourceful/riverflow-v2.5-fast
```

## Live-run gates

A live harness invocation must include all of the following before any Provider call is possible:

1. `--live` and `--confirm-spend`;
2. a positive safe-integer `--max-budget-micros` covering the complete selected-route ceiling;
3. one or more exact current tuples selected with `--route`;
4. a private manifest in which every source is an authorized private asset;
5. the server-only credential for every selected Provider;
6. an executor bound to the existing production job, moderation, storage, and finalization path;
7. the exact route's production certification gate enabled only after the required evidence review.
8. evidence that OpenRouter credits were purchased in batches of at least $20, or a replacement
   budget that explicitly allocates the $0.80 minimum purchase fee.

The core harness checks the plan before the first case and executes sequentially. Before each next
call it combines observed cost with the remaining catalog ceiling and fails closed if that would
exceed the explicit maximum. It stops after unknown or above-budget observed cost. This cannot undo a
charge for the already-submitted call; it prevents an unbounded sequence of later calls.

The checked-in CLI intentionally has no direct Provider executor. A direct call would bypass input
authorization, remote URL/DNS policy, private transfer, output moderation, durable attempt evidence,
and uncertain-submission recovery. Any authorized operator binding must reuse those paths.

Example syntax only after the private executor and external prerequisites are supplied:

```bash
pnpm provider:benchmark:image-edit -- --live --confirm-spend --max-budget-micros=<positive-integer> --manifest=<private-manifest-path> --route=<product:provider:model>
```

## Scorecard contract

Each executed case can record only sanitized observations:

- Provider/model tuple and terminal result category;
- first-result usability;
- 1-5 subject-preservation, prompt-adherence, and visual-quality scores;
- latency and billed Provider cost when reconciled;
- output count, image MIME, and dimensions;
- moderation/Provider rejection category and retry count;
- proof that the output was stored privately and approved by output moderation.

The aggregate scorecard computes coverage, success rate, first-result usability, p50/p95, cost totals,
average human scores, MIME/dimension counts, rejection counts, and retries. The first-result usability
denominator is the complete planned invocation count, including failures and rejections. Partial or
unscored data remains `NOT_COMPLETED`. The harness never certifies Standard or Quality automatically;
an authorized human must review complete private outputs for the exact tuple and pricing version.

## Privacy and execution boundary

Source images, prompts, authorization records, asset IDs, URLs/signed URLs, raw Provider payloads,
credentials, and individual rating records stay private. The browser submits only `image-fast` or
`image-quality`; it never receives Provider, model, cost, credential, or routing information. A live
success is invalid unless output passed the existing remote URL policy, private transfer, and output
moderation path.

No Provider call, output, latency, success rate, billed cost, or route certification is claimed in
this report. Production OpenRouter execution remains **NOT_COMPLETED** and
`MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED` must remain false until the exact retained tuples have real
private execution, billing reconciliation, and human scorecard evidence.

## Raphael comparison boundary

Raphael's public pricing page lists Pro $20/2,000 credits, Ultimate $40/5,000 credits, and Max
$80/10,000 credits, with a displayed 50% annual discount and model-dependent credit consumption.
Subscription-credit rollover was not confirmed. This is a UX/pricing reference only; EzPic does not
infer Raphael's Provider costs or copy apparent zero-credit routes and cross-model subsidies.

## Sources

Official/public pages accessed 2026-09-05:

- OpenRouter Riverflow Fast: <https://openrouter.ai/sourceful/riverflow-v2.5-fast>
- OpenRouter Riverflow Pro: <https://openrouter.ai/sourceful/riverflow-v2.5-pro>
- OpenRouter FAQ / PAYG credit fee: <https://openrouter.ai/docs/faq>
- Replicate FLUX Schnell: <https://replicate.com/black-forest-labs/flux-schnell>
- fal FLUX Schnell: <https://fal.ai/models/fal-ai/flux/schnell>
- Google Gemini API pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Raphael pricing: <https://raphael.app/pricing>

## Rollback

There is no database migration in this research record. A pricing/catalog rollback must restore route
membership, server-only cost ceilings, per-edit credits, pricing version, plan values, localized copy,
`BillingPlan` snapshots, and tests as one compatible set. Existing Quote, job, credit, purchase,
subscription, storage, and moderation history remains immutable.
