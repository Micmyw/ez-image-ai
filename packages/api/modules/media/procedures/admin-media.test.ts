import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getAdminMediaDiagnostics: vi.fn(),
	listAdminUncertainGenerationAttempts: vi.fn(),
	listAdminMediaAudit: vi.fn(),
	replayPersistedMediaEvent: vi.fn(),
	requeueAdminMediaVerification: vi.fn(),
	resolveAdminUncertainSubmission: vi.fn(),
	retryAdminMediaJobStage: vi.fn(),
	setAdminMediaRuntimeOverride: vi.fn(),
	rollbackAdminMediaRuntimeOverride: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";
import {
	getAdminMediaDiagnostics,
	listAdminUncertainGenerationAttempts,
	listAdminMediaAudit,
	replayPersistedMediaEvent,
	requeueAdminMediaVerification,
	resolveAdminUncertainSubmission,
	retryAdminMediaJobStage,
	setAdminMediaRuntimeOverride,
} from "@repo/database";

import { listMediaAuditLog } from "./admin-audit-log";
import { adminMediaDiagnostics, listUncertainGenerationAttempts } from "./admin-diagnostics";
import {
	replayMediaEvent,
	requeueMediaVerification,
	resolveUncertainSubmission,
	retryMediaJobStage,
	setMediaRuntimeOverride,
} from "./admin-operations";

const context = { context: { headers: new Headers() } };

