import { TestMediaSafetyAdapter } from "@repo/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { listVerificationRecoveryCandidates } from "../orchestration/verification-recovery";
import { createDatabaseVerifyUploadDependencies } from "../runtime";

describe("output verification admission", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["image/png", "IMAGE_PROCESSING", 5_000, true],
		["video/mp4", "VIDEO_PROCESSING", 15_000, false],
	] as const)(
		"starts %s polling without bypassing its due time or resubmitting moderation",
		async (mimeType, reasonCode, intervalMs, immediateWake) => {
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
				verificationProviderTaskId: null as string | null,
				verificationSubmissionUncertain: false,
			};
			const update = async ({ data }: { data: Record<string, unknown> }) => ({
				...Object.assign(asset, data),
			});
			const wake = vi.fn(async (_input: { where: { dedupeKey: string } }) => ({}));
			const tx = {
				$executeRaw: vi.fn(async () => 1),
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
					create: async () => ({}),
					count: async () => 0,
				},
				outboxEvent: { upsert: wake },
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
			const retrieve = vi.fn(async (input: { ruleVersion: string }) => ({
				decision: "REVIEW" as const,
				reasonCode,
				ruleVersion: input.ruleVersion,
			}));
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
			await dependencies.verify(asset.id);
			expect(wake).toHaveBeenCalledOnce();
			expect.soft(wake).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({
						eventType: "MEDIA_ASSET_VERIFY",
						availableAt: new Date(now.getTime() + (immediateWake ? 0 : intervalMs)),
					}),
				}),
			);
			expect.soft(asset.verificationNextAttemptAt).toEqual(new Date(now.getTime() + intervalMs));
			await dependencies.verify(asset.id);
			expect(submit).toHaveBeenCalledOnce();
			expect(retrieve).toHaveBeenCalledOnce();
			expect(asset.status).toBe("VERIFYING");
			vi.setSystemTime(new Date(now.getTime() + intervalMs));
			await dependencies.verify(asset.id);
			expect(submit).toHaveBeenCalledOnce();
			expect(retrieve).toHaveBeenCalledTimes(2);
			expect(retrieve).toHaveBeenLastCalledWith(
				expect.objectContaining({ moderationTaskId: "same-moderation-task" }),
			);
			if (immediateWake) {
				// Repeated pending responses must reuse one polling Workflow, not fan out.
				expect(wake.mock.calls[1]![0].where.dedupeKey).toBe(wake.mock.calls[0]![0].where.dedupeKey);
			}
			expect(asset.status).toBe("VERIFYING");
		},
	);

	it("excludes transfer-owned outputs before the recovery batch limit", async () => {
		const findMany = vi.fn(async () => []);
		await listVerificationRecoveryCandidates(
			{ mediaAsset: { findMany } } as never,
			{ limit: 2, now: new Date() },
			{},
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
			await expect(verify.verify(asset.id)).resolves.toBeUndefined();
			expect(update).not.toHaveBeenCalled();
		},
	);
});
