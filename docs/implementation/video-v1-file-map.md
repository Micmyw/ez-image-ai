# Video generation V1: verified implementation map

Review handoff: branch `codex/video-v1-release`, integrated onto
`e4f6b81fd8fc8e769b975e6c59177a1afefa06a9`. The responsibilities below describe
the implemented paths; the [review branch inventory](video-v1-review-files.md)
records the complete branch diff, including integration fixes and generated schema output.
The original implementation baseline below remains historical attribution evidence.

Implementation baseline (2026-10-04): branch `main`, HEAD
`569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`. The supplied plan's
`1b3c9dc2c2b5ee3e9dd0b05e3fea02141908d04b` is historical context only.
This batch adapts the working tree in place. Existing edits were recorded before
implementation in `.cache/video-v1/initial-status.txt`, `initial-working.patch`
and `initial-hashes.json`; the index was empty at baseline.
That initial implementation record contains no reset, checkout, push or deployment.
Later release authorization and results belong to the final verification report.
Open log files belonging to pre-existing processes could not be hashed.

The root user-provided AGENTS instructions and `apps/saas/AGENTS.md` apply.
The database-schema-change and verify-changes skills supply the package conventions.
The plan is implemented as one coordinated batch; its suggested per-task commit and
approval cadence is superseded by the user's continuous-execution request.

| Responsibility                                                                      | Actual location / reuse                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned product contract and closed readiness                                     | `packages/config/video-v1.ts`; `packages/ai/media/catalog/fixtures/kie-video-v1-contract.json`                                                                                                                         |
| Exact Kling T2V / I2V adapter                                                       | `packages/ai/media/providers/kie-video-v1.ts`                                                                                                                                                                          |
| Prompt, reference-image and output visual safety                                    | `packages/ai/media/moderation/video-configured.ts`; Waffo prompt checks and SeeAPI visual checks; current provider policy below                                                                                        |
| Canonical persisted state                                                           | `packages/database/prisma/schema.prisma`; `prisma/migrations/20261004000000_video_generation_v1`; `20261004010000_video_quote_pending_evidence`; `20261004020000_video_resource_recovery`                              |
| Shared type contract                                                                | `packages/jobs/src/video-v1/contracts.ts`                                                                                                                                                                              |
| Quotes, transactional admission, immutable fingerprint, existing credit reservation | `packages/database/prisma/queries/media/video-v1.ts`; existing `credits.ts`, `credit-allocations.ts`, `storage-usage-locks.ts`; `packages/jobs/src/video-v1/admission.ts`                                              |
| API namespace                                                                       | `packages/api/modules/video-v1/router.ts`; mounted in `packages/api/orpc/router.ts`                                                                                                                                    |
| Upload quota / immutable promotion                                                  | `packages/api/modules/video-v1/uploads.ts`; existing `media/procedures/complete-upload-session.ts`; `packages/database/prisma/queries/media/assets.ts`, `video-v1-uploads.ts`; `packages/storage/provider/s3/index.ts` |
| Small reference WebP normalization                                                  | Existing storage image processor boundary extended in `image-processing/types.ts`, `sharp.ts`, `cloudflare-images.ts`; server-owned immutable PNG, same geometry                                                       |
| Submission intent, prompt/input review, authoritative provider query                | `packages/jobs/src/video-v1/submission.ts`; `packages/database/prisma/queries/media/video-v1-execution.ts`                                                                                                             |
| Durable provider callbacks                                                          | `packages/jobs/src/video-v1/webhooks.ts`; Hono route in `packages/api/index.ts`                                                                                                                                        |
| Direct Workflow class and stage orchestration                                       | `apps/workflows/src/video-generation-v1.ts`, `video-orchestrator.ts`, `video-runtime.ts`; exports from `workers.ts` / hybrid entry                                                                                     |
| Request-owned binding context                                                       | `packages/jobs/src/video-v1/workflow-binding.ts`; `apps/saas/cloudflare-worker.ts`                                                                                                                                     |
| Output streaming, same-object review, atomic settlement                             | `packages/jobs/src/video-v1/fulfillment.ts`, `output-storage.ts`; `packages/database/prisma/queries/media/video-v1-fulfillment.ts`                                                                                     |
| Private GET/HEAD/Range playback and download                                        | `packages/api/modules/video-v1/playback.ts`, `playback-policy.ts`; authenticated `/api/video-v1/jobs/:jobId/content`; `readPrivateMediaStream` in storage                                                              |
| Owner UI / history                                                                  | `apps/saas/app/(authenticated)/(main)/(account)/video`; `apps/saas/modules/video-v1`; existing account auth/layout/i18n                                                                                                |
| Recovery / timings                                                                  | `packages/jobs/src/video-v1/recovery.ts`, `telemetry.ts`; `packages/database/prisma/queries/media/video-v1-recovery.ts`; independent existing scheduled entry                                                          |
| Actual generated deployment configs                                                 | `apps/web-host/src/profiles.ts` invoked by `prepare-profiles.ts`; Workflows Wrangler configs; site wrapper bindings                                                                                                    |
| Dedicated tests                                                                     | `tests/video-v1/run.ts`; owning-workspace video tests; existing unit, integration, workerd, browser and build entry points                                                                                             |