describe("media administration authorization and safe DTOs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("GUEST_MEDIA_ENABLED", "true");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "review-period");
		vi.stubEnv("GUEST_RISK_BUDGET_MICROS", "100000");
	});

	afterEach(() => vi.unstubAllEnvs());

	it("rejects diagnostics before touching the database for non-admin users", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1", role: "user" },
			session: { id: "session_1" },
		} as never);

		await expect(call(adminMediaDiagnostics, undefined, context)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(getAdminMediaDiagnostics).not.toHaveBeenCalled();
	});

	it("rejects uncertain-attempt recovery diagnostics before touching the database for non-admin users", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1", role: "user" },
			session: { id: "session_1" },
		} as never);

		await expect(
			call(listUncertainGenerationAttempts, { limit: 20 }, context),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(listAdminUncertainGenerationAttempts).not.toHaveBeenCalled();
	});

	it("returns only allowlisted aggregate diagnostics", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(getAdminMediaDiagnostics).mockResolvedValue({
			generatedAt: "2026-08-14T00:00:00.000Z",
			queue: { depth: 4, oldestAgeSeconds: 12, stalledJobs: 1, needsReconciliation: 2 },
			outbox: { pending: 2, deadLetter: 0, oldestAgeSeconds: 5 },
			providers: [
				{ provider: "replicate", succeeded: 3, failed: 1, running: 0, costMicros: "700" },
			],
			storage: { readyAssets: 3, readyBytes: "1200", reservedBytes: "10" },
			credits: { spendable: "40", reserved: "5", debt: "0", settled: "20" },
			finance: {
				revenueMicros: "1000",
				refundedMicros: "100",
				providerCostMicros: "700",
				marginMicros: "200",
			},
			events: {
				providerFailed: 0,
				payment: {
					failed: {
						count: 1,
						items: [
							{
								id: "payment_failed_1",
								providerEventId: "evt_failed_1",
								status: "FAILED",
								attemptCount: 2,
								lastTriggerAttempt: 2,
								lastAttemptAt: "2026-08-14T00:00:00.000Z",
								lastTriggerRunId: "trigger_run_1",
								lastErrorClass: "TRANSIENT",
							},
						],
					},
					deadLetter: { count: 0, items: [] },
					ignored: { count: 0, items: [] },
				},
			},
			overrides: [],
			guest: {
				admission: {
					accepted: 3,
					deniedByReason: [{ reason: "QUEUE_CAPACITY", count: 2 }],
				},
				queue: {
					depth: 4,
					oldestAgeSeconds: 301,
					waitMs: { p50: 80_000, p95: 140_000 },
					expiredBeforeDispatch: 1,
				},
				risk: {
					budgetMicros: "100000",
					heldMicros: "20000",
					committedMicros: "60000",
					releasedMicros: "10000",
					utilizationPercent: 80,
					state: "SLOW",
				},
				sponsorCredits: { granted: "12", reserved: "4", settled: "8", released: "0" },
				attempts: {
					accepted: 2,
					rejected: 0,
					uncertain: 1,
					uncertainOlderThanTenMinutes: 1,
					reportedCostCovered: 2,
					reportedCostMissing: 1,
					billedSpendMismatch: 0,
				},
				moderation: { approved: 2, rejected: 1, errors: 0, errorRate: 0 },
				watermark: { succeeded: 2, failed: 0 },
				resultAccess: { ready: 2, grantsCompleted: 1, expiredGrants: 0 },
				cleanup: {
					expiredAssets: 1,
					overdueAssets: 1,
					deadLetterEvents: 0,
					oldestOverdueSeconds: 42,
				},
				controls: {
					environmentEnabled: false,
					runtimeEnabled: false,
					admissionOpen: false,
					automaticClosureReasons: ["QUEUE_AGE"],
				},
				rawIp: "203.0.113.8",
				deviceHash: "fixture-secret-do-not-return",
				prompt: "fixture-secret-do-not-return",
				providerPayload: { costMicros: 1234 },
			},
		} as never);

		const result = await call(adminMediaDiagnostics, undefined, context);
		expect(getAdminMediaDiagnostics).toHaveBeenCalledWith(
			{},
			{
				guestEnvironmentEnabled: true,
				guestPromotionPeriod: "review-period",
				guestRiskBudgetMicros: 100_000n,
			},
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toMatch(
			/prompt|rawPayload|requestBody|responseBody|envelope|secret|signature|signedUrl|objectKey|sourceUrl|token|url/i,
		);
		expect(serialized).not.toContain("fixture-secret-do-not-return");
		expect(result.queue.depth).toBe(4);
		expect(result.guest).toEqual({
			admission: {
				accepted: 3,
				deniedByReason: [{ reason: "QUEUE_CAPACITY", count: 2 }],
			},
			queue: {
				depth: 4,
				oldestAgeSeconds: 301,
				waitMs: { p50: 80_000, p95: 140_000 },
				expiredBeforeDispatch: 1,
			},
			risk: {
				budgetMicros: "100000",
				heldMicros: "20000",
				committedMicros: "60000",
				releasedMicros: "10000",
				utilizationPercent: 80,
				state: "SLOW",
			},
			sponsorCredits: { granted: "12", reserved: "4", settled: "8", released: "0" },
			attempts: {
				accepted: 2,
				rejected: 0,
				uncertain: 1,
				uncertainOlderThanTenMinutes: 1,
				reportedCostCovered: 2,
				reportedCostMissing: 1,
				billedSpendMismatch: 0,
			},
			moderation: { approved: 2, rejected: 1, errors: 0, errorRate: 0 },
			watermark: { succeeded: 2, failed: 0 },
			resultAccess: { ready: 2, grantsCompleted: 1, expiredGrants: 0 },
			cleanup: {
				expiredAssets: 1,
				overdueAssets: 1,
				deadLetterEvents: 0,
				oldestOverdueSeconds: 42,
			},
			controls: {
				environmentEnabled: false,
				runtimeEnabled: false,
				admissionOpen: false,
				automaticClosureReasons: ["QUEUE_AGE"],
			},
		});
		expect(result.events.payment.failed.items).toEqual([
			{
				id: "payment_failed_1",
				providerEventId: "evt_failed_1",
				status: "FAILED",
				attemptCount: 2,
				lastTriggerAttempt: 2,
				lastAttemptAt: "2026-08-14T00:00:00.000Z",
				lastTriggerRunId: "trigger_run_1",
				lastErrorClass: "TRANSIENT",
			},
		]);
	});

	it("returns a redacted uncertain-attempt recovery DTO only to administrators", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(listAdminUncertainGenerationAttempts).mockResolvedValue([
			{
				ids: {
					attemptId: "attempt_1",
					jobId: "job_1",
					reservationId: "reservation_1",
				},
				route: { provider: "fal", providerModelId: "fal-ai/flux/schnell" },
				status: { attempt: "NEEDS_RECONCILIATION", job: "NEEDS_RECONCILIATION" },
				timestamps: {
					createdAt: "2026-08-23T00:00:00.000Z",
					updatedAt: "2026-08-23T00:01:00.000Z",
					submittedAt: "2026-08-23T00:00:10.000Z",
					completedAt: null,
					lastProviderEventAt: null,
					nextReconcileAt: null,
				},
				retryCount: 2,
				reservationStatus: "ACTIVE",
				reasonCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
				providerTaskId: "provider-task-secret",
				providerStatusUrl: "https://queue.fal.run/secret",
				responseSnapshot: { signedUrl: "https://cdn.example/output?signature=secret" },
			},
		] as never);

		const result = await call(listUncertainGenerationAttempts, { limit: 20 }, context);

		expect(listAdminUncertainGenerationAttempts).toHaveBeenCalledWith(
			{ limit: 20 },
			expect.anything(),
		);
		expect(result).toEqual({
			items: [
				{
					ids: { attemptId: "attempt_1", jobId: "job_1", reservationId: "reservation_1" },
					route: { provider: "fal", providerModelId: "fal-ai/flux/schnell" },
					status: { attempt: "NEEDS_RECONCILIATION", job: "NEEDS_RECONCILIATION" },
					timestamps: {
						createdAt: "2026-08-23T00:00:00.000Z",
						updatedAt: "2026-08-23T00:01:00.000Z",
						submittedAt: "2026-08-23T00:00:10.000Z",
						completedAt: null,
						lastProviderEventAt: null,
						nextReconcileAt: null,
					},
					retryCount: 2,
					reservationStatus: "ACTIVE",
					reasonCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/providerTaskId|providerStatusUrl|responseSnapshot|signature|token|secret/i,
		);
	});

	it("paginates audit records without exposing before, after, or metadata JSON", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(listAdminMediaAudit).mockResolvedValue({
			items: [
				{
					id: "audit_1",
					actorUserId: "admin_1",
					action: "MEDIA_EVENT_REPLAYED",
					targetType: "PAYMENT_EVENT",
					targetId: "event_1",
					createdAt: "2026-08-14T00:00:00.000Z",
				},
			],
			nextCursor: null,
		} as never);

		const result = await call(listMediaAuditLog, { limit: 20 }, context);
		expect(result.items[0]).toEqual({
			id: "audit_1",
			actorUserId: "admin_1",
			action: "MEDIA_EVENT_REPLAYED",
			targetType: "PAYMENT_EVENT",
			targetId: "event_1",
			createdAt: "2026-08-14T00:00:00.000Z",
		});
		expect(JSON.stringify(result)).not.toMatch(/metadata|before|after|prompt/i);
	});
});

