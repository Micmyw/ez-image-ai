# Image continuation in the existing Workflow

This change removes per-event child Workflow creation from the normal image continuation path. It does not change provider generation speed, private asset access, moderation, settlement, or the separate video engine.

## Execution path

Previously, a committed image event entered `media-deliver-events`, which dispatched a child through the Workflow binding and checked its status before another executor ran the task. Each stage repeated that creation/status round trip.

The new Workflow adapter handles exact event IDs directly:

1. A short `media-prepare-event` control invocation claims one existing eligible event through the normal PostgreSQL `SKIP LOCKED` mechanism. It returns a strict private task and an event/owner/token receipt, without creating a child Workflow.
2. The prepare invocation completes. The original Workflow invokes the task on its classified executor: ordinary verification, asynchronous submission and settlement use request-owned `ControlExecutor`; eligible URL images use streaming `TransferExecutor`. These new service paths have no global count-based admission cap. Incompatible buffered or transformed transfers retain `jobs-primary`.
3. After lane admission, the receiver checks the receipt and renews its lease for the task timeout plus 30 seconds. A 900-second finalization therefore receives a 930-second execution lease instead of relying on the initial 90-second preparation lease.
4. Durable completion ACKs that exact unexpired receipt before following the returned continuation or accepted provider polling. Moderation `PENDING` does not ACK; the same Workflow retains the receipt and renews it on each existing moderation poll.

At most four sibling events are in flight per continuation batch, so independent input/output reviews start without waiting for another review's polling to finish. This is a batch bound within one Workflow, not a shared four-user system limit. The legacy heavy Durable Object remains guarded for paths that still buffer or transform full images. A long legacy capacity wait can expire a preparation lease; the stale receipt performs no business work and does not ACK. The Workflow may prepare again using a new durable step, up to three times. Existing scheduled recovery remains the fallback.

An event already `PROCESSED` after a lost response never reruns the business handler. It reconstructs the committed continuation, including accepted-attempt polling and output-review events. Provider uncertainty, per-attempt ownership and moderation leases remain authoritative.

Finalization retries also return their actual committed event ID and persisted `availableAt` as continuation `notBefore`. The original Workflow sleeps until that due time and prepares the same event; recovery after a lost response reconstructs only the current job/version/stage/retry's committed work. This closes the stalled-retry gap when normal execution suppresses global scanning. A retry shares one `notBefore` with its continuation batch, so an exceptional batch containing both a future retry and an immediately eligible sibling waits until that retry is due. No event is dropped; ordinary single-image success does not use this delayed branch.

## Compatibility and deployment order

`outboxReceipt` is a strict private request-envelope field. Older receivers reject it rather than silently ignoring ownership. New receivers require explicit `deliveryState` responses, and prepare must explicitly return a validated task or `null`.

Deploy receipt-capable receivers before enabling the producer adapter. For Workers, the receivers and Workflow entrypoint ship in the jobs artifact; ensure the receiving Worker version and `JOBS_CONTROL` / `JOBS_TRANSFER` self-service bindings are active before directing new Workflow starts to the new adapter. Both bindings target named entrypoints in the selected profile, with request-owned Hyperdrive and Images resources. For hybrid, update and verify the private Node runtime first, then the Workflow entrypoint and service receivers. Do not send the new envelope to old container instances during a rolling release.

Keep `media-deliver-events`, `media-deliver-output-review`, scanned Outbox delivery and their completion receipts available while old Workflows drain. The explicit adapter opt-in keeps old or test adapters on their prior protocol. A rollback must retain receipt-aware receivers until accepted new Workflows and their leases have drained; disabling producers does not authorize resubmitting uncertain tasks or switching execution engines.

The signed execution envelope separately opts in to immediate polling with `supportsImmediatePolling: true`. Only these callers can receive a pending `waitSeconds: 0` / `retryImmediately: true` result. Older Kie and moderation callers retain their five-second and one-second response floors. A callback received during a successful query can trigger an immediate follow-up after lease release; moderation follow-ups require a bound, non-uncertain task and use `queryOnly`. Failed queries, active leases and future provider backoff never authorize immediate loops. The Workflow and direct-wake paths keep their finite execution budgets.

