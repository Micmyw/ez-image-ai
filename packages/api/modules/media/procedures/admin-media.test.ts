import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getAdminMediaDiagnostics: vi.fn(),
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
	listAdminMediaAudit,
	replayPersistedMediaEvent,
	requeueAdminMediaVerification,
	resolveAdminUncertainSubmission,
	retryAdminMediaJobStage,
	setAdminMediaRuntimeOverride,
} from "@repo/database";

import { listMediaAuditLog } from "./admin-audit-log";
import { adminMediaDiagnostics } from "./admin-diagnostics";
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
	});

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
		} as never);

		const result = await call(adminMediaDiagnostics, undefined, context);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toMatch(
			/prompt|rawPayload|requestBody|responseBody|envelope|secret|signature|signedUrl|objectKey|sourceUrl|token|url/i,
		);
		expect(serialized).not.toContain("fixture-secret-do-not-return");
		expect(result.queue.depth).toBe(4);
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
