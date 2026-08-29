# Anonymous Standard Residual Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three residual load-bearing anonymous Standard trial defects: preserve linked waiting work through the final Provider fence, erase expired trial-held HMAC evidence without deleting immutable business facts, and enforce the complete promotion-aware production abuse/capacity envelope.

**Architecture:** Keep PostgreSQL as the only business source of truth and reuse the existing `GuestMediaTrial`, link/grant, jobs runtime, retention sweeper, `GuestAbuseBucket`, and risk-budget paths. Serialize linking and dispatch with the existing owner-promotion advisory lock and trial row lock; retain audit/business rows while nulling expired HMAC evidence; divide rate evidence into promotion-scoped subject limits and intentionally cross-promotion global capacity limits.

**Tech Stack:** TypeScript, Node.js, Prisma/PostgreSQL, Vitest, Next.js monorepo packages, pnpm/Turbo.

**Spec:** `docs/superpowers/specs/2026-08-27-anonymous-standard-raphael-experience-design.md`

## Global Constraints

- Base the repair on `fbd7874f499c51fd6a90ebc5e031962a367da87c` in the existing isolated worktree and branch `codex/anonymous-standard-trial`.
- Keep production guest generation disabled. Do not push, merge, deploy, enable production, or call a real Provider, Turnstile, Stripe, Trigger.dev, mail, or cloud-storage service.
- Preserve anonymous `ownerType="USER"`, job/Attempt/Outbox, private storage, moderation, quote, four-credit sponsorship, reservation, immutable ledger, and registered Quote -> Confirm, History, Edit Again, recovery, billing, and navigation behavior.
- One guest trial remains `image-fast`, Standard Edit, one input, one prompt, one output, four sponsor credits, one in-flight job, at most one external Attempt, and at most one pre-Provider replacement.
- Never transfer the guest Job, sponsor credits, history, or Edit Again rights to the registered account. Account linking creates only an expiry-bounded `GuestResultAccessGrant`.
- Preserve private owner/grant-scoped result access and short-lived signed URLs. Never expose source URLs, object keys, Provider/model/raw cost, or a public bucket.
- Amend only `packages/database/prisma/migrations/20260827232400_anonymous_standard_trial/migration.sql`; it is not deployed. Do not add a second migration, shadow schema, limiter, queue, state store, cleanup system, or direct Provider path.
- Every production behavior change requires a test-only RED checkpoint against the prior task HEAD, followed by the smallest GREEN implementation and focused rerun. Tests must exercise real PostgreSQL behavior, not source-text assertions or mocks of the database path.
- Database work may use only the proven dual-isolated Docker environment (`LOCALAPPDATA=D:\D6\e2\L`, `APPDATA=D:\D6\e2\R`) after the complete fail-closed preflight documented in `.superpowers/sdd/2026-08-27-anonymous-standard-raphael-experience/cross-task-visual-e2e-report.md`. Never start Docker normally.
- Each task owns one exact disposable loopback database and all processes it starts. It must drop only that database, preserve `ezpic` and `ezpic_testing`, stop its exact process tree, and prove WSL/task ports closed before reporting.
- Do not hand-edit generated Prisma Client or `packages/database/prisma/zod/index.ts`; run the repository generator after schema changes.
- Run `pnpm format`, `pnpm lint`, focused tests, forced type-check, and relevant standard loaders before each task commit. Record external/live/publish gates separately as `NOT_COMPLETED`.

---

### Task 1: Preserve linked waiting work through the final Provider fence

**Files:**

- Modify: `packages/jobs/src/runtime.ts`
- Modify: `packages/jobs/src/handlers/runtime-stores.database.integration.test.ts`
- Modify: `packages/database/prisma/queries/media/guest-link.integration.test.ts`
- Inspect without broad refactor: `packages/database/prisma/queries/media/guest-link.ts`
- Include controller-authored plan in commit: `docs/superpowers/plans/2026-08-29-anonymous-standard-residual-safety-fixes.md`

**Interfaces:**

- Consumes: `completeGuestLinkIntentTransaction`, `createDatabaseDispatchStore`, `guestDispatchChecksPass`, `expireGuestJobBeforeProvider`, the existing `guest-owner-promotion:<ownerId>:<promotionPeriod>` advisory lock, `GuestMediaTrial.currentJobId`, and `GuestMediaTrial.consumedJobId`.
- Produces: a final dispatch fence that treats linking as an access transition rather than job cancellation, plus real link/dispatch race coverage that later tasks must keep green.

