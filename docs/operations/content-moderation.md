# Configurable text and image moderation

## Administrator image inspection

The customer image section at `/admin/media#customer-content` reads existing `MediaAsset` and
`AssetModerationResult` records, including ordinary content refusals without a `ModerationReview`.
Administrators can filter image state/type or search by exact owner, asset or job ID, then inspect
the image and its bound job's inputs and outputs. Saved prompts and bounded SeeAPI `nsfw` and
`specialCare` labels retain their recorded provenance. Historical review attempts are labeled.
Detail reads are audited and previews use 60-second private URLs. Deleted, unfinalized and
changed-bound content remains unavailable. The endpoints use the existing administrator role
and private, non-cacheable responses.

## Moderation configuration

The API and jobs runtime must receive the same server-only configuration. Image prompts use
SeeAPI text moderation first, with Waffo only on technical failures; image review remains SeeAPI.
Video retains its separately frozen Waffo text contract. Sightengine is retired across runtime paths:

```dotenv
MEDIA_SAFETY_ADAPTER=configured
MEDIA_ALLOW_TEST_SAFETY_ADAPTER=false
MODERATION_TEXT_WAFFO_ENABLED=true
MODERATION_TEXT_SIGHTENGINE_ENABLED=false
MODERATION_IMAGE_SEEAPI_ENABLED=true
MODERATION_IMAGE_SIGHTENGINE_ENABLED=false
WAFFO_MERCHANT_ID=<merchant ID>
WAFFO_PRIVATE_KEY=<merchant RSA private key>
SEEAPI_API_KEY=<SeeAPI key>
```

Keep credentials in ignored environment files or runtime secrets. Never prefix them with
`NEXT_PUBLIC_`. The moderation switches are server configuration, not browser controls. After a
configuration change, restart/redeploy both API and job workers through the normal release process.
Preparing a local production environment file does not activate it on the deployed service.

## Current runtime behavior

| Check or condition                           | Behavior                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Image prompt text                            | SeeAPI `text-nsfw-filter` at threshold 0.3, all seven categories; Waffo fallback only for technical failures |
| Waffo fallback                               | Merchant-signed prompt scan; only complete approval can authorize generation                                 |
| SeeAPI images                                | One asynchronous task per verified image, then query the persisted task ID                                   |
| Missing required check                       | Configuration error; that content cannot pass                                                                |
| Retired Sightengine request                  | No external call; unfinished work requiring it remains held                                                  |
| Confirmed SeeAPI input technical failure     | Versioned input delegation may continue to generation-provider checks when enabled; see the rollout below    |
| Other technical failure or incomplete review | Bounded recovery may run; exhausted retries alone do not authorize bypass                                    |

Sightengine switches and the old `MEDIA_SAFETY_ADAPTER=sightengine` value do not restore
outbound checks. No Sightengine credentials are needed for current execution or old-job
draining. Keep historical evidence unchanged: unfinished work requiring retired checks
is held, and previously completed private results remain subject to existing ownership,
expiry, evidence and settlement checks. The test adapter remains forbidden in production.

The earlier broad technical-outage `BYPASS`/`BYPASSED` policy remains superseded. The
[2026-11-13 input delegation](seeapi-input-technical-delegation-2026-11-13.md) is a distinct,
versioned permission for specific authenticated terminal SeeAPI failures on ordinary account
image inputs. It is not approval and does not permit output delivery. Exhausted retries,
unknown acceptance, malformed results, still-processing tasks and historical bypass records
do not qualify. Incident/review records remain available for audit.

Video uses a separately frozen Waffo text profile and SeeAPI visual policy. Its output
confirmation is triggered by a verified, persisted callback with bounded transient GET
retries and no periodic polling fallback. Native sound remains supported; new video
snapshots record `audioSafetyPolicy={schemaVersion:1,mode:'not_requested'}` and invoke no
transcription or audio-review service. See [video rollout](video-v1-rollout.md).

Waffo's scan is a merchant-signed verification action at the fixed API origin, independent of
checkout sessions. It needs the merchant ID and RSA private key, not checkout product IDs or a
payment webhook public key; changing moderation does not change `WAFFO_ENVIRONMENT`. The request
uses `locale=en`, `semantic=enforce`. Only a complete `allow` with semantic status `scored` and no
matched categories or warnings authorizes generation. Neither service availability nor a free
quota is guaranteed by this integration.

The image-prompt rule is `seeapi-text-waffo-fallback-2026-11-15.1`. Registered quotes, guest
admission, retries and administrator prompt rechecks share this adapter. `MODERATION_TEXT_WAFFO_ENABLED`
must remain `true` for fallback. Complete SeeAPI approval does not call Waffo; rejection, review,
pending decisions, unknown terminal codes, invalid credentials and invalid input do not switch to Waffo.
HTTP 429, timeout/network failures, 5xx, unusable responses without restrictive signals, and explicit
technical task failures may fall back. Restrictive flags or threshold-crossing scores in malformed
results require review. Both providers failing keeps admission closed. Fallback evidence records its
primary error and task ID when available. Prompt text, raw responses and credentials are not returned
in public errors. This text fallback does not authorize image-review bypass or output delivery.

