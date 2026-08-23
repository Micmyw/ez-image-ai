import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, schedules, tasks } = vi.hoisted(() => ({
	db: { mediaAsset: { findMany: vi.fn() } },
	schedules: { task: vi.fn((configuration: unknown) => configuration) },
	tasks: { trigger: vi.fn() },
}));

vi.mock("@trigger.dev/sdk", () => ({ schedules, tasks }));
vi.mock("@repo/database/client", () => ({ db }));

import { recoverMediaVerificationsTask } from "./recover-media-verifications";

type RecoverTaskConfiguration = {
	run: () => Promise<{ recovered: number }>;
};

describe("recoverMediaVerificationsTask", () => {
	beforeEach(() => vi.clearAllMocks());

	it("runs bounded expired-lease recovery every minute", async () => {
		db.mediaAsset.findMany.mockResolvedValue([
			{ id: "asset-1", status: "VERIFYING", verificationLastErrorCode: null },
			{
				id: "asset-2",
				status: "QUARANTINED",
				verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
			},
		]);
		tasks.trigger.mockResolvedValue(undefined);
		const task = recoverMediaVerificationsTask as unknown as RecoverTaskConfiguration;

		await expect(task.run()).resolves.toEqual({ recovered: 2 });
		expect(tasks.trigger.mock.calls).toEqual([
			["media-verify-upload", { assetId: "asset-1", allowQuarantinedReverification: false }],
			["media-verify-upload", { assetId: "asset-2", allowQuarantinedReverification: true }],
		]);
		expect(db.mediaAsset.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					deletedAt: null,
					OR: expect.arrayContaining([
						expect.objectContaining({ status: "VERIFYING" }),
						expect.objectContaining({ status: "READY" }),
						expect.objectContaining({
							status: "QUARANTINED",
							verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
						}),
					]),
				}),
			}),
		);
		expect(recoverMediaVerificationsTask).toMatchObject({
			id: "media-recover-verifications",
			cron: "* * * * *",
			queue: { name: "media-verification-recovery", concurrencyLimit: 1 },
		});
	});
});
