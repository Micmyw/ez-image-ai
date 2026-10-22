import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { listVerificationRecoveryCandidates } from "../orchestration/verification-recovery";
import { createDatabaseVerifyUploadDependencies } from "../runtime";

describe("output verification admission", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["image/png", "IMAGE_PROCESSING", 5_000, true, false],
		["video/mp4", "VIDEO_PROCESSING", 15_000, false, false],
		["image/png", "IMAGE_PROCESSING", 5_000, true, true],
	] as const)(
		"starts %s polling without bypassing its due time or resubmitting moderation",
		async (mimeType, reasonCode, intervalMs, immediateWake, callbackDuringQuery) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const now = new Date("2026-09-21T08:04:14Z");
			vi.setSystemTime(now);
			const asset = {
				id: "pending-output",
				kind: "OUTPUT",
				status: "VERIFYING",
				deletedAt: null,
				objectKey: "private/output",
				mimeType,
				byteSize: 16n,
				checksum: "a".repeat(64),
				finalizedAt: now,
				verificationGeneration: 0,
				verificationAttemptCount: 0,
				verificationNextAttemptAt: null as Date | null,
				verificationEngine: "legacy",
				verificationLeaseToken: null as string | null,
				verificationLeasedUntil: null as Date | null,
				verificationProviderTaskId: null as string | null,
				verificationSubmissionToken: null as string | null,
				verificationSubmissionUncertain: false,
				verificationCallbackReceivedAt: null as Date | null,
			};
			const update = async ({ data }: { data: Record<string, unknown> }) => ({
				...Object.assign(asset, data),
			});
			const committedEvents = new Map<string, { id: string; availableAt: Date }>();
			const wake = vi.fn(
				async (input: {
					skipDuplicates: boolean;
					data: { id: string; dedupeKey: string; availableAt?: Date };
				}) => {
					expect(input.skipDuplicates).toBe(true);
					if (committedEvents.has(input.data.dedupeKey)) return { count: 0 };
					committedEvents.set(input.data.dedupeKey, {
						id: input.data.id,
						availableAt: input.data.availableAt ?? new Date(now),
					});
					return { count: 1 };
				},
			);
			const countFailures = vi.fn(async () => 0);
			const tx = {
				$executeRaw: vi.fn(async () => 1),
				$queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
					const statement = sql.join("?");
					if (statement.includes('SELECT "phaseKey"')) return [];
					if (statement.includes('AS "current"')) {
						const [id, generation, leaseToken] = values;
						return [
							{
								current:
									asset.id === id &&
									asset.verificationGeneration === generation &&
									asset.verificationLeaseToken === leaseToken &&
									!!asset.verificationLeasedUntil &&
									asset.verificationLeasedUntil > new Date(),
							},
						];
					}
					if (statement.includes('RETURNING "verificationSubmissionToken"')) {
						const [newToken, submittedAt, updatedAt, id, generation, leaseToken, startedAt] =
							values;
						if (
							asset.verificationEngine !== "legacy" ||
							asset.id !== id ||
							asset.status !== "VERIFYING" ||
							asset.verificationGeneration !== generation ||
							asset.verificationLeaseToken !== leaseToken ||
							!asset.verificationLeasedUntil ||
							asset.verificationLeasedUntil <= (startedAt as Date) ||
							asset.verificationProviderTaskId !== null ||
							asset.verificationSubmissionUncertain
						)
							return [];
						await update({
							data: {
								verificationSubmissionToken: asset.verificationSubmissionToken ?? newToken,
								verificationCallbackReceivedAt: asset.verificationSubmissionToken
									? asset.verificationCallbackReceivedAt
									: null,
								verificationSubmissionUncertain: true,
								verificationSubmittedAt: submittedAt,
								updatedAt,
							},
						});
						return [{ verificationSubmissionToken: asset.verificationSubmissionToken }];
					}
					if (statement.includes('RETURNING "verificationLeasedUntil"')) {
						const [providerTaskId, updatedAt, id, generation, leaseToken, submissionToken] = values;
						if (
							asset.verificationEngine !== "legacy" ||
							asset.id !== id ||
							asset.status !== "VERIFYING" ||
							asset.verificationGeneration !== generation ||
							asset.verificationLeaseToken !== leaseToken ||
							asset.verificationSubmissionToken !== submissionToken ||
							!asset.verificationSubmissionUncertain ||
							(asset.verificationProviderTaskId !== null &&
								asset.verificationProviderTaskId !== providerTaskId)
						)
							return [];
						await update({
							data: {
								verificationProviderTaskId: providerTaskId,
								verificationSubmissionUncertain: false,
								updatedAt,
							},
						});
						return [{ verificationLeasedUntil: asset.verificationLeasedUntil, ownerCurrent: true }];
					}
					throw new Error("UNEXPECTED_VERIFICATION_QUERY");
				}),
				mediaAsset: {
					findUnique: async () => ({ ...asset }),
					findFirst: async () => ({ ...asset }),
					update,
					updateMany: async (input: { data: Record<string, unknown> }) => {
						await update(input);
						return { count: 1 };
					},
				},
				auditLog: { findFirst: async () => null },
				generationJobAsset: { findMany: async () => [] },
				assetModerationResult: {
					findFirst: async () => null,
					createMany: async () => ({ count: 1 }),
					count: countFailures,
				},
				outboxEvent: {
					createMany: wake,
					findUniqueOrThrow: async ({ where }: { where: { dedupeKey: string } }) => {
						const event = committedEvents.get(where.dedupeKey);
						if (!event) throw new Error("POLL_EVENT_NOT_FOUND");
						return event;
					},
				},
			};
			const database = {
				...tx,
				$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
			};
			const submit = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
				moderationTaskId: "same-moderation-task",
				status: "QUEUED" as const,
				ruleVersion: input.ruleVersion,
				idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
			}));
			const retrieve = vi.fn(async (input: { ruleVersion: string }) => {
				if (callbackDuringQuery && !asset.verificationCallbackReceivedAt)
					asset.verificationCallbackReceivedAt = new Date();
				return { decision: "REVIEW" as const, reasonCode, ruleVersion: input.ruleVersion };
			});
			const dependencies = createDatabaseVerifyUploadDependencies(database as never, {
				safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
					submitImage: submit,
					retrieveImage: retrieve,
					submitVideo: submit,
					retrieveVideo: retrieve,
				}),
				moderationProvider: "test",
				headObject: async () => ({
					contentLength: 16,
					contentType: mimeType,
					etag: "etag",
					metadata: {},
				}),
				readMediaHeader: async () =>
					Buffer.from(
						mimeType === "image/png"
							? "89504e470d0a1a0a0000000d49484452"
							: "00000018667479706d70343200000000",
						"hex",
					),
				createSignedReadUrl: async () => "https://private.example/output",
			});
			const firstResult = await dependencies.verify(asset.id);
			const firstEvent = committedEvents.get(wake.mock.calls[0]![0].data.dedupeKey)!;
			expect(firstResult).toEqual({
				outboxCommitted: immediateWake,
				...(immediateWake ? { outputReviewEventId: firstEvent.id, queryOnly: true } : {}),
			});
			expect(wake).toHaveBeenCalledOnce();
			expect.soft(wake).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						eventType: "MEDIA_ASSET_VERIFY",
						...(immediateWake ? {} : { availableAt: new Date(now.getTime() + intervalMs) }),
					}),
				}),
			);
			if (immediateWake) {
				expect(wake.mock.calls[0]![0].data).not.toHaveProperty("availableAt");
			}
			expect
				.soft(asset.verificationNextAttemptAt)
				.toEqual(new Date(now.getTime() + (callbackDuringQuery ? 0 : intervalMs)));
			if (callbackDuringQuery) {
				// A callback arriving while the current query holds the lease wakes one
				// immediate authenticated retrieval, then normal polling resumes.
				await expect(dependencies.verify(asset.id)).resolves.toMatchObject({
					outboxCommitted: false,
				});
				expect(asset.verificationNextAttemptAt).toEqual(new Date(now.getTime() + intervalMs));
			}
			await expect(dependencies.verify(asset.id)).resolves.toMatchObject({
				outboxCommitted: false,
			});
			expect(submit).toHaveBeenCalledOnce();
			expect(retrieve).toHaveBeenCalledTimes(callbackDuringQuery ? 2 : 1);
			expect(asset.status).toBe("VERIFYING");
			vi.setSystemTime(new Date(now.getTime() + intervalMs));
			await expect(dependencies.verify(asset.id, { queryOnly: immediateWake })).resolves.toEqual({
				outboxCommitted: false,
				...(immediateWake ? { outputReviewEventId: firstEvent.id, queryOnly: true } : {}),
			});
			expect(submit).toHaveBeenCalledOnce();
			expect(retrieve).toHaveBeenCalledTimes(callbackDuringQuery ? 3 : 2);
			expect(retrieve).toHaveBeenLastCalledWith(
				expect.objectContaining({ moderationTaskId: "same-moderation-task" }),
			);
			if (immediateWake) {
				// Repeated pending responses must reuse one polling Workflow, not fan out.
				expect(wake.mock.calls[1]![0].data.dedupeKey).toBe(wake.mock.calls[0]![0].data.dedupeKey);
				expect(committedEvents.size).toBe(1);
			}
			expect(asset.status).toBe("VERIFYING");
			// Admission retains one failure-budget check per claimed attempt;
			// normal PENDING commits perform no further error aggregates.
			expect(countFailures).toHaveBeenCalledTimes(callbackDuringQuery ? 3 : 2);
		},
	);
	it.each([
		"unsubmitted",
		"uncertain",
		"stale rule",
		"stale policy",
		"stale provider",
		"ready",
		"video",
		"no retrieval",
	])("does not submit or reset %s state through result-only capacity", async (state) => {
		const asset = {
			id: "result-only-asset",
			mimeType: state === "video" ? "video/mp4" : "image/png",
			status: state === "ready" ? "READY" : "VERIFYING",
			verificationGeneration: 1,
			verificationProviderTaskId: state === "unsubmitted" ? null : "bound-task",
			verificationSubmissionUncertain: state === "uncertain",
			verificationProvider: state === "stale provider" ? "old-provider" : "test",
			verificationRuleVersion:
				state === "stale rule" ? "old-rule" : MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion:
				state === "stale policy" ? "old-policy" : MEDIA_VERIFICATION_POLICY_VERSION,
		};
		const update = vi.fn();
		const tx = {
			$executeRaw: vi.fn(async () => 1),
			$queryRaw: vi.fn(async () => []),
			mediaAsset: { findUnique: async () => asset, update },
		};
		const submit = vi.fn();
		const retrieve = vi.fn();
		const deps = createDatabaseVerifyUploadDependencies(
			{
				...tx,
				$transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(tx),
			} as never,
			{
				moderationProvider: "test",
				safety: Object.assign(new TestMediaSafetyAdapter("ALLOW"), {
					submitImage: submit,
					retrieveImage: state === "no retrieval" ? undefined : retrieve,
				}),
			},
		);
		await expect(
			deps.verify(asset.id, { queryOnly: true, allowQuarantinedReverification: true }),
		).resolves.toEqual({ outboxCommitted: false });
		expect(submit).not.toHaveBeenCalled();
		expect(retrieve).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("excludes transfer-owned outputs before the recovery batch limit", async () => {
		const findMany = vi.fn(async () => []);
		await listVerificationRecoveryCandidates(
			{ mediaAsset: { findMany } } as never,
			{ limit: 2, now: new Date() },
			{ NODE_ENV: "test", MEDIA_SAFETY_ADAPTER: "test", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
		);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					NOT: {
						kind: "OUTPUT",
						OR: [
							{ outputTransferToken: { not: null } },
							{ finalizedAt: null },
							{ checksum: null },
							{ byteSize: { lte: 0n } },
						],
					},
				}),
				take: 2,
			}),
		);
	});
	it.each(["active transfer", "expired transfer", "unfinished output"])(
		"does not consume moderation attempts for an %s",
		async (state) => {
			const asset = {
				id: "pending-output",
				kind: "OUTPUT",
				status: "VERIFYING",
				deletedAt: null,
				byteSize: 0n,
				checksum: null,
				finalizedAt: null,
				outputTransferToken: state === "unfinished output" ? null : "transfer-token",
				outputTransferLeaseExpiresAt:
					state === "active transfer" ? new Date(Date.now() + 60_000) : new Date(0),
				verificationGeneration: 0,
				verificationAttemptCount: 0,
				verificationDeadlineAt: new Date(Date.now() + 86_400_000),
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationSubmissionUncertain: false,
			};
			const update = vi.fn(async () => {
				throw new Error("VERIFICATION_STARTED_BEFORE_TRANSFER_COMPLETED");
			});
			const tx = {
				$executeRaw: vi.fn(async () => 1),
				$queryRaw: vi.fn(async () => []),
				mediaAsset: { findUnique: async () => asset, update },
				auditLog: { findFirst: async () => null },
				assetModerationResult: { count: async () => 0 },
			};
			const database = {
				$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
			};
			const verify = createDatabaseVerifyUploadDependencies(database as never, {
				safety: new TestMediaSafetyAdapter("ALLOW"),
			});
			await expect(verify.verify(asset.id)).resolves.toEqual({ outboxCommitted: false });
			expect(update).not.toHaveBeenCalled();
		},
	);
});