## Authorized follow-up: multiple models, properties, audio and pricing

The later user messages expand the original fixed five-second, silent product.
They authorize the competitor-style property selection and native model controls;
the original document does not override that expanded scope. A later instruction
authorizes push and deployment, while feature opening and paid acceptance remain gated.
The earlier table also locates immutable historical V1 records; it does not authorize
outbound calls to a retired provider.

| Responsibility                                                              | Follow-up location                                                                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Public model families and legal mode/duration/resolution/ratio/audio tuples | `packages/config/video-models.ts`; `packages/ai/media/catalog/fixtures/kie-video-model-contracts-2026-10-04.json`                  |
| Verified Kie model payloads and authoritative status queries                | `packages/ai/media/providers/kie-video-models.ts`; existing `packages/jobs/src/video-v1/submission.ts` bridge                      |
| Full-cost price policy, paid-credit floor, reproducible scenario            | `packages/config/video-pricing.server.ts`; `tests/video-v1/pricing-report.ts`; `docs/product/video-model-pricing.md`               |
| Compact public capability/price availability                                | `packages/api/modules/video-v1/catalog.ts`; `router.ts`; no supplier prices exposed                                                |
| Paid-funding provenance and allocation                                      | `packages/database/prisma/queries/media/paid-credit-funding.ts`; `credits.ts`; `video-v1.ts`; associated payment refund reducers   |
| Shared image/guest/video Kie admission capacity                             | `packages/database/prisma/queries/media/shared-provider-capacity.ts`; `jobs.ts`; `guest-admission.ts`                              |
| Actual output duration, track, dimensions and request constraints           | `packages/config/video-output.ts`; `packages/storage/lib/video-mp4.ts`; video fulfillment                                          |
| Native sound with immutable not_requested audio policy                      | `packages/config/video-output.ts`; `video-pricing.server.ts`; `packages/jobs/src/video-v1/fulfillment.ts`                          |
| Family picker and linked property panel                                     | `apps/saas/modules/video-v1`; four locale `saas.json` files; `apps/saas/content/docs/video-beta.mdx`                               |
| Windows-hosted native Linux site packaging                                  | `apps/saas/cloudflare/build-linux.mjs`; network guard and cleanup helpers/tests; `docs/operations/cloudflare-local-linux-build.md` |
| Follow-up evidence and residual external gates                              | `docs/operations/video-v1-followup-verification.md`; `docs/operations/evidence/video-pricing`                                      |

## Compatibility and decisions

### Authorized SeeAPI visual-review follow-up

The latest user instruction selects Waffo for prompt review and SeeAPI for reference/output
visual review, aligned with its image-review settings. Sightengine is retired globally,
including old-job draining. Native sound is retained without audio-review service calls,
keys or fees. No deployment or live acceptance is inferred from this source map.
The current source map is:

| Responsibility                                                                                | Actual location                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable visual profile and read-only historical policy recognition                          | `packages/config/video-safety.ts`; `packages/jobs/src/video-v1/contracts.ts`                                                                                                                                  |
| SeeAPI `video-nsfw-filter` / `video-moderation` submit/query and sampled-report validation    | `packages/ai/media/moderation/seeapi-video.ts`; `seeapi-video.test.ts`; `types.ts`; `video-configured.ts`                                                                                                     |
| New-admission readiness and matching text/visual cost policy gates                            | `packages/config/video-v1.ts`; `packages/jobs/src/video-v1/admission.ts`; `packages/api/modules/video-v1/catalog.ts`                                                                                          |
| Quote/create snapshot binding and database mutation guard                                     | `packages/database/prisma/queries/media/video-v1.ts`; `packages/database/prisma/migrations/20261004030000_video_input_snapshot_immutable/migration.sql`; `video-input-snapshot-immutable.integration.test.ts` |
| Same immutable output, actual duration/byte bounds, profile-bound review/settlement           | `packages/jobs/src/video-v1/fulfillment.ts`; `packages/database/prisma/queries/media/video-v1-fulfillment.ts`                                                                                                 |
| Callback-only wait, bounded confirmation GET retries and manual holds, independent of browser | `apps/workflows/src/video-orchestrator.ts`; `video-runtime.ts`; `video-generation-v1.ts`; `packages/jobs/src/video-v1/fulfillment.ts`                                                                         |
| Server-only callback readiness and asset/generation/attempt-bound URL proof                   | `packages/config/video-seeapi-callback.ts`; `packages/jobs/src/video-v1/seeapi-callback-url.ts`                                                                                                               |
| Raw-body signature verification, bounded receiver and durable notification                    | `packages/ai/media/moderation/seeapi-video-webhook.ts`; `packages/jobs/src/video-v1/seeapi-webhooks.ts`; route in `packages/api/index.ts`                                                                     |
| Immutable callback evidence, deduplication and durable confirmation budget/result             | `packages/database/prisma/queries/media/video-v1-seeapi-events.ts`; existing `ProviderWebhookEvent` and `VideoExecution.stageData`                                                                            |
| Retired Sightengine callback isolation; no unfinished-job resumption                          | `packages/jobs/src/video-v1/moderation-webhooks.ts`; `packages/database/prisma/queries/media/video-v1-moderation-events.ts`                                                                                   |
| Rollout/drain/configuration and account-backed pricing explanation                            | `docs/operations/video-v1-rollout.md`; `video-v1-configuration.example.env`; `docs/product/video-model-pricing.md`; `apps/saas/content/docs/video-beta.mdx`                                                   |

