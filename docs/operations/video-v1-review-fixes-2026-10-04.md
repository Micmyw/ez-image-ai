# Video review fixes: 2026-10-04

Review baseline: `4a7294c0f8d085953eb6a1fffbec41bcaec6e2bf` on
`codex/video-v1-release`. The three reported findings were checked against the
implementation before repair. This follow-up does not merge main, migrate production,
deploy, or send paid provider requests.

## Scope and regression evidence

| Finding                                                                             | Repair                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A valid video with audio was rejected above the retired 25 MB spoken-review ceiling | Storage transfer and existing-object inspection read the immutable audio policy carried in output constraints. `not_requested` keeps the normal output rules; historical `required` or missing policy keeps its original limit.                         | Two new 30 MB transfer/recovery cases failed before the fix and passed afterward. Config and affected storage/fulfillment suites: 45 PASS.                                                                                                                   |
| Generation could be purchased without enough space to save its output               | Reserve the accepted output capacity atomically with admission and retain it through the original execution attempt.                                                                                                                                    | Two regressions reproduced the original admission gap. The final aggregate PostgreSQL run passes capacity rejection (including only one byte remaining), idempotency, shared quota, paid-send fencing, uncertain holds, recovery and actual-byte settlement. |
| Cleanup could delete a successful output before its saved expiry                    | Candidate selection and transactional recheck share the same retention predicate. A saved deadline takes precedence; successful outputs without a deadline remain protected. Failed, undelivered outputs without a deadline retain the 30-day fallback. | Eight behavior regressions failed before repair. All 21 isolated PostgreSQL cleanup cases and 4 Jobs cleanup cases passed afterward.                                                                                                                         |

The native-audio settings no longer display the obsolete claim that spoken-content
review is performed. No replacement warning or additional product prompt is added.
Its two rendering regressions failed before repair; the 27-test video UI suite passed
afterward, with SaaS types, formatting and lint also passing.

Independent read-only checks covered the capacity accounting and cleanup changes.
The cleanup reviewer checked the shared predicate, live/manual/uncertain protections,
lease guards, idempotency and release only after physical deletion. That review did
not independently rerun the implementer's tests.

## Capacity and recovery contract

- Quote/job snapshots freeze `outputStoragePolicy`; admission reserves the complete
  100 MiB output budget in the same transaction as the job and credit reservation,
  using the stable `video-output:${jobId}` reference key.
- The paid-submission fence requires the reservation. Transfer atomically changes
  that same reservation row to `generation-output:${assetId}`; successful storage
  commits actual bytes. There is no double counting or unreserved transfer window.
- The existing shared upload/image quota accounting includes these reservations.
  Passing the diagnostic expiry timestamp or lowering today's quota does not
  release capacity already accepted for a running or uncertain task.
- A definite pre-output failure releases empty capacity. An uncertain submission
  keeps its original credits and capacity. If an object may have been written,
  capacity is held until physical cleanup completes.
- Previously accepted jobs without a reservation cannot make a new paid request.
  Already-paid historical jobs may recover storage only after authenticated provider
  success and a new check for the full required capacity; recovery does not regenerate.
- The shared lock order is owner storage, video job, then asset. This repair adds
  no schema migration, environment variable, scan loop or provider call.

## Final verification

