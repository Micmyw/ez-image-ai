# SeeAPI image verification persistence recovery

Status: local implementation and isolated verification; no production deployment or customer job replay.

## Confirmed incident

All times below are Asia/Shanghai on 2026-11-15. Read-only PostgreSQL, Cloudflare Workflow instance and retained Worker telemetry were correlated for asset `c44672be-0200-4ac0-b69f-40209fb5b604` and initial event `cmwgotb7o0001psp7ax1q8wm7`.

- 01:36:29.485: the submission fence was persisted; the subsequent authenticated SeeAPI response supplied task `task_f4989bebb22b4705b4ee0925803848fc`.
- 01:36:33.372: `moderation_result` recorded `REVIEW`, source `submission`. The accepted task identity was bound, but the subsequent PENDING transaction did not commit.
- 01:36:38.993: `job_execution_failed` logged `errorCode=P2028`, `phase=UNKNOWN`, for `media-execute-event`. The interval since `moderation_result` was about 5.45 seconds. That transaction still used Prisma's implicit five-second timeout, unlike the final-verdict transaction's explicit twenty-second budget. This is consistent with transaction expiry; retained diagnostics do not identify the particular slow SQL or distinguish lock waiting from other latency.
- 01:36:39.209: Workflow `job-a6338723830940cd53e2440614d0775c72d060bdfcb1b8e7a2b40357b13ff07a` in `ezpic-jobs-workers-production` errored with `TASK_RECOVERY_REQUIRED:media-execute-event`. Its first durable step returned `{status:"failed"}`; read-only recovery returned `eventRecoveryState:"held"`.
- 01:37:20.530: the signed callback entered the website handler. At 01:37:24.531 its receipt timestamp was stored; transaction completion at 01:37:24.850 was successful. The active verification lease caused a recorded-only wake, not an authenticated result query. Callback logs show approximately 3.65 seconds between transaction start and lock acquisition during concurrent admission, but do not establish the cause of the earlier P2028.
- 01:38:21.083: the temporary input's review deadline elapsed. This is distinct from its next-day object expiry.
- Subsequent recovery Workflows repeatedly logged `not_claimed`; the original phase owner remained leased until 01:46:26.633. Around 02:00 the database recorded lease-expired and review-deadline errors and finalized both waiting jobs.

Jobs `cmwgotktx0002psp778raa76k` and `cmwgoukw90004psp77xzutpk2` had no generation attempt. Each released its five reserved credits. A later authenticated GET returned SeeAPI success with `flagged:false`; the response has no completion timestamp, so it does not prove approval before the original deadline. The separate third job's reference had a confirmed content rejection and is not recoverable through a technical-failure bypass.

“Callback received without a saved verdict” describes two different checkpoints. The signed callback persists a notification and wakes work; it is never itself approval. An authenticated provider read and guarded verdict transaction must still succeed. Here the callback was saved, but the original polling continuation had already failed.

## Failure categories

- Executor exceptions, database errors, unavailable configuration and transport failures become failed invocations. Finite retries can end in `TASK_FAILED`; capacity waiting can end in `TASK_CAPACITY_TIMEOUT`.
- An uncertain receipt-bound effect or fused wrapper is deliberately not replayed. Read-only recovery must prove completion or produce the narrowly validated query described below; otherwise `TASK_RECOVERY_REQUIRED` remains correct.
- Invalid polling/receipt/continuation responses and incompatible receivers fail protocol validation. Future-event/lease preparation has finite time and attempt budgets.
- Cloudflare step timeouts and platform termination can interrupt otherwise valid code. A callback does not revive a failed Workflow or transfer its ownership automatically.
- A content rejection or asset review deadline is a business terminal result, not proof of a Workflow engine failure. Ownership loss is a fence, not permission for another submission.

## Local correction

1. Image PENDING commits no longer take a prompt-publication lock: they cannot publish, approve or delegate anything. Image state transactions use the same explicit twenty-second transaction budget as final verdicts, with bounded acquisition and sanitized stage/error diagnostics. Video retains its previous transaction options.
2. After a completed invocation encounters an allowlisted database/connection failure, a short database transaction may relinquish only its own live image-verification claim. It requires the same object, checksum, generation, task, policy, lease and current phase owner, an already bound SeeAPI task, no submission uncertainty, and unexpired review/object deadlines. It atomically writes a query-only Outbox intent. No approval, moderation failure waiver, credit mutation or paid replay occurs. At most three such recovery intents exist per generation, enforced through unique durable slots.
3. A fused wrapper's read-only recovery can return an existing query-only receipt when its exact owned Outbox event is `RECOVERY_REQUIRED`, the accepted image task is still valid, and no verification claim remains active. The original Workflow then queries that same task using normal lease and receipt checks. Active execution guards, other owners, expired identities, uncertain acceptance and generation submissions remain held. The read itself does not ACK or change any lease.
4. Scheduled Outbox delivery preserves `queryOnly`. A callback alone still cannot advance a job. Only the authenticated verdict atomically creates its ordinary continuation, which remains idempotent.

## Verification and rollout

The regression injects P2028 inside a real PostgreSQL transaction after provider-task binding and an early callback. Before the change it rejects the invocation; after the change the accepted task is queried once. ALLOW produces one waiting-job dispatch; REJECT quarantines the input and produces no generation dispatch. Additional PostgreSQL cases cover the three-recovery budget, stale task/lease/epoch/checksum, uncertainty, object/review expiry, and a held fused receipt through query completion and repeated delivery. Provider HTTP is a fixture; no paid provider request is made.

Focused checks cover verification submission/polling/handoff/phase ownership, Outbox delivery and parser contracts, fused/targeted Workflows and executor transport. Jobs and Workflows type checks, affected lint/format checks and diff checks are required. These are local results, not cloud end-to-end latency or deployed behavior.

Completed locally: 75 PostgreSQL integration tests, 75 jobs unit tests, 91 Workflow tests, both affected workspace type checks, affected Oxlint/Oxfmt and `git diff --check`. The expanded 28-case verification submission suite was rerun after adding receipt completion/replay assertions. The task-owned PostgreSQL 16 container and anonymous volume were removed after verification; shared development services were untouched.

No schema migration or policy flag is needed. Deploy the parser/Workflow consumers that accept a same-event query-only recovery receipt before enabling the producer in independently deployed executors (including retained hybrid Node receivers); deploy Outbox consumers preserving query-only payloads before recovery-intent producers. A single Workers artifact contains both sides, but older in-flight Workflow versions may retain their old behavior. Old consumers safely reject the new recovery response rather than replaying a paid body. Keep compatible consumers while accepted work drains.

Database outages that prevent both the normal commit and the recovery transaction still cannot be automatically declared successful. Process termination before a relinquished execution is proven, exhausted recovery budgets and expired references retain the existing durable recovery/manual-hold or terminal path. This change does not extend review deadlines, steal live claims, restart terminal customer jobs, or guarantee that infrastructure never fails. Production validation must confirm accepted-task recovery and verdict persistence on the deployed version; historical failed jobs and financial records remain unchanged.