Official contract source: [SeeAPI Video NSFW Filter](https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/),
cached during this phase at `.cache/video-v1/seeapi-contract/video-moderation.{html,txt}`.
The API uses `POST /v1/inferences`; a verified, durably stored callback starts one
confirmation flow using authenticated `GET /v1/inferences/{id}` and only the server's
stored task ID. At most three GET requests are allowed, including the first; only
network failures, timeouts, 429 and 5xx retry with 1-second then 3-second backoff.
The budget and result are persisted and never reset by duplicate callbacks or recovery.
No callback means zero GET requests; processing, invalid and rejection results do not retry.
The implemented generic raw-body signature verifier and task-bound URL proof do not
guess inference event-body semantics. The callback is persisted and deduplicated before
waking the Workflow; it cannot approve content or settle credits by itself. Missing or
uncertain confirmation requires a manual hold, with no recurring polling fallback.
See the [callback decision](../operations/video-v1-seeapi-verification.md#callback-decision)
for official signature sources and the **NOT_RUN** real inference-delivery compatibility gap.
This callback phase adds no database migration; the fourth video migration's immutable
snapshot trigger remains required.

`inputSnapshot.visualSafetyProfile` is persisted with the accepted request and cannot be
changed by a new environment default. Historical jobs without the field are recognized as
the original Sightengine policy for historical checks only. Unfinished work requiring the
retired provider is held without another external call. Historical `READY` output keeps
existing bounded ownership, expiry, immutable evidence and settlement checks. Malformed
profiles fail closed; no historical profile is backfilled or silently migrated.

New snapshots also freeze Waffo `textSafetyProfile` and
`audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}`. The text contract lives in
`packages/config/video-text-safety.ts`, the adapter in
`packages/jobs/src/video-v1/text-moderation.ts`, and the signed Waffo primitive in
`packages/payments/provider/waffo/content-safety.ts`. Admission, the paid-send fence and
pricing require the same positive prompt evidence and approved
`VIDEO_COST_TEXT_RULE_VERSION=waffo-prompt-safety-2026-10-04.1`. Native sound remains in
the MP4; no transcription or audio-review invocation or fee is added. Historical
audio-bearing work whose accepted policy still requires that review remains held.

For new SeeAPI work, `threshold_offset=0`, `strict_special_care=true`, and
`return_frames=none`; requested frames are `clamp(ceil(request seconds)+2,8,32)`.
The actual stored video is limited to 30 seconds and 100,000,000 bytes. Its report must meet
the application's first/last/adjacent-sample coverage checks, but those checks do not prove
every-frame review and have not been validated against real supplier output. Optional
special-care labels preserve their reported/omitted distinction without invented categories.
Real video callback delivery, timestamp coverage, billable cost conversion and current
video moderation acceptance remain **NOT_RUN/BLOCKED**. Credential presence alone does
not satisfy them; the root verification report owns final tests and release status.

### Preserved engine and data boundaries

- `GenerationJob.executionEngine` and `MediaAsset.verificationEngine` default to
  `legacy`. `VideoExecution` is metadata, not a second job, payment, user or wallet.
  Its state changes accompany overall job changes in the same transaction.
- Legacy direct execution, provider events, recovery, verification, cancellation,
  administrative requeue and settlement are guarded in existing database media
  queries and jobs runtime/handlers. Video does not use `jobs-primary` or a global
  Outbox pass to progress. General immutable ledger invariants continue to apply.
- The current maintained Drizzle variants have no media job/asset/ledger schema
  or matching media-query implementation at baseline. This batch extends the actual
  Prisma media domain; creating a partial parallel video schema without its related
  media tables would not provide parity. No existing Drizzle media mapping was omitted.
- The current official Kling documents cap prompts at 1000 characters and require
  JPEG/PNG input up to decimal 10 MB; WebP uploads are privately normalized to PNG
  without resizing before quotation/review. Both original and normalized temporary
  bytes are reserved. Oversized normalized content fails closed.
- Input review and video review remain explicit; a completed upload is still
  `VERIFYING`, and quotations use `PENDING_VIDEO_WORKFLOW` evidence.
- Five-minute playback grants are owner/content-bound and the server rechecks
  the current login, asset, review, retention and settlement on every GET/HEAD.
  They are revocable without waiting for an R2 presigned URL to expire.
- No production credentials, prices or real-generation results are manufactured.
  Actual external acceptance and feature opening are recorded separately in
  `docs/operations/video-v1-verification.md`.
