# Generation speed integration and acceptance — 2026-10-09

## Status and source

This plan records local integration status, not final implementation acceptance.
C2 code has been imported and awaits combined C1+C2 verification; C1 and C3–C6
implementation SHAs are still pending. The C7 read-only audit has been imported;
C7 optimization is conditionally blocked. No production configuration change, paid
request, migration against production, push, or deployment is included.

- Fixed baseline: `af4c7a333f3820a5914aca9f8ad867a537700f10`.
- Integration branch: `codex/generation-speed-integration`.
- Worktree: `D:/AIProject/Gefei/SaaSTool/ez-image-ai/.worktrees/generation-speed-integration`.
- Root checkout and other worktrees remain untouched.
- Source: `ezimage-generation-codex-handoff(1).md`, Library
  `libfile_8bc567030ca08191b078668aef012de3`,
  file `file_00000000234c8230a7386790edab467a`; version was returned as null.
- All 528 lines were read through Library in contiguous windows 1–190, 191–360,
  and 361–528. Reconstructed UTF-8 text is 46,407 bytes.
- Source SHA-256:
  `0a587d14ea09dcb4cbc895640d03cea5195eea381ad8932e42ff13a9a50c93a9`.
- Local source and identity receipt:
  `D:/梅一伟/Documents/codex/2026-10-08/task/generation-speed-20261009/source/`.
  This is a complete Library text read reconstructed locally, not a claim that a
  cloud path was materialized on Windows.

Read root `agents.md`, `apps/saas/AGENTS.md`, relevant repository verification,
unit-test, environment and documentation skills, and the Cloudflare runtime/profile
references. Node is 24.14.1; the pinned pnpm is 11.3.0. Native worktree creation was
unavailable; Git created a new branch in the already-ignored `.worktrees` directory.

## Ownership and integration order

The parent coordinates the five implementation groups. Do not create duplicate
implementation sessions or edit their active worktrees.

| Group       | Scope                                                    | Primary ownership                                                                                                           | Handoff dependency                                                                              |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A           | C1 and browser admission/display timing                  | media generation hooks, GenerationForm where needed, preview timing and related UI tests                                    | First batch; coordinate the job correlation field with B                                        |
| B           | C2 and server admission timing                           | SaaS request scope/Worker entry, new request-local registration module, API context, submit/create dispatch path and tests  | First batch; publish optional defer contract before consumers                                   |
| C           | C3/C4                                                    | video execution callback persistence, jobs video webhooks, video fulfillment claim/context and tests                        | C4 must finish before E edits either fulfillment file                                           |
| D           | C5/C6                                                    | generation authorization/free-credit wrapper and DB helper; jobs runtime/dispatch/executor/contracts/continuation and mocks | Keep B's create-generation dispatch section owned by B; coordinate any shared signature changes |
| E           | C7 feasibility audit first                               | read-only storage write/identity audit; output-storage and fulfillment implementation only after C4                         | Do not enable fast path without identity, conditional-read and recovery evidence                |
| Integration | Cross-group acceptance, conflict resolution and evidence | This plan; later integration-only harness/report paths after contract notification                                          | C1+C2 → C3/C4+C5/C6 → eligible C7 → independent Astra max review                                |

File ownership includes corresponding tests. Shared surfaces needing explicit
coordination before edits:

1. `packages/api/modules/media/procedures/create-generation.ts`: B owns dispatch
   lifecycle; D should keep admission optimizations in authorization/DB helpers.
2. `packages/jobs/src/video-v1/fulfillment.ts` and
   `packages/database/prisma/queries/media/video-v1-fulfillment.ts`: C then E,
   never concurrent patches from the original baseline.
3. `packages/jobs/src/contracts.ts`, `runtime.ts` and store mocks: D owns
   continuation return values, including explicit empty results.
4. `flow-timing.ts`: B; `preview-timing.ts`: A; video stage timing fields: C.
   Reuse existing log-only mechanisms; timing must not add a serial SQL per event.
5. Shared barrel/package exports, `agents.md`, runtime docs and `CHANGELOG.md`:
   notify parent of intended contract/documentation changes; consolidate conflicting
   documentation in integration. No new dependency or infrastructure subsystem is
   planned.
