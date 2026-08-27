# Anonymous Standard Trial Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor upload one image, submit one real Standard Edit, and view or download one temporary watermarked result without signing up, while preserving EzPic's existing owner-scoped credits, jobs, moderation, storage, and Provider safety paths.

**Architecture:** Better Auth creates an invisible anonymous `USER` principal only from a consumed marketing-draft bootstrap. Public upload and handoff endpoints promote one private image into that owner, and a dedicated guest media boundary atomically creates a four-credit sponsor grant, quote, reservation, `GUEST_SLOW` job, and delayed Outbox event. The existing dispatch and finalization pipeline is extended with one-attempt guest fencing, deterministic EzPic watermarking, absolute retention deadlines, and owner/grant-scoped result access; registered traffic remains on the current immediate path.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Better Auth 1.6, Hono/oRPC, Prisma/PostgreSQL, Trigger.dev, private S3-compatible storage, Sharp, Zod 4, Vitest, Playwright, next-intl.

**Spec:** `docs/superpowers/specs/2026-08-27-anonymous-standard-raphael-experience-design.md`

## Global Constraints

- Production guest generation stays disabled by default. Do not enable it, deploy it, call a real Provider, or describe mocks as live evidence in this plan.
- Anonymous Better Auth users keep `ownerType="USER"`; do not add a shared guest owner, public bucket, parallel balance, direct Provider call, or alternate moderation path.
- `protectedProcedure`, `adminProcedure`, the authenticated layout, and Better Auth's wildcard route must deny anonymous sessions except for an exact, intent-backed allowlist.
- One launch trial means `productKey="image-fast"`, one input, one prompt, one output, a four-credit sponsor grant, one in-flight job, and at most one external Provider Attempt.
- `GUEST_SLOW` work uses a persistent low-priority admission event and a capacity-derived estimate. Do not add an artificial 50-second wait or an exact completion promise.
- A pre-Provider failure may create at most one replacement job under the same trial. Once any Attempt exists, the trial is consumed, reservation/risk stays conservative, and guest retry/failover is forbidden.
- Guest input, staging, failed-transform, and final objects receive immutable absolute deletion deadlines at creation. Authorization expires no later than 24 hours even if physical cleanup is delayed.
- A guest may access only the transformed EzPic-watermarked private result through short-lived signed URLs. Clean staging must be deleted before the final asset can become `READY`.
- Account linking uses a durable `GuestLinkIntent` fence and creates only an expiry-bounded `GuestResultAccessGrant`; it never transfers sponsor credits, guest history, or Edit Again rights.
- Public UI and built artifacts may contain no Raphael name, asset, hotlink, Provider/model identifier, raw cost, unlimited claim, unsupported ratio control, or commercial-rights claim.
- Preserve all current registered Quote -> Confirm behavior, idempotency, History, Edit Again, private storage, moderation, recovery, billing, and authenticated navigation.
- Every behavior change follows a recorded RED -> GREEN cycle. Provider, Turnstile, and storage tests use deterministic fakes or task-owned local services only.
- Preserve the user's unrelated deleted/untracked files in the original checkout. Stage only task-owned files from the isolated implementation worktree.

## File and Interface Map

| Area                                           | Owned by task | Stable interface produced                                                                                 |
| ---------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| Schema, configuration, auth boundaries         | Task 1        | anonymous-aware Prisma models, `GuestMediaConfig`, registered/guest procedure guards, auth-route policy   |
| Signed upload and cross-origin handoff         | Task 2        | `GuestCapabilitySnapshot`, upload intent/completion endpoints, single-use draft bootstrap                 |
| Trial admission and account link fence         | Task 3        | `submitGuestGeneration`, `GuestJobSnapshot`, atomic trial/grant/job transaction, result grant             |
| Queue, dispatch, watermark, retention          | Task 4        | guest admission event, one-attempt dispatch fence, watermarked finalizer, absolute-expiry sweeper         |
| Marketing, `/try`, and registered workspace UI | Task 5        | responsive EzPic generator, guest state machine, safe conversion actions, registered layout refresh       |
| Operations, documentation, E2E, release gate   | Task 6        | diagnostics, privacy/runbook, originality scan, browser/regression evidence, production-off certification |

---

### Task 1: Additive schema, guest configuration, and anonymous permission boundary

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260827_anonymous_standard_trial/migration.sql`
- Modify: `packages/database/drizzle/schema/postgres.ts`
- Modify: `packages/database/drizzle/schema/mysql.ts`
- Modify: `packages/database/drizzle/schema/sqlite.ts`
- Modify: `packages/config/server.ts`
- Modify: `packages/config/public.ts`
- Modify: `packages/config/env.ts`
- Create: `packages/config/guest-media.test.ts`
- Modify: `packages/auth/auth.ts`
- Modify: `packages/auth/client.ts`
- Modify: `packages/auth/config.ts`
- Modify: `packages/auth/types.ts`
- Create: `packages/auth/lib/anonymous-boundary.ts`
- Create: `packages/auth/lib/anonymous-boundary.test.ts`
- Modify: `packages/api/orpc/procedures.ts`
- Modify: `packages/api/orpc/procedures.test.ts`
- Modify: `packages/api/index.ts`
- Create: `packages/api/auth-anonymous-boundary.integration.test.ts`
- Modify: `packages/api/modules/media/lib/free-plan-credits.ts`
- Modify: `packages/api/modules/media/lib/free-plan-credits.test.ts`
- Modify: `packages/database/prisma/queries/media/free-plan-credits.ts`
- Modify: `packages/database/prisma/queries/media/free-plan-credits.integration.test.ts`
- Modify: `apps/saas/app/(authenticated)/layout.tsx`
- Create: `apps/saas/app/(authenticated)/layout.test.tsx`

**Interfaces:**

- Produces `GuestMediaConfig` from `getGuestMediaConfig(env, runtimeOverride)` with an environment flag, database override, `promotionPeriod`, `sponsorCredits: 4n`, `productKey: "image-fast"`, 10 MiB upload limit, MIME allowlist, queue/rate/risk limits, Turnstile settings, trusted-proxy policy, and absolute retention durations. Production-invalid input returns `enabled: false` plus stable reason codes.
- Produces `isAnonymousUser(user: { isAnonymous?: boolean | null }): boolean`, `assertRegisteredSession(session)`, and `assertAnonymousSession(session)`.
- Produces `guestMediaProcedure`, scoped to anonymous Better Auth sessions only. It is exported only from the media router implementation and is not a generic public authorization primitive.
- Adds `User.isAnonymous`, `GenerationServiceClass`, `GenerationJob.serviceClass`, `dispatchEligibleAt`, `guestTrialId`, `MediaRetentionClass`, `MediaAsset.retentionClass`, `deleteAfter`, `watermarkVersion`, `watermarkedAt`, and `cleanStagingDeletedAt`.
- Adds `GuestSessionBootstrap`, `GuestMediaTrial`, `GuestLinkIntent`, `GuestResultAccessGrant`, and durable guest abuse/risk bucket rows with unique indexes for owner, promotion period, claim hash, idempotency, and result grant.
- Uses a separate `GuestLinkState = NONE | LINKING | LINKED`; trial eligibility remains `AVAILABLE | IN_FLIGHT | CONSUMED | EXPIRED` so linking and consumption cannot overwrite one another.
- Existing users/jobs/assets migrate to `isAnonymous=false`, `serviceClass=STANDARD`, and `retentionClass=ACCOUNT`; no historical business records are rewritten.
- Mirror only Better Auth's `User.isAnonymous` field into the PostgreSQL/MySQL/SQLite Drizzle auth schemas. Guest/media domain tables remain Prisma-owned.

- [ ] **Step 1: Write failing schema/config/auth-boundary tests**

```typescript
it("fails closed when production guest cost evidence or hard-budget evidence is absent", () => {
	expect(getGuestMediaConfig(productionEnvWithoutEvidence, null)).toMatchObject({
		enabled: false,
		reason: "GUEST_PRODUCTION_EVIDENCE_REQUIRED",
	});
});

