import type { MediaProviderAdapter, ProviderKey, ProviderTaskStatus } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import type { GenerationPollingStore, ReconciliationLease } from "../contracts";
import { generationPollingDelaySeconds } from "../generation-polling-policy";
import { pollGeneration } from "./poll-generation";

describe("bounded active generation polling", () => {
	it.each(["kie", "fal"] as const)(
		"observes %s completion through the existing reconciliation path within a minute",
		async (provider) => {
			const fixture = pollingFixture(provider, ["RUNNING", "SUCCEEDED"]);
			const result = await pollGeneration({ attemptId: "attempt-1" }, fixture.dependencies);
			expect(result).toEqual({ outcome: "STOPPED", polls: 2 });
			expect(fixture.observations).toEqual(["RUNNING", "SUCCEEDED"]);
			expect(fixture.elapsed()).toBeLessThan(60_000);
			expect(fixture.submit).not.toHaveBeenCalled();
		},
	);

	it("honors the durable lease/due time before querying a Provider", async () => {
		const fixture = pollingFixture("kie", ["SUCCEEDED"]);
		fixture.setPollAt(75_000);
		await pollGeneration({ attemptId: "attempt-1" }, fixture.dependencies);
		expect(fixture.retrievedAt).toEqual([75_000]);
	});

	it("stops promptly when a webhook finalizes the attempt while the worker waits", async () => {
		const fixture = pollingFixture("kie", ["SUCCEEDED"]);
		fixture.dependencies.wait = async () => {
			fixture.stop();
		};
		expect(await pollGeneration({ attemptId: "attempt-1" }, fixture.dependencies)).toEqual({
			outcome: "STOPPED",
			polls: 0,
		});
		expect(fixture.retrievedAt).toEqual([]);
	});

	it("hands long-running work back to scheduled recovery after a bounded window", async () => {
		const fixture = pollingFixture("fal", ["RUNNING"]);
		const result = await pollGeneration({ attemptId: "attempt-1" }, fixture.dependencies);
		expect(result.outcome).toBe("RECOVERY_PENDING");
		expect(fixture.elapsed()).toBeLessThanOrEqual(600_000);
		expect(fixture.retrievedAt.length).toBeGreaterThan(5);
		expect(fixture.retrievedAt.length).toBeLessThan(40);
	});

	it("respects recovery backoff after a transport failure without resubmitting", async () => {
		const fixture = pollingFixture("kie", ["SUCCEEDED"]);
		const retrieve = fixture.adapter.retrieve.bind(fixture.adapter);
		let failed = false;
		fixture.adapter.retrieve = async (input) => {
			if (!failed) {
				failed = true;
				throw new Error("temporary network failure");
			}
			return retrieve(input);
		};
		await pollGeneration({ attemptId: "attempt-1" }, fixture.dependencies);
		expect(fixture.retrievedAt[0]).toBeGreaterThanOrEqual(130_000);
		expect(fixture.submit).not.toHaveBeenCalled();
	});

	it("rejects an empty task payload before any database or Provider work", async () => {
		const fixture = pollingFixture("kie", ["SUCCEEDED"]);
		await expect(pollGeneration({ attemptId: "" }, fixture.dependencies)).rejects.toThrow(
			"INVALID_GENERATION_ATTEMPT_ID",
		);
		expect(fixture.retrievedAt).toEqual([]);
	});

	it.each([
		[0, 10],
		[59_000, 10],
		[60_000, 20],
		[180_000, 30],
		[600_000, 60],
	])("backs off pending work at age %i ms to %i seconds", (age, seconds) => {
		expect(generationPollingDelaySeconds(new Date(0), new Date(age))).toBe(seconds);
	});
});

function pollingFixture(provider: ProviderKey, statuses: ProviderTaskStatus[]) {
	let clock = 0;
	let pollAt = 10_000;
	let stopped = false;
	const observations: ProviderTaskStatus[] = [];
	const retrievedAt: number[] = [];
	const lease: ReconciliationLease = {
		jobId: "job-1",
		version: 1,
		attemptId: "attempt-1",
		provider,
		providerTaskId: "remote-1",
		leaseToken: "lease-1",
		staleAgeMinutes: 1,
		repairCount: 0,
	};
	const submit = vi.fn(async () => {
		throw new Error("polling must never submit");
	});
	const adapter: MediaProviderAdapter = {
		provider,
		submit,
		retrieve: async () => {
			retrievedAt.push(clock);
			return {
				providerTaskId: "remote-1",
				status: statuses[Math.min(observations.length, statuses.length - 1)]!,
				raw: {},
			};
		},
		normalizeResult: async () => ({
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		}),
	};
	const store: GenerationPollingStore = {
		getPollingState: async () => (stopped ? null : { pollAt: new Date(pollAt) }),
		claimStale: async ({ attemptId, now }) => {
			if (attemptId !== "attempt-1") throw new Error("unscoped poll");
			return !stopped && now.getTime() >= pollAt ? [lease] : [];
		},
		recordReconciled: async (_lease, snapshot) => {
			observations.push(snapshot.status);
			stopped = snapshot.status === "SUCCEEDED";
			pollAt = clock + generationPollingDelaySeconds(new Date(0), new Date(clock)) * 1_000;
		},
		releaseReconciliationLease: async (_lease, _code, retryAt) => {
			pollAt = retryAt.getTime();
		},
		markUncertainForManualReconciliation: async () => {
			stopped = true;
		},
	};
	const dependencies = {
		store,
		getProvider: () => adapter,
		now: () => new Date(clock),
		wait: async (seconds: number) => {
			clock += seconds * 1_000;
		},
	};
	return {
		dependencies,
		adapter,
		submit,
		observations,
		retrievedAt,
		elapsed: () => clock,
		setPollAt: (value: number) => {
			pollAt = value;
		},
		stop: () => {
			stopped = true;
		},
	};
}