6. The parent explicitly assigned the bounded credit-cache account isolation fix
   to A/C1. Ownership includes the three readers in `use-generation.ts`,
   `HeaderPurchaseActions.tsx` and `StudioShell.tsx`, one shared owner-key/helper,
   and corresponding tests. Deliver this as a separate small commit. No global
   QueryClient replacement, whole-site cache redesign or accepted-job cancellation
   belongs to this extension.

Before cherry-pick, inspect each SHA, its parent, file list and stated checks.
Apply only commits supplied by the parent; never take another group's uncommitted
files. Keep the original baseline available in Git; do not reset a working tree
to produce performance comparisons.

## C1–C7 acceptance matrix

C2 is **INTEGRATED_PENDING_BATCH_VERIFICATION**. C1 and C3–C6 are
**PENDING_IMPLEMENTATION_HANDOFF**. C7 is **CONDITIONALLY_BLOCKED**: the audit is
delivered, but the optimization is neither implemented nor accepted.

| Item | Removed dependency / structural target                                                        | Required positive and negative evidence                                                                                                                                                                                                                                                                                                                                                                    | Primary focused tests                                                                                 |
| ---- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| C1   | Accepted job display no longer waits on history/balance invalidation                          | Both auxiliary queries held for injected 5 s: task appears after response; rejected refresh cannot turn acceptance into failure; same-key retry/double-click one job; account/action changes reject stale response; no incomplete DTO cast into job cache                                                                                                                                                  | SaaS use-generation-submit, use-generation, GenerationForm, preview-timing                            |
| C2   | Committed image request may return while short dispatch runs in managed lifecycle             | Dispatch starts immediately after commit; response can finish before dispatch; scope remains alive through response cancellation, rejection and child registration; two requests remain isolated; no-hook still awaits; lost response/recovery reuse original intent and reservation                                                                                                                       | request-scope; API submit-generation/create-generation; affected context tests; final Worker artifact |
| C3   | Inbox commit → sendEvent excludes standalone timing SQL                                       | Inbox committed + timing failure still wakes; inbox failure neither ACKs nor wakes; failed notification recovers; no new attempt on replay; missing first commit observation stays null; atomic stageData merge retains concurrent fields; callback is only a hint before authenticated query                                                                                                              | jobs webhooks; DB video-v1-execution integration                                                      |
| C4   | Normal review entry removes one logical snapshot read                                         | Claim returns already-validated minimal context; actual duration/audio retained; APPROVED/REJECTED/BUSY/UNCERTAIN and historical policies unchanged; immediate completed-result consumption preserved; writes still check lease/owner/engine/version                                                                                                                                                       | jobs fulfillment; DB video-v1-fulfillment integration                                                 |
| C5   | Existing immutable free grant skips no-op grant transaction; undefined budget skips aggregate | Full immutable command identity matches; first/month/concurrent miss grants once; debt, amount conflict, anonymous/missing/paid/grace semantics preserved; undefined budget zero aggregate, zero budget still enforced; Waffo-time eligibility changes caught in final transaction                                                                                                                         | free-plan-credits unit+DB; authorization; admission-context/create-generation                         |
| C6   | Successful submission returns committed continuation instead of rereading                     | Actual persisted pollAttemptId or deduplicated event row; repeat returns same ID; rolled-back work gives no continuation; explicit empty array suppresses lookup and global scan; undefined only uses compatibility query; crash after commit recovers without repeated paid submit                                                                                                                        | jobs dispatch/executor/runtime; continuation-delivery DB; first-image-continuation/orchestrator       |
| C7   | Eligible finalize avoids one full stored-object GET after first full stored validation        | Prove server-origin/versioned proof and immutable identity; fresh HEAD plus conditional small Range has exact response semantics; locked transaction checks current proof/owner/engine/asset/object/size/hash/ETag/constraint binding; 30 s attestation retained; missing/old proof full-read fallback; conflicts/404/412 reject/recover; concurrent finalizers settle once; deleted content stays deleted | output-storage; fulfillment; DB fulfillment; storage identity audit                                   |

### Additional mandatory C1 gate: account-scoped credit cache

Status: **PENDING_IMPLEMENTATION_HANDOFF**. The fixed baseline already uses the
same `media-credit-account` key for all three readers, with a browser QueryClient
singleton and a default 60-second stale time. Updating the session does not clear
that query. Normal logout navigates the whole page, which reduces exposure but
does not establish isolation for an in-place identity transition.

