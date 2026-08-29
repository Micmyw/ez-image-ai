import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReconciliationLease } from "../src/contracts";

const runtimeMocks = vi.hoisted(() => {
	const claimStale = vi.fn();
	const recordReconciled = vi.fn();
	const releaseReconciliationLease = vi.fn();
	const markUncertainForManualReconciliation = vi.fn();
	return {
		claimStale,
		recordReconciled,
		releaseReconciliationLease,
		markUncertainForManualReconciliation,
		databaseReconciliationStore: {
			claimStale,
			recordReconciled,
			releaseReconciliationLease,
			markUncertainForManualReconciliation,
		},
		schedules: { task: vi.fn((configuration: unknown) => configuration) },
	};
});

vi.mock("@trigger.dev/sdk", () => ({ schedules: runtimeMocks.schedules }));
vi.mock("../src/runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/runtime")>()),
	databaseReconciliationStore: runtimeMocks.databaseReconciliationStore,
}));

import { reconcileGenerationsTask } from "./reconcile-generations";

type ReconcileGenerationsTaskConfiguration = {
	run: () => Promise<{ claimed: number; reconciled: number }>;
};

describe("reconcileGenerationsTask", () => {
	const lease: ReconciliationLease = {
		jobId: "job-1",
		version: 1,
		attemptId: "attempt-1",
		provider: "replicate",
		providerTaskId: "provider-task-1",
		leaseToken: "lease-token-1",
		staleAgeMinutes: 30,
		repairCount: 1,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "");
		vi.stubEnv("MEDIA_RECOVERY_PROVIDERS", "replicate");
		vi.stubEnv("REPLICATE_API_TOKEN", "");
		runtimeMocks.claimStale.mockResolvedValue([lease]);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("freezes a due attempt when its configured recovery provider lacks worker credentials", async () => {
		const task = reconcileGenerationsTask as unknown as ReconcileGenerationsTaskConfiguration;

		await expect(task.run()).resolves.toEqual({ claimed: 1, reconciled: 0 });
		expect(runtimeMocks.markUncertainForManualReconciliation).toHaveBeenCalledWith(
			lease,
			"PROVIDER_RECOVERY_UNAVAILABLE",
		);
		expect(runtimeMocks.releaseReconciliationLease).not.toHaveBeenCalled();
		expect(runtimeMocks.recordReconciled).not.toHaveBeenCalled();
	});
});
