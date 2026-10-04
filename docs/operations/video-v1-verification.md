# Video generation V1 verification

> **Historical scope; superseded runtime (2026-10-04).** The current implementation uses
> Waffo prompts and SeeAPI visuals, retires Sightengine calls and preserves native sound
> without an audio-review service. Earlier scope and test results below remain historical.
> Current acceptance and release status belong to [the current report](video-v1-seeapi-verification.md).

This is the original fixed-duration/silent batch record. The user's subsequent
multi-model/audio expansion and remaining-issue repairs are tracked in
[the follow-up verification](video-v1-followup-verification.md); its final evidence
supersedes the unresolved local blockers below without rewriting historical results.

Evidence date: 2026-10-04 (Asia/Shanghai). This is an implementation and local
verification record, not a production launch certificate.

| Layer                  | Status                         | Meaning                                                                                               |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Code                   | IMPLEMENTED                    | Tasks 0–5: text/single-image input, separate Workflow, private delivery, history, ledger and recovery |
| Local / Mock           | PARTIAL: core video gates PASS | Full browser regression and native-Windows website packaging are not green; see exact matrix          |
| Real external services | BLOCKED / NOT_RUN              | No authorized paid account acceptance, actual price or moderation configuration                       |
| Production opening     | NOT_DEPLOYED / DISABLED        | No production migration, upload, deployment, callback registration or feature opening                 |

## Repository and scope

Branch `main`; starting and final HEAD
`569bf39eea9dcf072d3c5e5f79d58cd38d6bb466`. All changes remain uncommitted.
No staging, reset, checkout, push or production action occurred. The plan's older
baseline was not restored. Existing dirty work was captured before implementation;
see [actual file map](../implementation/video-v1-file-map.md) and
[batch file inventory](../implementation/video-v1-changed-files.md) for attribution.
Concurrent unrelated edits are explicitly excluded from this batch.

The implementation uses `/video` and `/video/history`, account-only noindex routes.
Invited users first review a configured credit quote, then confirm. Admission is
closed by default, requires a logged-in administrator or configured user-ID whitelist,
and reserves existing credits transactionally. No guest video trial was added.
Image editing, homepage search positioning, accounts, subscription prices and domain
remain on their existing paths.

`VideoGenerationWorkflowV1` executes its own input review, paid submission fence,
authoritative result query, streaming storage, output review and atomic settlement.
It does not dispatch the legacy `jobs-primary` slot or depend on browser polling,
global Outbox scans or cron for normal progression. Dedicated exceptional recovery
and cleanup use indexed batches and preserve the same job, attempt and Workflow ID.

## Contract and deliberate differences from the plan

- Official Kie documentation specifies `kling-2.6/text-to-video` and
  `kling-2.6/image-to-video`, string duration `"5"`, boolean `sound=false`, and a
  1000-character prompt cap. UI/server enforce 1000 Unicode code points.
- Text input offers 16:9/9:16. Image input has exactly one JPEG/PNG URL, no separate
  aspect ratio, and a decimal 10,000,000-byte cap further limited by account entitlement.
  Uploaded WebP is decoded and privately normalized into an immutable PNG without
  geometric changes before quote/review. It is not sent as undocumented provider input.
- Sightengine text safety currently accepts English/Latin script policy only.
  Unsupported scripts fail closed. Real text/image/video safety adapters are implemented;
  account/model policy access and whole-video sampling coverage are not certified.
- Video approval requires terminal, identity-matched complete evidence, sufficient
  temporal frame coverage and MP4 checks for real audio tracks, duration and container.
  Muting a player cannot satisfy soundlessness.
- The maintained Drizzle starter variants contain no media-domain schema/query layer
  at this HEAD. The active Prisma media domain and generated clients were extended;
  no incomplete parallel Drizzle video model was introduced.
- Successful immutable video review/retention is 30 days. Playback grants last five
  minutes and every GET/HEAD also checks current login, ownership, review, asset and
  settlement. Grant expiry does not permanently strand a retained reviewed output.

Official contract snapshots and fixture provenance are recorded in
`packages/ai/media/catalog/fixtures/kie-video-v1-contract.json` and
`.cache/video-v1/provider-report.md`. These are documentation checks, not paid tests.

## Migrations and configuration

Three additive Prisma migrations:

1. `20261004000000_video_generation_v1`: engine ownership, VideoExecution, attempt
   callback identity, immutable identity/version checks, indexes and table permissions.
2. `20261004010000_video_quote_pending_evidence`: restricted pending-review quote
   evidence for this exact video product, preserving existing image quote rules.
