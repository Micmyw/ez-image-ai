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

The same CI run also exposed a separate production-build E2E configuration
regression. Its website log repeatedly reported that the test safety adapter was
forbidden under `NODE_ENV=production`, even with the established loopback-only
test harness identity. A focused configuration regression reproduced that exact
failure. The run was cancelled after diagnosis, rather than allowing every
browser case to exhaust its timeout; it is not a passing run. The 12 ordinary
MinIO and five video-input MinIO cases had already passed before cancellation.

Text and image moderation now reuse the existing complete local E2E identity
check. It requires both E2E flags, explicit Mock/test adapter opt-ins, a valid
run ID, matching loopback test-database URLs and a loopback HTTP site origin.
The database URL additionally rejects non-PostgreSQL protocols and any query or
fragment, preventing PostgreSQL connection parameters from overriding the
apparently local host. Ordinary production and incomplete/remote fixture
identities still fail closed, and the low-level adapter's production rejection
is unchanged. Focused regressions passed: 97 config/guest cases, 46 configured
image/low-level adapter cases and 42 text-moderation cases (185 total). These
overlap other suites and are not added to their totals.

[The run on `e6c12c62`](https://github.com/Micmyw/ez-image-ai/actions/runs/37187052637)
passed all 1577 integration cases (five optional skips), the database-backed
workerd artifact and route smoke. Its final global invariant check exposed two
test-data problems: 28 manually constructed Kie recovery inbox rows omitted the
identity fields that the real persistence path writes; 23 valid SeeAPI inbox rows
lost their owning jobs/assets when later suites used `TRUNCATE ... CASCADE` on the
same database. A local reproduction confirmed all 23 were missing both related
records. The recovery fixtures now use complete identities. Destructive suites
now use a third, explicitly approved guest database; the workflow checks full
invariants on both main and guest targets. Twenty-four target/routing regressions
cover the actual command plan, including absent configuration, loopback aliases,
query-only differences, repeated database names behind different forwarded ports and forbidden connection overrides. Invariant SQL and
provider coverage are unchanged.

That run also reported 34 authenticated browser passes, one login retry that
passed and one avatar failure. The avatar upload and profile update succeeded;
the trace showed CSP upgrading the local HTTP MinIO redirect to unsupported HTTPS.
The strict local production-build E2E identity now controls that transport
exception. Normal production keeps HTTPS upgrade and HSTS. The original avatar
assertion is unchanged; 31 focused transport-policy cases passed. Guest browser
and video UI steps did not execute in that failed run and remain NOT_RUN there.

The workerd network-denial smoke separately exposed a stderr delivery race: its
HTTP error response arrived before the matching log record. A controlled 100 ms
stderr delay reproduced the failure and then delivered the same denial reference.
The correction awaits that exact complete record for at most three seconds and
still asserts the network-denial cause; absent or unrelated evidence cannot pass.
Fifteen focused cases and the real local workerd smoke passed, including the same
100 ms delay injection. The tests are discovered by the existing Storage unit
contract command. This verifies local workerd behavior, not a Cloudflare deployment.

[The run on `2ea0ef29`](https://github.com/Micmyw/ez-image-ai/actions/runs/37188831446)
passed four of five jobs, including all 1577 integration cases, both database
invariant checks, production builds and the workerd smoke. MinIO passed 12 image
and five video-input cases. Authenticated browsers passed 34 cases and two more
after a login retry; the avatar regression passed. The guest phase passed 27
cases, but its homepage resource check failed twice at 534,261 gzip bytes against
the existing 532,480-byte limit. Its trace showed a statically imported video
catalog/hooks chunk of 11,980 gzip bytes on the guest homepage. Video UI did not
execute after that failure; this run is FAILURE, not a complete browser pass.

Both shared navigation entry points now load `VideoNavigationLink` dynamically
inside the existing registered-user condition. The link still requires the
server catalog's availability decision. Two guest/anonymous import regressions
failed before the change; all 21 focused shell/navigation cases passed afterward.
The existing production homepage browser test also rejects the actual video
catalog product marker in downloaded scripts, without changing its byte limit.
The resulting production resource total must be verified in the subsequent CI
run; a source-level split alone is not that measurement.

The two login retries in that run were not unexplained browser timing: server
logs recorded HTTP 429 for `POST /api/auth/sign-in/email` after three successful
sign-ins inside ten seconds. Better Auth's production password-login rule is
three requests per ten seconds and returns `X-Retry-After`. The browser-test
helper now listens before submitting the real form and honors at most one valid
0–10-second server cooldown. Missing/invalid delay headers, other errors and a
second 429 fail explicitly. Production authentication and its rate limits are
unchanged, and the tests retain their real login and post-login URL assertions.
All 19 focused cooldown contracts passed; the E2E tooling type check passed.
The homepage navigation change also passed the SaaS type check and independent
source review. No local database or browser server was restarted for these fixes.

[The run on `842797aa`](https://github.com/Micmyw/ez-image-ai/actions/runs/37190262925)
passed the four non-browser jobs, all 36 authenticated and 28 guest browser cases
without flaky retries, and both MinIO groups. The measured homepage total fell
to 531,366 gzip bytes, below the unchanged 532,480-byte limit; the new video
catalog exclusion assertion passed. The final video UI phase executed for the
first time in CI: two cases passed and seven failed at their repeated password
login setup with HTTP 429, before reaching video assertions. This run remains
FAILURE. The video fixtures now reuse one real authenticated
session in independent test contexts, while retaining the explicit clear-cookie
and reauthentication scenario.

The guarded local video runner now accepts an explicit
`E2E_USE_PRODUCTION_BUILD=true` opt-in instead of always replacing it with false.
Its default remains development mode, and the database, loopback, environment
scrubbing and no-paid-network guards are unchanged. Eight offline dispatch
regressions passed, including a failure reproduced before the opt-in fix; the
existing CI quality job now runs this check unconditionally.

The complete local video UI rerun then passed all nine cases against a fresh
PostgreSQL 17.11 database with all 59 migrations and dedicated private MinIO.
It used a newly built production Next.js site, real local authentication and
the unchanged video RPC/upload/playback Mock boundary. There were no skipped,
unexpected or flaky cases: two password-login POSTs returned 200, with zero
HTTP 429 responses. The full command took 194.273 seconds including the build;
this is test execution time, not real video delivery latency. The process
record confirmed all 66 observed task-owned processes exited and port 3349
closed. A first setup attempt had stopped before building because the local
seeder's dedicated MinIO endpoint was missing; that prerequisite was supplied
without relaxing the seeder or network guard.

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

For a complete local `pnpm test:integration`, provide the usual
`TEST_DATABASE_URL`, the separately migrated `GUEST_TEST_DATABASE_URL`
(`127.0.0.1:55440/ai_media_guest_test`) and the explicit migrated
`VIDEO_VERIFICATION_DATABASE_URL` accepted by
`tests/load/video-verification-target.ts`. The API-only phase also requires the
guest database but does not require the video database. All three physical
targets must be distinct. See the workflow for the disposable service definitions;
never substitute a production target. Main and guest targets both undergo the
unmodified `pnpm verify:invariants` check after integration.

### Complete local integration result

The latest complete sequence passed on 2026-10-04 against three fresh,
task-owned PostgreSQL 17.11 databases, each with all 59 migrations applied. It
used only local fixture credentials, explicit Mock/test adapters and the
no-paid-network guard. Integration completed in 251.5 seconds; integration,
route smoke and both invariant checks completed in 260.1 seconds with exit code 0.

| Serial group                                     | Passed | Optional cases not run |
| ------------------------------------------------ | -----: | ---------------------: |
| Ordinary database                                |    365 |                      0 |
| Guest database, growth and shared video capacity |    107 |                      0 |
| Dedicated SeeAPI handoff database                |     32 |                      0 |
| Main Jobs database and video domain flows        |    101 |                      5 |
| Isolated runtime-stores database                 |     76 |                      0 |
| API                                              |    884 |                      0 |
| Guest API boundary                               |     12 |                      0 |
| Total in this command                            |   1577 |                      5 |

The five skips are explicitly opt-in: three video concurrency performance cases
(`VIDEO_V1_RUN_PERFORMANCE=1`) and two legacy immutable-S3 crash-recovery cases
(`RUN_MEDIA_STORAGE_INTEGRATION=true`). They remain NOT_RUN in this command.
This total includes unit and database-backed cases selected by the integration
runner; it is not a count of independent real-service requests and must not be
added to historical overlapping test totals. The local log and process record
are retained under `.cache/video-v1-prerelease/isolated-integration-and-invariants*`
and are not published as production evidence. Both main and guest databases
passed all ten unmodified invariant checks. The main database retained all 23
SeeAPI inbox records with zero missing jobs or assets, proving the result did not
come from deleting the evidence. The earlier failed reproduction is retained
separately.

After verification, both task-owned PostgreSQL containers and their dedicated
volumes were removed following graceful shutdown. Ports 55432, 55439 and 55440
were confirmed closed, and all recorded task process trees exited. The shared
PostgreSQL and MinIO services retained their original container identities,
start times, volumes and healthy state. The unmerged review worktree and local
diagnostic evidence are retained.

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
