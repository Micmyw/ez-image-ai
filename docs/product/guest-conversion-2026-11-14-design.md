# Guest conversion and first useful result — 2026-11-14

## Authorization and intent

The owner requested coordinated design, parallel implementation and central acceptance of the six proposals and selected items from the 100-item list. Preserve the existing local administrator customer-content feature and other contributors' work. This authorizes local implementation and relevant verification; it does not authorize production writes, paid provider calls, publication or deployment.

The subsequent request prioritizes feasibility and measured timing of proposal 3 (provider result preview before archive completion) and proposal 4 (output review parallel with archive). Evaluate that output protocol separately before changing its state machine. Other independent, explicitly selected improvements continue.

## Decisions

1. Start guest upload and input review after file selection, once immutable upload is complete. Keep pending review out of ordinary user-facing progress; failures still explain the required action. The Generate action reuses the same upload and review. Pending is never approval.
2. Keep transactional job/credit/idempotency admission. Existing ordinary Generate does not read the entire R2 input; do not remove financial or ownership checks in the name of avoiding storage reads. Optimize repeated work rather than creating untracked provider calls.
3. UI rate feedback is simple; server-side upload and entitlement controls remain authoritative. Never restore retired IP, subnet or site-wide daily cost caps. Repeated preparation/completion of one identity does not count as a new upload.
4. Free guest access covers exactly MiniMax H3 1K and Nano Banana 2 Lite 1K. One trial means once per identifiable anonymous browser/account, not provably once per natural person. Existing granted/purchased balances remain valid. Registered lifetime 10-credit allowance remains a separate existing contract.
5. New free eligibility excludes only the explicitly named network country IN. Do not infer a broader country list or nationality. Use server-verified request location, never client claims; do not embed personalized eligibility in cached public HTML. Historical allowances are not revoked.
6. Preserve original images, prompt, public model/SKU, parameters and destination across authentication, cancellation and navigation back. Reuse same-object review evidence. A genuine private server copy may inherit evidence only through a verified immutable-copy contract, never a browser approval flag.
7. Google social sign-in and magic link already exist. Improve their presentation and recovery. Google One Tap is a separate added request; its callback must retain anonymous-account linking, attribution and existing authentication gates.
8. Only generic implicit model selection may prefer a guest-compatible route. Explicit model, user selection, SEO route and paid Sheru template choices take precedence.
9. Preserve homepage THD title/H1 observation and public indexing. New purchase presentation uses existing offer coverage and accepted funding rules; no new prices or blanket Image Pass coverage.
10. Analytics distinguish file selection, actual upload, click, draft, admitted job, authenticated session and visible image. Optional tracking cannot block business work or prove payment. Never store prompts, image URLs, filenames or authorization tokens in telemetry.

## Selected scope and owners

| Workstream                                                     | Owner                                              | Selected items                     | Acceptance boundary                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Early guest preparation and composer integration               | guest worker                                       | 1, 2, 29, 39; owner proposals 1/2  | One upload/review identity; replacement races and ambiguous retries preserve the original attempt                                                               |
| Guest benefits and request eligibility                         | trial worker                                       | owner proposal 5                   | Exact two 1K SKUs, persistent identifiable-guest one-time receipt, all login-grant entry points obey trusted eligibility                                        |
| Authentication and draft restoration                           | auth worker                                        | 11, 12, 13, 17, 18, 19; proposal 6 | Original file and parameters survive cancellation, return navigation and supported login callbacks                                                              |
| Purpose, refinement and contextual purchase                    | experience worker                                  | 5, 9, 42, 51, 99                   | Explicit choices win; owner-scoped refine; new pass offer shown only when current SKU is covered                                                                |
| Upload compatibility, cached capability and truthful estimates | compatibility worker                               | 27, 32, 34                         | Decode/normalize before hashing; bounded processing; no fabricated wait estimate; deduplicated public fetch                                                     |
| Journey diagnostics and voluntary feedback                     | measurement worker                                 | 35, 91, 92, 93, 98, 100            | Distinct trusted facts/observations; prefetch excluded; existing support and experiment machinery reused                                                        |
| Output latency protocol                                        | coordinator and output reviewer                    | owner proposals 3/4                | Measured boundaries, same reviewed bytes, authenticated preview, durable recovery and single settlement                                                         |
| Administrator content and cleanup                              | administrator, diagnostics and measurement workers | later owner request                | Guest/account inputs and prompts, including failures without assets; truthful moderation/model provenance; exact auditable deletion with active-work protection |

Shared router/barrel exports, translation JSON, final integration and cross-package acceptance are coordinator-owned. `LandingGenerator.tsx` has one editing owner. Other workers provide independent helpers/components and small integration contracts. Never run SaaS Vitest, Fumadocs generation and Playwright concurrently because they share `.source`.