New SeeAPI checks use `POST https://api.seeapi.com/v1/inferences`, with model `nsfw-filter-2`, endpoint
`image-moderation`, provider `seeapi`, `threshold=0.5`, and `strict_special_care=true`.
Its bearer credential and the image's short-lived private access URL stay server-side. HTTP 202
and task status `succeeded` do not mean approval: the worker polls `GET /v1/inferences/{id}` and
requires a complete successful result with `flagged=false` and empty category lists. A definite
flag rejects; unexpected labels without a flag require review. Invalid, incomplete, timed-out,
or unavailable checks never approve an image.

The shared adapter serves ordinary image inputs, generated image outputs, and video reference-image
checks. Existing `nsfw-filter` tasks remain queryable by their saved IDs. Evidence records the returned
model, so a historical 1.0 result retains its original identity. This upgrade retains
the existing application review policy and historical approvals.

The 2.0 service contract accepts static PNG/JPEG up to 16 MiB, each dimension 256–8192 pixels, and
78,400–32,000,000 total pixels. Its recommended range is 256–1568 per dimension and up to 2,458,624
total pixels. The shared jobs preparation path converts the immutable original to a static
1568×1568 JPEG at quality 85, fitting the entire image with white padding and flattening transparency.
This supports PNG, JPEG and WebP originals, including small images and large generation outputs.
The prepared JPEG is bounded to 8 MiB and sent as a data URL. Source byte count, SHA-256 and available
ETag are checked before submission, and the actual JPEG dimensions are checked after conversion.
The original asset retains its own bytes, checksum, generation and moderation evidence identity.