Confirmed database-conflict recovery has a separate `supportsDatabaseConflictRetry: true` capability in the signed envelope. HTTP 503 is retryable only with exactly `status`, `reason` and `phase`, a valid execution receipt and one of these two closed combinations:

- `media-finalize-generation`: nominal `OutputTransferClaimConflictError`, `reason: OUTPUT_TRANSFER_CLAIM_CONFLICT`, `phase: BEFORE_TRANSFER_LEASE`. The current output candidate exhausted confirmed rolled-back claim conflicts before obtaining its transfer fence. Earlier candidates may already be persisted and are reused.
- `media-settle-generation`: nominal `SettlementTransactionConflictError`, `reason: SETTLEMENT_TRANSACTION_CONFLICT`, `phase: TRANSACTION_ROLLED_BACK`. Only the settlement store's outer transaction boundary constructs this error after exhausting confirmed serialization/lock conflicts. The entire settlement transaction rolled back; the wrapper excludes settlement-claim work and post-commit notifications.

Error strings, matching names or `code` fields, generic database errors, other financial/Stripe tasks, generic 502/503 responses and lost transport responses never authorize this recovery. Unknown commit or connection outcomes retain recovery protection. This capability was unified before deployment; there is no deployed output-only capability to retain.

A direct callback wake hands the exact receipt to a durable continuation after either response; it does not start another direct retry loop. The Workflow uses its existing finite task-attempt budget (five finalization attempts or eight settlement attempts) without an added retry sleep. These are separate from the store's bounded transaction retries. A failed prepare can hand off the event ID because preparation cannot execute paid work. If the prepare response was lost after claiming, a new owner still waits for the existing unexpired lease; the same owner may resume only its existing receipt. No handoff steals an execution lease, invents an ACK, or starts a global scan.

The existing begin UPDATE now renews the lease and atomically writes `EXECUTION_IN_PROGRESS:<random execution UUID>` before entering the handler. Unknown receipt execution errors may replace that exact execution marker with `RECOVERY_REQUIRED`; if the failure-marker write also fails, the original in-progress guard still blocks re-entry by old or new callers. A lost begin response never calls the handler or writes a second marker. Successful ACK clears the guard in its existing update, so normal success adds no database round trip.

A prepare no-op has no execution UUID and may ACK only an event without any execution/recovery guard. Re-preparing a same-owner live event after its route becomes unavailable cannot erase an active or uncertain execution.

Only explicit `done: false` review results, the two nominal rollbacks, or the existing pre-transfer heavy reroute can clear an active execution guard while retaining its lease. Clear and failure writes match the execution UUID as well as the exact event/owner/lease token and unexpired database time; a late prior attempt cannot clear or downgrade a newer execution under the same receipt. Targeted completion also matches that execution UUID. A failed or lost clear response never emits the nominal retry protocol. A `queryOnly` review can pass only `RECOVERY_REQUIRED`, and the database also restricts the exception to a media-asset review event. Its guard is `RECOVERY_QUERY_IN_PROGRESS:<UUID>`; safe PENDING restores the original `RECOVERY_REQUIRED` hold rather than granting first-submission privilege. Neither normal execution nor query recovery may cross an in-progress guard. A subsequent claim clears these closed markers only while acquiring a new token through normal due/expiry recovery; other errors remain intact. Existing business recovery and uncertainty gates still reconcile outcomes.

New adapters also stop automatic non-query retries for unknown or transport failures. A lost response after a committed ACK cannot mark the processed event failed. Receiver diagnostics expose only whitelisted codes and phases; messages, cause contents, provider payloads, private URLs and stacks are not logged. Deploy capable service/Workers/hybrid receivers before enabling new invokers, and retain them while accepted continuation Workflows drain. Legacy callers receive their prior generic failure response and pass through the same receiver guard.

