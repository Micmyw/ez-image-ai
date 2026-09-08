import type { MediaProviderAdapter, ProviderKey, ProviderSubmission } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import type { DispatchDependencies, DispatchStore, ReconciliationLease } from "../contracts";
import { dispatchGeneration } from "./dispatch-generation";
import { reconcileGenerations } from "./reconcile-generations";

describe("active generation polling admission", () => {
	it.each(["kie", "fal", "replicate"] as const)(
		"starts polling %s only after acceptance is persisted",
		async (provider) => {
			const fixture = dispatchFixture(provider);
			await expect(
				dispatchGeneration({ jobId: "job-1", version: 0 }, fixture.dependencies),
			).resolves.toEqual({ outcome: "SUBMITTED" });
			expect(fixture.events).toEqual(["submission-started", "accepted", "poll:attempt-1"]);
		},
	);

	it("does not reclassify accepted work when the polling scheduler is unavailable", async () => {
		const fixture = dispatchFixture("kie");
		fixture.dependencies.schedulePolling = async () => {
			throw new Error("scheduler unavailable");
		};
		await expect(
			dispatchGeneration({ jobId: "job-1", version: 0 }, fixture.dependencies),
		).resolves.toEqual({ outcome: "SUBMITTED" });
		expect(fixture.events).toEqual(["submission-started", "accepted"]);
	});

	it("does not poll synchronous results or uncertain submissions without a task ID", async () => {
		for (const outcome of ["synchronous", "uncertain"] as const) {
			const fixture = dispatchFixture("kie", outcome);
			await dispatchGeneration({ jobId: "job-1", version: 0 }, fixture.dependencies);
			expect(fixture.events).toEqual(["submission-started", outcome]);
		}
	});

	it("scopes an active poll to one attempt instead of sweeping the batch", async () => {
		const claimStale = vi.fn(async () => []);
		await reconcileGenerations(
			{ attemptId: "attempt-2" },
			{
				store: { claimStale } as never,
				getProvider: () => {
					throw new Error("no due work");
				},
			},
		);
		expect(claimStale).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: "attempt-2", limit: 1 }),
		);
	});

	it("rejects an empty targeted attempt instead of falling back to an unscoped sweep", async () => {
		const claimStale = vi.fn(async () => []);
		await expect(
			reconcileGenerations(
				{ attemptId: " " },
				{
					store: { claimStale } as never,
					getProvider: () => {
						throw new Error("no due work");
					},
				},
			),
		).rejects.toThrow("INVALID_GENERATION_ATTEMPT_ID");
		expect(claimStale).not.toHaveBeenCalled();
	});

	it("lets scheduled reconciliation restart timely polling after a lost initial dispatch", async () => {
		const fixture = dispatchFixture("fal");
		const lease: ReconciliationLease = {
			jobId: "job-1",
			version: 1,
			attemptId: "attempt-1",
			provider: "fal",
			providerTaskId: "remote-1",
			leaseToken: "lease-1",
			staleAgeMinutes: 1,
			repairCount: 1,
		};
		const events: string[] = [];
		await reconcileGenerations(
			{},
			{
				store: {
					claimStale: async () => [lease],
					recordReconciled: async () => {
						events.push("recorded");
					},
					releaseReconciliationLease: async () => {
						events.push("failed");
					},
					markUncertainForManualReconciliation: async () => {
						events.push("manual");
					},
				},
				getProvider: (provider) => fixture.dependencies.getProvider(provider),
				schedulePolling: async (attemptId: string) => {
					events.push(`poll:${attemptId}`);
				},
			},
		);
		expect(events).toEqual(["recorded", "poll:attempt-1"]);
	});
});

function dispatchFixture(
	provider: ProviderKey,
	outcome: "asynchronous" | "synchronous" | "uncertain" = "asynchronous",
) {
	const events: string[] = [];
	const store: DispatchStore = {
		claimDispatch: async () => ({
			attemptId: "attempt-1",
			attemptNumber: 1,
			serviceClass: "STANDARD",
			provider,
			providerModelId: "server-model",
			mediaKind: "image",
			queueKey: provider,
			input: { kind: "text-to-image", prompt: "A calm lake" },
		}),
		recordSubmissionStarted: async () => {
			events.push("submission-started");
		},
		recordSubmission: async () => {
			events.push("accepted");
		},
		recordSynchronousCompletion: async () => {
			events.push("synchronous");
		},
		recordUncertainSubmission: async () => {
			events.push("uncertain");
		},
		recordProviderAdapterUnavailable: async () => {
			events.push("unavailable");
		},
		recordRejectedSubmission: async () => {
			events.push("rejected");
		},
	};
	const adapter: MediaProviderAdapter = {
		provider,
		submit: async (): Promise<ProviderSubmission> => {
			if (outcome === "uncertain") throw new Error("connection lost");
			return {
				outcome: "accepted",
				providerTaskId: "remote-1",
				status: outcome === "synchronous" ? "SUCCEEDED" : "QUEUED",
				idempotency: { providerSupported: false, replayed: false },
				reconciliation: { submissionToken: "attempt-1" },
				...(outcome === "synchronous"
					? { snapshot: { providerTaskId: "remote-1", status: "SUCCEEDED" as const, raw: {} } }
					: {}),
			};
		},
		retrieve: async () => ({ providerTaskId: "remote-1", status: "RUNNING", raw: {} }),
		normalizeResult: async () => ({
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		}),
	};
	const dependencies: DispatchDependencies & { schedulePolling(attemptId: string): Promise<void> } =
		{
			store,
			getProvider: () => adapter,
			isGenerationEnabled: () => true,
			schedulePolling: async (attemptId) => {
				events.push(`poll:${attemptId}`);
			},
		};
	return { dependencies, events };
}
