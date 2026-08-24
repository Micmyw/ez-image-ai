# EzPic image-edit model benchmark

## Status

This document is the PR 2 benchmark report. The reproducible harness and dry-run contract are
implemented, but no real Provider benchmark has been performed.

| Evidence or decision                                               | Status            |
| ------------------------------------------------------------------ | ----------------- |
| Authorized source images                                           | **NOT COMPLETED** |
| Real Provider executions                                           | **NOT COMPLETED** |
| First-result usability review                                      | **NOT COMPLETED** |
| Subject-preservation, prompt-adherence, and visual-quality scoring | **NOT COMPLETED** |
| Measured success rate                                              | **NOT COMPLETED** |
| Measured latency p50/p95                                           | **NOT COMPLETED** |
| Measured or billed Provider cost                                   | **NOT COMPLETED** |
| Standard Edit final route                                          | **NOT COMPLETED** |
| Quality Edit final route                                           | **NOT COMPLETED** |

The current `image-fast` and `image-quality` catalog routes are candidates inherited from the
foundation. This report does not certify them for image editing, and PR 2 does not change their
weights, Provider cost estimates, credits, catalog version, or pricing version.

## Reproducible dry-run snapshot

The committed manifest contains no images. It defines ten placeholder input slots, two in each
required category, with three distinct synthetic task kinds each:

- product on white background;
- portrait;
- indoor scene;
- outdoor scene;
- complex multi-object scene.

The dry-run plan is:

| Item                       |  Planned value | Evidence meaning                                        |
| -------------------------- | -------------: | ------------------------------------------------------- |
| Placeholder inputs         |             10 | Manifest shape only; no authorization claim             |
| Edit tasks                 |             30 | Three tasks per placeholder input                       |
| Current catalog candidates |              3 | Internal candidate tuples, not certified routes         |
| Planned invocations        |             90 | 30 tasks multiplied by three candidates                 |
| Maximum catalog estimate   | 435,000 micros | Uncertified catalog estimate, not actual or billed cost |

Run it from the repository root:

```bash
pnpm provider:benchmark:image-edit
```

The command defaults to dry-run and makes zero Provider calls. Its JSON report labels certification,
all real metrics, and both route decisions `NOT_COMPLETED`.

An internal candidate can be planned explicitly without making a call:

```bash
pnpm provider:benchmark:image-edit -- --route=image-fast:replicate:black-forest-labs/flux-schnell
```

## Candidate and decision record

Provider and model details below are server/operator-only. They are not part of the public catalog.

| Public mode   | Internal candidate                           | Catalog estimate | Final selection   | Rejection reason                                       |
| ------------- | -------------------------------------------- | ---------------: | ----------------- | ------------------------------------------------------ |
| Standard Edit | `replicate / black-forest-labs/flux-schnell` |     3,000 micros | **NOT COMPLETED** | **NOT COMPLETED** — no authorized run or human scoring |
| Standard Edit | `fal / fal-ai/flux/schnell`                  |     3,500 micros | **NOT COMPLETED** | **NOT COMPLETED** — no authorized run or human scoring |
| Quality Edit  | `gemini / gemini-2.5-flash-image`            |     8,000 micros | **NOT COMPLETED** | **NOT COMPLETED** — no authorized run or human scoring |

Marketing names and the public API remain `Standard Edit` and `Quality Edit`. Both public products
continue to accept only `image-to-image`, and the public catalog continues to omit Provider, model,
cost, and route-weight fields.

## Live-run gates

A live harness invocation must include all of the following before any Provider call is possible:

1. `--live`;
2. `--confirm-spend`;
3. a positive safe-integer `--max-budget-micros` that is at least the complete selected-route
   catalog ceiling;
4. one or more exact current catalog tuples selected with `--route` (or all candidates);
5. a private manifest in which every source is a private asset and every authorization record is
   complete;
6. the server-only credential for every selected Provider;
7. an executor bound to the existing production job and private finalization path.

The core harness checks the entire plan before invoking the first case and executes cases
sequentially. Before each subsequent call, it combines observed cost with the remaining catalog
ceiling and fails closed if that amount would exceed the explicit maximum. It also stops further
calls when a completed call reports unknown cost or observed cost above the maximum. This cannot
guarantee or undo the real charge for that already-completed single call; it only guarantees that no
subsequent call is made without known remaining budget. The checked-in CLI intentionally does not
install a direct Provider executor: direct adapter calls would bypass input authorization, remote
URL/DNS policy, private storage transfer, output moderation, durable attempt evidence, and
uncertain-submission recovery. A future authorized operator binding must reuse those existing paths
rather than create a second Provider or storage architecture.

Example syntax after the private executor and all external prerequisites are supplied:

```bash
pnpm provider:benchmark:image-edit -- --live --confirm-spend --max-budget-micros=<positive-integer> --manifest=<private-manifest-path> --route=<product:provider:model>
```

## Scorecard contract

Each executed case can record only sanitized observations:

- Provider/model tuple and terminal result category;
- first-result usability;
- 1–5 subject-preservation, prompt-adherence, and visual-quality scores;
- latency;
- Provider cost in micros when measured;
- output count, image MIME, and dimensions;
- moderation/Provider rejection category;
- retry count;
- proof that the output was stored privately and approved by output moderation.

The aggregate scorecard computes route coverage, success rate, first-result usability, p50/p95,
cost totals, average human scores, MIME/dimension counts, rejection counts, and retries. The
first-result usability denominator is the complete planned invocation count: failures, Provider
rejections, and moderation rejections are first-result unusable. Partial or unscored data remains
`NOT_COMPLETED`. The harness never selects Standard or Quality automatically; an authorized human
must record the final selection and rejection reasons after reviewing complete private outputs
against the PR 2 thresholds.

## Privacy boundary

Source images, prompts, authorization records, source asset IDs, output asset IDs, URLs, signed URLs,
raw Provider payloads, credentials, and individual human rating records stay private. The report
contains only category/task counts, internal candidate tuples, and aggregate scorecard values. Live
success is invalid unless output passed the existing remote URL policy, private transfer, and output
moderation path.

## External and human prerequisites

Real benchmarking remains blocked on all of the following:

- at least one Provider test account and server-only credential;
- a user-approved positive maximum spend budget;
- ten or more authorized private test images with retained evidence;
- an authorized human scorer;
- an operational binding to the existing private generation/finalization pipeline.

No credential was read or used for this report. No Provider call, real output, real cost, real
latency, real success rate, or routing certification is claimed.

## Rollback

There is no database migration. Rollback removes the benchmark script/export, fixture contracts,
environment path, and documentation. Existing catalog routes, stored quotes/jobs, credits, pricing,
Provider adapters, storage, moderation, payment, and administration remain unchanged.
