# Account INPUT verified copy implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Registered users retain eligible pre-generation INPUTs in fresh verified account objects without relying on old guest delete I/O drain.

**Architecture:** A versioned Outbox intent binds source, draft, owner and one immutable destination. Database-only claims enqueue copy; a worker performs conditional verified storage copy outside transactions, then materializes VERIFYING media and standard moderation. Owner-scoped polling exposes READY only after current asset evidence. Terminal tombstones and durable orphan recovery isolate late writers.

**Tech stack:** TypeScript, Prisma transaction contracts, PostgreSQL, existing S3/R2 immutable promotion, Vitest, React Query.

**Spec:** `docs/superpowers/specs/2026-10-19-account-input-copy-design.md`

## Global constraints

- No production writes, paid calls, schema migration, push, merge or deployment in this task.
- Old ACCOUNT_INPUT_PROMOTION_ENABLED stays ineffective; new ACCOUNT_INPUT_COPY_ENABLED defaults off.
- Never hold DB transactions across storage I/O; never trust client keys or copy unverified input into usable state.
- Preserve guest RESULT grants, watermark/expiry, credits, prices and moderation. Reuse effective paid storage quota and owner locks.
- Missing official generated Prisma must be reported, never fabricated or downloaded around network policy.

## Review focus

- A response lost after physical copy resumes the exact immutable destination.
- A stale worker cannot commit or clear a current lease's MPU.
- Terminal cleanup and late write cannot resurrect a target or delete a committed account input.
- All draft replays and editor recovery wait; no implicit text-only fallback.
- Free quota, actual file size and paid unlimited follow existing storage policy and reservation accounting.

### Task 1: Durable database intent and claim integration

Files: new database `queries/media/account-input-copy.ts` and tests; drafts/account-input-promotion/barrel.

- [x] Add failing contract tests for exclusive owner claim, source identity, quota, duplicate intent, lease fencing, materialization, terminal/orphan and READY evidence.
- [x] Implement createAccountInputCopyInTransaction, claim/register/commit/fail/status/recovery helpers using Outbox JSON and existing asset/reservation rows.
- [x] Connect registered claim and registered guest-link DRAFT transfer; all replays/getClaimed return preparation while pending.
- [x] Run meaningful mock and real PostgreSQL query-port regression; existing assets and source cleanup remain unchanged.

### Task 2: Worker and recovery

Files: new jobs handler/tests; runtime wiring; registry/executor/lanes/outbox delivery; storage adapter/tests where needed.

- [x] Add failing mock tests for default multipart+mandatory SHA, existing target, lost commit, stale lease, late writes and orphan cleanup.
- [x] Implement handler against Task 1 interfaces, conditional full-byte verification and durable MPU registration.
- [x] Route copy heavy through completion-before-ACK dispatch; orphan/recovery maintenance; guard copy target terminal/reverify lifecycle.
- [x] Run targeted tests and feasible isolated storage simulation, registering added integration suites.

### Task 3: Owner-scoped polling and editor preparation

Files: new API status procedure/test/router; claim/link contracts; RegisteredEditor and new waiting component/tests.

- [x] Add failing tests for owner scope, pending/review/ready/error, refresh recovery and no generation while waiting.
- [x] Expose only status/promotionId/reason, retaining prompt/settings server-side; existing RESULT response unchanged.
- [x] Render explicit preparation/recheck state, refresh editor only when READY, never use original guest key or fall back to text generation.
- [x] Read Next local docs before UI edits; run focused API/UI tests.

### Task 4: Review and deliver

- [x] Run scoped formatting/lint/type diagnostics, focused suites and real query-port concurrency where possible.
- [x] Cross-review the DB helper and worker/API boundaries; fix concrete findings and rerun affected checks. Parent final complete-patch review remains required before release.
- [x] Prepare isolated commit and validation report; final handoff records exact SHA, tested boundaries, missing genuine ORM/storage/platform evidence and closed flags.