- [ ] **Step 1: Add a failing link-before-final-dispatch integration test**

  Build a real waiting guest trial and job with zero Attempts, complete its link intent into a registered result grant, then call the real database dispatch store through the final pre-Provider transaction. Assert the dispatch reservation succeeds, the job is not `EXPIRED`, the trial advances from `currentJobId` to `consumedJobId`, `providerBoundaryAt` is set, and exactly one Attempt exists.

  The central assertion must exercise the real store, in this shape:

```ts
const linked = await completeGuestLinkIntentTransaction(linkInput, database);
expect(linked).toMatchObject({ mode: "RESULT", jobId: guestJobId });

const claim = await dispatchStore.claimDispatch({ jobId: guestJobId, version: 0 });
expect(claim).not.toBeNull();
expect(claim?.jobId).toBe(guestJobId);

const persisted = await database.generationJob.findUniqueOrThrow({
	where: { id: guestJobId },
	include: { attempts: true, guestTrial: true },
});
expect(persisted.status).not.toBe("EXPIRED");
expect(persisted.attempts).toHaveLength(1);
expect(persisted.guestTrial?.currentJobId).toBeNull();
expect(persisted.guestTrial?.consumedJobId).toBe(guestJobId);
```

- [ ] **Step 2: Add failing dispatch-before-link and concurrency tests**

  Cover these independent orderings with real transactions:

```ts
test.each(["dispatch-then-link", "link-then-dispatch", "concurrent"])(
	"%s preserves one canonical guest job and one Attempt",
	async (ordering) => {
		// Arrange one real trial/job, execute the named ordering, then reload all rows.
		expect(job.status).not.toBe("EXPIRED");
		expect(job.attempts).toHaveLength(1);
		expect(grant.guestJobId).toBe(job.id);
		expect(trial.consumedJobId).toBe(job.id);
	},
);
```

Also prove replay returns the same grant, an expired trial cannot dispatch or link, the registered user receives no sponsor CreditAccount/Lot/Ledger rows, and the guest job owner remains the anonymous user.

- [ ] **Step 3: Run the focused tests and retain the expected RED output**

  Use the exact database `ezpic_residual_link_20260829_test` on loopback port 55432. Run the two named integration files sequentially. The new link-before-dispatch and concurrency cases must fail because `guestDispatchChecksPass` returns false and `expireGuestJobBeforeProvider` expires the job; fixture, migration, TypeScript, or connection errors are not an acceptable RED checkpoint.

- [ ] **Step 4: Remove only link-state cancellation from the final Provider fence**

  In `guestDispatchChecksPass`, retain every job/trial/owner/price/risk/expiry/queue/runtime/Attempt invariant, but remove `trial.linkedAt !== null` and `trial.linkIntents.some((intent) => intent.state !== "NONE")` from the rejection predicate. Do not transfer ownership or credits and do not weaken the `currentJobId === job.id`, `consumedJobId === null`, `providerBoundaryAt === null`, `riskState === "HELD"`, exact expiry, or zero-Attempt checks.

  The final predicate must retain this form:

```ts
if (
	job.serviceClass !== "GUEST_SLOW" ||
	job.status !== "DISPATCH_QUEUED" ||
	job.productKey !== "image-fast" ||
	job.guestTrialId !== trial.id ||
	job.ownerId !== trial.ownerId ||
	trial.currentJobId !== job.id ||
	trial.consumedJobId !== null ||
	trial.providerBoundaryAt !== null ||
	trial.expiresAt <= now
) {
	return false;
}
```

Both link completion and dispatch already take the owner-promotion advisory lock; preserve that shared serialization and existing trial row lock ordering.

- [ ] **Step 5: Run focused GREEN and mutation checks**

  Re-run both files sequentially. Then temporarily restore either rejected link-state condition and prove the new link-before-dispatch test fails; restore the implementation and prove GREEN again. Record both outputs in `task-1-report.md`.

- [ ] **Step 6: Run task gates, clean resources, and commit**

  Run jobs/database focused suites, `pnpm test:unit:contracts`, `pnpm test:integration`, `pnpm format`, `pnpm lint`, and `pnpm type-check --force` with the safe task database. Drop only `ezpic_residual_link_20260829_test`, preserve protected databases, stop the exact isolated Docker/forwarder tree, and verify task ports and WSL stopped. Commit the plan, tests, and implementation as `fix: preserve linked guest dispatch`.