The original local 50-user v3 run contained 12 one-invocation failed transfers whose callback identities and stranded leases were verified from saved logs and PostgreSQL snapshots. Their receiver logs omitted the actual errors, so all 12 underlying causes remain unknown. The new nominal-error path is a bounded recovery contract, not retrospective proof that those failures were claim conflicts.

This receipt protocol itself requires no schema migration, provider request format or ledger change. The subsequent [one-second-budget implementation](./generation-one-second-budget-2026-10-22.md) adds a nullable callback-wake field, private owner storage fences and opt-in durable job notifications; follow its migrations, receiver-first rollout and two-phase isolation requirements when deploying the combined changes.

## V2 phase ownership and callback recovery

Persisted `executionVersion: 2` image Workflows fuse control preparation and receipt-bound execution through `media-execute-event`. Classified transfer/heavy children still return their exact receipt to the parent. Old Workflow parameters retain their original step names. An unknown wrapper response can recover committed state only; it does not replay a paid handler.

Apply `20261022022231_image_workflow_phase_owner` before deploying owner-aware consumers. The private row binds an asset/review generation or provider attempt to its real Workflow ID, phase key and epoch. Callbacks persist wake evidence before signaling `/internal/phase-wake`; legacy callers cannot bypass a live owner. Expired owners cannot authorize new calls, while late accepted provider identities remain stored for query-only recovery.

The generic provider-webhook recovery path distinguishes held work from completion. A live owner, active processing lease or lost claim defers the same Outbox event for its remaining wait without ACK or consuming failure attempts. After successful inline recovery and ACK, the response carries bounded `continuations[]`. The parent Workflow consumes them after releasing maintenance resources, including results from the final scan. Each entry retains its own due time, provider attempt and phase owner. Empty batches, failed ACKs and unknown outcomes do not create successful continuations.

Deploy compatible Node/Workers response transports and Workflow consumers before enabling those inline producers. Keep the old singular continuation step identity while accepted old Workflows drain. Older consumers may fall back to durable recovery; that is not immediate continuation or one-second latency evidence.

## Local verification

Focused checks cover strict preparation/result serialization on Workers and Node, original-Workflow stage execution and cached replay, pending moderation, stale receipt recovery, 900-second lease renewal, concurrent scan/target ownership and exactly-once receipt completion. PostgreSQL tests also discard a successful response after ACK and verify that replay calls the simulated paid handler only once.

The local workerd check runs actual Workflow checkpoints and durable waits with executor results supplied as fixtures. PostgreSQL tests run against an isolated loopback test database. These verify runtime and ownership behavior, not production latency or live supplier acceptance. The full scanless runtime benchmark and deployed timings must be reported separately; a reduced Workflow/RPC count is not a measured end-user time reduction.

```powershell
pnpm --filter @repo/jobs exec vitest run src/handlers/targeted-event-delivery.test.ts src/orchestration/registry.test.ts src/orchestration/worker-executors.test.ts
pnpm --filter @repo/workflows exec vitest run --project unit src/targeted-events.test.ts src/orchestrator.test.ts src/execution.test.ts src/dispatch.test.ts
pnpm --filter @repo/jobs-runtime exec vitest run src/server.test.ts
pnpm --filter @repo/workflows exec vitest run --project workerd src/workflow.workerd.test.ts
pnpm --filter @repo/workflows exec vitest run --project worker-executor src/executor.workerd.test.ts
```

With an explicitly isolated local `TEST_DATABASE_URL` (and without pointing `DATABASE_URL` at that same value for the database guard):

```powershell
pnpm --filter @repo/database exec vitest run prisma/queries/media/outbox.test.ts --configLoader runner
pnpm --filter @repo/database exec vitest run prisma/queries/media/outbox.integration.test.ts --config vitest.integration.config.ts --configLoader runner
pnpm --filter @repo/jobs exec vitest run src/handlers/continuation-delivery.database.integration.test.ts --config vitest.config.ts
```
