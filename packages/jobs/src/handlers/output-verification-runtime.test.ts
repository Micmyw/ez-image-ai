import { TestMediaSafetyAdapter } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { listVerificationRecoveryCandidates } from "../orchestration/verification-recovery";
import { createDatabaseVerifyUploadDependencies } from "../runtime";

describe("output verification admission", () => {
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
