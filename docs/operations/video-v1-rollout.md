# Video V1 deployment and recovery

Push and deployment are authorized by the latest release instruction; opening video access
still requires the gates below, and paid external acceptance requires its own authorization.
This guide does not assert that a deployment has completed. Existing image
routes, homepage query positioning, accounts, plans and production domain remain in place.
The deployable default is closed, logged-in internal access, no guest video trial.
See [configuration](video-v1-configuration.example.env) and
[verification](video-v1-verification.md) before opening access.

## Deployment order

1. Review/apply all four additive `20261004` Prisma migrations to the named authorized
   target, with backup and schema checks. Keep existing jobs, ledger and image data.
   The dedicated new table denies `anon`/`authenticated`; verify the actual server role
   rather than assuming Better Auth identities are Supabase `auth.uid()`.
   `20261004030000_video_input_snapshot_immutable` prevents changing accepted video
   input snapshots, including their visual-safety profiles. It does not backfill old jobs.
2. Build the jobs Worker with the existing profile preparation. Deploy the receiver
   containing `VideoGenerationWorkflowV1` alongside `JobsWorkflow` and `WorkerJobs`.
   Preserve the old identities. The same build supports workers/hybrid profiles.
3. Deploy the site with a native cross-Worker `VIDEO_WORKFLOW` binding pointing to that
   receiver, private `VIDEO_MEDIA_BUCKET`, `HYPERDRIVE`, existing `IMAGES`, and default
   `VIDEO_V1_ENABLED=false`. Verify the **generated** config, not just example Wrangler.
4. Verify Hyperdrive origin TLS and disabled query cache, R2 private access/PUT CORS,
   per-request/per-step contexts and binding readiness. The recovery path must still
   run outside the legacy maintenance executor.