| Check                                                             | Result                                                  | Evidence / boundary                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node tests/video-v1/local-command.mjs test:video:unit`           | PASS: 580 tests across 38 files                         | Config, adapters, storage, Jobs, API, orchestrator, native workerd, web-host and SaaS. External network blocked; zero paid generation requests.                                                 |
| `node tests/video-v1/local-command.mjs test:video:integration`    | PASS: 144 database tests + 24 Jobs flow/isolation tests | Dedicated loopback PostgreSQL; three opt-in performance cases NOT_RUN.                                                                                                                          |
| Fresh isolated PostgreSQL migrations                              | PASS: 59/59                                             | Includes all four existing video migrations; no unfinished migration. No production database used.                                                                                              |
| Affected Config, Database, Jobs and SaaS type checks              | PASS                                                    | Owning-package checks; not a claim that all repository checks were rerun.                                                                                                                       |
| Nine browser cases                                                | PASS: 9/9                                               | Actual SaaS/auth UI, mocked video RPC; 2.7 minutes. Desktop and 390 px screenshots inspected. Not external generation acceptance.                                                               |
| Jobs build and actual local workerd/PostgreSQL probes             | PASS                                                    | Artifact SHA-256 `06b331354017a8dcc968ec40a7894b3545cee31b599585ba5d4c30979b21eb98`.                                                                                                            |
| Linux website production build and actual artifact workerd probes | PASS                                                    | 409.319 seconds in isolated Docker. Health, dynamic login, theme initialization and static caching passed. Artifact SHA-256 `23e0a1a4427dd7af367f704a64e8f4f6955f6289786878b53c3f7dcf59ded81f`. |
| Final changed-file formatting, lint and diff checks               | PASS                                                    | 30 staged files checked for formatting; 19 source files checked by lint; cached diff check passed.                                                                                              |

The first aggregate database run exposed an outdated moderation-event fixture:
its decimal 100,000,000-byte quota was smaller than the complete 100 MiB admission
budget. It was changed to the shared constant, preserving the production guard.
The complete command was rerun successfully (144 + 24 PASS).

Both build snapshots have source-manifest SHA-256
`53761392bb8f160189019051e6198a67252d0625ca94dfdfee756e3b1d9af66b`
(2526 files). Subsequent changes were documentation and the moderation-event test
fixture; no runtime or product UI source changed after the build snapshot.

Focused and aggregate counts overlap and must not be added as independent tests.
Raw local logs are retained in `.cache/video-v1-review-fixes/` and
`.cache/video-v1/review-fixes/`; caches and fixture environment files are not committed.
Local fixtures are not evidence of live Kie, Waffo, SeeAPI, R2 or Hyperdrive acceptance.

Browser verification used real account/session/page code, but intercepted every
video RPC, upload and playback response. The isolated UI database had zero video
jobs and zero credit reservations afterward. Thus refresh, double-click, uncertain
response and mobile-layout cases prove UI behavior only. Database/Workflow behavior
is covered separately by the isolated integration and native workerd checks.

Local stage timings: Jobs build plus workerd 8.734 seconds; browser harness
179.085 seconds (Playwright execution 160.454 seconds); website wrapper
409.319 seconds, including dependency install 203.4 seconds, Next compilation
64 seconds and static generation 3.1 seconds. These measurements are neither
real-generation stage latencies nor cloud capacity results.

Task-owned test processes exited. The dedicated PostgreSQL, MinIO and website-build
containers and their temporary volumes were removed; ports 55439 and 3349 closed.
Shared services were untouched. The unmerged review worktree and ignored local
evidence remain available for the next review.

## Deployment and rollback

This follow-up changes code only; the four migrations and deployment configuration
in the [rollout guide](video-v1-rollout.md) remain required for the whole feature.
Website and background artifacts must be released together after the unchanged
external acceptance gates are satisfied. This repair is published only to the review
branch; it does not authorize or record production opening.

Reverting to `4a7294c0` restores the three known defects. Close new admissions before
an operational rollback and retain the repaired runtime while draining accepted work
where possible. Preserve all capacity rows and immutable snapshots created by this
repair; do not bulk-release uncertain jobs or reset their attempts. Any residual
job-key reservations after a runtime rollback require audited reconciliation against
the same task and its physical objects before release.

## External and production status

- Code: three verified findings repaired and obsolete audio-review hint removed;
  independent source review and the listed local checks passed. Changes are confined
  to `codex/video-v1-release`; the containing Git commit identifies this repair.
- GitHub CI: NOT_RUN at handoff; branch-only publication is not CI evidence.
- Real external acceptance: BLOCKED / NOT_RUN. The callback, price and account/model
  acceptance requirements in [the review guide](../implementation/video-v1-github-review.md)
  remain unchanged.
- Production migration, deployment and opening: NOT_RUN.
- Real generation-to-storage-to-review-to-playback latency: NOT_RUN. Historical local
  performance measurements are not relabelled as evidence for this repair.

The prior review snapshot and its build hashes remain in
[the original review verification](video-v1-review-branch-verification.md).