A read-only in-memory QueryObserver reproduction using the installed TanStack
version observed both a fresh cached A balance and a delayed A response in B's
observer, without starting B's query. Using separate owner keys in the comparison
started B's query and delivered only B's balance. These are controlled client-cache
observations, not a production exploit or evidence of server/ledger authorization
failure; `getCreditAccount` still reads through the authenticated `user.id`.

The C1 acceptance matrix includes all of the following:

- All three readers use the same owner-scoped key/helper. Unknown or anonymous
  identity must not start the protected credit query or display a prior owner's
  cached balance.
- Consume and forward query cancellation signals; a delayed prior-owner response
  cannot populate the current owner's view. Do not use query cancellation to
  cancel an accepted generation or discard its durable idempotency identity.
- Capture the submission owner for background invalidation. A completed A
  submission cannot refresh B's balance as though it belonged to that operation.
- Test A → B with fresh cached data, A → B while a credit request is pending,
  identity becoming unavailable, delayed auxiliary refresh rejection, and
  accepted-job continuity through account change. Use the real QueryClient for
  cache/deduplication behavior; mocked `useQuery` alone is insufficient evidence.
- Inspect existing credit invalidators for compatibility with the owner-key
  contract. Keep unrelated account, billing and global cache behavior outside
  this bounded patch; notify the parent before any further shared-file expansion.

The earlier 114-test baseline result is unchanged and does not claim these new
regressions have passed. A/C1 must supply the dedicated fix SHA and its checks.

C4's logical read count is not an SQL count. C7's target applies only to application
reads after transfer: two full reads become one on a proven ordinary path, excluding
review-provider reads and customer playback.

C7 is a conditional gate. The current task does not permit real R2 writes or online
conditional-semantics experiments. If local/source evidence cannot establish the
required safety premise, keep the full-read behavior and deliver the audit as a
bounded non-implementation outcome. Do not silently enable a weaker HEAD-only path.

### C7 audit handoff and integration decision

The parent supplied audit commit `332ee0d5c85e9c0aecb70d7011f0ca6275a71446`.
It contains only [the C7 feasibility report](c7-storage-proof-audit-2026-10-09.md),
imported without code changes as `4076c350ba1c606002ccc9fceabe90284c98fb4d`.
The report's read-only independent Astra max review reported no P0/P1/P2 findings.
That review does not establish implementation, unit, database or real-R2 acceptance.

The audit leaves three enabling premises unproven:

1. Every storage write entrance enforces non-overwrite for the video output identity.
2. Real R2 conditional multipart completion and conditional Range response semantics
   satisfy the proposed proof; local mocks or SDK field mapping cannot certify this.
3. The current private GET wrapper returns enough response evidence: it presently
   omits HTTP status and ContentRange needed for strict range validation.

Parent decision: prioritize C1–C6 and preserve both existing full stored-object
read/hash/MP4 checks. Do not add a large proof/state or infrastructure change merely
to leave a disabled fast path with no measured benefit. The implementation proposals
in the audit remain proposals; C4 completion alone does not authorize implementing
or enabling them.

After C4 integration, perform only a minimal source/contract feasibility recheck.
If enabling C7 still requires real R2 writes or shared-scope expansion, send the
specific operation/scope and remaining evidence gap to the parent for a decision
and concrete authorization before proceeding. No such online operation is currently
authorized. C7 currently removes **0 reads, 0 queries and 0 waits**, has no paired
performance samples, and remains **CONDITIONALLY_BLOCKED**.

### C2 implementation handoff

Source commit `a037cfc78ddff62868eb93cb83283f3844a984c7`, based directly on the fixed
baseline, was imported without conflicts as
`c15f0736e31da1f1093bfc068ec2aa1c9e8aad7c`. All 12 changed files are within B's
request-lifecycle, API dispatch and test ownership; database/business transaction,
authorization, pricing, ledger, moderation and provider execution files are unchanged.

Shared contract now present in the integration branch:

- Server-only `@repo/utils/request-lifecycle` exposes
  `RequestDefer = (promise: Promise<unknown>) => void`, `getRequestDefer` and
  `runWithRequestDefer`. It is not exported from the client barrel; no dependency
  or package configuration changed. Symbol-keyed AsyncLocalStorage shares only the
  registrar storage across separate server bundles, not a mutable current request.
- Worker registration uses the proxy context supplied to the
  `runScopedWorkerRequest` handler. API/oRPC context has optional `defer`;
  `submitGenerationForUser` accepts it as an optional fifth argument. Both normal
  submit and old createGeneration call `startCreatedGenerationDispatch` after the
  persisted admission result returns.