5. Configure Kie credentials and callback verification; confirm account access to each
   exact enabled model and parameter combination. Verify the request-specific full-cost
   price policy, paid-credit revenue provenance and actual shared provider quota.
   Configure `VIDEO_V1_VIDEO_SAFETY_ADAPTER=seeapi` and reference-image SeeAPI review.
   Configure `VIDEO_V1_TEXT_SAFETY_ADAPTER=waffo`, the existing Waffo merchant credentials,
   and an approved prompt-check cost basis. Set
   `VIDEO_COST_TEXT_RULE_VERSION=waffo-prompt-safety-2026-10-04.1` only after confirming
   that cost basis; missing or mismatched values block new quotes/admission.
   Reapprove visual cost bounds and set
   `VIDEO_COST_VISUAL_POLICY_VERSION=seeapi-video-policy-2026-10-04.1`; an absent or
   mismatched marker blocks new quotes/admission, even if old cost values remain present.
   Configure server-only `VIDEO_SEEAPI_CALLBACK_SECRET` and
   `SEEAPI_WEBHOOK_SIGNING_KEYS` consistently on the website and background Workers;
   missing or invalid values block new SeeAPI admission. The server generates an
   asset/generation/attempt-bound `callback_url` at `/api/webhooks/video-v1/seeapi/:assetId`.
   Only a verified, durably stored notification permits authenticated status confirmation,
   with at most three GET requests for the same task, including the first request.
   See the [callback decision](video-v1-seeapi-verification.md#callback-decision) for
   signature sources, manual holds and the real inference-delivery acceptance gap.
   Sightengine is retired across the runtime. Do not configure it for old-job draining
   or let old callbacks resume unfinished work. Hold work that still requires that
   provider without rewriting its accepted evidence. Native sound remains a model
   setting; new snapshots use `audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}`.
   No audio-review API, key or fee is required. Missing model contracts or ambiguous supplier-price
   mappings stay unavailable; a competitor label does not authorize a substitute.
6. Run separately authorized real prompt/image/video visual moderation within the approved
   combined paid-task and moderation budget. Confirm selected duration and actual dimensions,
   no audio tracks for silent requests, native model sound for audio selections, input identity,
   private transfer, range/HEAD playback, one settlement, Kie callback and SeeAPI
   verified callback followed by bounded authenticated status confirmation,
   retired-provider isolation, no audio-review calls, recovery, and stage
   timing. Neither readiness markers nor a Mock result proves this acceptance.
7. Open only the configured logged-in administrator/user-ID whitelist after the above
   passes. A later public rollout is a separate decision; V1 access mode remains internal.

## Visual review policy and provider cutover

New admission binds `inputSnapshot.visualSafetyProfile` to the immutable accepted content.
The profile records the provider, contract, rule, policy, and sampling settings. The SeeAPI
identifiers are `seeapi-video-nsfw-schema5-2026-10-04.1`,
`seeapi-video-safety-2026-10-04.1`, and `seeapi-video-policy-2026-10-04.1`.
Callbacks, status confirmation, recovery, review and settlement must use this saved
profile rather than whichever provider the current deployment selects. SeeAPI output
review uses callback-triggered confirmation; existing SeeAPI input-image and Kie generation
mechanisms retain their current behavior. A missing historical visual profile identifies
the old Sightengine policy for historical validation only; it does not authorize another
Sightengine call. Unfinished retired-provider work is held. A malformed profile is an
error, not permission to switch providers. Do not rewrite or backfill accepted jobs to
move them to SeeAPI. Historical `READY` results retain existing owner, expiry, immutable
evidence and settlement checks; no fresh approval or public access is granted.

The [SeeAPI Video NSFW Filter contract](https://www.seeapi.com/docs/video-nsfw-filter/video-moderation/)
uses `POST /v1/inferences` with model `video-nsfw-filter`, endpoint `video-moderation`,
provider `seeapi`, and a stable `Idempotency-Key`. Keep the authorized URL for the same
private stored object readable during review. Persist the returned task ID and wait for
the verified callback. The Workflow then starts one confirmation flow using authenticated
`GET /v1/inferences/{id}` with that stored ID; `/v1/generations/{id}` is the wrong
resource. Callback body fields never supply the authoritative task ID or content verdict.
Neither HTTP 202 nor task `status=succeeded` is a content pass. Submission uncertainty
preserves the original attempt; it does not authorize blind additional billed submissions.

Confirmation permits at most three GET requests in total, including the first, only
retrying network failures, timeouts, HTTP 429 or HTTP 5xx with 1-second then 3-second
backoff. The request budget and completed result are persisted; duplicate callbacks or
Workflow recovery cannot reset them. A processing/nonterminal result, invalid response
or rejection does not trigger a retry. No callback means zero confirmation GET requests.

The output policy uses the same strict visual settings as SeeAPI image review:
`threshold_offset=0`, `strict_special_care=true`, and `return_frames=none`. Requested
frames are `clamp(ceil(request duration in seconds) + 2, 8, 32)`. Before submission,
the actual stored MP4 must be at most 30 seconds and 100,000,000 bytes; a permitted
generation-model setting does not override these moderation limits.

For a normal report, require consistent task/schema/verdict/frame counts and completed
sampling. The application's timestamp coverage standard requires the first sample at
or before 0.25 seconds, the last within `[actual duration - 1, actual duration + 0.5]`,
and no adjacent sample gap over 1 second. These are **application acceptance criteria**,
not SeeAPI guarantees: its timestamps are approximate, and actual compliance with this
coverage standard is **NOT_RUN/BLOCKED** pending authorized real-service acceptance.

The report covers **sampled frames**, never every frame or all possible visual hazards.
`special` labels are optional; omission does not mean a reported empty category, and
labels must not be fabricated or interpreted as verified facts about a person. Missing
frame-image URLs are expected for `return_frames=none`. A policy-blocked result can be
`succeeded` with `flagged=true` and `output=null`, remains billable, and is not a pass.
Incomplete, inconsistent or uncertain evidence cannot enable playback or settlement.

New requests freeze the Waffo `textSafetyProfile` and
`audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}` alongside the visual profile.
Native sound remains in the generated MP4 when requested and supported. There is no
transcription, audio moderation, audio-review credential or audio-review charge in this
scope, and no fabricated audio approval. Unfinished historical audio-bearing work with
a required or missing audio policy is held rather than silently reclassified. See
[pricing policy](../product/video-model-pricing.md) for separate
SeeAPI credits, account exchange-rate evidence, and full-cost approval requirements.

## Recovery behavior

- A committed `VideoExecution` with PENDING start intent retries the stable
  `video-v1-${jobId}` instance identity. Lost create responses are checked on that ID.
- Before sending the paid request, a durable attempt records that submission may have
  happened. A missing task ID after timeout/crash is uncertain; no automatic second POST
  and no automatic credit release. Authenticated callbacks can associate only that attempt.
- Kie's task ID/timestamp signature does not cover result URLs. The callback only wakes
  the instance; authenticated `recordInfo` establishes results and terminal outcomes.
- Persisted SeeAPI callback notification failures are replayable. Historical Sightengine
  callbacks cannot resume retired checks or decide a SeeAPI-profile job. A SeeAPI callback
  must pass both the task-bound
  URL proof and raw-body signature checks before persistence and Workflow notification.
  Duplicate delivery or replay cannot reset the persisted confirmation budget or reach
  the legacy engine. A cached completed result is reused without another provider query.
- SeeAPI output review waits for that callback until the moderation deadline. No callback,
  exhausted transient GET retries, a nonretryable confirmation failure, or a nonterminal
  result enters `NEEDS_REVIEW`: playback stays
  unavailable and credits stay reserved for authorized manual handling. These cases remain
  distinct from a confirmed content rejection or provider task failure. There is no recurring
  polling fallback, repeat moderation POST or replacement generation. Closing the browser
  does not stop the Workflow; callback delivery and manual reconciliation remain server work.
- Transfer recovery uses the same attempt, output asset and immutable key. It checks the
  stored winner after a DB failure; it never runs a new generation to replace a download.
- Output review uses that object's checksum/ETag, evidence satisfying its saved sampling
  profile, and MP4 checks. Complete sampling does not claim every-frame inspection.
  Rejection evidence, inaccessible asset state and credit release commit together.
  Successful finalization settles once and atomically enters READY. Late failure is inert.
- A platform-completed/terminated/error instance that still has unfinished business goes
  to NEEDS_REVIEW. Late callbacks may record the original task ID but cannot silently
  reopen a parked task. Diagnose by job ID through the protected admin endpoint; preserve
  the attempt/reservation until an authorized operator determines the real provider state.
  Do not change the engine or create a random replacement Workflow.
- Dedicated video cleanup uses bounded indexed batches. It preserves active, uncertain and
  review-held assets, only reclaims unused inputs after 24h and outputs at their explicit
  retention deadline (successful videos: 30d), and separately accounts for normalization
  source cleanup. It does not change shared-bucket lifecycle policy.

## Rollback

Close **new admission** first. Keep callbacks, the original versioned Workflow class,
database metadata, recovery, private media authorization and ledger services deployed
until accepted work drains or is explicitly reconciled. Do not flip video rows to legacy,
drop the new table/columns, route video to `jobs-primary`, replay a paid attempt, or roll
back to an image binary that does not enforce engine isolation.

Retain deployment versions for both Workers; roll back UI/admission independently while
the compatible video receiver continues draining. Existing image flow remains on its
old engine. A production rollback drill is not established by local fixture tests.

Retain the SeeAPI callback receiver and its two callback secrets, compatible immutable
profile readers and existing private evidence until accepted work is resolved. Do not
restore Sightengine calls or audio-review calls to drain old jobs. Missing SeeAPI
notifications require authorized manual reconciliation; rollback does not enable an
automatic provider retry. Roll back admission without changing accepted profiles or
letting historical profileless jobs use SeeAPI. Keep unfinished retired-provider work
held and already completed output access bounded by its existing authorization and expiry.
Do not remove the immutable-snapshot guard to
force a provider switch. Current real-service evidence and remaining limitations are
recorded in the [2026-10-05 acceptance report](video-v1-real-acceptance-2026-10-05.md);
these instructions alone do not establish a production deployment or opened feature.
