# Video V1 pre-release validation

The source follow-up starts at `5f135184cd4dcbc6adaab24906d3a72202e9a037`
on `codex/video-v1-release`. The external source re-review accepted the three
previous repairs; it did not independently rerun tests or certify production.
No additional models, audio review, provider switching or workflow engine changes
are introduced here.

## CI coverage and corrections

The validation workflow runs on main pushes, pull requests targeting main and
manual `workflow_dispatch`. Ordinary review-branch pushes do not start it.
[The first manual run](https://github.com/Micmyw/ez-image-ai/actions/runs/37184100453)
tested `5f135184`; its PostgreSQL job exposed
`ISOLATED_VIDEO_TEST_DATABASE_REQUIRED` in the SeeAPI handoff invariant suite.
That suite requires a dedicated video target supplied as both database URLs,
whereas the normal database group deliberately removes the runtime URL.
The 32 unexecuted cases in that failed suite are not successful optional skips.

The runner now executes that suite in a separate serial group against an explicitly
named disposable video PostgreSQL service. Its original guard remains intact.
The ordinary PostgreSQL service and its existing isolation rules are unchanged.
The two existing Jobs video-flow suites are included in both the root integration
runner and the Jobs package command. Three performance cases remain opt-in.

[The next run](https://github.com/Micmyw/ez-image-ai/actions/runs/37184713882)
passed all 369 cases in the normal database group, then exposed two guest/video
shared-capacity fixtures whose decimal 100 MB budget was below the new 100 MiB
reservation. Their shared fixture now uses `VIDEO_OUTPUT_MAX_BYTES`; the admission
guard and the original capacity/concurrency assertions are unchanged. This was
a test setup failure, not authority to reduce the production output reservation.

The complete local integration run then found three stale Jobs test assumptions:
the positive legacy-recovery fixture could fall beyond a global 100-row page;
five guest dispatch cases supplied an explicit test environment without the local
moderation opt-ins required by their seeded evidence; and an old exhausted-review
case still expected automatic BYPASS, which had already been retired. Fixtures now
establish their actual prerequisites, and the last case asserts that repeated
technical errors remain blocked without a fabricated approval or extra bypass
audit. Runtime moderation and recovery guards are unchanged.

The nine video UI cases now follow the standard media E2E in CI. They reuse the
existing browser harness and local services, with video disabled and a network
guard allowing only loopback services and optional font downloads. Video RPCs,
uploads and playback are mocked. Only the named browser report/results paths are
uploaded; environment files and the rest of `.cache` are excluded.

The CI contract checks require these entries so future edits cannot silently omit
the video paths. The workflow does not deploy or invoke paid generation. Read the
actual run conclusion and commit SHA in
[GitHub Actions](https://github.com/Micmyw/ez-image-ai/actions/workflows/validate-prs.yml?query=branch%3Acodex%2Fvideo-v1-release);
a dispatched or running workflow is not a pass.

The existing five-case immutable video-input/Range storage suite also joins the
same MinIO lifecycle using a dedicated private bucket containing `test` in its
name. Its loopback and bucket guards remain unchanged.

For a complete local `pnpm test:integration`, provide both the usual
`TEST_DATABASE_URL` and the explicit migrated `VIDEO_VERIFICATION_DATABASE_URL`
accepted by `tests/load/video-verification-target.ts`. The API-only phase does not
require the additional video database. See the workflow for the two disposable
service definitions; never substitute a production target.

### Complete local integration result

The corrected root integration command passed on 2026-10-04 against two fresh,
task-owned PostgreSQL 17.11 databases, each with all 59 migrations applied. The
run used only local fixture credentials, explicit Mock/test adapters and the
no-paid-network guard. It completed in 330.7 seconds with exit code 0.

| Serial group                             | Passed | Optional cases not run |
| ---------------------------------------- | -----: | ---------------------: |
| Ordinary database                        |    369 |                      0 |
| Guest database and shared video capacity |    103 |                      0 |
| Dedicated SeeAPI handoff database        |     32 |                      0 |
| Jobs database and video domain flows     |    177 |                      5 |
| API                                      |    870 |                      0 |
| Guest API boundary                       |     12 |                      0 |
| Total in this command                    |   1563 |                      5 |

The five skips are explicitly opt-in: three video concurrency performance cases
(`VIDEO_V1_RUN_PERFORMANCE=1`) and two legacy immutable-S3 crash-recovery cases
(`RUN_MEDIA_STORAGE_INTEGRATION=true`). They remain NOT_RUN in this command.
This total includes unit and database-backed cases selected by the integration
runner; it is not a count of independent real-service requests and must not be
added to historical overlapping test totals. The local log and process record
are retained under `.cache/video-v1-prerelease/full-integration*` and are not
published as production evidence.

## Deployment readiness repair

Profile preparation previously called the legacy single-model readiness branch,
even though API admission uses the current multi-model contract. Valid current
configuration therefore failed with legacy price/contract errors. Profile
preparation now passes `multiModel: true`, retaining the separate full-cost gate.
Both workers and hybrid regressions failed before the fix; all 31 web-host tests
passed afterward. Missing model contract, callback secret, quota and upload CORS
remain blocking, covered by four additional rejection cases. Web-host types,
formatting and lint passed.

The configuration example also clarifies that an omitted callback base uses the
canonical origin; an explicitly empty value is invalid. Transfer capacity remains
100 MiB, while SeeAPI separately accepts at most 100,000,000 bytes.

## Read-only external prerequisite inventory

Inventory date: 2026-10-04. Only local ignored environment files were inspected;
remote Worker secrets, account permissions and live endpoints were not verified.
No secret values were copied into this report or committed.

| Requirement                                                        | Observed state                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Kie and SeeAPI API credentials                                     | Present locally; online permissions NOT_RUN                       |
| Waffo merchant/private-key configuration                           | Present; supported local format; online prompt moderation NOT_RUN |
| Database, auth and private S3/R2 configuration                     | Present locally; live video delivery NOT_RUN                      |
| Kie callback verifier `KIE_WEBHOOK_SECRET`                         | MISSING locally; BLOCKED                                          |
| Application callback proof `VIDEO_SEEAPI_CALLBACK_SECRET`          | MISSING locally; BLOCKED                                          |
| Official SeeAPI signing-key map `SEEAPI_WEBHOOK_SIGNING_KEYS`      | MISSING locally; BLOCKED                                          |
| Video contract, adapter, quota, output-host and CORS configuration | MISSING in inspected deployment environment files; BLOCKED        |
| Approved cost basis, policy markers and validity period            | MISSING; BLOCKED                                                  |
| Authorized aggregate paid-acceptance budget                        | Not established; BLOCKED                                          |

The release worktree has no private deployment environment file. The original
production environment file has a syntactically valid canonical HTTPS origin;
the ordinary local development origin is unsuitable for public callbacks. This
does not establish callback reachability. No Waffo payment environment change or
audio-review credentials are needed.

### Subsequent read-only production binding check

Cloudflare Worker settings were subsequently queried for
`ezimageai-site-production` and `ezpic-workflows-workers-production`; both reads
returned HTTP 200. Only binding names/types were retained, with no secret values
read or logged. Both have the existing Kie, SeeAPI, Waffo and Hyperdrive bindings.
Neither has `VIDEO_WORKFLOW`, `VIDEO_MEDIA_BUCKET`, `VIDEO_V1_ENABLED`, the three
callback-verification settings, the video price-approval settings or video provider
concurrency. There were no `VIDEO_*` bindings on either Worker. This confirms these
video deployment prerequisites are absent remotely as well as locally; it does not
test provider account permissions or database migration state. No remote setting
was changed.

Kie's [official verifier documentation](https://docs.kie.ai/common-api/webhook-verification.md)
directs the account owner to view or generate `webhookHmacKey` in
[Settings](https://kie.ai/settings); no API-key-based retrieval endpoint was found
in its public common-API index. SeeAPI's
[signing-key panel](https://www.seeapi.com/keys/?tab=webhook-signing-key) states that
the full secret is shown only once after creation/rotation. Its authenticated
metadata GET does not recover that secret. Reuse a securely retained secret where
available; do not silently rotate a key shared with other integrations.
`VIDEO_SEEAPI_CALLBACK_SECRET` is a separate application-generated URL proof secret,
not another provider-issued credential. Neither provider key was created or rotated.

## Smallest useful real acceptance batch

After all prerequisites and a total paid budget are established, three distinct
requests can cover the baseline paths: Kling 2.6 text-to-video, 5 seconds, silent;
Kling 2.6 image-to-video, 5 seconds, silent, using one owned immutable reference;
and Kling 2.6 text-to-video, 5 seconds, native sound.

The code's referenced public Kie generation-price subtotal is USD 1.10. This is
not an account invoice, a complete budget or spending authorization. Add three
Waffo prompt checks, one SeeAPI image check, three SeeAPI video checks (1.5 SeeAPI
credits at the documented five-second rate, with the account's actual USD
conversion), storage/runtime/payment costs and the approved failure allowance.
Unverified prices remain unconfigured.

Each request must traverse real Waffo, Kie, private transfer, verified/persisted
SeeAPI notification, bounded authenticated result confirmation, authorized private
playback and exactly one settlement. Reuse the same accepted attempts to inspect
browser closure, duplicate callbacks and transfer recovery; do not generate again
merely because a waiting stage or storage retry is being inspected.

This three-case smoke does not certify the whole model directory. The runtime
understands explicit per-product disabled overrides, but the existing admin input
schema/UI does not expose the new video keys. Do not claim an operational per-model
release switch is available without an authorized configuration mechanism.
Global video access remains closed while acceptance is incomplete.

## Required real timing evidence

The protected video diagnostics already expose stable job/attempt IDs and persisted
timestamps. For each accepted real task, retain provider completion and result
confirmation, storage start/end, output-review start/end, READY, and browser first
playable frame. Report result discovery, transfer, review, finalization and
provider-complete-to-playback separately. Missing browser or supplier timestamps
remain null/NOT_RUN; do not substitute build durations or Mock timing.

Real provider/moderation acceptance, cloud delivery latency, production migration,
deployment and feature opening remain BLOCKED / NOT_RUN in this preflight. Existing
[deployment and rollback instructions](video-v1-rollout.md) still apply; this change
adds no migration and does not alter credentials or production business data.