- Dispatch starts immediately. Without a hook the same work is awaited; if
  registration fails, the already-started Promise is awaited without redispatch.
  Stable Workflow/event identity, explicit empty continuation, 3-second short-wake
  timeout and durable recovery remain. The request scope retains pending/derived
  work through response cancellation, then disposes once; closing rejects late
  registrations.
- Existing log-only timing separates `request.http`, `background.dispatch`,
  commit-observation/replay-to-wake and no-hook `admission.dispatch`. No SQL was
  added for timing. Structural change: one HTTP wait removed when defer is present;
  query reduction 0, file-read reduction 0, dispatch-count change 0.

Group-reported evidence, inspected but not rerun during this import: SaaS 15,
API 41, Workflow 32 and dispatch-client 4 assertions passed; targeted type/lint/
format checks passed. The manual source-workerd harness overlaps the SaaS wrapper
and is not counted again. The group reports an independent Astra max review with
no unresolved findings. These results are not added to the earlier 114 baseline
assertions as a new integrated-candidate total.

Evidence files supplied by the parent:
`D:/梅一伟/Documents/codex/2026-10-09/task-4/c2-evidence/validation.md` and
`paired-mock.json` in the same directory. The paired JSON has N=5, one warmup per
version, concurrency 1, hot modules, 202-byte schema-only request, zero media bytes,
and a synthetic 250 ms wake timer. Function-return times are 258.3520–262.4017 ms
before and 0.1599–0.3137 ms after; each sample dispatches once. This is local mock
function timing with no real DB/provider/storage or browser/network HTTP timing,
not an estimate of production improvement.

First-batch integration will run C1 and C2 together after C1 handoff. Add
`cloudflare/request-scope.workerd.test.ts` and
`modules/media/procedures/submit-generation.http.test.ts` to that batch. Final
OpenNext website artifact lifetime/DB binding, isolated real-DB durable recovery
and ledger invariants remain **NOT_RUN**. Source workerd tests use a dynamic local
port and mocked DB scope; they do not establish those remaining gates. This import
starts no DB/port service and repeats no full build.

## Cross-cutting invariants

- PostgreSQL owns state; job/input/reservation/durable intent commit atomically.
- Retry, lost response and recovery never create another reservation or paid attempt.
- Maintain immutable ledger and one settlement, owner and engine isolation, private
  asset authorization, NSFW and visual review, historic required-audio holds.
- Preserve `af4c7a33` quality behavior: duration, sound, resolution and aspect
  deviations are output-report warnings; container/codec/track integrity, checksum,
  byte/time safety limits, current moderation evidence and deletion remain gates.
- Ordinary video stays on VIDEO_WORKFLOW, not image heavy/global Outbox routes.
- Image heavy/control/maintenance limits remain 1/4/1; native video is not assigned
  to the image heavy lane. No new queue, polling framework or generic cache.
- Section 13 remains observation only: no removal of two-phase rate limiting, guest
  delay, provider occupancy, capacity limits, or moderation retries.
- Browser drafts/account state, quote invalidation, pending submissions and original
  task recovery remain isolated. READY and metadata loaded are not first-frame proof.

## Verification phases and commands

Run each phase once per relevant integrated candidate. Re-run only after relevant
changes/failures; do not add totals from overlapping repeated runs.

### Baseline checkpoint

Install from the frozen lockfile into this worktree's own node_modules; do not
junction the other groups' active node_modules or generated files. Generate Prisma
locally only if required, with an explicitly disposable loopback URL. No DB server
or remote configuration is needed for generation or unit mocks.

Run a small baseline covering request lifetime, generation acceptance/timing and
video safety contracts. Record exact commands and results in the checkpoint result.
This is baseline health, not C1–C7 behavioral acceptance.

Checkpoint executed on the fixed baseline in the independent worktree:

- Frozen-lockfile install and both Node/workerd Prisma client generation: PASS.
- SaaS request-scope, generation hooks/form and preview timing: 5 files, 58 passed.
- Jobs video webhooks, fulfillment and output storage: 3 files, 56 passed.
- Combined non-overlapping baseline unit/mock assertions: 114 passed, 0 failed,
  0 skipped. This did not open a database server or call external services.