describe("media administration mutations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_1", role: "admin" },
			session: { id: "session_1" },
		} as never);
	});

	it("passes an idempotency key and actor to safe persisted-event replay", async () => {
		vi.mocked(replayPersistedMediaEvent).mockResolvedValue({
			replayed: false,
			eventId: "event_1",
		} as never);
		await call(
			replayMediaEvent,
			{
				eventKind: "PAYMENT",
				eventId: "event_1",
				idempotencyKey: "operation-123",
				reason: "Retry after dependency recovery",
			},
			context,
		);
		expect(replayPersistedMediaEvent).toHaveBeenCalledWith(
			expect.objectContaining({ actorUserId: "admin_1", idempotencyKey: "operation-123" }),
			expect.anything(),
		);
	});

	it("requeues verification through the audited generation-aware database command", async () => {
		vi.mocked(requeueAdminMediaVerification).mockResolvedValue({
			assetId: "asset_1",
			generation: 3,
			replayed: false,
		});

		await call(
			requeueMediaVerification,
			{
				assetId: "asset_1",
				idempotencyKey: "moderation-operation-123",
				reason: "Re-run the failed asset with the current moderation policy",
			},
			context,
		);

		expect(requeueAdminMediaVerification).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: "asset_1",
				actorUserId: "admin_1",
				idempotencyKey: "moderation-operation-123",
				currentVerification: {
					provider: process.env.MEDIA_SAFETY_ADAPTER ?? "test",
					ruleVersion: expect.stringMatching(/^media-safety-/),
					policyVersion: expect.stringMatching(/^media-policy-/),
				},
			}),
			expect.anything(),
		);
	});

	it("only accepts explicitly safe job stages", async () => {
		vi.mocked(retryAdminMediaJobStage).mockResolvedValue({
			replayed: false,
			jobId: "job_1",
			stage: "FINALIZE",
		} as never);
		await expect(
			call(
				retryMediaJobStage,
				{
					jobId: "job_1",
					stage: "SUBMIT_PROVIDER" as never,
					idempotencyKey: "operation-123",
					reason: "Unsafe duplicate submission",
				},
				context,
			),
		).rejects.toBeDefined();
		expect(retryAdminMediaJobStage).not.toHaveBeenCalled();
	});

	it("requires provider evidence and a task ID before accepting uncertain submissions", async () => {
		await expect(
			call(
				resolveUncertainSubmission,
				{
					attemptId: "attempt_1",
					resolution: "ACCEPTED",
					providerEvidenceReference: "provider-case-12345",
					idempotencyKey: "operation-123",
					reason: "Provider confirmed the uncertain submission",
				},
				context,
			),
		).rejects.toBeDefined();
		expect(resolveAdminUncertainSubmission).not.toHaveBeenCalled();

		vi.mocked(resolveAdminUncertainSubmission).mockResolvedValue({ replayed: false } as never);
		await call(
			resolveUncertainSubmission,
			{
				attemptId: "attempt_1",
				resolution: "ACCEPTED",
				providerTaskId: "provider-task-1",
				providerEvidenceReference: "provider-case-12345",
				idempotencyKey: "operation-124",
				reason: "Provider confirmed the uncertain submission",
			},
			context,
		);
		expect(resolveAdminUncertainSubmission).toHaveBeenCalledWith(
			expect.objectContaining({
				actorUserId: "admin_1",
				providerTaskId: "provider-task-1",
				resolution: "ACCEPTED",
			}),
			expect.anything(),
		);
	});

	it("uses logical product keys for model overrides", async () => {
		vi.mocked(setAdminMediaRuntimeOverride).mockResolvedValue({
			id: "override_1",
			version: 2,
			replayed: false,
		} as never);
		await call(
			setMediaRuntimeOverride,
			{
				scope: "MODEL",
				productKey: "image-fast",
				enabled: false,
				idempotencyKey: "operation-123",
				reason: "Provider error rate exceeded threshold",
			},
			context,
		);
		expect(setAdminMediaRuntimeOverride).toHaveBeenCalledWith(
			expect.objectContaining({ configKey: "media.model.image-fast.enabled", value: false }),
			expect.anything(),
		);
	});
});
