import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createDatabaseFinalizingGenerationRecoveryStore,
	db,
	listCandidates,
	recoverCandidate,
	schedules,
} = vi.hoisted(() => ({
	createDatabaseFinalizingGenerationRecoveryStore: vi.fn(),
	db: {},
	listCandidates: vi.fn(),
	recoverCandidate: vi.fn(),
	schedules: { task: vi.fn((configuration: unknown) => configuration) },
}));

vi.mock("@trigger.dev/sdk", () => ({ schedules }));
vi.mock("@repo/database/client", () => ({ db }));
vi.mock("../src/handlers/finalization-recovery-store", () => ({
	createDatabaseFinalizingGenerationRecoveryStore,
}));

import { recoverFinalizingGenerationsTask } from "./recover-finalizing-generations";

type RecoverFinalizingGenerationsTaskConfiguration = {
	run: () => Promise<{
		scanned: number;
		recovered: number;
		skipped: number;
		exhausted: number;
		failed: number;
	}>;
};

describe("recoverFinalizingGenerationsTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listCandidates.mockResolvedValue([{ jobId: "job-1" }, { jobId: "job-2" }]);
		recoverCandidate.mockResolvedValueOnce("RECOVERED").mockResolvedValueOnce("SKIPPED");
		createDatabaseFinalizingGenerationRecoveryStore.mockReturnValue({
			listCandidates,
			recoverCandidate,
		});
	});

	it("runs bounded durable finalization recovery every minute on an isolated queue", async () => {
		const task =
			recoverFinalizingGenerationsTask as unknown as RecoverFinalizingGenerationsTaskConfiguration;

		await expect(task.run()).resolves.toEqual({
			scanned: 2,
			recovered: 1,
			skipped: 1,
			exhausted: 0,
			failed: 0,
		});
		expect(createDatabaseFinalizingGenerationRecoveryStore).toHaveBeenCalledWith(db);
		expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
		expect(recoverCandidate).toHaveBeenCalledTimes(2);
		expect(recoverFinalizingGenerationsTask).toMatchObject({
			id: "media-recover-finalizing-generations",
			cron: "* * * * *",
			queue: { name: "media-finalization-recovery", concurrencyLimit: 1 },
			maxDuration: 120,
		});
	});
});