3. `20261004020000_video_resource_recovery`: cleanup completion and bounded inbox/
   asset recovery indexes.

Applied only to task-owned loopback PostgreSQL databases (58 migrations total).
Baseline image job/asset/account/immutable ledger values survived unchanged, and
existing rows default to `legacy`. Actual `SET ROLE` tests deny anon/authenticated
and allow the intended server role. The actual production connection role still
requires release verification. Prisma clients/Zod were generated from schema.

See [closed configuration example](video-v1-configuration.example.env) for all fields.
Formal credits/costs, actual shared supplier capacity, output-host allowlist and
secrets are deliberately unset. Required native bindings are `VIDEO_WORKFLOW`,
`VIDEO_MEDIA_BUCKET`, `HYPERDRIVE` and existing `IMAGES`; upload CORS readiness must
be confirmed. Both existing Workers and hybrid profile generation preserve the new
class and legacy identities.

## Command evidence

Commands ran with local-only fixture settings. The verification wrapper shadows
environment-file keys without copying their values; network guards deny provider,
moderation and other external requests. Website builds/browser regression permit
only GET/HEAD downloads from Google Fonts hosts. No paid test was attempted.

| Check                                       | Result / evidence                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:video-v1`                        | PASS: 156 tests across config 4, provider/safety 16, metadata 10, jobs 55, API 14, orchestration 10, actual workerd 3, profiles 22, UI 22; `video-unit-final.log`                                                                                                                                     |
| `pnpm test:video-v1:integration`            | PASS on new empty migrated DB: database 35 tests + 6 real-domain flow cases, including 353 completed Mock jobs; `final-video-integration.log`                                                                                                                                                         |
| Real MinIO input/Range integration          | PASS 5: JPEG/PNG/WebP seal, overwritten staging isolation, normalized identity reuse, Range/ETag and invalid/truncated image rejection; `video-input-minio.log`                                                                                                                                       |
| Migration/defaults/RLS                      | PASS; `migration-verification.json`, `migration-final-grants.json`                                                                                                                                                                                                                                    |
| `pnpm verify:invariants`                    | PASS 9/9 with 75 retained video fixtures, all without legacy Outbox. Missing-VideoExecution negative fixture failed correctly, then was removed; `invariants-final.log` / `invariants-negative.log`                                                                                                   |
| `pnpm type-check` equivalent without dotenv | PASS: `pnpm exec turbo type-check`, all 22 tasks including SaaS, API, jobs, database and Workflows; `full-types.log` and final `full-types-completion.log`                                                                                                                                            |
| `pnpm workflows:type-check` workspaces      | Covered by successful full type-check of jobs, Workflows and jobs-runtime                                                                                                                                                                                                                             |
| `pnpm cloudflare:jobs:build`                | PASS final build: 9313.29 KiB / gzip 2178.63 KiB; `jobs-build-final-runtime.log`                                                                                                                                                                                                                      |
| Built jobs artifact in actual workerd       | PASS native cross-Worker video binding/schema guard, legacy image auth/routing and isolated PostgreSQL; `workflow-artifact-final-runtime.log`                                                                                                                                                         |
| Video browser acceptance                    | Seven scenarios have PASS evidence across a 6/7 full run plus a focused successful retry after local auth ECONNRESET. Real isolated Better Auth; video RPC/storage/playback responses are fixtures. `ui-evidence/browser-seven-cases.json`, `browser-recovered-confirmation.json`                     |
| `pnpm lint --deny-warnings`                 | FAILED full-tree command: generated/untracked cache and unrelated pre-existing files participate. Task-owned scoped lint is tracked separately below; unrelated work was not rewritten                                                                                                                |
| `pnpm format:check`                         | FAILED full-tree command: 709 files including cache/unrelated dirty work. Task-owned scoped formatting is tracked separately below                                                                                                                                                                    |
| `pnpm test:unit:contracts`                  | PASS by phase continuation: upstream stages in `contracts-final-clean.log`; API 636/636 in `api-contracts-final.log`; SaaS 739 cases have passing evidence across 737/739 then focused 10/10. One unrelated workerd case stays skipped. Earlier full invocations exited 1                             |
| `pnpm test:integration`                     | PASS by phase continuation: 735 distinct cases = database 272 + guest database 99 + jobs 139 + API 225. See `final-regression-report.md` and its linked logs; earlier complete commands exited 1                                                                                                      |
| `pnpm cloudflare:web:build`                 | BLOCKED at OpenNext packaging on native Windows: pnpm junction access denied and invalid `cloudflare:sockets` directory. Next compilation, TypeScript and 59/59 static pages PASS, `/video` and `/video/history` included; `web-build-fonts-allowed.log`. This is not a deployable site artifact PASS |
| `pnpm e2e:media:ci`                         | FAILED overall: original account group 31 passed / 4 failed / 1 NOT_RUN; targeted retry recovered 3 failures, avatar remains failed. Guest continuation 18 passed / 9 failed / 1 skipped (NOT_RUN). Logs: `image-e2e-final-run.log`, `image-e2e-remaining.log`, `image-e2e-guest.log`                 |
| Final scoped lint/format                    | PASS on explicitly selected batch source/docs files; exact checked file counts and output in `scoped-quality-completion.log`. Generated/unrelated cache excluded                                                                                                                                      |

Logs named above are under `.cache/video-v1/`. They are local evidence, not remote CI.
The workerd timeout-path test emits a known platform `WorkflowTimeoutError` log while
its assertions pass. Browser video decode, actual generated output and real Cloudflare
latency are not established by the fixture browser tests.

## Failure and recovery verification

The image browser regression used real local auth, PostgreSQL, MinIO and the legacy
Outbox pump with a fixture provider. Its first 36-case group was not fully green.
The mobile test expected removed comboboxes even at the initial snapshot; it now
exercises the existing keyboard-accessible options popover. Checkout review needed
the same explicit local database guard used by the isolated regression. Upgrade
restoration passed after waiting for editor readiness and asserting prompt preservation
before/after model selection. No image product source was changed for these test repairs.
The avatar test still failed before a crop dialog appeared; a proposed chooser-based
test adjustment also failed and was reverted. Its original test and avatar product
source remain unchanged. The underlying cause is **unresolved**, so complete image
browser acceptance is **not certified**. First/targeted run logs and screenshots are
retained in `.cache/video-v1/image-e2e-*`; neither failure is hidden by rerunning a
paid generation.

The separate guest continuation exercised all 28 scheduled cases: **18 passed,
9 failed, 1 skipped (NOT_RUN)**. The actual anonymous image trial case passed. The nine
failures are landing prompt-save/editability, editor visibility/docking, model/SKU
upload stages, retry input preservation, comparison examples and responsive tool
expectations. They remain **FAILED**, with no claim of a proven common cause.
`LandingGenerator`, `LandingPage`, `GenerationForm`, `ImageEditorWorkspace` and
`PromptPanel` exactly match their task-start hashes
(`image-regression-baseline-hashes.json`); the existing landing tests and these
product components were not rewritten to mask the failures. A clean baseline
browser comparison was not performed. Full image/browser release certification
therefore remains blocked independently of the passing video-focused tests.

| Injected condition                                                                | Verified behavior                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Twenty concurrent identical admissions / changed request under same key           | One job/reservation/ledger/start identity; changed immutable input conflicts                         |
| Last credit or capacity slot contention                                           | Short locked transactions prevent excess reservations and leave no failed admission slots            |
| Staging overwritten, wrong owner, corrupt/truncated image, expired quote          | Original sealed content retained or request rejected before paid submission                          |
| Workflow create response lost / durable startup pending                           | Stable `video-v1-${jobId}` recovered; no random replacement instance                                 |
| Supplier accepted before local task-ID persistence failed                         | Durable attempt remains uncertain; no second paid POST or speculative release                        |
| Early/repeated/out-of-order callback; replaced URL in signed Kie body             | Durable inbox is idempotent; authenticated query determines actual result                            |
| Inbox persisted but notification failed                                           | Same event can be replayed; early signed moderation event binds only its original sealed-output task |
| Missing callbacks / repeated pending responses                                    | Bounded fresh query rounds for the same provider task; deadline parks NEEDS_REVIEW                   |
| Interrupted transfer / storage success followed by DB failure                     | Recover original object/asset and transfer stage; generation call count stays one                    |
| Incomplete/sparse video review, refusal, service error, invalid MP4/audio         | No playable output; rejection/evidence/quarantine/release commit together                            |
| Repeated finalize / late failure / day-two playback                               | One settlement, monotonic READY, retained immutable review remains usable                            |
| Owner mismatch, expired/deleted/unreviewed output, HEAD/Range                     | Access denied or correct HEAD/206/416 behavior; current auth checked on every request                |
| Video intake closed / old executors, callbacks, review, admin and recovery active | Existing video drains under its own engine; old entry points cannot mutate it                        |
| Cleanup fails or WebP source outlives staging key                                 | Active/uncertain/review-held resources preserved; same storage cleanup retries before quota release  |
| Refresh/close/sign-out/relogin/interrupted response                               | Account-scoped receipt/history restores same request; server execution independent of page           |

Aggregate regression exposed and fixed a real concurrent moderation inbox race,
SSI contention under explicit admission/settlement locks, rejection atomicity and
review-expiry problems. Temporary fixture leftovers were separately repaired without
loosening production capacity or ledger invariants.

## Performance and billing evidence

Final benchmark: 353 completed jobs, 353 Mock provider submissions, 1230 Mock safety
calls, zero real provider or moderation calls. Every job has one attempt and one
settlement. Ten batches at each test concurrency use 50/100/200 timing samples.

| Local Mock concurrency | Samples | Whole local flow P50 / P95 ms |
| ---------------------- | ------- | ----------------------------- |
| 5                      | 50      | 558.33 / 709.18               |
| 10                     | 100     | 836.17 / 1019.18              |
| 20                     | 200     | 1769.95 / 2931.77             |

These use real local SQL and domain services, an in-process Workflow harness, a
synthetic 64 KiB MP4 metadata fixture and a deliberate 10 ms Mock provider delay.
They do not measure real decoding, supplier generation, cloud scheduling, R2 or
Supabase performance. Peak overlapping Mock submissions was 3; no global single
heavy-job slot was used. Synchronous success paths had zero artificial polling waits.
Same-clock startup ordering passed for every job.

At test concurrency 20, request-to-reservation P95 was **1679 ms**, exceeding the
plan's 1-second target in this local stress run; at the closed-beta concurrency 5
it was **187 ms**. This is a measured limitation, not a production SLA result.
Local harness startup times do not certify the platform's 2-second startup target.

Per-task timestamps/segments and summarized P50/P95 are saved under
`docs/operations/evidence/video-v1/`: [summary](evidence/video-v1/performance-summary.json)
and [353-task CSV](evidence/video-v1/task-stage-timings.csv). The source successful run
is `2026-10-03T17:13:42.537Z`; raw benchmark is `.cache/video-v1/performance.json`.
The CSV includes the 350 concurrency samples plus text, image and uncertain-submit
recovery functional cases. Callback **receipt** to authoritative confirmation is
measured; callback **commit completion** to confirmation is `null / NOT_INSTRUMENTED`
because there is no independent commit-completion timestamp. These are not interchangeable.
Real generation duration, real safety duration, real upload/cloud transfer duration,
browser ready-display/first-frame timing, real provider cost and real moderation cost
are all **null / NOT_RUN**. There are no real tasks for a real-task timing table.
Mock ledger prices are fixture values and must not be copied to production pricing.

## External acceptance and opening blockers

1. **BLOCKED:** approved Kling account access to both exact models, actual shared
   quota, authoritative accepted output hosts and final commercial credit/cost basis.
2. **BLOCKED:** real text/image/video safety credentials/policy access and signed
   account-level Sightengine callback configuration; verify whole-video evidence
   coverage, language policy, actual billing and Kie callback/authenticated query.
3. **BLOCKED:** explicit production migration/deployment and paid-test authorization
   with a total generation plus moderation budget. The plan's suggested four tasks
   is a proposal, not approval to spend.
4. **NOT_RUN:** real Cloudflare Workflow/startup/recovery, private R2/CORS, Hyperdrive
   TLS/cache and Supabase role acceptance; final site artifact/build limits are above.
5. **NOT_RUN:** generated five-second MP4 with no audio tracks, actual browser decode,
   private Range/download, same-content moderation, cost and per-stage real timing.

Deployment order and rollback are in [video-v1-rollout.md](video-v1-rollout.md).
Close new admission first; retain the versioned receiver, callbacks, database fields,
recovery and settlement until accepted jobs drain or are reconciled. Never change
video ownership to legacy or replay an uncertain paid attempt during rollback.

Local cleanup completed: all 85 recorded browser-run process entries were absent,
with no listeners on task ports 3339/3349. The exact task-owned PostgreSQL and MinIO
containers and their anonymous volumes were stopped/removed after evidence capture;
ports 55439/59000/59001 are closed. See `final-process-cleanup.json`,
`container-cleanup.json` and `final-resource-cleanup.json`. Shared PostgreSQL/MinIO
and Codex/plugin services were not stopped. Local logs, snapshots, CSV and reports
remain available; no service was intentionally retained. No task-owned worktree was
created. Existing uncommitted source and concurrent unrelated edits remain intact.