## Output feasibility

Current production shape: authenticated provider retrieval → source download/private archive and bookkeeping → reread private image and prepare review image → SeeAPI → persisted verdict → authorized preview.

A provider callback currently wakes authenticated retrieval. Its attempt-bound callback authorization is not a supplier signature over the complete result body. It cannot authorize a raw result URL by itself.

Sending a compatible static JPEG/PNG URL to SeeAPI and opening the same URL in a browser is technically possible. Current provider and moderation contracts do not establish immutable contents or matching content digests. A URL alone cannot prove the reviewed, displayed and archived bytes match. Expiry, owner access, withdrawal and link recovery also require a defined protocol.

The subsequent [source-level design review](../operations/output-preview-parallel-review-2026-11-14.md) narrows this proposal: feed one source read to the existing conditional original write and bounded preview preparation. Review submission requires complete source identity and validated preview bytes. Publishing also requires proof that the selected immutable original matches the preview's source; a conditional-write winner may differ from a later supplier response. Use a separate private preview purpose/candidate relation with distinct visibility, download, input and settlement capabilities. Archive failure retries the same result, never the model. Format/size/runtime unsupported paths keep the existing implementation.

The safe first version can move later original bookkeeping/settlement off the preview's visible path, while retaining the existing complete immutable R2 object for recovery. A small durable preview/candidate/verdict record recovers the preview, not missing full-resolution bytes. Removing all original persistence from the visible path requires either a verified supplier immutability/retention contract or explicit handling of a preview whose original ultimately cannot be delivered. That guarantee was missing from the preliminary proposal. Direct supplier-URL presentation remains conditional and unimplemented.

## Production timing evidence

Window: 2026-11-13 13:36:12 to 2026-11-14 13:36:12 Asia/Shanghai. Cloudflare production Workflow logs, 17 matched output assets, 13 READY and 4 QUARANTINED; includes internal demonstration tasks and is not a customer-only conversion cohort. Queries returned sampling level 1. Times below are log-observation intervals, not pure storage or SQL service times, nor actual browser visibility.

| Boundary                                                                     | n   | P50      | P90      | Max      |
| ---------------------------------------------------------------------------- | --- | -------- | -------- | -------- |
| Most recent finalization execution before archive handoff → handoff          | 17  | 5.411 s  | 10.391 s | 15.677 s |
| Archive handoff → persisted-verdict observation                              | 17  | 14.912 s | 20.984 s | 23.902 s |
| Same-task sum of those two intervals                                         | 17  | 20.391 s | 31.828 s | 37.149 s |
| Initial review preparation stage (private reread plus transformation/checks) | 17  | 0.770 s  | 1.173 s  | 2.994 s  |

The finalization interval excludes earlier failed/retried executions where present. Do not interpret this as full post-provider latency. Separate percentile values cannot be added. Review duration includes orchestration, provider calls, waiting and persistence; it is not SeeAPI's internal inference duration. No supported overall model-time denominator exists in this projection, so these observations do not establish that output handling is the majority of total time.

Further same-asset correlation found the observed SeeAPI callback ingress after the persisted-verdict marker in all 17 samples (0.820–51.154 s later). These timestamps do not establish the service's internal completion or callback-send times. Query-only retrieval found the verdict first. The current normal image processing poll policy is 5 seconds; observed submission-return to query preparation spans 5.175–9.987 seconds including pending persistence, scheduled wait and claim work. Query preparation to observed result spans 0.256–0.512 seconds; result observation to verdict observation spans 0.119–5.458 seconds. There is no evidence here that callback-triggered polling was the blocking path. Do not remove ordinary polling or promise that changing an image URL eliminates these waits. A faster initial poll policy requires checking supplier query limits/costs and measuring its effect; it is not silently enabled by this design.

## Verification and rollout boundaries

Use focused regressions for preparation races, retries, original input restoration, eligibility/credit invariants, analytics privacy and correct offer coverage. Cross-package TypeScript and owning-package checks follow integration. Browser checks exercise real components with local fixtures; they do not establish live supplier, login-provider, payment or performance behavior. Do not claim conversion uplift without aligned exposures, mature outcomes, costs and refunds.

Record implementation status and remaining gaps in the acceptance report. Schema/reader changes require a separate reviewed release order before any enabling configuration is published.

The implementation and focused local evidence are recorded in [the acceptance report](../operations/guest-conversion-acceptance-2026-11-14.md). Output proposals 3/4 remain an evaluated future protocol; the other workstreams and administrator additions are local changes awaiting a separately authorized release.