---

### Task 2: Expiry-bound and erase trial-held HMAC evidence

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/prisma/migrations/20260827232400_anonymous_standard_trial/migration.sql`
- Regenerate: `packages/database/prisma/zod/index.ts`
- Modify: `packages/database/prisma/queries/media/guest-admission.ts`
- Modify: `packages/database/prisma/queries/media/guest-retention.ts`
- Modify: `packages/api/modules/media/lib/guest-admission.ts`
- Modify: `packages/database/prisma/queries/media/anonymous-standard-schema.integration.test.ts`
- Modify: `packages/database/prisma/queries/media/guest-retention.integration.test.ts`
- Modify as required by the new required expiry: direct `GuestMediaTrial` fixture builders in the standard integration loader, including Task 1's link/dispatch fixtures

**Interfaces:**

- Consumes: Task 1's unchanged job ownership/link behavior, `CreateGuestGenerationTransactionInput.abuseEvidenceTtlMs`, the scheduled `expireGuestMedia` retention transaction, and `GuestMediaTrial` as retained business/audit evidence.
- Produces: nullable trial HMAC fields, immutable per-trial evidence expiry, auditable scrub timestamp, and idempotent PostgreSQL cleanup that Task 3 must preserve while changing admission scopes.

- [ ] **Step 1: Write failing schema and lifecycle tests before editing Schema or migration**

  Add schema assertions for nullable `sourceSessionHash`, `deviceHash`, `ipHash`, `subnetHash`, and `idempotencyFingerprint`, required `abuseEvidenceExpiresAt`, nullable `abuseEvidenceDeletedAt`, and the existing owner `ON DELETE SET NULL` action.

  Add real lifecycle fixtures for:

```ts
const cases = [
	"bootstrap-only anonymous principal",
	"admitted waiting trial",
	"consumed terminal trial with Attempt and credit ledger",
	"linked trial with expired result grant",
	"not-yet-due anonymous trial",
	"registered user",
] as const;
```

For due anonymous trials, assert all five HMAC fields become `null`, `abuseEvidenceDeletedAt` equals the sweep time, expired sessions/buckets are removed, and retained Trial/Job/Attempt/Reservation/Ledger/Outbox rows still exist. A bootstrap-only principal has no Trial HMAC row; use it only to prove bootstrap/session/bucket/user cleanup. Use not-yet-due evidence for the registered-user control so the test proves the registered User remains without incorrectly requiring globally expired abuse buckets to survive.

- [ ] **Step 2: Add replay and concurrent-sweeper RED tests**

  Run the same sweep twice and concurrently. Both paths must converge to one scrub timestamp, no remaining HMAC values, no duplicate cleanup event, and preserved immutable business rows. The test must fail on the current non-null Schema/cleanup behavior, not on fixture setup.

- [ ] **Step 3: Run the focused tests and retain the expected RED output**

  Use exact database `ezpic_residual_hmac_20260829_test`. Apply the current 36 migrations before modifying production/schema files, then run the schema and retention files sequentially. Expected failures are non-null HMAC columns after cleanup and missing evidence expiry/scrub timestamps.

- [ ] **Step 4: Amend the single not-deployed migration and Prisma model**

  Change the five fields to nullable and add two timestamps:

  ```prisma
  sourceSessionHash       String?
  deviceHash              String?
  ipHash                  String?
  subnetHash              String?
  idempotencyFingerprint  String?   @unique
  abuseEvidenceExpiresAt  DateTime  @db.Timestamptz(3)
  abuseEvidenceDeletedAt  DateTime? @db.Timestamptz(3)

  @@index([abuseEvidenceDeletedAt, abuseEvidenceExpiresAt])
  ```

  Keep the existing compound unique constraints; PostgreSQL permits multiple `NULL` values while active non-null trials remain unique. Edit the existing `CREATE TABLE "guest_media_trial"` definition in `20260827232400_anonymous_standard_trial/migration.sql`; do not add a migration. Regenerate tracked Prisma Zod output using the repository generator.

- [ ] **Step 5: Require and persist immutable evidence expiry at admission**

  Make `abuseEvidenceTtlMs` required in both `CreateGuestGenerationTransactionInput` and the API-side `GuestAdmissionConfig`. The capability/config path already supplies a concrete value; do not add a database or API fallback that could silently retain evidence for a different period. When `GuestMediaTrial` is created, set:

  ```ts
  abuseEvidenceExpiresAt: new Date(input.now.getTime() + input.abuseEvidenceTtlMs),
  abuseEvidenceDeletedAt: null,
  ```

  Keep the original non-null hashes for the active promotion window. Do not derive expiry from current configuration during cleanup, because later config changes must not retroactively extend old evidence. Production's exact 30-day validation remains Task 3, but every Task 2 caller and direct fixture must provide an explicit positive TTL.

- [ ] **Step 6: Scrub a bounded evidence batch atomically before anonymous-user deletion**

  In the existing retention transaction, after deleting due link/bootstrap/session/bucket rows and before deleting eligible Users, select no more than `input.limit` due unsanitized Trial IDs with `FOR UPDATE SKIP LOCKED`, ordered by evidence expiry and ID. Update only that selected batch:

```ts
const dueTrialIds = await selectDueEvidenceTrialIdsWithSkipLocked(tx, {
	now: input.now,
	limit: input.limit,
});
await tx.guestMediaTrial.updateMany({
	where: {
		id: { in: dueTrialIds },
		abuseEvidenceDeletedAt: null,
	},
	data: {
		sourceSessionHash: null,
		deviceHash: null,
		ipHash: null,
		subnetHash: null,
		idempotencyFingerprint: null,
		abuseEvidenceDeletedAt: input.now,
	},
});
```

Preserve promotion period, pricing/risk totals, Trial/Job/Attempt/Reservation/Ledger/Outbox facts, and result deletion evidence. The bounded selection plus the new index must prevent an unbounded sweep and allow concurrent sweepers to claim disjoint batches. Active lookup/link/admission paths must reject expired trials before depending on nullable hashes; add explicit null guards only where TypeScript or an active-path invariant requires them.

- [ ] **Step 7: Run GREEN, migration, and mutation verification**

  Recreate the exact task database from empty, apply all 36 migrations, run Prisma validate/status/drift, regenerate clients, then run the schema and lifecycle tests sequentially. Temporarily omit one scrubbed field in the update and prove its matching lifecycle assertion fails; restore and rerun GREEN.

- [ ] **Step 8: Run task gates, clean resources, and commit**

  Run standard unit/contracts and integration loaders, `pnpm format`, `pnpm lint`, forced type-check, and forced root tests against the task database. Drop only `ezpic_residual_hmac_20260829_test`, preserve protected databases, stop the exact runtime tree, and prove ports/WSL/settings clean. Commit as `fix: expire guest abuse evidence`.

---

### Task 3: Enforce the complete promotion-aware production abuse and capacity envelope

**Files:**

- Modify: `packages/config/guest-media.ts`
- Modify: `packages/config/guest-media.test.ts`
- Modify: `packages/api/modules/media/lib/guest-admission.ts`
- Modify: `packages/api/modules/media/lib/guest-capability.test.ts`
- Modify: `packages/api/modules/media/procedures/create-guest-upload-intent.ts`
- Modify: `packages/database/prisma/queries/media/guest-admission.ts`
- Modify: `packages/database/prisma/queries/media/guest-bootstrap.ts`
- Modify: `packages/database/prisma/queries/media/guest-admission.integration.test.ts`
- Modify: `packages/database/prisma/queries/media/guest-bootstrap.integration.test.ts`
- Modify only as needed to keep standard loaders exhaustive: `tests/load/run-unit-contracts.ts`, `tests/load/run-integration.ts`

**Interfaces:**

- Consumes: Task 2's nullable trial evidence fields and immutable `abuseEvidenceExpiresAt`, `GuestAdmissionLimits`, `incrementGuestBucket`, existing trial/risk/queue locks, and existing zero-business-graph transaction rollback.
- Produces: fail-closed production ceiling validation, explicit risk/evidence configuration, promotion-scoped subject buckets, intentionally global capacity buckets, and full N/N+1/concurrency/zero-side-effect coverage.

- [ ] **Step 1: Add production-envelope RED tests with literal boundary values**

  Build one complete valid production environment with every required value explicit, including `GUEST_RISK_BUDGET_MICROS=350000`, `GUEST_QUEUE_TTL_SECONDS=600`, `GUEST_QUEUE_MAX_DEPTH=25`, and `GUEST_ABUSE_EVIDENCE_TTL_DAYS=30`.

  Assert these mutations disable guest media with `GUEST_CONFIGURATION_INVALID`. Cover every frozen ceiling, including session active/accepted, device active/accepted, IP active, outstanding bootstraps, temporary principals, and risk budget. At minimum include:

```ts
const invalid = [
	["GUEST_RISK_BUDGET_MICROS", undefined],
	["GUEST_RISK_BUDGET_MICROS", "350001"],
	["GUEST_QUEUE_TTL_SECONDS", "601"],
	["GUEST_QUEUE_MAX_DEPTH", "26"],
	["GUEST_ABUSE_EVIDENCE_TTL_DAYS", "29"],
	["GUEST_ABUSE_EVIDENCE_TTL_DAYS", "31"],
	["GUEST_IP_MAX_PER_10_MINUTES", "2"],
	["GUEST_IP_MAX_PER_24_HOURS", "4"],
	["GUEST_SUBNET_MAX_PER_24_HOURS", "21"],
	["GUEST_GLOBAL_MAX_PER_MINUTE", "4"],
	["GUEST_GLOBAL_MAX_PER_HOUR", "31"],
	["GUEST_GLOBAL_MAX_PER_24_HOURS", "101"],
] as const;
```

Positive values below a request/capacity ceiling remain valid and intentionally stricter. Queue TTL/depth must be positive and no greater than 600/25. The launch evidence policy is exactly 30 days until the privacy disclosure and spec are deliberately revised together. The risk configuration test covers the hard `350000`/`350001` ceiling; runtime risk behavior remains the existing 75%-slow and 90%-close policy, not an artificial request-count N/N+1 test.

- [ ] **Step 2: Add promotion-scope and global-scope RED tests**

  Saturate the IP/subnet/upload/bootstrap subject bucket for promotion A and prove the same subject is accepted in promotion B. Separately saturate each boundary's intentionally cross-promotion global minute/hour/day scope and prove promotion B is still rejected by that boundary's global capacity. Upload must pass `promotionPeriod` from the API into its database transaction. Assert stored scope names follow these exact categories:

  ```ts
  `guest-generate:${promotionPeriod}:ip:ten-minute`;
  `guest-generate:${promotionPeriod}:ip:day`;
  `guest-generate:${promotionPeriod}:subnet:day`;
  `guest-upload:${promotionPeriod}:ip:ten-minute`;
  `guest-bootstrap:${promotionPeriod}:ip:ten-minute`;
  ("guest-generate:global:minute");
  ("guest-generate:global:hour");
  ("guest-generate:global:day");
  ("guest-upload:global:minute");
  ("guest-upload:global:hour");
  ("guest-upload:global:day");
  ("guest-bootstrap:global:minute");
  ("guest-bootstrap:global:hour");
  ("guest-bootstrap:global:day");
  ```

  These global capacity buckets are separate per boundary so one normal upload -> bootstrap -> generate flow does not consume the complete three-per-minute generation allowance. `guest-turnstile-token` remains intentionally global and promotion-independent for one-time-token replay protection. Session/device accepted and active checks remain promotion-scoped relational queries; do not create parallel buckets for them.

- [ ] **Step 3: Add complete table-driven N/N+1 and concurrency RED coverage**

  Exercise every frozen runtime dimension with hand-checked literal limits: session active 1, session accepted 1, device active 1, device accepted per promotion 1, IP active 2, IP ten-minute 1, IP day 3, subnet day 20, global minute 3, global hour 30, global day 100, queue depth 25, queue age 600 seconds, outstanding bootstraps 25, and temporary principals 100.

  For each dimension:

```ts
expect(await admitExactly(limit)).toHaveLength(limit);
await expect(admitOneMore()).rejects.toThrow(expectedReason);
expect(await countBusinessGraphRows()).toEqual({
	trials: limit,
	quotes: limit,
	accounts: limit,
	lots: limit,
	ledgers: limit,
	reservations: limit,
	jobs: limit,
	outbox: limit,
	attempts: 0,
});
```

The generic graph-count assertion applies to generation admission only; upload/bootstrap use boundary-specific row and signed-upload side-effect snapshots. Queue age and depth need separate fixtures: with the real API's one-slot/60-second estimate, depth 10 reaches 600 seconds and depth 11 is rejected by age first, while the depth-25 fence must be isolated with controlled queue capacity or preseeded rows. The one-trial invariant can make owner-active and device-active reason codes unreachable first; verify the composite production invariant and use safe targeted overrides only where a dimension can be reached without constructing an invalid graph.

Add concurrent `Promise.allSettled` variants using small override limits of 1 or 2 so exactly N requests succeed and the rest deterministically reject. Rejection must create no partial Trial/Quote/CreditAccount/Lot/Ledger/Reservation/Job/Outbox/Attempt and invoke no Provider boundary. Replayed denials must increment the durable denial counter once for generation, whose stable idempotency fingerprint defines replay; do not invent denial identity for upload/bootstrap.

Also cover two concurrency defects directly: the total-temporary-principal and outstanding-bootstrap caps require one cross-promotion global advisory lock, and concurrent admissions sharing one `promotionPeriod + sourceSessionHash` require a matching lock or stable error mapping so exactly one graph wins without exposing a raw unique-constraint error.

- [ ] **Step 4: Run focused RED and verify failures are behavioral**

  Use exact database `ezpic_residual_limits_20260829_test`. Expected failures are accepted TTL 601/depth 26/missing risk budget, promotion B denied by promotion A's subject buckets, or a dimension exceeding N. Fixture collisions, timeout, shared-schema deadlocks, or missing environment values are not acceptable RED evidence.

- [ ] **Step 5: Enforce explicit production ceilings**

  Make production require `GUEST_RISK_BUDGET_MICROS` and validate all configured limits against the frozen ceilings. Reuse the existing `GUEST_CONFIGURATION_INVALID` boundary; do not reveal which internal limit failed publicly. Keep development/test defaults for deterministic local tests, but never allow a production fallback for risk budget or a value above a ceiling.

- [ ] **Step 6: Split promotion-scoped subject evidence from global capacity evidence**

  Thread `promotionPeriod` through generation, upload, and bootstrap boundary inputs. Use promotion-qualified scopes for IP/subnet subject evidence at each boundary. Keep each boundary's global minute/hour/day scopes intentionally cross-promotion, while keeping the Turnstile token scope global as a replay fence. Session/device evidence stays in existing promotion-qualified relational queries. Continue storing expiry in the existing `GuestAbuseBucket`; do not add a table or limiter.

- [ ] **Step 7: Preserve transactional rejection and immutable evidence expiry**

  Keep advisory locks and bucket increments inside the existing admission transaction before Trial/Quote/Credit creation. Use a global lock for global temporary-principal/bootstrap caps and a promotion/session-hash lock for accepted-session concurrency. Preserve Task 2's required `abuseEvidenceTtlMs`, `abuseEvidenceExpiresAt = now + abuseEvidenceTtlMs` write, and nullable evidence lifecycle. Queue depth/age, risk, and all rate checks must reject before a business graph or external Attempt exists.

- [ ] **Step 8: Run GREEN, mutation checks, and complete task gates**

  Re-run config, admission, bootstrap, upload, standard loaders, migration validation, format, lint, forced type-check, and forced root tests. Mutate one ceiling comparison from `>` to `>=` and one promotion-qualified scope back to the old static scope; prove the exact boundary and promotion-isolation tests fail, then restore and rerun GREEN.

- [ ] **Step 9: Clean resources and commit**

  Drop only `ezpic_residual_limits_20260829_test`, preserve `ezpic` and `ezpic_testing`, stop the exact isolated runtime tree, and verify Docker/WSL/task ports/settings. Commit as `fix: enforce guest admission ceilings`.

---

## Whole-wave verification after all three task reviews

- Freeze and independently review `fbd7874..HEAD` with every task report, RED/GREEN evidence, migration lifecycle, and deferred finding.
- On a fresh exact database `ezpic_residual_final_20260829_test`, apply all migrations and run standard unit/contracts, integration, forced root tests, forced type-check, format-check, lint, build, default built-route originality, and the complete production-build SaaS Playwright project matrix (`guest`, `funded`, `empty`, `free`).
- Use only local deterministic adapters and fixtures; real Provider, Turnstile, cloud storage, deployment, production enablement, public-live verification, push, PR, merge, and remote CI remain `NOT_COMPLETED` unless separately authorized and actually executed.
- Remove the exact final verification database, test-owned MinIO objects, processes, WSL activity, and task ports. Preserve protected databases and user-owned data.