it("rejects an anonymous user at the registered procedure boundary", async () => {
	await expect(callProtected({ user: { id: "guest", isAnonymous: true } })).rejects.toMatchObject({
		code: "UNAUTHORIZED",
	});
});

it("accepts only an anonymous user at the guest media boundary", async () => {
	await expect(callGuest({ user: { id: "registered", isAnonymous: false } })).rejects.toMatchObject(
		{
			code: "UNAUTHORIZED",
		},
	);
});
```

- [ ] **Step 2: Run RED and record the expected missing-schema/missing-export failures**

```powershell
pnpm --filter @repo/config exec vitest run guest-media.test.ts
pnpm --filter @repo/auth exec vitest run lib/anonymous-boundary.test.ts --config vitest.config.ts
pnpm --filter @repo/api exec vitest run orpc/procedures.test.ts auth-anonymous-boundary.integration.test.ts
```

Expected: tests fail because `GuestMediaConfig`, anonymous plugin wiring, `isAnonymous`, and guest/registered guards do not exist.

- [ ] **Step 3: Add the additive Prisma model and migration**

```prisma
enum GenerationServiceClass {
  STANDARD
  GUEST_SLOW
}

enum MediaRetentionClass {
  ACCOUNT
  GUEST_TRIAL
}
```

Add the fields and guest records named in **Interfaces**, with foreign keys to the anonymous `User`, claimed draft/source asset, current/consumed job, registered grantee, and Outbox-owned cleanup state. Use nullable/defaulted fields for compatibility and database unique/check constraints for one trial per owner/promotion period, one current job, one consumed job, one intent token hash, and one grant per guest job/registered user.

- [ ] **Step 4: Implement fail-closed configuration and Better Auth anonymous wiring**

```typescript
export interface GuestMediaConfig {
	enabled: boolean;
	reason: string | null;
	productKey: "image-fast";
	sponsorCredits: bigint;
	maximumBytes: number;
	mimeTypes: readonly ["image/jpeg", "image/png", "image/webp"];
	retentionMs: number;
	queueTtlMs: number;
	limits: GuestAdmissionLimits;
	riskBudgetMicros: bigint;
}
```

Register Better Auth's anonymous server/client plugins, expose `isAnonymous` as an inferred additional field, disable anonymous-user deletion during linking, skip welcome notification for anonymous creation, and enforce the exact anonymous auth-route policy before Better Auth handles `/auth/**`.

- [ ] **Step 5: Enforce registered-only boundaries and lifecycle exclusions**

Update `protectedProcedure` to reject `user.isAnonymous === true`; `adminProcedure` inherits the rejection. Add `guestMediaProcedure`. Redirect anonymous sessions from the authenticated layout to `/try`. Make the welcome hook and Free monthly grant helper return without side effects for anonymous users.

- [ ] **Step 6: Run GREEN plus migration generation checks**

```powershell
pnpm --filter @repo/database generate
pnpm --filter @repo/config exec vitest run guest-media.test.ts
pnpm --filter @repo/auth test
pnpm --filter @repo/api exec vitest run orpc/procedures.test.ts auth-anonymous-boundary.integration.test.ts modules/media/lib/free-plan-credits.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/free-plan-credits.integration.test.ts --config vitest.integration.config.ts --configLoader runner
pnpm --filter saas exec vitest run 'app/(authenticated)/layout.test.tsx'
```

Expected: all listed tests pass; generated Prisma output reflects the additive schema; an anonymous session receives no registered surface, welcome notification, or Free monthly grant.

- [ ] **Step 7: Commit the foundation**

```powershell
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260827_anonymous_standard_trial packages/database/drizzle/schema packages/config packages/auth packages/api/orpc packages/api/index.ts packages/api/auth-anonymous-boundary.integration.test.ts packages/api/modules/media/lib/free-plan-credits.ts packages/api/modules/media/lib/free-plan-credits.test.ts packages/database/prisma/queries/media/free-plan-credits.ts packages/database/prisma/queries/media/free-plan-credits.integration.test.ts 'apps/saas/app/(authenticated)/layout.tsx' 'apps/saas/app/(authenticated)/layout.test.tsx'
git commit -m "feat: establish anonymous trial boundaries"
```

---

### Task 2: Signed guest upload, capability snapshot, and cross-origin identity handoff

**Files:**

- Create: `packages/api/modules/media/lib/guest-capability.ts`
- Create: `packages/api/modules/media/lib/guest-capability.test.ts`
- Create: `packages/api/modules/media/lib/turnstile.ts`
- Create: `packages/api/modules/media/lib/turnstile.test.ts`
- Create: `packages/api/modules/media/procedures/get-guest-capability.ts`
- Create: `packages/api/modules/media/procedures/create-guest-upload-intent.ts`
- Create: `packages/api/modules/media/procedures/complete-guest-upload.ts`
- Create: `packages/api/modules/media/procedures/claim-guest-draft.ts`
- Modify: `packages/api/modules/media/router.ts`
- Modify: `packages/api/modules/media/procedures/create-generation-draft.ts`
- Modify: `packages/api/modules/media/procedures/create-generation-draft.test.ts`
- Create: `packages/database/prisma/queries/media/guest-bootstrap.ts`
- Create: `packages/database/prisma/queries/media/guest-bootstrap.integration.test.ts`
- Modify: `packages/database/prisma/queries/media/drafts.ts`
- Modify: `packages/database/prisma/queries/media/index.ts`
- Modify: `apps/saas/modules/media/lib/draft-handoff.ts`
- Modify: `apps/saas/modules/media/lib/draft-handoff.test.ts`
- Move: `apps/saas/app/(authenticated)/draft/continue/route.ts` -> `apps/saas/app/draft/continue/route.ts`
- Move: `apps/saas/app/(authenticated)/draft/continue/route.test.ts` -> `apps/saas/app/draft/continue/route.test.ts`
- Create: `apps/marketing/modules/generator/lib/guest-capability.ts`
- Create: `apps/marketing/modules/generator/lib/guest-capability.test.ts`
- Create: `apps/marketing/modules/generator/lib/guest-upload-client.ts`
- Create: `apps/marketing/modules/generator/lib/guest-upload-client.test.ts`
- Modify: `apps/marketing/modules/generator/lib/draft-client.ts`
- Modify: `apps/marketing/modules/generator/lib/draft-client.test.ts`

**Interfaces:**

- Produces public `GuestCapabilitySnapshot`:

```typescript
interface GuestCapabilitySnapshot {
	version: string;
	enabled: boolean;
	reason: string | null;
	upload: { mimeTypes: readonly string[]; maximumBytes: number };
	product: { key: "image-fast"; label: "Standard Edit"; credits: "4" };
	queueEstimate:
		{ kind: "range"; minimumSeconds: number; maximumSeconds: number } | { kind: "capacity" };
}
```

- Produces `createGuestDraftUploadIntent({ capabilityVersion, contentType, bytes, sha256, turnstileToken })` returning `{ sessionId, assetId, uploadUrl, completionToken, expiresAt }`.
- Produces `completeGuestDraftUpload({ sessionId, completionToken, capabilityVersion, sha256, prompt })` returning `{ claimToken, continueUrl: "/draft/continue" }` only after object HEAD, magic-byte MIME, exact size/checksum, immutable promotion, and input moderation reach `READY`.
- Keeps claim/completion tokens out of URLs, analytics, logs, and storage keys. Tokens are stored only as hashes and consumed once.
- `/draft/continue` becomes an identity-state router: registered session -> registered draft claim -> `/create`; missing/anonymous session -> consume/resume `GuestSessionBootstrap` -> anonymous sign-in -> `/try`.
- The old base64 draft route remains compatibility-only and cannot satisfy the guest readiness flag.

- [ ] **Step 1: Write failing capability, Turnstile, upload, and replay tests**

```typescript
it("fails closed when the selected and completed capability versions differ", async () => {
	await expect(
		completeGuestDraftUpload({ ...validCompletion, capabilityVersion: "old" }),
	).rejects.toThrow("GUEST_CAPABILITY_CHANGED");
});

it("consumes one Turnstile token for only the guest_upload action", async () => {
	await verifyGuestTurnstile(validResponse("guest_upload"));
	await expect(verifyGuestTurnstile(validResponse("guest_upload"))).rejects.toThrow(
		"TURNSTILE_REPLAYED",
	);
});

it("creates one anonymous principal when the same bootstrap is claimed concurrently", async () => {
	const results = await Promise.all(Array.from({ length: 32 }, () => consumeBootstrap(claimToken)));
	expect(new Set(results.map((result) => result.userId))).toHaveSize(1);
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @repo/api exec vitest run modules/media/lib/guest-capability.test.ts modules/media/lib/turnstile.test.ts modules/media/procedures/create-generation-draft.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-bootstrap.integration.test.ts --config vitest.integration.config.ts --configLoader runner
pnpm --filter marketing exec vitest run modules/generator/lib/guest-upload-client.test.ts modules/generator/lib/draft-client.test.ts
```

Expected: missing guest capability/upload/bootstrap modules fail; the old client still serializes base64.

- [ ] **Step 3: Implement server capability and single-use Turnstile verification**

Validate `hostname`, exact action (`guest_upload` or `guest_generate`), success, freshness, and single-use token hash. Resolve trusted client IP only from the configured proxy chain; direct spoofed forwarding headers are ignored. The capability snapshot is server-owned, versioned, and has no enabled fallback when its source is unavailable.

- [ ] **Step 4: Implement private signed upload intent and completion**

Reuse the existing upload-session byte reservation, private storage presigning, verification, moderation, promotion, checksum, and cleanup primitives. Bind intent and completion credentials to separate hashes, one asset, one capability version, one origin, and absolute expiries. Create cleanup Outbox rows for abandoned staging/final objects at allocation time.

- [ ] **Step 5: Implement bootstrap consumption and identity-state routing**

Use a serializable transaction and deterministic advisory lock keyed by the claim hash. Reject bad Origin, expired/replayed claim, temporary-user caps, and untrusted IP before creating a User/Session. Replay resumes the one canonical bootstrap principal. Widen the HttpOnly, SameSite=Lax claim cookie only to the exact claim/bootstrap path and delete it after the attempt.

- [ ] **Step 6: Replace the marketing base64 path with direct private upload**

```typescript
export async function uploadGuestDraft(
	input: GuestDraftUploadInput,
): Promise<MarketingDraftHandoff> {
	const intent = await createGuestDraftUploadIntent(input.metadata);
	await uploadGuestFile(intent.uploadUrl, input.file, input.onProgress);
	return completeGuestDraftUpload({ ...intentCompletion(intent), prompt: input.prompt });
}
```

Use XHR transferred bytes for upload percentage. Keep the opaque top-level form POST for the claim handoff and never perform credentialed cross-origin fetches from marketing.

- [ ] **Step 7: Run GREEN and regress the existing upload/draft security contracts**

```powershell
pnpm --filter @repo/api exec vitest run modules/media/lib/guest-capability.test.ts modules/media/lib/turnstile.test.ts modules/media/procedures/create-generation-draft.test.ts modules/media/procedures/create-upload-session.test.ts modules/media/procedures/complete-upload-session.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-bootstrap.integration.test.ts prisma/queries/media/upload-finalization.integration.test.ts prisma/queries/media/upload-quota.integration.test.ts --config vitest.integration.config.ts --configLoader runner
pnpm --filter marketing exec vitest run modules/generator/lib/guest-upload-client.test.ts modules/generator/lib/draft-client.test.ts
pnpm --filter saas exec vitest run app/draft/continue/route.test.ts modules/media/lib/draft-handoff.test.ts
```

- [ ] **Step 8: Commit the signed handoff**

```powershell
git add packages/api/modules/media packages/database/prisma/queries/media apps/marketing/modules/generator/lib apps/saas/modules/media/lib/draft-handoff.ts apps/saas/modules/media/lib/draft-handoff.test.ts apps/saas/app/draft/continue/route.ts apps/saas/app/draft/continue/route.test.ts
git commit -m "feat: add private guest draft handoff"
```

---

### Task 3: Atomic guest trial admission, sponsor credits, and link/result-grant fence

**Files:**

- Create: `packages/database/prisma/queries/media/guest-admission.ts`
- Create: `packages/database/prisma/queries/media/guest-admission.integration.test.ts`
- Create: `packages/database/prisma/queries/media/guest-link.ts`
- Create: `packages/database/prisma/queries/media/guest-link.integration.test.ts`
- Modify: `packages/database/prisma/queries/media/index.ts`
- Create: `packages/api/modules/media/lib/guest-admission.ts`
- Create: `packages/api/modules/media/lib/guest-admission.test.ts`
- Create: `packages/api/modules/media/procedures/get-guest-eligibility.ts`
- Create: `packages/api/modules/media/procedures/submit-guest-generation.ts`
- Create: `packages/api/modules/media/procedures/submit-guest-generation.test.ts`
- Create: `packages/api/modules/media/procedures/get-guest-job.ts`
- Create: `packages/api/modules/media/procedures/get-guest-asset-access-url.ts`
- Create: `packages/api/modules/media/procedures/begin-guest-link-intent.ts`
- Create: `packages/api/modules/media/procedures/complete-guest-link-intent.ts`
- Modify: `packages/api/modules/media/procedures/get-asset-access-url.ts`
- Modify: `packages/api/modules/media/procedures/get-asset-access-url.test.ts`
- Modify: `packages/api/modules/media/router.ts`
- Create: `packages/api/modules/media/guest-media.integration.test.ts`

**Interfaces:**

- Consumes Task 1's `GuestMediaConfig` and guards and Task 2's claimed `READY` asset/bootstrap.
- Produces `createGuestGenerationTransaction(input, db)` that atomically writes the moderated quote, `GuestMediaTrial`, isolated credit account/lot/ledger grant, reservation/allocation, input binding, `GUEST_SLOW` job, risk hold, and delayed `GUEST_GENERATION_ELIGIBLE` Outbox event.
- Produces public `GuestJobSnapshot` containing only `{ jobId, stage, projectedDispatchAt, estimateExpiresAt, resultExpiresAt, watermarked, trialConsumed, linkReady }`.
- `beginGuestLinkIntent` locks the trial and marks it `LINKING` before returning a one-time HttpOnly intent capability. `completeGuestLinkIntent` either transfers a pre-admission draft into the existing registered claim path or creates an expiry-bounded `GuestResultAccessGrant` for the exact job, then revokes anonymous sessions.
- Guest result procedures never appear in History/Assets and reject expired, cross-owner, non-watermarked, non-approved, or unrelated assets.

- [ ] **Step 1: Write failing unit and PostgreSQL concurrency tests**

```typescript
it("commits exactly one trial, grant, reservation, job and outbox row under a 32-way replay", async () => {
	const results = await concurrentBarrier(32, () => submit(validGuestRequest));
	expect(new Set(results.map((result) => result.jobId))).toHaveSize(1);
	await expectGuestGraphCounts({ trials: 1, grants: 1, reservations: 1, jobs: 1, outbox: 1 });
});

it("creates no business row and makes no Provider call when any admission dimension is N plus one", async () => {
	await admitExactly(limit);
	await expect(submit(extraRequest)).rejects.toThrow("GUEST_CAPACITY_UNAVAILABLE");
	await expectNoRowsFor(extraRequest.idempotencyKey);
	expect(providerSubmit).toHaveBeenCalledTimes(0);
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @repo/api exec vitest run modules/media/lib/guest-admission.test.ts modules/media/procedures/submit-guest-generation.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-admission.integration.test.ts prisma/queries/media/guest-link.integration.test.ts --config vitest.integration.config.ts --configLoader runner
```

Expected: guest admission/link exports and atomic records are absent.

- [ ] **Step 3: Implement pre-transaction verification and stable quote construction**

Verify feature/runtime switches, Origin, proxy identity, anonymous session, device format, one-time `guest_generate` Turnstile token, every rate/cap dimension, source ownership/readiness/size/moderation, Standard executable route, and prompt moderation. `REVIEW`, `ERROR`, and `REJECT` produce no trial, grant, quote, job, reservation, Outbox, or Provider call.

- [ ] **Step 4: Implement one serializable admission transaction**

Acquire advisory locks in the documented order: global promotion period -> IP/subnet/device buckets -> anonymous owner -> trial/idempotency. Recheck queue depth, projected wait, quoted-risk budgets, link status, one active job, one consumed job, and Standard price. Require the canonical quote to equal four credits; otherwise throw `GUEST_PRICE_CHANGED`. Set the initial event's `availableAt` to `projectedDispatchAt`.

- [ ] **Step 5: Implement eligibility, polling, guest access, and account-link grants**

Return stable generic errors for cross-owner access. Deny signed URL issuance at `deleteAfter` even when the object still exists. The registered grant procedure may poll/download only the exact watermarked result until the original expiry; it cannot list, edit, transfer, or extend it.

- [ ] **Step 6: Run GREEN and ordinary generation regressions**

```powershell
pnpm --filter @repo/api exec vitest run modules/media/lib/guest-admission.test.ts modules/media/procedures/submit-guest-generation.test.ts modules/media/procedures/get-asset-access-url.test.ts modules/media/procedures/create-quote.test.ts modules/media/procedures/create-generation.test.ts modules/media/guest-media.integration.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-admission.integration.test.ts prisma/queries/media/guest-link.integration.test.ts prisma/queries/media/media.integration.test.ts --config vitest.integration.config.ts --configLoader runner
```

- [ ] **Step 7: Commit atomic admission and linking**

```powershell
git add packages/database/prisma/queries/media packages/api/modules/media
git commit -m "feat: admit one sponsored guest edit"
```

---

### Task 4: Durable free queue, one-attempt dispatch, watermark finalization, and absolute cleanup

**Files:**

- Modify: `packages/storage/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/jobs/src/handlers/admit-guest-generation.ts`
- Create: `packages/jobs/src/handlers/admit-guest-generation.test.ts`
- Create: `packages/storage/lib/image-watermark.ts`
- Create: `packages/storage/lib/image-watermark.test.ts`
- Modify: `packages/storage/index.ts`
- Modify: `packages/storage/provider/s3/index.ts`
- Create: `packages/jobs/src/handlers/expire-guest-media.ts`
- Create: `packages/jobs/src/handlers/expire-guest-media.test.ts`
- Modify: `packages/jobs/src/contracts.ts`
- Modify: `packages/jobs/src/handlers/deliver-outbox-event.ts`
- Modify: `packages/jobs/src/handlers/deliver-outbox-event.test.ts`
- Modify: `packages/jobs/src/handlers/dispatch-generation.ts`
- Modify: `packages/jobs/src/handlers/dispatch-generation.security.test.ts`
- Modify: `packages/jobs/src/runtime.ts`
- Modify: `packages/jobs/src/runtime.test.ts`
- Modify: `packages/jobs/src/handlers/runtime-stores.database.integration.test.ts`
- Modify: `packages/jobs/src/handlers/finalization-transfer.database.integration.test.ts`
- Modify: `packages/jobs/src/handlers/cleanup-storage-object.ts`
- Modify: `packages/jobs/src/handlers/cleanup-storage-object.test.ts`
- Modify: `packages/jobs/src/handlers/storage-cleanup-runtime.test.ts`
- Create: `packages/jobs/trigger/admit-guest-generation.ts`
- Create: `packages/jobs/trigger/expire-guest-media.ts`
- Modify: `packages/api/modules/media/lib/dispatch-created-job.ts`
- Modify: `packages/api/modules/media/lib/dispatch-created-job.test.ts`
- Create: `packages/database/prisma/queries/media/guest-retention.ts`
- Create: `packages/database/prisma/queries/media/guest-retention.integration.test.ts`

**Interfaces:**

- Consumes Task 3's `GUEST_GENERATION_ELIGIBLE` event and guest trial/risk rows.
- `admitGuestGeneration` uses one advisory lock plus `FOR UPDATE SKIP LOCKED`, admits FIFO only when no guest job is active, moves the job to `DISPATCH_QUEUED`, and emits the existing dispatch event. Busy work is rescheduled, not completed.
- The dispatch store transaction rechecks all guest switches/budgets/trial expiry, creates Attempt 1, compare-and-sets the job to `SUBMITTING`, and moves risk `HELD -> COMMITTED` before returning an adapter claim.
- The guest dispatch path rejects Attempt 2 and disables the existing retry-route/failover branch for `GUEST_SLOW`. Duplicate events/workers still result in exactly one `adapter.submit` call.
- `watermarkStagedGuestImage(input): Promise<{ bytes; sha256; etag?; versionId?; cleanStagingDeletedAt }>` lives in `@repo/storage` and uses Sharp to add an EzPic wordmark plate at lower right with proportional safe padding. Only transformed bytes are checksummed, moderated, and promoted.
- `expireGuestMedia(now)` denies authorization first, marks due assets, and emits one idempotent delete event per object; physical deletion completion is recorded only after storage confirms it.

- [ ] **Step 1: Write failing queue, Attempt, watermark, and retention tests**

```typescript
it("never sends GUEST_SLOW through the immediate dispatch helper", async () => {
	await expect(dispatchCreatedJobBestEffort(guestJob, dependencies)).rejects.toThrow(
		"GUEST_DISPATCH_REQUIRES_ADMISSION",
	);
	expect(trigger).not.toHaveBeenCalled();
});

it("allows two racing workers to submit a guest trial only once", async () => {
	await Promise.all([dispatch(event), dispatch(event)]);
	expect(providerSubmit).toHaveBeenCalledTimes(1);
	expect(await countAttempts(jobId)).toBe(1);
});

it("does not publish READY until clean staging is physically deleted", async () => {
	storage.deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));
	await expect(finalizeGuest(candidate)).rejects.toThrow("GUEST_CLEAN_STAGE_DELETE_REQUIRED");
	expect(await readAssetStatus(assetId)).not.toBe("READY");
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @repo/jobs exec vitest run src/handlers/admit-guest-generation.test.ts src/handlers/dispatch-generation.security.test.ts src/handlers/expire-guest-media.test.ts src/handlers/deliver-outbox-event.test.ts --config vitest.config.ts
pnpm --filter @repo/storage exec vitest run lib/image-watermark.test.ts
pnpm --filter @repo/api exec vitest run modules/media/lib/dispatch-created-job.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-retention.integration.test.ts --config vitest.integration.config.ts --configLoader runner
```

Expected: guest event/queue/watermark/retention code is absent and immediate dispatch does not yet reject `GUEST_SLOW`.

- [ ] **Step 3: Implement durable FIFO guest admission**

Add the event contract, delivery routing, Trigger task, capacity estimate update, ten-minute undispatched expiry, reservation/risk release only when no Attempt exists, and one bounded pre-Provider replacement. Keep registered `STANDARD` dispatch behavior unchanged.

- [ ] **Step 4: Fence the Provider boundary in one transaction**

Extend the runtime dispatch store so the claim returned to `dispatchGeneration` exists only after switch/budget/trial/attempt checks commit. Any existing guest Attempt returns no new claim. Make explicit rejection, timeout, malformed response, missing cost, and duplicate delivery enter reconciliation/settlement without a retry route or failover.

- [ ] **Step 5: Add Sharp to storage and deterministic EzPic watermarking**

Add `sharp: "catalog:"` to `@repo/storage`. Stream Provider output into the existing private staging architecture, transform to a new immutable final object, checksum the transformed bytes, delete clean staging, then moderate/publish the transformed asset. Transform, moderation, or clean-delete failure queues idempotent cleanup and keeps guest access closed.

- [ ] **Step 6: Implement absolute expiry and physical cleanup**

At every guest object allocation write a nonextendable `deleteAfter`. The sweeper expires read authorization synchronously, schedules deletion for upload staging, input, clean output staging, failed transform, multipart parts, and final object, and removes temporary users only after retained guest records no longer reference them.

- [ ] **Step 7: Run GREEN plus registered dispatch/finalization regressions**

```powershell
pnpm --filter @repo/jobs exec vitest run src/runtime.test.ts src/handlers/admit-guest-generation.test.ts src/handlers/dispatch-generation.security.test.ts src/handlers/runtime-stores.database.integration.test.ts src/handlers/expire-guest-media.test.ts src/handlers/finalization-transfer.database.integration.test.ts src/handlers/cleanup-storage-object.test.ts src/handlers/storage-cleanup-runtime.test.ts src/handlers/deliver-outbox-event.test.ts --config vitest.config.ts
pnpm --filter @repo/storage exec vitest run lib/image-watermark.test.ts
pnpm --filter @repo/api exec vitest run modules/media/lib/dispatch-created-job.test.ts modules/media/lib/dispatch-created-job.database.integration.test.ts
pnpm --filter @repo/database exec vitest run prisma/queries/media/guest-retention.integration.test.ts --config vitest.integration.config.ts --configLoader runner
```

- [ ] **Step 8: Commit queue/finalization/cleanup**

```powershell
git add packages/jobs packages/storage packages/api/modules/media/lib/dispatch-created-job.ts packages/api/modules/media/lib/dispatch-created-job.test.ts packages/api/modules/media/lib/dispatch-created-job.database.integration.test.ts packages/database/prisma/queries/media/guest-retention.ts packages/database/prisma/queries/media/guest-retention.integration.test.ts pnpm-lock.yaml
git commit -m "feat: process guest edits through a safe slow queue"
```

---

### Task 5: Original responsive marketing, guest `/try`, and registered workspace experience

**Files:**

- Modify: `apps/marketing/modules/image-editor/components/ImageEditorHero.tsx`
- Modify: `apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- Modify: `apps/marketing/modules/generator/components/MarketingGenerator.test.tsx`
- Modify: `apps/marketing/modules/generator/components/MarketingGenerator.growth.test.tsx`
- Modify: `apps/marketing/modules/image-editor/components/ImageDropzone.tsx`
- Modify: `apps/marketing/modules/image-editor/components/SourcePreview.tsx`
- Modify: `apps/marketing/modules/image-editor/components/PromptSuggestions.tsx`
- Create: `packages/ui/components/turnstile.tsx`
- Create: `apps/saas/app/(guest)/layout.tsx`
- Create: `apps/saas/app/(guest)/try/page.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestShell.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestTrialWorkspace.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestTrialWorkspace.test.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestStatusPanel.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestResultCard.tsx`
- Create: `apps/saas/modules/media/components/guest/GuestConversionActions.tsx`
- Create: `apps/saas/modules/media/hooks/use-guest-trial.ts`
- Create: `apps/saas/modules/media/lib/guest-trial-state.ts`
- Create: `apps/saas/modules/media/lib/guest-trial-state.test.ts`
- Create: `apps/saas/modules/media/lib/guest-device.ts`
- Modify: `apps/saas/modules/media/components/editor/ImageEditorWorkspace.tsx`
- Create: `apps/saas/modules/media/components/editor/ImageEditorWorkspace.test.tsx`
- Modify: `apps/saas/modules/media/components/GenerationForm.tsx`
- Modify: `apps/saas/modules/media/components/GenerationForm.test.tsx`
- Modify: `apps/saas/modules/media/components/editor/ImageSourcePanel.tsx`
- Modify: `apps/saas/modules/media/components/editor/PromptPanel.tsx`
- Modify: `apps/saas/modules/media/components/editor/EditModeSelector.tsx`
- Modify: `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- Modify: `apps/saas/modules/media/components/editor/EditorResultPanel.test.tsx`
- Modify: `apps/saas/modules/media/components/RecentJobQueue.tsx`
- Modify: `packages/i18n/translations/en/marketing.json`
- Modify: `packages/i18n/translations/de/marketing.json`
- Modify: `packages/i18n/translations/es/marketing.json`
- Modify: `packages/i18n/translations/fr/marketing.json`
- Modify: `packages/i18n/translations/en/saas.json`
- Modify: `packages/i18n/translations/de/saas.json`
- Modify: `packages/i18n/translations/es/saas.json`
- Modify: `packages/i18n/translations/fr/saas.json`

**Interfaces:**

- Consumes Task 2's direct-upload/handoff API and Task 3's guest eligibility/submit/poll/access/link procedures.
- Marketing and product surfaces share the same task order: source -> labelled prompt -> Standard/Quality explanation -> queue/temporary disclosure -> one primary action -> stable status/result region.
- `resolveGuestTrialView(snapshot, now)` maps server states to `preparingSession | waiting | editing | finishing | moderatingOutput | ready | delayed | rejected | failed | expired`; it never fabricates percent progress or queue position.
- Guest shell renders only EzPic brand and fenced Sign in/Create account actions. It never renders authenticated navigation.
- Registered `/create` keeps the current Quote -> Confirm hook, private result access, Before/After, History, Edit Again, upgrade recovery, and credit behavior while adopting the new violet/slate responsive composition.

- [ ] **Step 1: Write failing marketing and guest-state tests**

```tsx
it("renders Standard as the only guest action and Quality as a Creator or Studio explanation", () => {
	render(<MarketingGenerator capability={enabledCapability} />);
	expect(screen.getByRole("button", { name: /try one standard edit free/i })).toBeEnabled();
	expect(screen.getByRole("link", { name: /quality edit.*creator or studio/i })).toBeVisible();
	expect(screen.queryByRole("radio", { name: /quality/i })).not.toBeInTheDocument();
});

it("uses the delayed state after the server estimate expires without an exact countdown", () => {
	expect(resolveGuestTrialView(waitingSnapshot, afterEstimate)).toMatchObject({ state: "delayed" });
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter marketing exec vitest run modules/generator/components/MarketingGenerator.test.tsx modules/generator/components/MarketingGenerator.growth.test.tsx
pnpm --filter saas exec vitest run modules/media/lib/guest-trial-state.test.ts modules/media/components/guest/GuestTrialWorkspace.test.tsx modules/media/components/editor/ImageEditorWorkspace.test.tsx
```

Expected: new disclosure, guest modules, state mapper, and responsive workspace assertions are absent.

- [ ] **Step 3: Build the EzPic-owned marketing generator**

Use Plus Jakarta Sans, violet/indigo actions, slate neutrals, 12-16 px radii, a restrained glass surface, and one subtle contact-sheet/scan accent that honors reduced motion. At >=1200 px use compact source/prompt/options/action composition; at 640-1199 px wrap options and full-width action; below 640 px use the strict long-form order and a 48 px full-width CTA. Touch targets are at least 44 px.

Approved visible copy includes `Try one Standard edit free`, `No sign-up required`, `Free queue · one watermarked preview · available for up to 24 hours`, and the temporary-session disclosure. Do not show ratio, multiple output, unlimited, Provider/model, exact time, clean-original, or commercial-rights controls/claims.

- [ ] **Step 4: Build `/try` from server-driven stages**

Reserve one result card immediately after acceptance without moving the viewport. Upload alone may display transferred-byte percentage. Later stages use server timestamps/status and polite live announcements. Provide explicit `View status`/`View result`; only failed submit moves focus to an alert. Ready shows the watermarked private image, exact expiry, guest download, and fenced account actions; no History, Edit Again, cancel, or clean original.

- [ ] **Step 5: Refresh registered `/create` without changing its business path**

Create a large-screen editor/result split, stacked middle layout, and mobile task order matching marketing. Keep the existing hooks and API calls unchanged. Put recent edits after the primary workspace and retain the registered sidebar and all recovery/upgrade/private-download behaviors.

- [ ] **Step 6: Add complete four-language copy**

Add marketing keys `offer`, `oneOutput`, `freeQueue`, `temporaryResult`, `temporarySessionDisclosure`, `qualityCta`, `characterCount`, `states.*`, and `errors.*`; add equivalent `media.guest.*` and registered `media.create.workspace.*` keys in English, German, Spanish, and French. Tests must resolve every added key in every locale.

- [ ] **Step 7: Run GREEN and registered UI regressions**

```powershell
pnpm --filter marketing exec vitest run modules/generator/components/MarketingGenerator.test.tsx modules/generator/components/MarketingGenerator.growth.test.tsx
pnpm --filter marketing test
pnpm --filter saas exec vitest run modules/media/lib/guest-trial-state.test.ts modules/media/components/guest/GuestTrialWorkspace.test.tsx modules/media/components/editor/ImageEditorWorkspace.test.tsx modules/media/components/GenerationForm.test.tsx modules/media/components/editor/EditorResultPanel.test.tsx modules/media/components/editor/BeforeAfterSlider.test.tsx modules/media/components/RecentJobQueue.test.tsx
pnpm --filter saas test
```

- [ ] **Step 8: Commit the original responsive experience**

```powershell
git add apps/marketing/modules apps/saas/app/'(guest)' apps/saas/modules/media packages/ui/components/turnstile.tsx packages/i18n/translations
git commit -m "feat: add the anonymous Standard editor experience"
```

---

### Task 6: Operations, privacy, analytics, E2E, originality, and production-off readiness gate

**Files:**

- Modify: `packages/database/prisma/queries/media/admin-diagnostics.ts`
- Modify: `packages/api/modules/media/procedures/admin-diagnostics.ts`
- Modify: `packages/api/modules/media/procedures/admin-media.test.ts`
- Modify: `apps/saas/modules/admin/component/media/MediaOperations.tsx`
- Modify: `apps/saas/modules/admin/component/media/GrowthOperationsPanel.tsx`
- Modify: `apps/marketing/modules/analytics/growth.ts`
- Modify: `apps/marketing/modules/analytics/marketing-growth-funnel.test.ts`
- Modify: `apps/saas/modules/shared/lib/growth-analytics.ts`
- Modify: `packages/config/production-certification.ts`
- Modify: `packages/config/production-certification.test.ts`
- Modify: `tests/load/run-unit-contracts.ts`
- Modify: `tests/load/run-integration.ts`
- Modify: `apps/marketing/tests/generator.spec.ts`
- Modify: `apps/marketing/tests/home.spec.ts`
- Create: `apps/marketing/tests/originality.spec.ts`
- Create: `apps/saas/tests/guest-trial.spec.ts`
- Modify: `apps/saas/tests/media-generation.spec.ts`
- Create: `apps/saas/tests/originality.spec.ts`
- Modify: `apps/saas/playwright.config.ts`
- Create: `tooling/scripts/verify-public-ui-originality.mjs`
- Modify: `package.json`
- Modify: `apps/marketing/content/legal/privacy-policy.md`
- Modify: `apps/marketing/content/legal/privacy-policy.de.md`
- Create: `docs/operations/anonymous-standard-trial.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Diagnostics expose only aggregate admission reasons, queue depth/age, risk states, sponsor ledger counts, Attempt outcomes, watermark failures, result access, and cleanup backlog; no raw IP/device/token/prompt/Provider payload is returned.
- Funnel events cover visitor -> upload -> admitted -> ready/viewed -> watermarked download -> sign-in CTA -> registered/grant complete -> first registered edit -> paid, using existing consent-aware safe schemas.
- `verify:ui-originality` scans built public HTML/JS/CSS/resource URLs for `Raphael`, `Seedream`, `raphael.app`, Provider/model/cost strings, and foreign hotlinks, failing on a match.
- `launch:certify` remains `NOT_COMPLETED` until real billed Standard cost, Provider hard-budget evidence, privacy disclosure, cleanup readiness, and production configuration are recorded.

- [ ] **Step 1: Write failing diagnostics, certification, originality, and browser tests**

```typescript
it("keeps guest launch incomplete without billed cost and Provider hard-budget evidence", () => {
	expect(certifyGuestLaunch(localPassingEvidence)).toMatchObject({ status: "NOT_COMPLETED" });
});

test("guest result is reachable at 1440, 800, and 320 without horizontal overflow", async ({
	page,
}) => {
	await assertGuestLayouts(page, [1440, 800, 320]);
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @repo/config exec vitest run production-certification.test.ts
pnpm --filter @repo/api exec vitest run modules/media/procedures/admin-media.test.ts
pnpm --filter marketing exec playwright test tests/generator.spec.ts tests/originality.spec.ts --project=chromium
pnpm --filter saas exec playwright test tests/guest-trial.spec.ts tests/originality.spec.ts --project=guest
```

Expected: guest diagnostics/certification fields, guest Playwright project, responsive assertions, and originality scanner do not exist.

- [ ] **Step 3: Add aggregate operations and safe funnel instrumentation**

Implement the warning/closure thresholds from the spec: risk 50/75/90/100 percent, queue depth 20 warning/25 close, oldest age five-minute warning/ten-minute close, uncertain Attempt older than ten minutes, moderation errors above one percent, any watermark failure, billed-spend mismatch, or cleanup beyond TTL plus 30 minutes. Automatic closure changes only the guest runtime override.

- [ ] **Step 4: Document privacy and operating behavior**

Document the temporary anonymous User/Session, up-to-24-hour media retention, pseudonymous promotion-period HMAC abuse evidence, account-link grant, deletion process, four kill switches, drain/reconcile rollback behavior, and the distinction between local mocks and live Provider evidence in all four privacy pages and the runbook.

- [ ] **Step 5: Add browser, accessibility, and originality verification**

Create a `guest` Playwright project without storage state. Assert actual layout geometry at 1440/800/320, 320 px and 400% zoom overflow, 44 px targets, 48 px mobile CTA, labels, keyboard order, non-color selection, live region, alert focus, stable success focus, reduced motion, explicit status navigation, private signed download, expiry, and absence of authenticated navigation/History/Edit Again. Capture 1440 and 390 screenshots for human originality review; do not treat screenshots alone as proof.

- [ ] **Step 6: Wire all test suites and run GREEN**

```powershell
pnpm --filter @repo/config exec vitest run production-certification.test.ts
pnpm --filter @repo/api exec vitest run modules/media/procedures/admin-media.test.ts
pnpm --filter marketing exec playwright test tests/generator.spec.ts tests/originality.spec.ts --project=chromium
pnpm --filter saas exec playwright test tests/guest-trial.spec.ts tests/originality.spec.ts --project=guest
pnpm --filter saas exec playwright test tests/media-generation.spec.ts --project=funded --grep "successful edit|mobile editor"
pnpm verify:ui-originality
```

- [ ] **Step 7: Run repository gates with fresh evidence**

```powershell
pnpm format
pnpm lint --deny-warnings
pnpm type-check
pnpm test:unit:contracts
pnpm test:integration
pnpm e2e:media:ci
pnpm build
pnpm launch:certify
```

Expected: format/lint/type/unit/integration/E2E/build pass locally with deterministic adapters; `launch:certify` explicitly reports guest production enablement `NOT_COMPLETED` while billed-cost, Provider hard-budget, deployment, and live external verification remain absent.

- [ ] **Step 8: Inspect final diff and prove protected boundaries**

```powershell
git diff --check
git status --short
rg -n -i "raphael|seedream|providerModelId|providerCostMicros" apps/marketing/.next apps/saas/.next
```

The built-artifact search must return no public competitor/Provider/model/cost match. Review every changed file against the spec, confirm no real secret or credential was added, and verify the original checkout's unrelated files remain untouched.

- [ ] **Step 9: Commit operations and verification**

```powershell
git add packages/database/prisma/queries/media/admin-diagnostics.ts packages/api/modules/media/procedures apps/saas/modules/admin/component/media apps/marketing/modules/analytics apps/saas/modules/shared/lib/growth-analytics.ts packages/config tests/load apps/marketing/tests apps/saas/tests apps/saas/playwright.config.ts tooling/scripts/verify-public-ui-originality.mjs package.json apps/marketing/content/legal/privacy-policy.md apps/marketing/content/legal/privacy-policy.de.md docs/operations/anonymous-standard-trial.md CHANGELOG.md
git commit -m "test: certify the anonymous Standard trial"
```

## Final Acceptance Ledger

Record the following separately; never collapse them into one completion claim:

1. Schema generation and migration evidence.
2. RED -> GREEN command/output for each task.
3. Focused unit and PostgreSQL integration results.
4. Marketing and SaaS browser results at all three layout bands.
5. Full format, lint, type-check, unit-contract, integration, E2E, and build results.
6. Final branch review findings and resolutions.
7. Git branch/commit state.
8. Deployment: `NOT_COMPLETED` unless separately authorized and performed.
9. Real Provider/Turnstile/cloud-storage billed verification: `NOT_COMPLETED` in this plan.
10. Production guest enablement: `NOT_COMPLETED`; both environment and database guest switches remain off.