- Targeted Markdown formatting and Git whitespace check: PASS.
- DB integration, new 1/3/5 mixed harness, candidate type checks, Worker builds,
  browser acceptance and independent Astra max review: NOT_RUN, awaiting group
  contracts/SHAs and the integrated candidate.

Machine-readable checkpoint: [baseline-checkpoint-2026-10-09.json](evidence/generation-speed/baseline-checkpoint-2026-10-09.json).
Raw Vitest reports are retained in the task evidence directory as
\`baseline-saas.json\` and \`baseline-jobs.json\`.

### First integration batch: C1+C2

```text
pnpm --filter saas exec vitest run cloudflare/request-scope.test.ts modules/media/hooks/use-generation-submit.test.ts modules/media/hooks/use-generation.test.ts modules/media/components/GenerationForm.test.tsx modules/media/lib/preview-timing.test.ts
pnpm --filter @repo/api exec vitest run modules/media/procedures/submit-generation.test.ts modules/media/procedures/create-generation.test.ts modules/media/lib/flow-timing.test.ts
```

Add B's new context/registration tests to this list. SaaS Vitest, Next/Fumadocs
generation and browser checks run sequentially within this worktree. Verify API,
SaaS and new shared-module types after the contract is integrated. Inspect final
OpenNext artifact behavior across duplicated server bundles, not merely Node ALS mocks.

### Second integration batch: C3/C4+C5/C6

```text
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/video-v1/webhooks.test.ts src/video-v1/fulfillment.test.ts src/video-v1/output-storage.test.ts src/orchestration/executor.test.ts src/orchestration/worker-executors.test.ts
pnpm --filter @repo/api exec vitest run modules/media/lib/free-plan-credits.test.ts modules/media/lib/generation-authorization.test.ts modules/media/procedures/admission-context.test.ts modules/media/procedures/create-generation.test.ts
pnpm --filter @repo/workflows exec vitest run --project unit src/first-image-continuation.test.ts src/orchestrator.test.ts
pnpm --filter @repo/database exec vitest run --config vitest.integration.config.ts --configLoader runner prisma/queries/media/free-plan-credits.integration.test.ts prisma/queries/media/generation-admission.integration.test.ts prisma/queries/media/video-v1-execution.integration.test.ts prisma/queries/media/video-v1-fulfillment.integration.test.ts
pnpm --filter @repo/jobs exec vitest run --config vitest.config.ts src/handlers/continuation-delivery.database.integration.test.ts
```

Add D's changed runtime/store tests and C's new fault cases. DB suites use their
existing test guards, matching schema and only isolated fixtures. Safety/output
warning regression accompanies fulfillment changes; do not revive historical
released/failed jobs as part of a test fix.

### Worker integration and packaging

```text
pnpm workflows:type-check
pnpm cloudflare:jobs:build
pnpm --filter @repo/workflows test:artifact:workerd
pnpm --filter @repo/workflows test:artifact:workerd --database
pnpm cloudflare:web:build
pnpm --filter saas test:artifact:workerd
```

Run applicable workerd request-lifetime and video Workflow tests. Build only in this
worktree. OpenNext final packaging requires the repository's Linux/WSL wrapper; do
not bypass env cleanup with direct CLI. No production prepare/deploy command, cache
population, credentials or paid services are part of the gate.

A source unit test, Wrangler dry bundle, workerd artifact smoke and live deployment
are different evidence levels. If Linux/WSL final website packaging is unavailable,
report that specific gate unrun instead of substituting a Node result.

## Local environment ownership and known constraints

Plan an integration-owned PostgreSQL data directory under the task evidence root,
bound to loopback on an available high port (proposed 55442); use a separate video
instance/DB when required (proposed 55443). Recheck listener and process ownership
before startup; the ports are proposals, not reservations. Never reuse or change
another session's server, DB, bucket or .env. Keep PGOPTIONS at UTC for measurement.

Current guards are not uniform:

- Free-credit and ordinary video DB suites accept explicit disposable loopback test
  names. The video verification helper permits explicitly selected high ports and
  its two fixed disposable database names.
- `continuation-delivery.database.integration.test.ts` hard-codes port 55432.
- The existing scanless runtime driver also pins PostgreSQL 55432, MinIO 9540,
  fixture origin 9560 and dispatcher 9561.
- Final workerd artifact DB smoke has a narrower approved-port contract.

Do not disable guards to make parallel tests work. Coordinate with D before changing
its continuation test guard; otherwise reserve the canonical ports exclusively for
a serial integration interval. Any generalization must retain explicit target,
loopback, high-port and disposable-name constraints, with negative guard tests.

## 1/3/5 mixed mock acceptance plan

The existing video performance driver runs video-only 5/10/20 batches and raises
test-only capacity. It is not the required mixed workload and must not be relabeled.

Use a dedicated integration-only harness after receiving the group contracts. Reuse
actual admission/domain services, immutable ledger and native video/legacy image
paths; fixed external HTTP/storage fixtures fail on unexpected egress. Do not fake
business success by replacing claim, final transaction or recovery with no-ops.

| Simultaneous tasks | Composition                                                    | Required observation                                                                           |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1                  | One image, then one video in separate measured runs            | Single-task floors for each engine; cannot call one task itself mixed                          |
| 3                  | Two images + one video; rotate to one image + two videos       | Cross-engine progress, original attempt IDs, per-lane occupancy                                |
| 5                  | Three images + two videos; rotate to two images + three videos | Bounded contention, no capacity overshoot or starvation, one reserve/settle per completed task |

Hold source bytes, model contract selections, artificial provider/review delays,
DB initialization, process warm state and resources constant between baseline and
candidate. Record actual fixture byte size/checksum and accepted model keys; do not
compare differing model/duration/resolution configurations. Start with three paired
repetitions for each composition, alternate before/after, retain every raw value.
Use N and raw/min/median/max at small sample sizes; do not imply a stable P95.

Capture per job: admission response and task shown boundaries; commit observation
to dispatch start/finish; callback inbox commit to wake/confirm; review/transfer
and finalized stages; continuation lookup count; DB query count when tracing is
available; full/range object reads and bytes; original provider/attempt count;
ledger counts; lane/queue active/limit, busy count and accumulated wait; process RSS
and CPU. Label Node measurements as Node. Only actual workerd runs prove local
Worker execution/capacity behavior.

Inject auxiliary-query stalls/rejection, lost response, wake failure, duplicate
callbacks, account/action switch, moderation-time eligibility change, explicit
empty continuation and duplicate finalization. Run refresh/history/download UI
checks with private mocked media. Browser first frame requires a visible
requestVideoFrameCallback; loadeddata is only a separately labeled fallback, and
playing/time progression are separate playback evidence.

No production model/review calls or R2 writes are authorized. Real external metrics
remain null/unmeasured; a synthetic MP4 container cannot establish decodable video
or visual quality.

## Existing evidence assessed

- `video-v1-real-acceptance-2026-10-05.md`: historical 14 terminal tasks, 12 READY,
  one old duration-contract failure and one content rejection; multiple earlier
  releases, not baseline af4c7a33 remeasurement. Kling silent text: 180.815 s;
  image: 253.764 s; Seedance 1.5 text: 102.161 s. Review intervals include service
  and application work, so all review time is not removable internal delay.
- `evidence/video-v1/followup-performance-summary.json`: Node with real isolated
  PostgreSQL and mocked external HTTP/storage, synthetic MP4 and artificial 10 ms
  provider delay. Production/model/first-frame/upload/R2 metrics remain unmeasured.
- `evidence/video-v1/admission-optimization.json`: earlier concurrency-20 comparison
  predates post-COMMIT timing and paid-funding changes; unsuitable as this task's
  baseline comparison.
- `generation-batch1-validation-2026-09-30.md`: reusable timing methods and fixtures;
  reports individual local experiments with distinct boundaries. Do not sum their
  gains into an end-to-end production improvement.

Final delivery separates source deduction, local mock, isolated DB, local workerd
and historical real traces. State exactly which wait/query/read changed, N and
conditions, checks run or blocked, and the actual remaining gaps. No fixed speed
percentage or seconds saved is promised.

## Handoff requirements

Each group provides commit SHA, base, worktree, files, shared contract changes, exact
test commands/results and unrun items. A additionally supplies a separate small
credit-cache account-isolation commit and its real QueryClient regressions.
C additionally freezes C4's reviewContext
contract before any approved E implementation. E's current audit decision is
no-enable; the parent requires a minimal C4-dependent recheck before considering
additional implementation or online evidence collection.
Integration records ordered SHAs and resolved conflicts, then the parent routes
the complete candidate to independent Astra max review in a separate session, as
explicitly requested by the user. Only local commits are authorized.