Preparation runs before the provider uncertainty fence in both ordinary-image and video-reference
review. Existing task retrieval and uncertain submissions skip preparation. A preparation failure
does not create a detector task or establish approval. Native Node uses Sharp. Workers uses its
request-owned Images binding up to 20,000,000 source bytes, then uses Cloudflare remote image
transformations for the existing 25 MiB storage limit. That larger-source path verifies the complete
source before fetching its short-lived immutable URL, and verifies the transformed response before
SeeAPI submission. Cloudflare remote image transformations must be available on the deployed Worker.
Remote transform availability and real SeeAPI acceptance require live verification after deployment.
Contract source, reviewed 2026-11-05, [SeeAPI NSFW Filter 2.0](https://www.seeapi.com/docs/nsfw-filter-2/image-moderation/).

Task binding, verification leases, checksum, rule/policy versions, retries, and uncertainty gates
use the existing private-media path. Recovery polls the same bound task; an uncertain submission
without a task ID is withheld for recovery/review, not resubmitted blindly. Detector combinations
form the evidence identity, so changing enabled checks cannot reuse an approval from a different
combination. Text quotes also bind their approved detector combination before credit reservation.

Validated SeeAPI failed-task codes are technical results: `MEDIA_INVALID` maps to
`MODERATION_MEDIA_INVALID` (terminal for that immutable image); `PROVIDER_TIMEOUT` maps to
`MODERATION_TIMEOUT`. `RATE_LIMITED` maps to `MODERATION_RATE_LIMITED`, and
`DETECTION_REPORT_FAILED` maps to `MODERATION_DETECTION_REPORT_FAILED`. None means a
content rejection. Authenticated terminal failures stop polling immediately; only the narrowly
specified input delegation above can continue without detector approval. A valid failed POST still binds
its task ID and proceeds through authenticated retrieval; it does not authorize another POST.
Conflicting status/result/error fields remain invalid responses, and raw provider messages are
not exposed because they may contain private URLs.

Administrator review shows the stored historical outcome separately from a fresh GET of the same
persisted SeeAPI task. This read-only diagnostic is available even when the original was deleted;
it cannot resubmit, overwrite evidence, reopen a job, approve content or change credits. Deleted,
missing and failed image previews are explained explicitly, and manual image approval requires
the current preview to load. An original that has already been physically deleted cannot be
recovered by querying the detector. See [image retention](image-retention-pause-2026-10-24.md).

Completing output verification writes a deduplicated finalization wake-up in the same transaction
when the complete output scan has not yet been recorded. This avoids waiting for the generic
finalization backoff after an asynchronous check finishes. It does not queue settlement early:
finalization must still inspect every candidate before the existing settlement path can proceed.
Replayed verification and delivery do not create another provider generation or credit settlement.

## Coverage and operating cost

Waffo's documented categories focus on sexual content and exploitation; SeeAPI's interface returns
NSFW/special-care labels without a complete documented hate/violence taxonomy. This initial
combination is not evidence of complete violence, hate, identity/consent, copyright, or child-age
verification. No detector setup guarantees card-network compliance.
The [retired Sightengine profile](./sightengine-moderation.md) remains a historical record,
not an available fallback or a recommendation to restore its calls.

Cost is controlled by switching unused providers off, screening prompts before generation,
reusing approvals only for the exact unchanged private asset and current detector policy, and
persisting SeeAPI tasks before polling. Generation-provider safety checks remain an extra layer.
The app does not assume the image generator refunds its own charges after a blocked result.

## Credit settlement and rollout

Apply `20260916000000_output_moderation_grace` through the normal database deployment process
before starting this application/worker version. The migration adds one nullable field on the
billing account; existing records start with an unused waiver. Generated clients must match the
schema. Do not reset or migrate an unrelated/production database while running local tests.

From 2026-11-15, new quotes freeze `outputModerationBillingPolicy=charge-quoted-credits-v1`.
When current immutable output evidence confirms content rejection and no approved output is
available, ordinary CREDITS settlement charges the frozen quoted maximum from the first rejection.
It never claims or resets the historical lifetime-waiver field. Deploy compatible settlement
consumers in every active jobs runtime before enabling these new quote producers; retain them
until accepted new-policy jobs drain if producers are rolled back. No database migration is needed.

Historical quotes frozen with `outputModerationBillingPolicy=first-block-free-v1` retain their
original contract. When no approved output is
available and matching current evidence confirms a content rejection, settlement atomically
claims the account's lifetime waiver and settles zero credits; later such jobs settle the frozen
quoted maximum. It uses the existing reservation, immutable ledger, serializable transaction, and
stable `settle:<jobId>` reference. Concurrent jobs cannot both claim the waiver; retries/replays
cannot charge twice. USER and ORGANIZATION credit accounts retain separate lifetime state, and
deleting a job or its media does not reset it. Current generation creation remains USER-scoped;
this change does not introduce organization generation routes.

Unmarked old quotes retain their old billing policy. Input rejection, uncertain/review results, inspection
errors, and technical failures do not claim the waiver. Sponsored guest jobs never claim an
account's waiver. Provider acceptance uncertainty still holds the reservation until resolved.
Partial usable output keeps the existing per-output settlement policy.

Results use `OUTPUT_CONTENT_BLOCKED_WAIVED` or `OUTPUT_CONTENT_BLOCKED_CHARGED` to explain the
confirmed billing outcome even after output-media cleanup. Images remain quarantined with no
public access. The quote screen discloses the rule, and the result/history views show the actual
charged/released amounts and appeal guidance. This credit waiver is distinct from a payment refund.

## Customer feedback

Prompt denials use separate public outcomes: `CONTENT_REVIEW_REQUIRED` asks the customer to revise
the instruction or contact support, `TEXT_LANGUAGE_UNSUPPORTED` identifies a language limitation,
and `SAFETY_CHECK_UNAVAILABLE` identifies an unavailable check. These are not confirmed content
violations and do not create a quote, reserve credits, or consume the output-block waiver.
Production uses Waffo text checks without the legacy Sightengine Latin-script gate and SeeAPI
image checks. Keep website, jobs and Cloudflare Git build overrides aligned.

Prompt, reference-image, generated-result, and guest-trial screens separate the outcome, reason,
credit treatment, and next action. Confirmed blocks use an amber notice; an incomplete review uses
a neutral notice and explicitly avoids declaring a content violation. Both link to the content policy
and support. Result notices include the task reference; blocked media and private access URLs remain
unavailable. A cached input preview is hidden if a subsequent access check fails.

The API exposes only `PublicModerationReason` categories. Waffo's confirmed prompt rejection can
explain sexual content, minor safety, sexual exploitation, or identity manipulation using its
allowlisted matched categories. SeeAPI's boolean rejection currently has no stable documented
category mapping, so the notice says restricted content with no more specific reason available.
Unknown categories also use this fallback. Provider names, raw labels, request IDs, scores, and
diagnostic payloads stay server-side. REVIEW, ERROR, and unclassified image rejections never gain
a confirmed-violation label through the presentation mapping.

Credit wording follows the stored result: before generation no credits or waiver are used; a
confirmed output block reports its waiver or quoted charge; a terminal unavailable review with
zero charge reports released credits and no waiver use. Historical jobs without the new billing
marker use their ledger summary. Sponsored trials show no account charge or waiver use and retain
their separate trial-consumption status. No automatic appeal or refund is created by these notices.

Waffo and SeeAPI requests use Workers-compatible `redirect: "manual"` and reject non-success
responses. Credentials and private image URLs must never follow a redirect to another origin.

## References

- [Waffo scan prompt](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt)
- [SeeAPI image moderation](https://www.seeapi.com/docs/nsfw-filter/image-moderation/)

Local fixtures and database tests certify application behavior; they do not certify external
classifier accuracy. A live API smoke check establishes only the request/response exercised.
